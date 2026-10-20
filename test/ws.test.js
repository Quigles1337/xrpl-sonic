import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { XrplStream, NETWORKS, SUBSCRIBE_COMMAND } from '../src/ws.js';

/** Minimal scripted WebSocket double. `script` decides what each new socket does. */
function makeFakeWebSocket(script) {
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.closed = false;
      sockets.push(this);
      queueMicrotask(() => script(this, sockets.length - 1));
    }
    send(data) {
      this.sent.push(JSON.parse(data));
    }
    close() {
      this.closed = true;
      this.readyState = 3;
    }
    open() {
      this.readyState = 1;
      this.onopen?.({});
    }
    message(obj) {
      this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) });
    }
    drop(code = 1006) {
      this.readyState = 3;
      this.onclose?.({ code });
    }
  }
  return { FakeWebSocket, sockets };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('XrplStream requests', () => {
  async function connected() {
    const { FakeWebSocket, sockets } = makeFakeWebSocket((ws) => ws.open());
    const messages = [];
    const stream = new XrplStream({ endpoints: ['wss://a.example'], WebSocketImpl: FakeWebSocket, onMessage: (m) => messages.push(m) });
    stream.connect();
    await flush();
    return { stream, ws: sockets[0], messages };
  }

  test('request() sends the command with an id and resolves with the matching response', async () => {
    const { stream, ws, messages } = await connected();
    const p = stream.request({ command: 'ledger', ledger_index: 5, transactions: true, expand: true });
    const sent = ws.sent.at(-1);
    assert.equal(sent.command, 'ledger');
    assert.equal(sent.ledger_index, 5);
    assert.equal(sent.expand, true);
    assert.match(sent.id, /^xrpl-sonic-req-\d+$/);
    ws.message({ id: 'xrpl-sonic-req-other', status: 'success', type: 'response', result: { nope: true } });
    ws.message({ type: 'ledgerClosed', ledger_index: 5 });
    ws.message({ id: sent.id, status: 'success', type: 'response', result: { ledger: { ledger_index: 5, transactions: [] } } });
    const res = await p;
    assert.equal(res.result.ledger.ledger_index, 5);
    assert.deepEqual(
      messages.map((m) => m.type),
      ['response', 'ledgerClosed'],
      'unmatched responses and stream messages still reach onMessage; the matched one does not',
    );
    assert.equal(stream.pending.size, 0);
    stream.close();
  });

  test('request() rejects on an error response with the rippled error code', async () => {
    const { stream, ws } = await connected();
    const p = stream.request({ command: 'ledger', ledger_index: 999999999 });
    ws.message({ id: ws.sent.at(-1).id, status: 'error', type: 'response', error: 'lgrNotFound', error_message: 'Ledger not found.' });
    await assert.rejects(p, (err) => err.message === 'Ledger not found.' && err.code === 'lgrNotFound');
    stream.close();
  });

  test('request() rejects on timeout, on socket drop, and when not connected', async () => {
    const { stream, ws } = await connected();
    await assert.rejects(stream.request({ command: 'ping' }, { timeoutMs: 5 }), /timed out/);
    const dropped = stream.request({ command: 'ping' });
    ws.drop();
    await assert.rejects(dropped, /socket closed/);
    stream.close();
    await assert.rejects(stream.request({ command: 'ping' }), /not connected/);
  });
});

describe('XrplStream', () => {
  test('network table has the documented endpoints', () => {
    assert.equal(NETWORKS.mainnet.endpoints[0], 'wss://xrplcluster.com');
    assert.deepEqual(NETWORKS.mainnet.endpoints.slice(1), ['wss://s1.ripple.com', 'wss://s2.ripple.com']);
    assert.deepEqual(NETWORKS.testnet.endpoints, ['wss://s.altnet.rippletest.net:51233']);
    assert.deepEqual(SUBSCRIBE_COMMAND.streams, ['ledger', 'transactions']);
  });

  test('subscribes to ledger + transactions on open and dispatches parsed messages', async () => {
    const { FakeWebSocket, sockets } = makeFakeWebSocket((ws) => ws.open());
    const statuses = [];
    const messages = [];
    const stream = new XrplStream({
      endpoints: ['wss://a.example', 'wss://b.example'],
      WebSocketImpl: FakeWebSocket,
      onStatus: (s) => statuses.push(s.state),
      onMessage: (m) => messages.push(m),
    });
    stream.connect();
    await flush();
    assert.equal(sockets[0].url, 'wss://a.example');
    assert.deepEqual(sockets[0].sent[0], { ...SUBSCRIBE_COMMAND });
    assert.deepEqual(statuses, ['connecting', 'connected']);
    sockets[0].message({ type: 'ledgerClosed', ledger_index: 5 });
    sockets[0].message('{not json');
    assert.deepEqual(messages, [{ type: 'ledgerClosed', ledger_index: 5 }]);
    stream.close();
    assert.equal(sockets[0].closed, true);
    assert.equal(stream.state, 'idle');
  });

  test('rotates to the next endpoint with backoff when the socket drops', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { FakeWebSocket, sockets } = makeFakeWebSocket((ws, i) => (i === 0 ? ws.drop(1006) : ws.open()));
    const statuses = [];
    const stream = new XrplStream({
      endpoints: ['wss://a.example', 'wss://b.example', 'wss://c.example'],
      WebSocketImpl: FakeWebSocket,
      onStatus: (s) => statuses.push(s),
    });
    stream.connect();
    await flush();
    const reconnecting = statuses.find((s) => s.state === 'reconnecting');
    assert.ok(reconnecting, 'reports reconnecting');
    assert.equal(reconnecting.endpoint, 'wss://b.example', 'rotated to the next endpoint');
    assert.ok(reconnecting.delayMs >= 800 && reconnecting.delayMs <= 1200, `first backoff ≈1s, got ${reconnecting.delayMs}`);
    assert.match(reconnecting.error, /1006/);
    assert.equal(sockets.length, 1);
    t.mock.timers.tick(1300);
    await flush();
    assert.equal(sockets.length, 2);
    assert.equal(sockets[1].url, 'wss://b.example');
    assert.equal(stream.state, 'connected');
    assert.equal(stream.attempt, 0, 'attempt counter resets after a successful open');
    stream.close();
  });

  test('backoff grows and caps; close() stops reconnecting', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { FakeWebSocket, sockets } = makeFakeWebSocket((ws) => ws.drop(1011));
    const delays = [];
    const stream = new XrplStream({
      endpoints: ['wss://only.example'],
      WebSocketImpl: FakeWebSocket,
      onStatus: (s) => s.delayMs && delays.push(s.delayMs),
    });
    stream.connect();
    for (let i = 0; i < 8; i++) {
      await flush();
      t.mock.timers.tick(31000);
    }
    await flush();
    assert.ok(delays.length >= 7);
    assert.ok(delays[1] > delays[0], 'second delay longer than first');
    assert.ok(Math.max(...delays) <= 30000 * 1.2, 'capped at ~30s');
    const before = sockets.length;
    stream.close();
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(sockets.length, before, 'no new sockets after close()');
  });

  test('a subscribe error response triggers failover', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { FakeWebSocket, sockets } = makeFakeWebSocket((ws) => ws.open());
    const statuses = [];
    const stream = new XrplStream({
      endpoints: ['wss://a.example', 'wss://b.example'],
      WebSocketImpl: FakeWebSocket,
      onStatus: (s) => statuses.push(s),
    });
    stream.connect();
    await flush();
    sockets[0].message({ id: SUBSCRIBE_COMMAND.id, status: 'error', error: 'noPermission' });
    const r = statuses.find((s) => s.state === 'reconnecting');
    assert.ok(r);
    assert.match(r.error, /noPermission/);
    assert.equal(sockets[0].closed, true);
    stream.close();
  });

  test('watchdog pings after 20s idle and reconnects after 45s idle', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { FakeWebSocket, sockets } = makeFakeWebSocket((ws) => ws.open());
    const stream = new XrplStream({ endpoints: ['wss://a.example', 'wss://b.example'], WebSocketImpl: FakeWebSocket });
    stream.connect();
    await flush();
    t.mock.timers.tick(25000);
    assert.ok(sockets[0].sent.some((m) => m.command === 'ping'), 'ping sent');
    t.mock.timers.tick(25000);
    await flush();
    assert.equal(sockets[0].closed, true, 'dead socket closed');
    assert.equal(stream.state, 'reconnecting');
    stream.close();
  });

  test('setEndpoints reconnects to the new list when running', async () => {
    const { FakeWebSocket, sockets } = makeFakeWebSocket((ws) => ws.open());
    const stream = new XrplStream({ endpoints: ['wss://a.example'], WebSocketImpl: FakeWebSocket });
    stream.connect();
    await flush();
    stream.setEndpoints(['wss://t.example']);
    await flush();
    assert.equal(sockets.length, 2);
    assert.equal(sockets[1].url, 'wss://t.example');
    assert.equal(sockets[0].closed, true);
    stream.close();
  });

  test('constructor validates inputs', () => {
    assert.throws(() => new XrplStream({ endpoints: [], WebSocketImpl: class {} }), /endpoints required/);
    assert.throws(() => new XrplStream({ endpoints: 'wss://x', WebSocketImpl: class {} }), /endpoints required/);
  });
});

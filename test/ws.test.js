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

describe('XrplStream subscribe result (universe-requests.md R11)', () => {
  test('a hostid in the subscribe result goes out on the status callback as `subscribed` at once, the state stays connected, the response still reaches onMessage, and the hostid resets on reconnect', async () => {
    const { FakeWebSocket, sockets } = makeFakeWebSocket((ws) => ws.open());
    const statuses = [];
    const messages = [];
    const stream = new XrplStream({ endpoints: ['wss://a.example', 'wss://b.example'], WebSocketImpl: FakeWebSocket, onStatus: (s) => statuses.push(s), onMessage: (m) => messages.push(m) });
    stream.connect();
    await flush();
    assert.equal(stream.hostid, null);
    assert.ok(statuses.every((s) => s.hostid === null), 'null until the subscribe result names the node');
    const ws = sockets[0];
    ws.message({ id: SUBSCRIBE_COMMAND.id, status: 'success', type: 'response', result: { hostid: 'ABCD', ledger_index: 500, ledger_hash: 'A'.repeat(64), fee_base: 10, load_factor: 256 } });
    const sub = statuses.find((s) => s.state === 'subscribed');
    assert.deepEqual(sub, { state: 'subscribed', endpoint: 'wss://a.example', attempt: 0, hostid: 'ABCD' });
    assert.equal(stream.state, 'connected', 'an event on the callback, not a state');
    assert.equal(stream.hostid, 'ABCD');
    assert.equal(messages.at(-1).result.hostid, 'ABCD', 'the response reaches onMessage as before (the page seeds its ledger index from it)');
    assert.equal(statuses.filter((s) => s.state === 'connected').length, 1, 'connected is not announced twice');
    assert.ok(!ws.sent.some((m) => m.command === 'server_info'), 'no server_info when the result named the node');
    ws.drop();
    await flush();
    assert.equal(statuses.at(-1).state, 'reconnecting');
    assert.equal(statuses.at(-1).hostid, 'ABCD', 'the last known name rides along until a new socket opens');
    stream.close();
    assert.equal(statuses.at(-1).state, 'idle');
  });

  test('a subscribe result without a hostid (today’s rippled and Clio) asks server_info once: rippled’s info.hostid names the node, Clio’s answer without one gives null, and so does a failed request', async () => {
    const run = async (answer) => {
      const { FakeWebSocket, sockets } = makeFakeWebSocket((ws) => ws.open());
      const statuses = [];
      const stream = new XrplStream({ endpoints: ['wss://a.example'], WebSocketImpl: FakeWebSocket, onStatus: (s) => statuses.push(s), onMessage: () => {} });
      stream.connect();
      await flush();
      const ws = sockets[0];
      ws.message({ id: SUBSCRIBE_COMMAND.id, status: 'success', type: 'response', result: { ledger_index: 1, fee_base: 10 } });
      assert.ok(!statuses.some((s) => s.state === 'subscribed'), 'not named yet');
      const sent = ws.sent.at(-1);
      assert.equal(sent.command, 'server_info');
      ws.message(answer(sent.id));
      await flush();
      stream.close();
      return { statuses, stream, sent: ws.sent };
    };
    const rippled = await run((id) => ({ id, status: 'success', type: 'response', result: { info: { hostid: 'HUNTER', build_version: '3.4.1' } } }));
    assert.deepEqual(rippled.statuses.find((s) => s.state === 'subscribed'), { state: 'subscribed', endpoint: 'wss://a.example', attempt: 0, hostid: 'HUNTER' });
    assert.equal(rippled.sent.filter((m) => m.command === 'server_info').length, 1, 'asked once');
    const clio = await run((id) => ({ id, status: 'success', type: 'response', result: { info: { clio_version: '2.8.0' } } }));
    assert.deepEqual(clio.statuses.find((s) => s.state === 'subscribed'), { state: 'subscribed', endpoint: 'wss://a.example', attempt: 0, hostid: null });
    const refused = await run((id) => ({ id, status: 'error', type: 'response', error: 'noPermission' }));
    assert.deepEqual(refused.statuses.find((s) => s.state === 'subscribed'), { state: 'subscribed', endpoint: 'wss://a.example', attempt: 0, hostid: null });
  });

  test('a subscribe error still fails the connection; a socket that drops while server_info is pending names nothing', async () => {
    const { FakeWebSocket, sockets } = makeFakeWebSocket((ws) => ws.open());
    const statuses = [];
    const stream = new XrplStream({ endpoints: ['wss://a.example'], WebSocketImpl: FakeWebSocket, onStatus: (s) => statuses.push(s), onMessage: () => {} });
    stream.connect();
    await flush();
    sockets[0].message({ id: SUBSCRIBE_COMMAND.id, status: 'success', type: 'response', result: { ledger_index: 1 } });
    sockets[0].drop();
    await flush();
    assert.ok(!statuses.some((s) => s.state === 'subscribed'));
    assert.equal(statuses.at(-1).state, 'reconnecting');
    stream.close();
    const second = makeFakeWebSocket((ws) => ws.open());
    const errors = [];
    const s2 = new XrplStream({ endpoints: ['wss://a.example'], WebSocketImpl: second.FakeWebSocket, onStatus: (s) => errors.push(s), onMessage: () => {} });
    s2.connect();
    await flush();
    second.sockets[0].message({ id: SUBSCRIBE_COMMAND.id, status: 'error', type: 'response', error: 'noPermission' });
    assert.equal(errors.at(-1).state, 'reconnecting');
    assert.match(errors.at(-1).error, /subscribe failed: noPermission/);
    s2.close();
  });
});

describe('XrplStream for history (docs/loader.md)', () => {
  test('streams: [] opens a socket that subscribes to nothing and is connected at open; rotate() moves to the next endpoint now, rejecting what was pending', async () => {
    const { FakeWebSocket, sockets } = makeFakeWebSocket((ws) => ws.open());
    const statuses = [];
    const stream = new XrplStream({ endpoints: ['wss://s2.example', 'wss://s1.example', 'wss://c.example'], streams: [], WebSocketImpl: FakeWebSocket, onStatus: (s) => statuses.push(s), onMessage: () => {} });
    stream.connect();
    await flush();
    assert.equal(stream.state, 'connected');
    assert.deepEqual(sockets[0].sent, [], 'no subscribe');
    assert.equal(stream.endpoint, 'wss://s2.example');
    const pending = stream.request({ command: 'ledger', ledger_index: 5 });
    assert.equal(stream.rotate(), true);
    await assert.rejects(pending, /rotated/);
    await flush();
    assert.equal(stream.endpoint, 'wss://s1.example');
    assert.equal(sockets.length, 2);
    assert.ok(sockets[0].closed);
    assert.equal(stream.state, 'connected');
    assert.deepEqual(statuses.map((s) => s.state), ['connecting', 'connected', 'connecting', 'connected'], 'no failure backoff: a plain connect to the next');
    stream.rotate();
    await flush();
    stream.rotate();
    await flush();
    assert.equal(stream.endpoint, 'wss://s2.example', 'round the list');
    stream.close();
    assert.equal(stream.rotate(), false, 'closed: nowhere to go');
    const single = new XrplStream({ endpoints: ['wss://only.example'], streams: [], WebSocketImpl: FakeWebSocket, onMessage: () => {} });
    single.connect();
    await flush();
    assert.equal(single.rotate(), false, 'one endpoint: nothing to rotate to');
    single.close();
  });

  test('the default still subscribes to ledger and transactions', async () => {
    const { FakeWebSocket, sockets } = makeFakeWebSocket((ws) => ws.open());
    const stream = new XrplStream({ endpoints: ['wss://a.example'], WebSocketImpl: FakeWebSocket, onMessage: () => {} });
    stream.connect();
    await flush();
    assert.deepEqual(sockets[0].sent, [SUBSCRIBE_COMMAND]);
    stream.close();
  });
});

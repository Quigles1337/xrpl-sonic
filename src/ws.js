// xrpl-sonic — XRPL WebSocket stream client.
//
// Connects to a public rippled/Clio node, subscribes to the `ledger` and
// `transactions` streams, and reconnects with exponential backoff, rotating to
// the next endpoint on every failure. Uses the platform WebSocket (browser or
// Node 22+), so this file has no dependencies either.

export const NETWORKS = Object.freeze({
  mainnet: Object.freeze({
    label: 'Mainnet',
    endpoints: ['wss://xrplcluster.com', 'wss://s1.ripple.com', 'wss://s2.ripple.com'],
  }),
  testnet: Object.freeze({
    label: 'Testnet',
    endpoints: ['wss://s.altnet.rippletest.net:51233'],
  }),
});

export const SUBSCRIBE_COMMAND = Object.freeze({ id: 'xrpl-sonic-subscribe', command: 'subscribe', streams: ['ledger', 'transactions'] });

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const REQUEST_TIMEOUT_MS = 20000;
const PING_AFTER_MS = 20000; // send a ping if nothing arrived for this long
const DEAD_AFTER_MS = 45000; // reconnect if nothing arrived for this long

export class XrplStream {
  /**
   * @param {object} opts
   * @param {string[]} opts.endpoints  WebSocket URLs to rotate through
   * @param {(msg: object) => void} opts.onMessage  every parsed JSON message
   * @param {(status: {state: string, endpoint: string|null, attempt: number, hostid: string|null, error?: string}) => void} [opts.onStatus]
   *   the state changes (connecting, connected, reconnecting, idle), and one event that is not a state change: `subscribed`, after the
   *   subscribe result, carrying the node's `hostid` (see _named); every status object carries the hostid once it is known (null before)
   * @param {(json: string) => void} [opts.onRaw]  raw text (optional, for debugging)
   * @param {typeof WebSocket} [opts.WebSocketImpl]  override for tests
   * @param {string[]} [opts.streams]  the streams subscribed on open (ledger and transactions); [] for a socket that only makes requests (the history socket, docs/loader.md)
   */
  constructor({ endpoints, onMessage, onStatus, onRaw, WebSocketImpl, streams = SUBSCRIBE_COMMAND.streams } = {}) {
    if (!Array.isArray(endpoints) || endpoints.length === 0) throw new Error('XrplStream: endpoints required');
    this.endpoints = [...endpoints];
    this.onMessage = onMessage ?? (() => {});
    this.onStatus = onStatus ?? (() => {});
    this.onRaw = onRaw ?? null;
    this.streams = Array.isArray(streams) ? [...streams] : [];
    this.WebSocketImpl = WebSocketImpl ?? globalThis.WebSocket;
    if (!this.WebSocketImpl) throw new Error('XrplStream: no WebSocket implementation available');
    this.index = 0;
    this.attempt = 0;
    this.ws = null;
    this.closedByUser = true;
    this.reconnectTimer = null;
    this.watchdogTimer = null;
    this.lastMessageAt = 0;
    this.state = 'idle';
    this.hostid = null; // the node's name from the subscribe result, once it arrives
    this.pending = new Map(); // request id → {resolve, reject, timer}
    this.requestSeq = 0;
  }

  get endpoint() {
    return this.endpoints[this.index % this.endpoints.length];
  }

  connect() {
    this.closedByUser = false;
    this._clearTimers();
    this._open();
  }

  close() {
    this.closedByUser = true;
    this._clearTimers();
    this._rejectPending('disconnected');
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this._setState('idle');
  }

  /** Switch endpoint list (e.g. mainnet → testnet) and reconnect if running. */
  setEndpoints(endpoints) {
    this.endpoints = [...endpoints];
    this.index = 0;
    this.attempt = 0;
    if (!this.closedByUser) {
      this.close();
      this.connect();
    }
  }

  /**
   * The next endpoint now, for a refusal at the request level (the loader's
   * repeated slow-downs, docs/loader.md): no failure backoff, the pending
   * requests rejected as `rotated`. False when closed or there is nowhere to go.
   */
  rotate() {
    if (this.closedByUser || this.endpoints.length < 2) return false;
    this._clearTimers();
    this._rejectPending('rotated');
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.index = (this.index + 1) % this.endpoints.length;
    this.attempt = 0;
    this._open();
    return true;
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  /**
   * Send a command over the open socket and resolve with its response,
   * matched by id. Rejects on an error response (`err.code` = rippled error
   * name), when the socket drops, or after `timeoutMs`. Responses to requests
   * are not passed to onMessage.
   */
  request(command, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('not connected'));
    const id = `xrpl-sonic-req-${++this.requestSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${command?.command ?? 'request'} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ ...command, id }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  _settleRequest(msg) {
    const entry = msg && typeof msg.id === 'string' ? this.pending.get(msg.id) : undefined;
    if (!entry) return false;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.status === 'error') {
      const err = new Error(msg.error_message ?? msg.error ?? 'request failed');
      err.code = msg.error ?? 'unknown';
      entry.reject(err);
    } else {
      entry.resolve(msg);
    }
    return true;
  }

  _rejectPending(reason) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  _setState(state, extra = {}) {
    this.state = state;
    this.onStatus({ state, endpoint: this.endpoint, attempt: this.attempt, hostid: this.hostid, ...extra });
  }

  _open() {
    const url = this.endpoint;
    this._setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    let ws;
    try {
      ws = new this.WebSocketImpl(url);
    } catch (err) {
      this._fail(String(err?.message ?? err));
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.hostid = null;
      this.lastMessageAt = Date.now();
      if (this.streams.length) ws.send(JSON.stringify({ ...SUBSCRIBE_COMMAND, streams: this.streams }));
      this._setState('connected');
      this._armWatchdog();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastMessageAt = Date.now();
      const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
      if (this.onRaw) this.onRaw(text);
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (this._settleRequest(msg)) return;
      if (msg && msg.id === SUBSCRIBE_COMMAND.id) {
        if (msg.status === 'error') {
          this._fail(`subscribe failed: ${msg.error ?? 'unknown'}`);
          return;
        }
        // the node's name goes out on the status callback as an event (the state stays connected); the response
        // itself still reaches onMessage, which seeds the ledger index from it
        this._named(ws, msg.result);
      }
      this.onMessage(msg);
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      // onclose follows; nothing to do here beyond noting it.
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this._fail(`socket closed (${ev?.code ?? '?'})`);
    };
  }

  /**
   * The node's name after the subscribe result: the result's `hostid` when the
   * node sends one (rippled's API v1 did; current rippled and Clio do not),
   * else `server_info`'s `info.hostid` (rippled answers it; Clio has no hostid
   * and gives null). Goes out on the status callback as the `subscribed`
   * event with the state unchanged; nothing is sent if the socket went away.
   */
  async _named(ws, result) {
    let hostid = typeof result?.hostid === 'string' && result.hostid ? result.hostid : null;
    if (!hostid) {
      try {
        const r = await this.request({ command: 'server_info' }, { timeoutMs: 8000 });
        hostid = typeof r?.result?.info?.hostid === 'string' && r.result.info.hostid ? r.result.info.hostid : null;
      } catch {
        hostid = null;
      }
    }
    if (this.ws !== ws) return;
    this.hostid = hostid;
    this.onStatus({ state: 'subscribed', endpoint: this.endpoint, attempt: this.attempt, hostid });
  }

  _fail(error) {
    this._clearTimers();
    this._rejectPending(error);
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    if (this.closedByUser) return;
    this.attempt += 1;
    this.index = (this.index + 1) % this.endpoints.length; // rotate
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(this.attempt - 1, 5)) * (0.8 + Math.random() * 0.4);
    this._setState('reconnecting', { error, delayMs: Math.round(delay) });
    this.reconnectTimer = setTimeout(() => this._open(), delay);
  }

  _armWatchdog() {
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => {
      if (!this.ws) return;
      const idle = Date.now() - this.lastMessageAt;
      if (idle > DEAD_AFTER_MS) this._fail('no data for 45s');
      else if (idle > PING_AFTER_MS) this.send({ id: 'xrpl-sonic-ping', command: 'ping' });
    }, 5000);
  }

  _clearTimers() {
    clearTimeout(this.reconnectTimer);
    clearInterval(this.watchdogTimer);
    this.reconnectTimer = null;
    this.watchdogTimer = null;
  }
}

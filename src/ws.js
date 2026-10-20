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
const PING_AFTER_MS = 20000; // send a ping if nothing arrived for this long
const DEAD_AFTER_MS = 45000; // reconnect if nothing arrived for this long

export class XrplStream {
  /**
   * @param {object} opts
   * @param {string[]} opts.endpoints  WebSocket URLs to rotate through
   * @param {(msg: object) => void} opts.onMessage  every parsed JSON message
   * @param {(status: {state: string, endpoint: string|null, attempt: number, error?: string}) => void} [opts.onStatus]
   * @param {(json: string) => void} [opts.onRaw]  raw text (optional, for debugging)
   * @param {typeof WebSocket} [opts.WebSocketImpl]  override for tests
   */
  constructor({ endpoints, onMessage, onStatus, onRaw, WebSocketImpl } = {}) {
    if (!Array.isArray(endpoints) || endpoints.length === 0) throw new Error('XrplStream: endpoints required');
    this.endpoints = [...endpoints];
    this.onMessage = onMessage ?? (() => {});
    this.onStatus = onStatus ?? (() => {});
    this.onRaw = onRaw ?? null;
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

  send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  _setState(state, extra = {}) {
    this.state = state;
    this.onStatus({ state, endpoint: this.endpoint, attempt: this.attempt, ...extra });
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
      this.lastMessageAt = Date.now();
      ws.send(JSON.stringify(SUBSCRIBE_COMMAND));
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
      if (msg && msg.id === SUBSCRIBE_COMMAND.id && msg.status === 'error') {
        this._fail(`subscribe failed: ${msg.error ?? 'unknown'}`);
        return;
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

  _fail(error) {
    this._clearTimers();
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

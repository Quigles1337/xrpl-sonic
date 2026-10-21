// xrpl-sonic explorer — reads from a public node over the same WebSocket client
// the listening page uses. Every call is a documented rippled / Clio command;
// results are cached per session so moving back and forth costs nothing.
// Account reads take a `ledgerIndex` so one render can bind every part to
// one validated ledger (src/explorer/account.js); without it they read the
// node's current validated ledger, which may move between calls.

import { XrplStream, NETWORKS } from '../ws.js';

const CACHE_MS = { account_info: 15000, account_lines: 30000, account_objects: 30000, account_nfts: 60000, account_tx: 15000, tx: Infinity, ledger: Infinity, server_info: 60000 };

export class ExplorerApi {
  constructor({ network = 'mainnet', onStatus, onLedger } = {}) {
    this.network = network;
    this.onStatus = onStatus ?? (() => {});
    this.onLedger = onLedger ?? (() => {});
    this.cache = new Map();
    this.latest = null; // last ledgerClosed message
    this.stream = new XrplStream({
      endpoints: NETWORKS[network].endpoints,
      onStatus: (s) => this.onStatus(s),
      onMessage: (msg) => {
        if (msg?.type === 'ledgerClosed') {
          this.latest = msg;
          this.onLedger(msg);
        }
      },
    });
  }

  connect() {
    this.stream.connect();
  }

  close() {
    this.stream.close();
  }

  get host() {
    return this.stream.endpoint ? this.stream.endpoint.replace(/^wss:\/\//, '') : '';
  }

  /** Wait until connected (resolves at once when already connected). */
  ready(timeoutMs = 20000) {
    if (this.stream.state === 'connected') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const prev = this.onStatus;
      const timer = setTimeout(() => {
        this.onStatus = prev;
        reject(new Error('no connection to a node'));
      }, timeoutMs);
      this.onStatus = (s) => {
        prev(s);
        if (s.state === 'connected') {
          clearTimeout(timer);
          this.onStatus = prev;
          resolve();
        }
      };
    });
  }

  async request(command, { ttl } = {}) {
    const key = JSON.stringify(command);
    const maxAge = ttl ?? CACHE_MS[command.command] ?? 0;
    const hit = this.cache.get(key);
    if (hit && performance.now() - hit.at < maxAge) return hit.value;
    await this.ready();
    const value = await this.stream.request(command, { timeoutMs: 20000 });
    if (value?.status === 'error') throw Object.assign(new Error(value.error_message ?? value.error ?? 'request failed'), { code: value.error });
    this.cache.set(key, { at: performance.now(), value });
    if (this.cache.size > 400) this.cache.delete(this.cache.keys().next().value);
    return value;
  }

  /** The validated ledger's header (index, hash, close time): the snapshot an account render is bound to. */
  validatedLedger() {
    return this.request({ command: 'ledger', ledger_index: 'validated', transactions: false }, { ttl: 2000 }).then((r) => r.result);
  }

  accountInfo(account, { ledgerIndex } = {}) {
    return this.request({ command: 'account_info', account, ledger_index: ledgerIndex ?? 'validated' }).then((r) => r.result);
  }

  accountLines(account, { ledgerIndex, limit = 200, marker } = {}) {
    return this.request({ command: 'account_lines', account, ledger_index: ledgerIndex ?? 'validated', limit, ...(marker ? { marker } : {}) }).then((r) => r.result);
  }

  accountObjects(account, { ledgerIndex, limit = 200 } = {}) {
    return this.request({ command: 'account_objects', account, ledger_index: ledgerIndex ?? 'validated', limit }).then((r) => r.result);
  }

  accountNfts(account, { ledgerIndex, limit = 100 } = {}) {
    return this.request({ command: 'account_nfts', account, ledger_index: ledgerIndex ?? 'validated', limit }).then((r) => r.result);
  }

  /** Newest first; `marker` pages further back; `ledgerIndexMax` pins every page to one validated ledger. */
  accountTx(account, { limit = 40, marker, ledgerIndexMax } = {}) {
    return this.request({ command: 'account_tx', account, limit, ledger_index_min: -1, ledger_index_max: ledgerIndexMax ?? -1, forward: false, ...(marker ? { marker } : {}) }).then((r) => r.result);
  }

  tx(hash) {
    return this.request({ command: 'tx', transaction: hash, binary: false }).then((r) => r.result);
  }

  ledger(index, { transactions = true } = {}) {
    const ledger_index = index === 'latest' ? 'validated' : index;
    return this.request({ command: 'ledger', ledger_index, transactions, expand: transactions }, { ttl: index === 'latest' ? 2000 : Infinity }).then((r) => r.result);
  }

  serverInfo() {
    return this.request({ command: 'server_info' }).then((r) => r.result);
  }
}

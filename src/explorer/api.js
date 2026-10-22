// xrpl-sonic explorer — reads from a public node over the same WebSocket client
// the listening page uses. Every call is a documented rippled / Clio command;
// results are cached per session so moving back and forth costs nothing.
// Account reads take a `ledgerIndex` so one render can bind every part to
// one validated ledger (src/explorer/account.js); without it they read the
// node's current validated ledger, which may move between calls.

import { XrplStream, NETWORKS } from '../ws.js';

const CACHE_MS = { account_info: 15000, account_lines: 30000, account_objects: 30000, account_nfts: 60000, account_tx: 15000, tx: Infinity, ledger: Infinity, ledger_entry: 15000, server_info: 60000 };

/** AccountRoot flag bits (lsf*), by the key account_info's `account_flags` uses for each. */
export const ACCOUNT_ROOT_FLAGS = Object.freeze({
  passwordSpent: 0x00010000,
  requireDestinationTag: 0x00020000,
  requireAuthorization: 0x00040000,
  disallowIncomingXRP: 0x00080000,
  disableMasterKey: 0x00100000,
  noFreeze: 0x00200000,
  globalFreeze: 0x00400000,
  defaultRipple: 0x00800000,
  depositAuth: 0x01000000,
  amm: 0x02000000,
  disallowIncomingNFTokenOffer: 0x04000000,
  disallowIncomingCheck: 0x08000000,
  disallowIncomingPayChan: 0x10000000,
  disallowIncomingTrustline: 0x20000000,
  allowTrustLineClawback: 0x80000000,
});

/** A ledger_entry (account_root) result as an account_info result: account_data, account_flags from the bits, the ledger, and `via` with the error account_info gave. */
export function accountInfoFromEntry(result, error = null) {
  const node = result?.node;
  if (!node || node.LedgerEntryType !== 'AccountRoot') throw error ?? Object.assign(new Error('not an account root'), { code: 'entryNotFound' });
  const bits = Number(node.Flags) || 0;
  const account_flags = Object.fromEntries(Object.entries(ACCOUNT_ROOT_FLAGS).map(([k, bit]) => [k, (bits & bit) !== 0 || (bit === 0x80000000 && bits >= 0x80000000)]));
  return { account_data: { ...node, index: node.index ?? result.index }, account_flags, ledger_index: result.ledger_index ?? result.ledger_current_index ?? null, ledger_hash: result.ledger_hash ?? null, validated: result.validated ?? null, via: 'ledger_entry', error: error ? { code: error.code ?? 'unknown', message: error.message ?? String(error) } : null };
}

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

  /**
   * account_info, or, when the node refuses it, the account's root entry
   * through ledger_entry shaped like an account_info result and marked
   * `via: 'ledger_entry'`: rippled answers account_info for an AMM
   * pseudo-account with an internal error (docs/coherence.md, phase 2), and
   * the entry itself (lsfAMM, AMMID) is what names it one.
   */
  accountInfo(account, { ledgerIndex } = {}) {
    const at = ledgerIndex ?? 'validated';
    return this.request({ command: 'account_info', account, ledger_index: at }).then(
      (r) => r.result,
      (err) => this.request({ command: 'ledger_entry', account_root: account, ledger_index: at }).then((r) => accountInfoFromEntry(r.result, err), () => Promise.reject(err)),
    );
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

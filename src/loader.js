// xrpl-sonic — the loader policy (docs/loader.md).
//
// Where a request goes, how fast, what to do when the node says slow down,
// and what never has to be fetched twice. Measured on 2026-10-23 against the
// public nodes (the numbers are in docs/loader.md): s2.ripple.com serves one
// expanded ledger per 1.2 s without complaint and refuses with `slowDown`
// faster than that, recovering in about 1.5 s; xrplcluster.com meters units
// (2000 per 10 s, about six expanded ledgers), refuses with `tooBusy` and
// says how long to wait. So history goes to s2 first, paced; the live
// subscription stays on the cluster; a refusal is waited out, repeated
// refusals move the history socket to the next node; a validated ledger,
// once fetched, is kept in the browser by network, index and hash; and the
// ledgers the tours need ship with the page, so they open without a node.
//
// Pure: the socket, the cache store and the bundle's reader are injected.

import { NETWORKS } from './ws.js';
import { fetchCaseLedgers, ledgerCommand, caseLedgerIndices } from './ledgers.js';

/** The endpoints per request kind, in the order tried. */
export const ENDPOINTS = Object.freeze({
  mainnet: Object.freeze({
    stream: NETWORKS.mainnet.endpoints, // the live subscription: the cluster first, as before
    history: Object.freeze(['wss://s2.ripple.com', 'wss://s1.ripple.com', 'wss://xrplcluster.com']), // expanded ledgers, account_tx, tx: the Ripple nodes first (measured: docs/loader.md)
  }),
  testnet: Object.freeze({ stream: NETWORKS.testnet.endpoints, history: NETWORKS.testnet.endpoints }),
});
export const KINDS = Object.freeze(['stream', 'history']);
const HISTORY_COMMANDS = new Set(['ledger', 'ledger_data', 'ledger_entry', 'tx', 'account_tx', 'account_info', 'account_lines', 'account_objects', 'account_nfts', 'account_offers', 'book_offers', 'nft_history', 'nft_info']);

/** The kind of a command: `history` reads the record (ledgers, transactions, accounts, books); everything else belongs on the live socket. */
export function kindOf(command) {
  return HISTORY_COMMANDS.has(command?.command) ? 'history' : 'stream';
}

/** The endpoints of a network for a kind of request, in order; an unknown network reads as mainnet. */
export function endpointsFor(network, kind = 'history') {
  const n = ENDPOINTS[network] ?? ENDPOINTS.mainnet;
  return [...(n[kind] ?? n.history)];
}

/** Milliseconds between two expanded ledger fetches on an endpoint, and between two header fetches anywhere. */
export const PACE = Object.freeze({
  'wss://s2.ripple.com': 1200, // 25 of 25 at 1.2 s; 1 refusal in 25 at 0.8 s; 4 in 25 at 0.4 s
  'wss://s1.ripple.com': 1200, // the same software (Clio 2.8.0) as s2
  'wss://xrplcluster.com': 1700, // 2000 units per 10 s, about 330 per expanded ledger
  default: 1200,
  header: 200,
});

/** Waiting out a refusal: the node's own "retry in" when it says one, else doubling from the base; a move to the next node after this many in a row. */
export const BACKOFF = Object.freeze({ baseMs: 1500, factor: 2, maxMs: 30000, rotateAfter: 3, maxSlowDowns: 8, retryDelayMs: 800 });

/** The error codes a node refuses with when the caller is the load. */
export const SLOW_DOWN_CODES = Object.freeze(['slowDown', 'tooBusy', 'noNetwork']);

/** Whether an error is the node's slow-down signal: one of the codes, or a message that says so (the cluster's rate limit is `tooBusy` with "units quota … exhausted"). */
export function isSlowDown(err) {
  if (!err) return false;
  if (SLOW_DOWN_CODES.includes(err.code)) return true;
  return /slow ?down|too much load|too busy|quota|rate limit/i.test(String(err.message ?? err));
}

/** The wait a refusal names ("retry in ~9623ms"), in milliseconds, or null. */
export function retryAfterMs(err) {
  const m = /retry in ~?\s*(\d+)\s*ms/i.exec(String(err?.message ?? ''));
  return m ? Number(m[1]) : null;
}

/** The wait before the n-th retry (n from 1) after a refusal: what the node asked for, else the doubling, capped. */
export function backoffMs(attempt, err = null, policy = BACKOFF) {
  const asked = retryAfterMs(err);
  if (asked != null) return Math.min(policy.maxMs, Math.max(0, asked));
  return Math.min(policy.maxMs, policy.baseMs * policy.factor ** Math.max(0, attempt - 1));
}

/** The pace for a fetch on an endpoint: the endpoint's for an expanded ledger, the header pace for a header. */
export function paceFor(endpoint, { full = true } = {}, pace = PACE) {
  return full ? (pace[endpoint] ?? pace.default) : pace.header;
}

/** The cache key of a ledger: the network and the index; the hash is checked on read. */
export function cacheKey(network, index) {
  return `${network}:${Number(index)}`;
}

/** The hashes a case names for its ledgers (a moment records one per ledger), index → hash, for the cache and the bundle to be checked against. */
export function caseHashes(theCase) {
  const out = new Map();
  for (const l of theCase?.moment?.ledgers ?? []) if (typeof l?.hash === 'string' && /^[0-9A-F]{64}$/i.test(l.hash)) out.set(Number(l.index), l.hash.toUpperCase());
  return out;
}

/**
 * The cache store's shape, in memory: the browser's is src/ledger-cache.js
 * (IndexedDB) with the same four methods. An entry is { network, index,
 * hash, full, result, storedAt }, `result` the node's result object
 * ({ ledger_hash, ledger_index, validated, ledger }) as returned.
 */
export class MemoryCache {
  constructor() {
    this.map = new Map();
  }

  async get(network, index) {
    return this.map.get(cacheKey(network, index)) ?? null;
  }

  async put(entry) {
    this.map.set(cacheKey(entry.network, entry.index), entry);
    return true;
  }

  async count(network = null) {
    return network ? [...this.map.values()].filter((e) => e.network === network).length : this.map.size;
  }

  async clear(network = null) {
    if (!network) {
      this.map.clear();
      return;
    }
    for (const [k, e] of this.map) if (e.network === network) this.map.delete(k);
  }
}

/**
 * The ledgers that ship with the page: `<baseUrl><network>/index.json` lists
 * them ({ index, hash, closeTime, txnCount, full }), one file per ledger
 * beside it, the node's result object verbatim. `read(url)` returns the
 * parsed JSON or null when there is none (the default fetches; a script
 * reads the disk). The index is read once per network.
 */
export function createBundle({ baseUrl = 'docs/cases/ledgers/', read = null } = {}) {
  const reader =
    read ??
    (async (url) => {
      const r = await fetch(url, { cache: 'force-cache' });
      return r.ok ? r.json() : null;
    });
  const indexes = new Map(); // network → Promise<Map<index, entry>>
  const index = (network) => {
    if (!indexes.has(network)) {
      indexes.set(
        network,
        reader(`${baseUrl}${network}/index.json`)
          .then((idx) => new Map((idx?.ledgers ?? []).map((l) => [Number(l.index), l])))
          .catch(() => new Map()),
      );
    }
    return indexes.get(network);
  };
  return {
    baseUrl,
    /** The listed entry for a ledger, or null. */
    async entry(network, index_) {
      return (await index(network)).get(Number(index_)) ?? null;
    },
    /** The indices bundled for a network. */
    async indices(network) {
      return [...(await index(network)).keys()];
    },
    /** The bundled result for a ledger ({ result, hash, full }) when it is listed and serves the request (a header entry serves only a header), else null. */
    async get(network, index_, { full = true } = {}) {
      const e = (await index(network)).get(Number(index_));
      if (!e || (full && !e.full)) return null;
      let result = null;
      try {
        result = await reader(`${baseUrl}${network}/${Number(index_)}.json`);
      } catch {
        result = null;
      }
      if (!result?.ledger) return null;
      return { result, hash: typeof e.hash === 'string' ? e.hash.toUpperCase() : null, full: Boolean(e.full) };
    },
  };
}

/**
 * The loader: one ledger at a time through the bundle, the cache, then the
 * node, paced and backing off; or a whole case through fetchCaseLedgers.
 *
 * @param {object} deps
 * @param {(command: object) => Promise<object>} deps.request   the history socket's request; an error with code `noNode` ends the load's node fetches
 * @param {() => string|null} [deps.endpoint]   the endpoint the request goes to now, for the pace table
 * @param {() => void} [deps.rotate]   move the socket to the next endpoint (after repeated refusals)
 * @param {string} [deps.network]
 * @param {object} [deps.cache]   get/put/count/clear as MemoryCache; null for none
 * @param {object} [deps.bundle]   from createBundle(); null for none
 * @param {(event: { type: 'slow-down'|'rotate'|'offline', host: string, code?: string, delayMs?: number, attempt?: number }) => void} [deps.onEvent]
 * @param {object} [deps.pace]  @param {object} [deps.backoff]  @param {() => number} [deps.now]  @param {(ms: number) => Promise<void>} [deps.sleep]
 */
export class LedgerLoader {
  constructor({ request, endpoint = () => null, rotate = null, network = 'mainnet', cache = null, bundle = null, onEvent = null, pace = PACE, backoff = BACKOFF, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    if (typeof request !== 'function') throw new Error('LedgerLoader: request required');
    this.request = request;
    this.endpoint = endpoint;
    this.rotate = rotate;
    this.network = network;
    this.cache = cache;
    this.bundle = bundle;
    this.onEvent = onEvent ?? (() => {});
    this.pace = pace;
    this.backoff = backoff;
    this.now = now;
    this.sleep = sleep;
    this.nextAt = 0; // the earliest time the next node fetch may go out
    this.slowDowns = 0; // refusals in a row on the current endpoint
    this.offline = null; // the error that said no node answers, after which the rest of a load fails at once
    this.stats = { bundle: 0, cache: 0, node: 0, failed: 0, slowDowns: 0, rotations: 0 };
  }

  get host() {
    const e = this.endpoint?.() ?? null;
    return e ? String(e).replace(/^wss:\/\//, '') : '';
  }

  /** Wait for the next slot on the endpoint: slots are reserved in call order, so concurrent callers queue rather than burst. */
  async _paced(full) {
    const pace = paceFor(this.endpoint?.() ?? null, { full }, this.pace);
    const at = Math.max(this.now(), this.nextAt);
    this.nextAt = at + pace;
    const wait = at - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  /**
   * One ledger: { result, source, hash }. `source` is `bundle`, `cache` or
   * `node`. `hash`, when given, must match what the bundle or the cache holds,
   * else the node is asked. `live` skips the bundle and the cache (the
   * cache is still written). Throws when the node could not serve it.
   */
  async get(index, { full = true, hash = null, live = false, signal = null } = {}) {
    const n = Number(index);
    const want = hash ? String(hash).toUpperCase() : null;
    const matches = (h) => !want || (typeof h === 'string' && h.toUpperCase() === want);
    if (!live && this.bundle) {
      const b = await this.bundle.get(this.network, n, { full });
      if (b && matches(b.hash ?? b.result?.ledger_hash)) {
        this.stats.bundle += 1;
        return { result: b.result, source: 'bundle', hash: b.hash ?? b.result?.ledger_hash ?? null };
      }
    }
    if (!live && this.cache) {
      const c = await this.cache.get(this.network, n).catch(() => null);
      if (c?.result?.ledger && (c.full || !full) && matches(c.hash)) {
        this.stats.cache += 1;
        return { result: c.result, source: 'cache', hash: c.hash ?? null };
      }
    }
    if (this.offline) throw this.offline;
    let attempt = 0; // refusals waited out for this ledger
    let plainRetry = false; // one retry for an error that is not a refusal
    for (;;) {
      if (signal?.aborted) throw new Error('aborted');
      await this._paced(full);
      try {
        const res = await this.request(ledgerCommand(n, { full }));
        const ledger = res?.result?.ledger;
        if (!ledger || typeof ledger !== 'object') throw Object.assign(new Error(res?.result?.error_message ?? res?.error_message ?? res?.error ?? 'malformed ledger response'), { code: res?.error ?? 'malformed' });
        this.slowDowns = 0;
        this.stats.node += 1;
        const h = typeof res.result.ledger_hash === 'string' ? res.result.ledger_hash.toUpperCase() : typeof ledger.ledger_hash === 'string' ? ledger.ledger_hash.toUpperCase() : null;
        if (this.cache && res.result.validated === true) await this.cache.put({ network: this.network, index: n, hash: h, full, result: res.result, storedAt: this.now() }).catch(() => false);
        return { result: res.result, source: 'node', hash: h };
      } catch (err) {
        if (signal?.aborted) throw new Error('aborted');
        if (err?.code === 'noNode') {
          this.offline = err;
          this.onEvent({ type: 'offline', host: this.host, code: err.code });
          throw err;
        }
        if (isSlowDown(err)) {
          attempt += 1;
          this.slowDowns += 1;
          this.stats.slowDowns += 1;
          if (attempt > this.backoff.maxSlowDowns) throw err;
          const delayMs = backoffMs(attempt, err, this.backoff);
          this.onEvent({ type: 'slow-down', host: this.host, code: err.code ?? 'slowDown', delayMs, attempt });
          if (this.slowDowns >= this.backoff.rotateAfter && this.rotate) {
            this.rotate();
            this.stats.rotations += 1;
            this.slowDowns = 0;
            this.onEvent({ type: 'rotate', host: this.host });
          }
          this.nextAt = Math.max(this.nextAt, this.now() + delayMs);
          await this.sleep(delayMs);
          continue;
        }
        if (!plainRetry) {
          plainRetry = true;
          await this.sleep(this.backoff.retryDelayMs);
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * A case's ledgers through fetchCaseLedgers (src/ledgers.js), every
   * ledger through get(): the Map the score expects, the failures, and the
   * sources ({ bundle, cache, node, failed, total, host }), counted over the
   * full ledgers of the case.
   */
  async case(theCase, { onProgress = null, signal = null, live = false, hashes = null, concurrency = 2 } = {}) {
    const fulls = new Set(caseLedgerIndices(theCase));
    const request = async (cmd) => {
      const n = Number(cmd.ledger_index);
      const r = await this.get(n, { full: Boolean(cmd.transactions), hash: hashes?.get?.(n) ?? null, live, signal });
      return { result: r.result, source: r.source };
    };
    const { ledgers, failures } = await fetchCaseLedgers(request, theCase, { onProgress, signal, concurrency, attempts: 1, retryDelayMs: 0 });
    return { ledgers, failures, sources: countSources(ledgers, fulls, this.host) };
  }
}

/** The sources counted over the full ledgers of the case, read back from the Map (each entry carries the source its fetch reported). */
function countSources(ledgers, fulls, host) {
  const out = { bundle: 0, cache: 0, node: 0, failed: 0, total: fulls.size, host };
  for (const n of fulls) {
    const l = ledgers.get(n);
    if (!l?.ledger) out.failed += 1;
    else if (l.source === 'bundle') out.bundle += 1;
    else if (l.source === 'cache') out.cache += 1;
    else out.node += 1;
  }
  return out;
}

/** One line for the tape and the tour: "16 ledgers: 16 bundled with the page." / "12 from this browser's cache, 4 from s2.ripple.com; 2 not available from the node". */
export function describeSources({ sources } = {}) {
  if (!sources) return '';
  const parts = [];
  if (sources.bundle) parts.push(`${sources.bundle} bundled with the page`);
  if (sources.cache) parts.push(`${sources.cache} from this browser's cache`);
  if (sources.node) parts.push(`${sources.node} from ${sources.host || 'the node'}`);
  const total = `${sources.total} ledger${sources.total === 1 ? '' : 's'}`;
  const head = parts.length ? `${total}: ${parts.join(', ')}` : `${total}: none available`;
  return `${head}${sources.failed ? `; ${sources.failed} not available from the node` : ''}.`;
}

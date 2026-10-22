// xrpl-sonic — series from account_tx (docs/coherence.md, phase 1.5).
//
// For a named list of accounts over a ledger range, fetch every transaction
// the node has for each of them in that range: `account_tx` with
// `ledger_index_min` and `ledger_index_max` carried through pagination (the
// marker) until the range is complete, oldest first so that a page that
// fails leaves a known span uncovered. The bounds the node echoed, the
// validated ledger at query time and every failed page are recorded, and a
// ledger the fetch did not cover is missing, never zero: a ledger inside the
// covered span with no entry is a genuine zero, one outside it is absent.
// The frame builder in src/coherence.js turns the result into per-ledger
// series (submitted, involved, log volume) and touch records (src/record.js).
//
// Pure apart from the request function it is handed (XrplStream#request).

export const DEFAULT_PAGE_LIMIT = 200;
export const MAX_PAGES = 400;
export const MAX_RANGE = 20000;
export const RETRY_DELAY_MS = 800;

/** Why a ledger of the range is not covered. */
export const COVERAGE_REASONS = Object.freeze({
  missing: 'not available from the node',
  history: 'outside the node’s history',
  unvalidated: 'beyond the validated ledger at query time',
});

export function accountTxCommand(account, { from, to, limit = DEFAULT_PAGE_LIMIT, marker = null } = {}) {
  return { command: 'account_tx', account, ledger_index_min: from, ledger_index_max: to, forward: true, limit, ...(marker ? { marker } : {}) };
}

/** An account_tx entry (API v1 `tx` or v2 `tx_json`) as { tx, meta, hash, ledgerIndex, validated, success }; null when it is not a transaction. */
export function unwrapEntry(entry) {
  const tx = entry?.tx ?? entry?.tx_json ?? null;
  if (!tx || typeof tx !== 'object' || typeof tx.TransactionType !== 'string') return null;
  const meta = entry.meta ?? entry.metaData ?? null;
  const idx = Number(entry.ledger_index ?? tx.ledger_index ?? tx.inLedger);
  const hash = typeof entry.hash === 'string' ? entry.hash : typeof tx.hash === 'string' ? tx.hash : null;
  return { tx, meta, hash: hash ? hash.toUpperCase() : null, ledgerIndex: Number.isInteger(idx) ? idx : null, validated: entry.validated !== false, success: meta?.TransactionResult === 'tesSUCCESS' };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The ledger a marker points at (rippled and Clio both carry it as `ledger`), or null. */
function markerLedger(marker) {
  const n = Number(marker?.ledger);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Every transaction of one account in [from, to], oldest first, page by page.
 * A page that fails is retried `retries` times after `retryDelayMs`; when it
 * still fails, the ledgers it would have covered (from the marker's ledger,
 * which the previous page covered only in part, to the end of the range) are
 * recorded as missing and the fetch stops.
 * @param {(command: object) => Promise<object>} request
 * @returns {Promise<{ account: string, from: number, to: number, entries: object[], pages: number, requests: number, bounds: { min: number, max: number }|null, validated: boolean|null, missing: { from: number, to: number, reason: string }[], error: string|null }>}
 */
export async function fetchAccountTx(request, account, { from, to, limit = DEFAULT_PAGE_LIMIT, retries = 1, retryDelayMs = RETRY_DELAY_MS, maxPages = MAX_PAGES, onPage, signal } = {}) {
  const out = { account, from, to, entries: [], pages: 0, requests: 0, bounds: null, validated: null, missing: [], error: null };
  if (!Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to < from) {
    out.error = 'a range needs two ledger indices, from ≤ to';
    out.missing.push({ from, to, reason: 'missing' });
    return out;
  }
  let marker = null;
  let nextLedger = from; // the first ledger the next page may touch
  for (;;) {
    if (signal?.aborted) {
      out.error = 'aborted';
      out.missing.push({ from: nextLedger, to, reason: 'missing' });
      break;
    }
    let res = null;
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(retryDelayMs);
      out.requests += 1;
      try {
        res = await request(accountTxCommand(account, { from, to, limit, marker }));
        const r = res?.result;
        if (!r || !Array.isArray(r.transactions)) throw new Error(res?.result?.error_message ?? res?.error_message ?? res?.error ?? 'malformed account_tx response');
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        res = null;
      }
    }
    if (lastError) {
      out.error = lastError?.message ?? String(lastError);
      out.missing.push({ from: nextLedger, to, reason: 'missing' });
      break;
    }
    const r = res.result;
    out.pages += 1;
    if (out.pages === 1) {
      const min = Number(r.ledger_index_min);
      const max = Number(r.ledger_index_max);
      out.bounds = Number.isInteger(min) && Number.isInteger(max) ? { min, max } : null;
      out.validated = typeof r.validated === 'boolean' ? r.validated : null;
    }
    for (const raw of r.transactions) {
      const e = unwrapEntry(raw);
      if (e && (e.ledgerIndex == null || (e.ledgerIndex >= from && e.ledgerIndex <= to))) out.entries.push(e);
    }
    onPage?.({ page: out.pages, entries: out.entries.length, marker: r.marker ?? null });
    if (!r.marker) break;
    marker = r.marker;
    nextLedger = markerLedger(marker) ?? out.entries.at(-1)?.ledgerIndex ?? nextLedger;
    if (out.pages >= maxPages) {
      out.error = `stopped after ${maxPages} pages`;
      out.missing.push({ from: nextLedger, to, reason: 'missing' });
      break;
    }
  }
  // the node's own bounds: what it echoed narrower than the request is outside its history (or beyond its validated ledger)
  if (out.bounds) {
    if (out.bounds.min > from) out.missing.push({ from, to: Math.min(to, out.bounds.min - 1), reason: 'history' });
    if (out.bounds.max < to) out.missing.push({ from: Math.max(from, out.bounds.max + 1), to, reason: 'unvalidated' });
  }
  out.missing.sort((x, y) => x.from - y.from);
  return out;
}

/**
 * The validated ledger at query time, from a `ledger` request: { index, hash, closeTime } or null.
 */
export async function validatedLedgerOf(request) {
  try {
    const res = await request({ command: 'ledger', ledger_index: 'validated', transactions: false });
    const r = res?.result ?? {};
    const l = r.ledger ?? {};
    const index = Number(r.ledger_index ?? l.ledger_index);
    const hash = r.ledger_hash ?? l.ledger_hash ?? null;
    const closeTime = Number(l.close_time);
    return Number.isInteger(index) && index > 0 ? { index, hash: typeof hash === 'string' ? hash.toUpperCase() : null, closeTime: Number.isFinite(closeTime) ? closeTime : null } : null;
  } catch {
    return null;
  }
}

/**
 * The series source for a named list of accounts over a range: the validated
 * ledger first, then each account in turn (one at a time: a public node's
 * quota is per address, not per page), and the per-account result with its
 * coverage. Ledgers beyond the validated ledger are recorded as missing.
 * @param {(command: object) => Promise<object>} request
 * @param {{ address: string, label?: string }[]} accounts
 * @returns {Promise<{ from: number, to: number, validatedLedger: object|null, accounts: object[], ms: number }>}
 */
export async function fetchAccountSeries(request, accounts, { from, to, limit = DEFAULT_PAGE_LIMIT, retries = 1, retryDelayMs = RETRY_DELAY_MS, maxPages = MAX_PAGES, onPage, onAccount, signal } = {}) {
  const t0 = Date.now();
  const validatedLedger = await validatedLedgerOf(request);
  const results = [];
  for (const a of accounts ?? []) {
    if (!a || typeof a.address !== 'string') continue;
    const r = await fetchAccountTx(request, a.address, { from, to, limit, retries, retryDelayMs, maxPages, signal, onPage: (p) => onPage?.({ ...p, address: a.address }) });
    r.label = a.label ?? null;
    if (validatedLedger && validatedLedger.index < to && !r.missing.some((m) => m.reason === 'unvalidated')) {
      r.missing.push({ from: Math.max(from, validatedLedger.index + 1), to, reason: 'unvalidated' });
      r.missing.sort((x, y) => x.from - y.from);
    }
    results.push(r);
    onAccount?.(r);
  }
  return { from, to, validatedLedger, accounts: results, ms: Date.now() - t0 };
}

/** The ledgers of [from, to] not covered for an account, as a Set, with the first reason per ledger in `reasons`. */
export function uncovered(result, from, to) {
  const set = new Set();
  const reasons = new Map();
  for (const m of result?.missing ?? []) {
    for (let n = Math.max(from, m.from); n <= Math.min(to, m.to); n++) {
      set.add(n);
      if (!reasons.has(n)) reasons.set(n, m.reason);
    }
  }
  return { set, reasons };
}

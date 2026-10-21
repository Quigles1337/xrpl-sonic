// xrpl-sonic — fetching the ledgers a case names.
//
// Given a request function (XrplStream#request) and a validated case, fetch
// every ledger in every clip with `transactions: true, expand: true`, plus the
// header of the ledger after each clip so the last ledger's close interval is
// known. Bounded concurrency, a failure marks the ledger as unavailable rather
// than failing the case, and the result is the Map src/score.js expects.

export const DEFAULT_CONCURRENCY = 2;
export const RETRY_DELAY_MS = 800;

export function ledgerCommand(index, { full = true } = {}) {
  return full ? { command: 'ledger', ledger_index: index, transactions: true, expand: true } : { command: 'ledger', ledger_index: index };
}

/** Every ledger index a case needs in full, in play order, de-duplicated. */
export function caseLedgerIndices(theCase) {
  const out = [];
  const seen = new Set();
  for (const clip of theCase?.clips ?? []) {
    for (let n = clip.from; n <= clip.to; n++) {
      if (!seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
  }
  return out;
}

/** Headers needed for close intervals: the ledger after each clip, unless it is itself in the case. */
export function caseHeaderIndices(theCase) {
  const full = new Set(caseLedgerIndices(theCase));
  const out = [];
  for (const clip of theCase?.clips ?? []) {
    const next = clip.to + 1;
    if (!full.has(next) && !out.includes(next)) out.push(next);
  }
  return out;
}

async function pool(items, concurrency, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

/**
 * @param {(command: object) => Promise<object>} request
 * @param {object} theCase
 * A request that fails is retried once after `retryDelayMs`; a ledger that fails twice is marked unavailable.
 * @param {{ concurrency?: number, retryDelayMs?: number, onProgress?: (done: number, total: number) => void, signal?: { aborted: boolean } }} [opts]
 * @returns {Promise<{ ledgers: Map<number, { ledger: object|null, nextCloseTime: number|null }>, failures: { index: number, error: string }[] }>}
 */
export async function fetchCaseLedgers(request, theCase, { concurrency = DEFAULT_CONCURRENCY, retryDelayMs = RETRY_DELAY_MS, onProgress, signal } = {}) {
  const fullIndices = caseLedgerIndices(theCase);
  const headerIndices = caseHeaderIndices(theCase);
  const total = fullIndices.length + headerIndices.length;
  const got = new Map(); // index → ledger object (full or header) or null
  const failures = [];
  let done = 0;
  const fetchOne = async ({ index, full }) => {
    if (signal?.aborted) return;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      if (signal?.aborted) break;
      try {
        const res = await request(ledgerCommand(index, { full }));
        const ledger = res?.result?.ledger;
        if (!ledger || typeof ledger !== 'object') throw new Error(res?.result?.error_message ?? res?.error_message ?? res?.error ?? 'malformed ledger response');
        got.set(index, ledger);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) {
      if (full) failures.push({ index, error: lastError?.message ?? String(lastError) });
      got.set(index, null);
    }
    done += 1;
    onProgress?.(done, total);
  };
  const jobs = [...fullIndices.map((index) => ({ index, full: true })), ...headerIndices.map((index) => ({ index, full: false }))];
  await pool(jobs, concurrency, fetchOne);
  const ledgers = new Map();
  for (const index of fullIndices) {
    const ledger = got.get(index) ?? null;
    const nextRaw = got.get(index + 1);
    const nextClose = Number(nextRaw?.close_time);
    ledgers.set(index, { ledger, nextCloseTime: Number.isFinite(nextClose) ? nextClose : null });
  }
  return { ledgers, failures: failures.sort((a, b) => a.index - b.index) };
}

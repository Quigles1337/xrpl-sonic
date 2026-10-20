// xrpl-sonic — ledger replay scheduling.
//
// Pure: no DOM, no WebSocket. Given a `ledger` command result (with
// `transactions: true, expand: true`) and the close time of the following
// ledger, lay the transactions out across the real close interval so they can
// be played back in canonical order at the pace the network applied them.

export const MAX_REPLAY_LEDGERS = 50;
export const DEFAULT_CLOSE_INTERVAL_MS = 4000;
export const MAX_CLOSE_INTERVAL_MS = 30000;
export const REPLAY_SPEEDS = Object.freeze([0.5, 1, 2, 4]);

/**
 * Parse `#replay=<ledgerIndex>` or `#replay=<from>-<to>`.
 * A reversed range is swapped; a range longer than `max` ledgers is clamped
 * (and flagged); anything that is not one or two positive integers is null.
 * @returns {{ from: number, to: number, count: number, clamped: boolean } | null}
 */
export function parseReplayRange(spec, max = MAX_REPLAY_LEDGERS) {
  if (typeof spec !== 'string') return null;
  const m = /^\s*(\d{1,12})\s*(?:-\s*(\d{1,12})\s*)?$/.exec(spec);
  if (!m) return null;
  let from = Number(m[1]);
  let to = m[2] != null ? Number(m[2]) : from;
  if (!(from > 0) || !(to > 0)) return null;
  if (to < from) [from, to] = [to, from];
  let clamped = false;
  if (to - from + 1 > max) {
    to = from + max - 1;
    clamped = true;
  }
  return { from, to, count: to - from + 1, clamped };
}

/** The inverse of parseReplayRange, for building permalinks. */
export function formatReplayRange({ from, to }) {
  return from === to ? String(from) : `${from}-${to}`;
}

/**
 * Milliseconds the ledger stayed open, from its close time and the next
 * ledger's (both in Ripple-epoch seconds). Falls back to 4 s when the next
 * close is unknown or implausible.
 */
export function replayIntervalMs(ledger, nextCloseTime) {
  const close = Number(ledger?.close_time);
  const next = Number(nextCloseTime);
  if (!Number.isFinite(close) || !Number.isFinite(next)) return DEFAULT_CLOSE_INTERVAL_MS;
  const ms = (next - close) * 1000;
  if (!(ms > 0) || ms > MAX_CLOSE_INTERVAL_MS) return DEFAULT_CLOSE_INTERVAL_MS;
  return ms;
}

function transactionIndex(entry) {
  const meta = entry?.meta ?? entry?.metaData;
  const i = Number(meta?.TransactionIndex);
  return Number.isFinite(i) ? i : Number.POSITIVE_INFINITY;
}

/**
 * Lay a ledger's transactions out across its close interval.
 * Entries are sorted by metadata `TransactionIndex` (the order the ledger
 * applied them; the `ledger` command returns them in hash order) and spaced
 * evenly with half a slot of padding at each end, so nothing lands exactly on
 * the ledger tick.
 * @param {object} ledger  the `ledger` object from a `ledger` command result
 * @param {number|null} nextCloseTime  close_time of ledger_index + 1, Ripple epoch seconds
 * @returns {{ tx: object, offsetMs: number }[]}
 */
export function scheduleReplay(ledger, nextCloseTime) {
  const list = Array.isArray(ledger?.transactions) ? ledger.transactions : [];
  const entries = list
    .map((tx, i) => ({ tx, i, index: transactionIndex(tx) }))
    .filter((e) => e.tx && typeof e.tx === 'object')
    .sort((a, b) => a.index - b.index || a.i - b.i);
  const intervalMs = replayIntervalMs(ledger, nextCloseTime);
  const n = entries.length;
  return entries.map((e, i) => ({ tx: e.tx, offsetMs: ((i + 0.5) * intervalMs) / n }));
}

/** A synthetic `ledgerClosed` message for a replayed ledger, for mapping.ledgerToEvent. */
export function replayLedgerMessage(ledger) {
  const list = Array.isArray(ledger?.transactions) ? ledger.transactions : [];
  return {
    type: 'ledgerClosed',
    ledger_index: Number(ledger?.ledger_index),
    ledger_hash: ledger?.ledger_hash ?? null,
    ledger_time: Number(ledger?.close_time),
    txn_count: list.length,
    replay: true,
  };
}

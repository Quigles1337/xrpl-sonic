// xrpl-sonic — coherence: the statistic and its readout (phase 1, and phase
// 1.5: the null fixed by prewhitening, a wider window from account_tx, and
// the record checked for every pair).
//
// Relations between accounts, read from when they act. Each account gets a
// series over the window: per ledger, the transactions it submitted (the
// primary measure; `volume` is the alternative, the sum of log10(1 + XRP) of
// the XRP-denominated amounts; `involved` counts every transaction the
// account appears in, from account_tx). Each series is normalised as the
// deviation from the account's own baseline over the window (a z-score over
// the ledgers used), so a constant always-on account comes out flat and can
// show no coherence. Between two normalised series the cross-correlation at
// each lag in [−L, L] is the normalised sum of products over the ledgers that
// overlap at that lag; the lag with the largest |r| is the peak, and a
// positive lag means the second account follows the first. Lags are counted
// in ledgers on the ledger-index axis, so a missing ledger, or one the live
// stream did not fully receive, is simply absent: it pairs with nothing,
// contributes nothing, and is never read as zero.
//
// A series with a rhythm of its own (a market maker on a three-ledger
// cadence) correlates with any other rhythmic series at some lag by
// construction. So each series is also prewhitened: its own autoregressive
// structure (an AR fit by Burg's method, the order by AICc up to L) is removed and the residuals are correlated instead. The
// raw and the prewhitened r are both reported, each with its null, and the
// pairs are ranked by the prewhitened one. The null is the largest |r| over
// seeded circular shifts of the second series, excluding shifts within L of
// zero (those reproduce the real alignment at another lag), reported as the
// share of shifts the observed |r| exceeds, with the number of pairs tested
// beside it. Each account's own cadence (its best self-correlation at a lag
// of two or more) is kept and named, and two cadences give a beat.
//
// For every pair above the guard the record is checked (src/record.js): the
// transactions of the window in which one submitted and the other is the
// Destination, owns an entry in the AffectedNodes, or owned an offer that
// was crossed. A high r with no connection is co-activity, not a relation.
//
// Everything reported is tier `observation` (docs/facts.md): a correlation
// at a lag is what the series show; coordination or common ownership would
// be a hypothesis, and the readout says so. See docs/coherence.md.
//
// Pure: no DOM, no network, no audio, no canvas.

import { shortAddress, RIPPLE_EPOCH_OFFSET } from './mapping.js';
import { touchesOfLedger, touchesOfEntries, connections, describeConnections, connectionLines } from './record.js';
import { uncovered, COVERAGE_REASONS } from './account-tx.js';

export const COHERENCE_VERSION = 3;
export const MEASURES = Object.freeze(['count', 'volume', 'involved']);
export const TIER = 'observation';
/** The bins a frame can be read in: the seconds of one bin, 0 for the ledger itself (docs/coherence.md, phase 2). */
export const BINS = Object.freeze({ ledger: 0, minute: 60, hour: 3600, day: 86400 });
export const BIN_NAMES = Object.freeze(Object.keys(BINS));
/** The close interval assumed when a window's dates cannot say (seconds per ledger). */
export const ASSUMED_CLOSE_SECONDS = 4;

/**
 * Defaults. maxLag 8: a 50-ledger case keeps at least 42 overlapping pairs at
 * the furthest lag and a 12-ledger moment still has 4. minLedgers 12 and
 * minEvents 10: see docs/coherence.md, "Defaults", for the measurements they
 * rest on. shuffles 200 is a ceiling; a 50-ledger window has 33 admissible
 * shifts and uses them all, so the percentile's resolution is stated beside it.
 * maxOrder 0 means "up to L" for the AR fit. significance 0.95 is the
 * percentile at which a pair is counted among those "above the 95th".
 */
export const DEFAULTS = Object.freeze({ measure: 'count', maxLag: 8, minLedgers: 12, minEvents: 10, topK: 5, shuffles: 200, seed: 1337, subWindows: 3, minSubOverlap: 6, maxOrder: 0, significance: 0.95, maxHashes: 8, bin: 'ledger' });
export const LIMITS = Object.freeze({ maxLag: [1, 25], minLedgers: [2, 50], minEvents: [1, 100000], topK: [2, 12], shuffles: [0, 5000], subWindows: [2, 6], maxOrder: [0, 25], maxHashes: [0, 200] });

/**
 * The share of a series' variance an AR fit may leave before the series
 * counts as fully predicted by its own past: below one part in two hundred
 * the residual is end effects and rounding (an exact pulse every third
 * ledger leaves 7 parts in ten thousand at order 2, an exact pulse every
 * sixth 4 parts in a thousand at order 5), and there is nothing left to
 * correlate; the fit stops at that order. Real series stay far above it
 * (a market maker on a near-exact three-ledger cadence leaves 4.5%).
 */
export const PREDICTED_VARIANCE = 0.005;

/** Why a ledger is not used: it is absent, not zero. */
export const EXCLUSIONS = Object.freeze({
  missing: 'not available from the node',
  incomplete: 'not fully received (received < txn_count)',
  unknown: 'transaction count unknown',
  history: COVERAGE_REASONS.history,
  unvalidated: COVERAGE_REASONS.unvalidated,
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmtLag = (k) => (k > 0 ? `+${k}` : String(k));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fmtN = (n) => Number(n).toLocaleString('en-US');

export function normalizeOptions(input) {
  const o = { ...DEFAULTS };
  if (!input || typeof input !== 'object') return o;
  if (MEASURES.includes(input.measure)) o.measure = input.measure;
  if (typeof input.bin === 'string' && BINS[input.bin] != null) o.bin = input.bin;
  for (const key of ['maxLag', 'minLedgers', 'minEvents', 'topK', 'shuffles', 'subWindows', 'maxOrder', 'maxHashes']) {
    const v = Number(input[key]);
    if (Number.isFinite(v)) o[key] = clamp(Math.round(v), LIMITS[key][0], LIMITS[key][1]);
  }
  const seed = Number(input.seed);
  if (Number.isFinite(seed)) o.seed = Math.round(seed) >>> 0;
  const mso = Number(input.minSubOverlap);
  if (Number.isFinite(mso) && mso >= 2) o.minSubOverlap = Math.round(mso);
  const sig = Number(input.significance);
  if (Number.isFinite(sig) && sig > 0.5 && sig < 1) o.significance = sig;
  return o;
}

/** log10(1 + XRP) of an event's amount; 0 when the amount is not XRP-denominated or absent. */
export function logVolume(event) {
  const v = event?.amount?.isXrp ? Number(event.amount.value) : 0;
  return v > 0 ? Math.log10(1 + v) : 0;
}

// ---------------------------------------------------------------------------
// Frames: the ledgers of a window, one series per account, and the record
// ---------------------------------------------------------------------------

/**
 * The accounts to measure: the cast (by address, with labels), else the
 * top-K submitters of the frame by events over the ledgers used.
 * @returns {{ address: string, label: string }[]}
 */
export function accountsFor(cast, totals, { topK = DEFAULTS.topK } = {}) {
  const members = (cast ?? []).filter((m) => m && typeof m.address === 'string').map((m) => ({ address: m.address, label: m.label || shortAddress(m.address) }));
  if (members.length) return members;
  return [...(totals ?? new Map()).entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, topK)
    .map(([address]) => ({ address, label: shortAddress(address) }));
}

function emptyFrame(source) {
  return { source, measure: DEFAULTS.measure, unit: 'ledger', bin: null, ledgers: [], accounts: [], series: new Map(), totals: new Map(), chosen: 'none', records: null, fetched: null };
}

/**
 * The frame of a score: one row per ledger of the score in play order (a
 * missing ledger is a row that is not used), the submitters' totals over the
 * ledgers used, the accounts chosen, and per account a series aligned to the
 * rows. Events are the score's: what the listening settings selected. With
 * the fetched `ledgers` (the Map src/ledgers.js returns) the frame also
 * carries the touch records of every transaction in them, for the record check.
 * @param {object} score  from buildScore()
 * @param {{ cast?: object[], topK?: number, measure?: 'count'|'volume', ledgers?: Map<number, { ledger: object|null }> }} [options]
 */
export function frameFromScore(score, { cast = [], topK = DEFAULTS.topK, measure = DEFAULTS.measure, ledgers = null } = {}) {
  const frame = emptyFrame('score');
  frame.measure = measure === 'volume' ? 'volume' : DEFAULTS.measure;
  if (!score || !Array.isArray(score.ledgers)) return frame;
  frame.ledgers = score.ledgers.map((l) => ({ index: Number(l.ledgerIndex), included: !l.missing, reason: l.missing ? 'missing' : null, hash: l.hash ?? null, closeTime: isoSeconds(l.closeTimeIso) }));
  const row = new Map(frame.ledgers.map((l, i) => [l.index, i]));
  const counts = new Map(); // address → counts per row
  const volumes = new Map();
  for (const item of score.events ?? []) {
    const ev = item?.event;
    const address = ev?.account;
    const i = row.get(Number(item?.ledgerIndex));
    if (typeof address !== 'string' || !address || i == null || !frame.ledgers[i].included) continue;
    if (!counts.has(address)) {
      counts.set(address, new Array(frame.ledgers.length).fill(0));
      volumes.set(address, new Array(frame.ledgers.length).fill(0));
    }
    counts.get(address)[i] += 1;
    volumes.get(address)[i] += logVolume(ev);
  }
  for (const [address, c] of counts) frame.totals.set(address, c.reduce((a, b) => a + b, 0));
  frame.accounts = accountsFor(cast, frame.totals, { topK });
  frame.chosen = cast?.length ? 'cast' : `top ${topK} submitters`;
  const source = frame.measure === 'volume' ? volumes : counts;
  for (const a of frame.accounts) frame.series.set(a.address, source.get(a.address) ?? new Array(frame.ledgers.length).fill(0));
  if (ledgers && typeof ledgers.get === 'function') {
    frame.records = [];
    for (const l of frame.ledgers) {
      const entry = ledgers.get(l.index);
      if (entry?.ledger) frame.records.push(...touchesOfLedger(entry.ledger));
    }
  }
  return frame;
}

/**
 * The frame of the live window: the closed ledgers heard, used only when
 * the ledger's transaction count is known and every transaction was
 * received; the submitters counted by the window as transactions arrived,
 * and the touch records it kept, when it kept them.
 * @param {{ ledgers: { index, hash, txnCount, received, accounts, touches? }[] }} window  a LiveWindow (src/moment.js) or its `ledgers`
 */
export function frameFromLive(window, { cast = [], topK = DEFAULTS.topK, measure = DEFAULTS.measure } = {}) {
  const frame = emptyFrame('live');
  frame.measure = measure === 'volume' ? 'volume' : DEFAULTS.measure;
  const heard = Array.isArray(window) ? window : Array.isArray(window?.ledgers) ? window.ledgers : [];
  if (!heard.length) return frame;
  frame.ledgers = heard.map((l) => {
    const expected = l.txnCount == null ? null : Number(l.txnCount);
    const received = Number(l.received) || 0;
    const reason = expected == null ? 'unknown' : received < expected ? 'incomplete' : null;
    return { index: Number(l.index), included: !reason, reason, hash: l.hash ?? null, received, expected, closeTime: Number.isFinite(Number(l.closeTime)) ? Number(l.closeTime) + RIPPLE_EPOCH_OFFSET : null };
  });
  const counts = new Map();
  const volumes = new Map();
  heard.forEach((l, i) => {
    if (!frame.ledgers[i].included) return;
    for (const [address, rec] of Object.entries(l.accounts ?? {})) {
      if (!counts.has(address)) {
        counts.set(address, new Array(heard.length).fill(0));
        volumes.set(address, new Array(heard.length).fill(0));
      }
      counts.get(address)[i] += Number(rec?.count) || 0;
      volumes.get(address)[i] += Number(rec?.volume) || 0;
    }
  });
  for (const [address, c] of counts) frame.totals.set(address, c.reduce((a, b) => a + b, 0));
  frame.accounts = accountsFor(cast, frame.totals, { topK });
  frame.chosen = cast?.length ? 'cast' : `top ${topK} submitters`;
  const source = frame.measure === 'volume' ? volumes : counts;
  for (const a of frame.accounts) frame.series.set(a.address, source.get(a.address) ?? new Array(heard.length).fill(0));
  if (heard.some((l) => Array.isArray(l.touches))) {
    frame.records = [];
    heard.forEach((l, i) => {
      if (frame.ledgers[i].included && Array.isArray(l.touches)) frame.records.push(...l.touches);
    });
  }
  return frame;
}

/**
 * The frame of an account_tx fetch (src/account-tx.js): one row per ledger
 * of the range, used only when every account's fetch covered it; per
 * account the transactions it submitted (`count`), the transactions it is
 * involved in (`involved`, every entry account_tx returned for it) or its
 * log volume, failed transactions out unless `includeFailed`; the touch
 * records of every entry, once per hash. The accounts are the named ones,
 * in the order given.
 * @param {{ from: number, to: number, validatedLedger: object|null, accounts: object[] }} fetched  from fetchAccountSeries()
 */
export function frameFromAccountTx(fetched, { measure = DEFAULTS.measure, includeFailed = false, host = null } = {}) {
  const frame = emptyFrame('account_tx');
  frame.measure = MEASURES.includes(measure) ? measure : DEFAULTS.measure;
  const from = Number(fetched?.from);
  const to = Number(fetched?.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) return frame;
  const results = fetched.accounts ?? [];
  const reasons = new Map();
  for (const r of results) {
    const u = uncovered(r, from, to);
    for (const [n, reason] of u.reasons) if (!reasons.has(n)) reasons.set(n, reason);
  }
  frame.ledgers = [];
  for (let n = from; n <= to; n++) frame.ledgers.push({ index: n, included: !reasons.has(n), reason: reasons.get(n) ?? null, hash: null, closeTime: null });
  const row = new Map(frame.ledgers.map((l, i) => [l.index, i]));
  frame.accounts = results.map((r) => ({ address: r.account, label: r.label || shortAddress(r.account) }));
  frame.chosen = 'named accounts';
  const all = [];
  for (const r of results) {
    const counts = new Array(frame.ledgers.length).fill(0);
    const involved = new Array(frame.ledgers.length).fill(0);
    const volumes = new Array(frame.ledgers.length).fill(0);
    for (const e of r.entries ?? []) {
      const i = row.get(e.ledgerIndex);
      if (i == null || !frame.ledgers[i].included) continue;
      if (frame.ledgers[i].closeTime == null && Number.isFinite(Number(e.tx?.date))) frame.ledgers[i].closeTime = Number(e.tx.date) + RIPPLE_EPOCH_OFFSET;
      all.push(e);
      if (!e.success && !includeFailed) continue;
      involved[i] += 1;
      if (e.tx?.Account === r.account) {
        counts[i] += 1;
        volumes[i] += logVolume({ amount: xrpAmountOf(e) });
      }
    }
    frame.totals.set(r.account, counts.reduce((a, b) => a + b, 0));
    frame.series.set(r.account, frame.measure === 'volume' ? volumes : frame.measure === 'involved' ? involved : counts);
  }
  frame.records = touchesOfEntries(all.map((e) => ({ tx: e.tx, meta: e.meta, hash: e.hash, ledger_index: e.ledgerIndex })));
  frame.fetched = {
    host,
    validatedLedger: fetched.validatedLedger ?? null,
    includeFailed,
    accounts: results.map((r) => ({ address: r.account, label: r.label || shortAddress(r.account), bounds: r.bounds, pages: r.pages, requests: r.requests, entries: (r.entries ?? []).length, missing: r.missing ?? [], error: r.error ?? null })),
  };
  return frame;
}

/** The XRP amount of an account_tx entry as the mapping's amount shape, for logVolume; null when it is not XRP. */
function xrpAmountOf(e) {
  const delivered = e?.meta?.delivered_amount ?? e?.meta?.DeliveredAmount;
  const raw = typeof delivered === 'string' ? delivered : typeof e?.tx?.Amount === 'string' ? e.tx.Amount : typeof e?.tx?.DeliverMax === 'string' ? e.tx.DeliverMax : typeof e?.tx?.TakerGets === 'string' ? e.tx.TakerGets : null;
  if (raw == null || !/^\d+$/.test(raw)) return null;
  return { isXrp: true, value: Number(raw) / 1e6 };
}

/** Unix seconds of an ISO time, or null. */
function isoSeconds(iso) {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/**
 * A close time for every row: the known ones as they are; a row without one
 * placed between its nearest dated neighbours in proportion to its ledger
 * index; beyond the first or last dated row, at the dated span's mean close
 * interval (ASSUMED_CLOSE_SECONDS when the span has one date or none).
 * Null for every row when no row is dated.
 * @param {(number|null)[]} times
 * @param {number[]} indices  ledger indices of the rows
 */
export function interpolateCloseTimes(times, indices) {
  const dated = [];
  times.forEach((t, i) => {
    if (Number.isFinite(t)) dated.push(i);
  });
  if (!dated.length) return times.map(() => null);
  const first = dated[0];
  const last = dated.at(-1);
  const mean = last > first ? (times[last] - times[first]) / (indices[last] - indices[first]) : ASSUMED_CLOSE_SECONDS;
  const out = times.slice();
  let d = 0;
  for (let i = 0; i < times.length; i++) {
    if (Number.isFinite(times[i])) continue;
    while (d < dated.length && dated[d] < i) d += 1;
    const next = d < dated.length ? dated[d] : null;
    const prev = d > 0 ? dated[d - 1] : null;
    if (prev != null && next != null) out[i] = times[prev] + ((times[next] - times[prev]) * (indices[i] - indices[prev])) / (indices[next] - indices[prev]);
    else if (prev != null) out[i] = times[prev] + (indices[i] - indices[prev]) * mean;
    else out[i] = times[next] - (indices[next] - indices[i]) * mean;
  }
  return out;
}

/**
 * The frame read in bins of one minute, hour or day (UTC) instead of one
 * ledger: a bin is the run of ledgers whose close times fall in it, used only
 * when every ledger in it is used (the first excluded ledger's reason is the
 * bin's), and a bin with no ledger at all is absent, never zero, so a lag
 * across it is still a distance in bins. The series are summed per bin, the
 * totals recomputed over the bins used; the records are the ledgers' and are
 * unchanged. A frame with no dated row cannot be binned and is returned as it
 * is with `bin.error` set.
 * @param {object} frame  from a frame builder, in ledgers
 * @param {'ledger'|'minute'|'hour'|'day'} unit
 */
export function binFrame(frame, unit = 'ledger') {
  const seconds = BINS[unit];
  if (!frame || !seconds || (frame.unit ?? 'ledger') !== 'ledger') return frame;
  const rows = frame.ledgers ?? [];
  const times = interpolateCloseTimes(rows.map((l) => (Number.isFinite(l.closeTime) ? l.closeTime : null)), rows.map((l) => l.index));
  if (!rows.length || times.every((t) => t == null)) return { ...frame, unit: 'ledger', bin: { unit, seconds, ledgers: rows.length, bins: 0, error: 'no close time is known for any ledger of the window' } };
  const bins = [];
  const byKey = new Map();
  rows.forEach((l, i) => {
    const key = Math.floor(times[i] / seconds);
    let b = byKey.get(key);
    if (!b) {
      b = { key, rows: [], included: true, reason: null };
      byKey.set(key, b);
      bins.push(b);
    }
    b.rows.push(i);
    if (!l.included && b.included) {
      b.included = false;
      b.reason = l.reason ?? 'missing';
    }
  });
  bins.sort((x, y) => x.key - y.key);
  const firstKey = bins[0].key;
  const out = { ...frame, unit, bin: { unit, seconds, ledgers: rows.length, bins: bins.length, error: null }, series: new Map(), totals: new Map() };
  out.ledgers = bins.map((b) => ({ index: b.key - firstKey, included: b.included, reason: b.reason, hash: null, from: rows[b.rows[0]].index, to: rows[b.rows.at(-1)].index, ledgers: b.rows.length, closeTime: b.key * seconds }));
  for (const [address, series] of frame.series) {
    const v = bins.map((b) => (b.included ? b.rows.reduce((sum, i) => sum + (rows[i].included ? Number(series[i]) || 0 : 0), 0) : 0));
    out.series.set(address, v);
    out.totals.set(address, v.reduce((a, c) => a + c, 0));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The statistic
// ---------------------------------------------------------------------------

/**
 * A series as the deviation from its own baseline over the ledgers used: the
 * z-score with the sample standard deviation. `flat` when the series does
 * not vary (or fewer than two ledgers are used); its z is then all zeros.
 * Positions not used are left at 0 and never read.
 * @param {number[]} values
 * @param {boolean[]} [included]  which positions are used (default: all)
 */
export function normalise(values, included = null) {
  const use = (i) => (included ? Boolean(included[i]) : true);
  const xs = [];
  for (let i = 0; i < values.length; i++) if (use(i)) xs.push(Number(values[i]) || 0);
  const n = xs.length;
  const mean = n ? xs.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const flat = !(sd > 0);
  const z = values.map((v, i) => (use(i) && !flat ? ((Number(v) || 0) - mean) / sd : 0));
  return { z, mean, sd, n, flat };
}

/**
 * Normalised cross-correlation of two series (give them as z-scores) at every
 * lag in [−maxLag, maxLag]: at lag k, every pair of positions (i, j) with
 * position j − position i = k and both used contributes a_i·b_j, divided by
 * the root of the two sums of squares over the same pairs. A positive lag
 * means the second series follows the first: b at a later ledger matches a
 * at an earlier one. The peak is the lag with the largest |r|; ties go to
 * the smaller |lag|, then to the positive one.
 * @param {number[]} a
 * @param {number[]} b
 * @param {number} maxLag
 * @param {{ positions?: number[], included?: boolean[] }} [options]
 *   `positions` are the ledger indices of the rows (default 0, 1, 2, …), so a
 *   lag is a distance in ledgers even across a gap; `included` marks the rows used.
 * @returns {{ r: number, lag: number, n: number, overlap: number, byLag: { lag: number, r: number, overlap: number }[] }}
 */
export function crossCorrelation(a, b, maxLag, { positions = null, included = null } = {}) {
  const len = Math.min(a?.length ?? 0, b?.length ?? 0);
  const L = Math.max(0, Math.round(Number(maxLag) || 0));
  const pos = positions ?? Array.from({ length: len }, (_, i) => i);
  const use = (i) => (included ? Boolean(included[i]) : true);
  const at = new Map();
  for (let i = 0; i < len; i++) if (use(i)) at.set(pos[i], i);
  const byLag = [];
  let n = 0;
  for (let i = 0; i < len; i++) if (use(i)) n += 1;
  for (let k = -L; k <= L; k++) {
    let num = 0;
    let da = 0;
    let db = 0;
    let overlap = 0;
    for (let i = 0; i < len; i++) {
      if (!use(i)) continue;
      const j = at.get(pos[i] + k);
      if (j == null) continue;
      const x = Number(a[i]) || 0;
      const y = Number(b[j]) || 0;
      num += x * y;
      da += x * x;
      db += y * y;
      overlap += 1;
    }
    const r = da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
    byLag.push({ lag: k, r: Math.max(-1, Math.min(1, r)), overlap });
  }
  let peak = byLag.find((e) => e.lag === 0) ?? byLag[0] ?? { r: 0, lag: 0, overlap: 0 };
  for (const e of byLag) {
    const better = Math.abs(e.r) > Math.abs(peak.r) + 1e-12;
    const tie = Math.abs(Math.abs(e.r) - Math.abs(peak.r)) <= 1e-12;
    if (better || (tie && (Math.abs(e.lag) < Math.abs(peak.lag) || (Math.abs(e.lag) === Math.abs(peak.lag) && e.lag > peak.lag)))) peak = e;
  }
  return { r: peak.r, lag: peak.lag, n, overlap: peak.overlap, byLag };
}

/** A small deterministic generator (mulberry32), so the shuffle order is the same everywhere. */
export function seededRandom(seed) {
  let t = (Number(seed) || 0) >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The null beside r: circular shifts of the second series over the rows
 * used, excluding shifts within maxLag of zero (they reproduce the real
 * alignment at another lag) and their mirror images, in a seeded order, up
 * to `count` of them. For each shift the largest |r| over the lags is taken;
 * the percentile is the share of shifts the observed |r| strictly exceeds.
 * @returns {{ count: number, available: number, above: number, percentile: number|null, max: number }}
 */
export function shuffleTest(a, b, maxLag, { positions = null, included = null, count = DEFAULTS.shuffles, seed = DEFAULTS.seed, observed = null } = {}) {
  const len = Math.min(a?.length ?? 0, b?.length ?? 0);
  const L = Math.max(0, Math.round(Number(maxLag) || 0));
  const use = (i) => (included ? Boolean(included[i]) : true);
  const compact = [];
  for (let i = 0; i < len; i++) if (use(i)) compact.push(i);
  const m = compact.length;
  const shifts = [];
  for (let s = L + 1; s <= m - L - 1; s++) shifts.push(s);
  const base = observed ?? Math.abs(crossCorrelation(a, b, L, { positions, included }).r);
  const available = shifts.length;
  if (!available || count <= 0) return { count: 0, available, above: 0, percentile: null, max: 0 };
  const rand = seededRandom(seed);
  for (let i = shifts.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shifts[i], shifts[j]] = [shifts[j], shifts[i]];
  }
  const taken = shifts.slice(0, Math.min(count, available));
  let above = 0;
  let max = 0;
  for (const s of taken) {
    const shifted = b.slice();
    for (let t = 0; t < m; t++) shifted[compact[t]] = b[compact[(t + s) % m]];
    const peak = Math.abs(crossCorrelation(a, shifted, L, { positions, included }).r);
    if (peak < base) above += 1;
    if (peak > max) max = peak;
  }
  return { count: taken.length, available, above, percentile: above / taken.length, max };
}

/** The lag range a window can bear: the option, capped at a quarter of the ledgers used, so the furthest lag still overlaps on three quarters of them. */
export function effectiveLag(maxLag, used) {
  return Math.max(1, Math.min(Math.round(Number(maxLag) || 0), Math.floor(used / 4)));
}

/** AICc of an AR(p) fit with relative innovation variance sigma2 over n rows; Infinity when n cannot bear p, −Infinity when nothing is left to predict. */
export function aicc(n, sigma2, p) {
  if (!(n - p - 1 > 0)) return Infinity;
  if (!(sigma2 > 0)) return -Infinity;
  if (sigma2 < PREDICTED_VARIANCE) return -Infinity;
  return n * Math.log(sigma2) + 2 * p + (2 * p * (p + 1)) / (n - p - 1);
}

/**
 * An autoregressive fit of a series to itself by Burg's method: the
 * reflection coefficient of each order minimises the forward and backward
 * prediction errors over the rows used, taken along every run of
 * consecutive ledgers (a gap starts a new run; no error crosses it), and
 * the coefficients follow by the Levinson recursion. Burg rather than
 * Yule-Walker because a series with a near-exact cadence, a market maker
 * acting every third ledger, puts its poles on the unit circle, where the
 * autocorrelation route stalls at a low order while Burg keeps its
 * reflection coefficients inside (−1, 1) and reaches the order that
 * whitens it. The order is chosen by AICc among 0..maxOrder, ties to the
 * lower order; a fit that leaves nothing to predict is taken as it stands.
 * @returns {{ order: number, phi: number[], sigma2: number, n: number, candidates: { order: number, sigma2: number, aicc: number }[] }}
 *   `phi[j]` multiplies the value j + 1 ledgers earlier; `sigma2` is the innovation variance relative to the series' own.
 */
export function arFit(z, maxOrder, { positions = null, included = null } = {}) {
  const P = Math.max(0, Math.round(Number(maxOrder) || 0));
  const len = z?.length ?? 0;
  const pos = positions ?? Array.from({ length: len }, (_, i) => i);
  const use = (i) => (included ? Boolean(included[i]) : true);
  let n = 0;
  let sum = 0;
  for (let i = 0; i < len; i++) {
    if (!use(i)) continue;
    n += 1;
    sum += Number(z[i]) || 0;
  }
  const mean = n ? sum / n : 0;
  // runs of consecutive ledgers among the rows used
  const runs = [];
  let cur = null;
  for (let i = 0; i < len; i++) {
    if (!use(i)) {
      cur = null;
      continue;
    }
    const x = (Number(z[i]) || 0) - mean;
    if (cur && pos[i] === cur.last + 1) {
      cur.f.push(x);
      cur.b.push(x);
    } else {
      cur = { last: pos[i], f: [x], b: [x] };
      runs.push(cur);
    }
    cur.last = pos[i];
  }
  let a = [1]; // the prediction-error filter: e_t = Σ a_j z_{t−j}, a_0 = 1
  let sigma2 = 1;
  const candidates = [{ order: 0, phi: [], sigma2: 1, aicc: aicc(n, 1, 0) }];
  for (let p = 1; p <= P; p++) {
    let num = 0;
    let den = 0;
    for (const r of runs) {
      for (let t = p; t < r.f.length; t++) {
        num += r.f[t] * r.b[t - 1];
        den += r.f[t] * r.f[t] + r.b[t - 1] * r.b[t - 1];
      }
    }
    if (!(den > 0)) break;
    const k = (-2 * num) / den;
    if (!Number.isFinite(k) || Math.abs(k) > 1) break;
    const next = new Array(p + 1).fill(0);
    next[0] = 1;
    for (let j = 1; j < p; j++) next[j] = a[j] + k * a[p - j];
    next[p] = k;
    for (const r of runs) {
      for (let t = r.f.length - 1; t >= p; t--) {
        const ft = r.f[t];
        const bt = r.b[t - 1];
        r.f[t] = ft + k * bt;
        r.b[t] = bt + k * ft;
      }
    }
    a = next;
    sigma2 *= 1 - k * k;
    const predicted = !(sigma2 >= PREDICTED_VARIANCE);
    candidates.push({ order: p, phi: a.slice(1).map((v) => -v), sigma2, aicc: predicted ? -Infinity : aicc(n, sigma2, p), predicted });
    if (predicted) break;
  }
  let best = candidates[0];
  for (const c of candidates) if (c.aicc < best.aicc - 1e-12 || (c.aicc === -Infinity && best.aicc !== -Infinity)) best = c;
  return { order: best.order, phi: best.phi, sigma2: best.sigma2, predicted: Boolean(best.predicted), n, candidates: candidates.map(({ order, sigma2: s2, aicc: ac }) => ({ order, sigma2: s2, aicc: ac })) };
}

/**
 * A series with its own autoregressive structure removed: the residuals
 * z_t − Σ phi_j z_{t−j} at every row whose p predecessors on the ledger axis
 * are all used (a row after a gap, or among the first p, has no residual and
 * is not used), normalised again. `flat` when the residuals do not vary,
 * or when the fit left less than PREDICTED_VARIANCE of the variance: the
 * series is fully predicted by its own past and has nothing left to correlate.
 * @returns {{ residual: number[], included: boolean[], order: number, phi: number[], sigma2: number, n: number, flat: boolean, predicted: boolean }}
 */
export function prewhiten(z, maxOrder, { positions = null, included = null } = {}) {
  const len = z?.length ?? 0;
  const fit = arFit(z, maxOrder, { positions, included });
  const pos = positions ?? Array.from({ length: len }, (_, i) => i);
  const use = (i) => (included ? Boolean(included[i]) : true);
  const at = new Map();
  for (let i = 0; i < len; i++) if (use(i)) at.set(pos[i], i);
  const raw = new Array(len).fill(0);
  const mask = new Array(len).fill(false);
  for (let i = 0; i < len; i++) {
    if (!use(i)) continue;
    let e = Number(z[i]) || 0;
    let ok = true;
    for (let j = 1; j <= fit.order; j++) {
      const t = at.get(pos[i] - j);
      if (t == null) {
        ok = false;
        break;
      }
      e -= fit.phi[j - 1] * (Number(z[t]) || 0);
    }
    if (!ok) continue;
    raw[i] = e;
    mask[i] = true;
  }
  const norm = normalise(raw, mask);
  const flat = norm.flat || fit.predicted;
  return { residual: flat ? raw.map(() => 0) : norm.z, included: mask, order: fit.order, phi: fit.phi, sigma2: fit.sigma2, n: norm.n, flat, predicted: fit.predicted, candidates: fit.candidates };
}

/**
 * The peak lag over consecutive parts of the window (the rows used, split
 * into up to `parts` runs of equal length, each at least `minPart` ledgers,
 * by default three times the lag range), so a drifting lag can be seen.
 * Fewer than two parts fit: nothing is reported. A part whose overlap at
 * its peak is under `minOverlap` reports lag null.
 * @returns {{ from: number, to: number, r: number|null, lag: number|null, overlap: number, ledgers: number }[]}
 */
export function subWindowLags(a, b, maxLag, { positions = null, included = null, parts = DEFAULTS.subWindows, minPart = null, minOverlap = DEFAULTS.minSubOverlap } = {}) {
  const len = Math.min(a?.length ?? 0, b?.length ?? 0);
  const use = (i) => (included ? Boolean(included[i]) : true);
  const pos = positions ?? Array.from({ length: len }, (_, i) => i);
  const compact = [];
  for (let i = 0; i < len; i++) if (use(i)) compact.push(i);
  const m = compact.length;
  const least = Math.max(2, Math.round(minPart ?? 3 * (Math.round(Number(maxLag)) || 1)));
  const k = Math.min(Math.max(1, Math.round(parts) || 1), Math.floor(m / least));
  if (k < 2) return [];
  const out = [];
  for (let p = 0; p < k; p++) {
    const lo = Math.floor((p * m) / k);
    const hi = Math.floor(((p + 1) * m) / k);
    if (hi <= lo) continue;
    const mask = new Array(len).fill(false);
    for (let t = lo; t < hi; t++) mask[compact[t]] = true;
    // a part in which either series does not vary has no correlation to report: undefined, not r 1.00
    const flatIn = (s) => {
      let first = null;
      for (let t = lo; t < hi; t++) {
        const v = Number(s[compact[t]]) || 0;
        if (first == null) first = v;
        else if (Math.abs(v - first) > 1e-12) return false;
      }
      return true;
    };
    if (flatIn(a) || flatIn(b)) {
      out.push({ from: pos[compact[lo]], to: pos[compact[hi - 1]], r: null, lag: null, overlap: 0, ledgers: hi - lo, flat: true, reason: 'no variance' });
      continue;
    }
    const c = crossCorrelation(a, b, maxLag, { positions: pos, included: mask });
    const ok = c.overlap >= minOverlap;
    out.push({ from: pos[compact[lo]], to: pos[compact[hi - 1]], r: ok ? c.r : null, lag: ok ? c.lag : null, overlap: c.overlap, ledgers: hi - lo });
  }
  return out;
}

/**
 * An account's own cadence: the lag of two or more ledgers at which its
 * normalised series best matches itself, when that autocorrelation reaches
 * `least`; null otherwise. Spacing, in the interference picture.
 * @returns {{ period: number, r: number }|null}
 */
export function cadenceOf(z, maxLag, { positions = null, included = null, least = 0.3 } = {}) {
  const c = crossCorrelation(z, z, maxLag, { positions, included });
  let best = null;
  for (const e of c.byLag) {
    if (e.lag < 2) continue;
    if (e.r >= least && (!best || e.r > best.r + 1e-12)) best = { period: e.lag, r: e.r };
  }
  return best;
}

/**
 * Each account's own cadence, independent of pairs (docs/universe-requests.md,
 * R3): address → { period, r } or null, for every account of the frame, under
 * the same guard as a pair (`minLedgers` ledgers used) and the same
 * normalisation; null when the window is too short, the account has no series
 * or its series is flat. The frame is read as given: bin it first if wanted.
 * @param {object} frame  from frameFromScore(), frameFromLive() or frameFromAccountTx()
 * @returns {Map<string, { period: number, r: number } | null>}
 */
export function cadences(frame, options = DEFAULTS) {
  const o = normalizeOptions(options);
  const out = new Map();
  const ledgers = frame?.ledgers ?? [];
  const included = ledgers.map((l) => l.included);
  const positions = ledgers.map((l) => l.index);
  const used = included.filter(Boolean).length;
  const L = effectiveLag(o.maxLag, used);
  for (const a of frame?.accounts ?? []) {
    if (used < o.minLedgers || !frame.series?.has(a.address)) {
      out.set(a.address, null);
      continue;
    }
    const z = normalise(frame.series.get(a.address), included);
    out.set(a.address, z.flat ? null : cadenceOf(z.z, L, { positions, included }));
  }
  return out;
}

/** The AR order limit for a frame: the option, or L when the option is 0. */
export function orderLimit(options, L) {
  return options.maxOrder > 0 ? Math.min(options.maxOrder, L) : L;
}

/** The pair's record: the guard, the normalisation, the raw peak and its null, the prewhitened peak and its null, the record check, the parts and the cadences. */
export function pairCoherence(frame, first, second, options = DEFAULTS) {
  const o = normalizeOptions(options);
  const included = frame.ledgers.map((l) => l.included);
  const positions = frame.ledgers.map((l) => l.index);
  const used = included.filter(Boolean).length;
  const a = frame.series.get(first.address) ?? [];
  const b = frame.series.get(second.address) ?? [];
  const eventsA = frame.totals.get(first.address) ?? 0;
  const eventsB = frame.totals.get(second.address) ?? 0;
  const L = effectiveLag(o.maxLag, used);
  const pair = { a: { ...first, events: eventsA }, b: { ...second, events: eventsB }, n: used, measure: frame.measure ?? o.measure, unit: frame.unit ?? 'ledger', maxLag: L, judged: false, reason: null, flat: null, r: null, lag: null, overlap: null, shuffle: null, white: null, record: null, tested: null, subWindows: [], drift: null, cadence: null, beat: null, byLag: null };
  if (used < o.minLedgers) {
    pair.reason = `${plural(used, 'ledger')} used (guard ≥ ${o.minLedgers})`;
    return pair;
  }
  if (eventsA < o.minEvents || eventsB < o.minEvents) {
    pair.reason = `events ${eventsA}/${eventsB} (guard ≥ ${o.minEvents} each)`;
    return pair;
  }
  const za = normalise(a, included);
  const zb = normalise(b, included);
  pair.judged = true;
  pair.flat = { a: za.flat, b: zb.flat };
  pair.record = frame.records ? connections(frame.records, first.address, second.address) : null;
  if (za.flat || zb.flat) {
    pair.r = 0;
    pair.lag = 0;
    pair.overlap = used;
    pair.reason = za.flat && zb.flat ? 'both are flat' : `${za.flat ? first.label : second.label} is flat`;
    return pair;
  }
  const c = crossCorrelation(za.z, zb.z, L, { positions, included });
  pair.r = c.r;
  pair.lag = c.lag;
  pair.overlap = c.overlap;
  pair.byLag = c.byLag;
  pair.shuffle = shuffleTest(za.z, zb.z, L, { positions, included, count: o.shuffles, seed: o.seed, observed: Math.abs(c.r) });
  // prewhitened: each series less its own AR structure, correlated on the rows where both residuals exist
  const P = orderLimit(o, L);
  const wa = prewhiten(za.z, P, { positions, included });
  const wb = prewhiten(zb.z, P, { positions, included });
  const mask = included.map((u, i) => Boolean(u && wa.included[i] && wb.included[i]));
  const rows = mask.filter(Boolean).length;
  pair.white = { ar: { a: wa.order, b: wb.order }, sigma2: { a: wa.sigma2, b: wb.sigma2 }, n: rows, flat: { a: wa.flat, b: wb.flat }, reason: null, r: null, lag: null, overlap: null, shuffle: null, byLag: null };
  if (wa.flat || wb.flat) {
    const who = wa.flat && wb.flat ? 'both are' : `${wa.flat ? first.label : second.label} is`;
    pair.white.reason = `${who} fully predicted by its own past (AR(${wa.flat ? wa.order : wb.order})), no residual to correlate`;
  } else if (rows < 3) {
    pair.white.reason = `${plural(rows, 'residual row')}, too few to correlate`;
  } else {
    const w = crossCorrelation(wa.residual, wb.residual, L, { positions, included: mask });
    pair.white.r = w.r;
    pair.white.lag = w.lag;
    pair.white.overlap = w.overlap;
    pair.white.byLag = w.byLag;
    pair.white.shuffle = shuffleTest(wa.residual, wb.residual, L, { positions, included: mask, count: o.shuffles, seed: o.seed, observed: Math.abs(w.r) });
  }
  pair.subWindows = subWindowLags(za.z, zb.z, L, { positions, included, parts: o.subWindows, minOverlap: o.minSubOverlap });
  const lags = pair.subWindows.filter((s) => s.lag != null).map((s) => s.lag);
  pair.drift = lags.length >= 2 ? Math.max(...lags) - Math.min(...lags) : null;
  // the two cadences, and the beat between them: with periods p and q the alignment recurs every pq/|q − p| ledgers
  pair.cadence = { a: cadenceOf(za.z, L, { positions, included }), b: cadenceOf(zb.z, L, { positions, included }) };
  pair.beat = beatOf(pair.cadence.a, pair.cadence.b);
  return pair;
}

/**
 * What two cadences make together: `{ shared: p }` when they are the same,
 * `{ periods: [p, q], every: n }` when they differ (the alignment recurs
 * every pq/|q − p| ledgers, rounded), null when either account has none.
 */
export function beatOf(a, b) {
  if (!a || !b) return null;
  if (a.period === b.period) return { shared: a.period };
  const p = a.period;
  const q = b.period;
  return { periods: [p, q], every: Math.round((p * q) / Math.abs(q - p)) };
}

/** The shifts a null needs before the significance percentile means anything: 20 for the 95th (one shift is 5% of twenty). */
export function minShuffles(significance = DEFAULTS.significance) {
  return Math.ceil(1 / (1 - significance) - 1e-9);
}

/**
 * Is the pair above the significance percentile on the prewhitened (or, when
 * that is unavailable, the raw) null, with enough shifts to resolve it? A
 * pair above all 7 of 7 shifts is not called significant: at 20 ledgers the
 * null cannot tell the 95th from the 86th, and the count printed beside the
 * percentile is the warning.
 */
export function significant(pair, significance = DEFAULTS.significance) {
  const s = pair?.white?.shuffle ?? pair?.shuffle;
  return Boolean(s && s.count >= minShuffles(significance) && s.percentile >= significance);
}

/**
 * The report for a frame: every pair of its accounts, judged pairs first by
 * the prewhitened |r| (then by its percentile, then by the raw |r|), the
 * rest after, with the window, the options, the number of pairs tested and
 * how many stand above the significance percentile on each null, so the
 * readout can be checked.
 */
export function coherence(input, options = DEFAULTS) {
  const o = normalizeOptions(options);
  const frame = o.bin !== 'ledger' && input ? binFrame(input, o.bin) : input;
  const ledgers = frame?.ledgers ?? [];
  const accounts = frame?.accounts ?? [];
  const pairs = [];
  for (let i = 0; i < accounts.length; i++) for (let j = i + 1; j < accounts.length; j++) pairs.push(pairCoherence(frame, accounts[i], accounts[j], o));
  const tested = pairs.filter((p) => p.shuffle?.count).length;
  for (const p of pairs) p.tested = tested;
  const rank = (p) => (p.judged && !p.flat?.a && !p.flat?.b ? (p.white?.r != null ? 3 : 2) : p.judged ? 1 : 0);
  pairs.sort((x, y) => rank(y) - rank(x) || Math.abs(y.white?.r ?? 0) - Math.abs(x.white?.r ?? 0) || (y.white?.shuffle?.percentile ?? 0) - (x.white?.shuffle?.percentile ?? 0) || Math.abs(y.r ?? 0) - Math.abs(x.r ?? 0) || (y.shuffle?.percentile ?? 0) - (x.shuffle?.percentile ?? 0) || x.a.label.localeCompare(y.a.label));
  const excluded = {};
  for (const l of ledgers) if (!l.included) excluded[l.reason ?? 'missing'] = (excluded[l.reason ?? 'missing'] ?? 0) + 1;
  const included = ledgers.map((l) => l.included);
  const positions = ledgers.map((l) => l.index);
  const used = included.filter(Boolean).length;
  const L = effectiveLag(o.maxLag, used);
  const P = orderLimit(o, L);
  // each account's own cadence (cadences(), independent of pairs) and AR order, when the window can bear it
  const owned = cadences(frame, o);
  const own = (address) => {
    if (used < o.minLedgers) return { cadence: null, ar: null };
    const z = normalise(frame.series.get(address) ?? [], included);
    if (z.flat) return { cadence: null, ar: null };
    return { cadence: owned.get(address) ?? null, ar: arFit(z.z, P, { positions, included }).order };
  };
  const least = minShuffles(o.significance);
  const resolved = pairs.filter((p) => p.shuffle?.count >= least).length;
  const above = {
    raw: pairs.filter((p) => p.shuffle?.count >= least && p.shuffle.percentile >= o.significance).length,
    white: pairs.filter((p) => p.white?.shuffle?.count >= least && p.white.shuffle.percentile >= o.significance).length,
    expected: resolved * (1 - o.significance),
    resolved,
    unresolved: tested - resolved,
    minShuffles: least,
  };
  return {
    version: COHERENCE_VERSION,
    tier: TIER,
    source: frame?.source ?? 'none',
    unit: frame?.unit ?? 'ledger',
    bin: frame?.bin ?? null,
    measure: frame?.measure ?? o.measure,
    chosen: frame?.chosen ?? 'none',
    options: o,
    maxLag: L,
    maxOrder: P,
    window: { from: ledgers[0]?.from ?? ledgers[0]?.index ?? null, to: ledgers.at(-1)?.to ?? ledgers.at(-1)?.index ?? null, ledgers: ledgers.length, used, excluded, ledgerCount: frame?.bin?.ledgers ?? ledgers.length },
    accounts: accounts.map((a) => ({ ...a, events: frame.totals.get(a.address) ?? 0, ...own(a.address) })),
    records: frame?.records ? frame.records.length : null,
    fetched: frame?.fetched ?? null,
    tested,
    above,
    pairs,
  };
}

// ---------------------------------------------------------------------------
// The readout
// ---------------------------------------------------------------------------

/** "B follows A by 2 ledgers", "A follows B by 1 ledger", "in step", for a lag. */
export function followText(pair, lag = pair?.lag) {
  const unit = pair?.unit ?? 'ledger';
  if (lag > 0) return `${pair.b.label} follows ${pair.a.label} by ${plural(lag, unit)}`;
  if (lag < 0) return `${pair.a.label} follows ${pair.b.label} by ${plural(-lag, unit)}`;
  return 'in step';
}

/** "above 61% of shuffles (20 of 33; 10 pairs tested)". */
function nullText(s, tested) {
  if (!s || !s.count) return 'no shuffle test (too few ledgers for a shift beyond the lags)';
  return `above ${Math.round(s.percentile * 100)}% of shuffles (${s.above} of ${s.count}${tested != null ? `; ${plural(tested, 'pair')} tested` : ''})`;
}

/** One line per pair, in the project's voice; every number in it is one the statistic produced. */
export function describePair(pair, { significance = DEFAULTS.significance } = {}) {
  const head = `${pair.a.label} ↔ ${pair.b.label}`;
  const unit = pair.unit ?? 'ledger';
  if (!pair.judged) return `${head}: not judged: ${pair.reason}`;
  if (pair.flat?.a || pair.flat?.b) {
    const why = pair.measure === 'volume' ? `the same XRP volume in every ${unit} used, which for an account that moves no XRP is none` : `the same count in every ${unit} used`;
    return `${head}: no coherence: ${pair.reason} (${why}) · ${plural(pair.n, unit)} · events ${pair.a.events}/${pair.b.events} · ${pair.record ? describeConnections(pair.record) : 'record not available'}`;
  }
  const w = pair.white;
  const parts = [];
  if (w && w.r != null) {
    parts.push(`prewhitened r ${w.r.toFixed(2)} at lag ${fmtLag(w.lag)} (${followText(pair, w.lag)}) ${nullText(w.shuffle, pair.tested)}`);
    parts.push(`raw r ${pair.r.toFixed(2)} at lag ${fmtLag(pair.lag)} ${nullText(pair.shuffle, pair.tested)}`);
    parts.push(`${plural(pair.n, unit)} (overlap ${pair.overlap}; ${plural(w.n, 'residual row')} after AR(${w.ar.a})/AR(${w.ar.b}), overlap ${w.overlap})`);
  } else {
    parts.push(`raw r ${pair.r.toFixed(2)} at lag ${fmtLag(pair.lag)} (${followText(pair)}) ${nullText(pair.shuffle, pair.tested)}`);
    parts.push(`prewhitened: ${w ? w.reason : 'not computed'}`);
    parts.push(`${plural(pair.n, unit)} (overlap ${pair.overlap})`);
  }
  parts.push(`events ${pair.a.events}/${pair.b.events}`);
  if (pair.record) {
    const text = describeConnections(pair.record);
    parts.push(!pair.record.count && significant(pair, significance) ? `co-activity, not a relation: ${text}` : text);
  } else parts.push('record not available');
  const subs = pair.subWindows.filter((s) => s.lag != null || s.flat);
  if (subs.length >= 2) parts.push(`${subs.length} parts of ${subs[0].ledgers}: lag ${subs.map((s) => (s.flat ? `undefined (${s.reason})` : `${fmtLag(s.lag)} (r ${s.r.toFixed(2)})`)).join(', ')}`);
  const beat = pair.beat;
  if (beat) parts.push(beat.shared != null ? `shared cadence of ${plural(beat.shared, unit)}` : `cadences of ${beat.periods[0]} and ${beat.periods[1]} ${unit}s: a mismatch, the alignment recurs every ${plural(beat.every, unit)}`);
  return `${head}: ${parts.join(' · ')}`;
}

/**
 * Why nothing was judged, and what would satisfy the guard, for the readout's
 * empty state (docs/ux.md): no ledger heard, fewer than two accounts, too
 * few ledgers used, or an account short of events, with its rate so far
 * turned into the ledgers it would take. Null when a pair was judged.
 */
export function guardText(report) {
  if (!report) return null;
  const o = report.options ?? DEFAULTS;
  const unit = report.unit ?? 'ledger';
  if (!report.window?.ledgers) return `No ledger heard yet: press Start and listen; the readout needs at least ${plural(o.minLedgers, unit)}.`;
  if ((report.accounts ?? []).length < 2) return 'Fewer than two accounts to compare: add a second cast member, or listen until two accounts have submitted.';
  if ((report.pairs ?? []).some((p) => p.judged)) return null;
  const used = report.window.used;
  const bits = [];
  if (used < o.minLedgers) {
    const more = o.minLedgers - used;
    bits.push(`${plural(used, unit)} used; the guard needs ${o.minLedgers}: ${report.source === 'live' ? `listen for ${more} more ${unit}${more === 1 ? '' : 's'}` : `a case with ${o.minLedgers} or more ${unit}s`}`);
  }
  for (const a of report.accounts) {
    if (a.events >= o.minEvents) continue;
    const rate = used > 0 ? a.events / used : 0;
    const more = rate > 0 ? Math.ceil((o.minEvents - a.events) / rate) : null;
    bits.push(`${a.label} has ${plural(a.events, 'event')} over ${plural(used, unit)}; the guard needs ${o.minEvents} per account${more != null ? `: at its rate so far it would need about ${more} more ${unit}${more === 1 ? '' : 's'}` : ''}`);
  }
  if (!bits.length) bits.push(report.pairs[0]?.reason ?? 'below the guard');
  return `Not judged: ${bits.join(' · ')}.`;
}

/** The continuation lines of a pair: the connecting transactions' hashes, when there are any. */
export function pairDetailLines(pair, { maxHashes = DEFAULTS.maxHashes } = {}) {
  if (!pair?.record?.count) return [];
  const labelOf = (address) => (address === pair.a.address ? pair.a.label : address === pair.b.address ? pair.b.label : shortAddress(address));
  return connectionLines(pair.record, labelOf, { max: maxHashes }).map((l) => `  ${l}`);
}

const SOURCE_WORDS = Object.freeze({ live: 'live window', score: 'case', account_tx: 'account_tx' });

/** The whole report as text: what was measured, over what, under which settings, then one line per pair (and its hashes). */
export function readout(report) {
  if (!report) return '';
  const w = report.window;
  const o = report.options;
  const lines = [];
  const excluded = Object.entries(w.excluded ?? {}).map(([k, n]) => `${n} ${EXCLUSIONS[k] ?? k}`);
  const span = w.from != null ? `#${w.from}–#${w.to}` : 'empty';
  const unit = report.unit ?? 'ledger';
  const binned = report.bin && !report.bin.error ? ` (${fmtN(report.bin.ledgers)} ledgers in bins of one ${unit}, UTC)` : report.bin?.error ? ` (bins of one ${o.bin}: ${report.bin.error}; read per ledger)` : '';
  lines.push(`coherence v${report.version} · ${SOURCE_WORDS[report.source] ?? report.source} ${span} · ${w.used} of ${plural(w.ledgers, unit)} used${binned}${excluded.length ? ` (excluded: ${excluded.join(', ')})` : ''}`);
  const measure = report.measure === 'volume' ? `log volume per ${unit} (sum of log10(1 + XRP) of the XRP-denominated amounts submitted)` : report.measure === 'involved' ? `transactions involved in per ${unit} (the account anywhere in the transaction or its metadata)` : `transactions submitted per ${unit}`;
  const origin = report.source === 'live' ? 'counted as the stream delivered them' : report.source === 'account_tx' ? `from account_tx (failed ${report.fetched?.includeFailed ? 'included' : 'excluded'})` : 'from the score (events selected by the listening settings)';
  const L = report.maxLag ?? o.maxLag;
  const P = report.maxOrder ?? L;
  const lagText = L < o.maxLag ? `lags ±${L} ${unit}s (a quarter of the ${w.used} used; the option is ±${o.maxLag})` : `lags ±${L} ${unit}s`;
  lines.push(`series: ${measure}, ${origin} · accounts: ${report.chosen} · ${lagText} · guard ≥${o.minLedgers} ${unit}s, ≥${o.minEvents} events each · null: up to ${o.shuffles} circular shifts beyond ±${L}, seed ${o.seed}, on the raw series and on the residuals · prewhitening: each series less its own AR fit (Burg, order by AICc up to ${P}); pairs ranked by the prewhitened r · parts of ≥${3 * L} ${unit}s for inspection`);
  if (report.fetched) {
    const f = report.fetched;
    const v = f.validatedLedger ? `validated ledger #${f.validatedLedger.index} at query time` : 'validated ledger at query time unknown';
    const per = f.accounts.map((a) => {
      const bits = [a.bounds ? `bounds #${a.bounds.min}–#${a.bounds.max}` : 'no bounds echoed', `${plural(a.pages, 'page')} in ${plural(a.requests, 'request')}`, `${a.entries} ${a.entries === 1 ? 'entry' : 'entries'}`];
      for (const m of a.missing) bits.push(`#${m.from}–#${m.to} ${EXCLUSIONS[m.reason] ?? m.reason}`);
      if (a.error) bits.push(`error: ${a.error}`);
      return `${a.label}: ${bits.join(', ')}`;
    });
    lines.push(`account_tx${f.host ? ` on ${f.host}` : ''} · ${v} · ${per.join('; ')}`);
  }
  const ownText = (a) => `${a.cadence ? `, cadence ${plural(a.cadence.period, unit)} (self-correlation ${a.cadence.r.toFixed(2)})` : ''}${a.ar != null ? `, AR(${a.ar})` : ''}`;
  lines.push(`accounts: ${report.accounts.length ? report.accounts.map((a) => `${a.label} = ${a.address} (${plural(a.events, 'event')}${ownText(a)})`).join('; ') : 'none'}`);
  const recordText = report.records == null ? 'not available' : report.source === 'live' ? `${fmtN(report.records)} transactions heard in the ledgers used` : report.source === 'account_tx' ? `${fmtN(report.records)} transactions of the named accounts in the ledgers used` : `${fmtN(report.records)} transactions of the window’s ledgers (failed included)`;
  const pct = Math.round(o.significance * 100);
  const ab = report.above ?? { raw: 0, white: 0, expected: 0, resolved: report.tested ?? 0, unresolved: 0, minShuffles: 20 };
  const unresolved = ab.unresolved ? ` · ${plural(ab.unresolved, 'pair')} with fewer than ${ab.minShuffles} shifts, where the ${pct}th cannot be resolved` : '';
  lines.push(`record: ${recordText} · pairs tested: ${report.tested ?? 0} · above the ${pct}th of their shuffles: raw ${ab.raw}, prewhitened ${ab.white} · chance alone gives about ${ab.expected.toFixed(1)} of ${ab.resolved}${unresolved}`);
  lines.push(`tier ${report.tier}: a correlation at a lag is what these series show; coordination or common ownership would be a hypothesis and is not stated here.`);
  if (!report.pairs.length) lines.push(report.accounts.length < 2 ? 'no pair: fewer than two accounts to compare' : 'no pair');
  for (const p of report.pairs) {
    lines.push(describePair(p, { significance: o.significance }));
    lines.push(...pairDetailLines(p, { maxHashes: o.maxHashes }));
  }
  return lines.join('\n');
}

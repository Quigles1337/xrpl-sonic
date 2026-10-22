// xrpl-sonic — coherence, phase 1: the statistic and its readout.
//
// Relations between accounts, read from when they act. Each account gets a
// series over the window: per ledger, the transactions it submitted (the
// primary measure; `volume` is the alternative, the sum of log10(1 + XRP) of
// the XRP-denominated amounts). Each series is normalised as the deviation
// from the account's own baseline over the window (a z-score over the
// ledgers used), so a constant always-on account comes out flat and can show
// no coherence. Between two normalised series the cross-correlation at each
// lag in [−L, L] is the normalised sum of products over the ledgers that
// overlap at that lag; the lag with the largest |r| is the peak, and a
// positive lag means the second account follows the first. Lags are counted
// in ledgers on the ledger-index axis, so a missing ledger, or one the live
// stream did not fully receive, is simply absent: it pairs with nothing,
// contributes nothing, and is never read as zero.
//
// Behind a guard (a minimum of ledgers used and of events per account) the
// pairs are ranked by |r|. Beside r stands a null: the largest |r| over
// circular shifts of the second series, a fixed count of shifts in a seeded
// order, excluding shifts within L of zero (those reproduce the real
// alignment at another lag), reported as the share of shifts the observed
// |r| exceeds. Sub-windows give the peak lag over consecutive thirds of the
// window, so a cadence mismatch (two periods, drifting phase) shows as a
// drifting lag rather than hiding inside one small r.
//
// Everything reported is tier `observation` (docs/facts.md): a correlation
// at a lag is what the series show; coordination or common ownership would
// be a hypothesis, and the readout says so. See docs/coherence.md.
//
// Pure: no DOM, no network, no audio, no canvas.

import { shortAddress } from './mapping.js';

export const COHERENCE_VERSION = 1;
export const MEASURES = Object.freeze(['count', 'volume']);
export const TIER = 'observation';

/**
 * Defaults. maxLag 8: a 50-ledger case keeps at least 42 overlapping pairs at
 * the furthest lag and a 12-ledger moment still has 4. minLedgers 12 and
 * minEvents 10: see docs/coherence.md, "Defaults", for the measurements they
 * rest on. shuffles 200 is a ceiling; a 50-ledger window has 33 admissible
 * shifts and uses them all, so the percentile's resolution is stated beside it.
 */
export const DEFAULTS = Object.freeze({ measure: 'count', maxLag: 8, minLedgers: 12, minEvents: 10, topK: 5, shuffles: 200, seed: 1337, subWindows: 3, minSubOverlap: 6 });
export const LIMITS = Object.freeze({ maxLag: [1, 25], minLedgers: [2, 50], minEvents: [1, 100000], topK: [2, 12], shuffles: [0, 5000], subWindows: [2, 6] });

/** Why a ledger is not used: it is absent, not zero. */
export const EXCLUSIONS = Object.freeze({
  missing: 'not available from the node',
  incomplete: 'not fully received (received < txn_count)',
  unknown: 'transaction count unknown',
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmtLag = (k) => (k > 0 ? `+${k}` : String(k));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function normalizeOptions(input) {
  const o = { ...DEFAULTS };
  if (!input || typeof input !== 'object') return o;
  if (MEASURES.includes(input.measure)) o.measure = input.measure;
  for (const key of ['maxLag', 'minLedgers', 'minEvents', 'topK', 'shuffles', 'subWindows']) {
    const v = Number(input[key]);
    if (Number.isFinite(v)) o[key] = clamp(Math.round(v), LIMITS[key][0], LIMITS[key][1]);
  }
  const seed = Number(input.seed);
  if (Number.isFinite(seed)) o.seed = Math.round(seed) >>> 0;
  const mso = Number(input.minSubOverlap);
  if (Number.isFinite(mso) && mso >= 2) o.minSubOverlap = Math.round(mso);
  return o;
}

/** log10(1 + XRP) of an event's amount; 0 when the amount is not XRP-denominated or absent. */
export function logVolume(event) {
  const v = event?.amount?.isXrp ? Number(event.amount.value) : 0;
  return v > 0 ? Math.log10(1 + v) : 0;
}

// ---------------------------------------------------------------------------
// Frames: the ledgers of a window and one series per account
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
  return { source, measure: DEFAULTS.measure, ledgers: [], accounts: [], series: new Map(), totals: new Map(), chosen: 'none' };
}

/**
 * The frame of a score: one row per ledger of the score in play order (a
 * missing ledger is a row that is not used), the submitters' totals over the
 * ledgers used, the accounts chosen, and per account a series aligned to the
 * rows. Events are the score's: what the listening settings selected.
 * @param {object} score  from buildScore()
 * @param {{ cast?: object[], topK?: number, measure?: 'count'|'volume' }} [options]
 */
export function frameFromScore(score, { cast = [], topK = DEFAULTS.topK, measure = DEFAULTS.measure } = {}) {
  const frame = emptyFrame('score');
  frame.measure = MEASURES.includes(measure) ? measure : DEFAULTS.measure;
  if (!score || !Array.isArray(score.ledgers)) return frame;
  frame.ledgers = score.ledgers.map((l) => ({ index: Number(l.ledgerIndex), included: !l.missing, reason: l.missing ? 'missing' : null, hash: l.hash ?? null }));
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
  return frame;
}

/**
 * The frame of the live window: the closed ledgers heard, used only when
 * the ledger's transaction count is known and every transaction was
 * received; the submitters counted by the window as transactions arrived.
 * @param {{ ledgers: { index, hash, txnCount, received, accounts }[] }} window  a LiveWindow (src/moment.js) or its `ledgers`
 */
export function frameFromLive(window, { cast = [], topK = DEFAULTS.topK, measure = DEFAULTS.measure } = {}) {
  const frame = emptyFrame('live');
  frame.measure = MEASURES.includes(measure) ? measure : DEFAULTS.measure;
  const heard = Array.isArray(window) ? window : Array.isArray(window?.ledgers) ? window.ledgers : [];
  if (!heard.length) return frame;
  frame.ledgers = heard.map((l) => {
    const expected = l.txnCount == null ? null : Number(l.txnCount);
    const received = Number(l.received) || 0;
    const reason = expected == null ? 'unknown' : received < expected ? 'incomplete' : null;
    return { index: Number(l.index), included: !reason, reason, hash: l.hash ?? null, received, expected };
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
  return frame;
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

/** The pair's record: the guard, the normalisation, the peak, the null and the sub-windows. */
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
  const pair = { a: { ...first, events: eventsA }, b: { ...second, events: eventsB }, n: used, measure: frame.measure ?? o.measure, maxLag: L, judged: false, reason: null, flat: null, r: null, lag: null, overlap: null, shuffle: null, subWindows: [], drift: null, cadence: null, beat: null, byLag: null };
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

/**
 * The report for a frame: every pair of its accounts, judged pairs first by
 * |r| (then by the shuffle percentile), the rest after, with the window and
 * the options stated so the readout can be checked.
 */
export function coherence(frame, options = DEFAULTS) {
  const o = normalizeOptions(options);
  const ledgers = frame?.ledgers ?? [];
  const accounts = frame?.accounts ?? [];
  const pairs = [];
  for (let i = 0; i < accounts.length; i++) for (let j = i + 1; j < accounts.length; j++) pairs.push(pairCoherence(frame, accounts[i], accounts[j], o));
  const rank = (p) => (p.judged && !p.flat?.a && !p.flat?.b ? 2 : p.judged ? 1 : 0);
  pairs.sort((x, y) => rank(y) - rank(x) || Math.abs(y.r ?? 0) - Math.abs(x.r ?? 0) || (y.shuffle?.percentile ?? 0) - (x.shuffle?.percentile ?? 0) || x.a.label.localeCompare(y.a.label));
  const excluded = {};
  for (const l of ledgers) if (!l.included) excluded[l.reason ?? 'missing'] = (excluded[l.reason ?? 'missing'] ?? 0) + 1;
  const included = ledgers.map((l) => l.included);
  const positions = ledgers.map((l) => l.index);
  const used = included.filter(Boolean).length;
  const L = effectiveLag(o.maxLag, used);
  // each account's own cadence, from its autocorrelation, when the window can bear it
  const cadence = (address) => {
    if (used < o.minLedgers) return null;
    const z = normalise(frame.series.get(address) ?? [], included);
    return z.flat ? null : cadenceOf(z.z, L, { positions, included });
  };
  return {
    version: COHERENCE_VERSION,
    tier: TIER,
    source: frame?.source ?? 'none',
    measure: frame?.measure ?? o.measure,
    chosen: frame?.chosen ?? 'none',
    options: o,
    maxLag: L,
    window: { from: ledgers[0]?.index ?? null, to: ledgers.at(-1)?.index ?? null, ledgers: ledgers.length, used, excluded },
    accounts: accounts.map((a) => ({ ...a, events: frame.totals.get(a.address) ?? 0, cadence: cadence(a.address) })),
    pairs,
  };
}

// ---------------------------------------------------------------------------
// The readout
// ---------------------------------------------------------------------------

/** "B follows A by 2 ledgers", "A follows B by 1 ledger", "in step". */
export function followText(pair) {
  if (pair.lag > 0) return `${pair.b.label} follows ${pair.a.label} by ${plural(pair.lag, 'ledger')}`;
  if (pair.lag < 0) return `${pair.a.label} follows ${pair.b.label} by ${plural(-pair.lag, 'ledger')}`;
  return 'in step';
}

/** One line per pair, in the project's voice; every number in it is one the statistic produced. */
export function describePair(pair) {
  const head = `${pair.a.label} ↔ ${pair.b.label}`;
  if (!pair.judged) return `${head}: not judged: ${pair.reason}`;
  if (pair.flat?.a || pair.flat?.b) {
    const why = pair.measure === 'volume' ? 'the same XRP volume in every ledger used, which for an account that moves no XRP is none' : 'the same count in every ledger used';
    return `${head}: no coherence: ${pair.reason} (${why}) · ${plural(pair.n, 'ledger')} · events ${pair.a.events}/${pair.b.events}`;
  }
  const s = pair.shuffle;
  const nullText = s && s.count ? `above ${Math.round(s.percentile * 100)}% of shuffles (${s.above} of ${s.count})` : 'no shuffle test (too few ledgers for a shift beyond the lags)';
  const subs = pair.subWindows.filter((w) => w.lag != null);
  const subText = subs.length >= 2 ? ` · ${subs.length} parts of ${subs[0].ledgers}: lag ${subs.map((w) => `${fmtLag(w.lag)} (r ${w.r.toFixed(2)})`).join(', ')}` : '';
  const beat = pair.beat;
  const beatText = !beat ? '' : beat.shared != null ? ` · shared cadence of ${plural(beat.shared, 'ledger')}` : ` · cadences of ${beat.periods[0]} and ${beat.periods[1]} ledgers: a mismatch, the alignment recurs every ${plural(beat.every, 'ledger')}`;
  return `${head}: r ${pair.r.toFixed(2)} at lag ${fmtLag(pair.lag)} (${followText(pair)}) · ${plural(pair.n, 'ledger')} (overlap ${pair.overlap}) · events ${pair.a.events}/${pair.b.events} · ${nullText}${subText}${beatText}`;
}

/** The whole report as text: what was measured, over what, under which settings, then one line per pair. */
export function readout(report) {
  if (!report) return '';
  const w = report.window;
  const lines = [];
  const excluded = Object.entries(w.excluded ?? {}).map(([k, n]) => `${n} ${EXCLUSIONS[k] ?? k}`);
  const span = w.from != null ? `#${w.from}–#${w.to}` : 'empty';
  lines.push(`coherence v${report.version} · ${report.source === 'live' ? 'live window' : 'case'} ${span} · ${w.used} of ${plural(w.ledgers, 'ledger')} used${excluded.length ? ` (excluded: ${excluded.join(', ')})` : ''}`);
  const measure = report.measure === 'volume' ? 'log volume per ledger (sum of log10(1 + XRP) of the XRP-denominated amounts submitted)' : 'transactions submitted per ledger';
  const L = report.maxLag ?? report.options.maxLag;
  const lagText = L < report.options.maxLag ? `lags ±${L} ledgers (a quarter of the ${w.used} used; the option is ±${report.options.maxLag})` : `lags ±${L} ledgers`;
  lines.push(`series: ${measure}, ${report.source === 'live' ? 'counted as the stream delivered them' : 'from the score (events selected by the listening settings)'} · accounts: ${report.chosen} · ${lagText} · guard ≥${report.options.minLedgers} ledgers, ≥${report.options.minEvents} events each · null: up to ${report.options.shuffles} circular shifts beyond ±${L}, seed ${report.options.seed} · parts of ≥${3 * L} ledgers for the drift check`);
  const cadenceText = (a) => (a.cadence ? `, cadence ${plural(a.cadence.period, 'ledger')} (self-correlation ${a.cadence.r.toFixed(2)})` : '');
  lines.push(`accounts: ${report.accounts.length ? report.accounts.map((a) => `${a.label} = ${a.address} (${plural(a.events, 'event')}${cadenceText(a)})`).join('; ') : 'none'}`);
  lines.push(`tier ${report.tier}: a correlation at a lag is what these series show; coordination or common ownership would be a hypothesis and is not stated here.`);
  if (!report.pairs.length) lines.push(report.accounts.length < 2 ? 'no pair: fewer than two accounts to compare' : 'no pair');
  for (const p of report.pairs) lines.push(describePair(p));
  return lines.join('\n');
}

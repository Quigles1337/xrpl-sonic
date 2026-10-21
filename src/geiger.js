// xrpl-sonic — Geiger mode: a detector that counts, and says what it counted.
//
// Per validated ledger it measures a few plain things — transactions in all,
// per category, and for each cast member the transactions it submitted, the
// transactions it was involved in, and its share of the ledger's OfferCreate
// submissions — then compares each against a baseline formed from the
// previous ledgers. A crossing is reported with the numbers that produced
// it. The measurements are taken before the synthesiser's rate limiting and
// before any filter, so dropped notes never shrink a count.
//
// States are explicit: 'forming' while the baseline fills, 'nominal' when
// the last ledger was within it, 'crossing' when a threshold was crossed,
// 'stale' when no ledger has arrived for a while. Silence therefore means
// "no configured deviation was reported while the feed and the detector were
// running", not "nothing happened".
//
// Pure: no DOM, no audio.

import { categorize, unwrapTransactionMessage, involvesAccount, CATEGORY_NAMES } from './mapping.js';

export const GEIGER_DEFAULTS = Object.freeze({ window: 30, threshold: 3, minCount: 10, adapt: true });
export const GEIGER_LIMITS = Object.freeze({ window: [5, 200], threshold: [1.5, 10], minCount: [1, 1000] });
export const STALE_AFTER_MS = 20000;
export const HISTORY_LENGTH = 60;
export const MAX_CROSSINGS_KEPT = 8;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Validate detector settings onto the defaults. */
export function normalizeGeigerConfig(input) {
  const c = { ...GEIGER_DEFAULTS };
  if (!input || typeof input !== 'object') return c;
  for (const key of ['window', 'threshold', 'minCount']) {
    const v = Number(input[key]);
    if (Number.isFinite(v)) c[key] = clamp(key === 'threshold' ? v : Math.round(v), GEIGER_LIMITS[key][0], GEIGER_LIMITS[key][1]);
  }
  if (typeof input.adapt === 'boolean') c.adapt = input.adapt;
  return c;
}

/** Transactions of one ledger as plain counts. Accepts stream messages or `ledger` command entries. */
export function featuresOf(transactions, cast = []) {
  const byCategory = Object.fromEntries(CATEGORY_NAMES.map((c) => [c, 0]));
  const members = Object.fromEntries((cast ?? []).map((m) => [m.id, { submitted: 0, involved: 0, offerCreate: 0 }]));
  let total = 0;
  let offerCreateTotal = 0;
  const seen = new Set(); // a reconnect can replay a ledger's stream; the same hash counts once
  for (const raw of Array.isArray(transactions) ? transactions : []) {
    const u = unwrapTransactionMessage(raw);
    if (!u) continue;
    if (u.hash) {
      if (seen.has(u.hash)) continue;
      seen.add(u.hash);
    }
    total += 1;
    byCategory[categorize(u.tx.TransactionType)] += 1;
    const isOfferCreate = u.tx.TransactionType === 'OfferCreate';
    if (isOfferCreate) offerCreateTotal += 1;
    for (const m of cast ?? []) {
      const rec = members[m.id];
      if (u.tx.Account === m.address) {
        rec.submitted += 1;
        if (isOfferCreate) rec.offerCreate += 1;
        rec.involved += 1;
      } else if (involvesAccount(raw, m.address)) {
        rec.involved += 1;
      }
    }
  }
  return { total, byCategory, members, offerCreateTotal };
}

/** Flatten features into the measured series: id → { value, count, kind }. */
export function seriesOf(features, cast = []) {
  const out = new Map();
  out.set('total', { value: features.total, count: features.total, kind: 'count', label: 'transactions' });
  for (const c of CATEGORY_NAMES) out.set(`cat:${c}`, { value: features.byCategory[c], count: features.byCategory[c], kind: 'count', label: `${c} transactions` });
  for (const m of cast ?? []) {
    const rec = features.members[m.id];
    if (!rec) continue;
    out.set(`member:${m.id}:submitted`, { value: rec.submitted, count: rec.submitted, kind: 'count', label: `transactions submitted by ${m.label}`, member: m });
    out.set(`member:${m.id}:involved`, { value: rec.involved, count: rec.involved, kind: 'count', label: `transactions involving ${m.label}`, member: m });
    const share = features.offerCreateTotal > 0 ? rec.offerCreate / features.offerCreateTotal : 0;
    out.set(`member:${m.id}:offerShare`, { value: share, count: rec.offerCreate, kind: 'share', label: `share of the ledger's OfferCreate submitted by ${m.label}`, member: m, of: features.offerCreateTotal });
  }
  return out;
}

function stats(values) {
  const n = values.length;
  if (!n) return { mean: 0, sd: 0, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
  return { mean, sd: Math.sqrt(variance), n };
}

/** Standard-deviation floor: counts are at least Poisson-noisy; shares have a fixed floor. */
function sdFloor(kind, mean) {
  return kind === 'share' ? 0.05 : Math.max(1, Math.sqrt(Math.max(mean, 1)));
}

const pct = (v) => `${Math.round(v * 100)}%`;
const fmtN = (n) => Number(n).toLocaleString('en-US');

/** The sentence a crossing is reported with. Everything in it is a number the detector measured. */
export function explain(crossing) {
  const { ledgerIndex, series, value, count, mean, sd, z, threshold, windowSize, of } = crossing;
  const where = `ledger #${fmtN(ledgerIndex)}`;
  if (series.kind === 'share') {
    return `${series.member.label} submitted ${fmtN(count)} of the ${fmtN(of)} OfferCreate transactions in ${where} (${pct(value)}). Over the previous ${windowSize} ledgers its share averaged ${pct(mean)} ± ${pct(sd)}, so this is ${z.toFixed(1)}σ above the baseline (threshold ${threshold}σ).`;
  }
  return `${where} carried ${fmtN(value)} ${series.label}; the previous ${windowSize} ledgers averaged ${mean.toFixed(1)} ± ${sd.toFixed(1)}, so this is ${z.toFixed(1)}σ above the baseline (threshold ${threshold}σ).`;
}

export class Geiger {
  /**
   * @param {object} [opts]
   * @param {number} [opts.window]     ledgers in the baseline
   * @param {number} [opts.threshold]  z-score that counts as a crossing
   * @param {number} [opts.minCount]   smallest count that can cross (a 1-of-1 share is not a flood)
   * @param {boolean} [opts.adapt]     keep updating the baseline (false = frozen once formed, or pinned)
   * @param {object[]} [opts.cast]     cast members to measure
   * @param {object} [opts.baseline]   a pinned baseline from snapshot()
   */
  constructor({ window: windowSize, threshold, minCount, adapt, cast = [], baseline = null } = {}) {
    this.config = normalizeGeigerConfig({ window: windowSize, threshold, minCount, adapt });
    this.cast = cast;
    this.values = new Map(); // series id → recent values (up to window)
    this.pinned = null; // series id → { mean, sd, n }
    this.seen = 0;
    this.lastLedger = null;
    this.lastAt = null;
    this.history = []; // { ledgerIndex, total, crossing } for the sparkline
    this.crossings = []; // most recent first
    this.last = null; // last observation
    if (baseline) this.pin(baseline);
  }

  setCast(cast) {
    this.cast = cast ?? [];
  }

  get formed() {
    return Boolean(this.pinned) || this.seen >= this.config.window;
  }

  /** Freeze the baseline (from a snapshot, or from what has been seen so far). */
  pin(snapshot = null) {
    const source = snapshot?.series ?? null;
    const pinned = new Map();
    if (source && typeof source === 'object') {
      for (const [id, s] of Object.entries(source)) {
        if (Number.isFinite(Number(s?.mean)) && Number.isFinite(Number(s?.sd))) pinned.set(id, { mean: Number(s.mean), sd: Number(s.sd), n: Number(s.n) || 0 });
      }
    } else {
      for (const [id, vals] of this.values) pinned.set(id, stats(vals));
    }
    this.pinned = pinned;
    if (snapshot?.window) this.config.window = normalizeGeigerConfig({ window: snapshot.window }).window;
    return this.snapshot();
  }

  unpin() {
    this.pinned = null;
  }

  /** The current baseline as plain data, for a case file. */
  snapshot() {
    const series = {};
    const source = this.pinned ?? new Map([...this.values].map(([id, vals]) => [id, stats(vals)]));
    for (const [id, s] of source) series[id] = { mean: Number(s.mean.toFixed(4)), sd: Number(s.sd.toFixed(4)), n: s.n };
    return { window: this.config.window, pinnedAt: this.lastLedger, series };
  }

  baselineFor(id) {
    if (this.pinned) return this.pinned.get(id) ?? null;
    const vals = this.values.get(id);
    return vals && vals.length >= this.config.window ? stats(vals) : null;
  }

  /**
   * Observe one validated ledger's transactions.
   * @returns {{ ledgerIndex, features, state, crossings }}
   */
  observeLedger({ ledgerIndex, transactions, nowMs = Date.now() }) {
    const features = featuresOf(transactions, this.cast);
    const series = seriesOf(features, this.cast);
    const judged = this.formed; // was there a baseline to judge this ledger against?
    const crossings = [];
    const windowSize = this.config.window;
    for (const [id, s] of series) {
      const base = this.baselineFor(id);
      if (base && s.count >= this.config.minCount) {
        const sd = Math.max(base.sd, sdFloor(s.kind, base.mean));
        const z = (s.value - base.mean) / sd;
        if (z >= this.config.threshold) {
          const crossing = { ledgerIndex, id, series: s, value: s.value, count: s.count, of: s.of ?? null, mean: base.mean, sd, z, threshold: this.config.threshold, windowSize };
          crossing.explanation = explain(crossing);
          crossings.push(crossing);
        }
      }
    }
    crossings.sort((a, b) => b.z - a.z);
    // Update the rolling baseline after judging the ledger, unless frozen or pinned.
    if (!this.pinned && (this.config.adapt || this.seen < windowSize)) {
      for (const [id, s] of series) {
        const vals = this.values.get(id) ?? [];
        vals.push(s.value);
        while (vals.length > windowSize) vals.shift();
        this.values.set(id, vals);
      }
    }
    this.seen += 1;
    this.lastLedger = ledgerIndex;
    this.lastAt = nowMs;
    this.history.push({ ledgerIndex, total: features.total, crossing: crossings.length > 0 });
    while (this.history.length > HISTORY_LENGTH) this.history.shift();
    if (crossings.length) {
      this.crossings.unshift(...crossings.slice(0, 3));
      this.crossings.length = Math.min(this.crossings.length, MAX_CROSSINGS_KEPT);
    }
    const state = crossings.length ? 'crossing' : judged ? 'nominal' : 'forming';
    this.last = { ledgerIndex, features, state, crossings, zMax: crossings[0]?.z ?? 0 };
    return this.last;
  }

  /** The status to show, given the current time (for staleness). */
  status(nowMs = Date.now()) {
    const stale = this.lastAt != null && nowMs - this.lastAt > STALE_AFTER_MS;
    const formed = this.formed;
    let state;
    let text;
    if (stale) {
      state = 'stale';
      text = `Stale: no ledger for ${Math.round((nowMs - this.lastAt) / 1000)} s. Nothing is being judged.`;
    } else if (this.lastAt == null) {
      state = 'forming';
      text = 'Waiting for the first ledger.';
    } else if (!formed) {
      state = 'forming';
      text = `Baseline forming: ${this.seen} of ${this.config.window} ledgers.`;
    } else if (this.last?.state === 'crossing') {
      state = 'crossing';
      text = this.last.crossings[0].explanation;
    } else {
      state = 'nominal';
      text = `Nominal: ledger #${fmtN(this.lastLedger)} within the ${this.pinned ? 'pinned' : this.config.adapt ? 'rolling' : 'frozen'} baseline (${this.config.window} ledgers, ${this.config.threshold}σ, counts ≥ ${this.config.minCount}).`;
    }
    return { state, text, seen: this.seen, window: this.config.window, pinned: Boolean(this.pinned), lastLedger: this.lastLedger, crossings: this.crossings, history: this.history };
  }
}

/** Baseline band for the sparkline: mean ± 2 sd of the total series, or null while forming. */
export function totalBand(geiger) {
  const base = geiger.baselineFor('total');
  if (!base) return null;
  const sd = Math.max(base.sd, sdFloor('count', base.mean));
  return { mean: base.mean, low: Math.max(0, base.mean - 2 * sd), high: base.mean + 2 * sd };
}

// UNIVERSE phase 3B — the score, always visible: skill against each baseline (1 − MAE/MAE_baseline over the ledgers
// both forecast), interval coverage for counts (the share of outcomes inside the 80% interval), the Brier score for
// binaries; per ledger, so any portion can be read: the tuning portion (where a model is chosen) and the held-out
// portion (where it is reported). The error is the point forecast's: each model's median (the point the absolute
// error is consistent for: Gneiting, "Making and evaluating point forecasts", JASA 106, 2011), its mean where its law
// is symmetric. Pure.

/** One model's resolved forecasts, kept per ledger. */
export class Record {
  constructor(name, { keep = 8192 } = {}) {
    this.name = name;
    this.keep = keep;
    this.entries = new Map(); // ledger index → { err, inside }
    this.binary = new Map(); // ledger index → { sq, k }
  }

  /** Resolve a count forecast { point?, mean, interval } against the outcome at ledger `index`: the error is the point's (the median), or the mean's when no point is given. */
  resolveCount(forecast, outcome, index) {
    const point = Number.isFinite(forecast?.point) ? forecast.point : forecast?.mean;
    if (!forecast || !Number.isFinite(point) || !Number.isFinite(outcome)) return;
    const inside = Boolean(forecast.interval && outcome >= forecast.interval[0] && outcome <= forecast.interval[1]);
    this.entries.set(index, { err: Math.abs(point - outcome), inside });
    if (this.entries.size > this.keep) this.entries.delete(this.entries.keys().next().value);
  }

  /** Resolve a probability against a yes/no outcome at ledger `index` (several per ledger are summed). */
  resolveBinary(probability, happened, index) {
    if (!Number.isFinite(probability)) return;
    const e = this.binary.get(index) ?? { sq: 0, k: 0 };
    const d = probability - (happened ? 1 : 0);
    e.sq += d * d;
    e.k += 1;
    this.binary.set(index, e);
    if (this.binary.size > this.keep) this.binary.delete(this.binary.keys().next().value);
  }

  /** Count forecasts over [from, to): { n, mae, coverage, from, to } with the first and last ledger covered. */
  over(from = -Infinity, to = Infinity) {
    let n = 0;
    let sum = 0;
    let inside = 0;
    let lo = null;
    let hi = null;
    for (const [i, e] of this.entries) {
      if (i < from || i >= to) continue;
      n += 1;
      sum += e.err;
      if (e.inside) inside += 1;
      lo = lo == null ? i : Math.min(lo, i);
      hi = hi == null ? i : Math.max(hi, i);
    }
    return { n, mae: n ? sum / n : null, coverage: n ? inside / n : null, from: lo, to: hi };
  }

  /** Binary forecasts over [from, to): { ledgers, k, brier, from, to }. */
  brierOver(from = -Infinity, to = Infinity) {
    let ledgers = 0;
    let k = 0;
    let sq = 0;
    let lo = null;
    let hi = null;
    for (const [i, e] of this.binary) {
      if (i < from || i >= to) continue;
      ledgers += 1;
      k += e.k;
      sq += e.sq;
      lo = lo == null ? i : Math.min(lo, i);
      hi = hi == null ? i : Math.max(hi, i);
    }
    return { ledgers, k, brier: k ? sq / k : null, from: lo, to: hi };
  }

  /** Skill against another record over the ledgers both resolved in [from, to): { skill: 1 − Σerr/Σerr_other, n }, or null. */
  skillAgainst(other, from = -Infinity, to = Infinity) {
    if (!other) return null;
    let a = 0;
    let b = 0;
    let n = 0;
    for (const [i, e] of this.entries) {
      if (i < from || i >= to) continue;
      const o = other.entries.get(i);
      if (!o) continue;
      a += e.err;
      b += o.err;
      n += 1;
    }
    if (!n || b === 0) return null;
    return { skill: 1 - a / b, n };
  }

  get n() {
    return this.entries.size;
  }

  indices() {
    return [...this.entries.keys()].sort((x, y) => x - y);
  }

  snapshot(from = -Infinity, to = Infinity) {
    const o = this.over(from, to);
    const b = this.brierOver(from, to);
    return { name: this.name, n: o.n, mae: o.mae, coverage: o.coverage, from: o.from, to: o.to, binaries: b.k, brier: b.brier };
  }
}

/**
 * The split of the resolved ledgers: the first share is the tuning portion
 * (a model is chosen there), the rest the held-out portion (it is reported
 * there). Null until both portions hold at least `min` ledgers.
 */
export function heldOutCut(indices, { share = 0.6, min = 20 } = {}) {
  const n = indices.length;
  const cut = Math.floor(n * share);
  if (cut < min || n - cut < min) return { cut: null, statement: `the held-out portion is forming (${n} resolved; the split needs ${Math.ceil(min / Math.min(share, 1 - share))})` };
  return { cut: indices[cut], tuning: [indices[0], indices[cut - 1]], heldOut: [indices[cut], indices[n - 1]], statement: `models chosen on the first ${Math.round(100 * share)}% of resolved ledgers (#${indices[0]}–#${indices[cut - 1]}, ${cut}), reported on the last ${Math.round(100 * (1 - share))}% (#${indices[cut]}–#${indices[n - 1]}, ${n - cut})` };
}

const pct = (x) => `${Math.round(100 * x)}%`;
const fmt = (x) => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1));
const sign = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;

/**
 * "count 112–148 (80%, mean 130) · held-out coverage 81% over 240 ledgers (#a–#b) · persistence skill +0.07": the
 * forecast, its interval and its record over the range given, never "will".
 */
export function describeCountForecast(name, forecast, record, baselines = {}, range = [-Infinity, Infinity], label = 'held-out') {
  if (!forecast) return `${name}: no forecast yet`;
  const centre = Number.isFinite(forecast.point) && Math.abs(forecast.point - forecast.mean) > 1e-9 ? `median ${fmt(forecast.point)}, mean ${fmt(forecast.mean)}` : `mean ${fmt(forecast.mean)}`;
  const parts = [`${name} ${fmt(forecast.interval[0])}–${fmt(forecast.interval[1])} (80%, ${centre})`];
  const o = record ? record.over(range[0], range[1]) : { n: 0 };
  if (o.n) {
    parts.push(`${label} coverage ${pct(o.coverage)} over ${o.n} ledger${o.n === 1 ? '' : 's'} (#${o.from}–#${o.to})`);
    for (const [bname, brec] of Object.entries(baselines)) {
      if (!brec || brec === record) continue;
      const s = record.skillAgainst(brec, range[0], range[1]);
      if (s) parts.push(`${bname} skill ${sign(s.skill)}`);
    }
  } else parts.push(`no ${label} record yet`);
  return parts.join(' · ');
}

/** "P 0.62 · held-out Brier 0.21 over 80 forecasts in 40 ledgers" for a binary target. */
export function describeBinaryForecast(name, probability, record, range = [-Infinity, Infinity], label = 'held-out') {
  if (!Number.isFinite(probability)) return `${name}: no forecast yet`;
  const b = record ? record.brierOver(range[0], range[1]) : { k: 0 };
  return `${name} P ${probability.toFixed(2)}${b.k ? ` · ${label} Brier ${b.brier.toFixed(3)} over ${b.k} forecast${b.k === 1 ? '' : 's'} in ${b.ledgers} ledger${b.ledgers === 1 ? '' : 's'}` : ` · no ${label} record yet`}`;
}

/** The verdict over a range: which models beat persistence there (at least `min` shared ledgers), or that nothing did. */
export function verdict(records, persistenceRecord, range = [-Infinity, Infinity], { min = 20, label = 'held-out' } = {}) {
  const o = persistenceRecord ? persistenceRecord.over(range[0], range[1]) : { n: 0 };
  if (!o.n) return `no ${label} outcomes scored yet`;
  const beats = [];
  for (const r of records) {
    if (!r || r === persistenceRecord) continue;
    const s = r.skillAgainst(persistenceRecord, range[0], range[1]);
    if (s && s.n >= min && s.skill > 0) beats.push(`${r.name} (${Math.round(100 * s.skill)}% less error over ${s.n})`);
  }
  const where = `on the ${label} ledgers (#${o.from}–#${o.to})`;
  return beats.length ? `${where}, beats persistence: ${beats.join(', ')}` : `${where}, nothing beats persistence`;
}

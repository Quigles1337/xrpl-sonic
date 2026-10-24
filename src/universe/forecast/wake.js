// UNIVERSE phase 3B — the wake: per metric, the standardized gap between a short and a long rope, a CUSUM on the
// residuals against the long rope with its threshold set for a stated in-control average run length by simulation,
// and Bayesian online change-point detection (Adams & MacKay, arXiv:0710.3742, 2007; Poisson–Gamma for counts,
// Normal with known variance for shares; a constant hazard) reporting the run length and the probability of a change
// at this ledger. Pure.
//
// Counts are bursty: on the recordings a tenth of the ledgers hold 300 to 1,000 transactions against a median of
// about 74, in runs (lag-1 autocorrelation about 0.5). So for a count the gap and the CUSUM read log(1 + count), the
// CUSUM's threshold is set for the stated run length on residuals with the lag-1 autocorrelation measured on the
// residuals themselves (an AR(1) normal law in the simulation; read as independent, the stated run length would be
// false), and the change-point posterior weighs each ledger's evidence by one over the count's dispersion (variance
// over mean of the reference rope): a power likelihood, the quasi-likelihood of an overdispersed Poisson count
// (Wedderburn 1974), so one burst is not read as a new run.

import { seededRandom } from '../../coherence.js';
import { Rope, RopeBank } from './ropes.js';
import { exp as dexp, log as dlog, log1p as dlog1p, logGamma, normalSampler } from './dmath.js';

/**
 * A change within the last few ledgers: the posterior mass on runs of at most this many, two of the short rope's
 * half-lives. The mass within 5 ledgers missed 6 of 40 planted +3 sd shifts on synthetic Poisson streams (the
 * posterior found the new run, but its mass passed one half only after the run was longer than 5); within 8 it found
 * all 40 (delay 3 at the median, 6 at most) with 2 false flags in 15,640 steady ledgers; within 16 it raised 9.
 */
export const RECENT = 8;

// --- the standardized gap ------------------------------------------------------------------------

/** The gap between the short rope's mean and the long rope's, in the long rope's standard deviations (0 when the long rope has none). */
export function standardizedGap(shortRope, longRope) {
  if (shortRope?.mean == null || longRope?.mean == null) return null;
  const sd = longRope.sd;
  if (!(sd > 0)) return 0;
  return (shortRope.mean - longRope.mean) / sd;
}

// --- CUSUM ----------------------------------------------------------------------------------------

/**
 * A two-sided CUSUM on standardized residuals (Page 1954): S⁺ = max(0, S⁺ + z − k), S⁻ = max(0, S⁻ − z − k); an alarm
 * when either passes h, after which the sum restarts. k and h are in units of the residual's standard deviation.
 */
export class Cusum {
  constructor({ k = 0.5, h = 4 } = {}) {
    this.k = k;
    this.h = h;
    this.up = 0;
    this.down = 0;
    this.alarms = 0;
    this.lastAlarmAt = null;
    this.t = 0;
  }

  /** Feed a standardized residual; returns the alarm side ('up' | 'down' | null) at this step. */
  update(z) {
    this.t += 1;
    if (!Number.isFinite(z)) return null;
    this.up = Math.max(0, this.up + z - this.k);
    this.down = Math.max(0, this.down - z - this.k);
    let alarm = null;
    if (this.up > this.h) alarm = 'up';
    else if (this.down > this.h) alarm = 'down';
    if (alarm) {
      this.alarms += 1;
      this.lastAlarmAt = this.t;
      this.up = 0;
      this.down = 0;
    }
    return alarm;
  }

  snapshot() {
    return { k: this.k, h: this.h, up: this.up, down: this.down, alarms: this.alarms, lastAlarmAt: this.lastAlarmAt, t: this.t };
  }
}

/**
 * The mean run length to a false alarm of a two-sided CUSUM (k, h) on
 * standard normal residuals with lag-1 autocorrelation rho (an AR(1) law
 * with unit variance; rho 0 is independence), by simulation (seeded; the
 * normal draws by dmath.js's polar method, so the run lengths are the same
 * in every engine).
 */
export function simulatedArl(k, h, { runs = 200, maxLen = 20000, seed = 7, rho = 0 } = {}) {
  const normal = normalSampler(seededRandom(seed));
  const innovation = Math.sqrt(1 - rho * rho);
  let total = 0;
  for (let r = 0; r < runs; r++) {
    const c = new Cusum({ k, h });
    let len = 0;
    let z = normal();
    while (len < maxLen) {
      len += 1;
      if (c.update(z)) break;
      z = rho * z + innovation * normal();
    }
    total += len;
  }
  return total / runs;
}

/**
 * The thresholds for the default run length (ARL 500, k 0.5, 2,000 runs, seed
 * 7) at lag-1 autocorrelations 0, 0.1, …, 0.9, computed once by thresholdFor's
 * own bisection (src/universe/bench/cusum-thresholds.mjs prints them; a test
 * recomputes two) so the worker never stalls on a simulation: [h, measured
 * ARL on 4,000 runs]. 2,000 runs a step of the search hold its sampling
 * error near 2% of the stated run length (400 left it near 5%).
 */
/** The runs a step of the search behind the shipped table. */
export const TABLE_RUNS = 2000;

export const ARL500_THRESHOLDS = Object.freeze([
  [5.0717, 494.2], // rho 0.0
  [5.8471, 499.8], // rho 0.1
  [6.7663, 503.7], // rho 0.2
  [7.8891, 505], // rho 0.3
  [9.3153, 512.1], // rho 0.4
  [11.1748, 515.1], // rho 0.5
  [13.768, 521.2], // rho 0.6
  [17.5327, 516], // rho 0.7
  [23.8399, 510.3], // rho 0.8
  [37.8196, 511.1], // rho 0.9
]);

/**
 * The threshold h for a stated in-control average run length at reference
 * value k, found by bisection on the simulated ARL (monotone in h). The
 * result is cached per (k, arl) so the search runs once.
 */
const thresholdCache = new Map();
export function thresholdFor(arl = 500, { k = 0.5, runs = 200, seed = 7, rho = 0, table = true } = {}) {
  const key = `${k}:${arl}:${runs}:${seed}:${rho}`;
  if (table && thresholdCache.has(key)) return thresholdCache.get(key);
  const step = Math.round(rho * 10);
  if (table && arl === 500 && k === 0.5 && runs === TABLE_RUNS && seed === 7 && Math.abs(rho * 10 - step) < 1e-9 && ARL500_THRESHOLDS[step]) {
    const [h, measuredArl] = ARL500_THRESHOLDS[step];
    const found = { h, k, arl, measuredArl, runs, seed, rho };
    thresholdCache.set(key, found);
    return found;
  }
  let lo = 0.5;
  let hi = rho > 0 ? 12 + 60 * rho : 12;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (simulatedArl(k, mid, { runs, seed, rho }) < arl) lo = mid;
    else hi = mid;
  }
  const h = (lo + hi) / 2;
  const found = { h, k, arl, measuredArl: simulatedArl(k, h, { runs: runs * 2, seed: seed + 1, rho }), runs, seed, rho };
  if (table) thresholdCache.set(key, found);
  return found;
}

// --- Bayesian online change-point detection ----------------------------------------------------------

// the log-gamma is dmath.js's (Lanczos, without the sine reflection)

/**
 * Online change-point detection with a constant hazard (Adams & MacKay
 * 2007, Algorithm 1): a posterior over the run length r_t, grown and
 * changed at every step with the predictive probability of the new
 * observation under each run's sufficient statistics. `family` is
 * 'poisson' (Gamma prior on the rate; the predictive is negative binomial)
 * for counts or 'normal' (a known variance, a Normal prior on the mean) for
 * shares. The posterior is truncated at `maxRun`.
 */
export class ChangePoint {
  constructor({ family = 'poisson', hazard = 1 / 200, maxRun = 1024, prior = {} } = {}) {
    this.family = family;
    this.hazard = hazard;
    this.maxRun = maxRun;
    this.prior = family === 'poisson' ? { a: prior.a ?? 1, b: prior.b ?? 0.01 } : { mu: prior.mu ?? 0, kappa: prior.kappa ?? 0.01, sigma2: prior.sigma2 ?? 1 };
    this.weights = [1]; // P(r_t = r | x_{1:t}) for r = 0..
    this.stats = [this.family === 'poisson' ? { a: this.prior.a, b: this.prior.b } : { mu: this.prior.mu, kappa: this.prior.kappa }];
    this.t = 0;
    this.changeProbability = 0; // P(r_t = 1): this ledger began a new run (P(r_t = 0) is the hazard itself, by construction)
    this.recentChangeProbability = null; // P(r_t ≤ RECENT): a change within the last few ledgers (null for the first RECENT ledgers)
    this.runLength = 0;
    this.changes = [];
  }

  /** A fresh prior for new runs (the long rope's level, with unit weight), so a run that starts is judged against today's level, not the first ledger's. */
  setPrior(prior = {}) {
    if (this.family === 'poisson') {
      if (Number.isFinite(prior.a) && prior.a > 0) this.prior.a = prior.a;
      if (Number.isFinite(prior.b) && prior.b > 0) this.prior.b = prior.b;
    } else {
      if (Number.isFinite(prior.mu)) this.prior.mu = prior.mu;
      if (Number.isFinite(prior.sigma2) && prior.sigma2 > 0) this.prior.sigma2 = prior.sigma2;
    }
  }

  /**
   * The log predictive of x under a run's statistics. Poisson family, with
   * the evidence weighed by w (a power likelihood Poisson(x | λ)^w against
   * the run's Gamma(a, b) law of λ): log Γ(a + w·x) − log Γ(a) + a·log b −
   * (a + w·x)·log(b + w) − w·log Γ(x + 1); at w = 1 the negative binomial
   * NB(x; a, b/(b + 1)). Normal family: a known observation variance and the
   * mean's posterior variance s2/kappa.
   */
  _logPredictive(stat, x, w = 1) {
    if (this.family === 'poisson') {
      const { a, b } = stat;
      const k = Math.max(0, x);
      return logGamma(a + w * k) - logGamma(a) + a * dlog(b) - (a + w * k) * dlog(b + w) - w * logGamma(k + 1);
    }
    const { mu, kappa } = stat;
    const s2 = this.prior.sigma2;
    const v = s2 + s2 / kappa;
    return -((x - mu) * (x - mu)) / (2 * v) - 0.5 * dlog(2 * Math.PI * v);
  }

  _predictive(stat, x, w = 1) {
    return dexp(this._logPredictive(stat, x, w));
  }

  _grown(stat, x, w = 1) {
    if (this.family === 'poisson') return { a: stat.a + w * Math.max(0, x), b: stat.b + w };
    const kappa = stat.kappa + 1;
    return { mu: (stat.mu * stat.kappa + x) / kappa, kappa };
  }

  /**
   * Feed an observation (Poisson family: its evidence weighed by `weight`,
   * one over the dispersion); returns { runLength, changeProbability,
   * recentChangeProbability, changed } for this step. The predictives are
   * taken in log space with the largest subtracted: a burst far from every
   * run cannot underflow them all and empty the posterior.
   */
  update(x, { weight = 1 } = {}) {
    this.t += 1;
    if (!Number.isFinite(x)) return { runLength: this.runLength, changeProbability: this.changeProbability, recentChangeProbability: this.recentChangeProbability, changed: false };
    const H = this.hazard;
    const w = this.family === 'poisson' && weight > 0 ? weight : 1;
    const lp = this.stats.map((s) => this._logPredictive(s, x, w));
    const top = Math.max(...lp);
    const pred = lp.map((v) => dexp(v - top));
    const grow = this.weights.map((w, r) => w * pred[r] * (1 - H));
    const change = this.weights.reduce((sum, w, r) => sum + w * pred[r] * H, 0);
    const next = [change, ...grow];
    const nextStats = [this.family === 'poisson' ? { a: this.prior.a, b: this.prior.b } : { mu: this.prior.mu, kappa: this.prior.kappa }, ...this.stats.map((s) => this._grown(s, x, w))];
    if (next.length > this.maxRun) {
      next.length = this.maxRun;
      nextStats.length = this.maxRun;
    }
    const z = next.reduce((a, b) => a + b, 0) || 1e-300;
    this.weights = next.map((w) => w / z);
    this.stats = nextStats;
    let best = 0;
    for (let r = 1; r < this.weights.length; r++) if (this.weights[r] > this.weights[best]) best = r;
    this.runLength = best;
    this.changeProbability = this.weights[1] ?? 0;
    // within the first RECENT ledgers every run is at most RECENT long, so the mass says nothing yet: null until then
    this.recentChangeProbability = this.t > RECENT ? this.weights.slice(0, RECENT + 1).reduce((a, b) => a + b, 0) : null;
    const changed = this.recentChangeProbability != null && this.recentChangeProbability > 0.5 && (this.changes.length === 0 || this.t - this.changes.at(-1) > RECENT);
    if (changed) this.changes.push(this.t);
    return { runLength: this.runLength, changeProbability: this.changeProbability, recentChangeProbability: this.recentChangeProbability, changed };
  }

  snapshot() {
    return { family: this.family, hazard: this.hazard, t: this.t, runLength: this.runLength, changeProbability: this.changeProbability, recentChangeProbability: this.recentChangeProbability, changes: this.changes.slice(-8) };
  }
}

// --- the wake of one metric --------------------------------------------------------------------------

/**
 * One metric's wake: the rope bank it watches, the gap between its short
 * (h 4) and long (h 64) ropes, the CUSUM on the residual against the
 * longest formed rope, and the change-point posterior. For a count
 * (transform 'log1p', the default for the Poisson family) the gap and the
 * CUSUM read log(1 + x) through the wake's own ropes; the CUSUM's threshold
 * follows the residuals' measured lag-1 autocorrelation (the h 256 ropes of
 * z_t·z_{t−1} and z_t², their ratio rounded to a tenth in [0, 0.9];
 * independence until sixteen products are in); the change-point posterior
 * reads x over its dispersion (variance over mean of the metric's own
 * longest formed rope, at least 1). `update(x)` is called before the
 * caller's bank takes x, so every residual is against the ropes as they
 * stood. `threshold` is the CUSUM's at independence (from thresholdFor).
 */
export class Wake {
  constructor({ name, bank, family = 'poisson', hazard = 1 / 200, threshold, shortH = 4, longH = 64, prior = {}, minVariance = 1e-4, transform = family === 'poisson' ? 'log1p' : null, lagH = 256 }) {
    this.name = name;
    this.bank = bank;
    this.transform = transform;
    this.scaled = transform ? new RopeBank() : bank; // the ropes the gap and the CUSUM read
    this.shortH = shortH;
    this.longH = longH;
    this.threshold = threshold;
    this.current = threshold; // the threshold in force, at the measured autocorrelation
    this.minVariance = minVariance;
    this.cusum = new Cusum({ k: threshold.k, h: threshold.h });
    this.cp = new ChangePoint({ family, hazard, prior });
    this.lag = new Rope(lagH); // z_t · z_{t−1}
    this.square = new Rope(lagH); // z_t²
    this.rho = 0;
    this.prevZ = null;
    this.dispersion = 1;
    this.scaleH = null;
    this.last = null;
  }

  _formed(bank) {
    const ref = bank.longestFormed();
    return ref && !ref.forming && ref.n >= 8 && ref.mean != null && ref.sd > 0 ? ref : null;
  }

  /** The reference rope the residuals are read against: the longest formed (two windows at least, eight observations) on the scale the CUSUM reads, or null. */
  reference() {
    return this._formed(this.scaled);
  }

  /** Feed the metric's value for a ledger, before the bank is updated with it. */
  update(x) {
    if (!Number.isFinite(x)) return this.last;
    const v = this.transform === 'log1p' ? dlog1p(Math.max(0, x)) : x;
    const ref = this.reference();
    const z = ref ? (v - ref.mean) / ref.sd : 0;
    this.scaleH = ref ? ref.halfLife : null;
    // the residuals' lag-1 autocorrelation sets the threshold in force for the stated run length
    if (ref && this.lag.n >= 16 && this.square.mean > 0) {
      const rho = Math.max(0, Math.min(0.9, Math.round((10 * this.lag.mean) / this.square.mean) / 10));
      if (rho !== this.rho) {
        this.rho = rho;
        this.current = thresholdFor(this.threshold.arl, { k: this.threshold.k, runs: this.threshold.runs, seed: this.threshold.seed ?? 7, rho });
        this.cusum.h = this.current.h;
      }
    }
    const alarm = ref ? this.cusum.update(z) : null; // the CUSUM starts once a rope is formed
    if (ref) {
      if (this.prevZ != null) this.lag.update(z * this.prevZ);
      this.square.update(z * z);
      this.prevZ = z;
    }
    // the change-point posterior: a count's evidence weighed by one over its dispersion, new runs judged against the
    // reference level with the weight of one such ledger; a share against its level and variance
    let weight = 1;
    if (this.cp.family === 'poisson') {
      const raw = this._formed(this.bank);
      this.dispersion = raw ? Math.max(1, raw.variance / Math.max(1e-9, raw.mean)) : 1;
      weight = 1 / this.dispersion;
      if (raw) this.cp.setPrior({ a: Math.max(0.05, raw.mean) * weight, b: weight });
    } else if (ref) this.cp.setPrior({ mu: ref.mean, sigma2: Math.max(this.minVariance, ref.variance) });
    const cp = this.cp.update(this.cp.family === 'poisson' ? x : v, { weight }); // counts as counts; a normal family on the scale its CUSUM reads
    if (this.transform) this.scaled.update(v);
    this.last = { x, z, alarm, runLength: cp.runLength, changeProbability: cp.changeProbability, recentChangeProbability: cp.recentChangeProbability, changed: cp.changed, rho: this.rho, h: this.cusum.h, dispersion: this.dispersion };
    return this.last;
  }

  /** The standardized gap between the short rope and the long one (h 64, or the longest formed rope longer than the short one), now, on the scale the CUSUM reads. */
  get gap() {
    const short = this.scaled.rope(this.shortH);
    let long = this.scaled.rope(this.longH);
    if (!long || long.forming) {
      const formed = this.scaled.ropes.filter((r) => r.halfLife > this.shortH && !r.forming);
      long = formed.length ? formed[formed.length - 1] : null;
    }
    return long ? { value: standardizedGap(short, long), longH: long.halfLife } : { value: null, longH: null };
  }

  /**
   * The words: "count: gap +1.80 σ (h 4 against h 64, on log(1 + x)) ·
   * CUSUM 2.10/9.01 (0 alarms, k 0.5, ARL 500 at lag-1 autocorrelation 0.4,
   * residuals of log(1 + x) against the h 256 rope) · run 37 ledgers ·
   * P(a new run began at this ledger) 0.01 · P(change within 5) 0.03
   * (Poisson–Gamma, each ledger's evidence weighed by one over the
   * dispersion 113)".
   */
  describe() {
    const l = this.last;
    if (!l) return `${this.name}: no observation yet`;
    const c = this.cusum;
    const g = this.gap;
    const on = this.transform === 'log1p' ? ', on log(1 + x)' : '';
    const of = this.transform === 'log1p' ? 'of log(1 + x) ' : '';
    const gap = g.value == null ? 'gap — (no formed long rope yet)' : `gap ${g.value >= 0 ? '+' : ''}${g.value.toFixed(2)} σ (h ${this.shortH} against h ${g.longH}${on})`;
    const d = this.dispersion >= 10 ? this.dispersion.toFixed(0) : this.dispersion.toFixed(1);
    const cp = this.cp.family === 'poisson' ? ` (Poisson–Gamma, each ledger's evidence weighed by one over the dispersion ${d})` : '';
    return `${this.name}: ${gap} · CUSUM ${Math.max(c.up, c.down).toFixed(2)}/${c.h.toFixed(2)} (${c.alarms} alarm${c.alarms === 1 ? '' : 's'}, k ${c.k}, ARL ${this.threshold.arl} at lag-1 autocorrelation ${this.rho.toFixed(1)}, residuals ${of}against ${this.scaleH ? `the h ${this.scaleH} rope` : 'no formed rope yet'}) · run ${l.runLength} ledger${l.runLength === 1 ? '' : 's'} · P(a new run began at this ledger) ${l.changeProbability.toFixed(2)} · P(change within ${RECENT}) ${l.recentChangeProbability == null ? `— (the first ${RECENT} ledgers)` : l.recentChangeProbability.toFixed(2)}${cp}${l.recentChangeProbability > 0.5 ? ' · a change: intervals fall back to the short rope' : ''}`;
  }

  snapshot() {
    return { name: this.name, last: this.last, gap: this.gap, scaleH: this.scaleH, rho: this.rho, dispersion: this.dispersion, cusum: this.cusum.snapshot(), changePoint: this.cp.snapshot(), threshold: this.current };
  }
}

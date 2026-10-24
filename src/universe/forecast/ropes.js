// UNIVERSE phase 3B — the ropes: an EWMA bank of mean and variance per metric at half-lives of 1, 4, 16, 64, 256 and
// 1,024 ledgers, each labelled with its wall-time length and the number of independent windows behind it; a rope longer
// than the history is "forming" and never drawn as if it had one. Pure.

import { log1p as dlog1p, expm1 as dexpm1 } from './dmath.js';

export const HALF_LIVES = Object.freeze([1, 4, 16, 64, 256, 1024]);

/** The weight of one step for a half-life in steps: the mean's memory halves every `h` ledgers. */
export const alphaOf = (halfLife) => -dexpm1(-Math.LN2 / Math.max(1e-9, halfLife)); // 1 − 2^(−1/h), through dmath.js

/** One rope: an exponentially weighted mean and variance, updated per ledger. */
export class Rope {
  constructor(halfLife) {
    this.halfLife = halfLife;
    this.alpha = alphaOf(halfLife);
    this.mean = null;
    this.s = 0; // the exponentially weighted sum of squared deviations, uncorrected
    this.n = 0; // observations seen
  }

  update(x) {
    if (!Number.isFinite(x)) return this;
    this.n += 1;
    if (this.mean == null) {
      this.mean = x;
      this.s = 0;
      return this;
    }
    const d = x - this.mean;
    this.mean += this.alpha * d;
    // the exponentially weighted variance, with the mean's update folded in
    this.s = (1 - this.alpha) * (this.s + this.alpha * d * d);
    return this;
  }

  /**
   * The variance, corrected twice: for the start (the sum begins at zero, so
   * after n observations it has gathered 1 − (1−α)^(n−1) of its weight) and
   * for the mean's own estimation error (in steady state the sum settles at
   * 2(1−α)/(2−α) of the variance for independent observations). Zero before
   * two observations.
   */
  get variance() {
    if (this.n < 2) return 0;
    const a = this.alpha;
    const start = -dexpm1((this.n - 1) * dlog1p(-a)); // 1 − (1 − a)^(n − 1)
    const steady = (2 * (1 - a)) / (2 - a);
    return this.s / Math.max(1e-12, start * steady);
  }

  get sd() {
    return Math.sqrt(Math.max(0, this.variance));
  }

  /** How many independent windows of this half-life the history holds (floored); below two the rope is forming. */
  windows(history = this.n) {
    return Math.floor(history / this.halfLife);
  }

  get forming() {
    return this.windows() < 2;
  }

  /** The rope as the readout prints it: "h 64 ≈ 4.2 min · mean 118.3 · sd 21.4 · 5 windows" or "forming". */
  describe(msPerLedger = null) {
    const wall = msPerLedger ? ` ≈ ${wallLabel(this.halfLife * msPerLedger)}` : '';
    const w = this.windows();
    return `h ${this.halfLife}${wall} · ${this.mean == null ? 'no observation' : `mean ${fmt(this.mean)} · sd ${fmt(this.sd)}`} · ${w} window${w === 1 ? '' : 's'}${this.forming ? ' · forming' : ''}`;
  }

  snapshot() {
    return { halfLife: this.halfLife, mean: this.mean, sd: this.sd, n: this.n, windows: this.windows(), forming: this.forming };
  }
}

const fmt = (x) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(3));

/** A duration in milliseconds as the readout says it. */
export function wallLabel(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'unknown';
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)} min`;
  if (ms < 86400000) return `${(ms / 3600000).toFixed(1)} h`;
  return `${(ms / 86400000).toFixed(1)} d`;
}

/** The bank for one metric: a rope per half-life, updated together. */
export class RopeBank {
  constructor(halfLives = HALF_LIVES) {
    this.ropes = halfLives.map((h) => new Rope(h));
    this.n = 0;
  }

  update(x) {
    if (!Number.isFinite(x)) return this;
    this.n += 1;
    for (const r of this.ropes) r.update(x);
    return this;
  }

  rope(halfLife) {
    return this.ropes.find((r) => r.halfLife === halfLife) ?? null;
  }

  /** The longest rope that is not forming, else the shortest. */
  longestFormed() {
    const formed = this.ropes.filter((r) => !r.forming);
    return formed.length ? formed[formed.length - 1] : this.ropes[0];
  }

  describe(msPerLedger = null) {
    return this.ropes.map((r) => r.describe(msPerLedger));
  }

  snapshot() {
    return { n: this.n, ropes: this.ropes.map((r) => r.snapshot()) };
  }
}

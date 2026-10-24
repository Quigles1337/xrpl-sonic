// UNIVERSE phase 3B — the sealed past: the forecaster reads only through this, and it cannot return any ledger after N.
//
// The store holds one row per closed ledger, in sequence: { index, arrivedAt
// (the worker's clock, milliseconds, or null in a replay without arrival
// times), closeTime (the header's, seconds; never a target), count, types
// (counts per category), fee (the fee level when polled: open_ledger_fee in
// drops, queue size, expected_ledger_size, the server), accounts (the
// addresses that submitted), loops (Part A's loops reported at this ledger),
// takes (loop-takes seen in this ledger), proposed (the nowcast's view before
// the close, when available) }. `at(N)` gives a view whose every accessor
// throws on an index above N, so a leaky feature is caught by the accessor,
// not by review (docs/universe.md, Part B, "Sealed past"). Pure.

export class SealedPast {
  /** @param {{ max?: number }} options  the rows kept (the oldest are dropped beyond it; a dropped ledger reads as not heard) */
  constructor({ max = 4096 } = {}) {
    this.max = max;
    this.rows = [];
    this.byIndex = new Map();
    this.dropped = 0;
  }

  /** Append a closed ledger's row; rows arrive in increasing sequence (an older one is ignored, a gap is allowed and visible). */
  push(row) {
    if (!row || !Number.isInteger(row.index)) throw new Error('a row needs a ledger index');
    const last = this.rows.at(-1);
    if (last && row.index <= last.index) return false;
    const r = Object.freeze({ ...row });
    this.rows.push(r);
    this.byIndex.set(r.index, r);
    while (this.rows.length > this.max) {
      const old = this.rows.shift();
      this.byIndex.delete(old.index);
      this.dropped += 1;
    }
    return true;
  }

  get length() {
    return this.rows.length;
  }

  get latest() {
    return this.rows.at(-1) ?? null;
  }

  /** The view sealed at ledger N: nothing after N can be read through it. */
  at(N) {
    if (!Number.isInteger(N)) throw new Error('a sealed view needs a ledger index');
    return new SealedView(this, N);
  }
}

export class SealedView {
  constructor(store, N) {
    this.store = store;
    this.N = N;
    this.upto = store.rows.filter((r) => r.index <= N);
  }

  /** The row of a ledger, or null when it was not heard; throws for any index after N. */
  row(index) {
    if (!Number.isInteger(index)) throw new Error('a ledger index');
    if (index > this.N) throw new Error(`sealed at #${this.N}: #${index} is the future`);
    return this.store.byIndex.get(index) ?? null;
  }

  /** The last `k` rows at or before N, oldest first. */
  last(k) {
    return this.upto.slice(Math.max(0, this.upto.length - k));
  }

  /** Every row at or before N. */
  all() {
    return this.upto;
  }

  /** The newest row at or before N. */
  get head() {
    return this.upto.at(-1) ?? null;
  }

  get length() {
    return this.upto.length;
  }

  /** A series of one numeric field over the rows at or before N (null where absent). */
  series(pick) {
    return this.upto.map((r) => {
      const v = pick(r);
      return Number.isFinite(v) ? v : null;
    });
  }
}

/**
 * A feature is a function of a sealed view only. `guard` runs it and
 * rethrows the view's refusal with the feature's name, so a leaky feature
 * is caught the moment it reaches past N.
 */
export function guard(name, feature) {
  return (view) => {
    try {
      return feature(view);
    } catch (err) {
      throw new Error(`feature "${name}" reached past the sealed ledger: ${err.message}`);
    }
  };
}

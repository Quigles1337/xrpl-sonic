// UNIVERSE phase 3B — event studies: for every taker trade above a stated size, the mid, the spread and the
// top-of-book depth from N−w to N+w, averaged by book with bootstrap bands; the price move, the depth's half-recovery
// in ledgers, and the persistence. Each curve's mid is signed by the taker's side (positive when the mid moved the way
// the taker pushed it: up when the taker took the book's first asset), so a buy's move and a sell's do not cancel. The
// curves are candidate signals under the same out-of-sample rule as every other. Pure.

import { assetOf, valueOf, fundedOf } from '../shared-price.js';
import { seededRandom } from '../../coherence.js';
import { decodeCurrency, shortAddress } from '../../mapping.js';

/** A book key in words: "RLUSD (rMxC…m5De) | XRP" for "524C55…/rMxC…|XRP"; an asset without an issuer keeps its name. */
export function bookLabel(key) {
  return String(key)
    .split('|')
    .map((asset) => {
      if (asset === 'XRP' || !asset.includes('/')) return asset;
      const [code, issuer] = asset.split('/');
      return code === 'MPT' ? `MPT ${shortAddress(issuer)}` : `${decodeCurrency(code)} (${shortAddress(issuer)})`;
    })
    .join(' | ');
}

export const DEFAULTS = Object.freeze({ window: 8, sizePercentile: 0.9, resamples: 200, band: 0.8 });

/** A trade's side on a book: +1 when the taker received the book's first asset (its price in the second rises when pushed), −1 for the second, +1 when not known. */
export const sideOf = (book, got) => (got == null ? 1 : got === String(book).split('|')[0] ? 1 : -1);

/** The book key of two assets, order-free. */
export const bookOf = (a, b) => [a, b].sort().join('|');

/**
 * The quotes of every book in a book state: per book, the best price in
 * each direction (TakerPays per TakerGets of the best offer selling the
 * first asset, and of the best selling the second), the mid and the spread
 * as shares of the mid, and the depth at the top (the best offer's funded
 * TakerGets). Prices are the second asset per unit of the first (the
 * sorted key's order), so the two sides compare.
 */
export function quotesOf(state, only = null) {
  const books = new Map();
  for (const o of state.offers.values()) {
    const gets = assetOf(o.TakerGets);
    const pays = assetOf(o.TakerPays);
    const key = bookOf(gets, pays);
    if (only && !only.has(key)) continue;
    const f = fundedOf(o);
    if (!f) continue;
    const [first] = key.split('|');
    // the offer sells `gets` for `pays`; its price in second-per-first terms
    const sellsFirst = gets === first;
    const price = sellsFirst ? f.pays.amount / f.gets.amount : f.gets.amount / f.pays.amount;
    const b = books.get(key) ?? books.set(key, { key, ask: null, bid: null, askDepth: 0, bidDepth: 0, offers: 0 }).get(key);
    b.offers += 1;
    if (sellsFirst) {
      // an ask on the first asset: the lowest price wins
      if (b.ask == null || price < b.ask) {
        b.ask = price;
        b.askDepth = f.gets.amount;
      } else if (price === b.ask) b.askDepth += f.gets.amount;
    } else if (b.bid == null || price > b.bid) {
      b.bid = price;
      b.bidDepth = f.pays.amount;
    } else if (price === b.bid) b.bidDepth += f.pays.amount;
  }
  for (const b of books.values()) {
    b.mid = b.ask != null && b.bid != null ? (b.ask + b.bid) / 2 : (b.ask ?? b.bid ?? null);
    b.spread = b.ask != null && b.bid != null && b.mid > 0 ? (b.ask - b.bid) / b.mid : null;
    b.depth = b.askDepth + b.bidDepth;
  }
  return books;
}

/** The size of a taker trade in XRP-equivalent: the XRP side when one is XRP, else the amount times the book's mid when known. */
export function tradeSizeXrp(trade, quotes) {
  if (trade.gaveAsset === 'XRP') return trade.gave;
  if (trade.gotAsset === 'XRP') return trade.got;
  return null;
}

/** The threshold: the stated percentile of trade sizes in the window. */
export function sizeThreshold(sizes, percentile = DEFAULTS.sizePercentile) {
  const s = sizes.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.floor(percentile * s.length))];
}

/**
 * One study: the quotes of a book around an event, as relative curves
 * (mid as the change from the mid at N−1, spread and depth as ratios to
 * N−1), from N−w to N+w; null entries where the book had no quote.
 */
export function curveOf(series, at, w = DEFAULTS.window, sign = 1) {
  const base = series.get(at - 1);
  if (!base || base.mid == null) return null;
  const mid = [];
  const spread = [];
  const depth = [];
  for (let k = -w; k <= w; k++) {
    const q = series.get(at + k);
    mid.push(q?.mid != null ? (sign * (q.mid - base.mid)) / base.mid : null);
    spread.push(q?.spread != null && base.spread != null && base.spread > 0 ? q.spread / base.spread : null);
    depth.push(q?.depth != null && base.depth > 0 ? q.depth / base.depth : null);
  }
  return { mid, spread, depth, w };
}

/** The mean curve of many, with bootstrap bands at `band` (seeded), per position; null where fewer than two curves had a value. */
export function averageCurves(curves, { resamples = DEFAULTS.resamples, band = DEFAULTS.band, seed = 1 } = {}) {
  if (!curves.length) return null;
  const w = curves[0].w;
  const L = 2 * w + 1;
  const rnd = seededRandom(seed);
  const out = {};
  for (const field of ['mid', 'spread', 'depth']) {
    const mean = new Array(L).fill(null);
    const lo = new Array(L).fill(null);
    const hi = new Array(L).fill(null);
    const n = new Array(L).fill(0);
    for (let i = 0; i < L; i++) {
      const vals = curves.map((c) => c[field][i]).filter((v) => v != null);
      n[i] = vals.length;
      if (vals.length < 2) continue;
      mean[i] = vals.reduce((a, b) => a + b, 0) / vals.length;
      const means = [];
      for (let r = 0; r < resamples; r++) {
        let s = 0;
        for (let k = 0; k < vals.length; k++) s += vals[Math.floor(rnd() * vals.length)];
        means.push(s / vals.length);
      }
      means.sort((a, b) => a - b);
      lo[i] = means[Math.floor(((1 - band) / 2) * resamples)];
      hi[i] = means[Math.min(resamples - 1, Math.floor((1 - (1 - band) / 2) * resamples))];
    }
    out[field] = { mean, lo, hi, n };
  }
  out.w = w;
  out.count = curves.length;
  return out;
}

/**
 * The summary of an averaged study: the price move at N (the mid's change
 * at the event, in basis points), the depth's half-recovery in ledgers
 * (the first k after N at which the depth is back half way from its
 * trough to 1), and the persistence (the share of the move left at N+w).
 */
export function summarize(avg) {
  if (!avg) return null;
  const w = avg.w;
  const atN = avg.mid.mean[w];
  const atEnd = avg.mid.mean[2 * w];
  const move = atN == null ? null : atN * 1e4;
  // the share of the move left at N+w, only for a move told apart from none (its band excludes zero): a ratio over a move
  // inside its own noise is noise (18 on a 0.1 bp move on the second recording)
  const told = atN != null && avg.mid.lo[w] != null && avg.mid.hi[w] != null && (avg.mid.lo[w] > 0 || avg.mid.hi[w] < 0);
  const persistence = told && atEnd != null && Math.abs(atN) > 1e-12 ? atEnd / atN : null;
  let halfRecovery = null;
  const dN = avg.depth.mean[w];
  if (dN != null && dN < 1) {
    const target = dN + (1 - dN) / 2;
    for (let k = 1; k <= w; k++) {
      const d = avg.depth.mean[w + k];
      if (d != null && d >= target) {
        halfRecovery = k;
        break;
      }
    }
  }
  return { moveBps: move, moveBand: atN == null ? null : [avg.mid.lo[w] * 1e4, avg.mid.hi[w] * 1e4], persistence, told, halfRecovery, count: avg.count, depthAtN: dN };
}

/** The words: "USD.rI|XRP: 12 trades above 5,000 XRP · move −8.3 bp (−12.1 to −4.6, 80%) · depth half back in 3 ledgers · 0.42 of the move left at N+8". */
export function describeStudy(key, summary, threshold, thresholdUnit = 'XRP') {
  if (!summary) return `${key}: no study (fewer than two events)`;
  const band = summary.moveBand ? ` (${summary.moveBand[0].toFixed(1)} to ${summary.moveBand[1].toFixed(1)}, 80%)` : '';
  return `${key}: ${summary.count} trade${summary.count === 1 ? '' : 's'} above ${threshold == null ? '—' : Number(threshold).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${thresholdUnit} · move ${summary.moveBps == null ? '—' : `${summary.moveBps >= 0 ? '+' : ''}${summary.moveBps.toFixed(1)} bp in the taker’s direction${band}`} · depth ${summary.halfRecovery == null ? (summary.depthAtN != null && summary.depthAtN >= 1 ? 'not thinned' : 'not half back within the window') : `half back in ${summary.halfRecovery} ledger${summary.halfRecovery === 1 ? '' : 's'}`} · ${summary.persistence != null ? `${summary.persistence.toFixed(2)} of the move left at N+w` : summary.moveBps != null && !summary.told ? 'persistence — (the move’s band holds zero)' : 'persistence —'}`;
}

/**
 * The event-study bookkeeping: per book, a ring of quotes by ledger
 * (kept for 2w+2 ledgers after the last use), the events (taker trades
 * above the threshold) and the curves completed once N+w has closed.
 */
export class EventStudies {
  constructor({ window = DEFAULTS.window, keep = 64, maxBooks = 300 } = {}) {
    this.w = window;
    this.keep = keep;
    this.maxBooks = maxBooks;
    this.quotes = new Map(); // book → Map<ledger, quote>
    this.pending = []; // { book, at }
    this.curves = new Map(); // book → curve[]
    this.sizes = [];
    this.threshold = null;
    this.active = new Map(); // book → the last ledger a trade was seen on it
    this.trades = 0;
    this.studies = 0;
    this.paperMin = 5; // the past studies a paper trade's direction needs
    this.paper = { n: 0, held: 0, books: new Set() };
  }

  /** The books worth quoting: those a trade was seen on, the most recent first, at most maxBooks. */
  activeBooks() {
    if (this.active.size <= this.maxBooks) return new Set(this.active.keys());
    return new Set([...this.active].sort((a, b) => b[1] - a[1]).slice(0, this.maxBooks).map(([k]) => k));
  }

  /** The average mid change from a large trade's ledger to k ledgers on, over this book's completed studies (at least `min`), or null. */
  drift(book, k = 1, min = 5) {
    const curves = this.curves.get(book);
    if (!curves || curves.length < min) return null;
    const vals = curves.map((c) => (c.mid[c.w + k] != null && c.mid[c.w] != null ? (1 + c.mid[c.w + k]) / (1 + c.mid[c.w]) - 1 : null)).filter((v) => v != null);
    return vals.length >= min ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }

  /**
   * A paper trade, for the research switch only: at a large trade's ledger
   * N, follow (or fade) the sign of this book's mean signed move from N to
   * N+w over the studies whose windows had closed by N (at least paperMin),
   * and see whether this event's own move went that way. Counted, never
   * valued: no profit is kept or shown.
   */
  _paper(book, curve) {
    const w = curve.w;
    const moveOf = (c) => (c.mid[2 * w] != null && c.mid[w] != null ? (1 + c.mid[2 * w]) / (1 + c.mid[w]) - 1 : null);
    const prior = (this.curves.get(book) ?? []).filter((c) => c.at + w <= curve.at).map(moveOf).filter((v) => v != null);
    if (prior.length < this.paperMin) return;
    const direction = Math.sign(prior.reduce((a, b) => a + b, 0));
    const moved = moveOf(curve);
    if (!direction || moved == null || moved === 0) return;
    this.paper.n += 1;
    if (direction * moved > 0) this.paper.held += 1;
    this.paper.books.add(book);
  }

  /** The paper trades in words, with the simulator's blind spots; no profit. */
  paperLine() {
    const p = this.paper;
    return `paper trades (research switch; counted, never valued): after a large trade, the direction of the book's past signed move from N to N+${this.w} (at least ${this.paperMin} past studies whose windows had closed) held in ${p.held} of ${p.n} on ${p.books.size} book${p.books.size === 1 ? '' : 's'} · blind spots: no own impact, no ordering lottery, no queue position, mids from the offers seen at face value`;
  }

  /** Record the quotes of a ledger (from quotesOf), keeping a bounded history per book. */
  noteQuotes(ledger, books) {
    for (const [key, q] of books) {
      const series = this.quotes.get(key) ?? this.quotes.set(key, new Map()).get(key);
      series.set(ledger, { mid: q.mid, spread: q.spread, depth: q.depth });
      if (series.size > this.keep) {
        const oldest = Math.min(...series.keys());
        series.delete(oldest);
      }
    }
    // complete the studies whose window has closed
    const done = [];
    for (const p of this.pending) {
      if (ledger < p.at + this.w) continue;
      const series = this.quotes.get(p.book);
      const curve = series ? curveOf(series, p.at, this.w, p.sign ?? 1) : null;
      if (curve) {
        curve.at = p.at;
        this._paper(p.book, curve);
        (this.curves.get(p.book) ?? this.curves.set(p.book, []).get(p.book)).push(curve);
        this.studies += 1;
      }
      done.push(p);
    }
    if (done.length) this.pending = this.pending.filter((p) => !done.includes(p));
  }

  /** A taker trade at `ledger` on `book` of `sizeXrp`: joins the studies when above the threshold (the stated percentile of sizes so far). */
  noteTrade(ledger, book, sizeXrp, got = null) {
    if (!Number.isFinite(sizeXrp)) return false;
    this.active.set(book, ledger);
    this.trades += 1;
    this.sizes.push(sizeXrp);
    if (this.sizes.length > 4000) this.sizes.shift();
    this.threshold = sizeThreshold(this.sizes);
    if (this.sizes.length < 20 || sizeXrp < this.threshold) return false;
    this.pending.push({ book, at: ledger, sign: sideOf(book, got) });
    return true;
  }

  /** The averaged studies per book with their summaries and words. */
  report() {
    const out = [];
    for (const [book, curves] of this.curves) {
      const avg = averageCurves(curves);
      const summary = summarize(avg);
      out.push({ book, count: curves.length, summary, line: describeStudy(bookLabel(book), summary, this.threshold) });
    }
    out.sort((a, b) => b.count - a.count);
    return out;
  }
}

// UNIVERSE phase 3B — the research switch's book closes, off by default until the owner decides.
//
// rippled's book_changes (src/xrpld/rpc/BookChanges.h, computeBookChanges, branch develop, read 2026-10-24) tallies,
// per book in a ledger, every Offer node that was modified or deleted (never created) with both previous and final
// amounts, skipping a deletion whose Sequence is the transaction's OfferSequence (an explicit cancel or replace): the
// volumes are the absolute changes of TakerGets and TakerPays; side A is XRP when one side is, else the smaller asset
// string (an asset is "XRP" or "issuer/currency", to_string(Issue) in src/libxrpl/protocol/Issue.cpp; the output names
// XRP "XRP_drops"); a rate is side A per side B of one change, and open, close, high and low are the first, last,
// highest and lowest of those rates in the ledger, which is to say traded rates, not the top of the book the
// documentation page describes. This module reads the method's result, tallies the same books from the facts layer's
// traded offers (src/explorer/facts.js, tradedAmounts, exact decimal strings), cross-checks the two, and forecasts
// each XRP book's close at its next trade (persistence, and the event studies' drift after a large trade), scored.
// docs/universe.md, "Phase 3B". Pure.

import { facts } from '../../explorer/facts.js';
import { add, sub, abs, cmp, isZero } from '../../decimal.js';
import { log as dlog, log1p as dlog1p } from './dmath.js';

/** An asset as rippled names it in a book key: "XRP" or "issuer/currency". */
export const rippledAsset = (amount) => (amount == null ? null : amount.currency === 'XRP' && !amount.issuer ? 'XRP' : `${amount.issuer}/${amount.code ?? amount.currency}`);

/** rippled's side A of a book: XRP when one side is, else the smaller string. */
export function orient(x, y) {
  const noswap = x === 'XRP' || (y !== 'XRP' && x < y);
  return noswap ? [x, y] : [y, x];
}

const keyOf = (a, b) => `${a}|${b}`;

/** The method's result as Map<"A|B", { a, b, volumeA, volumeB, close, open, high, low }>, XRP named "XRP". */
export function parseBookChanges(result) {
  const out = new Map();
  for (const c of result?.changes ?? []) {
    if (c.mpt_issuance_id_a || c.mpt_issuance_id_b) continue;
    const a = c.currency_a === 'XRP_drops' ? 'XRP' : c.currency_a;
    const b = c.currency_b === 'XRP_drops' ? 'XRP' : c.currency_b;
    out.set(keyOf(a, b), { a, b, volumeA: String(c.volume_a), volumeB: String(c.volume_b), close: Number(c.close), open: Number(c.open), high: Number(c.high), low: Number(c.low) });
  }
  return out;
}

/** The same books tallied from the facts layer's traded offers of a ledger's transactions (exact strings). */
export function bookChangesFromFacts(transactions) {
  const out = new Map();
  let offers = 0;
  for (const t of transactions ?? []) {
    if (t.meta?.TransactionResult !== 'tesSUCCESS') continue;
    let f;
    try {
      f = facts(t.tx, t.meta);
    } catch {
      continue;
    }
    for (const o of f.offers ?? []) {
      if (o.traded !== 'yes' || !o.tradedAmounts || typeof o.tradedAmounts !== 'object') continue;
      const gave = o.tradedAmounts.gave;
      const got = o.tradedAmounts.got;
      const g = rippledAsset(gave);
      const p = rippledAsset(got);
      if (!g || !p) continue;
      const vg = gave.drops ?? gave.value;
      const vp = got.drops ?? got.value;
      if (vg == null || vp == null) continue;
      const [a, b] = orient(g, p);
      const key = keyOf(a, b);
      const e = out.get(key) ?? { a, b, volumeA: '0', volumeB: '0', offers: 0 };
      e.volumeA = add(e.volumeA, a === g ? vg : vp);
      e.volumeB = add(e.volumeB, a === g ? vp : vg);
      e.offers += 1;
      out.set(key, e);
      offers += 1;
    }
  }
  return { books: out, offers };
}

/** Two decimal strings equal within a relative tolerance (rippled sums tokens to 16 significant digits). */
function close(x, y, rel = 1e-9) {
  if (cmp(x, y) === 0) return true;
  const d = Number(abs(sub(x, y)));
  const m = Math.max(Math.abs(Number(x)), Math.abs(Number(y)));
  return m === 0 ? d === 0 : d / m <= rel;
}

/** The cross-check of the method against the facts layer at one ledger: matched books, and the mismatches with why. */
export function crossCheck(fromMethod, fromFacts) {
  const mismatches = [];
  let matched = 0;
  for (const [key, m] of fromMethod) {
    const f = fromFacts.get(key);
    if (!f) {
      mismatches.push({ key, why: 'in book_changes only' });
      continue;
    }
    if (!close(m.volumeA, f.volumeA) || !close(m.volumeB, f.volumeB)) mismatches.push({ key, why: `volumes ${m.volumeA}/${m.volumeB} against ${f.volumeA}/${f.volumeB}` });
    else matched += 1;
  }
  for (const key of fromFacts.keys()) if (!fromMethod.has(key)) mismatches.push({ key, why: 'in the facts layer only' });
  return { method: fromMethod.size, facts: fromFacts.size, matched, mismatches };
}

const shortAsset = (s) => (s === 'XRP' ? 'XRP' : `${s.split('/')[1] ?? s}.${(s.split('/')[0] ?? '').slice(0, 4)}…`);

/** "book_changes at #N: 31 books · the facts layer: 31 · 31 match · 0 mismatches" or "not cross-checked: 120 heard of 124". */
export function describeCheck(index, check, { heard = null, txnCount = null } = {}) {
  if (heard != null && txnCount != null && heard < txnCount) return `book_changes at #${index}: not cross-checked (${heard} of ${txnCount} transactions heard)`;
  const first = check.mismatches.slice(0, 3).map((m) => `${m.key.split('|').map(shortAsset).join('|')}: ${m.why}`);
  return `book_changes at #${index}: ${check.method} books · the facts layer: ${check.facts} · ${check.matched} match · ${check.mismatches.length} mismatch${check.mismatches.length === 1 ? '' : 'es'}${first.length ? ` (${first.join('; ')})` : ''}`;
}

/**
 * The close of each XRP book at its next trade: persistence (the last
 * close) against the event studies' drift after a large trade (the last
 * close moved by the average mid change one ledger on, when the last trade
 * was large and five studies stand behind the book); both scored on every
 * trade that follows. Token/token books are cross-checked, not forecast.
 * The study keeps its own sealed order: a close is forecast from closes at
 * earlier ledgers only.
 */
export class BookCloses {
  constructor({ keep = 20000 } = {}) {
    this.last = new Map(); // key → { index, close, large }
    this.pending = new Map(); // key → { persistence, drift }: the forecasts of log(close) at the book's next trade
    this.resolved = []; // { index, key, persistence, drift }: absolute errors of log(close), one per book per next trade
    this.keep = keep;
    this.checks = { ledgers: 0, books: 0, matched: 0, mismatches: 0, notChecked: 0, first: [] };
    this.lastIndex = null;
  }

  /**
   * A ledger's book_changes (parsed), with the books that saw a large trade
   * and a drift lookup (book → relative mid change one ledger on, or null).
   * Each book's close is forecast for its next trade on the log scale
   * (rates in drops per token unit span many orders of magnitude, so an
   * error in rate units would be the largest book's alone).
   */
  note(index, changes, { large = new Set(), driftOf = () => null } = {}) {
    if (this.lastIndex != null && index <= this.lastIndex) return;
    this.lastIndex = index;
    for (const [key, c] of changes) {
      if (c.a !== 'XRP' || !Number.isFinite(c.close) || c.close <= 0) continue;
      const lc = dlog(c.close);
      // resolve the forecast made for this book's next trade
      const p = this.pending.get(key);
      if (p) {
        this.resolved.push({ index, key, persistence: Math.abs(p.persistence - lc), drift: p.drift == null ? null : Math.abs(p.drift - lc) });
        if (this.resolved.length > this.keep) this.resolved.shift();
        this.pending.delete(key);
      }
      // the forecast for its next trade
      const isLarge = large.has(key);
      const d = isLarge ? driftOf(key) : null;
      this.pending.set(key, { persistence: lc, drift: Number.isFinite(d) && d > -1 ? lc + dlog1p(d) : null });
      this.last.set(key, { index, close: c.close, large: isLarge });
    }
  }

  /** Persistence's mean absolute error of log(close) over every next trade, and the drift's skill against it over the trades both forecast. */
  scores() {
    const n = this.resolved.length;
    const persistenceMae = n ? this.resolved.reduce((acc, r) => acc + r.persistence, 0) / n : null;
    const both = this.resolved.filter((r) => r.drift != null);
    const sp = both.reduce((acc, r) => acc + r.persistence, 0);
    const sd = both.reduce((acc, r) => acc + r.drift, 0);
    return { n, persistenceMae, drift: both.length ? { n: both.length, mae: sd / both.length, skill: sp > 0 ? 1 - sd / sp : null } : null };
  }

  noteCheck(check, { heard = null, txnCount = null } = {}) {
    if (heard != null && txnCount != null && heard < txnCount) {
      this.checks.notChecked += 1;
      return;
    }
    this.checks.ledgers += 1;
    this.checks.books += check.method;
    this.checks.matched += check.matched;
    this.checks.mismatches += check.mismatches.length;
    for (const m of check.mismatches) if (this.checks.first.length < 3) this.checks.first.push(m);
  }

  describe() {
    const sc = this.scores();
    const c = this.checks;
    return [
      `book closes (research switch): ${this.last.size} XRP books with a close · persistence's mean absolute error of log(close) ${sc.persistenceMae == null ? '—' : `${sc.persistenceMae.toFixed(4)} (about ${(100 * sc.persistenceMae).toFixed(2)}%)`} over ${sc.n} next trades${sc.drift ? ` · after a large trade, the event-study drift's skill against persistence ${sc.drift.skill == null ? '—' : `${sc.drift.skill >= 0 ? '+' : ''}${sc.drift.skill.toFixed(2)}`} over ${sc.drift.n}` : ' · no large trade with five studies behind its book yet'} · rates are side A per side B (drops per token unit for an XRP book), the traded rates book_changes calls close`,
      `book_changes against the facts layer: ${c.ledgers} ledgers checked (${c.notChecked} not, heard short) · ${c.books} books · ${c.matched} match · ${c.mismatches} mismatch${c.mismatches === 1 ? '' : 'es'}${c.first.length ? ` (first: ${c.first.map((m) => `${m.key.split('|').map(shortAsset).join('|')}: ${m.why}`).join('; ')})` : ''}`,
    ];
  }
}

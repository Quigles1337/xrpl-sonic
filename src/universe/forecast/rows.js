// UNIVERSE phase 3B — the rows: one per closed ledger, built from the stream's messages by one pure builder that the
// worker and the bench share, so a live sky, a replay and the Node evaluation forecast from identical rows.
//
// On this stream a ledger's transactions arrive after its close message (the first recording: 57,870 of the 59,787
// transactions of its first 201 ledgers came after their ledger's close), so a row is finished when the transactions
// heard for it reach the header's txn_count, or at the next close, whichever comes first. A transaction for a ledger
// already finished is left out of every row: counted a duplicate when its hash was already heard for that ledger (the
// first recording's stream sent 41,262 transactions a second time, 2 to 49 closes after their ledger's close, in 276
// runs), else late (11 there); one for a ledger more than keepFinished rows behind is counted stale and never opens a
// row. In-flight transactions (transactions_proposed: no
// metadata, validated false, a ledger_current_index) are counted per open ledger for the nowcast; fee results are kept
// per open ledger (their ledger_current_index). docs/universe.md, "Phase 3B". Pure.

import { unwrapTransactionMessage, categorize } from '../../mapping.js';
import { loopTakes, consumedOffers } from '../shared-price.js';

export const ROW_VERSION = 1;

/** An in-flight transaction message (transactions_proposed): no metadata, or validated false. */
export const isInFlight = (msg) => msg?.type === 'transaction' && (msg.validated === false || (!msg.meta && !msg.metadata));

const hashOf = (msg) => {
  const h = msg?.transaction?.hash ?? msg?.tx_json?.hash ?? msg?.hash;
  return typeof h === 'string' ? h.toUpperCase() : null;
};

/** The book key of two assets, order-free ("A|B" with the smaller string first). */
export const bookKey = (a, b) => [a, b].sort().join('|');

/**
 * The XRP-side size of a consumed offer, in XRP, or null for a token/token
 * book (no XRP side to size it by).
 */
export function tradeXrp(o) {
  if (o.asset === 'XRP' && Number.isFinite(o.gave)) return o.gave / 1e6;
  if (o.paysAsset === 'XRP' && Number.isFinite(o.got)) return o.got / 1e6;
  return null;
}

export class RowBuilder {
  /**
   * @param {{ keepFinished?: number, keepInFlight?: number, keepTransactions?: boolean }} options
   *   keepTransactions: hand each row its ledger's transactions (the research switch's facts cross-check reads them)
   */
  constructor({ keepFinished = 64, keepInFlight = 8, keepTransactions = false } = {}) {
    this.open = new Map(); // ledger index → { header, hashes, heard, types, accounts, txs }
    this.finished = new Set();
    this.finishedOrder = [];
    this.keepFinished = keepFinished;
    this.keepInFlight = keepInFlight;
    this.keepTransactions = keepTransactions;
    this.late = 0; // a transaction first heard after its ledger's row finished
    this.duplicates = 0; // a transaction heard again (before or after its row finished)
    this.stale = 0; // a transaction for a ledger more than keepFinished rows behind the newest finished one
    this.finishedHashes = new Map(); // finished ledger index → the hashes heard for it (the last keepFinished rows)
    this.highestFinished = null;
    this.proposed = new Map(); // open ledger index → Set of in-flight hashes
    this.proposedSeen = false;
    this.fees = new Map(); // open ledger index → the last fee result seen during it
    this.feeSeen = false;
    this.rows = 0;
  }

  _entry(index) {
    let e = this.open.get(index);
    if (!e) {
      e = { index, header: null, hashes: new Set(), heard: 0, types: {}, accounts: new Set(), txs: [] };
      this.open.set(index, e);
    }
    return e;
  }

  /** A validated transaction message; returns the rows it finished (usually none, or its ledger's). In-flight messages go to noteProposed. */
  noteTransaction(msg) {
    if (isInFlight(msg)) {
      this.noteProposed(msg);
      return [];
    }
    const u = unwrapTransactionMessage(msg);
    if (!u) return [];
    const index = Number(u.ledgerIndex);
    if (!Number.isInteger(index) || index <= 0) return [];
    const hash = typeof u.hash === 'string' ? u.hash.toUpperCase() : null;
    if (this.finished.has(index)) {
      if (hash && this.finishedHashes.get(index)?.has(hash)) this.duplicates += 1; // sent again after its row finished
      else this.late += 1;
      return [];
    }
    if (this.highestFinished != null && index <= this.highestFinished - this.keepFinished) {
      this.stale += 1;
      return [];
    }
    const e = this._entry(index);
    if (hash) {
      if (e.hashes.has(hash)) {
        this.duplicates += 1;
        return [];
      }
      e.hashes.add(hash);
    }
    e.heard += 1;
    const category = categorize(u.tx?.TransactionType);
    e.types[category] = (e.types[category] ?? 0) + 1;
    if (typeof u.tx?.Account === 'string') e.accounts.add(u.tx.Account);
    e.txs.push({ tx: u.tx, meta: u.meta, hash, ledgerIndex: index });
    return this._finishIfComplete(index);
  }

  /** An in-flight transaction (transactions_proposed), counted against the open ledger it was proposed in. */
  noteProposed(msg) {
    this.proposedSeen = true;
    const hash = hashOf(msg);
    const index = Number(msg?.ledger_current_index);
    if (!hash || !Number.isInteger(index)) return;
    let set = this.proposed.get(index);
    if (!set) {
      set = new Set();
      this.proposed.set(index, set);
      for (const k of this.proposed.keys()) if (k < index - this.keepInFlight) this.proposed.delete(k);
    }
    set.add(hash);
  }

  /** A fee method result (polled, or a timed recording's line), kept against the open ledger it was read in. */
  noteFee(result, { at = null, server = null } = {}) {
    const index = Number(result?.ledger_current_index);
    if (!Number.isInteger(index)) return;
    this.feeSeen = true;
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    this.fees.set(index, { ledgerCurrentIndex: index, openLedgerFee: num(result.drops?.open_ledger_fee), medianFee: num(result.drops?.median_fee), queueSize: num(result.current_queue_size), maxQueueSize: num(result.max_queue_size), expectedLedgerSize: num(result.expected_ledger_size), currentLedgerSize: num(result.current_ledger_size), at, server });
    for (const k of this.fees.keys()) if (k < index - this.keepInFlight) this.fees.delete(k);
  }

  /** What was in flight for ledger L before its close: the proposed count (null when no proposed stream) and the last fee result read while L was open (null when none). */
  inflight(index) {
    return { proposed: this.proposedSeen ? (this.proposed.get(index)?.size ?? 0) : null, fee: this.fees.get(index) ?? null };
  }

  /**
   * A ledgerClosed message. Finishes every open ledger older than this one
   * (their transactions came after their own close and before this one),
   * registers this ledger's header (txn_count, ledger_time, the local
   * arrival time, what was in flight for it), and finishes it at once when
   * everything it holds has already arrived. Returns the finished rows,
   * oldest first; the caller can tell this ledger's row from older ones by
   * its index.
   */
  noteClose(msg, arrivedAt = null) {
    const index = Number(msg?.ledger_index);
    if (!Number.isInteger(index) || index <= 0) return [];
    if (this.finished.has(index)) return [];
    const out = [];
    for (const k of [...this.open.keys()].sort((a, b) => a - b)) {
      const e = this.open.get(k);
      if (k < index && e.header) out.push(this._finish(k));
      else if (k < index - this.keepFinished) this.open.delete(k); // never closed here: another network or a gap
    }
    const e = this._entry(index);
    e.header = { txnCount: Number.isFinite(Number(msg.txn_count)) ? Number(msg.txn_count) : null, closeTime: Number.isFinite(Number(msg.ledger_time)) ? Number(msg.ledger_time) : null, arrivedAt: Number.isFinite(arrivedAt) ? arrivedAt : null, inflight: this.inflight(index) };
    out.push(...this._finishIfComplete(index));
    return out;
  }

  _finishIfComplete(index) {
    const e = this.open.get(index);
    if (!e?.header) return [];
    if (e.header.txnCount != null && e.heard >= e.header.txnCount) return [this._finish(index)];
    return [];
  }

  _finish(index) {
    const e = this.open.get(index);
    this.open.delete(index);
    this.finished.add(index);
    this.finishedHashes.set(index, e.hashes);
    this.finishedOrder.push(index);
    this.highestFinished = Math.max(this.highestFinished ?? index, index);
    while (this.finishedOrder.length > this.keepFinished) {
      const old = this.finishedOrder.shift();
      this.finished.delete(old);
      this.finishedHashes.delete(old);
    }
    e.txs.sort((a, b) => Number(a.meta?.TransactionIndex ?? 0) - Number(b.meta?.TransactionIndex ?? 0));
    const takes = loopTakes(e.txs)
      .filter((t) => t.kind === 'pair' || t.circular)
      .map((t) => ({ kind: t.kind, taker: t.taker, hash: t.hash, offers: t.offers.map((o) => `${o.owner}:${o.sequence}`) }));
    const trades = [];
    let tokenTrades = 0;
    for (const t of e.txs) {
      if (t.meta?.TransactionResult !== 'tesSUCCESS') continue;
      for (const o of consumedOffers(t.tx, t.meta)) {
        const xrp = tradeXrp(o);
        if (xrp == null) tokenTrades += 1;
        else if (xrp > 0) trades.push({ book: bookKey(o.asset, o.paysAsset), xrp, got: o.asset }); // got: the asset the taker received
      }
    }
    this.rows += 1;
    const h = e.header;
    const row = {
      index,
      arrivedAt: h.arrivedAt,
      closeTime: h.closeTime,
      txnCount: h.txnCount,
      heard: e.heard,
      count: h.txnCount ?? e.heard,
      types: { ...e.types },
      accounts: [...e.accounts].sort(),
      takes,
      trades,
      tokenTrades,
      fee: h.inflight.fee,
      proposed: h.inflight.proposed,
      late: this.late,
      duplicates: this.duplicates,
    };
    if (this.keepTransactions) Object.defineProperty(row, 'transactions', { value: e.txs, enumerable: false });
    return row;
  }
}

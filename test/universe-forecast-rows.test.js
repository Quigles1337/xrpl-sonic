// UNIVERSE phase 3B — the rows: one per closed ledger, finished when the transactions heard reach the header's
// txn_count or at the next close; duplicates and stragglers counted; what was in flight kept per open ledger; the
// loop-takes and the trades of the ledger. And the research switch's book_changes: parsed, tallied from the facts
// layer, cross-checked, and the book closes scored.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RowBuilder, isInFlight, bookKey, tradeXrp } from '../src/universe/forecast/rows.js';
import { parseBookChanges, bookChangesFromFacts, crossCheck, describeCheck, orient, rippledAsset, BookCloses } from '../src/universe/forecast/books.js';

const I = 'rIssuerAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const iou = (c, v) => ({ currency: c, issuer: I, value: String(v) });
let seq = 0;
const hash = () => (++seq).toString(16).toUpperCase().padStart(64, '0');
const close = (index, txnCount) => ({ type: 'ledgerClosed', ledger_index: index, ledger_time: 800000000 + index, txn_count: txnCount });
const tx = (index, fields = {}, nodes = [], txIndex = 0) => {
  const h = hash();
  return { type: 'transaction', validated: true, ledger_index: index, hash: h, engine_result: 'tesSUCCESS', transaction: { TransactionType: 'Payment', Account: 'rSender', Destination: 'rDest', Amount: '1000', hash: h, ...fields }, meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: txIndex, AffectedNodes: nodes } };
};
const offerNode = (kind, owner, sequence, gets, pays, prevGets, prevPays) => ({ [kind]: { LedgerEntryType: 'Offer', FinalFields: { Account: owner, Sequence: sequence, TakerGets: gets, TakerPays: pays }, ...(prevGets != null ? { PreviousFields: { TakerGets: prevGets, TakerPays: prevPays } } : {}) } });

describe('the rows', () => {
  test('transactions after their close: the row finishes when the heard count reaches txn_count', () => {
    const b = new RowBuilder();
    assert.deepEqual(b.noteClose(close(100, 3), 5000), []);
    assert.deepEqual(b.noteTransaction(tx(100, { TransactionType: 'Payment' })), []);
    assert.deepEqual(b.noteTransaction(tx(100, { TransactionType: 'OfferCreate', Account: 'rMaker' })), []);
    const [row] = b.noteTransaction(tx(100, { TransactionType: 'TrustSet', Account: 'rTrust' }));
    assert.equal(row.index, 100);
    assert.equal(row.count, 3);
    assert.equal(row.heard, 3);
    assert.equal(row.txnCount, 3);
    assert.equal(row.arrivedAt, 5000);
    assert.equal(row.closeTime, 800000100);
    assert.deepEqual(row.types, { payment: 1, offer: 1, trust: 1 });
    assert.deepEqual(row.accounts, ['rMaker', 'rSender', 'rTrust']);
    assert.equal(row.proposed, null, 'no proposed stream: null, not zero');
    assert.equal(row.fee, null);
  });
  test('transactions before their close: the row finishes at the close when everything is already in', () => {
    const b = new RowBuilder();
    b.noteTransaction(tx(200));
    b.noteTransaction(tx(200));
    const done = b.noteClose(close(200, 2), 1);
    assert.deepEqual(done.map((r) => r.index), [200]);
    assert.equal(done[0].heard, 2);
  });
  test('the next close finishes a ledger heard short; a duplicate is not heard twice; a straggler after its row is counted late', () => {
    const b = new RowBuilder();
    b.noteClose(close(300, 3), 1);
    const one = tx(300);
    b.noteTransaction(one);
    b.noteTransaction({ ...one });
    assert.equal(b.duplicates, 1);
    b.noteTransaction(tx(300));
    const done = b.noteClose(close(301, 0), 2);
    assert.deepEqual(done.map((r) => [r.index, r.heard, r.txnCount, r.count]), [
      [300, 2, 3, 3],
      [301, 0, 0, 0],
    ]);
    assert.deepEqual(b.noteTransaction(tx(300)), []);
    assert.equal(b.late, 1);
    assert.equal(b.rows, 2);
  });
  test('a re-delivery after its row finished is a duplicate, not a straggler; a ledger beyond the kept window is stale and opens no row', () => {
    const b = new RowBuilder({ keepFinished: 4 });
    b.noteClose(close(500, 2), 1);
    const one = tx(500);
    b.noteTransaction(one);
    const done = b.noteTransaction(tx(500));
    assert.deepEqual(done.map((r) => [r.index, r.heard]), [[500, 2]]);
    b.noteTransaction({ ...one }); // the stream sends it again after the row finished
    assert.equal(b.duplicates, 1);
    assert.equal(b.late, 0);
    b.noteTransaction(tx(500)); // a new hash for a finished ledger: a genuine straggler
    assert.equal(b.late, 1);
    for (let L = 501; L <= 506; L++) b.noteClose(close(L, 0), L);
    assert.equal(b.highestFinished, 506);
    assert.deepEqual(b.noteTransaction(tx(501)), []); // 506 − 4 = 502: 501 is behind the window
    assert.equal(b.stale, 1);
    assert.equal(b.open.has(501), false);
    assert.deepEqual(b.noteClose(close(507, 0), 507).map((r) => r.index), [507]); // no headerless row for 501
  });
  test('in flight: proposed transactions counted against the open ledger they were proposed in; the last fee result read while it was open', () => {
    const b = new RowBuilder();
    const inflight = (L) => ({ type: 'transaction', ledger_current_index: L, transaction: { TransactionType: 'Payment', hash: hash() } });
    assert.equal(isInFlight(inflight(400)), true);
    assert.equal(isInFlight(tx(400)), false);
    b.noteTransaction(inflight(400));
    b.noteTransaction(inflight(400));
    b.noteTransaction(inflight(401));
    b.noteFee({ ledger_current_index: 400, current_ledger_size: '50', current_queue_size: '2', expected_ledger_size: '180', drops: { open_ledger_fee: '12', median_fee: '5000' } }, { at: 9, server: 'test' });
    b.noteFee({ ledger_current_index: 400, current_ledger_size: '61', current_queue_size: '0', expected_ledger_size: '180', drops: { open_ledger_fee: '10' } }, { at: 10, server: 'test' });
    assert.deepEqual(b.inflight(400).proposed, 2);
    assert.equal(b.inflight(400).fee.currentLedgerSize, 61, 'the last read wins');
    assert.equal(b.inflight(401).fee, null);
    const [row] = b.noteClose(close(400, 0), 11);
    assert.equal(row.proposed, 2);
    assert.equal(row.fee.openLedgerFee, 10);
    assert.equal(row.fee.expectedLedgerSize, 180);
    assert.equal(row.fee.server, 'test');
  });
  test('the loop-takes and the trades of a ledger: a circular self-payment that consumed offers; trades sized by their XRP side', () => {
    const b = new RowBuilder();
    b.noteClose(close(500, 2), 1);
    // a circular self-payment: XRP in, XRP out, through a USD offer
    b.noteTransaction(tx(500, { Account: 'rLoop', Destination: 'rLoop', Amount: '2000000', SendMax: '1990000' }, [offerNode('ModifiedNode', 'rMaker', 7, iou('USD', 9), '18000000', iou('USD', 10), '20000000')], 0));
    // a token-token conversion: no XRP side to size it by
    const [row] = b.noteTransaction(tx(500, { Account: 'rX', Destination: 'rY', Amount: iou('EUR', 1), SendMax: iou('USD', 2) }, [offerNode('ModifiedNode', 'rM2', 3, { currency: 'EUR', issuer: I, value: '4' }, iou('USD', 8), { currency: 'EUR', issuer: I, value: '5' }, iou('USD', 10))], 1));
    assert.deepEqual(row.takes, [{ kind: 'self-payment', taker: 'rLoop', hash: row.takes[0].hash, offers: ['rMaker:7'] }]);
    assert.equal(row.trades.length, 1);
    assert.equal(row.trades[0].book, bookKey(`USD/${I}`, 'XRP'));
    assert.ok(Math.abs(row.trades[0].xrp - 2) < 1e-9, 'the maker received 2 XRP');
    assert.equal(row.tokenTrades, 1);
    assert.equal(tradeXrp({ asset: 'XRP', gave: 5e6, paysAsset: `USD/${I}`, got: 1 }), 5);
    assert.equal(tradeXrp({ asset: `USD/${I}`, gave: 1, paysAsset: `EUR/${I}`, got: 2 }), null);
  });
});

describe('the research switch: book_changes against the facts layer', () => {
  test('rippled names a book with XRP first, else the smaller asset string; a token as issuer/currency', () => {
    assert.deepEqual(orient(`${I}/USD`, 'XRP'), ['XRP', `${I}/USD`]);
    assert.deepEqual(orient(`${I}/USD`, `${I}/EUR`), [`${I}/EUR`, `${I}/USD`]);
    assert.equal(rippledAsset({ currency: 'XRP', issuer: null, drops: '1' }), 'XRP');
    assert.equal(rippledAsset({ currency: 'USD', code: 'USD', issuer: I, value: '1' }), `${I}/USD`);
  });
  const crossing = { tx: { TransactionType: 'OfferCreate', Account: 'rTaker', TakerGets: '1000000', TakerPays: iou('USD', 0.5), Sequence: 9 }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [offerNode('ModifiedNode', 'rMaker', 5, iou('USD', 9.5), '19000000', iou('USD', 10), '20000000')] } };
  test('the facts layer tallies a crossing as rippled would: side A the XRP volume, side B the token’s', () => {
    const { books, offers } = bookChangesFromFacts([crossing]);
    assert.equal(offers, 1);
    const e = books.get(`XRP|${I}/USD`);
    assert.deepEqual([e.volumeA, e.volumeB], ['1000000', '0.5']);
  });
  test('the cross-check matches equal volumes and reports a mismatch with why', () => {
    const method = parseBookChanges({ changes: [{ currency_a: 'XRP_drops', currency_b: `${I}/USD`, volume_a: '1000000', volume_b: '0.5', close: '2000000', open: '2000000', high: '2000000', low: '2000000' }] });
    const facts = bookChangesFromFacts([crossing]).books;
    const ok = crossCheck(method, facts);
    assert.deepEqual([ok.method, ok.facts, ok.matched, ok.mismatches.length], [1, 1, 1, 0]);
    assert.match(describeCheck(10, ok, { heard: 5, txnCount: 5 }), /^book_changes at #10: 1 books · the facts layer: 1 · 1 match · 0 mismatches$/);
    const off = parseBookChanges({ changes: [{ currency_a: 'XRP_drops', currency_b: `${I}/USD`, volume_a: '1000001', volume_b: '0.5', close: '2000002' }, { currency_a: 'XRP_drops', currency_b: `${I}/EUR`, volume_a: '5', volume_b: '1', close: '5' }] });
    const bad = crossCheck(off, facts);
    assert.equal(bad.matched, 0);
    assert.deepEqual(
      bad.mismatches.map((m) => m.why.split(' ')[0]),
      ['volumes', 'in'],
    );
    assert.match(describeCheck(11, bad, { heard: 3, txnCount: 4 }), /not cross-checked \(3 of 4 transactions heard\)/);
  });
  test('book closes: persistence and the drift after a large trade, each scored at the book’s next trade', () => {
    const bc = new BookCloses();
    const key = `XRP|${I}/USD`;
    const ch = (close) => new Map([[key, { a: 'XRP', b: `${I}/USD`, volumeA: '1', volumeB: '1', close }]]);
    bc.note(1, ch(100));
    bc.note(2, ch(101), { large: new Set([key]), driftOf: () => -0.01 });
    bc.note(3, ch(99.9));
    const s = bc.scores();
    assert.equal(s.n, 2);
    assert.ok(Math.abs(s.persistenceMae - (Math.abs(Math.log(101 / 100)) + Math.abs(Math.log(99.9 / 101))) / 2) < 1e-12, 'on the log scale');
    assert.equal(s.drift.n, 1, 'the drift forecast only after the large trade');
    assert.ok(Math.abs(s.drift.mae - Math.abs(Math.log((101 * 0.99) / 99.9))) < 1e-12);
    // two books closing in one ledger are both scored, each on its own scale
    const bc2 = new BookCloses();
    const k2 = `XRP|${I}/EUR`;
    const two = (x, y) => new Map([[key, { a: 'XRP', b: `${I}/USD`, volumeA: '1', volumeB: '1', close: x }], [k2, { a: 'XRP', b: `${I}/EUR`, volumeA: '1', volumeB: '1', close: y }]]);
    bc2.note(1, two(100, 1e7));
    bc2.note(2, two(110, 1.1e7));
    assert.equal(bc2.scores().n, 2, 'one score per book, not per ledger');
    assert.ok(Math.abs(bc2.scores().persistenceMae - Math.log(1.1)) < 1e-12, 'a 10% move scores the same at 100 drops and at ten million');
    bc.noteCheck({ method: 3, matched: 3, mismatches: [] }, { heard: 4, txnCount: 4 });
    bc.noteCheck({ method: 2, matched: 1, mismatches: [{ key, why: 'volumes 1/1 against 2/2' }] }, { heard: 4, txnCount: 4 });
    bc.noteCheck({ method: 2, matched: 2, mismatches: [] }, { heard: 3, txnCount: 4 });
    const [closes, checks] = bc.describe();
    assert.match(closes, /^book closes \(research switch\): 1 XRP books with a close · persistence's mean absolute error of log\(close\) 0\.\d{4} \(about [\d.]+%\) over 2 next trades · after a large trade, the event-study drift's skill against persistence [+-]\d\.\d\d over 1/);
    assert.match(checks, /^book_changes against the facts layer: 2 ledgers checked \(1 not, heard short\) · 5 books · 4 match · 1 mismatch \(first: XRP\|USD\.rIss…: volumes 1\/1 against 2\/2\)$/);
  });
});

// UNIVERSE phase 3A — the shared-price measure on synthetic books with known answers (docs/universe.md, Part A).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assetOf, fundedOf, constraintOf, poolConstraints, feasible, edgeOf, roomOf, nerveOf, bettiOf, describeLoop, describeNerve, sharedPriceAt, loopTakes, consumedOffers, BookState, candidatesOf, rateOf } from '../src/universe/shared-price.js';

const I = 'rIssuerAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const J = 'rIssuerBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const iou = (c, i, v) => ({ currency: c, issuer: i, value: String(v) });
const mk = (owner, seq, gets, pays, extra = {}) => ({ Account: owner, Sequence: seq, TakerGets: gets, TakerPays: pays, ...extra });
const cand = (offers, opts) => offers.map((o) => ({ id: o.Account, address: o.Account, constraints: [constraintOf(o, opts)].filter(Boolean) }));
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

describe('assets, funding and qualities', () => {
  test('an asset is XRP or currency/issuer; drops are XRP', () => {
    assert.equal(assetOf('1000000'), 'XRP');
    assert.equal(assetOf(iou('USD', I, 1)), `USD/${I}`);
    assert.equal(assetOf({ currency: 'XRP' }), 'XRP');
  });
  test('funded amounts: taker_*_funded win, else owner_funds caps TakerGets and scales TakerPays; nothing funded is null', () => {
    const o = mk('rA', 1, iou('USD', I, 100), '95000000');
    assert.deepEqual([fundedOf(o).gets.amount, fundedOf(o).pays.amount], [100, 95000000]);
    const capped = fundedOf({ ...o, owner_funds: '50' });
    assert.ok(near(capped.gets.amount, 50) && near(capped.pays.amount, 47500000));
    const partial = fundedOf({ ...o, taker_gets_funded: iou('USD', I, 10), taker_pays_funded: '9500000' });
    assert.deepEqual([partial.gets.amount, partial.pays.amount], [10, 9500000]);
    assert.equal(fundedOf({ ...o, owner_funds: '0' }), null);
    assert.equal(constraintOf({ ...o, owner_funds: '0' }), null);
  });
  test('the constraint: edge from the TakerPays asset to the TakerGets asset, weight log of the owner’s quality; fees by the engine’s rules', () => {
    const o = mk('rA', 1, iou('USD', I, 100), iou('EUR', J, 90));
    const c = constraintOf(o);
    assert.equal(c.from, `EUR/${J}`);
    assert.equal(c.to, `USD/${I}`);
    assert.ok(near(c.nominalQ, 0.9) && near(c.ownerQ, 0.9) && near(c.takerQ, 0.9) && near(c.weight, Math.log(0.9)));
    const rates = new Map([
      [I, rateOf(1020000000)], // the issuer of what the owner gives: the owner pays
      [J, rateOf(1005000000)], // the issuer of what the taker pays: the taker pays
    ]);
    const f = constraintOf(o, { rates });
    assert.ok(near(f.rateOut, 1.02) && near(f.rateIn, 1.005));
    assert.ok(near(f.ownerQ, 0.9 / 1.02), 'the owner gives TakerGets × rate');
    assert.ok(near(f.takerQ, 0.9 * 1.005), 'the taker pays TakerPays × rate');
    const x = constraintOf(mk('rA', 2, '1000000', iou('USD', I, 1)), { rates });
    assert.equal(x.rateOut, 1, 'XRP is parity');
    const own = constraintOf(o, { rates, takerIssues: (issuer) => issuer === J });
    assert.equal(own.rateIn, 1, 'a taker who issues the token it pays with pays no rate');
    assert.equal(rateOf(0), 1);
    assert.equal(rateOf(undefined), 1);
  });
  test('a pool is two constraints at the marginal qualities that cannot loop on their own', () => {
    const cs = poolConstraints({ account: 'rPool', amount: '1000000000', amount2: iou('USD', I, 500), trading_fee: 500 });
    assert.equal(cs.length, 2);
    assert.ok(cs.every((c) => c.pool && c.pool.fee === 0.005));
    assert.ok(feasible(cs).feasible);
    assert.ok(cs[0].weight + cs[1].weight > 0);
  });
});

describe('feasibility and the certificate', () => {
  test('a chain of offers has prices; XRP is the numéraire', () => {
    const f = feasible([constraintOf(mk('rA', 1, iou('USD', I, 100), '95000000')), constraintOf(mk('rB', 1, iou('EUR', J, 100), iou('USD', I, 90)))]);
    assert.equal(f.feasible, true);
    assert.equal(f.prices.get('XRP'), 0);
    assert.equal(f.prices.size, 3);
  });
  test('three makers below one: the negative cycle comes back in the taker’s order with the constructed edge', () => {
    const offers = [mk('rA', 1, iou('AAA', I, 100), iou('BBB', I, 95)), mk('rB', 1, iou('BBB', I, 100), iou('CCC', I, 95)), mk('rC', 1, iou('CCC', I, 100), iou('AAA', I, 95))];
    const f = feasible(offers.map((o) => constraintOf(o)));
    assert.equal(f.feasible, false);
    assert.equal(f.cycle.length, 3);
    for (let i = 0; i < 3; i++) assert.equal(f.cycle[i].to, f.cycle[(i + 1) % 3].from, 'each leg’s TakerGets is the next leg’s TakerPays');
    const e = edgeOf(f.cycle);
    assert.ok(near(e.afterFees, 1 / 0.95 ** 3 - 1) && near(e.nominal, e.afterFees));
    const room = roomOf(f.cycle);
    assert.ok(room > 0 && room <= 100, `room ${room}`);
  });
  test('the room through a pool is the input at which the pool’s own price impact closes the loop', () => {
    const [ab] = poolConstraints({ account: 'rPool', amount: iou('AAA', I, 10000), amount2: iou('BBB', I, 10000), trading_fee: 0 });
    const back = constraintOf(mk('rB', 1, iou('AAA', I, 1000), iou('BBB', I, 900))); // 0.9 BBB per AAA: with the pool at 1:1 the loop pays 11%
    const cycle = [ab, back];
    const e = edgeOf(cycle);
    assert.ok(e.afterFees > 0.1);
    const room = roomOf(cycle);
    // the pool's average quality (10000 + δ)/10000 · 0.9 = 1 at δ = 1111.1; the offer's own size then bounds it
    assert.ok(room > 0 && room < 1200, `room ${room}`);
  });
});

describe('the nerve and its Betti numbers', () => {
  const below = [mk('rA', 1, iou('AAA', I, 100), iou('BBB', I, 95)), mk('rB', 1, iou('BBB', I, 100), iou('CCC', I, 95)), mk('rC', 1, iou('CCC', I, 100), iou('AAA', I, 95))];
  const above = [mk('rA', 1, iou('AAA', I, 95), iou('BBB', I, 100)), mk('rB', 1, iou('BBB', I, 95), iou('CCC', I, 100)), mk('rC', 1, iou('CCC', I, 95), iou('AAA', I, 100))];
  test('qualities whose product is below one: every pair shares a price, the triple does not, β₁ = 1, the edge is the constructed value', () => {
    const n = nerveOf(cand(below));
    assert.deepEqual(n.vertices, [0, 1, 2]);
    assert.ok(n.faces.has('0,1') && n.faces.has('0,2') && n.faces.has('1,2'));
    assert.equal(n.faces.has('0,1,2'), false);
    assert.equal(n.loops.length, 1);
    assert.deepEqual(n.loops[0].members, [0, 1, 2]);
    assert.ok(near(n.loops[0].edge.afterFees, 1 / 0.95 ** 3 - 1));
    assert.deepEqual(bettiOf(n.faces), [1, 1]);
    assert.equal(n.assets, 4, 'AAA, BBB, CCC and XRP');
    assert.equal(n.bound, 5);
  });
  test('the same above one: the nerve is filled, β₁ = 0', () => {
    const n = nerveOf(cand(above));
    assert.equal(n.loops.length, 0);
    assert.ok(n.faces.has('0,1,2'));
    assert.deepEqual(bettiOf(n.faces), [1, 0, 0]);
  });
  test('a fourth maker priced with every pair: the loop stays a minimal non-face, but the cone over it fills the cycle (β worked by hand: 4 vertices, 6 edges, 3 triangles, χ = 1, β = 1, 0, 0)', () => {
    const d = mk('rD', 1, iou('AAA', I, 100), iou('BBB', I, 120)); // 1.2 BBB per AAA: loops with nobody
    const n = nerveOf(cand([...below, d]));
    assert.deepEqual(n.vertices, [0, 1, 2, 3]);
    for (const pair of ['0,1', '0,2', '0,3', '1,2', '1,3', '2,3']) assert.ok(n.faces.has(pair), pair);
    assert.equal(n.faces.has('0,1,2'), false);
    for (const tri of ['0,1,3', '0,2,3', '1,2,3']) assert.ok(n.faces.has(tri), tri);
    assert.equal(n.faces.has('0,1,2,3'), false);
    assert.equal(n.loops.length, 1);
    assert.deepEqual(n.loops[0].members, [0, 1, 2]);
    assert.deepEqual(bettiOf(n.faces), [1, 0, 0]);
  });
  test('an unfunded offer that would close a loop is excluded and counted; the nerve is filled', () => {
    const offers = [below[0], below[1], { ...below[2], owner_funds: '0' }];
    const built = candidatesOf({ focus: 'rA', focusOffers: [offers[0]], bookOffers: new Map([[[`AAA/${I}`, `BBB/${I}`].sort().join('|'), [offers[0]]], [[`BBB/${I}`, `CCC/${I}`].sort().join('|'), []]]) });
    assert.equal(built.candidates.length, 1, 'the focused account alone: its book holds no other maker');
    const n = nerveOf(cand(offers));
    assert.equal(n.loops.length, 0);
    assert.deepEqual(n.noOffers, [2], 'the unfunded candidate has no constraint: no vertex');
    assert.deepEqual(n.empty, []);
    const c = candidatesOf({ focus: 'rC', focusOffers: [offers[2]], bookOffers: new Map() });
    assert.equal(c.excluded.unfunded, 1);
  });
  test('a transfer fee that turns a nominal loop negative is not reported as a loop, and is counted as closed by fees', () => {
    const thin = [mk('rA', 1, iou('AAA', I, 100), iou('BBB', I, 99)), mk('rB', 1, iou('BBB', I, 100), iou('CCC', I, 99)), mk('rC', 1, iou('CCC', I, 100), iou('AAA', I, 99))];
    const nominal = nerveOf(cand(thin));
    assert.equal(nominal.loops.length, 1);
    assert.ok(near(nominal.loops[0].edge.nominal, 1 / 0.99 ** 3 - 1));
    const rates = new Map([[I, rateOf(1020000000)]]);
    const fees = nerveOf(cand(thin, { rates }));
    assert.equal(fees.loops.length, 0, 'the taker’s fees eat the edge');
    assert.equal(fees.closed.length, 1);
    assert.ok(fees.closed[0].edge.afterFees < 0);
  });
  test('Betti numbers over GF(2) on known complexes', () => {
    assert.deepEqual(bettiOf(new Set(['0', '1', '2', '0,1', '1,2', '0,2'])), [1, 1], 'a hollow triangle');
    assert.deepEqual(bettiOf(new Set(['0', '1', '2', '0,1', '1,2', '0,2', '0,1,2'])), [1, 0, 0], 'a filled one');
    assert.deepEqual(bettiOf(new Set(['0', '1', '2', '3', '0,1', '2,3'])), [2, 0], 'two components');
    assert.deepEqual(bettiOf(new Set()), []);
  });
  test('the words: the loop line, the nerve line and the whole readout say what they must and never the forbidden words', () => {
    const r = sharedPriceAt({ ledger: 107842000, focus: 'rA', candidates: cand(below), selection: '3 candidates (a test)' });
    const text = r.lines.join('\n');
    assert.match(text, /loop across 3 accounts · \+16\.64% after fees/);
    assert.match(text, /room /);
    assert.match(text, /ledger #107,842,000/);
    assert.match(text, /nerve: β₀ 1 · β₁ 1/);
    assert.match(text, /rippling through trust lines is out of scope/);
    assert.match(text, /measured in \d+ ms/);
    for (const w of ['arbitrage', 'inefficient', 'diverse', 'equilibrium', 'will ']) assert.doesNotMatch(text.toLowerCase(), new RegExp(w));
    assert.deepEqual(r.lit.sort(), ['rA', 'rB', 'rC']);
    const none = sharedPriceAt({ ledger: 1, focus: 'rZ', candidates: [{ id: 'rZ', address: 'rZ', constraints: [] }], selection: 's' });
    assert.match(none.lines.join('\n'), /no funded offers at this ledger: nothing lit/);
    assert.deepEqual(none.lit, []);
    assert.match(describeNerve(nerveOf(cand(above)), [1, 0, 0], 5), /β₀ 1 · β₁ 0 · β₂ 0/);
  });
});

describe('the loop-take rule and the book state', () => {
  const offerNode = (kind, owner, seq, gets, pays, prevGets) => ({ [kind]: { LedgerEntryType: 'Offer', FinalFields: { Account: owner, Sequence: seq, TakerGets: gets, TakerPays: pays }, ...(prevGets != null ? { PreviousFields: { TakerGets: prevGets } } : {}) } });
  const created = (owner, seq, gets, pays) => ({ CreatedNode: { LedgerEntryType: 'Offer', NewFields: { Account: owner, Sequence: seq, TakerGets: gets, TakerPays: pays } } });
  test('a self-payment that consumed offers is a loop-take; one that consumed nothing is not', () => {
    const txs = [
      { tx: { TransactionType: 'Payment', Account: 'rT', Destination: 'rT', Amount: iou('USD', I, 10), SendMax: iou('USD', I, 9) }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [offerNode('ModifiedNode', 'rM', 7, iou('USD', I, 90), '9000000', iou('USD', I, 100))] }, hash: 'H1', ledgerIndex: 10 },
      { tx: { TransactionType: 'Payment', Account: 'rT', Destination: 'rT', Amount: '1000000' }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [] }, hash: 'H2', ledgerIndex: 10 },
    ];
    const takes = loopTakes(txs);
    assert.equal(takes.length, 1);
    assert.equal(takes[0].kind, 'self-payment');
    assert.equal(takes[0].circular, true, 'USD sent for USD delivered: circular');
    const conversion = loopTakes([{ tx: { TransactionType: 'Payment', Account: 'rT', Destination: 'rT', Amount: iou('USD', I, 10), SendMax: '20000000' }, meta: txs[0].meta, hash: 'H9', ledgerIndex: 10 }]);
    assert.equal(conversion.length, 1);
    assert.equal(conversion[0].circular, false, 'XRP sent for USD delivered: a conversion, not a loop');
    assert.match(conversion[0].rule, /conversion/);
    assert.deepEqual(takes[0].offers.map((o) => [o.owner, o.sequence, o.gave]), [['rM', 7, 10]]);
  });
  test('a same-ledger pair: an OfferCreate by X and a cross-currency Payment by Y consuming X’s new offer', () => {
    const txs = [
      { tx: { TransactionType: 'OfferCreate', Account: 'rX' }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [created('rX', 3, iou('CUR', 'rX', 100), '50000000')] }, hash: 'H3', ledgerIndex: 11 },
      { tx: { TransactionType: 'Payment', Account: 'rY', Destination: 'rZ', Amount: iou('CUR', 'rX', 100), SendMax: '60000000' }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [offerNode('DeletedNode', 'rX', 3, iou('CUR', 'rX', 0), '0', iou('CUR', 'rX', 100))] }, hash: 'H4', ledgerIndex: 11 },
      { tx: { TransactionType: 'Payment', Account: 'rY', Destination: 'rZ', Amount: '1000000' }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [offerNode('DeletedNode', 'rX', 3, iou('CUR', 'rX', 0), '0', iou('CUR', 'rX', 100))] }, hash: 'H5', ledgerIndex: 11 },
    ];
    const takes = loopTakes(txs);
    assert.equal(takes.length, 1, 'the XRP-to-XRP payment is not cross-currency: no pair');
    assert.equal(takes[0].kind, 'pair');
    assert.equal(takes[0].maker, 'rX');
    assert.equal(takes[0].makerHash, 'H3');
    assert.equal(takes[0].taker, 'rY');
  });
  test('consumed offers: the submitter’s own offers, cleanups and cancels are not consumption', () => {
    const own = consumedOffers({ Account: 'rM' }, { AffectedNodes: [offerNode('ModifiedNode', 'rM', 1, iou('USD', I, 5), '1', iou('USD', I, 9))] });
    assert.equal(own.length, 0);
    const cleanup = consumedOffers({ Account: 'rT' }, { AffectedNodes: [{ DeletedNode: { LedgerEntryType: 'Offer', FinalFields: { Account: 'rM', Sequence: 1, TakerGets: iou('USD', I, 5), TakerPays: '1' } } }] });
    assert.equal(cleanup.length, 0);
  });
  test('the book state of a replay: created, modified and deleted offers; an offer first seen modified is flagged unseen', () => {
    const s = new BookState();
    s.apply({ TransactionType: 'OfferCreate' }, { TransactionResult: 'tesSUCCESS', AffectedNodes: [created('rA', 1, iou('USD', I, 100), '95000000')] }, 100);
    s.apply({ TransactionType: 'Payment' }, { TransactionResult: 'tesSUCCESS', AffectedNodes: [offerNode('ModifiedNode', 'rA', 1, iou('USD', I, 60), '57000000', iou('USD', I, 100)), offerNode('ModifiedNode', 'rB', 9, iou('EUR', J, 10), '12000000', iou('EUR', J, 20))] }, 101);
    assert.equal(s.offers.size, 2);
    assert.equal(s.offers.get('rA:1').TakerGets.value, '60');
    assert.equal(s.offers.get('rB:9').unseenCreation, true);
    assert.equal(s.unseenCreations, 1);
    assert.equal(s.ofAccount('rA').length, 1);
    assert.equal(s.onBook(`USD/${I}`, 'XRP').length, 1);
    const snap = s.snapshot();
    s.apply({ TransactionType: 'OfferCancel' }, { TransactionResult: 'tesSUCCESS', AffectedNodes: [offerNode('DeletedNode', 'rA', 1, iou('USD', I, 60), '57000000')] }, 102);
    assert.equal(s.offers.size, 1);
    assert.equal(snap.offers.size, 2, 'the snapshot kept the earlier state');
    s.apply({}, { TransactionResult: 'tecUNFUNDED', AffectedNodes: [created('rC', 1, iou('USD', I, 1), '1')] }, 103);
    assert.equal(s.offers.size, 1, 'a failed transaction changes nothing');
  });
  test('the candidates: the focused account, the busiest makers per book by funded size, the cap and the selection sentence', () => {
    const focusOffers = [mk('rF', 1, iou('USD', I, 100), '95000000')];
    const book = [`USD/${I}`, 'XRP'].sort().join('|');
    const makers = [];
    for (let i = 0; i < 6; i++) makers.push(mk(`rM${i}`, 1, iou('USD', I, 10 * (i + 1)), String(9500000 * (i + 1))));
    const built = candidatesOf({ focus: 'rF', focusOffers, bookOffers: new Map([[book, makers]]), makersPerBook: 3, cap: 10 });
    assert.deepEqual(built.candidates.map((c) => c.id), ['rF', 'rM5', 'rM4', 'rM3']);
    assert.match(built.selection, /^4 candidates: the probed account and the 3 largest makers by funded size on each of its 1 book \(cap 10\)$/);
    const capped = candidatesOf({ focus: 'rF', focusOffers, bookOffers: new Map([[book, makers]]), makersPerBook: 6, cap: 3 });
    assert.equal(capped.candidates.length, 3);
    assert.equal(capped.excluded['beyond the cap'], 4);
    const frozen = candidatesOf({ focus: 'rF', focusOffers, bookOffers: new Map([[book, makers]]), frozen: new Set(['rM5:1']) });
    assert.equal(frozen.excluded['on frozen lines'], 1);
  });
});

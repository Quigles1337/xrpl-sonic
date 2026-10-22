// The record check behind coherence (src/record.js): touch records from real
// validated transactions, and the connections between two accounts counted
// from them, with the hashes.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { touchOf, touchesOfLedger, touchesOfEntries, touchKind, connections, describeConnections, connectionLines, TOUCH_KINDS } from '../src/record.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8'));
const result = (name) => fixture(name).result;

// real mainnet records
const xrpPayment = result('explorer/payment-xrp'); // rnh6…71mV → raEH…Uo7A, creates the destination
const consumed = result('facts/fully-consumed'); // an OfferCreate by rnCE…vGF7 that crossed three book offers
const crossing = result('facts/payment-crossing'); // a Payment to self that crossed offers and moved trust lines
const failed = result('explorer/failed'); // a tecPATH_DRY payment to self

describe('touch records', () => {
  test('a payment: the submitter, the Destination, the AccountRoots touched, no offers', () => {
    const t = touchOf(xrpPayment, xrpPayment.meta);
    assert.equal(t.submitter, xrpPayment.Account);
    assert.equal(t.destination, xrpPayment.Destination);
    assert.deepEqual(t.entries, [xrpPayment.Account, xrpPayment.Destination], 'both AccountRoots are in the record');
    assert.deepEqual(t.lines, []);
    assert.deepEqual(t.crossed, []);
    assert.equal(t.success, true);
    assert.equal(t.hash, xrpPayment.hash);
    assert.equal(t.ledgerIndex, xrpPayment.ledger_index);
  });

  test('an OfferCreate that crossed the book: the crossed offers’ owners come from Part A, the trust lines are told apart', () => {
    const t = touchOf(consumed, consumed.meta);
    assert.equal(t.submitter, consumed.Account);
    assert.equal(t.destination, null);
    const owners = consumed.meta.AffectedNodes.map((n) => Object.values(n)[0]).filter((e) => e.LedgerEntryType === 'Offer').map((e) => e.FinalFields.Account);
    assert.deepEqual([...t.crossed].sort(), [...new Set(owners)].sort(), 'every traded book offer’s owner is crossed');
    assert.ok(owners.every((o) => t.entries.includes(o)), 'their Offer entries are in the AffectedNodes too');
    assert.ok(t.lines.length >= 2, 'the trust lines that moved name both sides');
    assert.ok(!t.crossed.includes(consumed.Account));
  });

  test('a payment that crossed offers on the way: owners via the Payment’s Part A facts', () => {
    const t = touchOf(crossing, crossing.meta);
    assert.equal(t.destination, crossing.Account, 'a payment to self names itself');
    assert.ok(t.crossed.length >= 2, `crossed ${t.crossed.join(', ')}`);
    assert.ok(t.lines.length >= 3);
  });

  test('a failed transaction is recorded as such; a non-transaction is null', () => {
    const t = touchOf(failed, failed.meta);
    assert.equal(t.success, false);
    assert.equal(t.submitter, failed.Account);
    assert.equal(touchOf(null, null), null);
    assert.equal(touchOf({ Account: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp' }, null), null, 'no TransactionType, no record');
    const bare = touchOf({ TransactionType: 'Payment', Account: xrpPayment.Account, Destination: xrpPayment.Destination }, null, { hash: 'ab'.repeat(32), ledgerIndex: 5 });
    assert.deepEqual(bare, { hash: 'AB'.repeat(32), ledgerIndex: 5, submitter: xrpPayment.Account, destination: xrpPayment.Destination, entries: [], lines: [], crossed: [], success: false });
  });

  test('from a fetched ledger and from account_tx entries, once per hash', () => {
    const ledger = { ledger_index: 107777809, transactions: [{ ...xrpPayment, metaData: xrpPayment.meta }, { ...consumed, metaData: consumed.meta }] };
    const fromLedger = touchesOfLedger(ledger);
    assert.deepEqual(fromLedger.map((t) => [t.hash, t.ledgerIndex]), [[xrpPayment.hash, 107777809], [consumed.hash, 107777809]]);
    const entries = [{ tx: xrpPayment, meta: xrpPayment.meta, validated: true }, { tx_json: consumed, meta: consumed.meta, hash: consumed.hash, ledger_index: consumed.ledger_index }, { tx: xrpPayment, meta: xrpPayment.meta }];
    const fromEntries = touchesOfEntries(entries);
    assert.deepEqual(fromEntries.map((t) => t.hash), [xrpPayment.hash, consumed.hash], 'v1 and v2 shapes, duplicates dropped');
    assert.equal(fromEntries[1].ledgerIndex, consumed.ledger_index);
  });
});

describe('connections', () => {
  const A = xrpPayment.Account;
  const B = xrpPayment.Destination;
  const maker = consumed.meta.AffectedNodes.map((n) => Object.values(n)[0]).find((e) => e.LedgerEntryType === 'Offer').FinalFields.Account;
  const taker = consumed.Account;
  const touches = [touchOf(xrpPayment, xrpPayment.meta), touchOf(consumed, consumed.meta), touchOf(crossing, crossing.meta), touchOf(failed, failed.meta)];

  test('kinds, strongest first: destination over crossed over entry over line', () => {
    assert.deepEqual(TOUCH_KINDS, ['destination', 'crossed', 'entry', 'line']);
    assert.equal(touchKind(touches[0], A, B), 'destination');
    assert.equal(touchKind(touches[0], B, A), null, 'B did not submit it');
    assert.equal(touchKind(touches[1], taker, maker), 'crossed');
    assert.equal(touchKind(touches[1], maker, taker), null);
    const lineSide = touches[1].lines.find((l) => !touches[1].crossed.includes(l) && !touches[1].entries.includes(l));
    if (lineSide) assert.equal(touchKind(touches[1], taker, lineSide), 'line');
    assert.equal(touchKind(touches[0], A, A), null, 'an account does not connect to itself');
  });

  test('a pair’s connections: counted once per hash, by the strongest kind, with the failed ones noted', () => {
    const c = connections(touches, A, B);
    assert.equal(c.count, 1);
    assert.deepEqual(c.byKind, { destination: 1, crossed: 0, entry: 0, line: 0 });
    assert.deepEqual(c.transactions, [{ hash: xrpPayment.hash, ledgerIndex: xrpPayment.ledger_index, by: A, kind: 'destination', success: true }]);
    assert.equal(describeConnections(c), 'connected in the record: 1 transaction (1 destination)');
    const both = connections([...touches, touches[0]], B, A);
    assert.equal(both.count, 1, 'the same hash twice counts once, and the order of the pair does not matter');
    const crossedPair = connections(touches, maker, taker);
    assert.equal(crossedPair.count, 1);
    assert.equal(crossedPair.byKind.crossed, 1);
    assert.equal(crossedPair.transactions[0].by, taker);
    const none = connections(touches, A, taker);
    assert.equal(none.count, 0);
    assert.equal(describeConnections(none), 'not connected in this window');
    assert.equal(describeConnections(null), 'record not available');
    const self = connections([touches[3]], failed.Account, failed.Account);
    assert.equal(self.count, 0, 'a payment to self is no connection between two accounts');
  });

  test('the hashes, with ledger, submitter and kind, capped with "and N more"', () => {
    const c = connections(touches, A, B);
    const lines = connectionLines(c, (x) => (x === A ? 'Payer' : x));
    assert.deepEqual(lines, [`record: ${xrpPayment.hash} (#${xrpPayment.ledger_index}, by Payer: the other is the Destination)`]);
    const many = { count: 3, failed: 1, byKind: { destination: 3 }, transactions: [1, 2, 3].map((i) => ({ hash: String(i).repeat(64), ledgerIndex: 100 + i, by: A, kind: 'destination', success: i !== 2 })) };
    const capped = connectionLines(many, (x) => x, { max: 2 });
    assert.equal(capped.length, 1);
    assert.match(capped[0], /^record: 1{64} \(#101, by r\S+: the other is the Destination\); 2{64} \(#102, by r\S+: the other is the Destination, failed\); and 1 more$/);
    assert.equal(describeConnections(many), 'connected in the record: 3 transactions (3 destination; 1 failed)');
    assert.deepEqual(connectionLines({ count: 0, transactions: [] }), []);
  });
});

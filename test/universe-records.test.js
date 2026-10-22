// UNIVERSE spike: compact records and the three metadata readers, on real
// validated transactions (the explorer's and the facts layer's fixtures).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Interner, compactRecord, recordBytes, rootsOf, linesOf, issuerOfLine, offersOf, touchedBy, TYPE_CODES, CATEGORY_CODES } from '../src/universe/records.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const result = (name) => JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8')).result;

const payment = result('explorer/payment-xrp'); // creates the destination
const consumed = result('facts/fully-consumed'); // an OfferCreate that crossed three book offers
const crossing = result('facts/payment-crossing'); // a payment through offers and trust lines
const ammFill = result('facts/amm-fill'); // an OfferCreate filled by an AMM pool

describe('compact records', () => {
  test('a payment: type, category, both parties, the destination as a touched entry, birth', () => {
    const rec = compactRecord(payment, payment.meta, { hash: payment.hash, ledgerIndex: payment.ledger_index });
    assert.equal(rec.type, TYPE_CODES.Payment);
    assert.equal(rec.category, CATEGORY_CODES.payment);
    assert.equal(rec.success, true);
    assert.equal(rec.account, payment.Account);
    assert.equal(rec.destination, payment.Destination);
    assert.deepEqual(rec.entries, [payment.Destination], 'the submitter is left out of the touched entries');
    assert.equal(rec.created, true, 'the destination AccountRoot was created');
    assert.equal(rec.xrp, true);
    assert.ok(rec.log != null);
    assert.equal(rec.hash, payment.hash.toUpperCase());
    assert.equal(rec.ledger, payment.ledger_index);
  });

  test('an interner gives the same id to the same address and ids start at 1', () => {
    const it = new Interner();
    const a = it.id(payment.Account);
    const b = it.id(payment.Destination);
    assert.equal(a, 1);
    assert.equal(b, 2);
    assert.equal(it.id(payment.Account), 1);
    assert.equal(it.id(null), 0);
    assert.equal(it.string(2), payment.Destination);
    assert.equal(it.size, 2);
    const rec = compactRecord(payment, payment.meta, { interner: it, currencies: new Interner() });
    assert.equal(rec.account, 1);
    assert.equal(rec.destination, 2);
    assert.equal(rec.currency, 1, 'currencies have their own interner');
  });

  test('a crossing offer: the book owners are touched entries, the trust lines are told apart', () => {
    const rec = compactRecord(consumed, consumed.meta, { hash: consumed.hash });
    const owners = new Set(consumed.meta.AffectedNodes.map((n) => Object.values(n)[0]).filter((e) => e.LedgerEntryType === 'Offer').map((e) => e.FinalFields.Account));
    for (const o of owners) assert.ok(rec.entries.includes(o), `${o} crossed`);
    assert.ok(rec.lines.length >= 2);
    assert.ok(!rec.entries.includes(consumed.Account));
    assert.ok(!rec.lines.includes(consumed.Account));
    assert.equal(touchedBy(consumed.meta, consumed.Account).entries.length, rec.entries.length);
  });

  test('bytes: a payment is under 100 bytes, a busy record grows by 4 per touched id', () => {
    const p = compactRecord(payment, payment.meta);
    const c = compactRecord(consumed, consumed.meta);
    assert.ok(recordBytes(p) < 100, `${recordBytes(p)}`);
    assert.equal(recordBytes(c) - recordBytes(p), 4 * (c.entries.length + c.lines.length - p.entries.length - p.lines.length));
  });
});

describe('the metadata readers', () => {
  test('rootsOf: every AccountRoot with balance, flags, key and AMMID; the pool carries its AMMID', () => {
    const roots = rootsOf(ammFill.meta);
    assert.ok(roots.length >= 2);
    const pool = roots.find((r) => r.ammId);
    assert.ok(pool, 'one root is the pool');
    assert.ok(pool.flags & 0x00100000, 'a pseudo-account has its master key disabled');
    assert.equal(pool.regularKey, null, 'and no regular key in its final fields');
    for (const r of roots) {
      assert.match(r.address, /^r/);
      assert.ok(r.balance == null || Number.isFinite(r.balance));
      assert.ok(['created', 'modified', 'deleted'].includes(r.action));
    }
    const birth = rootsOf(payment.meta).find((r) => r.action === 'created');
    assert.equal(birth?.address, payment.Destination);
  });

  test('linesOf and issuerOfLine: the balance sign names the issuer; both sides are addresses', () => {
    const lines = linesOf(crossing.meta);
    assert.ok(lines.length >= 3);
    for (const line of lines) {
      assert.match(line.low, /^r/);
      assert.match(line.high, /^r/);
      const side = issuerOfLine(line);
      if (line.balance > 0) assert.deepEqual([side.issuer, side.holder], [line.high, line.low]);
      if (line.balance < 0) assert.deepEqual([side.issuer, side.holder], [line.low, line.high]);
    }
    // the zero-balance rules
    assert.deepEqual(issuerOfLine({ low: 'rL', high: 'rH', balance: 0, lowLimit: 100, highLimit: 0 }), { issuer: 'rH', holder: 'rL', tier: 'rule', rule: 'line.issuer.limit' });
    assert.deepEqual(issuerOfLine({ low: 'rL', high: 'rH', balance: 0, lowLimit: 0, highLimit: 5 }), { issuer: 'rL', holder: 'rH', tier: 'rule', rule: 'line.issuer.limit' });
    assert.equal(issuerOfLine({ low: 'rL', high: 'rH', balance: 0, lowLimit: 1, highLimit: 1 }), null, 'both limits at zero balance: unresolved');
    assert.equal(issuerOfLine({ low: 'rL', high: 'rH', balance: 0, lowLimit: 0, highLimit: 0 }), null);
  });

  test('offersOf: the crossed offers were deleted, by their owners', () => {
    const offers = offersOf(consumed.meta);
    assert.ok(offers.some((o) => o.action === 'deleted'));
    for (const o of offers) assert.match(o.owner, /^r/);
  });
});

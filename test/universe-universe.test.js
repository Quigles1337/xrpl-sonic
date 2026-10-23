// UNIVERSE spike: the observed universe. Coverage counts only what was heard
// against txn_count, the stream's disorder is kept, and the bodies come out
// of real records.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Universe, coverageLine } from '../src/universe/universe.js';
import { bodyOf } from '../src/universe/bodies.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8'));
const result = (name) => fixture(name).result;

// a recorded ledgerClosed and two recorded transaction messages of the same ledger (as test/moment.test.js uses them)
const closed = fixture('ledger-closed');
const LIVE = Number(closed.ledger_index);
const txA = fixture('payment-failed');
const txB = fixture('payment-delivermax-unavailable');
const closedAt = (index, txn_count = closed.txn_count) => ({ ...closed, ledger_index: index, txn_count });
const asMsg = (r) => ({ type: 'transaction', transaction: r, meta: r.meta, hash: r.hash, ledger_index: r.ledger_index, engine_result: r.meta.TransactionResult, validated: true });

describe('the observed universe', () => {
  test('coverage: what was heard against txn_count, closed ledgers only, provisional ones counted apart', () => {
    const u = new Universe();
    assert.equal(u.noteTransaction(txA)?.ledger, LIVE, 'a transaction before its close is kept against its own ledger index');
    assert.equal(u.noteTransaction(txA), null, 'heard twice counts once');
    assert.equal(u.counts.dupes, 1);
    let c = u.coverage();
    assert.equal(c.ledgersClosed, 0);
    assert.equal(c.provisional, 1);
    u.noteLedger(closedAt(LIVE));
    u.noteTransaction(txB);
    c = u.coverage();
    assert.equal(c.ledgersClosed, 1);
    assert.equal(c.expected, closed.txn_count);
    assert.equal(c.received, 2);
    assert.equal(c.provisional, 0);
    assert.equal(c.transactions, 2);
    assert.equal(c.failed, 1, 'the tecPATH_DRY payment');
    assert.ok(c.planets >= 1);
    const line = coverageLine(c, { host: 'xrplcluster.com' });
    assert.match(line, /^Observed /);
    assert.match(line, new RegExp(`1 ledgers \\(#${LIVE.toLocaleString('en-US').replace(/,/g, ',')}\\)`));
    assert.match(line, new RegExp(`2 of ${closed.txn_count} transactions`));
    assert.match(line, /xrplcluster\.com\. This is what the page has heard, not the ledger\.$/);
  });

  test('the coverage line never claims the ledger: before data, when disconnected, and for a synthetic sky', () => {
    const u = new Universe();
    assert.match(coverageLine(u.coverage(), { host: 's1.ripple.com', state: 'connected' }), /^Observed nothing yet/);
    assert.match(coverageLine(u.coverage(), { host: 's1.ripple.com', state: 'reconnecting' }), /^Not connected/);
    assert.match(coverageLine({ planets: 12, transactions: 40 }, { synthetic: true }), /^Synthetic sky: 12 planets and 40 made-up transactions.*Nothing here is the ledger\.$/);
    u.noteLedger(closedAt(LIVE, null));
    assert.match(coverageLine(u.coverage()), /txn_count unknown/);
  });

  test('planets and edges from a real record: both parties, the touched owners, the trust-line sides; the issuer’s holders', () => {
    const u = new Universe();
    const crossing = result('facts/payment-crossing');
    const r = u.noteTransaction(asMsg(crossing));
    assert.ok(r);
    assert.ok(r.newPlanets.length >= 3);
    assert.equal(r.touched.length, r.newPlanets.length, 'every planet touched by the first record is new');
    const sender = u.planet(crossing.Account);
    assert.equal(sender.submitted, 1);
    assert.equal(sender.involved, 1);
    assert.equal(sender.sentPayments, 1, 'a payment to self: sent and received');
    assert.equal(sender.receivedPayments, 1);
    assert.ok(sender.balanceDrops > 0, 'the submitter’s root carries its balance');
    for (const e of r.edges) {
      assert.ok(e);
      assert.ok([e.a, e.b].includes(sender.id));
      assert.equal(u.edge(e.a, e.b), e);
    }
    const issuers = [...u.planets].filter((p) => p?.holders?.size);
    assert.ok(issuers.length >= 1, 'a RippleState names an issuer');
    for (const iss of issuers) for (const h of iss.holders) assert.ok(u.planets[h].issuers.has(iss.id), 'holder and issuer agree');
    assert.ok(sender.degree >= r.edges.length);
  });

  test('bodies earned from the fixtures: the AMM pool is a binary star, a well-held issuer a star', () => {
    const u = new Universe();
    for (const name of ['facts/amm-fill', 'facts/fully-consumed', 'facts/payment-crossing', 'facts/tfsell-sweep']) u.noteTransaction(asMsg(result(name)));
    const kinds = {};
    for (const p of u.planets) if (p) kinds[bodyOf(p, { ledger: u.currentLedger }).kind] = (kinds[bodyOf(p, { ledger: u.currentLedger }).kind] ?? 0) + 1;
    assert.equal(kinds.binary, 1);
    assert.ok(kinds.star >= 1);
    assert.ok(kinds.planet >= 10);
    assert.equal(kinds.blackhole, undefined, 'the pool’s disabled master is not a black hole');
    const pool = [...u.planets].find((p) => p?.ammId);
    assert.ok(pool.providers == null || pool.providers.size === 0, 'an OfferCreate is a fill, not a deposit');
  });

  test('a ledger that jumps backwards is still recorded; the current ledger is the highest seen', () => {
    const u = new Universe();
    u.noteLedger(closedAt(LIVE + 5));
    u.noteLedger(closedAt(LIVE + 2));
    assert.equal(u.currentLedger, LIVE + 5);
    assert.equal(u.coverage().ledgersClosed, 2);
  });
});

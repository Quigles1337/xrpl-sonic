// The facts layer, proven by real validated transactions. Every file in
// test/fixtures/facts/ is a `tx` response stored verbatim; beside it, an
// `.expected.json` states the findings the record must yield (derived with
// exact decimal arithmetic, independently of the implementation) and the
// headline the explorer must render from them.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { facts, TIERS, RULES, FLAG_NAMES } from '../src/explorer/facts.js';
import { summarize, explain, describeAffected, balanceChanges } from '../src/explorer/anatomy.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'facts');
const cases = readdirSync(dir)
  .filter((f) => f.endsWith('.expected.json'))
  .map((f) => {
    const expected = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const response = JSON.parse(readFileSync(join(dir, expected.source.file), 'utf8'));
    return { name: f.replace('.expected.json', ''), expected, tx: response.result, meta: response.result.meta };
  });

/** Every key in `expected` must match in `actual`; arrays named `rules` are inclusion, other arrays exact. */
function matchSubset(actual, expected, path) {
  if (expected === null || typeof expected !== 'object') {
    assert.deepEqual(actual, expected, path);
    return;
  }
  if (Array.isArray(expected)) {
    if (path.endsWith('.rules')) {
      assert.ok(Array.isArray(actual), `${path}: expected rules, got ${JSON.stringify(actual)}`);
      for (const r of expected) assert.ok(actual.includes(r), `${path}: missing rule ${r} in [${actual.join(', ')}]`);
    } else assert.deepEqual(actual, expected, path);
    return;
  }
  assert.ok(actual && typeof actual === 'object', `${path}: expected an object, got ${JSON.stringify(actual)}`);
  for (const [k, v] of Object.entries(expected)) matchSubset(actual[k], v, `${path}.${k}`);
}

describe('facts from real transactions', () => {
  assert.ok(cases.length >= 17, `expected at least 17 fixtures, found ${cases.length}`);

  for (const c of cases) {
    test(`${c.name}: ${c.expected.case}`, () => {
      assert.equal(c.tx.hash, c.expected.hash, 'the fixture is the transaction the expectation names');
      assert.equal(c.tx.ledger_index, c.expected.ledgerIndex);
      const f = facts(c.tx, c.meta, { network: c.expected.network, closeTime: c.tx.date });
      assert.equal(f.version, 1);
      assert.equal(f.hash, c.expected.hash);
      assert.equal(f.ledgerIndex, c.expected.ledgerIndex);
      assert.equal(f.network, c.expected.network);
      matchSubset(f.transaction, c.expected.expect.transaction, 'transaction');

      // offers, by AffectedNodes index
      const expectedOffers = c.expected.expect.offers ?? {};
      assert.equal(f.offers.length, Object.keys(expectedOffers).length, `offer count (${f.offers.map((o) => o.node).join(',')})`);
      for (const [n, eo] of Object.entries(expectedOffers)) {
        const actual = f.offers.find((o) => o.node === Number(n));
        assert.ok(actual, `offer node ${n} present`);
        matchSubset(actual, eo, `offers[${n}]`);
      }

      // the exchange
      if (c.expected.expect.exchange === null) assert.equal(f.exchange, null);
      else matchSubset(f.exchange, c.expected.expect.exchange, 'exchange');

      // balances: exact strings, every expected change present and no more
      if (c.expected.expect.balances) {
        const bals = balanceChanges(c.meta);
        assert.equal(bals.length, c.expected.expect.balances.length, 'balance change count');
        for (const eb of c.expected.expect.balances) {
          const b = bals.find((x) => x.account === eb.account && x.currency === eb.currency && x.issuer === eb.issuer && x.node === eb.node);
          assert.ok(b, `balance change for ${eb.account} ${eb.currency} from node ${eb.node}`);
          assert.deepEqual(b.exact, eb.exact, `exact balance strings for ${eb.account} ${eb.currency}`);
          assert.equal(typeof b.delta, 'number', 'the rounded number stays for the display layer');
        }
        assert.deepEqual(f.balances.map((b) => b.exact), bals.map((b) => b.exact), 'facts carry the same exact balances');
      }

      // every finding is typed and traceable
      assert.ok(f.findings.length > 0);
      for (const x of f.findings) {
        assert.ok(TIERS.includes(x.tier), `${x.rule}: tier ${x.tier}`);
        assert.ok(RULES[x.rule], `${x.rule} is a documented rule`);
        assert.equal(RULES[x.rule].tier, x.tier, `${x.rule} carries its documented tier`);
        assert.ok(typeof x.id === 'string' && x.id, 'finding id');
        assert.ok(typeof x.subject === 'string' && x.subject, 'finding subject');
        assert.ok(typeof x.property === 'string' && x.property, 'finding property');
        assert.ok(Array.isArray(x.evidence), 'evidence list');
        for (const e of x.evidence) {
          if (e.node != null) assert.ok(Number.isInteger(e.node) && e.node >= 0 && e.node < c.meta.AffectedNodes.length, `${x.rule}: evidence node ${e.node} exists`);
          assert.ok(typeof e.field === 'string', `${x.rule}: evidence names a field`);
        }
        if (x.tier === 'hypothesis') assert.ok(x.note, `${x.rule}: a hypothesis says what would settle it`);
        assert.ok(!JSON.stringify(x.value).includes('e+') && !JSON.stringify(x.value).includes('E+'), `${x.rule}: values are plain decimal strings`);
      }
      const ids = f.findings.map((x) => x.id);
      assert.equal(new Set(ids).size, ids.length, 'finding ids are unique');

      // the sentences rendered from the findings
      assert.equal(summarize(c.tx, c.meta), c.expected.expect.headline);
      const ex = explain(c.tx, c.meta);
      assert.equal(ex.text, c.expected.expect.headline);
      assert.ok(ex.sentences.length >= 1);
      const known = new Set(ids);
      for (const s of ex.sentences) {
        assert.ok(typeof s.text === 'string' && s.text, 'sentence text');
        assert.ok(Array.isArray(s.rules) && s.rules.length > 0, `sentence "${s.text}" keeps its rule ids`);
        for (const r of s.rules) assert.ok(RULES[r], `sentence rule ${r} is documented`);
        for (const id of s.findings ?? []) assert.ok(known.has(id), `sentence finding ${id} exists`);
      }
      const { entries } = describeAffected(c.meta, c.tx);
      for (const e of entries) {
        assert.ok(Array.isArray(e.rules) && e.rules.length > 0, `entry "${e.summary}" keeps its rule ids`);
        for (const r of e.rules) assert.ok(RULES[r], `entry rule ${r} is documented`);
      }
    });
  }

  test('flag names are read per transaction type; 0x00020000 is partial payment on a Payment and immediate-or-cancel on an OfferCreate', () => {
    assert.deepEqual(FLAG_NAMES.Payment[0x00020000], 'tfPartialPayment');
    assert.deepEqual(FLAG_NAMES.OfferCreate[0x00020000], 'tfImmediateOrCancel');
    const f = facts({ TransactionType: 'Payment', Account: 'rrrrrrrrrrrrrrrrrrrrBZbvji', Flags: 0x40020000, Fee: '0' }, { AffectedNodes: [], TransactionResult: 'tesSUCCESS' });
    assert.deepEqual(f.transaction.flags, ['tfInnerBatchTxn', 'tfPartialPayment']);
  });

  test('unresolved is a legal value: a deleted offer with a one-sided PreviousFields is not interpreted', () => {
    // No real record in a 300-ledger scan had a one-sided PreviousFields (10,421 Offer nodes); this
    // shape is synthetic to pin the behaviour, and is the only hand-written metadata in these tests.
    const meta = {
      TransactionResult: 'tesSUCCESS',
      AffectedNodes: [{ DeletedNode: { LedgerEntryType: 'Offer', LedgerIndex: 'AB', FinalFields: { Account: 'rOwner', Sequence: 5, TakerGets: '0', TakerPays: { currency: 'USD', issuer: 'rIss', value: '0' }, Flags: 0 }, PreviousFields: { TakerGets: '100' } } }],
    };
    const f = facts({ TransactionType: 'OfferCreate', Account: 'rTaker', Fee: '10', Flags: 0, TakerGets: '1', TakerPays: { currency: 'USD', issuer: 'rIss', value: '1' } }, meta);
    assert.equal(f.offers[0].traded, 'unresolved');
    assert.equal(f.offers[0].removal, 'unresolved');
    assert.equal(f.exchange.fill.status, 'unresolved');
    const removal = f.findings.find((x) => x.subject === 'offer:0' && x.property === 'removal');
    assert.equal(removal.rule, 'offer.removal.unresolved');
  });

  test('missing input is tolerated', () => {
    assert.equal(facts(null, null).findings.length, 0);
    const f = facts({ TransactionType: 'AccountSet', Account: 'rrrrrrrrrrrrrrrrrrrrBZbvji', Fee: '12' }, null);
    assert.equal(f.exchange, null);
    assert.deepEqual(f.offers, []);
  });
});

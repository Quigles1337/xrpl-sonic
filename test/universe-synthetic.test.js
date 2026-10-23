// UNIVERSE spike: the synthetic stream is deterministic and stream-shaped,
// so a measurement can be repeated and the page's pipeline is exercised as
// the live one is.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SyntheticStream, fakeAddress, seeded } from '../src/universe/synthetic.js';
import { unwrapTransactionMessage, isValidAddress, classifyMessage } from '../src/mapping.js';
import { Universe } from '../src/universe/universe.js';

describe('synthetic stream', () => {
  test('addresses are well-formed and a seed repeats itself', () => {
    const r1 = seeded(7);
    const r2 = seeded(7);
    for (let i = 0; i < 5; i++) assert.ok(isValidAddress(fakeAddress(r1)));
    assert.equal(fakeAddress(seeded(7)), fakeAddress(seeded(7)));
    assert.notEqual(fakeAddress(seeded(7)), fakeAddress(seeded(8)));
    const a = new SyntheticStream({ planets: 50, seed: 3 }).nextLedger();
    const b = new SyntheticStream({ planets: 50, seed: 3 }).nextLedger();
    assert.deepEqual(a, b);
    assert.equal(seeded(1)(), seeded(1)());
    void r2;
  });

  test('every ledger has stream-shaped transactions and a close whose txn_count is their number', () => {
    const s = new SyntheticStream({ planets: 200, seed: 11, perLedger: 20 });
    const u = new Universe();
    let ledgers = 0;
    while (s.accounts.length < 200 || ledgers < 5) {
      const msgs = s.nextLedger();
      const close = msgs.at(-1);
      assert.equal(classifyMessage(close), 'ledger');
      assert.equal(close.txn_count, msgs.length - 1);
      for (const m of msgs.slice(0, -1)) {
        assert.equal(classifyMessage(m), 'transaction');
        const un = unwrapTransactionMessage(m);
        assert.ok(un && un.tx.TransactionType === 'Payment');
        assert.ok(isValidAddress(un.tx.Account) && isValidAddress(un.tx.Destination));
        assert.notEqual(un.tx.Account, un.tx.Destination);
        u.noteTransaction(m);
      }
      u.noteLedger(close);
      ledgers += 1;
    }
    assert.equal(u.planetCount, 200);
    const c = u.coverage();
    assert.equal(c.share, 1, 'the synthetic stream is complete by construction');
    assert.ok(c.edges > 100);
  });
});

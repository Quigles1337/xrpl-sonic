// UNIVERSE spike: the body rules. Every body is earned by a property of the
// record, and the precedence between rules is fixed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { bodyOf, cometOf, describeBody, sizeFromBalance, hueOf, glowOf, BLACKHOLE_KEYS, LSF, STAR_HOLDERS, KINDS } from '../src/universe/bodies.js';
import { TYPE_CODES, CATEGORY_CODES } from '../src/universe/records.js';
import { sigilPattern } from '../src/explorer/sigil.js';

const ADDRESS = 'rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah';
const planet = (over = {}) => ({ id: 1, address: ADDRESS, firstLedger: 100, lastLedger: 110, ledgersSeen: 3, submitted: 2, involved: 5, byCategory: [3, 2, 0, 0, 0, 0, 0, 0], activity: 2, balanceDrops: 12948919267, flags: 0, ownerCount: 38, regularKey: null, domain: null, ammId: null, created: false, deleted: false, holders: null, issuers: null, peers: null, fundedLines: 0, providers: null, openOffers: 0, minted: 0, degree: 2, cadence: null, ...over });

describe('bodies', () => {
  test('a planet is observed: the account appeared in the record; size from the balance, hue from the sigil', () => {
    const b = bodyOf(planet());
    assert.equal(b.kind, 'planet');
    assert.equal(b.tier, 'observed');
    assert.equal(b.sizeKnown, true);
    assert.equal(b.hue, sigilPattern(ADDRESS).hue, 'the same hue as the explorer’s sigil');
    assert.equal(hueOf(ADDRESS), b.hue);
    assert.ok(b.size > 1);
  });

  test('size grows with the log of the balance; unknown is small and hollow', () => {
    const one = sizeFromBalance(1e6);
    const million = sizeFromBalance(1e12);
    assert.ok(million.size > one.size);
    assert.ok(million.size < 5);
    assert.deepEqual(sizeFromBalance(null), { size: 0.9, known: false });
    assert.equal(bodyOf(planet({ balanceDrops: null })).sizeKnown, false);
  });

  test('a black hole is a hypothesis: master disabled and an unusable or absent key; a usable key is a planet', () => {
    for (const key of BLACKHOLE_KEYS) {
      const b = bodyOf(planet({ flags: LSF.disableMaster, regularKey: key }));
      assert.equal(b.kind, 'blackhole');
      assert.equal(b.tier, 'hypothesis');
      assert.equal(b.rule, 'blackhole.candidate');
      assert.ok(b.note.includes('SignerList'));
    }
    assert.equal(bodyOf(planet({ flags: LSF.disableMaster, regularKey: null })).kind, 'blackhole');
    assert.equal(bodyOf(planet({ flags: LSF.disableMaster, regularKey: 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq' })).kind, 'planet', 'a usable regular key keeps it a planet');
    assert.equal(bodyOf(planet({ flags: 0, regularKey: BLACKHOLE_KEYS[0] })).kind, 'planet', 'an unusable key with the master enabled is nothing');
  });

  test('an AMM pool is a binary star by AMMID, before the black hole rule (its master is disabled too)', () => {
    const b = bodyOf(planet({ flags: LSF.disableMaster | LSF.depositAuth | LSF.defaultRipple, regularKey: null, ammId: 'AB'.repeat(32), providers: new Set([2, 3]) }));
    assert.equal(b.kind, 'binary');
    assert.equal(b.tier, 'observed');
    assert.equal(b.providers, 2);
  });

  test('a star issues to enough holders; fewer is a planet', () => {
    assert.equal(bodyOf(planet({ holders: new Set([2, 3, 4]) })).kind, 'star');
    assert.equal(bodyOf(planet({ holders: new Set([2, 3]) })).kind, 'planet');
    assert.equal(bodyOf(planet({ holders: new Set([2, 3]) }), { minHolders: 2 }).kind, 'star');
    assert.equal(STAR_HOLDERS, 3);
  });

  test('a pulsar has a cadence of two or more; a collapsed planet was deleted, before everything', () => {
    const p = bodyOf(planet({ cadence: { period: 3, r: 0.96 } }));
    assert.equal(p.kind, 'pulsar');
    assert.equal(p.period, 3);
    assert.equal(p.tier, 'observation');
    assert.equal(bodyOf(planet({ cadence: { period: 1, r: 0.9 } })).kind, 'planet');
    assert.equal(bodyOf(planet({ deleted: true, ammId: 'X', holders: new Set([2, 3, 4]) })).kind, 'collapsed');
    assert.deepEqual(KINDS, ['planet', 'star', 'binary', 'blackhole', 'pulsar', 'collapsed']);
  });

  test('glow decays with the ledgers since the last touch', () => {
    const p = planet({ activity: 8, lastLedger: 100 });
    assert.ok(glowOf(p, 100) > glowOf(p, 112));
    assert.equal(glowOf(planet({ activity: 0 }), 100), 0);
  });

  test('the text equivalent says the kind, the balance, the counts, and the tier when it is not observed', () => {
    const text = describeBody(planet({ flags: LSF.disableMaster, regularKey: BLACKHOLE_KEYS[1], fundedLines: 2, peers: new Set([2, 3]) }));
    assert.match(text, /black hole candidate/);
    assert.match(text, /12,948\.92 XRP/);
    assert.match(text, /5 transactions in 3 ledgers, 2 submitted/);
    assert.match(text, /2 trust lines seen, 2 funded/);
    assert.match(text, /\(hypothesis: blackhole\.candidate\)/);
    assert.match(describeBody(planet()), /a planet/);
    assert.doesNotMatch(describeBody(planet()), /observed:/, 'an observed body states no tier');
  });

  test('comets: a payment is a comet (dust under 1 XRP) with a tail from its paths; an escrow is long-period; the rest flash', () => {
    const pay = cometOf({ type: TYPE_CODES.Payment, category: CATEGORY_CODES.payment, account: 1, destination: 2, log: 2, xrp: true, paths: 3, success: true });
    assert.equal(pay.kind, 'comet');
    assert.equal(pay.tail, 4);
    assert.equal(cometOf({ type: TYPE_CODES.Payment, category: 0, account: 1, destination: 2, log: -2, xrp: true, paths: 0, success: true }).kind, 'dust');
    assert.equal(cometOf({ type: TYPE_CODES.Payment, category: 0, account: 1, destination: 2, log: -2, xrp: false, paths: 0, success: true }).kind, 'comet', 'an issued amount under one is not XRP dust');
    const esc = cometOf({ type: TYPE_CODES.EscrowCreate, category: CATEGORY_CODES.escrow, account: 1, destination: 2, finishAfter: 800000000, success: true });
    assert.equal(esc.kind, 'long-period');
    assert.equal(esc.returns, 800000000);
    assert.equal(cometOf({ type: TYPE_CODES.OfferCreate, category: CATEGORY_CODES.offer, account: 1, success: true }).kind, 'flash');
    assert.equal(cometOf(null), null);
  });
});

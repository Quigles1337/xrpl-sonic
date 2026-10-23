// UNIVERSE phase 1: the name rule, the labels with their thresholds, the cast
// highlight, the flight clock the picture and the sound share, and the Batch
// category of the field guide.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { nameOf, labelOf, nebulaLabel, castMemberOf, describeBody, flightOf, THRESHOLDS, bodyOf, LSF, BLACKHOLE_KEYS } from '../src/universe/bodies.js';
import { CATEGORY_CODES, CATEGORY_BY_CODE, CATEGORY_COUNT, compactRecord } from '../src/universe/records.js';
import { normalizeCast } from '../src/cast.js';
import { CATEGORIES, CATEGORY_NAMES } from '../src/mapping.js';

const MAKER = 'rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah';
const OTHER = 'rKNRrawfVS59C3tN1bBiUWc5wZQAfUPh7z';
const cast = normalizeCast([{ address: MAKER, label: 'Maker' }]);
const planet = (over = {}) => ({ id: 1, address: MAKER, firstLedger: 100, lastLedger: 110, ledgersSeen: 3, submitted: 2, involved: 5, byCategory: new Array(CATEGORY_COUNT).fill(0), activity: 2, balanceDrops: 12948919267, flags: 0, ownerCount: 38, regularKey: null, domain: null, ammId: null, created: false, deleted: false, holders: null, issuers: null, peers: null, fundedLines: 0, providers: null, openOffers: 0, minted: 0, degree: 2, cadence: null, ...over });

describe('names', () => {
  test('the on-ledger Domain wins, then the cast label, then the short address', () => {
    // "xrpl.org" as the hex Domain field carries it
    const domain = Buffer.from('xrpl.org', 'utf8').toString('hex').toUpperCase();
    assert.deepEqual(nameOf({ address: MAKER, domain }, cast), { name: 'xrpl.org', source: 'domain', member: cast[0] });
    assert.deepEqual(nameOf({ address: MAKER }, cast), { name: 'Maker', source: 'cast', member: cast[0] });
    assert.equal(nameOf({ address: OTHER }, cast).source, 'address');
    assert.equal(nameOf({ address: OTHER }, cast).name, 'rKNR…Ph7z');
    assert.equal(castMemberOf(OTHER, cast), null);
    assert.equal(castMemberOf(MAKER, []), null);
  });
});

describe('labels print their thresholds', () => {
  test('every kind but a plain planet names the number that made it', () => {
    assert.equal(labelOf(bodyOf(planet({ holders: new Set([2, 3, 4, 5, 6]) }))), `star · 5 holders ≥ ${THRESHOLDS.starHolders}`);
    assert.equal(labelOf(bodyOf(planet({ ammId: 'AB'.repeat(32), providers: new Set([2, 3]) }))), 'binary · AMM pool · 2 providers');
    assert.equal(labelOf(bodyOf(planet({ flags: LSF.disableMaster, regularKey: BLACKHOLE_KEYS[1] }))), 'black hole? · master key disabled · key rrrr…BZbvji unusable · a SignerList would reopen it');
    assert.equal(labelOf(bodyOf(planet({ flags: LSF.disableMaster, regularKey: null }))), 'black hole? · master key disabled · key absent unusable · a SignerList would reopen it');
    assert.equal(labelOf(bodyOf(planet({ cadence: { period: 3, r: 0.96 } }))), `pulsar · cadence 3 ledgers · r 0.96 ≥ ${THRESHOLDS.pulsarLeast.toFixed(2)}`);
    assert.equal(labelOf(bodyOf(planet({ deleted: true }))), 'collapsed · account deleted');
    assert.equal(labelOf(bodyOf(planet())), '', 'a planet has no rule to print');
    assert.equal(nebulaLabel(12), `nebula · 12 planets ≥ ${THRESHOLDS.nebulaSize} · edges ≥ ${THRESHOLDS.clusterEdge} namings · hubs > ${THRESHOLDS.hubDegree} counterparties left out`);
  });

  test('a cadence below the bar is not a pulsar; the thresholds are the spike’s', () => {
    assert.equal(bodyOf(planet({ cadence: { period: 3, r: 0.2 } })).kind, 'planet');
    assert.equal(bodyOf(planet({ cadence: { period: 1, r: 0.9 } })).kind, 'planet');
    assert.deepEqual(THRESHOLDS, { starHolders: 3, pulsarLeast: 0.3, pulsarPeriod: 2, clusterEdge: 2, hubDegree: 40, nebulaSize: 5 });
  });

  test('the text equivalent names the cast member and says so, and prints the thresholds', () => {
    const text = describeBody(planet({ holders: new Set([2, 3, 4]) }), null, { cast });
    assert.match(text, /^Maker \(rBTw…jjah\): a star · 3 holders in orbit \(star ≥ 3\) · in the cast · balance 12,948\.92 XRP/);
    const other = describeBody(planet({ address: OTHER }), null, { cast });
    assert.match(other, /^rKNR…Ph7z: a planet · balance/);
    assert.doesNotMatch(other, /in the cast/);
  });
});

describe('the flight clock', () => {
  test('objects of a ledger are staggered across 85% of the interval; a comet lands at start + life, a flash is instant', () => {
    const now = 1000;
    const comet = flightOf({ kind: 'comet' }, 0, 4, 4000, now);
    assert.equal(comet.start, 1000);
    assert.equal(comet.life, 3600);
    assert.equal(comet.arrival, 4600);
    const last = flightOf({ kind: 'comet' }, 3, 4, 4000, now);
    assert.equal(last.start, 1000 + 0.75 * 4000 * 0.85);
    const flash = flightOf({ kind: 'flash' }, 1, 2, 4000, now);
    assert.equal(flash.life, 700);
    assert.equal(flash.arrival, flash.start);
    assert.equal(flightOf({ kind: 'dust' }, 0, 1, 4000, now).life, 2000);
    assert.equal(flightOf({ kind: 'long-period' }, 0, 1, 4000, now).life, 6400);
  });
});

describe('the Batch category', () => {
  test('the codes follow the field guide’s list, Batch included, and a Batch record carries its code', () => {
    assert.deepEqual(CATEGORY_BY_CODE, CATEGORY_NAMES);
    assert.equal(CATEGORY_CODES.batch, CATEGORY_NAMES.indexOf('batch'));
    assert.equal(CATEGORY_COUNT, CATEGORY_NAMES.length);
    assert.equal(CATEGORIES.batch.colour, '#d4a373');
    const rec = compactRecord({ TransactionType: 'Batch', Account: MAKER, Flags: 0x00010000, RawTransactions: [] }, { TransactionResult: 'tesSUCCESS', AffectedNodes: [] }, { result: 'tesSUCCESS' });
    assert.equal(rec.category, CATEGORY_CODES.batch);
    assert.equal(rec.type, 29);
  });
});

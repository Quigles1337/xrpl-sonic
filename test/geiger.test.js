import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeCast } from '../src/cast.js';
import { Geiger, featuresOf, seriesOf, explain, normalizeGeigerConfig, totalBand, GEIGER_DEFAULTS, STALE_AFTER_MS, HISTORY_LENGTH } from '../src/geiger.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8'));
const ledger = fixture('ledger-expanded').result.ledger;
const SENDER = ledger.transactions[0].Account;
const MAKER = 'rMakerMakerMakerMakerMakerMake'; // base58-shaped, 30 characters

/** A synthetic ledger: n OfferCreate from `maker`, m OfferCreate from others, k payments from others. */
function synth({ maker = MAKER, makerOffers = 0, otherOffers = 10, payments = 20 }) {
  const txs = [];
  for (let i = 0; i < makerOffers; i++) txs.push({ TransactionType: 'OfferCreate', Account: maker, hash: `M${i}` });
  for (let i = 0; i < otherOffers; i++) txs.push({ TransactionType: 'OfferCreate', Account: `rOther${i % 7}`, hash: `O${i}` });
  for (let i = 0; i < payments; i++) txs.push({ TransactionType: 'Payment', Account: `rPayer${i % 5}`, Destination: 'rDest', hash: `P${i}` });
  return txs;
}

describe('features', () => {
  test('counts the fixture ledger by category and by cast member', () => {
    const cast = normalizeCast([{ address: SENDER, label: 'Alice' }]);
    const f = featuresOf(ledger.transactions, cast);
    assert.equal(f.total, ledger.transactions.length);
    assert.equal(Object.values(f.byCategory).reduce((a, b) => a + b, 0), f.total);
    assert.equal(f.members.c1.submitted, ledger.transactions.filter((t) => t.Account === SENDER).length);
    assert.ok(f.members.c1.involved >= f.members.c1.submitted);
    assert.equal(f.offerCreateTotal, ledger.transactions.filter((t) => t.TransactionType === 'OfferCreate').length);
    const s = seriesOf(f, cast);
    assert.equal(s.get('total').value, f.total);
    assert.equal(s.get('member:c1:offerShare').kind, 'share');
    assert.deepEqual(featuresOf(null).byCategory.payment, 0);
  });

  test('normalizeGeigerConfig clamps and defaults', () => {
    assert.deepEqual(normalizeGeigerConfig(null), GEIGER_DEFAULTS);
    assert.deepEqual(normalizeGeigerConfig({ window: 2, threshold: 50, minCount: 'x', adapt: false }), { window: 5, threshold: 10, minCount: 10, adapt: false });
    assert.equal(normalizeGeigerConfig({ window: 12.6 }).window, 13);
  });
});

describe('Geiger', () => {
  test('forms a baseline, then reports nominal ledgers', () => {
    const g = new Geiger({ window: 5 });
    for (let i = 0; i < 4; i++) assert.equal(g.observeLedger({ ledgerIndex: 100 + i, transactions: synth({}), nowMs: 1000 * i }).state, 'forming');
    assert.equal(g.status(4000).state, 'forming');
    assert.match(g.status(4000).text, /4 of 5/);
    const r = g.observeLedger({ ledgerIndex: 104, transactions: synth({}), nowMs: 4000 });
    assert.equal(r.state, 'forming', 'the fifth ledger completes the window after it is judged');
    const r2 = g.observeLedger({ ledgerIndex: 105, transactions: synth({}), nowMs: 5000 });
    assert.equal(r2.state, 'nominal');
    assert.equal(g.status(5000).state, 'nominal');
    assert.match(g.status(5000).text, /rolling baseline/);
    assert.deepEqual(r2.crossings, []);
  });

  test('a flood of offers from one account crosses, with an explanation made of the measured numbers', () => {
    const cast = normalizeCast([{ address: MAKER, label: 'Maker' }]);
    assert.equal(cast.length, 1);
    const g = new Geiger({ window: 5, threshold: 3, minCount: 10, cast });
    for (let i = 0; i < 5; i++) g.observeLedger({ ledgerIndex: 100 + i, transactions: synth({ makerOffers: 2, otherOffers: 18 }), nowMs: i });
    const r = g.observeLedger({ ledgerIndex: 105, transactions: synth({ makerOffers: 80, otherOffers: 20 }), nowMs: 5 });
    assert.equal(r.state, 'crossing');
    const share = r.crossings.find((c) => c.id === 'member:c1:offerShare');
    assert.ok(share, 'the share series crossed');
    assert.equal(share.count, 80);
    assert.equal(share.of, 100);
    assert.match(share.explanation, /^Maker submitted 80 of the 100 OfferCreate transactions in ledger #105 \(80%\)\. Over the previous 5 ledgers its share averaged 10% ± 5%, so this is \d+\.\dσ above the baseline \(threshold 3σ\)\.$/);
    const submitted = r.crossings.find((c) => c.id === 'member:c1:submitted');
    assert.ok(submitted);
    assert.match(submitted.explanation, /ledger #105 carried 80 transactions submitted by Maker; the previous 5 ledgers averaged 2\.0 ± 1\.4/);
    assert.equal(g.status(5).state, 'crossing');
    assert.equal(g.status(5).crossings[0].z, r.crossings[0].z, 'highest z first');
    assert.ok(g.history.at(-1).crossing);
  });

  test('minCount keeps a 1-of-1 share from counting as a flood', () => {
    const cast = normalizeCast([{ address: MAKER, label: 'Maker' }]);
    const g = new Geiger({ window: 5, minCount: 10, cast });
    for (let i = 0; i < 5; i++) g.observeLedger({ ledgerIndex: i, transactions: synth({ makerOffers: 0, otherOffers: 30 }) });
    const r = g.observeLedger({ ledgerIndex: 5, transactions: synth({ makerOffers: 1, otherOffers: 0, payments: 0 }) });
    assert.equal(r.state, 'nominal');
    assert.equal(r.features.members.c1.offerCreate, 1);
  });

  test('a pinned baseline is not moved by what comes after; adapt=false freezes it once formed', () => {
    const g = new Geiger({ window: 5 });
    for (let i = 0; i < 5; i++) g.observeLedger({ ledgerIndex: i, transactions: synth({ payments: 20 }) });
    const snap = g.pin();
    assert.equal(snap.window, 5);
    assert.ok(Math.abs(snap.series.total.mean - 30) < 1e-9);
    for (let i = 5; i < 20; i++) g.observeLedger({ ledgerIndex: i, transactions: synth({ payments: 200 }) });
    assert.ok(Math.abs(g.baselineFor('total').mean - 30) < 1e-9, 'pinned mean unchanged by the floods');
    assert.equal(g.last.state, 'crossing');
    g.unpin();
    assert.equal(g.baselineFor('total').mean, 30, 'the rolling values were not updated while pinned either');
    const restored = new Geiger({ window: 5, baseline: snap });
    assert.equal(restored.formed, true);
    assert.equal(restored.observeLedger({ ledgerIndex: 99, transactions: synth({ payments: 200 }) }).state, 'crossing');

    const frozen = new Geiger({ window: 5, adapt: false });
    for (let i = 0; i < 5; i++) frozen.observeLedger({ ledgerIndex: i, transactions: synth({ payments: 20 }) });
    for (let i = 5; i < 15; i++) frozen.observeLedger({ ledgerIndex: i, transactions: synth({ payments: 200 }) });
    assert.equal(frozen.baselineFor('total').mean, 30);
    assert.match(frozen.status(0).text.replace(/^.*\(/, '('), /^\(/);
  });

  test('a rolling baseline absorbs a sustained change', () => {
    const g = new Geiger({ window: 5, adapt: true });
    for (let i = 0; i < 5; i++) g.observeLedger({ ledgerIndex: i, transactions: synth({ payments: 20 }) });
    const states = [];
    for (let i = 5; i < 15; i++) states.push(g.observeLedger({ ledgerIndex: i, transactions: synth({ payments: 200 }) }).state);
    assert.equal(states[0], 'crossing');
    assert.equal(states.at(-1), 'nominal', 'after a window of the new level it is the baseline');
  });

  test('stale when no ledger arrives; history is bounded; band reflects the baseline', () => {
    const g = new Geiger({ window: 5 });
    assert.equal(g.status(0).state, 'forming');
    for (let i = 0; i < HISTORY_LENGTH + 10; i++) g.observeLedger({ ledgerIndex: i, transactions: synth({}), nowMs: 1000 });
    assert.equal(g.history.length, HISTORY_LENGTH);
    assert.equal(g.status(1000 + STALE_AFTER_MS + 1).state, 'stale');
    assert.equal(g.status(1000 + STALE_AFTER_MS - 1).state, 'nominal');
    const band = totalBand(g);
    assert.ok(band && band.low <= band.mean && band.mean <= band.high);
    assert.equal(totalBand(new Geiger({ window: 5 })), null);
  });

  test('explain is deterministic from its inputs', () => {
    const text = explain({ ledgerIndex: 7, series: { kind: 'count', label: 'payment transactions' }, value: 412, count: 412, mean: 120, sd: 40, z: 7.3, threshold: 3, windowSize: 30 });
    assert.equal(text, 'ledger #7 carried 412 payment transactions; the previous 30 ledgers averaged 120.0 ± 40.0, so this is 7.3σ above the baseline (threshold 3σ).');
  });
});

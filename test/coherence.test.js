// Coherence: the statistic and its readout (phase 1), the prewhitened
// statistic, the pairs-tested count and the record check (phase 1.5).
// Synthetic trains with planted answers (lockstep, lagged, uncorrelated,
// always-on, a cadence mismatch, missing ledgers, a shared period with and
// without a planted lag), the frames from a score, the live window and
// account_tx, the readout wording, and the checked-in real cases.
//
// Phase 1.5 re-pinned the phase 1 lines: every pair line now carries the
// prewhitened r and its null first, the raw r and its null second, the
// residual rows and AR orders, and the record check; the pairs are ranked
// by the prewhitened r, so the order of the recorded windows' tables
// changed. The raw numbers themselves are unchanged.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalise,
  crossCorrelation,
  shuffleTest,
  subWindowLags,
  seededRandom,
  frameFromScore,
  frameFromLive,
  accountsFor,
  pairCoherence,
  coherence,
  readout,
  describePair,
  pairDetailLines,
  followText,
  beatOf,
  logVolume,
  normalizeOptions,
  arFit,
  prewhiten,
  aicc,
  significant,
  minShuffles,
  orderLimit,
  PREDICTED_VARIANCE,
  BINS,
  BIN_NAMES,
  ASSUMED_CLOSE_SECONDS,
  interpolateCloseTimes,
  binFrame,
  DEFAULTS,
  EXCLUSIONS,
  COHERENCE_VERSION,
  TIER,
} from '../src/coherence.js';
import { touchOf } from '../src/record.js';
import { LiveWindow } from '../src/moment.js';
import { validateCase } from '../src/case.js';
import { buildScore } from '../src/score.js';
import { shortAddress } from '../src/mapping.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8'));

const A = 'rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah';
const B = 'rKYdJJLAgxbJcn9Ria2X5jMMiqP91r4qy';
const C = 'r33SNW2rSBkXGmn84FSKSY4RG4FJ7fUVhk';

/** A series of small counts with real variation, deterministic. */
function train(n, seed, { base = 3, spread = 6 } = {}) {
  const rand = seededRandom(seed);
  return Array.from({ length: n }, () => Math.max(0, Math.round(base + (rand() - 0.5) * spread)));
}

/** A frame built by hand: rows 0..n-1 (ledger indices from 1000), series per address, all used unless `missing` lists rows. */
function frameOf(series, { missing = [], labels = {} } = {}) {
  const n = Math.max(...Object.values(series).map((s) => s.length));
  const ledgers = Array.from({ length: n }, (_, i) => ({ index: 1000 + i, included: !missing.includes(i), reason: missing.includes(i) ? 'missing' : null, hash: null }));
  const totals = new Map(Object.entries(series).map(([a, s]) => [a, s.reduce((x, y, i) => x + (ledgers[i].included ? y : 0), 0)]));
  const accounts = Object.keys(series).map((address) => ({ address, label: labels[address] ?? shortAddress(address) }));
  return { source: 'score', measure: 'count', ledgers, accounts, series: new Map(Object.entries(series)), totals, chosen: 'cast' };
}

const z = (values, included) => normalise(values, included).z;

describe('coherence: synthetic trains', () => {
  test('a lockstep pair: r 1 at lag 0, every shuffle below it', () => {
    const a = train(40, 1);
    const c = crossCorrelation(z(a), z(a), 5);
    assert.ok(Math.abs(c.r - 1) < 1e-9, `r ${c.r}`);
    assert.equal(c.lag, 0);
    assert.equal(c.n, 40);
    assert.equal(c.overlap, 40);
    assert.equal(c.byLag.length, 11);
    assert.deepEqual(c.byLag.map((e) => e.overlap), [35, 36, 37, 38, 39, 40, 39, 38, 37, 36, 35], 'the overlap shrinks by one per ledger of lag');
    const s = shuffleTest(z(a), z(a), 5, { observed: 1 });
    assert.equal(s.available, 40 - 2 * 5 - 1, 'shifts within the lags and their mirrors are not admissible');
    assert.equal(s.count, s.available, 'fewer admissible shifts than the ceiling: all of them are used');
    assert.equal(s.above, s.count);
    assert.equal(s.percentile, 1);
    assert.ok(s.max < 1);
    assert.deepEqual(shuffleTest(z(a), z(a), 5, { observed: 1 }), s, 'seeded, so the same every time');
  });

  test('a lagged pair: the peak at the planted lag, positive when the second follows the first', () => {
    const a = train(48, 2);
    const b = a.map((_, t) => (t >= 3 ? a[t - 3] : train(3, 9)[t])); // b repeats a three ledgers later
    const c = crossCorrelation(z(a), z(b), 8);
    assert.equal(c.lag, 3, 'b follows a by 3');
    assert.ok(c.r > 0.95, `r ${c.r}`);
    assert.equal(c.overlap, 45);
    const back = crossCorrelation(z(b), z(a), 8);
    assert.equal(back.lag, -3, 'the same pair the other way round: a leads');
    assert.ok(Math.abs(back.r - c.r) < 1e-12);
    assert.equal(crossCorrelation(z(a), z(b), 2).lag !== 3, true, 'a lag beyond maxLag cannot be found');
    const pair = pairCoherence(frameOf({ [A]: a, [B]: b }, { labels: { [A]: 'A', [B]: 'B' } }), { address: A, label: 'A' }, { address: B, label: 'B' }, { maxLag: 8, minLedgers: 12, minEvents: 10 });
    assert.equal(followText(pair), 'B follows A by 3 ledgers');
    assert.ok(pair.shuffle.percentile >= 0.9, `percentile ${pair.shuffle.percentile}`);
  });

  test('an uncorrelated pair: low r, a low percentile, and the readout says so with every number', () => {
    const a = train(50, 3);
    const b = train(50, 4);
    const c = crossCorrelation(z(a), z(b), 8);
    assert.ok(Math.abs(c.r) < 0.5, `r ${c.r}`);
    const s = shuffleTest(z(a), z(b), 8, { observed: Math.abs(c.r) });
    assert.equal(s.available, 33);
    assert.ok(s.percentile < 0.95, `percentile ${s.percentile}`);
    const line = describePair(pairCoherence(frameOf({ [A]: a, [B]: b }, { labels: { [A]: 'A', [B]: 'B' } }), { address: A, label: 'A' }, { address: B, label: 'B' }));
    assert.match(line, /^A ↔ B: prewhitened r -?\d\.\d\d at lag [+-]?\d+ \((B follows A by \d+ ledgers?|A follows B by \d+ ledgers?|in step)\) above \d+% of shuffles \(\d+ of \d+\) · raw r -?\d\.\d\d at lag [+-]?\d+ above \d+% of shuffles \(\d+ of 33\) · 50 ledgers \(overlap \d+; \d+ residual rows after AR\(\d\)\/AR\(\d\), overlap \d+\) · events \d+\/\d+ · record not available · 2 parts of 25: lag [+-]?\d+ \(r -?\d\.\d\d\), [+-]?\d+ \(r -?\d\.\d\d\)$/);
    assert.equal(line.includes('pairs tested'), false, 'a pair judged on its own has no count of pairs tested');
  });

  test('an always-on account is flat after normalisation and shows no coherence', () => {
    const steady = new Array(40).fill(5);
    const n = normalise(steady);
    assert.equal(n.flat, true);
    assert.equal(n.sd, 0);
    assert.ok(n.z.every((v) => v === 0));
    const busy = train(40, 5);
    assert.equal(normalise(busy).flat, false);
    const frame = frameOf({ [A]: steady, [B]: busy }, { labels: { [A]: 'Always', [B]: 'Busy' } });
    const pair = pairCoherence(frame, frame.accounts[0], frame.accounts[1]);
    assert.equal(pair.judged, true);
    assert.deepEqual(pair.flat, { a: true, b: false });
    assert.equal(pair.r, 0);
    assert.equal(pair.shuffle, null);
    assert.equal(describePair(pair), 'Always ↔ Busy: no coherence: Always is flat (the same count in every ledger used) · 40 ledgers · events 200/' + busy.reduce((x, y) => x + y, 0) + ' · record not available');
    const both = pairCoherence(frameOf({ [A]: steady, [B]: new Array(40).fill(2) }), { address: A, label: 'A' }, { address: B, label: 'B' });
    assert.equal(both.reason, 'both are flat');
    assert.equal(crossCorrelation(n.z, n.z, 3).r, 0, 'two flat series correlate at 0, not NaN');
  });

  test('a periodic pair with a cadence mismatch: the peak lag drifts across the sub-windows and the line says so', () => {
    const n = 60;
    // counts that swell and fade every 7 ledgers, and every 8
    const a = Array.from({ length: n }, (_, t) => Math.round(3 + 3 * Math.cos((2 * Math.PI * t) / 7)));
    const b = Array.from({ length: n }, (_, t) => Math.round(3 + 3 * Math.cos((2 * Math.PI * t) / 8)));
    const subs = subWindowLags(z(a), z(b), 8, { parts: 3 });
    assert.equal(subs.length, 2, 'a part is at least three lag ranges long: two parts of 30 fit in 60 ledgers, not three of 20');
    assert.deepEqual(subs.map((s) => [s.from, s.to, s.ledgers]), [[0, 29, 30], [30, 59, 30]]);
    const lags = subs.map((s) => s.lag);
    assert.ok(lags.every((l) => l != null));
    assert.ok(Math.max(...lags) - Math.min(...lags) >= 2, `lags ${lags.join(', ')} should drift`);
    // even the ideal signal peaks at only r 0.71 and 0.76 in parts of 30: the phase keeps drifting inside a part, so a part's peak is no verdict
    assert.ok(subs.every((s) => Math.abs(s.r) >= 0.6 && Math.abs(s.r) < 0.8), `each part peaks at its own lag, moderately: ${subs.map((s) => s.r.toFixed(2)).join(', ')}`);
    const frame = frameOf({ [A]: a, [B]: b }, { labels: { [A]: 'Seven', [B]: 'Eight' } });
    const pair = pairCoherence(frame, frame.accounts[0], frame.accounts[1], { minEvents: 1 });
    assert.ok(pair.drift >= 2);
    assert.ok(Math.abs(pair.r) < 0.2, `over the whole window the drifting phase averages out: r ${pair.r.toFixed(2)}`);
    // the mismatch is read from the cadences themselves: 7 and 8 ledgers, so the alignment recurs every 56
    assert.deepEqual(pair.cadence.a.period, 7);
    assert.deepEqual(pair.cadence.b.period, 8);
    assert.deepEqual(pair.beat, { periods: [7, 8], every: 56 });
    assert.match(describePair(pair), / · 2 parts of 30: lag [+-]?\d+ \(r -?\d\.\d\d\), [+-]?\d+ \(r -?\d\.\d\d\) · cadences of 7 and 8 ledgers: a mismatch, the alignment recurs every 56 ledgers$/);
    const same = subWindowLags(z(a), z(a), 8, { parts: 3 });
    assert.deepEqual(same.map((s) => s.lag), [0, 0], 'the same cadence holds its lag');
    const twin = pairCoherence(frameOf({ [A]: a, [B]: a.map((v) => v + 1) }, { labels: { [A]: 'Seven', [B]: 'Seven too' } }), { address: A, label: 'Seven' }, { address: B, label: 'Seven too' }, { minEvents: 1 });
    assert.deepEqual(twin.beat, { shared: 7 });
    assert.match(describePair(twin), / · shared cadence of 7 ledgers$/);
    assert.deepEqual(subWindowLags(z(a), z(b), 8, { parts: 3, minPart: 40 }), [], 'fewer than two parts fit: nothing is reported');
    const noise = pairCoherence(frameOf({ [A]: train(50, 21), [B]: train(50, 22) }), { address: A, label: 'A' }, { address: B, label: 'B' });
    assert.equal(noise.beat, noise.cadence.a && noise.cadence.b ? noise.beat : null, 'no beat without a cadence on both sides');
    assert.equal(beatOf(null, { period: 3, r: 0.5 }), null);
    assert.deepEqual(beatOf({ period: 3, r: 0.5 }, { period: 4, r: 0.5 }), { periods: [3, 4], every: 12 });
    const report = coherence(frame, { minEvents: 1 });
    assert.deepEqual(report.accounts.map((x) => x.cadence?.period), [7, 8], 'each account’s own cadence, from its autocorrelation');
    assert.ok(report.accounts.every((x) => x.cadence.r > 0.9));
    assert.match(readout(report), /Seven = \S+ \(\d+ events, cadence 7 ledgers \(self-correlation \d\.\d\d\), AR\(\d\)\)/);
  });

  test('missing ledgers are absent: they pair with nothing and n reflects it', () => {
    const a = train(20, 6);
    const frame = frameOf({ [A]: a, [B]: a }, { missing: [15, 16], labels: { [A]: 'A', [B]: 'B' } });
    const included = frame.ledgers.map((l) => l.included);
    const positions = frame.ledgers.map((l) => l.index);
    const c = crossCorrelation(z(a, included), z(a, included), 2, { positions, included });
    assert.equal(c.n, 18);
    assert.equal(c.overlap, 18);
    assert.equal(c.byLag.find((e) => e.lag === 1).overlap, 16, 'pairs touching a missing ledger do not exist');
    assert.equal(c.byLag.find((e) => e.lag === 2).overlap, 14);
    const pair = pairCoherence(frame, frame.accounts[0], frame.accounts[1], { minLedgers: 5, minEvents: 1, maxLag: 2 });
    assert.equal(pair.n, 18);
    assert.ok(Math.abs(pair.r - 1) < 1e-9);
    assert.equal(normalise(a, included).n, 18, 'the baseline is over the ledgers used');
    const report = coherence(frame, { minLedgers: 5, minEvents: 1, maxLag: 2 });
    assert.deepEqual(report.window, { from: 1000, to: 1019, ledgers: 20, used: 18, excluded: { missing: 2 }, ledgerCount: 20 });
    assert.match(readout(report), /18 of 20 ledgers used \(excluded: 2 not available from the node\)/);
  });

  test('the guard: too few ledgers or events is reported, not ranked', () => {
    const short = frameOf({ [A]: train(5, 1), [B]: train(5, 2) }, { labels: { [A]: 'A', [B]: 'B' } });
    const p = pairCoherence(short, short.accounts[0], short.accounts[1]);
    assert.equal(p.judged, false);
    assert.equal(p.reason, '5 ledgers used (guard ≥ 12)');
    assert.equal(describePair(p), 'A ↔ B: not judged: 5 ledgers used (guard ≥ 12)');
    const quiet = frameOf({ [A]: train(40, 1), [B]: new Array(40).fill(0).map((_, i) => (i === 3 ? 1 : 0)) }, { labels: { [A]: 'A', [B]: 'B' } });
    const q = pairCoherence(quiet, quiet.accounts[0], quiet.accounts[1]);
    assert.equal(q.judged, false);
    assert.match(q.reason, /^events \d+\/1 \(guard ≥ 10 each\)$/);
    assert.equal(p.r, null);
    assert.equal(p.shuffle, null);
  });

  test('options are validated onto the defaults', () => {
    assert.deepEqual(normalizeOptions(null), DEFAULTS);
    assert.deepEqual(normalizeOptions({ maxLag: 99, minLedgers: 0, topK: 50, measure: 'bogus', seed: 7.9, shuffles: -1 }), { ...DEFAULTS, maxLag: 25, minLedgers: 2, topK: 12, seed: 8, shuffles: 0 });
    assert.equal(normalizeOptions({ measure: 'volume' }).measure, 'volume');
    assert.equal(COHERENCE_VERSION, 3, 'phase 2: the frame in bins, the unit on every line, undefined parts');
    assert.equal(TIER, 'observation');
    assert.deepEqual(Object.keys(EXCLUSIONS), ['missing', 'incomplete', 'unknown', 'history', 'unvalidated']);
    assert.equal(normalizeOptions({ maxOrder: 3 }).maxOrder, 3);
    assert.equal(normalizeOptions({ significance: 0.99 }).significance, 0.99);
    assert.equal(normalizeOptions({ significance: 2 }).significance, DEFAULTS.significance);
    assert.equal(orderLimit(DEFAULTS, 5), 5, 'maxOrder 0 means up to L');
    assert.equal(orderLimit({ ...DEFAULTS, maxOrder: 2 }, 5), 2);
  });
});

describe('coherence: prewhitening (phase 1.5)', () => {
  /** A seeded noise series with a near-Gaussian shape (the sum of three uniforms). */
  const noise = (n, seed, scale = 1) => {
    const rand = seededRandom(seed);
    return Array.from({ length: n }, () => (rand() + rand() + rand() - 1.5) * scale);
  };
  /** A pulse of `amp` every `period` ledgers from `phase`, plus small counts of noise. */
  const pulses = (n, period, phase, amp, seed, spread) => {
    const rand = seededRandom(seed);
    return Array.from({ length: n }, (_, t) => ((t + phase) % period === 0 ? amp : 0) + Math.round(rand() * spread));
  };
  const white = (a, b, { maxLag = 8 } = {}) => {
    const wa = prewhiten(z(a), maxLag);
    const wb = prewhiten(z(b), maxLag);
    const included = wa.included.map((u, i) => u && wb.included[i]);
    const c = crossCorrelation(wa.residual, wb.residual, maxLag, { included });
    const s = shuffleTest(wa.residual, wb.residual, maxLag, { included, observed: Math.abs(c.r) });
    return { c, s, wa, wb };
  };

  test('Burg finds the structure it is given: an AR(1), an exact cadence (fully predicted), white noise (order 0)', () => {
    const e = noise(400, 41);
    const ar1 = [e[0]];
    for (let t = 1; t < e.length; t++) ar1.push(0.6 * ar1[t - 1] + e[t]);
    const fit = arFit(z(ar1), 8);
    assert.equal(fit.order, 1, `order ${fit.order}`);
    assert.ok(Math.abs(fit.phi[0] - 0.6) < 0.1, `phi ${fit.phi[0]}`);
    assert.ok(fit.sigma2 < 0.75 && fit.sigma2 > 0.5, `relative innovation variance ${fit.sigma2}`);
    assert.equal(fit.candidates.length, 9);
    assert.equal(fit.candidates[0].aicc, 0, 'order 0 is the reference');
    const exact = Array.from({ length: 30 }, (_, t) => (t % 3 === 0 ? 5 : 1));
    const w = prewhiten(z(exact), 8);
    assert.equal(w.order, 2, 'a zero-mean series that repeats every three ledgers is z_t = −z_{t−1} − z_{t−2}');
    assert.equal(w.flat, true, 'nothing is left to predict');
    assert.equal(w.predicted, true);
    assert.ok(w.sigma2 < PREDICTED_VARIANCE && w.sigma2 > 0, `Burg leaves end effects: ${w.sigma2}`);
    assert.ok(w.phi.every((p) => Math.abs(p + 1) < 0.1), `phi ${w.phi.join(', ')}`);
    assert.ok(w.residual.every((v) => v === 0));
    assert.equal(prewhiten(z(Array.from({ length: 60 }, (_, t) => (t % 6 === 0 ? 6 : 0))), 8).order, 5, 'an exact pulse every six ledgers is z_t = −(z_{t−1} + … + z_{t−5}): order 5, not 6');
    assert.equal(PREDICTED_VARIANCE, 0.005);
    const plain = prewhiten(z(train(60, 43)), 8);
    assert.ok(plain.order <= 1, `white noise keeps a low order: ${plain.order}`);
    if (plain.order === 0) assert.ok(plain.residual.every((v, i) => Math.abs(v - z(train(60, 43))[i]) < 1e-9), 'order 0 leaves the series as it is');
    assert.equal(plain.included.filter(Boolean).length, 60 - plain.order);
    assert.equal(aicc(10, 1, 9), Infinity, 'an order the rows cannot bear');
    assert.equal(aicc(10, 0, 2), -Infinity, 'nothing left to predict wins');
    assert.equal(aicc(10, 0.001, 2), -Infinity, 'below PREDICTED_VARIANCE too');
    assert.ok(Number.isFinite(aicc(10, 0.5, 2)));
    // with a gap, no residual crosses it
    const gapped = prewhiten(z(ar1.slice(0, 40)), 3, { included: ar1.slice(0, 40).map((_, i) => i !== 20) });
    assert.equal(gapped.included[20], false);
    assert.equal(gapped.included[21], false, 'the row after the gap has no predecessor on the ledger axis');
    assert.equal(gapped.included[22], true);
  });

  test('two independent series with the same period: a high raw r by construction, not significant after prewhitening', () => {
    let rawHigh = 0;
    let whiteSignificant = 0;
    let whitened = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const a = pulses(60, 6, 0, 6, seed, 3);
      const b = pulses(60, 6, 2, 6, 100 + seed, 3);
      const raw = crossCorrelation(z(a), z(b), 8);
      if (Math.abs(raw.r) >= 0.5) rawHigh += 1;
      const { c, s, wa, wb } = white(a, b);
      if (wa.order >= 6 && wb.order >= 6) whitened += 1;
      if (s.percentile >= 0.95) whiteSignificant += 1;
      assert.ok(Math.abs(c.r) < 0.6, `seed ${seed}: prewhitened r ${c.r.toFixed(2)}`);
    }
    assert.equal(rawHigh, 20, 'the shared period lines the raw series up at some lag every time');
    assert.ok(whitened >= 18, `the AR fit reaches the period: ${whitened} of 20`);
    assert.ok(whiteSignificant <= 2, `above the 95th after prewhitening in ${whiteSignificant} of 20 (chance gives 1)`);
    const frame = frameOf({ [A]: pulses(60, 6, 0, 6, 1, 3), [B]: pulses(60, 6, 2, 6, 101, 3) }, { labels: { [A]: 'A', [B]: 'B' } });
    const report = coherence(frame);
    const line = describePair(report.pairs[0]);
    assert.match(line, /^A ↔ B: prewhitened r -?0\.\d\d at lag [+-]?\d+ \(.*\) above \d+% of shuffles \(\d+ of \d+; 1 pair tested\) · raw r -?0\.[5-9]\d at lag [+-]?\d+ above \d+% of shuffles \(\d+ of 43; 1 pair tested\) · 60 ledgers \(overlap \d+; \d+ residual rows after AR\([6-8]\)\/AR\([6-8]\), overlap \d+\)/);
    assert.match(line, / · shared cadence of 6 ledgers$/, 'the cadence line stays');
    assert.equal(report.pairs[0].white.shuffle.percentile < 0.95, true);
  });

  test('a planted lagged relation on top of a shared period survives prewhitening, at its lag and sign', () => {
    let atLag = 0;
    let significantCount = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const rand = seededRandom(500 + seed);
      const e = Array.from({ length: 63 }, () => Math.round(rand() * 4));
      const a = Array.from({ length: 60 }, (_, t) => (t % 6 === 0 ? 6 : 0) + e[t]);
      const b = Array.from({ length: 60 }, (_, t) => ((t + 2) % 6 === 0 ? 6 : 0) + (t >= 3 ? e[t - 3] : e[60 + t])); // b carries a's noise three ledgers later
      const { c, s } = white(a, b);
      if (c.lag === 3) atLag += 1;
      if (s.percentile >= 0.95) significantCount += 1;
    }
    assert.ok(atLag >= 19, `the peak is at the planted lag +3 in ${atLag} of 20`);
    assert.ok(significantCount >= 18, `above the 95th in ${significantCount} of 20`);
    const rand = seededRandom(777);
    const e = Array.from({ length: 63 }, () => Math.round(rand() * 4));
    const a = Array.from({ length: 60 }, (_, t) => (t % 6 === 0 ? 6 : 0) + e[t]);
    const b = Array.from({ length: 60 }, (_, t) => ((t + 2) % 6 === 0 ? 6 : 0) + (t >= 3 ? e[t - 3] : e[60 + t]));
    const pair = pairCoherence(frameOf({ [A]: a, [B]: b }, { labels: { [A]: 'A', [B]: 'B' } }), { address: A, label: 'A' }, { address: B, label: 'B' });
    assert.equal(pair.white.lag, 3);
    assert.ok(pair.white.r > 0.7, `prewhitened r ${pair.white.r}`);
    assert.ok(significant(pair));
    assert.match(describePair(pair), /^A ↔ B: prewhitened r 0\.\d\d at lag \+3 \(B follows A by 3 ledgers\) above (9\d|100)% of shuffles/);
    const back = pairCoherence(frameOf({ [B]: b, [A]: a }, { labels: { [A]: 'A', [B]: 'B' } }), { address: B, label: 'B' }, { address: A, label: 'A' });
    assert.equal(back.white.lag, -3, 'the other way round, A leads');
    const capped = pairCoherence(frameOf({ [A]: a, [B]: b }), { address: A, label: 'A' }, { address: B, label: 'B' }, { maxOrder: 2 });
    assert.ok(capped.white.ar.a <= 2 && capped.white.ar.b <= 2, 'maxOrder caps the fit');
  });

  test('the phase 1 trains under prewhitening: lockstep stays 1 at 0, the lagged copy keeps its lag, a flat residual is said', () => {
    const a = train(40, 1);
    const same = pairCoherence(frameOf({ [A]: a, [B]: a }, { labels: { [A]: 'A', [B]: 'B' } }), { address: A, label: 'A' }, { address: B, label: 'B' });
    assert.ok(Math.abs(same.white.r - 1) < 1e-9);
    assert.equal(same.white.lag, 0);
    assert.equal(same.white.ar.a, same.white.ar.b);
    const b = a.map((_, t) => (t >= 3 ? a[t - 3] : train(3, 9)[t]));
    const lagged = pairCoherence(frameOf({ [A]: a, [B]: b }, { labels: { [A]: 'A', [B]: 'B' } }), { address: A, label: 'A' }, { address: B, label: 'B' });
    assert.equal(lagged.white.lag, 3);
    assert.ok(lagged.white.r > 0.9);
    const exact = Array.from({ length: 30 }, (_, t) => (t % 3 === 0 ? 5 : 1));
    const pair = pairCoherence(frameOf({ [A]: exact, [B]: train(30, 2) }, { labels: { [A]: 'Metronome', [B]: 'B' } }), { address: A, label: 'Metronome' }, { address: B, label: 'B' });
    assert.equal(pair.white.r, null);
    assert.equal(pair.white.reason, 'Metronome is fully predicted by its own past (AR(2)), no residual to correlate');
    assert.match(describePair(pair), /^Metronome ↔ B: raw r -?\d\.\d\d at lag [+-]?\d+ \(.*\) above \d+% of shuffles \(\d+ of \d+\) · prewhitened: Metronome is fully predicted by its own past \(AR\(2\)\), no residual to correlate · 30 ledgers \(overlap \d+\) · events \d+\/\d+ · record not available/);
    assert.equal(significant(pair), false, '30 ledgers leave 15 shifts: the 95th cannot be resolved, so nothing is called significant');
    assert.equal(minShuffles(0.95), 20);
    assert.equal(minShuffles(0.99), 100);
    const long = pairCoherence(frameOf({ [A]: train(60, 1), [B]: train(60, 1) }), { address: A, label: 'A' }, { address: B, label: 'B' });
    assert.equal(significant(long), true, 'a lockstep pair over 43 shifts');
  });
});

describe('coherence: the record check (phase 1.5)', () => {
  const H = (n) => String(n).padStart(64, '0');
  /** A ledger with transactions: `payments` from a to b, `own` by each; every transaction has its AccountRoots in the record. */
  const ledgerOf = (index, { pay = 0, ownA = 0, ownB = 0, failed = 0 } = {}) => {
    const transactions = [];
    let seq = 0;
    const tx = (account, extra = {}, result = 'tesSUCCESS') => ({ TransactionType: extra.Destination ? 'Payment' : 'OfferCreate', Account: account, hash: H(index * 100 + ++seq), ...extra, metaData: { TransactionResult: result, AffectedNodes: [{ ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: account } } }, ...(extra.Destination ? [{ ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: extra.Destination } } }] : [])] } });
    for (let i = 0; i < pay; i++) transactions.push(tx(A, { Destination: B }));
    for (let i = 0; i < ownA; i++) transactions.push(tx(A));
    for (let i = 0; i < ownB; i++) transactions.push(tx(B));
    for (let i = 0; i < failed; i++) transactions.push(tx(B, { Destination: A }, 'tecPATH_DRY'));
    return { ledger_index: index, ledger_hash: 'A'.repeat(64), transactions };
  };
  const scoreOf = (ledgers) => ({
    ledgers: ledgers.map((l) => ({ ledgerIndex: l.ledger_index, missing: false, hash: l.ledger_hash })),
    events: ledgers.flatMap((l) => l.transactions.filter((t) => t.metaData.TransactionResult === 'tesSUCCESS').map((t) => ({ ledgerIndex: l.ledger_index, hash: t.hash, event: { account: t.Account, amount: null } }))),
  });

  test('from a score with its ledgers: the touch records, the connections of a pair with their hashes, and the readout lines', () => {
    const ledgers = Array.from({ length: 16 }, (_, i) => ledgerOf(2000 + i, { pay: i % 5 === 0 ? 1 : 0, ownA: 1 + (i % 3), ownB: 2 + (i % 4), failed: i === 7 ? 1 : 0 }));
    const map = new Map(ledgers.map((l) => [l.ledger_index, { ledger: l, nextCloseTime: null }]));
    const cast = [{ address: A, label: 'Ay' }, { address: B, label: 'Bee' }];
    const plain = frameFromScore(scoreOf(ledgers), { cast });
    assert.equal(plain.records, null, 'without the ledgers there is no record to check');
    const frame = frameFromScore(scoreOf(ledgers), { cast, ledgers: map });
    assert.equal(frame.records.length, ledgers.reduce((n, l) => n + l.transactions.length, 0), 'every transaction of the window, the failed one included');
    const report = coherence(frame);
    const pair = report.pairs[0];
    assert.equal(pair.judged, true);
    assert.deepEqual([pair.record.count, pair.record.failed, pair.record.byKind], [5, 1, { destination: 5, crossed: 0, entry: 0, line: 0 }], 'four payments from A to B and the failed one from B to A');
    assert.deepEqual(pair.record.transactions.map((t) => [t.ledgerIndex, t.by, t.success]), [[2000, A, true], [2005, A, true], [2007, B, false], [2010, A, true], [2015, A, true]]);
    const text = readout(report);
    assert.match(text, /\nrecord: \d+ transactions of the window’s ledgers \(failed included\) · pairs tested: 1 · above the 95th of their shuffles: raw 0, prewhitened 0 · chance alone gives about 0\.0 of 0 · 1 pair with fewer than 20 shifts, where the 95th cannot be resolved\n/);
    assert.match(text, / · events \d+\/\d+ · connected in the record: 5 transactions \(5 destination; 1 failed\)/);
    const lines = text.split('\n');
    assert.equal(lines.at(-1), `  record: ${H(200001)} (#2000, by Ay: the other is the Destination); ${H(200501)} (#2005, by Ay: the other is the Destination); ${H(200708)} (#2007, by Bee: the other is the Destination, failed); ${H(201001)} (#2010, by Ay: the other is the Destination); ${H(201501)} (#2015, by Ay: the other is the Destination)`);
    assert.deepEqual(pairDetailLines(pair, { maxHashes: 2 }), [`  record: ${H(200001)} (#2000, by Ay: the other is the Destination); ${H(200501)} (#2005, by Ay: the other is the Destination); and 3 more`]);
    assert.match(readout(coherence(frame, { maxHashes: 2 })), /; and 3 more$/);
    assert.deepEqual(pairDetailLines({ record: { count: 0 } }), []);
  });

  test('a high prewhitened r with no connection is co-activity, not a relation; with a connection it is said as connected', () => {
    const a = train(40, 11);
    const lagged = a.map((_, t) => (t >= 2 ? a[t - 2] : 0));
    const ledgers = Array.from({ length: 40 }, (_, i) => ledgerOf(3000 + i, { ownA: a[i], ownB: lagged[i] }));
    const map = new Map(ledgers.map((l) => [l.ledger_index, { ledger: l, nextCloseTime: null }]));
    const cast = [{ address: A, label: 'A' }, { address: B, label: 'B' }];
    const frame = frameFromScore(scoreOf(ledgers), { cast, ledgers: map });
    const pair = coherence(frame).pairs[0];
    assert.ok(significant(pair), 'the lagged copy is above the 95th');
    assert.equal(pair.record.count, 0);
    assert.match(describePair(pair), / · events \d+\/\d+ · co-activity, not a relation: not connected in this window$/);
    const touched = ledgers.map((l, i) => (i === 9 ? ledgerOf(3009, { ownA: a[9] - 1, ownB: lagged[9], pay: 1 }) : l));
    const connected = coherence(frameFromScore(scoreOf(touched), { cast, ledgers: new Map(touched.map((l) => [l.ledger_index, { ledger: l, nextCloseTime: null }])) })).pairs[0];
    assert.equal(connected.record.count, 1);
    assert.match(describePair(connected), / · connected in the record: 1 transaction \(1 destination\)$/);
    assert.equal(describePair(connected).includes('co-activity'), false);
    // a pair below the 95th and not connected is simply not connected
    const noise = coherence(frameFromScore(scoreOf(ledgers.map((l, i) => ledgerOf(3100 + i, { ownA: train(40, 21)[i], ownB: train(40, 22)[i] }))), { cast, ledgers: new Map(ledgers.map((l, i) => [3100 + i, { ledger: ledgerOf(3100 + i, { ownA: train(40, 21)[i], ownB: train(40, 22)[i] }), nextCloseTime: null }])) })).pairs[0];
    if (!significant(noise)) assert.match(describePair(noise), / · events \d+\/\d+ · not connected in this window$/);
  });
});

describe('coherence: frames', () => {
  const fakeScore = ({ ledgers, events }) => ({
    ledgers: ledgers.map((l) => ({ ledgerIndex: l.index, missing: Boolean(l.missing), hash: l.hash ?? null })),
    events: events.map((e, n) => ({ n, ledgerIndex: e.ledger, hash: e.hash ?? `H${n}`, event: { account: e.account, amount: e.xrp != null ? { currency: 'XRP', isXrp: true, value: e.xrp } : e.iou != null ? { currency: 'USD', isXrp: false, value: e.iou } : null } })),
  });

  test('from a score: one row per ledger in play order, the cast or the top submitters, counts or log volume', () => {
    const score = fakeScore({
      ledgers: [{ index: 10 }, { index: 11, missing: true }, { index: 12 }, { index: 20 }],
      events: [
        { ledger: 10, account: A, xrp: 9 },
        { ledger: 10, account: A, xrp: 99 },
        { ledger: 10, account: B, iou: 5 },
        { ledger: 11, account: A, xrp: 1 }, // in a missing ledger: never counted
        { ledger: 12, account: B, xrp: 0.5 },
        { ledger: 20, account: C },
        { ledger: 20, account: A },
        { ledger: 99, account: A }, // not in the score's ledgers
      ],
    });
    const f = frameFromScore(score, { cast: [{ address: B, label: 'Bee' }, { address: A, label: 'Ay' }] });
    assert.equal(f.source, 'score');
    assert.deepEqual(f.ledgers.map((l) => [l.index, l.included, l.reason]), [[10, true, null], [11, false, 'missing'], [12, true, null], [20, true, null]]);
    assert.deepEqual(f.accounts, [{ address: B, label: 'Bee' }, { address: A, label: 'Ay' }], 'the cast, in cast order');
    assert.deepEqual(f.series.get(A), [2, 0, 0, 1]);
    assert.deepEqual(f.series.get(B), [1, 0, 1, 0]);
    assert.equal(f.totals.get(A), 3);
    assert.equal(f.totals.get(C), 1);
    assert.equal(f.chosen, 'cast');
    const top = frameFromScore(score, { topK: 2 });
    assert.deepEqual(top.accounts.map((a) => a.address), [A, B], 'no cast: the top submitters by events over the ledgers used');
    assert.equal(top.chosen, 'top 2 submitters');
    assert.deepEqual(top.accounts.map((a) => a.label), [shortAddress(A), shortAddress(B)]);
    const vol = frameFromScore(score, { cast: [{ address: A, label: 'Ay' }], measure: 'volume' });
    assert.ok(Math.abs(vol.series.get(A)[0] - (Math.log10(10) + Math.log10(100))) < 1e-12, 'log volume: log10(1 + XRP) summed');
    assert.deepEqual(vol.series.get(A).slice(1), [0, 0, 0], 'an event without an XRP amount adds nothing');
    assert.equal(logVolume({ amount: { isXrp: false, value: 1e6 } }), 0);
    assert.equal(logVolume(null), 0);
    assert.deepEqual(frameFromScore(null).ledgers, []);
    assert.deepEqual(accountsFor([], new Map([[A, 0]])), [], 'an account with no events is not a top submitter');
  });

  test('from the live window: a ledger is used only when every transaction was received; submitters are counted once each', () => {
    const w = new LiveWindow();
    const closed = (index, txn_count) => ({ type: 'ledgerClosed', ledger_index: index, ledger_hash: 'A'.repeat(64), ledger_time: 800000000 + index, txn_count });
    const tx = (index, account, hash, amount = '2000000') => ({ type: 'transaction', transaction: { Account: account, TransactionType: 'Payment', Destination: C, Amount: amount, hash }, meta: { TransactionResult: 'tesSUCCESS' }, hash, ledger_index: index, validated: true });
    w.noteTransaction(tx(500, A, '1'.repeat(64)));
    w.noteTransaction(tx(500, A, '1'.repeat(64))); // delivered twice: counted once
    w.noteTransaction(tx(500, B, '2'.repeat(64)));
    w.noteLedger(closed(500, 2));
    w.noteTransaction(tx(501, A, '3'.repeat(64)));
    w.noteLedger(closed(501, 5)); // three never arrived
    w.noteTransaction(tx(502, B, '4'.repeat(64)));
    w.noteLedger({ type: 'ledgerClosed', ledger_index: 502, ledger_hash: 'B'.repeat(64) }); // no txn_count
    w.noteTransaction(tx(503, A, '5'.repeat(64), '0'));
    w.noteTransaction(tx(503, B, '6'.repeat(64)));
    w.noteLedger(closed(503, 2));
    assert.deepEqual(w.ledgers[0].accounts, { [A]: { count: 1, volume: Math.log10(3) }, [B]: { count: 1, volume: Math.log10(3) } });
    const f = frameFromLive(w, { cast: [{ address: A, label: 'A' }, { address: B, label: 'B' }] });
    assert.equal(f.source, 'live');
    assert.deepEqual(f.ledgers.map((l) => [l.index, l.included, l.reason, l.received, l.expected]), [[500, true, null, 2, 2], [501, false, 'incomplete', 1, 5], [502, false, 'unknown', 1, null], [503, true, null, 2, 2]]);
    assert.deepEqual(f.series.get(A), [1, 0, 0, 1], 'nothing is counted for a ledger not used');
    assert.deepEqual(f.series.get(B), [1, 0, 0, 1]);
    assert.equal(f.totals.get(A), 2);
    const report = coherence(f, { minLedgers: 2, minEvents: 1 });
    assert.match(readout(report), /^coherence v3 · live window #500–#503 · 2 of 4 ledgers used \(excluded: 1 not fully received \(received < txn_count\), 1 transaction count unknown\)/);
    assert.match(readout(report), /counted as the stream delivered them/);
    assert.equal(f.records.length, 4, 'the touch records of the ledgers used, kept by the window');
    assert.ok(f.records.every((t) => t.destination === C));
    assert.equal(report.pairs[0].record.count, 0, 'both paid C; neither touched the other');
    assert.match(readout(report), /record: 4 transactions heard in the ledgers used · pairs tested: 0 · above the 95th of their shuffles: raw 0, prewhitened 0 · chance alone gives about 0\.0 of 0$/m, 'two ledgers leave no shift beyond the lags: judged, with no null, so not counted as tested');
    assert.match(readout(report), / · not connected in this window/);
    assert.equal(frameFromLive(w.ledgers.map((l) => ({ ...l, touches: undefined }))).records, null, 'a window without touch records has no record to check');
    assert.deepEqual(frameFromLive(new LiveWindow()).ledgers, []);
  });
});

describe('coherence: the report and its readout', () => {
  test('pairs are ranked by the prewhitened |r| behind the guard; the header states the window, the series, the accounts, the settings, the record, the pairs tested and the tier', () => {
    const a = train(40, 11);
    const lagged = a.map((_, t) => (t >= 2 ? a[t - 2] : 0));
    const frame = frameOf({ [A]: a, [B]: lagged, [C]: train(40, 12) }, { labels: { [A]: 'A', [B]: 'B', [C]: 'C' } });
    const report = coherence(frame);
    assert.equal(report.pairs.length, 3);
    assert.deepEqual(report.pairs[0].a.label + report.pairs[0].b.label, 'AB', 'the lagged copy ranks first');
    assert.equal(report.pairs[0].lag, 2);
    assert.ok(report.pairs.every((p, i) => i === 0 || Math.abs(p.white.r) <= Math.abs(report.pairs[i - 1].white.r)), 'ranked by the prewhitened r');
    assert.equal(report.tested, 3);
    assert.ok(report.pairs.every((p) => p.tested === 3));
    assert.ok(Math.abs(report.above.expected - 0.15) < 1e-9, 'three pairs at the 95th: chance gives 0.15 of them');
    assert.equal(report.above.white >= 1, true, 'the lagged copy is above the 95th after prewhitening');
    assert.deepEqual(report.accounts.map((x) => x.events), [a.reduce((x, y) => x + y, 0), lagged.reduce((x, y) => x + y, 0), frame.totals.get(C)]);
    const text = readout(report);
    const lines = text.split('\n');
    assert.equal(lines[0], 'coherence v3 · case #1000–#1039 · 40 of 40 ledgers used');
    assert.equal(lines[1], 'series: transactions submitted per ledger, from the score (events selected by the listening settings) · accounts: cast · lags ±8 ledgers · guard ≥12 ledgers, ≥10 events each · null: up to 200 circular shifts beyond ±8, seed 1337, on the raw series and on the residuals · prewhitening: each series less its own AR fit (Burg, order by AICc up to 8); pairs ranked by the prewhitened r · parts of ≥24 ledgers for inspection');
    const cadenceText = (x) => (x.cadence ? `, cadence ${x.cadence.period} ledgers (self-correlation ${x.cadence.r.toFixed(2)})` : '');
    assert.equal(lines[2], `accounts: ${report.accounts.map((x) => `${x.label} = ${x.address} (${x.events} events${cadenceText(x)}, AR(${x.ar}))`).join('; ')}`);
    assert.ok(report.accounts.every((x) => Number.isInteger(x.ar) && x.ar >= 0 && x.ar <= 8));
    assert.match(lines[3], /^record: not available · pairs tested: 3 · above the 95th of their shuffles: raw \d, prewhitened \d · chance alone gives about 0\.2 of 3$/);
    assert.deepEqual([report.above.resolved, report.above.unresolved, report.above.minShuffles], [3, 0, 20]);
    const few = coherence(frameOf({ [A]: train(20, 31), [B]: train(20, 32) }), { minEvents: 1 });
    assert.deepEqual([few.tested, few.pairs[0].shuffle.count, few.above.resolved, few.above.unresolved], [1, 9, 0, 1], '20 ledgers leave 9 shifts: tested, but the 95th cannot be resolved');
    assert.match(readout(few), /pairs tested: 1 · above the 95th of their shuffles: raw 0, prewhitened 0 · chance alone gives about 0\.0 of 0 · 1 pair with fewer than 20 shifts, where the 95th cannot be resolved$/m);
    assert.equal(significant(few.pairs[0]), false);
    assert.deepEqual(report.accounts.map((x) => x.events), [a.reduce((x, y) => x + y, 0), lagged.reduce((x, y) => x + y, 0), frame.totals.get(C)]);
    assert.equal(report.maxLag, 8);
    const short = coherence(frameOf({ [A]: train(14, 31), [B]: train(14, 32) }), { minLedgers: 12, minEvents: 1 });
    assert.equal(short.maxLag, 3, 'a quarter of 14 ledgers');
    assert.match(readout(short), /lags ±3 ledgers \(a quarter of the 14 used; the option is ±8\)/);
    assert.equal(short.pairs[0].shuffle.available, 14 - 2 * 3 - 1);
    assert.equal(lines[4], 'tier observation: a correlation at a lag is what these series show; coordination or common ownership would be a hypothesis and is not stated here.');
    assert.equal(lines.length, 8);
    assert.match(lines[5], /^A ↔ B: prewhitened r 0\.\d\d at lag \+2 \(B follows A by 2 ledgers\) above \d+% of shuffles \(\d+ of \d+; 3 pairs tested\) · raw r 0\.\d\d at lag \+2 above \d+% of shuffles \(\d+ of 23; 3 pairs tested\) · 40 ledgers \(overlap 38; \d+ residual rows after AR\(\d\)\/AR\(\d\), overlap \d+\) · events \d+\/\d+ · record not available/);
    assert.equal(readout(coherence(frameOf({ [A]: a }))).split('\n').at(-1), 'no pair: fewer than two accounts to compare');
    assert.equal(readout(null), '');
    assert.equal(readout(coherence(frame, { measure: 'volume' })).includes('transactions submitted per ledger'), true, 'the measure named is the frame’s, not the option’s');
    const volFrame = { ...frame, measure: 'volume' };
    assert.match(readout(coherence(volFrame)), /series: log volume per ledger/);
  });
});

describe('coherence: the checked-in cases', () => {
  test('the recorded moment (one ledger) is below the guard and says so', () => {
    const full = fixture('describe/ledger-107811677').result.ledger;
    const nextClose = Number(fixture('describe/ledger-107811678-header').result.ledger.close_time);
    const theCase = validateCase(fixture('describe/moment-107811677.sonic-case')).case;
    const score = buildScore(theCase, new Map([[Number(full.ledger_index), { ledger: full, nextCloseTime: nextClose }]]));
    const frame = frameFromScore(score, { cast: theCase.cast });
    assert.deepEqual(frame.accounts.map((x) => x.label), ['Maker', 'Taker']);
    assert.ok(frame.totals.get(theCase.cast[0].address) > 0);
    const report = coherence(frame);
    assert.equal(report.pairs.length, 1);
    assert.equal(report.pairs[0].judged, false);
    assert.equal(report.pairs[0].reason, '1 ledger used (guard ≥ 12)');
    assert.equal(readout(report).split('\n').at(-1), 'Maker ↔ Taker: not judged: 1 ledger used (guard ≥ 12)');
  });

  // Two 50-ledger mainnet windows recorded as derived series (test/fixtures/coherence/):
  // the numbers here are the as-built tables of docs/coherence.md.
  const windowFixture = (name) => JSON.parse(readFileSync(join(fixturesDir, 'coherence', `${name}.json`), 'utf8'));
  function frameFromFixture(fx, { measure = 'count', topK = DEFAULTS.topK } = {}) {
    const ledgers = fx.ledgers.map((l) => ({ index: l.index, included: !l.missing, reason: l.missing ? 'missing' : null, hash: l.hash }));
    const totals = new Map(fx.accounts.map((x) => [x.address, x.counts.reduce((s, v, i) => s + (ledgers[i].included ? v : 0), 0)]));
    const accounts = accountsFor(fx.case.cast ?? [], totals, { topK });
    const series = new Map(accounts.map((x) => [x.address, fx.accounts.find((y) => y.address === x.address)[measure === 'volume' ? 'volumes' : 'counts']]));
    return { source: 'score', measure, ledgers, accounts, series, totals, chosen: fx.case.cast?.length ? 'cast' : `top ${topK} submitters` };
  }
  const row = (p) => [p.a.label, p.b.label, Number(p.r.toFixed(2)), p.lag, p.n, p.overlap, p.a.events, p.b.events, p.shuffle.above, p.shuffle.count];
  /** The phase 1.5 shape: raw r, lag and null; prewhitened r, lag and null; the AR orders; the residual rows. */
  const wrow = (p) => [p.a.label, p.b.label, Number(p.r.toFixed(2)), p.lag, p.shuffle.above, p.shuffle.count, Number(p.white.r.toFixed(2)), p.white.lag, p.white.shuffle.above, p.white.shuffle.count, p.white.ar.a, p.white.ar.b, p.white.n];
  const byLabels = (pairs, a, b) => pairs.find((p) => p.a.label === a && p.b.label === b);

  test('the 50 ledgers around the sample case, with its cast: the two busiest senders are not coherent, and Sender A has a three-ledger cadence', () => {
    const fx = windowFixture('window-107777790-107777839');
    assert.equal(fx.ledgers.length, 50);
    assert.ok(fx.ledgers.every((l) => /^[0-9A-F]{64}$/.test(l.hash) && !l.missing), 'every ledger fetched, with its hash');
    const count = coherence(frameFromFixture(fx));
    assert.equal(count.window.used, 50);
    assert.deepEqual(count.accounts.map((x) => [x.label, x.events, x.cadence?.period ?? null, x.cadence ? Number(x.cadence.r.toFixed(2)) : null]), [['Sender A', 847, 3, 0.96], ['Sender B', 53, null, null]]);
    assert.deepEqual(count.pairs.map(row), [['Sender A', 'Sender B', 0.19, -3, 50, 47, 847, 53, 20, 33]]);
    // prewhitened: Sender A's three-ledger cadence is an AR(2) (a zero-mean series that repeats every three ledgers satisfies z_t = −z_{t−1} − z_{t−2}); what is left correlates at −0.51 at lag +7, above 24 of 31 shuffles: not significant
    assert.deepEqual(count.pairs.map(wrow), [['Sender A', 'Sender B', 0.19, -3, 20, 33, -0.51, 7, 24, 31, 2, 1, 48]]);
    assert.deepEqual(count.accounts.map((x) => x.ar), [2, 1]);
    assert.deepEqual([count.tested, count.above.raw, count.above.white], [1, 0, 0]);
    assert.deepEqual(count.pairs[0].cadence, { a: { period: 3, r: count.pairs[0].cadence.a.r }, b: null }, 'Sender A keeps a three-ledger cadence; Sender B has none');
    assert.equal(count.pairs[0].beat, null, 'no beat without a cadence on both sides');
    const volume = coherence(frameFromFixture(fx, { measure: 'volume' }));
    assert.deepEqual(volume.pairs.map(row), [['Sender A', 'Sender B', -0.19, 7, 50, 43, 847, 53, 17, 33]]);
    assert.deepEqual(volume.pairs.map(wrow), [['Sender A', 'Sender B', -0.19, 7, 17, 33, -0.52, 7, 24, 31, 2, 1, 48]]);
    assert.equal(describePair(count.pairs[0]), 'Sender A ↔ Sender B: prewhitened r -0.51 at lag +7 (Sender B follows Sender A by 7 ledgers) above 77% of shuffles (24 of 31; 1 pair tested) · raw r 0.19 at lag -3 above 61% of shuffles (20 of 33; 1 pair tested) · 50 ledgers (overlap 47; 48 residual rows after AR(2)/AR(1), overlap 41) · events 847/53 · record not available · 2 parts of 25: lag +7 (r -0.27), -1 (r -0.12)');
  });

  test('a recent 50-ledger window with the top five submitters: two pairs above the raw null, none after prewhitening, most pairs noise, and the volume measure has a flat account', () => {
    const fx = windowFixture('window-107822030-107822079');
    assert.equal(fx.ledgers.length, 50);
    const count = coherence(frameFromFixture(fx));
    assert.equal(count.chosen, 'top 5 submitters');
    assert.deepEqual(count.accounts.map((x) => x.events), [826, 182, 139, 135, 114]);
    assert.deepEqual(count.accounts[0].cadence, { period: 3, r: count.accounts[0].cadence.r });
    assert.ok(Math.abs(count.accounts[0].cadence.r - 0.66) < 0.005);
    assert.equal(count.pairs.length, 10);
    // the phase 1 raw numbers, unchanged, found by label since the ranking is now by the prewhitened r
    assert.deepEqual([['rBTw…jjah', 'rEqY…NLNF'], ['rBTw…jjah', 'rLCN…Ujm5'], ['rMsX…xgfY', 'rURt…bKns'], ['rLCN…Ujm5', 'rEqY…NLNF']].map(([a, b]) => row(byLabels(count.pairs, a, b))), [
      ['rBTw…jjah', 'rEqY…NLNF', 0.42, 1, 50, 49, 826, 135, 32, 33],
      ['rBTw…jjah', 'rLCN…Ujm5', -0.37, -8, 50, 42, 826, 139, 25, 33],
      ['rMsX…xgfY', 'rURt…bKns', 0.36, 0, 50, 50, 182, 114, 33, 33],
      ['rLCN…Ujm5', 'rEqY…NLNF', 0.36, -5, 50, 45, 139, 135, 31, 33],
    ]);
    // phase 1.5: the two pairs above the raw null (0.42 at +1 above 32 of 33; 0.36 in step above 33 of 33) fall to 19 of 29 and 18 of 32 once each series is prewhitened; nothing is above the 95th
    assert.deepEqual(count.accounts.map((x) => x.ar), [4, 0, 2, 0, 1], 'the market maker takes an AR(4); two accounts are white already');
    assert.deepEqual([count.tested, count.above.raw, count.above.white, count.above.expected], [10, 2, 0, 0.5000000000000004]);
    assert.deepEqual(count.pairs.map(wrow), [
      ['rBTw…jjah', 'rLCN…Ujm5', -0.37, -8, 25, 33, -0.38, -2, 22, 29, 4, 2, 46],
      ['rLCN…Ujm5', 'rEqY…NLNF', 0.36, -5, 31, 33, 0.38, -5, 26, 31, 2, 0, 48],
      ['rMsX…xgfY', 'rLCN…Ujm5', 0.32, -8, 17, 33, 0.34, -8, 17, 31, 0, 2, 48],
      ['rBTw…jjah', 'rMsX…xgfY', 0.31, -1, 11, 33, -0.34, 8, 22, 29, 4, 0, 46],
      ['rBTw…jjah', 'rEqY…NLNF', 0.42, 1, 32, 33, -0.34, 2, 19, 29, 4, 0, 46],
      ['rMsX…xgfY', 'rURt…bKns', 0.36, 0, 33, 33, 0.31, 0, 18, 32, 0, 1, 49],
      ['rBTw…jjah', 'rURt…bKns', 0.18, 1, 2, 33, -0.31, 8, 13, 29, 4, 1, 46],
      ['rLCN…Ujm5', 'rURt…bKns', -0.27, 0, 1, 33, -0.3, 0, 8, 31, 2, 1, 48],
      ['rMsX…xgfY', 'rEqY…NLNF', 0.27, 2, 20, 33, 0.27, 2, 20, 33, 0, 0, 50],
      ['rEqY…NLNF', 'rURt…bKns', -0.22, -1, 7, 33, 0.21, 6, 6, 32, 0, 1, 49],
    ]);
    assert.ok(count.pairs.every((p) => !significant(p)));
    assert.equal(describePair(count.pairs[0]), 'rBTw…jjah ↔ rLCN…Ujm5: prewhitened r -0.38 at lag -2 (rBTw…jjah follows rLCN…Ujm5 by 2 ledgers) above 76% of shuffles (22 of 29; 10 pairs tested) · raw r -0.37 at lag -8 above 76% of shuffles (25 of 33; 10 pairs tested) · 50 ledgers (overlap 42; 46 residual rows after AR(4)/AR(2), overlap 44) · events 826/139 · record not available · 2 parts of 25: lag -7 (r -0.44), -6 (r 0.46)');
    assert.ok(count.pairs.every((p) => p.beat === null), 'only one account has a cadence, so no pair has a beat');
    assert.ok(count.pairs.every((p) => p.subWindows.length === 2 && p.subWindows.every((s) => Math.abs(s.r) <= 0.7)), 'the parts’ peaks stay within what noise reaches');
    assert.ok(count.pairs.every((p) => Math.abs(p.r) <= 0.42));
    const volume = coherence(frameFromFixture(fx, { measure: 'volume' }));
    const flat = volume.pairs.filter((p) => p.flat?.a || p.flat?.b);
    assert.equal(flat.length, 4);
    assert.ok(flat.every((p) => p.reason === 'rMsX…xgfY is flat'));
    assert.match(describePair(flat[0]), /the same XRP volume in every ledger used, which for an account that moves no XRP is none/);
    assert.deepEqual(row(byLabels(volume.pairs, 'rBTw…jjah', 'rLCN…Ujm5')), ['rBTw…jjah', 'rLCN…Ujm5', 0.42, -6, 50, 44, 826, 139, 21, 33]);
    assert.deepEqual(wrow(volume.pairs[0]), ['rEqY…NLNF', 'rURt…bKns', 0.33, 8, 23, 33, 0.33, 8, 23, 33, 0, 0, 50], 'two white series: raw and prewhitened are the same numbers');
    assert.deepEqual(volume.accounts.map((x) => x.ar), [4, null, 2, 0, 0], 'a flat account has no fit');
    assert.deepEqual([volume.tested, volume.above.raw, volume.above.white], [6, 0, 0]);
    assert.ok(volume.pairs.every((p) => p.beat === null));
  });
});

describe('coherence: bins and the two defects (phase 2)', () => {
  /** A frame with close times four seconds apart from a minute boundary, so every fifteen ledgers make a minute. */
  function timedFrame(series, { missing = [], labels = {}, start = 1_700_000_040 } = {}) {
    const f = frameOf(series, { missing, labels });
    f.ledgers.forEach((l, i) => (l.closeTime = start + i * 4));
    return f;
  }

  test('close times: known rows as they are, a row between dated neighbours in proportion, the ends at the dated span’s mean interval', () => {
    assert.deepEqual(interpolateCloseTimes([100, null, null, 112], [10, 11, 12, 13]), [100, 104, 108, 112]);
    assert.deepEqual(interpolateCloseTimes([null, 100, null, 108, null], [1, 2, 3, 4, 6]), [96, 100, 104, 108, 116], 'four seconds per ledger from the dated span; the last row is two ledgers on');
    assert.deepEqual(interpolateCloseTimes([null, 100, null], [5, 6, 7]), [100 - ASSUMED_CLOSE_SECONDS, 100, 100 + ASSUMED_CLOSE_SECONDS], 'one date: the assumed interval');
    assert.deepEqual(interpolateCloseTimes([null, null], [1, 2]), [null, null], 'no date at all');
    assert.deepEqual(BIN_NAMES, ['ledger', 'minute', 'hour', 'day']);
    assert.deepEqual(BINS, { ledger: 0, minute: 60, hour: 3600, day: 86400 });
  });

  test('a frame in bins of one minute: fifteen ledgers each, the series summed, a missing ledger excludes its bin, an empty minute is absent', () => {
    const a = train(120, 21);
    const b = train(120, 22);
    const f = timedFrame({ [A]: a, [B]: b }, { missing: [20], labels: { [A]: 'A', [B]: 'B' } });
    const m = binFrame(f, 'minute');
    assert.equal(m.unit, 'minute');
    assert.deepEqual(m.bin, { unit: 'minute', seconds: 60, ledgers: 120, bins: 8, error: null });
    assert.deepEqual(m.ledgers.map((l) => [l.index, l.included, l.reason, l.from, l.to, l.ledgers]), [[0, true, null, 1000, 1014, 15], [1, false, 'missing', 1015, 1029, 15], [2, true, null, 1030, 1044, 15], [3, true, null, 1045, 1059, 15], [4, true, null, 1060, 1074, 15], [5, true, null, 1075, 1089, 15], [6, true, null, 1090, 1104, 15], [7, true, null, 1105, 1119, 15]]);
    assert.equal(m.series.get(A)[0], a.slice(0, 15).reduce((x, y) => x + y, 0));
    assert.equal(m.series.get(A)[1], 0, 'nothing is counted for a bin not used');
    assert.equal(m.totals.get(A), a.reduce((x, y, i) => x + (i >= 15 && i < 30 ? 0 : y), 0), 'the totals are over the bins used');
    assert.equal(m.records, f.records, 'the records are the ledgers’, unchanged');
    assert.equal(binFrame(f, 'ledger'), f, 'per ledger is the frame itself');
    assert.equal(binFrame(m, 'hour'), m, 'a binned frame is not binned again');
    // a gap in time is a gap in position: ledgers 60.. close ten minutes later
    const g = timedFrame({ [A]: a, [B]: b }, { labels: { [A]: 'A', [B]: 'B' } });
    g.ledgers.forEach((l, i) => (l.closeTime = 1_700_000_040 + i * 4 + (i >= 60 ? 600 : 0)));
    const gm = binFrame(g, 'minute');
    assert.deepEqual(gm.ledgers.map((l) => l.index), [0, 1, 2, 3, 14, 15, 16, 17], 'ten empty minutes are absent, never zero');
    const undated = frameOf({ [A]: a, [B]: b });
    const u = binFrame(undated, 'minute');
    assert.equal(u.unit, 'ledger');
    assert.equal(u.bin.error, 'no close time is known for any ledger of the window');
  });

  test('coherence in bins: the lags, the guard, the parts and every line count in the unit, and the header says how many ledgers the bins hold', () => {
    const a = train(300, 23);
    const f = timedFrame({ [A]: a, [B]: a.slice() }, { labels: { [A]: 'A', [B]: 'B' } });
    const report = coherence(f, { bin: 'minute' });
    assert.equal(report.unit, 'minute');
    assert.deepEqual(report.window, { from: 1000, to: 1299, ledgers: 20, used: 20, excluded: {}, ledgerCount: 300 });
    assert.equal(report.maxLag, 5, 'a quarter of twenty minutes');
    const lines = readout(report).split('\n');
    assert.equal(lines[0], 'coherence v3 · case #1000–#1299 · 20 of 20 minutes used (300 ledgers in bins of one minute, UTC)');
    assert.match(lines[1], /^series: transactions submitted per minute, from the score .* · lags ±5 minutes \(a quarter of the 20 used; the option is ±8\) · guard ≥12 minutes, ≥10 events each · .* · parts of ≥15 minutes for inspection$/);
    const p = report.pairs[0];
    assert.equal(p.unit, 'minute');
    assert.match(describePair(p), /^A ↔ B: prewhitened r 1\.00 at lag 0 \(in step\) above \d+% of shuffles \(\d+ of \d+; 1 pair tested\) · raw r 1\.00 at lag 0 above .* · 20 minutes \(overlap 20; \d+ residual rows after AR\(\d\)\/AR\(\d\), overlap \d+\) · events \d+\/\d+ · record not available/);
    assert.equal(coherence(f).unit, 'ledger', 'the default stays the ledger');
    assert.equal(normalizeOptions({ bin: 'hour' }).bin, 'hour');
    assert.equal(normalizeOptions({ bin: 'fortnight' }).bin, 'ledger');
    const undated = coherence(frameOf({ [A]: a, [B]: a.slice() }, { labels: { [A]: 'A', [B]: 'B' } }), { bin: 'hour' });
    assert.equal(undated.unit, 'ledger');
    assert.match(readout(undated).split('\n')[0], /300 of 300 ledgers used \(bins of one hour: no close time is known for any ledger of the window; read per ledger\)$/);
  });

  test('a part in which a series does not vary reports undefined, not r 1.00', () => {
    const n = 90;
    const a = train(n, 24);
    const b = train(n, 25);
    for (let i = 0; i < 30; i++) b[i] = 0; // the first third of B is silent: on the window's z-scale a constant, not zero
    const f = frameOf({ [A]: a, [B]: b }, { labels: { [A]: 'A', [B]: 'B' } });
    const parts = subWindowLags(z(a), z(b), 8, { parts: 3 });
    assert.equal(parts.length, 3);
    assert.deepEqual([parts[0].r, parts[0].lag, parts[0].flat, parts[0].reason, parts[0].overlap], [null, null, true, 'no variance', 0]);
    assert.ok(parts[1].lag != null && parts[2].lag != null);
    const report = coherence(f);
    assert.match(describePair(report.pairs[0]), / · 3 parts of 30: lag undefined \(no variance\), [+-]?\d+ \(r -?\d\.\d\d\), [+-]?\d+ \(r -?\d\.\d\d\)/);
    assert.doesNotMatch(describePair(report.pairs[0]), /r 1\.00/);
  });
});

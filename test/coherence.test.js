// Coherence, phase 1: the statistic and its readout. Synthetic trains with
// planted answers (lockstep, lagged, uncorrelated, always-on, a cadence
// mismatch, missing ledgers), the frames from a score and from the live
// window, the readout wording, and the checked-in real cases.

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
  followText,
  beatOf,
  logVolume,
  normalizeOptions,
  DEFAULTS,
  EXCLUSIONS,
  COHERENCE_VERSION,
  TIER,
} from '../src/coherence.js';
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
    assert.match(line, /^A ↔ B: r -?\d\.\d\d at lag [+-]?\d+ \((B follows A by \d+ ledgers?|A follows B by \d+ ledgers?|in step)\) · 50 ledgers \(overlap \d+\) · events \d+\/\d+ · above \d+% of shuffles \(\d+ of 33\) · 2 parts of 25: lag [+-]?\d+ \(r -?\d\.\d\d\), [+-]?\d+ \(r -?\d\.\d\d\)/);
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
    assert.equal(describePair(pair), 'Always ↔ Busy: no coherence: Always is flat (the same count in every ledger used) · 40 ledgers · events 200/' + busy.reduce((x, y) => x + y, 0));
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
    assert.match(readout(report), /Seven = \S+ \(\d+ events, cadence 7 ledgers \(self-correlation \d\.\d\d\)\)/);
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
    assert.deepEqual(report.window, { from: 1000, to: 1019, ledgers: 20, used: 18, excluded: { missing: 2 } });
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
    assert.equal(COHERENCE_VERSION, 1);
    assert.equal(TIER, 'observation');
    assert.deepEqual(Object.keys(EXCLUSIONS), ['missing', 'incomplete', 'unknown']);
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
    assert.match(readout(report), /^coherence v1 · live window #500–#503 · 2 of 4 ledgers used \(excluded: 1 not fully received \(received < txn_count\), 1 transaction count unknown\)/);
    assert.match(readout(report), /counted as the stream delivered them/);
    assert.deepEqual(frameFromLive(new LiveWindow()).ledgers, []);
  });
});

describe('coherence: the report and its readout', () => {
  test('pairs are ranked by |r| behind the guard; the header states the window, the series, the accounts, the settings and the tier', () => {
    const a = train(40, 11);
    const lagged = a.map((_, t) => (t >= 2 ? a[t - 2] : 0));
    const frame = frameOf({ [A]: a, [B]: lagged, [C]: train(40, 12) }, { labels: { [A]: 'A', [B]: 'B', [C]: 'C' } });
    const report = coherence(frame);
    assert.equal(report.pairs.length, 3);
    assert.deepEqual(report.pairs[0].a.label + report.pairs[0].b.label, 'AB', 'the lagged copy ranks first');
    assert.equal(report.pairs[0].lag, 2);
    assert.ok(report.pairs.every((p, i) => i === 0 || Math.abs(p.r) <= Math.abs(report.pairs[i - 1].r)));
    assert.deepEqual(report.accounts.map((x) => x.events), [a.reduce((x, y) => x + y, 0), lagged.reduce((x, y) => x + y, 0), frame.totals.get(C)]);
    const text = readout(report);
    const lines = text.split('\n');
    assert.equal(lines[0], 'coherence v1 · case #1000–#1039 · 40 of 40 ledgers used');
    assert.equal(lines[1], 'series: transactions submitted per ledger, from the score (events selected by the listening settings) · accounts: cast · lags ±8 ledgers · guard ≥12 ledgers, ≥10 events each · null: up to 200 circular shifts beyond ±8, seed 1337 · parts of ≥24 ledgers for the drift check');
    const cadenceText = (x) => (x.cadence ? `, cadence ${x.cadence.period} ledgers (self-correlation ${x.cadence.r.toFixed(2)})` : '');
    assert.equal(lines[2], `accounts: ${report.accounts.map((x) => `${x.label} = ${x.address} (${x.events} events${cadenceText(x)})`).join('; ')}`);
    assert.deepEqual(report.accounts.map((x) => x.events), [a.reduce((x, y) => x + y, 0), lagged.reduce((x, y) => x + y, 0), frame.totals.get(C)]);
    assert.equal(report.maxLag, 8);
    const short = coherence(frameOf({ [A]: train(14, 31), [B]: train(14, 32) }), { minLedgers: 12, minEvents: 1 });
    assert.equal(short.maxLag, 3, 'a quarter of 14 ledgers');
    assert.match(readout(short), /lags ±3 ledgers \(a quarter of the 14 used; the option is ±8\)/);
    assert.equal(short.pairs[0].shuffle.available, 14 - 2 * 3 - 1);
    assert.equal(lines[3], 'tier observation: a correlation at a lag is what these series show; coordination or common ownership would be a hypothesis and is not stated here.');
    assert.equal(lines.length, 7);
    assert.match(lines[4], /^A ↔ B: r 0\.\d\d at lag \+2 \(B follows A by 2 ledgers\) · 40 ledgers \(overlap 38\) · events \d+\/\d+ · above \d+% of shuffles \(\d+ of 23\)/);
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

  test('the 50 ledgers around the sample case, with its cast: the two busiest senders are not coherent, and Sender A has a three-ledger cadence', () => {
    const fx = windowFixture('window-107777790-107777839');
    assert.equal(fx.ledgers.length, 50);
    assert.ok(fx.ledgers.every((l) => /^[0-9A-F]{64}$/.test(l.hash) && !l.missing), 'every ledger fetched, with its hash');
    const count = coherence(frameFromFixture(fx));
    assert.equal(count.window.used, 50);
    assert.deepEqual(count.accounts.map((x) => [x.label, x.events, x.cadence?.period ?? null, x.cadence ? Number(x.cadence.r.toFixed(2)) : null]), [['Sender A', 847, 3, 0.96], ['Sender B', 53, null, null]]);
    assert.deepEqual(count.pairs.map(row), [['Sender A', 'Sender B', 0.19, -3, 50, 47, 847, 53, 20, 33]]);
    assert.deepEqual(count.pairs[0].cadence, { a: { period: 3, r: count.pairs[0].cadence.a.r }, b: null }, 'Sender A keeps a three-ledger cadence; Sender B has none');
    assert.equal(count.pairs[0].beat, null, 'no beat without a cadence on both sides');
    const volume = coherence(frameFromFixture(fx, { measure: 'volume' }));
    assert.deepEqual(volume.pairs.map(row), [['Sender A', 'Sender B', -0.19, 7, 50, 43, 847, 53, 17, 33]]);
    assert.equal(describePair(count.pairs[0]), 'Sender A ↔ Sender B: r 0.19 at lag -3 (Sender A follows Sender B by 3 ledgers) · 50 ledgers (overlap 47) · events 847/53 · above 61% of shuffles (20 of 33) · 2 parts of 25: lag +7 (r -0.27), -1 (r -0.12)');
  });

  test('a recent 50-ledger window with the top five submitters: one in-step pair above every shuffle, most pairs noise, and the volume measure has a flat account', () => {
    const fx = windowFixture('window-107822030-107822079');
    assert.equal(fx.ledgers.length, 50);
    const count = coherence(frameFromFixture(fx));
    assert.equal(count.chosen, 'top 5 submitters');
    assert.deepEqual(count.accounts.map((x) => x.events), [826, 182, 139, 135, 114]);
    assert.deepEqual(count.accounts[0].cadence, { period: 3, r: count.accounts[0].cadence.r });
    assert.ok(Math.abs(count.accounts[0].cadence.r - 0.66) < 0.005);
    assert.equal(count.pairs.length, 10);
    assert.deepEqual(count.pairs.slice(0, 4).map(row), [
      ['rBTw…jjah', 'rEqY…NLNF', 0.42, 1, 50, 49, 826, 135, 32, 33],
      ['rBTw…jjah', 'rLCN…Ujm5', -0.37, -8, 50, 42, 826, 139, 25, 33],
      ['rMsX…xgfY', 'rURt…bKns', 0.36, 0, 50, 50, 182, 114, 33, 33],
      ['rLCN…Ujm5', 'rEqY…NLNF', 0.36, -5, 50, 45, 139, 135, 31, 33],
    ]);
    assert.ok(count.pairs.every((p) => p.beat === null), 'only one account has a cadence, so no pair has a beat');
    assert.ok(count.pairs.every((p) => p.subWindows.length === 2 && p.subWindows.every((s) => Math.abs(s.r) <= 0.7)), 'the parts’ peaks stay within what noise reaches');
    assert.ok(count.pairs.every((p) => Math.abs(p.r) <= 0.42));
    const volume = coherence(frameFromFixture(fx, { measure: 'volume' }));
    const flat = volume.pairs.filter((p) => p.flat?.a || p.flat?.b);
    assert.equal(flat.length, 4);
    assert.ok(flat.every((p) => p.reason === 'rMsX…xgfY is flat'));
    assert.match(describePair(flat[0]), /the same XRP volume in every ledger used, which for an account that moves no XRP is none/);
    assert.deepEqual(volume.pairs[0] && row(volume.pairs[0]), ['rBTw…jjah', 'rLCN…Ujm5', 0.42, -6, 50, 44, 826, 139, 21, 33]);
    assert.ok(volume.pairs.every((p) => p.beat === null));
  });
});

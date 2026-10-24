// UNIVERSE phase 3B — the sealed past and its leak test, the ropes (their corrected variance, their windows), the
// wake (the CUSUM calibrated by simulation, false alarms at the stated run length on a no-shift stream through the
// ropes, a planted shift flagged within a stated delay, the change-point posterior).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SealedPast, guard } from '../src/universe/forecast/sealed.js';
import { Rope, RopeBank, HALF_LIVES, alphaOf, wallLabel } from '../src/universe/forecast/ropes.js';
import { Cusum, simulatedArl, thresholdFor, ChangePoint, Wake, standardizedGap, RECENT } from '../src/universe/forecast/wake.js';
import { seededRandom } from '../src/coherence.js';

const normal = (rnd) => Math.sqrt(-2 * Math.log(Math.max(1e-12, rnd()))) * Math.cos(2 * Math.PI * rnd());
const poisson = (rnd, lambda) => {
  if (lambda > 50) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal(rnd)));
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rnd();
  } while (p > L);
  return k - 1;
};

describe('the sealed past', () => {
  const store = new SealedPast();
  for (let i = 1; i <= 20; i++) store.push({ index: 100 + i, count: i * 10, arrivedAt: 1000 * i });
  test('rows arrive in sequence; an older one is ignored', () => {
    assert.equal(store.length, 20);
    assert.equal(store.push({ index: 105, count: 1 }), false);
    assert.equal(store.latest.index, 120);
  });
  test('a view sealed at N reads at or before N and refuses the future', () => {
    const v = store.at(110);
    assert.equal(v.length, 10);
    assert.equal(v.head.index, 110);
    assert.equal(v.row(105).count, 50);
    assert.equal(v.row(99), null, 'a ledger not heard is null, not an error');
    assert.throws(() => v.row(111), /sealed at #110: #111 is the future/);
    assert.deepEqual(
      v.last(3).map((r) => r.index),
      [108, 109, 110],
    );
    assert.deepEqual(v.series((r) => r.count).slice(-2), [90, 100]);
  });
  test('a deliberately leaky feature (N+1’s own count) is caught by the accessor, not by review', () => {
    const leaky = guard('tomorrow’s count', (view) => view.row(view.N + 1).count);
    assert.throws(() => leaky(store.at(110)), /feature "tomorrow’s count" reached past the sealed ledger/);
    const honest = guard('today’s count', (view) => view.row(view.N).count);
    assert.equal(honest(store.at(110)), 100);
  });
  test('the rows are frozen: nothing downstream can edit the past', () => {
    assert.throws(() => {
      store.at(110).row(105).count = 0;
    });
  });
  test('the past is bounded: the oldest rows are dropped and read as not heard', () => {
    const s = new SealedPast({ max: 5 });
    for (let i = 1; i <= 8; i++) s.push({ index: i, count: i });
    assert.equal(s.length, 5);
    assert.equal(s.dropped, 3);
    assert.equal(s.at(8).row(2), null);
    assert.equal(s.at(8).row(4).count, 4);
  });
});

describe('the ropes', () => {
  test('the half-life sets the weight: the mean’s memory halves every h ledgers', () => {
    const r = new Rope(4);
    r.update(0);
    for (let i = 0; i < 4; i++) r.update(1);
    assert.ok(Math.abs(r.mean - 0.5) < 0.03, `after one half-life the mean is halfway: ${r.mean}`);
    assert.ok(Math.abs(alphaOf(1) - 0.5) < 1e-12);
  });
  test('a bank of six, labelled with wall time and windows; a rope longer than the history is forming', () => {
    const b = new RopeBank();
    assert.deepEqual(
      b.ropes.map((r) => r.halfLife),
      [...HALF_LIVES],
    );
    for (let i = 0; i < 40; i++) b.update(100 + (i % 5));
    const r64 = b.rope(64);
    assert.equal(r64.windows(), 0);
    assert.equal(r64.forming, true);
    assert.match(r64.describe(4000), /^h 64 ≈ 4\.3 min · mean 10[0-9](\.\d)? · sd \d+(\.\d+)? · 0 windows · forming$/);
    const r16 = b.rope(16);
    assert.equal(r16.windows(), 2);
    assert.equal(r16.forming, false);
    assert.equal(b.longestFormed().halfLife, 16);
    assert.equal(wallLabel(90000), '1.5 min');
    assert.equal(wallLabel(5000), '5.0 s');
  });
  test('the variance is corrected for its start and for the mean’s own error: a Poisson stream’s rate and spread recovered at every half-life', () => {
    const rnd = seededRandom(21);
    const b = new RopeBank();
    for (let i = 0; i < 4000; i++) b.update(poisson(rnd, 73));
    for (const h of [4, 16, 64, 256]) {
      const r = b.rope(h);
      assert.ok(Math.abs(r.mean - 73) < 4 + 40 / Math.sqrt(h), `h ${h}: mean ${r.mean.toFixed(1)} for λ 73`);
      assert.ok(Math.abs(r.sd - Math.sqrt(73)) / Math.sqrt(73) < (h <= 4 ? 0.45 : 0.25), `h ${h}: sd ${r.sd.toFixed(2)} for √73 = ${Math.sqrt(73).toFixed(2)}`);
    }
    const early = new Rope(64);
    const rnd2 = seededRandom(22);
    for (let i = 0; i < 12; i++) early.update(73 + Math.sqrt(73) * normal(rnd2));
    assert.ok(early.sd > 0.5 * Math.sqrt(73), `twelve observations into a long rope the sd is not collapsed: ${early.sd.toFixed(2)}`);
  });
  test('constant input gives zero variance; alternating input gives the gap’s half', () => {
    const r = new Rope(16);
    for (let i = 0; i < 200; i++) r.update(7);
    assert.ok(r.sd < 1e-9);
    const s = new Rope(16);
    for (let i = 0; i < 400; i++) s.update(i % 2 ? 10 : 0);
    assert.ok(s.sd > 4.5 && s.sd < 5.5, `sd ${s.sd}`);
  });
});

describe('the wake', () => {
  test('the standardized gap is the short mean less the long mean in the long rope’s sd', () => {
    const b = new RopeBank();
    const rnd = seededRandom(1);
    for (let i = 0; i < 300; i++) b.update(100 + 10 * normal(rnd));
    for (let i = 0; i < 8; i++) b.update(160);
    const gap = standardizedGap(b.rope(4), b.rope(64));
    assert.ok(gap > 2, `gap ${gap}`);
  });
  test('the CUSUM threshold is set by simulation for the stated in-control run length, and its false alarms match it', () => {
    const t = thresholdFor(200, { k: 0.5, runs: 400, seed: 3 });
    assert.ok(t.h > 1 && t.h < 10, `h ${t.h}`);
    assert.ok(Math.abs(t.measuredArl - 200) / 200 < 0.2, `measured ARL ${t.measuredArl.toFixed(0)} for 200`);
    const rnd = seededRandom(11);
    const c = new Cusum({ k: t.k, h: t.h });
    let alarms = 0;
    const steps = 40000;
    for (let i = 0; i < steps; i++) if (c.update(normal(rnd))) alarms += 1;
    const observed = steps / Math.max(1, alarms);
    assert.ok(observed > 150 && observed < 270, `observed ARL ${observed.toFixed(0)} for 200 (${alarms} alarms)`);
    assert.equal(simulatedArl(0.5, 100, { runs: 5, maxLen: 500 }), 500, 'an unreachable threshold runs to the cap');
  });
  test('through the ropes, on a no-shift Poisson stream, the wake’s false alarms sit near the stated run length', () => {
    const t = thresholdFor(200, { k: 0.5, runs: 400, seed: 3 });
    const rnd = seededRandom(17);
    const bank = new RopeBank();
    const w = new Wake({ name: 'count', bank, family: 'poisson', threshold: t });
    const steps = 30000;
    for (let i = 0; i < steps; i++) {
      const x = poisson(rnd, 90);
      w.update(x);
      bank.update(x);
    }
    const observed = (steps - 64) / Math.max(1, w.cusum.alarms);
    // estimated means and variances and a discrete count stream move it from the normal ideal; within a factor of 1.6
    assert.ok(observed > 200 / 1.6 && observed < 200 * 1.6, `observed ARL ${observed.toFixed(0)} for 200 (${w.cusum.alarms} alarms, residuals against h ${w.scaleH})`);
    assert.equal(w.scaleH, 1024, 'after 30,000 ledgers the residuals are read against the longest rope');
  });
  test('a planted shift is flagged by the CUSUM and the change-point posterior within a stated delay (25 ledgers)', () => {
    const rnd = seededRandom(5);
    const t = thresholdFor(500, { k: 0.5, runs: 2000, seed: 7 });
    const bank = new RopeBank();
    const w = new Wake({ name: 'count', bank, family: 'poisson', hazard: 1 / 200, threshold: t });
    const shiftAt = 400;
    let firstAlarm = null;
    let cpFlag = null;
    for (let i = 1; i <= 520; i++) {
      const x = poisson(rnd, i <= shiftAt ? 100 : 130); // +3 sd of a Poisson(100)
      const r = w.update(x);
      bank.update(x);
      if (i > shiftAt && firstAlarm == null && r.alarm) firstAlarm = i - shiftAt;
      if (i > shiftAt && cpFlag == null && r.recentChangeProbability > 0.5) cpFlag = i - shiftAt;
    }
    assert.ok(firstAlarm != null && firstAlarm <= 25, `CUSUM delay ${firstAlarm} ledgers`);
    assert.ok(cpFlag != null && cpFlag <= 25, `change-point delay ${cpFlag} ledgers`);
    assert.ok(w.cp.runLength < 130, `run length after the shift ${w.cp.runLength}`);
    assert.match(w.describe(), new RegExp(`^count: gap [+-][\\d.]+ σ \\(h 4 against h 64, on log\\(1 \\+ x\\)\\) · CUSUM [\\d.]+/[\\d.]+ \\(\\d+ alarms?, k 0\\.5, ARL 500 at lag-1 autocorrelation 0\\.\\d, residuals of log\\(1 \\+ x\\) against the h \\d+ rope\\) · run \\d+ ledgers? · P\\(a new run began at this ledger\\) [\\d.]+ · P\\(change within ${RECENT}\\) [\\d.]+ \\(Poisson–Gamma, each ledger's evidence weighed by one over the dispersion [\\d.]+\\)`));
  });
  test('without a shift the change-point posterior keeps a long run and rarely flags', () => {
    const rnd = seededRandom(9);
    const cp = new ChangePoint({ family: 'poisson', hazard: 1 / 200 });
    let flags = 0;
    for (let i = 1; i <= 800; i++) if (cp.update(poisson(rnd, 60)).changed) flags += 1;
    assert.ok(flags <= 6, `${flags} flags in 800 steady ledgers`);
    assert.ok(cp.runLength > 200, `run length ${cp.runLength}`);
  });
  test('the normal family for shares: a planted shift in a share is flagged too', () => {
    const rnd = seededRandom(13);
    const cp = new ChangePoint({ family: 'normal', hazard: 1 / 200, prior: { mu: 0.3, sigma2: 0.0025 } });
    let flagged = null;
    for (let i = 1; i <= 300; i++) {
      const x = (i <= 200 ? 0.3 : 0.5) + 0.05 * normal(rnd);
      const r = cp.update(x);
      if (i > 200 && flagged == null && r.recentChangeProbability > 0.5) flagged = i - 200;
    }
    assert.ok(flagged != null && flagged <= 10, `delay ${flagged}`);
  });
  test('before any rope is formed the wake reads no residual and says so', () => {
    const t = thresholdFor(500, { k: 0.5, runs: 2000, seed: 7 });
    const bank = new RopeBank();
    const w = new Wake({ name: 'count', bank, threshold: t });
    w.update(10);
    bank.update(10);
    assert.equal(w.last.z, 0);
    assert.equal(w.scaleH, null);
    assert.match(w.describe(), new RegExp(`gap — \\(no formed long rope yet\\).*residuals of log\\(1 \\+ x\\) against no formed rope yet.*P\\(change within ${RECENT}\\) — \\(the first ${RECENT} ledgers\\)`));
    assert.equal(w.last.recentChangeProbability, null, 'the first ledgers say nothing about a recent change');
    assert.equal(w.cp.changes.length, 0, 'and flag none');
  });
});

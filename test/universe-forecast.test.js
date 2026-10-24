// UNIVERSE phase 3B — the forecaster as a whole: the readout's words, parity of two runs over the same rows (and of a
// recorded live session's rows, when its fixture is present), the sealed past inside it, a planted shift reaching the
// readout, the loops resolved by their offers, presence from cadence, the nowcast labelled apart and scored, the
// server's heuristic in the nowcast only.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Forecaster } from '../src/universe/forecast/forecaster.js';
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

/** Synthetic finished rows: counts from a rate (optionally shifting or drifting), a type mix, accounts by presence probabilities (one strictly every third ledger), arrival times 4 s apart with jitter, loops and takes when asked, a fee result and a proposed count tied to the count. */
function rows({ n = 200, rate = 80, shift = null, drift = 0, seed = 1, arrivals = true, takesEvery = 0, loopsEvery = 0 } = {}) {
  const rnd = seededRandom(seed);
  const out = [];
  let at = 1_700_000_000_000;
  const accounts = ['rA1', 'rA2', 'rA3', 'rA4', 'rA5'];
  for (let i = 1; i <= n; i++) {
    const lambda = (shift && i >= shift.at ? shift.rate : rate) * (1 + drift * Math.sin(i / 9));
    const count = poisson(rnd, lambda);
    at += 4000 + Math.round(800 * normal(rnd));
    const present = accounts.filter((_, k) => rnd() < [0.9, 0.6, 0.3, 0.1, 0.5][k]);
    if (i % 3 === 0) present.push('rPulse');
    const payment = Math.round(count * 0.4);
    const offer = Math.round(count * 0.5);
    out.push({
      index: 1000 + i,
      arrivedAt: arrivals ? at : null,
      closeTime: 800_000_000 + 4 * i,
      txnCount: count,
      heard: count,
      count,
      types: { payment, offer, batch: count - payment - offer },
      accounts: present.sort(),
      loops: loopsEvery && i % loopsEvery === 0 ? [{ members: 3, edge: 0.01, offers: [`rMaker:${i}`] }] : [],
      takes: takesEvery && i % takesEvery === 0 ? [{ kind: 'self-payment', offers: [`rMaker:${i - 2}`] }] : [],
      fee: { openLedgerFee: 10 + (rnd() < 0.1 ? 5 : 0), queueSize: poisson(rnd, 2), expectedLedgerSize: Math.round(lambda * 0.95), currentLedgerSize: Math.round(count * 0.8), server: 'test-node' },
      proposed: Math.max(0, Math.round(count * 0.9 + 3 * normal(rnd))),
    });
  }
  return out;
}

describe('the forecaster', () => {
  test('the readout: the forecast shown with its interval and held-out record, the baselines and models, the verdict, the split, the ropes, the wake; never "will"', () => {
    const f = new Forecaster();
    let last = null;
    for (const r of rows({ n: 170, seed: 2, takesEvery: 30 })) last = f.push(r);
    const text = last.lines.join('\n');
    assert.match(last.lines[0], /^forecast for ledger #1,171, from 170 closed ledgers \(#1,001–#1,170\) · walk-forward/);
    assert.match(last.lines[1], /^count \(shown: [^)]+\) [\d.]+–[\d.]+ \(80%, (median [\d.]+, )?mean [\d.]+\) · held-out coverage \d+% over \d+ ledgers \(#\d+–#\d+\) · persistence skill [+-]\d\.\d\d · ewma h16 skill [+-]\d\.\d\d$/);
    assert.match(text, /\n {2}persistence [\d.]+–[\d.]+ \(80%, mean [\d.]+\) · held-out coverage \d+% over \d+ ledgers/);
    assert.match(text, /\n {2}hmm [\d.]+–[\d.]+/);
    assert.match(text, /\n {2}hawkes [\d.]+–[\d.]+/);
    assert.match(text, /on the held-out ledgers \(#\d+–#\d+\), (nothing beats persistence|beats persistence: )/);
    assert.match(text, /models chosen on the first 60% of resolved ledgers \(#\d+–#\d+, \d+\), reported on the last 40% \(#\d+–#\d+, \d+\)/);
    assert.match(text, /\d signals tried \(previous count, ewma h4\)/);
    assert.match(text, /type mix \(h 16 rope of each share\): offer 50% \(\d+–\d+\) · payment 40% \(\d+–\d+\)/);
    assert.match(text, /the \d+ most active accounts at #1,171: mean P\(transacts\) 0\.\d\d, from their cadence for \d+/);
    assert.match(text, /close interval in ms \(from local arrival times; never the header close_time\) [\d.]+–[\d.]+ \(80%, mean [\d.]+\) · held-out coverage \d+%/);
    assert.match(text, /wall-clock features: time of day not yet · day of week not yet \(history 11\.\d min over 170 ledgers with arrival times/);
    assert.match(text, /ropes \(count\): h 1 ≈ [\d.]+ s · mean/);
    assert.match(text, /h 1024 ≈ [\d.]+ (min|h) · mean [\d.]+ · sd [\d.]+ · 0 windows · forming/);
    assert.match(text, /wake: count: gap [+-][\d.]+ σ \(h 4 against h \d+, on log\(1 \+ x\)\) · CUSUM/);
    assert.match(text, /CUSUM threshold h [\d.]+ for an in-control run length of 500 ledgers at the residuals' lag-1 autocorrelation 0\.\d \(an AR\(1\) normal law; measured \d+ on 4,000 simulated runs, k 0\.5; h 5\.07 if independent\) · change-point hazard 1\/200 per ledger · a ledger ≈ [\d.]+ s/);
    assert.match(text, /last resolved: #1,170 count \d+ · (inside|outside) the 80% interval shown/);
    assert.match(text, /computed in [\d.]+ ms over 170 rows/);
    assert.doesNotMatch(text, /\bwill\b/);
    assert.doesNotMatch(text, /expected_ledger_size/, 'the server’s heuristic is a nowcast baseline only');
    assert.equal(last.records.persistence.n > 0, true);
  });
  test('parity: two runs over the same rows give identical forecasts at every ledger', () => {
    const data = rows({ n: 120, seed: 3, loopsEvery: 17, takesEvery: 19 });
    const a = new Forecaster();
    const b = new Forecaster();
    for (const r of data) {
      a.push(r);
      b.push(JSON.parse(JSON.stringify(r)));
      assert.equal(a.fingerprint(), b.fingerprint(), `ledger #${r.index}`);
    }
  });
  test('parity with a recorded live session: the rows the live worker read, replayed here, give its forecasts exactly', (t) => {
    const file = new URL('./universe-fixtures/forecast/live-session.json', import.meta.url);
    if (!existsSync(file)) {
      t.skip('no recorded live session yet (bench/capture-forecast-session.mjs writes it)');
      return;
    }
    const s = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(s.rows.length >= 40, `${s.rows.length} rows`);
    const f = new Forecaster({ mode: s.options.mode });
    s.rows.forEach((row, i) => {
      f.push(row);
      assert.equal(f.fingerprint(), s.fingerprints[i], `the forecast after ledger #${row.index} differs from the live worker's`);
    });
  });
  test('without arrival times the close interval is neither forecast nor scored, and the readout says so', () => {
    const f = new Forecaster();
    let last = null;
    for (const r of rows({ n: 60, seed: 4, arrivals: false })) last = f.push(r);
    const text = last.lines.join('\n');
    assert.match(text, /close interval: no local arrival times in these rows, so not forecast and not scored/);
    assert.match(text, /wall-clock features: no local arrival times in these rows/);
    assert.equal(last.intervalRecord.n, 0);
    assert.match(text, /ropes \(count\): h 1 · mean/, 'no wall-time label without arrival times');
  });
  test('the sealed past inside the forecaster: an older or repeated row is ignored, and nothing reads past N', () => {
    const f = new Forecaster();
    const data = rows({ n: 50, seed: 5 });
    for (const r of data) f.push(r);
    const before = f.fingerprint();
    f.push({ ...data[10] });
    assert.equal(f.fingerprint(), before);
    assert.equal(f.past.length, 50);
    assert.throws(() => f.past.at(1049).row(1050), /the future/);
  });
  test('a planted shift reaches the readout: the wake flags it and the forecast shown falls back to the short rope', () => {
    const f = new Forecaster();
    const data = rows({ n: 260, seed: 6, rate: 80, shift: { at: 220, rate: 130 } });
    let fellBack = null;
    let alarmed = null;
    data.forEach((r, i) => {
      const out = f.push(r);
      if (i + 1 >= 220 && fellBack == null && /falls back to the short rope/.test(out.lines.join('\n'))) fellBack = i + 1 - 220;
      if (i + 1 >= 220 && alarmed == null && out.wake.count.cusum.alarms > 0) alarmed = i + 1 - 220;
    });
    assert.ok(fellBack != null && fellBack <= 25, `fell back ${fellBack} ledgers after the shift`);
    assert.ok(alarmed != null && alarmed <= 25, `CUSUM alarm ${alarmed} ledgers after the shift`);
  });
  test('loops reported at N are scored as taken within j when a loop-take consumes one of their offers, with a Brier score', () => {
    const f = new Forecaster({ loopWithin: 3 });
    const data = rows({ n: 60, seed: 7 });
    data[19].loops = [{ members: 3, edge: 0.01, offers: ['rMaker:A'] }]; // taken two ledgers later
    data[21].takes = [{ kind: 'self-payment', offers: ['rMaker:A'] }];
    data[39].loops = [{ members: 3, edge: 0.01, offers: ['rMaker:B'] }]; // never taken
    data[41].takes = [{ kind: 'self-payment', offers: ['rMaker:other'] }];
    for (const r of data) f.push(r);
    const b = f.loopRecord.brierOver();
    assert.equal(b.k, 2);
    assert.equal(f.loopRecord.binary.size, 2);
    const [taken, missed] = [...f.loopRecord.binary.values()];
    assert.ok(taken.sq > 0 && missed.sq > 0);
    assert.ok(taken.sq > missed.sq, 'a low base rate is far from a loop that was taken and near one that was not');
  });
  test('presence from cadence: an account present every third ledger is forecast in phase', () => {
    const f = new Forecaster();
    for (const r of rows({ n: 100, seed: 8 })) f.push(r);
    const p = f.presenceOf('rPulse');
    assert.equal(p.method, 'cadence');
    assert.equal(p.period, 3);
    const inPhase = (1100 + 1) % 3 === 2; // rows index 1000 + i with i % 3 === 0 hold rPulse: index ≡ 1 (mod 3)
    assert.equal(inPhase, false);
    assert.ok(p.p < 0.2, `out of phase at #1101: P ${p.p}`);
    assert.match(p.line, /^transacts at #1,101: P 0\.\d\d from its cadence \(every 3 ledgers, r [\d.]+ on its own presence\) · present in \d+ of the last 64 ledgers$/);
    // an account present at random nine ledgers in ten: whichever way it is read (a chance cadence across fifteen lags can pass r 0.3), its probability is high
    const busy = f.presenceOf('rA1');
    assert.ok(busy.p > 0.7, `P ${busy.p} by ${busy.method}`);
  });
  test('the nowcast: labelled apart, made from what was in flight, scored; the proposed count beats persistence on the held-out ledgers', () => {
    const f = new Forecaster({ mode: 'nowcast' });
    let now = null;
    let last = null;
    for (const r of rows({ n: 200, seed: 9, drift: 0.4 })) {
      now = f.nowcastFor(r.index, { proposed: r.proposed, fee: r.fee }) ?? now;
      last = f.push(r);
    }
    assert.match(now.lines[0], /^nowcast for ledger #1,200, just before its close, from 199 closed ledgers and what was in flight for it \(\d+ proposed · open-ledger fee \d+ drops · queue \d+ · current size \d+ · from test-node\)$/);
    assert.match(now.lines[1], /^count \(shown: ridge on the (proposed count|current size)\) /);
    const text = now.lines.join('\n');
    assert.match(text, /test-node's expected_ledger_size \(its own heuristic/);
    assert.match(text, /on the held-out ledgers \(#\d+–#\d+\), beats persistence: .*ridge on the proposed count \(\d+% less error/);
    assert.equal(last.mode, 'nowcast');
    assert.match(last.lines.join('\n'), /wake: open-ledger fee \(drops\): /);
    assert.equal(new Forecaster().nowcastFor(1001, {}), null, 'forecast mode makes no nowcast');
  });
});

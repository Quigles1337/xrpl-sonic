// UNIVERSE phase 3B — the predictive laws behind the scored points and intervals (Poisson mixtures, the negative
// binomial at a dispersion, the log-scale ridge), the HMM's numerical guards (a burst far from every rate, a window
// that opens on a burst), the Hawkes fit's dispersion and the coverage of its interval, the change-point posterior's
// evidence weighed by the dispersion, and the CUSUM threshold that follows the residuals' autocorrelation.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { poissonMixtureQuantiles, negBinomialQuantiles, ridgeOne, fitHmm, filterHmm, predictHmm, hmmLogLik, stationaryOf, fitHawkes, hawkesRate, predictHawkes } from '../src/universe/forecast/models.js';
import { ChangePoint, Wake, Cusum, thresholdFor, ARL500_THRESHOLDS } from '../src/universe/forecast/wake.js';
import { RopeBank } from '../src/universe/forecast/ropes.js';
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
/** A Gamma(shape, scale) draw (Marsaglia & Tsang 2000; shape below 1 by the boost u^(1/shape)). */
function gamma(rnd, shape, scale) {
  if (shape < 1) return gamma(rnd, shape + 1, scale) * Math.pow(Math.max(1e-12, rnd()), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x;
    let v;
    do {
      x = normal(rnd);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rnd();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}
/** A negative binomial draw with mean m and variance φ·m, as a Gamma-mixed Poisson. */
const negBinomial = (rnd, m, phi) => (phi <= 1 ? poisson(rnd, m) : poisson(rnd, gamma(rnd, m / (phi - 1), phi - 1)));
const quantile = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
};

describe('the predictive laws', () => {
  test('Poisson mixture quantiles are where the mass first reaches each level', () => {
    assert.deepEqual(poissonMixtureQuantiles([1], [4], [0.1, 0.5, 0.9]), [2, 4, 7]); // P(X ≤ 1) 0.092, P(X ≤ 2) 0.238; P(X ≤ 3) 0.433, P(X ≤ 4) 0.629; P(X ≤ 6) 0.889, P(X ≤ 7) 0.949
    const [lo, mid, hi] = poissonMixtureQuantiles([0.5, 0.5], [10, 100], [0.1, 0.5, 0.9]);
    assert.ok(lo <= 10 && hi >= 100, `${lo}–${hi}`);
    assert.ok(mid > 15 && mid < 90, `the median of two far modes sits between them: ${mid}`);
    // checked against the cumulative mass computed apart
    const cdf = (k) => {
      let c = 0;
      for (let j = 0; j <= k; j++) {
        let lf = 0;
        for (let i = 2; i <= j; i++) lf += Math.log(i);
        c += 0.5 * Math.exp(j * Math.log(10) - 10 - lf) + 0.5 * Math.exp(j * Math.log(100) - 100 - lf);
      }
      return c;
    };
    assert.ok(cdf(mid - 1) < 0.5 && cdf(mid) >= 0.5 - 1e-12);
  });
  test('negative binomial quantiles at a dispersion match a Gamma-mixed Poisson sample; at φ 1 they are the Poisson law’s', () => {
    const rnd = seededRandom(41);
    const sample = Array.from({ length: 20000 }, () => negBinomial(rnd, 50, 5));
    const mean = sample.reduce((a, b) => a + b, 0) / sample.length;
    const v = sample.reduce((a, b) => a + (b - mean) ** 2, 0) / sample.length;
    assert.ok(Math.abs(mean - 50) < 1.5 && Math.abs(v / mean - 5) < 0.5, `the sampler: mean ${mean.toFixed(1)}, variance over mean ${(v / mean).toFixed(2)}`);
    const q = negBinomialQuantiles(50, 5, [0.1, 0.5, 0.9]);
    const e = [0.1, 0.5, 0.9].map((p) => quantile(sample, p));
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(q[i] - e[i]) <= 2, `quantile ${[0.1, 0.5, 0.9][i]}: ${q[i]} against the sample's ${e[i]}`);
    assert.deepEqual(negBinomialQuantiles(4, 1, [0.1, 0.5, 0.9]), [2, 4, 7]);
    assert.ok(q[1] < 50, 'skewed: its median under its mean');
  });
  test('the ridge on log(1 + x): the slope of a log-linear law, the median as its point, an 80% interval that covers 80%', () => {
    const rnd = seededRandom(43);
    const draw = (x) => Math.max(0, Math.round(Math.expm1(1 + 0.7 * Math.log1p(x) + 0.3 * normal(rnd))));
    const pairs = [];
    for (let i = 0; i < 600; i++) {
      const x = Math.round(Math.expm1(3 + normal(rnd)));
      pairs.push([x, draw(x)]);
    }
    const f = ridgeOne(pairs, { lambda: 1, log: true });
    assert.ok(Math.abs(f.b - 0.7) < 0.05, `slope ${f.b.toFixed(3)}`);
    const p = f.predict(100);
    assert.ok(p.point < p.mean, 'the median under the log-normal mean');
    assert.ok(Math.abs(Math.log1p(p.point) - (1 + 0.7 * Math.log1p(100))) < 0.1);
    let inside = 0;
    for (let i = 0; i < 2000; i++) {
      const x = Math.round(Math.expm1(3 + normal(rnd)));
      const y = draw(x);
      const q = f.predict(x);
      if (y >= q.interval[0] && y <= q.interval[1]) inside += 1;
    }
    assert.ok(Math.abs(inside / 2000 - 0.8) < 0.05, `coverage ${(inside / 20).toFixed(1)}%`);
  });
});

describe('the HMM’s numerical guards', () => {
  test('a burst far from every rate neither empties the filter nor the fit (the emissions are scaled per count)', () => {
    const rnd = seededRandom(47);
    const counts = [];
    let state = 0;
    for (let t = 0; t < 400; t++) {
      if (rnd() < 0.05) state = 1 - state;
      counts.push(poisson(rnd, state ? 180 : 60));
    }
    counts[200] = 1500;
    counts[201] = 2000;
    const m = fitHmm(counts, { states: 2 });
    assert.ok(m.lambda.every(Number.isFinite) && Number.isFinite(m.logLik), `rates ${m.lambda} log-likelihood ${m.logLik}`);
    const f = filterHmm(m, [60, 70, 3000, 65]);
    assert.ok(Math.abs(f.filtered.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'the filtered posterior sums to one');
    const p = predictHmm(f);
    assert.ok(Number.isFinite(p.point) && p.point < 1000, `point ${p.point}`);
    assert.ok(Number.isFinite(hmmLogLik(m, [60, 3000, 70])));
  });
  test('a window that opens on a burst: the filter starts from the stationary distribution, not the fitted initial point mass', () => {
    const m = { states: 3, lambda: [68, 207, 558], A: [[0.87, 0.073, 0.057], [0.61, 0.243, 0.147], [0.129, 0.351, 0.52]], pi: [1, 0, 0] };
    const st = stationaryOf(m.A);
    assert.ok(Math.abs(st.reduce((a, b) => a + b, 0) - 1) < 1e-12 && st.every((x) => x > 0));
    for (let j = 0; j < 3; j++) assert.ok(Math.abs(st.reduce((s, p, i) => s + p * m.A[i][j], 0) - st[j]) < 1e-9, 'stationary: πA = π');
    const p = predictHmm(filterHmm(m, [600, 580, 90, 75, 70]));
    assert.ok(p && Number.isFinite(p.point) && p.point < 200000, `the window that emptied every state on the recording: point ${p?.point}`);
    assert.equal(predictHmm({ ...m, filtered: [0, 0, 0] }), null, 'an empty posterior gives no forecast');
  });
});

describe('the self-exciting model’s dispersion', () => {
  test('a planted Hawkes rate with negative binomial counts (φ 4): the fit measures the dispersion and its interval covers about 80%', () => {
    const rnd = seededRandom(53);
    const counts = [];
    let s = 0;
    for (let t = 0; t < 1500; t++) {
      const rate = 20 + 0.4 * s;
      const x = negBinomial(rnd, rate, 4);
      counts.push(x);
      s = 0.5 * s + x;
    }
    const m = fitHawkes(counts.slice(0, 1000));
    assert.ok(m.dispersion > 3 && m.dispersion < 5.5, `dispersion ${m.dispersion.toFixed(2)} for 4`);
    let inside = 0;
    let n = 0;
    for (let t = 1000; t < 1500; t++) {
      const p = predictHawkes(hawkesRate(m, counts.slice(t - 64, t)));
      if (counts[t] >= p.interval[0] && counts[t] <= p.interval[1]) inside += 1;
      n += 1;
    }
    assert.ok(Math.abs(inside / n - 0.8) < 0.07, `coverage ${((100 * inside) / n).toFixed(1)}% over ${n}`);
    // the same rate with Poisson counts: a dispersion near 1
    const plain = [];
    let s2 = 0;
    for (let t = 0; t < 1000; t++) {
      const x = poisson(rnd, 20 + 0.4 * s2);
      plain.push(x);
      s2 = 0.5 * s2 + x;
    }
    const d1 = fitHawkes(plain).dispersion;
    assert.ok(d1 < 1.3, 'a Poisson stream’s dispersion ' + d1.toFixed(2));
  });
});

describe('the change-point posterior’s weighed evidence', () => {
  test('on a dispersed stream (φ 20) the evidence weighed by one over the dispersion keeps one run; unweighed it splits the stream', () => {
    const rnd = seededRandom(59);
    const stream = Array.from({ length: 800 }, () => negBinomial(rnd, 80, 20));
    const weighed = new ChangePoint({ family: 'poisson', hazard: 1 / 200, prior: { a: 80 / 20, b: 1 / 20 } });
    const plain = new ChangePoint({ family: 'poisson', hazard: 1 / 200, prior: { a: 80, b: 1 } });
    for (const x of stream) {
      weighed.update(x, { weight: 1 / 20 });
      plain.update(x);
    }
    assert.ok(weighed.changes.length <= 3, `${weighed.changes.length} changes weighed`);
    assert.ok(plain.changes.length > 20, `${plain.changes.length} changes unweighed`);
  });
  test('a value far from every run cannot empty the posterior (log-space predictives)', () => {
    const cp = new ChangePoint({ family: 'poisson', hazard: 1 / 200, prior: { a: 70, b: 1 } });
    for (let i = 0; i < 300; i++) cp.update(70);
    cp.update(1e6);
    const total = cp.weights.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9 && cp.weights.every(Number.isFinite), `the posterior sums to ${total}`);
    cp.update(70);
    assert.ok(Number.isFinite(cp.recentChangeProbability));
  });
  test('P(a new run began at this ledger) is the mass on r = 1, not the hazard: steady data keep it low, a jump raises it', () => {
    const rnd = seededRandom(61);
    const cp = new ChangePoint({ family: 'poisson', hazard: 1 / 200, prior: { a: 100, b: 1 } });
    for (let i = 0; i < 200; i++) cp.update(poisson(rnd, 100));
    assert.ok(cp.changeProbability < 0.02, `steady ${cp.changeProbability}`);
    cp.update(160);
    cp.update(165);
    assert.ok(cp.weights[2] + cp.weights[1] > 0.1, 'two ledgers after a jump the short runs hold mass');
  });
});

describe('the CUSUM threshold follows the residuals’ autocorrelation', () => {
  test('the shipped table is what the bisection gives (two entries recomputed)', () => {
    for (const step of [0, 3]) {
      const t = thresholdFor(500, { k: 0.5, runs: 2000, seed: 7, rho: step / 10, table: false });
      assert.equal(Number(t.h.toFixed(4)), ARL500_THRESHOLDS[step][0], `h at rho ${step / 10}`);
      assert.equal(Number(t.measuredArl.toFixed(1)), ARL500_THRESHOLDS[step][1]);
    }
    for (let i = 1; i < ARL500_THRESHOLDS.length; i++) assert.ok(ARL500_THRESHOLDS[i][0] > ARL500_THRESHOLDS[i - 1][0], 'h rises with the autocorrelation');
  });
  test('on autocorrelated counts (an AR(1) of 0.6 on the log scale) the wake measures 0.6, and its alarms keep the stated run length; held at independence they come twelve times as often', () => {
    const t = thresholdFor(500, { k: 0.5, runs: 2000, seed: 7 });
    const rnd = seededRandom(21);
    const bank = new RopeBank();
    const w = new Wake({ name: 'count', bank, family: 'poisson', threshold: t });
    const fixed = new Cusum({ k: 0.5, h: t.h });
    let u = normal(rnd);
    let fixedAlarms = 0;
    const steps = 30000;
    for (let i = 0; i < steps; i++) {
      u = 0.6 * u + 0.8 * normal(rnd);
      const x = Math.max(0, Math.round(Math.expm1(4.5 + 0.25 * u)));
      const r = w.update(x);
      if (w.reference() && fixed.update(r.z)) fixedAlarms += 1;
      bank.update(x);
    }
    assert.equal(w.rho, 0.6);
    assert.equal(w.cusum.h, ARL500_THRESHOLDS[6][0]);
    const arl = steps / Math.max(1, w.cusum.alarms);
    assert.ok(arl > 500 / 1.5 && arl < 500 * 1.5, `observed run length ${arl.toFixed(0)} for 500 (${w.cusum.alarms} alarms)`);
    assert.ok(fixedAlarms > 8 * w.cusum.alarms, `at independence ${fixedAlarms} alarms against ${w.cusum.alarms}`);
  });
});

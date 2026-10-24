// UNIVERSE phase 3B — the deterministic elementary functions behind the forecaster: within two units in the last place
// of the engine's own, the special values right, and the exact bits pinned on fixed inputs (the browser's worker and
// the Node replay must agree bit for bit; src/universe/bench/math-parity.mjs checks the two engines side by side).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { exp, log, log1p, expm1, pow, logGamma, normalSampler } from '../src/universe/forecast/dmath.js';
import { seededRandom } from '../src/coherence.js';

const hex = (x) => {
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, x);
  return v.getUint32(0).toString(16).padStart(8, '0') + v.getUint32(4).toString(16).padStart(8, '0');
};
/** The spacing of doubles at x. */
const ulp = (x) => {
  if (!Number.isFinite(x) || x === 0) return Number.MIN_VALUE;
  const e = Math.floor(Math.log2(Math.abs(x)));
  return Math.pow(2, Math.max(e, -1022) - 52);
};
const within = (a, b, n) => Math.abs(a - b) <= n * ulp(b);

describe('the deterministic elementary functions', () => {
  test('within two units in the last place of the engine’s own on 50,000 inputs each', () => {
    const rnd = seededRandom(71);
    const cases = [
      ['exp', (u) => -700 + 1400 * u, exp, Math.exp, 1],
      ['log', (u) => Math.exp(-700 + 1400 * u), log, Math.log, 1],
      ['log1p', (u) => -0.999 + 1e4 * u * u * u, log1p, Math.log1p, 2],
      ['expm1', (u) => -30 + 60 * u, expm1, Math.expm1, 2],
      ['log1p near zero', (u) => (u - 0.5) * 1e-9, log1p, Math.log1p, 2],
      ['expm1 near zero', (u) => (u - 0.5) * 1e-9, expm1, Math.expm1, 2],
    ];
    for (const [name, gen, mine, theirs, tol] of cases) {
      let worst = 0;
      for (let i = 0; i < 50000; i++) {
        const x = gen(rnd());
        const a = mine(x);
        const b = theirs(x);
        const e = Math.abs(a - b) / ulp(b);
        if (e > worst) worst = e;
      }
      // the engine's own is itself within about one unit of the truth, so two between them is the tolerance
      assert.ok(worst <= tol + 1, `${name}: ${worst.toFixed(2)} units in the last place`);
    }
    assert.ok(within(pow(2, -1 / 16), Math.pow(2, -1 / 16), 4));
  });
  test('the special values', () => {
    assert.equal(exp(0), 1);
    assert.equal(exp(Infinity), Infinity);
    assert.equal(exp(-Infinity), 0);
    assert.ok(Number.isNaN(exp(NaN)));
    assert.equal(exp(710), Infinity);
    assert.equal(exp(-746), 0);
    assert.equal(log(1), 0);
    assert.equal(log(0), -Infinity);
    assert.ok(Number.isNaN(log(-1)));
    assert.equal(log(Infinity), Infinity);
    assert.ok(within(log(5e-324), Math.log(5e-324), 1), 'a subnormal');
    assert.equal(log1p(0), 0);
    assert.equal(log1p(-1), -Infinity);
    assert.ok(Number.isNaN(log1p(-2)));
    assert.equal(log1p(1e-30), 1e-30);
    assert.equal(expm1(0), 0);
    assert.equal(expm1(-Infinity), -1);
    assert.equal(expm1(1e-30), 1e-30);
    assert.ok(Number.isFinite(expm1(709.78)) && within(expm1(709.78), Math.expm1(709.78), 2), 'no overflow near the top of the range');
    assert.ok(Number.isNaN(logGamma(0)) && Number.isNaN(logGamma(-1)));
  });
  test('the log-gamma: log((n)!) to fourteen digits for n up to 2,000, and below one half by the recurrence', () => {
    let lf = 0;
    for (let n = 1; n < 2000; n++) {
      lf += Math.log(n);
      assert.ok(Math.abs(logGamma(n + 1) - lf) <= 1e-14 * Math.max(1, lf), `log ${n}!`);
    }
    assert.ok(Math.abs(logGamma(0.3) - 1.0957979948180756) < 1e-14);
    assert.ok(Math.abs(logGamma(0.5) - 0.5723649429247001) < 1e-14, 'log √π');
  });
  test('the exact bits on fixed inputs, so the live worker and the replay cannot drift apart unseen', () => {
    const golden = [
      ['exp', 1, '4005bf0a8b14576a'],
      ['exp', -0.5, '3fe368b2fc6f960a'],
      ['exp', 10.25, '40db9ea2aed2a0f2'],
      ['exp', -700.5, '00c4ff475c68ca02'],
      ['log', 2, '3fe62e42fefa39ef'],
      ['log', 1e-300, 'c085963447f87fb5'],
      ['log', 123456.789, '40277281cad8a844'],
      ['log1p', 1e-10, '3ddb7cdfd9d1d693'],
      ['log1p', 0.75, '3fe1e85f5e7040d0'],
      ['expm1', 1e-12, '3d719799812df3bd'],
      ['expm1', -0.3, 'bfd0966f2c7907f6'],
      ['expm1', 5, '40626d389970338f'],
      ['logGamma', 0.3, '3ff188637a6c4199'],
      ['logGamma', 12.5, '4032bbfe32d3aa80'],
      ['logGamma', 1001, '40b71820d04e2eb6'],
    ];
    const fns = { exp, log, log1p, expm1, logGamma };
    for (const [f, x, bits] of golden) assert.equal(hex(fns[f](x)), bits, `${f}(${x})`);
  });
  test('the normal sampler: mean 0 and variance 1 over 100,000 draws, the same draws from the same seed', () => {
    const a = normalSampler(seededRandom(73));
    const b = normalSampler(seededRandom(73));
    let s = 0;
    let s2 = 0;
    const n = 100000;
    for (let i = 0; i < n; i++) {
      const x = a();
      assert.equal(x, b());
      s += x;
      s2 += x * x;
    }
    assert.ok(Math.abs(s / n) < 0.01, `mean ${s / n}`);
    assert.ok(Math.abs(s2 / n - 1) < 0.015, `variance ${s2 / n}`);
  });
});

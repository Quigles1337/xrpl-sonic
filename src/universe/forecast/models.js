// UNIVERSE phase 3B — the models, simple first: baselines (persistence, EWMA, a server's own heuristic), one-signal
// ridge regressions, a 2–3 state hidden Markov model of activity regimes with Poisson emissions (Baum–Welch), and a
// self-exciting count model (a discrete Hawkes with an exponential kernel, by maximum likelihood). Each gives a point
// forecast for the next ledger and an 80% interval; the forecaster compares them out of sample. Pure.

import { Rope } from './ropes.js';
import { exp as dexp, log as dlog, log1p as dlog1p, expm1 as dexpm1 } from './dmath.js';

const Z80 = 1.2816; // the 90th percentile of the standard normal: ± for an 80% interval

/** An 80% interval around a mean for a count-like target: Poisson-ish when the variance is unknown, else from the sd given. */
export function interval80(mean, sd = null) {
  const s = sd != null && sd > 0 ? sd : Math.sqrt(Math.max(1, mean));
  return [Math.max(0, mean - Z80 * s), mean + Z80 * s];
}

// --- baselines ----------------------------------------------------------------------------------

/** Persistence: the next value is this one; the interval from the recent absolute changes. */
export function persistence(series) {
  const n = series.length;
  if (!n) return null;
  const last = series[n - 1];
  const diffs = [];
  for (let i = Math.max(1, n - 32); i < n; i++) diffs.push(Math.abs(series[i] - series[i - 1]));
  const sd = diffs.length ? Math.sqrt(diffs.reduce((a, d) => a + d * d, 0) / diffs.length) : null;
  return { name: 'persistence', mean: last, interval: interval80(last, sd) };
}

/** The EWMA baseline at a half-life (16 by default), its interval from the rope's sd. */
export function ewmaBaseline(series, halfLife = 16) {
  const r = new Rope(halfLife);
  for (const x of series) r.update(x);
  if (r.mean == null) return null;
  return { name: `ewma h${halfLife}`, mean: r.mean, interval: interval80(r.mean, r.sd > 0 ? r.sd : null) };
}

/** A server's own heuristic as a baseline, labelled as that server's and never as network truth; null when not recorded. */
export function serverBaseline(expectedLedgerSize, server = 'the server') {
  if (!Number.isFinite(expectedLedgerSize)) return null;
  return { name: `${server}'s expected_ledger_size (its own heuristic, as the server reported it)`, mean: expectedLedgerSize, interval: interval80(expectedLedgerSize) };
}

// --- one-signal ridge regression ------------------------------------------------------------------

/**
 * y_{t+1} = a + b · x_t by ridge (λ on the slope), fitted on the pairs
 * given; returns the fit and a predictor with an interval from the
 * residual sd. One signal at a time, shown separately.
 */
export function ridgeOne(input, { lambda = 1, log = false } = {}) {
  const pairs = log ? input.map(([x, y]) => [dlog1p(Math.max(0, x)), dlog1p(Math.max(0, y))]) : input;
  const n = pairs.length;
  if (n < 8) return null;
  let mx = 0;
  let my = 0;
  for (const [x, y] of pairs) {
    mx += x;
    my += y;
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of pairs) {
    sxx += (x - mx) * (x - mx);
    sxy += (x - mx) * (y - my);
  }
  const b = sxy / (sxx + lambda);
  const a = my - b * mx;
  let sse = 0;
  for (const [x, y] of pairs) {
    const r = y - (a + b * x);
    sse += r * r;
  }
  const sd = Math.sqrt(sse / Math.max(1, n - 2));
  if (!log) return { a, b, sd, n, log, predict: (x) => ({ mean: a + b * x, interval: interval80(a + b * x, sd) }) };
  // on log(1 + x): the median is exp(μ) − 1, the interval exp(μ ± z·sd) − 1, the mean exp(μ + sd²/2) − 1 (log-normal)
  return {
    a,
    b,
    sd,
    n,
    log,
    predict: (x) => {
      const mu = a + b * dlog1p(Math.max(0, x));
      return { mean: dexpm1(mu + (sd * sd) / 2), point: dexpm1(mu), interval: [Math.max(0, dexpm1(mu - Z80 * sd)), dexpm1(mu + Z80 * sd)] };
    },
  };
}

// --- quantiles of the count laws -------------------------------------------------------------------

/** Quantiles (ps ascending) of a mixture of Poisson laws (weights summing to 1), by walking the mass from 0. */
export function poissonMixtureQuantiles(weights, rates, ps, { cap = 200000 } = {}) {
  const out = [];
  let c = 0;
  let j = 0;
  for (let k = 0; k <= cap && j < ps.length; k++) {
    let mass = 0;
    for (let i = 0; i < rates.length; i++) if (weights[i] > 0) mass += weights[i] * dexp(logPoisson(k, rates[i]));
    c += mass;
    while (j < ps.length && c >= ps[j] - 1e-12) {
      out.push(k);
      j += 1;
    }
  }
  while (out.length < ps.length) out.push(cap);
  return out;
}

/**
 * Quantiles (ps ascending) of a negative binomial law with mean m and
 * variance φ·m (size m/(φ − 1)), a Poisson law when φ ≤ 1, by walking the
 * mass from 0.
 */
export function negBinomialQuantiles(mean, phi, ps, { cap = 200000 } = {}) {
  if (!(phi > 1 + 1e-9) || !(mean > 0)) return poissonMixtureQuantiles([1], [Math.max(1e-9, mean)], ps, { cap });
  const r = mean / (phi - 1);
  const q = 1 / phi;
  const out = [];
  let logMass = r * dlog(q);
  let c = 0;
  let j = 0;
  for (let k = 0; k <= cap && j < ps.length; k++) {
    if (k > 0) logMass += dlog((k - 1 + r) / k) + dlog(1 - q);
    c += dexp(logMass);
    while (j < ps.length && c >= ps[j] - 1e-12) {
      out.push(k);
      j += 1;
    }
  }
  while (out.length < ps.length) out.push(cap);
  return out;
}

// --- the hidden Markov model of regimes ---------------------------------------------------------------

let LOG_FACTORIAL = new Float64Array([0, 0]);
const logFactorial = (k) => {
  const n = Math.max(0, Math.round(k));
  if (n >= LOG_FACTORIAL.length) {
    const next = new Float64Array(Math.max(n + 1, 2 * LOG_FACTORIAL.length));
    next.set(LOG_FACTORIAL);
    for (let i = LOG_FACTORIAL.length; i < next.length; i++) next[i] = next[i - 1] + dlog(i);
    LOG_FACTORIAL = next;
  }
  return LOG_FACTORIAL[n];
};
const logPoisson = (k, lambda) => k * dlog(Math.max(1e-12, lambda)) - lambda - logFactorial(Math.round(k));

/**
 * One count's Poisson emissions under each rate, scaled by the largest: { e, top } with e[k] = exp(log p_k − top).
 * A burst far from every rate (1,000 transactions against rates of 68 and 186) underflows to zero in every state
 * otherwise and the filter collapses; the scale cancels in each step's normalisation and is added back to the
 * log-likelihood.
 */
const scaledEmissions = (x, lambda) => {
  const le = lambda.map((l) => logPoisson(x, l));
  const top = Math.max(...le);
  return { e: le.map((v) => dexp(v - top)), top };
};

/**
 * A hidden Markov model with K states and Poisson emissions, fitted by
 * Baum–Welch (expectation–maximisation) on a count series, with the forward
 * and backward passes scaled and the emissions scaled per count. It stops
 * when an iteration improves the log-likelihood by less than `tolerance`
 * of its size (on the 90-minute recording's last 1,024 counts, 3 states:
 * 20 iterations, about 4 ms), or after `iterations`. Returns the rates,
 * the transition matrix, the initial distribution (floored), the
 * log-likelihood, the filtered state posterior at the last observation and
 * the iterations used.
 */
export function fitHmm(counts, { states = 2, iterations = 60, tolerance = 1e-7 } = {}) {
  const T = counts.length;
  const K = states;
  if (T < 4 * K) return null;
  // initial rates spread over the data's quantiles
  const sorted = [...counts].sort((a, b) => a - b);
  let lambda = Array.from({ length: K }, (_, k) => Math.max(0.5, sorted[Math.floor(((k + 0.5) / K) * (T - 1))]));
  let A = Array.from({ length: K }, (_, i) => Array.from({ length: K }, (_, j) => (i === j ? 0.9 : 0.1 / Math.max(1, K - 1))));
  let pi = new Array(K).fill(1 / K);
  const alpha = new Float64Array(T * K);
  const beta = new Float64Array(T * K);
  const E = new Float64Array(T * K); // emissions scaled per count by the largest
  const scale = new Float64Array(T);
  let logLik = -Infinity;
  let used = 0;
  for (let it = 0; it < iterations; it++) {
    used = it + 1;
    let ll = 0;
    // log Poisson(x | λ_k) = x · log λ_k − λ_k − log x!, with log λ_k taken once an iteration (the same expression, the same bits)
    const logLam = lambda.map((l) => dlog(Math.max(1e-12, l)));
    for (let t = 0; t < T; t++) {
      let top = -Infinity;
      const lf = logFactorial(Math.round(counts[t]));
      for (let k = 0; k < K; k++) {
        const v = counts[t] * logLam[k] - lambda[k] - lf;
        E[t * K + k] = v;
        if (v > top) top = v;
      }
      for (let k = 0; k < K; k++) E[t * K + k] = dexp(E[t * K + k] - top);
      ll += top;
    }
    // forward with scaling
    let z = 0;
    for (let k = 0; k < K; k++) {
      alpha[k] = pi[k] * E[k];
      z += alpha[k];
    }
    scale[0] = z || 1e-300;
    for (let k = 0; k < K; k++) alpha[k] /= scale[0];
    for (let t = 1; t < T; t++) {
      z = 0;
      for (let j = 0; j < K; j++) {
        let acc = 0;
        for (let i = 0; i < K; i++) acc += alpha[(t - 1) * K + i] * A[i][j];
        const v = acc * E[t * K + j];
        alpha[t * K + j] = v;
        z += v;
      }
      scale[t] = z || 1e-300;
      for (let j = 0; j < K; j++) alpha[t * K + j] /= scale[t];
    }
    for (let t = 0; t < T; t++) ll += dlog(scale[t]);
    // backward
    for (let k = 0; k < K; k++) beta[(T - 1) * K + k] = 1;
    for (let t = T - 2; t >= 0; t--) {
      for (let i = 0; i < K; i++) {
        let acc = 0;
        for (let j = 0; j < K; j++) acc += A[i][j] * E[(t + 1) * K + j] * beta[(t + 1) * K + j];
        beta[t * K + i] = acc / scale[t + 1];
      }
    }
    // expectations, accumulated in place
    const num = new Array(K).fill(0);
    const den = new Array(K).fill(0);
    const first = new Array(K).fill(0);
    const xi = Array.from({ length: K }, () => new Array(K).fill(0));
    const cell = new Float64Array(K * K);
    for (let t = 0; t < T; t++) {
      let g = 0;
      for (let k = 0; k < K; k++) g += alpha[t * K + k] * beta[t * K + k];
      g = g || 1e-300;
      for (let k = 0; k < K; k++) {
        const w = (alpha[t * K + k] * beta[t * K + k]) / g;
        num[k] += w * counts[t];
        den[k] += w;
        if (t === 0) first[k] = w;
      }
      if (t < T - 1) {
        let c = 0;
        for (let i = 0; i < K; i++)
          for (let j = 0; j < K; j++) {
            const v = alpha[t * K + i] * A[i][j] * E[(t + 1) * K + j] * beta[(t + 1) * K + j];
            cell[i * K + j] = v;
            c += v;
          }
        if (c > 0) for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) xi[i][j] += cell[i * K + j] / c;
      }
    }
    // maximisation (the initial distribution floored: Baum–Welch drives it to a point mass)
    pi = first.map((v) => Math.max(1e-6, v));
    const piSum = pi.reduce((a, b) => a + b, 0);
    pi = pi.map((v) => v / piSum);
    A = xi.map((row, i) => {
      const r = row.reduce((a, b) => a + b, 0);
      return r > 0 ? row.map((v) => Math.max(1e-6, v / r)) : A[i];
    });
    lambda = lambda.map((l, k) => (den[k] > 0 ? Math.max(1e-3, num[k] / den[k]) : l));
    const done = Math.abs(ll - logLik) < tolerance * Math.abs(ll);
    logLik = ll;
    if (done) break;
  }
  // the filtered posterior at T−1, for the prediction
  const filtered = forward({ lambda, A, pi }, counts, { start: pi }).filtered;
  const order = lambda.map((l, k) => [l, k]).sort((x, y) => x[0] - y[0]).map(([, k]) => k);
  return { states: K, lambda, A, pi, logLik, filtered, order, iterations: used };
}

/** The stationary distribution of a transition matrix, by power iteration from the uniform distribution. */
export function stationaryOf(A, { steps = 500 } = {}) {
  const K = A.length;
  let v = new Array(K).fill(1 / K);
  for (let it = 0; it < steps; it++) {
    const next = new Array(K).fill(0);
    for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) next[j] += v[i] * A[i][j];
    const z = next.reduce((a, b) => a + b, 0) || 1;
    v = next.map((x) => x / z);
  }
  return v;
}

/**
 * The forward filter with the parameters fixed: the state posterior after
 * the last count and the log-likelihood, emissions scaled per count. It
 * starts from `start` (the fitted initial distribution for the fitting
 * window itself, the stationary distribution for any later window); a step
 * whose evidence empties every state restarts from the stationary
 * distribution.
 */
function forward({ lambda, A, pi }, counts, { start = null } = {}) {
  const K = lambda.length;
  const stationary = stationaryOf(A);
  const first = start ?? stationary;
  let { e, top } = scaledEmissions(counts[0], lambda);
  let a = first.map((p, k) => p * e[k]);
  let z = a.reduce((x, y) => x + y, 0);
  if (!(z > 0)) {
    a = stationary.map((p, k) => p * e[k]);
    z = a.reduce((x, y) => x + y, 0) || 1e-300;
  }
  let ll = dlog(z) + top;
  a = a.map((v) => v / z);
  for (let t = 1; t < counts.length; t++) {
    ({ e, top } = scaledEmissions(counts[t], lambda));
    let next = new Array(K).fill(0);
    for (let j = 0; j < K; j++) {
      let s = 0;
      for (let i = 0; i < K; i++) s += a[i] * A[i][j];
      next[j] = s * e[j];
    }
    z = next.reduce((x, y) => x + y, 0);
    if (!(z > 0)) {
      next = stationary.map((p, k) => p * e[k]);
      z = next.reduce((x, y) => x + y, 0) || 1e-300;
    }
    ll += dlog(z) + top;
    a = next.map((v) => v / z);
  }
  return { filtered: a, logLik: ll };
}

/** The HMM with its parameters fixed and its state filtered forward over `counts` (the forecaster refits every so often and filters every ledger). */
export function filterHmm(model, counts) {
  if (!model || !counts.length) return model;
  return { ...model, filtered: forward(model, counts).filtered };
}

/** The HMM's one-step prediction: the predictive law is a mixture of the states' Poisson laws; its median, its 10th–90th percentiles, its mean. */
export function predictHmm(model) {
  if (!model) return null;
  const { lambda, A, filtered } = model;
  const K = lambda.length;
  const next = new Array(K).fill(0);
  for (let j = 0; j < K; j++) for (let i = 0; i < K; i++) next[j] += filtered[i] * A[i][j];
  const total = next.reduce((a, b) => a + b, 0);
  if (!(total > 0.999 && total < 1.001)) return null; // an empty or broken posterior: no forecast rather than a wrong one
  const mean = next.reduce((s, p, k) => s + p * lambda[k], 0);
  const [lo, median, hi] = poissonMixtureQuantiles(next, lambda, [0.1, 0.5, 0.9]);
  const regime = next.indexOf(Math.max(...next));
  return { name: `hmm ${K} states`, mean, point: median, interval: [lo, hi], regime, regimeRate: lambda[regime], regimeProbability: next[regime], weights: next };
}

/** The held-out log-likelihood of a fitted HMM on another series (forward filter), for choosing the number of states. */
export function hmmLogLik(model, counts) {
  return forward(model, counts).logLik;
}

// --- the self-exciting count model (a discrete Hawkes) --------------------------------------------------

/**
 * λ_{t+1} = μ + α · Σ_{k≥0} β^k · x_{t−k}: a Poisson count whose rate is
 * excited by recent counts with an exponential kernel (the discrete form of
 * a Hawkes process; stationary when α/(1−β) < 1). Fitted by the profile
 * likelihood over β (a grid, then a finer one around the best), with Newton
 * steps for (μ, α) at each β: given β the model is a Poisson regression on
 * the excited sum, and its log-likelihood is concave in (μ, α).
 */
export function fitHawkes(counts, { grid = 19, newton = 25 } = {}) {
  const T = counts.length;
  if (T < 16) return null;
  const mean = counts.reduce((a, b) => a + b, 0) / T;
  const excited = (beta) => {
    const sum = new Array(T).fill(0); // s_t = Σ β^k x_{t−1−k}: what excites ledger t
    let acc = 0;
    for (let t = 0; t < T; t++) {
      sum[t] = acc;
      acc = beta * acc + counts[t];
    }
    return { sum, tail: acc };
  };
  const fitAt = (beta) => {
    const { sum, tail } = excited(beta);
    let mu = Math.max(0.1, mean * 0.5);
    let alpha = 0.1;
    for (let it = 0; it < newton; it++) {
      // gradient and Hessian of Σ_{t≥1} [x_t log λ_t − λ_t], λ_t = μ + α s_t
      let g0 = 0;
      let g1 = 0;
      let h00 = 0;
      let h01 = 0;
      let h11 = 0;
      for (let t = 1; t < T; t++) {
        const lam = Math.max(1e-9, mu + alpha * sum[t]);
        const r = counts[t] / lam - 1;
        g0 += r;
        g1 += r * sum[t];
        const w = counts[t] / (lam * lam);
        h00 -= w;
        h01 -= w * sum[t];
        h11 -= w * sum[t] * sum[t];
      }
      const det = h00 * h11 - h01 * h01;
      if (!(Math.abs(det) > 1e-18)) break;
      // Newton step: (μ, α) ← (μ, α) − H⁻¹ g, damped and kept in the stationary region
      let dmu = -(h11 * g0 - h01 * g1) / det;
      let dalpha = -(-h01 * g0 + h00 * g1) / det;
      let step = 1;
      for (let k = 0; k < 8; k++) {
        const m2 = mu + step * dmu;
        const a2 = alpha + step * dalpha;
        if (m2 > 1e-6 && a2 >= 0 && a2 / (1 - beta) < 0.995) {
          mu = m2;
          alpha = a2;
          break;
        }
        step /= 2;
      }
      if (Math.abs(dmu) + Math.abs(dalpha) < 1e-9) break;
    }
    // the log-likelihood once, at the fitted (μ, α): the Newton steps need only its derivatives
    let ll = 0;
    for (let t = 1; t < T; t++) {
      const lam = Math.max(1e-9, mu + alpha * sum[t]);
      ll += counts[t] * dlog(lam) - lam;
    }
    return { mu, alpha, beta, ll, tail };
  };
  let best = null;
  const betas = Array.from({ length: grid }, (_, i) => 0.05 + (0.9 * i) / (grid - 1));
  for (const b of betas) {
    const f = fitAt(b);
    if (!best || f.ll > best.ll) best = f;
  }
  // a finer grid around the best β
  const lo = Math.max(0.01, best.beta - 0.05);
  const hi = Math.min(0.99, best.beta + 0.05);
  for (let i = 0; i <= 10; i++) {
    const f = fitAt(lo + ((hi - lo) * i) / 10);
    if (f.ll > best.ll) best = f;
  }
  const nextRate = best.mu + best.alpha * best.tail;
  // the Pearson dispersion of the fit (McCullagh & Nelder 1989): Σ (x_t − λ_t)² / λ_t over T − 3, at least 1; the
  // counts' spread beyond a Poisson law at the fitted rate, carried into the interval
  const { sum } = excited(best.beta);
  let pearson = 0;
  for (let t = 1; t < T; t++) {
    const lam = Math.max(1e-9, best.mu + best.alpha * sum[t]);
    pearson += ((counts[t] - lam) * (counts[t] - lam)) / lam;
  }
  const dispersion = Math.max(1, pearson / Math.max(1, T - 3));
  return { mu: best.mu, alpha: best.alpha, beta: best.beta, logLik: best.ll, branching: best.alpha / (1 - best.beta), nextRate, dispersion };
}

/** The self-exciting rate for the next ledger with fixed parameters over `counts` (the kernel's tail beyond them is negligible: β^64 < 0.002 for β ≤ 0.9). */
export function hawkesRate(model, counts) {
  if (!model) return null;
  let s = 0;
  for (const x of counts) s = model.beta * s + x;
  return { ...model, nextRate: model.mu + model.alpha * s };
}

/** The Hawkes-type prediction for the next ledger: the excited rate as the mean of a negative binomial law with the fit's dispersion (variance φλ); its median and 10th–90th percentiles. */
export function predictHawkes(model) {
  if (!model) return null;
  const phi = model.dispersion ?? 1;
  const [lo, median, hi] = negBinomialQuantiles(model.nextRate, phi, [0.1, 0.5, 0.9]);
  return { name: 'self-exciting counts (discrete Hawkes)', mean: model.nextRate, point: median, interval: [lo, hi], dispersion: phi };
}

// UNIVERSE phase 3B — deterministic elementary functions for the forecaster: exp, log, log1p, expm1, a log-gamma and
// a normal sampler, computed with IEEE basic operations only (+ − × ÷, square root, and exact changes of exponent), so
// a live sky in any browser and the Node replay of its rows give the same bits. The engines' own functions do not:
// between Chrome 157 (V8 15) and Node 22 (V8 12.4), Math.exp, log, pow, expm1, log1p, sin and cos differed in the last
// bit on 1% to 22% of 2,000 inputs each (src/universe/bench/math-parity.mjs), and a recorded live session replayed in
// Node left the live worker's forecasts at its fourth ledger. Pure.
//
// exp and log are ports of fdlibm's e_exp.c and e_log.c (FreeBSD msun), whose notice follows:
//
// ====================================================
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//
// Developed at SunPro, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this
// software is freely granted, provided that this notice
// is preserved.
// ====================================================
//
// log1p and expm1 are the identities of Goldberg ("What every computer scientist should know about floating-point
// arithmetic", ACM Computing Surveys 23, 1991, Theorem 4) and Kahan, on top of those two; the log-gamma is Lanczos's
// series (g = 7, nine terms) with the recurrence Γ(z + 1) = zΓ(z) below one half instead of the sine reflection.

// the two words of a double through typed views of one buffer (faster than a DataView); which index holds the high
// word is the platform's byte order, read once, so the bits are the same everywhere
const f64 = new Float64Array(1);
const i32 = new Int32Array(f64.buffer);
const u32 = new Uint32Array(f64.buffer);
const HI = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 1 : 0; // little-endian: the high word is the second
const LO = 1 - HI;
/** The high 32 bits of a double, signed (fdlibm's __HI). */
const hiWord = (x) => {
  f64[0] = x;
  return i32[HI];
};
/** The low 32 bits of a double, unsigned (fdlibm's __LO). */
const loWord = (x) => {
  f64[0] = x;
  return u32[LO];
};
/** x with its high word replaced (fdlibm's __HI(x) = hi). */
const withHi = (x, hi) => {
  f64[0] = x;
  i32[HI] = hi | 0;
  return f64[0];
};

// --- exp (fdlibm e_exp.c) -----------------------------------------------------------------------

const halF = [0.5, -0.5];
const oThreshold = 7.09782712893383973096e2;
const uThreshold = -7.45133219101941108420e2;
const ln2HI = [6.93147180369123816490e-1, -6.93147180369123816490e-1];
const ln2LO = [1.90821492927058770002e-10, -1.90821492927058770002e-10];
const invln2 = 1.44269504088896338700;
const P1 = 1.66666666666666019037e-1;
const P2 = -2.77777777770155933842e-3;
const P3 = 6.61375632143793436117e-5;
const P4 = -1.65339022054652515390e-6;
const P5 = 4.13813679705723846039e-8;
const twom1000 = 9.33263618503218878990e-302;

/** e^x, within one unit in the last place, the same bits in every engine. */
export function exp(x) {
  let hx = hiWord(x);
  const xsb = (hx >>> 31) & 1;
  hx &= 0x7fffffff;
  let hi = 0;
  let lo = 0;
  let k = 0;
  if (hx >= 0x40862e42) {
    if (hx >= 0x7ff00000) {
      if (((hx & 0xfffff) | loWord(x)) !== 0) return x + x; // NaN
      return xsb === 0 ? x : 0; // exp(±∞) = ∞, 0
    }
    if (x > oThreshold) return Infinity;
    if (x < uThreshold) return 0;
  }
  if (hx > 0x3fd62e42) {
    // |x| > ln2/2: x = k·ln2 + r
    if (hx < 0x3ff0a2b2) {
      hi = x - ln2HI[xsb];
      lo = ln2LO[xsb];
      k = 1 - xsb - xsb;
    } else {
      k = Math.trunc(invln2 * x + halF[xsb]);
      hi = x - k * ln2HI[0]; // exact
      lo = k * ln2LO[0];
    }
    x = hi - lo;
  } else if (hx < 0x3e300000) {
    return 1 + x; // |x| < 2⁻²⁸
  }
  const t = x * x;
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1 - ((x * c) / (c - 2) - x);
  const y = 1 - (lo - (x * c) / (2 - c) - hi);
  if (k >= -1021) return withHi(y, hiWord(y) + (k << 20));
  return withHi(y, hiWord(y) + ((k + 1000) << 20)) * twom1000;
}

// --- log (fdlibm e_log.c) -----------------------------------------------------------------------

const ln2Hi = 6.93147180369123816490e-1;
const ln2Lo = 1.90821492927058770002e-10;
const two54 = 1.80143985094819840000e16;
const Lg1 = 6.666666666666735130e-1;
const Lg2 = 3.999999999940941908e-1;
const Lg3 = 2.857142874366239149e-1;
const Lg4 = 2.222219843214978396e-1;
const Lg5 = 1.818357216161805012e-1;
const Lg6 = 1.531383769920937332e-1;
const Lg7 = 1.479819860511658591e-1;

/** The natural logarithm, within one unit in the last place, the same bits in every engine. */
export function log(x) {
  let hx = hiWord(x);
  const lx = loWord(x);
  let k = 0;
  if (hx < 0x00100000) {
    // x < 2⁻¹⁰²², or negative
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity;
    if (hx < 0) return NaN;
    k -= 54;
    x *= two54; // a subnormal, scaled up
    hx = hiWord(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  const i0 = (hx + 0x95f64) & 0x100000;
  x = withHi(x, hx | (i0 ^ 0x3ff00000)); // normalise x or x/2
  k += i0 >> 20;
  const f = x - 1;
  const dk = k;
  if ((0x000fffff & (2 + hx)) < 3) {
    // |f| < 2⁻²⁰
    if (f === 0) return k === 0 ? 0 : dk * ln2Hi + dk * ln2Lo;
    const R = f * f * (0.5 - 0.33333333333333333 * f);
    return k === 0 ? f - R : dk * ln2Hi - (R - dk * ln2Lo - f);
  }
  const s = f / (2 + f);
  const z = s * s;
  let i = hx - 0x6147a;
  const w = z * z;
  const j = 0x6b851 - hx;
  const t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
  const t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
  i |= j;
  const R = t2 + t1;
  if (i > 0) {
    const hfsq = 0.5 * f * f;
    return k === 0 ? f - (hfsq - s * (hfsq + R)) : dk * ln2Hi - (hfsq - (s * (hfsq + R) + dk * ln2Lo) - f);
  }
  return k === 0 ? f - s * (f - R) : dk * ln2Hi - (s * (f - R) - dk * ln2Lo - f);
}

// --- log1p and expm1 ------------------------------------------------------------------------------

/** log(1 + x), accurate near zero: x · log(u) / (u − 1) with u = 1 + x (Goldberg's Theorem 4). */
export function log1p(x) {
  if (x !== x) return NaN;
  if (x === Infinity) return Infinity;
  const u = 1 + x;
  if (u === 1) return x;
  if (u === 0) return -Infinity;
  if (u < 0) return NaN;
  return log(u) * (x / (u - 1));
}

/** e^x − 1, accurate near zero: (u − 1) · x / log(u) with u = e^x (Kahan); above 1, u − 1 itself (no cancellation, and the identity's product would overflow near the top of the range). */
export function expm1(x) {
  if (x !== x) return NaN;
  const u = exp(x);
  if (u === 1) return x;
  if (u === Infinity) return Infinity;
  if (x >= 1) return u - 1;
  const um1 = u - 1;
  if (um1 === -1) return -1;
  return (um1 * x) / log(u);
}

/** b^y for b > 0, as e^(y·log b): deterministic, a few units in the last place. */
export const pow = (b, y) => (y === 0 ? 1 : b === 1 ? 1 : exp(y * log(b)));

// --- the log-gamma --------------------------------------------------------------------------------

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
const HALF_LOG_TWO_PI = 0.5 * log(2 * Math.PI);

/** log Γ(z) for z > 0 (Lanczos, g = 7; below one half by log Γ(z) = log Γ(z + 1) − log z). */
export function logGamma(z) {
  if (!(z > 0)) return NaN;
  if (z < 0.5) return logGamma(z + 1) - log(z);
  const zz = z - 1;
  let x = LANCZOS[0];
  for (let i = 1; i < 9; i++) x += LANCZOS[i] / (zz + i);
  const t = zz + 7.5;
  return HALF_LOG_TWO_PI + (zz + 0.5) * log(t) - t + log(x);
}

// --- a normal sampler -------------------------------------------------------------------------------

/** A standard normal sampler from a uniform source (Marsaglia's polar method: logarithms and square roots only). */
export function normalSampler(uniform) {
  let spare = null;
  return () => {
    if (spare != null) {
      const s = spare;
      spare = null;
      return s;
    }
    for (;;) {
      const u = 2 * uniform() - 1;
      const v = 2 * uniform() - 1;
      const s = u * u + v * v;
      if (s > 0 && s < 1) {
        const m = Math.sqrt((-2 * log(s)) / s);
        spare = v * m;
        return u * m;
      }
    }
  };
}

// xrpl-sonic — exact decimal strings.
//
// Ledger amounts are strings: XRP as integer drops, issued currencies as
// decimals with up to 16 significant digits, which rippled writes plainly
// ("33490.0352556885") or in scientific form for very large and very small
// values ("1000000000000000e3", "1e-10"). Number() loses digits on both, so
// anything that compares or adds amounts goes through here: every value is a
// sign, a BigInt of digits and a power of ten, and every result is written
// back as a plain decimal string with no exponent and no trailing zeros.
//
// Pure: no DOM, no network.

const FORM = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/** @returns {{ neg: boolean, digits: bigint, exp: number }} (−1)^neg × digits × 10^exp */
export function parse(input) {
  const text = typeof input === 'number' && Number.isFinite(input) ? String(input) : input;
  if (typeof text !== 'string') throw new TypeError(`not a decimal string: ${String(input)}`);
  const m = FORM.exec(text.trim());
  if (!m) throw new TypeError(`not a decimal string: ${text}`);
  const [, sign, int = '', frac = '', e = '0'] = m;
  if (!int && !frac) throw new TypeError(`not a decimal string: ${text}`);
  let digits = BigInt(`${int}${frac}` || '0');
  let exp = Number(e) - frac.length;
  if (digits === 0n) return { neg: false, digits: 0n, exp: 0 };
  while (digits % 10n === 0n) {
    digits /= 10n;
    exp += 1;
  }
  return { neg: sign === '-', digits, exp };
}

/** The plain decimal string for a parsed value. */
export function format({ neg, digits, exp }) {
  if (digits === 0n) return '0';
  const s = digits.toString();
  let body;
  if (exp >= 0) body = s + '0'.repeat(exp);
  else if (s.length > -exp) body = `${s.slice(0, s.length + exp)}.${s.slice(s.length + exp)}`;
  else body = `0.${'0'.repeat(-exp - s.length)}${s}`;
  return neg ? `-${body}` : body;
}

export function normalize(x) {
  return format(parse(x));
}

/** Both values on a common exponent, as signed BigInts. */
function aligned(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  const exp = Math.min(pa.exp, pb.exp);
  const scale = (p) => (p.neg ? -p.digits : p.digits) * 10n ** BigInt(p.exp - exp);
  return { x: scale(pa), y: scale(pb), exp };
}

function fromSigned(value, exp) {
  return format(parse(`${value < 0n ? '-' : ''}${(value < 0n ? -value : value).toString()}e${exp}`));
}

export function add(a, b) {
  const { x, y, exp } = aligned(a, b);
  return fromSigned(x + y, exp);
}

export function sub(a, b) {
  const { x, y, exp } = aligned(a, b);
  return fromSigned(x - y, exp);
}

export function neg(a) {
  const p = parse(a);
  return format({ ...p, neg: p.digits === 0n ? false : !p.neg });
}

export function abs(a) {
  return format({ ...parse(a), neg: false });
}

/** −1, 0 or 1. */
export function cmp(a, b) {
  const { x, y } = aligned(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function isZero(a) {
  return parse(a).digits === 0n;
}

export function isNegative(a) {
  const p = parse(a);
  return p.neg && p.digits !== 0n;
}

export function mulInt(a, n) {
  const p = parse(a);
  const k = BigInt(n);
  const value = (p.neg ? -p.digits : p.digits) * k;
  return fromSigned(value, p.exp);
}

/** floor(log10(|x|)), or null for zero. */
function magnitude(x) {
  const p = parse(x);
  if (p.digits === 0n) return null;
  return p.digits.toString().length - 1 + p.exp;
}

/**
 * Equal to within the precision the ledger keeps. Issued amounts carry 16
 * significant digits, so a sum of recorded deltas and a recorded balance
 * delta may differ in the last place of the coarsest figure involved. The
 * tolerance is one unit in the 16th significant digit of the largest
 * figure among a, b and `operands`, times the number of figures.
 */
export function nearlyEqual(a, b, { operands = [] } = {}) {
  const diff = abs(sub(a, b));
  if (isZero(diff)) return true;
  const figures = [a, b, ...operands];
  let top = null;
  for (const f of figures) {
    const m = magnitude(f);
    if (m != null && (top == null || m > top)) top = m;
  }
  if (top == null) return false;
  const tolerance = format({ neg: false, digits: BigInt(figures.length), exp: top - 15 });
  return cmp(diff, tolerance) <= 0;
}

/**
 * Is |num| / |den| above 1 and at most 2? That is the range a transfer fee
 * can stretch a debit by (TransferRate is between 1.0 and 2.0).
 */
export function divRatio(num, den) {
  const bounds = { above: 1, atMost: 2 };
  if (isZero(den)) return { ...bounds, within: false };
  const n = abs(num);
  const d = abs(den);
  const within = cmp(n, d) > 0 && cmp(n, mulInt(d, 2)) <= 0;
  return { ...bounds, within };
}

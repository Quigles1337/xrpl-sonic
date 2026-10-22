// xrpl-sonic — the interference field (docs/coherence.md, phase 2).
//
// Relations between accounts as interference between their sigils. Each
// cast member with a judged series is a source; a pair draws only when its
// prewhitened percentile clears the significance bar with a null that can
// resolve it (src/coherence.js `significant()`). A cell of the coarse grid
// under the sigils has a path difference to the two sources, λ, counted in
// lags (one lag is a fixed distance on the grid), and the pair draws
// f(λ) = r · c(λ − lag): r and lag the prewhitened statistic of the pair's
// readout line, c a carrier at the cadence's period (a shared cadence gives
// the spacing, two cadences a beat, none a single lobe one lag wide). Beyond
// ±L the function tapers to nothing, so the picture shows only lags the
// statistic measured. The glow at a cell is the sum over the drawn pairs of
// max(0, f) in the blend of the two members' colours; the fringe lines are
// the zero crossings of each pair's f. Every feature of the picture is one
// of three numbers of the readout line (r, lag, cadence) and the record
// count in the label. Nothing here says "coordinated".
//
// Pure: no DOM, no canvas. src/visual.js paints what fieldGrid() returns.

import { significant, describePair, pairDetailLines, DEFAULTS } from './coherence.js';
import { sigilPattern } from './explorer/sigil.js';
import { hexToRgb } from './glyphs.js';

export const FIELD_MODES = Object.freeze(['off', 'cast', 'pair']);
/** Cell sizes in CSS px, from the default to the coarsest the budget rule may fall to. */
export const CELL_SIZES = Object.freeze([16, 32, 48]);
/** The budget rule: the field's own frame time, averaged over `frames`, above `dropAboveMs` doubles the cell; under `restoreBelowMs` steps it back. */
export const BUDGET = Object.freeze({ dropAboveMs: 3, restoreBelowMs: 0.6, frames: 10 });
/** How far beyond ±L the fringe function tapers to nothing, in lags. */
export const TAPER = 1;
/** Seconds per lag for the beat animation: a lag is a ledger, and a ledger closes about every four seconds. */
export const SECONDS_PER_LAG = 4;
/** The least |f| at which a cell belongs to a pair for a click. */
export const HIT_LEAST = 0.05;

const fmtLag = (k) => (k > 0 ? `+${k}` : String(k));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** hsl (degrees, percent, percent) → [r, g, b] in 0..255. */
export function hslToRgb(h, s, l) {
  const S = s / 100;
  const L = l / 100;
  const C = (1 - Math.abs(2 * L - 1)) * S;
  const H = (((h % 360) + 360) % 360) / 60;
  const X = C * (1 - Math.abs((H % 2) - 1));
  let rgb = [0, 0, 0];
  if (H < 1) rgb = [C, X, 0];
  else if (H < 2) rgb = [X, C, 0];
  else if (H < 3) rgb = [0, C, X];
  else if (H < 4) rgb = [0, X, C];
  else if (H < 5) rgb = [X, 0, C];
  else rgb = [C, 0, X];
  const m = L - C / 2;
  return rgb.map((v) => Math.round((v + m) * 255));
}

/** A member's colour as [r, g, b]: its cast colour when it has one, else its sigil's hue. */
export function colourOf(address, cast = []) {
  const member = (cast ?? []).find((m) => m?.address === address);
  if (member?.colour) return hexToRgb(member.colour);
  const s = sigilPattern(address);
  return hslToRgb(s.hue, s.saturation, s.lightness);
}

/**
 * The pairs that draw: judged, with a prewhitened statistic, above the
 * significance percentile on a null that can resolve it; in `pair` mode
 * only the chosen pair (by address, either order); none when off.
 */
export function fieldPairs(report, { mode = 'cast', pair = null } = {}) {
  if (!report || !FIELD_MODES.includes(mode) || mode === 'off') return [];
  const sig = report.options?.significance ?? DEFAULTS.significance;
  const chosen = mode === 'pair' && Array.isArray(pair) && pair.length === 2 ? new Set(pair) : null;
  return (report.pairs ?? []).filter((p) => {
    if (!p.judged || p.white?.r == null || !significant(p, sig)) return false;
    if (chosen && !(chosen.has(p.a.address) && chosen.has(p.b.address))) return false;
    return true;
  });
}

/**
 * The carrier of a pair: `shared` with period P for a shared cadence,
 * `beat` with periods p and q for a mismatch (the envelope recurs every
 * pq/|q − p| lags), `lobe` when neither account has a cadence.
 */
export function carrierOf(pair) {
  const beat = pair?.beat;
  if (beat?.shared != null) return { kind: 'shared', p: beat.shared, q: null, every: null };
  if (Array.isArray(beat?.periods)) return { kind: 'beat', p: beat.periods[0], q: beat.periods[1], every: beat.every };
  return { kind: 'lobe', p: null, q: null, every: null };
}

/**
 * The fringe function of a pair at path difference λ (in lags), with the
 * beat's phase (radians; 0 is stationary): r times the carrier centred on
 * the lag, tapered to nothing beyond ±(L + TAPER).
 */
export function fringe(pair, lambda, phase = 0) {
  return fringeOf(fringeParams(pair), lambda, phase);
}

/** The three numbers a pair draws from, read once: r and lag (prewhitened), the carrier, the lag range. */
export function fringeParams(pair) {
  return { r: pair?.white?.r ?? 0, lag: pair?.white?.lag ?? 0, carrier: carrierOf(pair), L: pair?.maxLag ?? DEFAULTS.maxLag };
}

/** fringe() on parameters already read, allocation-free, for the grid. */
export function fringeOf({ r, lag, carrier, L }, lambda, phase = 0) {
  const u = lambda - lag;
  let value;
  if (carrier.kind === 'shared') value = Math.cos((2 * Math.PI * u) / carrier.p);
  else if (carrier.kind === 'beat') value = 0.5 * (Math.cos((2 * Math.PI * u) / carrier.p) + Math.cos((2 * Math.PI * u) / carrier.q + phase));
  else value = Math.abs(u) <= 1.5 ? Math.cos(Math.PI * u) : 0;
  const edge = Math.abs(lambda) - L;
  const taper = edge <= 0 ? 1 : edge >= TAPER ? 0 : 1 - edge / TAPER;
  return r * value * taper || 0; // never −0
}

/** The label of a drawn pair: the lag and the record check, never a verdict. */
export function fieldLabel(pair) {
  const lag = pair?.white?.lag ?? 0;
  const n = pair?.record?.count ?? null;
  const touch = n == null ? 'record not available' : n > 0 ? `connected in the record: ${n}` : 'not touching';
  return `${pair.a.label} ↔ ${pair.b.label}: in step at lag ${fmtLag(lag)} · ${touch}`;
}

/** Why nothing is drawn, in a sentence, or null when something is. */
export function fieldSummary(report, drawn, { mode = 'cast', hasCast = true } = {}) {
  if (mode === 'off') return 'field off';
  if (!hasCast) return 'field: no cast; the field draws interference between cast sigils only';
  if (drawn.length) return null;
  if (!report || !report.pairs?.length) return `field: nothing drawn · ${report?.window?.ledgers ? 'fewer than two accounts to compare' : 'no ledger heard yet'}`;
  const judged = report.pairs.filter((p) => p.judged && !p.flat?.a && !p.flat?.b).length;
  const tested = report.tested ?? 0;
  const ab = report.above ?? {};
  const pct = Math.round((report.options?.significance ?? DEFAULTS.significance) * 100);
  const bits = [`field: nothing drawn`];
  if (!judged) bits.push(`no pair judged: ${report.pairs[0]?.reason ?? 'below the guard'}`);
  else {
    bits.push(`${tested} pair${tested === 1 ? '' : 's'} tested, ${ab.white ?? 0} above the ${pct}th prewhitened`);
    if (ab.unresolved) bits.push(`${ab.unresolved} with fewer than ${ab.minShuffles ?? 20} shifts, where the ${pct}th cannot be resolved`);
    if (mode === 'pair' && (ab.white ?? 0) > 0) bits.push('the chosen pair is not among them');
  }
  return bits.join(' · ');
}

/**
 * The model the painter needs: the sources (one per cast member of the
 * report that was judged, in the report's order; the field is between cast
 * sigils only), the drawn pairs with their fringe
 * parameters, colours and labels, the lag range, the unit, and the sentence
 * when nothing is drawn.
 * @param {object} report  from coherence()
 * @param {{ mode?: string, pair?: string[]|null, cast?: object[] }} [options]
 */
export function fieldModel(report, { mode = 'cast', pair = null, cast = [] } = {}) {
  const hasCast = Boolean(cast?.length);
  const drawn = hasCast ? fieldPairs(report, { mode, pair }) : [];
  const unit = report?.unit ?? 'ledger';
  const L = report?.maxLag ?? DEFAULTS.maxLag;
  const judged = new Set();
  for (const p of report?.pairs ?? []) if (p.judged) judged.add(p.a.address).add(p.b.address);
  const inCast = new Set((cast ?? []).map((m) => m?.address));
  const sources = (report?.accounts ?? []).filter((a) => judged.has(a.address) && inCast.has(a.address)).map((a) => ({ address: a.address, label: a.label, rgb: colourOf(a.address, cast), cells: sigilPattern(a.address).cells, events: a.events, cadence: a.cadence?.period ?? null }));
  const index = new Map(sources.map((s, i) => [s.address, i]));
  const pairs = drawn
    .filter((p) => index.has(p.a.address) && index.has(p.b.address))
    .map((p) => {
      const ca = colourOf(p.a.address, cast);
      const cb = colourOf(p.b.address, cast);
      return {
        a: index.get(p.a.address),
        b: index.get(p.b.address),
        r: p.white.r,
        lag: p.white.lag,
        carrier: carrierOf(p),
        rgb: [0, 1, 2].map((i) => Math.round((ca[i] + cb[i]) / 2)),
        label: fieldLabel(p),
        line: describePair(p, { significance: report.options?.significance }),
        detail: pairDetailLines(p, { maxHashes: report.options?.maxHashes }),
        pair: p,
      };
    });
  const animated = pairs.some((p) => p.carrier.kind === 'beat');
  const window = report?.window ? `#${report.window.from}–#${report.window.to}` : '';
  const caption = report ? `${unit === 'ledger' ? 'per ledger' : `per ${unit}`} · ${window} · lags ±${L} ${unit}${L === 1 ? '' : 's'} · ${report.tested ?? 0} pair${report.tested === 1 ? '' : 's'} tested` : '';
  return { on: mode !== 'off', mode, unit, L, sources, pairs, animated, caption, summary: fieldSummary(report, drawn, { mode, hasCast }), tested: report?.tested ?? 0 };
}

/**
 * Where the sources sit in a band of the plate: a row across it, evenly
 * spaced, with one lag a fixed fraction of the spacing so the whole lag
 * range of a pair, with its taper, fits between adjacent sigils: along the
 * segment between two sources the path difference runs from −D to D.
 * @returns {{ points: { x: number, y: number }[], unit: number, spacing: number }}  CSS px; `unit` is px per lag
 */
export function fieldLayout(model, { width, height, band = { top: 0.12, bottom: 0.52 } } = {}) {
  const n = model?.sources?.length ?? 0;
  const left = Math.min(48, width * 0.06);
  // on a wide plate the instrument panel covers the right 30%: the row keeps clear of it, as the ledger stamp does
  const right = width >= 900 ? Math.max(left, Math.min(360, width * 0.3)) : left;
  const span = Math.max(1, width - left - right);
  const spacing = n > 1 ? span / (n - 1) : span;
  const points = [];
  for (let i = 0; i < n; i++) points.push({ x: n > 1 ? left + spacing * i : width / 2, y: height * band.top });
  const unit = spacing / ((model?.L ?? DEFAULTS.maxLag) + TAPER);
  return { points, unit, spacing, left, right: width - right, top: height * band.top, bottom: height * band.bottom };
}

/**
 * The grid: per cell the glow in rgb (summed over the drawn pairs, each
 * max(0, f) in its colour), the dominant pair (largest |f|) and its value,
 * and per pair its f, for the fringe lines and the click.
 * @param {object} model  from fieldModel()
 * @param {{ width: number, height: number, cell?: number, phase?: number, layout?: object }} geometry  CSS px; phase in radians for the beat
 */
export function fieldGrid(model, { width, height, cell = CELL_SIZES[0], phase = 0, layout = null } = {}) {
  const lay = layout ?? fieldLayout(model, { width, height });
  const cols = Math.max(1, Math.ceil(width / cell));
  const top = Math.floor(lay.top / cell);
  const rows = Math.max(1, Math.ceil(lay.bottom / cell) - top);
  const n = cols * rows;
  const pairs = model?.pairs ?? [];
  const params = pairs.map((p) => ({ r: p.r, lag: p.lag, carrier: p.carrier, L: model.L }));
  const rgb = new Float32Array(n * 3);
  const best = new Int16Array(n).fill(-1);
  const bestValue = new Float32Array(n);
  const perPair = pairs.map(() => new Float32Array(n));
  for (let row = 0; row < rows; row++) {
    const y = (top + row + 0.5) * cell;
    for (let col = 0; col < cols; col++) {
      const x = (col + 0.5) * cell;
      const i = row * cols + col;
      pairs.forEach((p, k) => {
        const A = lay.points[p.a];
        const B = lay.points[p.b];
        const lambda = (Math.hypot(x - A.x, y - A.y) - Math.hypot(x - B.x, y - B.y)) / lay.unit;
        const f = fringeOf(params[k], lambda, phase);
        perPair[k][i] = f;
        if (Math.abs(f) > Math.abs(bestValue[i])) {
          bestValue[i] = f;
          best[i] = k;
        }
        if (f > 0) {
          rgb[i * 3] += (f * p.rgb[0]) / 255;
          rgb[i * 3 + 1] += (f * p.rgb[1]) / 255;
          rgb[i * 3 + 2] += (f * p.rgb[2]) / 255;
        }
      });
    }
  }
  return { cols, rows, top, cell, rgb, best, bestValue, perPair, layout: lay };
}

/**
 * The fringe lines of one pair: the zero crossings of its f on the grid,
 * by marching squares with linear interpolation, as segments in CSS px.
 * @returns {{ x1: number, y1: number, x2: number, y2: number }[]}
 */
export function fringeLines(grid, k) {
  const f = grid.perPair[k];
  if (!f) return [];
  const { cols, rows, cell, top } = grid;
  const at = (col, row) => f[row * cols + col];
  const px = (col) => (col + 0.5) * cell;
  const py = (row) => (top + row + 0.5) * cell;
  const cross = (a, b) => (a === 0 ? 0 : a / (a - b)); // where the zero sits between two samples, 0..1
  const out = [];
  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const v = [at(col, row), at(col + 1, row), at(col + 1, row + 1), at(col, row + 1)];
      if (v.every((x) => x === 0)) continue;
      const pts = [];
      if (v[0] * v[1] < 0) pts.push([px(col) + cross(v[0], v[1]) * cell, py(row)]);
      if (v[1] * v[2] < 0) pts.push([px(col + 1), py(row) + cross(v[1], v[2]) * cell]);
      if (v[2] * v[3] < 0) pts.push([px(col + 1) - cross(v[2], v[3]) * cell, py(row + 1)]);
      if (v[3] * v[0] < 0) pts.push([px(col), py(row + 1) - cross(v[3], v[0]) * cell]);
      if (pts.length === 2) out.push({ x1: pts[0][0], y1: pts[0][1], x2: pts[1][0], y2: pts[1][1] });
      else if (pts.length === 4) {
        out.push({ x1: pts[0][0], y1: pts[0][1], x2: pts[1][0], y2: pts[1][1] });
        out.push({ x1: pts[2][0], y1: pts[2][1], x2: pts[3][0], y2: pts[3][1] });
      }
    }
  }
  return out;
}

/** Where a drawn pair's label sits: the point on the line between its sources where λ equals its lag (the brightest fringe), clamped to the band. */
export function labelPoint(model, grid, k) {
  const p = model.pairs[k];
  const lay = grid.layout;
  const A = lay.points[p.a];
  const B = lay.points[p.b];
  const d = Math.hypot(B.x - A.x, B.y - A.y) || 1;
  // along AB, d_A − d_B = 2t − d for t from A: t = (λ·unit + d) / 2
  const t = clamp((p.lag * lay.unit + d) / 2, 0, d);
  const x = A.x + ((B.x - A.x) * t) / d;
  const y = lay.top + (lay.bottom - lay.top) * (0.25 + 0.5 * (k / Math.max(1, model.pairs.length)));
  return { x, y };
}

/** The pair under a point, when a drawn pair reaches it: its model entry, else null. */
export function fieldHit(model, grid, x, y) {
  if (!grid || !model?.pairs?.length) return null;
  const col = Math.floor(x / grid.cell);
  const row = Math.floor(y / grid.cell) - grid.top;
  if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return null;
  const i = row * grid.cols + col;
  const k = grid.best[i];
  if (k < 0 || Math.abs(grid.bestValue[i]) < HIT_LEAST) return null;
  return { index: k, pair: model.pairs[k], value: grid.bestValue[i] };
}

/** The next cell size under the budget rule, given the mean frame time; the same size when neither bound is crossed. */
export function nextCell(cell, meanMs) {
  const i = CELL_SIZES.indexOf(cell);
  const at = i < 0 ? 0 : i;
  if (meanMs > BUDGET.dropAboveMs && at < CELL_SIZES.length - 1) return CELL_SIZES[at + 1];
  if (meanMs < BUDGET.restoreBelowMs && at > 0) return CELL_SIZES[at - 1];
  return CELL_SIZES[at];
}

/** The beat's phase at a time, in radians: the envelope recurs every `every` lags, one lag per SECONDS_PER_LAG. */
export function beatPhase(model, seconds) {
  const beat = (model?.pairs ?? []).find((p) => p.carrier.kind === 'beat');
  if (!beat || !beat.carrier.every) return 0;
  return ((2 * Math.PI * seconds) / (beat.carrier.every * SECONDS_PER_LAG)) % (2 * Math.PI);
}

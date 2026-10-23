// UNIVERSE — the overlay both renderers share: ignitions, the ledger pulse,
// the marks of the kinds, the cast rings, the labels, the nebula labels.
//
// The two skies (src/universe/sky.js on the 2D canvas, src/universe/sky-gl.js
// in WebGL) draw the planets; everything that is text or a mark is drawn
// here, on the 2D overlay canvas above them, so the two paths cannot drift
// apart in what they say. Nothing here is invented (docs/universe.md,
// decision 3): the ignition is the plate's (a scale-in with a little
// overshoot and a white-hot core, 220 ms and 180 ms, none under reduced
// motion); the ledger pulse is the plate's ring from the centre; the marks
// are the field guide's shapes (the lattice's hexagon for a star, the pool's
// three rings for a binary star, the struck-through treatment of a cancelled
// offer for a black hole candidate and a collapsed planet); the colours are
// the field guide's and the plate's ink and pulse; the type is the plate's
// monospace stack.

import { CATEGORIES } from '../mapping.js';
import { KINDS, labelOf, nebulaLabel } from './bodies.js';

export const MONO = '"JetBrains Mono", "Cascadia Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace';
export const PULSE_COLOUR = '#c8dcff';
export const INK = Object.freeze([128, 164, 224]);
export const PULSE_RGB = Object.freeze([200, 220, 255]);
/** The plate's ignition: scale-in with overshoot for SPAWN_MS, a white-hot core for FLASH_MS. */
export const SPAWN_MS = 220;
export const FLASH_MS = 180;
/** The plate's ledger pulse: a ring from the centre, 2.6 s, growing to 1.25 world units. */
export const PULSE_LIFE_MS = 2600;
export const PULSE_MAX_R = 1.25;

export const hexToRgb = (hex) => {
  const n = parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgba = ([r, g, b], a) => `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;
const easeOutBack = (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
const TRUST_RGB = hexToRgb(CATEGORIES.trust.colour);
const AMM_RGB = hexToRgb(CATEGORIES.amm.colour);

/** The ignition factor of a body born `age` ms ago: the plate's overshoot, 1 after SPAWN_MS; always 1 under reduced motion. */
export function ignition(age, reduced = false) {
  if (reduced || !(age >= 0) || age >= SPAWN_MS) return 1;
  return easeOutBack(age / SPAWN_MS);
}

/** The white-hot core alpha of a body born `age` ms ago, 0 after FLASH_MS; always 0 under reduced motion. */
export function flashAlpha(age, reduced = false) {
  if (reduced || !(age >= 0) || age >= FLASH_MS) return 0;
  return 1 - age / FLASH_MS;
}

function hexagon(ctx, x, y, r, rot = 0) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = rot + (Math.PI / 3) * i;
    const px = x + r * Math.cos(a);
    const py = y + r * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/**
 * Draw the overlay for one frame.
 * @param {CanvasRenderingContext2D} ctx  the overlay, already scaled to CSS pixels and cleared
 * @param {object} s  screen positions: { x, y, r, depth } typed arrays indexed by planet id (depth 0 = not visible)
 * @param {object} a  the attributes from the worker: { n, kind, known, rings, holders, providers, period, r100 }
 * @param {object} o  { near: number[] (ids at the body level, far to near), focus, hover, names: (id) => {name, source, member}, bodies: (id) => body, born: Map<id, ms>, now, reduced, cast: Map<id, member>, nebulae: [{x,y,r,size}] projected to screen as { sx, sy, sr }, pulse: { start } | null, projectRing: (radius) => points[] | null, layers }
 */
export function drawOverlay(ctx, s, a, o) {
  const now = o.now ?? performance.now();
  const reduced = Boolean(o.reduced);
  ctx.lineCap = 'round';
  // --- the ledger pulse: a ring from the centre of the sky (the plate's) ----------------------
  if (o.pulse && o.projectRing) {
    const t = (now - o.pulse.start) / PULSE_LIFE_MS;
    if (t < 1) {
      const radius = reduced ? PULSE_MAX_R * 0.35 : PULSE_MAX_R * (1 - (1 - t) ** 2);
      const pts = o.projectRing(radius);
      if (pts && pts.length > 2) {
        ctx.strokeStyle = rgba(PULSE_RGB, 0.55 * (1 - t));
        ctx.lineWidth = 2;
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.stroke();
      }
    }
  }
  // --- ignitions: the white-hot core of every body born in the last FLASH_MS ----------------
  if (o.born?.size) {
    ctx.globalCompositeOperation = 'lighter';
    for (const [id, bornAt] of o.born) {
      const age = now - bornAt;
      if (age >= SPAWN_MS || !(s.depth[id] > 0)) {
        if (age >= SPAWN_MS) o.born.delete(id);
        continue;
      }
      const fa = flashAlpha(age, reduced);
      const grow = ignition(age, reduced);
      const r = Math.max(1.5, s.r[id]) * grow * 2.2;
      if (fa > 0) {
        const g = ctx.createRadialGradient(s.x[id], s.y[id], 0, s.x[id], s.y[id], r);
        g.addColorStop(0, `rgba(255, 255, 255, ${(0.9 * fa).toFixed(3)})`);
        g.addColorStop(0.4, rgba(PULSE_RGB, 0.35 * fa));
        g.addColorStop(1, rgba(PULSE_RGB, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(s.x[id], s.y[id], r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  // --- the marks of the kinds, and the cast rings, on the near bodies; a crowded near level keeps the largest 240 --
  const near = (o.near ?? []).length > 240 ? [...o.near].sort((p, q) => s.r[q] - s.r[p]).slice(0, 240) : o.near ?? [];
  for (const id of near) {
    const x = s.x[id];
    const y = s.y[id];
    const r = s.r[id];
    const kind = KINDS[a.kind[id]] ?? 'planet';
    if (!a.known[id]) {
      // balance never seen: hollow
      ctx.fillStyle = 'rgba(6, 10, 18, 0.85)';
      ctx.beginPath();
      ctx.arc(x, y, r * 0.62, 0, Math.PI * 2);
      ctx.fill();
    }
    const rings = o.layers?.trust === false ? 0 : Math.min(5, a.rings[id]);
    for (let k = 0; k < rings; k++) {
      const rr = r * (1.5 + 0.45 * k);
      ctx.strokeStyle = rgba(TRUST_RGB, 0.55 - 0.08 * k);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(x, y, rr, rr * 0.38, 0.3, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (kind === 'star') {
      // the lattice's hexagon, in the trust colour: a star is made of trust lines
      ctx.strokeStyle = rgba(TRUST_RGB, 0.85);
      ctx.lineWidth = 1.2;
      hexagon(ctx, x, y, r * 1.9, now / 9000);
      ctx.stroke();
    } else if (kind === 'binary') {
      // the pool's three overlapping rings, in the AMM colour
      ctx.strokeStyle = rgba(AMM_RGB, 0.8);
      ctx.lineWidth = 1.2;
      const breathe = reduced ? 1 : 1 + 0.06 * Math.sin(now / 700);
      for (let k = 0; k < 3; k++) {
        const ang = (k / 3) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(x + Math.cos(ang) * r * 0.5, y + Math.sin(ang) * r * 0.5, r * 1.1 * breathe, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else if (kind === 'blackhole' || kind === 'collapsed') {
      // struck through, the plate's treatment of a cancelled offer; a black hole candidate keeps a dark core
      if (kind === 'blackhole') {
        ctx.fillStyle = 'rgba(2, 3, 6, 0.96)';
        ctx.beginPath();
        ctx.arc(x, y, r * 0.78, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = rgba(PULSE_RGB, 0.9);
        ctx.lineWidth = Math.max(1.2, r * 0.16);
        ctx.beginPath();
        ctx.arc(x, y, r * 0.95, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.strokeStyle = rgba(PULSE_RGB, kind === 'collapsed' ? 0.5 : 0.85);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - r * 1.6, y + r * 0.9);
      ctx.lineTo(x + r * 1.6, y - r * 0.9);
      ctx.stroke();
    }
    const member = o.cast?.get(id);
    if (member) {
      ctx.strokeStyle = member.colour ?? '#ffffff';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(x, y, r + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (id === o.focus || id === o.hover) {
      ctx.strokeStyle = 'rgba(232, 238, 251, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r + 7, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  // --- cast rings on cast members that are not near (so a highlighted member is always findable) ---
  if (o.cast?.size) {
    for (const [id, member] of o.cast) {
      if (!(s.depth[id] > 0) || near.includes(id)) continue;
      ctx.strokeStyle = member.colour ?? '#ffffff';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(s.x[id], s.y[id], Math.max(3, s.r[id]) + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  // --- labels: the largest near bodies, the focused, the hovered, every cast member, with the threshold on every body ---
  const chosen = new Set(near.slice().sort((p, q) => s.r[q] - s.r[p]).slice(0, 14));
  if (o.focus && s.depth[o.focus] > 0) chosen.add(o.focus);
  if (o.hover && s.depth[o.hover] > 0) chosen.add(o.hover);
  if (o.cast?.size) for (const id of o.cast.keys()) if (s.depth[id] > 0) chosen.add(id);
  ctx.font = `500 10px ${MONO}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (const id of chosen) {
    const named = o.names(id);
    const body = o.bodies(id);
    const suffix = labelOf(body);
    const text = suffix ? `${named.name} · ${suffix}` : named.name;
    const off = Math.max(3, s.r[id]) + 8;
    const member = o.cast?.get(id);
    ctx.fillStyle = id === o.focus ? 'rgba(232, 238, 251, 1)' : member ? member.colour ?? 'rgba(232, 238, 251, 0.95)' : 'rgba(183, 194, 217, 0.85)';
    ctx.fillText(text, s.x[id] + off, s.y[id]);
  }
  // --- nebula labels at far zoom ---------------------------------------------------------------
  if (o.nebulae?.length) {
    ctx.fillStyle = rgba(INK, 0.8);
    ctx.textAlign = 'center';
    const placed = [];
    for (const nb of [...o.nebulae].sort((p, q) => q.size - p.size)) {
      if (!(nb.sr >= 24)) continue;
      const ly = nb.sy + nb.sr + 10;
      if (placed.some(([px, py]) => Math.abs(px - nb.sx) < 260 && Math.abs(py - ly) < 24)) continue;
      placed.push([nb.sx, ly]);
      ctx.fillText(nebulaLabel(nb.size), nb.sx, ly);
    }
  }
  // --- pair labels ------------------------------------------------------------------------------
  if (o.pairs?.length) {
    ctx.fillStyle = rgba(PULSE_RGB, 0.8);
    ctx.textAlign = 'center';
    for (const pr of o.pairs) {
      if (!(s.depth[pr.a] > 0) || !(s.depth[pr.b] > 0)) continue;
      ctx.fillText(pr.label.split(' · ')[0], (s.x[pr.a] + s.x[pr.b]) / 2, (s.y[pr.a] + s.y[pr.b]) / 2 - 8);
    }
  }
}

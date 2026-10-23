// UNIVERSE phase 1.5 — the motion grammar: one object, one motion, one still.
//
// Both renderers draw every event through this module. A motion is an
// event in flight: the object, its ends as planet ids, its start and life
// on the flight clock, its colour and size. For a frame, `primitivesOf`
// turns a motion into primitives that either renderer can draw: lines,
// dots, rings and darts in screen space, from the screen positions of the
// planets. Under reduced motion `primitivesOf` returns the object's still
// marker instead (docs/universe.md, "Phase 1.5"), so a still sky says the
// same things a moving one does.
//
// Nothing here is invented beyond the plate's ignition language: a comet is
// the photon with its tail, a spark is the ignition's white-hot core that
// never moves, a flash is the pulse ring, a rock is the mote, a dart is the
// spectral line's diamond turned along its path, the ring of light is the
// pulse ring, the star's ignition is the lattice's hexagon.
//
// Pure: no DOM.

import { hashString } from '../mapping.js';

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const easeOut = (t) => 1 - (1 - t) ** 3;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const WHITE = Object.freeze([255, 255, 255]);
const GREY = Object.freeze([128, 136, 150]);
const PULSE = Object.freeze([200, 220, 255]);
const TAU = Math.PI * 2;

/** The life of an object's motion in ledger intervals (comets fly one interval, as before). */
export const LIFE = Object.freeze({ comet: 0.9, 'bent-comet': 1.1, partial: 0.9, burn: 1.0, dust: 0.5, shower: 0.9, 'long-period': 1.6, 'long-period-arrive': 1.2, 'long-period-return': 1.2, 'check-drift': 1.2, 'check-cash': 0.8, 'check-cancel': 0.3, 'moon-capture': 1.2, 'reverse-comet': 0.9, collapse: 1.2, beam: 1.5, 'beam-fund': 1.0, 'beam-pulse': 0.8, rocket: 1.0, deorbit: 0.8, freeze: 1.0, beacon: 1.0, gate: 1.5, ignite: 1.5, rock: 0.6, fill: 0.9, flare: 0.4, blink: 0.3, crumble: 0.6, 'binary-form': 1.5, 'binary-brighten': 0.8, 'binary-dim': 0.8, satellite: 1.5, 'binary-collapse': 1.0, ring: 0.7, nameplate: 1.0, darken: 1.2, tilt: 1.2, guardians: 1.5, shimmer: 0.5, 'moon-form': 1.0, 'moon-crumble': 0.8, 'moon-beacon': 0.7, 'moon-beacon-off': 0.3, lighthouse: 1.5, badge: 0.7, tick: 0.15, spark: 0.25 });

/** How loud an object is: the size scale and the alpha, by frequency (payments, offers and wrappers small and quiet; control changes noticed). */
export const LOUDNESS = Object.freeze({ comet: 1, 'bent-comet': 1.1, partial: 1, burn: 0.9, dust: 0.45, shower: 0.6, 'long-period': 1, 'long-period-arrive': 1, 'long-period-return': 1, 'check-drift': 0.9, 'check-cash': 0.9, 'check-cancel': 0.6, 'moon-capture': 1.1, 'reverse-comet': 1.3, collapse: 1.6, beam: 1.2, 'beam-fund': 1.1, 'beam-pulse': 1, rocket: 1.1, deorbit: 1, freeze: 1.2, beacon: 1.1, gate: 1.2, ignite: 2, rock: 0.5, fill: 0.8, flare: 0.7, blink: 0.4, crumble: 0.45, 'binary-form': 1.6, 'binary-brighten': 0.9, 'binary-dim': 0.8, satellite: 1.1, 'binary-collapse': 1.5, ring: 0.8, nameplate: 1.2, darken: 1.8, tilt: 1.8, guardians: 1.8, shimmer: 0.35, 'moon-form': 1, 'moon-crumble': 0.9, 'moon-beacon': 0.6, 'moon-beacon-off': 0.4, lighthouse: 1.2, badge: 0.9, tick: 0.2, spark: 0.5 });

/** A stable angle for an owner's rock in a belt (so a rock stays where it was set). */
export function rockAngle(owner, sequence) {
  return (hashString(`${owner}:${sequence ?? 0}`) / 4294967296) * TAU;
}

/** The belt radius around a host, in screen pixels, for a price band in [0, 1] (0 the lowest price seen on the book, 1 the highest). */
export function beltRadius(hostR, band = 0.5) {
  return Math.max(hostR, 3) * 1.6 + 10 + clamp(band, 0, 1) * 22;
}

/** A point on a polyline through the given screen points at fraction f of its length. */
function along(points, f) {
  if (points.length === 1) return points[0];
  let total = 0;
  const seg = [];
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    seg.push(d);
    total += d;
  }
  let want = clamp(f, 0, 1) * total;
  for (let i = 1; i < points.length; i++) {
    if (want <= seg[i - 1] || i === points.length - 1) {
      const u = seg[i - 1] ? clamp(want / seg[i - 1], 0, 1) : 1;
      return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * u, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * u];
    }
    want -= seg[i - 1];
  }
  return points.at(-1);
}

/** The screen path of a motion: from, through the via planets (each offset to the side so the tail bends around it), to. Null when an end is not on screen. */
function pathOf(m, s) {
  const pt = (id) => (id > 0 && s.depth[id] > 0 ? [s.x[id], s.y[id]] : null);
  const a = pt(m.from);
  const b = pt(m.to ?? m.from);
  if (!a || !b) return null;
  const points = [a];
  for (const id of m.via ?? []) {
    const v = pt(id);
    if (!v) continue;
    // slingshot: pass beside the hop, not through it, by the hop's radius plus a margin, on the side away from the straight line
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const side = (v[0] - a[0]) * nx + (v[1] - a[1]) * ny >= 0 ? 1 : -1;
    const off = Math.max(6, s.r[id] * 2.2 + 4);
    points.push([v[0] + nx * off * side, v[1] + ny * off * side]);
  }
  points.push(b);
  return points;
}

/** Comet-like motions: a head along the path with a tail behind it; `reach` is how far along the path the head gets (a partial payment arrives short). */
function comet(m, s, p, { reach = 1, dash = null, headCore = true, tailFrac = null, reverse = false } = {}) {
  let path = pathOf(m, s);
  if (!path) return p;
  if (reverse) path = [...path].reverse();
  const rgb = m.rgb;
  const t = m.t;
  const fade = t < 0.85 ? 1 : (1 - t) / 0.15;
  const e = easeInOut(t) * reach;
  const tail = tailFrac ?? Math.min(0.5, 0.06 * (m.tail ?? 1) + 0.04);
  const head = along(path, e);
  const back = along(path, Math.max(0, e - tail));
  const alpha = (m.object === 'dust' ? 0.25 : 0.7) * fade * (m.success === false ? 0.5 : 1) * m.loud;
  p.lines.push({ x0: back[0], y0: back[1], x1: head[0], y1: head[1], rgb, a: alpha, w: Math.min(4, m.width), dash });
  if (path.length > 2 && e > tail) {
    // the bent part of the tail: the path behind the straight tail, faint
    const prev = along(path, Math.max(0, e - tail * 2.5));
    p.lines.push({ x0: prev[0], y0: prev[1], x1: back[0], y1: back[1], rgb, a: alpha * 0.35, w: 1, dash });
  }
  if (headCore) p.dots.push({ x: head[0], y: head[1], r: m.object === 'dust' ? 0.8 : 1.2 + 0.4 * m.loud, rgb: WHITE, a: 0.9 * fade, core: true });
  return p;
}

/** The still marker of a comet-like motion: the whole path at low alpha, the head at its end. */
function cometStill(m, s, p, { reach = 1, dash = null, reverse = false } = {}) {
  let path = pathOf(m, s);
  if (!path) return p;
  if (reverse) path = [...path].reverse();
  const alpha = (m.object === 'dust' ? 0.2 : 0.5) * (1 - m.t) * m.loud;
  const end = along(path, reach);
  for (let i = 1; i < path.length; i++) {
    const seg = i === path.length - 1 ? end : path[i];
    p.lines.push({ x0: path[i - 1][0], y0: path[i - 1][1], x1: seg[0], y1: seg[1], rgb: m.rgb, a: alpha, w: Math.min(3, m.width), dash });
    if (seg === end) break;
  }
  p.dots.push({ x: end[0], y: end[1], r: 1.6, rgb: WHITE, a: 0.8 * (1 - m.t), core: true });
  return p;
}

/** A dart: the spectral line's diamond turned along its direction. */
function dart(p, x, y, angle, len, rgb, a) {
  p.darts.push({ x, y, angle, len, rgb, a });
}

/** A pulse ring at a planet (the plate's), expanding then fading; still: a ring at a fixed radius. */
function pulse(m, s, p, id, { rgb = m.rgb, grow = 10, w = 1, dash = null, still = false } = {}) {
  if (!(id > 0) || !(s.depth[id] > 0)) return p;
  const t = m.t;
  const r = s.r[id] + (still ? grow * 0.4 : 2 + grow * easeOut(t));
  p.rings.push({ x: s.x[id], y: s.y[id], r, rgb, a: 0.6 * (still ? 1 - t : 1 - t) * m.loud, w, dash });
  return p;
}

/** The spark: the ignition's white-hot core at the planet, never leaving it. */
function spark(m, s, p, id, { rgb = m.rgb } = {}) {
  if (!(id > 0) || !(s.depth[id] > 0)) return p;
  const a = (1 - m.t) * 0.9 * m.loud;
  p.dots.push({ x: s.x[id], y: s.y[id], r: 1.5 + 2.5 * (1 - m.t), rgb: WHITE, a, core: true });
  p.dots.push({ x: s.x[id], y: s.y[id], r: 3 + 4 * (1 - m.t), rgb, a: a * 0.5, core: false });
  return p;
}

/** A bead in orbit around a planet at a stable angle. */
function orbitPoint(s, id, angle, extra = 0) {
  const r = Math.max(3, s.r[id]) * 1.5 + 6 + extra;
  return [s.x[id] + Math.cos(angle) * r, s.y[id] + Math.sin(angle) * r * 0.42, r];
}

/**
 * The primitives of one motion for a frame.
 * @param {object} m  { object, from, to, via, at, t (0..1), rgb, loud, width, tail, success, detail, seed }
 * @param {object} s  screen positions { x, y, r, depth } by planet id
 * @param {{ reduced: boolean, now: number }} opts
 * @returns {{ lines: object[], dots: object[], rings: object[], darts: object[] }}
 */
export function primitivesOf(m, s, { reduced = false, now = 0 } = {}) {
  const p = { lines: [], dots: [], rings: [], darts: [] };
  const at = m.at ?? m.from;
  const on = (id) => id > 0 && s.depth[id] > 0;
  switch (m.object) {
    case 'comet':
    case 'dust':
    case 'shower':
      return reduced ? cometStill(m, s, p) : comet(m, s, p);
    case 'bent-comet':
      return reduced ? cometStill(m, s, p) : comet(m, s, p);
    case 'partial':
      return reduced ? cometStill(m, s, p, { reach: 0.82 }) : comet(m, s, p, { reach: 0.82 });
    case 'burn': {
      // out of the planet, around it (through the book or pool when one is in the record) and back
      if (!on(m.from)) return p;
      const r = Math.max(4, s.r[m.from]) * 2.4 + 8;
      if (reduced) {
        p.rings.push({ x: s.x[m.from], y: s.y[m.from], r, rgb: m.rgb, a: 0.5 * (1 - m.t) * m.loud, w: 1 });
        return p;
      }
      const a0 = m.seed;
      const a1 = a0 + easeInOut(m.t) * TAU;
      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        const u0 = a0 + ((a1 - a0) * (i - 1)) / steps;
        const u1 = a0 + ((a1 - a0) * i) / steps;
        const fade = (i / steps) ** 2;
        p.lines.push({ x0: s.x[m.from] + Math.cos(u0) * r, y0: s.y[m.from] + Math.sin(u0) * r * 0.5, x1: s.x[m.from] + Math.cos(u1) * r, y1: s.y[m.from] + Math.sin(u1) * r * 0.5, rgb: m.rgb, a: 0.7 * fade * (1 - m.t * 0.5) * m.loud, w: Math.min(3, m.width) });
      }
      p.dots.push({ x: s.x[m.from] + Math.cos(a1) * r, y: s.y[m.from] + Math.sin(a1) * r * 0.5, r: 1.4, rgb: WHITE, a: 0.9 * (1 - m.t), core: true });
      return p;
    }
    case 'long-period':
      return reduced ? cometStill(m, s, p, { dash: [3, 4] }) : comet(m, s, p, { dash: [3, 4] });
    case 'long-period-arrive':
      return reduced ? cometStill(m, s, p, { dash: [3, 4] }) : comet(m, s, p, { dash: [3, 4] });
    case 'long-period-return':
      return reduced ? cometStill(m, s, p, { dash: [3, 4], reverse: false }) : comet(m, s, p, { dash: [3, 4] });
    case 'check-drift':
    case 'check-cash':
    case 'moon-capture':
      // a bead drifting along the path, no tail
      if (reduced) return cometStill(m, s, p, {});
      {
        const path = pathOf(m, s);
        if (!path) return p;
        const h = along(path, easeInOut(m.t));
        const fade = m.t < 0.85 ? 1 : (1 - m.t) / 0.15;
        const prev = along(path, Math.max(0, easeInOut(m.t) - 0.08));
        p.lines.push({ x0: prev[0], y0: prev[1], x1: h[0], y1: h[1], rgb: m.rgb, a: 0.35 * fade * m.loud, w: 1 });
        p.dots.push({ x: h[0], y: h[1], r: 1.8 + m.loud, rgb: m.rgb, a: 0.9 * fade, core: false });
        p.dots.push({ x: h[0], y: h[1], r: 0.9, rgb: WHITE, a: 0.9 * fade, core: true });
        return p;
      }
    case 'check-cancel':
    case 'moon-beacon-off':
    case 'blink':
      // a brief glint where the thing was, then nothing
      if (!on(at)) return p;
      {
        const [x, y] = m.object === 'blink' ? beltPoint(m, s) : orbitPoint(s, at, m.seed);
        if (reduced) {
          p.dots.push({ x, y, r: 1.5, rgb: GREY, a: 0.5 * (1 - m.t), core: false });
          return p;
        }
        p.dots.push({ x, y, r: 1.5 + 3 * (1 - m.t), rgb: WHITE, a: 0.8 * (1 - m.t) * m.loud, core: true });
        return p;
      }
    case 'reverse-comet':
      return reduced ? cometStill(m, s, p) : comet(m, s, p);
    case 'collapse': {
      // the final comet to the destination; the planet's strike is the overlay's (its kind is collapsed from this ledger on)
      if (reduced) return cometStill(m, s, p);
      comet(m, s, p);
      if (on(m.from)) p.rings.push({ x: s.x[m.from], y: s.y[m.from], r: s.r[m.from] + 3 + 12 * easeOut(m.t), rgb: PULSE, a: 0.6 * (1 - m.t), w: 1.5 });
      return p;
    }
    case 'beam':
    case 'beam-fund':
    case 'gate': {
      // a standing line between the two planets for the motion's life
      if (!on(m.from) || !on(m.to)) return p;
      const w = m.object === 'beam-fund' ? 2.4 : m.object === 'beam' ? 1.6 : 0.8;
      const a = (reduced ? 0.5 : 0.65 * (m.t < 0.1 ? m.t / 0.1 : 1)) * (1 - Math.max(0, (m.t - 0.8) / 0.2)) * m.loud;
      p.lines.push({ x0: s.x[m.from], y0: s.y[m.from], x1: s.x[m.to], y1: s.y[m.to], rgb: m.rgb, a, w, dash: m.object === 'gate' ? [2, 4] : null });
      return p;
    }
    case 'beam-pulse': {
      if (!on(m.from) || !on(m.to)) return p;
      p.lines.push({ x0: s.x[m.from], y0: s.y[m.from], x1: s.x[m.to], y1: s.y[m.to], rgb: m.rgb, a: 0.4 * (1 - m.t) * m.loud, w: 1.6 });
      const u = reduced ? 0.5 : easeInOut(m.t);
      p.dots.push({ x: s.x[m.from] + (s.x[m.to] - s.x[m.from]) * u, y: s.y[m.from] + (s.y[m.to] - s.y[m.from]) * u, r: 2.2, rgb: WHITE, a: 0.9 * (1 - m.t), core: true });
      return p;
    }
    case 'rocket':
    case 'deorbit': {
      // a dart from the submitter to the issuer's orbit (or away from it), with a spark trail; it docks, it does not land
      if (!on(m.from) || !on(m.to)) return p;
      const x0 = s.x[m.from];
      const y0 = s.y[m.from];
      const x1 = s.x[m.to];
      const y1 = s.y[m.to];
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      const orbit = Math.max(3, s.r[m.to]) * 1.5 + 8;
      const dockF = Math.max(0.05, 1 - orbit / len);
      const outward = m.object === 'deorbit';
      const u = reduced ? dockF : outward ? dockF * (1 - easeInOut(m.t)) : Math.min(dockF, easeOut(m.t) * dockF);
      const x = x0 + dx * u;
      const y = y0 + dy * u;
      const angle = Math.atan2(dy, dx) + (u >= dockF - 1e-6 && !outward ? Math.PI / 2 : 0);
      const a = (outward ? 1 - m.t : 1) * 0.9 * m.loud;
      dart(p, x, y, angle, 7 + 3 * m.loud, m.rgb, a);
      if (!reduced) {
        for (let k = 1; k <= 3; k++) {
          const bu = u - k * 0.03 * (outward ? -1 : 1);
          if (bu < 0 || bu > 1) continue;
          p.dots.push({ x: x0 + dx * bu, y: y0 + dy * bu, r: 1.2 - k * 0.25, rgb: m.rgb, a: a * (0.5 - k * 0.12), core: false });
        }
      }
      if (!outward && u >= dockF - 1e-6) {
        // docked: an arc of the issuer's orbit lights up
        p.rings.push({ x: x1, y: y1, r: orbit, rgb: m.rgb, a: 0.5 * (1 - Math.max(0, (m.t - 0.6) / 0.4)) * m.loud, w: 1, dash: [2, 6] });
      }
      return p;
    }
    case 'freeze': {
      // the orbit recoloured, no motion: a dashed ring around the holder in the pulse colour
      if (!on(m.from)) return p;
      p.rings.push({ x: s.x[m.from], y: s.y[m.from], r: Math.max(3, s.r[m.from]) * 1.5 + 6, rgb: m.detail?.frozen ? PULSE : m.rgb, a: 0.7 * (1 - m.t * 0.5) * m.loud, w: 1.4, dash: m.detail?.frozen ? [4, 3] : null });
      return p;
    }
    case 'beacon': {
      if (!on(m.from)) return p;
      const [x, y] = orbitPoint(s, m.from, m.seed);
      const blink = reduced ? 1 : (Math.sin(now / 160) + 1) / 2;
      p.dots.push({ x, y, r: 1.6 + blink, rgb: m.rgb, a: (0.4 + 0.5 * blink) * (1 - m.t * 0.5) * m.loud, core: true });
      return p;
    }
    case 'ignite': {
      // the lattice's hexagon grows out of the planet: it is a star now
      if (!on(at)) return p;
      const r = Math.max(4, s.r[at]) * (reduced ? 1.9 : 1 + 0.9 * easeOut(Math.min(1, m.t * 2)));
      p.rings.push({ x: s.x[at], y: s.y[at], r, rgb: m.rgb, a: 0.9 * (1 - m.t * 0.7) * m.loud, w: 1.4, hex: true });
      if (!reduced) p.dots.push({ x: s.x[at], y: s.y[at], r: r * 1.6 * (1 - m.t), rgb: WHITE, a: 0.6 * (1 - m.t), core: true });
      return p;
    }
    case 'rock': {
      const [x, y] = beltPoint(m, s);
      if (!Number.isFinite(x)) return p;
      const a = (reduced ? 0.8 : Math.min(1, m.t * 4)) * m.loud;
      p.dots.push({ x, y, r: 1.6, rgb: m.rgb, a, core: false, square: true });
      return p;
    }
    case 'flare': {
      const [x, y] = beltPoint(m, s);
      if (!Number.isFinite(x)) return p;
      if (reduced) return p;
      p.dots.push({ x, y, r: 1.5 + 4 * (1 - m.t), rgb: WHITE, a: 0.9 * (1 - m.t) * m.loud, core: true });
      p.dots.push({ x, y, r: 3 + 6 * (1 - m.t), rgb: m.rgb, a: 0.5 * (1 - m.t) * m.loud, core: false });
      return p;
    }
    case 'crumble': {
      const [x, y] = beltPoint(m, s);
      if (!Number.isFinite(x)) return p;
      p.dots.push({ x, y, r: 1.6, rgb: GREY, a: 0.6 * (1 - m.t) * m.loud, core: false, square: true });
      return p;
    }
    case 'fill':
      return reduced ? cometStill(m, s, p) : comet(m, s, p, { tailFrac: 0.12 });
    case 'binary-form':
    case 'binary-brighten':
    case 'binary-dim':
    case 'binary-collapse': {
      const id = m.to ?? m.from;
      if (!on(id)) return p;
      const bright = m.object === 'binary-dim' ? 0.3 : m.object === 'binary-collapse' ? 0.5 : 1;
      const grow = m.object === 'binary-form' ? 16 : 8;
      pulse(m, s, p, id, { rgb: m.object === 'binary-collapse' ? PULSE : m.rgb, grow, w: 1.2, still: reduced });
      if (m.object === 'binary-form' || m.object === 'binary-collapse') {
        for (let k = 0; k < 3; k++) {
          const ang = (k / 3) * TAU + (reduced ? 0 : m.t);
          const R = Math.max(3, s.r[id]) * 1.1;
          p.rings.push({ x: s.x[id] + Math.cos(ang) * R * 0.5, y: s.y[id] + Math.sin(ang) * R * 0.5, r: R, rgb: m.rgb, a: 0.7 * bright * (1 - m.t) * m.loud, w: 1 });
        }
      }
      return p;
    }
    case 'satellite': {
      const id = m.to ?? m.from;
      if (!on(id)) return p;
      const [x, y] = orbitPoint(s, id, m.seed + (reduced ? 0 : m.t * TAU * 2), 4);
      p.dots.push({ x, y, r: 2, rgb: m.rgb, a: 0.9 * (1 - m.t * 0.5) * m.loud, core: false });
      return p;
    }
    case 'ring':
    case 'nameplate':
      return pulse(m, s, p, at, { grow: 12, still: reduced });
    case 'darken': {
      if (!on(at)) return p;
      const r = s.r[at] + (reduced ? 4 : 16 * (1 - easeOut(m.t)) + 2);
      p.rings.push({ x: s.x[at], y: s.y[at], r, rgb: PULSE, a: 0.8 * m.loud * (reduced ? 1 - m.t : 1), w: 1.5 });
      p.dots.push({ x: s.x[at], y: s.y[at], r: Math.max(2, s.r[at] * 0.8), rgb: [2, 3, 6], a: reduced ? 0.8 : 0.9 * easeOut(m.t), core: false });
      return p;
    }
    case 'tilt': {
      if (!on(at)) return p;
      const L = Math.max(4, s.r[at]) * 3;
      const ang = -Math.PI / 2 + (reduced ? 0.5 : easeOut(m.t) * 0.5);
      p.lines.push({ x0: s.x[at] - Math.cos(ang) * L, y0: s.y[at] - Math.sin(ang) * L, x1: s.x[at] + Math.cos(ang) * L, y1: s.y[at] + Math.sin(ang) * L, rgb: PULSE, a: 0.8 * (1 - m.t * 0.6) * m.loud, w: 1.2 });
      return p;
    }
    case 'guardians': {
      if (!on(at)) return p;
      const n = Math.max(1, m.detail?.signers?.length ?? 1);
      const quorum = m.detail?.quorum ?? 0;
      const weights = m.detail?.weights ?? [];
      const R = Math.max(3, s.r[at]) * 1.5 + 8;
      let lit = 0;
      for (let k = 0; k < n; k++) {
        const ang = m.seed + (k / n) * TAU + (reduced ? 0 : easeOut(m.t) * 0.6);
        lit += weights[k] ?? 1;
        const isLit = lit <= quorum || quorum === 0;
        p.dots.push({ x: s.x[at] + Math.cos(ang) * R, y: s.y[at] + Math.sin(ang) * R * 0.5, r: 2, rgb: isLit ? WHITE : m.rgb, a: (isLit ? 0.95 : 0.45) * (1 - m.t * 0.5) * m.loud, core: isLit });
      }
      p.rings.push({ x: s.x[at], y: s.y[at], r: R, rgb: m.rgb, a: 0.4 * (1 - m.t * 0.5) * m.loud, w: 1, ry: 0.5 });
      return p;
    }
    case 'shimmer': {
      if (!on(at)) return p;
      for (let k = 0; k < 3; k++) {
        const ang = m.seed + k * 2.1 + (reduced ? 0 : now / 400);
        const r = Math.max(3, s.r[at]) + 4 + k * 2;
        p.dots.push({ x: s.x[at] + Math.cos(ang) * r, y: s.y[at] + Math.sin(ang) * r * 0.5, r: 0.9, rgb: WHITE, a: 0.5 * (1 - m.t) * m.loud, core: true });
      }
      return p;
    }
    case 'moon-form':
    case 'moon-beacon':
    case 'badge': {
      if (!on(at)) return p;
      const [x, y] = orbitPoint(s, at, m.seed, m.object === 'badge' ? -2 : 2);
      const blink = m.object === 'moon-beacon' && !reduced ? (Math.sin(now / 150) + 1) / 2 : 1;
      p.dots.push({ x, y, r: m.object === 'badge' ? 1.6 : 2, rgb: m.rgb, a: (0.5 + 0.5 * blink) * (1 - m.t * 0.5) * m.loud, core: m.object !== 'badge', square: m.object === 'badge' });
      return p;
    }
    case 'moon-crumble': {
      if (!on(at)) return p;
      const [x, y] = orbitPoint(s, at, m.seed, 2);
      p.dots.push({ x, y, r: 2, rgb: GREY, a: 0.7 * (1 - m.t) * m.loud, core: false });
      return p;
    }
    case 'lighthouse': {
      if (!on(at)) return p;
      const L = Math.max(4, s.r[at]) * 4 + 10;
      // one turn per measured cadence (the account's interval between oracle updates); a second when none is measured yet
      const period = Math.max(400, Math.min(20000, m.detail?.cadenceMs ?? 1000));
      const ang = m.seed + (reduced ? 0 : (now / period) * TAU);
      p.lines.push({ x0: s.x[at], y0: s.y[at], x1: s.x[at] + Math.cos(ang) * L, y1: s.y[at] + Math.sin(ang) * L * 0.6, rgb: m.rgb, a: 0.55 * (1 - m.t * 0.5) * m.loud, w: 1.2 });
      return p;
    }
    case 'tick': {
      if (!on(at)) return p;
      p.dots.push({ x: s.x[at], y: s.y[at] - Math.max(3, s.r[at]) - 3, r: 0.8, rgb: m.rgb, a: 0.6 * (1 - m.t) * m.loud, core: false, square: true });
      return p;
    }
    case 'spark':
    default:
      return spark(m, s, p, at);
  }
}

/** The screen point of a rock (or its flare, blink or crumble) in its book's belt around the host; NaN when the host is off screen. */
function beltPoint(m, s) {
  const host = m.to;
  if (!(host > 0) || !(s.depth[host] > 0)) return [NaN, NaN];
  const ang = rockAngle(m.detail?.owner ?? m.from, m.detail?.sequence);
  const r = beltRadius(s.r[host], m.detail?.band ?? 0.5);
  return [s.x[host] + Math.cos(ang) * r, s.y[host] + Math.sin(ang) * r * 0.42];
}

/**
 * The weather at far zoom: flows as lines between two cluster centroids,
 * streams as short converging lines toward a star, haze as a soft ring
 * around a book host, glow as a halo on a planet; width and alpha from the
 * count. `pointOf(key)` gives a screen point for a cluster root or a planet.
 */
export function weatherPrimitives(weather, pointOf, { rgbOf = () => PULSE, reduced = false, now = 0 } = {}) {
  const p = { lines: [], dots: [], rings: [], darts: [] };
  if (!weather) return p;
  const loud = (n) => Math.min(1, 0.25 + Math.log2(1 + n) / 6);
  for (const f of weather.flows ?? []) {
    const a = pointOf(f.a);
    const b = pointOf(f.b);
    if (!a || !b) continue;
    p.lines.push({ x0: a[0], y0: a[1], x1: b[0], y1: b[1], rgb: rgbOf('payment'), a: 0.45 * loud(f.n), w: Math.min(5, 0.6 + Math.log2(1 + f.n) * 0.7) });
    if (!reduced) {
      const u = ((now / 1800) % 1 + 1) % 1;
      p.dots.push({ x: a[0] + (b[0] - a[0]) * u, y: a[1] + (b[1] - a[1]) * u, r: 1.2, rgb: WHITE, a: 0.6 * loud(f.n), core: true });
    }
  }
  for (const st of weather.streams ?? []) {
    const c = pointOf(st.star);
    if (!c) continue;
    const k = Math.min(8, st.n);
    for (let i = 0; i < k; i++) {
      const ang = (i / k) * TAU + (reduced ? 0 : now / 3000);
      const R0 = 26 + (i % 3) * 6;
      const R1 = 12;
      p.lines.push({ x0: c[0] + Math.cos(ang) * R0, y0: c[1] + Math.sin(ang) * R0 * 0.6, x1: c[0] + Math.cos(ang) * R1, y1: c[1] + Math.sin(ang) * R1 * 0.6, rgb: rgbOf('trust'), a: 0.5 * loud(st.n), w: 1 });
    }
  }
  for (const h of weather.haze ?? []) {
    const c = pointOf(h.host);
    if (!c) continue;
    p.rings.push({ x: c[0], y: c[1], r: 14 + Math.log2(1 + h.n) * 3, rgb: rgbOf('offer'), a: 0.35 * loud(h.n), w: 4, ry: 0.42, soft: true });
  }
  for (const g of weather.glow ?? []) {
    const c = pointOf(g.planet);
    if (!c) continue;
    p.dots.push({ x: c[0], y: c[1], r: 4 + Math.log2(1 + g.n) * 2, rgb: rgbOf('other'), a: 0.35 * loud(g.n), core: false });
  }
  return p;
}

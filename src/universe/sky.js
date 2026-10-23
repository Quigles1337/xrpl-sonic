// UNIVERSE — the sky on a 2D canvas, with levels of detail. The fallback
// renderer; src/universe/sky-gl.js is the first.
//
// Planets arrive as typed arrays from the worker (positions every frame the
// layout moved, attributes every ledger) and are drawn through the same
// perspective camera the plate and the constellation use (a copy of
// src/projection.js until R1 lands). Three levels of detail by projected
// size:
//
//   splat   under 2.6 px: written into a pixel buffer with a small additive
//           kernel, one putImageData for all of them;
//   sprite  to 8 px: the plate's glow sprite (a white-hot core in the
//           planet's hue) blitted at the projected size;
//   body    from 8 px: a disc; its marks, rings and label are the overlay's
//           (src/universe/overlay.js), shared with the WebGL path.
//
// Comets fly from the sender's planet to the receiver's over one ledger
// interval, with a tail as long as the payment's path, as the plate's
// photon trails; dust is faint and brief; a flash is the plate's pulse ring
// at the planet, in the category's colour, for everything that is not a
// payment. Nebulae are soft washes in the plate's nebula ink at far zoom.
// With reduced motion the camera does not turn, comets are still lines
// that fade, and nothing ignites.
//
// The renderer measures itself: frame time percentiles, where the frame
// went, and how many planets fell in each level, read by the bench harness.

import { project, referenceScale, ringPoints, clampCamera } from './projection.js';
import { CATEGORIES, CATEGORY_NAMES } from '../mapping.js';
import { drawOverlay, hexToRgb } from './overlay.js';

export const CAMERA_HOME = Object.freeze({ yaw: 0.35, pitch: 0.28, distance: 3.2, fov: 1.0, target: Object.freeze([0, 0, 0]) });
export const CAMERA_LIMITS = Object.freeze({ yaw: [-Infinity, Infinity], pitch: [-1.2, 1.2], distance: [0.25, 7] });
/** Pixel radius of a size-1 planet at the camera's reference depth: one pixel, so most of a sky is points. */
export const BASE_PX = 1.0;
export const LOD = Object.freeze({ far: 2.6, near: 8 });
/** Camera distance from which nebulae are drawn. */
export const NEBULA_ZOOM = 2.4;
/** The plate's glow sprite size. */
const SPRITE = 128;
/** The plate's nebula ink: the first of its three washes. */
const NEBULA_RGB = Object.freeze([40, 120, 190]);
/** The field guide's colours by category code (src/mapping.js CATEGORIES, in order). */
export const CATEGORY_RGB = Object.freeze(CATEGORY_NAMES.map((c) => hexToRgb(CATEGORIES[c].colour)));
/** The sky's four layers by category name; everything else is always drawn (R10 when it lands). */
export const LAYER_OF = Object.freeze({ payment: 'payment', escrow: 'payment', paychan: 'payment', offer: 'dex', amm: 'dex', trust: 'trust', nft: 'nft', batch: 'other', other: 'other' });
export const LAYER_OF_CATEGORY = Object.freeze(CATEGORY_NAMES.map((c) => LAYER_OF[c] ?? 'other'));

/** hue (degrees), s, l in [0,1] → [r, g, b] 0..255 */
export function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** The sigil's colour for a hue: the same saturation and lightness as src/explorer/sigil.js. */
export const HUE_TABLE = Object.freeze(Array.from({ length: 360 }, (_, h) => hslToRgb(h, 0.7, 0.68)));
const rgba = ([r, g, b], a) => `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const easeOutBack = (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;

/** Additive kernels for the splat level: a planet of radius r pixels is written as a (2k+1)-square where k = round(r·dpr/2), up to 2. */
const KERNELS = [[[0, 0, 1]], [[0, 0, 1], [1, 0, 0.45], [-1, 0, 0.45], [0, 1, 0.45], [0, -1, 0.45], [1, 1, 0.18], [-1, 1, 0.18], [1, -1, 0.18], [-1, -1, 0.18]], [[0, 0, 1], [1, 0, 0.7], [-1, 0, 0.7], [0, 1, 0.7], [0, -1, 0.7], [1, 1, 0.45], [-1, 1, 0.45], [1, -1, 0.45], [-1, -1, 0.45], [2, 0, 0.3], [-2, 0, 0.3], [0, 2, 0.3], [0, -2, 0.3], [2, 1, 0.15], [2, -1, 0.15], [-2, 1, 0.15], [-2, -1, 0.15], [1, 2, 0.15], [-1, 2, 0.15], [1, -2, 0.15], [-1, -2, 0.15]]];

/** Add a colour into a pixel of the ABGR buffer with saturation. */
function splat(px, index, r, g, b) {
  const v = px[index];
  const nb = Math.min(255, ((v >>> 16) & 255) + b);
  const ng = Math.min(255, ((v >>> 8) & 255) + g);
  const nr = Math.min(255, (v & 255) + r);
  px[index] = (0xff000000 | (nb << 16) | (ng << 8) | nr) >>> 0;
}

/** Percentiles of a sample, for stats(). */
export function percentiles(values, ps = [0.5, 0.95, 0.99]) {
  const v = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return Object.fromEntries(ps.map((p) => [`p${Math.round(p * 100)}`, null]));
  return Object.fromEntries(ps.map((p) => [`p${Math.round(p * 100)}`, v[Math.min(v.length - 1, Math.floor(p * v.length))]]));
}

/** The glow of a planet from its attributes at `ledger`: activity decayed by half every six ledgers, as src/universe/bodies.js glowOf. */
export function glowFromAttrs(a, id, ledger) {
  if (!a || !(a.activity[id] > 0)) return 0;
  const age = Math.max(0, ledger - a.lastLedger[id]);
  const now = a.activity[id] * 0.5 ** (age / 6);
  return Math.min(1, Math.log2(1 + now) / 5);
}

/**
 * The state and behaviour both renderers share: the camera, the data, the
 * comets, the pointer, the hit test, the overlay call. Sky (2D) and SkyGL
 * extend it and draw the planets their own way.
 */
export class SkyBase {
  constructor(canvas, labels, { reduced = false, onHover } = {}) {
    this.canvas = canvas;
    this.labels = labels;
    this.lctx = labels.getContext('2d');
    this.reduced = reduced;
    this.onHover = onHover ?? (() => {});
    this.onClick = null;
    this.camera = { ...CAMERA_HOME, target: [...CAMERA_HOME.target] };
    this.spin = { yaw: 0, pitch: 0 };
    this.drag = null;
    this.n = 0;
    this.positions = new Float32Array(3);
    this.attrs = null;
    this.addresses = [null];
    this.ledger = 0;
    this.comets = [];
    this.flashes = [];
    this.nebulae = [];
    this.pairs = [];
    this.layers = { payment: true, trust: true, dex: true, nft: true, other: true };
    this.focus = 0;
    this.hover = 0;
    this.cast = new Map(); // id → cast member
    this.names = (id) => ({ name: `#${id}`, source: 'address', member: null });
    this.bodies = () => ({ kind: 'planet' });
    this.born = new Map(); // id → ms, for the ignition
    this.pulse = null; // { start } the ledger pulse
    this.intervalMs = 4000;
    this.screen = { x: new Float32Array(1), y: new Float32Array(1), r: new Float32Array(1), depth: new Float32Array(1) };
    this.frameTimes = [];
    this.frames = 0;
    this.lodCounts = { far: 0, mid: 0, near: 0, culled: 0 };
    this.phase = null;
    this.dpr = 1;
    this.width = 1;
    this.height = 1;
    this.t0 = performance.now();
    this._resize = () => this.resize();
    globalThis.addEventListener?.('resize', this._resize);
    this._bindPointer();
  }

  destroy() {
    globalThis.removeEventListener?.('resize', this._resize);
  }

  // --- data -------------------------------------------------------------------

  setPositions(positions, n) {
    this.positions = positions;
    this.n = Math.min(n ?? Math.floor(positions.length / 3) - 1, Math.floor(positions.length / 3) - 1);
    if (this.screen.x.length < this.n + 1) {
      const len = Math.max(this.n + 1, this.screen.x.length * 2);
      this.screen = { x: new Float32Array(len), y: new Float32Array(len), r: new Float32Array(len), depth: new Float32Array(len) };
      this.grew(len);
    }
    this.positionsDirty = true;
  }

  grew() {}

  /** The attributes of a ledger; `added` are the planets born since the last, which ignite. */
  setAttributes(attrs, added = [], ledger = this.ledger) {
    this.attrs = attrs;
    const now = performance.now();
    for (const [id, address] of added) {
      this.addresses[id] = address;
      if (!this.reduced) this.born.set(id, now);
    }
    this.ledger = ledger;
    this.attrsDirty = true;
  }

  /** A ledger closed: the pulse ring from the centre. */
  ledgerClosed() {
    this.pulse = { start: performance.now() };
  }

  setNebulae(list) {
    this.nebulae = list ?? [];
  }

  setPairs(list) {
    this.pairs = list ?? [];
  }

  setLayers(layers) {
    this.layers = { ...this.layers, ...layers };
  }

  setReduced(on) {
    this.reduced = Boolean(on);
    if (this.reduced) {
      this.born.clear();
      this.spin = { yaw: 0, pitch: 0 };
    }
  }

  setFocus(id) {
    this.focus = id || 0;
  }

  /** The Watch cast as id → member, so a member's planet is ringed and labelled. */
  setCast(map) {
    this.cast = map ?? new Map();
  }

  /** The name rule and the body of a planet, supplied by the page (it holds the cast, the domains and the keys). */
  setResolvers({ names, bodies } = {}) {
    if (names) this.names = names;
    if (bodies) this.bodies = bodies;
  }

  /** The comets and flashes of a ledger, each with its start and life already set (src/universe/bodies.js flightOf). */
  addComets(list, intervalMs = this.intervalMs) {
    this.intervalMs = intervalMs;
    for (const c of list) {
      if (c.kind === 'flash') this.flashes.push(c);
      else this.comets.push(c);
    }
    if (this.comets.length > 1200) this.comets.splice(0, this.comets.length - 1200);
    if (this.flashes.length > 600) this.flashes.splice(0, this.flashes.length - 600);
  }

  // --- camera -----------------------------------------------------------------

  orbit(dyaw, dpitch) {
    this.camera = clampCamera({ ...this.camera, yaw: this.camera.yaw + dyaw, pitch: this.camera.pitch + dpitch }, CAMERA_LIMITS);
  }

  zoom(factor) {
    this.camera = clampCamera({ ...this.camera, distance: this.camera.distance * factor }, CAMERA_LIMITS);
  }

  reset() {
    this.camera = { ...CAMERA_HOME, target: [...CAMERA_HOME.target] };
    this.spin = { yaw: 0, pitch: 0 };
  }

  /** Aim the camera at a planet (keyboard travel): the target moves there, the distance closes in. */
  lookAt(id, { distance = 0.9 } = {}) {
    if (!id || id > this.n) return;
    const i = 3 * id;
    this.camera = clampCamera({ ...this.camera, target: [this.positions[i], this.positions[i + 1], this.positions[i + 2]], distance: Math.min(this.camera.distance, distance) }, CAMERA_LIMITS);
  }

  /** Camera motion for a frame: inertia, then the plate's slow turn; neither under reduced motion. */
  moveCamera() {
    if (this.drag) return;
    if (Math.abs(this.spin.yaw) > 1e-4 || Math.abs(this.spin.pitch) > 1e-4) {
      this.orbit(this.spin.yaw, this.spin.pitch);
      this.spin = { yaw: this.spin.yaw * 0.92, pitch: this.spin.pitch * 0.92 };
    } else if (!this.reduced) this.camera = { ...this.camera, yaw: this.camera.yaw + 0.0006 };
  }

  _bindPointer() {
    const c = this.canvas;
    if (!c.addEventListener) return;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.drag = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, lastT: performance.now(), moved: false };
      this.spin = { yaw: 0, pitch: 0 };
      c.setPointerCapture?.(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (this.drag) {
        const dx = e.clientX - this.drag.lastX;
        const dy = e.clientY - this.drag.lastY;
        if (Math.hypot(e.clientX - this.drag.x, e.clientY - this.drag.y) > 4) this.drag.moved = true;
        if (this.drag.moved) {
          this.orbit(-dx * 0.006, dy * 0.005);
          const dt = Math.max(1, performance.now() - this.drag.lastT);
          this.spin = this.reduced ? { yaw: 0, pitch: 0 } : { yaw: ((-dx * 0.006) / dt) * 16, pitch: ((dy * 0.005) / dt) * 16 };
        }
        this.drag.lastX = e.clientX;
        this.drag.lastY = e.clientY;
        this.drag.lastT = performance.now();
        return;
      }
      const id = this.hitTest(e.clientX, e.clientY);
      if (id !== this.hover) {
        this.hover = id;
        this.onHover(id || null);
      }
      c.style.cursor = id ? 'pointer' : 'grab';
    });
    const up = (e) => {
      if (!this.drag) return;
      const moved = this.drag.moved;
      this.drag = null;
      if (!moved) this.onClick?.(this.hitTest(e.clientX, e.clientY) || null);
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom(1 + Math.sign(e.deltaY) * 0.1);
      },
      { passive: false },
    );
    c.addEventListener('dblclick', () => this.reset());
  }

  resize() {
    const w = Math.max(1, globalThis.innerWidth || 800);
    const h = Math.max(1, globalThis.innerHeight || 600);
    this.dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    this.width = w;
    this.height = h;
    for (const c of [this.canvas, this.labels]) {
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(h * this.dpr);
    }
    this.lctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.resized();
  }

  resized() {}

  // --- hit test ---------------------------------------------------------------

  hitTest(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best = 0;
    let bd = Infinity;
    const s = this.screen;
    for (let id = 1; id <= this.n; id++) {
      if (!(s.depth[id] > 0)) continue;
      const d = Math.hypot(s.x[id] - x, s.y[id] - y);
      if (d < Math.max(7, s.r[id] * 2) && d < bd) {
        best = id;
        bd = d;
      }
    }
    return best;
  }

  glowOf(id, ledger) {
    return glowFromAttrs(this.attrs, id, ledger);
  }

  /** The nebulae projected to the screen for the frame: { sx, sy, sr, size }. */
  projectNebulae(cam, vp) {
    if (cam.distance < NEBULA_ZOOM) return [];
    const out = [];
    for (const nb of this.nebulae) {
      const p = project([nb.x, nb.y, nb.z], cam, vp);
      if (!p) continue;
      out.push({ ...nb, sx: p.x, sy: p.y, sr: Math.max(14, (nb.r + 0.04) * p.scale * 1.4) });
    }
    return out;
  }

  /** The overlay for the frame: ignitions, the pulse, marks, cast rings, labels. */
  overlay(near, now, cam, vp, projectedNebulae) {
    const l = this.lctx;
    l.clearRect(0, 0, this.width, this.height);
    if (!this.attrs) return;
    drawOverlay(l, this.screen, this.attrs, {
      near,
      focus: this.focus,
      hover: this.hover,
      names: this.names,
      bodies: this.bodies,
      born: this.born,
      now,
      reduced: this.reduced,
      cast: this.cast,
      nebulae: projectedNebulae,
      pairs: this.pairs,
      layers: this.layers,
      pulse: this.pulse,
      projectRing: (radius) => {
        const pts = ringPoints([0, 0, 0], radius, { segments: 72 }).map((p) => project(p, cam, vp));
        return pts.some((p) => !p) ? null : pts;
      },
    });
  }

  record(ms, far, mid, near, culled) {
    this.frameTimes.push(ms);
    if (this.frameTimes.length > 600) this.frameTimes.shift();
    this.frames += 1;
    this.lodCounts = { far, mid, near, culled };
  }

  /** Frame-time percentiles over the last frames, where the frame went, and how many planets fell in each level in the last one. */
  stats() {
    const p = percentiles(this.frameTimes);
    const mean = this.frameTimes.length ? this.frameTimes.reduce((x, y) => x + y, 0) / this.frameTimes.length : null;
    return { renderer: this.renderer, frames: this.frames, sampled: this.frameTimes.length, meanMs: mean, ...p, maxMs: this.frameTimes.length ? Math.max(...this.frameTimes) : null, phase: this.phase, lod: this.lodCounts, planets: this.n, comets: this.comets.length, flashes: this.flashes.length, camera: { distance: this.camera.distance }, dpr: this.dpr, size: [this.width, this.height], gpu: this.gpuName?.() ?? null };
  }
}

export class Sky extends SkyBase {
  constructor(canvas, labels, opts = {}) {
    super(canvas, labels, opts);
    this.renderer = '2d';
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.sprites = new Map();
    this.pixels = null;
    this.resize();
  }

  resized() {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.pixels = this.ctx.createImageData(this.canvas.width, this.canvas.height);
    this.pixels32 = new Uint32Array(this.pixels.data.buffer);
  }

  /** The plate's glow sprite ('core': a white-hot centre in the colour), rendered once per hue bucket. */
  sprite(hueBucket) {
    let sp = this.sprites.get(hueBucket);
    if (sp) return sp;
    const c = document.createElement('canvas');
    c.width = c.height = SPRITE;
    const g = c.getContext('2d');
    const [r, gr, b] = HUE_TABLE[(hueBucket * 10) % 360];
    const grad = g.createRadialGradient(SPRITE / 2, SPRITE / 2, 0, SPRITE / 2, SPRITE / 2, SPRITE / 2);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
    grad.addColorStop(0.1, `rgba(${r}, ${gr}, ${b}, 0.9)`);
    grad.addColorStop(0.3, `rgba(${r}, ${gr}, ${b}, 0.3)`);
    grad.addColorStop(0.6, `rgba(${r}, ${gr}, ${b}, 0.07)`);
    grad.addColorStop(1, `rgba(${r}, ${gr}, ${b}, 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, SPRITE, SPRITE);
    sp = c;
    this.sprites.set(hueBucket, sp);
    return sp;
  }

  draw(now = performance.now()) {
    const t0 = performance.now();
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const dpr = this.dpr;
    const vp = { width: this.width, height: this.height };
    this.moveCamera();
    const cam = this.camera;
    const ref = referenceScale(cam, vp);
    const attrs = this.attrs;
    const n = attrs ? Math.min(this.n, attrs.n) : 0;
    const s = this.screen;
    const px = this.pixels32;
    px.fill(0xff000000 | 0x120a06); // the background, in ABGR: #060a12
    const far = [];
    const mid = [];
    const near = [];
    let culled = 0;
    const ledger = this.ledger;
    const phase = {};
    let tp = performance.now();
    const lap = (name) => {
      const t = performance.now();
      phase[name] = (phase[name] ?? 0) + (t - tp);
      tp = t;
    };
    // project everything once; splats go straight into the buffer
    for (let id = 1; id <= n; id++) {
      const i = 3 * id;
      const p = project([this.positions[i], this.positions[i + 1], this.positions[i + 2]], cam, vp);
      if (!p) {
        s.depth[id] = 0;
        culled += 1;
        continue;
      }
      const rel = p.scale / ref;
      const r = attrs.size[id] * BASE_PX * rel;
      s.x[id] = p.x;
      s.y[id] = p.y;
      s.r[id] = r;
      s.depth[id] = p.depth;
      if (p.x < -r || p.y < -r || p.x > this.width + r || p.y > this.height + r) {
        culled += 1;
        continue;
      }
      if (r < LOD.far) {
        const X = Math.round(p.x * dpr);
        const Y = Math.round(p.y * dpr);
        const k = Math.min(2, Math.round(r * dpr * 0.5));
        if (X >= k && Y >= k && X < W - k && Y < H - k) {
          const rgb = HUE_TABLE[attrs.hue[id]];
          const glow = this.glowOf(id, ledger);
          const kind = attrs.kind[id];
          const bright = (0.65 + 0.35 * glow) * (kind === 5 ? 0.3 : 1) * (attrs.known[id] ? 1 : 0.6);
          const cr = rgb[0] * bright;
          const cg = rgb[1] * bright;
          const cb = rgb[2] * bright;
          for (const [dx, dy, w] of KERNELS[k]) splat(px, (Y + dy) * W + X + dx, (cr * w) | 0, (cg * w) | 0, (cb * w) | 0);
        }
        far.push(id);
      } else if (r < LOD.near) mid.push(id);
      else near.push(id);
    }
    lap('project');
    ctx.putImageData(this.pixels, 0, 0);
    lap('putImageData');
    ctx.save();
    ctx.scale(dpr, dpr);
    // nebulae at far zoom: soft washes in the plate's nebula ink
    const nebulae = this.projectNebulae(cam, vp);
    if (nebulae.length) {
      ctx.globalCompositeOperation = 'lighter';
      for (const nb of nebulae) {
        const a = Math.min(0.28, 0.08 + 0.02 * Math.log2(nb.size));
        const g = ctx.createRadialGradient(nb.sx, nb.sy, 0, nb.sx, nb.sy, nb.sr);
        g.addColorStop(0, rgba(NEBULA_RGB, a));
        g.addColorStop(0.5, rgba(NEBULA_RGB, a * 0.35));
        g.addColorStop(1, rgba(NEBULA_RGB, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(nb.sx, nb.sy, nb.sr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    // pairs in step: a dashed line between the two
    if (this.pairs.length) {
      ctx.setLineDash([3, 5]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(200, 220, 255, 0.45)';
      for (const pr of this.pairs) {
        if (!(s.depth[pr.a] > 0) || !(s.depth[pr.b] > 0)) continue;
        ctx.beginPath();
        ctx.moveTo(s.x[pr.a], s.y[pr.a]);
        ctx.lineTo(s.x[pr.b], s.y[pr.b]);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    lap('nebulae+pairs');
    mid.sort((a, b) => s.depth[b] - s.depth[a]);
    near.sort((a, b) => s.depth[b] - s.depth[a]);
    lap('sort');
    // sprites, far to near, additive
    ctx.globalCompositeOperation = 'lighter';
    for (const id of mid) {
      const r = s.r[id];
      const glow = this.glowOf(id, ledger);
      const sp = this.sprite(Math.floor(attrs.hue[id] / 10));
      const d = r * (2.2 + 1.6 * glow);
      ctx.globalAlpha = attrs.kind[id] === 5 ? 0.3 : attrs.known[id] ? 0.75 + 0.25 * glow : 0.45 + 0.25 * glow;
      ctx.drawImage(sp, s.x[id] - d, s.y[id] - d, 2 * d, 2 * d);
    }
    ctx.globalAlpha = 1;
    lap('mid');
    // bodies: the disc with its glow; marks and labels are the overlay's
    for (const id of near) this.drawBody(ctx, id, ledger, now);
    ctx.globalCompositeOperation = 'source-over';
    lap('near');
    this.drawComets(ctx, now);
    ctx.restore();
    lap('comets');
    this.overlay(near, now, cam, vp, nebulae);
    lap('overlay');
    this.phase = phase;
    const ms = performance.now() - t0;
    this.record(ms, far.length, mid.length, near.length, culled);
    return ms;
  }

  drawBody(ctx, id, ledger, now) {
    const a = this.attrs;
    const s = this.screen;
    const x = s.x[id];
    const y = s.y[id];
    const born = this.born.get(id);
    // the plate's ignition: a scale-in with a little overshoot over 220 ms
    const grow = born == null || this.reduced ? 1 : Math.max(0.2, easeOutBack(Math.min(1, (now - born) / 220)));
    const r = s.r[id] * grow;
    const rgb = HUE_TABLE[a.hue[id]];
    const glow = this.glowOf(id, ledger);
    const alpha = a.kind[id] === 5 ? 0.35 : 1;
    const gr = r * (2.4 + 2 * glow);
    const g = ctx.createRadialGradient(x, y, 0, x, y, gr);
    g.addColorStop(0, rgba(rgb, (0.5 + 0.4 * glow) * alpha));
    g.addColorStop(1, rgba(rgb, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, gr, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    const disc = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
    disc.addColorStop(0, `rgba(255,255,255,${(0.9 * alpha).toFixed(2)})`);
    disc.addColorStop(0.5, rgba(rgb, 0.95 * alpha));
    disc.addColorStop(1, rgba(rgb, 0.75 * alpha));
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
  }

  drawComets(ctx, now) {
    const s = this.screen;
    const alive = [];
    ctx.lineCap = 'round';
    for (const c of this.comets) {
      const t = (now - c.start) / c.life;
      if (t >= 1) continue;
      alive.push(c);
      if (t < 0) continue;
      if (this.layers[LAYER_OF_CATEGORY[c.category] ?? 'other'] === false) continue;
      const a = c.from;
      const b = c.to;
      if (!(a > 0) || !(b > 0) || !(s.depth[a] > 0) || !(s.depth[b] > 0)) continue;
      const rgb = CATEGORY_RGB[c.category] ?? CATEGORY_RGB[CATEGORY_RGB.length - 1];
      const fade = this.reduced ? 1 - t : t < 0.85 ? 1 : (1 - t) / 0.15;
      const w = c.kind === 'dust' ? 0.8 : 1 + Math.max(0, (c.log ?? 0) + 1) * 0.35;
      ctx.strokeStyle = rgba(rgb, (c.kind === 'dust' ? 0.25 : 0.7) * fade * (c.success ? 1 : 0.5));
      ctx.lineWidth = Math.min(4, w);
      ctx.setLineDash(c.success ? (c.kind === 'long-period' ? [3, 4] : []) : [4, 4]);
      if (this.reduced || a === b) {
        ctx.beginPath();
        ctx.moveTo(s.x[a], s.y[a]);
        ctx.lineTo(s.x[b], s.y[b]);
        ctx.stroke();
        continue;
      }
      const e = easeInOut(t);
      const hx = s.x[a] + (s.x[b] - s.x[a]) * e;
      const hy = s.y[a] + (s.y[b] - s.y[a]) * e;
      const tail = Math.min(0.5, 0.06 * (c.tail ?? 1) + 0.04) * (c.kind === 'dust' ? 0.5 : 1);
      const tx = s.x[a] + (s.x[b] - s.x[a]) * Math.max(0, e - tail);
      const ty = s.y[a] + (s.y[b] - s.y[a]) * Math.max(0, e - tail);
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      // the photon's head: the plate's white-hot core
      ctx.fillStyle = rgba([255, 255, 255], 0.9 * fade);
      ctx.beginPath();
      ctx.arc(hx, hy, c.kind === 'dust' ? 0.8 : 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.setLineDash([]);
    this.comets = alive;
    // flashes: the plate's pulse ring at the planet, in the category's colour
    const flashes = [];
    for (const f of this.flashes) {
      const t = (now - f.start) / f.life;
      if (t >= 1) continue;
      flashes.push(f);
      if (t < 0) continue;
      if (this.layers[LAYER_OF_CATEGORY[f.category] ?? 'other'] === false) continue;
      const id = f.at;
      if (!(id > 0) || !(s.depth[id] > 0)) continue;
      const rgb = CATEGORY_RGB[f.category] ?? CATEGORY_RGB[CATEGORY_RGB.length - 1];
      const r = s.r[id] + (this.reduced ? 4 : 2 + 10 * (1 - (1 - t) ** 2));
      ctx.strokeStyle = rgba(rgb, 0.6 * (1 - t) * (f.success ? 1 : 0.5));
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(s.x[id], s.y[id], r, 0, Math.PI * 2);
      ctx.stroke();
    }
    this.flashes = flashes;
  }
}

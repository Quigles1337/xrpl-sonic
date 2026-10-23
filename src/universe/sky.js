// UNIVERSE spike — the sky on a 2D canvas, with levels of detail.
//
// Planets arrive as typed arrays from the worker (positions every frame the
// layout moved, attributes every ledger) and are drawn through the same
// perspective camera the plate and the constellation use (a copy of
// src/projection.js). Three levels of detail by projected size:
//
//   far    under about a pixel: a point written into a pixel buffer, one
//          putImageData for all of them;
//   mid    a cached glow sprite blitted at the projected size;
//   near   the body itself: glow, disc, rings for funded trust lines, the
//          kind's mark (a star's spikes, a binary's two discs, a black
//          hole's dark core and bright rim, a pulsar's beam), and a label.
//
// Comets travel from the sender's planet to the receiver's over one ledger
// interval, with a tail as long as the payment's path; dust is faint and
// short; a flash is a ring at the planet for everything that is not a
// payment. Nebulae are soft clouds at far zoom. With reduced motion the
// camera does not turn and comets are still lines that fade.
//
// The renderer measures itself: frame time percentiles and how many planets
// fell in each level, read by the bench harness.

import { project, referenceScale, clampCamera } from './projection.js';
import { CATEGORIES } from '../mapping.js';
import { KINDS } from './bodies.js';

const MONO = '"JetBrains Mono", "Cascadia Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace';
export const CAMERA_HOME = Object.freeze({ yaw: 0.35, pitch: 0.28, distance: 3.2, fov: 1.0, target: Object.freeze([0, 0, 0]) });
export const CAMERA_LIMITS = Object.freeze({ yaw: [-Infinity, Infinity], pitch: [-1.2, 1.2], distance: [0.25, 7] });
/** Pixel radius of a size-1 planet at the camera's reference depth. */
export const BASE_PX = 1.0;
export const LOD = Object.freeze({ far: 2.6, near: 8 });
/** Additive kernels for the far level: a planet of radius r pixels is written as a (2k+1)-square where k = round(r), up to 2. */
const KERNELS = [[[0, 0, 1]], [[0, 0, 1], [1, 0, 0.45], [-1, 0, 0.45], [0, 1, 0.45], [0, -1, 0.45], [1, 1, 0.18], [-1, 1, 0.18], [1, -1, 0.18], [-1, -1, 0.18]], [[0, 0, 1], [1, 0, 0.7], [-1, 0, 0.7], [0, 1, 0.7], [0, -1, 0.7], [1, 1, 0.45], [-1, 1, 0.45], [1, -1, 0.45], [-1, -1, 0.45], [2, 0, 0.3], [-2, 0, 0.3], [0, 2, 0.3], [0, -2, 0.3], [2, 1, 0.15], [2, -1, 0.15], [-2, 1, 0.15], [-2, -1, 0.15], [1, 2, 0.15], [-1, 2, 0.15], [1, -2, 0.15], [-1, -2, 0.15]]];

/** Add a colour into a pixel of the ABGR buffer with saturation. */
function splat(px, index, r, g, b) {
  const v = px[index];
  const nb = Math.min(255, ((v >>> 16) & 255) + b);
  const ng = Math.min(255, ((v >>> 8) & 255) + g);
  const nr = Math.min(255, (v & 255) + r);
  px[index] = (0xff000000 | (nb << 16) | (ng << 8) | nr) >>> 0;
}
const NEBULA_ZOOM = 2.4; // camera distance from which nebulae are drawn
const CATEGORY_RGB = Object.freeze(['payment', 'offer', 'trust', 'nft', 'escrow', 'paychan', 'amm', 'other'].map((c) => hexToRgb(CATEGORIES[c].colour)));
const LAYER_OF_CATEGORY = ['payment', 'dex', 'trust', 'nft', 'payment', 'payment', 'dex', 'other'];

function hexToRgb(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

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

const HUE_TABLE = Array.from({ length: 360 }, (_, h) => hslToRgb(h, 0.7, 0.68));
const rgba = ([r, g, b], a) => `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Percentiles of a sample, for stats(). */
export function percentiles(values, ps = [0.5, 0.95, 0.99]) {
  const v = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return Object.fromEntries(ps.map((p) => [`p${Math.round(p * 100)}`, null]));
  return Object.fromEntries(ps.map((p) => [`p${Math.round(p * 100)}`, v[Math.min(v.length - 1, Math.floor(p * v.length))]]));
}

export class Sky {
  /**
   * @param {HTMLCanvasElement} canvas  the sky
   * @param {HTMLCanvasElement} labels  an overlay for text (shared with the WebGL path)
   * @param {{ reduced?: boolean, onHover?: (id|null) => void }} opts
   */
  constructor(canvas, labels, { reduced = false, onHover } = {}) {
    this.canvas = canvas;
    this.labels = labels;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.lctx = labels.getContext('2d');
    this.reduced = reduced;
    this.onHover = onHover ?? (() => {});
    this.camera = { ...CAMERA_HOME, target: [...CAMERA_HOME.target] };
    this.spin = { yaw: 0, pitch: 0 };
    this.drag = null;
    this.n = 0;
    this.positions = new Float32Array(3);
    this.attrs = null; // { size, hue, kind, known, rings, activity, lastLedger }
    this.addresses = [null];
    this.ledger = 0;
    this.comets = [];
    this.flashes = [];
    this.nebulae = [];
    this.pairs = [];
    this.layers = { payment: true, trust: true, dex: true, nft: true, other: true };
    this.focus = 0;
    this.hover = 0;
    this.intervalMs = 4000;
    this.screen = { x: new Float32Array(1), y: new Float32Array(1), r: new Float32Array(1), depth: new Float32Array(1) };
    this.sprites = new Map();
    this.pixels = null; // ImageData for the far level
    this.frameTimes = [];
    this.lodCounts = { far: 0, mid: 0, near: 0, culled: 0 };
    this.frames = 0;
    this.dpr = 1;
    this.width = 1;
    this.height = 1;
    this.t0 = performance.now();
    this._resize = () => this.resize();
    globalThis.addEventListener?.('resize', this._resize);
    this._bindPointer();
    this.resize();
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
    }
  }

  setAttributes(attrs, added = [], ledger = this.ledger) {
    this.attrs = attrs;
    for (const [id, address] of added) this.addresses[id] = address;
    this.ledger = ledger;
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
  }

  setFocus(id) {
    this.focus = id || 0;
  }

  /** The comets of a ledger: they fly over the ledger interval, staggered across it like the plate's bursts. */
  addComets(list, intervalMs = this.intervalMs) {
    this.intervalMs = intervalMs;
    const now = performance.now();
    const k = Math.max(1, list.length);
    list.forEach((c, i) => {
      const start = now + (i / k) * intervalMs * 0.85;
      if (c.kind === 'flash') this.flashes.push({ ...c, start, life: 700 });
      else this.comets.push({ ...c, start, life: c.kind === 'dust' ? intervalMs * 0.5 : c.kind === 'long-period' ? intervalMs * 1.6 : intervalMs * 0.9 });
    });
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
      if (!moved) {
        const id = this.hitTest(e.clientX, e.clientY);
        this.onClick?.(id || null);
      }
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
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.lctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.pixels = this.ctx.createImageData(this.canvas.width, this.canvas.height);
    this.pixels32 = new Uint32Array(this.pixels.data.buffer);
  }

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

  // --- sprites ----------------------------------------------------------------

  sprite(hueBucket, kind) {
    const key = `${hueBucket}:${kind}`;
    let sp = this.sprites.get(key);
    if (sp) return sp;
    const size = 64;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const rgb = HUE_TABLE[(hueBucket * 10) % 360];
    const r = size / 2;
    const glow = g.createRadialGradient(r, r, 0, r, r, r);
    if (kind === 3) {
      // black hole: a dark core with a bright rim
      glow.addColorStop(0, 'rgba(0, 0, 0, 0.95)');
      glow.addColorStop(0.3, 'rgba(0, 0, 0, 0.9)');
      glow.addColorStop(0.42, rgba(rgb, 0.9));
      glow.addColorStop(0.6, rgba(rgb, 0.18));
      glow.addColorStop(1, rgba(rgb, 0));
    } else {
      glow.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
      glow.addColorStop(0.18, rgba(rgb, 0.85));
      glow.addColorStop(0.42, rgba(rgb, 0.22));
      glow.addColorStop(1, rgba(rgb, 0));
    }
    g.fillStyle = glow;
    g.fillRect(0, 0, size, size);
    sp = c;
    this.sprites.set(key, sp);
    return sp;
  }

  // --- the frame --------------------------------------------------------------

  draw(now = performance.now()) {
    const t0 = performance.now();
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const dpr = this.dpr;
    const vp = { width: this.width, height: this.height };
    // camera motion: inertia, then the slow turn (never under reduced motion)
    if (!this.drag) {
      if (Math.abs(this.spin.yaw) > 1e-4 || Math.abs(this.spin.pitch) > 1e-4) {
        this.orbit(this.spin.yaw, this.spin.pitch);
        this.spin = { yaw: this.spin.yaw * 0.92, pitch: this.spin.pitch * 0.92 };
      } else if (!this.reduced) this.camera = { ...this.camera, yaw: this.camera.yaw + 0.0006 };
    }
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
    // project everything once; far points go straight into the buffer
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
    // nebulae at far zoom
    if (cam.distance >= NEBULA_ZOOM && this.nebulae.length) {
      ctx.globalCompositeOperation = 'lighter';
      for (const nb of this.nebulae) {
        const p = project([nb.x, nb.y, nb.z], cam, vp);
        if (!p) continue;
        const rr = Math.max(14, (nb.r + 0.04) * p.scale * 1.4);
        const a = Math.min(0.28, 0.08 + 0.02 * Math.log2(nb.size));
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr);
        g.addColorStop(0, `rgba(128, 164, 224, ${a.toFixed(3)})`);
        g.addColorStop(0.6, `rgba(128, 164, 224, ${(a * 0.35).toFixed(3)})`);
        g.addColorStop(1, 'rgba(128, 164, 224, 0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    // pairs in step: a dashed line between the two
    if (this.pairs.length) {
      ctx.setLineDash([3, 5]);
      ctx.lineWidth = 1;
      for (const pr of this.pairs) {
        if (!(s.depth[pr.a] > 0) || !(s.depth[pr.b] > 0)) continue;
        ctx.strokeStyle = 'rgba(200, 220, 255, 0.45)';
        ctx.beginPath();
        ctx.moveTo(s.x[pr.a], s.y[pr.a]);
        ctx.lineTo(s.x[pr.b], s.y[pr.b]);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    lap('nebulae+pairs');
    // mid and near bodies, far to near
    mid.sort((a, b) => s.depth[b] - s.depth[a]);
    near.sort((a, b) => s.depth[b] - s.depth[a]);
    lap('sort');
    ctx.globalCompositeOperation = 'lighter';
    for (const id of mid) {
      const r = s.r[id];
      const glow = this.glowOf(id, ledger);
      const sp = this.sprite(Math.floor(attrs.hue[id] / 10), attrs.kind[id]);
      const d = r * (2.2 + 1.6 * glow);
      ctx.globalAlpha = attrs.kind[id] === 5 ? 0.3 : attrs.known[id] ? 0.75 + 0.25 * glow : 0.45 + 0.25 * glow;
      ctx.drawImage(sp, s.x[id] - d, s.y[id] - d, 2 * d, 2 * d);
    }
    ctx.globalAlpha = 1;
    lap('mid');
    for (const id of near) this.drawBody(ctx, id, ledger, now);
    ctx.globalCompositeOperation = 'source-over';
    lap('near');
    // comets and flashes
    this.drawComets(ctx, now);
    ctx.restore();
    lap('comets');
    // labels on the overlay
    this.drawLabels(near, now);
    lap('labels');
    this.phase = phase;
    const ms = performance.now() - t0;
    this.frameTimes.push(ms);
    if (this.frameTimes.length > 600) this.frameTimes.shift();
    this.frames += 1;
    this.lodCounts = { far: far.length, mid: mid.length, near: near.length, culled };
    return ms;
  }

  glowOf(id, ledger) {
    const a = this.attrs;
    if (!a || !(a.activity[id] > 0)) return 0;
    const age = Math.max(0, ledger - a.lastLedger[id]);
    const now = a.activity[id] * 0.5 ** (age / 6);
    return Math.min(1, Math.log2(1 + now) / 5);
  }

  drawBody(ctx, id, ledger, now) {
    const a = this.attrs;
    const s = this.screen;
    const x = s.x[id];
    const y = s.y[id];
    const r = s.r[id];
    const rgb = HUE_TABLE[a.hue[id]];
    const kind = KINDS[a.kind[id]] ?? 'planet';
    const glow = this.glowOf(id, ledger);
    const hot = id === this.focus || id === this.hover;
    const alpha = kind === 'collapsed' ? 0.35 : 1;
    // glow
    const gr = r * (2.4 + 2 * glow + (hot ? 1 : 0));
    const g = ctx.createRadialGradient(x, y, 0, x, y, gr);
    g.addColorStop(0, rgba(rgb, (0.5 + 0.4 * glow) * alpha));
    g.addColorStop(1, rgba(rgb, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, gr, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    if (kind === 'blackhole') {
      ctx.fillStyle = 'rgba(2, 3, 6, 0.98)';
      ctx.beginPath();
      ctx.arc(x, y, r * 0.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba(rgb, 0.95);
      ctx.lineWidth = Math.max(1.2, r * 0.18);
      ctx.beginPath();
      ctx.arc(x, y, r * 0.95, 0, Math.PI * 2);
      ctx.stroke();
    } else if (kind === 'binary') {
      ctx.fillStyle = rgba(rgb, 0.95 * alpha);
      ctx.beginPath();
      ctx.arc(x - r * 0.45, y, r * 0.6, 0, Math.PI * 2);
      ctx.arc(x + r * 0.45, y, r * 0.6, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const disc = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
      disc.addColorStop(0, `rgba(255,255,255,${(0.9 * alpha).toFixed(2)})`);
      disc.addColorStop(0.5, rgba(rgb, 0.95 * alpha));
      disc.addColorStop(1, rgba(rgb, 0.75 * alpha));
      ctx.fillStyle = disc;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      if (!a.known[id]) {
        // balance never seen: hollow
        ctx.fillStyle = 'rgba(6, 10, 18, 0.85)';
        ctx.beginPath();
        ctx.arc(x, y, r * 0.62, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (kind === 'star') {
      ctx.strokeStyle = rgba(rgb, 0.8);
      ctx.lineWidth = 1;
      const L = r * 2.6;
      ctx.beginPath();
      ctx.moveTo(x - L, y);
      ctx.lineTo(x + L, y);
      ctx.moveTo(x, y - L);
      ctx.lineTo(x, y + L);
      ctx.stroke();
    }
    if (kind === 'pulsar') {
      const phase = this.reduced ? 0.5 : (Math.sin(now / 300) + 1) / 2;
      ctx.strokeStyle = rgba([220, 232, 255], 0.35 + 0.5 * phase);
      ctx.lineWidth = 1.2;
      const L = r * 3;
      ctx.beginPath();
      ctx.moveTo(x - L, y - L);
      ctx.lineTo(x + L, y + L);
      ctx.stroke();
    }
    if (kind === 'collapsed') {
      ctx.strokeStyle = rgba(rgb, 0.6);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - r, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.moveTo(x + r, y - r);
      ctx.lineTo(x - r, y + r);
      ctx.stroke();
    }
    // rings: funded trust lines, up to five, tilted ellipses
    const rings = this.layers.trust ? Math.min(5, a.rings[id]) : 0;
    for (let k = 0; k < rings; k++) {
      const rr = r * (1.5 + 0.45 * k);
      ctx.strokeStyle = `rgba(158, 227, 125, ${(0.55 - 0.08 * k).toFixed(2)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(x, y, rr, rr * 0.38, 0.3, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (hot) {
      ctx.strokeStyle = 'rgba(232, 238, 251, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
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
      const layer = LAYER_OF_CATEGORY[c.category] ?? 'other';
      if (this.layers[layer] === false) continue;
      const a = c.from;
      const b = c.to;
      if (!(a > 0) || !(b > 0) || !(s.depth[a] > 0) || !(s.depth[b] > 0)) continue;
      const rgb = CATEGORY_RGB[c.category] ?? CATEGORY_RGB[7];
      const fade = this.reduced ? 1 - t : t < 0.85 ? 1 : (1 - t) / 0.15;
      const w = c.kind === 'dust' ? 0.8 : 1 + Math.max(0, (c.log ?? 0) + 1) * 0.35;
      ctx.strokeStyle = rgba(rgb, (c.kind === 'dust' ? 0.25 : 0.7) * fade * (c.success ? 1 : 0.5));
      ctx.lineWidth = Math.min(4, w);
      ctx.setLineDash(c.success ? (c.kind === 'long-period' ? [3, 4] : []) : [4, 4]);
      if (this.reduced || a === b) {
        // still: the whole path, fading
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
      ctx.fillStyle = rgba([255, 255, 255], 0.9 * fade);
      ctx.beginPath();
      ctx.arc(hx, hy, c.kind === 'dust' ? 0.8 : 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.setLineDash([]);
    this.comets = alive;
    const flashes = [];
    for (const f of this.flashes) {
      const t = (now - f.start) / f.life;
      if (t >= 1) continue;
      flashes.push(f);
      if (t < 0) continue;
      const layer = LAYER_OF_CATEGORY[f.category] ?? 'other';
      if (this.layers[layer] === false) continue;
      const id = f.at;
      if (!(id > 0) || !(s.depth[id] > 0)) continue;
      const rgb = CATEGORY_RGB[f.category] ?? CATEGORY_RGB[7];
      const r = s.r[id] + (this.reduced ? 4 : 2 + 10 * t);
      ctx.strokeStyle = rgba(rgb, 0.6 * (1 - t) * (f.success ? 1 : 0.5));
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(s.x[id], s.y[id], r, 0, Math.PI * 2);
      ctx.stroke();
    }
    this.flashes = flashes;
  }

  drawLabels(near, now) {
    const l = this.lctx;
    l.clearRect(0, 0, this.width, this.height);
    const s = this.screen;
    const a = this.attrs;
    if (!a) return;
    // the largest few near bodies by projected size, the focused and the hovered one
    const chosen = new Set(near.slice().sort((p, q) => s.r[q] - s.r[p]).slice(0, 14));
    if (this.focus && s.depth[this.focus] > 0) chosen.add(this.focus);
    if (this.hover && s.depth[this.hover] > 0) chosen.add(this.hover);
    l.font = `500 10px ${MONO}`;
    l.textBaseline = 'middle';
    for (const id of chosen) {
      const text = this.addresses[id] ? `${this.addresses[id].slice(0, 4)}…${this.addresses[id].slice(-4)}` : `#${id}`;
      const kind = KINDS[a.kind[id]];
      const label = kind && kind !== 'planet' ? `${text} · ${kind}` : text;
      const off = s.r[id] + 8;
      l.fillStyle = id === this.focus ? 'rgba(232, 238, 251, 1)' : 'rgba(183, 194, 217, 0.85)';
      l.textAlign = 'left';
      l.fillText(label, s.x[id] + off, s.y[id]);
    }
    // the pair labels
    l.fillStyle = 'rgba(200, 220, 255, 0.8)';
    l.textAlign = 'center';
    for (const pr of this.pairs) {
      if (!(s.depth[pr.a] > 0) || !(s.depth[pr.b] > 0)) continue;
      l.fillText(pr.label.split(' · ')[0], (s.x[pr.a] + s.x[pr.b]) / 2, (s.y[pr.a] + s.y[pr.b]) / 2 - 8);
    }
  }

  /** Frame-time percentiles over the last frames, and how many planets fell in each level in the last one. */
  stats() {
    const p = percentiles(this.frameTimes);
    const mean = this.frameTimes.length ? this.frameTimes.reduce((x, y) => x + y, 0) / this.frameTimes.length : null;
    return { renderer: '2d', frames: this.frames, sampled: this.frameTimes.length, meanMs: mean, ...p, phase: this.phase ?? null, maxMs: this.frameTimes.length ? Math.max(...this.frameTimes) : null, lod: this.lodCounts, planets: this.n, comets: this.comets.length, flashes: this.flashes.length, camera: { distance: this.camera.distance }, dpr: this.dpr, size: [this.width, this.height] };
  }
}

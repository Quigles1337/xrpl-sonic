// xrpl-sonic — the detector plate.
//
// The scene is a cloud chamber for a ledger. The x-axis is pitch (for
// payments that means amount: whales to the left, dust to the right) and every
// transaction species leaves its own kind of track — the field guide lives in
// src/glyphs.js. A ledger close is the pulse: a ring from the centre, the grid
// lighting up for a moment and the ledger number stamped faintly behind the
// plate.
//
// Cost discipline, because this has to run on phones next to a synth: glow
// sprites are rendered once per colour and blitted, the nebula, grid, ruler
// and vignette are cached per resize, particle and ring counts are capped,
// shadowBlur is never used and DPR is capped at 2.

import { GLYPHS, PITCH_AXIS, pitchPosition, shapeFor, hexToRgb } from './glyphs.js';

const MAX_PARTICLES = 420;
const MAX_RINGS = 12;
const SPRITE = 128;
const PULSE_COLOUR = '#c8dcff';
const BG = [6, 10, 18]; // #060a12 — keep in step with --bg-0 in styles.css and composeSnapshot
const INK = [128, 164, 224]; // grid, ruler and stamp tint
const RULER_BOTTOM = 52; // CSS px from the bottom edge to the ruler baseline (above the footer bar)
const SPAWN_MS = 220; // ignition: scale-in with a little overshoot
const FLASH_MS = 180; // ignition: white-hot core
const MONO = '"JetBrains Mono", "Cascadia Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const easeOutBack = (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const rgba = ([r, g, b], a) => `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;

function hexagonPath(ctx, x, y, r, rot) {
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

function starPath(ctx, x, y, len, waist, rot) {
  const pts = [
    [len, 0],
    [waist, waist],
    [0, len],
    [-waist, waist],
    [-len, 0],
    [-waist, -waist],
    [0, -len],
    [waist, -waist],
  ];
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  ctx.beginPath();
  pts.forEach(([px, py], i) => {
    const rx = x + px * c - py * s;
    const ry = y + px * s + py * c;
    if (i === 0) ctx.moveTo(rx, ry);
    else ctx.lineTo(rx, ry);
  });
  ctx.closePath();
}

export class Visualizer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ transparent?: boolean, hud?: boolean }} [opts]
   *   transparent: no background fill (overlay mode); hud: nebula, grid, ruler, stamp and vignette (off in overlay mode);
   *   reduced: honour prefers-reduced-motion (tracks still appear, but without drift, overshoot or flashes)
   */
  constructor(canvas, { transparent = false, hud = !transparent, reduced = false } = {}) {
    this.canvas = canvas;
    this.transparent = transparent;
    this.hud = hud;
    this.reduced = reduced; // prefers-reduced-motion: no drift, no ignition flash, no overshoot
    this.exposure = false; // long-exposure plate: where tracks landed, fading over about a minute
    this.plateLayer = null; // accumulation canvas for the exposure
    this.ctx = canvas.getContext('2d', { alpha: transparent });
    this.particles = [];
    this.rings = [];
    this.bonds = []; // lines between cast members who met in one transaction
    this.lastByMember = new Map(); // cast member id → its most recent track
    this.flash = 0; // ledger pulse 0..1
    this.stamp = ''; // ledger number stamped behind the plate
    this.stampGlow = 0;
    this.stampFit = null; // { text, w, size } cache for drawStamp
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.running = false;
    this.raf = 0;
    this.lastFrame = 0;
    this.onFrame = null; // (nowMs) => void, for the metronome etc.
    this.rgbCache = new Map();
    this.sprites = new Map();
    this.layers = null; // { nebula, grid, ruler, vignette } cached per resize
    this._resize = () => this.resize();
    this._loop = (ts) => this.frame(ts);
    this.resize();
    globalThis.addEventListener?.('resize', this._resize);
  }

  // ---------------------------------------------------------------- lifecycle

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    this.width = Math.max(1, Math.round(rect.width));
    this.height = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.layers = this.hud ? this.buildLayers() : null;
    this.plateLayer = null;
    if (this.transparent) {
      this.ctx.clearRect(0, 0, this.width, this.height);
    } else {
      this.ctx.fillStyle = rgba(BG, 1);
      this.ctx.fillRect(0, 0, this.width, this.height);
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this._loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  destroy() {
    this.stop();
    globalThis.removeEventListener?.('resize', this._resize);
  }

  setReduced(on) {
    this.reduced = Boolean(on);
  }

  /** Long exposure: keep a fading trace of every track's landing point, so a busy issuer or maker becomes a column. */
  setExposure(on) {
    this.exposure = Boolean(on);
    if (!this.exposure) this.plateLayer = null;
  }

  _exposureLayer() {
    if (!this.plateLayer) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(this.width * this.dpr));
      c.height = Math.max(1, Math.round(this.height * this.dpr));
      const g = c.getContext('2d');
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.plateLayer = { canvas: c, ctx: g, lastFade: 0 };
    }
    return this.plateLayer;
  }

  /** Blind comparison: keep the plate but hide the ledger number stamped behind it. */
  setBlind(on) {
    this.blind = Boolean(on);
  }

  rgb(hex) {
    let v = this.rgbCache.get(hex);
    if (!v) {
      v = hexToRgb(hex);
      this.rgbCache.set(hex, v);
    }
    return v;
  }

  /** Horizontal padding that keeps the ruler and the spawn band aligned. */
  pad() {
    return Math.min(48, this.width * 0.06);
  }

  // ------------------------------------------------------------------ sprites

  /** Radial glow sprite, rendered once per (kind, colour). 'core' has a white-hot centre, 'halo' is a soft wash. */
  sprite(kind, hex) {
    const key = kind + hex;
    let c = this.sprites.get(key);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = SPRITE;
    c.height = SPRITE;
    const g = c.getContext('2d');
    const [r, gr, b] = this.rgb(hex);
    const grad = g.createRadialGradient(SPRITE / 2, SPRITE / 2, 0, SPRITE / 2, SPRITE / 2, SPRITE / 2);
    if (kind === 'core') {
      grad.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
      grad.addColorStop(0.1, `rgba(${r}, ${gr}, ${b}, 0.9)`);
      grad.addColorStop(0.3, `rgba(${r}, ${gr}, ${b}, 0.3)`);
      grad.addColorStop(0.6, `rgba(${r}, ${gr}, ${b}, 0.07)`);
      grad.addColorStop(1, `rgba(${r}, ${gr}, ${b}, 0)`);
    } else {
      grad.addColorStop(0, `rgba(${r}, ${gr}, ${b}, 0.4)`);
      grad.addColorStop(0.45, `rgba(${r}, ${gr}, ${b}, 0.11)`);
      grad.addColorStop(1, `rgba(${r}, ${gr}, ${b}, 0)`);
    }
    g.fillStyle = grad;
    g.fillRect(0, 0, SPRITE, SPRITE);
    this.sprites.set(key, c);
    return c;
  }

  blit(kind, hex, x, y, radius, alpha) {
    if (alpha <= 0.004 || radius <= 0.5) return;
    const ctx = this.ctx;
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(this.sprite(kind, hex), x - radius, y - radius, radius * 2, radius * 2);
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------- HUD layers

  layer(scale = 1) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(this.width * this.dpr * scale));
    c.height = Math.max(1, Math.round(this.height * this.dpr * scale));
    const g = c.getContext('2d');
    g.setTransform(this.dpr * scale, 0, 0, this.dpr * scale, 0, 0);
    return [c, g];
  }

  buildLayers() {
    const w = this.width;
    const h = this.height;
    const pad = this.pad();
    const axisX = (midi) => pad + pitchPosition(midi) * (w - 2 * pad);

    // Nebula: three soft washes at quarter resolution, drawn oversize so the slow drift never shows an edge.
    const [nebula, ng] = this.layer(0.25);
    const wash = (cx, cy, radius, [r, g, b], a) => {
      const grad = ng.createRadialGradient(cx, cy, 0, cx, cy, radius);
      grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${a})`);
      grad.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, ${a * 0.35})`);
      grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      ng.fillStyle = grad;
      ng.fillRect(0, 0, w, h);
    };
    wash(w * 0.28, h * 0.32, Math.max(w, h) * 0.5, [40, 120, 190], 0.16);
    wash(w * 0.76, h * 0.7, Math.max(w, h) * 0.46, [110, 70, 190], 0.13);
    wash(w * 0.55, h * 1.05, Math.max(w, h) * 0.4, [20, 150, 140], 0.07);

    // Grid: one line per octave, a fainter one at the tritone, horizontals every 72 px.
    const [grid, gg] = this.layer();
    gg.lineWidth = 1;
    for (let midi = PITCH_AXIS.low; midi <= PITCH_AXIS.high; midi += 6) {
      const major = (midi - PITCH_AXIS.low) % 12 === 0;
      gg.strokeStyle = rgba(INK, major ? 0.11 : 0.045);
      const x = Math.round(axisX(midi)) + 0.5;
      gg.beginPath();
      gg.moveTo(x, 0);
      gg.lineTo(x, h - RULER_BOTTOM);
      gg.stroke();
    }
    gg.strokeStyle = rgba(INK, 0.04);
    for (let y = 72; y < h - RULER_BOTTOM; y += 72) {
      gg.beginPath();
      gg.moveTo(0, y + 0.5);
      gg.lineTo(w, y + 0.5);
      gg.stroke();
    }

    // Ruler: the pitch axis with octave ticks and note names.
    const [ruler, rg] = this.layer();
    const y0 = h - RULER_BOTTOM + 0.5;
    rg.strokeStyle = rgba(INK, 0.28);
    rg.lineWidth = 1;
    rg.beginPath();
    rg.moveTo(pad, y0);
    rg.lineTo(w - pad, y0);
    rg.stroke();
    for (let midi = PITCH_AXIS.low; midi <= PITCH_AXIS.high; midi += 1) {
      const octave = (midi - PITCH_AXIS.low) % 12 === 0;
      const fifth = (midi - PITCH_AXIS.low) % 12 === 7;
      const x = Math.round(axisX(midi)) + 0.5;
      rg.strokeStyle = rgba(INK, octave ? 0.6 : fifth ? 0.3 : 0.16);
      rg.beginPath();
      rg.moveTo(x, y0);
      rg.lineTo(x, y0 + (octave ? 9 : fifth ? 6 : 3));
      rg.stroke();
    }
    rg.font = `500 10px ${MONO}`;
    rg.textAlign = 'center';
    rg.textBaseline = 'top';
    rg.fillStyle = rgba(INK, 0.7);
    for (const tick of PITCH_AXIS.ticks) rg.fillText(tick.label, axisX(tick.midi), y0 + 13);
    try {
      rg.letterSpacing = '0.14em';
    } catch {
      /* older engines */
    }
    rg.font = `500 9px ${MONO}`;
    rg.textBaseline = 'bottom';
    rg.fillStyle = rgba(INK, 0.5);
    rg.textAlign = 'center';
    rg.fillText('PITCH', w / 2, y0 - 7);
    if (w >= 600) {
      rg.textAlign = 'left';
      rg.fillText('LOW · LARGER PAYMENTS', pad, y0 - 7);
      rg.textAlign = 'right';
      rg.fillText('SMALLER PAYMENTS · HIGH', w - pad, y0 - 7);
    }

    // Vignette: darkens the edges so the plate reads as an instrument window.
    const [vignette, vg] = this.layer(0.5);
    const vgrad = vg.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) * 0.6);
    vgrad.addColorStop(0, rgba(BG, 0));
    vgrad.addColorStop(1, rgba(BG, 0.62));
    vg.fillStyle = vgrad;
    vg.fillRect(0, 0, w, h);
    const top = vg.createLinearGradient(0, 0, 0, 120);
    top.addColorStop(0, rgba(BG, 0.55));
    top.addColorStop(1, rgba(BG, 0));
    vg.fillStyle = top;
    vg.fillRect(0, 0, w, 120);

    return { nebula, grid, ruler, vignette };
  }

  // ------------------------------------------------------------------ events

  /** Spawn a track for a transaction event. `dim` marks rate-limited or muted-by-account events. */
  spawn(event, { dim = false } = {}) {
    const w = this.width;
    const h = this.height;
    const pad = this.pad();
    const x = pad + pitchPosition(event.pitch) * (w - 2 * pad) + (Math.random() - 0.5) * w * 0.035;
    const y = h * (0.18 + Math.random() * 0.5);
    const glyph = GLYPHS[event.category] ?? GLYPHS.other;
    const hover = glyph.motion === 'hover';
    const life = clamp(event.duration * 2.2, 1.2, 4) * glyph.lifeScale * 1000;
    const r = event.size * (dim ? 0.6 : 1);
    const p = {
      x,
      y,
      r,
      vx: (Math.random() - 0.5) * (hover ? 4 : 12),
      vy: hover ? -(2 + Math.random() * 3) : -(9 + Math.random() * 14) - r * 0.35,
      shape: shapeFor(event),
      colour: event.colour,
      rgb: this.rgb(event.colour),
      born: performance.now(),
      life,
      hollow: event.timbre === 'iou',
      whale: Boolean(event.sub),
      alpha: dim ? 0.4 : 1,
      seed: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 2,
      event,
      castColour: event.castColour ?? null,
      castLabel: event.castLabel ?? null,
      castId: event.primary ?? null,
      cues: Array.isArray(event.cues) ? event.cues : [],
      dead: false,
    };
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift().dead = true;
    this.particles.push(p);
    if (this.exposure) {
      const L = this._exposureLayer();
      L.ctx.globalCompositeOperation = 'lighter';
      L.ctx.fillStyle = rgba(p.rgb, dim ? 0.12 : 0.3);
      L.ctx.beginPath();
      L.ctx.arc(x, y, Math.max(1.5, r * 0.35), 0, Math.PI * 2);
      L.ctx.fill();
      L.ctx.globalCompositeOperation = 'source-over';
    }
    if (p.castId) {
      // A bond to the latest track of every other member this transaction involved.
      for (const cue of p.cues) {
        const other = this.lastByMember.get(cue.id);
        if (other && !other.dead) this.bonds.push({ a: p, b: other, rgb: this.rgb(cue.colour ?? p.castColour), born: p.born, life: 1600 });
      }
      this.lastByMember.set(p.castId, p);
      while (this.bonds.length > 24) this.bonds.shift();
    }
    if (!dim) {
      if (p.whale) this.ring({ colour: event.colour, x, y, life: 1700, width: 2.5, maxR: 160 + r * 6 });
      if (p.shape === 'vault-open') this.ring({ colour: event.colour, x, y, life: 900, width: 1.5, maxR: 48 + r * 2 });
    }
    return p;
  }

  /** The track nearest a point (CSS px, canvas coordinates), within a small tolerance; the youngest wins a tie. */
  hitTest(x, y) {
    let best = null;
    let bestD = Infinity;
    for (const p of this.particles) {
      const tol = Math.max(14, p.r * 2.2);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= tol && (d < bestD - 2 || (Math.abs(d - bestD) <= 2 && p.born > best.born))) {
        best = p;
        bestD = d;
      }
    }
    return best;
  }

  /** A gap between clips: a dashed ring that contracts to the centre — time folding. */
  gap() {
    this.ring({ colour: PULSE_COLOUR, life: 1500, width: 1.5, inward: true });
  }

  /** Expanding ring. The ledger pulse calls this with defaults: centre, pale, to the edge of the plate. */
  ring({ colour = PULSE_COLOUR, x, y, life = 2600, width = 2, maxR, pulse = false, inward = false } = {}) {
    if (this.rings.length >= MAX_RINGS) this.rings.shift();
    this.rings.push({
      x: x ?? this.width / 2,
      y: y ?? this.height / 2,
      rgb: this.rgb(colour),
      born: performance.now(),
      life,
      width,
      pulse,
      inward,
      maxR: maxR ?? Math.hypot(this.width, this.height) / 2,
    });
  }

  /** Ledger close: ring from the centre, grid flash, number stamped behind the plate. */
  ledger(ledgerEvent) {
    this.ring({ pulse: true });
    this.flash = 1;
    if (ledgerEvent?.ledgerIndex != null) {
      this.stamp = `#${Number(ledgerEvent.ledgerIndex).toLocaleString('en-US')}`;
      this.stampGlow = 1;
    }
    return ledgerEvent;
  }

  // ------------------------------------------------------------------- frame

  frame(ts) {
    if (!this.running) return;
    // Schedule the next frame first so a drawing exception can never stop the loop.
    this.raf = requestAnimationFrame(this._loop);
    const dt = Math.min(0.1, Math.max(0, (ts - this.lastFrame) / 1000));
    this.lastFrame = ts;
    try {
      this.draw(ts, dt);
    } catch (err) {
      console.warn('[xrpl-sonic] draw error', err);
    }
    if (this.onFrame) this.onFrame(ts);
  }

  draw(ts, dt) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    this.flash = Math.max(0, this.flash - dt * 1.6);
    this.stampGlow = Math.max(0, this.stampGlow - dt * 0.8);
    const f = this.flash;

    // --- plate -------------------------------------------------------------
    ctx.globalCompositeOperation = 'source-over';
    if (this.transparent) {
      ctx.clearRect(0, 0, w, h);
      if (f > 0) {
        ctx.fillStyle = `rgba(200, 220, 255, ${(f * 0.08).toFixed(3)})`;
        ctx.fillRect(0, 0, w, h);
      }
    } else {
      ctx.fillStyle = `rgb(${BG[0] + f * 8}, ${BG[1] + f * 12}, ${BG[2] + f * 22})`;
      ctx.fillRect(0, 0, w, h);
    }
    const L = this.layers;
    if (L) {
      const dx = this.reduced ? 0 : Math.sin(ts / 13000) * w * 0.05;
      const dy = this.reduced ? 0 : Math.cos(ts / 17000) * h * 0.04;
      ctx.drawImage(L.nebula, -w * 0.15 + dx, -h * 0.15 + dy, w * 1.3, h * 1.3);
      ctx.drawImage(L.grid, 0, 0, w, h);
      if (f > 0) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = f * 0.75;
        ctx.drawImage(L.grid, 0, 0, w, h);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
      if (this.stamp && !this.blind) this.drawStamp(w, h);
    }

    // --- long exposure: the accumulated plate, fading slowly ------------------
    if (this.exposure && this.plateLayer) {
      const L = this.plateLayer;
      if (ts - L.lastFade > 250) {
        L.lastFade = ts;
        L.ctx.globalCompositeOperation = 'destination-out';
        L.ctx.fillStyle = 'rgba(0, 0, 0, 0.012)';
        L.ctx.fillRect(0, 0, w, h);
        L.ctx.globalCompositeOperation = 'source-over';
      }
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(L.canvas, 0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    }

    // --- rings (ledger pulse, Cherenkov rings, escrow releases) ------------
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];
      const age = Math.max(0, (ts - ring.born) / ring.life);
      if (age >= 1) {
        this.rings.splice(i, 1);
        continue;
      }
      const radius = ring.inward ? (1 - easeOutCubic(age)) * ring.maxR : easeOutCubic(age) * ring.maxR;
      const fade = 1 - age;
      if (ring.inward) ctx.setLineDash([6, 8]);
      // wide, faint band
      ctx.strokeStyle = rgba(ring.rgb, fade * 0.07);
      ctx.lineWidth = ring.width * 7;
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      // bright leading edge
      ctx.strokeStyle = rgba(ring.rgb, fade * 0.8);
      ctx.lineWidth = Math.max(0.6, ring.width * (1 - age * 0.6));
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      if (ring.inward) ctx.setLineDash([]);
      // the ledger pulse carries an echo just behind its edge
      if (ring.pulse && radius > 12) {
        ctx.strokeStyle = rgba(ring.rgb, fade * 0.22);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, radius * 0.93, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // --- tracks --------------------------------------------------------------
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      // rAF timestamps can trail performance.now() by a frame, so clamp: a negative age would give negative radii.
      const t = Math.max(0, ts - p.born);
      const age = t / p.life;
      if (age >= 1) {
        p.dead = true;
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx += Math.sin(ts / 900 + p.y * 0.01) * 6 * dt;
      const k = {
        x: p.x,
        y: p.y,
        r: p.r,
        t,
        age,
        s: this.reduced ? 1 : easeOutBack(Math.min(1, t / SPAWN_MS)),
        a: (age < 0.12 ? 1 : 1 - ((age - 0.12) / 0.88) ** 1.5) * p.alpha,
        flash: this.reduced ? 0 : Math.max(0, 1 - t / FLASH_MS) * p.alpha,
      };
      const drawShape = this[`draw_${p.shape.replace('-', '_')}`] ?? this.draw_mote;
      drawShape.call(this, ctx, p, k);
      if (p.castColour) this.drawIdentity(ctx, p, k);
    }

    // --- bonds: two cast members met in one transaction ---------------------
    if (this.bonds.length) {
      ctx.setLineDash([3, 5]);
      ctx.lineWidth = 1;
      for (let i = this.bonds.length - 1; i >= 0; i--) {
        const bond = this.bonds[i];
        const age = (ts - bond.born) / bond.life;
        if (age >= 1 || bond.a.dead || bond.b.dead) {
          this.bonds.splice(i, 1);
          continue;
        }
        const reach = easeOutCubic(Math.min(1, age * 2.5));
        ctx.strokeStyle = rgba(bond.rgb, (1 - age) * 0.6);
        ctx.beginPath();
        ctx.moveTo(bond.a.x, bond.a.y);
        ctx.lineTo(bond.a.x + (bond.b.x - bond.a.x) * reach, bond.a.y + (bond.b.y - bond.a.y) * reach);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // --- ruler and vignette on top ------------------------------------------
    ctx.globalCompositeOperation = 'source-over';
    if (L) {
      ctx.drawImage(L.ruler, 0, 0, w, h);
      if (f > 0) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = f * 0.7;
        ctx.drawImage(L.ruler, 0, 0, w, h);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.drawImage(L.vignette, 0, 0, w, h);
    }
  }

  drawStamp(w, h) {
    const ctx = this.ctx;
    const glow = this.stampGlow;
    // Size the number to a fixed share of the width so it clears an open settings panel on any font.
    if (this.stampFit?.text !== this.stamp || this.stampFit.w !== w) {
      ctx.font = `500 100px ${MONO}`;
      const measured = ctx.measureText(this.stamp).width || 1;
      this.stampFit = { text: this.stamp, w, size: clamp((100 * w * 0.5) / measured, 32, h * 0.18) };
    }
    const size = this.stampFit.size;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `500 ${size.toFixed(0)}px ${MONO}`;
    ctx.fillStyle = rgba(INK, 0.045 + glow * 0.11);
    ctx.fillText(this.stamp, w / 2, h * 0.46);
    try {
      ctx.letterSpacing = '0.3em';
    } catch {
      /* older engines */
    }
    ctx.font = `500 ${Math.max(9, size * 0.11).toFixed(0)}px ${MONO}`;
    ctx.fillStyle = rgba(INK, 0.09 + glow * 0.2);
    ctx.fillText('VALIDATED LEDGER', w / 2, h * 0.46 - size * 0.72);
    try {
      ctx.letterSpacing = '0px';
    } catch {
      /* older engines */
    }
  }

  /** Cast identity: a ring in the member's colour, the label, and a dot on the ring per other involved member. */
  drawIdentity(ctx, p, k) {
    const { x, y, r, a, s } = k;
    const rgb = this.rgb(p.castColour);
    const R = (r * 1.4 + 7) * s;
    ctx.strokeStyle = rgba(rgb, a * 0.85);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.stroke();
    p.cues.forEach((cue, i) => {
      const ang = -Math.PI / 4 + i * 0.55;
      ctx.fillStyle = rgba(this.rgb(cue.colour ?? p.castColour), a);
      ctx.beginPath();
      ctx.arc(x + Math.cos(ang) * R, y + Math.sin(ang) * R, 2.2, 0, Math.PI * 2);
      ctx.fill();
    });
    if (p.castLabel && a > 0.15) {
      ctx.font = `600 9px ${MONO}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = rgba(rgb, Math.min(1, a * 1.1));
      ctx.fillText(p.castLabel.toUpperCase(), x + R + 4, y - R * 0.3);
    }
  }

  // ------------------------------------------------------------------ shapes
  // Each receives the particle and k = { x, y, r, t, age, s (ignition scale), a (alpha), flash }.

  /** Payment: a photon with a comet tail; whales glow wider and leave a ring (spawned in spawn()). */
  draw_photon(ctx, p, k) {
    const { x, y, r, a, s, flash } = k;
    const tail = p.whale ? 0.9 : 0.55;
    ctx.strokeStyle = rgba(p.rgb, a * 0.3);
    ctx.lineWidth = Math.max(1, r * 0.45 * s);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - p.vx * tail, y - p.vy * tail);
    ctx.stroke();
    this.blit('halo', p.colour, x, y, r * (p.whale ? 7 : 4.5) * s, a * 0.55);
    this.blit('core', p.colour, x, y, r * 2.2 * s, a * 0.9);
    if (p.hollow) {
      ctx.strokeStyle = rgba(p.rgb, a);
      ctx.lineWidth = Math.max(1.2, r * 0.26);
      ctx.beginPath();
      ctx.arc(x, y, r * 0.95 * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(255, 255, 255, ${(a * 0.8).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1, r * 0.22), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = rgba(p.rgb, a);
      ctx.beginPath();
      ctx.arc(x, y, r * 0.78 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(255, 255, 255, ${(a * 0.85).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x, y, r * 0.36 * s, 0, Math.PI * 2);
      ctx.fill();
    }
    if (flash > 0) {
      ctx.fillStyle = `rgba(255, 255, 255, ${(flash * 0.55).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x, y, r * (1.2 + flash * 1.4), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** DEX offer: a spectral line — a thin vertical flash with a glint at ignition. */
  draw_spectral(ctx, p, k, cancelled = false) {
    const { x, y, r, a, s, flash } = k;
    const hh = (9 + r * 1.5) * s;
    const hw = Math.max(1.1, r * 0.22) * s;
    ctx.fillStyle = rgba(p.rgb, a * (cancelled ? 0.5 : 0.95));
    ctx.beginPath();
    ctx.moveTo(x, y - hh);
    ctx.lineTo(x + hw, y);
    ctx.lineTo(x, y + hh);
    ctx.lineTo(x - hw, y);
    ctx.closePath();
    ctx.fill();
    this.blit('core', p.colour, x, y, r * 1.6 * s, a * 0.6);
    if (flash > 0) {
      const gl = hh * 0.9 * flash;
      ctx.strokeStyle = `rgba(255, 255, 255, ${(flash * 0.8).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - gl, y);
      ctx.lineTo(x + gl, y);
      ctx.stroke();
    }
    if (cancelled) {
      const c = hh * 0.42;
      ctx.strokeStyle = rgba(p.rgb, a);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x - c, y - c);
      ctx.lineTo(x + c, y + c);
      ctx.moveTo(x + c, y - c);
      ctx.lineTo(x - c, y + c);
      ctx.stroke();
    }
  }

  draw_spectral_cancel(ctx, p, k) {
    this.draw_spectral(ctx, p, k, true);
  }

  /** Trust line: a hexagonal cell that grows a bond to its issuer. */
  draw_lattice(ctx, p, k) {
    const { x, y, r, a, s, t, age } = k;
    const R = (7 + r * 0.85) * s * (1 + age * 0.5);
    const rot = p.seed + (t / 4000) * p.spin;
    this.blit('halo', p.colour, x, y, R * 2.2, a * 0.35);
    ctx.strokeStyle = rgba(p.rgb, a * 0.85);
    ctx.lineWidth = 1.3;
    hexagonPath(ctx, x, y, R, rot);
    ctx.stroke();
    ctx.fillStyle = rgba(p.rgb, a * 0.35);
    hexagonPath(ctx, x, y, R * 0.45, rot + Math.PI / 6);
    ctx.fill();
    const prog = smoothstep(0, 0.35, age);
    if (prog > 0) {
      const c = Math.cos(p.seed);
      const sn = Math.sin(p.seed);
      const ex = x + c * R * 2.6 * prog;
      const ey = y + sn * R * 2.6 * prog;
      ctx.strokeStyle = rgba(p.rgb, a * 0.7);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x + c * R, y + sn * R);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.fillStyle = rgba(p.rgb, a * prog);
      ctx.beginPath();
      ctx.arc(ex, ey, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** NFT: a four-point star with a lens flare at ignition, turning slowly. */
  draw_stellar(ctx, p, k) {
    const { x, y, r, a, s, t, flash } = k;
    const L = (9 + r * 1.1) * s;
    const rot = p.seed + t / 2600;
    this.blit('halo', p.colour, x, y, L * 2.2, a * 0.3);
    this.blit('core', p.colour, x, y, r * 2.4 * s, a * 0.9);
    ctx.fillStyle = rgba(p.rgb, a);
    starPath(ctx, x, y, L, L * 0.16, rot);
    ctx.fill();
    ctx.fillStyle = `rgba(255, 255, 255, ${(a * 0.6).toFixed(3)})`;
    starPath(ctx, x, y, L * 0.5, L * 0.1, rot + Math.PI / 4);
    ctx.fill();
    if (flash > 0) {
      ctx.strokeStyle = `rgba(255, 255, 255, ${(flash * 0.6).toFixed(3)})`;
      ctx.lineWidth = 1;
      const len = L * 4 * flash;
      ctx.beginPath();
      ctx.moveTo(x - len, y);
      ctx.lineTo(x + len, y);
      ctx.stroke();
      ctx.strokeStyle = rgba(p.rgb, flash * 0.5);
      for (const ang of [Math.PI / 6, -Math.PI / 6]) {
        const l2 = L * 2.4 * flash;
        ctx.beginPath();
        ctx.moveTo(x - Math.cos(ang) * l2, y - Math.sin(ang) * l2);
        ctx.lineTo(x + Math.cos(ang) * l2, y + Math.sin(ang) * l2);
        ctx.stroke();
      }
    }
  }

  /** Escrow: a dial that winds shut (create), springs open (finish) or is struck through (cancel). */
  draw_vault(ctx, p, k, mode = 'lock') {
    const { x, y, r, a, s, t, age } = k;
    const R = (7 + r * 0.8) * s;
    this.blit('halo', p.colour, x, y, R * 2, a * 0.3);
    if (mode === 'open') {
      const R2 = R * (1 + easeOutCubic(Math.min(1, t / 700)) * 0.9);
      ctx.strokeStyle = rgba(p.rgb, a);
      ctx.lineWidth = Math.max(0.8, 2 * (1 - age));
      ctx.beginPath();
      ctx.arc(x, y, R2, 0, Math.PI * 2);
      ctx.stroke();
      this.blit('core', p.colour, x, y, R * 1.6, a * 0.8);
      ctx.fillStyle = rgba(p.rgb, a * 0.7);
      ctx.beginPath();
      ctx.arc(x, y, R * 0.45 * (1 - age * 0.6), 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.strokeStyle = rgba(p.rgb, a * (mode === 'cancel' ? 0.5 : 0.3));
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.stroke();
    if (mode === 'cancel') {
      ctx.strokeStyle = rgba(p.rgb, a);
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(x - R * 0.75, y + R * 0.75);
      ctx.lineTo(x + R * 0.75, y - R * 0.75);
      ctx.stroke();
      return;
    }
    const prog = smoothstep(0.02, 0.6, age);
    const end = -Math.PI / 2 + Math.PI * 2 * prog;
    ctx.strokeStyle = rgba(p.rgb, a);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, R, -Math.PI / 2, end);
    ctx.stroke();
    ctx.fillStyle = `rgba(255, 255, 255, ${(a * 0.85).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x + Math.cos(end) * R, y + Math.sin(end) * R, 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = rgba(p.rgb, a * 0.9);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1.5, r * 0.25), 0, Math.PI * 2);
    ctx.fill();
  }

  draw_vault_open(ctx, p, k) {
    this.draw_vault(ctx, p, k, 'open');
  }

  draw_vault_cancel(ctx, p, k) {
    this.draw_vault(ctx, p, k, 'cancel');
  }

  /** Payment channel: four bars that light in sequence with the arpeggio (150 ms apart in src/audio.js). */
  draw_ladder(ctx, p, k) {
    const { x, y, r, a, s, t } = k;
    const step = (6 + r * 0.6) * s;
    const bw = Math.max(2, r * 0.35) * s;
    const base = y + step;
    this.blit('halo', p.colour, x, y, step * 3, a * 0.25);
    for (let i = 0; i < 4; i++) {
      const lit = t >= i * 150;
      const ignite = clamp((t - i * 150) / 160, 0, 1);
      const bh = (5 + i * 4.5 + r * 0.5) * s;
      const bx = x + (i - 1.5) * step * 1.4;
      ctx.fillStyle = rgba(p.rgb, lit ? a : a * 0.15);
      ctx.fillRect(bx - bw / 2, base - bh, bw, bh);
      if (lit) {
        ctx.fillStyle = `rgba(255, 255, 255, ${(a * 0.7).toFixed(3)})`;
        ctx.fillRect(bx - bw / 2, base - bh, bw, 1.5);
        if (ignite < 1) this.blit('core', p.colour, bx, base - bh, bw * 2.2 * (1 - ignite) + 2, (1 - ignite) * a);
      }
    }
  }

  /** AMM: three overlapping rings, breathing together. */
  draw_pool(ctx, p, k) {
    const { x, y, r, a, s, t } = k;
    const R = (6 + r * 0.7) * s * (1 + 0.05 * Math.sin(t / 260 + p.seed));
    const d = R * 0.62;
    const rot = p.seed + t / 5000;
    this.blit('halo', p.colour, x, y, R * 2.6, a * 0.35);
    ctx.lineWidth = 1.3;
    for (let i = 0; i < 3; i++) {
      const ang = rot + (i * Math.PI * 2) / 3;
      const cx = x + Math.cos(ang) * d;
      const cy = y + Math.sin(ang) * d;
      ctx.fillStyle = rgba(p.rgb, a * 0.08);
      ctx.strokeStyle = rgba(p.rgb, a * 0.8);
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.fillStyle = `rgba(255, 255, 255, ${(a * 0.6).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Everything else: a single bright mote. */
  draw_mote(ctx, p, k) {
    const { x, y, r, a, s, flash } = k;
    const sz = (2.4 + r * 0.15) * s;
    ctx.fillStyle = rgba(p.rgb, a);
    ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
    ctx.fillStyle = `rgba(255, 255, 255, ${(a * 0.7).toFixed(3)})`;
    ctx.fillRect(x - 0.5, y - 0.5, 1, 1);
    if (flash > 0) this.blit('core', p.colour, x, y, sz * 3 * flash, flash * 0.6);
  }
}

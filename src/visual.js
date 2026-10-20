// xrpl-sonic — canvas visualiser.
//
// Transactions are particles (colour = category, size = amount, x = pitch),
// ledger closes are expanding rings from the centre. Designed to stay cheap on
// phones: capped particle count, no shadowBlur, DPR capped at 2.

const MAX_PARTICLES = 400;
const MAX_RINGS = 10;
const PITCH_LOW = 36;
const PITCH_SPAN = 60;

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.particles = [];
    this.rings = [];
    this.flash = 0; // background pulse 0..1
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.running = false;
    this.raf = 0;
    this.lastFrame = 0;
    this.onFrame = null; // (nowMs) => void, for the metronome etc.
    this.rgbCache = new Map();
    this._resize = () => this.resize();
    this._loop = (ts) => this.frame(ts);
    this.resize();
    globalThis.addEventListener?.('resize', this._resize);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    this.width = Math.max(1, Math.round(rect.width));
    this.height = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.fillStyle = '#0b0f1a';
    this.ctx.fillRect(0, 0, this.width, this.height);
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

  rgb(hex) {
    let v = this.rgbCache.get(hex);
    if (!v) {
      v = hexToRgb(hex);
      this.rgbCache.set(hex, v);
    }
    return v;
  }

  /** Spawn a particle for a transaction event. `dim` marks rate-limited (silent) events. */
  spawn(event, { dim = false } = {}) {
    const w = this.width;
    const h = this.height;
    const pad = Math.min(40, w * 0.06);
    const px = (event.pitch - PITCH_LOW) / PITCH_SPAN;
    const x = pad + px * (w - 2 * pad) + (Math.random() - 0.5) * w * 0.04;
    const y = h * (0.3 + Math.random() * 0.45);
    const life = Math.min(4, Math.max(1.2, event.duration * 2.2));
    const r = event.size * (dim ? 0.6 : 1);
    const p = {
      x,
      y,
      vx: (Math.random() - 0.5) * 12,
      vy: -(8 + Math.random() * 14) - r * 0.4,
      r,
      colour: event.colour,
      rgb: this.rgb(event.colour),
      born: performance.now(),
      life: life * 1000,
      hollow: event.timbre === 'iou',
      alpha: dim ? 0.45 : 1,
    };
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push(p);
    if (event.sub) this.ring({ colour: event.colour, x, y, speed: 1.6, life: 1400, width: 4 });
    return p;
  }

  /** Expanding ring. Ledger closes call this with defaults (centre, white). */
  ring({ colour = '#c8dcff', x, y, speed = 1, life = 2400, width = 2 } = {}) {
    if (this.rings.length >= MAX_RINGS) this.rings.shift();
    this.rings.push({
      x: x ?? this.width / 2,
      y: y ?? this.height / 2,
      rgb: this.rgb(colour),
      born: performance.now(),
      life,
      speed,
      width,
      maxR: Math.hypot(this.width, this.height) / 2,
    });
  }

  /** Ledger close: ring from the centre plus a background pulse. */
  ledger(ledgerEvent) {
    this.ring();
    this.flash = 1;
    return ledgerEvent;
  }

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

    // Background with a soft pulse on ledger close.
    this.flash = Math.max(0, this.flash - dt * 1.8);
    const f = this.flash;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgb(${11 + f * 10}, ${15 + f * 14}, ${26 + f * 22})`;
    ctx.fillRect(0, 0, w, h);

    // Rings
    ctx.lineCap = 'round';
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];
      const age = Math.max(0, (ts - ring.born) / ring.life);
      if (age >= 1) {
        this.rings.splice(i, 1);
        continue;
      }
      const eased = 1 - (1 - age) ** 2.2;
      const radius = eased * ring.maxR * ring.speed;
      const alpha = (1 - age) * 0.55;
      const [r, g, b] = ring.rgb;
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
      ctx.lineWidth = ring.width * (1 - age * 0.7);
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Particles (additive glow).
    ctx.globalCompositeOperation = 'lighter';
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      const age = Math.max(0, (ts - p.born) / p.life);
      if (age >= 1) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx += Math.sin(ts / 900 + p.y * 0.01) * 6 * dt;
      const fade = age < 0.08 ? age / 0.08 : 1 - (age - 0.08) / 0.92;
      const a = fade * p.alpha;
      const [r, g, b] = p.rgb;
      const radius = p.r * (1 + age * 0.35);
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a * 0.14})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 2.6, 0, Math.PI * 2);
      ctx.fill();
      if (p.hollow) {
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${a * 0.9})`;
        ctx.lineWidth = Math.max(1, radius * 0.25);
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a * 0.9})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}

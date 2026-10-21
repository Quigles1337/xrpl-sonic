// xrpl-sonic explorer — the constellation.
//
// An account drawn as a place rather than a table: the account at the
// centre, its XRP as a ring whose radius grows with the balance and the
// reserve as a disc inside it (a disc that reaches the ring means the account
// is at its reserve), each issued currency it holds as a further ring, and
// the accounts it dealt with as stars placed around it — the most frequent
// nearest, each in the colour of what they mostly did together, joined by a
// line whose weight is how often. Hovering a star names it; clicking goes
// there. The field turns, slowly, unless the viewer prefers reduced motion.

import { CATEGORIES } from '../mapping.js';
import { hashString, shortAddress } from '../mapping.js';
import { sigilPattern } from './sigil.js';

const MONO = '"JetBrains Mono", "Cascadia Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace';
const INK = [128, 164, 224];
const rgba = ([r, g, b], a) => `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

function dominant(categories) {
  let best = 'other';
  let n = -1;
  for (const [k, v] of Object.entries(categories ?? {})) if (v > n) [best, n] = [k, v];
  return best;
}

export class Constellation {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ onHover?: (party|null, x, y) => void, onClick?: (party) => void, reduced?: boolean }} opts
   */
  constructor(canvas, { onHover, onClick, reduced = false } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onHover = onHover ?? (() => {});
    this.onClick = onClick ?? (() => {});
    this.reduced = reduced;
    this.data = null;
    this.stars = [];
    this.hover = null;
    this.angle = 0;
    this.raf = 0;
    this.running = false;
    this.dpr = 1;
    this._resize = () => this.resize();
    this.observer = typeof ResizeObserver === 'function' ? new ResizeObserver(this._resize) : null;
    this.observer?.observe(canvas.parentElement ?? canvas);
    canvas.addEventListener('pointermove', (e) => this.pointer(e));
    canvas.addEventListener('pointerleave', () => this.setHover(null));
    canvas.addEventListener('click', (e) => {
      const s = this.hit(e);
      if (s) this.onClick(s.party);
    });
    this.resize();
  }

  destroy() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.observer?.disconnect();
  }

  resize() {
    const rect = (this.canvas.parentElement ?? this.canvas).getBoundingClientRect();
    this.dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    this.width = Math.max(1, Math.round(rect.width));
    this.height = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.layout();
    this.draw();
  }

  /**
   * @param {{ account, xrp, reserve, lines: { currency, issuer, balance }[], parties: object[] }} data
   */
  setData(data) {
    this.data = data;
    this.layout();
    this.draw();
    if (!this.running) {
      this.running = true;
      const loop = () => {
        if (!this.running) return;
        this.raf = requestAnimationFrame(loop);
        if (!this.reduced) {
          this.angle += 0.0009;
          this.draw();
        }
      };
      this.raf = requestAnimationFrame(loop);
    }
  }

  layout() {
    const d = this.data;
    this.stars = [];
    if (!d) return;
    const cx = this.width / 2;
    const cy = this.height / 2;
    const R = Math.min(this.width, this.height) / 2;
    const parties = (d.parties ?? []).slice(0, 48);
    const maxCount = Math.max(1, ...parties.map((p) => p.count));
    parties.forEach((p, i) => {
      const rank = i / Math.max(1, parties.length - 1);
      const base = 0.46 + rank * 0.44; // the most frequent nearest the centre
      const jitter = ((hashString(`${p.address}:r`) % 1000) / 1000 - 0.5) * 0.08;
      const radius = R * Math.min(0.94, base + jitter);
      const theta = ((hashString(p.address) % 3600) / 3600) * Math.PI * 2;
      const size = 3 + 5 * Math.log1p(p.count) / Math.log1p(maxCount);
      const cat = dominant(p.categories);
      this.stars.push({ party: p, theta, radius, size, rgb: hexToRgb(CATEGORIES[cat]?.colour ?? '#8d99ae'), hue: sigilPattern(p.address).hue, label: p.label ?? shortAddress(p.address) });
    });
    this.centre = { cx, cy, R };
  }

  starXY(s) {
    const { cx, cy } = this.centre;
    const a = s.theta + this.angle * (0.5 + (s.radius / this.centre.R) * 0.8);
    return [cx + Math.cos(a) * s.radius, cy + Math.sin(a) * s.radius];
  }

  hit(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let best = null;
    let bd = Infinity;
    for (const s of this.stars) {
      const [sx, sy] = this.starXY(s);
      const d = Math.hypot(sx - x, sy - y);
      if (d < Math.max(14, s.size * 2.4) && d < bd) {
        best = s;
        bd = d;
      }
    }
    return best;
  }

  pointer(e) {
    const s = this.hit(e);
    this.canvas.style.cursor = s ? 'pointer' : 'crosshair';
    this.setHover(s, e.clientX, e.clientY);
  }

  setHover(s, x, y) {
    if (this.hover === s && s) {
      this.onHover(s.party, x, y);
      return;
    }
    this.hover = s;
    this.onHover(s ? s.party : null, x, y);
    if (this.reduced) this.draw();
  }

  orbitRadius(value, R) {
    // log scale: 1 XRP ≈ 0.12 R, 100M XRP ≈ 0.4 R
    const v = Math.max(0, Number(value) || 0);
    return R * (0.08 + 0.04 * Math.log10(1 + v));
  }

  draw() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    ctx.clearRect(0, 0, w, h);
    if (!this.data || !this.centre) return;
    const { cx, cy, R } = this.centre;
    const d = this.data;

    // Faint graticule.
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(INK, 0.06);
    for (const f of [0.46, 0.68, 0.9]) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * f, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Lines to the stars, then the stars.
    for (const s of this.stars) {
      const [x, y] = this.starXY(s);
      const weight = 0.5 + 2 * Math.log1p(s.party.count) / Math.log1p(Math.max(2, this.stars[0]?.party.count ?? 2));
      const hot = this.hover === s;
      ctx.strokeStyle = rgba(s.rgb, hot ? 0.7 : 0.16);
      ctx.lineWidth = hot ? weight + 1 : weight;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const s of this.stars) {
      const [x, y] = this.starXY(s);
      const hot = this.hover === s;
      const glow = ctx.createRadialGradient(x, y, 0, x, y, s.size * (hot ? 5 : 3.2));
      glow.addColorStop(0, rgba(s.rgb, hot ? 0.6 : 0.35));
      glow.addColorStop(1, rgba(s.rgb, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, s.size * (hot ? 5 : 3.2), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgba(s.rgb, 0.95);
      ctx.beginPath();
      ctx.arc(x, y, s.size, 0, Math.PI * 2);
      ctx.fill();
      // the sigil's hue as a thin ring: the same account, the same colour, everywhere
      ctx.strokeStyle = `hsl(${s.hue} 70% 68% / ${hot ? 1 : 0.7})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(x, y, s.size + 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    // Labels for the nearest few and the hovered one.
    ctx.font = `500 10px ${MONO}`;
    ctx.textBaseline = 'middle';
    this.stars.forEach((s, i) => {
      if (i >= 7 && this.hover !== s) return;
      const [x, y] = this.starXY(s);
      const right = x >= cx;
      ctx.textAlign = right ? 'left' : 'right';
      ctx.fillStyle = rgba(INK, this.hover === s ? 1 : 0.75);
      ctx.fillText(s.label, x + (right ? s.size + 7 : -(s.size + 7)), y);
    });

    // Orbits: XRP ring, the reserve disc inside it, then each issued currency.
    const xrpR = this.orbitRadius(d.xrp, R);
    const reserveR = this.orbitRadius(d.reserve, R);
    ctx.fillStyle = rgba([249, 199, 79], d.reserve > d.xrp ? 0.22 : 0.1);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.min(reserveR, R * 0.44), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = rgba([76, 201, 240], 0.9);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, xrpR, 0, Math.PI * 2);
    ctx.stroke();
    const lines = (d.lines ?? []).filter((l) => Math.abs(Number(l.balance)) > 0).slice(0, 12);
    lines.forEach((l, i) => {
      const r = this.orbitRadius(Math.abs(Number(l.balance)), R) + 6 + i * 5;
      const hue = hashString(`${l.currency}:${l.issuer}`) % 360;
      ctx.strokeStyle = `hsl(${hue} 70% 68% / 0.55)`;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      const a = -Math.PI / 2 + (i / Math.max(1, lines.length)) * Math.PI * 2;
      ctx.fillStyle = `hsl(${hue} 70% 68%)`;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `500 9px ${MONO}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = `hsl(${hue} 70% 68% / 0.9)`;
      ctx.fillText(l.currency, cx + Math.cos(a) * r + 5, cy + Math.sin(a) * r);
    });
    // The account itself.
    ctx.fillStyle = rgba([232, 238, 251], 0.95);
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `600 11px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = rgba([76, 201, 240], 0.95);
    ctx.fillText(`${Number(d.xrp).toLocaleString('en-US', { maximumFractionDigits: 2 })} XRP`, cx, cy + xrpR + 6);
    ctx.font = `500 9px ${MONO}`;
    ctx.fillStyle = rgba([249, 199, 79], 0.85);
    ctx.fillText(`reserve ${Number(d.reserve).toLocaleString('en-US', { maximumFractionDigits: 2 })}`, cx, cy + xrpR + 20);
  }
}

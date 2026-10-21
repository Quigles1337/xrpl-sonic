// xrpl-sonic explorer — the constellation, in three dimensions.
//
// An account drawn as a place rather than a table. The account sits at the
// origin. Its XRP is a ring whose radius grows with the balance, with the
// reserve as a disc inside it (a disc that reaches the ring means the account
// is at its reserve). Each issued currency it holds is a further ring, each
// on its own tilted plane, with a bead travelling along it. The accounts it
// dealt with are stars placed around it on a sphere, the most frequent
// nearest, each in the colour of what they mostly did together and ringed in
// the hue of its sigil, joined to the centre by a line weighted by how often.
//
// A perspective camera (src/projection.js) looks at it all; the field turns
// slowly on its own, and you can drag to orbit it, with a little inertia.
// Hovering a star names it; clicking goes there. Everything is drawn with the
// 2D canvas at projected positions: no WebGL, no dependencies.

import { CATEGORIES, hashString, shortAddress } from '../mapping.js';
import { project, referenceScale, ringPoints, ringPoint, clampCamera } from '../projection.js';
import { sigilPattern } from './sigil.js';

const MONO = '"JetBrains Mono", "Cascadia Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace';
const INK = [128, 164, 224];
const rgba = ([r, g, b], a) => `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;
const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const LIMITS = { yaw: [-Infinity, Infinity], pitch: [-0.9, 1.25], distance: [1.6, 5] };

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
    this.camera = { yaw: 0.4, pitch: 0.42, distance: 2.3, fov: 1.0, target: [0, 0, 0] };
    this.spin = { yaw: 0, pitch: 0 }; // inertia
    this.drag = null;
    this.t0 = performance.now();
    this.raf = 0;
    this.running = false;
    this.dpr = 1;
    this._resize = () => this.resize();
    this.observer = typeof ResizeObserver === 'function' ? new ResizeObserver(this._resize) : null;
    this.observer?.observe(canvas.parentElement ?? canvas);
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    canvas.addEventListener('pointerleave', () => {
      if (!this.drag) this.setHover(null);
    });
    canvas.addEventListener('dblclick', () => {
      this.camera = { ...this.camera, yaw: 0.4, pitch: 0.42, distance: 2.3 };
      this.spin = { yaw: 0, pitch: 0 };
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camera = clampCamera({ ...this.camera, distance: this.camera.distance * (1 + Math.sign(e.deltaY) * 0.08) }, LIMITS);
      this.draw();
    }, { passive: false });
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
    this.draw();
  }

  /** @param {{ account, xrp, reserve, lines: { currency, issuer, balance }[], parties: object[] }} data */
  setData(data) {
    this.data = data;
    this.layout();
    this.draw();
    if (!this.running) {
      this.running = true;
      const loop = () => {
        if (!this.running) return;
        this.raf = requestAnimationFrame(loop);
        this.step();
      };
      this.raf = requestAnimationFrame(loop);
    }
  }

  layout() {
    const d = this.data;
    this.stars = [];
    if (!d) return;
    const parties = (d.parties ?? []).slice(0, 48);
    const maxCount = Math.max(1, ...parties.map((p) => p.count));
    parties.forEach((p, i) => {
      const rank = i / Math.max(1, parties.length - 1);
      const radius = 0.55 + rank * 0.55 + ((hashString(`${p.address}:r`) % 1000) / 1000 - 0.5) * 0.08;
      const theta = ((hashString(p.address) % 3600) / 3600) * Math.PI * 2;
      const phi = ((hashString(`${p.address}:e`) % 1000) / 1000 - 0.5) * 0.9; // elevation: a band, not a disc
      const cat = dominant(p.categories);
      this.stars.push({
        party: p,
        pos: [radius * Math.cos(phi) * Math.cos(theta), radius * Math.sin(phi), radius * Math.cos(phi) * Math.sin(theta)],
        size: 2.6 + 4.6 * Math.log1p(p.count) / Math.log1p(maxCount),
        rgb: hexToRgb(CATEGORIES[cat]?.colour ?? '#8d99ae'),
        hue: sigilPattern(p.address).hue,
        label: p.label ?? shortAddress(p.address),
        weight: 0.4 + 1.8 * Math.log1p(p.count) / Math.log1p(maxCount),
        px: 0,
        py: 0,
        ps: 1,
      });
    });
  }

  // --- camera interaction ---------------------------------------------------

  down(e) {
    this.drag = { x: e.clientX, y: e.clientY, moved: false, lastX: e.clientX, lastY: e.clientY, lastT: performance.now() };
    this.canvas.setPointerCapture?.(e.pointerId);
  }

  move(e) {
    if (this.drag) {
      const dx = e.clientX - this.drag.lastX;
      const dy = e.clientY - this.drag.lastY;
      if (Math.hypot(e.clientX - this.drag.x, e.clientY - this.drag.y) > 4) this.drag.moved = true;
      if (this.drag.moved) {
        this.camera = clampCamera({ ...this.camera, yaw: this.camera.yaw - dx * 0.006, pitch: this.camera.pitch + dy * 0.005 }, LIMITS);
        const dt = Math.max(1, performance.now() - this.drag.lastT);
        this.spin = { yaw: (-dx * 0.006) / dt * 16, pitch: (dy * 0.005) / dt * 16 };
        this.canvas.style.cursor = 'grabbing';
        this.setHover(null);
        this.draw();
      }
      this.drag.lastX = e.clientX;
      this.drag.lastY = e.clientY;
      this.drag.lastT = performance.now();
      return;
    }
    const s = this.hit(e);
    this.canvas.style.cursor = s ? 'pointer' : 'grab';
    this.setHover(s, e.clientX, e.clientY);
  }

  up(e) {
    if (!this.drag) return;
    const { moved } = this.drag;
    this.drag = null;
    this.canvas.style.cursor = 'grab';
    if (!moved) {
      const s = this.hit(e);
      if (s) this.onClick(s.party);
    }
  }

  hit(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let best = null;
    let bd = Infinity;
    for (const s of this.stars) {
      const d = Math.hypot(s.px - x, s.py - y);
      if (d < Math.max(12, s.size * s.ps * 2.4) && d < bd) {
        best = s;
        bd = d;
      }
    }
    return best;
  }

  setHover(s, x, y) {
    if (this.hover === s && s) {
      this.onHover(s.party, x, y);
      return;
    }
    this.hover = s;
    this.onHover(s ? s.party : null, x, y);
  }

  step() {
    if (!this.drag) {
      // inertia, then the slow turn of the field
      if (Math.abs(this.spin.yaw) > 1e-4 || Math.abs(this.spin.pitch) > 1e-4) {
        this.camera = clampCamera({ ...this.camera, yaw: this.camera.yaw + this.spin.yaw, pitch: this.camera.pitch + this.spin.pitch }, LIMITS);
        this.spin = { yaw: this.spin.yaw * 0.92, pitch: this.spin.pitch * 0.92 };
      } else if (!this.reduced) {
        this.camera = { ...this.camera, yaw: this.camera.yaw + 0.0012 };
      }
    }
    if (!this.reduced || this.drag) this.draw();
  }

  orbitRadius(value) {
    // log scale in world units: 1 XRP ≈ 0.16, 100M XRP ≈ 0.56
    const v = Math.max(0, Number(value) || 0);
    return 0.12 + 0.055 * Math.log10(1 + v);
  }

  draw() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    ctx.clearRect(0, 0, w, h);
    if (!this.data) return;
    const d = this.data;
    const vp = { width: w, height: h };
    const cam = this.camera;
    const ref = referenceScale(cam, vp);
    const t = (performance.now() - this.t0) / 1000;
    const centre = project([0, 0, 0], cam, vp);
    if (!centre) return;
    const fog = (depth) => Math.max(0.35, Math.min(1, 1.35 - (depth - cam.distance) * 0.45));

    // --- the reserve disc, then the XRP ring on the equatorial plane --------
    const xrpR = this.orbitRadius(d.xrp);
    const reserveR = Math.min(this.orbitRadius(d.reserve), 0.7);
    const disc = ringPoints([0, 0, 0], reserveR, { segments: 48 }).map((p) => project(p, cam, vp)).filter(Boolean);
    if (disc.length > 2) {
      ctx.fillStyle = rgba([249, 199, 79], d.reserve > d.xrp ? 0.26 : 0.12);
      ctx.beginPath();
      disc.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
    }
    this.strokeRing(ringPoints([0, 0, 0], xrpR, { segments: 72 }), rgba([76, 201, 240], 0.9), 2, cam, vp);

    // --- currency orbits: each on its own tilted plane, with a travelling bead
    const lines = (d.lines ?? []).filter((l) => Math.abs(Number(l.balance)) > 0).slice(0, 12);
    const orbits = lines.map((l, i) => {
      const seed = hashString(`${l.currency}:${l.issuer}`);
      const hue = seed % 360;
      return {
        l,
        hue,
        r: this.orbitRadius(Math.abs(Number(l.balance))) + 0.05 + i * 0.035,
        tilt: 0.25 + ((seed >> 8) % 100) / 100 * 0.9,
        turn: ((seed >> 16) % 628) / 100,
        speed: 0.08 + ((seed >> 4) % 10) / 100,
        phase: ((seed >> 20) % 628) / 100,
      };
    });
    for (const o of orbits) {
      ctx.setLineDash([2, 5]);
      this.strokeRing(ringPoints([0, 0, 0], o.r, { tilt: o.tilt, turn: o.turn, segments: 64 }), `hsl(${o.hue} 70% 68% / 0.5)`, 1, cam, vp);
      ctx.setLineDash([]);
    }

    // --- stars: project, depth-sort, draw far to near --------------------------
    for (const s of this.stars) {
      const p = project(s.pos, cam, vp);
      s.visible = Boolean(p);
      if (!p) continue;
      s.px = p.x;
      s.py = p.y;
      s.ps = p.scale / ref;
      s.depth = p.depth;
    }
    const order = this.stars.filter((s) => s.visible).sort((a, b) => b.depth - a.depth);
    for (const s of order) {
      const hot = this.hover === s;
      const a = fog(s.depth);
      ctx.strokeStyle = rgba(s.rgb, (hot ? 0.75 : 0.16) * a);
      ctx.lineWidth = (hot ? s.weight + 1 : s.weight) * s.ps;
      ctx.beginPath();
      ctx.moveTo(centre.x, centre.y);
      ctx.lineTo(s.px, s.py);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const s of order) {
      const hot = this.hover === s;
      const a = fog(s.depth);
      const r = s.size * s.ps;
      const glow = ctx.createRadialGradient(s.px, s.py, 0, s.px, s.py, r * (hot ? 5 : 3.2));
      glow.addColorStop(0, rgba(s.rgb, (hot ? 0.6 : 0.35) * a));
      glow.addColorStop(1, rgba(s.rgb, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(s.px, s.py, r * (hot ? 5 : 3.2), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgba(s.rgb, 0.95 * a);
      ctx.beginPath();
      ctx.arc(s.px, s.py, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `hsl(${s.hue} 70% 68% / ${((hot ? 1 : 0.7) * a).toFixed(2)})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(s.px, s.py, r + 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    // beads on the currency orbits, with the currency's name
    for (const o of orbits) {
      const bead = project(ringPoint([0, 0, 0], o.r, o.phase + t * o.speed, { tilt: o.tilt, turn: o.turn }), cam, vp);
      if (!bead) continue;
      const a = fog(bead.depth);
      const br = 2.6 * (bead.scale / ref);
      const g = ctx.createRadialGradient(bead.x, bead.y, 0, bead.x, bead.y, br * 4);
      g.addColorStop(0, `hsl(${o.hue} 70% 68% / ${(0.5 * a).toFixed(2)})`);
      g.addColorStop(1, `hsl(${o.hue} 70% 68% / 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(bead.x, bead.y, br * 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `hsl(${o.hue} 70% 68%)`;
      ctx.beginPath();
      ctx.arc(bead.x, bead.y, br, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.font = `500 ${Math.max(8, 9 * (bead.scale / ref)).toFixed(1)}px ${MONO}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = `hsl(${o.hue} 70% 68% / ${(0.9 * a).toFixed(2)})`;
      ctx.fillText(o.l.currency, bead.x + br + 4, bead.y);
      ctx.globalCompositeOperation = 'lighter';
    }
    ctx.globalCompositeOperation = 'source-over';

    // --- labels: the nearest few by rank, and the hovered one -------------------
    ctx.textBaseline = 'middle';
    this.stars.forEach((s, i) => {
      if (!s.visible || (i >= 7 && this.hover !== s)) return;
      const right = s.px >= centre.x;
      ctx.font = `500 ${Math.max(8, 10 * Math.min(1.1, s.ps)).toFixed(1)}px ${MONO}`;
      ctx.textAlign = right ? 'left' : 'right';
      ctx.fillStyle = rgba(INK, (this.hover === s ? 1 : 0.75) * fog(s.depth));
      const off = s.size * s.ps + 7;
      ctx.fillText(s.label, s.px + (right ? off : -off), s.py);
    });

    // --- the account itself, and the balance under its ring ---------------------
    ctx.fillStyle = rgba([232, 238, 251], 0.95);
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, 4 * Math.min(1.2, centre.scale / ref), 0, Math.PI * 2);
    ctx.fill();
    const under = project([0, -0.02, xrpR], cam, vp) ?? centre;
    ctx.font = `600 11px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = rgba([76, 201, 240], 0.95);
    ctx.fillText(`${Number(d.xrp).toLocaleString('en-US', { maximumFractionDigits: 2 })} XRP`, under.x, under.y + 6);
    ctx.font = `500 9px ${MONO}`;
    ctx.fillStyle = rgba([249, 199, 79], 0.85);
    ctx.fillText(`reserve ${Number(d.reserve).toLocaleString('en-US', { maximumFractionDigits: 2 })}`, under.x, under.y + 20);
  }

  strokeRing(points, style, width, cam, vp) {
    const ctx = this.ctx;
    const pts = points.map((p) => project(p, cam, vp));
    if (pts.some((p) => !p)) return;
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
  }
}

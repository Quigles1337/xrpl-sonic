// xrpl-sonic explorer — the constellation, in three dimensions.
//
// An account drawn as a place rather than a table. The account sits at the
// origin. Its XRP is a ring whose radius grows with the balance, with the
// reserve as a disc inside it (a disc that reaches the ring means the account
// is at its reserve). Each issued currency it holds is a further ring, each
// on its own tilted plane in the currency's colour, with a bead travelling
// along it. The accounts it dealt with are stars placed around it on a
// sphere, the most frequent nearest, each in the colour of what they mostly
// did together and ringed in the hue of its sigil; the counterparties of its
// trust lines are stars too, in their currency's colour.
//
// The lines from the centre to a star are the edges (src/explorer/edges.js):
// each trust line in its currency's colour, as wide as its balance, with an
// arrowhead on the trusted side; each transaction as a strand in the colour
// of its category, as wide as its amount, with an arrowhead at the receiving
// end, dashed when it failed, dotted when it was a partial payment, and a
// bead in its currency's colour near the star. Lines to the same star fan
// out side by side.
//
// A perspective camera (src/projection.js) looks at it all; the field turns
// slowly on its own, and you can drag to orbit it, with a little inertia.
// Hovering a star names it; clicking goes there. Everything is drawn with the
// 2D canvas at projected positions: no WebGL, no dependencies.

import { project, referenceScale, ringPoints, ringPoint, clampCamera } from '../projection.js';
import { constellationModel, currencyRgb, hueCss, orbitRadius, XRP_RGB } from './edges.js';

const MONO = '"JetBrains Mono", "Cascadia Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace';
const INK = [128, 164, 224];
const RESERVE = [249, 199, 79];
const rgba = ([r, g, b], a) => `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;
const LIMITS = { yaw: [-Infinity, Infinity], pitch: [-0.9, 1.25], distance: [1.6, 5] };
const EMPTY_MODEL = Object.freeze({ stars: [], edges: [], strands: [], orbits: [], currencies: [], categories: [], hues: new Map(), counts: { stars: 0, trust: { drawn: 0, total: 0 }, strands: { drawn: 0, total: 0, attached: 0 } } });

export class Constellation {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ onHover?: (star|null, x, y) => void, onClick?: (star) => void, reduced?: boolean }} opts
   *   A star is { address, party, trust, strands, … } from src/explorer/edges.js.
   */
  constructor(canvas, { onHover, onClick, reduced = false } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onHover = onHover ?? (() => {});
    this.onClick = onClick ?? (() => {});
    this.reduced = reduced;
    this.data = null;
    this.model = EMPTY_MODEL;
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

  /**
   * @param {{ account, xrp, reserve, lines?: object[], parties?: object[], entries?: object[] }} data
   *   `lines` are account_lines entries, `parties` from counterparties(), `entries` the account_tx records.
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
        this.step();
      };
      this.raf = requestAnimationFrame(loop);
    }
  }

  layout() {
    const d = this.data;
    this.model = d ? constellationModel(d) : EMPTY_MODEL;
    const kept = this.hover?.address ?? null;
    this.stars = this.model.stars.map((s) => ({ ...s, px: 0, py: 0, ps: 1, depth: 0, visible: false }));
    this.hover = kept ? (this.stars.find((s) => s.address === kept) ?? null) : null;
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
      if (s) this.onClick(s);
    }
  }

  hit(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let best = null;
    let bd = Infinity;
    for (const s of this.stars) {
      if (!s.visible) continue;
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
      this.onHover(s, x, y);
      return;
    }
    this.hover = s;
    this.onHover(s ?? null, x, y);
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
    const xrpR = orbitRadius(d.xrp);
    const reserveR = Math.min(orbitRadius(d.reserve), 0.7);
    const disc = ringPoints([0, 0, 0], reserveR, { segments: 48 }).map((p) => project(p, cam, vp)).filter(Boolean);
    if (disc.length > 2) {
      ctx.fillStyle = rgba(RESERVE, d.reserve > d.xrp ? 0.26 : 0.12);
      ctx.beginPath();
      disc.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
    }
    this.strokeRing(ringPoints([0, 0, 0], xrpR, { segments: 72 }), rgba(XRP_RGB, 0.9), 2, cam, vp);

    // --- currency orbits: each on its own tilted plane, in its currency's hue
    const orbits = this.model.orbits;
    for (const o of orbits) {
      ctx.setLineDash([2, 5]);
      this.strokeRing(ringPoints([0, 0, 0], o.r, { tilt: o.tilt, turn: o.turn, segments: 64 }), hueCss(o.hue, 0.5), 1, cam, vp);
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

    // the lines: a faint one for how often, then the edges fanned out beside it
    for (const s of order) {
      const hot = this.hover === s;
      const a = fog(s.depth);
      if (s.weight > 0) {
        ctx.strokeStyle = rgba(s.rgb, (hot ? 0.5 : 0.12) * a);
        ctx.lineWidth = (hot ? s.weight + 1 : s.weight) * s.ps;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(centre.x, centre.y);
        ctx.lineTo(s.px, s.py);
        ctx.stroke();
      }
      this.drawLinks(s, centre, hot, a);
    }

    ctx.setLineDash([]);
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
      g.addColorStop(0, hueCss(o.hue, 0.5 * a));
      g.addColorStop(1, hueCss(o.hue, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(bead.x, bead.y, br * 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = hueCss(o.hue);
      ctx.beginPath();
      ctx.arc(bead.x, bead.y, br, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.font = `500 ${Math.max(8, 9 * (bead.scale / ref)).toFixed(1)}px ${MONO}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = hueCss(o.hue, 0.9 * a);
      ctx.fillText(o.name, bead.x + br + 4, bead.y);
      ctx.globalCompositeOperation = 'lighter';
    }
    ctx.globalCompositeOperation = 'source-over';

    // --- labels: the nearest few by rank, and the hovered one -------------------
    ctx.textBaseline = 'middle';
    for (const s of this.stars) {
      if (!s.visible || (!s.labelled && this.hover !== s)) continue;
      const right = s.px >= centre.x;
      ctx.font = `500 ${Math.max(8, 10 * Math.min(1.1, s.ps)).toFixed(1)}px ${MONO}`;
      ctx.textAlign = right ? 'left' : 'right';
      ctx.fillStyle = rgba(INK, (this.hover === s ? 1 : 0.75) * fog(s.depth));
      const off = s.size * s.ps + 7;
      ctx.fillText(s.label, s.px + (right ? off : -off), s.py);
    }

    // --- the account itself, and the balance under its ring ---------------------
    ctx.fillStyle = rgba([232, 238, 251], 0.95);
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, 4 * Math.min(1.2, centre.scale / ref), 0, Math.PI * 2);
    ctx.fill();
    const under = project([0, -0.02, xrpR], cam, vp) ?? centre;
    ctx.font = `600 11px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = rgba(XRP_RGB, 0.95);
    ctx.fillText(`${Number(d.xrp).toLocaleString('en-US', { maximumFractionDigits: 2 })} XRP`, under.x, under.y + 6);
    ctx.font = `500 9px ${MONO}`;
    ctx.fillStyle = rgba(RESERVE, 0.85);
    ctx.fillText(`reserve ${Number(d.reserve).toLocaleString('en-US', { maximumFractionDigits: 2 })}`, under.x, under.y + 20);
  }

  /**
   * The edges of one star, fanned out side by side: trust lines first, then
   * the strands. The fan is widest at the star and narrower at the centre.
   */
  drawLinks(s, centre, hot, a) {
    const ctx = this.ctx;
    const links = [...s.trust, ...s.strands];
    const k = links.length;
    if (!k) return;
    const dx = s.px - centre.x;
    const dy = s.py - centre.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;
    // a bundle of many lines is thinned so that each stays its own line, never a ribbon
    const fanScale = k > 4 ? 4 / k : 1;
    const widthOf = (link) => (link.kind === 'trust' ? 0.8 + 3.2 * link.width : 0.6 + 2.4 * link.width) * s.ps * fanScale;
    const spacing = k > 1 ? Math.max(...links.map(widthOf)) + 1.2 * s.ps : 0;
    const starGap = s.size * s.ps + 4;
    links.forEach((link, i) => {
      const off = (i - (k - 1) / 2) * spacing;
      const x0 = centre.x + nx * off * 0.4;
      const y0 = centre.y + ny * off * 0.4;
      const x1 = s.px + nx * off;
      const y1 = s.py + ny * off;
      const trust = link.kind === 'trust';
      const width = widthOf(link);
      const colour = trust ? hueCss(link.hue, (hot ? 0.95 : 0.75) * a) : rgba(link.rgb, (link.success ? (hot ? 0.85 : 0.5) : hot ? 0.6 : 0.3) * a);
      ctx.strokeStyle = colour;
      ctx.fillStyle = colour;
      ctx.lineWidth = width;
      ctx.setLineDash(trust ? (link.width === 0 ? [2, 5] : []) : !link.success ? [5, 4] : link.partial ? [1.5, 3] : []);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1 - ux * starGap, y1 - uy * starGap);
      ctx.stroke();
      ctx.setLineDash([]);
      // arrowheads: at the star for `out`; a third of the way out from the centre, pointing in, for `in`; both for `both`
      const head = (3.5 + 4 * link.width) * s.ps;
      if (link.direction === 'out' || link.direction === 'both') this.arrow(x1 - ux * starGap, y1 - uy * starGap, ux, uy, head, width);
      if (link.direction === 'in' || link.direction === 'both') this.arrow(x0 + (x1 - x0) * 0.3, y0 + (y1 - y0) * 0.3, -ux, -uy, head, width);
      // a bead in the currency's colour near the star, for a strand that moved one
      if (!trust && link.currency) {
        const bx = x0 + (x1 - x0) * 0.72;
        const by = y0 + (y1 - y0) * 0.72;
        ctx.fillStyle = rgba(currencyRgb(link.currency, this.model.hues), 0.95 * a);
        ctx.beginPath();
        ctx.arc(bx, by, (1.6 + 1.6 * link.width) * s.ps, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  /** A filled arrowhead with its tip at (x, y), pointing along (ux, uy). */
  arrow(x, y, ux, uy, size, lineWidth) {
    const ctx = this.ctx;
    const hw = Math.max(size * 0.45, lineWidth * 0.9);
    const bx = x - ux * size;
    const by = y - uy * size;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(bx - uy * hw, by + ux * hw);
    ctx.lineTo(bx + uy * hw, by - ux * hw);
    ctx.closePath();
    ctx.fill();
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

// UNIVERSE spike — the sky in WebGL, hand-written, to measure against the 2D canvas.
//
// The same camera (a copy of src/projection.js) is evaluated in the vertex
// shader: every planet is one point sprite whose size is its body size over
// its depth, its colour from its hue, its glow from its activity; the
// fragment shader draws a soft disc with a halo, additively. Comets are
// line segments rebuilt per frame. Nebulae are large soft points. The near
// level's marks (rings, a black hole's rim, labels) are drawn on the 2D
// overlay for the few planets that are near, so the text equivalent and
// the focus ring are the same on both paths. No library: the shaders, the
// buffers and the matrix are written here.
//
// Measured against src/universe/sky.js by src/universe/bench/frames.mjs.

import { project, referenceScale, clampCamera } from './projection.js';
import { CATEGORIES } from '../mapping.js';
import { KINDS } from './bodies.js';
import { CAMERA_HOME, CAMERA_LIMITS, BASE_PX, LOD, percentiles, hslToRgb } from './sky.js';

const MONO = '"JetBrains Mono", "Cascadia Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace';
const CATEGORY_RGB = ['payment', 'offer', 'trust', 'nft', 'escrow', 'paychan', 'amm', 'other'].map((c) => {
  const n = parseInt(CATEGORIES[c].colour.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
});
const LAYER_OF_CATEGORY = ['payment', 'dex', 'trust', 'nft', 'payment', 'payment', 'dex', 'other'];
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

const POINT_VS = `
attribute vec3 aPos;
attribute float aSize;
attribute float aHue;
attribute float aGlow;
attribute float aKind;
uniform vec3 uTarget;
uniform float uYaw;
uniform float uPitch;
uniform float uDistance;
uniform vec2 uViewport;
uniform float uFocal;
uniform float uBasePx;
uniform float uDpr;
varying float vHue;
varying float vGlow;
varying float vKind;
varying float vRadius;
void main() {
  vec3 t = aPos - uTarget;
  float cy = cos(uYaw); float sy = sin(uYaw);
  float x1 = t.x * cy - t.z * sy;
  float z1 = t.x * sy + t.z * cy;
  float cp = cos(uPitch); float sp = sin(uPitch);
  float y2 = t.y * cp + z1 * sp;
  float z2 = -t.y * sp + z1 * cp;
  float depth = z2 + uDistance;
  gl_Position = vec4(x1 * uFocal * 2.0 / uViewport.x, y2 * uFocal * 2.0 / uViewport.y, 0.0, depth);
  float radius = aSize * uBasePx * uDistance / max(depth, 0.001);
  vRadius = radius;
  float halo = 2.4 + 2.0 * aGlow;
  gl_PointSize = clamp(radius * halo * 2.0 * uDpr, 1.0, 128.0);
  vHue = aHue; vGlow = aGlow; vKind = aKind;
}`;

const POINT_FS = `
precision mediump float;
varying float vHue;
varying float vGlow;
varying float vKind;
varying float vRadius;
vec3 hsl(float h, float s, float l) {
  float c = (1.0 - abs(2.0 * l - 1.0)) * s;
  float hp = mod(h, 360.0) / 60.0;
  float x = c * (1.0 - abs(mod(hp, 2.0) - 1.0));
  vec3 rgb = hp < 1.0 ? vec3(c, x, 0.0) : hp < 2.0 ? vec3(x, c, 0.0) : hp < 3.0 ? vec3(0.0, c, x) : hp < 4.0 ? vec3(0.0, x, c) : hp < 5.0 ? vec3(x, 0.0, c) : vec3(c, 0.0, x);
  return rgb + (l - c / 2.0);
}
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = length(p);
  if (d > 1.0) discard;
  vec3 rgb = hsl(vHue, 0.7, 0.68);
  float halo = 2.4 + 2.0 * vGlow;
  float core = 1.0 / halo;           // the disc's radius in point units
  float disc = smoothstep(core, core * 0.7, d);
  float glow = exp(-d * d * 3.5) * (0.35 + 0.5 * vGlow) * (1.0 - disc);
  float a = disc * 0.95 + glow;
  vec3 colour = mix(rgb, vec3(1.0), disc * 0.55);
  if (vKind > 2.5 && vKind < 3.5) { // black hole: dark core, bright rim
    float rim = smoothstep(core * 0.75, core * 0.95, d) * (1.0 - smoothstep(core * 0.95, core * 1.25, d));
    colour = mix(vec3(0.0), rgb, rim);
    a = disc * 0.98 + glow * 0.5;
  }
  if (vKind > 4.5) { a *= 0.3; } // collapsed
  if (vRadius < 1.1) { a *= 0.6 + 0.4 * vGlow; }
  gl_FragColor = vec4(colour * a, a);
}`;

const LINE_VS = `
attribute vec3 aPos;
attribute vec4 aColour;
uniform vec3 uTarget;
uniform float uYaw;
uniform float uPitch;
uniform float uDistance;
uniform vec2 uViewport;
uniform float uFocal;
varying vec4 vColour;
void main() {
  vec3 t = aPos - uTarget;
  float cy = cos(uYaw); float sy = sin(uYaw);
  float x1 = t.x * cy - t.z * sy;
  float z1 = t.x * sy + t.z * cy;
  float cp = cos(uPitch); float sp = sin(uPitch);
  float y2 = t.y * cp + z1 * sp;
  float z2 = -t.y * sp + z1 * cp;
  float depth = z2 + uDistance;
  gl_Position = vec4(x1 * uFocal * 2.0 / uViewport.x, y2 * uFocal * 2.0 / uViewport.y, 0.0, depth);
  vColour = aColour;
}`;

const LINE_FS = `
precision mediump float;
varying vec4 vColour;
void main() { gl_FragColor = vec4(vColour.rgb * vColour.a, vColour.a); }`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(sh)}`);
  return sh;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
  return p;
}

export class SkyGL {
  constructor(canvas, labels, { reduced = false, onHover } = {}) {
    this.canvas = canvas;
    this.labels = labels;
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL is not available');
    this.gl = gl;
    this.lctx = labels.getContext('2d');
    this.reduced = reduced;
    this.onHover = onHover ?? (() => {});
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
    this.intervalMs = 4000;
    this.frameTimes = [];
    this.frames = 0;
    this.lodCounts = { far: 0, mid: 0, near: 0, culled: 0 };
    this.glow = new Float32Array(1);
    this.screen = { x: new Float32Array(1), y: new Float32Array(1), r: new Float32Array(1), depth: new Float32Array(1) };
    this.points = program(gl, POINT_VS, POINT_FS);
    this.lines = program(gl, LINE_VS, LINE_FS);
    this.buffers = { pos: gl.createBuffer(), size: gl.createBuffer(), hue: gl.createBuffer(), glow: gl.createBuffer(), kind: gl.createBuffer(), linePos: gl.createBuffer(), lineColour: gl.createBuffer(), nebPos: gl.createBuffer(), nebSize: gl.createBuffer(), nebHue: gl.createBuffer(), nebGlow: gl.createBuffer(), nebKind: gl.createBuffer() };
    this.loc = {
      p: { aPos: gl.getAttribLocation(this.points, 'aPos'), aSize: gl.getAttribLocation(this.points, 'aSize'), aHue: gl.getAttribLocation(this.points, 'aHue'), aGlow: gl.getAttribLocation(this.points, 'aGlow'), aKind: gl.getAttribLocation(this.points, 'aKind'), uTarget: gl.getUniformLocation(this.points, 'uTarget'), uYaw: gl.getUniformLocation(this.points, 'uYaw'), uPitch: gl.getUniformLocation(this.points, 'uPitch'), uDistance: gl.getUniformLocation(this.points, 'uDistance'), uViewport: gl.getUniformLocation(this.points, 'uViewport'), uFocal: gl.getUniformLocation(this.points, 'uFocal'), uBasePx: gl.getUniformLocation(this.points, 'uBasePx'), uDpr: gl.getUniformLocation(this.points, 'uDpr') },
      l: { aPos: gl.getAttribLocation(this.lines, 'aPos'), aColour: gl.getAttribLocation(this.lines, 'aColour'), uTarget: gl.getUniformLocation(this.lines, 'uTarget'), uYaw: gl.getUniformLocation(this.lines, 'uYaw'), uPitch: gl.getUniformLocation(this.lines, 'uPitch'), uDistance: gl.getUniformLocation(this.lines, 'uDistance'), uViewport: gl.getUniformLocation(this.lines, 'uViewport'), uFocal: gl.getUniformLocation(this.lines, 'uFocal') },
    };
    this.positionsDirty = true;
    this.attrsDirty = true;
    this.dpr = 1;
    this.width = 1;
    this.height = 1;
    this._resize = () => this.resize();
    globalThis.addEventListener?.('resize', this._resize);
    this._bindPointer();
    this.resize();
  }

  destroy() {
    globalThis.removeEventListener?.('resize', this._resize);
  }

  // the data interface, shared with Sky
  setPositions(positions, n) {
    this.positions = positions;
    this.n = Math.min(n ?? Math.floor(positions.length / 3) - 1, Math.floor(positions.length / 3) - 1);
    if (this.screen.x.length < this.n + 1) {
      const len = Math.max(this.n + 1, this.screen.x.length * 2);
      this.screen = { x: new Float32Array(len), y: new Float32Array(len), r: new Float32Array(len), depth: new Float32Array(len) };
      this.glow = new Float32Array(len);
    }
    this.positionsDirty = true;
  }

  setAttributes(attrs, added = [], ledger = this.ledger) {
    this.attrs = attrs;
    for (const [id, address] of added) this.addresses[id] = address;
    this.ledger = ledger;
    this.attrsDirty = true;
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

  lookAt(id, { distance = 0.9 } = {}) {
    if (!id || id > this.n) return;
    const i = 3 * id;
    this.camera = clampCamera({ ...this.camera, target: [this.positions[i], this.positions[i + 1], this.positions[i + 2]], distance: Math.min(this.camera.distance, distance) }, CAMERA_LIMITS);
  }

  _bindPointer() {
    const c = this.canvas;
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
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

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
    const a = this.attrs;
    if (!a || !(a.activity[id] > 0)) return 0;
    const age = Math.max(0, ledger - a.lastLedger[id]);
    const now = a.activity[id] * 0.5 ** (age / 6);
    return Math.min(1, Math.log2(1 + now) / 5);
  }

  _uniforms(loc) {
    const gl = this.gl;
    const cam = this.camera;
    gl.uniform3f(loc.uTarget, cam.target[0], cam.target[1], cam.target[2]);
    gl.uniform1f(loc.uYaw, cam.yaw);
    gl.uniform1f(loc.uPitch, cam.pitch);
    gl.uniform1f(loc.uDistance, cam.distance);
    gl.uniform2f(loc.uViewport, this.width, this.height);
    gl.uniform1f(loc.uFocal, this.height / 2 / Math.tan(cam.fov / 2));
  }

  _attrib(buffer, loc, data, size, upload) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    if (upload) gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }

  draw(now = performance.now()) {
    const t0 = performance.now();
    const gl = this.gl;
    if (!this.drag) {
      if (Math.abs(this.spin.yaw) > 1e-4 || Math.abs(this.spin.pitch) > 1e-4) {
        this.orbit(this.spin.yaw, this.spin.pitch);
        this.spin = { yaw: this.spin.yaw * 0.92, pitch: this.spin.pitch * 0.92 };
      } else if (!this.reduced) this.camera = { ...this.camera, yaw: this.camera.yaw + 0.0006 };
    }
    const cam = this.camera;
    const vp = { width: this.width, height: this.height };
    const ref = referenceScale(cam, vp);
    const a = this.attrs;
    const n = a ? Math.min(this.n, a.n) : 0;
    gl.clearColor(6 / 255, 10 / 255, 18 / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // additive, premultiplied
    // the screen positions for hit tests, labels and comets (JS side, once per frame)
    const s = this.screen;
    const near = [];
    let far = 0;
    let mid = 0;
    let culled = 0;
    for (let id = 1; id <= n; id++) {
      const i = 3 * id;
      const p = project([this.positions[i], this.positions[i + 1], this.positions[i + 2]], cam, vp);
      if (!p) {
        s.depth[id] = 0;
        culled += 1;
        continue;
      }
      const r = a.size[id] * BASE_PX * (p.scale / ref);
      s.x[id] = p.x;
      s.y[id] = p.y;
      s.r[id] = r;
      s.depth[id] = p.depth;
      this.glow[id] = this.glowOf(id, this.ledger);
      if (r < LOD.far) far += 1;
      else if (r < LOD.near) mid += 1;
      else near.push(id);
    }
    if (n > 0) {
      gl.useProgram(this.points);
      this._uniforms(this.loc.p);
      gl.uniform1f(this.loc.p.uBasePx, BASE_PX);
      gl.uniform1f(this.loc.p.uDpr, this.dpr);
      this._attrib(this.buffers.pos, this.loc.p.aPos, this.positions, 3, this.positionsDirty);
      this._attrib(this.buffers.size, this.loc.p.aSize, a.size, 1, this.attrsDirty);
      this._attrib(this.buffers.hue, this.loc.p.aHue, new Float32Array(a.hue), 1, this.attrsDirty);
      this._attrib(this.buffers.kind, this.loc.p.aKind, new Float32Array(a.kind), 1, this.attrsDirty);
      this._attrib(this.buffers.glow, this.loc.p.aGlow, this.glow, 1, true);
      this.positionsDirty = false;
      this.attrsDirty = false;
      gl.drawArrays(gl.POINTS, 1, n);
    }
    // nebulae at far zoom as large soft points
    if (cam.distance >= 2.4 && this.nebulae.length) {
      const k = this.nebulae.length;
      const pos = new Float32Array(3 * k);
      const size = new Float32Array(k);
      const hue = new Float32Array(k).fill(220);
      const glow = new Float32Array(k).fill(0.2);
      const kind = new Float32Array(k);
      this.nebulae.forEach((nb, j) => {
        pos[3 * j] = nb.x;
        pos[3 * j + 1] = nb.y;
        pos[3 * j + 2] = nb.z;
        size[j] = Math.max(3, (nb.r + 0.04) * 60) / BASE_PX;
      });
      this._attrib(this.buffers.nebPos, this.loc.p.aPos, pos, 3, true);
      this._attrib(this.buffers.nebSize, this.loc.p.aSize, size, 1, true);
      this._attrib(this.buffers.nebHue, this.loc.p.aHue, hue, 1, true);
      this._attrib(this.buffers.nebGlow, this.loc.p.aGlow, glow, 1, true);
      this._attrib(this.buffers.nebKind, this.loc.p.aKind, kind, 1, true);
      gl.drawArrays(gl.POINTS, 0, k);
    }
    // comets, flashes (as short crosses) and pair links as lines
    this.drawLines(now);
    // the overlay: near marks and labels
    this.drawOverlay(near, now);
    const ms = performance.now() - t0;
    this.frameTimes.push(ms);
    if (this.frameTimes.length > 600) this.frameTimes.shift();
    this.frames += 1;
    this.lodCounts = { far, mid, near: near.length, culled };
    return ms;
  }

  drawLines(now) {
    const gl = this.gl;
    const pos = [];
    const col = [];
    const P = this.positions;
    const push = (i, j, rgb, alpha) => {
      pos.push(P[3 * i], P[3 * i + 1], P[3 * i + 2], P[3 * j], P[3 * j + 1], P[3 * j + 2]);
      col.push(rgb[0], rgb[1], rgb[2], alpha, rgb[0], rgb[1], rgb[2], alpha);
    };
    const alive = [];
    for (const c of this.comets) {
      const t = (now - c.start) / c.life;
      if (t >= 1) continue;
      alive.push(c);
      if (t < 0) continue;
      if (this.layers[LAYER_OF_CATEGORY[c.category] ?? 'other'] === false) continue;
      if (!(c.from > 0) || !(c.to > 0) || c.from > this.n || c.to > this.n) continue;
      const rgb = CATEGORY_RGB[c.category] ?? CATEGORY_RGB[7];
      const fade = this.reduced ? 1 - t : t < 0.85 ? 1 : (1 - t) / 0.15;
      const alpha = (c.kind === 'dust' ? 0.25 : 0.7) * fade * (c.success ? 1 : 0.5);
      if (this.reduced || c.from === c.to) {
        push(c.from, c.to, rgb, alpha);
        continue;
      }
      // the head travels; the tail is the segment behind it, in world space
      const e = easeInOut(t);
      const tail = Math.min(0.5, 0.06 * (c.tail ?? 1) + 0.04) * (c.kind === 'dust' ? 0.5 : 1);
      const i = 3 * c.from;
      const j = 3 * c.to;
      const e0 = Math.max(0, e - tail);
      pos.push(P[i] + (P[j] - P[i]) * e0, P[i + 1] + (P[j + 1] - P[i + 1]) * e0, P[i + 2] + (P[j + 2] - P[i + 2]) * e0, P[i] + (P[j] - P[i]) * e, P[i + 1] + (P[j + 1] - P[i + 1]) * e, P[i + 2] + (P[j + 2] - P[i + 2]) * e);
      col.push(rgb[0], rgb[1], rgb[2], alpha * 0.4, 1, 1, 1, alpha);
    }
    this.comets = alive;
    const flashes = [];
    for (const f of this.flashes) {
      const t = (now - f.start) / f.life;
      if (t >= 1) continue;
      flashes.push(f);
      if (t < 0 || !(f.at > 0) || f.at > this.n) continue;
      if (this.layers[LAYER_OF_CATEGORY[f.category] ?? 'other'] === false) continue;
      const rgb = CATEGORY_RGB[f.category] ?? CATEGORY_RGB[7];
      const i = 3 * f.at;
      const r = (this.reduced ? 0.012 : 0.004 + 0.02 * t) * this.camera.distance;
      const alpha = 0.6 * (1 - t) * (f.success ? 1 : 0.5);
      pos.push(P[i] - r, P[i + 1], P[i + 2], P[i] + r, P[i + 1], P[i + 2], P[i], P[i + 1] - r, P[i + 2], P[i], P[i + 1] + r, P[i + 2]);
      for (let k = 0; k < 4; k++) col.push(rgb[0], rgb[1], rgb[2], alpha);
    }
    this.flashes = flashes;
    for (const pr of this.pairs) if (pr.a <= this.n && pr.b <= this.n) push(pr.a, pr.b, [0.78, 0.86, 1], 0.45);
    if (!pos.length) return;
    gl.useProgram(this.lines);
    this._uniforms(this.loc.l);
    this._attrib(this.buffers.linePos, this.loc.l.aPos, new Float32Array(pos), 3, true);
    this._attrib(this.buffers.lineColour, this.loc.l.aColour, new Float32Array(col), 4, true);
    gl.drawArrays(gl.LINES, 0, pos.length / 3);
  }

  drawOverlay(near, now) {
    const l = this.lctx;
    l.clearRect(0, 0, this.width, this.height);
    const s = this.screen;
    const a = this.attrs;
    if (!a) return;
    near.sort((p, q) => s.r[q] - s.r[p]);
    // rings and marks for the near bodies
    for (const id of near) {
      const x = s.x[id];
      const y = s.y[id];
      const r = s.r[id];
      const kind = KINDS[a.kind[id]] ?? 'planet';
      const rings = this.layers.trust ? Math.min(5, a.rings[id]) : 0;
      for (let k = 0; k < rings; k++) {
        const rr = r * (1.5 + 0.45 * k);
        l.strokeStyle = `rgba(158, 227, 125, ${(0.55 - 0.08 * k).toFixed(2)})`;
        l.lineWidth = 1;
        l.beginPath();
        l.ellipse(x, y, rr, rr * 0.38, 0.3, 0, Math.PI * 2);
        l.stroke();
      }
      if (kind === 'star') {
        const rgb = hslToRgb(a.hue[id], 0.7, 0.68);
        l.strokeStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.8)`;
        const L = r * 2.6;
        l.beginPath();
        l.moveTo(x - L, y);
        l.lineTo(x + L, y);
        l.moveTo(x, y - L);
        l.lineTo(x, y + L);
        l.stroke();
      }
      if (kind === 'pulsar') {
        const phase = this.reduced ? 0.5 : (Math.sin(now / 300) + 1) / 2;
        l.strokeStyle = `rgba(220, 232, 255, ${(0.35 + 0.5 * phase).toFixed(2)})`;
        const L = r * 3;
        l.beginPath();
        l.moveTo(x - L, y - L);
        l.lineTo(x + L, y + L);
        l.stroke();
      }
      if (!a.known[id]) {
        l.fillStyle = 'rgba(6, 10, 18, 0.85)';
        l.beginPath();
        l.arc(x, y, r * 0.62, 0, Math.PI * 2);
        l.fill();
      }
      if (id === this.focus || id === this.hover) {
        l.strokeStyle = 'rgba(232, 238, 251, 0.9)';
        l.lineWidth = 1.5;
        l.beginPath();
        l.arc(x, y, r + 5, 0, Math.PI * 2);
        l.stroke();
      }
    }
    const chosen = new Set(near.slice(0, 14));
    if (this.focus && s.depth[this.focus] > 0) chosen.add(this.focus);
    if (this.hover && s.depth[this.hover] > 0) chosen.add(this.hover);
    l.font = `500 10px ${MONO}`;
    l.textBaseline = 'middle';
    l.textAlign = 'left';
    for (const id of chosen) {
      const text = this.addresses[id] ? `${this.addresses[id].slice(0, 4)}…${this.addresses[id].slice(-4)}` : `#${id}`;
      const kind = KINDS[a.kind[id]];
      l.fillStyle = id === this.focus ? 'rgba(232, 238, 251, 1)' : 'rgba(183, 194, 217, 0.85)';
      l.fillText(kind && kind !== 'planet' ? `${text} · ${kind}` : text, s.x[id] + s.r[id] + 8, s.y[id]);
    }
    l.fillStyle = 'rgba(200, 220, 255, 0.8)';
    l.textAlign = 'center';
    for (const pr of this.pairs) {
      if (!(s.depth[pr.a] > 0) || !(s.depth[pr.b] > 0)) continue;
      l.fillText(pr.label.split(' · ')[0], (s.x[pr.a] + s.x[pr.b]) / 2, (s.y[pr.a] + s.y[pr.b]) / 2 - 8);
    }
  }

  stats() {
    const p = percentiles(this.frameTimes);
    const mean = this.frameTimes.length ? this.frameTimes.reduce((x, y) => x + y, 0) / this.frameTimes.length : null;
    return { renderer: 'webgl', frames: this.frames, sampled: this.frameTimes.length, meanMs: mean, ...p, maxMs: this.frameTimes.length ? Math.max(...this.frameTimes) : null, lod: this.lodCounts, planets: this.n, comets: this.comets.length, flashes: this.flashes.length, camera: { distance: this.camera.distance }, dpr: this.dpr, size: [this.width, this.height], gpu: this.gpuName() };
  }

  /** The renderer string, unmasked where the extension allows, so a software renderer (SwiftShader) is named as such. */
  gpuName() {
    const gl = this.gl;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  }
}

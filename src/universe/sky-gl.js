// UNIVERSE — the sky in WebGL, hand-written, the first renderer (docs/universe.md, decision 4).
//
// The same camera (a copy of src/projection.js until R1 lands) is evaluated
// in the vertex shader: every planet is one point sprite whose size is its
// body size over its depth, its colour from its hue, its glow from its
// activity; the fragment shader draws the plate's glow sprite (a white-hot
// core in the colour, a soft halo), additively. Comets are line segments
// rebuilt per frame; flashes are short crosses; nebulae are large soft
// points in the plate's nebula ink. Everything that is a mark or text (the
// ignitions, the ledger pulse, the kinds' marks, the cast rings, the
// labels) is the shared overlay's (src/universe/overlay.js), so the two
// renderers say the same things. No library: the shaders, the buffers and
// the camera are written here. src/universe/sky.js is the fallback the page
// takes when WebGL is unavailable.

import { project, referenceScale } from './projection.js';
import { SkyBase, CATEGORY_RGB, LAYER_OF_CATEGORY, BASE_PX, LOD, NEBULA_ZOOM } from './sky.js';

const NEBULA_HUE = 207; // the plate's nebula ink [40, 120, 190] as a hue
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const unit = ([r, g, b]) => [r / 255, g / 255, b / 255];

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
  // the plate's core sprite: white at the centre, the colour just outside it, a soft halo
  float white = smoothstep(core * 0.6, 0.0, d);
  float disc = smoothstep(core, core * 0.7, d);
  float glow = exp(-d * d * 3.5) * (0.35 + 0.5 * vGlow) * (1.0 - disc);
  float a = disc * 0.95 + glow;
  vec3 colour = mix(rgb, vec3(1.0), white * 0.95);
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

// screen-space primitives of the motion grammar: positions in CSS pixels, a colour per vertex
const FLAT_VS = `
attribute vec2 aPos;
attribute vec4 aColour;
attribute float aSize;
uniform vec2 uViewport;
uniform float uDpr;
varying vec4 vColour;
void main() {
  gl_Position = vec4(aPos.x / uViewport.x * 2.0 - 1.0, 1.0 - aPos.y / uViewport.y * 2.0, 0.0, 1.0);
  gl_PointSize = max(1.0, aSize * 2.0 * uDpr);
  vColour = aColour;
}`;

const FLAT_FS = `
precision mediump float;
varying vec4 vColour;
void main() { gl_FragColor = vec4(vColour.rgb * vColour.a, vColour.a); }`;

const DOT_FS = `
precision mediump float;
varying vec4 vColour;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = length(p);
  if (d > 1.0) discard;
  float a = vColour.a * smoothstep(1.0, 0.6, d);
  gl_FragColor = vec4(vColour.rgb * a, a);
}`;

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

export class SkyGL extends SkyBase {
  constructor(canvas, labels, opts = {}) {
    super(canvas, labels, opts);
    this.renderer = 'webgl';
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL is not available');
    this.gl = gl;
    this.glow = new Float32Array(1);
    this.points = program(gl, POINT_VS, POINT_FS);
    this.lines = program(gl, LINE_VS, LINE_FS);
    this.flat = program(gl, FLAT_VS, FLAT_FS);
    this.flatDots = program(gl, FLAT_VS, DOT_FS);
    this.flatBuffers = { pos: gl.createBuffer(), colour: gl.createBuffer(), size: gl.createBuffer() };
    this.flatLoc = {
      line: { aPos: gl.getAttribLocation(this.flat, 'aPos'), aColour: gl.getAttribLocation(this.flat, 'aColour'), aSize: gl.getAttribLocation(this.flat, 'aSize'), uViewport: gl.getUniformLocation(this.flat, 'uViewport'), uDpr: gl.getUniformLocation(this.flat, 'uDpr') },
      dot: { aPos: gl.getAttribLocation(this.flatDots, 'aPos'), aColour: gl.getAttribLocation(this.flatDots, 'aColour'), aSize: gl.getAttribLocation(this.flatDots, 'aSize'), uViewport: gl.getUniformLocation(this.flatDots, 'uViewport'), uDpr: gl.getUniformLocation(this.flatDots, 'uDpr') },
    };
    this.buffers = { pos: gl.createBuffer(), size: gl.createBuffer(), hue: gl.createBuffer(), glow: gl.createBuffer(), kind: gl.createBuffer(), linePos: gl.createBuffer(), lineColour: gl.createBuffer(), nebPos: gl.createBuffer(), nebSize: gl.createBuffer(), nebHue: gl.createBuffer(), nebGlow: gl.createBuffer(), nebKind: gl.createBuffer() };
    this.loc = {
      p: { aPos: gl.getAttribLocation(this.points, 'aPos'), aSize: gl.getAttribLocation(this.points, 'aSize'), aHue: gl.getAttribLocation(this.points, 'aHue'), aGlow: gl.getAttribLocation(this.points, 'aGlow'), aKind: gl.getAttribLocation(this.points, 'aKind'), uTarget: gl.getUniformLocation(this.points, 'uTarget'), uYaw: gl.getUniformLocation(this.points, 'uYaw'), uPitch: gl.getUniformLocation(this.points, 'uPitch'), uDistance: gl.getUniformLocation(this.points, 'uDistance'), uViewport: gl.getUniformLocation(this.points, 'uViewport'), uFocal: gl.getUniformLocation(this.points, 'uFocal'), uBasePx: gl.getUniformLocation(this.points, 'uBasePx'), uDpr: gl.getUniformLocation(this.points, 'uDpr') },
      l: { aPos: gl.getAttribLocation(this.lines, 'aPos'), aColour: gl.getAttribLocation(this.lines, 'aColour'), uTarget: gl.getUniformLocation(this.lines, 'uTarget'), uYaw: gl.getUniformLocation(this.lines, 'uYaw'), uPitch: gl.getUniformLocation(this.lines, 'uPitch'), uDistance: gl.getUniformLocation(this.lines, 'uDistance'), uViewport: gl.getUniformLocation(this.lines, 'uViewport'), uFocal: gl.getUniformLocation(this.lines, 'uFocal') },
    };
    this.positionsDirty = true;
    this.attrsDirty = true;
    this.hueF = new Float32Array(1);
    this.kindF = new Float32Array(1);
    this.resize();
  }

  grew(len) {
    this.glow = new Float32Array(len);
  }

  resized() {
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  /** The renderer string, unmasked where the extension allows, so a software renderer (SwiftShader) is named as such. */
  gpuName() {
    const gl = this.gl;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
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
    this.moveCamera();
    const cam = this.camera;
    const vp = { width: this.width, height: this.height };
    const ref = referenceScale(cam, vp);
    const a = this.attrs;
    const n = a ? Math.min(this.n, a.n) : 0;
    const phase = {};
    let tp = performance.now();
    const lap = (name) => {
      const t = performance.now();
      phase[name] = (phase[name] ?? 0) + (t - tp);
      tp = t;
    };
    gl.clearColor(6 / 255, 10 / 255, 18 / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // additive, premultiplied
    // the screen positions for hit tests, labels and comets (JavaScript, once per frame)
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
    lap('project');
    if (n > 0) {
      gl.useProgram(this.points);
      this._uniforms(this.loc.p);
      gl.uniform1f(this.loc.p.uBasePx, BASE_PX);
      gl.uniform1f(this.loc.p.uDpr, this.dpr);
      if (this.attrsDirty) {
        if (this.hueF.length < a.n + 1) {
          this.hueF = new Float32Array(a.n + 1);
          this.kindF = new Float32Array(a.n + 1);
        }
        this.hueF.set(a.hue);
        this.kindF.set(a.kind);
      }
      this._attrib(this.buffers.pos, this.loc.p.aPos, this.positions, 3, this.positionsDirty);
      this._attrib(this.buffers.size, this.loc.p.aSize, a.size, 1, this.attrsDirty);
      this._attrib(this.buffers.hue, this.loc.p.aHue, this.hueF, 1, this.attrsDirty);
      this._attrib(this.buffers.kind, this.loc.p.aKind, this.kindF, 1, this.attrsDirty);
      this._attrib(this.buffers.glow, this.loc.p.aGlow, this.glow, 1, true);
      this.positionsDirty = false;
      this.attrsDirty = false;
      gl.drawArrays(gl.POINTS, 1, n);
    }
    lap('points');
    // nebulae at far zoom as large soft points in the nebula ink
    const nebulae = this.projectNebulae(cam, vp);
    if (cam.distance >= NEBULA_ZOOM && this.nebulae.length) {
      const k = this.nebulae.length;
      const pos = new Float32Array(3 * k);
      const size = new Float32Array(k);
      const hue = new Float32Array(k).fill(NEBULA_HUE);
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
    lap('nebulae');
    this.drawLines(now);
    this.drawPrimitivesGL(this.livePrimitives(now, cam, vp));
    lap('comets');
    this.overlay(near, now, cam, vp, nebulae);
    lap('overlay');
    this.phase = phase;
    const ms = performance.now() - t0;
    this.record(ms, far, mid, near.length, culled);
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
      const rgb = unit(CATEGORY_RGB[c.category] ?? CATEGORY_RGB[CATEGORY_RGB.length - 1]);
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
      const rgb = unit(CATEGORY_RGB[f.category] ?? CATEGORY_RGB[CATEGORY_RGB.length - 1]);
      const i = 3 * f.at;
      const r = (this.reduced ? 0.012 : 0.004 + 0.02 * (1 - (1 - t) ** 2)) * this.camera.distance;
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

  /**
   * Lines, dots, rings and darts of the motion grammar in WebGL: lines and ring polylines as LINES, dots as point
   * sprites, darts as triangles, all in screen space through one flat program with a colour per vertex.
   */
  drawPrimitivesGL(p) {
    const gl = this.gl;
    const total = p.lines.length + p.dots.length + p.rings.length + p.darts.length;
    if (!total) return;
    const lp = [];
    const lc = [];
    const seg = (x0, y0, x1, y1, rgb, a) => {
      lp.push(x0, y0, x1, y1);
      lc.push(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, a, rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, a);
    };
    for (const l of p.lines) {
      if (l.dash) {
        // a dashed line as its dashes
        const len = Math.hypot(l.x1 - l.x0, l.y1 - l.y0) || 1;
        const on = l.dash[0];
        const off = l.dash[1] ?? on;
        for (let d = 0; d < len; d += on + off) {
          const u0 = d / len;
          const u1 = Math.min(1, (d + on) / len);
          seg(l.x0 + (l.x1 - l.x0) * u0, l.y0 + (l.y1 - l.y0) * u0, l.x0 + (l.x1 - l.x0) * u1, l.y0 + (l.y1 - l.y0) * u1, l.rgb, l.a);
        }
      } else {
        // width as parallel strands, since WebGL lines are one pixel
        const w = Math.max(1, Math.round(l.w ?? 1));
        const dx = l.x1 - l.x0;
        const dy = l.y1 - l.y0;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        for (let k = 0; k < w; k++) {
          const off = (k - (w - 1) / 2) * 0.9;
          seg(l.x0 + nx * off, l.y0 + ny * off, l.x1 + nx * off, l.y1 + ny * off, l.rgb, l.a / Math.sqrt(w));
        }
      }
    }
    for (const r of p.rings) {
      const segs = r.hex ? 6 : 28;
      const ry = r.r * (r.ry ?? 1);
      for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2;
        const a1 = ((i + 1) / segs) * Math.PI * 2;
        if (r.dash && i % 2) continue;
        seg(r.x + Math.cos(a0) * r.r, r.y + Math.sin(a0) * ry, r.x + Math.cos(a1) * r.r, r.y + Math.sin(a1) * ry, r.rgb, r.a * (r.soft ? 0.5 : 1));
      }
    }
    // darts as two triangles each, drawn as TRIANGLES in the same flat program
    const tp = [];
    const tc = [];
    for (const d of p.darts) {
      const c = Math.cos(d.angle);
      const sn = Math.sin(d.angle);
      const L = d.len;
      const W = Math.max(1.5, L * 0.28);
      const tip = [d.x + c * L, d.y + sn * L];
      const left = [d.x - sn * W, d.y + c * W];
      const back = [d.x - c * L * 0.6, d.y - sn * L * 0.6];
      const right = [d.x + sn * W, d.y - c * W];
      tp.push(...tip, ...left, ...back, ...tip, ...back, ...right);
      for (let k = 0; k < 6; k++) tc.push(d.rgb[0] / 255, d.rgb[1] / 255, d.rgb[2] / 255, d.a);
    }
    gl.useProgram(this.flat);
    gl.uniform2f(this.flatLoc.line.uViewport, this.width, this.height);
    gl.uniform1f(this.flatLoc.line.uDpr, this.dpr);
    if (lp.length) {
      this._attrib(this.flatBuffers.pos, this.flatLoc.line.aPos, new Float32Array(lp), 2, true);
      this._attrib(this.flatBuffers.colour, this.flatLoc.line.aColour, new Float32Array(lc), 4, true);
      gl.disableVertexAttribArray(this.flatLoc.line.aSize);
      gl.vertexAttrib1f(this.flatLoc.line.aSize, 1);
      gl.drawArrays(gl.LINES, 0, lp.length / 2);
    }
    if (tp.length) {
      this._attrib(this.flatBuffers.pos, this.flatLoc.line.aPos, new Float32Array(tp), 2, true);
      this._attrib(this.flatBuffers.colour, this.flatLoc.line.aColour, new Float32Array(tc), 4, true);
      gl.disableVertexAttribArray(this.flatLoc.line.aSize);
      gl.vertexAttrib1f(this.flatLoc.line.aSize, 1);
      gl.drawArrays(gl.TRIANGLES, 0, tp.length / 2);
    }
    if (p.dots.length) {
      const dp = new Float32Array(p.dots.length * 2);
      const dc = new Float32Array(p.dots.length * 4);
      const ds = new Float32Array(p.dots.length);
      p.dots.forEach((d, i) => {
        dp[2 * i] = d.x;
        dp[2 * i + 1] = d.y;
        dc[4 * i] = d.rgb[0] / 255;
        dc[4 * i + 1] = d.rgb[1] / 255;
        dc[4 * i + 2] = d.rgb[2] / 255;
        dc[4 * i + 3] = d.a;
        ds[i] = d.square ? d.r * 1.4 : d.core ? d.r * 1.8 : d.r;
      });
      gl.useProgram(this.flatDots);
      gl.uniform2f(this.flatLoc.dot.uViewport, this.width, this.height);
      gl.uniform1f(this.flatLoc.dot.uDpr, this.dpr);
      this._attrib(this.flatBuffers.pos, this.flatLoc.dot.aPos, dp, 2, true);
      this._attrib(this.flatBuffers.colour, this.flatLoc.dot.aColour, dc, 4, true);
      this._attrib(this.flatBuffers.size, this.flatLoc.dot.aSize, ds, 1, true);
      gl.drawArrays(gl.POINTS, 0, p.dots.length);
    }
  }

  /** The colour drawn at a CSS-pixel position, for the headless check that the shader's camera agrees with the JavaScript projection. */
  readPixel(x, y) {
    const gl = this.gl;
    const out = new Uint8Array(4);
    gl.readPixels(Math.round(x * this.dpr), Math.round(this.canvas.height - y * this.dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return [...out];
  }
}

// UNIVERSE spike — an incremental force layout that does not reshuffle the sky.
//
// Every planet has a home: a point in a ball of radius 1, derived from the
// hash of its address, so the same account always appears in the same place
// on first sight and nothing depends on arrival order. From there three
// forces act, but only on planets that are warm (touched within the last
// `warmLedgers` ledgers); a cold planet does not move, whatever pulls on it:
//
//   a spring along every edge toward the other end, stiffer with the log of
//   the edge's count, with a rest length that grows with the busier end's
//   degree, so a hub's counterparties settle on a shell around it rather
//   than on one point;
//   a weak spring back to the home, so a planet with no edges stays put and
//   a planet with few drifts only as far as its edges insist;
//   a repulsion from the crowd nearby, read off a spatial grid as the
//   aggregate of each of the 27 surrounding cells (its count and centroid),
//   so the cost is the same whether the neighbourhood holds two planets or
//   two thousand: a dense cluster cannot turn the step quadratic.
//
// Positions live in typed arrays the worker can transfer to the page in one
// message. `step()` returns how far planets that existed before the step
// moved, which is the stability the spike measures.
//
// Pure: no DOM, no network.

import { hashString } from '../mapping.js';

export const DEFAULTS = Object.freeze({ warmLedgers: 12, restLength: 0.06, edgeStiffness: 0.08, homeStiffness: 0.02, repelRadius: 0.05, repelStrength: 0.0025, damping: 0.72, maxStep: 0.012, radius: 1 });

const u32 = (s) => hashString(s) / 4294967296;

/** The rest length of an edge whose busier end has `degree` counterparties: the shell they share grows with the square root of their number, so they keep their spacing. */
export function restLengthFor(base, degree) {
  return base * (1 + 0.14 * Math.sqrt(Math.max(1, degree) - 1));
}

/** The home of an address: a point in the unit ball, uniform in volume, fixed by the address alone. */
export function homeOf(address, radius = DEFAULTS.radius) {
  const key = String(address ?? '');
  const u = u32(key);
  const v = u32(`${key}:v`);
  const w = u32(`${key}:w`);
  const z = 1 - 2 * u;
  const rxy = Math.sqrt(Math.max(0, 1 - z * z));
  const theta = 2 * Math.PI * v;
  const r = radius * Math.cbrt(0.15 + 0.85 * w); // never at the exact centre
  return [r * rxy * Math.cos(theta), r * z, r * rxy * Math.sin(theta)];
}

export class Layout {
  constructor(options = {}) {
    this.o = { ...DEFAULTS, ...options };
    this.capacity = Math.max(64, options.capacity ?? 1024);
    this.count = 0; // ids are 1-based and dense (the Universe's interner); slot = id
    this.pos = new Float32Array(3 * (this.capacity + 1));
    this.vel = new Float32Array(3 * (this.capacity + 1));
    this.home = new Float32Array(3 * (this.capacity + 1));
    this.lastTouched = new Int32Array(this.capacity + 1).fill(-1);
    this.present = new Uint8Array(this.capacity + 1);
    this.ea = [];
    this.eb = [];
    this.ew = [];
    this.er = []; // rest length per edge
    this.edgeIndex = new Map(); // key → index into ea/eb/ew/er
    this.adjacency = []; // id → array of edge indices
    this.ledger = 0;
    this.stepsRun = 0;
    // the grid: cells of repelRadius over the ball, with room to drift outside it
    this.span = 2 * this.o.radius + 0.6;
    this.g = Math.ceil(this.span / this.o.repelRadius);
    const cells = this.g ** 3;
    this.cellCount = new Int32Array(cells);
    this.cellSum = new Float64Array(3 * cells);
    this.cellOf = new Int32Array(this.capacity + 1);
  }

  _grow(id) {
    while (id > this.capacity) {
      const cap = this.capacity * 2;
      const grow = (arr, per, fill) => {
        const next = new arr.constructor(per * (cap + 1));
        if (fill != null) next.fill(fill);
        next.set(arr);
        return next;
      };
      this.pos = grow(this.pos, 3);
      this.vel = grow(this.vel, 3);
      this.home = grow(this.home, 3);
      this.lastTouched = grow(this.lastTouched, 1, -1);
      this.present = grow(this.present, 1);
      this.cellOf = grow(this.cellOf, 1);
      this.capacity = cap;
    }
  }

  /** Place a planet at its home. Idempotent. */
  add(id, address, ledger = this.ledger) {
    this._grow(id);
    if (this.present[id]) return false;
    const h = homeOf(address, this.o.radius);
    const i = 3 * id;
    this.home[i] = this.pos[i] = h[0];
    this.home[i + 1] = this.pos[i + 1] = h[1];
    this.home[i + 2] = this.pos[i + 2] = h[2];
    this.vel[i] = this.vel[i + 1] = this.vel[i + 2] = 0;
    this.present[id] = 1;
    this.lastTouched[id] = ledger;
    this.count = Math.max(this.count, id);
    return true;
  }

  has(id) {
    return id > 0 && id <= this.capacity && this.present[id] === 1;
  }

  /** Mark a planet warm at a ledger. */
  touch(id, ledger = this.ledger) {
    if (!this.has(id)) return;
    this.lastTouched[id] = Math.max(this.lastTouched[id], ledger);
  }

  /** Set an edge's weight (its count in the record) and, from the two degrees, its rest length; both ends must be present. */
  link(a, b, count = 1, degreeA = 1, degreeB = 1) {
    if (!this.has(a) || !this.has(b) || a === b) return;
    const key = a < b ? a * 4194304 + b : b * 4194304 + a;
    let i = this.edgeIndex.get(key);
    if (i == null) {
      i = this.ea.length;
      this.ea.push(Math.min(a, b));
      this.eb.push(Math.max(a, b));
      this.ew.push(0);
      this.er.push(this.o.restLength);
      this.edgeIndex.set(key, i);
      (this.adjacency[a] ??= []).push(i);
      (this.adjacency[b] ??= []).push(i);
    }
    this.ew[i] = Math.log2(1 + count);
    this.er[i] = restLengthFor(this.o.restLength, Math.max(degreeA, degreeB));
  }

  isWarm(id, ledger = this.ledger) {
    return this.has(id) && this.lastTouched[id] >= ledger - this.o.warmLedgers;
  }

  position(id) {
    const i = 3 * id;
    return [this.pos[i], this.pos[i + 1], this.pos[i + 2]];
  }

  _cellIndex(x, y, z) {
    const g = this.g;
    const cell = this.o.repelRadius;
    const half = this.span / 2;
    const cx = Math.min(g - 1, Math.max(0, Math.floor((x + half) / cell)));
    const cy = Math.min(g - 1, Math.max(0, Math.floor((y + half) / cell)));
    const cz = Math.min(g - 1, Math.max(0, Math.floor((z + half) / cell)));
    return (cx * g + cy) * g + cz;
  }

  /**
   * One relaxation step at `ledger`. Only warm planets move. Returns the
   * stability numbers: how many were warm, the mean and largest displacement
   * of the planets that were present before this ledger (in sky radii), the
   * share of them that moved more than `threshold`, how many crowd
   * aggregates were read, and the time it took.
   */
  step(ledger = this.ledger, { threshold = 0.005 } = {}) {
    const t0 = globalThis.performance?.now?.() ?? Date.now();
    this.ledger = Math.max(this.ledger, ledger);
    const o = this.o;
    const n = this.count;
    const pos = this.pos;
    const vel = this.vel;
    const home = this.home;
    // the warm set
    const warm = [];
    const warmMask = new Uint8Array(n + 1);
    for (let id = 1; id <= n; id++) {
      if (this.present[id] && this.lastTouched[id] >= this.ledger - o.warmLedgers) {
        warm.push(id);
        warmMask[id] = 1;
      }
    }
    if (!warm.length) {
      this.stepsRun += 1;
      return { warm: 0, measured: 0, moved: 0, maxMoved: 0, movedShare: 0, pairs: 0, ms: (globalThis.performance?.now?.() ?? Date.now()) - t0, planets: n };
    }
    const force = new Float32Array(3 * (n + 1));
    // edge springs: only edges with a warm end, applied to warm ends
    const seen = new Uint8Array(this.ea.length);
    for (const id of warm) {
      const adj = this.adjacency[id];
      if (!adj) continue;
      for (const ei of adj) {
        if (seen[ei]) continue;
        seen[ei] = 1;
        const a = this.ea[ei];
        const b = this.eb[ei];
        const ia = 3 * a;
        const ib = 3 * b;
        let dx = pos[ib] - pos[ia];
        let dy = pos[ib + 1] - pos[ia + 1];
        let dz = pos[ib + 2] - pos[ia + 2];
        let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 1e-6) {
          // coincident: push along the hash-derived home difference
          dx = home[ib] - home[ia] || 1e-3;
          dy = home[ib + 1] - home[ia + 1];
          dz = home[ib + 2] - home[ia + 2];
          d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-3;
        }
        const k = o.edgeStiffness * Math.min(4, this.ew[ei]);
        const f = k * (d - this.er[ei]);
        const fx = (f * dx) / d;
        const fy = (f * dy) / d;
        const fz = (f * dz) / d;
        if (warmMask[a]) {
          force[ia] += fx;
          force[ia + 1] += fy;
          force[ia + 2] += fz;
        }
        if (warmMask[b]) {
          force[ib] -= fx;
          force[ib + 1] -= fy;
          force[ib + 2] -= fz;
        }
      }
    }
    // the home spring
    for (const id of warm) {
      const i = 3 * id;
      force[i] += o.homeStiffness * (home[i] - pos[i]);
      force[i + 1] += o.homeStiffness * (home[i + 1] - pos[i + 1]);
      force[i + 2] += o.homeStiffness * (home[i + 2] - pos[i + 2]);
    }
    // the crowd: every present planet into its cell; each warm planet reads the 27 cells around it as aggregates
    const g = this.g;
    const cellCount = this.cellCount;
    const cellSum = this.cellSum;
    cellCount.fill(0);
    cellSum.fill(0);
    const cellOf = this.cellOf;
    for (let id = 1; id <= n; id++) {
      if (!this.present[id]) continue;
      const i = 3 * id;
      const c = this._cellIndex(pos[i], pos[i + 1], pos[i + 2]);
      cellOf[id] = c;
      cellCount[c] += 1;
      cellSum[3 * c] += pos[i];
      cellSum[3 * c + 1] += pos[i + 1];
      cellSum[3 * c + 2] += pos[i + 2];
    }
    const reach = o.repelRadius * 1.5;
    let pairs = 0;
    for (const id of warm) {
      const i = 3 * id;
      const c = cellOf[id];
      const cz = c % g;
      const cy = Math.floor(c / g) % g;
      const cx = Math.floor(c / (g * g));
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= g) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const y = cy + dy;
          if (y < 0 || y >= g) continue;
          for (let dz = -1; dz <= 1; dz++) {
            const z = cz + dz;
            if (z < 0 || z >= g) continue;
            const cc = (x * g + y) * g + z;
            let count = cellCount[cc];
            let sx = cellSum[3 * cc];
            let sy = cellSum[3 * cc + 1];
            let sz = cellSum[3 * cc + 2];
            if (cc === c) {
              // the planet's own cell, without itself
              count -= 1;
              sx -= pos[i];
              sy -= pos[i + 1];
              sz -= pos[i + 2];
            }
            if (count <= 0) continue;
            pairs += count;
            let ddx = pos[i] - sx / count;
            let ddy = pos[i + 1] - sy / count;
            let ddz = pos[i + 2] - sz / count;
            let d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
            if (d < 1e-5) {
              // on top of the crowd's centre: step off along the home direction
              ddx = home[i] - pos[i] || 1e-3;
              ddy = home[i + 1] - pos[i + 1];
              ddz = home[i + 2] - pos[i + 2];
              d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz) || 1e-3;
            }
            if (d >= reach) continue;
            const s = (o.repelStrength * Math.min(count, 64) * (1 - d / reach)) / d;
            force[i] += ddx * s;
            force[i + 1] += ddy * s;
            force[i + 2] += ddz * s;
          }
        }
      }
    }
    // integrate the warm planets; measure how far the ones that were here before this ledger moved
    let sum = 0;
    let max = 0;
    let movedCount = 0;
    let measured = 0;
    for (const id of warm) {
      const i = 3 * id;
      let vx = (vel[i] + force[i]) * o.damping;
      let vy = (vel[i + 1] + force[i + 1]) * o.damping;
      let vz = (vel[i + 2] + force[i + 2]) * o.damping;
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (sp > o.maxStep) {
        const s = o.maxStep / sp;
        vx *= s;
        vy *= s;
        vz *= s;
      }
      vel[i] = vx;
      vel[i + 1] = vy;
      vel[i + 2] = vz;
      pos[i] += vx;
      pos[i + 1] += vy;
      pos[i + 2] += vz;
      const moved = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (this.lastTouched[id] < this.ledger) {
        measured += 1;
        sum += moved;
        if (moved > max) max = moved;
        if (moved > threshold) movedCount += 1;
      }
    }
    this.stepsRun += 1;
    return { warm: warm.length, measured, moved: measured ? sum / measured : 0, maxMoved: max, movedShare: measured ? movedCount / measured : 0, pairs, ms: (globalThis.performance?.now?.() ?? Date.now()) - t0, planets: n };
  }

  /** A copy of the positions of ids 1..count as a transferable Float32Array (slot 0 unused). */
  snapshot() {
    return this.pos.slice(0, 3 * (this.count + 1));
  }
}

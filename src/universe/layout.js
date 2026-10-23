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

export const DEFAULTS = Object.freeze({ warmLedgers: 12, restLength: 0.06, edgeStiffness: 0.08, homeStiffness: 0.02, repelRadius: 0.06, repelStrength: 0.0025, damping: 0.72, maxStep: 0.012, radius: 2, discStiffness: 0.06, discBase: 0.045, discTwist: 1.6, shell: 1.8, coreStiffness: 0.3, coreRepel: 0.03, galaxyEdge: 0.25 });

const u32 = (s) => hashString(s) / 4294967296;

/** The rest length of an edge whose busier end has `degree` counterparties: the shell they share grows with the square root of their number, so they keep their spacing. */
export function restLengthFor(base, degree) {
  return base * (1 + 0.14 * Math.sqrt(Math.max(1, degree) - 1));
}

/**
 * The galactic disc of a core: a plane through it whose normal is fixed by
 * its address, with two unit vectors in the plane. A satellite of the core
 * sits on that plane at a radius that grows with its rank among the core's
 * satellites (the busiest nearest) and at an angle that turns with the
 * radius, so the disc reads as a spiral at far zoom (the owner's art
 * direction of 2026-10-23: the cosmos, with galaxies).
 */
export function discOf(address) {
  const key = String(address ?? '');
  const u = u32(`${key}:n1`);
  const v = u32(`${key}:n2`);
  const z = 1 - 2 * u;
  const rxy = Math.sqrt(Math.max(0, 1 - z * z));
  const theta = 2 * Math.PI * v;
  const n = [rxy * Math.cos(theta), z, rxy * Math.sin(theta)];
  // two vectors in the plane: n × up (or n × right when n is up)
  const up = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const a = [n[1] * up[2] - n[2] * up[1], n[2] * up[0] - n[0] * up[2], n[0] * up[1] - n[1] * up[0]];
  const la = Math.hypot(...a) || 1;
  const ua = a.map((x) => x / la);
  const b = [n[1] * ua[2] - n[2] * ua[1], n[2] * ua[0] - n[0] * ua[2], n[0] * ua[1] - n[1] * ua[0]];
  return { normal: n, u: ua, v: b };
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
    this.core = new Int32Array(this.capacity + 1); // the galaxy a planet belongs to: its core's id, 0 for none
    this.rank = new Float32Array(this.capacity + 1); // its rank among the core's satellites, the busiest 0
    this.discs = new Map(); // core id → { u, v, normal } (Float64 triples)
    this.promoted = new Uint8Array(this.capacity + 1); // 1 for a core that has moved out to the shell
    this.cores = []; // the promoted cores, in the order they were promoted
    this.addresses = [];
    this.ea = [];
    this.eb = [];
    this.ew = [];
    this.er = []; // rest length per edge
    this.edgeIndex = new Map(); // key → index into ea/eb/ew/er
    this.adjacency = []; // id → array of edge indices
    this.ledger = 0;
    this.stepsRun = 0;
    // the grid: cells of repelRadius over the ball, with room to drift outside it
    this.span = 2 * Math.max(this.o.shell, this.o.radius) + 1.2;
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
      this.core = grow(this.core, 1);
      this.rank = grow(this.rank, 1);
      this.promoted = grow(this.promoted, 1);
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
    this.addresses[id] = address;
    this.count = Math.max(this.count, id);
    return true;
  }

  /** Put a planet in a core's galaxy at a rank; core 0 takes it out. The core's disc is made on first use. */
  setCore(id, core, rank = 0) {
    if (!this.has(id)) return;
    this._grow(Math.max(id, core));
    this.core[id] = core > 0 && core !== id ? core : 0;
    this.rank[id] = rank;
    if (core > 0 && !this.discs.has(core)) this.discs.set(core, discOf(this.addresses[core] ?? String(core)));
  }

  /**
   * A planet that has become the core of a galaxy moves out, once, to the
   * galactic shell: its home goes to the shell's radius along its own home
   * direction and it is warmed so it travels there; its satellites follow
   * on the disc. The one time a sky reshuffles, and only for a new core
   * (the owner's art direction of 2026-10-23: galaxies stand apart).
   */
  promote(core, ledger = this.ledger) {
    if (!this.has(core) || this.discs.get(core)?.promoted) return false;
    const d = this.discs.get(core) ?? discOf(this.addresses[core] ?? String(core));
    d.promoted = true;
    this.discs.set(core, d);
    this.promoted[core] = 1;
    this.cores.push(core);
    const i = 3 * core;
    const len = Math.hypot(this.home[i], this.home[i + 1], this.home[i + 2]) || 1;
    const k = this.o.shell / len;
    this.home[i] *= k;
    this.home[i + 1] *= k;
    this.home[i + 2] *= k;
    this.lastTouched[core] = Math.max(this.lastTouched[core], ledger);
    return true;
  }

  /** The disc target of a satellite: on its core's plane, at a radius from its rank, turned with the radius. */
  discTarget(id) {
    const core = this.core[id];
    if (!core || !this.present[core]) return null;
    const d = this.discs.get(core);
    if (!d) return null;
    const o = this.o;
    const r = o.discBase * (0.6 + 0.55 * Math.sqrt(this.rank[id] + 1));
    const base = (hashString(this.addresses[id] ?? String(id)) / 4294967296) * Math.PI * 2;
    const ang = base + o.discTwist * r * 8;
    const c = 3 * core;
    return [this.pos[c] + (d.u[0] * Math.cos(ang) + d.v[0] * Math.sin(ang)) * r, this.pos[c + 1] + (d.u[1] * Math.cos(ang) + d.v[1] * Math.sin(ang)) * r, this.pos[c + 2] + (d.u[2] * Math.cos(ang) + d.v[2] * Math.sin(ang)) * r];
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
        // the disc holds a galaxy and the shell holds it apart: an edge between two galaxy members moves neither;
        // an edge between a galaxy member and a field star draws the field star, at a fraction, never the member
        const ga = this.core[a] || this.promoted[a];
        const gb = this.core[b] || this.promoted[b];
        if (ga && gb) continue;
        const k = o.edgeStiffness * Math.min(4, this.ew[ei]) * (ga || gb ? o.galaxyEdge : 1);
        const f = k * (d - this.er[ei]);
        const fx = (f * dx) / d;
        const fy = (f * dy) / d;
        const fz = (f * dz) / d;
        if (warmMask[a] && !ga) {
          force[ia] += fx;
          force[ia + 1] += fy;
          force[ia + 2] += fz;
        }
        if (warmMask[b] && !gb) {
          force[ib] -= fx;
          force[ib + 1] -= fy;
          force[ib + 2] -= fz;
        }
      }
    }
    // the home spring, or for a satellite the spring to its place on its core's disc, or for a promoted core the
    // radial spring that holds it on the galactic shell (its home, already on the shell, is a weak preference)
    for (const id of warm) {
      const i = 3 * id;
      const t = this.core[id] ? this.discTarget(id) : null;
      if (t) {
        force[i] += o.discStiffness * (t[0] - pos[i]);
        force[i + 1] += o.discStiffness * (t[1] - pos[i + 1]);
        force[i + 2] += o.discStiffness * (t[2] - pos[i + 2]);
      } else if (this.promoted[id]) {
        const len = Math.sqrt(pos[i] * pos[i] + pos[i + 1] * pos[i + 1] + pos[i + 2] * pos[i + 2]) || 1e-3;
        const radial = (o.coreStiffness * (o.shell - len)) / len;
        force[i] += radial * pos[i] + o.homeStiffness * (home[i] - pos[i]);
        force[i + 1] += radial * pos[i + 1] + o.homeStiffness * (home[i + 1] - pos[i + 1]);
        force[i + 2] += radial * pos[i + 2] + o.homeStiffness * (home[i + 2] - pos[i + 2]);
      } else {
        force[i] += o.homeStiffness * (home[i] - pos[i]);
        force[i + 1] += o.homeStiffness * (home[i + 1] - pos[i + 1]);
        force[i + 2] += o.homeStiffness * (home[i + 2] - pos[i + 2]);
      }
    }
    // galaxies keep their distance: two promoted cores closer than their discs allow push each other along the shell
    if (this.cores.length > 1) {
      const sats = new Int32Array(n + 1);
      for (let id = 1; id <= n; id++) if (this.present[id] && this.core[id]) sats[this.core[id]] += 1;
      const discR = (c) => o.discBase * (0.6 + 0.55 * Math.sqrt(sats[c]));
      // a push on a core, less its radial part: the shell holds the radius, the push slides the galaxy along it
      const tangent = (i, fx, fy, fz) => {
        const px = pos[i];
        const py = pos[i + 1];
        const pz = pos[i + 2];
        const dot = (fx * px + fy * py + fz * pz) / (px * px + py * py + pz * pz || 1e-6);
        force[i] += fx - dot * px;
        force[i + 1] += fy - dot * py;
        force[i + 2] += fz - dot * pz;
      };
      for (let x = 0; x < this.cores.length; x++) {
        const a = this.cores[x];
        if (!this.present[a]) continue;
        const ra = discR(a);
        for (let y = x + 1; y < this.cores.length; y++) {
          const b = this.cores[y];
          if (!this.present[b] || (!warmMask[a] && !warmMask[b])) continue;
          const ia = 3 * a;
          const ib = 3 * b;
          let dx = pos[ia] - pos[ib];
          let dy = pos[ia + 1] - pos[ib + 1];
          let dz = pos[ia + 2] - pos[ib + 2];
          let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < 1e-5) {
            dx = home[ia] - home[ib] || 1e-3;
            dy = home[ia + 1] - home[ib + 1];
            dz = home[ia + 2] - home[ib + 2];
            d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-3;
          }
          const minSep = 1.1 * (ra + discR(b)) + 0.08;
          if (d >= minSep) continue;
          const s = (o.coreRepel * (minSep - d)) / d;
          if (warmMask[a]) tangent(ia, dx * s, dy * s, dz * s);
          if (warmMask[b]) tangent(ib, -dx * s, -dy * s, -dz * s);
        }
      }
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

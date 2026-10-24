// UNIVERSE — an incremental layout that does not reshuffle the sky: a forest drawn at every scale.
//
// Every planet has a home: a point in a ball, derived from the hash of its
// address, so the same account always appears in the same place on first
// sight and nothing depends on arrival order. The ball grows with the cube
// root of the number of planets (`radius · ∛(1 + planets / massUnit)`), and
// a home is drawn once, inside the ball of the moment the planet was first
// seen: early planets stay inside while later ones arrive further out, so
// the middle never empties as the sky expands (the owner's art direction of
// 2026-10-23: fractal, not hollow).
//
// The worker gives every planet a parent (the busiest of its bigger
// counterparties; docs/universe.md, phase 2.5) and a rank among its
// siblings. The layout is the tree:
//
//   a child sits on its parent's disc, a plane through the parent whose
//   tilt is fixed by the parent's address, at a radius that grows with the
//   child's rank and an angle that turns with it: a spiral at every level;
//   a node's disc base is its parent's base times `discScale`; the slots
//   on a disc are packed, each child's orbit placed outside the previous
//   child's whole disc, so a busy child's cluster gets room and a disc
//   grows with its children's discs: self-similar and space-filling;
//   a root keeps a weak spring to its home; a galaxy root (a root the
//   worker marks, five or more descendants) also keeps every other galaxy
//   root at a distance of their two disc radii, a push in all three
//   dimensions, so where it is crowded the cosmos grows outward;
//   a root also feels a repulsion from the crowd nearby, read off a spatial
//   grid as the aggregate of each of the 27 surrounding cells, so the cost is
//   the same whether the neighbourhood holds two planets or two thousand;
//   a child does not (its slot is its place, at every scale, and the crowd's
//   reach would undo a disc smaller than itself). The grid coarsens with the
//   ball so a step costs the same at any size.
//
// Only warm planets move (touched within the last `warmLedgers` ledgers);
// a cold planet does not move, whatever pulls on it. The edge springs of
// phase 1 are gone: the tree places everything; `link()` still records the
// edges for anyone who asks the layout about them.
//
// Positions live in typed arrays the worker can transfer to the page in one
// message. `step()` returns how far planets that existed before the step
// moved, which is the stability the spike measured.
//
// Pure: no DOM, no network.

import { hashString } from '../mapping.js';

export const DEFAULTS = Object.freeze({
  warmLedgers: 12,
  homeStiffness: 0.02,
  repelRadius: 0.06,
  repelStrength: 0.0025,
  damping: 0.72,
  maxStep: 0.012,
  radius: 1.2, // the ball's radius at `massUnit` planets
  massUnit: 400,
  discStiffness: 0.06,
  discBase: 0.045, // a root's disc base; a child's is its parent's times discScale
  discTwist: 1.6,
  discScale: 0.35,
  slotGap: 0.6, // a child's orbit clears the previous child's disc and its own by this share of their radii
  galaxyChildren: 5,
  rootRepel: 0.03,
  gridCells: 96, // the crowd grid's cells per side at most; the cell grows with the ball
  restLength: 0.06, // kept for link(): the rest length an edge would have had
  edgeStiffness: 0.08,
});

const u32 = (s) => hashString(s) / 4294967296;

/** The rest length of an edge whose busier end has `degree` counterparties (kept for link(); the step no longer uses it). */
export function restLengthFor(base, degree) {
  return base * (1 + 0.14 * Math.sqrt(Math.max(1, degree) - 1));
}

/**
 * The disc of a node: a plane through it whose normal is fixed by its
 * address, with two unit vectors in the plane. Its children sit on that
 * plane at a radius that grows with their rank (the busiest nearest) and at
 * an angle that turns with the rank, so a disc reads as a spiral at every
 * level (the owner's art direction of 2026-10-23: the cosmos, fractal).
 */
export function discOf(address) {
  const key = String(address ?? '');
  const u = u32(`${key}:n1`);
  const v = u32(`${key}:n2`);
  const z = 1 - 2 * u;
  const rxy = Math.sqrt(Math.max(0, 1 - z * z));
  const theta = 2 * Math.PI * v;
  const n = [rxy * Math.cos(theta), z, rxy * Math.sin(theta)];
  const up = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const a = [n[1] * up[2] - n[2] * up[1], n[2] * up[0] - n[0] * up[2], n[0] * up[1] - n[1] * up[0]];
  const la = Math.hypot(...a) || 1;
  const ua = a.map((x) => x / la);
  const b = [n[1] * ua[2] - n[2] * ua[1], n[2] * ua[0] - n[0] * ua[2], n[0] * ua[1] - n[1] * ua[0]];
  return { normal: n, u: ua, v: b };
}

/** The home of an address: a point in a ball of `radius`, uniform in volume, fixed by the address alone. */
export function homeOf(address, radius = DEFAULTS.radius) {
  const key = String(address ?? '');
  const u = u32(key);
  const v = u32(`${key}:v`);
  const w = u32(`${key}:w`);
  const z = 1 - 2 * u;
  const rxy = Math.sqrt(Math.max(0, 1 - z * z));
  const theta = 2 * Math.PI * v;
  const r = radius * Math.cbrt(0.02 + 0.98 * w); // uniform in volume, never at the exact centre
  return [r * rxy * Math.cos(theta), r * z, r * rxy * Math.sin(theta)];
}

/** The ball's radius for a number of planets: the first `massUnit` fill a ball of `radius`; the density is kept from there. */
export function extentFor(count, { radius = DEFAULTS.radius, massUnit = DEFAULTS.massUnit } = {}) {
  return radius * Math.cbrt(1 + Math.max(0, count) / massUnit);
}

/** The slot factor of a rank: a child's radius on its parent's disc is the parent's base times this. */
export const slotFactor = (rank) => 0.6 + 0.55 * Math.sqrt(Math.max(0, rank) + 1);

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
    this.parent = new Int32Array(this.capacity + 1); // the node a planet sits around, 0 for a root
    this.rank = new Float32Array(this.capacity + 1); // its rank among its siblings, the busiest 0
    this.kids = new Int32Array(this.capacity + 1); // how many children a node has
    this.galaxyRoot = new Uint8Array(this.capacity + 1); // 1 for a root the worker marked a galaxy (five or more descendants)
    this.roots = []; // the galaxy roots, in the order they were marked
    this.discs = new Map(); // node id → { u, v, normal }
    this.childrenOf = new Map(); // node id → its children by rank (the worker's lists)
    this.baseCache = new Float32Array(this.capacity + 1);
    this.baseStamp = new Int32Array(this.capacity + 1).fill(-1);
    this.slotCache = new Float32Array(this.capacity + 1); // a child's packed slot radius on its parent's disc
    this.slotStamp = new Int32Array(this.capacity + 1).fill(-1);
    this.radiusCache = new Float32Array(this.capacity + 1); // a node's whole disc radius
    this.radiusStamp = new Int32Array(this.capacity + 1).fill(-1);
    this.addresses = [];
    this.ea = [];
    this.eb = [];
    this.ew = [];
    this.er = [];
    this.edgeIndex = new Map();
    this.adjacency = [];
    this.ledger = 0;
    this.stepsRun = 0;
    // the crowd grid: cells over the ball, rebuilt coarser when the ball outgrows it
    this.span = 0;
    this.cell = this.o.repelRadius;
    this.g = 1;
    this.cellOf = new Int32Array(this.capacity + 1);
    this._ensureGrid();
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
      this.parent = grow(this.parent, 1);
      this.rank = grow(this.rank, 1);
      this.kids = grow(this.kids, 1);
      this.galaxyRoot = grow(this.galaxyRoot, 1);
      this.baseCache = grow(this.baseCache, 1);
      this.baseStamp = grow(this.baseStamp, 1, -1);
      this.slotCache = grow(this.slotCache, 1);
      this.slotStamp = grow(this.slotStamp, 1, -1);
      this.radiusCache = grow(this.radiusCache, 1);
      this.radiusStamp = grow(this.radiusStamp, 1, -1);
      this.capacity = cap;
    }
  }

  /** The ball's radius now. */
  extent() {
    return extentFor(this.count, this.o);
  }

  /** The grid covers the ball with room to drift outside it; when the ball outgrows the grid, the grid is rebuilt coarser (at most gridCells a side). */
  _ensureGrid() {
    const need = 2 * (this.extent() + 0.8);
    if (need <= this.span) return;
    this.span = need * 1.25;
    this.cell = Math.max(this.o.repelRadius, this.span / this.o.gridCells);
    this.g = Math.ceil(this.span / this.cell);
    const cells = this.g ** 3;
    this.cellCount = new Int32Array(cells);
    this.cellSum = new Float64Array(3 * cells);
  }

  /** Place a planet at its home, drawn inside the ball of this moment. Idempotent. */
  add(id, address, ledger = this.ledger) {
    this._grow(id);
    if (this.present[id]) return false;
    this.count = Math.max(this.count, id);
    const h = homeOf(address, this.extent());
    const i = 3 * id;
    this.home[i] = this.pos[i] = h[0];
    this.home[i + 1] = this.pos[i + 1] = h[1];
    this.home[i + 2] = this.pos[i + 2] = h[2];
    this.vel[i] = this.vel[i + 1] = this.vel[i + 2] = 0;
    this.present[id] = 1;
    this.lastTouched[id] = ledger;
    this.addresses[id] = address;
    return true;
  }

  /** A planet's parent and its rank among the parent's children; parent 0 makes it a root. The parent's disc is made on first use. */
  setParent(id, parent, rank = 0) {
    if (!this.has(id)) return;
    this._grow(Math.max(id, parent));
    this.parent[id] = parent > 0 && parent !== id ? parent : 0;
    this.rank[id] = rank;
    if (parent > 0 && !this.discs.has(parent)) this.discs.set(parent, discOf(this.addresses[parent] ?? String(parent)));
  }

  /** How many children a node has (its disc's size). */
  setChildren(id, count) {
    if (!this.has(id)) return;
    this.kids[id] = Math.max(0, count | 0);
    if (count > 0 && !this.discs.has(id)) this.discs.set(id, discOf(this.addresses[id] ?? String(id)));
  }

  /** A node's children by rank, the busiest first: sets each child's parent and rank, the count, and the packing order. */
  setChildrenList(id, children) {
    if (!this.has(id)) return;
    const list = children.filter((c) => this.has(c) && c !== id);
    list.forEach((c, rank) => this.setParent(c, id, rank));
    this.setChildren(id, list.length);
    if (list.length) this.childrenOf.set(id, list);
    else this.childrenOf.delete(id);
  }

  /** A root the worker marks as a galaxy joins the roots that keep their distance (once; unmarking takes it out of the push). */
  setGalaxyRoot(id, on = true) {
    if (!this.has(id)) return;
    if (on && !this.galaxyRoot[id]) this.roots.push(id);
    this.galaxyRoot[id] = on ? 1 : 0;
  }

  /** The depth of a node in its tree (a root is 0), walking up at most 64 parents. */
  depthOf(id) {
    let d = 0;
    let p = this.parent[id];
    while (p > 0 && d < 64) {
      d += 1;
      p = this.parent[p];
    }
    return d;
  }

  /** The root of a node's tree. */
  topOf(id) {
    let n = id;
    let guard = 0;
    while (this.parent[n] > 0 && guard < 64) {
      n = this.parent[n];
      guard += 1;
    }
    return n;
  }

  /** A node's disc base: a root's is `discBase`; a child's is its parent's times `discScale` (self-similar). Cached per step. */
  discBaseOf(id) {
    if (this.baseStamp[id] === this.stepsRun) return this.baseCache[id];
    const p = this.parent[id];
    const base = p > 0 && this.present[p] ? this.discBaseOf(p) * this.o.discScale : this.o.discBase;
    this.baseStamp[id] = this.stepsRun;
    this.baseCache[id] = base;
    return base;
  }

  /**
   * The packed slots of a node's children: the first child at the base
   * times slotFactor(0); each next child's orbit at least the spiral's
   * step further out, and at least `slotGap` times the two neighbouring
   * discs' radii beyond the previous child's orbit, so a busy child's
   * cluster has room. Computed for all the node's children at once, cached
   * per step.
   */
  _packSlots(id) {
    const list = this.childrenOf.get(id);
    if (!list) return;
    const base = this.discBaseOf(id);
    let r = 0;
    let prevRadius = 0;
    for (let k = 0; k < list.length; k++) {
      const child = list[k];
      const own = this.discRadius(child);
      const spiral = base * (k === 0 ? slotFactor(0) : slotFactor(k) - slotFactor(k - 1));
      r = k === 0 ? spiral : r + Math.max(spiral, this.o.slotGap * (prevRadius + own));
      this.slotCache[child] = r;
      this.slotStamp[child] = this.stepsRun;
      prevRadius = own;
    }
  }

  /** A child's slot radius on its parent's disc (packed); the plain spiral slot when the parent's list is not known. */
  slotRadius(id) {
    if (this.slotStamp[id] === this.stepsRun) return this.slotCache[id];
    const p = this.parent[id];
    if (!p || !this.present[p]) return 0;
    if (this.childrenOf.has(p)) {
      this._packSlots(p);
      if (this.slotStamp[id] === this.stepsRun) return this.slotCache[id];
    }
    const r = this.discBaseOf(p) * slotFactor(this.rank[id]);
    this.slotCache[id] = r;
    this.slotStamp[id] = this.stepsRun;
    return r;
  }

  /** The radius of a node's whole disc: its last child's slot plus that child's disc; 0 for a node with no children. Cached per step. */
  discRadius(id) {
    if (this.radiusStamp[id] === this.stepsRun) return this.radiusCache[id];
    this.radiusStamp[id] = this.stepsRun;
    this.radiusCache[id] = 0; // a guard against a cycle while computing
    const kids = this.kids[id];
    let r = 0;
    if (kids > 0) {
      const list = this.childrenOf.get(id);
      const last = list ? list[list.length - 1] : 0;
      r = last ? this.slotRadius(last) + this.discRadius(last) : this.discBaseOf(id) * slotFactor(kids - 1);
    }
    this.radiusCache[id] = r;
    return r;
  }

  /** The target of a child: on its parent's disc, at its packed slot radius, turned with the rank. */
  discTarget(id) {
    const p = this.parent[id];
    if (!p || !this.present[p]) return null;
    const d = this.discs.get(p);
    if (!d) return null;
    const r = this.slotRadius(id);
    const base = u32(this.addresses[id] ?? String(id)) * Math.PI * 2;
    const ang = base + this.o.discTwist * 0.5 * Math.sqrt(this.rank[id] + 1);
    const c = 3 * p;
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    return [this.pos[c] + (d.u[0] * cos + d.v[0] * sin) * r, this.pos[c + 1] + (d.u[1] * cos + d.v[1] * sin) * r, this.pos[c + 2] + (d.u[2] * cos + d.v[2] * sin) * r];
  }

  has(id) {
    return id > 0 && id <= this.capacity && this.present[id] === 1;
  }

  /** Mark a planet warm at a ledger. */
  touch(id, ledger = this.ledger) {
    if (!this.has(id)) return;
    this.lastTouched[id] = Math.max(this.lastTouched[id], ledger);
  }

  /** Record an edge's weight (its count in the record) and rest length; both ends must be present. The step does not use edges; the tree places everything. */
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
    const cell = this.cell;
    const half = this.span / 2;
    const cx = Math.min(g - 1, Math.max(0, Math.floor((x + half) / cell)));
    const cy = Math.min(g - 1, Math.max(0, Math.floor((y + half) / cell)));
    const cz = Math.min(g - 1, Math.max(0, Math.floor((z + half) / cell)));
    return (cx * g + cy) * g + cz;
  }

  /**
   * One relaxation step at `ledger`. Only warm planets move. Returns the
   * stability numbers: how many were warm, the mean and largest displacement
   * of the planets that were present before this ledger (in sky units), the
   * share of them that moved more than `threshold`, how many crowd
   * aggregates were read, the ball's radius, and the time it took.
   */
  step(ledger = this.ledger, { threshold = 0.005 } = {}) {
    const t0 = globalThis.performance?.now?.() ?? Date.now();
    this.ledger = Math.max(this.ledger, ledger);
    this._ensureGrid();
    const o = this.o;
    const n = this.count;
    const pos = this.pos;
    const vel = this.vel;
    const home = this.home;
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
      return { warm: 0, measured: 0, moved: 0, maxMoved: 0, movedShare: 0, pairs: 0, extent: this.extent(), ms: (globalThis.performance?.now?.() ?? Date.now()) - t0, planets: n };
    }
    const force = new Float32Array(3 * (n + 1));
    // the tree: a child's spring to its place on its parent's disc; a root's weak spring home
    for (const id of warm) {
      const i = 3 * id;
      const t = this.parent[id] ? this.discTarget(id) : null;
      if (t) {
        force[i] += o.discStiffness * (t[0] - pos[i]);
        force[i + 1] += o.discStiffness * (t[1] - pos[i + 1]);
        force[i + 2] += o.discStiffness * (t[2] - pos[i + 2]);
      } else {
        force[i] += o.homeStiffness * (home[i] - pos[i]);
        force[i + 1] += o.homeStiffness * (home[i + 1] - pos[i + 1]);
        force[i + 2] += o.homeStiffness * (home[i + 2] - pos[i + 2]);
      }
    }
    // galaxies keep their distance: two galaxy roots closer than their discs allow push each other apart, in all three dimensions
    if (this.roots.length > 1) {
      const live = this.roots.filter((r) => this.present[r] && this.galaxyRoot[r] && !this.parent[r]);
      for (let x = 0; x < live.length; x++) {
        const a = live[x];
        const ra = this.discRadius(a);
        for (let y = x + 1; y < live.length; y++) {
          const b = live[y];
          if (!warmMask[a] && !warmMask[b]) continue;
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
          const minSep = 1.1 * (ra + this.discRadius(b)) + 0.05;
          if (d >= minSep) continue;
          const s = (o.rootRepel * (minSep - d)) / d;
          if (warmMask[a]) {
            force[ia] += dx * s;
            force[ia + 1] += dy * s;
            force[ia + 2] += dz * s;
          }
          if (warmMask[b]) {
            force[ib] -= dx * s;
            force[ib + 1] -= dy * s;
            force[ib + 2] -= dz * s;
          }
        }
      }
    }
    // the crowd: every present planet into its cell; each warm ROOT reads the 27 cells around it as aggregates (a child's
    // place is its slot on its parent's disc at every scale; the crowd's reach would undo a disc smaller than itself)
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
    const reach = this.cell * 1.5;
    let pairs = 0;
    for (const id of warm) {
      if (this.parent[id]) continue;
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
    return { warm: warm.length, measured, moved: measured ? sum / measured : 0, maxMoved: max, movedShare: measured ? movedCount / measured : 0, pairs, extent: this.extent(), ms: (globalThis.performance?.now?.() ?? Date.now()) - t0, planets: n };
  }

  /** A copy of the positions of ids 1..count as a transferable Float32Array (slot 0 unused). */
  snapshot() {
    return this.pos.slice(0, 3 * (this.count + 1));
  }
}

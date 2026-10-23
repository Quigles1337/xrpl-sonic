// UNIVERSE spike — one level of clustering: nebulae.
//
// A nebula is a connected group of planets at far zoom. The spike earns it
// with one rule: two planets are in the same cluster when a transaction has
// named them together at least `minEdge` times in the window and neither is
// a hub (a planet with more than `hubDegree` distinct counterparties, which
// would otherwise pull the whole sky into one cloud: an exchange or a
// market maker is a star of its own, not a nebula's glue). Clusters are
// kept with a union-find, which merges as edges arrive and never splits, so
// a planet that becomes a hub later keeps the unions it made before; that
// is a known limit of the spike, written in docs/universe.md.
//
// Pure: no DOM, no network.

export const DEFAULTS = Object.freeze({ minEdge: 2, hubDegree: 40, minSize: 5 });

export class Clusters {
  constructor(options = {}) {
    this.o = { ...DEFAULTS, ...options };
    this.parent = new Int32Array(1025);
    this.size = new Int32Array(1025);
    this.unions = 0;
    this.skippedHub = 0;
    this.count = 0;
  }

  _grow(id) {
    while (id >= this.parent.length) {
      const next = new Int32Array(this.parent.length * 2);
      next.set(this.parent);
      this.parent = next;
      const sizes = new Int32Array(this.size.length * 2);
      sizes.set(this.size);
      this.size = sizes;
    }
  }

  add(id) {
    this._grow(id);
    if (this.parent[id] === 0) {
      this.parent[id] = id;
      this.size[id] = 1;
      this.count = Math.max(this.count, id);
    }
  }

  find(id) {
    this._grow(id);
    if (this.parent[id] === 0) this.add(id);
    let root = id;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[id] !== root) {
      const next = this.parent[id];
      this.parent[id] = root;
      id = next;
    }
    return root;
  }

  /** An edge as the record has it now: unite when it is strong enough and neither end is a hub. */
  consider(a, b, count, degreeA, degreeB) {
    if (!a || !b || a === b || count < this.o.minEdge) return false;
    if (degreeA > this.o.hubDegree || degreeB > this.o.hubDegree) {
      this.skippedHub += 1;
      return false;
    }
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    if (this.size[ra] < this.size[rb]) {
      this.parent[ra] = rb;
      this.size[rb] += this.size[ra];
    } else {
      this.parent[rb] = ra;
      this.size[ra] += this.size[rb];
    }
    this.unions += 1;
    return true;
  }

  /** The clusters of at least `minSize` planets: { root, size, members }. */
  groups({ minSize = this.o.minSize } = {}) {
    const byRoot = new Map();
    for (let id = 1; id <= this.count; id++) {
      if (this.parent[id] === 0) continue;
      const r = this.find(id);
      if (this.size[r] < minSize) continue;
      let g = byRoot.get(r);
      if (!g) {
        g = { root: r, size: this.size[r], members: [] };
        byRoot.set(r, g);
      }
      g.members.push(id);
    }
    return [...byRoot.values()].sort((x, y) => y.size - x.size);
  }

  /**
   * The nebulae: each group with its centroid and rms radius over the
   * layout's positions, for drawing at far zoom.
   */
  nebulae(layout, { minSize = this.o.minSize } = {}) {
    return this.groups({ minSize }).map((g) => {
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (const id of g.members) {
        const [x, y, z] = layout.position(id);
        cx += x;
        cy += y;
        cz += z;
      }
      cx /= g.size;
      cy /= g.size;
      cz /= g.size;
      let rms = 0;
      for (const id of g.members) {
        const [x, y, z] = layout.position(id);
        rms += (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2;
      }
      return { root: g.root, size: g.size, x: cx, y: cy, z: cz, r: Math.sqrt(rms / g.size), members: g.members };
    });
  }
}

// UNIVERSE phase 2.5 — the forest: every planet's parent is the busiest of its bigger counterparties.
//
// Pure. Given the record's edges (each pair once with its count) and each
// planet's degree (how many counterparties it has), returns the tree the
// layout draws at every scale (docs/universe.md, phase 2.5): a planet's
// parent is, among its counterparties with more counterparties than it (a
// tie goes to the elder, the lower id, so a chain never loops), the one it
// dealt with most (ties again to the lower id); a planet with no bigger
// counterparty is a root. Children are ranked by count, the busiest first.
// Also the root of every node, its depth, and the size of every subtree.

/**
 * @param {{ edges: Iterable<{ a: number, b: number, count: number }>, degreeOf: (id: number) => number, present?: (id: number) => boolean, count: number }} input
 * @returns {{ parent: Int32Array, bestCount: Float64Array, children: Map<number, [number, number][]>, kids: Int32Array, rank: Float32Array, top: Int32Array, depth: Int32Array, subtree: Int32Array, roots: number[] }}
 */
export function forestOf({ edges, degreeOf, present = () => true, count }) {
  const n = Math.max(0, count | 0);
  const parent = new Int32Array(n + 1);
  const bestCount = new Float64Array(n + 1);
  for (const e of edges) {
    if (!e || !(e.a > 0) || !(e.b > 0) || e.a > n || e.b > n || e.a === e.b || !(e.count > 0)) continue;
    if (!present(e.a) || !present(e.b)) continue;
    const da = degreeOf(e.a);
    const db = degreeOf(e.b);
    const aElder = da > db || (da === db && e.a < e.b);
    const elder = aElder ? e.a : e.b;
    const younger = aElder ? e.b : e.a;
    if (e.count > bestCount[younger] || (e.count === bestCount[younger] && (parent[younger] === 0 || elder < parent[younger]))) {
      bestCount[younger] = e.count;
      parent[younger] = elder;
    }
  }
  const children = new Map();
  for (let id = 1; id <= n; id++) if (parent[id]) (children.get(parent[id]) ?? children.set(parent[id], []).get(parent[id])).push([id, bestCount[id]]);
  const kids = new Int32Array(n + 1);
  const rank = new Float32Array(n + 1);
  for (const [node, list] of children) {
    list.sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    list.forEach(([child], i) => (rank[child] = i));
    kids[node] = list.length;
  }
  // the root of every node and its depth, each chain walked once
  const top = new Int32Array(n + 1);
  const depth = new Int32Array(n + 1);
  for (let id = 1; id <= n; id++) {
    if (top[id] || !present(id)) continue;
    const path = [];
    let node = id;
    while (node && !top[node] && path.length < 64) {
      path.push(node);
      node = parent[node];
    }
    const known = node && top[node];
    const root = known ? top[node] : path.at(-1);
    let d = known ? depth[node] + 1 : 0;
    for (let k = path.length - 1; k >= 0; k--, d++) {
      top[path[k]] = root;
      depth[path[k]] = d;
    }
  }
  // subtree sizes: deepest first
  const subtree = new Int32Array(n + 1);
  const order = [];
  for (let id = 1; id <= n; id++) {
    if (!present(id)) continue;
    subtree[id] = 1;
    order.push(id);
  }
  order.sort((a, b) => depth[b] - depth[a]);
  for (const id of order) if (parent[id]) subtree[parent[id]] += subtree[id];
  const roots = order.filter((id) => !parent[id]);
  return { parent, bestCount, children, kids, rank, top, depth, subtree, roots };
}

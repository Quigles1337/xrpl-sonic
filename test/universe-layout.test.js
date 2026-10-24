// UNIVERSE: the layout is a forest drawn at every scale. Homes are fixed by
// the address inside the ball of their moment, cold planets never move, a
// child comes to its parent's disc, the disc base is self-similar and capped
// by the slot, galaxy roots keep their distance, the middle does not hollow,
// a step at twenty thousand nodes is under budget, and a step reports the
// stability numbers. The forest rule itself (src/universe/forest.js) and the
// clusters are tested beside it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Layout, homeOf, extentFor, slotFactor, DEFAULTS } from '../src/universe/layout.js';
import { forestOf } from '../src/universe/forest.js';
import { Clusters } from '../src/universe/cluster.js';

const addr = (i) => `r${String(i).padStart(24, 'A')}xyz`;
const gap = (l, a, b) => Math.hypot(...l.position(a).map((v, i) => v - l.position(b)[i]));
const dist = (p, q) => Math.hypot(...p.map((v, i) => v - q[i]));

describe('layout', () => {
  test('a home is the same for the same address, inside the ball, never at its centre', () => {
    const a = homeOf('rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah');
    assert.deepEqual(homeOf('rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah'), a);
    const r = Math.hypot(...a);
    assert.ok(r <= DEFAULTS.radius && r > 0, `${r}`);
    assert.notDeepEqual(homeOf('rKNRrawfVS59C3tN1bBiUWc5wZQAfUPh7z'), a);
  });

  test('the ball grows with the cube root of the count, from the radius at the mass unit', () => {
    assert.equal(extentFor(0), DEFAULTS.radius);
    assert.ok(Math.abs(extentFor(DEFAULTS.massUnit) - DEFAULTS.radius * Math.cbrt(2)) < 1e-9);
    assert.ok(Math.abs(extentFor(7 * DEFAULTS.massUnit) - 2 * DEFAULTS.radius) < 1e-9, 'eight times the mass, twice the radius');
  });

  test('adding is idempotent and places the planet at its home inside the ball of its moment; the arrays grow', () => {
    const l = new Layout({ capacity: 64 });
    assert.equal(l.add(1, addr(1), 10), true);
    assert.equal(l.add(1, addr(1), 10), false);
    assert.deepEqual(l.position(1), homeOf(addr(1), extentFor(1)).map((v) => Math.fround(v)));
    assert.equal(l.add(500, addr(500), 10), true);
    assert.ok(l.capacity >= 500);
    assert.equal(l.count, 500);
    assert.equal(l.snapshot().length, 3 * 501);
    assert.ok(Math.hypot(...l.position(500)) <= extentFor(500) + 1e-6, 'inside the ball of its moment');
  });

  test('cold planets do not move when a newcomer joins the disc; the newcomer travels to its slot', () => {
    const l = new Layout({ warmLedgers: 2 });
    for (let i = 1; i <= 50; i++) l.add(i, addr(i), 1);
    l.setChildrenList(1, Array.from({ length: 49 }, (_, k) => 2 + k));
    for (let k = 0; k < 10; k++) l.step(1);
    // ten ledgers later everyone is cold; a newcomer arrives as the last child of planet 1
    const before = l.snapshot();
    l.add(51, addr(51), 11);
    l.setChildrenList(1, Array.from({ length: 50 }, (_, k) => 2 + k));
    const d0 = dist(l.position(51), l.discTarget(51));
    let s;
    for (let k = 0; k < 150; k++) s = l.step(11);
    const after = l.snapshot();
    for (let i = 1; i <= 50; i++) for (let c = 0; c < 3; c++) assert.equal(after[3 * i + c], before[3 * i + c], `planet ${i} stayed`);
    const d1 = dist(l.position(51), l.discTarget(51));
    assert.ok(d1 < d0 * 0.5, `the newcomer came toward its slot: ${d0.toFixed(3)} → ${d1.toFixed(3)}`);
    assert.equal(s.warm, 1);
    assert.equal(s.measured, 0, 'a planet that arrived in this ledger is not in the stability population');
    s = l.step(12);
    assert.equal(s.measured, 1, 'from the next ledger on it is');
    assert.ok(s.moved >= 0 && s.maxMoved <= DEFAULTS.maxStep + 1e-6);
    assert.ok(Number.isFinite(s.ms) && s.extent > 0);
  });

  test('a child comes to its slot on the parent’s disc; a root with nothing stays near its home', () => {
    const l = new Layout();
    l.add(1, addr(1), 5);
    l.add(2, addr(2), 5);
    l.add(3, addr(3), 5);
    l.setChildrenList(1, [2]);
    for (let k = 0; k < 120; k++) l.step(5);
    const slot = DEFAULTS.discBase * slotFactor(0);
    assert.ok(Math.abs(gap(l, 1, 2) - slot) < 0.01, `the child sits at the first slot: ${gap(l, 1, 2).toFixed(3)} vs ${slot.toFixed(3)}`);
    assert.ok(dist(l.position(2), l.discTarget(2)) < 0.005, 'on its target');
    const home3 = homeOf(addr(3), extentFor(3));
    assert.ok(dist(l.position(3), home3) < 0.02, 'a root with nothing stays home');
  });

  test('the disc base is self-similar by the scale; the slots are packed so a busy child’s disc has room', () => {
    const l = new Layout();
    for (let i = 1; i <= 40; i++) l.add(i, addr(i), 1);
    // 1 is a root with 3 children (2, 3, 4); 2 has 30 children (5..34); 3 has 1 child (35)
    l.setChildrenList(1, [2, 3, 4]);
    l.setChildrenList(2, Array.from({ length: 30 }, (_, k) => 5 + k));
    l.setChildrenList(3, [35]);
    assert.equal(l.discBaseOf(1), DEFAULTS.discBase);
    assert.ok(Math.abs(l.discBaseOf(2) - DEFAULTS.discBase * DEFAULTS.discScale) < 1e-9, 'a child’s base is the parent’s times the scale');
    assert.ok(Math.abs(l.discBaseOf(35) - DEFAULTS.discBase * DEFAULTS.discScale ** 2) < 1e-9, 'and so on down');
    assert.ok(Math.abs(l.slotRadius(2) - DEFAULTS.discBase * slotFactor(0)) < 1e-9, 'the first child sits at the first spiral slot');
    const r2 = l.discRadius(2);
    assert.ok(r2 > 0);
    assert.ok(l.slotRadius(3) >= l.slotRadius(2) + DEFAULTS.slotGap * r2 - 1e-9, 'the next child’s orbit clears the busy child’s whole disc');
    assert.ok(l.slotRadius(4) > l.slotRadius(3), 'and the next is further out still');
    assert.ok(l.discRadius(1) >= l.slotRadius(4), 'the parent’s disc reaches its last child');
    assert.equal(l.depthOf(35), 2);
    assert.equal(l.topOf(35), 1);
    assert.equal(l.discRadius(4), 0, 'no children, no disc');
  });

  test('galaxy roots push each other apart, in three dimensions', () => {
    const l = new Layout();
    for (let i = 1; i <= 42; i++) l.add(i, addr(i), 1);
    l.setChildrenList(1, Array.from({ length: 20 }, (_, k) => 3 + k));
    l.setChildrenList(2, Array.from({ length: 20 }, (_, k) => 23 + k));
    l.setGalaxyRoot(1, true);
    l.setGalaxyRoot(2, true);
    // put the two roots almost on top of each other
    const p = l.position(1);
    l.pos.set([p[0] + 0.001, p[1], p[2] + 0.001], 6);
    const minSep = 1.1 * (l.discRadius(1) + l.discRadius(2)) + 0.05;
    for (let k = 0; k < 400; k++) {
      for (let i = 1; i <= 42; i++) l.touch(i, 1);
      l.step(1);
    }
    assert.ok(gap(l, 1, 2) >= minSep * 0.9, `${gap(l, 1, 2).toFixed(3)} ≥ ${(minSep * 0.9).toFixed(3)}`);
  });

  test('the middle does not hollow out as the sky grows: a fifth of the planets lie within half the ball', () => {
    const l = new Layout();
    const n = 3000;
    for (let i = 1; i <= n; i++) l.add(i, addr(i), 1);
    const R = l.extent();
    let inner = 0;
    for (let i = 1; i <= n; i++) if (Math.hypot(...l.position(i)) <= R / 2) inner += 1;
    assert.ok(inner / n >= 0.2, `${((100 * inner) / n).toFixed(1)}% within half the ball of radius ${R.toFixed(2)}`);
  });

  test('a step at twenty thousand nodes, all warm, is under budget', () => {
    const l = new Layout({ capacity: 4096 });
    const n = 20000;
    for (let i = 1; i <= n; i++) l.add(i, addr(i), 1);
    // 50 roots, each with 399 children
    for (let r = 0; r < 50; r++) {
      const root = r * 400 + 1;
      l.setChildrenList(root, Array.from({ length: 399 }, (_, k) => root + 1 + k));
      l.setGalaxyRoot(root, true);
    }
    l.step(1);
    let worst = 0;
    for (let k = 0; k < 3; k++) {
      const s = l.step(1);
      worst = Math.max(worst, s.ms);
    }
    assert.ok(worst < 150, `worst step ${worst.toFixed(1)} ms`);
  });

  test('a step with nobody warm costs nothing and reports zero', () => {
    const l = new Layout();
    l.add(1, addr(1), 1);
    const s = l.step(100);
    assert.deepEqual([s.warm, s.moved, s.movedShare], [0, 0, 0]);
  });
});

describe('the forest', () => {
  const degrees = new Map([
    [1, 5],
    [2, 3],
    [3, 3],
    [4, 1],
    [5, 1],
    [6, 2],
    [7, 1],
  ]);
  const edges = [
    { a: 1, b: 2, count: 10 },
    { a: 1, b: 3, count: 4 },
    { a: 2, b: 4, count: 2 },
    { a: 3, b: 4, count: 7 }, // 4 deals more with 3 than with 2
    { a: 2, b: 5, count: 1 },
    { a: 6, b: 7, count: 3 }, // a small tree of its own
    { a: 2, b: 3, count: 9 }, // equal degree: the elder (lower id) is the parent
  ];
  const f = forestOf({ edges, degreeOf: (id) => degrees.get(id) ?? 0, count: 7 });
  test('the parent is the busiest bigger counterparty; equal degree goes to the elder; no bigger counterparty makes a root', () => {
    assert.equal(f.parent[1], 0, '1 is the biggest: a root');
    assert.equal(f.parent[2], 1);
    assert.equal(f.parent[3], 2, '3 dealt most (9) with 2, its equal in degree and its elder');
    assert.equal(f.parent[4], 3, '4 dealt more with 3 than with 2');
    assert.equal(f.parent[5], 2);
    assert.equal(f.parent[6], 0);
    assert.equal(f.parent[7], 6);
    assert.deepEqual([...f.roots].sort(), [1, 6]);
  });
  test('children are ranked by count, the busiest first; depth, top and subtree sizes follow', () => {
    assert.deepEqual(
      f.children.get(2).map(([c]) => c),
      [3, 5],
    );
    assert.equal(f.rank[3], 0);
    assert.equal(f.rank[5], 1);
    assert.equal(f.kids[2], 2);
    assert.equal(f.depth[4], 3);
    assert.equal(f.top[4], 1);
    assert.equal(f.subtree[1], 5);
    assert.equal(f.subtree[6], 2);
    assert.equal(f.subtree[4], 1);
  });
  test('a chain never loops, whatever the edges', () => {
    const many = [];
    for (let i = 1; i <= 200; i++) for (let j = i + 1; j <= Math.min(200, i + 7); j++) many.push({ a: i, b: j, count: ((i * 7 + j * 13) % 5) + 1 });
    const deg = new Map();
    for (const e of many) {
      deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
      deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
    }
    const g = forestOf({ edges: many, degreeOf: (id) => deg.get(id) ?? 0, count: 200 });
    for (let id = 1; id <= 200; id++) {
      let node = id;
      let steps = 0;
      while (g.parent[node] && steps < 1000) {
        node = g.parent[node];
        steps += 1;
      }
      assert.ok(steps < 200, `no loop from ${id}`);
      assert.equal(g.top[id], node);
    }
  });
});

describe('clusters', () => {
  test('an edge unites at the minimum count, never through a hub, and the groups report size and centroid', () => {
    const c = new Clusters({ minEdge: 2, hubDegree: 3, minSize: 2 });
    for (let i = 1; i <= 8; i++) c.add(i);
    assert.equal(c.consider(1, 2, 1, 1, 1), false, 'one transaction is not a cluster');
    assert.equal(c.consider(1, 2, 2, 1, 1), true);
    assert.equal(c.consider(2, 3, 5, 2, 1), true);
    assert.equal(c.consider(4, 5, 9, 1, 40), false, 'a hub does not glue');
    assert.equal(c.skippedHub, 1);
    assert.equal(c.find(1), c.find(3));
    assert.notEqual(c.find(1), c.find(4));
    const groups = c.groups();
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].members.sort(), [1, 2, 3]);
    const l = new Layout();
    for (let i = 1; i <= 8; i++) l.add(i, addr(i), 1);
    const [n] = c.nebulae(l, { minSize: 3 });
    assert.equal(n.size, 3);
    const cx = (l.position(1)[0] + l.position(2)[0] + l.position(3)[0]) / 3;
    assert.ok(Math.abs(n.x - cx) < 1e-6);
    assert.ok(n.r > 0);
  });
});

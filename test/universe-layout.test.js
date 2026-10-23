// UNIVERSE spike: the incremental layout. Homes are fixed by the address,
// cold planets never move, warm linked planets come together, and a step
// reports the stability numbers.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Layout, homeOf, DEFAULTS } from '../src/universe/layout.js';
import { Clusters } from '../src/universe/cluster.js';

const addr = (i) => `r${String(i).padStart(24, 'A')}xyz`;

describe('layout', () => {
  test('a home is the same for the same address, inside the ball, never at its centre', () => {
    const a = homeOf('rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah');
    assert.deepEqual(homeOf('rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah'), a);
    const r = Math.hypot(...a);
    assert.ok(r <= 1 && r > 0.3, `${r}`);
    assert.notDeepEqual(homeOf('rKNRrawfVS59C3tN1bBiUWc5wZQAfUPh7z'), a);
  });

  test('adding is idempotent and places the planet at its home; the arrays grow', () => {
    const l = new Layout({ capacity: 64 });
    assert.equal(l.add(1, addr(1), 10), true);
    assert.equal(l.add(1, addr(1), 10), false);
    assert.deepEqual(l.position(1), homeOf(addr(1)).map((v) => Math.fround(v)));
    assert.equal(l.add(500, addr(500), 10), true);
    assert.ok(l.capacity >= 500);
    assert.equal(l.count, 500);
    assert.equal(l.snapshot().length, 3 * 501);
  });

  test('cold planets do not move when a newcomer is linked to them; the newcomer does', () => {
    const l = new Layout({ warmLedgers: 2 });
    for (let i = 1; i <= 50; i++) l.add(i, addr(i), 1);
    for (let i = 2; i <= 50; i++) l.link(1, i, 3);
    for (let k = 0; k < 10; k++) l.step(1);
    // ten ledgers later everyone is cold; a newcomer arrives linked to planet 1
    const before = l.snapshot();
    l.add(51, addr(51), 11);
    l.link(51, 1, 2);
    const d0 = Math.hypot(...l.position(51).map((v, i) => v - l.position(1)[i]));
    let s;
    for (let k = 0; k < 30; k++) s = l.step(11);
    const after = l.snapshot();
    for (let i = 1; i <= 50; i++) for (let c = 0; c < 3; c++) assert.equal(after[3 * i + c], before[3 * i + c], `planet ${i} stayed`);
    const d1 = Math.hypot(...l.position(51).map((v, i) => v - l.position(1)[i]));
    assert.ok(d1 < d0, `the newcomer came closer: ${d0.toFixed(3)} → ${d1.toFixed(3)}`);
    assert.equal(s.warm, 1);
    assert.equal(s.measured, 0, 'a planet that arrived in this ledger is not in the stability population');
    s = l.step(12);
    assert.equal(s.measured, 1, 'from the next ledger on it is');
    assert.ok(s.moved >= 0 && s.maxMoved <= DEFAULTS.maxStep + 1e-6);
    assert.ok(Number.isFinite(s.ms));
  });

  test('two warm linked planets come together and two unlinked ones stay near their homes', () => {
    const l = new Layout();
    l.add(1, addr(1), 5);
    l.add(2, addr(2), 5);
    l.add(3, addr(3), 5);
    l.link(1, 2, 8);
    const gap = (a, b) => Math.hypot(...l.position(a).map((v, i) => v - l.position(b)[i]));
    const g0 = gap(1, 2);
    for (let k = 0; k < 80; k++) l.step(5);
    assert.ok(gap(1, 2) < g0 * 0.6, `${g0.toFixed(3)} → ${gap(1, 2).toFixed(3)}`);
    const home3 = homeOf(addr(3));
    assert.ok(Math.hypot(...l.position(3).map((v, i) => v - home3[i])) < 0.02, 'an unlinked planet stays home');
  });

  test('a step with nobody warm costs nothing and reports zero', () => {
    const l = new Layout();
    l.add(1, addr(1), 1);
    const s = l.step(100);
    assert.deepEqual([s.warm, s.moved, s.movedShare], [0, 0, 0]);
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

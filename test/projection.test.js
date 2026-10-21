import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CAMERA, project, toCamera, focal, referenceScale, ringPoints, ringPoint, clampCamera } from '../src/projection.js';

const vp = { width: 800, height: 600 };
const flat = { yaw: 0, pitch: 0, distance: 2, fov: 1, target: [0, 0, 0] };

describe('projection', () => {
  test('the target lands at the centre with the reference scale', () => {
    const p = project([0, 0, 0], flat, vp);
    assert.equal(p.x, 400);
    assert.equal(p.y, 300);
    assert.ok(Math.abs(p.scale - referenceScale(flat, vp)) < 1e-9);
    assert.ok(Math.abs(p.depth - 2) < 1e-9);
    assert.ok(Math.abs(focal(flat, vp) - 300 / Math.tan(0.5)) < 1e-9);
  });

  test('right is right, up is up, far is smaller', () => {
    const r = project([0.5, 0, 0], flat, vp);
    const u = project([0, 0.5, 0], flat, vp);
    const far = project([0, 0, 1], flat, vp);
    assert.ok(r.x > 400 && Math.abs(r.y - 300) < 1e-9);
    assert.ok(u.y < 300 && Math.abs(u.x - 400) < 1e-9);
    assert.ok(far.scale < r.scale && far.depth > r.depth);
  });

  test('looking down from above puts far points higher on the screen', () => {
    const cam = { ...flat, pitch: 0.4 };
    const near = project([0, 0, -0.5], cam, vp);
    const far = project([0, 0, 0.5], cam, vp);
    assert.ok(far.y < near.y, 'far point is higher (smaller y)');
  });

  test('yaw turns x into depth', () => {
    const cam = { ...flat, yaw: Math.PI / 2 };
    const [x, , depth] = toCamera([1, 0, 0], cam);
    assert.ok(Math.abs(x) < 1e-9);
    assert.ok(Math.abs(depth - 3) < 1e-9, 'a point on +x is now one unit further than the target');
  });

  test('points at or behind the camera project to null', () => {
    assert.equal(project([0, 0, -2], flat, vp), null);
    assert.equal(project([0, 0, -5], flat, vp), null);
    assert.ok(project([0, 0, -1.9], flat, vp));
  });

  test('DEFAULT_CAMERA is frozen and sensible', () => {
    assert.ok(Object.isFrozen(DEFAULT_CAMERA));
    assert.ok(DEFAULT_CAMERA.distance > 1 && DEFAULT_CAMERA.pitch > 0);
  });
});

describe('rings and limits', () => {
  test('ring points sit at the radius on a tilted, turned plane', () => {
    const pts = ringPoints([1, 2, 3], 0.5, { tilt: 0.3, turn: 0.7, segments: 12 });
    assert.equal(pts.length, 12);
    for (const [x, y, z] of pts) assert.ok(Math.abs(Math.hypot(x - 1, y - 2, z - 3) - 0.5) < 1e-9);
    const flatRing = ringPoints([0, 0, 0], 1, { segments: 4 });
    assert.ok(flatRing.every(([, y]) => Math.abs(y) < 1e-12), 'untilted ring lies in the xz plane');
    const tilted = ringPoints([0, 0, 0], 1, { tilt: Math.PI / 2, segments: 4 });
    assert.ok(tilted.some(([, y]) => Math.abs(y) > 0.5), 'a tilted ring leaves the plane');
    assert.deepEqual(ringPoint([0, 0, 0], 1, 0), [1, 0, 0]);
  });

  test('clampCamera keeps yaw, pitch and distance inside the limits', () => {
    const c = clampCamera({ yaw: 9, pitch: -1, distance: 100 }, { yaw: [-1, 1], pitch: [0.1, 0.9], distance: [2, 4] });
    assert.deepEqual(c, { yaw: 1, pitch: 0.1, distance: 4 });
    assert.equal(clampCamera({ yaw: 0.2, pitch: 0.3, distance: 3 }).yaw, 0.2);
  });
});

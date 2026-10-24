// UNIVERSE phase 2.5 — the fly camera's arithmetic: axes, the eye, entering and leaving flight, the move, the dive.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FLY, FLY_LIMITS, axesOf, eyeOf, enterFly, leaveFly, aheadOf, slowFactor, flyStep, anglesToward, diveGlide, glideCamera, flyCameraAt } from '../src/universe/flycam.js';
import { toCamera, referenceScale, focal } from '../src/universe/projection.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const nearV = (p, q, eps = 1e-6) => p.every((v, i) => near(v, q[i], eps));
const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const len = (p) => Math.hypot(...p);
const cam0 = { yaw: 0.35, pitch: 0.28, distance: 5.2, fov: 1.0, target: [0, 0, 0] };

describe('the fly camera', () => {
  test('the axes are orthonormal and forward is the view: a point ahead of the eye projects to the centre with positive depth', () => {
    const a = axesOf(cam0);
    for (const v of Object.values(a)) assert.ok(near(len(v), 1));
    assert.ok(near(dot(a.forward, a.right), 0) && near(dot(a.forward, a.up), 0) && near(dot(a.right, a.up), 0));
    const eye = eyeOf(cam0);
    const ahead = eye.map((v, i) => v + a.forward[i] * 2);
    const [cx, cy, depth] = toCamera(ahead, cam0);
    assert.ok(near(cx, 0, 1e-5) && near(cy, 0, 1e-5), 'on the axis');
    assert.ok(near(depth, 2, 1e-5), 'two ahead of the eye');
  });
  test('the eye is the target less the distance along the view; the target itself sits at depth = distance', () => {
    const eye = eyeOf(cam0);
    assert.ok(near(len(eye), 5.2, 1e-6));
    assert.ok(near(toCamera(eye, cam0)[2], 0, 1e-6), 'the eye is at depth zero');
    assert.ok(near(toCamera(cam0.target, cam0)[2], 5.2, 1e-9));
  });
  test('entering flight keeps the eye where it was and holds the size reference at the home scale', () => {
    const f = enterFly(cam0);
    assert.ok(nearV(eyeOf(f), eyeOf(cam0), 1e-5));
    assert.equal(f.distance, FLY.eyeDistance);
    assert.equal(f.sizeDistance, FLY.sizeDistance);
    const vp = { width: 1000, height: 800 };
    assert.ok(near(referenceScale(f, vp), focal(f, vp) / FLY.sizeDistance), 'sizes are referenced to sizeDistance, not the eye');
    assert.ok(referenceScale(f, vp) < referenceScale({ ...f, sizeDistance: undefined }, vp), 'without it everything would be enormous');
  });
  test('leaving flight orbits the point given at the leave distance and drops the size reference', () => {
    const f = enterFly(cam0);
    const o = leaveFly(f, aheadOf(f));
    assert.equal(o.distance, FLY.leaveDistance);
    assert.equal('sizeDistance' in o, false);
    assert.ok(nearV(o.target, aheadOf(f)));
  });
  test('the move goes along the axes by the step; forward then back returns', () => {
    const f = enterFly(cam0);
    const a = axesOf(f);
    const g = flyStep(f, { forward: 1 }, 0.5);
    assert.ok(nearV(eyeOf(g), eyeOf(f).map((v, i) => v + a.forward[i] * 0.5), 1e-5));
    const h = flyStep(flyStep(g, { forward: -1 }, 0.5), { strafe: 1, up: -1 }, 0.1);
    assert.ok(nearV(eyeOf(h), eyeOf(f).map((v, i) => v + (a.right[i] - a.up[i]) * 0.1), 1e-5));
  });
  test('the slowing: full speed at the slow-within distance and beyond, a tenth at most beside a planet', () => {
    assert.equal(slowFactor(Infinity), 1);
    assert.equal(slowFactor(FLY.slowWithin), 1);
    assert.equal(slowFactor(FLY.slowWithin * 2), 1);
    assert.ok(near(slowFactor(FLY.slowWithin / 2), 0.5));
    assert.equal(slowFactor(0), 0.1);
  });
  test('the angles toward a direction look along it, pitch within the limits', () => {
    for (const d of [
      [1, 0, 0],
      [0, 0, -1],
      [0.3, -0.5, 0.8],
      [0, 1, 0],
    ]) {
      const { yaw, pitch } = anglesToward(d);
      const f = axesOf({ yaw, pitch }).forward;
      const u = d.map((v) => v / len(d));
      if (Math.abs(u[1]) < 0.99) assert.ok(nearV(f, u, 1e-6), `looks along ${d}`);
      assert.ok(pitch >= FLY_LIMITS.pitch[0] && pitch <= FLY_LIMITS.pitch[1]);
    }
  });
  test('the dive ends a dozen radii from the planet on the side the eye came from, facing it; reduced motion arrives at once', () => {
    const f = enterFly(cam0);
    const planet = [0.4, -0.2, 0.9];
    const g = diveGlide(f, planet, 1000);
    assert.equal(g.ms, FLY.glideMs);
    const mid = glideCamera(f, g, 1000 + FLY.glideMs / 2);
    assert.equal(mid.done, false);
    const end = glideCamera(f, g, 1000 + FLY.glideMs);
    assert.equal(end.done, true);
    const eye = eyeOf(end.camera);
    assert.ok(near(len(eye.map((v, i) => v - planet[i])), FLY.diveDistance, 1e-4), 'at the dive distance');
    const from = eyeOf(f);
    const came = from.map((v, i) => v - planet[i]);
    const at = eye.map((v, i) => v - planet[i]);
    assert.ok(dot(came, at) / (len(came) * len(at)) > 0.999, 'on the side it came from');
    const fwd = axesOf(end.camera).forward;
    const toPlanet = planet.map((v, i) => v - eye[i]);
    assert.ok(dot(fwd, toPlanet) / len(toPlanet) > 0.999, 'facing it');
    assert.equal(end.camera.sizeDistance, FLY.sizeDistance);
    const r = diveGlide(f, planet, 5, { reduced: true });
    const at0 = glideCamera(f, r, 5);
    assert.equal(at0.done, true, 'reduced motion: there at once');
    assert.ok(nearV(eyeOf(at0.camera), eye, 1e-5));
  });
  test('a dive from a camera sitting on the planet backs off along the view', () => {
    const f = flyCameraAt(cam0, [0.4, -0.2, 0.9]);
    const g = diveGlide(f, [0.4, -0.2, 0.9], 0, { reduced: true });
    const end = glideCamera(f, g, 0).camera;
    assert.ok(near(len(eyeOf(end).map((v, i) => v - [0.4, -0.2, 0.9][i])), FLY.diveDistance, 1e-4));
  });
});

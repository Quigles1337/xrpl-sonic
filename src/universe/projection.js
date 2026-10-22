// UNIVERSE spike — a verbatim copy of src/projection.js (pure), so the spike
// has a camera without editing a shared module. docs/universe-requests.md asks
// for the one addition the sky needs (a view matrix for a WebGL path); until
// then this copy is the camera of universe.html only.
//
// xrpl-sonic — a small perspective camera for the plate and the constellation.
//
// World space: x to the right, y up, z away from the viewer. The camera looks
// at `target` from `distance` along a direction set by `yaw` (around y) and
// `pitch` (positive looks down from above). Points are projected onto a
// viewport in CSS pixels; `scale` is pixels per world unit at that depth, so
// a sprite drawn with it shrinks with distance. No WebGL, no dependencies:
// everything is drawn with the 2D canvas at projected positions.
//
// Pure.

export const DEFAULT_CAMERA = Object.freeze({ yaw: 0, pitch: 0.32, distance: 2.6, fov: 1.05, target: Object.freeze([0, 0.25, 0.5]) });

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Focal length in pixels for a viewport and a vertical field of view. */
export function focal(camera, viewport) {
  return viewport.height / 2 / Math.tan((camera.fov ?? DEFAULT_CAMERA.fov) / 2);
}

/** World point → camera space [x, y, depth]; depth is the distance along the view axis. */
export function toCamera([x, y, z], camera) {
  const t = camera.target ?? DEFAULT_CAMERA.target;
  const tx = x - t[0];
  const ty = y - t[1];
  const tz = z - t[2];
  const cy = Math.cos(camera.yaw ?? 0);
  const sy = Math.sin(camera.yaw ?? 0);
  const x1 = tx * cy - tz * sy;
  const z1 = tx * sy + tz * cy;
  const cp = Math.cos(camera.pitch ?? 0);
  const sp = Math.sin(camera.pitch ?? 0);
  const y2 = ty * cp + z1 * sp;
  const z2 = -ty * sp + z1 * cp;
  return [x1, y2, z2 + (camera.distance ?? DEFAULT_CAMERA.distance)];
}

/**
 * Project a world point. Returns { x, y, scale, depth } in viewport pixels, or
 * null when the point is at or behind the camera.
 */
export function project(point, camera, viewport) {
  const [cx, cy, depth] = toCamera(point, camera);
  if (!(depth > 0.05)) return null;
  const f = focal(camera, viewport);
  const scale = f / depth;
  return { x: viewport.width / 2 + cx * scale, y: viewport.height / 2 - cy * scale, scale, depth };
}

/** Pixels per world unit at the target's depth: the reference size for sprites. */
export function referenceScale(camera, viewport) {
  return focal(camera, viewport) / (camera.distance ?? DEFAULT_CAMERA.distance);
}

/**
 * Points of a ring of `radius` around `centre`, lying in a plane tilted by
 * `tilt` radians around the x axis and then turned by `turn` radians around
 * the y axis (so every currency can have its own orbit). `segments` points.
 */
export function ringPoints(centre, radius, { tilt = 0, turn = 0, segments = 64, phase = 0 } = {}) {
  const out = [];
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  const cu = Math.cos(turn);
  const su = Math.sin(turn);
  for (let i = 0; i < segments; i++) {
    const a = phase + (i / segments) * Math.PI * 2;
    const x0 = Math.cos(a) * radius;
    const z0 = Math.sin(a) * radius;
    // tilt around x: y = -z0·sin, z = z0·cos
    const y1 = -z0 * st;
    const z1 = z0 * ct;
    // turn around y
    const x2 = x0 * cu - z1 * su;
    const z2 = x0 * su + z1 * cu;
    out.push([centre[0] + x2, centre[1] + y1, centre[2] + z2]);
  }
  return out;
}

/** One point on such a ring at angle `a` (for beads that travel along orbits). */
export function ringPoint(centre, radius, a, { tilt = 0, turn = 0 } = {}) {
  return ringPoints(centre, radius, { tilt, turn, segments: 1, phase: a })[0];
}

/** Keep a camera within sensible limits (used by drag-to-orbit). */
export function clampCamera(camera, { yaw = [-Math.PI, Math.PI], pitch = [0.02, 1.2], distance = [1.2, 6] } = {}) {
  return { ...camera, yaw: clamp(camera.yaw, yaw[0], yaw[1]), pitch: clamp(camera.pitch, pitch[0], pitch[1]), distance: clamp(camera.distance, distance[0], distance[1]) };
}

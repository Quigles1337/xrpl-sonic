// UNIVERSE phase 2.5 — the fly camera's arithmetic, pure.
//
// The sky's camera looks at `target` from `distance` along a view set by
// `yaw` and `pitch` (src/universe/projection.js). Flying, the camera is an
// eye: the target sits FLY.eyeDistance ahead of the eye so the eye is, for
// every purpose, at the target, and sizes are referenced to
// FLY.sizeDistance instead of the eye's distance, so planets keep their
// perspective size when the eye is among them. The dive takes the eye to
// FLY.diveDistance from a planet on the side it came from, facing it, over
// FLY.glideMs (at once under reduced motion). No DOM: the sky calls these.

export const FLY = Object.freeze({ eyeDistance: 0.02, sizeDistance: 1.4, speed: 0.5, diveDistance: 0.12, glideMs: 600, slowWithin: 0.3, leaveDistance: 0.9 });
export const FLY_LIMITS = Object.freeze({ yaw: [-Infinity, Infinity], pitch: [-1.5, 1.5], distance: [FLY.eyeDistance, FLY.eyeDistance] });

/** The camera's axes in world space: forward (the view), right, up. The inverse of the projection's yaw-then-pitch rotation applied to the camera's axes. */
export function axesOf(camera) {
  const cy = Math.cos(camera.yaw ?? 0);
  const sy = Math.sin(camera.yaw ?? 0);
  const cp = Math.cos(camera.pitch ?? 0);
  const sp = Math.sin(camera.pitch ?? 0);
  return { forward: [cp * sy, -sp, cp * cy], right: [cy, 0, -sy], up: [sp * sy, cp, sp * cy] };
}

/** Where the eye is: the target, less the distance along the view. */
export function eyeOf(camera) {
  const { forward } = axesOf(camera);
  const t = camera.target;
  const d = camera.distance;
  return [t[0] - forward[0] * d, t[1] - forward[1] * d, t[2] - forward[2] * d];
}

/** The camera whose eye is at `eye` looking along `yaw`/`pitch`, in the flying form. */
export function flyCameraAt(camera, eye, yaw = camera.yaw, pitch = camera.pitch) {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const forward = [cp * Math.sin(yaw), -sp, cp * Math.cos(yaw)];
  const d = FLY.eyeDistance;
  return { ...camera, yaw, pitch, target: [eye[0] + forward[0] * d, eye[1] + forward[1] * d, eye[2] + forward[2] * d], distance: d, sizeDistance: FLY.sizeDistance };
}

/** Entering flight: the eye stays where it was. */
export function enterFly(camera) {
  return flyCameraAt(camera, eyeOf(camera));
}

/** Leaving flight: orbit around `target` at the leave distance, the size reference released. */
export function leaveFly(camera, target) {
  const { sizeDistance, ...rest } = camera;
  return { ...rest, target: [...target], distance: FLY.leaveDistance };
}

/** The point the eye would orbit when leaving: FLY.leaveDistance ahead of it. */
export function aheadOf(camera, distance = FLY.leaveDistance) {
  const e = eyeOf(camera);
  const { forward } = axesOf(camera);
  return [e[0] + forward[0] * distance, e[1] + forward[1] * distance, e[2] + forward[2] * distance];
}

/** The slowing near planets: the full speed at FLY.slowWithin and beyond, a tenth at most beside a planet. */
export function slowFactor(nearestDistance) {
  if (!Number.isFinite(nearestDistance)) return 1;
  return Math.max(0.1, Math.min(1, nearestDistance / FLY.slowWithin));
}

/** The eye moved by `step` sky units along the camera's axes, weighted by forward/strafe/up (each −1..1). */
export function flyStep(camera, { forward = 0, strafe = 0, up = 0 }, step) {
  const a = axesOf(camera);
  const t = camera.target;
  return { ...camera, target: [t[0] + (a.forward[0] * forward + a.right[0] * strafe + a.up[0] * up) * step, t[1] + (a.forward[1] * forward + a.right[1] * strafe + a.up[1] * up) * step, t[2] + (a.forward[2] * forward + a.right[2] * strafe + a.up[2] * up) * step] };
}

/** The yaw and pitch that look along a direction. */
export function anglesToward(direction) {
  const len = Math.hypot(...direction) || 1;
  const f = direction.map((v) => v / len);
  return { yaw: Math.atan2(f[0], f[2]), pitch: Math.max(FLY_LIMITS.pitch[0], Math.min(FLY_LIMITS.pitch[1], -Math.asin(Math.max(-1, Math.min(1, f[1]))))) };
}

/**
 * The dive's glide: from the eye now to FLY.diveDistance from the planet on
 * the side the eye came from, facing it; `ms` is 0 under reduced motion.
 */
export function diveGlide(camera, planet, now, { reduced = false } = {}) {
  const from = eyeOf(camera);
  let dir = [from[0] - planet[0], from[1] - planet[1], from[2] - planet[2]];
  const len = Math.hypot(...dir);
  if (len < 1e-6) {
    const { forward } = axesOf(camera);
    dir = [-forward[0], -forward[1], -forward[2]];
  } else dir = dir.map((v) => v / len);
  const to = [planet[0] + dir[0] * FLY.diveDistance, planet[1] + dir[1] * FLY.diveDistance, planet[2] + dir[2] * FLY.diveDistance];
  const { yaw, pitch } = anglesToward([-dir[0], -dir[1], -dir[2]]);
  return { from, to, yaw0: camera.yaw, pitch0: camera.pitch, yaw, pitch, start: now, ms: reduced ? 0 : FLY.glideMs };
}

/** The camera at a moment of a glide (a smooth step), and whether the glide is done. */
export function glideCamera(camera, glide, now) {
  const t = glide.ms > 0 ? Math.min(1, (now - glide.start) / glide.ms) : 1;
  const k = t * t * (3 - 2 * t);
  let dyaw = glide.yaw - glide.yaw0;
  dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
  const yaw = glide.yaw0 + dyaw * k;
  const pitch = glide.pitch0 + (glide.pitch - glide.pitch0) * k;
  const eye = [glide.from[0] + (glide.to[0] - glide.from[0]) * k, glide.from[1] + (glide.to[1] - glide.from[1]) * k, glide.from[2] + (glide.to[2] - glide.from[2]) * k];
  return { camera: flyCameraAt(camera, eye, yaw, pitch), done: t >= 1 };
}

// UNIVERSE phase 2 — the UFO: the probe's cursor over the sky.
//
// A toggle, default on here and absent on every other page: a double
// right-click on the sky (two secondary-button presses within the browser's
// double-click interval, read from the second mousedown's click count, which
// the browser counts with its own interval; a timestamp within DOUBLE_MS is
// the fallback where it does not count secondary buttons), the U key, a
// visible switch, and on touch a two-finger double-tap (two touches starting
// together, twice within DOUBLE_MS). The context menu is suppressed over the
// sky canvas only. The page remembers the switch and whether the one caption
// was shown under the sky's own storage key, never the listening page's.
//
// Drawing: the plate's spectral diamond as a saucer (two diamonds, one
// flat), a beam that is a cone of the pulse colour at low alpha, locked
// brighter with a thin core, and the sheaf of thin lines from the probed
// planet to each lit planet. Under reduced motion nothing of it pulses.
// Pure apart from the storage it is handed.

export const UFO_SENTENCE = 'The UFO is the probe’s cursor over the sky: double right-click the sky, press U, or double-tap with two fingers to put it away or bring it back.';
export const STORAGE_KEY = 'xrpl-sonic:universe:v1';
export const DOUBLE_MS = 400; // the fallback interval, and the touch interval
export const HOLD_MS = 450; // a press this long without moving is a hold

/** The sky's own stored switches: { ufo: boolean, captionShown: boolean }; a missing or broken store reads as the defaults. */
export function loadUfoState(storage = globalThis.localStorage) {
  const d = { ufo: true, captionShown: false };
  try {
    const raw = storage?.getItem?.(STORAGE_KEY);
    if (!raw) return d;
    const o = JSON.parse(raw);
    return { ufo: typeof o?.ufo === 'boolean' ? o.ufo : d.ufo, captionShown: Boolean(o?.captionShown) };
  } catch {
    return d;
  }
}

export function saveUfoState(state, storage = globalThis.localStorage) {
  try {
    storage?.setItem?.(STORAGE_KEY, JSON.stringify({ ufo: Boolean(state.ufo), captionShown: Boolean(state.captionShown) }));
    return true;
  } catch {
    return false;
  }
}

/**
 * The gestures, fed the sky canvas's events; `onToggle()` fires on a double
 * right-click or a two-finger double-tap. Returns true from a feed when the
 * event was one of the gesture's presses (the caller then leaves it alone).
 */
export class UfoGestures {
  constructor({ onToggle = () => {}, doubleMs = DOUBLE_MS, now = () => performance.now() } = {}) {
    this.onToggle = onToggle;
    this.doubleMs = doubleMs;
    this.now = now;
    this.lastRight = -Infinity;
    this.lastTwoFinger = -Infinity;
  }

  /** A mousedown over the sky: a secondary button counts; the second within the interval toggles. */
  mousedown(e) {
    if (e.button !== 2) return false;
    const t = this.now();
    const counted = typeof e.detail === 'number' && e.detail >= 2; // the browser's own double-click count
    const within = t - this.lastRight <= this.doubleMs;
    if (counted || within) {
      this.lastRight = -Infinity;
      this.onToggle();
    } else this.lastRight = t;
    return true;
  }

  /** A touchstart over the sky: two touches starting together count; the second within the interval toggles. */
  touchstart(e) {
    const n = e.touches?.length ?? 0;
    if (n !== 2) return false;
    const t = this.now();
    if (t - this.lastTwoFinger <= this.doubleMs) {
      this.lastTwoFinger = -Infinity;
      this.onToggle();
    } else this.lastTwoFinger = t;
    return true;
  }
}

const rgba = (rgb, a) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;

/** The saucer at a point: two diamonds, one flat, in the plate's spectral style; a soft light below; a slow hover bob unless reduced. */
export function drawUfo(ctx, x, y, { t = 0, reduced = false, rgb = [255, 255, 255], scale = 1, lift = 14 } = {}) {
  const bob = reduced ? 0 : Math.sin(t / 420) * 1.5;
  const cy = y - lift * scale + bob;
  ctx.save();
  ctx.lineJoin = 'round';
  // the light below: a faint disc
  const g = ctx.createRadialGradient(x, cy + 6 * scale, 0, x, cy + 6 * scale, 16 * scale);
  g.addColorStop(0, rgba(rgb, 0.16));
  g.addColorStop(1, rgba(rgb, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, cy + 6 * scale, 16 * scale, 0, Math.PI * 2);
  ctx.fill();
  // the flat diamond: the hull
  ctx.strokeStyle = rgba(rgb, 0.9);
  ctx.fillStyle = 'rgba(6, 10, 18, 0.9)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(x - 12 * scale, cy);
  ctx.lineTo(x, cy + 3.5 * scale);
  ctx.lineTo(x + 12 * scale, cy);
  ctx.lineTo(x, cy - 3.5 * scale);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // the upright diamond: the dome
  ctx.beginPath();
  ctx.moveTo(x - 4.5 * scale, cy - 3 * scale);
  ctx.lineTo(x, cy - 10 * scale);
  ctx.lineTo(x + 4.5 * scale, cy - 3 * scale);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // the running lights, three dots on the hull
  ctx.fillStyle = rgba(rgb, 0.95);
  for (const dx of [-6, 0, 6]) {
    ctx.beginPath();
    ctx.arc(x + dx * scale, cy + 1.2 * scale, 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * The beam: a cone from the saucer's underside to a planet, the pulse colour
 * at low alpha; locked, brighter with a thin core line. `strength` 0..1
 * fades it in and out (reduced motion: fully on or off).
 */
export function drawBeam(ctx, from, to, { strength = 1, locked = false, reduced = false, rgb = [255, 255, 255], targetRadius = 4 } = {}) {
  if (!(strength > 0)) return;
  const s = reduced ? (strength > 0 ? 1 : 0) : strength;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const half = Math.max(6, targetRadius * 1.6 + 4);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
  g.addColorStop(0, rgba(rgb, (locked ? 0.34 : 0.22) * s));
  g.addColorStop(1, rgba(rgb, (locked ? 0.14 : 0.08) * s));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(from.x - 2 * nx, from.y - 2 * ny);
  ctx.lineTo(to.x + half * nx, to.y + half * ny);
  ctx.lineTo(to.x - half * nx, to.y - half * ny);
  ctx.lineTo(from.x + 2 * nx, from.y + 2 * ny);
  ctx.closePath();
  ctx.fill();
  if (locked) {
    ctx.strokeStyle = rgba(rgb, 0.55 * s);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }
  ctx.restore();
}

/** The sheaf: thin lines from one point to each lit planet; a planet in step draws a little brighter than one merely touching. */
export function drawSheaf(ctx, from, targets, { rgb = [255, 255, 255], strength = 1 } = {}) {
  if (!(strength > 0) || !targets.length) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const t of targets) {
    ctx.strokeStyle = rgba(rgb, (t.inStep ? 0.5 : t.touching ? 0.3 : 0.16) * strength);
    ctx.lineWidth = t.inStep ? 1.2 : 0.8;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(t.x, t.y);
    ctx.stroke();
    ctx.fillStyle = rgba(rgb, (t.inStep ? 0.8 : 0.45) * strength);
    ctx.beginPath();
    ctx.arc(t.x, t.y, t.inStep ? 3 : 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// xrpl-sonic — the transport.
//
// Plays a score (src/score.js) against a clock: play, pause, step, seek, loop,
// speed. It never touches audio or the DOM; it emits each ledger, gap, event
// and annotation a little ahead of time (the lookahead) with the offset at
// which it should happen, and the caller schedules sound and tracks from that.
// The clock is injected so the whole thing is testable with a fake one.

export const LOOKAHEAD_MS = 150;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function firstAtOrAfter(list, timeMs) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].timeMs < timeMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class Transport {
  /**
   * @param {object} score  from buildScore
   * @param {object} [opts]
   * @param {() => number} [opts.now]  wall clock in ms (performance.now by default)
   * @param {(item: object, offsetSeconds: number) => void} [opts.onEvent]
   * @param {(ledger: object, offsetSeconds: number) => void} [opts.onLedger]
   * @param {(gap: object, offsetSeconds: number) => void} [opts.onGap]
   * @param {(annotation: object, offsetSeconds: number) => void} [opts.onAnnotation]
   * @param {(state: string, detail: object) => void} [opts.onState]
   * @param {(positionMs: number) => void} [opts.onProgress]
   * @param {() => void} [opts.onEnd]
   * @param {boolean} [opts.honourPauses]  pause at annotations marked `pause` (default true)
   */
  constructor(score, { now, onEvent, onLedger, onGap, onAnnotation, onState, onProgress, onEnd, honourPauses = true } = {}) {
    this.now = now ?? (() => globalThis.performance?.now() ?? Date.now());
    this.onEvent = onEvent ?? (() => {});
    this.onLedger = onLedger ?? (() => {});
    this.onGap = onGap ?? (() => {});
    this.onAnnotation = onAnnotation ?? (() => {});
    this.onState = onState ?? (() => {});
    this.onProgress = onProgress ?? (() => {});
    this.onEnd = onEnd ?? (() => {});
    this.honourPauses = honourPauses;
    this.state = 'idle';
    this.speed = 1;
    this.loop = null; // { fromMs, toMs }
    this.position = 0; // score ms when not playing
    this.anchorPos = 0;
    this.anchorWall = 0;
    this.setScore(score);
  }

  /** Replace the score (same case, rebuilt) keeping the position and state. */
  setScore(score) {
    this.score = score;
    this.events = score?.events ?? [];
    this.ledgers = score?.ledgers ?? [];
    this.gaps = score?.gaps ?? [];
    this.annotations = score?.annotations ?? [];
    this.totalMs = score?.totalMs ?? 0;
    this._resetCursors(this.positionNow());
  }

  get playing() {
    return this.state === 'playing';
  }

  /** Current position in score milliseconds. */
  positionNow() {
    if (this.state !== 'playing') return this.position;
    return clamp(this.anchorPos + (this.now() - this.anchorWall) * this.speed, 0, this.totalMs);
  }

  _resetCursors(timeMs) {
    this.cursor = {
      event: firstAtOrAfter(this.events, timeMs),
      ledger: firstAtOrAfter(this.ledgers, timeMs),
      gap: firstAtOrAfter(this.gaps, timeMs),
      annotation: firstAtOrAfter(this.annotations, timeMs),
    };
  }

  _anchor(positionMs) {
    this.anchorPos = positionMs;
    this.anchorWall = this.now();
  }

  _setState(state, detail = {}) {
    if (this.state === state) return;
    this.state = state;
    this.onState(state, detail);
  }

  play() {
    if (this.state === 'playing') return;
    if (this.state === 'ended' || this.position >= this.totalMs) this.seek(this.loop ? this.loop.fromMs : 0);
    this._anchor(this.position);
    this._setState('playing');
  }

  pause(detail = {}) {
    if (this.state !== 'playing') return;
    this.position = this.positionNow();
    this._setState('paused', detail);
  }

  toggle() {
    if (this.state === 'playing') this.pause();
    else this.play();
  }

  stop() {
    this.position = 0;
    this._resetCursors(0);
    this._setState('idle');
  }

  /** Move to a position without playing anything; everything at or after it is still to come. */
  seek(ms) {
    const target = clamp(Number(ms) || 0, 0, this.totalMs);
    this.position = target;
    this._resetCursors(target);
    if (this.state === 'playing') this._anchor(target);
    else if (this.state === 'ended') this._setState('paused');
    this.onProgress(target);
  }

  /** Play exactly the next event (now), land on its time, and stay paused. */
  step() {
    if (this.state === 'playing') this.pause();
    if (this.state === 'ended') this.seek(0);
    const i = this.cursor.event;
    const item = this.events[i];
    if (!item) {
      this._finish();
      return null;
    }
    // Ledgers, gaps and annotations between here and the event fire first, all "now".
    this._fireUpTo(item.timeMs, item.timeMs, { events: false, annotations: true });
    this.cursor.event = i + 1;
    this.onEvent(item, 0);
    this.position = item.timeMs;
    this._setState('paused');
    this.onProgress(item.timeMs);
    return item;
  }

  /** Land on the previous event's time (without playing it), so step() replays it. */
  stepBack() {
    if (this.state === 'playing') this.pause();
    const pos = this.position;
    let i = firstAtOrAfter(this.events, pos) - 1;
    // When we are sitting exactly on an event (after step()), go one further back.
    if (i >= 0 && this.events[i].timeMs === pos) i -= 1;
    const target = i >= 0 ? this.events[i].timeMs : 0;
    this.seek(target);
    if (this.state === 'idle' || this.state === 'ended') this._setState('paused');
    return this.events[i] ?? null;
  }

  setSpeed(speed) {
    const s = Number(speed);
    if (!(s > 0)) return;
    if (this.state === 'playing') this._anchor(this.positionNow());
    this.speed = s;
  }

  /** Loop between two positions (ms); null clears it. The loop also bounds play() after the end. */
  setLoop(loop) {
    if (!loop) {
      this.loop = null;
      return;
    }
    const fromMs = clamp(Number(loop.fromMs) || 0, 0, this.totalMs);
    const toMs = clamp(Number(loop.toMs) || this.totalMs, 0, this.totalMs);
    this.loop = toMs > fromMs ? { fromMs, toMs } : null;
  }

  /**
   * Fire everything due within the lookahead window. Call this often (every
   * animation frame). Returns the position in ms.
   */
  tick() {
    if (this.state !== 'playing') return this.position;
    const pos = this.positionNow();
    const horizon = pos + LOOKAHEAD_MS * this.speed;
    const end = this.loop ? Math.min(this.loop.toMs, this.totalMs) : this.totalMs;
    const limit = Math.min(horizon, end);
    const pausing = this._nextPauseAnnotation(limit);
    this._fireUpTo(pausing ? pausing.timeMs : limit, pos, { events: true, annotations: true });
    if (pausing) {
      this.cursor.annotation = this.annotations.indexOf(pausing) + 1;
      this.position = pausing.timeMs;
      this._setState('paused', { annotation: pausing });
      this.onProgress(pausing.timeMs);
      return pausing.timeMs;
    }
    this.onProgress(pos);
    if (pos >= end) {
      if (this.loop && this.loop.toMs > this.loop.fromMs) this.seek(this.loop.fromMs);
      else this._finish();
    }
    return pos;
  }

  _finish() {
    this.position = this.totalMs;
    this._setState('ended');
    this.onEnd();
  }

  _nextPauseAnnotation(limit) {
    if (!this.honourPauses) return null;
    for (let i = this.cursor.annotation; i < this.annotations.length; i++) {
      const a = this.annotations[i];
      if (a.timeMs > limit) return null;
      if (a.pause) return a;
    }
    return null;
  }

  /** Emit everything with timeMs <= limit in time order (ledger, gap, annotation, event on ties), with offsets relative to `pos`. */
  _fireUpTo(limit, pos, { events, annotations }) {
    const offset = (t) => Math.max(0, t - pos) / this.speed / 1000;
    const lanes = [
      { key: 'ledger', list: this.ledgers, emit: (x, o) => this.onLedger(x, o), on: true },
      { key: 'gap', list: this.gaps, emit: (x, o) => this.onGap(x, o), on: true },
      { key: 'annotation', list: this.annotations, emit: (x, o) => this.onAnnotation(x, o), on: annotations },
      { key: 'event', list: this.events, emit: (x, o) => this.onEvent(x, o), on: events },
    ];
    for (;;) {
      let best = null;
      for (const lane of lanes) {
        if (!lane.on) continue;
        const item = lane.list[this.cursor[lane.key]];
        if (!item || item.timeMs > limit) continue;
        if (!best || item.timeMs < best.item.timeMs) best = { lane, item };
      }
      if (!best) return;
      this.cursor[best.lane.key] += 1;
      best.lane.emit(best.item, offset(best.item.timeMs));
    }
  }
}

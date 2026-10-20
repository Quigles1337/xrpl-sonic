// xrpl-sonic — Web Audio synthesis engine.
//
// Everything is synthesised from oscillators and generated noise; there are no
// samples. Events arrive in bursts (one burst per validated ledger), so the
// engine spreads each burst across the expected inter-ledger interval and
// enforces a polyphony cap plus per-category cooldowns to keep it musical.

const DEFAULT_COOLDOWNS = {
  payment: 0.03,
  offer: 0.05,
  trust: 0.25,
  nft: 0.2,
  escrow: 0.4,
  paychan: 0.3,
  amm: 0.3,
  other: 0.08,
};

const REVERB_SECONDS = 2.2;
const NOISE_SECONDS = 2;

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** A looping buffer of white noise, generated once. */
function makeNoiseBuffer(ctx, seconds) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** A synthetic impulse response: exponentially decaying stereo noise. */
function makeImpulseResponse(ctx, seconds, decay = 3.5) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      data[i] = (Math.random() * 2 - 1) * (1 - t) ** decay;
    }
  }
  return buffer;
}

export class AudioEngine {
  constructor({ maxVoices = 24, cooldowns = DEFAULT_COOLDOWNS, volume = 0.8, muted = false } = {}) {
    this.ctx = null;
    this.maxVoices = maxVoices;
    this.cooldowns = { ...DEFAULT_COOLDOWNS, ...cooldowns };
    this.volume = volume;
    this.muted = muted;
    this.voices = []; // {start, end}
    this.lastByCategory = new Map();
    this.nextSlot = 0;
    this.ledgerInterval = 4;
    this.expectedPerLedger = 40;
    this.stats = { played: 0, dropped: 0 };
  }

  get state() {
    return this.ctx ? this.ctx.state : 'closed';
  }

  get currentTime() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /**
   * Start (or resume) the context. Call it from a user gesture when you can;
   * when autoplay is blocked, Chrome leaves resume() pending until the next
   * gesture, so this never waits on it for more than a moment. The pending
   * resume still completes on its own once the user interacts.
   */
  async start() {
    if (!this.ctx) this._build();
    if (this.ctx.state !== 'running') {
      await Promise.race([this.ctx.resume().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 300))]);
    }
    if (this.ctx.state === 'running') {
      // iOS unlock: play a silent buffer.
      const src = this.ctx.createBufferSource();
      src.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      src.connect(this.ctx.destination);
      src.start();
      this.nextSlot = this.ctx.currentTime;
    }
    return this.ctx.state;
  }

  async stop() {
    if (this.ctx && this.ctx.state === 'running') await this.ctx.suspend();
    this.voices.length = 0;
  }

  setVolume(v) {
    this.volume = clamp(Number(v) || 0, 0, 1);
    this._applyMaster();
  }

  /** A MediaStream carrying the master output (post volume/mute), for recording. Null before start(). */
  recordingStream() {
    if (!this.ctx || !this.master) return null;
    if (!this.recordingDestination) {
      this.recordingDestination = this.ctx.createMediaStreamDestination();
      this.master.connect(this.recordingDestination);
    }
    return this.recordingDestination.stream;
  }

  setMuted(m) {
    this.muted = Boolean(m);
    this._applyMaster();
  }

  /** Seconds between ledger closes (used to spread each burst). */
  setLedgerInterval(seconds) {
    if (seconds > 0.5 && seconds < 30) this.ledgerInterval = seconds;
  }

  /** How many events the last ledger carried (used to choose spacing). */
  setExpectedCount(n) {
    if (n > 0) this.expectedPerLedger = 0.6 * this.expectedPerLedger + 0.4 * n;
  }

  _build() {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    const ctx = new Ctx({ latencyHint: 'interactive' });
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -18;
    this.compressor.knee.value = 12;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.25;

    this.bus = ctx.createGain(); // dry voices land here
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.28;
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulseResponse(ctx, REVERB_SECONDS);
    this.reverbTone = ctx.createBiquadFilter();
    this.reverbTone.type = 'lowpass';
    this.reverbTone.frequency.value = 5000;

    this.bus.connect(this.compressor);
    this.bus.connect(this.reverbSend);
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.reverbTone);
    this.reverbTone.connect(this.compressor);
    this.compressor.connect(this.master);
    this.master.connect(ctx.destination);

    this.noise = makeNoiseBuffer(ctx, NOISE_SECONDS);
    this._applyMaster();
  }

  _applyMaster() {
    if (!this.master) return;
    const target = this.muted ? 0 : this.volume * this.volume; // perceptual curve
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
  }

  _pruneVoices(now) {
    this.voices = this.voices.filter((v) => v.end > now);
  }

  /**
   * Schedule a transaction event. Returns the delay (seconds from now) at which
   * it will sound, or -1 if it was dropped by the rate limiter.
   */
  play(event) {
    if (!this.ctx || this.ctx.state !== 'running' || !event) return -1;
    const now = this.ctx.currentTime;
    this._pruneVoices(now);

    // Spread bursts: each event takes the next slot, spaced so a typical ledger's
    // worth of events fills ~85% of the inter-ledger interval.
    const spacing = clamp((this.ledgerInterval * 0.85) / Math.max(this.expectedPerLedger, 8), 0.02, 0.18);
    let t = Math.max(now + 0.01, this.nextSlot);
    if (t - now > this.ledgerInterval * 1.1) {
      this.stats.dropped++;
      return -1; // backlog longer than a ledger: drop rather than drift
    }

    const cooldown = this.cooldowns[event.category] ?? 0.05;
    const last = this.lastByCategory.get(event.category) ?? -Infinity;
    if (t - last < cooldown) {
      this.stats.dropped++;
      return -1;
    }

    const activeAt = this.voices.filter((v) => v.start <= t && v.end > t).length;
    if (activeAt >= this.maxVoices) {
      this.stats.dropped++;
      return -1;
    }

    this.nextSlot = t + spacing;
    this.lastByCategory.set(event.category, t);
    const tail = event.sound === 'pad' || event.sound === 'swell' ? 0.8 : 0.3;
    this.voices.push({ start: t, end: t + event.duration + tail });
    this.stats.played++;

    const synth = SYNTHS[event.sound] ?? click;
    try {
      synth(this, event, t);
      if (event.sub) subBass(this, event, t);
    } catch (err) {
      console.warn('[xrpl-sonic] synth error', err);
    }
    return t - now;
  }

  /**
   * Schedule a transaction event at an exact offset from now (used by replay,
   * which lays events out itself). Skips the burst spreader but keeps the
   * per-category cooldown and the polyphony cap. Returns the delay in seconds
   * or -1 if dropped.
   */
  playAt(event, offsetSeconds = 0) {
    if (!this.ctx || this.ctx.state !== 'running' || !event) return -1;
    const now = this.ctx.currentTime;
    this._pruneVoices(now);
    const t = now + Math.max(0.005, Number(offsetSeconds) || 0);

    const cooldown = this.cooldowns[event.category] ?? 0.05;
    const last = this.lastByCategory.get(event.category) ?? -Infinity;
    if (t - last < cooldown) {
      this.stats.dropped++;
      return -1;
    }
    const activeAt = this.voices.filter((v) => v.start <= t && v.end > t).length;
    if (activeAt >= this.maxVoices) {
      this.stats.dropped++;
      return -1;
    }

    this.lastByCategory.set(event.category, t);
    this.nextSlot = Math.max(this.nextSlot, t);
    const tail = event.sound === 'pad' || event.sound === 'swell' ? 0.8 : 0.3;
    this.voices.push({ start: t, end: t + event.duration + tail });
    this.stats.played++;
    const synth = SYNTHS[event.sound] ?? click;
    try {
      synth(this, event, t);
      if (event.sub) subBass(this, event, t);
    } catch (err) {
      console.warn('[xrpl-sonic] synth error', err);
    }
    return t - now;
  }

  /** Ledger close: a low tick, played immediately. */
  tick(ledgerEvent) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime + 0.005;
    ledgerTick(this, ledgerEvent, t);
  }

  // -- node helpers ---------------------------------------------------------

  _gain(t, value = 0) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(value, t);
    g.connect(this.bus);
    return g;
  }

  _osc(type, freq, t) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    return o;
  }

  _noise(t) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.loopStart = Math.random() * (NOISE_SECONDS - 0.5);
    s.loopEnd = NOISE_SECONDS;
    return s;
  }
}

// ---------------------------------------------------------------------------
// Voices. Each receives (engine, event, startTime) and schedules its own nodes.
// ---------------------------------------------------------------------------

/** Payment: a plucked, kalimba-like tone with a quick filter sweep. */
function pluck(e, ev, t) {
  const ctx = e.ctx;
  const freq = ev.freq;
  const dur = ev.duration;
  const vel = ev.velocity;
  const iou = ev.timbre === 'iou';

  const out = e._gain(t, 0);
  out.gain.linearRampToValueAtTime(vel * 0.6, t + 0.004);
  out.gain.exponentialRampToValueAtTime(0.0008, t + dur);

  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.Q.value = 1.2;
  filt.frequency.setValueAtTime(Math.min(freq * 7, 14000), t);
  filt.frequency.exponentialRampToValueAtTime(Math.max(freq * 1.3, 120), t + 0.22);
  filt.connect(out);

  const o1 = e._osc(iou ? 'square' : 'triangle', freq, t);
  const o2 = e._osc('sine', freq * (iou ? 3.01 : 2.005), t);
  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(iou ? 0.18 : 0.3, t);
  g2.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.5);
  const g1 = ctx.createGain();
  g1.gain.value = iou ? 0.35 : 0.8;
  o1.connect(g1).connect(filt);
  o2.connect(g2).connect(filt);
  o1.start(t);
  o2.start(t);
  o1.stop(t + dur + 0.05);
  o2.stop(t + dur + 0.05);
  o1.onended = () => {
    out.disconnect();
    filt.disconnect();
  };
}

/** Whale payment: a sub-bass drop under the pluck. */
function subBass(e, ev, t) {
  const ctx = e.ctx;
  const out = e._gain(t, 0);
  out.gain.linearRampToValueAtTime(0.7, t + 0.01);
  out.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
  const o = e._osc('sine', 72, t);
  o.frequency.exponentialRampToValueAtTime(38, t + 0.35);
  o.connect(out);
  o.start(t);
  o.stop(t + 1);
  // transient click so the thump reads on small speakers
  const n = e._noise(t);
  const nf = ctx.createBiquadFilter();
  nf.type = 'lowpass';
  nf.frequency.value = 600;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.25, t);
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  n.connect(nf).connect(ng).connect(e.bus);
  n.start(t);
  n.stop(t + 0.08);
  o.onended = () => out.disconnect();
}

/** OfferCreate: closed hi-hat. OfferCancel: rim tick. */
function hat(e, ev, t) {
  const ctx = e.ctx;
  const rim = ev.variant === 'rim';
  const dur = rim ? 0.045 : 0.07;
  const n = e._noise(t);
  const f = ctx.createBiquadFilter();
  if (rim) {
    f.type = 'bandpass';
    f.frequency.value = 2600;
    f.Q.value = 4;
  } else {
    f.type = 'highpass';
    f.frequency.value = 7000;
    f.Q.value = 0.7;
  }
  const g = e._gain(t, 0);
  g.gain.linearRampToValueAtTime(ev.velocity * (rim ? 1.2 : 0.9), t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  n.connect(f).connect(g);
  n.start(t);
  n.stop(t + dur + 0.01);
  if (rim) {
    const o = e._osc('sine', 1800, t);
    const og = ctx.createGain();
    og.gain.setValueAtTime(ev.velocity * 0.5, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.025);
    o.connect(og).connect(e.bus);
    o.start(t);
    o.stop(t + 0.03);
  }
  n.onended = () => g.disconnect();
}

/** TrustSet: a soft pad swell on root + fifth, each issuer its own note. */
function pad(e, ev, t) {
  const ctx = e.ctx;
  const dur = ev.duration;
  const out = e._gain(t, 0);
  out.gain.linearRampToValueAtTime(ev.velocity * 0.45, t + dur * 0.35);
  out.gain.setTargetAtTime(0.0001, t + dur * 0.5, dur * 0.18);
  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.setValueAtTime(500, t);
  filt.frequency.linearRampToValueAtTime(1800, t + dur * 0.4);
  filt.frequency.linearRampToValueAtTime(400, t + dur);
  filt.connect(out);
  const oscs = [];
  for (const midi of ev.notes) {
    const f = 440 * 2 ** ((midi - 69) / 12);
    for (const detune of [-7, 7]) {
      const o = e._osc('triangle', f, t);
      o.detune.value = detune;
      o.connect(filt);
      oscs.push(o);
    }
  }
  const low = e._osc('sine', ev.freq / 2, t);
  const lg = ctx.createGain();
  lg.gain.value = 0.5;
  low.connect(lg).connect(filt);
  oscs.push(low);
  for (const o of oscs) {
    o.start(t);
    o.stop(t + dur + 0.6);
  }
  oscs[0].onended = () => {
    out.disconnect();
    filt.disconnect();
  };
}

/** NFT: an FM bell with inharmonic partials. */
function bell(e, ev, t) {
  const ctx = e.ctx;
  const freq = ev.freq;
  const dur = ev.duration;
  const vel = ev.velocity;

  const out = e._gain(t, 0);
  out.gain.linearRampToValueAtTime(vel * 0.5, t + 0.003);
  out.gain.exponentialRampToValueAtTime(0.0006, t + dur);

  const carrier = e._osc('sine', freq, t);
  const mod = e._osc('sine', freq * 3.47, t);
  const modGain = ctx.createGain();
  modGain.gain.setValueAtTime(freq * 1.8, t);
  modGain.gain.exponentialRampToValueAtTime(freq * 0.05, t + dur * 0.6);
  mod.connect(modGain).connect(carrier.frequency);
  carrier.connect(out);

  const partial = e._osc('sine', freq * 2.76, t);
  const pg = ctx.createGain();
  pg.gain.setValueAtTime(vel * 0.18, t);
  pg.gain.exponentialRampToValueAtTime(0.0005, t + dur * 0.4);
  partial.connect(pg).connect(e.bus);

  for (const o of [carrier, mod, partial]) {
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  carrier.onended = () => out.disconnect();
}

/** Escrow: a reverse-cymbal swell; EscrowFinish resolves into a chime. */
function swell(e, ev, t) {
  const ctx = e.ctx;
  const rise = Math.min(ev.duration * 0.8, 1);
  const n = e._noise(t);
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 1.4;
  const lowBand = ev.variant === 'cancel';
  f.frequency.setValueAtTime(lowBand ? 500 : 1200, t);
  f.frequency.exponentialRampToValueAtTime(lowBand ? 1400 : 5000, t + rise);
  const g = e._gain(t, 0.0005);
  g.gain.exponentialRampToValueAtTime(ev.velocity * 0.55, t + rise);
  g.gain.linearRampToValueAtTime(0, t + rise + 0.04);
  n.connect(f).connect(g);
  n.start(t);
  n.stop(t + rise + 0.06);
  n.onended = () => g.disconnect();

  if (ev.variant === 'finish') {
    const tc = t + rise;
    const o = e._osc('sine', ev.freq * 2, tc);
    const o2 = e._osc('sine', ev.freq * 3, tc);
    const og = e._gain(tc, 0);
    og.gain.linearRampToValueAtTime(ev.velocity * 0.5, tc + 0.005);
    og.gain.exponentialRampToValueAtTime(0.0006, tc + 0.9);
    const o2g = ctx.createGain();
    o2g.gain.setValueAtTime(0.3, tc);
    o2g.gain.exponentialRampToValueAtTime(0.001, tc + 0.4);
    o.connect(og);
    o2.connect(o2g).connect(og);
    o.start(tc);
    o2.start(tc);
    o.stop(tc + 1);
    o2.stop(tc + 1);
    o.onended = () => og.disconnect();
  }
}

/** Payment channels: a quick ascending arpeggio of short sine plucks. */
function arp(e, ev, t) {
  const ctx = e.ctx;
  const step = Math.max(0.06, ev.duration / ev.notes.length);
  ev.notes.forEach((midi, i) => {
    const ts = t + i * step;
    const f = 440 * 2 ** ((midi - 69) / 12);
    const g = e._gain(ts, 0);
    g.gain.linearRampToValueAtTime(ev.velocity * 0.5, ts + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0008, ts + 0.3);
    const o = e._osc('sine', f, ts);
    const o2 = e._osc('triangle', f * 2, ts);
    const g2 = ctx.createGain();
    g2.gain.value = 0.15;
    o.connect(g);
    o2.connect(g2).connect(g);
    o.start(ts);
    o2.start(ts);
    o.stop(ts + 0.32);
    o2.stop(ts + 0.32);
    o.onended = () => g.disconnect();
  });
}

/** AMM: a soft triad. */
function chord(e, ev, t) {
  const ctx = e.ctx;
  const dur = ev.duration;
  const out = e._gain(t, 0);
  out.gain.linearRampToValueAtTime(ev.velocity * 0.4, t + 0.05);
  out.gain.exponentialRampToValueAtTime(0.0006, t + dur);
  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.setValueAtTime(2200, t);
  filt.frequency.exponentialRampToValueAtTime(500, t + dur);
  filt.connect(out);
  const oscs = [];
  ev.notes.forEach((midi, i) => {
    const f = 440 * 2 ** ((midi - 69) / 12);
    const o = e._osc('triangle', f, t);
    o.detune.value = (i - 1) * 4;
    o.connect(filt);
    oscs.push(o);
  });
  for (const o of oscs) {
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  oscs[0].onended = () => {
    out.disconnect();
    filt.disconnect();
  };
}

/** Everything else: a barely-there click. */
function click(e, ev, t) {
  const ctx = e.ctx;
  const n = e._noise(t);
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 3200;
  f.Q.value = 2;
  const g = e._gain(t, 0);
  g.gain.linearRampToValueAtTime(ev.velocity * 0.6, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0008, t + 0.03);
  n.connect(f).connect(g);
  n.start(t);
  n.stop(t + 0.04);
  n.onended = () => g.disconnect();
}

/** Ledger close: a low, short tick with a pitch drop. */
function ledgerTick(e, ev, t) {
  const ctx = e.ctx;
  const g = e._gain(t, 0);
  g.gain.linearRampToValueAtTime(0.5, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0008, t + 0.28);
  const o = e._osc('sine', 96, t);
  o.frequency.exponentialRampToValueAtTime(52, t + 0.12);
  o.connect(g);
  o.start(t);
  o.stop(t + 0.3);
  const n = e._noise(t);
  const nf = ctx.createBiquadFilter();
  nf.type = 'bandpass';
  nf.frequency.value = 900;
  nf.Q.value = 1;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.12, t);
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
  n.connect(nf).connect(ng).connect(e.bus);
  n.start(t);
  n.stop(t + 0.03);
  o.onended = () => g.disconnect();
}

const SYNTHS = { pluck, hat, pad, bell, swell, arp, chord, click };

export const VOICE_NAMES = Object.freeze(Object.keys(SYNTHS));

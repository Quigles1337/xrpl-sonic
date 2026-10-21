// xrpl-sonic — live Web MIDI output.
//
// The same note events that go into a MIDI file (src/midi.js) can be sent to
// a hardware or software instrument as they are played, from a case or from
// the live stream. Web MIDI needs a secure context, a browser that offers it,
// and the user's permission, so everything here starts from a click and fails
// softly: `supported()` says whether it exists at all, `connect()` asks, and
// `send()` is a no-op without an output.

import { noteEventsFor, PERCUSSION_CHANNEL } from './midi.js';

export function midiSupported() {
  return typeof globalThis.navigator?.requestMIDIAccess === 'function';
}

export class MidiOut {
  constructor() {
    this.access = null;
    this.output = null;
    this.channels = new Map();
    this.onChange = null;
  }

  /** Ask for access (from a user gesture). Resolves with the list of outputs. */
  async connect() {
    if (!midiSupported()) throw new Error('Web MIDI is not available in this browser or context');
    this.access = await globalThis.navigator.requestMIDIAccess({ sysex: false });
    this.access.onstatechange = () => this.onChange?.(this.outputs());
    return this.outputs();
  }

  /** Available outputs as { id, name }. */
  outputs() {
    if (!this.access) return [];
    return [...this.access.outputs.values()].map((o) => ({ id: o.id, name: o.name || o.id }));
  }

  /** Choose an output by id (or null to stop sending). */
  select(id) {
    this.allNotesOff();
    this.output = id && this.access ? this.access.outputs.get(id) ?? null : null;
    return this.output ? { id: this.output.id, name: this.output.name || this.output.id } : null;
  }

  get active() {
    return Boolean(this.output);
  }

  channelFor(key) {
    if (!this.channels.has(key)) {
      let n = this.channels.size;
      if (n >= PERCUSSION_CHANNEL) n += 1;
      this.channels.set(key, Math.min(15, n));
    }
    return this.channels.get(key);
  }

  /**
   * Send a score item's notes `offsetSeconds` from now. Works for live events
   * too: pass { event, timeMs: 0, gate: 'play', primary, cast } shaped like a score item.
   */
  play(item, offsetSeconds = 0) {
    if (!this.output) return 0;
    const base = performance.now() + Math.max(0, offsetSeconds) * 1000;
    const notes = noteEventsFor({ ...item, timeMs: 0 }, { channelFor: (k) => this.channelFor(k) });
    for (const n of notes) {
      const at = base + n.timeMs;
      try {
        this.output.send([0x90 | n.channel, n.note, n.velocity], at);
        this.output.send([0x80 | n.channel, n.note, 0], at + n.durationMs);
      } catch {
        /* a closed port; keep going */
      }
    }
    return notes.length;
  }

  /** The ledger pulse on the percussion channel. */
  pulse(offsetSeconds = 0) {
    if (!this.output) return;
    const at = performance.now() + Math.max(0, offsetSeconds) * 1000;
    try {
      this.output.send([0x90 | PERCUSSION_CHANNEL, 36, 96], at);
      this.output.send([0x80 | PERCUSSION_CHANNEL, 36, 0], at + 80);
    } catch {
      /* ignore */
    }
  }

  allNotesOff() {
    if (!this.output) return;
    for (let ch = 0; ch < 16; ch++) {
      try {
        this.output.send([0xb0 | ch, 123, 0]);
      } catch {
        /* ignore */
      }
    }
  }
}

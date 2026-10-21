// xrpl-sonic — MIDI from the score.
//
// A score (src/score.js) is already a list of musical events with voice,
// notes, velocity, duration and time. This module turns it into note events
// and writes them as a Standard MIDI File (format 1): one track per category
// voice, one per cast member, a percussion track for hi-hats, clicks and the
// ledger pulse, and the annotations as marker meta events at their times. A
// MIDI file carries the events, not the synthesiser: the receiving instrument
// decides how they sound.
//
// Pure: no DOM, no Web MIDI. src/midi-out.js sends the same note events live.

import { CATEGORIES } from './mapping.js';
import { CAST_VOICES } from './cast.js';

export const PPQ = 480;
export const BPM = 120;
export const PERCUSSION_CHANNEL = 9; // channel 10, 0-based

/** General MIDI programs (0-based) for the pitched voices. */
export const PROGRAMS = Object.freeze({
  pluck: 108, // Kalimba
  pad: 89, // Pad 2 (warm)
  bell: 14, // Tubular Bells
  swell: 119, // Reverse Cymbal
  arp: 46, // Orchestral Harp
  chord: 4, // Electric Piano 1
  marimba: 12, // Marimba
  glass: 98, // FX 3 (crystal)
  brass: 61, // Brass Section
  reed: 71, // Clarinet
  pulse: 80, // Lead 1 (square)
});

/** General MIDI percussion notes for the unpitched voices and the ledger pulse. */
export const PERCUSSION = Object.freeze({ hat: 42, rim: 37, click: 75, ledger: 36, gap: 49 });

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const msToTicks = (ms, { ppq = PPQ, bpm = BPM } = {}) => Math.round((ms * ppq * bpm) / 60000);
const vel = (v) => clamp(Math.round(v * 127), 1, 127);

/** The track a score event belongs to: the primary cast member's, or its category voice's. */
export function trackKeyFor(item) {
  const ev = item.event;
  if (item.primary && ev.voice) return `cast:${item.primary}`;
  if (ev.sound === 'hat' || ev.sound === 'click') return 'percussion';
  return `voice:${ev.sound}`;
}

/**
 * Note events for one score item: { timeMs, durationMs, channel, note, velocity, track }.
 * Chords sound together, the payment-channel arpeggio is staggered as the synth plays it,
 * and the unpitched voices become fixed percussion notes. Silent (dim) items yield nothing.
 */
export function noteEventsFor(item, { channelFor = () => 0 } = {}) {
  const ev = item?.event;
  if (!ev || item.gate === 'dim') return [];
  const key = trackKeyFor(item);
  const t = item.timeMs;
  const out = [];
  if (key === 'percussion') {
    const note = ev.sound === 'hat' ? (ev.variant === 'rim' ? PERCUSSION.rim : PERCUSSION.hat) : PERCUSSION.click;
    out.push({ timeMs: t, durationMs: 60, channel: PERCUSSION_CHANNEL, note, velocity: vel(ev.velocity * (ev.sound === 'click' ? 2 : 3)), track: key });
    return out;
  }
  const channel = channelFor(key);
  const notes = Array.isArray(ev.notes) && ev.notes.length ? ev.notes : [ev.pitch];
  const stagger = ev.sound === 'arp' && !ev.voice ? Math.max(60, (ev.duration * 1000) / notes.length) : 0;
  const durationMs = Math.max(40, Math.round(ev.duration * 1000));
  notes.forEach((midi, i) => {
    out.push({ timeMs: t + i * stagger, durationMs, channel, note: clamp(Math.round(midi), 0, 127), velocity: vel(ev.velocity), track: key });
  });
  return out;
}

/** Every note event of a score, in time order, with the track keys that occur. */
export function scoreNoteEvents(score, theCase) {
  const channels = new Map();
  const channelFor = (key) => {
    if (!channels.has(key)) {
      let n = channels.size;
      if (n >= PERCUSSION_CHANNEL) n += 1; // skip channel 10
      channels.set(key, Math.min(15, n));
    }
    return channels.get(key);
  };
  const events = [];
  for (const item of score.events) events.push(...noteEventsFor(item, { channelFor }));
  for (const l of score.ledgers) if (!l.missing) events.push({ timeMs: l.timeMs, durationMs: 80, channel: PERCUSSION_CHANNEL, note: PERCUSSION.ledger, velocity: 96, track: 'percussion' });
  for (const g of score.gaps) events.push({ timeMs: g.timeMs, durationMs: 200, channel: PERCUSSION_CHANNEL, note: PERCUSSION.gap, velocity: 70, track: 'percussion' });
  events.sort((a, b) => a.timeMs - b.timeMs || a.note - b.note);
  const tracks = [...new Set(events.map((e) => e.track))];
  const names = Object.fromEntries(
    tracks.map((key) => {
      if (key === 'percussion') return [key, 'Percussion: offers, clicks, ledger closes'];
      if (key.startsWith('cast:')) {
        const m = (theCase?.cast ?? []).find((x) => x.id === key.slice(5));
        return [key, m ? `${m.label} (${CAST_VOICES[m.voice]?.label ?? m.voice})` : key];
      }
      const sound = key.slice(6);
      const cat = Object.values(CATEGORIES).find((c) => c.sound === sound);
      return [key, cat ? `${cat.label} (${sound})` : sound];
    }),
  );
  const programs = Object.fromEntries(
    tracks.map((key) => {
      if (key === 'percussion') return [key, null];
      if (key.startsWith('cast:')) {
        const m = (theCase?.cast ?? []).find((x) => x.id === key.slice(5));
        return [key, PROGRAMS[m?.voice] ?? 0];
      }
      return [key, PROGRAMS[key.slice(6)] ?? 0];
    }),
  );
  return { events, tracks, names, programs, channels: Object.fromEntries(channels) };
}

// ---------------------------------------------------------------------------
// Standard MIDI File writing
// ---------------------------------------------------------------------------

export function vlq(n) {
  let v = Math.max(0, Math.round(n));
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

function u32(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function u16(n) {
  return [(n >>> 8) & 255, n & 255];
}

function textBytes(s) {
  return [...new TextEncoder().encode(String(s).slice(0, 200))];
}

function meta(type, bytes) {
  return [0xff, type, ...vlq(bytes.length), ...bytes];
}

/** Build one MTrk chunk from absolute-tick messages [{ tick, bytes }], sorted and delta-encoded. */
function trackChunk(messages) {
  const sorted = [...messages].sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body = [];
  let last = 0;
  for (const m of sorted) {
    body.push(...vlq(m.tick - last), ...m.bytes);
    last = m.tick;
  }
  body.push(...vlq(0), 0xff, 0x2f, 0x00);
  return [...[0x4d, 0x54, 0x72, 0x6b], ...u32(body.length), ...body];
}

/**
 * Write the score as a format-1 Standard MIDI File.
 * @returns {Uint8Array}
 */
export function scoreToMidi(score, theCase, { ppq = PPQ, bpm = BPM } = {}) {
  const ticks = (ms) => msToTicks(ms, { ppq, bpm });
  const { events, tracks, names, programs, channels } = scoreNoteEvents(score, theCase);
  const title = theCase?.title || theCase?.id || score.caseId || 'xrpl-sonic';
  const conductor = [
    { tick: 0, order: 0, bytes: meta(0x03, textBytes(title)) },
    { tick: 0, order: 1, bytes: meta(0x01, textBytes(`xrpl-sonic case ${theCase?.id ?? ''} · network ${score.network} · mapping ${score.mappingVersion} · ${score.events.length} events`)) },
    { tick: 0, order: 2, bytes: meta(0x51, [(Math.round(60000000 / bpm) >> 16) & 255, (Math.round(60000000 / bpm) >> 8) & 255, Math.round(60000000 / bpm) & 255]) },
    { tick: 0, order: 3, bytes: meta(0x58, [4, 2, 24, 8]) },
  ];
  for (const a of score.annotations ?? []) conductor.push({ tick: ticks(a.timeMs), order: 10, bytes: meta(0x06, textBytes(a.text)) });
  for (const l of score.ledgers ?? []) conductor.push({ tick: ticks(l.timeMs), order: 11, bytes: meta(0x07, textBytes(l.missing ? `ledger ${l.ledgerIndex} unavailable` : `ledger ${l.ledgerIndex}`)) });
  const chunks = [trackChunk(conductor)];
  for (const key of tracks) {
    const messages = [{ tick: 0, order: 0, bytes: meta(0x03, textBytes(names[key])) }];
    const channel = key === 'percussion' ? PERCUSSION_CHANNEL : channels[key];
    if (programs[key] != null) messages.push({ tick: 0, order: 1, bytes: [0xc0 | channel, programs[key] & 0x7f] });
    for (const e of events) {
      if (e.track !== key) continue;
      const on = ticks(e.timeMs);
      const off = Math.max(on + 1, ticks(e.timeMs + e.durationMs));
      messages.push({ tick: on, order: 2, bytes: [0x90 | e.channel, e.note, e.velocity] });
      messages.push({ tick: off, order: 1, bytes: [0x80 | e.channel, e.note, 0] });
    }
    chunks.push(trackChunk(messages));
  }
  const header = [...[0x4d, 0x54, 0x68, 0x64], ...u32(6), ...u16(1), ...u16(chunks.length), ...u16(ppq)];
  return Uint8Array.from([...header, ...chunks.flat()]);
}

export function midiFilename(theCase, score) {
  const id = theCase?.id || score?.caseId || 'xrpl-sonic';
  return `${String(id).replace(/[^a-z0-9._-]+/gi, '-')}.mid`;
}

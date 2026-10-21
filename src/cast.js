// xrpl-sonic — the cast.
//
// A cast is up to five accounts a listener chooses to follow. Each member has
// a voice of its own, a place in the stereo field, a colour and a label, so a
// person can tell "that was the market maker again" without reading the tape.
// This module is pure: it decides who a transaction involves and what the
// sound policy is; src/audio.js plays the voices and src/visual.js draws the
// identity.

import { isValidAddress, shortAddress, involvesAccount, unwrapTransactionMessage, stableIndex, degreeToMidi, getScaleSteps, hashString } from './mapping.js';

export const CAST_MAX = 5;

/** Cast voices: timbres chosen to stay apart from each other and from the category voices. */
export const CAST_VOICES = Object.freeze({
  marimba: Object.freeze({ label: 'Marimba', hint: 'warm and woody, quick decay' }),
  glass: Object.freeze({ label: 'Glass', hint: 'bright, ringing partials' }),
  brass: Object.freeze({ label: 'Brass', hint: 'bold, sustained, filtered saw' }),
  reed: Object.freeze({ label: 'Reed', hint: 'nasal square wave with vibrato' }),
  pulse: Object.freeze({ label: 'Pulse', hint: 'gated electronic pulse' }),
});

export const CAST_VOICE_NAMES = Object.freeze(Object.keys(CAST_VOICES));

/** Pastel identities, deliberately lighter than the saturated category colours so both read at once. */
export const CAST_PALETTE = Object.freeze(['#ffffff', '#ffb3c6', '#c8b6ff', '#b9fbc0', '#9bf6ff']);

/** Default stereo placement per slot: centre first, then alternating sides. -1 = left, 1 = right. */
export const CAST_PANS = Object.freeze([0, -0.6, 0.6, -0.3, 0.3]);

/** What to do with transactions that involve nobody in the cast. */
export const CAST_MODES = Object.freeze({ all: 'Play everything', mute: 'Mute others', hide: 'Hide others' });

/** Sound policy for a transaction that involves several members: the primary voice plays, the others get a short cue. */
export const CAST_POLICY = Object.freeze({ primary: 'primary', cue: 'cue' });

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function cleanLabel(label, fallback) {
  const s = typeof label === 'string' ? label.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24) : '';
  return s || fallback;
}

/**
 * Normalise a cast list: valid, unique addresses only, at most CAST_MAX, with
 * defaults for label, voice, pan and colour. Ids are positional (c1..c5) so
 * the same cast always gets the same ids. `solo` and `muted` are live controls
 * and are carried through but never required.
 */
export function normalizeCast(list) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    if (out.length >= CAST_MAX) break;
    const m = raw && typeof raw === 'object' ? raw : { address: raw };
    const address = typeof m.address === 'string' ? m.address.trim() : '';
    if (!isValidAddress(address) || seen.has(address)) continue;
    seen.add(address);
    const i = out.length;
    const pan = Number(m.pan);
    out.push({
      id: `c${i + 1}`,
      address,
      label: cleanLabel(m.label, shortAddress(address)),
      voice: CAST_VOICE_NAMES.includes(m.voice) ? m.voice : CAST_VOICE_NAMES[i % CAST_VOICE_NAMES.length],
      pan: Number.isFinite(pan) ? clamp(Math.round(pan * 100) / 100, -1, 1) : CAST_PANS[i],
      colour: /^#[0-9a-f]{6}$/i.test(m.colour ?? '') ? m.colour.toLowerCase() : CAST_PALETTE[i],
      solo: m.solo === true,
      muted: m.muted === true,
    });
  }
  return out;
}

/** Look a member up by id or address. */
export function castMember(cast, idOrAddress) {
  if (!Array.isArray(cast)) return null;
  return cast.find((m) => m.id === idOrAddress || m.address === idOrAddress) ?? null;
}

/**
 * Which cast members a transaction involves. The primary member is the sender
 * when the sender is in the cast, otherwise the first involved member in cast
 * order. Involvement uses the same metadata-aware test as the account watch.
 * @returns {{ members: object[], primary: object|null }}
 */
export function castFor(msg, cast) {
  const members = [];
  if (!Array.isArray(cast) || cast.length === 0) return { members, primary: null };
  const unwrapped = unwrapTransactionMessage(msg);
  if (!unwrapped) return { members, primary: null };
  for (const m of cast) if (involvesAccount(msg, m.address)) members.push(m);
  const sender = members.find((m) => m.address === unwrapped.tx.Account) ?? null;
  return { members, primary: sender ?? members[0] ?? null };
}

/**
 * Sound policy for an event given the involvement, the cast and the mode.
 * Returns 'play' (sounds), 'dim' (drawn, silent) or 'skip' (not drawn).
 *
 * - No cast: everything plays.
 * - Involved: plays unless every involved member is muted (then dim). When any
 *   member is soloed, only events involving a soloed member play; the rest dim.
 * - Not involved: 'all' plays it in its category voice, 'mute' dims it, 'hide' skips it.
 */
export function castGate(involvement, cast, mode = 'all') {
  if (!Array.isArray(cast) || cast.length === 0) return 'play';
  const members = involvement?.members ?? [];
  const anySolo = cast.some((m) => m.solo);
  if (members.length > 0) {
    const audible = members.filter((m) => !m.muted && (!anySolo || m.solo));
    return audible.length > 0 ? 'play' : 'dim';
  }
  if (anySolo) return mode === 'hide' ? 'skip' : 'dim';
  if (mode === 'hide') return 'skip';
  if (mode === 'mute') return 'dim';
  return 'play';
}

/**
 * Apply the cast to a mapped event: the primary member's voice and pan replace
 * the category voice, the other involved members are listed for cues, and the
 * event remains one event (counted once). Returns the same object, decorated.
 */
export function decorateEvent(event, involvement) {
  if (!event) return event;
  const members = involvement?.members ?? [];
  const primary = involvement?.primary ?? null;
  event.cast = members.map((m) => m.id);
  event.primary = primary?.id ?? null;
  if (primary) {
    event.voice = primary.voice;
    event.pan = primary.pan;
    event.castColour = primary.colour;
    event.castLabel = primary.label;
  }
  event.cues = members.filter((m) => m !== primary && !m.muted).map((m) => ({ id: m.id, voice: m.voice, pan: m.pan, colour: m.colour, label: m.label }));
  return event;
}

/**
 * A three-note motif derived from the address, in the current scale and key,
 * played by the preview button and as a member's ident. The same address always
 * yields the same phrase.
 */
export function motifFor(address, scale = 'pentatonicMajor', key = 'C') {
  const len = getScaleSteps(scale).length;
  const h = hashString(address);
  const root = 2 * len + stableIndex(address, 2 * len);
  const shapes = [
    [0, 2, 4],
    [0, 4, 2],
    [0, 1, 3],
    [0, 3, 1],
    [0, 2, 5],
    [0, 5, 2],
    [0, 1, len],
    [0, len, 2],
  ];
  const shape = shapes[h % shapes.length];
  return shape.map((d) => degreeToMidi(root + d, scale, key));
}

// ---------------------------------------------------------------------------
// URL spec: `r...~Label~voice~pan,r...~...` — label percent-encoded, every
// field after the address optional.
// ---------------------------------------------------------------------------

export function parseCastSpec(spec) {
  const errors = [];
  if (typeof spec !== 'string' || !spec.trim()) return { cast: [], errors };
  const raw = [];
  for (const part of spec.split(',')) {
    const [address, label, voice, pan] = part.split('~').map((s) => s?.trim() ?? '');
    if (!address) continue;
    if (!isValidAddress(address)) {
      errors.push(`Ignoring invalid cast address: ${address.slice(0, 12)}…`);
      continue;
    }
    let decoded = '';
    try {
      decoded = decodeURIComponent(label ?? '');
    } catch {
      decoded = label ?? '';
    }
    raw.push({ address, label: decoded, voice: voice || undefined, pan: pan === '' ? undefined : Number(pan) });
  }
  if (raw.length > CAST_MAX) errors.push(`A cast has at most ${CAST_MAX} members; the rest were ignored.`);
  return { cast: normalizeCast(raw), errors };
}

export function formatCastSpec(cast) {
  const members = normalizeCast(cast);
  return members
    .map((m, i) => {
      const defaultLabel = m.label === shortAddress(m.address);
      const defaultVoice = m.voice === CAST_VOICE_NAMES[i % CAST_VOICE_NAMES.length];
      const defaultPan = m.pan === CAST_PANS[i];
      const fields = [m.address, defaultLabel ? '' : encodeURIComponent(m.label), defaultVoice ? '' : m.voice, defaultPan ? '' : String(m.pan)];
      while (fields.length > 1 && fields.at(-1) === '') fields.pop();
      return fields.join('~');
    })
    .join(',');
}

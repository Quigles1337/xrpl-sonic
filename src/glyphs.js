// xrpl-sonic — the field guide.
//
// The scene is a cloud chamber for a ledger: every transaction species leaves
// its own kind of track. This module is the one place that says what each
// species looks like, so the canvas, the legend tiles in the settings panel,
// the transaction tape and the start screen all speak the same language.
//
// Pure: no DOM, no canvas. The SVG strings here are the legend icons; the
// canvas renderer in src/visual.js draws the animated versions.

import { CATEGORIES, CATEGORY_NAMES, PITCH_RANGE, midiToName } from './mapping.js';

/**
 * One entry per sound category.
 *  shape      the track morphology drawn by the visualiser
 *  motion     'rise' drifts upward like a photon; 'hover' barely moves
 *  lifeScale  multiplies the audio-derived lifetime so slow shapes can unfold
 *  track      one line for the legend: what to look for
 */
export const GLYPHS = Object.freeze({
  payment: Object.freeze({ shape: 'photon', motion: 'rise', lifeScale: 1, track: 'A photon with a comet tail. Whales break the light barrier and leave a Cherenkov ring.' }),
  offer: Object.freeze({ shape: 'spectral', motion: 'rise', lifeScale: 1.1, track: 'A spectral line: a thin vertical flash. A cancelled offer is struck through.' }),
  trust: Object.freeze({ shape: 'lattice', motion: 'hover', lifeScale: 1, track: 'A hexagonal cell that grows a bond to its issuer, like a crystal forming.' }),
  nft: Object.freeze({ shape: 'stellar', motion: 'rise', lifeScale: 1.15, track: 'A four-point star with a lens flare at ignition, turning slowly.' }),
  escrow: Object.freeze({ shape: 'vault', motion: 'hover', lifeScale: 1.2, track: 'A dial that winds shut when funds are locked and springs open on finish.' }),
  paychan: Object.freeze({ shape: 'ladder', motion: 'rise', lifeScale: 2, track: 'Four bars that light in sequence with the arpeggio, climbing to the right.' }),
  amm: Object.freeze({ shape: 'pool', motion: 'hover', lifeScale: 1.1, track: 'Three overlapping rings, breathing together: a pool.' }),
  other: Object.freeze({ shape: 'mote', motion: 'rise', lifeScale: 1, track: 'A single bright mote. Background radiation.' }),
});

/** The ledger close is not a category but it has a glyph of its own in the tape. */
export const PULSE = Object.freeze({ shape: 'pulse', colour: '#c8dcff', label: 'Ledger close', track: 'A ring from the centre of the plate; the grid lights up and the ledger number is stamped behind it.' });

/**
 * Resolve the shape to draw for an event, taking the type variant into account.
 * Returns one of the GLYPHS shapes or a variant of it: 'spectral-cancel',
 * 'vault-open', 'vault-cancel'.
 */
export function shapeFor(event) {
  const base = GLYPHS[event?.category]?.shape ?? 'mote';
  if (base === 'spectral' && event.variant === 'rim') return 'spectral-cancel';
  if (base === 'vault') {
    if (event.variant === 'finish') return 'vault-open';
    if (event.variant === 'cancel') return 'vault-cancel';
  }
  return base;
}

/** Octave ticks for the pitch ruler drawn under the plate (C2 … C7 for the default range). */
export const PITCH_AXIS = Object.freeze({
  low: PITCH_RANGE.low,
  high: PITCH_RANGE.low + PITCH_RANGE.octaves * 12,
  ticks: Object.freeze(
    Array.from({ length: PITCH_RANGE.octaves + 1 }, (_, i) => {
      const midi = PITCH_RANGE.low + i * 12;
      return Object.freeze({ midi, label: midiToName(midi) });
    }),
  ),
});

/** Horizontal position (0..1) of a MIDI pitch on the ruler. */
export function pitchPosition(midi) {
  const span = PITCH_AXIS.high - PITCH_AXIS.low;
  const v = (Number(midi) - PITCH_AXIS.low) / span;
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.5));
}

export function hexToRgb(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---------------------------------------------------------------------------
// Legend icons (24×24, currentColor, so CSS decides the colour and the dimming)
// ---------------------------------------------------------------------------

const hexagon = (cx, cy, r) =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i;
    return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
  }).join(' ');

const ICONS = Object.freeze({
  photon:
    '<circle cx="12" cy="12" r="7.5" fill="currentColor" fill-opacity=".14"/>' +
    '<path d="M12 15.5v6" stroke="currentColor" stroke-opacity=".55" stroke-width="2.2" stroke-linecap="round"/>' +
    '<circle cx="12" cy="12" r="3.4" fill="currentColor"/>' +
    '<circle cx="12" cy="12" r="1.3" fill="#fff" fill-opacity=".85"/>',
  spectral: '<path d="M12 2.5 14 12l-2 9.5L10 12z" fill="currentColor"/><path d="M6 12h12" stroke="currentColor" stroke-opacity=".35" stroke-width="1"/>',
  'spectral-cancel':
    '<path d="M12 2.5 14 12l-2 9.5L10 12z" fill="currentColor" fill-opacity=".55"/>' +
    '<path d="M7.5 7.5l9 9M16.5 7.5l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  lattice:
    `<polygon points="${hexagon(12, 12, 8.5)}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<polygon points="${hexagon(12, 12, 3.6)}" fill="currentColor" fill-opacity=".6"/>`,
  stellar:
    '<path d="M12 1.5 13.7 10.3 22.5 12 13.7 13.7 12 22.5 10.3 13.7 1.5 12 10.3 10.3z" fill="currentColor"/>' +
    '<path d="M12 7.5 13 11 16.5 12 13 13 12 16.5 11 13 7.5 12 11 11z" fill="#fff" fill-opacity=".7"/>',
  vault:
    '<circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-width="1.5"/>' +
    '<path d="M12 4.5A7.5 7.5 0 1 1 4.5 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
    '<circle cx="12" cy="12" r="2" fill="currentColor"/>',
  'vault-open':
    '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<circle cx="12" cy="12" r="4" fill="currentColor" fill-opacity=".9"/>',
  'vault-cancel':
    '<circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-opacity=".6" stroke-width="1.5"/>' +
    '<path d="M6.5 17.5l11-11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  ladder:
    '<rect x="2.5" y="16" width="3.4" height="5.5" rx=".6" fill="currentColor" fill-opacity=".4"/>' +
    '<rect x="7.7" y="12" width="3.4" height="9.5" rx=".6" fill="currentColor" fill-opacity=".6"/>' +
    '<rect x="12.9" y="8" width="3.4" height="13.5" rx=".6" fill="currentColor" fill-opacity=".8"/>' +
    '<rect x="18.1" y="3" width="3.4" height="18.5" rx=".6" fill="currentColor"/>',
  pool:
    '<circle cx="12" cy="8.3" r="5.2" fill="currentColor" fill-opacity=".14" stroke="currentColor" stroke-width="1.5"/>' +
    '<circle cx="8.4" cy="14.5" r="5.2" fill="currentColor" fill-opacity=".14" stroke="currentColor" stroke-width="1.5"/>' +
    '<circle cx="15.6" cy="14.5" r="5.2" fill="currentColor" fill-opacity=".14" stroke="currentColor" stroke-width="1.5"/>',
  mote: '<rect x="9.2" y="9.2" width="5.6" height="5.6" rx=".8" fill="currentColor"/><rect x="11" y="11" width="2" height="2" fill="#fff" fill-opacity=".8"/>',
  pulse:
    '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-opacity=".45" stroke-width="1.2"/>' +
    '<circle cx="12" cy="12" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
    '<circle cx="12" cy="12" r="1.8" fill="currentColor"/>',
});

export const ICON_SHAPES = Object.freeze(Object.keys(ICONS));

/**
 * Inline SVG for a shape (24×24 viewBox, scaled to `size` px, currentColor).
 * Unknown shapes fall back to the mote. The markup contains only literals
 * from this module, never caller input, so it is safe to assign to innerHTML.
 */
export function iconSvg(shape, size = 16) {
  const body = ICONS[shape] ?? ICONS.mote;
  const px = Math.max(8, Math.round(Number(size) || 16));
  return `<svg class="glyph glyph-${ICONS[shape] ? shape : 'mote'}" width="${px}" height="${px}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** Legend icon for a category (the base shape, no variant). */
export function categoryIcon(category, size = 16) {
  return iconSvg(GLYPHS[category]?.shape ?? 'mote', size);
}

/** Icon for an event, honouring variants (cancelled offers, finished escrows…). */
export function eventIcon(event, size = 16) {
  if (event?.kind === 'ledger') return iconSvg('pulse', size);
  return iconSvg(shapeFor(event), size);
}

/** The field guide in order: category, label, colour, sound, shape and the one-line track description. */
export function fieldGuide() {
  return CATEGORY_NAMES.map((name) => ({
    category: name,
    label: CATEGORIES[name].label,
    colour: CATEGORIES[name].colour,
    sound: CATEGORIES[name].sound,
    shape: GLYPHS[name].shape,
    track: GLYPHS[name].track,
  }));
}

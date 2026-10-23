// xrpl-sonic explorer — sigils.
//
// A sigil is a small generative mark derived from an address, so the same
// account is recognisable at a glance everywhere it appears: a 5×5 grid with
// left–right symmetry, a hue from the hash, drawn in the observatory's style.
// Deterministic: the same address always gives the same sigil.
//
// Pure: returns SVG markup built only from literals and hex digits.

import { hashString } from '../mapping.js';

export const SIGIL_CELLS = 5;

/** The cells (booleans, row-major, 5×5) and hue for an address. */
export function sigilPattern(address) {
  const key = String(address ?? '');
  const h1 = hashString(key);
  const h2 = hashString(`${key}:2`);
  const bits = (BigInt(h1) << 32n) | BigInt(h2);
  const cells = [];
  for (let row = 0; row < SIGIL_CELLS; row++) {
    for (let col = 0; col < SIGIL_CELLS; col++) {
      const mirrored = col > 2 ? 4 - col : col; // 3 columns decide, mirrored across the middle
      const bit = Number((bits >> BigInt(row * 3 + mirrored)) & 1n);
      cells.push(bit === 1);
    }
  }
  // Never blank: force the centre on when fewer than 5 cells are set.
  if (cells.filter(Boolean).length < 5) cells[12] = true;
  const hue = h1 % 360;
  return { cells, hue, saturation: 70, lightness: 68 };
}

/** Inline SVG for an address's sigil. `size` in px. */
export function sigilSvg(address, size = 20) {
  const { cells, hue, saturation, lightness } = sigilPattern(address);
  const px = Math.max(8, Math.round(Number(size) || 20));
  const colour = `hsl(${hue} ${saturation}% ${lightness}%)`;
  const dim = `hsl(${hue} ${saturation}% ${lightness}% / 0.18)`;
  const rects = [];
  cells.forEach((on, i) => {
    if (!on) return;
    const x = i % SIGIL_CELLS;
    const y = Math.floor(i / SIGIL_CELLS);
    rects.push(`<rect x="${x * 4 + 2}" y="${y * 4 + 2}" width="4" height="4" fill="${colour}"/>`);
  });
  return `<svg class="sigil" width="${px}" height="${px}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect width="24" height="24" rx="4" fill="${dim}"/>${rects.join('')}</svg>`;
}

/** The sigil's hue alone, without building the cells (docs/universe-requests.md, R8): the number sigilPattern() draws with, cheap enough to call per planet per ledger. */
export function sigilHue(address) {
  return hashString(String(address ?? '')) % 360;
}

/** The sigil's colour as a CSS string, for borders and rings beside it. */
export function sigilColour(address) {
  const { hue, saturation, lightness } = sigilPattern(address);
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

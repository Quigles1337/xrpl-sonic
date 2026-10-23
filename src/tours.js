// xrpl-sonic — the tours of the Learn mode (docs/ux.md, PR 2).
//
// Three short tours, each a list of steps the page walks with Next and
// Back: a sentence to show in the caption strip and the Learn panel, and
// an action for the page to take through what already exists (load a
// shipped case, start, seek the transport to an event, open the inspector,
// open the coherence drawer, turn the field on). Every sentence is taken
// from the field guide (src/glyphs.js, which the README's sound-mapping
// table is rendered from), the shipped cases' own annotations, the README
// or docs/coherence.md; the one-line card descriptions are the project's
// own sentences from src/vocabulary.js. Nothing here says "coordinated".
//
// Pure: no DOM, no network. A step's text may be a function of a context
// the page fills (the loaded case, a caption, a coherence report).

import { fieldGuide, PULSE } from './glyphs.js';
import { TERMS } from './vocabulary.js';

export const SAMPLE_CASE_URL = 'docs/cases/busiest-senders-107777809.sonic-case.json';
/** Sixteen ledgers around the sample case: enough for the guard (twelve), few enough for the public cluster's quota (docs/coherence.md, finding 9: a fifty-ledger case empties it). */
export const COHERENCE_CASE_URL = 'docs/cases/cadence-107777802-107777817.sonic-case.json';

/** README, "Cases": the sample case. */
const SAMPLE_CASE_SENTENCE = 'A sample case built from real mainnet ledgers ships with the page: the two accounts that submitted the most transactions across ledgers 107777809–107777811, each with its own voice, and annotations that state only counts taken from the ledgers.';
/** README, "Replay a ledger, with a permalink": the inspector. */
const INSPECTOR_SENTENCE = 'Click any line on the tape, or any track on the plate, to open the inspector: type and result, amount, parties (with cast labels), ledger and hash as explorer links, the voice and note that played it, whether it sounded or was drawn silent, its position in the case, and the annotations anchored to it, with Previous / Next to walk the score one event at a time.';
/** The tape's line when a case starts (src/main.js), the transport's keys. */
const KEYS_SENTENCE = 'K pauses, . steps, L loops, click a line or a track to inspect it.';
/** docs/coherence.md, "What the real data did that the synthetic trains did not predict", finding 2. */
const CADENCE_SENTENCE = 'The market maker has a three-ledger cadence. Its series matches itself at lag 3 with self-correlation 0.96 around the sample case; its lag profile against any other account alternates in sign every three lags. That is its own rhythm, not a relation, and the readout names it so the alternation is not misread.';
/** The transport's own caption at the end of a case (src/ui-transport.js). */
const END_SENTENCE = 'End of the case. ▶ plays it again; Go live returns to the stream.';

export const TOURS = Object.freeze([
  Object.freeze({ id: 'legend', name: 'The legend', line: TERMS.transactionTypes.sentence, needsCase: null }),
  Object.freeze({ id: 'payment', name: 'Follow a payment', line: INSPECTOR_SENTENCE, needsCase: SAMPLE_CASE_URL }),
  Object.freeze({ id: 'cadence', name: 'The market maker’s cadence', line: CADENCE_SENTENCE.split('. ')[0] + '.', needsCase: COHERENCE_CASE_URL }),
]);

export function tourById(id) {
  return TOURS.find((t) => t.id === id) ?? null;
}

/**
 * The steps of a tour. Each is { text, action, glyph? }: `text` a string or
 * a function of the page's context, `action` what the page does before
 * showing it ({ kind: 'none' | 'case' | 'seekEvent' | 'inspect' | 'play' |
 * 'coherence' | 'field' | 'end', ... }), `glyph` the legend tile to show.
 */
export function tourSteps(id) {
  if (id === 'legend') {
    return [
      ...fieldGuide().map((g) => ({ text: `${g.label}: ${g.sound}. ${g.track}`, action: { kind: 'none' }, glyph: { category: g.category, colour: g.colour, label: g.label } })),
      { text: `${PULSE.label}: ${PULSE.track}`, action: { kind: 'none' }, glyph: { category: 'ledger', colour: PULSE.colour, label: PULSE.label } },
    ];
  }
  if (id === 'payment') {
    return [
      { text: SAMPLE_CASE_SENTENCE, action: { kind: 'case', url: SAMPLE_CASE_URL } },
      { text: (ctx) => ctx.firstNote ?? 'The case has started.', action: { kind: 'seek', ms: 0 } },
      { text: (ctx) => (ctx.caption ? `The first payment of the window: ${ctx.caption}` : 'No payment in this window.'), action: { kind: 'seekEvent', category: 'payment' } },
      { text: INSPECTOR_SENTENCE, action: { kind: 'inspect' } },
      { text: KEYS_SENTENCE, action: { kind: 'play' } },
      { text: END_SENTENCE, action: { kind: 'end' } },
    ];
  }
  if (id === 'cadence') {
    return [
      { text: (ctx) => ctx.caseDescription ?? 'The case is loading.', action: { kind: 'case', url: COHERENCE_CASE_URL } },
      { text: (ctx) => `${CADENCE_SENTENCE}${ctx.accountsLine ? ` This window: ${ctx.accountsLine}` : ''}`, action: { kind: 'coherence' } },
      { text: TERMS.field.sentence, action: { kind: 'field' } },
      { text: END_SENTENCE, action: { kind: 'end' } },
    ];
  }
  return [];
}

/** A step's text for a context. */
export function stepText(step, ctx = {}) {
  return typeof step?.text === 'function' ? step.text(ctx) : String(step?.text ?? '');
}

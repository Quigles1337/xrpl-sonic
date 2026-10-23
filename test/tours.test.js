// The tours of the Learn mode (src/tours.js): three of them, each a list of
// steps with a sentence from the field guide, the shipped cases, the README
// or docs/coherence.md and an action the page can take; nothing says
// "coordinated".

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOURS, tourById, tourSteps, stepText, SAMPLE_CASE_URL, COHERENCE_CASE_URL } from '../src/tours.js';
import { fieldGuide } from '../src/glyphs.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('tours', () => {
  test('three tours, named, with a line and the case each needs; the cases ship with the page', () => {
    assert.deepEqual(TOURS.map((t) => t.id), ['legend', 'payment', 'cadence']);
    assert.deepEqual(TOURS.map((t) => t.name), ['The legend', 'Follow a payment', 'The market maker’s cadence']);
    for (const t of TOURS) assert.ok(t.line.length > 20);
    assert.equal(tourById('payment').needsCase, SAMPLE_CASE_URL);
    assert.equal(tourById('cadence').needsCase, COHERENCE_CASE_URL);
    assert.equal(tourById('nope'), null);
    for (const url of [SAMPLE_CASE_URL, COHERENCE_CASE_URL]) {
      const c = JSON.parse(readFileSync(join(root, url), 'utf8'));
      assert.equal(c.format, 'xrpl-sonic/case');
    }
  });

  test('the legend tour is the field guide, one step per transaction type and one for the ledger close, in the guide’s own words', () => {
    const steps = tourSteps('legend');
    const guide = fieldGuide();
    assert.equal(steps.length, guide.length + 1);
    guide.forEach((g, i) => {
      assert.equal(stepText(steps[i]), `${g.label}: ${g.sound}. ${g.track}`);
      assert.deepEqual(steps[i].glyph, { category: g.category, colour: g.colour, label: g.label });
      assert.equal(steps[i].action.kind, 'none');
    });
    assert.match(stepText(steps.at(-1)), /^Ledger close: A ring from the centre of the plate/);
  });

  test('follow a payment: the sample case, the first note, the first payment, the inspector, the keys, the end', () => {
    const steps = tourSteps('payment');
    assert.deepEqual(steps.map((s) => s.action.kind), ['case', 'seek', 'seekEvent', 'inspect', 'play', 'end']);
    assert.equal(steps[0].action.url, SAMPLE_CASE_URL);
    assert.match(stepText(steps[0]), /^A sample case built from real mainnet ledgers ships with the page/);
    assert.equal(stepText(steps[1], { firstNote: 'Ledger #107,777,809 opens the window: 84 transactions.' }), 'Ledger #107,777,809 opens the window: 84 transactions.');
    assert.equal(stepText(steps[2], { caption: 'Payment · 1 XRP' }), 'The first payment of the window: Payment · 1 XRP');
    assert.equal(stepText(steps[2], {}), 'No payment in this window.');
    assert.match(stepText(steps[3]), /^Click any line on the tape/);
    assert.equal(stepText(steps[4]), 'K pauses, . steps, L loops, click a line or a track to inspect it.');
  });

  test('the market maker’s cadence: the 50-ledger case, the finding with the window’s own accounts line, the field, the end', () => {
    const steps = tourSteps('cadence');
    assert.deepEqual(steps.map((s) => s.action.kind), ['case', 'coherence', 'field', 'end']);
    assert.equal(stepText(steps[0], { caseDescription: 'Sixteen ledgers.' }), 'Sixteen ledgers.', 'the case’s own description is the first step');
    assert.equal(stepText(steps[0], {}), 'The case is loading.');
    assert.match(COHERENCE_CASE_URL, /cadence-107777802-107777817/);
    assert.match(stepText(steps[1], {}), /^The market maker has a three-ledger cadence\./);
    assert.match(stepText(steps[1], { accountsLine: 'Sender A = r… (847 events, cadence 3 ledgers (self-correlation 0.96), AR(2))' }), / This window: Sender A = r… \(847 events, cadence 3 ledgers/);
    assert.match(stepText(steps[2]), /^The field draws what the readout says/);
    assert.deepEqual(tourSteps('nope'), []);
  });

  test('nothing in any tour says coordinated', () => {
    for (const t of TOURS) {
      assert.doesNotMatch(t.line, /coordinat/i);
      for (const s of tourSteps(t.id)) assert.doesNotMatch(stepText(s, { caption: 'x', firstNote: 'y', accountsLine: 'z' }), /coordinat/i);
    }
  });
});

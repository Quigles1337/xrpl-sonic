import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CATEGORIES, CATEGORY_NAMES, PITCH_RANGE, txToEvent } from '../src/mapping.js';
import { GLYPHS, PULSE, ICON_SHAPES, PITCH_AXIS, shapeFor, pitchPosition, hexToRgb, iconSvg, categoryIcon, eventIcon, fieldGuide } from '../src/glyphs.js';

import offerCreate from './fixtures/offercreate.json' with { type: 'json' };
import offerCancel from './fixtures/offercancel.json' with { type: 'json' };
import escrowCreate from './fixtures/escrowcreate.json' with { type: 'json' };
import escrowFinish from './fixtures/escrowfinish.json' with { type: 'json' };
import paymentXrp from './fixtures/payment-xrp-drops.json' with { type: 'json' };
import batch from './fixtures/batch.json' with { type: 'json' };

describe('field guide', () => {
  test('every category has a glyph with a shape, a motion, a lifetime scale and a description', () => {
    for (const name of CATEGORY_NAMES) {
      const g = GLYPHS[name];
      assert.ok(g, `${name} has a glyph`);
      assert.ok(ICON_SHAPES.includes(g.shape), `${name} shape ${g.shape} has an icon`);
      assert.ok(['rise', 'hover'].includes(g.motion), `${name} motion`);
      assert.ok(g.lifeScale > 0 && g.lifeScale <= 3, `${name} lifeScale`);
      assert.ok(g.track.length > 10, `${name} track description`);
    }
  });

  test('no two categories share a shape', () => {
    const shapes = CATEGORY_NAMES.map((n) => GLYPHS[n].shape);
    assert.equal(new Set(shapes).size, shapes.length);
  });

  test('no two categories share a colour', () => {
    const colours = CATEGORY_NAMES.map((n) => CATEGORIES[n].colour);
    assert.equal(new Set(colours).size, colours.length);
  });

  test('fieldGuide() lists every category in order with label, colour, sound, shape and track', () => {
    const guide = fieldGuide();
    assert.deepEqual(
      guide.map((g) => g.category),
      CATEGORY_NAMES,
    );
    for (const g of guide) {
      assert.equal(g.label, CATEGORIES[g.category].label);
      assert.equal(g.colour, CATEGORIES[g.category].colour);
      assert.equal(g.sound, CATEGORIES[g.category].sound);
      assert.equal(g.shape, GLYPHS[g.category].shape);
      assert.equal(g.track, GLYPHS[g.category].track);
    }
  });

  test('the ledger pulse has its own icon and colour', () => {
    assert.match(PULSE.colour, /^#[0-9a-f]{6}$/);
    assert.ok(ICON_SHAPES.includes(PULSE.shape));
  });
});

describe('shapeFor', () => {
  test('base shapes follow the category', () => {
    assert.equal(shapeFor(txToEvent(paymentXrp)), 'photon');
    assert.equal(shapeFor(txToEvent(offerCreate)), 'spectral');
    assert.equal(shapeFor(txToEvent(escrowCreate)), 'vault');
    assert.equal(shapeFor(txToEvent(batch)), 'bundle', 'a Batch has a glyph of its own');
    assert.match(categoryIcon('batch'), /glyph-bundle/);
    assert.match(eventIcon(txToEvent(batch)), /glyph-bundle/);
  });

  test('variants pick the cancelled and opened forms', () => {
    assert.equal(shapeFor(txToEvent(offerCancel)), 'spectral-cancel');
    assert.equal(shapeFor(txToEvent(escrowFinish)), 'vault-open');
    assert.equal(shapeFor({ category: 'escrow', variant: 'cancel' }), 'vault-cancel');
  });

  test('unknown input falls back to the mote', () => {
    assert.equal(shapeFor(null), 'mote');
    assert.equal(shapeFor({ category: 'nope' }), 'mote');
  });
});

describe('pitch axis', () => {
  test('ticks span the pitch range one octave apart, labelled with note names', () => {
    assert.equal(PITCH_AXIS.low, PITCH_RANGE.low);
    assert.equal(PITCH_AXIS.high, PITCH_RANGE.low + PITCH_RANGE.octaves * 12);
    assert.equal(PITCH_AXIS.ticks.length, PITCH_RANGE.octaves + 1);
    assert.equal(PITCH_AXIS.ticks[0].label, 'C2');
    assert.equal(PITCH_AXIS.ticks.at(-1).label, 'C7');
    for (let i = 1; i < PITCH_AXIS.ticks.length; i++) assert.equal(PITCH_AXIS.ticks[i].midi - PITCH_AXIS.ticks[i - 1].midi, 12);
  });

  test('pitchPosition maps the range onto 0..1 and clamps outside it', () => {
    assert.equal(pitchPosition(PITCH_AXIS.low), 0);
    assert.equal(pitchPosition(PITCH_AXIS.high), 1);
    assert.equal(pitchPosition(PITCH_AXIS.low + 30), 0.5);
    assert.equal(pitchPosition(0), 0);
    assert.equal(pitchPosition(200), 1);
    assert.equal(pitchPosition(undefined), 0.5);
  });

  test('a whale sits left of dust', () => {
    const msg = (Amount) => ({ type: 'transaction', engine_result: 'tesSUCCESS', validated: true, transaction: { TransactionType: 'Payment', Account: 'rAlice', Destination: 'rBob', Amount } });
    const whale = txToEvent(msg('250000000000000'));
    const dust = txToEvent(msg('12'));
    assert.ok(pitchPosition(whale.pitch) < pitchPosition(dust.pitch));
  });
});

describe('icons', () => {
  test('hexToRgb', () => {
    assert.deepEqual(hexToRgb('#4cc9f0'), [76, 201, 240]);
    assert.deepEqual(hexToRgb('#000000'), [0, 0, 0]);
    assert.deepEqual(hexToRgb('#ffffff'), [255, 255, 255]);
  });

  test('every shape renders an inline SVG that uses currentColor and carries its shape class', () => {
    for (const shape of ICON_SHAPES) {
      const markup = iconSvg(shape, 16);
      assert.match(markup, /^<svg class="glyph glyph-[a-z-]+" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">.*<\/svg>$/);
      assert.ok(markup.includes(`glyph-${shape}`), `${shape} class`);
      assert.ok(markup.includes('currentColor'), `${shape} uses currentColor`);
      assert.ok(!markup.includes('<script'), `${shape} contains no script`);
    }
  });

  test('size is rounded and never below 8', () => {
    assert.match(iconSvg('photon', 13.6), /width="14" height="14"/);
    assert.match(iconSvg('photon', 2), /width="8" height="8"/);
    assert.match(iconSvg('photon', 'x'), /width="16" height="16"/);
  });

  test('unknown shapes fall back to the mote', () => {
    assert.ok(iconSvg('nope').includes('glyph-mote'));
    assert.ok(categoryIcon('nope').includes('glyph-mote'));
  });

  test('categoryIcon and eventIcon agree for a plain event, and eventIcon honours variants', () => {
    assert.equal(categoryIcon('offer'), eventIcon(txToEvent(offerCreate)));
    assert.ok(eventIcon(txToEvent(offerCancel)).includes('glyph-spectral-cancel'));
    assert.ok(eventIcon({ kind: 'ledger' }).includes('glyph-pulse'));
  });
});

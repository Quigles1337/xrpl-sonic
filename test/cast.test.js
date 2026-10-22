import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { txToEvent, shortAddress, getScaleSteps } from '../src/mapping.js';
import { EXAMPLE_CAST, isExampleCast } from '../src/cast.js';
import {
  CAST_MAX,
  CAST_VOICE_NAMES,
  CAST_PALETTE,
  CAST_PANS,
  normalizeCast,
  castMember,
  castFor,
  castGate,
  decorateEvent,
  motifFor,
  parseCastSpec,
  formatCastSpec,
} from '../src/cast.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8'));

const A = 'rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah';
const B = 'rKNRrawfVS59C3tN1bBiUWc5wZQAfUPh7z';
const C = 'r9JYakz9YorwYEjtBcwV87TYEcYohTrtQd';
const D = 'rnHeqy9a1MxQJEYbGBXYNDosZRU7qySsAV';
const E = 'rBWr5wTBJhc5osje2PcRZkaWFcamqjnDBG';
const F = 'rnh6AcSp8JKuihKbchsvAuGyUTqEZh71mV';

describe('normalizeCast', () => {
  test('fills defaults positionally and ids are stable', () => {
    const cast = normalizeCast([{ address: A }, { address: B, label: 'Maker', voice: 'brass', pan: 0.25, colour: '#ABCDEF' }]);
    assert.equal(cast.length, 2);
    assert.deepEqual(cast[0], { id: 'c1', address: A, label: shortAddress(A), voice: CAST_VOICE_NAMES[0], pan: CAST_PANS[0], colour: CAST_PALETTE[0], solo: false, muted: false });
    assert.equal(cast[1].id, 'c2');
    assert.equal(cast[1].label, 'Maker');
    assert.equal(cast[1].voice, 'brass');
    assert.equal(cast[1].pan, 0.25);
    assert.equal(cast[1].colour, '#abcdef');
  });

  test('drops invalid and duplicate addresses, caps at CAST_MAX, clamps pan, trims labels', () => {
    const cast = normalizeCast([A, 'rNope', A, { address: B, pan: 9, label: `  ${'x'.repeat(40)}  ` }, C, D, E, F]);
    assert.equal(cast.length, CAST_MAX);
    assert.deepEqual(
      cast.map((m) => m.address),
      [A, B, C, D, E],
    );
    assert.equal(cast[1].pan, 1);
    assert.equal(cast[1].label.length, 24);
    assert.deepEqual(normalizeCast(null), []);
    assert.deepEqual(normalizeCast('x'), []);
  });

  test('castMember finds by id or address', () => {
    const cast = normalizeCast([A, B]);
    assert.equal(castMember(cast, 'c2').address, B);
    assert.equal(castMember(cast, A).id, 'c1');
    assert.equal(castMember(cast, 'c9'), null);
  });
});

describe('involvement and gating', () => {
  const payment = fixture('payment-xrp-drops');
  const sender = payment.transaction.Account;
  const dest = payment.transaction.Destination;

  test('castFor lists involved members and prefers the sender as primary', () => {
    const cast = normalizeCast([{ address: dest, label: 'Dest' }, { address: sender, label: 'Sender' }]);
    const inv = castFor(payment, cast);
    assert.deepEqual(
      inv.members.map((m) => m.label),
      ['Dest', 'Sender'],
    );
    assert.equal(inv.primary.label, 'Sender');
    const only = castFor(payment, normalizeCast([dest]));
    assert.equal(only.primary.address, dest);
    assert.deepEqual(castFor(payment, []), { members: [], primary: null });
    assert.deepEqual(castFor(null, normalizeCast([A])), { members: [], primary: null });
  });

  test('castGate: no cast plays everything; modes govern the uninvolved', () => {
    const cast = normalizeCast([A]);
    const none = { members: [], primary: null };
    assert.equal(castGate(none, [], 'hide'), 'play');
    assert.equal(castGate(none, cast, 'all'), 'play');
    assert.equal(castGate(none, cast, 'mute'), 'dim');
    assert.equal(castGate(none, cast, 'hide'), 'skip');
    assert.equal(castGate({ members: [cast[0]], primary: cast[0] }, cast, 'hide'), 'play');
  });

  test('castGate: muted members dim, soloing narrows playback to the soloed', () => {
    const cast = normalizeCast([A, B]);
    const [a, b] = cast;
    a.muted = true;
    assert.equal(castGate({ members: [a], primary: a }, cast, 'all'), 'dim');
    assert.equal(castGate({ members: [a, b], primary: a }, cast, 'all'), 'play');
    a.muted = false;
    b.solo = true;
    assert.equal(castGate({ members: [a], primary: a }, cast, 'all'), 'dim');
    assert.equal(castGate({ members: [b], primary: b }, cast, 'all'), 'play');
    assert.equal(castGate({ members: [], primary: null }, cast, 'all'), 'dim');
    assert.equal(castGate({ members: [], primary: null }, cast, 'hide'), 'skip');
  });

  test('decorateEvent gives the primary voice and pan, lists cues, keeps one event', () => {
    const cast = normalizeCast([
      { address: dest, label: 'Dest', voice: 'glass', pan: 0.5 },
      { address: sender, label: 'Sender', voice: 'reed', pan: -0.5 },
    ]);
    const ev = decorateEvent(txToEvent(payment), castFor(payment, cast));
    assert.equal(ev.voice, 'reed');
    assert.equal(ev.pan, -0.5);
    assert.equal(ev.castLabel, 'Sender');
    assert.deepEqual(ev.cast, ['c1', 'c2']);
    assert.equal(ev.primary, 'c2');
    assert.deepEqual(
      ev.cues.map((c) => c.voice),
      ['glass'],
    );
    assert.equal(ev.sound, 'pluck', 'the category voice is still recorded');
    const plain = decorateEvent(txToEvent(payment), { members: [], primary: null });
    assert.equal(plain.voice, undefined);
    assert.deepEqual(plain.cues, []);
  });
});

describe('motifFor', () => {
  test('three notes, deterministic per address, within the scale', () => {
    const m1 = motifFor(A);
    const m2 = motifFor(A);
    assert.equal(m1.length, 3);
    assert.deepEqual(m1, m2);
    assert.notDeepEqual(motifFor(A), motifFor(B));
    const steps = getScaleSteps('pentatonicMajor');
    for (const midi of m1) assert.ok(steps.includes((midi - 36) % 12), `${midi} is in C major pentatonic`);
    assert.notDeepEqual(motifFor(A, 'pentatonicMajor', 'C'), motifFor(A, 'pentatonicMajor', 'G'));
  });
});

describe('cast URL spec', () => {
  test('round-trips labels, voices and pans, omitting defaults', () => {
    const cast = normalizeCast([{ address: A }, { address: B, label: 'Market maker #2', voice: 'brass', pan: 0.25 }]);
    const spec = formatCastSpec(cast);
    assert.equal(spec, `${A},${B}~Market%20maker%20%232~brass~0.25`);
    const back = parseCastSpec(spec);
    assert.deepEqual(back.errors, []);
    assert.deepEqual(back.cast, cast);
  });

  test('reports bad addresses and ignores extras beyond the cap', () => {
    const r = parseCastSpec(`rBad,${A}~Alice,${B},${C},${D},${E},${F}`);
    assert.equal(r.cast.length, CAST_MAX);
    assert.equal(r.errors.length, 2);
    assert.match(r.errors[0], /invalid cast address/);
    assert.match(r.errors[1], /at most 5/);
    assert.deepEqual(parseCastSpec(''), { cast: [], errors: [] });
    assert.deepEqual(parseCastSpec(undefined), { cast: [], errors: [] });
  });
});

describe('the example cast (docs/ux.md)', () => {
  test('the README cast link: the maker as the brass on the left, the issuer as the glass in the centre; equality by address and order', () => {
    const cast = normalizeCast(EXAMPLE_CAST);
    assert.deepEqual(cast.map((m) => [m.label, m.voice, m.pan]), [['Maker', 'brass', -0.6], ['Issuer', 'glass', 0]]);
    assert.equal(isExampleCast(cast), true);
    assert.equal(isExampleCast(normalizeCast([EXAMPLE_CAST[1], EXAMPLE_CAST[0]])), false, 'another order is another cast');
    assert.equal(isExampleCast(normalizeCast([EXAMPLE_CAST[0]])), false);
    assert.equal(isExampleCast([]), false);
    assert.equal(isExampleCast(null), false);
    assert.equal(isExampleCast(normalizeCast([{ ...EXAMPLE_CAST[0], label: 'Renamed' }, EXAMPLE_CAST[1]])), true, 'a relabelled example is still the example');
  });
});

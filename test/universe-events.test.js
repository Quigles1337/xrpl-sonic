// UNIVERSE phase 1.5: the four verbs. Every fixture under test/universe-fixtures
// is a real recorded transaction with the events expected of it; the objects
// table is complete (a verb or none, a rule, a life, a loudness, a still);
// the showers, the weather and the primitives under reduced motion.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eventsOf, describeEvent, collapseShowers, weatherOf, bookOf, priceOf, colourOf, OBJECTS, OBJECT_NAMES, VERBS, DESIGNED_TYPES, SPARK_THRESHOLD } from '../src/universe/events.js';
import { primitivesOf, weatherPrimitives, LIFE, LOUDNESS, rockAngle, beltRadius } from '../src/universe/motions.js';
import { unwrapTransactionMessage, CATEGORIES } from '../src/mapping.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'universe-fixtures');
const fixtures = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : [];

describe('the objects table', () => {
  test('every object has a verb of the four or none, a rule, what is drawn, a still marker, a life and a loudness', () => {
    assert.deepEqual(VERBS, ['travel', 'dock', 'place', 'happen']);
    for (const name of OBJECT_NAMES) {
      const o = OBJECTS[name];
      assert.ok(o.verb === null || VERBS.includes(o.verb), `${name} verb`);
      assert.ok(typeof o.rule === 'string' && o.rule.length, `${name} rule`);
      assert.ok(typeof o.drawn === 'string' && o.drawn.length > 8, `${name} drawn`);
      assert.ok(typeof o.still === 'string' && o.still.length, `${name} still`);
      assert.ok(LIFE[name] > 0, `${name} life`);
      assert.ok(LOUDNESS[name] > 0, `${name} loudness`);
    }
    assert.equal(OBJECTS.spark.verb, null);
    assert.equal(OBJECTS.tick.verb, null);
    assert.ok(SPARK_THRESHOLD > 0 && SPARK_THRESHOLD < 0.01);
    assert.ok(DESIGNED_TYPES.includes('TrustSet') && DESIGNED_TYPES.includes('Batch'));
  });
});

describe('the fixtures: real recorded transactions and the events expected of them', () => {
  test('there are fixtures', () => {
    assert.ok(fixtures.length >= 20, `${fixtures.length} fixtures`);
  });
  for (const fx of fixtures) {
    test(`${fx.object}: ${fx.expected.map((e) => e.object).join(' + ')}`, () => {
      const messages = fx.messages ?? [fx.message];
      const all = [];
      for (const msg of messages) {
        const u = unwrapTransactionMessage(msg);
        assert.ok(u, 'the fixture is a stream message');
        assert.ok(Array.isArray(u.meta?.AffectedNodes), 'the metadata is the node’s, not hand-written');
        all.push(...eventsOf(u.tx, u.meta, { hash: u.hash, ledgerIndex: u.ledgerIndex, result: u.result }));
      }
      const events = fx.object === 'shower' ? collapseShowers(all).filter((e) => e.object === 'shower') : all;
      assert.ok(events.some((e) => e.object === fx.object), `an event of object ${fx.object}`);
      if (fx.object !== 'shower') {
        assert.equal(events.length, fx.expected.length, 'as many events as expected');
        events.forEach((e, i) => {
          const x = fx.expected[i];
          assert.equal(e.object, x.object);
          assert.equal(e.verb, x.verb);
          assert.equal(e.rule, x.rule);
          assert.equal(e.from, x.from);
          assert.equal(e.to, x.to);
          assert.deepEqual(e.via, x.via);
          assert.equal(e.at, x.at);
          assert.equal(e.label, x.label);
          assert.ok(e.label.startsWith(`${e.object}: `), 'the label names the object first');
          assert.ok(Array.isArray(e.evidence) && e.evidence.length, 'evidence fields');
          assert.ok(OBJECTS[e.object], 'the object is in the vocabulary (no zoo)');
          assert.equal(e.verb, OBJECTS[e.object].verb);
        });
      } else {
        assert.equal(events[0].detail.count, fx.expected[0].count);
        assert.equal(events[0].label, fx.expected[0].label);
      }
    });
  }
});

describe('rules on the recorded fixtures', () => {
  const by = (name) => fixtures.find((f) => f.object === name);
  const eventsFor = (fx) => {
    const u = unwrapTransactionMessage(fx.message);
    return eventsOf(u.tx, u.meta, { hash: u.hash, ledgerIndex: u.ledgerIndex, result: u.result });
  };
  test('a spark is a failed transaction and says the result', { skip: !by('spark') }, () => {
    const [e] = eventsFor(by('spark'));
    assert.equal(e.verb, null);
    assert.match(e.label, /failed with te[a-z]/);
    assert.equal(e.success, false);
  });
  test('a rocket docks at the issuer and the label reads balance of up to limit', { skip: !by('rocket') }, () => {
    const [e] = eventsFor(by('rocket'));
    assert.equal(e.verb, 'dock');
    assert.match(e.label, /^rocket: .+ set a trust line to .+, .+ of up to .+ [A-Z0-9]+$/);
    assert.equal(e.to, by('rocket').message.transaction?.LimitAmount?.issuer ?? by('rocket').message.tx_json?.LimitAmount?.issuer);
  });
  test('a partial payment says delivered X of up to Y and the delivered amount is below the asked', { skip: !by('partial') }, () => {
    const [e] = eventsFor(by('partial'));
    assert.equal(e.verb, 'travel');
    assert.match(e.label, /delivered .+ of up to .+/);
    assert.notEqual(e.detail.delivered, e.detail.asked);
  });
  test('a burn is a payment to self; a comet is to someone else', { skip: !(by('burn') && by('comet')) }, () => {
    const [b] = eventsFor(by('burn'));
    assert.equal(b.from, b.to);
    const [c] = eventsFor(by('comet'));
    assert.notEqual(c.from, c.to);
    assert.equal(c.verb, 'travel');
  });
  test('a fill carries the consumed count and its flares name the book', { skip: !by('fill') }, () => {
    const events = eventsFor(by('fill'));
    const fill = events.find((e) => e.object === 'fill');
    assert.equal(fill.verb, 'place');
    assert.ok(fill.detail.consumed >= 1 || fill.detail.amm);
    for (const f of events.filter((e) => e.object === 'flare')) assert.match(f.detail.book, /\|/);
  });
  test('a rock has a book, a host and a price', { skip: !by('rock') }, () => {
    const rock = eventsFor(by('rock')).find((e) => e.object === 'rock');
    assert.match(rock.detail.book, /\|/);
    assert.ok(rock.detail.price > 0);
    assert.ok(rock.detail.hosts.length >= 1 || rock.detail.xrp);
  });
  test('a moon capture names seller and buyer, and the broker when there was one', { skip: !by('moon-capture') }, () => {
    const [e] = eventsFor(by('moon-capture'));
    assert.ok(e.from && e.to && e.from !== e.to);
    if (e.detail.brokered) assert.equal(e.via.length, 1);
  });
  test('a tick is a Batch wrapper with its inner count', { skip: !by('tick') }, () => {
    const [e] = eventsFor(by('tick'));
    assert.equal(e.verb, null);
    assert.ok(e.detail.inner >= 1);
    assert.match(e.label, /submitted a Batch of \d+ transactions?/);
  });
});

describe('showers, weather, books, colours', () => {
  const dustOf = (from, to, hash) => ({ object: 'dust', verb: 'travel', from, to, at: from, hash, ledgerIndex: 1, category: 'payment', detail: { delivered: '0.1 XRP' }, evidence: [] });
  test('five dust payments from one sender in a ledger become one shower; four stay dust', () => {
    const five = Array.from({ length: 5 }, (_, i) => dustOf('rA', `rB${i}`, `H${i}`));
    const out = collapseShowers(five);
    assert.equal(out.length, 1);
    assert.equal(out[0].object, 'shower');
    assert.equal(out[0].detail.count, 5);
    assert.match(out[0].label, /^shower: rA sent 5 payments under one XRP/);
    assert.equal(collapseShowers(five.slice(0, 4)).length, 4);
  });
  test('the weather counts flows between clusters, streams to stars, haze on hosts, glow on planets', () => {
    const events = [
      { verb: 'travel', from: 'a', to: 'b' },
      { verb: 'travel', from: 'a', to: 'c' },
      { verb: 'travel', from: 'a', to: 'a2' },
      { verb: 'dock', from: 'x', to: 'star' },
      { verb: 'place', detail: { hosts: ['issuer'] } },
      { verb: 'happen', at: 'p' },
      { verb: null, object: 'spark', at: 'p' },
    ];
    const w = weatherOf(events, { clusterOf: (a) => (a === 'a' || a === 'a2' ? 'A' : a === 'b' || a === 'c' ? 'B' : a), kindOf: (a) => (a === 'star' ? 'star' : 'planet') });
    assert.deepEqual(w.flows, [{ a: 'A', b: 'B', n: 2 }]);
    assert.deepEqual(w.streams, [{ star: 'star', n: 1, kind: 'star' }]);
    assert.deepEqual(w.haze, [{ host: 'issuer', n: 1 }]);
    assert.deepEqual(w.glow.sort((p, q) => p.planet.localeCompare(q.planet)), [{ planet: 'a', n: 1 }, { planet: 'p', n: 2 }]);
  });
  test('a book is its two sides and its hosts; an XRP book has one host; the price is pays per gets', () => {
    const b = bookOf('1000000', { currency: 'USD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', value: '2' });
    assert.equal(b.key, 'XRP|USD/rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De');
    assert.deepEqual(b.hosts, ['rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De']);
    assert.equal(b.xrp, true);
    assert.equal(priceOf('1000000', { currency: 'USD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', value: '2' }), 2);
    const c = bookOf({ currency: 'EUR', issuer: 'rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah', value: '1' }, { currency: 'USD', issuer: 'rKNRrawfVS59C3tN1bBiUWc5wZQAfUPh7z', value: '1.1' });
    assert.deepEqual(c.hosts, ['rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah', 'rKNRrawfVS59C3tN1bBiUWc5wZQAfUPh7z']);
    assert.equal(c.xrp, false);
  });
  test('every event takes the field guide’s colour for its category; a clawback the trust colour', () => {
    assert.equal(colourOf({ category: 'payment' }), CATEGORIES.payment.colour);
    assert.equal(colourOf({ category: 'batch' }), CATEGORIES.batch.colour);
    assert.equal(colourOf({ category: 'trust', object: 'reverse-comet' }), CATEGORIES.trust.colour);
    assert.equal(colourOf({ category: 'nope' }), CATEGORIES.other.colour);
  });
  test('describeEvent takes the sky’s name rule', () => {
    const e = { object: 'comet', from: 'rA', to: 'rB', detail: { delivered: '5 XRP' } };
    assert.equal(describeEvent(e, (a) => ({ rA: 'Maker', rB: 'Issuer' })[a]), 'comet: Maker paid Issuer 5 XRP');
  });
});

describe('the motion grammar', () => {
  const screen = () => {
    const n = 8;
    const s = { x: new Float32Array(n), y: new Float32Array(n), r: new Float32Array(n), depth: new Float32Array(n) };
    for (let i = 1; i < n; i++) {
      s.x[i] = 100 + i * 60;
      s.y[i] = 200 + (i % 2) * 40;
      s.r[i] = 3 + i;
      s.depth[i] = 2;
    }
    return s;
  };
  const motion = (object, over = {}) => ({ object, verb: OBJECTS[object].verb, from: 1, to: 2, via: [3], at: 1, t: 0.5, rgb: [76, 201, 240], loud: LOUDNESS[object], width: 1.5, tail: 2, success: true, seed: 1, detail: { owner: 'rA', sequence: 7, band: 0.4, frozen: true, signers: ['a', 'b', 'c'], weights: [1, 1, 1], quorum: 2, open: true }, ...over });
  test('every object draws something in motion and something still, in screen space', () => {
    const s = screen();
    for (const name of OBJECT_NAMES) {
      for (const reduced of [false, true]) {
        const p = primitivesOf(motion(name), s, { reduced, now: 1000 });
        const n = p.lines.length + p.dots.length + p.rings.length + p.darts.length;
        const blinks = ['blink', 'check-cancel', 'moon-beacon-off', 'flare'];
        if (reduced && blinks.includes(name)) continue; // their still is nothing or a grey mark, both allowed
        assert.ok(n > 0, `${name} ${reduced ? 'still' : 'in motion'} draws ${n} primitives`);
        for (const l of p.lines) assert.ok([l.x0, l.y0, l.x1, l.y1].every(Number.isFinite), `${name} line finite`);
        for (const d of p.dots) assert.ok(Number.isFinite(d.x) && Number.isFinite(d.y) && d.r > 0, `${name} dot finite`);
      }
    }
  });
  test('a partial comet stops short of the receiver; a comet reaches it', () => {
    const s = screen();
    const reach = (name) => {
      const p = primitivesOf(motion(name, { via: [], t: 0.999 }), s, { reduced: false });
      const head = p.dots.find((d) => d.core);
      return Math.hypot(head.x - s.x[2], head.y - s.y[2]);
    };
    assert.ok(reach('partial') > reach('comet') + 5, 'the partial head stays short');
  });
  test('a rocket docks at the issuer’s orbit and never lands; a de-orbit burn leaves it', () => {
    const s = screen();
    const docked = primitivesOf(motion('rocket', { via: [], t: 0.99 }), s, { reduced: false });
    const dart = docked.darts[0];
    const d = Math.hypot(dart.x - s.x[2], dart.y - s.y[2]);
    assert.ok(d > s.r[2] * 1.5, 'docked outside the planet');
    assert.ok(docked.rings.length >= 1, 'the orbit arc lights');
    const leaving = primitivesOf(motion('deorbit', { via: [], t: 0.9 }), s, { reduced: false });
    assert.ok(Math.hypot(leaving.darts[0].x - s.x[2], leaving.darts[0].y - s.y[2]) > d, 'further from the issuer than docked');
  });
  test('rocks sit on a stable belt radius by price band; the angle is stable per owner and sequence', () => {
    assert.equal(rockAngle('rA', 7), rockAngle('rA', 7));
    assert.notEqual(rockAngle('rA', 7), rockAngle('rA', 8));
    assert.ok(beltRadius(5, 1) > beltRadius(5, 0));
  });
  test('the weather draws flows, streams, haze and glow from counts', () => {
    const p = weatherPrimitives({ flows: [{ a: 'A', b: 'B', n: 10 }], streams: [{ star: 'S', n: 3 }], haze: [{ host: 'H', n: 4 }], glow: [{ planet: 'P', n: 2 }] }, (k) => ({ A: [0, 0], B: [100, 0], S: [50, 50], H: [10, 10], P: [20, 20] })[k], { reduced: true });
    assert.ok(p.lines.length >= 4 && p.rings.length === 1 && p.dots.length === 1);
  });
});

// Universe requests, batch 1 (docs/universe-requests.md): the parts that live in
// the page and the engine rather than in one pure module. R12: the fourth door
// and the Universe link beside Explorer, read from index.html, their sentence
// taken from docs/universe.md. R9: the engine's event contract, checked
// against the engine's own source: every field the engine reads from an
// event is in EVENT_FIELDS, and nothing else is. R3, R8, R10 and R11 are
// tested beside their modules (coherence, explorer-route, mapping, ws).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EVENT_FIELDS, minimalEvent } from '../src/audio.js';
import { txToEvent } from '../src/mapping.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

describe('R12: a fourth door and a link beside Explorer, pointing at universe.html', () => {
  const html = read('index.html');

  test('the welcome overlay has a Universe door after the three mode doors, an ordinary link to universe.html, with one line cut from docs/universe.md', () => {
    const doors = [...html.matchAll(/<(button|a)[^>]*class="door"[^>]*id="door-([a-z]+)"[^>]*>/g)].map((m) => [m[2], m[1]]);
    assert.deepEqual(doors, [['listen', 'button'], ['watch', 'button'], ['learn', 'button'], ['universe', 'a']]);
    const door = html.match(/<a class="door" id="door-universe" href="([^"]+)">(.*?)<\/a>/s);
    assert.ok(door, 'the door is a link, not a mode button');
    assert.equal(door[1], 'universe.html');
    const line = door[2].match(/<span class="door-line">(.*?)<\/span>/)[1];
    assert.equal(line, 'The ledger as a sky: accounts are planets, transactions are celestial objects.');
    const spec = read('docs/universe.md');
    assert.match(spec, /the ledger is a sky: accounts are planets, transactions are celestial objects/, 'the sentence is the specification’s own, with its first words turned into a title');
    assert.match(html, /<div class="doors" role="group" aria-label="Four ways in">/);
  });

  test('the top bar carries a Universe link beside Explorer, in the same strip as every mode’s actions', () => {
    const pages = html.match(/<span class="pages">(.*?)<\/span>\s*<button id="moment"/s);
    assert.ok(pages, 'Explorer and Universe sit together before the Moment button');
    assert.match(pages[1], /<a class="btn explorer-link" href="explorer\.html"/);
    assert.match(pages[1], /<a class="btn universe-link" href="universe\.html" title="The ledger as a sky: accounts are planets, transactions are celestial objects">Universe<\/a>/);
    const css = read('src/styles.css');
    assert.match(css, /body\.mode-embed \.universe-link,/, 'the embed hides it with the Explorer link');
    assert.doesNotMatch(css, /body\[data-view="[a-z]+"\] \.universe-link/, 'no mode hides it');
    assert.doesNotMatch(css, /body\[data-view="[a-z]+"\] \.explorer-link/, 'nor the Explorer link');
  });

  test('the mode map and the README say where the door leads, and nothing else changes for it', () => {
    assert.match(read('docs/ux.md'), /A fourth door, \*\*Universe\*\*, and a link beside Explorer in every mode's top bar open the sky page, `universe\.html`/);
    assert.match(read('README.md'), /A fourth door on the welcome screen, \*\*Universe\*\*, and a link beside Explorer in every mode's top bar open the sky page, `universe\.html`/);
    const ui = read('src/ui.js');
    assert.match(ui, /querySelectorAll\('\.door\[data-view\]'\)/, 'the mode doors are bound by their view; the Universe door, a link, is not');
  });
});

describe('R9: the engine’s event contract', () => {
  const source = read('src/audio.js').split('export const EVENT_FIELDS')[0]; // the engine: everything before the contract and minimalEvent
  const listed = new Set([...EVENT_FIELDS.required, ...EVENT_FIELDS.voice, ...EVENT_FIELDS.optional]);

  test('every field the engine reads from an event is listed, and every listed field is read', () => {
    // the engine names the event `event` in play/playAt/_render and `ev` in the voices; `cue` is one of event.cues
    const reads = new Set([...source.matchAll(/\b(?:event|ev)\.([a-zA-Z_]+)/g)].map((m) => m[1]));
    assert.deepEqual([...reads].sort(), [...listed].sort());
    const cueReads = new Set([...source.matchAll(/\bcue\.([a-zA-Z_]+)/g)].map((m) => m[1]));
    assert.deepEqual([...cueReads].sort(), [...EVENT_FIELDS.cue].sort());
  });

  test('the contract is the shape the universe worker posts, less `pitch`, which the engine does not read', () => {
    const posted = ['category', 'sound', 'variant', 'pitch', 'freq', 'notes', 'velocity', 'duration', 'sub', 'timbre'];
    for (const k of posted) if (k !== 'pitch') assert.ok(listed.has(k), k);
    assert.ok(!listed.has('pitch'));
    assert.ok(!source.match(/\b(?:event|ev)\.pitch\b/));
  });

  test('minimalEvent keeps the contract’s fields of a mapped event and nothing else; the engine’s reads are covered by them', () => {
    const fixture = (name) => JSON.parse(readFileSync(join(root, 'test', 'fixtures', `${name}.json`), 'utf8'));
    const ev = txToEvent(fixture('payment-xrp-drops'));
    const min = minimalEvent({ ...ev, voice: 'marimba', pan: -0.4, cues: [{ voice: 'glass', pan: 0.3, label: 'B', extra: 1 }] });
    for (const k of Object.keys(min)) assert.ok(listed.has(k), `${k} is in the contract`);
    for (const k of EVENT_FIELDS.required) assert.ok(k in min, `${k} is kept`);
    assert.equal(min.hash, undefined);
    assert.equal(min.colour, undefined);
    assert.equal(min.pitch, undefined);
    assert.deepEqual(min.cues, [{ voice: 'glass', pan: 0.3 }]);
    assert.notEqual(min.notes, ev.notes, 'notes are copied, not shared');
    assert.deepEqual(min.notes, ev.notes);
    assert.equal(minimalEvent(null), null);
    assert.deepEqual(minimalEvent({ category: 'other', sound: 'click', velocity: 0.1, duration: 0.05 }), { category: 'other', sound: 'click', velocity: 0.1, duration: 0.05 });
  });
});

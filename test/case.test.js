import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MAPPING_VERSION } from '../src/mapping.js';
import { CASE_FORMAT, CASE_VERSION, MAX_CASE_LEDGERS, defaultCase, validateCase, caseFromState, serializeCase, encodeCase, decodeCase, caseLedgerCount, caseFilename, addAnnotation, updateAnnotation, removeAnnotation } from '../src/case.js';

const A = 'rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah';
const B = 'rKNRrawfVS59C3tN1bBiUWc5wZQAfUPh7z';
const HASH = 'A'.repeat(64);

const sample = () => ({
  format: CASE_FORMAT,
  version: CASE_VERSION,
  id: 'Sample Case!',
  title: 'A sample',
  network: 'testnet',
  clips: [{ from: 110, to: 112, label: 'second' }, '100-101'],
  cast: [{ address: A, label: 'Alice', voice: 'glass' }, B],
  filters: { enabled: { offer: false }, includeFailed: true, quietThreshold: 5, castMode: 'mute' },
  mapping: { version: MAPPING_VERSION, scale: 'dorian', key: 'F#' },
  timing: { speed: 2 },
  annotations: [
    { id: 'first', anchor: { hash: HASH.toLowerCase() }, text: 'The first thing.', source: 'me', status: 'reviewed', pause: true },
    { anchor: { ledger: 111 }, text: 'A ledger note' },
    { anchor: { timeMs: 1234.6 }, text: 'A timed note', status: 'bogus' },
  ],
});

describe('validateCase', () => {
  test('normalises a full case', () => {
    const { case: c, errors, warnings } = validateCase(sample());
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    assert.equal(c.id, 'sample-case');
    assert.equal(c.network, 'testnet');
    assert.deepEqual(c.clips, [
      { from: 100, to: 101, label: '' },
      { from: 110, to: 112, label: 'second' },
    ]);
    assert.equal(caseLedgerCount(c), 5);
    assert.equal(c.cast.length, 2);
    assert.equal(c.cast[0].label, 'Alice');
    assert.equal(c.cast[0].voice, 'glass');
    assert.equal(c.filters.enabled.offer, false);
    assert.equal(c.filters.enabled.payment, true);
    assert.equal(c.filters.includeFailed, true);
    assert.equal(c.filters.quietThreshold, 5);
    assert.equal(c.filters.castMode, 'mute');
    assert.deepEqual(c.mapping, { version: MAPPING_VERSION, scale: 'dorian', key: 'F#' });
    assert.equal(c.timing.speed, 2);
    assert.equal(c.annotations.length, 3);
    assert.deepEqual(c.annotations[0], { id: 'first', anchor: { hash: HASH }, text: 'The first thing.', source: 'me', status: 'reviewed', pause: true });
    assert.deepEqual(c.annotations[1], { id: 'a2', anchor: { ledger: 111 }, text: 'A ledger note', source: '', status: 'draft', pause: false });
    assert.deepEqual(c.annotations[2].anchor, { timeMs: 1235 });
    assert.equal(c.annotations[2].status, 'draft');
  });

  test('an unplayable case returns null with reasons; recoverable problems are errors on a usable case', () => {
    assert.equal(validateCase(null).case, null);
    assert.equal(validateCase({ format: 'other', clips: ['1'] }).case, null);
    assert.equal(validateCase({ version: 2, clips: ['1'] }).case, null);
    const empty = validateCase({ clips: [] });
    assert.equal(empty.case, null);
    assert.match(empty.errors[0], /at least one clip/);
    const big = validateCase({ clips: [`1-${MAX_CASE_LEDGERS + 1}`] });
    assert.equal(big.case, null);
    assert.match(big.errors[0], /limit is/);
    const messy = validateCase({ clips: ['5', 'x', { from: 0 }], network: 'devnet', mapping: { scale: 'nope', key: 'H' }, timing: { speed: 3 }, annotations: [{ text: 'no anchor' }, { anchor: { ledger: 5 } }] });
    assert.ok(messy.case);
    assert.deepEqual(messy.case.clips, [{ from: 5, to: 5, label: '' }]);
    assert.equal(messy.case.network, 'mainnet');
    assert.equal(messy.case.mapping.scale, 'pentatonicMajor');
    assert.equal(messy.case.timing.speed, 1);
    assert.equal(messy.case.annotations.length, 0);
    assert.ok(messy.errors.length >= 7, messy.errors.join('; '));
  });

  test('overlapping clips are an error; reversed clips are swapped and sorted', () => {
    const r = validateCase({ clips: [{ from: 10, to: 5 }, { from: 7, to: 8 }] });
    assert.ok(r.case);
    assert.match(r.errors[0], /overlap/);
    assert.deepEqual(validateCase({ clips: [{ from: 10, to: 5 }, { from: 20, to: 11 }] }).case.clips.map((c) => c.from), [5, 11]);
  });

  test('a different mapping version is a warning, not an error', () => {
    const r = validateCase({ clips: ['1'], mapping: { version: '0.9.0' } });
    assert.ok(r.case);
    assert.equal(r.case.mapping.version, '0.9.0');
    assert.deepEqual(r.errors, []);
    assert.match(r.warnings[0], /written for mapping 0\.9\.0/);
  });

  test('defaultCase has every category enabled and the current mapping version', () => {
    const c = defaultCase();
    assert.equal(c.mapping.version, MAPPING_VERSION);
    assert.ok(Object.values(c.filters.enabled).every(Boolean));
  });
});

describe('caseFromState', () => {
  test('builds a one-clip case from the page state, with the watched account as a cast of one', () => {
    const c = caseFromState({
      network: 'testnet',
      replay: { from: 7, to: 9, count: 3 },
      account: A,
      settings: { enabled: { nft: false }, includeFailed: true, quietMode: true, quietThreshold: 50, accountMode: 'hide', scale: 'blues', key: 'D' },
    });
    assert.equal(c.network, 'testnet');
    assert.deepEqual(c.clips, [{ from: 7, to: 9, label: '' }]);
    assert.equal(c.cast[0].address, A);
    assert.equal(c.cast[0].label, 'Watched');
    assert.equal(c.filters.enabled.nft, false);
    assert.equal(c.filters.quietThreshold, 50);
    assert.equal(c.filters.castMode, 'hide');
    assert.equal(c.mapping.scale, 'blues');
    assert.equal(c.id, 'ledgers-7-9');
    assert.deepEqual(validateCase(c).errors, []);
  });

  test('quiet mode off means no threshold; an explicit cast wins over the account', () => {
    const c = caseFromState({ replay: { from: 1, to: 1 }, account: A, cast: [B], settings: { quietMode: false, quietThreshold: 50 } });
    assert.equal(c.filters.quietThreshold, 0);
    assert.equal(c.cast[0].address, B);
  });
});

describe('serialisation and links', () => {
  test('serializeCase is stable and round-trips through validateCase', () => {
    const { case: c } = validateCase(sample());
    const json = serializeCase(c);
    assert.equal(json, serializeCase(validateCase(JSON.parse(json)).case));
    assert.ok(json.startsWith(`{\n  "format": "${CASE_FORMAT}",\n  "version": ${CASE_VERSION},`));
    assert.ok(!json.includes('"solo"'), 'live controls are not serialised');
  });

  test('encodeCase/decodeCase round-trip (compressed when the platform allows)', async () => {
    const { case: c } = validateCase(sample());
    const encoded = await encodeCase(c);
    assert.match(encoded, /^[zj]:[A-Za-z0-9_-]+$/);
    const back = validateCase(await decodeCase(encoded)).case;
    assert.equal(serializeCase(back), serializeCase(c));
    if (typeof globalThis.CompressionStream === 'function') {
      assert.ok(encoded.startsWith('z:'));
      assert.ok(encoded.length < serializeCase(c, { pretty: false }).length, 'compressed form is shorter than the JSON');
    }
  });

  test('decodeCase rejects junk', async () => {
    await assert.rejects(() => decodeCase('nope'), /not an encoded case/);
    await assert.rejects(() => decodeCase('x:abc'), /unknown case encoding/);
    await assert.rejects(() => decodeCase('j:!!!'));
  });

  test('caseFilename', () => {
    assert.equal(caseFilename({ id: 'my-case' }), 'my-case.sonic-case.json');
    assert.equal(caseFilename(null), 'case.sonic-case.json');
  });
});

describe('annotation editing', () => {
  test('addAnnotation returns a new validated case and the added note; the original is untouched', () => {
    const { case: c } = validateCase(sample());
    const r = addAnnotation(c, { anchor: { timeMs: 50 }, text: 'Added', pause: true });
    assert.deepEqual(r.errors, []);
    assert.equal(r.case.annotations.length, 4);
    assert.equal(r.annotation.text, 'Added');
    assert.equal(r.annotation.pause, true);
    assert.match(r.annotation.id, /^a\d+$/);
    assert.equal(c.annotations.length, 3, 'input not mutated');
    const bad = addAnnotation(c, { text: 'no anchor' });
    assert.equal(bad.case, null);
    assert.match(bad.errors[0], /needs text and an anchor/);
  });

  test('updateAnnotation patches text, status, pause and anchor; removeAnnotation drops by id', () => {
    const { case: c } = validateCase(sample());
    const u = updateAnnotation(c, 'first', { text: 'Edited', status: 'draft', pause: false, anchor: { ledger: 100 } });
    const a = u.annotations.find((x) => x.id === 'first');
    assert.equal(a.text, 'Edited');
    assert.equal(a.status, 'draft');
    assert.equal(a.pause, false);
    assert.deepEqual(a.anchor, { ledger: 100 });
    assert.equal(updateAnnotation(c, 'nope', { text: 'x' }).annotations.length, 3);
    const r = removeAnnotation(c, 'first');
    assert.deepEqual(
      r.annotations.map((x) => x.id),
      ['a2', 'a3'],
    );
    assert.equal(c.annotations.length, 3);
  });
});

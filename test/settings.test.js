import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, sanitizeSettings, loadSettings, saveSettings, mappingOptions, migrateV1, STORAGE_KEY, LEGACY_STORAGE_KEY } from '../src/settings.js';
import { sanitizeField, FIELD_MODES } from '../src/settings.js';

describe('settings', () => {
  test('sanitize returns defaults for garbage and never shares the enabled object', () => {
    const a = sanitizeSettings(null);
    const b = sanitizeSettings('nope');
    assert.deepEqual(a, b);
    assert.deepEqual(a.enabled, DEFAULT_SETTINGS.enabled);
    assert.notEqual(a.enabled, DEFAULT_SETTINGS.enabled);
    a.enabled.payment = false;
    assert.equal(DEFAULT_SETTINGS.enabled.payment, true);
  });

  test('sanitize merges valid fields and rejects invalid ones', () => {
    const s = sanitizeSettings({
      network: 'testnet',
      volume: 1.7,
      muted: 'yes',
      scale: 'blues',
      key: 'H',
      quietMode: true,
      quietThreshold: -5,
      enabled: { offer: false, bogus: false, nft: 'no' },
      showLog: false,
    });
    assert.equal(s.network, 'testnet');
    assert.equal(s.volume, 1);
    assert.equal(s.muted, false);
    assert.equal(s.scale, 'blues');
    assert.equal(s.key, 'C');
    assert.equal(s.quietMode, true);
    assert.equal(s.quietThreshold, DEFAULT_SETTINGS.quietThreshold);
    assert.equal(s.enabled.offer, false);
    assert.equal(s.enabled.nft, true);
    assert.equal('bogus' in s.enabled, false);
    assert.equal(s.showLog, false);
  });

  test('load/save round-trip through localStorage, tolerating a throwing store', () => {
    const backing = new Map();
    globalThis.localStorage = {
      getItem: (k) => (backing.has(k) ? backing.get(k) : null),
      setItem: (k, v) => backing.set(k, String(v)),
    };
    try {
      assert.deepEqual(loadSettings(), sanitizeSettings(null));
      assert.equal(saveSettings({ key: 'G', volume: 0.3, enabled: { trust: false } }), true);
      assert.ok(backing.has(STORAGE_KEY));
      const loaded = loadSettings();
      assert.equal(loaded.key, 'G');
      assert.equal(loaded.volume, 0.3);
      assert.equal(loaded.enabled.trust, false);
      backing.set(STORAGE_KEY, '{broken');
      assert.deepEqual(loadSettings(), sanitizeSettings(null));

      globalThis.localStorage = {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
      };
      assert.deepEqual(loadSettings(), sanitizeSettings(null));
      assert.equal(saveSettings({}), false);
    } finally {
      delete globalThis.localStorage;
    }
  });

  test('cast mode and explorer are validated; the cast is normalised and its live controls are not persisted', () => {
    const addr = 'rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah';
    const s = sanitizeSettings({ castMode: 'hide', explorer: 'bithomp', account: addr, cast: [{ address: addr, label: 'Alice', voice: 'glass', solo: true, muted: true }, 'rNope'] });
    assert.equal(s.castMode, 'hide');
    assert.equal(s.explorer, 'bithomp');
    assert.equal('account' in s, false, 'the old single watched account is never persisted');
    assert.equal(s.cast.length, 1);
    assert.equal(s.cast[0].label, 'Alice');
    assert.equal(s.cast[0].voice, 'glass');
    assert.equal(s.cast[0].solo, false);
    assert.equal(s.cast[0].muted, false);
    const bad = sanitizeSettings({ castMode: 'loud', explorer: 'etherscan', cast: 'nope' });
    assert.equal(bad.castMode, 'all');
    assert.equal(bad.explorer, 'sonic', "an unknown explorer falls back to this site's own");
    assert.equal(sanitizeSettings({ explorer: 'xrpscan' }).explorer, 'xrpscan', 'XRPScan chosen in this build is kept');
    assert.deepEqual(bad.cast, []);
    assert.equal(sanitizeSettings({ accountMode: 'mute' }).castMode, 'mute', 'the key from before the cast existed is still read');
  });

  test('settings stored by builds whose default explorer was XRPScan are read once: a stored XRPScan was the default, another choice is kept', () => {
    assert.equal(migrateV1({ explorer: 'xrpscan', key: 'G' }).explorer, undefined);
    assert.equal(migrateV1({ explorer: 'xrpscan', key: 'G' }).key, 'G');
    assert.equal(migrateV1({ explorer: 'bithomp' }).explorer, 'bithomp');
    assert.equal(migrateV1(null), null);
    const backing = new Map();
    globalThis.localStorage = {
      getItem: (k) => (backing.has(k) ? backing.get(k) : null),
      setItem: (k, v) => backing.set(k, String(v)),
    };
    try {
      backing.set(LEGACY_STORAGE_KEY, JSON.stringify({ explorer: 'xrpscan', key: 'G', network: 'testnet' }));
      let loaded = loadSettings();
      assert.equal(loaded.explorer, 'sonic');
      assert.equal(loaded.key, 'G');
      assert.equal(loaded.network, 'testnet', 'everything else carries over');
      backing.set(LEGACY_STORAGE_KEY, JSON.stringify({ explorer: 'bithomp' }));
      assert.equal(loadSettings().explorer, 'bithomp');
      assert.equal(saveSettings({ explorer: 'xrpscan' }), true);
      assert.ok(backing.has(STORAGE_KEY));
      assert.equal(loadSettings().explorer, 'xrpscan', 'a v2 entry is read as stored and wins over the legacy one');
      assert.ok(backing.has(LEGACY_STORAGE_KEY), 'the legacy entry is left for older builds');
    } finally {
      delete globalThis.localStorage;
    }
  });

  test('caption, speech and pause-at-notes toggles are booleans with sensible defaults', () => {
    const d = sanitizeSettings(null);
    assert.equal(d.captions, true);
    assert.equal(d.speak, false);
    assert.equal(d.pauseAtNotes, true);
    const s = sanitizeSettings({ captions: false, speak: true, pauseAtNotes: 'yes' });
    assert.equal(s.captions, false);
    assert.equal(s.speak, true);
    assert.equal(s.pauseAtNotes, true);
  });

  test('mappingOptions applies the quiet threshold only in quiet mode', () => {
    const base = sanitizeSettings({ quietThreshold: 250 });
    assert.equal(mappingOptions(base).quietThreshold, 0);
    assert.equal(mappingOptions({ ...base, quietMode: true }).quietThreshold, 250);
    assert.equal(mappingOptions(base).scale, base.scale);
    assert.equal(mappingOptions(base).enabled, base.enabled);
  });
});

describe('settings: the interference field (phase 2)', () => {
  test('off by default; a known mode; pair mode needs two distinct valid addresses or falls back to cast', () => {
    assert.deepEqual(FIELD_MODES, ['off', 'cast', 'pair']);
    assert.deepEqual(sanitizeSettings(null).field, { mode: 'off', pair: null });
    assert.deepEqual(sanitizeField({ mode: 'cast' }), { mode: 'cast', pair: null });
    assert.deepEqual(sanitizeField({ mode: 'bogus' }), { mode: 'off', pair: null });
    const a = 'rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah';
    const b = 'rKYdJJLAgxbJcn9Ria2X5jMMiqP91r4qy';
    assert.deepEqual(sanitizeField({ mode: 'pair', pair: [a, b] }), { mode: 'pair', pair: [a, b] });
    assert.deepEqual(sanitizeField({ mode: 'pair', pair: [a, a] }), { mode: 'cast', pair: null }, 'the same address twice is no pair');
    assert.deepEqual(sanitizeField({ mode: 'pair', pair: [a, 'nope'] }), { mode: 'cast', pair: null });
    assert.deepEqual(sanitizeField({ mode: 'pair' }), { mode: 'cast', pair: null });
    assert.deepEqual(sanitizeSettings({ field: { mode: 'pair', pair: [a, b] } }).field, { mode: 'pair', pair: [a, b] });
    assert.equal(sanitizeSettings({ field: 'cast' }).field.mode, 'off', 'not an object');
  });
});

describe('settings: the view (docs/ux.md, PR 2)', () => {
  test('listen by default; watch and learn are kept; anything else is listen', () => {
    assert.equal(sanitizeSettings(null).view, 'listen');
    assert.equal(sanitizeSettings({ view: 'watch' }).view, 'watch');
    assert.equal(sanitizeSettings({ view: 'learn' }).view, 'learn');
    assert.equal(sanitizeSettings({ view: 'overlay' }).view, 'listen');
  });
});

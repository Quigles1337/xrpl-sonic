import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, sanitizeSettings, loadSettings, saveSettings, mappingOptions, STORAGE_KEY } from '../src/settings.js';

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

  test('mappingOptions applies the quiet threshold only in quiet mode', () => {
    const base = sanitizeSettings({ quietThreshold: 250 });
    assert.equal(mappingOptions(base).quietThreshold, 0);
    assert.equal(mappingOptions({ ...base, quietMode: true }).quietThreshold, 250);
    assert.equal(mappingOptions(base).scale, base.scale);
    assert.equal(mappingOptions(base).enabled, base.enabled);
  });
});

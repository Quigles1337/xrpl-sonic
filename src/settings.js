// xrpl-sonic — settings persistence (localStorage, guarded).

import { CATEGORY_NAMES, SCALES, KEYS } from './mapping.js';

export const STORAGE_KEY = 'xrpl-sonic:settings:v1';

export const DEFAULT_SETTINGS = Object.freeze({
  network: 'mainnet',
  volume: 0.8,
  muted: false,
  scale: 'pentatonicMajor',
  key: 'C',
  quietMode: false,
  quietThreshold: 100,
  includeFailed: false,
  enabled: Object.freeze(Object.fromEntries(CATEGORY_NAMES.map((c) => [c, true]))),
  showLog: true,
});

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Validate and coerce a partial settings object onto the defaults. */
export function sanitizeSettings(input) {
  const s = { ...DEFAULT_SETTINGS, enabled: { ...DEFAULT_SETTINGS.enabled } };
  if (!input || typeof input !== 'object') return s;
  if (input.network === 'mainnet' || input.network === 'testnet') s.network = input.network;
  const vol = Number(input.volume);
  if (Number.isFinite(vol)) s.volume = Math.min(1, Math.max(0, vol));
  if (typeof input.muted === 'boolean') s.muted = input.muted;
  if (typeof input.scale === 'string' && SCALES[input.scale]) s.scale = input.scale;
  if (typeof input.key === 'string' && KEYS.includes(input.key)) s.key = input.key;
  if (typeof input.quietMode === 'boolean') s.quietMode = input.quietMode;
  const qt = Number(input.quietThreshold);
  if (Number.isFinite(qt) && qt >= 0) s.quietThreshold = qt;
  if (typeof input.includeFailed === 'boolean') s.includeFailed = input.includeFailed;
  if (input.enabled && typeof input.enabled === 'object') {
    for (const c of CATEGORY_NAMES) {
      if (typeof input.enabled[c] === 'boolean') s.enabled[c] = input.enabled[c];
    }
  }
  if (typeof input.showLog === 'boolean') s.showLog = input.showLog;
  return s;
}

export function loadSettings() {
  const store = storage();
  if (!store) return sanitizeSettings(null);
  try {
    const raw = store.getItem(STORAGE_KEY);
    return sanitizeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeSettings(null);
  }
}

export function saveSettings(settings) {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(sanitizeSettings(settings)));
    return true;
  } catch {
    return false;
  }
}

/** Options object for mapping.txToEvent derived from settings. */
export function mappingOptions(settings) {
  return {
    scale: settings.scale,
    key: settings.key,
    enabled: settings.enabled,
    quietThreshold: settings.quietMode ? settings.quietThreshold : 0,
    includeFailed: settings.includeFailed,
  };
}

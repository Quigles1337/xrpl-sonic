// xrpl-sonic — settings persistence (localStorage, guarded).

import { CATEGORY_NAMES, SCALES, KEYS } from './mapping.js';
import { EXPLORERS, DEFAULT_EXPLORER } from './explorers.js';
import { normalizeCast, CAST_MODES } from './cast.js';
import { normalizeGeigerConfig, GEIGER_DEFAULTS } from './geiger.js';

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
  captions: true, // text equivalent of annotations, gaps and cast events during a case
  speak: false, // read annotations aloud (Web Speech), independent of the sound
  pauseAtNotes: true, // honour annotations that ask the transport to pause
  exposure: false, // long-exposure plate: a fading trace of where tracks landed
  geiger: Object.freeze({ enabled: false, ...GEIGER_DEFAULTS }), // the detector (src/geiger.js)
  health: Object.freeze({ poll: false, sound: false }), // observed fee pressure (src/health.js)
  midiOutput: '', // name of the preferred live MIDI output, re-selected after Connect
  cast: Object.freeze([]), // followed accounts (src/cast.js); solo and mute are live controls and are not persisted
  castMode: 'all', // transactions that involve nobody in the cast: 'all' (play) | 'mute' (dim, silent) | 'hide'
  explorer: DEFAULT_EXPLORER,
});

/** @deprecated The cast replaced the single watched account; CAST_MODES in src/cast.js is the source. */
export const ACCOUNT_MODES = CAST_MODES;

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Validate and coerce a partial settings object onto the defaults. */
export function sanitizeSettings(input) {
  const s = { ...DEFAULT_SETTINGS, enabled: { ...DEFAULT_SETTINGS.enabled }, cast: [], geiger: { ...DEFAULT_SETTINGS.geiger }, health: { ...DEFAULT_SETTINGS.health } };
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
  for (const k of ['captions', 'speak', 'pauseAtNotes', 'exposure']) if (typeof input[k] === 'boolean') s[k] = input[k];
  s.geiger = { enabled: input.geiger?.enabled === true, ...normalizeGeigerConfig(input.geiger) };
  s.health = { poll: input.health?.poll === true, sound: input.health?.sound === true };
  if (typeof input.midiOutput === 'string') s.midiOutput = input.midiOutput.slice(0, 120);
  const mode = input.castMode ?? input.accountMode; // accountMode: the key from before the cast existed
  if (typeof mode === 'string' && CAST_MODES[mode]) s.castMode = mode;
  s.cast = normalizeCast(input.cast).map((m) => ({ ...m, solo: false, muted: false }));
  if (typeof input.explorer === 'string' && EXPLORERS[input.explorer]) s.explorer = input.explorer;
  // `account` (the single watched address of older builds) is not persisted; the cast lives here and in the URL hash.
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

// xrpl-sonic — the case file.
//
// A case is a small, versioned description of something worth listening to:
// which network, which ledger windows (clips), which accounts form the cast,
// which filters and mapping were used, how fast to play it, and what the
// author wants to say about particular moments (annotations). A case plus the
// ledgers it names produces a score (src/score.js); the same case always yields
// the same score, which is what makes a shared listening reproducible.
//
// Pure: no DOM. See docs/case-format.md for the format.

import { CATEGORY_NAMES, SCALES, KEYS, MAPPING_VERSION } from './mapping.js';
import { MAX_REPLAY_LEDGERS, REPLAY_SPEEDS, parseReplayRange, formatReplayRange } from './replay.js';
import { normalizeCast, CAST_MODES } from './cast.js';
import { normalizeGeigerConfig } from './geiger.js';

export const CASE_FORMAT = 'xrpl-sonic/case';
export const CASE_VERSION = 1;
export const MAX_CASE_LEDGERS = MAX_REPLAY_LEDGERS;
export const MAX_ANNOTATIONS = 200;
export const MAX_ANNOTATION_CHARS = 500;
export const ANNOTATION_STATUSES = Object.freeze(['draft', 'reviewed']);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}

function slug(value, fallback) {
  const s = cleanText(value, 64)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}

export function defaultCase() {
  return {
    format: CASE_FORMAT,
    version: CASE_VERSION,
    id: 'untitled',
    title: '',
    description: '',
    network: 'mainnet',
    clips: [],
    cast: [],
    filters: {
      enabled: Object.fromEntries(CATEGORY_NAMES.map((c) => [c, true])),
      includeFailed: false,
      quietThreshold: 0,
      castMode: 'all',
    },
    mapping: { version: MAPPING_VERSION, scale: 'pentatonicMajor', key: 'C' },
    timing: { speed: 1 },
    annotations: [],
    geiger: null, // optional: { enabled, window, threshold, minCount, adapt, baseline? }
  };
}

/** Number of ledgers a case plays, across all clips. */
export function caseLedgerCount(c) {
  return (c?.clips ?? []).reduce((n, clip) => n + (clip.to - clip.from + 1), 0);
}

function normalizeClips(input, errors) {
  const clips = [];
  if (!Array.isArray(input)) {
    if (input != null) errors.push('clips must be an array of { from, to }');
    return clips;
  }
  for (const raw of input) {
    let from;
    let to;
    let label = '';
    if (typeof raw === 'string' || typeof raw === 'number') {
      const r = parseReplayRange(String(raw), Number.MAX_SAFE_INTEGER);
      if (!r) {
        errors.push(`clip "${String(raw).slice(0, 24)}" is not a ledger index or range`);
        continue;
      }
      ({ from, to } = r);
    } else if (raw && typeof raw === 'object') {
      from = Number(raw.from);
      to = raw.to == null ? from : Number(raw.to);
      label = cleanText(raw.label, 64);
    } else {
      errors.push('clip entries must be objects or ranges');
      continue;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to <= 0) {
      errors.push('clip ledger indices must be positive integers');
      continue;
    }
    if (to < from) [from, to] = [to, from];
    clips.push({ from, to, label });
  }
  clips.sort((a, b) => a.from - b.from);
  for (let i = 1; i < clips.length; i++) {
    if (clips[i].from <= clips[i - 1].to) {
      errors.push(`clips overlap: ${formatReplayRange(clips[i - 1])} and ${formatReplayRange(clips[i])}`);
      break;
    }
  }
  return clips;
}

function normalizeFilters(input, base) {
  const f = { ...base, enabled: { ...base.enabled } };
  if (!input || typeof input !== 'object') return f;
  if (input.enabled && typeof input.enabled === 'object') {
    for (const c of CATEGORY_NAMES) if (typeof input.enabled[c] === 'boolean') f.enabled[c] = input.enabled[c];
  }
  if (typeof input.includeFailed === 'boolean') f.includeFailed = input.includeFailed;
  const qt = Number(input.quietThreshold);
  if (Number.isFinite(qt) && qt >= 0) f.quietThreshold = qt;
  if (typeof input.castMode === 'string' && CAST_MODES[input.castMode]) f.castMode = input.castMode;
  return f;
}

/** The detector settings a case carries, with an optional pinned baseline ({ window, pinnedAt, series }). */
function normalizeGeiger(input, errors) {
  if (input == null) return null;
  if (typeof input !== 'object') {
    errors.push('geiger must be an object');
    return null;
  }
  const g = { enabled: input.enabled === true, ...normalizeGeigerConfig(input) };
  const b = input.baseline;
  if (b && typeof b === 'object' && b.series && typeof b.series === 'object') {
    const series = {};
    for (const [id, s] of Object.entries(b.series)) {
      const mean = Number(s?.mean);
      const sd = Number(s?.sd);
      if (/^[a-z0-9:]{1,64}$/i.test(id) && Number.isFinite(mean) && Number.isFinite(sd) && sd >= 0) series[id] = { mean, sd, n: Number.isFinite(Number(s?.n)) ? Number(s.n) : 0 };
    }
    g.baseline = { window: normalizeGeigerConfig({ window: b.window }).window, pinnedAt: Number.isInteger(Number(b.pinnedAt)) ? Number(b.pinnedAt) : null, series };
  } else if (b != null) {
    errors.push('geiger.baseline must be { window, pinnedAt, series }');
  }
  return g;
}

function normalizeAnnotations(input, errors) {
  const out = [];
  if (!Array.isArray(input)) {
    if (input != null) errors.push('annotations must be an array');
    return out;
  }
  const ids = new Set();
  for (const raw of input) {
    if (out.length >= MAX_ANNOTATIONS) {
      errors.push(`at most ${MAX_ANNOTATIONS} annotations are kept`);
      break;
    }
    if (!raw || typeof raw !== 'object') continue;
    const text = cleanText(raw.text, MAX_ANNOTATION_CHARS);
    if (!text) {
      errors.push('an annotation without text was dropped');
      continue;
    }
    const a = raw.anchor && typeof raw.anchor === 'object' ? raw.anchor : {};
    const anchor = {};
    if (typeof a.hash === 'string' && /^[0-9A-F]{64}$/i.test(a.hash)) anchor.hash = a.hash.toUpperCase();
    if (Number.isInteger(Number(a.ledger)) && Number(a.ledger) > 0) anchor.ledger = Number(a.ledger);
    if (Number.isFinite(Number(a.timeMs)) && Number(a.timeMs) >= 0) anchor.timeMs = Math.round(Number(a.timeMs));
    if (!('hash' in anchor) && !('ledger' in anchor) && !('timeMs' in anchor)) {
      errors.push(`annotation "${text.slice(0, 24)}…" has no usable anchor (hash, ledger or timeMs)`);
      continue;
    }
    let id = slug(raw.id, '');
    if (!id || ids.has(id)) id = `a${out.length + 1}`;
    ids.add(id);
    out.push({
      id,
      anchor,
      text,
      source: cleanText(raw.source, 120),
      status: ANNOTATION_STATUSES.includes(raw.status) ? raw.status : 'draft',
      pause: raw.pause === true,
    });
  }
  return out;
}

/**
 * Validate and normalise a case. Returns the normalised case (or null when it
 * cannot be used at all), a list of errors (things that were dropped or make
 * the case unplayable) and warnings (things to know about, like a mapping
 * version other than this build's).
 * @returns {{ case: object|null, errors: string[], warnings: string[] }}
 */
export function validateCase(input) {
  const errors = [];
  const warnings = [];
  const base = defaultCase();
  if (!input || typeof input !== 'object') return { case: null, errors: ['not a case object'], warnings };
  if (input.format != null && input.format !== CASE_FORMAT) errors.push(`format must be "${CASE_FORMAT}"`);
  const version = Number(input.version ?? CASE_VERSION);
  if (version !== CASE_VERSION) errors.push(`unsupported case version ${String(input.version)} (this build reads ${CASE_VERSION})`);
  const c = {
    ...base,
    id: slug(input.id, base.id),
    title: cleanText(input.title, 120),
    description: cleanText(input.description, 2000),
    network: input.network === 'testnet' ? 'testnet' : 'mainnet',
    clips: normalizeClips(input.clips, errors),
    cast: normalizeCast(input.cast),
    filters: normalizeFilters(input.filters, base.filters),
    mapping: { ...base.mapping },
    timing: { ...base.timing },
    annotations: normalizeAnnotations(input.annotations, errors),
    geiger: normalizeGeiger(input.geiger, errors),
  };
  if (input.network != null && input.network !== 'mainnet' && input.network !== 'testnet') errors.push(`unknown network "${String(input.network).slice(0, 16)}"; using mainnet`);
  if (Array.isArray(input.cast) && input.cast.length > c.cast.length) warnings.push(`${input.cast.length - c.cast.length} cast entries were invalid, duplicates or beyond the limit and were dropped`);
  const m = input.mapping && typeof input.mapping === 'object' ? input.mapping : {};
  if (typeof m.scale === 'string' && SCALES[m.scale]) c.mapping.scale = m.scale;
  else if (m.scale != null) errors.push(`unknown scale "${String(m.scale).slice(0, 24)}"`);
  if (typeof m.key === 'string' && KEYS.includes(m.key)) c.mapping.key = m.key;
  else if (m.key != null) errors.push(`unknown key "${String(m.key).slice(0, 8)}"`);
  if (typeof m.version === 'string' && m.version) {
    c.mapping.version = m.version;
    if (m.version !== MAPPING_VERSION) warnings.push(`case was written for mapping ${m.version}; this build uses ${MAPPING_VERSION}, so some notes or voices may differ`);
  }
  const t = input.timing && typeof input.timing === 'object' ? input.timing : {};
  const speed = Number(t.speed);
  if (REPLAY_SPEEDS.includes(speed)) c.timing.speed = speed;
  else if (t.speed != null) errors.push(`speed must be one of ${REPLAY_SPEEDS.join(', ')}`);
  const count = caseLedgerCount(c);
  if (count === 0) errors.push('a case needs at least one clip');
  if (count > MAX_CASE_LEDGERS) errors.push(`case covers ${count} ledgers; the limit is ${MAX_CASE_LEDGERS}`);
  const unplayable = errors.some((e) => /^(format|unsupported|a case needs|case covers)/.test(e));
  return { case: unplayable ? null : c, errors, warnings };
}

/** Build a case from the live page state, for sharing what is playing now. */
export function caseFromState({ network = 'mainnet', replay = null, account = '', cast = [], settings = {}, title = '' } = {}) {
  const c = defaultCase();
  c.network = network === 'testnet' ? 'testnet' : 'mainnet';
  if (replay && Number.isInteger(replay.from) && Number.isInteger(replay.to)) c.clips = [{ from: replay.from, to: replay.to, label: '' }];
  const members = Array.isArray(cast) && cast.length ? cast : account ? [{ address: account, label: 'Watched' }] : [];
  c.cast = normalizeCast(members);
  if (settings.enabled) for (const k of CATEGORY_NAMES) if (typeof settings.enabled[k] === 'boolean') c.filters.enabled[k] = settings.enabled[k];
  if (typeof settings.includeFailed === 'boolean') c.filters.includeFailed = settings.includeFailed;
  if (settings.quietMode && Number.isFinite(Number(settings.quietThreshold))) c.filters.quietThreshold = Math.max(0, Number(settings.quietThreshold));
  if (typeof settings.accountMode === 'string' && CAST_MODES[settings.accountMode]) c.filters.castMode = settings.accountMode;
  if (typeof settings.scale === 'string' && SCALES[settings.scale]) c.mapping.scale = settings.scale;
  if (typeof settings.key === 'string' && KEYS.includes(settings.key)) c.mapping.key = settings.key;
  c.title = cleanText(title, 120);
  c.id = slug(title, c.clips.length ? `ledgers-${formatReplayRange(c.clips[0])}` : 'live');
  return c;
}

/** Stable JSON with a fixed key order, for files and for hashing. */
export function serializeCase(c, { pretty = true } = {}) {
  const ordered = {
    format: CASE_FORMAT,
    version: CASE_VERSION,
    id: c.id,
    title: c.title,
    description: c.description,
    network: c.network,
    clips: c.clips.map((clip) => (clip.label ? { from: clip.from, to: clip.to, label: clip.label } : { from: clip.from, to: clip.to })),
    cast: c.cast.map((m) => ({ address: m.address, label: m.label, voice: m.voice, pan: m.pan, colour: m.colour })),
    filters: c.filters,
    mapping: c.mapping,
    timing: c.timing,
    annotations: c.annotations,
  };
  if (c.geiger) ordered.geiger = c.geiger;
  return JSON.stringify(ordered, null, pretty ? 2 : 0);
}

// ---------------------------------------------------------------------------
// URL encoding: `#case=z:<base64url deflate-raw JSON>` when the platform has
// CompressionStream, otherwise `j:<base64url JSON>`. Both decode everywhere.
// ---------------------------------------------------------------------------

function bytesToBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function pipeBytes(bytes, Transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(new Transform('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeCase(c) {
  const json = serializeCase(c, { pretty: false });
  const bytes = new TextEncoder().encode(json);
  if (typeof globalThis.CompressionStream === 'function') {
    try {
      return `z:${bytesToBase64Url(await pipeBytes(bytes, globalThis.CompressionStream))}`;
    } catch {
      /* fall through to the plain form */
    }
  }
  return `j:${bytesToBase64Url(bytes)}`;
}

/** Decode a `#case=` value into a raw object (not yet validated). Throws on malformed input. */
export async function decodeCase(str) {
  if (typeof str !== 'string' || str.length < 3 || str[1] !== ':') throw new Error('not an encoded case');
  const kind = str[0];
  let bytes = base64UrlToBytes(str.slice(2));
  if (kind === 'z') {
    if (typeof globalThis.DecompressionStream !== 'function') throw new Error('this browser cannot decompress a case link');
    bytes = await pipeBytes(bytes, globalThis.DecompressionStream);
  } else if (kind !== 'j') {
    throw new Error('unknown case encoding');
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

// ---------------------------------------------------------------------------
// Annotation editing: each returns a new, validated case (never mutates).
// ---------------------------------------------------------------------------

function fresh(c) {
  return validateCase(JSON.parse(serializeCase(c))).case;
}

/** Add an annotation; a missing id is generated. Returns { case, annotation } or { case: null, errors } when it was dropped. */
export function addAnnotation(c, annotation) {
  const before = new Set((c.annotations ?? []).map((a) => a.id));
  const next = fresh({ ...c, annotations: [...(c.annotations ?? []), annotation] });
  const added = next?.annotations.find((a) => !before.has(a.id)) ?? null;
  if (!next || !added) return { case: null, annotation: null, errors: ['the note was dropped: it needs text and an anchor (hash, ledger or timeMs)'] };
  return { case: next, annotation: added, errors: [] };
}

/** Patch an annotation's text, source, status, pause or anchor. */
export function updateAnnotation(c, id, patch) {
  const annotations = (c.annotations ?? []).map((a) => (a.id === id ? { ...a, ...patch, id } : a));
  const next = fresh({ ...c, annotations });
  return next ?? c;
}

export function removeAnnotation(c, id) {
  const next = fresh({ ...c, annotations: (c.annotations ?? []).filter((a) => a.id !== id) });
  return next ?? c;
}

/** File name for a case download. */
export function caseFilename(c) {
  return `${slug(c?.id, 'case')}.sonic-case.json`;
}

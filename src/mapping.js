// xrpl-sonic — pure mapping layer.
//
// Turns an XRPL `transactions`-stream message into a sound/visual event, and a
// `ledgerClosed` message into a ledger event. This module has NO DOM and NO
// Web Audio imports so it can be unit-tested with plain `node --test`.

export const RIPPLE_EPOCH_OFFSET = 946684800; // seconds between 1970-01-01 and 2000-01-01
export const DROPS_PER_XRP = 1_000_000;

/** Amount (in XRP) at or above which a payment also triggers the sub-bass thump. */
export const WHALE_THRESHOLD_XRP = 100_000;

/**
 * Sound/visual categories. Every transaction type maps to exactly one.
 * `sound` names the synth voice in src/audio.js; `colour` is the particle colour.
 */
export const CATEGORIES = Object.freeze({
  payment: Object.freeze({ label: 'Payment', colour: '#4cc9f0', sound: 'pluck' }),
  offer: Object.freeze({ label: 'DEX offer', colour: '#f9c74f', sound: 'hat' }),
  trust: Object.freeze({ label: 'Trust line', colour: '#90be6d', sound: 'pad' }),
  nft: Object.freeze({ label: 'NFT', colour: '#f72585', sound: 'bell' }),
  escrow: Object.freeze({ label: 'Escrow', colour: '#b5179e', sound: 'swell' }),
  paychan: Object.freeze({ label: 'Payment channel', colour: '#f3722c', sound: 'arp' }),
  amm: Object.freeze({ label: 'AMM', colour: '#43aa8b', sound: 'chord' }),
  other: Object.freeze({ label: 'Other', colour: '#8d99ae', sound: 'click' }),
});

export const CATEGORY_NAMES = Object.freeze(Object.keys(CATEGORIES));

/** Musical scales as semitone steps from the root. */
export const SCALES = Object.freeze({
  pentatonicMajor: Object.freeze({ label: 'Major pentatonic', steps: [0, 2, 4, 7, 9] }),
  pentatonicMinor: Object.freeze({ label: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] }),
  major: Object.freeze({ label: 'Major', steps: [0, 2, 4, 5, 7, 9, 11] }),
  dorian: Object.freeze({ label: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] }),
  lydian: Object.freeze({ label: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11] }),
  blues: Object.freeze({ label: 'Blues', steps: [0, 3, 5, 6, 7, 10] }),
  hirajoshi: Object.freeze({ label: 'Hirajoshi', steps: [0, 2, 3, 7, 8] }),
  wholeTone: Object.freeze({ label: 'Whole tone', steps: [0, 2, 4, 6, 8, 10] }),
});

export const KEYS = Object.freeze(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']);

/** MIDI range the amount→pitch mapping spans (C2 .. C7, five octaves). */
export const PITCH_RANGE = Object.freeze({ low: 36, octaves: 5 });

/** log10(XRP) range: one drop (1e-6 XRP) up to 100 million XRP. */
export const LOG_RANGE = Object.freeze({ min: -6, max: 8 });

/** Used when a transaction carries no XRP amount (roughly a 10 XRP pitch). */
const DEFAULT_LOG_AMOUNT = 1;

export const DEFAULT_OPTIONS = Object.freeze({
  scale: 'pentatonicMajor',
  key: 'C',
  enabled: Object.freeze(Object.fromEntries(CATEGORY_NAMES.map((c) => [c, true]))),
  quietThreshold: 0, // XRP; 0 = off
  includeFailed: false,
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function midiToFreq(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function midiToName(midi) {
  const name = KEYS[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

/** Deterministic 32-bit string hash (FNV-1a). */
export function hashString(str) {
  let h = 0x811c9dc5;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stable index in [0, n) derived from a string, so the same account/issuer always sounds the same. */
export function stableIndex(str, n) {
  if (!n || n <= 0) return 0;
  return hashString(str) % n;
}

export function shortAddress(address) {
  if (typeof address !== 'string' || address.length < 10) return address ?? '';
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** Base58 r-address format check (XRPL alphabet, 25–35 characters). No checksum. */
export function isValidAddress(address) {
  return typeof address === 'string' && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address);
}

/** Decode a 160-bit hex currency code into something printable; 3-letter codes pass through. */
export function decodeCurrency(code) {
  if (typeof code !== 'string') return '';
  if (code.length === 3) return code.toUpperCase() === 'XRP' ? 'XRP' : code;
  if (/^[0-9A-Fa-f]{40}$/.test(code)) {
    if (code.startsWith('00') || code.startsWith('01') || code.startsWith('02')) return code; // non-standard / demurrage codes
    let out = '';
    for (let i = 0; i < 40; i += 2) {
      const byte = parseInt(code.slice(i, i + 2), 16);
      if (byte === 0) continue;
      if (byte < 0x20 || byte > 0x7e) return code; // not printable ASCII → keep hex
      out += String.fromCharCode(byte);
    }
    return out || code;
  }
  return code;
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/**
 * Parse any XRPL amount representation.
 *  - string of drops            → XRP
 *  - {currency, issuer, value}  → issued currency (IOU)
 *  - {mpt_issuance_id, value}   → multi-purpose token
 * Returns null for anything unparseable.
 */
export function parseAmount(amount) {
  if (amount == null) return null;
  if (typeof amount === 'string') {
    if (!/^\d+$/.test(amount)) return null;
    const drops = Number(amount);
    return { currency: 'XRP', issuer: null, value: drops / DROPS_PER_XRP, drops, isXrp: true, kind: 'xrp' };
  }
  if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) {
    return { currency: 'XRP', issuer: null, value: amount / DROPS_PER_XRP, drops: amount, isXrp: true, kind: 'xrp' };
  }
  if (typeof amount === 'object') {
    const value = Number(amount.value);
    if (!Number.isFinite(value)) return null;
    if (typeof amount.mpt_issuance_id === 'string') {
      return { currency: 'MPT', issuer: amount.mpt_issuance_id, value, drops: null, isXrp: false, kind: 'mpt' };
    }
    if (typeof amount.currency === 'string') {
      return {
        currency: decodeCurrency(amount.currency),
        issuer: amount.issuer ?? null,
        value,
        drops: null,
        isXrp: false,
        kind: 'iou',
      };
    }
  }
  return null;
}

function pickXrpSide(a, b) {
  const pa = parseAmount(a);
  const pb = parseAmount(b);
  if (pa?.isXrp) return pa;
  if (pb?.isXrp) return pb;
  return pa ?? pb ?? null;
}

/**
 * The amount that best describes a transaction. For payments the metadata's
 * `delivered_amount` wins (partial payments!), then `DeliverMax` (API v2
 * spelling), then `Amount` (API v1 spelling).
 */
export function extractAmount(tx, meta) {
  if (!tx || typeof tx !== 'object') return null;
  const type = tx.TransactionType;
  switch (type) {
    case 'Payment': {
      const delivered = meta?.delivered_amount ?? meta?.DeliveredAmount;
      if (delivered != null && delivered !== 'unavailable') {
        const parsed = parseAmount(delivered);
        if (parsed) return parsed;
      }
      return parseAmount(tx.DeliverMax ?? tx.Amount);
    }
    case 'OfferCreate':
      return pickXrpSide(tx.TakerGets, tx.TakerPays);
    case 'TrustSet':
      return parseAmount(tx.LimitAmount);
    case 'EscrowCreate':
    case 'PaymentChannelCreate':
    case 'PaymentChannelFund':
    case 'NFTokenCreateOffer':
    case 'CheckCash':
    case 'Clawback':
      return parseAmount(tx.Amount);
    case 'PaymentChannelClaim':
      return parseAmount(tx.Balance ?? tx.Amount);
    case 'CheckCreate':
      return parseAmount(tx.SendMax);
    case 'AMMDeposit':
    case 'AMMWithdraw':
    case 'AMMCreate':
      return pickXrpSide(tx.Amount, tx.Amount2);
    case 'AMMBid':
      return parseAmount(tx.BidMax ?? tx.BidMin);
    default:
      return parseAmount(tx.Amount);
  }
}

// ---------------------------------------------------------------------------
// Categorisation
// ---------------------------------------------------------------------------

export function categorize(txType) {
  if (typeof txType !== 'string') return 'other';
  if (txType === 'Payment') return 'payment';
  if (txType.startsWith('Offer')) return 'offer';
  if (txType === 'TrustSet') return 'trust';
  if (txType.startsWith('NFToken')) return 'nft';
  if (txType.startsWith('Escrow')) return 'escrow';
  if (txType.startsWith('PaymentChannel')) return 'paychan';
  if (txType.startsWith('AMM')) return 'amm';
  return 'other';
}

// ---------------------------------------------------------------------------
// Pitch
// ---------------------------------------------------------------------------

export function getScaleSteps(scaleName) {
  return SCALES[scaleName]?.steps ?? SCALES.pentatonicMajor.steps;
}

export function getKeyOffset(keyName) {
  const i = KEYS.indexOf(keyName);
  return i < 0 ? 0 : i;
}

/** Number of scale degrees available across the pitch range. */
export function degreeCount(scaleName) {
  return getScaleSteps(scaleName).length * PITCH_RANGE.octaves;
}

/** Scale degree index → MIDI note, honouring scale and key. */
export function degreeToMidi(index, scaleName, keyName) {
  const steps = getScaleSteps(scaleName);
  const i = Math.max(0, Math.round(index));
  const octave = Math.floor(i / steps.length);
  return PITCH_RANGE.low + getKeyOffset(keyName) + octave * 12 + steps[i % steps.length];
}

/**
 * Position of an XRP amount on the pitch axis: 0 = whale (lowest note),
 * 1 = dust (highest note). Null/zero amounts sit near the middle.
 */
export function amountPosition(amountXrp) {
  const lg = amountXrp > 0 ? Math.log10(amountXrp) : DEFAULT_LOG_AMOUNT;
  const clamped = clamp(lg, LOG_RANGE.min, LOG_RANGE.max);
  return (LOG_RANGE.max - clamped) / (LOG_RANGE.max - LOG_RANGE.min);
}

/** Scale degree index for an amount (0 = lowest). */
export function amountToDegree(amountXrp, scaleName) {
  const degrees = degreeCount(scaleName);
  return Math.round(amountPosition(amountXrp) * (degrees - 1));
}

/** XRP amount → MIDI note. Tiny payments high, whales low. */
export function pitchFromAmount(amountXrp, scaleName = 'pentatonicMajor', keyName = 'C') {
  return degreeToMidi(amountToDegree(amountXrp, scaleName), scaleName, keyName);
}

/** Particle radius (px) from an XRP amount. */
export function sizeFromAmount(amountXrp) {
  if (!(amountXrp > 0)) return 4;
  const r = 3 + 2.2 * Math.max(0, Math.log10(amountXrp) + 2);
  return clamp(r, 3, 28);
}

/** Chord: scale degrees root, +2, +4 (a triad within the scale). */
function triad(rootDegree, scaleName, keyName) {
  return [0, 2, 4].map((d) => degreeToMidi(rootDegree + d, scaleName, keyName));
}

/** Arpeggio: root, +2, +4, octave. */
function arpeggio(rootDegree, scaleName, keyName) {
  const len = getScaleSteps(scaleName).length;
  return [0, 2, 4, len].map((d) => degreeToMidi(rootDegree + d, scaleName, keyName));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatAmount(amount) {
  if (!amount) return '';
  const v = amount.value;
  let num;
  if (!Number.isFinite(v)) num = String(v);
  else if (Math.abs(v) >= 1000) num = Math.round(v).toLocaleString('en-US');
  else if (Math.abs(v) >= 1) num = Number(v.toFixed(2)).toString();
  else num = Number(v.toFixed(6)).toString();
  return `${num} ${amount.currency}`;
}

export function resultLabel(result) {
  if (typeof result !== 'string') return 'unknown';
  if (result === 'tesSUCCESS') return 'success';
  return result;
}

// ---------------------------------------------------------------------------
// Transaction → event
// ---------------------------------------------------------------------------

/** Unwrap a stream message into {tx, meta, result, validated, ledgerIndex, hash}. Supports rippled API v1 and v2 shapes. */
export function unwrapTransactionMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const tx = msg.tx_json ?? msg.transaction ?? (msg.TransactionType ? msg : null);
  if (!tx || typeof tx.TransactionType !== 'string') return null;
  const meta = msg.meta ?? msg.metaData ?? null;
  const result = msg.engine_result ?? meta?.TransactionResult ?? null;
  return {
    tx,
    meta,
    result,
    validated: msg.validated !== false,
    ledgerIndex: msg.ledger_index ?? tx.ledger_index ?? null,
    hash: msg.hash ?? tx.hash ?? null,
  };
}

function mergeOptions(options) {
  if (!options) return DEFAULT_OPTIONS;
  return {
    ...DEFAULT_OPTIONS,
    ...options,
    enabled: { ...DEFAULT_OPTIONS.enabled, ...(options.enabled ?? {}) },
  };
}

/**
 * Log text for a transaction, in pieces so the UI can link each address:
 * `head` is "Type · amount", `parties` the accounts with the separator that
 * precedes each one, and `text` the flat string of both.
 */
function describe(tx, category, amount) {
  const type = tx.TransactionType;
  const head = amount ? `${type} · ${formatAmount(amount)}` : type;
  const parties = [];
  const party = (address, role, separator) => {
    if (typeof address === 'string' && address) parties.push({ address, short: shortAddress(address), role, separator });
  };
  party(tx.Account, 'from', ' · ');
  switch (category) {
    case 'payment':
    case 'escrow':
    case 'paychan':
      party(tx.Destination, 'to', ' → ');
      break;
    case 'trust':
      party(tx.LimitAmount?.issuer, 'issuer', ' ⇢ ');
      break;
    default:
      break;
  }
  const text = head + parties.map((p) => p.separator + p.short).join('');
  return { head, parties, text };
}

function containsString(value, needle, depth) {
  if (depth > 8 || value == null) return false;
  if (typeof value === 'string') return value === needle;
  if (Array.isArray(value)) return value.some((v) => containsString(v, needle, depth + 1));
  if (typeof value === 'object') return Object.values(value).some((v) => containsString(v, needle, depth + 1));
  return false;
}

/** Transaction fields that name an account directly (besides Account and Destination). */
const ACCOUNT_FIELDS = Object.freeze(['Owner', 'Issuer', 'Authorize', 'Unauthorize', 'RegularKey', 'NFTokenMinter', 'Holder']);

/**
 * Does a transaction involve an account? True when the account is the sender,
 * the destination, another direct account field, or appears anywhere in the
 * metadata's AffectedNodes (balances, trust lines, offers it owns...).
 * Accepts a stream message, a `ledger` command transaction entry, or a bare tx.
 */
export function involvesAccount(msg, address) {
  if (typeof address !== 'string' || !address) return false;
  const unwrapped = unwrapTransactionMessage(msg);
  if (!unwrapped) return false;
  const { tx, meta } = unwrapped;
  if (tx.Account === address || tx.Destination === address) return true;
  for (const field of ACCOUNT_FIELDS) if (tx[field] === address) return true;
  const nodes = meta?.AffectedNodes;
  if (Array.isArray(nodes)) {
    for (const node of nodes) if (containsString(node, address, 0)) return true;
  }
  return false;
}

/**
 * Map a `transactions` stream message to a sound event, or null if it should be
 * skipped (not a tx, failed, category disabled, below the quiet threshold).
 */
export function txToEvent(msg, options) {
  const opts = mergeOptions(options);
  const unwrapped = unwrapTransactionMessage(msg);
  if (!unwrapped) return null;
  const { tx, meta, result, ledgerIndex, hash } = unwrapped;

  const success = result === 'tesSUCCESS';
  if (!success && !opts.includeFailed) return null;

  const txType = tx.TransactionType;
  const category = categorize(txType);
  if (opts.enabled[category] === false) return null;

  const amount = extractAmount(tx, meta);
  const amountXrp = amount?.isXrp ? amount.value : null;
  const amountValue = amount ? amount.value : null;

  const threshold = Number(opts.quietThreshold) || 0;
  if (threshold > 0 && !(amountXrp >= threshold)) return null;

  const scale = opts.scale;
  const key = opts.key;
  const degrees = degreeCount(scale);
  const steps = getScaleSteps(scale);
  const len = steps.length;
  const position = amountPosition(amountXrp ?? amountValue);

  let degree;
  let velocity;
  let duration;
  let notes;
  let variant = null;

  switch (category) {
    case 'payment': {
      degree = amountToDegree(amountXrp ?? amountValue, scale);
      velocity = clamp(0.35 + 0.45 * (1 - position), 0.2, 0.9);
      duration = 0.6 + 0.8 * (1 - position);
      notes = [degreeToMidi(degree, scale, key)];
      break;
    }
    case 'offer': {
      // No pitch to speak of; spread market makers across the stage by account.
      degree = len + stableIndex(tx.Account, 3 * len);
      variant = txType === 'OfferCancel' ? 'rim' : 'hat';
      velocity = variant === 'rim' ? 0.2 : 0.22;
      duration = variant === 'rim' ? 0.04 : 0.08;
      notes = [degreeToMidi(degree, scale, key)];
      break;
    }
    case 'trust': {
      // Each issuer gets its own pad note so popular issuers become recognisable drones.
      degree = len + stableIndex(tx.LimitAmount?.issuer ?? tx.Account, 2 * len);
      velocity = 0.3;
      duration = 2.2;
      const root = degreeToMidi(degree, scale, key);
      notes = [root, root + 7];
      break;
    }
    case 'nft': {
      degree = 3 * len + stableIndex(tx.NFTokenID ?? tx.NFTokenTaxon ?? tx.Account, 2 * len);
      velocity = 0.42;
      duration = 1.6;
      notes = [degreeToMidi(degree, scale, key)];
      break;
    }
    case 'escrow': {
      degree = amountToDegree(amountXrp, scale);
      variant = txType === 'EscrowFinish' ? 'finish' : txType === 'EscrowCancel' ? 'cancel' : 'create';
      velocity = 0.38;
      duration = 1.2;
      notes = [degreeToMidi(degree, scale, key)];
      break;
    }
    case 'paychan': {
      degree = len + stableIndex(tx.Channel ?? tx.Destination ?? tx.Account, 2 * len);
      velocity = 0.34;
      duration = 0.6;
      notes = arpeggio(degree, scale, key);
      break;
    }
    case 'amm': {
      degree = len + stableIndex(tx.Asset?.currency ?? tx.Asset2?.currency ?? tx.Account, 2 * len);
      velocity = 0.36;
      duration = 1.3;
      notes = triad(degree, scale, key);
      break;
    }
    default: {
      degree = len + stableIndex(tx.Account, 3 * len);
      velocity = 0.12;
      duration = 0.05;
      notes = [degreeToMidi(degree, scale, key)];
    }
  }

  const pitch = notes[0];
  const sub = category === 'payment' && amountXrp != null && amountXrp >= WHALE_THRESHOLD_XRP;
  const described = describe(tx, category, amount);

  return {
    kind: 'tx',
    category,
    txType,
    sound: CATEGORIES[category].sound,
    variant,
    colour: CATEGORIES[category].colour,
    pitch,
    freq: midiToFreq(pitch),
    notes,
    note: midiToName(pitch),
    velocity,
    duration,
    sub,
    size: sizeFromAmount(amountXrp ?? amountValue),
    timbre: amount && !amount.isXrp ? 'iou' : 'xrp',
    amount,
    amountXrp,
    success,
    result,
    hash,
    account: tx.Account ?? null,
    destination: tx.Destination ?? null,
    ledgerIndex,
    head: described.head,
    parties: described.parties,
    text: described.text,
  };
}

// ---------------------------------------------------------------------------
// Ledger → event
// ---------------------------------------------------------------------------

/** Map a `ledgerClosed` stream message (or a subscribe result) to a ledger event, or null. */
export function ledgerToEvent(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const src = msg.type === 'ledgerClosed' ? msg : msg.result ?? msg;
  const ledgerIndex = Number(src.ledger_index);
  if (!Number.isFinite(ledgerIndex)) return null;
  const rippleTime = Number(src.ledger_time);
  const closeTime = Number.isFinite(rippleTime) ? rippleTime + RIPPLE_EPOCH_OFFSET : null;
  return {
    kind: 'ledger',
    ledgerIndex,
    hash: src.ledger_hash ?? null,
    closeTime,
    closeTimeIso: closeTime != null ? new Date(closeTime * 1000).toISOString() : null,
    txnCount: Number.isFinite(Number(src.txn_count)) ? Number(src.txn_count) : null,
    feeBase: src.fee_base ?? null,
    reserveBase: src.reserve_base ?? null,
    validatedLedgers: src.validated_ledgers ?? null,
    text: `Ledger #${ledgerIndex.toLocaleString('en-US')}${src.txn_count != null ? ` · ${src.txn_count} tx` : ''}`,
  };
}

/** Classify any raw stream message. */
export function classifyMessage(msg) {
  if (!msg || typeof msg !== 'object') return 'unknown';
  if (msg.type === 'ledgerClosed') return 'ledger';
  if (msg.type === 'transaction') return 'transaction';
  if (msg.type === 'response') return 'response';
  if (msg.type === 'error' || msg.status === 'error') return 'error';
  return 'unknown';
}

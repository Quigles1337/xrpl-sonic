// xrpl-sonic — save this moment.
//
// Someone is listening, live or in replay, something catches their ear, and
// one action preserves the selection and their observation before it scrolls
// away. A moment is a case (src/case.js), not a new format: the selection
// becomes the clips, the selected event or position becomes the anchor, the
// observation becomes a question annotation at that anchor, and a `moment`
// block records where it was saved, the loop, and per ledger the hash and
// (live) how many transactions were heard of how many there were. Reopening
// goes through the ordinary case path, which refetches full ledgers; the
// saved coverage is what was heard, not what happened. See
// docs/save-this-moment.md.
//
// Pure: no DOM, no network, no audio.

import { MAX_REPLAY_LEDGERS } from './replay.js';
import { ledgerAtPosition } from './score.js';
import { defaultCase, MOMENT_VERSION } from './case.js';
import { unwrapTransactionMessage, extractAmount } from './mapping.js';
import { logVolume } from './coherence.js';
import { touchOf } from './record.js';

export { MOMENT_VERSION };

/** How many validated ledgers the live page keeps behind it: the case cap, so a moment can carry them all. */
export const LIVE_WINDOW_LEDGERS = MAX_REPLAY_LEDGERS;

const HASH = /^[0-9A-F]{64}$/i;
const validHash = (h) => typeof h === 'string' && HASH.test(h);

/** The digits of an ISO time, for a file name: 2026-10-21T20:14:03.512Z → 20261021t201403. */
function stamp(savedAt) {
  const iso = typeof savedAt === 'string' && savedAt ? savedAt : new Date().toISOString();
  return iso.replace(/\.\d+Z?$/, '').replace(/[-:Z]/g, '').toLowerCase();
}

const titleFor = (index) => `Moment at ledger #${Number(index).toLocaleString('en-US')}`;

// ---------------------------------------------------------------------------
// The live window: what the page has heard
// ---------------------------------------------------------------------------

/**
 * The last validated ledgers the live stream delivered, with the hashes of
 * the transactions heard for each (a transaction delivered twice counts
 * once). The stream is not ordered: a ledger's transactions arrive before
 * and after its ledgerClosed message, and older ledgers' transactions
 * trickle in several ledgers late, so transactions for a ledger whose close
 * has not arrived are kept provisionally and the window reports a ledger
 * only once it has closed. A ledger index that jumps backwards or by more
 * than the window (another network, a long disconnect) starts the window
 * over.
 */
export class LiveWindow {
  /** @param {{ max?: number }} [opts]  `max` is how many closed ledgers are kept: the case cap by default; a reader that does not save a case (the sky, docs/universe-requests.md R2) may keep more. A moment saved from a wider window keeps its last 50. */
  constructor({ max = LIVE_WINDOW_LEDGERS } = {}) {
    this.max = max;
    this.entries = [];
  }

  _entry(index, { create = false } = {}) {
    let entry = this.entries.find((e) => e.index === index);
    if (entry || !create) return entry ?? null;
    const latest = this.entries.at(-1);
    if (latest && (index < latest.index - this.max || index - latest.index > this.max)) return null; // too far from what is here to belong to it
    entry = { index, closed: false, hash: null, closeTime: null, txnCount: null, hashes: new Set(), anonymous: 0, accounts: new Map(), touches: [] };
    this.entries.push(entry);
    this.entries.sort((a, b) => a.index - b.index);
    while (this.entries.length > this.max) this.entries.shift();
    return entry;
  }

  /** A `ledgerClosed` stream message. */
  noteLedger(msg) {
    const index = Number(msg?.ledger_index);
    if (!Number.isInteger(index) || index <= 0) return null;
    const latest = this.entries.findLast?.((e) => e.closed) ?? [...this.entries].reverse().find((e) => e.closed) ?? null;
    if (latest && (index < latest.index || index - latest.index > this.max)) this.entries = []; // another network, or a long gap: start over
    const entry = this._entry(index, { create: true });
    if (!entry || entry.closed) return entry;
    entry.closed = true;
    entry.hash = validHash(msg.ledger_hash) ? msg.ledger_hash.toUpperCase() : null;
    entry.closeTime = Number.isFinite(Number(msg.ledger_time)) ? Number(msg.ledger_time) : null;
    entry.txnCount = Number.isFinite(Number(msg.txn_count)) ? Number(msg.txn_count) : null;
    return entry;
  }

  /** A `transaction` stream message; one without a ledger index belongs to the ledger streaming now. */
  noteTransaction(msg) {
    const u = unwrapTransactionMessage(msg);
    if (!u) return false;
    const given = Number(u.ledgerIndex);
    const index = Number.isInteger(given) && given > 0 ? given : this.entries.at(-1)?.index ?? null;
    if (index == null) return false;
    const entry = this._entry(index, { create: true });
    if (!entry) return false;
    let fresh = true;
    if (validHash(u.hash)) {
      const h = u.hash.toUpperCase();
      fresh = !entry.hashes.has(h);
      entry.hashes.add(h);
    } else entry.anonymous += 1; // delivered without a hash: counted, since it cannot be deduplicated
    // the submitter, for coherence (src/coherence.js): count and log volume per account, once per transaction
    const address = u.tx?.Account;
    if (fresh && typeof address === 'string' && address) {
      const rec = entry.accounts.get(address) ?? { count: 0, volume: 0 };
      rec.count += 1;
      rec.volume += logVolume({ amount: extractAmount(u.tx, u.meta) });
      entry.accounts.set(address, rec);
    }
    // and the touch record (src/record.js), so a pair can be checked against the record heard
    if (fresh) {
      const t = touchOf(u.tx, u.meta, { hash: u.hash, ledgerIndex: index });
      if (t) entry.touches.push(t);
    }
    return true;
  }

  reset() {
    this.entries = [];
  }

  /** Transactions heard for a ledger, closed or not. */
  receivedFor(index) {
    const e = this.entries.find((x) => x.index === index);
    return e ? e.hashes.size + e.anonymous : 0;
  }

  /**
   * The closed ledgers, oldest first: { index, hash, closeTime, txnCount, received, accounts, touches },
   * `accounts` being address → { count, volume } of the submitters heard and `touches` the touch records
   * (src/record.js) of the transactions heard, in arrival order.
   */
  get ledgers() {
    return this.entries.filter((e) => e.closed).map((e) => ({ index: e.index, hash: e.hash, closeTime: e.closeTime, txnCount: e.txnCount, received: e.hashes.size + e.anonymous, accounts: Object.fromEntries([...e.accounts].map(([a, r]) => [a, { ...r }])), touches: e.touches.map((t) => ({ ...t })) }));
  }

  /**
   * The closed ledgers without copying (docs/universe-requests.md, R2): the
   * fields of `ledgers`, with `accounts` the live Map (address → { count,
   * volume }) and `touches` the live array of each entry. For a reader that
   * reads every few ledgers and never writes; nothing it returns is a copy.
   */
  peek() {
    return this.entries.filter((e) => e.closed).map((e) => ({ index: e.index, hash: e.hash, closeTime: e.closeTime, txnCount: e.txnCount, received: e.hashes.size + e.anonymous, accounts: e.accounts, touches: e.touches }));
  }

  get latest() {
    return this.ledgers.at(-1) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Building a moment
// ---------------------------------------------------------------------------

function questionAnnotation(anchor, question) {
  const text = typeof question === 'string' ? question.trim() : '';
  return text ? { anchor, text, source: 'human', status: 'draft', question: true } : null;
}

/**
 * A moment of live listening: the window as one clip, the ledger playing
 * now (or the selected event) as the anchor, the question at it, and per
 * ledger what was heard against the ledger's txn_count.
 * @param {{ base: object, window: LiveWindow|object[], selectedHash?: string, question?: string, host?: string, savedAt?: string, speed?: number }} args
 *   `base` is caseFromState() with the current cast, filters and mapping.
 * @returns {object|null} a raw case for validateCase, or null when nothing has been heard yet
 */
export function momentFromLive({ base, window, selectedHash = null, question = '', host = '', savedAt = null, speed = null } = {}) {
  const all = window instanceof LiveWindow ? window.ledgers : Array.isArray(window) ? window : [];
  const heard = all.slice(-MAX_REPLAY_LEDGERS); // a window wider than the case cap (R2) saves its last 50
  if (!heard.length) return null;
  const first = heard[0];
  const last = heard.at(-1);
  const anchor = validHash(selectedHash) ? { hash: selectedHash.toUpperCase() } : { ledger: last.index };
  const byIndex = new Map(heard.map((l) => [l.index, l]));
  const ledgers = [];
  for (let n = first.index; n <= last.index; n++) {
    const l = byIndex.get(n);
    // a ledger whose close was missed is still in the clip; what was heard of it is kept, its txn_count is not known
    ledgers.push(l ? { index: n, hash: l.hash, received: l.received, expected: l.txnCount } : { index: n, hash: null, received: window?.receivedFor?.(n) ?? 0, expected: null });
  }
  const when = typeof savedAt === 'string' && savedAt ? savedAt : new Date().toISOString();
  const c = {
    ...(base ?? defaultCase()),
    id: `moment-${last.index}-${stamp(when)}`,
    title: titleFor(last.index),
    clips: [{ from: first.index, to: last.index }],
    annotations: [...(base?.annotations ?? [])],
    timing: { speed: speed ?? base?.timing?.speed ?? 1 },
    moment: { version: MOMENT_VERSION, savedAt: when, mode: 'live', host: host ?? '', anchor, loop: null, ledgers },
  };
  const q = questionAnnotation(anchor, question);
  if (q) c.annotations.push(q);
  return c;
}

/**
 * A moment of a case being played: the loop's ledgers (or the one playing
 * now) as the clips, grouped by the original clip so a gap survives; the
 * position, the loop and timed notes re-based to the new timeline; hashes
 * from the score.
 * @param {{ base: object, score: object, positionMs: number, loop?: {fromMs,toMs}|null, selectedHash?: string, question?: string, host?: string, savedAt?: string }} args
 *   `base` is currentCase(): the loaded case with the current settings folded in.
 */
export function momentFromReplay({ base, score, positionMs = 0, loop = null, selectedHash = null, question = '', host = '', savedAt = null } = {}) {
  if (!base || !Array.isArray(score?.ledgers) || !score.ledgers.length) return null;
  const looped = loop && Number(loop.toMs) > Number(loop.fromMs) ? { fromMs: Number(loop.fromMs), toMs: Number(loop.toMs) } : null;
  let chosen;
  if (looped) chosen = score.ledgers.filter((l) => l.timeMs < looped.toMs && l.timeMs + l.intervalMs > looped.fromMs);
  else {
    const at = ledgerAtPosition(score, positionMs);
    chosen = score.ledgers.filter((l) => l.ledgerIndex === at);
  }
  if (!chosen.length) chosen = [score.ledgers[0]];
  const origin = chosen[0].timeMs;
  const end = chosen.at(-1).timeMs + chosen.at(-1).intervalMs - origin;
  const rebase = (ms) => Math.max(0, Math.round(Number(ms) - origin));
  const clips = [];
  for (const l of chosen) {
    const prev = clips.at(-1);
    if (prev && prev.clip === l.clip && l.ledgerIndex === prev.to + 1) prev.to = l.ledgerIndex;
    else clips.push({ clip: l.clip, from: l.ledgerIndex, to: l.ledgerIndex });
  }
  const anchor = validHash(selectedHash) ? { hash: selectedHash.toUpperCase() } : { timeMs: rebase(positionMs) };
  const annotations = [];
  for (const a of base.annotations ?? []) {
    if (a.anchor?.timeMs != null) {
      const t = Number(a.anchor.timeMs) - origin;
      if (t < 0 || t > end) continue; // a timed note outside the selection has no place on the new timeline
      annotations.push({ ...a, anchor: { timeMs: Math.round(t) } });
    } else annotations.push(a);
  }
  const q = questionAnnotation(anchor, question);
  if (q) annotations.push(q);
  const last = chosen.at(-1).ledgerIndex;
  const when = typeof savedAt === 'string' && savedAt ? savedAt : new Date().toISOString();
  return {
    ...base,
    id: `moment-${last}-${stamp(when)}`,
    title: base.title || titleFor(last),
    clips: clips.map(({ from, to }) => ({ from, to })),
    annotations,
    moment: {
      version: MOMENT_VERSION,
      savedAt: when,
      mode: 'replay',
      host: host ?? '',
      anchor,
      loop: looped ? { fromMs: rebase(looped.fromMs), toMs: rebase(looped.toMs) } : null,
      ledgers: chosen.map((l) => ({ index: l.ledgerIndex, hash: validHash(l.hash) ? l.hash.toUpperCase() : null })),
    },
  };
}

/**
 * The explorer's handoff: one ledger as the clip, the transaction as the
 * anchor, no question. The listening page opens it like any case.
 */
export function momentFromTransaction({ network = 'mainnet', ledgerIndex, hash, ledgerHash = null, host = '', savedAt = null } = {}) {
  const index = Number(ledgerIndex);
  if (!Number.isInteger(index) || index <= 0 || !validHash(hash)) return null;
  const when = typeof savedAt === 'string' && savedAt ? savedAt : new Date().toISOString();
  const c = defaultCase();
  c.network = network === 'testnet' ? 'testnet' : 'mainnet';
  c.id = `moment-${index}-${stamp(when)}`;
  c.title = titleFor(index);
  c.clips = [{ from: index, to: index }];
  c.moment = { version: MOMENT_VERSION, savedAt: when, mode: 'explorer', host: host ?? '', anchor: { hash: hash.toUpperCase() }, loop: null, ledgers: [{ index, hash: validHash(ledgerHash) ? ledgerHash.toUpperCase() : null }] };
  return c;
}

export function isMoment(c) {
  return Boolean(c && typeof c === 'object' && c.moment);
}

/**
 * Where to put the transport when a moment is reopened: the anchor resolved
 * against the built score (a hash to its event, a ledger to its close, a
 * time as it is; an anchor that does not resolve lands at the start), the
 * loop clamped to the score, and the question annotation as the score
 * resolved it.
 * @returns {{ timeMs: number, loop: {fromMs,toMs}|null, annotation: object|null }|null}
 */
export function momentPosition(theCase, score) {
  if (!isMoment(theCase) || !score) return null;
  const m = theCase.moment;
  const question = (score.annotations ?? []).find((a) => a.question) ?? null;
  let timeMs = 0;
  const a = m.anchor;
  if (a?.hash) {
    const ev = (score.events ?? []).find((e) => typeof e.hash === 'string' && e.hash.toUpperCase() === a.hash);
    timeMs = ev ? ev.timeMs : question?.timeMs ?? 0;
  } else if (a?.ledger != null) {
    const l = (score.ledgers ?? []).find((x) => x.ledgerIndex === a.ledger);
    timeMs = l ? l.timeMs : 0;
  } else if (a?.timeMs != null) timeMs = Math.min(score.totalMs ?? 0, a.timeMs);
  let loop = null;
  if (m.loop) {
    const total = score.totalMs ?? 0;
    const fromMs = Math.min(m.loop.fromMs, total);
    const toMs = Math.min(m.loop.toMs, total);
    if (toMs > fromMs) loop = { fromMs, toMs };
  }
  return { timeMs, loop, annotation: question };
}

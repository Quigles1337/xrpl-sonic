// xrpl-sonic — the score.
//
// A score is the list of everything the instrument intends to play for a
// case: every ledger close, every transaction event with its voice, notes,
// velocity, duration and position on a single timeline, every gap between
// clips, and every annotation resolved to a time. It is built from the case
// and the ledgers the case names, deterministically: the same inputs produce
// the same score. Browser playback, the tape, the inspector, transcripts and
// MIDI export all read from it.
//
// Timing note: within a ledger, transactions are laid out in the order the
// ledger applied them (metadata TransactionIndex), spaced evenly across the
// interval the ledger stayed open. That reconstructs a listening sequence; it
// does not recover when each transaction was submitted or executed.
//
// Pure: no DOM, no audio.

import { txToEventOrReason, ledgerToEvent, formatAmount, shortAddress, MAPPING_VERSION, EXCLUSION_REASONS } from './mapping.js';
import { scheduleReplay, replayIntervalMs, replayLedgerMessage, DEFAULT_CLOSE_INTERVAL_MS } from './replay.js';
import { castFor, castGate, decorateEvent } from './cast.js';

export const SCORE_VERSION = 1;

/** Silence between clips, so an omitted interval is heard as well as seen. */
export const GAP_MS = 1500;

/** Why a transaction is not in the score: the mapping's reasons, plus the cast gate. */
export const SCORE_EXCLUSION_REASONS = Object.freeze({ ...EXCLUSION_REASONS, castHidden: 'outside the cast' });

function txIndexOf(tx) {
  const meta = tx?.meta ?? tx?.metaData;
  const i = Number(meta?.TransactionIndex);
  return Number.isFinite(i) ? i : null;
}

/**
 * Build the score for a case.
 * @param {object} theCase  a validated case (src/case.js)
 * @param {Map<number, { ledger: object|null, nextCloseTime: number|null }>} ledgers
 *   fetched `ledger` results keyed by index; a null ledger marks one that could not be fetched
 */
export function buildScore(theCase, ledgers) {
  const options = {
    scale: theCase.mapping.scale,
    key: theCase.mapping.key,
    enabled: theCase.filters.enabled,
    quietThreshold: theCase.filters.quietThreshold,
    includeFailed: theCase.filters.includeFailed,
  };
  const cast = theCase.cast ?? [];
  const mode = theCase.filters.castMode ?? 'all';
  const score = {
    version: SCORE_VERSION,
    caseId: theCase.id,
    mappingVersion: MAPPING_VERSION,
    network: theCase.network,
    speed: theCase.timing?.speed ?? 1,
    ledgers: [],
    gaps: [],
    events: [],
    annotations: [],
    warnings: [],
    totalMs: 0,
    counts: { events: 0, played: 0, dim: 0, missingLedgers: 0, byCategory: {}, excluded: { total: 0, byReason: {} } },
  };
  const exclude = (reason) => {
    score.counts.excluded.total += 1;
    score.counts.excluded.byReason[reason] = (score.counts.excluded.byReason[reason] ?? 0) + 1;
  };
  let cursor = 0;
  const byHash = new Map();
  const byLedger = new Map();

  theCase.clips.forEach((clip, ci) => {
    for (let n = clip.from; n <= clip.to; n++) {
      const entry = ledgers?.get?.(n) ?? null;
      const ledger = entry?.ledger ?? null;
      if (!ledger) {
        score.ledgers.push({ ledgerIndex: n, clip: ci, timeMs: cursor, intervalMs: DEFAULT_CLOSE_INTERVAL_MS, txnCount: null, missing: true, event: null });
        byLedger.set(n, cursor);
        score.counts.missingLedgers += 1;
        score.warnings.push(`ledger #${n} was not available; ${DEFAULT_CLOSE_INTERVAL_MS / 1000} s of silence stands in for it`);
        cursor += DEFAULT_CLOSE_INTERVAL_MS;
        continue;
      }
      const nextCloseTime = entry.nextCloseTime ?? null;
      const intervalMs = replayIntervalMs(ledger, nextCloseTime);
      const ledgerEvent = ledgerToEvent(replayLedgerMessage(ledger));
      score.ledgers.push({
        ledgerIndex: n,
        clip: ci,
        timeMs: cursor,
        intervalMs,
        txnCount: ledgerEvent?.txnCount ?? null,
        hash: ledger.ledger_hash ?? null,
        closeTimeIso: ledgerEvent?.closeTimeIso ?? null,
        missing: false,
        event: ledgerEvent,
      });
      byLedger.set(n, cursor);
      for (const { tx, offsetMs } of scheduleReplay(ledger, nextCloseTime)) {
        const { event: ev, reason } = txToEventOrReason(tx, options);
        if (!ev) {
          exclude(reason);
          continue;
        }
        if (ev.ledgerIndex == null) ev.ledgerIndex = Number(ledger.ledger_index);
        const involvement = castFor(tx, cast);
        const gate = castGate(involvement, cast, mode);
        if (gate === 'skip') {
          exclude('castHidden');
          continue;
        }
        decorateEvent(ev, involvement);
        const item = {
          n: score.events.length,
          clip: ci,
          ledgerIndex: n,
          txIndex: txIndexOf(tx),
          hash: ev.hash,
          offsetMs,
          timeMs: cursor + offsetMs,
          gate,
          cast: ev.cast,
          primary: ev.primary,
          event: ev,
        };
        score.events.push(item);
        if (item.hash) byHash.set(item.hash.toUpperCase(), item);
        score.counts.events += 1;
        if (gate === 'play') score.counts.played += 1;
        else score.counts.dim += 1;
        score.counts.byCategory[ev.category] = (score.counts.byCategory[ev.category] ?? 0) + 1;
      }
      cursor += intervalMs;
    }
    const next = theCase.clips[ci + 1];
    if (next) {
      score.gaps.push({ timeMs: cursor, afterLedger: clip.to, beforeLedger: next.from, omitted: next.from - clip.to - 1, durationMs: GAP_MS });
      cursor += GAP_MS;
    }
  });
  score.totalMs = cursor;

  for (const a of theCase.annotations ?? []) {
    let timeMs = null;
    let eventN = null;
    if (a.anchor.hash && byHash.has(a.anchor.hash)) {
      const item = byHash.get(a.anchor.hash);
      timeMs = item.timeMs;
      eventN = item.n;
    } else if (a.anchor.ledger != null && byLedger.has(a.anchor.ledger)) {
      timeMs = byLedger.get(a.anchor.ledger);
    } else if (a.anchor.timeMs != null && a.anchor.timeMs <= cursor) {
      timeMs = a.anchor.timeMs;
    }
    if (timeMs == null) {
      score.warnings.push(`annotation "${a.id}" does not resolve to anything in this case and will not play`);
      continue;
    }
    score.annotations.push({ ...a, timeMs, eventN });
  }
  score.annotations.sort((x, y) => x.timeMs - y.timeMs);
  return score;
}

/** The time range each clip occupies on the score's timeline, for A/B comparison and clip loops. */
export function clipRanges(score) {
  const out = [];
  for (const l of score?.ledgers ?? []) {
    const r = out[l.clip];
    if (!r) out[l.clip] = { clip: l.clip, fromMs: l.timeMs, toMs: l.timeMs + l.intervalMs, ledgers: 1 };
    else {
      r.toMs = Math.max(r.toMs, l.timeMs + l.intervalMs);
      r.ledgers += 1;
    }
  }
  return out.filter(Boolean);
}

/** The ledger playing at a position on the timeline: the last one that started at or before it (the first, before the start). */
export function ledgerAtPosition(score, ms) {
  const ledgers = score?.ledgers;
  if (!Array.isArray(ledgers) || !ledgers.length) return null;
  let found = ledgers[0];
  for (const l of ledgers) {
    if (l.timeMs <= ms) found = l;
    else break;
  }
  return found.ledgerIndex;
}

/** "failed 3, category disabled 2" for a score's excluded counts; empty when nothing was excluded. */
export function excludedText(counts) {
  const by = counts?.excluded?.byReason ?? {};
  return Object.entries(by)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${SCORE_EXCLUSION_REASONS[k] ?? k} ${n}`)
    .join(', ');
}

/** mm:ss.mmm for a score position. */
export function formatClock(ms) {
  const t = Math.max(0, Math.round(Number(ms) || 0));
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const f = t % 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(f).padStart(3, '0')}`;
}

/** A one-line text equivalent of a score event, for captions and transcripts. */
export function scoreCaption(item, cast = []) {
  const ev = item?.event;
  if (!ev) return '';
  const parts = [ev.txType];
  if (ev.amount) parts.push(formatAmount(ev.amount));
  const names = new Map(cast.map((m) => [m.id, m.label]));
  const party = (p) => {
    const member = cast.find((m) => m.address === p.address);
    return member ? `${member.label} (${p.short})` : p.short;
  };
  const who = ev.parties.map((p, i) => (i === 0 ? party(p) : `${p.separator.trim()} ${party(p)}`)).join(' ');
  if (who) parts.push(who);
  parts.push(`${ev.voice ?? ev.sound} ${ev.note}`);
  if (item.cast?.length) parts.push(`cast: ${item.cast.map((id) => names.get(id) ?? id).join(', ')}`);
  if (item.gate === 'dim') parts.push('silent');
  if (!ev.success) parts.push(`failed (${ev.result})`);
  return parts.join(' · ');
}

/** The whole score as readable text: one line per ledger, gap, event and annotation, in time order. */
export function transcript(score, theCase) {
  const cast = theCase?.cast ?? [];
  const lines = [];
  const title = theCase?.title || theCase?.id || score.caseId;
  lines.push(`xrpl-sonic transcript · ${title}`);
  lines.push(`network ${score.network} · mapping ${score.mappingVersion} · scale ${theCase?.mapping?.scale ?? ''} ${theCase?.mapping?.key ?? ''} · speed ${score.speed}×`);
  if (cast.length) lines.push(`cast: ${cast.map((m) => `${m.label} = ${m.address} (${m.voice}, pan ${m.pan})`).join('; ')}`);
  const excluded = score.counts.excluded?.total ? ` · ${score.counts.excluded.total} excluded (${excludedText(score.counts)})` : '';
  lines.push(`${score.ledgers.length} ledgers · ${score.counts.events} events (${score.counts.played} selected to sound, ${score.counts.dim} silent)${excluded} · ${formatClock(score.totalMs)} at 1×`);
  for (const w of score.warnings) lines.push(`warning: ${w}`);
  lines.push('');
  const rows = [];
  for (const l of score.ledgers) rows.push({ t: l.timeMs, order: 0, text: l.missing ? `ledger #${l.ledgerIndex} unavailable` : `ledger #${l.ledgerIndex} · ${l.txnCount} tx · closed ${l.closeTimeIso ?? '?'}` });
  for (const g of score.gaps) rows.push({ t: g.timeMs, order: 0, text: `— gap: ${g.omitted} ledger${g.omitted === 1 ? '' : 's'} omitted between #${g.afterLedger} and #${g.beforeLedger} —` });
  for (const e of score.events) rows.push({ t: e.timeMs, order: 1, text: `  ${scoreCaption(e, cast)}${e.hash ? ` · ${e.hash.slice(0, 8)}…` : ''}` });
  for (const a of score.annotations) rows.push({ t: a.timeMs, order: 2, text: `  >> ${a.text}${a.source ? ` [${a.source}]` : ''} (${a.status})` });
  rows.sort((x, y) => x.t - y.t || x.order - y.order);
  for (const r of rows) lines.push(`${formatClock(r.t)} ${r.text}`);
  return lines.join('\n');
}

/**
 * The transcript text read back as its header lines and one row per line
 * stamped with a time (ledger, gap, event or note), for a structured view that
 * changes no word of the text (docs/ux.md). Pure.
 * @returns {{ header: string[], rows: { time: string, kind: 'ledger'|'gap'|'event'|'note', text: string }[] }}
 */
export function transcriptRows(text) {
  const lines = String(text ?? '').split('\n');
  const blank = lines.indexOf('');
  const header = blank < 0 ? lines.slice() : lines.slice(0, blank);
  const rows = [];
  for (const line of blank < 0 ? [] : lines.slice(blank + 1)) {
    const m = /^(\d+:\d{2}\.\d{3}) (.*)$/.exec(line);
    if (!m) continue;
    const body = m[2];
    const kind = body.startsWith('  >> ') ? 'note' : body.startsWith('— gap') ? 'gap' : body.startsWith('ledger #') ? 'ledger' : 'event';
    rows.push({ time: m[1], kind, text: body.trim() });
  }
  return { header, rows };
}

/** Short label for a member id in a score, falling back to a short address. */
export function memberLabel(cast, id) {
  const m = (cast ?? []).find((x) => x.id === id);
  return m ? m.label : shortAddress(id);
}

// xrpl-sonic — Copy for AI.
//
// Turns a case (a moment, or any case) into text an assistant can work from
// without xrpl-sonic, and takes the assistant's answer back as draft
// annotations on the same case. One pure function is the whole feature:
//
//   describe(theCase, ledgers, facts, { level, budget, caseLink }) → text
//
// The text has, in order: a header (what this is, versions, network and
// host, the question and its anchor, the scope with ledger hashes, the
// coverage), three labelled counts (available, selected, excluded by
// reason), the listening settings as context, concentration, the events one
// per line with full hashes and exact amounts, the findings of the anchor
// (and, at the evidence level, of the cast-involved events, with their
// source fields), links, and a fixed trailer that says how to reply. Under
// a budget, events are selected by a stated rule and the text says how many
// of how many it shows; nothing is dropped silently. The same case, ledgers
// and facts give identical text. Hashes and amounts are verbatim: no
// shortened addresses, no rounded amounts. See docs/copy-for-ai.md.
//
// Pure: no DOM, no network, no audio.

import { buildScore, SCORE_VERSION, formatClock, excludedText } from './score.js';
import { facts as factsOf, FACTS_VERSION, flagNames, amountOf } from './explorer/facts.js';
import { featuresOf } from './geiger.js';
import { CASE_VERSION, MOMENT_VERSION, ANNOTATION_KINDS, MAX_ANNOTATION_CHARS, validateCase, serializeCase, normalizeAnchor } from './case.js';
import { MAPPING_VERSION, CATEGORY_NAMES } from './mapping.js';
import { SITE_URL } from './explorers.js';

export const LEVELS = Object.freeze(['gist', 'evidence']);

/**
 * Characters. Chosen after measuring representative cases (see
 * docs/copy-for-ai.md): a one-ledger moment of ~60 events renders in about
 * 14,000 characters at the gist level, so this keeps such a moment whole
 * and makes a busy window say "N of M events shown". A visible number, not a
 * promise: the size is shown before copying.
 */
export const DEFAULT_BUDGET = 24000;

export const SELECTION_RULE = 'the anchor event, then cast-involved events, then the rest in application order';

/** The fixed part of the trailer, before the example. */
export const REPLY_TRAILER_HEAD = `how to reply:
Answer the question above (or, if there is none, say what happened in these records and what to look at). Keep observations, what these records show, apart from hypotheses, what might explain them. For each one, cite the hash of every transaction you rely on, taken from this text. Say plainly what you could not establish from this text. Do not infer common ownership or intent from accounts appearing together. Then return your notes as a JSON array of annotations in this shape, which xrpl-sonic imports as drafts:
[{"text": "...", "anchor": {"hash": "<64-hex transaction hash from this text>"} or {"ledger": <ledger index>} or {"timeMs": <milliseconds on the case timeline>}, "kind": "observation" or "hypothesis" or "question", "evidence": ["<hash>", ...], "source": "<who you are>", "status": "draft"}]
`;

/** The one example in the trailer, in the exact annotation shape of src/case.js. */
export function exampleAnnotation(hash) {
  return { text: 'One sentence of what the cited record shows.', anchor: { hash }, kind: 'observation', evidence: [hash], source: 'assistant', status: 'draft' };
}

/** The explorer's route for a transaction, on the network's page. */
export function explorerRoute(network, hash) {
  return `${SITE_URL}explorer.html${network === 'testnet' ? '?network=testnet' : ''}#tx/${hash}`;
}

const HASH = /^[0-9A-F]{64}$/i;
const upper = (h) => (typeof h === 'string' ? h.toUpperCase() : h);

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Every fetched ledger of the case in clip order: { index, ledger } (ledger null when unavailable). */
function scopeLedgers(theCase, ledgers) {
  const out = [];
  for (const clip of theCase.clips) for (let n = clip.from; n <= clip.to; n++) out.push({ index: n, ledger: ledgers?.get?.(n)?.ledger ?? null });
  return out;
}

/** The transactions of the fetched ledgers, with where they sit. */
function scopeTransactions(theCase, ledgers) {
  const out = [];
  for (const { index, ledger } of scopeLedgers(theCase, ledgers)) {
    for (const tx of ledger?.transactions ?? []) {
      if (!tx || typeof tx !== 'object') continue;
      out.push({ tx, meta: tx.metaData ?? tx.meta ?? null, ledgerIndex: index, hash: upper(tx.hash) ?? null, closeTime: ledger.close_time ?? null });
    }
  }
  return out;
}

/**
 * The Part A facts for every transaction in scope, keyed by hash. This is
 * the `facts` argument of describe(); a Node entry point can build it the
 * same way, or hand in facts it already has.
 * @returns {Map<string, object>}
 */
export function factsForCase(theCase, ledgers) {
  const map = new Map();
  for (const t of scopeTransactions(theCase, ledgers)) {
    if (!t.hash) continue;
    map.set(t.hash, factsOf(t.tx, t.meta, { network: theCase.network, closeTime: t.closeTime }));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Rendering helpers: verbatim values
// ---------------------------------------------------------------------------

/** An exact amount as text: drops for XRP, the decimal with currency and issuer otherwise. */
function amountText(a) {
  if (!a) return 'none';
  if (a.currency === 'XRP' && a.drops != null) return `${a.drops} drops`;
  if (a.issuanceId) return `${a.value} MPT ${a.issuanceId}`;
  const code = a.code && a.code !== a.currency ? ` (${a.code})` : '';
  return `${a.value} ${a.currency}${code} issuer ${a.issuer}`;
}

const isAmount = (v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.currency === 'string' && (v.drops != null || v.value != null);

/** A finding's value, exact and readable: amounts as amounts, yes/no for booleans, objects as "key value" lists. */
function fmtValue(v, depth = 0) {
  if (v == null) return 'null';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.map((x) => fmtValue(x, depth + 1)).join(', ')}]`;
  if (isAmount(v)) return amountText(v);
  const inner = Object.entries(v).map(([k, x]) => `${k} ${fmtValue(x, depth + 1)}`).join(', ');
  return depth ? `{${inner}}` : inner;
}

const fmtPct = (n, of) => (of ? `${((n / of) * 100).toFixed(1)}%` : '0.0%');

// ---------------------------------------------------------------------------
// The text
// ---------------------------------------------------------------------------

/**
 * @param {object} theCase   a validated case (src/case.js)
 * @param {Map<number, { ledger: object|null, nextCloseTime: number|null }>} ledgers  as fetchCaseLedgers returns them
 * @param {Map<string, object>} facts  from factsForCase()
 * @param {{ level?: 'gist'|'evidence', budget?: number, caseLink?: string|null }} [options]
 * @returns {{ text: string, chars: number, tokensApprox: number, shown: number, total: number, rule: string|null, level: string, budget: number }}
 */
export function describeReport(theCase, ledgers, facts, { level = 'gist', budget = DEFAULT_BUDGET, caseLink = null } = {}) {
  const lvl = LEVELS.includes(level) ? level : 'gist';
  const limit = Number.isFinite(Number(budget)) && Number(budget) > 0 ? Math.round(Number(budget)) : DEFAULT_BUDGET;
  const m = theCase.moment ?? null;
  const score = buildScore(theCase, ledgers);
  const scope = scopeLedgers(theCase, ledgers);
  const txs = scopeTransactions(theCase, ledgers);
  const byHash = new Map(txs.map((t) => [t.hash, t]));
  const cast = theCase.cast ?? [];
  const labelOf = new Map(cast.map((c) => [c.address, c.label]));
  const labelById = new Map(cast.map((c) => [c.id, c.label]));
  const withLabel = (address) => (labelOf.has(address) ? `${address} "${labelOf.get(address)}"` : address);
  const question = (theCase.annotations ?? []).find((a) => a.question || a.kind === 'question') ?? null;
  const anchor = m?.anchor ?? question?.anchor ?? null;
  const anchorHash = anchor?.hash ? upper(anchor.hash) : null;

  // --- header
  const head = [];
  head.push(`xrpl-sonic case · Copy for AI · level ${lvl}`);
  head.push(`versions: case ${CASE_VERSION} · moment ${m ? MOMENT_VERSION : 'none'} · facts ${FACTS_VERSION} · mapping ${MAPPING_VERSION} · score ${SCORE_VERSION}`);
  const saved = m ? ` · saved: ${m.savedAt || 'unknown'} ${m.mode === 'explorer' ? 'from the explorer' : `while listening ${m.mode}`}` : '';
  head.push(`network: ${theCase.network} · host: ${m?.host || 'unknown'}${saved}`);
  head.push(`case: ${theCase.id}${theCase.title ? ` · "${theCase.title}"` : ''}`);
  const anchorText = !anchor ? 'none' : anchor.hash ? `tx ${anchorHash}` : anchor.ledger != null ? `ledger #${anchor.ledger}` : `${formatClock(anchor.timeMs)} on the case timeline`;
  head.push(`question: ${question ? `"${question.text}"` : 'none'} · anchor: ${anchorText}`);
  const hashOf = (n) => ledgers?.get?.(n)?.ledger?.ledger_hash ?? m?.ledgers?.find((l) => l.index === n)?.hash ?? 'unknown';
  theCase.clips.forEach((clip, i) => {
    const parts = [];
    for (let n = clip.from; n <= clip.to; n++) parts.push(`#${n} hash ${hashOf(n)}`);
    head.push(`scope: clip ${i + 1}: ledgers ${clip.from}–${clip.to} · ${parts.join(' · ')}`);
    const gap = score.gaps.find((g) => g.afterLedger === clip.to);
    if (gap) head.push(`  gap: ${gap.omitted} ledger${gap.omitted === 1 ? '' : 's'} omitted between #${gap.afterLedger} and #${gap.beforeLedger}`);
  });
  if (m?.loop) head.push(`loop: ${formatClock(m.loop.fromMs)}–${formatClock(m.loop.toMs)} on the case timeline`);
  if (m?.mode === 'live' && m.ledgers?.length) head.push(`coverage (as heard when saved, received/expected per ledger): ${m.ledgers.map((l) => `#${l.index} ${l.received ?? 0}/${l.expected ?? '?'}`).join(' · ')}`);
  head.push(`coverage (fetched for this text): ${scope.map(({ index, ledger }) => (ledger ? `#${index} fetched, ${(ledger.transactions ?? []).length} transactions` : `#${index} unavailable`)).join(' · ')}`);

  // --- counts
  const available = txs.length;
  const unavailable = scope.filter((s) => !s.ledger).length;
  const counts = ['counts:'];
  counts.push(`  available in scope (sum of txn_count over the fetched ledgers): ${available}${unavailable ? ` (${unavailable} ledger${unavailable === 1 ? '' : 's'} unavailable, not counted)` : ''}`);
  counts.push(`  selected by the listening settings (events in the score): ${score.counts.events}`);
  counts.push(`  excluded by reason: ${score.counts.excluded?.total ? excludedText(score.counts) : 'none'}`);

  // --- settings
  const f = theCase.filters;
  const off = CATEGORY_NAMES.filter((c) => f.enabled[c] === false);
  const settings = `listening settings (context for the selection, not facts about the ledger): cast: ${cast.length ? cast.map((c) => `${c.address} "${c.label}"`).join(', ') : 'none'}; categories: ${off.length ? `off: ${off.join(', ')}` : 'all on'}; failed transactions: ${f.includeFailed ? 'included' : 'excluded'}; quiet threshold: ${f.quietThreshold > 0 ? `${f.quietThreshold} XRP` : 'off'}; scale: ${theCase.mapping.scale}; key: ${theCase.mapping.key}; mapping: ${theCase.mapping.version}; cast mode: ${f.castMode}; speed: ${theCase.timing.speed}x`;

  // --- concentration
  const conc = [];
  if (!available) conc.push('concentration: no transactions available');
  else {
    conc.push(`concentration (submitting accounts among the ${available} available transactions):`);
    const senders = new Map();
    for (const t of txs) if (t.tx.Account) senders.set(t.tx.Account, (senders.get(t.tx.Account) ?? 0) + 1);
    const top = [...senders.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 8);
    for (const [address, n] of top) conc.push(`  ${withLabel(address)}: ${n} (${fmtPct(n, available)})`);
    if (cast.length) {
      const feat = featuresOf(txs.map((t) => t.tx), cast);
      for (const c of cast) {
        const r = feat.members[c.id] ?? { submitted: 0, involved: 0 };
        conc.push(`  cast: "${c.label}" ${c.address} submitted ${r.submitted}, involved ${r.involved}`);
      }
    } else conc.push('  cast: none');
  }

  // --- events
  const eventLine = (item) => {
    const t = byHash.get(upper(item.hash));
    const tx = t?.tx ?? {};
    const meta = t?.meta ?? {};
    const type = tx.TransactionType ?? item.event.txType;
    const result = meta.TransactionResult ?? item.event.result ?? 'unknown';
    const bits = [`#${item.ledgerIndex} tx ${item.txIndex ?? '?'} ${upper(item.hash)} ${type} ${result} from ${withLabel(tx.Account)}`];
    if (tx.Destination) bits.push(`to ${withLabel(tx.Destination)}`);
    const tail = [];
    if (type === 'Payment') {
      const delivered = meta.delivered_amount ?? meta.DeliveredAmount;
      if (delivered === 'unavailable') tail.push(`delivered unavailable; asked ${amountText(amountOf(tx.DeliverMax ?? tx.Amount))}`);
      else tail.push(`delivered ${amountText(amountOf(delivered ?? tx.DeliverMax ?? tx.Amount))}`);
    } else if (type === 'OfferCreate') {
      tail.push(`gives ${amountText(amountOf(tx.TakerGets))} for ${amountText(amountOf(tx.TakerPays))}`);
      if (tx.OfferSequence != null) tail.push(`replaces offer ${tx.OfferSequence}`);
    } else if (type === 'OfferCancel') tail.push(`cancels offer ${tx.OfferSequence}`);
    else if (type === 'TrustSet') tail.push(`limit ${amountText(amountOf(tx.LimitAmount))}`);
    else if (tx.Amount != null) tail.push(`amount ${amountText(amountOf(tx.Amount))}`);
    const tags = [];
    if (anchorHash && upper(item.hash) === anchorHash) tags.push('[anchor]');
    if (item.cast?.length) tags.push(`[cast: ${item.cast.map((id) => labelById.get(id) ?? id).join(', ')}]`);
    return `  ${bits.join(' ')}${tail.length ? ` · ${tail.join(' · ')}` : ''}${tags.length ? ` ${tags.join(' ')}` : ''}`;
  };
  const items = score.events;
  const total = items.length;
  const lines = items.map(eventLine);

  // --- findings
  const involved = new Set(items.filter((i) => i.cast?.length).map((i) => upper(i.hash)));
  const subjects = [];
  if (anchorHash) subjects.push(anchorHash);
  if (lvl === 'evidence') for (const h of involved) if (!subjects.includes(h)) subjects.push(h);
  const findingLines = [];
  const findingsFor = (hash) => {
    const t = byHash.get(hash);
    const fx = facts?.get?.(hash);
    const roles = [];
    if (hash === anchorHash) roles.push('the anchor');
    const castItem = items.find((i) => upper(i.hash) === hash && i.cast?.length);
    if (castItem) roles.push(`cast: ${castItem.cast.map((id) => labelById.get(id) ?? id).join(', ')}`);
    const type = t?.tx?.TransactionType ?? fx?.transaction?.type ?? 'unknown';
    const out = [`findings for ${hash} (${type}${roles.length ? `, ${roles.join(', ')}` : ''}):`];
    if (!fx) {
      out.push('  not available: this transaction is not in the fetched ledgers');
      return out;
    }
    for (const x of fx.findings) {
      const ev = x.evidence.map((e) => (e.node != null ? `node ${e.node} ${e.field}` : e.field)).join(', ');
      out.push(`  [${x.tier}] ${x.rule} ${x.subject}.${x.property} = ${fmtValue(x.value)}${ev ? ` · evidence: ${ev}` : ''}${x.note ? ` · note: ${x.note}` : ''}`);
    }
    if (lvl === 'evidence' && t) {
      const tx = t.tx;
      const meta = t.meta ?? {};
      const names = flagNames(tx);
      const src = [`TransactionType ${tx.TransactionType}`, `Account ${tx.Account}`];
      if (tx.Destination) src.push(`Destination ${tx.Destination}`);
      src.push(`Flags ${Number(tx.Flags) || 0} (${names.length ? names.join(' ') : 'none'})`);
      if (tx.DeliverMax != null || tx.Amount != null) src.push(`${tx.DeliverMax != null ? 'DeliverMax' : 'Amount'} ${amountText(amountOf(tx.DeliverMax ?? tx.Amount))}`);
      if (meta.delivered_amount != null) src.push(`delivered_amount ${meta.delivered_amount === 'unavailable' ? 'unavailable' : amountText(amountOf(meta.delivered_amount))}`);
      if (tx.TakerGets != null) src.push(`TakerGets ${amountText(amountOf(tx.TakerGets))}`);
      if (tx.TakerPays != null) src.push(`TakerPays ${amountText(amountOf(tx.TakerPays))}`);
      src.push(`Fee ${tx.Fee ?? 'unknown'}`, `Sequence ${tx.Sequence ?? 'unknown'}`);
      if (tx.OfferSequence != null) src.push(`OfferSequence ${tx.OfferSequence}`);
      src.push(`TransactionResult ${meta.TransactionResult ?? 'unknown'}`);
      out.push(`  source fields: ${src.join(' · ')}`);
    }
    return out;
  };
  if (subjects.length) for (const h of subjects) findingLines.push(...findingsFor(h));
  else if (!anchor) findingLines.push('findings: no anchor transaction, so there are none at the gist level');
  else if (anchor.ledger != null) findingLines.push('findings: the anchor is a ledger, not a transaction, so there are none at the gist level');
  else findingLines.push('findings: the anchor is a position, not a transaction, so there are none at the gist level');

  // --- links and trailer
  const links = ['links:', `  case: ${caseLink || 'not available in this rendering'}`, `  explorer: ${SITE_URL}explorer.html#tx/<hash> for any hash in this text`];
  for (const h of subjects) links.push(`  ${h}: ${explorerRoute(theCase.network, h)}`);
  const exampleHash = anchorHash ?? (items[0] ? upper(items[0].hash) : '0'.repeat(64));
  const trailer = `${REPLY_TRAILER_HEAD}example:\n${JSON.stringify([exampleAnnotation(exampleHash)])}\n`;

  // --- assemble, selecting events under the budget
  const assemble = (eventsHeader, eventLines) => [...head, '', ...counts, settings, '', ...conc, '', eventsHeader, ...eventLines, '', ...findingLines, '', ...links, '', trailer].join('\n');
  let text = assemble(total ? 'events (' + `${total} of ${total} shown; order: as applied in each ledger):` : 'events: none selected by the listening settings', lines);
  let shown = total;
  let rule = null;
  if (text.length > limit && total > 0) {
    const order = [];
    const seen = new Set();
    const take = (i) => {
      if (!seen.has(i)) {
        seen.add(i);
        order.push(i);
      }
    };
    items.forEach((it, i) => {
      if (anchorHash && upper(it.hash) === anchorHash) take(i);
    });
    items.forEach((it, i) => {
      if (it.cast?.length) take(i);
    });
    items.forEach((_, i) => take(i));
    const fixed = assemble(`events (${total} of ${total} shown; rule: ${SELECTION_RULE}, up to the budget of ${limit} characters):`, []).length;
    const chosen = [];
    let used = fixed;
    for (const i of order) {
      const cost = lines[i].length + 1;
      if (chosen.length && used + cost > limit) break;
      chosen.push(i);
      used += cost;
    }
    shown = chosen.length;
    rule = SELECTION_RULE;
    text = assemble(`events (${shown} of ${total} shown; rule: ${SELECTION_RULE}, up to the budget of ${limit} characters):`, chosen.map((i) => lines[i]));
  }
  return { text, chars: text.length, tokensApprox: Math.ceil(text.length / 4), shown, total, rule, level: lvl, budget: limit };
}

/** The text alone. */
export function describe(theCase, ledgers, facts, options = {}) {
  return describeReport(theCase, ledgers, facts, options).text;
}

// ---------------------------------------------------------------------------
// The return path: pasted annotations become drafts on the case
// ---------------------------------------------------------------------------

/**
 * Import annotations an assistant returned: an array, a whole case (its
 * annotations are merged), or the JSON text of either. Each is validated by
 * the case's annotation rules, set to draft with the given source, and its
 * anchor resolved against the score when one is given. Nothing existing is
 * overwritten; incoming ids are not kept.
 * @returns {{ case: object, accepted: { id, text, anchor, kind }[], rejected: { index, reason, text? }[] }}
 */
export function importAnnotations(theCase, input, { source = 'assistant', score = null } = {}) {
  const rejected = [];
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (err) {
      return { case: theCase, accepted: [], rejected: [{ index: 0, reason: `not JSON: ${err?.message ?? err}` }] };
    }
  }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray(raw.annotations) ? raw.annotations : null;
  if (!list) return { case: theCase, accepted: [], rejected: [{ index: 0, reason: 'no annotations: expected an array, or a case with an annotations array' }] };
  const existing = new Set((theCase.annotations ?? []).map((a) => `${JSON.stringify(a.anchor)}|${a.text}`));
  const candidates = [];
  list.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      rejected.push({ index, reason: 'not an object' });
      return;
    }
    const text = typeof item.text === 'string' ? item.text.trim().slice(0, MAX_ANNOTATION_CHARS) : '';
    if (!text) {
      rejected.push({ index, reason: 'no text' });
      return;
    }
    const anchor = normalizeAnchor(item.anchor);
    if (!anchor) {
      rejected.push({ index, reason: 'no usable anchor (hash, ledger or timeMs)', text });
      return;
    }
    if (score) {
      if (anchor.hash && !(score.events ?? []).some((e) => upper(e.hash) === anchor.hash)) {
        rejected.push({ index, reason: `hash ${anchor.hash} is not in this case`, text });
        return;
      }
      if (anchor.hash == null && anchor.ledger != null && !(score.ledgers ?? []).some((l) => l.ledgerIndex === anchor.ledger)) {
        rejected.push({ index, reason: `ledger #${anchor.ledger} is not in this case`, text });
        return;
      }
      if (anchor.hash == null && anchor.ledger == null && anchor.timeMs > (score.totalMs ?? 0)) {
        rejected.push({ index, reason: `timeMs ${anchor.timeMs} is beyond the end of this case (${score.totalMs ?? 0})`, text });
        return;
      }
    }
    const key = `${JSON.stringify(anchor)}|${text}`;
    if (existing.has(key)) {
      rejected.push({ index, reason: 'already present', text });
      return;
    }
    existing.add(key);
    candidates.push({ index, annotation: { anchor, text, source, status: 'draft', pause: false, ...(ANNOTATION_KINDS.includes(item.kind) ? { kind: item.kind } : {}), ...(Array.isArray(item.evidence) ? { evidence: item.evidence } : {}) } });
  });
  if (!candidates.length) return { case: theCase, accepted: [], rejected };
  const merged = validateCase(JSON.parse(serializeCase({ ...theCase, annotations: [...(theCase.annotations ?? []), ...candidates.map((c) => c.annotation)] })));
  const before = (theCase.annotations ?? []).length;
  const added = merged.case ? merged.case.annotations.slice(before) : [];
  const accepted = [];
  candidates.forEach((c, i) => {
    const a = added[i];
    if (!a) rejected.push({ index: c.index, reason: merged.errors.find((e) => /at most|annotation/.test(e)) ?? 'dropped by validation', text: c.annotation.text });
    else accepted.push({ id: a.id, text: a.text, anchor: a.anchor, kind: a.kind ?? null });
  });
  rejected.sort((a, b) => a.index - b.index);
  return { case: merged.case && accepted.length ? merged.case : theCase, accepted, rejected };
}

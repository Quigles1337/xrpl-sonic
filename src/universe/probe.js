// UNIVERSE phase 2 — the probe's measures, pure.
//
// A hold on a planet probes its account. This module is the arithmetic of
// that probe, with no DOM, no network and no worker in it: the touch graph of
// the window and a random walk with restart over it (record proximity), flow
// conservation from the exact balance changes of a bounded history (inflow
// and outflow per currency, the lag at which they best match), the account's
// own cadence (src/coherence.js cadenceOf on its own series), the coherence
// of the account against a named list of others (src/coherence.js
// pairCoherence, one pair per other, the prewhitened statistic with its null,
// the pairs tested and the percentile beside it, the record check), and the
// catch: the lit planets with one label per measure in the readout's own
// words. Nothing here says "coordinated"; a pass-through is a number, never
// a role; phase 3's two slots (influence, motif) are present and read "not
// measured (phase 3)". docs/universe.md, phase 2.
//
// Every amount stays an exact decimal string (src/decimal.js); the only
// Number made of an amount is the share shown beside "within", and the text
// says it is a share.

import { balanceFacts } from '../explorer/facts.js';
import { add, sub, abs, cmp, isZero, isNegative } from '../decimal.js';
import { normalise, cadenceOf, pairCoherence, significant, DEFAULTS as COHERENCE_DEFAULTS } from '../coherence.js';
import { unwrapEntry } from '../account-tx.js';
import { RIPPLE_EPOCH_OFFSET } from '../mapping.js';

export const PROBE_VERSION = 1;
export const TIER = Object.freeze({ calculated: 'calculated', observation: 'observation' });
export const PHASE3 = 'not measured (phase 3)';
export const DEFAULTS = Object.freeze({ restart: 0.15, iterations: 60, maxLag: 8, nearest: 6, historyLedgers: 2000, litMost: 24 });

// --- the touch graph and the walk ----------------------------------------------------------------

/**
 * The adjacency of the window's touch graph from the universe's edges
 * (src/universe/universe.js: { a, b, count } per pair), each pair once, the
 * weight its count. Ids are the universe's planet ids.
 * @param {Iterable<{ a: number, b: number, count: number }>} edges
 * @returns {Map<number, [number, number][]>}  id → [[neighbour, weight], …]
 */
export function touchGraph(edges) {
  const adj = new Map();
  for (const e of edges) {
    if (!e || !(e.a > 0) || !(e.b > 0) || e.a === e.b) continue;
    const w = Math.max(0, Number(e.count) || 0);
    if (!w) continue;
    (adj.get(e.a) ?? adj.set(e.a, []).get(e.a)).push([e.b, w]);
    (adj.get(e.b) ?? adj.set(e.b, []).get(e.b)).push([e.a, w]);
  }
  return adj;
}

/**
 * Record proximity: a random walk with restart from one planet over the
 * touch graph (personalised PageRank by power iteration: at each step the
 * walker follows a weighted edge with probability 1 − restart, or returns
 * to the start). The stationary mass on every planet the walk reaches, and
 * each one's rank among them (the start excluded). Tier: calculated, it is
 * arithmetic over the record.
 * @returns {{ scores: Map<number, number>, ranked: number[], reached: number, iterations: number, restart: number }}
 */
export function randomWalk(adj, start, { restart = DEFAULTS.restart, iterations = DEFAULTS.iterations } = {}) {
  if (!adj.has(start)) return { scores: new Map(), ranked: [], reached: 0, iterations: 0, restart };
  let p = new Map([[start, 1]]);
  for (let it = 0; it < iterations; it++) {
    const next = new Map([[start, restart]]);
    for (const [id, mass] of p) {
      const out = adj.get(id);
      if (!out?.length) {
        // a dead end returns to the start
        next.set(start, (next.get(start) ?? 0) + mass * (1 - restart));
        continue;
      }
      let total = 0;
      for (const [, w] of out) total += w;
      for (const [nb, w] of out) next.set(nb, (next.get(nb) ?? 0) + (mass * (1 - restart) * w) / total);
    }
    p = next;
  }
  const ranked = [...p.entries()]
    .filter(([id, m]) => id !== start && m > 1e-12)
    .sort((x, y) => y[1] - x[1] || x[0] - y[0])
    .map(([id]) => id);
  return { scores: p, ranked, reached: ranked.length, iterations, restart };
}

// --- flow conservation ----------------------------------------------------------------

const keyOf = (f) => (f.currency === 'XRP' ? 'XRP' : `${f.currency}/${f.issuer ?? ''}`);

/**
 * The account's exact balance changes per transaction of a bounded history
 * (account_tx entries, src/account-tx.js unwrapEntry; src/explorer/facts.js
 * balanceFacts), per currency and per ledger: inflow (deltas above zero) and
 * outflow (deltas below zero, their size), as decimal strings.
 * @returns {Map<string, { currency: string, issuer: string|null, byLedger: Map<number, { inflow: string, outflow: string, transactions: number }> }>}
 */
export function flowsOf(entries, account) {
  const flows = new Map();
  for (const entry of entries ?? []) {
    const u = unwrapEntry(entry);
    if (!u || !u.success || !u.meta) continue;
    for (const f of balanceFacts(u.meta)) {
      if (f.account !== account || !f.exact?.delta || isZero(f.exact.delta)) continue;
      const key = keyOf(f);
      const flow = flows.get(key) ?? flows.set(key, { currency: f.currency, issuer: f.currency === 'XRP' ? null : (f.issuer ?? null), byLedger: new Map() }).get(key);
      const row = flow.byLedger.get(u.ledgerIndex) ?? flow.byLedger.set(u.ledgerIndex, { inflow: '0', outflow: '0', transactions: 0 }).get(u.ledgerIndex);
      if (isNegative(f.exact.delta)) row.outflow = add(row.outflow, abs(f.exact.delta));
      else row.inflow = add(row.inflow, f.exact.delta);
      row.transactions += 1;
    }
  }
  return flows;
}

/**
 * Flow conservation per currency over the history: total inflow and outflow
 * (exact), their difference, the share of the larger that the difference is
 * (a Number, for the words "within N%"), and the lag in ledgers at which the
 * cumulative inflow best matches the cumulative outflow shifted by that lag
 * (the lag with the least summed absolute difference over the ledgers both
 * cover, 0..maxLag; a Number comparison, the amounts stay strings). XRP
 * outflow includes fees, and the row says so. Tier: calculated.
 * @returns {{ currency: string, issuer: string|null, inflow: string, outflow: string, difference: string, within: number|null, lag: number|null, ledgers: number, transactions: number, feesIncluded: boolean }[]}
 */
export function conservation(entries, account, { maxLag = DEFAULTS.maxLag } = {}) {
  const out = [];
  for (const flow of flowsOf(entries, account).values()) {
    const ledgers = [...flow.byLedger.keys()].sort((a, b) => a - b);
    let inflow = '0';
    let outflow = '0';
    let transactions = 0;
    const cumIn = [];
    const cumOut = [];
    for (const l of ledgers) {
      const row = flow.byLedger.get(l);
      inflow = add(inflow, row.inflow);
      outflow = add(outflow, row.outflow);
      transactions += row.transactions;
      cumIn.push(Number(inflow));
      cumOut.push(Number(outflow));
    }
    const difference = abs(sub(inflow, outflow));
    const larger = cmp(inflow, outflow) >= 0 ? inflow : outflow;
    const within = isZero(larger) ? null : Number(difference) / Number(larger);
    let lag = null;
    let least = Infinity;
    const span = ledgers.length - 1;
    for (let L = 0; L <= Math.min(maxLag, span); L++) {
      // outflow at ledger i + L against inflow at ledger i, over the rows both cover
      let sum = 0;
      let n = 0;
      for (let i = 0; i + L < cumIn.length; i++) {
        sum += Math.abs(cumIn[i] - cumOut[i + L]);
        n += 1;
      }
      if (!n) continue;
      const mean = sum / n;
      if (mean < least - 1e-12) {
        least = mean;
        lag = L;
      }
    }
    out.push({ currency: flow.currency, issuer: flow.issuer, inflow, outflow, difference, within, lag, ledgers: ledgers.length, transactions, feesIncluded: flow.currency === 'XRP' });
  }
  return out.sort((a, b) => b.transactions - a.transactions || (a.currency < b.currency ? -1 : 1));
}

// --- the account's own series and cadence ----------------------------------------------------------------

/**
 * The account's own series over a ledger range: transactions it submitted
 * per ledger, one row per ledger of the range (a row the history did not
 * cover is zero only because the fetch covered the range: the caller states
 * the bound).
 */
export function seriesOf(entries, account, { from, to }) {
  const n = Math.max(0, to - from + 1);
  const values = new Array(n).fill(0);
  for (const entry of entries ?? []) {
    const u = unwrapEntry(entry);
    if (!u || u.tx?.Account !== account) continue;
    const i = u.ledgerIndex - from;
    if (i >= 0 && i < n) values[i] += 1;
  }
  return values;
}

/** The account's cadence on its own series: src/coherence.js cadenceOf on the normalised series; the pulsar rule's words. */
export function cadence(values, { maxLag = DEFAULTS.maxLag, least = 0.3 } = {}) {
  const events = values.reduce((a, b) => a + b, 0);
  if (values.length < COHERENCE_DEFAULTS.minLedgers || events < COHERENCE_DEFAULTS.minEvents) return { period: null, r: null, events, ledgers: values.length, reason: values.length < COHERENCE_DEFAULTS.minLedgers ? 'too few ledgers' : 'too few events' };
  const { z, flat } = normalise(values);
  if (flat) return { period: null, r: null, events, ledgers: values.length, reason: 'flat' };
  const c = cadenceOf(z, maxLag, { least });
  return { period: c?.period ?? null, r: c?.r ?? null, events, ledgers: values.length, reason: c ? null : `no lag of two or more reaches r ≥ ${least}` };
}

// --- the history, newest first ----------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The account's recent history, newest first, bounded: account_tx between
 * two ledgers with forward: false, paged by marker, one page after the
 * other, a failed page retried once after a pause (a public node's tooBusy
 * is waited out longer), the rest of the bound marked missing when a page
 * fails twice. A copy of the loader's seam (R14 in docs/universe-requests.md):
 * src/account-tx.js pages forward only, and a busy account's recent ledgers
 * are what the probe needs. Entries come back oldest first.
 * @param {(cmd: object) => Promise<{ result?: object }>} request
 * @returns {Promise<{ entries: object[], pages: number, requests: number, more: boolean, missing: { from: number, to: number, reason: string }[], error: string|null, oldest: number|null, newest: number|null }>}
 */
export async function fetchRecentHistory(request, account, { from, to, limit = 200, maxPages = 5, retries = 1, retryDelayMs = 800, busyDelayMs = 3000, onPage = null } = {}) {
  const out = { entries: [], pages: 0, requests: 0, more: false, missing: [], error: null, oldest: null, newest: null };
  if (!Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to < from) {
    out.error = 'a range needs two ledger indices, from ≤ to';
    return out;
  }
  let marker = null;
  for (let page = 0; page < maxPages; page++) {
    const cmd = { command: 'account_tx', account, ledger_index_min: from, ledger_index_max: to, forward: false, limit, ...(marker ? { marker } : {}) };
    let res = null;
    let lastError = null;
    for (let attempt = 0; attempt <= retries && !res; attempt++) {
      out.requests += 1;
      try {
        res = await request(cmd);
      } catch (err) {
        lastError = err;
        if (attempt < retries) await sleep(err?.code === 'tooBusy' || err?.code === 'slowDown' ? busyDelayMs : retryDelayMs);
      }
    }
    if (!res) {
      const reached = out.oldest ?? to + 1;
      out.missing.push({ from, to: reached - 1, reason: lastError?.code ?? lastError?.message ?? 'failed' });
      out.error = lastError?.message ?? 'failed';
      break;
    }
    out.pages += 1;
    const list = res.result?.transactions ?? [];
    for (const e of list) {
      const u = unwrapEntry(e);
      if (!u) continue;
      out.entries.push(e);
      if (u.ledgerIndex != null) {
        out.oldest = out.oldest == null ? u.ledgerIndex : Math.min(out.oldest, u.ledgerIndex);
        out.newest = out.newest == null ? u.ledgerIndex : Math.max(out.newest, u.ledgerIndex);
      }
    }
    onPage?.({ pages: out.pages, entries: out.entries.length });
    marker = res.result?.marker ?? null;
    if (!marker) break;
    if (page === maxPages - 1) out.more = true;
  }
  out.entries.sort((a, b) => (unwrapEntry(a)?.ledgerIndex ?? 0) - (unwrapEntry(b)?.ledgerIndex ?? 0) || (Number(a.meta?.TransactionIndex ?? 0) - Number(b.meta?.TransactionIndex ?? 0)));
  return out;
}

// --- the window's frame for a named list ----------------------------------------------------------------

/**
 * The coherence frame of the live window for a named list of accounts
 * (src/moment.js LiveWindow.ledgers rows), as frameFromLive makes it
 * (included when the ledger's txn_count was heard in full), with one
 * difference the ground-truth run taught: an account that submitted fewer
 * than `minEvents` transactions in the window is read as the transactions
 * it was involved in per ledger (its address in a touch record's
 * destination, entries, lines or crossed), because a pool, a destination
 * or an issuer submits nothing; `measureOf` says which reading each
 * account got, for the labels. The involved reading leaves out the
 * transactions `except` submitted (the probed account): what it did to a
 * counterparty is its own series already, and counting it on the other
 * side would make every counterparty in step with it at lag 0. A copy of
 * R4's territory.
 */
export function frameFromWindow(ledgers, accounts, { minEvents = COHERENCE_DEFAULTS.minEvents, except = null } = {}) {
  const heard = Array.isArray(ledgers) ? ledgers : [];
  const frame = { source: 'live', measure: 'count', unit: 'ledger', bin: null, ledgers: [], accounts: [], series: new Map(), totals: new Map(), chosen: 'the probe', records: [], fetched: null, measureOf: new Map() };
  if (!heard.length) return frame;
  frame.ledgers = heard.map((l) => {
    const expected = l.txnCount == null ? null : Number(l.txnCount);
    const received = Number(l.received) || 0;
    const reason = expected == null ? 'unknown' : received < expected ? 'incomplete' : null;
    return { index: Number(l.index), included: !reason, reason, hash: l.hash ?? null, received, expected, closeTime: Number.isFinite(Number(l.closeTime)) ? Number(l.closeTime) + RIPPLE_EPOCH_OFFSET : null };
  });
  const list = accounts.map((a) => (typeof a === 'string' ? { address: a, label: a } : a)).filter((a) => a && typeof a.address === 'string');
  const submitted = new Map(list.map((a) => [a.address, new Array(heard.length).fill(0)]));
  const involved = new Map(list.map((a) => [a.address, new Array(heard.length).fill(0)]));
  heard.forEach((l, i) => {
    if (!frame.ledgers[i].included) return;
    for (const a of list) submitted.get(a.address)[i] += Number(l.accounts?.[a.address]?.count) || 0;
    for (const t of l.touches ?? []) {
      frame.records.push(t);
      const names = new Set([t.destination, ...(t.entries ?? []), ...(t.lines ?? []), ...(t.crossed ?? [])].filter(Boolean));
      if (except && t.submitter === except) continue; // the probed account's own transactions are its own series, not the other's
      for (const a of list) if (names.has(a.address) && t.submitter !== a.address) involved.get(a.address)[i] += 1;
    }
  });
  frame.accounts = list.map((a) => ({ address: a.address, label: a.label ?? a.address }));
  for (const a of frame.accounts) {
    const s = submitted.get(a.address);
    const total = s.reduce((x, y) => x + y, 0);
    const read = total >= minEvents ? 'submitted' : 'involved';
    const series = read === 'submitted' ? s : involved.get(a.address);
    frame.series.set(a.address, series);
    frame.totals.set(a.address, series.reduce((x, y) => x + y, 0));
    frame.measureOf.set(a.address, read);
  }
  return frame;
}

// --- coherence against a named list ----------------------------------------------------------------

/**
 * The probed account against each of a named list, one pair per other over
 * the frame (src/coherence.js frameFromLive with the list as its cast, so the
 * series are theirs), the full readout per pair: the prewhitened r and lag,
 * the null (pairs tested = the pairs with a null; the percentile = the share
 * of shifts the observed beat), the record check. Tier: observation.
 * @returns {{ pairs: object[], tested: number, significant: number }}
 */
export function coherenceAgainst(frame, address, others, options = COHERENCE_DEFAULTS) {
  const me = frame.accounts.find((a) => a.address === address);
  if (!me) return { pairs: [], tested: 0, significant: 0 };
  const pairs = [];
  for (const other of others) {
    const b = frame.accounts.find((a) => a.address === other);
    if (!b || b.address === address) continue;
    pairs.push(pairCoherence(frame, me, b, options));
  }
  const tested = pairs.filter((p) => p.shuffle?.count || p.white?.shuffle?.count).length;
  for (const p of pairs) p.tested = tested;
  pairs.sort((x, y) => Math.abs(y.white?.r ?? 0) - Math.abs(x.white?.r ?? 0) || (y.white?.shuffle?.percentile ?? 0) - (x.white?.shuffle?.percentile ?? 0));
  return { pairs, tested, significant: pairs.filter((p) => p.judged && significant(p, options.significance)).length, measureOf: frame.measureOf ?? null };
}

// --- the words ----------------------------------------------------------------

const pct = (x) => `${(100 * x).toFixed(x < 0.01 ? 2 : 1)}%`;
const num = (n) => Number(n).toLocaleString('en-US');
const sign = (l) => (l >= 0 ? `+${l}` : `${l}`);

/** "record proximity 0.031, rank 3 of 240" — the walk's mass on a planet and its rank among the reached. */
export function proximityLabel(walk, id) {
  const m = walk.scores.get(id);
  if (!(m > 0)) return 'record proximity 0: not reached by the walk';
  const rank = walk.ranked.indexOf(id) + 1;
  return `record proximity ${m.toFixed(m < 0.001 ? 5 : 3)}, rank ${rank} of ${walk.reached}`;
}

/** "connected in the record: 12 transactions (7 destination, 5 entry)" from the universe's edge between the two, by category. */
export function connectionLabel(edge, categoryNames) {
  if (!edge || !(edge.count > 0)) return 'not connected in the record';
  const parts = [];
  if (Array.isArray(edge.byCategory)) edge.byCategory.forEach((n, i) => n > 0 && parts.push(`${n} ${categoryNames?.[i] ?? i}`));
  return `connected in the record: ${num(edge.count)} transaction${edge.count === 1 ? '' : 's'}${parts.length ? ` (${parts.join(', ')})` : ''}${edge.trust ? ' · a trust line between them' : ''}`;
}

/** The flow line: "inflow 1,204.5 USD, outflow 1,198.0 USD, within 0.5% at a lag of 2 ledgers (fees included)". */
export function conservationLabel(row) {
  const unit = row.currency === 'XRP' ? 'drops' : row.currency;
  const within = row.within == null ? 'nothing moved' : row.within === 0 ? 'equal' : `within ${pct(row.within)} of the larger`;
  const lag = row.lag == null ? '' : ` at a lag of ${row.lag} ledger${row.lag === 1 ? '' : 's'}`;
  return `inflow ${row.inflow} ${unit}, outflow ${row.outflow} ${unit}, ${within}${lag}, over ${num(row.ledgers)} ledger${row.ledgers === 1 ? '' : 's'} and ${num(row.transactions)} transaction${row.transactions === 1 ? '' : 's'}${row.feesIncluded ? ' (fees included in the outflow)' : ''}${row.issuer ? ` · issuer ${row.issuer}` : ''}`;
}

/** The cadence line in the pulsar rule's words. */
export function cadenceLabel(c) {
  if (c.period == null) return `no cadence: ${c.reason} (${num(c.events)} of its own in ${num(c.ledgers)} ledgers)`;
  return `cadence: every ${c.period} ledgers (r ${c.r.toFixed(2)} on its own series, ${num(c.events)} of its own in ${num(c.ledgers)} ledgers)`;
}

/**
 * The pair line, the phase 1.5 readout's words: "in step at lag +1 · r 0.62 prewhitened (raw 0.71) · above 97% of 200 shuffles · 6 pairs tested ·
 * connected in the record: 3" or "· not touching"; a pair not judged says why. Never "coordinated".
 */
export function coherenceLabel(pair, measureOf = null) {
  const recOf = (p) => (p.record == null ? 'record not available' : p.record.count ? `connected in the record: ${num(p.record.count)}` : 'not touching');
  const other = measureOf?.get?.(pair.b?.address) === 'involved' ? ' · the other read as involved: it submits little in the window' : '';
  if (!pair.judged) return `not judged: ${pair.reason ?? 'too little to measure'}${other} · ${recOf(pair)}`;
  const w = pair.white ?? {};
  const s = w.shuffle ?? pair.shuffle ?? null;
  const inStep = significant(pair);
  const head = inStep ? `in step at lag ${sign(w.lag ?? pair.lag)}` : `not in step (best lag ${sign(w.lag ?? pair.lag)})`;
  const r = w.r == null ? `r ${pair.r?.toFixed(2) ?? '—'} raw` : `r ${w.r.toFixed(2)} prewhitened (raw ${pair.r?.toFixed(2) ?? '—'})`;
  const nul = s?.count ? `above ${Math.round(100 * (s.percentile ?? 0))}% of ${num(s.count)} shuffles` : 'no null (too few shifts)';
  const tested = `${num(pair.tested ?? 0)} pair${pair.tested === 1 ? '' : 's'} tested`;
  return `${head} · ${r} · ${nul} · ${tested}${other} · ${recOf(pair)}`;
}

// --- the catch ----------------------------------------------------------------

/**
 * The catch of a probe: the probed account, the history's bound as the
 * readout states it, and the lit planets with their labels, one per measure,
 * in a fixed order (connection, proximity, coherence, then the two phase 3
 * slots), the measures of the probed account itself (conservation, cadence)
 * on the head. `lit` is capped at `litMost`, the walk's order.
 */
export function catchOf({ id, address, history, walk, edgesOf, categoryNames, coherence: coh, conservation: cons, cadence: cad, idOf, addressOf, nearest = [], litMost = DEFAULTS.litMost }) {
  const byAddress = new Map((coh?.pairs ?? []).map((p) => [p.b.address === address ? p.a.address : p.b.address, p]));
  const lit = [];
  const seen = new Set();
  const consider = (pid) => {
    if (!pid || pid === id || seen.has(pid)) return;
    seen.add(pid);
    const addr = addressOf(pid);
    const pair = byAddress.get(addr) ?? null;
    const edge = edgesOf(pid);
    lit.push({
      id: pid,
      address: addr,
      labels: {
        connection: connectionLabel(edge, categoryNames),
        proximity: proximityLabel(walk, pid),
        coherence: pair ? coherenceLabel(pair, coh?.measureOf ?? null) : 'coherence not measured: not in the window',
        influence: PHASE3,
        motif: PHASE3,
      },
      inStep: Boolean(pair && pair.judged && significant(pair)),
      touching: Boolean(edge && edge.count > 0),
      evidence: (pair?.record?.transactions ?? []).map((t) => t.hash).filter((h) => typeof h === 'string').slice(0, 8),
      proximity: walk.scores.get(pid) ?? 0,
      rank: walk.ranked.indexOf(pid) + 1 || null,
    });
  };
  for (const pid of walk.ranked) {
    if (lit.length >= litMost) break;
    consider(pid);
  }
  for (const addr of nearest) {
    if (lit.length >= litMost) break;
    consider(idOf(addr));
  }
  for (const [addr] of byAddress) {
    if (lit.length >= litMost) break;
    consider(idOf(addr));
  }
  return {
    version: PROBE_VERSION,
    account: { id, address },
    history: history ?? null,
    head: {
      conservation: (cons ?? []).map((row) => ({ ...row, label: conservationLabel(row) })),
      cadence: cad ? { ...cad, label: cadenceLabel(cad) } : null,
      influence: PHASE3,
      motif: PHASE3,
    },
    coherence: coh ? { tested: coh.tested, significant: coh.significant, pairs: coh.pairs.length } : null,
    lit,
    tiers: { proximity: TIER.calculated, conservation: TIER.calculated, cadence: TIER.calculated, coherence: TIER.observation, connection: TIER.calculated },
  };
}

/** "ledgers #A–#B, N records, M of them in the window" — the history line the readout states first. */
export function historyLabel(h) {
  if (!h) return 'history not loaded';
  const covered = h.from != null && h.to != null ? `ledgers #${num(h.from)}–#${num(h.to)}` : 'ledgers unknown';
  const miss = h.missing?.length ? `, ${h.missing.length} span${h.missing.length === 1 ? '' : 's'} missing` : '';
  return `${covered}, ${num(h.records ?? 0)} record${h.records === 1 ? '' : 's'}${h.inWindow != null ? `, ${num(h.inWindow)} of them in the window` : ''}${h.more ? ', more beyond the bound' : ''}${miss}${h.host ? ` · from ${h.host}` : ''}`;
}

/** The catch as lines of text, one per lit planet after the head, for the text equivalent and Copy for AI. */
export function describeCatch(c, nameOf = (id, address) => address) {
  const lines = [];
  lines.push(`probe: ${nameOf(c.account.id, c.account.address)} (${c.account.address}) · ${historyLabel(c.history)}`);
  for (const row of c.head.conservation) lines.push(`flow: ${row.label}`);
  if (c.head.cadence) lines.push(c.head.cadence.label);
  lines.push(`influence →: ${c.head.influence} · motif: ${c.head.motif}`);
  if (c.coherence) lines.push(`coherence: ${c.coherence.pairs} pair${c.coherence.pairs === 1 ? '' : 's'} measured, ${c.coherence.tested} tested against a null, ${c.coherence.significant} in step`);
  for (const l of c.lit) lines.push(`${nameOf(l.id, l.address)} (${l.address}): ${l.labels.connection} · ${l.labels.proximity} · ${l.labels.coherence} · influence →: ${l.labels.influence} · motif: ${l.labels.motif}`);
  return lines;
}

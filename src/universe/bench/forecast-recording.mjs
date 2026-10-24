#!/usr/bin/env node
// UNIVERSE phase 3B — the forecaster on a recording, in Node, through the same row builder as the worker.
//
// Reads a stream recording (raw lines, or a timed recording's { at, from, msg } lines from bench/record-stream.mjs
// --timed), builds the rows with src/universe/forecast/rows.js, keeps the book state for the event studies, makes a
// nowcast at each close when the recording holds in-flight transactions or fee results, forecasts each next ledger,
// and writes the scores: every model's held-out skill and coverage, the verdict, the presence and loop Brier scores
// beside their baselines, the close interval when arrival times exist, the wake's alarms and changes, the event
// studies, and with --research the book_changes cross-check against the facts layer and the book closes (book_changes
// read from a full-history node, one request at a time). Nothing here reads past a ledger's close.
//
//   node src/universe/bench/forecast-recording.mjs <recording.ndjson> [--out src/universe/bench/results/forecast-<name>.md]
//        [--ledgers N] [--research] [--host wss://s2.ripple.com] [--report-model "<name>"]

import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { classifyMessage, unwrapTransactionMessage } from '../../mapping.js';
import { BookState } from '../shared-price.js';
import { RowBuilder, isInFlight } from '../forecast/rows.js';
import { Forecaster } from '../forecast/forecaster.js';
import { EventStudies, quotesOf, sideOf } from '../forecast/events.js';
import { parseBookChanges, bookChangesFromFacts, crossCheck, orient, BookCloses } from '../forecast/books.js';
import { verdict, heldOutCut } from '../forecast/score.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
if (!file) {
  console.error('usage: node src/universe/bench/forecast-recording.mjs <recording.ndjson> [--out file] [--ledgers N] [--research] [--host wss://...] [--report-model name]');
  process.exit(2);
}
const name = file.replace(/\\/g, '/').split('/').pop().replace(/\.ndjson$/, '');
const out = opt('out', `src/universe/bench/results/forecast-${name}.md`);
const maxLedgers = Number(opt('ledgers', 0)) || Infinity;
const research = args.includes('--research');
const host = opt('host', 'wss://s2.ripple.com');
const reportModel = opt('report-model', null);

// a quick look at what the recording holds, to choose the mode
async function holdsOf(path, lines = 20000) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  const h = { timed: false, proposed: false, fee: false };
  let n = 0;
  for await (const line of rl) {
    if (++n > lines) break;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m?.msg && Number.isFinite(m.at)) {
      h.timed = true;
      m = m.msg;
    }
    if (m?.type === 'fee') h.fee = true;
    if (isInFlight(m)) h.proposed = true;
  }
  rl.close();
  return h;
}
const holds = await holdsOf(file);
const mode = holds.proposed || holds.fee ? 'nowcast' : 'forecast';

// the research switch's node
let ws = null;
let seq = 0;
const pending = new Map();
if (research) {
  ws = new WebSocket(host);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`no connection to ${host}`)), { once: true });
  });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.status === 'error') p.reject(Object.assign(new Error(m.error_message ?? m.error), { code: m.error }));
    else p.resolve(m.result);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const request = (command) =>
  new Promise((resolve, reject) => {
    const id = `bench-${++seq}`;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ ...command, id }));
    setTimeout(() => pending.delete(id) && reject(new Error('timed out')), 30000);
  });
async function bookChanges(index) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await request({ command: 'book_changes', ledger_index: index });
    } catch (err) {
      if (err.code !== 'tooBusy' && err.code !== 'slowDown') throw err;
      await sleep(4000);
    }
  }
  throw new Error('the node stayed busy');
}

const rows = new RowBuilder({ keepTransactions: research });
const books = new BookState();
const studies = new EventStudies();
const forecaster = new Forecaster({ mode });
const closes = new BookCloses();
const seen = new Set();
const seenOrder = [];
let serverInfo = null;
let from = null;
let validations = 0;
let ledgers = 0;
let pushed = 0;
let pushMs = 0;
let nowcasts = 0;
let researchAsked = 0;
let researchFailed = 0;
let last = null;
let lastNowcast = null;
const changes = [];
const alarms = [];

const rippledBookKey = (book) => orient(...book.split('|').map((a) => (a === 'XRP' ? 'XRP' : `${a.split('/')[1]}/${a.split('/')[0]}`))).join('|');
function driftFor(key, sign) {
  const ours = key.split('|').map((s) => (s === 'XRP' ? 'XRP' : `${s.split('/')[1]}/${s.split('/')[0]}`));
  const book = [...ours].sort().join('|');
  const d = studies.drift(book, 1); // the mean signed move: in the taker's direction
  if (d == null || !sign) return null;
  const m = sign * d;
  return book.split('|')[0] === ours[1] ? m : 1 / (1 + m) - 1;
}
function largeSides(row) {
  const best = new Map();
  for (const t of row.trades) {
    if (studies.threshold == null || t.xrp < studies.threshold) continue;
    const key = rippledBookKey(t.book);
    if (!best.has(key) || t.xrp > best.get(key).xrp) best.set(key, { xrp: t.xrp, sign: sideOf(t.book, t.got) });
  }
  return new Map([...best].map(([k, v]) => [k, v.sign]));
}

async function pushRow(row) {
  row.loops = [];
  const active = studies.activeBooks();
  if (active.size) studies.noteQuotes(row.index, quotesOf(books, active));
  for (const t of row.trades) studies.noteTrade(row.index, t.book, t.xrp, t.got);
  if (research) {
    try {
      researchAsked += 1;
      const method = parseBookChanges(await bookChanges(row.index));
      const check = crossCheck(method, bookChangesFromFacts(row.transactions ?? []).books);
      closes.noteCheck(check, { heard: row.heard, txnCount: row.txnCount });
      const sides = largeSides(row);
      closes.note(row.index, method, { large: new Set(sides.keys()), driftOf: (key) => driftFor(key, sides.get(key)) });
    } catch {
      researchFailed += 1;
    }
  }
  const t0 = performance.now();
  last = forecaster.push(row);
  pushMs += performance.now() - t0;
  pushed += 1;
  const w = forecaster.wakes.count.last;
  if (w?.alarm) alarms.push({ index: row.index, side: w.alarm });
  if (w?.changed) changes.push(row.index);
}

const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
for await (const line of rl) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    continue;
  }
  let at = null;
  if (msg?.msg && Number.isFinite(msg.at)) {
    at = msg.at;
    from = from ?? msg.from;
    msg = msg.msg;
  }
  if (msg?.result?.info && !serverInfo) {
    serverInfo = msg.result.info;
    continue;
  }
  if (msg?.type === 'fee') {
    rows.noteFee(msg.result, { at, server: serverInfo?.clio_version ? `Clio ${serverInfo.clio_version} (${from?.endpoint ?? 'the recording'})` : (from?.endpoint ?? 'the recording') });
    continue;
  }
  if (msg?.type === 'validationReceived') {
    validations += 1;
    continue;
  }
  if (isInFlight(msg)) {
    rows.noteProposed(msg);
    continue;
  }
  const kind = classifyMessage(msg);
  if (kind === 'ledger') {
    ledgers += 1;
    if (ledgers > maxLedgers) break;
    const L = Number(msg.ledger_index);
    const done = rows.noteClose(msg, at);
    for (const row of done) if (row.index < L) await pushRow(row);
    if (mode === 'nowcast') {
      const n = forecaster.nowcastFor(L, rows.inflight(L));
      if (n) {
        lastNowcast = n;
        nowcasts += 1;
      }
    }
    for (const row of done) if (row.index === L) await pushRow(row);
    if (ledgers % 100 === 0) console.error(`#${L}: ${pushed} rows · ${(pushMs / Math.max(1, pushed)).toFixed(1)} ms a row`);
  } else if (kind === 'transaction') {
    const u = unwrapTransactionMessage(msg);
    const h = typeof u?.hash === 'string' ? u.hash.toUpperCase() : null;
    if (u && (!h || !seen.has(h))) {
      if (h) {
        seen.add(h);
        seenOrder.push(h);
        if (seenOrder.length > 20000) seen.delete(seenOrder.shift());
      }
      books.apply(u.tx, u.meta, Number(u.ledgerIndex));
    }
    for (const row of rows.noteTransaction(msg)) await pushRow(row);
  }
}
if (ws) ws.close();

// --- the report ----------------------------------------------------------------------------
const rec = forecaster.records;
const pRec = rec.get('persistence');
const split = heldOutCut(pRec.indices(), { share: forecaster.o.tuningShare, min: forecaster.o.minRecord });
const heldOut = [split.cut ?? Infinity, Infinity];
const table = [...rec.values()]
  .map((r) => {
    const o = r.over(heldOut[0], heldOut[1]);
    const s = r === pRec ? null : r.skillAgainst(pRec, heldOut[0], heldOut[1]);
    return `| ${r.name} | ${o.n} | ${o.mae == null ? '—' : o.mae.toFixed(2)} | ${o.coverage == null ? '—' : `${Math.round(100 * o.coverage)}%`} | ${s ? `${s.skill >= 0 ? '+' : ''}${s.skill.toFixed(3)} over ${s.n}` : '—'} |`;
  })
  .join('\n');
const nRec = forecaster.nowcastRecords;
const npRec = nRec.get('persistence');
const nSplit = npRec ? heldOutCut(npRec.indices(), { share: forecaster.o.tuningShare, min: forecaster.o.minRecord }) : null;
const nHeld = [nSplit?.cut ?? Infinity, Infinity];
const nTable = npRec
  ? [...nRec.values()]
      .map((r) => {
        const o = r.over(nHeld[0], nHeld[1]);
        const s = r === npRec ? null : r.skillAgainst(npRec, nHeld[0], nHeld[1]);
        return `| ${r.name} | ${o.n} | ${o.mae == null ? '—' : o.mae.toFixed(2)} | ${o.coverage == null ? '—' : `${Math.round(100 * o.coverage)}%`} | ${s ? `${s.skill >= 0 ? '+' : ''}${s.skill.toFixed(3)} over ${s.n}` : '—'} |`;
      })
      .join('\n')
  : null;
const ab = forecaster.accountRecord.brierOver(heldOut[0], heldOut[1]);
const ar = forecaster.accountRateRecord.brierOver(heldOut[0], heldOut[1]);
const ir = forecaster.intervalRecord.over(heldOut[0], heldOut[1]);
const reportLine = reportModel
  ? (() => {
      const r = rec.get(reportModel);
      const s = r?.skillAgainst(pRec);
      return `- the model chosen on another recording, **${reportModel}**, over every resolved ledger of this one: ${s ? `skill against persistence ${s.skill >= 0 ? '+' : ''}${s.skill.toFixed(3)} over ${s.n} ledgers, coverage ${Math.round(100 * r.over().coverage)}%` : 'no record (the model never spoke here)'}`;
    })()
  : null;
const md = [
  `# The forecaster on \`${name}\``,
  '',
  `Rows built by \`src/universe/forecast/rows.js\` from the recording, read in order; every forecast from the sealed past only. Mode: **${mode}** (${holds.proposed || holds.fee ? 'the recording holds in-flight data' : 'the recording holds closed ledgers only'}). ${holds.timed ? `Timed lines: local arrival times, heard from ${serverInfo?.clio_version ? `Clio ${serverInfo.clio_version}${serverInfo.rippled_version ? ` (rippled ${serverInfo.rippled_version})` : ''}` : 'a node'} behind ${from?.endpoint ?? 'an endpoint'}; ${validations.toLocaleString('en-US')} validation messages.` : 'No arrival times: the close interval is not scored.'}`,
  '',
  `- ledgers read: ${ledgers.toLocaleString('en-US')}; rows finished: ${rows.rows.toLocaleString('en-US')}; stragglers after their row: ${rows.late}; duplicate deliveries: ${rows.duplicates.toLocaleString('en-US')}${holds.proposed ? ' (the proposed stream carries every validated transaction a second time)' : ' (the stream sent transactions again after their ledger had closed)'}; transactions for a ledger beyond the kept window: ${rows.stale}`,
  `- the forecaster: ${(pushMs / Math.max(1, pushed)).toFixed(2)} ms a row on average (refits every ${forecaster.o.refitEvery} ledgers, ${forecaster.models.fits} refits); ${forecaster.signalsTried.size} signals tried (${[...forecaster.signalsTried].join(', ')})`,
  `- ${split.statement}`,
  `- ${split.cut != null ? verdict([...rec.values()].filter((r) => r.name !== 'shown'), pRec, heldOut, { min: forecaster.o.minRecord }) : 'no held-out portion'}`,
  `- the most active accounts' presence: held-out Brier ${ab.brier == null ? '—' : ab.brier.toFixed(4)} over ${ab.k.toLocaleString('en-US')} forecasts; the rate alone ${ar.brier == null ? '—' : ar.brier.toFixed(4)}`,
  `- the close interval: ${ir.n ? `held-out coverage ${Math.round(100 * ir.coverage)}% over ${ir.n} ledgers, MAE ${ir.mae.toFixed(0)} ms` : 'not scored (no arrival times)'}`,
  `- the wake on the count: ${alarms.length} CUSUM alarm${alarms.length === 1 ? '' : 's'} (ARL ${forecaster.threshold.arl} at the residuals' measured lag-1 autocorrelation ${forecaster.wakes.count.rho.toFixed(1)}, h ${forecaster.wakes.count.cusum.h.toFixed(2)} in force at the end)${alarms.length ? ` at ${alarms.slice(0, 8).map((a) => `#${a.index} ${a.side}`).join(', ')}` : ''}; ${changes.length} change${changes.length === 1 ? '' : 's'} flagged by the change-point posterior${changes.length ? ` at ${changes.slice(0, 8).map((c) => `#${c}`).join(', ')}` : ''}`,
  ...(reportLine ? [reportLine] : []),
  '',
  '## The count, on the held-out ledgers',
  '',
  '| model | ledgers | MAE | 80% coverage | skill against persistence |',
  '| --- | --- | --- | --- | --- |',
  table,
  '',
  ...(nTable ? [`## The nowcast (${nowcasts.toLocaleString('en-US')} made), on its held-out ledgers`, '', `- ${nSplit?.statement ?? ''}`, '', '| model | ledgers | MAE | 80% coverage | skill against persistence |', '| --- | --- | --- | --- | --- |', nTable, ''] : []),
  '## Event studies',
  '',
  `${studies.trades.toLocaleString('en-US')} taker trades with an XRP side; ${studies.studies} studies completed over ${studies.curves.size} books; threshold ${studies.threshold == null ? '—' : `${Math.round(studies.threshold).toLocaleString('en-US')} XRP`} (the 90th percentile of fills); quotes from the offers seen in the window at face value.`,
  '',
  ...studies.report().slice(0, 8).map((r) => `- ${r.line}`),
  '',
  ...(research ? ['## The research switch', '', `book_changes read from ${host} for ${researchAsked} ledgers (${researchFailed} failed).`, '', ...closes.describe().map((l) => `- ${l}`), `- ${studies.paperLine()}`, ''] : []),
  '## The last readout',
  '',
  ...(lastNowcast ? lastNowcast.lines.map((l) => `    ${l}`) : []),
  ...(last ? last.lines.map((l) => `    ${l}`) : []),
  '',
].join('\n');
writeFileSync(out, md);
console.log(md.split('\n').slice(0, 16).join('\n'));
console.error(`report: ${out}`);

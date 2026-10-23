#!/usr/bin/env node
// UNIVERSE phase 2 — the probe on the owner's AMM ground-truth windows, run locally.
//
// The inputs are the owner's: per launch, the account_tx fetches of the
// named cluster (the snipers and the pool) and of their drawn controls over
// the launch window, as src/account-tx.js fetchAccountSeries wrote them.
// They stay in the owner's folder and never enter the repository; this
// script takes their paths as arguments and writes its report beside them.
//
// What it does: turns the named accounts' transactions into a stream
// recording (one transaction message per entry, one ledgerClosed per ledger
// of the window with txn_count = what was fed, so the sky's coverage reads
// the partial record as complete: a made-up stream of the named accounts'
// transactions only, and the report says so), feeds it to the page through
// the bench server's data mount (?replay=), lets the replay finish, then
// probes one sniper's planet and one control's planet by the page's own
// entrance (window.xrplUniverse.probe) and reads the catch. Expected, from
// the brief: from the sniper, the other snipers light "in step" and "not
// touching", the pool "connected" and not in step (flat); from the control,
// only what chance gives lights in step.
//
//   node src/universe/bench/groundtruth-probe.mjs --cluster <launch.accounttx.json> --controls <launch.controls.accounttx.json> --data <bench server's data dir> [--name ARMY] [--gl 1] [--window <ledgers>] [--out <report dir>]
//   (bench/serve.mjs must be running with --data <the same dir>, port 4181)

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, openPage, waitFor, sleep } from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};
const clusterFile = opt('cluster', null);
const controlsFile = opt('controls', null);
const dataDir = opt('data', null);
const name = opt('name', 'launch');
const gl = opt('gl', '1');
const windowLedgers = Number(opt('window', 0)) || 0; // the sky's live window; the whole launch window by default
const outDir = opt('out', dataDir);
if (!clusterFile || !controlsFile || !dataDir) {
  console.error('usage: node src/universe/bench/groundtruth-probe.mjs --cluster <file> --controls <file> --data <dir> [--name X] [--gl 1|0] [--out dir]');
  process.exit(2);
}

// --- the stream from the named accounts' histories ----------------------------------------------
const cluster = JSON.parse(readFileSync(clusterFile, 'utf8'));
const controls = JSON.parse(readFileSync(controlsFile, 'utf8'));
const from = Math.min(cluster.from, controls.from);
const to = Math.max(cluster.to, controls.to);
const byHash = new Map();
const named = [];
for (const set of [cluster, controls]) {
  for (const a of set.accounts ?? []) {
    named.push({ address: a.account, label: a.label ?? a.account, entries: a.entries?.length ?? 0, set: set === cluster ? 'cluster' : 'control' });
    for (const e of a.entries ?? []) {
      const tx = e.tx ?? e.tx_json;
      const meta = e.meta ?? e.metaData;
      const hash = (e.hash ?? tx?.hash ?? '').toUpperCase();
      const ledger = Number(e.ledger_index ?? tx?.ledger_index);
      if (!tx || !meta || !hash || !Number.isInteger(ledger)) continue;
      if (!byHash.has(hash)) byHash.set(hash, { ledger, tx: { ...tx, hash }, meta });
    }
  }
}
const byLedger = new Map();
for (const t of byHash.values()) (byLedger.get(t.ledger) ?? byLedger.set(t.ledger, []).get(t.ledger)).push(t);
const lines = [];
let fed = 0;
for (let index = from; index <= to; index++) {
  const list = (byLedger.get(index) ?? []).sort((a, b) => Number(a.meta.TransactionIndex ?? 0) - Number(b.meta.TransactionIndex ?? 0));
  for (const t of list) {
    lines.push(JSON.stringify({ type: 'transaction', engine_result: t.meta.TransactionResult, engine_result_code: 0, ledger_index: index, ledger_hash: index.toString(16).padStart(64, '0').toUpperCase(), transaction: t.tx, meta: t.meta, validated: true, status: 'closed' }));
    fed += 1;
  }
  lines.push(JSON.stringify({ type: 'ledgerClosed', ledger_index: index, ledger_hash: index.toString(16).padStart(64, '0').toUpperCase(), ledger_time: 782434622 + (index - from) * 4, txn_count: list.length, fee_base: 10, reserve_base: 1000000, reserve_inc: 200000, validated_ledgers: `${from}-${index}` }));
}
const streamName = `probe-${name}.ndjson`;
writeFileSync(join(dataDir, streamName), lines.join('\n') + '\n');
console.error(`${streamName}: ${to - from + 1} ledgers, ${fed} transactions of ${named.length} named accounts (${byHash.size} distinct)`);

// --- the page ------------------------------------------------------------------------------------
const site = 'http://127.0.0.1:4181/';
const chrome = await launch({ port: 9347 });
const page = await openPage(chrome.port);
const report = [`==== ${name}: the probe on the ground-truth window ====`, `window #${from}–#${to} · ${fed} transactions of the named accounts fed as a stream (txn_count = what was fed: a made-up stream of the named accounts' transactions only; the sky's coverage reads it as complete) · renderer ${gl === '1' ? 'webgl' : '2d'}`, ''];
let failures = 0;
const check = (label, ok, detail = '') => {
  report.push(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` · ${detail}` : ''}`);
  if (!ok) failures += 1;
};
await page.navigate(`${site}universe.html?replay=/data/${encodeURIComponent(streamName)}&pace=0&autostart=1&window=${windowLedgers || to - from + 1}${gl === '1' ? '' : '&gl=0'}`);
await waitFor(page, 'window.xrplUniverse && window.xrplUniverse.stats().replayDone === true', { timeoutMs: 1500000, everyMs: 1000 });
await sleep(2500);
const planets = await page.evaluate('window.xrplUniverse.stats().planets');
report.push(`planets from the stream: ${planets}`, '');

const probeOf = async (address) => {
  const id = await page.evaluate(`window.xrplUniverse.addresses.indexOf(${JSON.stringify(address)})`);
  if (!(id > 0)) return null;
  await page.evaluate(`window.xrplUniverse.probe(${id})`);
  await waitFor(page, 'window.xrplUniverse.probeState() && (window.xrplUniverse.probeState().catch || window.xrplUniverse.probeState().error)', { timeoutMs: 180000, everyMs: 500 });
  return JSON.parse(await page.evaluate(`JSON.stringify((() => { const p = window.xrplUniverse.probeState(); return { id: p.id, error: p.error, lit: p.catch ? p.catch.lit.map((l) => ({ address: l.address, inStep: l.inStep, touching: l.touching, labels: l.labels })) : [], coherence: p.catch?.coherence ?? null, lines: p.lines, ms: p.catch?.ms }; })())`));
};

const labelOf = new Map(named.map((n) => [n.address, n.label]));
const snipers = named.filter((n) => n.set === 'cluster' && /sniper/i.test(n.label) && n.entries > 0);
const pools = named.filter((n) => n.set === 'cluster' && /pool/i.test(n.label));
const controlsPresent = named.filter((n) => n.set === 'control' && n.entries > 0);
report.push(`named: ${named.map((n) => `${n.label} (${n.entries} entries)`).join('; ')}`, '');

for (const s of snipers.slice(0, 2)) {
  const r = await probeOf(s.address);
  report.push(`---- from ${s.label} (${s.address}) ----`);
  if (!r) {
    check(`${s.label} is a planet`, false);
    continue;
  }
  check(`${s.label}: the probe ended without error`, !r.error, r.error ?? `${r.lit.length} lit in ${r.ms} ms`);
  const litBy = new Map(r.lit.map((l) => [l.address, l]));
  for (const other of snipers) {
    if (other.address === s.address) continue;
    const l = litBy.get(other.address);
    check(`${other.label} lit from ${s.label}`, Boolean(l), l ? l.labels.coherence : 'not among the lit');
    if (l) {
      check(`${other.label}: in step`, l.inStep === true, l.labels.coherence);
      check(`${other.label}: not touching`, l.touching === false, l.labels.connection);
    }
  }
  for (const pool of pools) {
    const l = litBy.get(pool.address);
    check(`${pool.label} lit from ${s.label}`, Boolean(l), l ? l.labels.coherence : 'not among the lit');
    if (l) {
      check(`${pool.label}: connected in the record`, l.touching === true, l.labels.connection);
      check(`${pool.label}: flat (not in step)`, l.inStep === false, l.labels.coherence);
    }
  }
  report.push(`coherence: ${JSON.stringify(r.coherence)}`, ...r.lines.map((x) => `  ${x}`), '');
  await page.evaluate('window.xrplUniverse.clearProbe()');
}
for (const c of controlsPresent.slice(0, 2)) {
  const r = await probeOf(c.address);
  report.push(`---- from ${c.label} (${c.address}) ----`);
  if (!r) {
    check(`${c.label} is a planet`, false);
    continue;
  }
  const inStep = r.lit.filter((l) => l.inStep).length;
  const tested = r.coherence?.tested ?? 0;
  const chance = Math.max(1, Math.ceil(tested * 0.05));
  check(`${c.label}: lights only what chance gives (${inStep} in step of ${tested} tested; chance allows about ${chance})`, inStep <= chance, r.lit.filter((l) => l.inStep).map((l) => `${labelOf.get(l.address) ?? l.address}: ${l.labels.coherence}`).join(' | '));
  report.push(`coherence: ${JSON.stringify(r.coherence)}`, ...r.lines.map((x) => `  ${x}`), '');
  await page.evaluate('window.xrplUniverse.clearProbe()');
}
const logs = page.logs.filter((l) => l.startsWith('EXCEPTION'));
check('no exceptions on the page', logs.length === 0, logs[0]);
page.close();
chrome.kill();
report.push('', failures ? `${failures} failed` : 'all expectations met');
const reportFile = join(outDir, `probe-${name}.report.txt`);
writeFileSync(reportFile, report.join('\n') + '\n');
console.log(report.join('\n'));
console.error(`report: ${reportFile}`);
process.exit(failures ? 1 : 0);

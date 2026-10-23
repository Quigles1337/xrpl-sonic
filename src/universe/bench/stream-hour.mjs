#!/usr/bin/env node
// UNIVERSE spike — what the live stream delivers in an hour.
//
// Connects with the same client the pages use (src/ws.js), subscribes to the
// ledger and transactions streams, and for every minute records: ledgers
// closed, transaction messages received, distinct hashes, distinct submitters,
// distinct accounts touched (every address in the tx fields and the
// AffectedNodes), accounts never seen before this minute (churn: what a
// layout would have to place), raw bytes received, the compact-record bytes
// the worker would keep for the same transactions, and the coverage against
// txn_count. Writes a JSON summary every minute so a run can be read while it
// is still going. Requires Node 22+ (global WebSocket).
//
//   node src/universe/bench/stream-hour.mjs [--minutes 60] [--out path.json] [--network mainnet|testnet]

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { XrplStream, NETWORKS } from '../../ws.js';
import { classifyMessage, unwrapTransactionMessage, categorize, extractAmount } from '../../mapping.js';
import { compactRecord, recordBytes } from '../records.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};
const minutes = Math.max(1, Number(opt('minutes', 60)) || 60);
const out = opt('out', `src/universe/bench/results/stream-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const network = NETWORKS[opt('network', 'mainnet')];
if (!network) {
  console.error('unknown network');
  process.exit(2);
}
if (typeof globalThis.WebSocket !== 'function') {
  console.error('needs Node 22+ (global WebSocket)');
  process.exit(2);
}
mkdirSync(dirname(out), { recursive: true });

const startedAt = Date.now();
const seenAccounts = new Set(); // ever, over the run
const seenHashes = new Set();
const ledgers = new Map(); // index → { txnCount, received, closedAt }
const perMinute = [];
let current = newMinute();
let rawBytesTotal = 0;
let compactBytesTotal = 0;
let txTotal = 0;
let endpoint = null;
const statuses = [];
const byCategory = {};
const byType = {};

function newMinute() {
  return { minute: perMinute.length, at: new Date().toISOString(), ledgers: 0, tx: 0, dupes: 0, submitters: new Set(), touched: new Set(), newAccounts: 0, rawBytes: 0, compactBytes: 0, txnCountSum: 0, failed: 0 };
}

function closeMinute() {
  const m = current;
  perMinute.push({ minute: m.minute, at: m.at, ledgers: m.ledgers, tx: m.tx, dupes: m.dupes, submitters: m.submitters.size, touched: m.touched.size, newAccounts: m.newAccounts, rawBytes: m.rawBytes, compactBytes: m.compactBytes, txnCountSum: m.txnCountSum, failed: m.failed });
  current = newMinute();
  current.minute = perMinute.length;
  write();
}

function write(final = false) {
  const elapsedMin = (Date.now() - startedAt) / 60000;
  const closed = [...ledgers.values()].filter((l) => l.txnCount != null);
  const txnCountSum = closed.reduce((a, l) => a + l.txnCount, 0);
  const receivedOfClosed = closed.reduce((a, l) => a + Math.min(l.received, l.txnCount), 0);
  const summary = {
    network: opt('network', 'mainnet'),
    endpoint,
    startedAt: new Date(startedAt).toISOString(),
    elapsedMinutes: Number(elapsedMin.toFixed(2)),
    final,
    totals: {
      ledgersClosed: closed.length,
      txMessages: txTotal,
      distinctHashes: seenHashes.size,
      distinctAccounts: seenAccounts.size,
      rawBytes: rawBytesTotal,
      compactBytes: compactBytesTotal,
      rawBytesPerTx: txTotal ? Math.round(rawBytesTotal / txTotal) : null,
      compactBytesPerTx: seenHashes.size ? Math.round(compactBytesTotal / seenHashes.size) : null,
      txnCountSum,
      coverage: txnCountSum ? Number((receivedOfClosed / txnCountSum).toFixed(4)) : null,
    },
    perHour: elapsedMin > 0 ? { tx: Math.round((seenHashes.size / elapsedMin) * 60), distinctAccounts: Math.round((seenAccounts.size / elapsedMin) * 60), ledgers: Math.round((closed.length / elapsedMin) * 60) } : null,
    byCategory,
    byType: Object.fromEntries(Object.entries(byType).sort((a, b) => b[1] - a[1])),
    statuses: statuses.slice(-20),
    perMinute,
  };
  writeFileSync(out, JSON.stringify(summary, null, 2));
}

/** Every r-address named by a transaction and its metadata (the planets this record would touch). */
function touchedAccounts(tx, meta) {
  const set = new Set();
  const isAddr = (a) => typeof a === 'string' && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a);
  const walk = (v, depth) => {
    if (depth > 6 || v == null) return;
    if (typeof v === 'string') {
      if (isAddr(v)) set.add(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (typeof v === 'object') for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(tx, 0);
  walk(meta?.AffectedNodes, 0);
  return set;
}

const stream = new XrplStream({
  endpoints: network.endpoints,
  onStatus: (s) => {
    endpoint = s.endpoint;
    statuses.push({ at: new Date().toISOString(), state: s.state, endpoint: s.endpoint, error: s.error ?? null });
    console.error(`[status] ${s.state} ${s.endpoint}${s.error ? ` — ${s.error}` : ''}`);
  },
  onRaw: (text) => {
    rawBytesTotal += Buffer.byteLength(text, 'utf8');
    current.rawBytes += Buffer.byteLength(text, 'utf8');
  },
  onMessage: (msg) => {
    const kind = classifyMessage(msg);
    if (kind === 'ledger') {
      const index = Number(msg.ledger_index);
      const l = ledgers.get(index) ?? { txnCount: null, received: 0 };
      l.txnCount = Number.isFinite(Number(msg.txn_count)) ? Number(msg.txn_count) : null;
      l.closedAt = Date.now();
      ledgers.set(index, l);
      current.ledgers += 1;
      if (l.txnCount != null) current.txnCountSum += l.txnCount;
      return;
    }
    if (kind !== 'transaction') return;
    const u = unwrapTransactionMessage(msg);
    if (!u) return;
    txTotal += 1;
    current.tx += 1;
    const index = Number(u.ledgerIndex);
    if (Number.isInteger(index)) {
      const l = ledgers.get(index) ?? { txnCount: null, received: 0 };
      l.received += 1;
      ledgers.set(index, l);
    }
    const hash = typeof u.hash === 'string' ? u.hash.toUpperCase() : null;
    if (hash && seenHashes.has(hash)) {
      current.dupes += 1;
      return;
    }
    if (hash) seenHashes.add(hash);
    const cat = categorize(u.tx.TransactionType);
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    byType[u.tx.TransactionType] = (byType[u.tx.TransactionType] ?? 0) + 1;
    if (u.result !== 'tesSUCCESS') current.failed += 1;
    if (typeof u.tx.Account === 'string') current.submitters.add(u.tx.Account);
    for (const a of touchedAccounts(u.tx, u.meta)) {
      current.touched.add(a);
      if (!seenAccounts.has(a)) {
        seenAccounts.add(a);
        current.newAccounts += 1;
      }
    }
    const rec = compactRecord(u.tx, u.meta, { hash: u.hash, ledgerIndex: index, result: u.result, amount: extractAmount(u.tx, u.meta) });
    const bytes = recordBytes(rec);
    compactBytesTotal += bytes;
    current.compactBytes += bytes;
  },
});

stream.connect();
const timer = setInterval(() => {
  closeMinute();
  console.error(`[minute ${perMinute.length}] tx ${seenHashes.size} · accounts ${seenAccounts.size} · raw ${(rawBytesTotal / 1048576).toFixed(1)} MiB · compact ${(compactBytesTotal / 1048576).toFixed(2)} MiB`);
  if (perMinute.length >= minutes) {
    clearInterval(timer);
    stream.close();
    write(true);
    console.error(`done: ${out}`);
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 200);
  }
}, 60000);
process.on('SIGINT', () => {
  closeMinute();
  write(true);
  process.exit(0);
});

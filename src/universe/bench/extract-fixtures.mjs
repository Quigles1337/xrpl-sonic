#!/usr/bin/env node
// UNIVERSE phase 1.5 — fixtures from the recording, one real transaction per object.
//
// Reads a stream recording (bench/record-stream.mjs, one raw message per
// line), classifies every transaction with src/universe/events.js, and
// writes the first example of each object into test/universe-fixtures/
// <object>.json: the recorded message verbatim (never hand-written), the
// ledger it came from, and the events the classifier made of it (verb,
// object, label) as the expected values the test pins. Objects for which
// no example turned up are listed in test/universe-fixtures/MISSING.md with
// what was searched.
//
//   node src/universe/bench/extract-fixtures.mjs <recording.ndjson> [--out test/universe-fixtures] [--prefer a,b,c]

import { createReadStream, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { unwrapTransactionMessage, classifyMessage } from '../../mapping.js';
import { eventsOf, OBJECT_NAMES, collapseShowers } from '../events.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};
const outDir = opt('out', 'test/universe-fixtures');
if (!file) {
  console.error('usage: node src/universe/bench/extract-fixtures.mjs <recording.ndjson> [--out dir]');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

/** A fixture is kept only once; a later, more informative example (more events, or brokered/partial detail) does not replace the first, so a fixture is stable. */
const have = new Map();
for (const name of OBJECT_NAMES) if (existsSync(join(outDir, `${name}.json`))) have.set(name, 'existing');
const counts = {};
const byLedger = new Map(); // for showers: dust per sender per ledger
let lines = 0;
let txs = 0;

const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
for await (const line of rl) {
  lines += 1;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    continue;
  }
  if (classifyMessage(msg) !== 'transaction') continue;
  const u = unwrapTransactionMessage(msg);
  if (!u) continue;
  txs += 1;
  const events = eventsOf(u.tx, u.meta, { hash: u.hash, ledgerIndex: u.ledgerIndex, result: u.result });
  for (const e of events) {
    counts[e.object] = (counts[e.object] ?? 0) + 1;
    if (have.has(e.object)) continue;
    have.set(e.object, 'new');
    writeFileSync(join(outDir, `${e.object}.json`), JSON.stringify({ object: e.object, verb: e.verb, recordedFrom: file.replace(/\\/g, '/').split('/').pop(), ledgerIndex: u.ledgerIndex, hash: u.hash, message: msg, expected: events.map((x) => ({ verb: x.verb, object: x.object, rule: x.rule, from: x.from, to: x.to, via: x.via, at: x.at, label: x.label })) }, null, 2));
    console.error(`fixture ${e.object} ← ${u.tx.TransactionType} ${u.hash}`);
  }
  // showers: the dust of one sender in one ledger
  if (events.some((e) => e.object === 'dust') && !have.has('shower')) {
    const key = u.ledgerIndex;
    const list = byLedger.get(key) ?? byLedger.set(key, []).get(key);
    list.push({ msg, u, events });
    const dust = list.flatMap((x) => x.events.filter((e) => e.object === 'dust'));
    const showers = collapseShowers(dust).filter((e) => e.object === 'shower');
    if (showers.length) {
      const s = showers[0];
      const members = list.filter((x) => x.u.tx.Account === s.from).map((x) => x.msg);
      have.set('shower', 'new');
      writeFileSync(join(outDir, 'shower.json'), JSON.stringify({ object: 'shower', verb: 'travel', recordedFrom: file.replace(/\\/g, '/').split('/').pop(), ledgerIndex: key, messages: members, expected: [{ verb: 'travel', object: 'shower', rule: s.rule, from: s.from, count: s.detail.count, label: s.label }] }, null, 2));
      console.error(`fixture shower ← ${members.length} dust payments by ${s.from} in #${key}`);
    }
    if (byLedger.size > 40) byLedger.delete(byLedger.keys().next().value);
  }
}
const missing = OBJECT_NAMES.filter((n) => !have.has(n));
const md = ['# Missing fixtures', '', `Searched ${txs.toLocaleString('en-US')} transactions in ${file.replace(/\\/g, '/').split('/').pop()} (${lines.toLocaleString('en-US')} messages) for a real example of every object; these turned up none:`, '', ...missing.map((n) => `- TODO ${n}: searched the recording for the transaction type and metadata its rule reads (src/universe/events.js, ${n}); none seen. Drawn as the spark until a real example is recorded.`), '', 'Objects seen, with counts:', '', ...Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v.toLocaleString('en-US')}`), ''].join('\n');
writeFileSync(join(outDir, 'MISSING.md'), md);
console.error(`${have.size} of ${OBJECT_NAMES.length} objects have a fixture; missing: ${missing.join(', ') || 'none'}`);

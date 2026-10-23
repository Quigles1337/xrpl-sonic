#!/usr/bin/env node
// UNIVERSE phase 1.5 — the type histogram as a Markdown table, from a recording's types file.
//
//   node src/universe/bench/types-table.mjs <types-*.json> [--threshold 0.0001]

import { readFileSync } from 'node:fs';
import { DESIGNED_TYPES, SPARK_THRESHOLD } from '../events.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node src/universe/bench/types-table.mjs <types-*.json>');
  process.exit(2);
}
const h = JSON.parse(readFileSync(file, 'utf8'));
const fmt = (n) => Number(n).toLocaleString('en-US');
const pct = (x, d = 2) => `${(x * 100).toFixed(d)}%`;
const out = [];
out.push(`From \`bench/record-stream.mjs\` against ${h.network}, ${h.elapsedMinutes} minutes from ${h.startedAt}: ${fmt(h.ledgers)} ledgers, ${fmt(h.transactions)} transactions (distinct hashes), ${(h.bytes / 1048576).toFixed(0)} MiB recorded. The spark threshold is ${pct(SPARK_THRESHOLD, 2)} of the transactions heard (${fmt(Math.ceil(h.transactions * SPARK_THRESHOLD))} here): a type the vocabulary does not name stays the spark below it, and above it is owed a design.`);
out.push('');
out.push('| Type | Count | Share | Inner (of a Batch) | Failed | In the sky |');
out.push('| --- | --- | --- | --- | --- | --- |');
for (const t of h.types) {
  const designed = DESIGNED_TYPES.includes(t.type);
  const verdict = t.type === 'Batch' ? 'tick (the wrapper), no body' : designed ? 'designed (see the vocabulary)' : t.share < SPARK_THRESHOLD ? 'spark (below the threshold, unnamed)' : 'spark (owed a design: above the threshold, unnamed)';
  out.push(`| ${t.type} | ${fmt(t.count)} | ${pct(t.share)} | ${fmt(t.inner)} (${pct(t.innerShare, 0)}) | ${fmt(t.failed)} (${pct(t.count ? t.failed / t.count : 0, 0)}) | ${verdict} |`);
}
out.push('');
out.push('The sub-kinds the rules cut, as counted in the same recording:');
out.push('');
out.push('| Sub-kind | Count |');
out.push('| --- | --- |');
for (const [k, v] of Object.entries(h.kinds)) out.push(`| ${k} | ${fmt(v)} |`);
process.stdout.write(out.join('\n'));

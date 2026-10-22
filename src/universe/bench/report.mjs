#!/usr/bin/env node
// UNIVERSE spike — the measurements as Markdown tables, from the result files.
//
//   node src/universe/bench/report.mjs [results-dir]
//
// Reads stream-hour-mainnet.json, hour-2d.json, hour-webgl.json,
// frames-headless.json and frames-real.json when present and prints the
// tables docs/universe.md carries, so the numbers in the document are the
// files' and nothing is typed by hand.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'src/universe/bench/results';
const read = (name) => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), 'utf8')) : null);
const fmt = (n, d = 0) => (n == null || Number.isNaN(n) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
const mib = (b) => (b == null ? '—' : `${(b / 1048576).toFixed(1)} MiB`);
const out = [];
const line = (s = '') => out.push(s);

const stream = read('stream-hour-mainnet.json');
if (stream) {
  const t = stream.totals;
  const mins = stream.perMinute;
  const perMin = (k) => mins.map((m) => m[k]);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  line(`**The stream alone** (\`stream-hour.mjs\`, Node, ${stream.network}, ${stream.endpoint?.replace(/^wss:\/\//, '')}, ${stream.elapsedMinutes} min from ${stream.startedAt}):`);
  line();
  line('| Measure | Value |');
  line('| --- | --- |');
  line(`| Ledgers closed | ${fmt(t.ledgersClosed)} (${fmt(stream.perHour.ledgers)} per hour) |`);
  line(`| Transactions heard (distinct hashes) | ${fmt(t.distinctHashes)} (${fmt(stream.perHour.tx)} per hour; ${fmt(med(perMin('tx')))} in the median minute, ${fmt(Math.max(...perMin('tx')))} in the busiest) |`);
  line(`| Distinct accounts named (all parties, including the metadata's entry owners) | ${fmt(t.distinctAccounts)} (${fmt(stream.perHour.distinctAccounts)} per hour; new accounts per minute fell from ${fmt(mins[0]?.newAccounts)} in the first to ${fmt(med(perMin('newAccounts').slice(Math.floor(mins.length / 2))))} in the median later minute) |`);
  line(`| Distinct submitters per minute (median) | ${fmt(med(perMin('submitters')))} |`);
  line(`| Coverage against txn_count | ${t.coverage == null ? '—' : `${(t.coverage * 100).toFixed(2)}%`} (${fmt(t.txnCountSum)} expected) |`);
  line(`| Duplicate deliveries | ${fmt(sum(perMin('dupes')))} |`);
  line(`| Failed (tec) among heard | ${fmt(sum(perMin('failed')))} (${((sum(perMin('failed')) / Math.max(1, t.distinctHashes)) * 100).toFixed(1)}%) |`);
  line(`| Raw JSON received | ${mib(t.rawBytes)} (${fmt(t.rawBytesPerTx)} bytes per transaction) |`);
  line(`| Compact record (typed-array estimate) | ${fmt(t.compactBytesPerTx)} bytes per transaction (${mib(t.compactBytes)} for the hour) |`);
  const types = Object.entries(stream.byType).slice(0, 8);
  line(`| Transaction types, largest first | ${types.map(([k, v]) => `${k} ${fmt(v)}`).join(' · ')} |`);
  line();
}

for (const [name, label] of [
  ['hour-2d.json', '2D canvas'],
  ['hour-webgl.json', 'WebGL'],
]) {
  const h = read(name);
  if (!h) continue;
  const s = h.samples.filter((x) => !x.error);
  const last = s.at(-1);
  if (!last) continue;
  const pick = (m) => s.find((x) => x.minute === m) ?? s.reduce((best, x) => (Math.abs(x.minute - m) < Math.abs(best.minute - m) ? x : best), s[0]);
  line(`**An hour of the live sky in headless Chrome, ${label}** (\`hour.mjs\`, ${h.url.replace(/^http:\/\/[^/]+\//, '')}, ${s.length} samples${h.final ? '' : ', still running'}):`);
  line();
  line('| Minute | Planets | Records | Edges | Heap (page) | Measured (page + worker + canvas) | Worker JS | Frame mean / p95 | Layout step | Coverage |');
  line('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const m of [1, 5, 10, 20, 30, 45, 60]) {
    const x = pick(m);
    if (!x || (m > 1 && x.minute < m - 2 && x !== last)) continue;
    const worker = x.memory.measured?.breakdown?.find((b) => b.attribution?.some((a) => a.scope === 'DedicatedWorkerGlobalScope'));
    line(`| ${x.minute} | ${fmt(x.stats.planets)} | ${fmt(x.memory.worker?.records)} | ${fmt(x.memory.worker?.edges)} | ${mib(x.memory.heap?.used)} | ${mib(x.memory.measured?.bytes)} | ${mib(worker?.bytes)} | ${fmt(x.stats.meanMs, 1)} / ${fmt(x.stats.p95, 1)} ms | ${x.stats.stability ? `${fmt(x.stats.stability.meanMs, 1)} ms, ${fmt(x.stats.stability.warm)} warm, moved ${fmt(x.stats.stability.moved * 1000, 2)}‰` : '—'} | ${x.stats.coverage?.share == null ? '—' : `${(x.stats.coverage.share * 100).toFixed(2)}%`} |`);
    if (x === last) break;
  }
  const c = last.stats.coherence;
  if (c) line(`\nCoherence over the live window at minute ${last.minute}: ${fmt(c.tested)} pairs tested among the top submitters, ${fmt(c.above?.white)} above the 95th prewhitened (chance about ${fmt(c.above?.expected, 1)}), ${fmt(c.ms, 0)} ms per run in the worker.`);
  if (h.exceptions?.length) line(`\nExceptions logged: ${h.exceptions.length} (first: ${h.exceptions[0].slice(0, 160)}).`);
  line();
}

for (const [name, label] of [
  ['frames-real.json', 'the user’s own browser (GPU)'],
  ['frames-headless.json', 'headless Chrome (SwiftShader, software)'],
]) {
  const f = read(name);
  if (!f) continue;
  line(`**Frame time, ${label}** (${f.note ?? `\`frames.mjs\`, ${f.seconds} s per view`}; the renderer's own time per frame, mean / p50 / p95 over the sampled frames, and how many planets fell in each pixel level at the home view):`);
  line();
  line('| Renderer | Planets | Home view | Closer | Inside | Levels at home (splat / sprite / body / culled) | Layout step (worker) |');
  line('| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of f.results) {
    const v = (view) => {
      const x = r.views[view];
      return x ? `${fmt(x.meanMs, 1)} / ${fmt(x.p50, 1)} / ${fmt(x.p95, 1)} ms` : '—';
    };
    const l = r.views.home?.lod ?? {};
    line(`| ${r.actualRenderer ?? r.renderer} | ${fmt(r.planets)} | ${v('home')} | ${v('closer')} | ${v('inside')} | ${fmt(l.far)} / ${fmt(l.mid)} / ${fmt(l.near)} / ${fmt(l.culled)} | ${r.stability ? `${fmt(r.stability.meanMs, 1)} ms, ${fmt(r.stability.warm)} warm` : '—'} |`);
  }
  if (f.results.some((r) => r.views.home?.gpu)) line(`\nGPU string seen by the page: ${[...new Set(f.results.map((r) => r.views.home?.gpu).filter(Boolean))].join(', ')}.`);
  if (f.exceptions?.length) line(`\nExceptions logged: ${f.exceptions.length}.`);
  line();
}

process.stdout.write(out.join('\n'));

#!/usr/bin/env node
// UNIVERSE spike — an hour of the live sky in headless Chrome: memory and frame time.
//
// Opens universe.html on the live stream, and every minute reads the page's
// heap (performance.memory), the cross-origin-isolated measurement
// (performance.measureUserAgentSpecificMemory, which includes the worker;
// the bench server sends the headers it needs), the worker's own counts
// (records, planets, edges) and the renderer's frame-time percentiles.
//
//   node src/universe/bench/serve.mjs &
//   node src/universe/bench/hour.mjs [--minutes 60] [--gl 0|1] [--out results/hour.json] [--port 9342]

import { writeFileSync } from 'node:fs';
import { launch, openPage, waitFor, sleep } from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};
const minutes = Number(opt('minutes', 60)) || 60;
const gl = opt('gl', '0');
const out = opt('out', 'src/universe/bench/results/hour.json');
const site = opt('site', 'http://127.0.0.1:4181/');
const port = Number(opt('port', 9342)) || 9342;

const chrome = await launch({ port });
const page = await openPage(chrome.port);
const url = `${site}universe.html?autostart=1&gl=${gl}`;
console.error(`[hour] ${url}`);
await page.navigate(url);
await waitFor(page, 'window.xrplUniverse && window.xrplUniverse.stats().ledger != null', { timeoutMs: 120000 });
const samples = [];
const write = (final = false) => writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), url, minutes, final, samples, exceptions: page.logs.filter((l) => l.startsWith('EXCEPTION') || l.startsWith('ERROR')).slice(0, 40) }, null, 2));
for (let m = 1; m <= minutes; m++) {
  await sleep(60000);
  try {
    const memory = JSON.parse(await page.evaluate('window.xrplUniverse.memory().then((m) => JSON.stringify(m))'));
    const stats = JSON.parse(await page.evaluate('JSON.stringify(window.xrplUniverse.stats())'));
    samples.push({ minute: m, memory, stats });
    const heap = memory.heap ? `${(memory.heap.used / 1048576).toFixed(1)} MiB heap` : 'no heap';
    const measured = memory.measured?.bytes ? `${(memory.measured.bytes / 1048576).toFixed(1)} MiB measured` : memory.measured?.error ?? 'no measurement';
    console.error(`[minute ${m}] ${heap} · ${measured} · planets ${stats.planets} · records ${memory.worker?.records} · frame mean ${stats.meanMs?.toFixed(2)} ms p95 ${stats.p95?.toFixed(2)} · coverage ${stats.coverage?.share != null ? (stats.coverage.share * 100).toFixed(2) + '%' : '?'}`);
  } catch (err) {
    samples.push({ minute: m, error: err?.message ?? String(err) });
    console.error(`[minute ${m}] error ${err?.message ?? err}`);
  }
  write(false);
}
write(true);
console.error(`written ${out}`);
page.close();
chrome.kill();

#!/usr/bin/env node
// UNIVERSE spike — frame time at 1k, 5k and 20k planets, 2D canvas and WebGL.
//
// Opens universe.html in headless Chrome with a synthetic sky of N planets,
// waits for the sky to reach N, lets the layout settle, then samples the
// renderer's own frame-time percentiles at three camera distances (the home
// view, closer, inside a cluster) for each renderer. Headless Chrome draws
// with SwiftShader (software), so these numbers are a floor on the real
// GPU's, and the harness says which GPU string the page saw. The same
// script against a running Chrome with --connect <port> measures a real one.
//
//   node src/universe/bench/serve.mjs &                     # on 4181
//   node src/universe/bench/frames.mjs [--sizes 1000,5000,20000] [--renderers 2d,webgl] [--seconds 8] [--out results/frames.json]

import { writeFileSync } from 'node:fs';
import { launch, openPage, waitFor, sleep } from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};
const sizes = opt('sizes', '1000,5000,20000').split(',').map(Number);
const renderers = opt('renderers', '2d,webgl').split(',');
const seconds = Number(opt('seconds', 8)) || 8;
const out = opt('out', 'src/universe/bench/results/frames.json');
const site = opt('site', 'http://127.0.0.1:4181/');
const connectPort = opt('connect', null);

const chrome = connectPort ? null : await launch({ port: 9341 });
const port = connectPort ? Number(connectPort) : chrome.port;
const page = await openPage(port);
const results = [];
for (const renderer of renderers) {
  for (const n of sizes) {
    const url = `${site}universe.html?synthetic=${n}&gl=${renderer === 'webgl' ? 1 : 0}&autostart=1&seed=1337`;
    console.error(`[frames] ${renderer} ${n}: ${url}`);
    await page.navigate(url);
    await waitFor(page, `window.xrplUniverse && window.xrplUniverse.stats().planets >= ${n}`, { timeoutMs: 180000 });
    await sleep(3000); // the layout settles, the first ledgers' comets fly
    const row = { renderer, planets: n, views: {} };
    for (const [view, distance] of [
      ['home', 3.2],
      ['closer', 1.4],
      ['inside', 0.5],
    ]) {
      await page.evaluate(`window.xrplUniverse.sky.camera = { ...window.xrplUniverse.sky.camera, distance: ${distance} }; window.xrplUniverse.sky.frameTimes.length = 0; 'ok'`);
      await sleep(seconds * 1000);
      const s = await page.evaluate('JSON.stringify(window.xrplUniverse.stats())');
      row.views[view] = JSON.parse(s);
      const v = row.views[view];
      console.error(`  ${view.padEnd(7)} mean ${v.meanMs?.toFixed(2)} ms · p50 ${v.p50?.toFixed(2)} · p95 ${v.p95?.toFixed(2)} · max ${v.maxMs?.toFixed(1)} · lod ${JSON.stringify(v.lod)}${v.gpu ? ` · ${v.gpu}` : ''}`);
    }
    row.stability = row.views.inside.stability;
    row.memory = row.views.inside.memory;
    row.actualRenderer = row.views.home.renderer;
    results.push(row);
  }
}
const exceptions = page.logs.filter((l) => l.startsWith('EXCEPTION') || l.startsWith('ERROR'));
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), site, headless: !connectPort, seconds, results, exceptions }, null, 2));
console.error(`written ${out}${exceptions.length ? ` · ${exceptions.length} exceptions` : ''}`);
page.close();
chrome?.kill();

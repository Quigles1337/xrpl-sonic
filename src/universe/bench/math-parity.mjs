#!/usr/bin/env node
// UNIVERSE phase 3B — the elementary functions in Node and in headless Chrome, on the same inputs: how many of the
// engines' own results differ in the last bit, and that src/universe/forecast/dmath.js gives the same bits in both.
// The forecaster runs live in the browser's worker and is replayed in Node by the parity test; that only holds if
// every function on its path returns the same bits in both engines. Needs bench/serve.mjs on port 4181 (the page
// imports dmath.js from it).
//
//   node src/universe/bench/math-parity.mjs [--n 2000]

import { launch, openPage } from './cdp.mjs';
import * as D from '../forecast/dmath.js';

const args = process.argv.slice(2);
const i = args.indexOf('--n');
const N = i >= 0 ? Number(args[i + 1]) : 2000;
const site = 'http://127.0.0.1:4181/';

// the same inputs in both engines: a Lehmer generator, exact in doubles
const inputs = `(() => { let x = 12345; const u = () => { x = (x * 16807) % 2147483647; return x / 2147483647; }; return Array.from({ length: ${N} }, u); })()`;
const natives = `{ pow2: (u) => Math.pow(2, -1 / (1 + 1000 * u)), pow: (u) => Math.pow(1 + 10 * u, 0.3 + 3 * u), exp: (u) => Math.exp(-50 + 100 * u), log: (u) => Math.log(1e-6 + 1e6 * u), expm1: (u) => Math.expm1(-3 + 10 * u), log1p: (u) => Math.log1p(1000 * u), sin: (u) => Math.sin(10 * u), cos: (u) => Math.cos(10 * u), sqrt: (u) => Math.sqrt(1000 * u) }`;
const deterministic = (D) => ({ exp: (u) => D.exp(-50 + 100 * u), log: (u) => D.log(1e-6 + 1e6 * u), expm1: (u) => D.expm1(-3 + 10 * u), log1p: (u) => D.log1p(1000 * u), pow: (u) => D.pow(1 + 10 * u, 0.3 + 3 * u), logGamma: (u) => D.logGamma(1e-3 + 300 * u) });
const run = (fns, us) => Object.fromEntries(Object.entries(fns).map(([k, f]) => [k, us.map(f)]));

const us = eval(inputs);
const nodeNative = run(eval(`(${natives})`), us);
const nodeDet = run(deterministic(D), us);

const chrome = await launch({ port: 9352 });
const page = await openPage(chrome.port);
await page.navigate(`${site}universe.html?forecast=0`);
await new Promise((r) => setTimeout(r, 1500));
const browser = JSON.parse(
  await page.evaluate(`(async () => {
    const D = await import('${site}src/universe/forecast/dmath.js');
    const us = ${inputs};
    const run = ${run.toString()};
    const deterministic = ${deterministic.toString()};
    return JSON.stringify({ native: run(${natives}, us), det: run(deterministic(D), us), agent: navigator.userAgent });
  })()`),
);
page.close();
chrome.kill();

console.log(`Node ${process.versions.node} (V8 ${process.versions.v8}) · ${browser.agent.match(/Chrome\/[\d.]+/)?.[0] ?? browser.agent} · ${N} inputs a function`);
const compare = (a, b) => a.reduce((n, v, j) => n + (Object.is(v, b[j]) ? 0 : 1), 0);
for (const k of Object.keys(nodeNative)) console.log(`  the engine's Math ${k.padEnd(6)}: ${compare(nodeNative[k], browser.native[k])} differ`);
let differ = 0;
for (const k of Object.keys(nodeDet)) {
  const d = compare(nodeDet[k], browser.det[k]);
  differ += d;
  console.log(`  dmath.js ${k.padEnd(9)}: ${d} differ`);
}
console.log(differ ? `dmath.js differs between the engines on ${differ} results` : 'dmath.js gives the same bits in both engines');
process.exit(differ ? 1 : 0);

#!/usr/bin/env node
// UNIVERSE phase 3B — the CUSUM thresholds for the default run length (ARL 500, k 0.5, 2,000 runs, seed 7) at lag-1
// autocorrelations 0, 0.1, …, 0.9, by thresholdFor's own bisection on the simulated run length of an AR(1) normal
// law with unit variance; printed as the table src/universe/forecast/wake.js ships (ARL500_THRESHOLDS), so the worker
// never stalls on a simulation. A test recomputes two of the entries.
//
//   node src/universe/bench/cusum-thresholds.mjs [--arl 500]

import { thresholdFor, TABLE_RUNS } from '../forecast/wake.js';

const args = process.argv.slice(2);
const i = args.indexOf('--arl');
const arl = i >= 0 ? Number(args[i + 1]) : 500;
const rows = [];
for (let step = 0; step <= 9; step++) {
  const t0 = performance.now();
  const t = thresholdFor(arl, { k: 0.5, runs: TABLE_RUNS, seed: 7, rho: step / 10, table: false });
  rows.push([Number(t.h.toFixed(4)), Number(t.measuredArl.toFixed(1))]);
  console.error(`rho ${(step / 10).toFixed(1)}: h ${t.h.toFixed(4)} · measured ARL ${t.measuredArl.toFixed(1)} on ${2 * TABLE_RUNS} runs · ${(performance.now() - t0).toFixed(0)} ms`);
}
console.log(JSON.stringify(rows));

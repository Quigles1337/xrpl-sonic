#!/usr/bin/env node
// Copy for AI, from the command line: render a case file (a saved moment, or
// any .sonic-case.json) as the text the listening page copies, fetching its
// ledgers from a public node with the same client the browser uses.
// Requires Node 22+ (global WebSocket and CompressionStream).
//
//   node scripts/describe.mjs path/to/moment.sonic-case.json            # gist
//   node scripts/describe.mjs case.json --level evidence                 # with findings for every cast-involved event
//   node scripts/describe.mjs case.json --budget 60000                   # characters; the text says N of M events when it must select
//   node scripts/describe.mjs case.json --measure                        # sizes only, for both levels
//
// The text goes to stdout; the size and the events-shown ratio go to stderr.

import { readFileSync } from 'node:fs';
import { XrplStream, NETWORKS } from '../src/ws.js';
import { validateCase, encodeCase } from '../src/case.js';
import { fetchCaseLedgers } from '../src/ledgers.js';
import { describeReport, factsForCase, DEFAULT_BUDGET } from '../src/describe.js';
import { buildHash } from '../src/params.js';
import { SITE_URL } from '../src/explorers.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};
if (!file) {
  console.error('usage: node scripts/describe.mjs <case.sonic-case.json> [--level gist|evidence] [--budget N] [--measure]');
  process.exit(2);
}
if (typeof globalThis.WebSocket !== 'function') {
  console.error('This script needs a global WebSocket (Node 22+).');
  process.exit(2);
}
const level = opt('level', 'gist');
const budget = Number(opt('budget', DEFAULT_BUDGET)) || DEFAULT_BUDGET;
const measureOnly = args.includes('--measure');

let raw;
try {
  raw = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`Could not read ${file}: ${err?.message ?? err}`);
  process.exit(2);
}
const { case: theCase, errors, warnings } = validateCase(raw);
for (const e of errors) console.error(`case: ${e}`);
for (const w of warnings) console.error(`case: ${w}`);
if (!theCase) process.exit(1);

const network = NETWORKS[theCase.network];
const stream = new XrplStream({ endpoints: network.endpoints, onMessage: () => {} });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no connection to a node within 20 s')), 20000);
  stream.onStatus = (s) => {
    if (s.state === 'connected') {
      clearTimeout(timer);
      resolve();
    }
  };
  stream.connect();
}).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
await stream.request({ command: 'unsubscribe', streams: ['ledger', 'transactions'] }).catch(() => {});

const t0 = Date.now();
const { ledgers, failures } = await fetchCaseLedgers((cmd) => stream.request(cmd), theCase, { onProgress: (d, t) => process.stderr.write(`\rfetching ledgers ${d}/${t}`) });
process.stderr.write('\n');
for (const f of failures) console.error(`ledger #${f.index} could not be fetched: ${f.error}`);
const facts = factsForCase(theCase, ledgers);
const caseLink = `${SITE_URL}${theCase.network !== 'mainnet' ? `?network=${theCase.network}` : ''}${buildHash({ case: await encodeCase(theCase) })}`;
const sizeLine = (r) => `${r.level}: ${r.chars.toLocaleString('en-US')} characters (~${r.tokensApprox.toLocaleString('en-US')} tokens) · ${r.shown} of ${r.total} events shown${r.rule ? ` (${r.rule})` : ''} · budget ${r.budget.toLocaleString('en-US')}`;
if (measureOnly) {
  for (const l of ['gist', 'evidence']) {
    const unlimited = describeReport(theCase, ledgers, facts, { level: l, budget: 1e9, caseLink });
    const bounded = describeReport(theCase, ledgers, facts, { level: l, budget, caseLink });
    console.log(`${sizeLine(unlimited)} [unbounded]`);
    console.log(sizeLine(bounded));
  }
} else {
  const r = describeReport(theCase, ledgers, facts, { level, budget, caseLink });
  process.stdout.write(r.text);
  console.error(sizeLine(r));
}
console.error(`${ledgers.size} ledgers, ${facts.size} transactions, ${((Date.now() - t0) / 1000).toFixed(1)} s via ${stream.endpoint.replace(/^wss:\/\//, '')}`);
stream.close();
process.exit(0);

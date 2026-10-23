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
//   node scripts/describe.mjs case.json --coherence [--top K] [--lags L] [--series count|volume] [--bin ledger|minute|hour|day]
//                                                                        # the coherence readout (docs/coherence.md) instead of the text; --bin reads the series per minute, hour or day
//   node scripts/describe.mjs --coherence --accounts rA[~Label],rB,... --ledgers FROM-TO [--series count|involved|volume] [--include-failed]
//                                                                        # the same readout over series fetched with account_tx for the named accounts (no case file)
//   ... [--network mainnet|testnet] [--endpoint wss://s2.ripple.com] [--live]  # the node: the network's history endpoints in order (docs/loader.md), or one given endpoint first;
//                                                                        # a case's ledgers come from the bundle that ships with the page when it has them, unless --live
//
// The text goes to stdout; the size and the events-shown ratio go to stderr.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { XrplStream, NETWORKS } from '../src/ws.js';
import { validateCase, encodeCase } from '../src/case.js';
import { LedgerLoader, createBundle, endpointsFor, caseHashes, describeSources } from '../src/loader.js';
import { describeReport, factsForCase, DEFAULT_BUDGET } from '../src/describe.js';
import { buildScore } from '../src/score.js';
import { frameFromScore, frameFromAccountTx, coherence, readout, DEFAULTS as COHERENCE_DEFAULTS, BIN_NAMES } from '../src/coherence.js';
import { fetchAccountSeries, MAX_RANGE } from '../src/account-tx.js';
import { parseReplayRange } from '../src/replay.js';
import { buildHash } from '../src/params.js';
import { SITE_URL } from '../src/explorers.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};
const accountsSpec = opt('accounts', '');
const ledgersSpec = opt('ledgers', '');
const byAccounts = Boolean(accountsSpec || ledgersSpec);
if (!file && !byAccounts) {
  console.error('usage: node scripts/describe.mjs <case.sonic-case.json> [--level gist|evidence] [--budget N] [--measure] [--coherence [--top K] [--lags L] [--series count|volume] [--bin ledger|minute|hour|day]]');
  console.error('       node scripts/describe.mjs --coherence --accounts rA[~Label],rB,... --ledgers FROM-TO [--series count|involved|volume] [--include-failed] [--network mainnet|testnet] [--endpoint wss://...]');
  process.exit(2);
}
if (typeof globalThis.WebSocket !== 'function') {
  console.error('This script needs a global WebSocket (Node 22+).');
  process.exit(2);
}
const level = opt('level', 'gist');
const budget = Number(opt('budget', DEFAULT_BUDGET)) || DEFAULT_BUDGET;
const measureOnly = args.includes('--measure');
const coherenceOnly = args.includes('--coherence');
const bin = opt('bin', COHERENCE_DEFAULTS.bin);
if (!BIN_NAMES.includes(bin)) {
  console.error(`--bin needs one of ${BIN_NAMES.join(', ')}`);
  process.exit(2);
}
const coherenceOptions = { maxLag: Number(opt('lags', COHERENCE_DEFAULTS.maxLag)) || COHERENCE_DEFAULTS.maxLag, bin };

// --- the series source: a case file, or named accounts over a range (account_tx)
let theCase = null;
let named = null;
if (byAccounts) {
  if (!coherenceOnly) {
    console.error('--accounts and --ledgers are for --coherence (there is no case to describe)');
    process.exit(2);
  }
  const range = parseReplayRange(ledgersSpec, MAX_RANGE);
  if (!range) {
    console.error(`--ledgers needs a range FROM-TO of at most ${MAX_RANGE} ledgers`);
    process.exit(2);
  }
  if (range.clamped) console.error(`--ledgers clamped to ${MAX_RANGE} ledgers: #${range.from}–#${range.to}`);
  const accounts = accountsSpec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [address, label] = s.split('~');
      return { address: address.trim(), label: (label ?? '').trim() || null };
    });
  if (accounts.length < 2) {
    console.error('--accounts needs at least two addresses, comma-separated, each with an optional ~Label');
    process.exit(2);
  }
  named = { accounts, from: range.from, to: range.to, network: opt('network', 'mainnet') === 'testnet' ? 'testnet' : 'mainnet' };
} else {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`Could not read ${file}: ${err?.message ?? err}`);
    process.exit(2);
  }
  const { case: validated, errors, warnings } = validateCase(raw);
  for (const e of errors) console.error(`case: ${e}`);
  for (const w of warnings) console.error(`case: ${w}`);
  if (!validated) process.exit(1);
  theCase = validated;
}

const networkName = theCase?.network ?? named.network;
if (!NETWORKS[networkName]) {
  console.error(`unknown network ${networkName}`);
  process.exit(2);
}
const endpoint = opt('endpoint', '');
const historyEndpoints = endpointsFor(networkName, 'history'); // docs/loader.md: s2.ripple.com first on mainnet
const endpoints = endpoint ? [endpoint, ...historyEndpoints.filter((e) => e !== endpoint)] : historyEndpoints;
const stream = new XrplStream({ endpoints, streams: [], onMessage: () => {} });
let connecting = null;
/** Connect on first need, so a case whose ledgers ship with the page needs no node at all. */
const connected = () => {
  connecting ??= new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('no connection to a node within 20 s'), { code: 'noNode' })), 20000);
    stream.onStatus = (s) => {
      if (s.state === 'connected') {
        clearTimeout(timer);
        resolve();
      }
    };
    stream.connect();
  });
  return connecting;
};
const request = async (cmd, opts) => {
  await connected();
  return stream.request(cmd, opts);
};

const t0 = Date.now();
if (named) {
  // series from account_tx (docs/coherence.md, phase 1.5): one account at a time, the pages reported as they arrive
  const fetched = await fetchAccountSeries((cmd) => request(cmd), named.accounts, {
    from: named.from,
    to: named.to,
    onPage: (p) => process.stderr.write(`\r${p.address}: page ${p.page}, ${p.entries} entries`),
    onAccount: (r) => process.stderr.write(`\r${r.account}: ${r.pages} page${r.pages === 1 ? '' : 's'}, ${r.entries.length} entries${r.missing.length ? `, missing ${r.missing.map((m) => `#${m.from}–#${m.to} (${m.reason})`).join(', ')}` : ''}${r.error ? `, error: ${r.error}` : ''}\n`),
  });
  const frame = frameFromAccountTx(fetched, { measure: opt('series', COHERENCE_DEFAULTS.measure), includeFailed: args.includes('--include-failed'), host: stream.endpoint.replace(/^wss:\/\//, '') });
  const report = coherence(frame, coherenceOptions);
  process.stdout.write(`${readout(report)}\n`);
  const requests = fetched.accounts.reduce((n, r) => n + r.requests, 0);
  console.error(`${frame.ledgers.length} ledgers, ${frame.records.length} transactions, ${requests} account_tx request${requests === 1 ? '' : 's'}, ${report.pairs.length} pair${report.pairs.length === 1 ? '' : 's'}, ${((Date.now() - t0) / 1000).toFixed(1)} s via ${stream.endpoint.replace(/^wss:\/\//, '')}`);
  stream.close();
  process.exit(0);
}
const bundle = createBundle({
  baseUrl: 'docs/cases/ledgers/',
  read: async (url) => {
    try {
      return JSON.parse(readFileSync(fileURLToPath(new URL(`../${url}`, import.meta.url)), 'utf8'));
    } catch {
      return null;
    }
  },
});
const loader = new LedgerLoader({
  network: networkName,
  request: (cmd) => request(cmd, { timeoutMs: 60000 }),
  endpoint: () => stream.endpoint,
  rotate: () => stream.rotate(),
  bundle,
  onEvent: (e) => process.stderr.write(`\n${e.type === 'slow-down' ? `${e.host} asked to slow down (${e.code}); waiting ${(e.delayMs / 1000).toFixed(1)} s` : e.type === 'rotate' ? `moving history requests to ${e.host}` : 'no node answered'}\n`),
});
const { ledgers, failures, sources } = await loader.case(theCase, { live: args.includes('--live'), hashes: caseHashes(theCase), onProgress: (d, t) => process.stderr.write(`\rfetching ledgers ${d}/${t}`) });
process.stderr.write(`\n${describeSources({ sources })}\n`);
for (const f of failures) console.error(`ledger #${f.index} could not be fetched: ${f.error}`);
/** The trailer's source: the node when it was asked, else the bundle that ships with the page. */
const via = sources.node || sources.failed ? stream.endpoint.replace(/^wss:\/\//, '') : 'the bundled ledgers';
if (coherenceOnly) {
  const score = buildScore(theCase, ledgers);
  const frame = frameFromScore(score, { cast: theCase.cast, topK: Number(opt('top', COHERENCE_DEFAULTS.topK)) || COHERENCE_DEFAULTS.topK, measure: opt('series', COHERENCE_DEFAULTS.measure), ledgers });
  const report = coherence(frame, coherenceOptions);
  process.stdout.write(`${readout(report)}\n`);
  console.error(`${ledgers.size} ledgers, ${score.counts.events} events, ${report.pairs.length} pair${report.pairs.length === 1 ? '' : 's'}, ${((Date.now() - t0) / 1000).toFixed(1)} s via ${via}`);
  stream.close();
  process.exit(0);
}
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
console.error(`${ledgers.size} ledgers, ${facts.size} transactions, ${((Date.now() - t0) / 1000).toFixed(1)} s via ${via}`);
stream.close();
process.exit(0);

#!/usr/bin/env node
// UNIVERSE phase 2 — the probe's fixtures, recorded from a public node verbatim.
//
// The probe's measures (src/universe/probe.js) are tested on real responses,
// never hand-written: this script asks one public node, one request at a
// time, for an account's bounded history (account_tx between two ledgers,
// forward, paged by marker) and the account's root, lines, objects and NFTs
// at the validated ledger, and writes each response as it came, with the
// request beside it, into <out>/<command>-<account>.json. The test pins the
// numbers the measures make of these; re-recording changes the fixture and
// the test says so.
//
//   node src/universe/bench/fetch-probe-fixtures.mjs --account r... --min <ledger> --max <ledger> [--out test/universe-fixtures/probe] [--pages 3] [--host wss://xrplcluster.com]

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};
const account = opt('account', null);
const min = Number(opt('min', NaN));
const max = Number(opt('max', NaN));
const out = opt('out', 'test/universe-fixtures/probe');
const pages = Math.max(1, Number(opt('pages', 3)) || 3);
const host = opt('host', 'wss://s2.ripple.com'); // full history, for the bounded account_tx
if (!account || !Number.isFinite(min) || !Number.isFinite(max)) {
  console.error('usage: node src/universe/bench/fetch-probe-fixtures.mjs --account r... --min <ledger> --max <ledger> [--out dir] [--pages n] [--host wss://...]');
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const ws = new WebSocket(host);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', (e) => reject(new Error(`could not connect to ${host}: ${e?.message ?? e}`)), { once: true });
});
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.status === 'error') p.reject(Object.assign(new Error(msg.error_message ?? msg.error), { code: msg.error }));
  else p.resolve(msg);
});
const request = (command) =>
  new Promise((resolve, reject) => {
    const id = `fixture-${++seq}`;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ ...command, id }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${command.command} timed out`));
    }, 30000);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PACE_MS = 250; // one request at a time, a quarter second apart: a public node's share
/** A public node that says tooBusy (its units quota) is waited for, fifteen seconds, up to three times; any other error is the response. */
const requestPaced = async (command) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request(command);
    } catch (err) {
      if (err.code !== 'tooBusy' || attempt >= 3) throw err;
      console.error(`${command.command}: ${err.message}; waiting 15 s`);
      await sleep(15000);
    }
  }
};

const save = (command, request_, responses) => {
  const file = join(out, `${command}-${account}.json`);
  writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString(), host, account, command, request: request_, responses }, null, 1));
  console.error(`${file}: ${responses.length} response(s)`);
};

// the bounded history, forward, paged by marker
{
  const base = { command: 'account_tx', account, ledger_index_min: min, ledger_index_max: max, forward: true, limit: 200 };
  const responses = [];
  let marker;
  for (let i = 0; i < pages; i++) {
    const res = await requestPaced(marker ? { ...base, marker } : base);
    responses.push(res);
    marker = res.result?.marker;
    if (!marker) break;
    await sleep(PACE_MS);
  }
  save('account_tx', base, responses);
}
for (const command of ['account_info', 'account_lines', 'account_objects', 'account_nfts']) {
  await sleep(PACE_MS);
  const req = { command, account, ledger_index: 'validated', ...(command === 'account_info' ? {} : { limit: 400 }) };
  try {
    const res = await requestPaced(req);
    save(command, req, [res]);
  } catch (err) {
    save(command, req, [{ status: 'error', error: err.code ?? 'unknown', error_message: err.message }]);
  }
}
ws.close();

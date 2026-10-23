#!/usr/bin/env node
// UNIVERSE phase 2 — the probe's expected numbers, made from the recorded fixtures.
//
// Runs the measures of src/universe/probe.js over every account_tx fixture
// in test/universe-fixtures/probe/ (recorded verbatim by
// bench/fetch-probe-fixtures.mjs) and writes what they made of it into
// expected.json beside them: the conservation rows per currency, the
// cadence, the entry count. test/universe-probe.test.js pins these; a change
// in the measures or a re-recording changes this file, and the diff says so.
//
//   node src/universe/bench/probe-expected.mjs [--dir test/universe-fixtures/probe]

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { conservation, seriesOf, cadence, conservationLabel, cadenceLabel, PROBE_VERSION } from '../probe.js';

const args = process.argv.slice(2);
const i = args.indexOf('--dir');
const dir = i >= 0 && args[i + 1] ? args[i + 1] : 'test/universe-fixtures/probe';
const out = { version: PROBE_VERSION, madeAt: new Date().toISOString(), accounts: {} };
for (const file of readdirSync(dir).filter((f) => f.startsWith('account_tx-') && f.endsWith('.json')).sort()) {
  const f = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const entries = f.responses.flatMap((r) => r.result?.transactions ?? []);
  const from = f.request.ledger_index_min;
  const to = f.request.ledger_index_max;
  const rows = conservation(entries, f.account);
  const cad = cadence(seriesOf(entries, f.account, { from, to }));
  out.accounts[f.account] = {
    fixture: file,
    entries: entries.length,
    bound: { from, to },
    conservation: rows.map((r) => ({ ...r, label: conservationLabel(r) })),
    cadence: { ...cad, label: cadenceLabel(cad) },
  };
  console.error(`${f.account}: ${entries.length} entries, ${rows.length} currencies, ${cad.label ?? cadenceLabel(cad)}`);
}
writeFileSync(join(dir, 'expected.json'), JSON.stringify(out, null, 1));
console.error(`${join(dir, 'expected.json')}: ${Object.keys(out.accounts).length} account(s)`);

#!/usr/bin/env node
// UNIVERSE phase 3B — the parity fixture: a live session of the page's forecaster, recorded.
//
// Opens the page headless on live mainnet (forecast mode: the parity replay pushes rows only, so the session must not
// carry nowcasts), waits for the given number of forecasts, then asks the worker for its session (the rows the
// forecaster read, without their trades, and the fingerprint after each) and writes it as
// test/universe-fixtures/forecast/live-session.json. test/universe-forecast.test.js replays the rows through a new
// forecaster in Node and requires the same fingerprint after every row. Public live data only.
//
//   node src/universe/bench/capture-forecast-session.mjs [--ledgers 80] [--out test/universe-fixtures/forecast/live-session.json]

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { launch, openPage, waitFor } from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};
const ledgers = Number(opt('ledgers', 80));
const out = opt('out', 'test/universe-fixtures/forecast/live-session.json');
const site = 'http://127.0.0.1:4181/';
const chrome = await launch({ port: 9350 });
const page = await openPage(chrome.port);
await page.navigate(`${site}universe.html?autostart=1&gl=0&forecast=1`);
const started = Date.now();
await waitFor(page, `window.xrplUniverse && window.xrplUniverse.forecast() && window.xrplUniverse.forecast().seq >= ${ledgers}`, { timeoutMs: 30 * 60000, everyMs: 2000 });
const session = JSON.parse(await page.evaluate('window.xrplUniverse.forecastSession().then((s) => JSON.stringify(s))'));
await page.evaluate('window.xrplUniverse.stop()');
const logs = page.logs.filter((l) => l.startsWith('EXCEPTION'));
page.close();
chrome.kill();
if (session.options.mode !== 'forecast') throw new Error(`the session ran in ${session.options.mode} mode; the parity replay needs forecast mode`);
if (session.rows.length !== session.fingerprints.length || session.rows.length < 40) throw new Error(`${session.rows.length} rows, ${session.fingerprints.length} fingerprints`);
const fixture = {
  about: 'A live session of the UNIVERSE forecaster (src/universe/forecast/), recorded by src/universe/bench/capture-forecast-session.mjs from the public mainnet stream: the rows it read (without their trades) and its fingerprint after each. test/universe-forecast.test.js replays the rows and requires the same fingerprints.',
  capturedAt: new Date(started).toISOString(),
  minutes: Math.round((Date.now() - started) / 6000) / 10,
  server: session.server,
  options: session.options,
  ledgers: [session.rows[0].index, session.rows.at(-1).index],
  rows: session.rows,
  fingerprints: session.fingerprints,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(fixture));
console.log(`${session.rows.length} rows (#${fixture.ledgers[0]}–#${fixture.ledgers[1]}) from ${session.server} in ${fixture.minutes} min → ${out}${logs.length ? ` · ${logs.length} page exceptions: ${logs[0]}` : ''}`);

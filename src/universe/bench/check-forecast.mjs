#!/usr/bin/env node
// UNIVERSE phase 3B — the forecast panel, checked headless on a replayed recording, on one renderer.
//
// Replays a stretch of the recording (with ?nowcast=1 when it holds in-flight data), then: G opens the panel and the
// button says so; the title names the next ledger and the status the mode and the worker's time; the first line says
// what the recording holds; the nowcast is labelled apart and first when it is on; the forecast line states the
// interval and its held-out record, the split is stated, the wake line carries the CUSUM and the change-point words,
// the close interval is forecast from local arrival times or said not to be, the event studies are counted; no line
// says "will" or reads as a trade signal; the probe's readout carries the next-ledger presence line for the probed
// account; G and Close shut the panel; no exceptions.
//
//   node src/universe/bench/check-forecast.mjs --recording <file in the data mount> [--gl 1|0] [--pace 30] [--ledgers 140] [--nowcast 1|0]

import { launch, openPage, waitFor, sleep } from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};
const recording = opt('recording', null);
const gl = opt('gl', '1');
const pace = Number(opt('pace', 30));
const ledgers = Number(opt('ledgers', 140));
const nowcast = opt('nowcast', '1') === '1';
if (!recording) {
  console.error('usage: node src/universe/bench/check-forecast.mjs --recording <file> [--gl 1|0] [--pace ms] [--ledgers n] [--nowcast 1|0]');
  process.exit(2);
}
const site = 'http://127.0.0.1:4181/';
const chrome = await launch({ port: 9349 });
const page = await openPage(chrome.port);
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok ' : 'FAIL'} ${name}${detail ? ` · ${String(detail).slice(0, 200)}` : ''}`);
  if (!ok) failures += 1;
};
const key = async (text, keyName = text, code = `Key${text.toUpperCase()}`) => {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, text: text.length === 1 ? text : undefined });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code });
  await sleep(200);
};
const lines = async () => JSON.parse(await page.evaluate(`JSON.stringify([...document.querySelectorAll('#forecast-lines li')].map((li) => li.textContent))`));

await page.navigate(`${site}universe.html?replay=/data/${encodeURIComponent(recording)}&pace=${pace}&autostart=1${nowcast ? '&nowcast=1' : ''}${gl === '1' ? '' : '&gl=0'}`);
await waitFor(page, `window.xrplUniverse && window.xrplUniverse.stats().coverage && window.xrplUniverse.stats().coverage.ledgersClosed >= ${ledgers} && window.xrplUniverse.forecast()`, { timeoutMs: 900000, everyMs: 1000 });
await page.evaluate('window.xrplUniverse.stop()');
await sleep(1500);

// --- the panel -------------------------------------------------------------------------------
check('the panel starts closed', await page.evaluate(`document.getElementById('forecast').classList.contains('hidden') && document.getElementById('forecast-btn').getAttribute('aria-pressed') === 'false'`));
await key('g');
check('G opens the forecast panel and the button says so', await page.evaluate(`!document.getElementById('forecast').classList.contains('hidden') && document.getElementById('forecast-btn').getAttribute('aria-pressed') === 'true'`));
const title = await page.evaluate(`document.getElementById('forecast-title').textContent`);
const status = await page.evaluate(`document.getElementById('forecast-status').textContent`);
const f = JSON.parse(await page.evaluate('JSON.stringify(window.xrplUniverse.forecast())'));
check('the title names the next ledger', /^The forecast · #[\d,]+$/.test(title) && title.endsWith(Number(f.next).toLocaleString('en-US')), title);
check('the status states the mode and the worker’s time', new RegExp(`^${nowcast ? 'nowcast' : 'forecast'} · [\\d.]+ ms$`).test(status), status);
const all = await lines();
const text = all.join('\n');
check('the panel holds the readout', all.length >= 12, `${all.length} lines`);
check('the first line says what the recording holds', /^this recording holds (local arrival times|proposed transactions|fee results|raw stream messages only)/.test(all[0]), all[0]);
const timed = /local arrival times/.test(all[0]);
if (nowcast && /proposed transactions|fee results/.test(all[0])) {
  const at = all.findIndex((l) => /^nowcast for ledger #[\d,]+, just before its close, from [\d,]+ closed ledgers and what was in flight for it/.test(l));
  const fc = all.findIndex((l) => /^forecast for ledger #/.test(l));
  check('the nowcast is labelled apart, ahead of the forecast', at > 0 && fc > at, all[at]);
  check('the nowcast names the server’s heuristic as its own', /expected_ledger_size \(its own heuristic, as the server reported it\)/.test(text));
} else check('no nowcast without in-flight data', !/^nowcast for ledger/m.test(text));
check('the forecast line: the interval, the point, the held-out record or that there is none yet', all.some((l) => /^count \(shown: .+\) [\d.]+–[\d.]+ \(80%, (median [\d.]+, )?mean [\d.]+\) · (held-out coverage \d+% over \d+ ledgers|no held-out record yet)/.test(l)), all.find((l) => l.startsWith('count (shown')));
check('the split is stated', /models chosen on the first 60% of resolved ledgers \(#\d+–#\d+, \d+\), reported on the last 40%|the split needs/.test(text));
check('the verdict is said against persistence', /(nothing beats persistence|beats persistence: |persistence is shown until the held-out portion forms)/.test(text));
check('the wake line carries the CUSUM and the change-point words', all.some((l) => /^wake: count: gap .+ · CUSUM [\d.]+\/[\d.]+ \(\d+ alarms?, k 0\.5, ARL 500 at lag-1 autocorrelation 0\.\d, .+\) · run \d+ ledgers? · P\(a new run began at this ledger\) [\d.]+ · P\(change within 8\) /.test(l)), all.find((l) => l.startsWith('wake: count')));
check('the ropes are labelled with their windows, and never drawn longer than the history', /ropes \(count\): h 1 .+ · \d+ windows .+ h 1024 .+ forming/.test(text));
check(timed ? 'the close interval is forecast from local arrival times' : 'without arrival times the close interval is said not to be forecast', timed ? /close interval in ms \(from local arrival times; never the header close_time\) [\d.]+–[\d.]+/.test(text) : /close interval: no local arrival times in these rows/.test(text));
check('the event studies are counted and called candidate signals', /^event studies: [\d,]+ taker trades with an XRP side seen, \d+ studies completed .+ candidate signals, not used by any forecast here/m.test(text));
const forbidden = text.match(/\b(will|arbitrage|inefficient|diverse|equilibrium|profit|buy|sell|opportunity|guaranteed)\b/i);
check('no line says "will" or reads as a trade signal', !forbidden, forbidden?.[0]);
const fp = await page.evaluate('window.xrplUniverse.forecast().fingerprint');
check('the readout carries its fingerprint for the parity test', typeof fp === 'string' && fp.startsWith('{"N":'));

// --- the probe's presence line -----------------------------------------------------------------
await page.evaluate(`(() => { const u = window.xrplUniverse; const g = u.sky.nebulae.filter((n) => n.core).sort((a, b) => b.size - a.size)[0]; if (g) u.focusOn(g.root, { look: false }); })()`);
if (!(await page.evaluate('window.xrplUniverse.state.focus > 0'))) await key(']', ']', 'BracketRight');
const focus = await page.evaluate('window.xrplUniverse.state.focus');
await key(' ', ' ', 'Space');
await waitFor(page, 'window.xrplUniverse.probeState() && window.xrplUniverse.probeState().presence', { timeoutMs: 60000, everyMs: 300 }).catch(() => null);
const presence = await page.evaluate('window.xrplUniverse.probeState() ? window.xrplUniverse.probeState().presence : null');
check('the probe’s readout carries the probed account’s next-ledger presence', typeof presence === 'string' && /^transacts at #[\d,]+: P \d\.\d\d/.test(presence) && /present in \d+ of the last \d+ ledgers/.test(presence), `#${focus}: ${presence}`);
check('the presence line is in the drawer', await page.evaluate(`[...document.querySelectorAll('#probe-lines li')].some((li) => li.textContent.startsWith('next ledger: transacts at #'))`));
await key('Escape', 'Escape', 'Escape');

// --- closing ---------------------------------------------------------------------------------
await page.screenshot(`src/universe/bench/results/forecast-${gl === '1' ? 'webgl' : '2d'}.png`);
await key('g');
check('G closes the panel', await page.evaluate(`document.getElementById('forecast').classList.contains('hidden') && document.getElementById('forecast-btn').getAttribute('aria-pressed') === 'false'`));
await key('g');
await page.evaluate(`document.getElementById('forecast-close').click()`);
await sleep(200);
check('Close shuts it too', await page.evaluate(`document.getElementById('forecast').classList.contains('hidden')`));

const logs = page.logs.filter((l) => l.startsWith('EXCEPTION'));
check('no exceptions on the page', logs.length === 0, logs[0]);
page.close();
chrome.kill();
console.log(failures ? `${failures} failed` : 'all checks passed');
process.exit(failures ? 1 : 0);

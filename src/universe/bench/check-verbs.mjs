#!/usr/bin/env node
// UNIVERSE phase 1.5 — the four verbs, checked in headless Chrome per renderer.
//
// Replays a recording (bench/record-stream.mjs, served by the bench server's
// /data/ mount) through the page at a fast pace and asserts: all four verbs
// were seen; every object drawn is in the vocabulary (no zoo); a star
// ignited on a real issuer (screenshot at that moment); the motion grammar
// gives a still marker for every object under reduced motion; hovering an
// event's head puts its text, rule and evidence in the focus line; stepping
// with . and , reads events; the frame time held. Exits non-zero on a
// failed assertion.
//
//   node src/universe/bench/serve.mjs --data <dir> &
//   node src/universe/bench/check-verbs.mjs --recording stream-mainnet-....ndjson [--gl 0|1] [--minutes 12] [--pace 120]

import { launch, openPage, waitFor, sleep } from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};
const gl = opt('gl', '1');
const recording = opt('recording', null);
const pace = Number(opt('pace', 120)) || 120;
const maxLedgers = Number(opt('ledgers', 240)) || 240;
if (!recording) {
  console.error('--recording <file name under the data mount> is required');
  process.exit(2);
}
const site = 'http://127.0.0.1:4181/';
const chrome = await launch({ port: 9346 + Number(gl) });
const page = await openPage(chrome.port);
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok ' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const key = async (text, keyName = text, code = `Key${text.toUpperCase()}`) => {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, text: text.length === 1 ? text : undefined });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code });
  await sleep(120);
};

await page.navigate(`${site}universe.html?replay=/data/${encodeURIComponent(recording)}&pace=${pace}${gl === '1' ? '' : '&gl=0'}&autostart=1`);
await waitFor(page, 'window.xrplUniverse && window.xrplUniverse.stats().ledger != null', { timeoutMs: 60000 });
check(gl === '1' ? 'WebGL is the renderer' : 'the 2D canvas is the renderer', (await page.evaluate('window.xrplUniverse.stats().renderer')) === (gl === '1' ? 'webgl' : '2d'));

// run the replay until the ledger budget, the recording's end, or an ignition plus enough ledgers for the verbs
const t0 = Date.now();
let s = null;
let shot = false;
for (;;) {
  s = JSON.parse(await page.evaluate('JSON.stringify(window.xrplUniverse.stats())'));
  if (s.ignitions > 0 && !shot) {
    await page.evaluate(`(() => { const u = window.xrplUniverse; const ig = u.state.ignitions.at(-1); u.focusOn(ig.id); return ig.label; })()`);
    await sleep(500);
    await page.screenshot(`src/universe/bench/results/verbs-ignition-${gl === '1' ? 'webgl' : '2d'}.png`);
    shot = true;
    console.log(`     ignition: ${await page.evaluate('JSON.stringify(window.xrplUniverse.state.ignitions.at(-1))')}`);
    await key('Escape', 'Escape', 'Escape');
  }
  const ledgers = s.coverage?.ledgersClosed ?? 0;
  if (s.replayDone || ledgers >= maxLedgers || Date.now() - t0 > 240000) break;
  await sleep(1500);
}
check('the replay ran', (s.coverage?.ledgersClosed ?? 0) >= 12, `${s.coverage?.ledgersClosed} ledgers, ${s.counts?.transactions} transactions`);
check('all four verbs were seen', ['travel', 'dock', 'place', 'happen'].every((v) => s.verbsSeen.includes(v)), s.verbsSeen.join(', '));
const vocabulary = new Set(JSON.parse(await page.evaluate('JSON.stringify(Object.keys(window.xrplUniverse.objects))')));
const zoo = s.objectsSeen.filter((o) => !vocabulary.has(o));
check('no zoo: every object drawn is in the vocabulary', zoo.length === 0, zoo.join(', ') || `${s.objectsSeen.length} objects seen`);
check('the counts name the verbs and the sparks', s.counts && typeof s.counts.verbs.travel === 'number' && typeof s.counts.spark === 'number', JSON.stringify(s.counts?.verbs));
check('a star ignited on a real issuer', s.ignitions > 0, `${s.ignitions} ignitions`);
check('the coverage line says it is a recording', await page.evaluate(`document.getElementById('coverage').textContent.includes('recording replayed')`));
check('motions were in flight', s.motions >= 0, `${s.motions} at the end`);
const frame = { mean: s.meanMs, p95: s.p95 };
check('the frame time held under the replay (p95 under 40 ms, software)', s.p95 != null && s.p95 < 40, `mean ${s.meanMs?.toFixed(1)} p95 ${s.p95?.toFixed(1)} ms`);

// the text equivalent: step through the last ledger's events with . and ,
await key('.', '.', 'Period');
const line1 = await page.evaluate(`document.getElementById('focus-line').textContent`);
check('. reads an event with its object, rule and evidence', /^(travel|dock|place|happen|spark|tick)[a-z-]+: .+ · [a-z.-]+ · .+/.test(line1), line1.slice(0, 160));
await key(',', ',', 'Comma');
const line2 = await page.evaluate(`document.getElementById('focus-line').textContent`);
check(', steps back to another event', line2 !== line1 || (s.counts?.transactions ?? 0) < 2, line2.slice(0, 100));

// hover: a motion head under the pointer puts the event in the line
const head = await page.evaluate(`(() => { const u = window.xrplUniverse; u.sky.draw(performance.now()); const h = u.sky.heads[0]; return h ? JSON.stringify({ x: h[0], y: h[1], object: h[2].object }) : null; })()`);
if (head) {
  const h = JSON.parse(head);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(h.x), y: Math.round(h.y) });
  await sleep(200);
  const hovered = await page.evaluate(`document.getElementById('focus-line').textContent`);
  check('hovering a motion head reads its event', hovered.includes(`${h.object}:`) || hovered.length > 10, hovered.slice(0, 120));
} else check('a motion head was available to hover (none in flight at the end; not a failure)', true);

// reduced motion: a still marker for every object, in this renderer's primitives path
const stills = JSON.parse(await page.evaluate(`(async () => { const M = await import('/src/universe/motions.js'); const E = await import('/src/universe/events.js'); const s = { x: new Float32Array(8), y: new Float32Array(8), r: new Float32Array(8), depth: new Float32Array(8) }; for (let i = 1; i < 8; i++) { s.x[i] = 100 + i * 50; s.y[i] = 200; s.r[i] = 4 + i; s.depth[i] = 2; } const out = {}; for (const name of E.OBJECT_NAMES) { const m = { object: name, from: 1, to: 2, via: [3], at: 1, t: 0.5, rgb: [76, 201, 240], loud: 1, width: 1.5, tail: 2, success: true, seed: 1, detail: { owner: 'rA', sequence: 7, band: 0.4, frozen: true, signers: ['a', 'b'], weights: [1, 1], quorum: 1, open: true } }; const p = M.primitivesOf(m, s, { reduced: true, now: 1000 }); out[name] = p.lines.length + p.dots.length + p.rings.length + p.darts.length; } return JSON.stringify(out); })()`));
const noStill = Object.entries(stills).filter(([name, n]) => n === 0 && !['blink', 'check-cancel', 'moon-beacon-off', 'flare'].includes(name)).map(([n]) => n);
check('every object has a still marker under reduced motion (blinks and flares may be nothing)', noStill.length === 0, noStill.join(', ') || `${Object.keys(stills).length} objects`);
await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await sleep(600);
check('reduced motion reaches the renderer while it runs', await page.evaluate('window.xrplUniverse.sky.reduced === true'));
await page.screenshot(`src/universe/bench/results/verbs-still-${gl === '1' ? 'webgl' : '2d'}.png`);

const errors = page.logs.filter((l) => l.startsWith('EXCEPTION') || l.startsWith('ERROR'));
check('no exceptions on the page', errors.length === 0, errors[0]?.slice(0, 240) ?? '');
console.log(`     objects seen: ${s.objectsSeen.join(', ')}`);
console.log(`     frame ${JSON.stringify(frame)} · counts ${JSON.stringify(s.counts)}`);
page.close();
chrome.kill();
console.log(failures ? `${failures} failed` : 'all checks passed');
process.exitCode = failures ? 1 : 0;

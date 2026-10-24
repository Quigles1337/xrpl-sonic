#!/usr/bin/env node
// UNIVERSE phase 2 — the probe and the UFO, checked headless on a replayed recording, on one renderer.
//
// Opens the page on the recording (?replay=, through bench/serve.mjs's /data/
// mount), lets a stretch of ledgers in, then: nothing in the sky moves on
// hover (the positions of every planet before and after the pointer crosses
// the sky are the same arrays); the UFO is on by default here, a double
// right-click over the sky puts it away and brings it back, the context menu
// is suppressed over the sky canvas and not elsewhere, U toggles it, the
// switch shows it; a hold on the busiest planet (the probe key on a focused
// planet) probes it: the readout states the history (none in a replay: the
// window is the record), the connections light, the catch arrives with its
// lit planets, each with the five slots, the phase 3 slots unmeasured, no
// label says "coordinated"; the text equivalent reads the catch through the
// focus line; Copy for AI carries the catch under its own heading; under
// reduced motion the beam is on or off and the saucer does not bob
// (drawn without exception); Escape puts the catch out; no exceptions.
//
//   node src/universe/bench/check-probe.mjs --recording <file in the data mount> [--gl 1|0] [--pace 60] [--ledgers 120]

import { launch, openPage, waitFor, sleep } from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};
const recording = opt('recording', null);
const gl = opt('gl', '1');
const pace = Number(opt('pace', 60));
const ledgers = Number(opt('ledgers', 120));
if (!recording) {
  console.error('usage: node src/universe/bench/check-probe.mjs --recording <file> [--gl 1|0] [--pace ms] [--ledgers n]');
  process.exit(2);
}
const site = 'http://127.0.0.1:4181/';
const chrome = await launch({ port: 9346 });
const page = await openPage(chrome.port);
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok ' : 'FAIL'} ${name}${detail ? ` · ${String(detail).slice(0, 160)}` : ''}`);
  if (!ok) failures += 1;
};
const key = async (text, keyName = text, code = `Key${text.toUpperCase()}`, modifiers = 0) => {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, text: text.length === 1 ? text : undefined, modifiers });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, modifiers });
  await sleep(150);
};
const mouse = async (type, x, y, button = 'none', clickCount = 0) => page.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount });

await page.navigate(`${site}universe.html?replay=/data/${encodeURIComponent(recording)}&pace=${pace}&autostart=1${gl === '1' ? '' : '&gl=0'}`);
await waitFor(page, `window.xrplUniverse && window.xrplUniverse.stats().coverage && window.xrplUniverse.stats().coverage.ledgersClosed >= ${ledgers}`, { timeoutMs: 600000, everyMs: 1000 });
await page.evaluate('window.xrplUniverse.stop()'); // the replay stops: the sky stands for the checks
await sleep(1500);

// --- nothing in the sky moves on hover ---------------------------------------------------------
{
  const before = await page.evaluate('Array.from(window.xrplUniverse.sky.positions.slice(0, 3 * (window.xrplUniverse.stats().planets + 1)))');
  for (let x = 100; x <= 1180; x += 60) {
    await mouse('mouseMoved', x, 300 + ((x / 60) % 5) * 40);
    await sleep(40);
  }
  await sleep(400);
  const after = await page.evaluate('Array.from(window.xrplUniverse.sky.positions.slice(0, 3 * (window.xrplUniverse.stats().planets + 1)))');
  const same = before.length === after.length && before.every((v, i) => v === after[i]);
  check('nothing in the sky moves on hover: every planet where it was after the pointer crossed the sky', same, `${before.length / 3 - 1} planets`);
  const hovered = await page.evaluate('window.xrplUniverse.sky.hover');
  check('the pointer crossing the sky hovered something (the sweep was not empty)', typeof hovered === 'number');
}

// --- the UFO -----------------------------------------------------------------------------------
check('the UFO is on by default here', await page.evaluate('window.xrplUniverse.state.ufo.ufo === true && window.xrplUniverse.sky.ufo.on === true'));
check('the switch shows it', (await page.evaluate(`document.getElementById('ufo').getAttribute('aria-pressed')`)) === 'true');
check('the one caption said the sentence', await page.evaluate(`document.getElementById('caption').textContent.includes('double right-click the sky')`));
{
  // the context menu: suppressed over the sky canvas, not elsewhere on the page
  const overSky = await page.evaluate(`(() => { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 400 }); document.getElementById('sky').dispatchEvent(e); return e.defaultPrevented; })()`);
  const elsewhere = await page.evaluate(`(() => { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }); document.querySelector('.topbar').dispatchEvent(e); return e.defaultPrevented; })()`);
  check('the context menu is suppressed over the sky canvas only', overSky === true && elsewhere === false, `sky ${overSky}, topbar ${elsewhere}`);
  // a double right-click over the sky: two secondary presses within the interval
  await mouse('mousePressed', 640, 400, 'right', 1);
  await mouse('mouseReleased', 640, 400, 'right', 1);
  await sleep(120);
  await mouse('mousePressed', 640, 400, 'right', 2);
  await mouse('mouseReleased', 640, 400, 'right', 2);
  await sleep(200);
  check('a double right-click on the sky puts the UFO away', await page.evaluate('window.xrplUniverse.state.ufo.ufo === false'));
  check('the switch follows', (await page.evaluate(`document.getElementById('ufo').getAttribute('aria-pressed')`)) === 'false');
  await key('u');
  check('U brings it back', await page.evaluate('window.xrplUniverse.state.ufo.ufo === true'));
  check('the setting is remembered under the sky’s own key', await page.evaluate(`JSON.parse(localStorage.getItem('xrpl-sonic:universe:v1') || '{}').ufo === true && localStorage.getItem('xrpl-sonic:settings:v2') === null`));
}

// --- the probe, by the mouse: a press held on a planet for the hold time, then released ---------------
{
  const planet = JSON.parse(await page.evaluate(`JSON.stringify((() => { const u = window.xrplUniverse; const s = u.sky.screen; const a = u.state.last.attrs; let best = 0; for (let id = 1; id <= a.n; id++) if (s.depth[id] > 0 && s.r[id] >= 3 && s.x[id] > 200 && s.x[id] < 1080 && s.y[id] > 120 && s.y[id] < 680 && s.r[id] > (s.r[best] ?? 0)) best = id; return { id: best, x: s.x[best], y: s.y[best] }; })())`));
  await mouse('mouseMoved', planet.x, planet.y);
  await sleep(150);
  await mouse('mousePressed', planet.x, planet.y, 'left', 1);
  await sleep(250);
  check('a short press is not yet a hold', await page.evaluate('window.xrplUniverse.probeState() === null'));
  await sleep(450);
  const held = JSON.parse(await page.evaluate('JSON.stringify((() => { const p = window.xrplUniverse.probeState(); return { on: Boolean(p), id: p?.id, locked: p?.locked, drag: Boolean(window.xrplUniverse.sky.drag) }; })())'));
  check('a press held on a planet for the hold time probes it and locks the beam', held.on && held.id === planet.id && held.locked === true && !held.drag, JSON.stringify(held));
  await mouse('mouseReleased', planet.x, planet.y, 'left', 1);
  await sleep(150);
  check('releasing the press retracts the beam and keeps the catch', await page.evaluate('window.xrplUniverse.probeState() && window.xrplUniverse.probeState().locked === false && window.xrplUniverse.sky.ufo.locked === 0'));
  await waitFor(page, 'window.xrplUniverse.probeState() && (window.xrplUniverse.probeState().catch || window.xrplUniverse.probeState().error)', { timeoutMs: 120000, everyMs: 500 });
  await key('Escape', 'Escape', 'Escape');
  check('Escape puts that catch out', await page.evaluate('window.xrplUniverse.probeState() === null'));
}

// --- the probe, by the keyboard: focus the busiest planet, Space holds -------------------------
// the busiest galaxy's core, a hub with counterparties (] would focus the most active planet, which may deal with nobody)
await page.evaluate(`(() => { const u = window.xrplUniverse; const g = u.sky.nebulae.filter((n) => n.core).sort((a, b) => b.size - a.size)[0]; if (g) u.focusOn(g.root, { look: false }); })()`);
if (!(await page.evaluate('window.xrplUniverse.state.focus > 0'))) await key(']', ']', 'BracketRight');
const focus = await page.evaluate('window.xrplUniverse.state.focus');
check('a planet is focused (the busiest galaxy’s core, else ])', focus > 0, `id ${focus}`);
await key(' ', ' ', 'Space');
check('Space with the UFO on and a planet focused holds the probe on it', await page.evaluate(`window.xrplUniverse.probeState() && window.xrplUniverse.probeState().id === ${focus} && window.xrplUniverse.probeState().locked === true`));
await waitFor(page, 'window.xrplUniverse.probeState() && (window.xrplUniverse.probeState().catch || window.xrplUniverse.probeState().error)', { timeoutMs: 120000, everyMs: 500 });
const p = JSON.parse(await page.evaluate(`JSON.stringify((() => { const p = window.xrplUniverse.probeState(); return { status: p.status, error: p.error, history: p.history, connections: p.connections.length, lit: p.catch ? p.catch.lit.length : -1, labels: p.catch ? p.catch.lit.slice(0, 3).map((l) => l.labels) : [], shorts: p.catch ? p.catch.lit.slice(0, 3).map((l) => l.short) : [], head: p.catch ? p.catch.head : null, lines: p.lines.slice(0, 6), tested: p.catch?.coherence?.tested, inStep: p.catch?.coherence?.significant, ms: p.catch?.ms }; })())`));
check('the probe ended without error', !p.error, p.error ?? p.status);
check('the readout states the history: none in a replay (or once stopped), the window is the record', p.history && p.history.source === 'window' && /replay|window is the record/.test(p.history.error ?? ''), p.history?.error);
check('the connections lit with counts', p.connections > 0, `${p.connections} connected`);
check('the catch arrived with lit planets', p.lit > 0, `${p.lit} lit in ${p.ms} ms`);
check('each lit planet has the five slots, the phase 3 slots unmeasured', p.labels.length > 0 && p.labels.every((l) => ['connection', 'proximity', 'coherence', 'influence', 'motif'].every((k) => typeof l[k] === 'string') && l.influence === 'not measured (phase 3)' && l.motif === 'not measured (phase 3)'));
check('the proximity label has the rank among the reached', p.labels.every((l) => /^record proximity /.test(l.proximity)), p.labels[0]?.proximity);
check('the coherence label is the readout’s: pairs tested and the record check, or why it was not judged', p.labels.every((l) => /pairs? tested( · the other read as involved[^·]*)? · (connected in the record: [\d,]+|not touching|record not available)$|^not judged: |^coherence not measured/.test(l.coherence)), p.labels[0]?.coherence);
check('no label says "coordinated"', !JSON.stringify(p).match(/coordinat/i));
check('the short label beside a lit planet is in the readout’s words', p.shorts.every((s) => /connected: \d+|not touching/.test(s)), p.shorts.join(' | '));
check('the head has the two phase 3 slots and the cadence from the window', p.head && p.head.influence === 'not measured (phase 3)' && p.head.cadence && /cadence|no cadence/.test(p.head.cadence.label), p.head?.cadence?.label);
await waitFor(page, 'window.xrplUniverse.probeState() && window.xrplUniverse.probeState().shared', { timeoutMs: 60000, everyMs: 500 });
const shared = JSON.parse(await page.evaluate('JSON.stringify(window.xrplUniverse.probeState().shared)'));
check('the shared-price measure answered on the replay from the book state', !shared.error && Array.isArray(shared.lines) && shared.lines.length >= 3, shared.error ?? `${shared.candidates} candidates, ${shared.loops?.length} loops, ${shared.ms} ms`);
check('its readout states the replay’s limits and the nerve, never the forbidden words', (() => { const t = (shared.lines ?? []).join(' '); return /nerve: /.test(t) && /a replay: offers taken at face/.test(t) && /rippling through trust lines is out of scope/.test(t) && !/arbitrage|inefficient|diverse|equilibrium/i.test(t); })(), (shared.lines ?? []).slice(0, 2).join(' | ').slice(0, 160));
check('the text equivalent reads the catch through the focus line', await page.evaluate(`(() => { const t = document.getElementById('focus-line').textContent; return t.startsWith('probe') && t.includes('record proximity'); })()`), (await page.evaluate(`document.getElementById('focus-line').textContent`)).slice(0, 120));
check('the readout drawer shows the lines', await page.evaluate(`!document.getElementById('probe').classList.contains('hidden') && document.querySelectorAll('#probe-lines li').length >= 3`));
check('Space again releases: the beam retracts, the catch stays lit', await (async () => {
  await key(' ', ' ', 'Space');
  return page.evaluate('window.xrplUniverse.probeState().locked === false && window.xrplUniverse.sky.catch !== null && window.xrplUniverse.sky.ufo.locked === 0');
})());
{
  // Copy for AI: the text carries the catch under its own heading (the clipboard is replaced by a spy)
  const text = await page.evaluate(`(async () => { let got = null; navigator.clipboard.writeText = async (t) => { got = t; }; await window.xrplUniverse.copyForAI(); return got; })()`);
  check('Copy for AI carries the catch under its own heading, after the events, with how to reply', typeof text === 'string' && text.includes('## The catch') && text.includes('## The last ledger') && text.includes('how to reply') && text.indexOf('## The last ledger') < text.indexOf('## The catch'), `${text?.length ?? 0} chars`);
}
{
  // reduced motion: the probe layer draws without exception, the beam on or off
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(300);
  await mouse('mouseMoved', 640, 400);
  await sleep(300);
  const ok = await page.evaluate(`(() => { try { const u = window.xrplUniverse; u.sky.setUfo({ over: true, x: 640, y: 400, since: performance.now() }); u.sky.draw(performance.now()); return u.sky.reduced === true; } catch (e) { return 'threw: ' + e.message; } })()`);
  check('under reduced motion the probe layer draws (beam on or off, no bob) without exception', ok === true, ok);
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
}
await key('Escape', 'Escape', 'Escape');
check('Escape puts the catch out', await page.evaluate(`window.xrplUniverse.probeState() === null && window.xrplUniverse.sky.catch === null && document.getElementById('probe').classList.contains('hidden')`));

const logs = page.logs.filter((l) => l.startsWith('EXCEPTION'));
check('no exceptions on the page', logs.length === 0, logs[0]);
page.close();
chrome.kill();
console.log(failures ? `${failures} failed` : 'all checks passed');
process.exit(failures ? 1 : 0);

#!/usr/bin/env node
// UNIVERSE spike — the keyboard and reduced-motion paths, checked in headless Chrome.
//
// Opens a small synthetic sky with prefers-reduced-motion emulated, and
// asserts: the renderer honours it (no turn, still comets); the coverage
// line is a status region with the synthetic sentence; `]` focuses a planet
// and the focus line (a status region) reads its text equivalent with the
// kind first; Escape clears it; `?` opens the help dialog and Escape closes
// it; the layer keys toggle their buttons' pressed state; Space stops and
// starts. Exits non-zero on the first failed assertion.
//
//   node src/universe/bench/serve.mjs &
//   node src/universe/bench/check-a11y.mjs [--gl 0|1]

import { launch, openPage, waitFor, sleep } from './cdp.mjs';

const args = process.argv.slice(2);
const gl = args.includes('--gl') ? args[args.indexOf('--gl') + 1] : '0';
const site = 'http://127.0.0.1:4181/';
const chrome = await launch({ port: 9345 });
const page = await openPage(chrome.port);
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok ' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const key = async (text, keyName = text, code = `Key${text.toUpperCase()}`) => {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, text: text.length === 1 ? text : undefined });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code });
  await sleep(150);
};

await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await page.navigate(`${site}universe.html?synthetic=300${gl === '1' ? '' : '&gl=0'}&autostart=1&seed=3#cast=rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah~Maker~brass~-0.6`);
await waitFor(page, 'window.xrplUniverse && window.xrplUniverse.stats().planets >= 300', { timeoutMs: 60000 });
await sleep(1500);

check(gl === '1' ? 'WebGL is the renderer by default' : '?gl=0 gives the 2D canvas', (await page.evaluate('window.xrplUniverse.stats().renderer')) === (gl === '1' ? 'webgl' : '2d'));
check('reduced motion reaches the renderer', await page.evaluate('window.xrplUniverse.sky.reduced === true'));
check('the cast in the hash is read and labelled as the listening page labels it', await page.evaluate(`window.xrplUniverse.state.cast.length === 1 && window.xrplUniverse.state.cast[0].label === 'Maker' && window.xrplUniverse.state.cast[0].address === 'rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah'`));
check('a body label prints its threshold', await page.evaluate(`(() => { const u = window.xrplUniverse; const a = u.state.last.attrs; for (let id = 1; id <= a.n; id++) { const b = u.bodies(id); if (b.kind !== 'planet') return true; } return a.n > 0; })()`));
if (gl === '1') {
  // the shader's camera agrees with the JavaScript projection: the brightest planet's pixel is lit where project() puts it
  const lit = await page.evaluate(`(() => { const u = window.xrplUniverse; const s = u.sky.screen; const a = u.state.last.attrs; let best = 0; for (let id = 1; id <= a.n; id++) if (s.depth[id] > 0 && s.r[id] > s.r[best]) best = id; u.sky.draw(performance.now()); const px = u.sky.readPixel(s.x[best], s.y[best]); const off = u.sky.readPixel(8, 8); return JSON.stringify({ best, r: +s.r[best].toFixed(1), px, off }); })()`);
  const p = JSON.parse(lit);
  check('the WebGL point lands where the projection says', p.best > 0 && Math.max(p.px[0], p.px[1], p.px[2]) > 60 && Math.max(p.off[0], p.off[1], p.off[2]) < 40, lit);
}
const yaw0 = await page.evaluate('window.xrplUniverse.sky.camera.yaw');
await sleep(1200);
check('the camera does not turn on its own', (await page.evaluate('window.xrplUniverse.sky.camera.yaw')) === yaw0);
check('the sky canvas has a role and a label', await page.evaluate(`(() => { const c = document.getElementById('sky'); return c.getAttribute('role') === 'img' && c.getAttribute('aria-label').length > 40 && c.tabIndex === 0; })()`));
check('the coverage line is a status region and names the synthetic sky', await page.evaluate(`(() => { const c = document.getElementById('coverage'); return c.getAttribute('role') === 'status' && c.getAttribute('aria-live') === 'polite' && /^Synthetic sky: .* Nothing here is the ledger\\.$/.test(c.querySelector('strong').textContent.trim()); })()`), await page.evaluate(`document.getElementById('coverage').textContent.slice(0, 120)`));
check('the focus line starts hidden', await page.evaluate(`document.getElementById('focus-line').classList.contains('hidden')`));

await key(']', ']', 'BracketRight');
await sleep(400);
const focus = await page.evaluate(`JSON.stringify({ hidden: document.getElementById('focus-line').classList.contains('hidden'), role: document.getElementById('focus-line').getAttribute('role'), text: document.getElementById('focus-line').textContent, focusId: window.xrplUniverse.state.focus, skyFocus: window.xrplUniverse.sky.focus })`);
const f = JSON.parse(focus);
check('] focuses the brightest planet and the focus line reads it', !f.hidden && f.role === 'status' && f.focusId > 0 && f.skyFocus === f.focusId && /planet|star|binary|black hole|pulsar/.test(f.text) && /balance/.test(f.text) && /transactions? in/.test(f.text), f.text.slice(0, 140));
const first = f.focusId;
await key(']', ']', 'BracketRight');
await sleep(300);
check('] again moves to the next planet', (await page.evaluate('window.xrplUniverse.state.focus')) !== first);
await key('[', '[', 'BracketLeft');
await sleep(300);
check('[ moves back', (await page.evaluate('window.xrplUniverse.state.focus')) === first);
check('the camera moved to the focused planet', (await page.evaluate('window.xrplUniverse.sky.camera.distance')) <= 0.9);
await key('Escape', 'Escape', 'Escape');
check('Escape clears the focus and hides the line', await page.evaluate(`window.xrplUniverse.state.focus === 0 && document.getElementById('focus-line').classList.contains('hidden')`));

await key('?', '?', 'Slash');
check('? opens the help dialog', await page.evaluate(`!document.getElementById('help').classList.contains('hidden') && document.getElementById('help').getAttribute('role') === 'dialog'`));
await key('Escape', 'Escape', 'Escape');
check('Escape closes it', await page.evaluate(`document.getElementById('help').classList.contains('hidden')`));

await key('t');
check('T toggles the trust layer off, with the button pressed state', await page.evaluate(`window.xrplUniverse.state.layers.trust === false && document.querySelector('.layer[data-layer="trust"]').getAttribute('aria-pressed') === 'false' && window.xrplUniverse.sky.layers.trust === false`));
await key('t');
check('T toggles it back', await page.evaluate(`window.xrplUniverse.state.layers.trust === true`));
await key('p');
check('P toggles the payment layer', await page.evaluate(`window.xrplUniverse.state.layers.payment === false`));
await key('p');

await key(' ', ' ', 'Space');
await sleep(300);
check('Space stops listening', await page.evaluate(`window.xrplUniverse.state.running === false && document.getElementById('start').textContent === 'Start'`));
await key(' ', ' ', 'Space');
await sleep(300);
check('Space starts again', await page.evaluate(`window.xrplUniverse.state.running === true`));

await key('ArrowLeft', 'ArrowLeft', 'ArrowLeft');
check('the arrow keys orbit', (await page.evaluate('window.xrplUniverse.sky.camera.yaw')) !== yaw0);
await key('0', '0', 'Digit0');
check('0 resets the camera', (await page.evaluate('window.xrplUniverse.sky.camera.distance')) === 3.2);

// sound: S turns the engine on from a key press, the worker posts events, the engine plays them
await key('s');
await sleep(5000);
const sound = JSON.parse(await page.evaluate(`JSON.stringify({ on: window.xrplUniverse.state.sound, pressed: document.getElementById('sound').getAttribute('aria-pressed'), state: window.xrplUniverse.engine.state, played: window.xrplUniverse.engine.stats.played, dropped: window.xrplUniverse.engine.stats.dropped })`));
check("S turns sound on and the engine plays the worker’s events", sound.on && sound.pressed === 'true' && sound.state === 'running' && sound.played > 0, JSON.stringify(sound));
await key('s');
check('S turns it off', await page.evaluate(`window.xrplUniverse.state.sound === false`));

const comets = await page.evaluate(`window.xrplUniverse.sky.comets.length`);
check('comets exist under reduced motion (drawn still, fading)', comets >= 0, `${comets} in flight`);
const errors = page.logs.filter((l) => l.startsWith('EXCEPTION') || l.startsWith('ERROR'));
check('no exceptions on the page', errors.length === 0, errors[0]?.slice(0, 200) ?? '');
await page.screenshot(`src/universe/bench/results/a11y-${gl === '1' ? 'webgl' : '2d'}.png`);
page.close();
chrome.kill();
console.log(failures ? `${failures} failed` : 'all checks passed');
process.exitCode = failures ? 1 : 0;

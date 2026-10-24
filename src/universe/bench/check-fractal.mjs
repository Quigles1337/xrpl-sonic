#!/usr/bin/env node
// UNIVERSE phase 2.5 — the fractal cosmos and the inside viewer, checked headless on a replayed recording.
//
// Replays a stretch of the recording, then asserts: the middle is not hollow
// (at least a fifth of the planets lie within half the ball's radius); the
// forest has depth (clusters within galaxies); the camera's home moved out
// with the ball; the fly keys move the eye and the arrows turn it; a dive
// puts the eye within 0.3 of the planet and faces it, and under reduced
// motion arrives at once; frame time inside a galaxy under the budget (the
// software bound); no exceptions.
//
//   node src/universe/bench/check-fractal.mjs --recording <file in the data mount> [--gl 1|0] [--pace 40] [--ledgers 150] [--forecast 1|0]

import { launch, openPage, waitFor, sleep } from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};
const recording = opt('recording', null);
const gl = opt('gl', '1');
const pace = Number(opt('pace', 40));
const forecast = opt('forecast', '1'); // 0: the page without the next-ledger forecast, to compare the layout's cost
const ledgers = Number(opt('ledgers', 150));
if (!recording) {
  console.error('usage: node src/universe/bench/check-fractal.mjs --recording <file> [--gl 1|0] [--pace ms] [--ledgers n]');
  process.exit(2);
}
const site = 'http://127.0.0.1:4181/';
const chrome = await launch({ port: 9348 });
const page = await openPage(chrome.port);
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok ' : 'FAIL'} ${name}${detail ? ` · ${String(detail).slice(0, 160)}` : ''}`);
  if (!ok) failures += 1;
};
const key = async (text, keyName = text, code = `Key${text.toUpperCase()}`, type = 'both') => {
  if (type !== 'up') await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, text: text.length === 1 ? text : undefined });
  if (type !== 'down') await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code });
  await sleep(120);
};

await page.navigate(`${site}universe.html?replay=/data/${encodeURIComponent(recording)}&pace=${pace}&autostart=1${gl === '1' ? '' : '&gl=0'}${forecast === '0' ? '&forecast=0' : ''}`);
await waitFor(page, `window.xrplUniverse && window.xrplUniverse.stats().coverage && window.xrplUniverse.stats().coverage.ledgersClosed >= ${ledgers}`, { timeoutMs: 600000, everyMs: 1000 });
await page.evaluate('window.xrplUniverse.stop()');
await sleep(1500);

const shape = JSON.parse(await page.evaluate(`JSON.stringify((() => { const u = window.xrplUniverse; const s = u.stats(); const n = s.planets; const p = u.sky.positions; const R = u.state.last.extent; let inner = 0; for (let id = 1; id <= n; id++) { const i = 3 * id; if (Math.hypot(p[i], p[i + 1], p[i + 2]) <= R / 2) inner += 1; } const g = u.sky.nebulae.filter((x) => x.core); return { planets: n, extent: R, inner: inner / n, galaxies: g.length, roots: g.filter((x) => !x.depth).length, deeper: g.filter((x) => x.depth > 0).length, maxDepth: Math.max(0, ...g.map((x) => x.depth)), largest: g[0] ? { size: g[0].size, r: g[0].r, root: g[0].root } : null, home: u.sky.camera.distance, layoutMs: s.stability?.meanMs ?? null }; })())`));
check('the middle is not hollow: a fifth of the planets within half the ball', shape.inner >= 0.2, `${(100 * shape.inner).toFixed(1)}% of ${shape.planets} within ${(shape.extent / 2).toFixed(2)} of ${shape.extent.toFixed(2)}`);
check('the forest has depth: clusters within galaxies', shape.deeper > 0 && shape.maxDepth >= 1, `${shape.roots} galaxies, ${shape.deeper} clusters within, depth up to ${shape.maxDepth}`);
check('the camera’s home moved out with the ball', shape.home >= 2.2 * shape.extent + 1.6 - 1e-6, `home ${shape.home.toFixed(2)} for a ball of ${shape.extent.toFixed(2)}`);
check('a layout step is under the phase 1 budget', shape.layoutMs == null || shape.layoutMs < 15, `${shape.layoutMs?.toFixed(1)} ms`);

// --- the inside viewer -----------------------------------------------------------------------------------
await key('f');
check('F turns the fly camera on', await page.evaluate('window.xrplUniverse.sky.fly.on === true'));
const eye0 = await page.evaluate('JSON.stringify(window.xrplUniverse.sky.eye())');
await key('w', 'w', 'KeyW', 'down');
await sleep(400);
await key('w', 'w', 'KeyW', 'up');
const eye1 = await page.evaluate('JSON.stringify(window.xrplUniverse.sky.eye())');
const moved = JSON.parse(eye0).map((v, i) => JSON.parse(eye1)[i] - v);
check('holding W moves the eye forward', Math.hypot(...moved) > 0.01, `${Math.hypot(...moved).toFixed(3)} units`);
const yaw0 = await page.evaluate('window.xrplUniverse.sky.camera.yaw');
await key('ArrowRight', 'ArrowRight', 'ArrowRight');
check('the arrows turn the view', (await page.evaluate('window.xrplUniverse.sky.camera.yaw')) !== yaw0);
check('sizes are referenced to the home scale while flying', await page.evaluate(`window.xrplUniverse.sky.camera.sizeDistance === 1.4 && window.xrplUniverse.sky.camera.distance === 0.02`));
check('the HUD says where the viewer is', await page.evaluate(`(() => { const h = document.getElementById('fly-hud'); return !h.classList.contains('hidden') && /flying · speed/.test(h.textContent); })()`), (await page.evaluate(`document.getElementById('fly-hud').textContent`)).slice(0, 120));

// the dive: to the largest galaxy's root
if (shape.largest) {
  const root = shape.largest.root;
  await page.evaluate(`window.xrplUniverse.fly.dive(${root}, { now: performance.now() })`);
  await sleep(900);
  const after = JSON.parse(await page.evaluate(`JSON.stringify((() => { const u = window.xrplUniverse; const i = 3 * ${root}; const p = [u.sky.positions[i], u.sky.positions[i + 1], u.sky.positions[i + 2]]; const e = u.sky.eye(); const f = u.sky.axes().forward; const d = p.map((v, k) => v - e[k]); const len = Math.hypot(...d); return { len, facing: (f[0] * d[0] + f[1] * d[1] + f[2] * d[2]) / len, gliding: Boolean(u.sky.glide) }; })())`));
  check('a dive puts the eye within 0.3 of the planet, facing it', after.len < 0.3 && after.facing > 0.99 && !after.gliding, `${after.len.toFixed(3)} away, facing ${after.facing.toFixed(3)}`);
  // frame time inside the galaxy
  await page.evaluate('window.xrplUniverse.sky.frameTimes.length = 0');
  await sleep(2500);
  const inside = JSON.parse(await page.evaluate('JSON.stringify(window.xrplUniverse.stats())'));
  check('frame time inside a galaxy under the software bound (p95 under 60 ms)', inside.p95 == null || inside.p95 < 60, `mean ${inside.meanMs?.toFixed(1)} p95 ${inside.p95?.toFixed(1)} ms at ${inside.planets} planets`);
  // reduced motion: the dive arrives at once
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(300);
  await page.evaluate(`window.xrplUniverse.sky.enterFly(); window.xrplUniverse.sky.flyMove(-1, 0, 0, 2)`);
  const at = JSON.parse(await page.evaluate(`JSON.stringify((() => { const u = window.xrplUniverse; u.fly.dive(${root}); const i = 3 * ${root}; const p = [u.sky.positions[i], u.sky.positions[i + 1], u.sky.positions[i + 2]]; const e = u.sky.eye(); return { len: Math.hypot(...p.map((v, k) => v - e[k])), gliding: Boolean(u.sky.glide) }; })())`));
  check('under reduced motion the dive arrives at once', at.len < 0.3 && !at.gliding, `${at.len.toFixed(3)} away`);
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
}
await key('f');
check('F again returns to orbit', await page.evaluate('window.xrplUniverse.sky.fly.on === false && window.xrplUniverse.sky.camera.sizeDistance === undefined'));
await key('0', '0', 'Digit0');
check('0 returns to the home, further out for a bigger ball', await page.evaluate(`Math.abs(window.xrplUniverse.sky.camera.distance - window.xrplUniverse.sky.homeDistance()) < 1e-9`));
await page.screenshot(`src/universe/bench/results/fractal-${gl === '1' ? 'webgl' : '2d'}.png`);

const logs = page.logs.filter((l) => l.startsWith('EXCEPTION'));
check('no exceptions on the page', logs.length === 0, logs[0]);
page.close();
chrome.kill();
console.log(failures ? `${failures} failed` : 'all checks passed');
process.exit(failures ? 1 : 0);

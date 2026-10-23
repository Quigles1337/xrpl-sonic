// UNIVERSE spike — the page.
//
// The worker (src/universe/worker.js) owns the stream, the records and the
// layout; this module owns the canvas, the camera, the keyboard, the
// coverage line and the focus line, and the sound through the listening
// page's engine (src/audio.js). Query: ?synthetic=N for a made-up sky of N
// planets (measuring), ?gl=1 for the WebGL path, ?autostart=1 to start on
// load (the bench harness), ?network=testnet, ?seed=N.

import { AudioEngine } from '../audio.js';
import { explorerUrl, SONIC_EXPLORER } from '../explorers.js';
import { Sky } from './sky.js';
import { SkyGL } from './sky-gl.js';

const query = new URLSearchParams(location.search);
const network = query.get('network') === 'testnet' ? 'testnet' : 'mainnet';
const synthetic = Math.max(0, Math.min(200000, Number(query.get('synthetic')) || 0));
const seed = Number(query.get('seed')) || 1337;
const wantGl = query.get('gl') === '1';
const autostart = query.get('autostart') === '1';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const $ = (sel) => document.querySelector(sel);
const canvas = $('#sky');
const labels = $('#labels');
const coverageEl = $('#coverage');
const focusLine = $('#focus-line');
const startBtn = $('#start');
const soundBtn = $('#sound');
const help = $('#help');

const state = {
  running: false,
  sound: false,
  ledger: null,
  planets: 0,
  focus: 0,
  focusList: [], // ids by brightness for [ ] travel
  focusIndex: -1,
  last: null, // the last ledger message
  memorySamples: [],
  startedAt: null,
  layers: { payment: true, trust: true, dex: true, nft: true },
  renderer: 'none',
};

let sky;
try {
  sky = wantGl ? new SkyGL(canvas, labels, { reduced: reducedMotion.matches, onHover }) : new Sky(canvas, labels, { reduced: reducedMotion.matches, onHover });
  state.renderer = wantGl ? 'webgl' : '2d';
} catch (err) {
  console.warn('[universe] WebGL unavailable, using the 2D canvas', err);
  sky = new Sky(canvas, labels, { reduced: reducedMotion.matches, onHover });
  state.renderer = '2d';
}
sky.onClick = (id) => (id ? focusOn(id, { look: false }) : clearFocus());
reducedMotion.addEventListener?.('change', (e) => sky.setReduced(e.matches));

const engine = new AudioEngine({ volume: 0.5 });
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const addresses = [null];

worker.onmessage = (e) => {
  const m = e.data ?? {};
  switch (m.type) {
    case 'ready':
      if (autostart) start();
      break;
    case 'status':
      $('#status-dot').dataset.state = m.state === 'connected' ? 'connected' : m.state === 'idle' ? 'idle' : 'connecting';
      $('#status-text').textContent = m.state === 'connected' ? (synthetic ? 'Synthetic' : m.host || 'Connected') : m.state === 'idle' ? 'Ready' : `${m.state}…`;
      break;
    case 'frame':
      sky.setPositions(m.positions, m.n);
      break;
    case 'ledger':
      onLedger(m);
      break;
    case 'described':
      showFocus(m);
      break;
    case 'error':
      console.warn('[universe]', m.message);
      break;
    default:
      break;
  }
};

function onLedger(m) {
  state.ledger = m.index;
  state.planets = m.attrs.n;
  state.last = m;
  for (const [id, address] of m.added) addresses[id] = address;
  sky.setPositions(m.positions, m.attrs.n);
  sky.setAttributes(m.attrs, m.added, m.index);
  sky.setNebulae(m.nebulae);
  sky.setPairs(m.pairs);
  sky.addComets(m.comets, m.intervalMs);
  $('#r-ledger').textContent = `#${Number(m.index).toLocaleString('en-US')}`;
  $('#r-planets').textContent = Number(m.attrs.n).toLocaleString('en-US');
  coverageEl.innerHTML = '';
  const strong = document.createElement('strong');
  strong.textContent = m.coverageLine;
  coverageEl.append(strong);
  if (m.stability) {
    const fine = document.createElement('span');
    fine.className = 'fine';
    fine.textContent = `layout: ${m.stability.warm} warm · moved ${(m.stability.moved * 1000).toFixed(2)}‰ of the sky per step · ${m.stability.meanMs.toFixed(1)} ms/step${m.nebulae.length ? ` · ${m.nebulae.length} nebulae` : ''}${m.pairs.length ? ` · ${m.pairs.length} pairs in step` : ''}`;
    coverageEl.append(fine);
  }
  // the travel order for [ and ]: by activity, then size
  const a = m.attrs;
  const ids = [];
  for (let id = 1; id <= a.n; id++) ids.push(id);
  ids.sort((p, q) => a.activity[q] - a.activity[p] || a.size[q] - a.size[p]);
  state.focusList = ids.slice(0, 200);
  if (state.sound && m.events.length) {
    engine.setLedgerInterval(m.intervalMs / 1000);
    engine.setExpectedCount(m.events.length);
    for (const ev of m.events) engine.play(ev);
  }
  if (state.focus) worker.postMessage({ type: 'describe', id: state.focus });
}

// --- the frame loop ------------------------------------------------------------

let raf = 0;
function frame(ts) {
  raf = requestAnimationFrame(frame);
  sky.draw(ts);
  if ((sky.frames & 31) === 0) {
    const s = sky.stats();
    $('#r-frame').textContent = s.meanMs == null ? '—' : `${s.meanMs.toFixed(1)} ms`;
  }
}
raf = requestAnimationFrame(frame);

// --- start, stop, sound ------------------------------------------------------------

async function start() {
  if (state.running) return;
  state.running = true;
  state.startedAt = Date.now();
  startBtn.textContent = 'Stop';
  startBtn.setAttribute('aria-pressed', 'true');
  worker.postMessage({ type: 'start', network, synthetic, seed, sound: state.sound });
  if (state.sound) await engine.start();
}

function stop() {
  if (!state.running) return;
  state.running = false;
  startBtn.textContent = 'Start';
  startBtn.setAttribute('aria-pressed', 'false');
  worker.postMessage({ type: 'stop' });
  engine.stop();
}

async function toggleSound() {
  state.sound = !state.sound;
  soundBtn.setAttribute('aria-pressed', String(state.sound));
  worker.postMessage({ type: 'sound', on: state.sound });
  if (state.sound) await engine.start();
  else engine.stop();
}

startBtn.addEventListener('click', () => (state.running ? stop() : start()));
soundBtn.addEventListener('click', toggleSound);

// --- layers ------------------------------------------------------------

for (const b of document.querySelectorAll('.layer')) {
  b.addEventListener('click', () => toggleLayer(b.dataset.layer));
}
function toggleLayer(name) {
  state.layers[name] = !state.layers[name];
  sky.setLayers({ [name]: state.layers[name] });
  const b = document.querySelector(`.layer[data-layer="${name}"]`);
  if (b) b.setAttribute('aria-pressed', String(state.layers[name]));
}

// --- focus and the text equivalent ------------------------------------------------------------

function onHover(id) {
  if (state.focus) return; // a focused planet keeps the line
  if (id) worker.postMessage({ type: 'describe', id, hover: true });
  else focusLine.classList.add('hidden');
}

function focusOn(id, { look = true } = {}) {
  state.focus = id;
  sky.setFocus(id);
  if (look) sky.lookAt(id);
  worker.postMessage({ type: 'describe', id });
}

function clearFocus() {
  state.focus = 0;
  state.focusIndex = -1;
  sky.setFocus(0);
  focusLine.classList.add('hidden');
}

function showFocus(m) {
  focusLine.classList.remove('hidden');
  focusLine.innerHTML = '';
  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = m.body?.kind ?? 'planet';
  const text = document.createElement('span');
  text.textContent = m.text;
  focusLine.append(kind, text);
  if (m.address && !synthetic) {
    const url = explorerUrl(SONIC_EXPLORER, network, 'account', m.address);
    if (url) {
      const a = document.createElement('a');
      a.href = url;
      a.textContent = ' · open in the explorer';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      focusLine.append(a);
    }
  }
}

function travel(step) {
  if (!state.focusList.length) return;
  state.focusIndex = (state.focusIndex + step + state.focusList.length) % state.focusList.length;
  focusOn(state.focusList[state.focusIndex]);
}

// --- keyboard ------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.key === 'Escape') {
    if (!help.classList.contains('hidden')) help.classList.add('hidden');
    else clearFocus();
    return;
  }
  if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
    help.classList.toggle('hidden');
    return;
  }
  if (!help.classList.contains('hidden')) return;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      state.running ? stop() : start();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      sky.orbit(-0.08, 0);
      break;
    case 'ArrowRight':
      e.preventDefault();
      sky.orbit(0.08, 0);
      break;
    case 'ArrowUp':
      e.preventDefault();
      sky.orbit(0, 0.06);
      break;
    case 'ArrowDown':
      e.preventDefault();
      sky.orbit(0, -0.06);
      break;
    case '+':
    case '=':
      sky.zoom(0.85);
      break;
    case '-':
    case '_':
      sky.zoom(1 / 0.85);
      break;
    case '0':
      sky.reset();
      clearFocus();
      break;
    case ']':
      travel(1);
      break;
    case '[':
      travel(-1);
      break;
    case 'Enter':
      if (state.focus && addresses[state.focus] && !synthetic) {
        const url = explorerUrl(SONIC_EXPLORER, network, 'account', addresses[state.focus]);
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
      }
      break;
    case 'p':
    case 'P':
      toggleLayer('payment');
      break;
    case 't':
    case 'T':
      toggleLayer('trust');
      break;
    case 'd':
    case 'D':
      toggleLayer('dex');
      break;
    case 'n':
    case 'N':
      toggleLayer('nft');
      break;
    case 's':
    case 'S':
      toggleSound();
      break;
    default:
      break;
  }
});
$('#help-btn').addEventListener('click', () => help.classList.toggle('hidden'));
$('#help-close').addEventListener('click', () => help.classList.add('hidden'));

// --- memory, for the bench harness ------------------------------------------------------------

async function memory() {
  const out = { at: new Date().toISOString(), minutes: state.startedAt ? (Date.now() - state.startedAt) / 60000 : 0, heap: null, measured: null, worker: null };
  if (performance.memory) out.heap = { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize };
  if (typeof performance.measureUserAgentSpecificMemory === 'function') {
    try {
      out.measured = await performance.measureUserAgentSpecificMemory();
    } catch (err) {
      out.measured = { error: err?.message ?? String(err) };
    }
  }
  out.worker = await new Promise((resolve) => {
    const h = (e) => {
      if (e.data?.type === 'memory') {
        worker.removeEventListener('message', h);
        resolve(e.data);
      }
    };
    worker.addEventListener('message', h);
    worker.postMessage({ type: 'memory' });
    setTimeout(() => resolve(null), 5000);
  });
  state.memorySamples.push(out);
  return out;
}

window.xrplUniverse = {
  state,
  sky,
  stats: () => ({ ...sky.stats(), renderer: state.renderer, ledger: state.ledger, planets: state.planets, running: state.running, synthetic, coverage: state.last?.coverage ?? null, stability: state.last?.stability ?? null, memory: state.last?.memory ?? null, coherence: state.last?.coherence ?? null }),
  memory,
  start,
  stop,
  focusOn,
  travel,
  worker,
  engine,
};

// UNIVERSE — the page.
//
// The worker (src/universe/worker.js) owns the stream, the records, the
// layout and the events; this module owns the canvas, the camera, the
// keyboard, the coverage line and the focus line, the Watch cast (the
// listening page's settings and the hash, read as it reads them), the name
// rule, the motions of each ledger's events on the flight clock, and the
// sound through the listening page's engine (src/audio.js), scheduled at
// each event's arrival. WebGL is the first renderer and the 2D canvas the
// fallback the page takes by itself (docs/universe.md, decision 4).
// Query: ?gl=0 for the canvas; ?synthetic=N for a made-up sky of N planets
// (measuring, behind its flag and labelled); ?replay=<url>&pace=<ms> to
// feed a recording instead of the node (the acceptance check); ?autostart=1
// to start on load (the bench harness); ?network=testnet; ?seed=N.

import { AudioEngine } from '../audio.js';
import { explorerUrl, SONIC_EXPLORER } from '../explorers.js';
import { loadSettings } from '../settings.js';
import { parseHash } from '../params.js';
import { normalizeCast, parseCastSpec } from '../cast.js';
import { Sky, LAYER_OF } from './sky.js';
import { SkyGL } from './sky-gl.js';
import { nameOf, KINDS } from './bodies.js';
import { describeEvent, colourOf, OBJECTS } from './events.js';
import { LIFE, LOUDNESS } from './motions.js';
import { hexToRgb } from './overlay.js';

const query = new URLSearchParams(location.search);
const network = query.get('network') === 'testnet' ? 'testnet' : 'mainnet';
const synthetic = Math.max(0, Math.min(200000, Number(query.get('synthetic')) || 0));
const seed = Number(query.get('seed')) || 1337;
const wantCanvas = query.get('gl') === '0';
const autostart = query.get('autostart') === '1';
const replay = (() => {
  const v = query.get('replay');
  if (!v) return null;
  // same-origin only: a path under the site, or the bench server's /data/ mount
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.includes('..')) return null;
  return v;
})();
const pace = Math.max(0, Number(query.get('pace')) || 300);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const $ = (sel) => document.querySelector(sel);
const canvas = $('#sky');
const labels = $('#labels');
const coverageEl = $('#coverage');
const focusLine = $('#focus-line');
const startBtn = $('#start');
const soundBtn = $('#sound');
const help = $('#help');

/** The Watch cast: the listening page's settings (the same storage), a cast in the hash winning over the stored one, #account= as a cast of one (as src/main.js does). */
function readCast() {
  const settings = loadSettings();
  const urlState = parseHash(location.hash);
  if (urlState.cast) {
    const { cast } = parseCastSpec(urlState.cast);
    if (cast.length) return cast;
  }
  if (urlState.account) return normalizeCast([{ address: urlState.account, label: 'Watched' }]);
  return Array.isArray(settings.cast) ? normalizeCast(settings.cast) : [];
}

const state = {
  running: false,
  sound: false,
  ledger: null,
  planets: 0,
  focus: 0,
  focusList: [],
  focusIndex: -1,
  last: null,
  memorySamples: [],
  startedAt: null,
  layers: { payment: true, trust: true, dex: true, nft: true },
  renderer: 'none',
  cast: readCast(),
  domains: new Map(), // id → hex Domain
  keys: new Map(), // id → regular key of a black hole candidate (null when absent)
  events: [], // the last ledger's events, for , and . and the hover line
  eventIndex: -1,
  counts: null, // the worker's cumulative counts of verbs and objects
  verbsSeen: new Set(),
  objectsSeen: new Set(),
  ignitions: [], // { ledger, id, address, label }
  replayDone: false,
};
const addresses = [null];

let sky;
try {
  if (wantCanvas) throw new Error('canvas asked for');
  sky = new SkyGL(canvas, labels, { reduced: reducedMotion.matches, onHover });
  state.renderer = 'webgl';
} catch (err) {
  if (!wantCanvas) console.warn('[universe] WebGL unavailable, using the 2D canvas', err?.message ?? err);
  sky = new Sky(canvas, labels, { reduced: reducedMotion.matches, onHover });
  state.renderer = '2d';
}
sky.onClick = (id) => (id ? focusOn(id, { look: false }) : clearFocus());
reducedMotion.addEventListener?.('change', (e) => sky.setReduced(e.matches));

/** The name rule for a planet the page knows: Domain, else the cast's label, else the short address. */
const names = (id) => nameOf({ address: addresses[id], domain: state.domains.get(id) ?? null }, state.cast);
/** The body of a planet from the last ledger's attributes, as the labels need it. */
const bodies = (id) => {
  const a = state.last?.attrs;
  if (!a || id > a.n) return { kind: 'planet' };
  return { kind: KINDS[a.kind[id]] ?? 'planet', holders: a.holders[id], providers: a.providers[id], period: a.period[id], r: a.r100[id] / 100, regularKey: state.keys.get(id) ?? null };
};
sky.setResolvers({ names, bodies });
const nameOfId = (id) => (id > 0 ? names(id).name : 'nobody');

function applyCast() {
  const map = new Map();
  for (let id = 1; id < addresses.length; id++) {
    const m = state.cast.find((c) => c.address === addresses[id]);
    if (m) map.set(id, m);
  }
  sky.setCast(map);
}
window.addEventListener('hashchange', () => {
  state.cast = readCast();
  applyCast();
});
window.addEventListener('storage', () => {
  state.cast = readCast();
  applyCast();
});

const engine = new AudioEngine({ volume: 0.5 });
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

worker.onmessage = (e) => {
  const m = e.data ?? {};
  switch (m.type) {
    case 'ready':
      if (autostart) start();
      break;
    case 'status':
      $('#status-dot').dataset.state = m.state === 'connected' ? 'connected' : m.state === 'idle' ? 'idle' : 'connecting';
      $('#status-text').textContent = m.state === 'connected' ? (synthetic ? 'Synthetic' : replay ? 'Replay' : m.host || 'Connected') : m.state === 'idle' ? 'Ready' : `${m.state}…`;
      break;
    case 'frame':
      sky.setPositions(m.positions, m.n);
      break;
    case 'ledger':
      onLedger(m);
      break;
    case 'described':
      if (m.hover && state.focus) break; // a focused planet keeps the line
      showFocus(m);
      break;
    case 'replay-done':
      state.replayDone = true;
      break;
    case 'error':
      console.warn('[universe]', m.message);
      break;
    default:
      break;
  }
};

/** The flight of the i-th of k events of a ledger: staggered across 85% of the interval, a life from the object's LIFE in intervals (src/universe/motions.js). */
function flight(e, i, k, intervalMs, now) {
  const start = now + (i / Math.max(1, k)) * intervalMs * 0.85;
  const life = (LIFE[e.object] ?? 0.9) * intervalMs;
  const instant = e.verb === 'happen' || e.verb === 'place' || e.object === 'spark' || e.object === 'tick' || e.object === 'ignite';
  return { start, life, arrival: instant ? start : start + life };
}

/** An event as a motion: the flight clock, the field guide's colour, its loudness, its width from the amount, its layer. */
function motionOf(e, i, k, intervalMs, now) {
  const f = flight(e, i, k, intervalMs, now);
  const log = e.detail?.log;
  return { ...e, ...f, rgb: hexToRgb(colourOf(e)), loud: LOUDNESS[e.object] ?? 1, width: 1 + Math.max(0, (Number.isFinite(log) ? log : 0) + 1) * 0.35, tail: 1 + (e.hops ?? 0), seed: (e.hash ? parseInt(e.hash.slice(0, 6), 16) / 0xffffff : 0.37) * Math.PI * 2, layer: LAYER_OF[e.category] ?? 'other', t: 0 };
}

function onLedger(m) {
  state.ledger = m.index;
  state.planets = m.attrs.n;
  state.last = m;
  state.counts = m.counts ?? null;
  let castChanged = false;
  for (const [id, address] of m.added) {
    addresses[id] = address;
    if (state.cast.some((c) => c.address === address)) castChanged = true;
  }
  for (const [id, hex] of m.domains) state.domains.set(id, hex);
  state.keys = new Map(m.keys);
  if (castChanged || !sky.cast.size) applyCast();
  sky.setPositions(m.positions, m.attrs.n);
  sky.setAttributes(m.attrs, m.added, m.index);
  sky.setNebulae(m.nebulae);
  sky.setPairs(m.pairs);
  sky.setStanding(m.standing);
  sky.setWeather(m.weather);
  sky.ledgerClosed();
  // the events of the ledger as motions, on one clock for the picture and the sound
  const now = performance.now();
  const k = m.events.length;
  const motions = m.events.map((e, i) => motionOf(e, i, k, m.intervalMs, now));
  for (const e of m.events) {
    if (e.verb) state.verbsSeen.add(e.verb);
    state.objectsSeen.add(e.object);
    if (e.object === 'ignite') state.ignitions.push({ ledger: m.index, id: e.at, address: addresses[e.at] ?? e.detail?.address ?? null, label: describeEvent(e, nameOfId) });
  }
  state.events = m.events;
  state.eventIndex = -1;
  sky.addMotions(motions);
  if (state.sound && engine.state === 'running') {
    engine.setLedgerInterval(m.intervalMs / 1000);
    engine.setExpectedCount(k);
    for (const mo of motions) if (mo.sound) engine.playAt(mo.sound, (mo.arrival - now) / 1000);
  }
  $('#r-ledger').textContent = `#${Number(m.index).toLocaleString('en-US')}`;
  $('#r-planets').textContent = Number(m.attrs.n).toLocaleString('en-US');
  coverageEl.innerHTML = '';
  const strong = document.createElement('strong');
  strong.textContent = m.coverageLine;
  coverageEl.append(strong);
  const fine = document.createElement('span');
  fine.className = 'fine';
  const v = m.counts?.verbs ?? {};
  fine.textContent = `events: ${k} this ledger · travel ${v.travel ?? 0} · dock ${v.dock ?? 0} · place ${v.place ?? 0} · happen ${v.happen ?? 0} · sparks ${m.counts?.spark ?? 0} · ticks ${m.counts?.tick ?? 0}${m.stability ? ` · layout ${m.stability.meanMs.toFixed(1)} ms/step` : ''}${m.nebulae.length ? ` · ${m.nebulae.length} nebulae` : ''}`;
  coverageEl.append(fine);
  // the travel order for [ and ]: by activity, then size
  const a = m.attrs;
  const ids = [];
  for (let id = 1; id <= a.n; id++) ids.push(id);
  ids.sort((p, q) => a.activity[q] - a.activity[p] || a.size[q] - a.size[p]);
  state.focusList = ids.slice(0, 200);
  if (state.focus) worker.postMessage({ type: 'describe', id: state.focus, cast: state.cast });
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
  state.replayDone = false;
  startBtn.textContent = 'Stop';
  startBtn.setAttribute('aria-pressed', 'true');
  worker.postMessage({ type: 'start', network, synthetic, seed, sound: state.sound, replay, pace });
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
  if (id) worker.postMessage({ type: 'describe', id, hover: true, cast: state.cast });
  else focusLine.classList.add('hidden');
}

canvas.addEventListener('pointermove', (e) => {
  if (state.focus || sky.drag) return;
  const m = sky.hitMotion(e.clientX, e.clientY);
  if (m) showEvent(m);
});

function focusOn(id, { look = true } = {}) {
  state.focus = id;
  sky.setFocus(id);
  if (look) sky.lookAt(id);
  worker.postMessage({ type: 'describe', id, cast: state.cast });
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

/** An event in the focus line: its text by the name rule, then its rule and the record fields that earned it. */
function showEvent(e) {
  focusLine.classList.remove('hidden');
  focusLine.innerHTML = '';
  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = e.verb ?? (e.object === 'tick' ? 'tick' : 'spark');
  const text = document.createElement('span');
  text.textContent = describeEvent(e, nameOfId);
  const rule = document.createElement('span');
  rule.className = 'fine';
  rule.textContent = ` · ${e.rule} · ${(e.evidence ?? []).map((x) => `${x.field}: ${x.value}`).join(' · ')}`;
  focusLine.append(kind, text, rule);
  if (e.hash && !synthetic) {
    const url = explorerUrl(SONIC_EXPLORER, network, 'tx', e.hash);
    if (url) {
      const a = document.createElement('a');
      a.href = url;
      a.textContent = ' · open the transaction';
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

/** Step through the last ledger's events with , and . : each goes to the focus line as text. */
function stepEvent(step) {
  if (!state.events.length) return;
  state.eventIndex = (state.eventIndex + step + state.events.length) % state.events.length;
  showEvent(state.events[state.eventIndex]);
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
    case '.':
      stepEvent(1);
      break;
    case ',':
      stepEvent(-1);
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
  addresses,
  names,
  bodies,
  objects: OBJECTS,
  describeEvent: (e) => describeEvent(e, nameOfId),
  stats: () => ({ ...sky.stats(), renderer: state.renderer, ledger: state.ledger, planets: state.planets, running: state.running, synthetic, replay, coverage: state.last?.coverage ?? null, stability: state.last?.stability ?? null, memory: state.last?.memory ?? null, coherence: state.last?.coherence ?? null, counts: state.counts, verbsSeen: [...state.verbsSeen], objectsSeen: [...state.objectsSeen], ignitions: state.ignitions.length, motions: sky.motions.length, replayDone: state.replayDone }),
  memory,
  start,
  stop,
  focusOn,
  travel,
  stepEvent,
  worker,
  engine,
};

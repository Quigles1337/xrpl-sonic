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
import { UfoGestures, loadUfoState, saveUfoState, UFO_SENTENCE, HOLD_MS } from './ufo.js';
import { describeCatch, historyLabel } from './probe.js';
import { addAnnotation, serializeCase, caseFilename, encodeCase, validateCase } from '../case.js';
import { buildHash } from '../params.js';
import { SITE_URL } from '../explorers.js';
import { REPLY_TRAILER_HEAD, exampleAnnotation } from '../describe.js';

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
const pace = query.has('pace') && Number.isFinite(Number(query.get('pace'))) ? Math.max(0, Number(query.get('pace'))) : 300; // ?pace=0 is honoured: as fast as the worker reads
const windowLedgers = Math.min(4000, Math.max(50, Number(query.get('window')) || 300)); // the live window's ledgers, for the probe's statistic
const forecastOn = query.get('forecast') !== '0'; // the next-ledger forecast (docs/universe.md, Phase 3B): on unless ?forecast=0
const nowcastOn = query.get('nowcast') === '1'; // the nowcast: the proposed stream and a fee poll, labelled apart
const researchOn = query.get('research') === '1'; // the research switch: book_changes, cross-checked; off by default
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
  ufo: loadUfoState(), // { ufo: on, captionShown } under the sky's own key
  hold: null, // a primary button down on a planet, waiting to be a hold
  probe: null, // the probe in progress or the last one: { seq, id, address, locked, status, history, connections, catch, lines }
  probeSeq: 0,
  explored: new Map(), // id → what the exploration learned
  moments: [], // the moments saved from the probe this session
  forecast: null, // the worker's last forecast readout
  nowcast: null, // its last nowcast
  forecastOpen: false,
  sessionWaiters: [],
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
    case 'probe-history':
      if (state.probe && m.seq === state.probe.seq) {
        state.probe.history = m.history;
        state.probe.status = 'connections…';
        renderProbe();
      }
      break;
    case 'probe-page':
      if (state.probe && m.seq === state.probe.seq) {
        state.probe.status = `history: page ${m.pages}…`;
        renderProbe();
      }
      break;
    case 'probe-connections':
      if (state.probe && m.seq === state.probe.seq) {
        state.probe.connections = m.connections ?? [];
        state.probe.status = 'measuring…';
        sky.setCatch(interimCatch(state.probe));
        renderProbe();
      }
      break;
    case 'probe-catch':
      onCatch(m);
      break;
    case 'shared-price':
      onSharedPrice(m);
      break;
    case 'forecast':
      state.forecast = m;
      if (state.forecastOpen) renderForecast();
      break;
    case 'nowcast':
      state.nowcast = m;
      break;
    case 'forecast-presence':
      if (state.probe && m.seq === state.probe.seq) {
        state.probe.presence = m.line;
        renderProbe();
      }
      break;
    case 'forecast-session':
      for (const resolve of state.sessionWaiters.splice(0)) resolve(m);
      break;
    case 'shared-price-waiting':
      if (state.probe && m.seq === state.probe.seq) {
        state.probe.status = `shared price: waiting ${Math.round(m.ms / 1000)} s for the node’s quota (${m.command})`;
        renderProbe();
      }
      break;
    case 'shared-price-error':
      if (state.probe && m.seq === state.probe.seq) {
        state.probe.shared = { error: m.message, lines: [`shared price: not measured (${m.message})`] };
        renderProbe();
      }
      break;
    case 'probe-error':
      if (state.probe && m.seq === state.probe.seq) {
        state.probe.error = m.message;
        renderProbe();
      }
      break;
    case 'explored':
      if (m.explored) state.explored.set(m.id, m.explored);
      if (state.focus === m.id) worker.postMessage({ type: 'describe', id: m.id, cast: state.cast });
      if (state.probe && state.probe.id === m.id) {
        state.probe.explored = m.explored;
        if (m.reason) state.probe.status = m.reason;
        renderProbe();
      }
      break;
    case 'explore-error':
      console.warn('[universe] explore', m.message);
      break;
    case 'moment':
      onMoment(m);
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
  if (m.extent != null) sky.setExtent(m.extent);
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
let lastTs = 0;
const held = new Set(); // the fly keys held down: w a s d q e
let hudAt = 0;
function frame(ts) {
  raf = requestAnimationFrame(frame);
  const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0;
  lastTs = ts;
  if (sky.fly.on && held.size && dt) sky.flyMove((held.has('w') ? 1 : 0) - (held.has('s') ? 1 : 0), (held.has('d') ? 1 : 0) - (held.has('a') ? 1 : 0), (held.has('e') ? 1 : 0) - (held.has('q') ? 1 : 0), dt);
  if (ts - hudAt > 250) {
    hudAt = ts;
    updateHud();
  }
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
  worker.postMessage({ type: 'start', network, synthetic, seed, sound: state.sound, replay, pace, window: windowLedgers, forecast: forecastOn, nowcast: nowcastOn, research: researchOn });
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
  sky.setUfo({ since: performance.now() }); // the beam fades to its new target
  if (state.focus) return; // a focused planet keeps the line
  if (id) worker.postMessage({ type: 'describe', id, hover: true, cast: state.cast });
  else focusLine.classList.add('hidden');
}

canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  sky.setUfo({ over: true, x: e.clientX - rect.left, y: e.clientY - rect.top });
  if (state.ufo.ufo) canvas.style.cursor = 'none';
  if (state.hold && Math.hypot(e.clientX - state.hold.x, e.clientY - state.hold.y) > 4) cancelHold();
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

const FLY_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e']);
window.addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => held.clear());
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (sky.fly.on && FLY_KEYS.has(e.key.toLowerCase()) && !e.ctrlKey && !e.metaKey && !e.altKey) {
    // flying, W A S D Q E move the eye (the layer and sound keys are the buttons meanwhile)
    held.add(e.key.toLowerCase());
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape') {
    if (!help.classList.contains('hidden')) help.classList.add('hidden');
    else if (state.probe) {
      clearProbe();
      clearFocus();
    } else clearFocus();
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
      if (state.ufo.ufo && !e.shiftKey && state.focus) {
        // the probe key: hold on the focused planet, and release (Shift+Space is Start/Stop while the UFO is on)
        if (state.probe?.locked && state.probe.id === state.focus) releaseProbe();
        else beginProbe(state.focus);
      } else state.running ? stop() : start();
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
      if (sky.fly.on) sky.setFlySpeed(sky.fly.speed * 1.5);
      else sky.zoom(0.85);
      break;
    case '-':
    case '_':
      if (sky.fly.on) sky.setFlySpeed(sky.fly.speed / 1.5);
      else sky.zoom(1 / 0.85);
      break;
    case 'f':
    case 'F':
      if (sky.fly.on) sky.leaveFly();
      else sky.enterFly();
      updateHud();
      break;
    case 'g':
    case 'G':
      toggleForecast();
      break;
    case 'v':
    case 'V':
      if (state.focus) sky.diveTo(state.focus);
      updateHud();
      break;
    case '0':
      sky.reset();
      clearFocus();
      updateHud();
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
      if (!state.focus || !addresses[state.focus] || synthetic) break;
      if (e.shiftKey) {
        const url = explorerUrl(SONIC_EXPLORER, network, 'account', addresses[state.focus]);
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
      } else explore(state.focus);
      break;
    case 'u':
    case 'U':
      setUfo(!state.ufo.ufo);
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

// --- the UFO and the probe (phase 2) ------------------------------------------------------------

const ufoBtn = $('#ufo');
const probeEl = $('#probe');
const probeLines = $('#probe-lines');
const probeStatus = $('#probe-status');
const probeTitle = $('#probe-title');
const captionEl = $('#caption');
let captionTimer = 0;

/** The name of a lit planet from its address when the page has not yet been told its id (a planet the probe made). */
const nameOfLit = (id, address) => nameOf({ address: address ?? addresses[id], domain: state.domains.get(id) ?? null }, state.cast).name;

/** One caption, the first time the sky opens in this browser: the UFO's sentence. */
function showCaption(text, ms = 14000) {
  captionEl.textContent = text;
  captionEl.classList.remove('hidden');
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => captionEl.classList.add('hidden'), ms);
}

/** The UFO on or off: the switch, the key, the gestures all land here; remembered under the sky's own key. */
function setUfo(on) {
  state.ufo.ufo = Boolean(on);
  saveUfoState(state.ufo);
  ufoBtn.setAttribute('aria-pressed', String(state.ufo.ufo));
  canvas.classList.toggle('ufo', state.ufo.ufo);
  sky.setUfo({ on: state.ufo.ufo, since: performance.now() });
  if (!state.ufo.ufo) releaseProbe();
}
ufoBtn.addEventListener('click', () => setUfo(!state.ufo.ufo));
const gestures = new UfoGestures({ onToggle: () => setUfo(!state.ufo.ufo) });
canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // over the sky canvas only, never elsewhere on the page
canvas.addEventListener('mousedown', (e) => {
  if (gestures.mousedown(e)) e.preventDefault();
});
canvas.addEventListener('touchstart', (e) => gestures.touchstart(e), { passive: true });
canvas.addEventListener('pointerleave', () => sky.setUfo({ over: false }));

/** A hold: the primary button down on a planet, HOLD_MS without moving; the sky's drag is let go and the probe begins. */
function cancelHold() {
  if (state.hold) clearTimeout(state.hold.timer);
  state.hold = null;
}
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !state.ufo.ufo) return;
  const id = sky.hitTest(e.clientX, e.clientY);
  if (!id) return;
  const hold = { id, x: e.clientX, y: e.clientY, timer: 0 };
  hold.timer = setTimeout(() => {
    if (state.hold !== hold) return;
    state.hold = null;
    sky.drag = null;
    beginProbe(id);
  }, HOLD_MS);
  state.hold = hold;
});
const onRelease = () => {
  cancelHold();
  releaseProbe();
};
canvas.addEventListener('pointerup', onRelease);
canvas.addEventListener('pointercancel', onRelease);

/** The probe begins on a planet: the catch of the last one goes out, the beam locks, the worker is asked, in the spec's order. */
function beginProbe(id) {
  if (!id || !addresses[id]) return 0;
  const seq = ++state.probeSeq;
  state.probe = { seq, id, address: addresses[id], startedAt: performance.now(), locked: true, status: 'history…', history: null, connections: [], catch: null, lines: [], error: null, explored: state.explored.get(id) ?? null };
  sky.setCatch(null);
  sky.setUfo({ locked: id, since: performance.now() });
  focusOn(id, { look: false });
  worker.postMessage({ type: 'probe', id, seq });
  explore(id, seq);
  renderProbe();
  return seq;
}

/** Release retracts the beam; the catch stays lit. */
function releaseProbe() {
  if (!state.probe?.locked) return;
  state.probe.locked = false;
  sky.setUfo({ locked: 0, since: performance.now() });
}

/** Escape, or the readout's Close: the catch goes out. */
function clearProbe() {
  state.probe = null;
  sky.setCatch(null);
  sky.setUfo({ locked: 0 });
  probeEl.classList.add('hidden');
}

/** Exploration proper: the planet loaded as the explorer loads it, from the node; nothing in a replay or a synthetic sky. */
function explore(id, seq = ++state.probeSeq) {
  if (!id || synthetic || replay) return;
  worker.postMessage({ type: 'explore', id, seq });
}

const connectionCount = (label) => Number((/connected in the record: ([\d,]+)/.exec(label ?? '')?.[1] ?? '0').replace(/,/g, '')) || 0;
/** The short label beside a lit planet: the pair's head and the record's word, in the readout's words. */
function shortOf(l) {
  const coh = l.labels?.coherence ?? '';
  const head = coh.startsWith('in step') ? coh.split(' · ')[0] : coh.startsWith('not in step') ? 'not in step' : coh.startsWith('not judged') ? 'not judged' : '';
  const n = connectionCount(l.labels?.connection);
  const conn = l.touching ? `connected: ${n}` : 'not touching';
  return [head, conn].filter(Boolean).join(' · ');
}

/** The connections, lit as they land, before the measures: an interim catch with the record's counts only. */
function interimCatch(p) {
  return { account: { id: p.id, address: p.address }, short: `probe · ${p.connections.length} connected · measuring…`, lit: p.connections.map((c) => ({ id: c.id, address: c.address, inStep: false, touching: true, short: `connected: ${c.count}` })) };
}

function onCatch(m) {
  const p = state.probe;
  if (!p || m.seq !== p.seq) return;
  const c = m.catch;
  for (const l of c.lit) l.short = shortOf(l);
  c.short = `probe · ${c.lit.length} lit · ${c.coherence ? `${c.coherence.significant} in step of ${c.coherence.tested} tested` : 'no coherence'} · ${historyLabel(c.history).split(',')[0]}`;
  p.catch = c;
  p.lines = describeCatch(c, nameOfLit);
  p.status = `${c.lit.length} lit · ${c.ms} ms · shared price…`;
  worker.postMessage({ type: 'sharedPrice', id: p.id, seq: p.seq }); // after the probe's own requests, so the node's quota is not asked for everything at once
  sky.setCatch(c);
  renderProbe();
  // the text equivalent: the catch in the readout's words through the focus line's status region, one line per lit
  // planet, for a screen reader; the eye gets one short line (the readout panel has every line)
  focusLine.classList.remove('hidden');
  focusLine.innerHTML = '';
  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = 'probe';
  const text = document.createElement('span');
  text.textContent = `${nameOfLit(p.id, p.address)} · ${c.lit.length} lit · ${c.coherence ? `${c.coherence.significant} in step of ${c.coherence.tested} tested` : 'no coherence'} · ${historyLabel(c.history).split(' · ')[0]} · the readout has every line`;
  const full = document.createElement('span');
  full.className = 'sr-only';
  full.textContent = [p.lines[0].replace(/^probe: /, ''), ...p.lines.slice(1)].join(' · ');
  focusLine.append(kind, text, full);
}

/** Part A's lines join the readout and its loops light the sky: each loop member carries "loop · +x.xx% after fees". */
function onSharedPrice(m) {
  const p = state.probe;
  if (!p || m.seq !== p.seq) return;
  p.shared = m;
  p.status = `${p.catch?.lit.length ?? 0} lit · ${p.catch?.ms ?? 0} ms · shared price ${m.loops.length ? `${m.loops.length} loop${m.loops.length === 1 ? '' : 's'}` : m.all ? 'one price fits' : 'measured'} · ${m.ms} ms`;
  const c = sky.catch ?? (p.catch ? p.catch : null);
  if (c && m.loops.length) {
    const lit = new Map(c.lit.map((l) => [l.id, l]));
    for (const loop of m.loops) {
      const short = `loop · ${loop.edge >= 0 ? '+' : ''}${(100 * loop.edge).toFixed(2)}% after fees`;
      for (const member of loop.members) {
        if (!member.id || member.id === p.id) continue;
        const had = lit.get(member.id);
        if (had) had.short = `${short} · ${had.short}`;
        else lit.set(member.id, { id: member.id, address: member.address, inStep: false, touching: true, short, labels: { connection: 'in a loop with the probed account', proximity: '', coherence: '', influence: 'not measured (phase 3)', motif: 'not measured (phase 3)' } });
      }
    }
    c.lit = [...lit.values()];
    sky.setCatch(c);
  }
  renderProbe();
}

function renderProbe() {
  const p = state.probe;
  if (!p) return;
  probeEl.classList.remove('hidden');
  probeTitle.textContent = `The probe · ${nameOfLit(p.id, p.address)}`;
  probeStatus.textContent = p.error ? `error: ${p.error}` : p.status;
  probeLines.innerHTML = '';
  const add = (text, cls) => {
    const li = document.createElement('li');
    if (cls) li.className = cls;
    li.textContent = text;
    probeLines.append(li);
  };
  if (p.history) add(historyLabel(p.history), 'head');
  if (p.explored?.root) {
    const x = p.explored;
    const err = (k, pending) => (x.waiting?.command === k ? `${k}: waiting ${Math.round(x.waiting.ms / 1000)} s for the node’s quota` : x.errors?.[k] ? `${k}: ${x.errors[k]}` : pending);
    add(`explored at #${Number(x.ledgerIndex ?? 0).toLocaleString('en-US')}: ${x.lines == null ? err('account_lines', 'lines…') : `${x.lines}${x.linesMore ? '+' : ''} trust lines, ${x.fundedLines ?? 0} funded`} · ${x.objects == null ? err('account_objects', 'objects…') : `${Object.entries(x.objects).map(([k, v]) => `${v} ${k}`).join(', ') || 'no objects'}${x.objectsMore ? ', more beyond the page' : ''}${x.signerList === true ? ' · a SignerList: guardians' : x.signerList === false ? ' · no SignerList' : ''}`} · ${x.nfts == null ? err('account_nfts', 'NFTs…') : `${x.nfts}${x.nftsMore ? '+' : ''} NFTs (moons)`}`, 'head');
  }
  if (p.catch) {
    const lines = p.lines;
    const headCount = lines.length - p.catch.lit.length;
    lines.forEach((line, i) => add(line, i < headCount ? 'head' : p.catch.lit[i - headCount]?.inStep ? 'step' : ''));
    add(`tiers: proximity, conservation, cadence and the record's connections are calculated; coherence is an observation (a correlation at a lag). Nothing here says who owns what.`, 'fine');
  } else if (p.connections.length) {
    add(`connected in the record: ${p.connections.length} planets, by count: ${p.connections
      .slice(0, 12)
      .map((c) => `${nameOfLit(c.id, c.address)} ${c.count}`)
      .join(', ')}${p.connections.length > 12 ? ', …' : ''}`);
  }
  if (p.shared) {
    add('shared price (limited arbitrage, after Chichilnisky 1993 and 1997; only the nerve, Helly and LP duality are used):', 'head');
    for (const line of p.shared.lines ?? []) add(line, /^loop across/.test(line) ? 'step' : line.startsWith('  ') ? 'fine' : '');
    if (p.shared.ms != null) add(`measured in the worker: ${p.shared.ms} ms, ${p.shared.candidates} candidates, ${p.shared.pools} pool${p.shared.pools === 1 ? '' : 's'}, ${p.shared.requests} requests`, 'fine');
  }
  if (p.presence) add(`next ledger: ${p.presence}`, 'head');
}

// --- the forecast panel (Phase 3B) ------------------------------------------------------------

const forecastEl = $('#forecast');
const forecastLines = $('#forecast-lines');
const forecastStatus = $('#forecast-status');
const forecastTitle = $('#forecast-title');
const forecastBtn = $('#forecast-btn');

function toggleForecast(open = !state.forecastOpen) {
  state.forecastOpen = open;
  forecastBtn?.setAttribute('aria-pressed', String(open));
  if (open) renderForecast();
  else forecastEl.classList.add('hidden');
}

/** The forecast panel: what the record holds, the nowcast (when on), the forecast, the event studies, the research lines; never "will". */
function renderForecast() {
  forecastEl.classList.remove('hidden');
  const f = state.forecast;
  forecastLines.innerHTML = '';
  const add = (text, cls) => {
    const li = document.createElement('li');
    if (cls) li.className = cls;
    li.textContent = text;
    forecastLines.append(li);
  };
  if (!forecastOn) {
    forecastTitle.textContent = 'The forecast';
    forecastStatus.textContent = 'off (?forecast=0)';
    return;
  }
  if (!f) {
    forecastTitle.textContent = 'The forecast';
    forecastStatus.textContent = state.running ? 'waiting for the first finished ledger…' : 'press Start';
    return;
  }
  forecastTitle.textContent = `The forecast · #${Number(f.next).toLocaleString('en-US')}`;
  forecastStatus.textContent = `${f.mode} · ${f.ms.toFixed(1)} ms`;
  add(f.holds, 'fine');
  if (state.nowcast?.lines) for (const [i, line] of state.nowcast.lines.entries()) add(line, i === 0 ? 'head' : line.startsWith('  ') ? 'fine' : '');
  for (const [i, line] of f.lines.entries()) add(line, i === 0 ? 'head' : i === 1 ? 'step' : line.startsWith('  ') ? 'fine' : '');
  for (const line of f.studyLines ?? []) add(line, line.startsWith('  ') ? 'fine' : '');
  for (const line of f.researchLines ?? []) add(line, '');
}
forecastBtn?.addEventListener('click', () => toggleForecast());
$('#forecast-close')?.addEventListener('click', () => toggleForecast(false));
$('#probe-close').addEventListener('click', clearProbe);

/** The clipboard, or a selected textarea when it is refused. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** Copy for AI: what this is, the coverage, the last ledger's events with their hashes, then the catch under its own heading, then how to reply. */
async function copyForAI() {
  const p = state.probe;
  if (!p?.catch) return false;
  const cov = state.last?.coverageLine ?? coverageEl.textContent;
  const lines = [
    'xrpl-sonic universe · the probe’s catch · text for an assistant',
    `generated ${new Date().toISOString()} · ${network} · ${state.renderer} renderer · probe v${p.catch.version}`,
    `coverage: ${cov}`,
    'This is what one page heard from a public node while it listened, never the whole ledger. Hashes and amounts are verbatim.',
    '',
    `## The last ledger’s events (${state.events.length}, ledger #${state.ledger ?? '?'})`,
    ...state.events.slice(0, 200).map((e) => `${describeEvent(e, nameOfId)} · ${e.rule}${e.hash ? ` · ${e.hash}` : ''}`),
    '',
    '## The catch',
    ...p.lines,
    '',
    'tiers: record proximity, flow conservation, cadence and the record’s connections are calculated from the records; coherence is an observation: a correlation at a lag, with its null. Nothing here infers ownership or intent.',
    '',
    `${REPLY_TRAILER_HEAD}example:\n${JSON.stringify([exampleAnnotation(state.events.find((e) => e.hash)?.hash ?? '0'.repeat(64))])}`,
  ];
  const ok = await copyText(lines.join('\n'));
  probeStatus.textContent = ok ? 'copied for AI' : 'the clipboard refused';
  return ok;
}
$('#probe-copy-ai').addEventListener('click', copyForAI);
$('#probe-copy').addEventListener('click', async () => {
  const p = state.probe;
  if (!p?.lines.length) return;
  probeStatus.textContent = (await copyText(p.lines.join('\n'))) ? 'readout copied' : 'the clipboard refused';
});

/** Save this moment, mid-probe: the worker builds the moment from its window with the probed account as the cast; the catch's lines become its notes. */
function saveMoment() {
  const p = state.probe;
  if (!p?.catch) return;
  const nm = names(p.id);
  worker.postMessage({ type: 'moment', seq: p.seq, network, cast: [{ address: p.address, label: nm.source === 'cast' ? nm.name : 'Probed' }], question: `the probe of ${p.address}: what do the catch’s lines show?`, title: `probe · ${nm.name}` });
  probeStatus.textContent = 'saving…';
}
$('#probe-save').addEventListener('click', saveMoment);

async function onMoment(m) {
  const p = state.probe;
  if (!p || m.seq !== p.seq) return;
  if (!m.case) {
    probeStatus.textContent = `not saved: ${m.reason ?? 'no window'}`;
    return;
  }
  let c = m.case;
  const ledger = c.clips?.[0]?.to ?? state.ledger;
  for (const [i, line] of p.lines.entries()) {
    const lit = i >= p.lines.length - p.catch.lit.length ? p.catch.lit[i - (p.lines.length - p.catch.lit.length)] : null;
    const r = addAnnotation(c, { text: line.slice(0, 500), anchor: { ledger }, kind: 'observation', evidence: lit?.evidence ?? [], source: 'xrpl-sonic universe probe', status: 'draft' });
    if (r.case) c = r.case;
  }
  const v = validateCase(c);
  if (!v.case) {
    probeStatus.textContent = `not saved: ${v.errors[0] ?? 'invalid case'}`;
    return;
  }
  c = v.case;
  const blob = new Blob([serializeCase(c)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = caseFilename(c);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  let link = null;
  try {
    link = `${SITE_URL}?network=${encodeURIComponent(network)}${buildHash({ case: await encodeCase(c) })}`;
  } catch {
    link = null;
  }
  const copied = link ? await copyText(link) : false;
  const covered = m.covered && m.covered.ledgers < m.covered.of ? ` · the last ${m.covered.ledgers} of ${m.covered.of} ledgers (the case format’s limit)` : '';
  probeStatus.textContent = `saved ${caseFilename(c)}${covered}${copied ? ' · link copied' : ''}`;
  state.moments.push({ id: c.id, file: caseFilename(c), link, covered: m.covered ?? null });
}

// the switch as stored, the caption once
setUfo(state.ufo.ufo);
if (!state.ufo.captionShown) {
  showCaption(UFO_SENTENCE);
  state.ufo.captionShown = true;
  saveUfoState(state.ufo);
}

// --- the inside viewer's line ------------------------------------------------------------

const hud = $('#fly-hud');
const footerKeys = $('.footer-keys');
const flyKeys = $('#fly-keys');
function updateHud() {
  const f = sky.flyInfo();
  canvas.classList.toggle('flying', f.on);
  if (!f.on) {
    hud.classList.add('hidden');
    footerKeys?.classList.remove('hidden');
    flyKeys?.classList.add('hidden');
    return;
  }
  hud.classList.remove('hidden');
  footerKeys?.classList.add('hidden');
  flyKeys?.classList.remove('hidden');
  const a = state.last?.attrs;
  const near = f.nearest > 0 ? nameOfId(f.nearest) : 'nothing';
  const galaxy = a && f.nearest > 0 && f.nearest <= a.n && a.core[f.nearest] ? nameOfId(a.core[f.nearest]) : null;
  hud.textContent = `flying · speed ×${f.speed.toFixed(f.speed < 1 ? 2 : 1)} · nearest ${near} at ${f.distance.toFixed(2)}${galaxy ? ` · in the galaxy of ${galaxy}` : ' · in the field'}${f.gliding ? ' · diving' : ''} · F leaves`;
}

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
  probe: beginProbe,
  releaseProbe,
  clearProbe,
  explore,
  setUfo,
  copyForAI,
  saveMoment,
  catch: () => state.probe?.catch ?? null,
  probeState: () => state.probe,
  sharedPrice: (id) => worker.postMessage({ type: 'sharedPrice', id, seq: state.probe?.seq ?? ++state.probeSeq }),
  forecast: () => state.forecast,
  nowcast: () => state.nowcast,
  toggleForecast,
  forecastSession: () =>
    new Promise((resolve) => {
      state.sessionWaiters.push(resolve);
      worker.postMessage({ type: 'forecast-session' });
    }),
  fly: { enter: () => sky.enterFly(), leave: () => sky.leaveFly(), dive: (id, opts) => sky.diveTo(id, opts), move: (f, s, u, dt) => sky.flyMove(f, s, u, dt), info: () => sky.flyInfo(), speed: (k) => sky.setFlySpeed(k) },
  worker,
  engine,
};

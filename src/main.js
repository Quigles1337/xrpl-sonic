// xrpl-sonic — application wiring.

import { txToEvent, ledgerToEvent, classifyMessage, involvesAccount, shortAddress } from './mapping.js';
import { XrplStream, NETWORKS } from './ws.js';
import { AudioEngine } from './audio.js';
import { Visualizer } from './visual.js';
import { loadSettings, saveSettings, mappingOptions } from './settings.js';
import { parseHash, buildHash } from './params.js';
import { createUI } from './ui.js';

const settings = loadSettings();
const params = new URLSearchParams(location.search);
if (params.get('network') === 'testnet' || params.get('network') === 'mainnet') settings.network = params.get('network');

// Shareable state lives in the URL hash: #account=r... (and #replay=, see below).
const urlState = parseHash(location.hash);
settings.account = urlState.account ?? '';

const canvas = document.getElementById('scene');
const viz = new Visualizer(canvas);
const engine = new AudioEngine({ volume: settings.volume, muted: settings.muted });

let stream = null;
let running = false;
let options = mappingOptions(settings);

// Ledger timing
const ledgerState = {
  index: null,
  lastCloseAt: 0, // performance.now()
  interval: 4, // EMA of inter-close interval in seconds
  count: 0,
};
const stats = { played: 0, dropped: 0 };
const recentTx = []; // timestamps for the tx/s readout
const pendingTimers = new Set();

const ui = createUI({
  settings,
  onToggleRun: () => (running ? stop() : start()),
  onChange: (patch) => {
    saveSettings(settings);
    options = mappingOptions(settings);
    if ('volume' in patch) engine.setVolume(settings.volume);
    if ('muted' in patch) engine.setMuted(settings.muted);
    if ('network' in patch && stream) {
      resetLedgerState();
      ui.logMessage(`Switching to ${NETWORKS[settings.network].label}…`);
      stream.setEndpoints(NETWORKS[settings.network].endpoints);
    }
    if ('account' in patch) {
      syncHash();
      applyAccount();
    }
    if ('network' in patch || 'explorer' in patch) ui.setAccount(settings.account);
  },
});

function syncHash() {
  const hash = buildHash({ account: settings.account, replay: urlState.replay });
  const url = `${location.pathname}${location.search}${hash}`;
  if (`${location.pathname}${location.search}${location.hash}` !== url) history.replaceState(null, '', url);
}

function applyAccount() {
  ui.setAccount(settings.account);
  if (settings.account) ui.logMessage(`Watching ${shortAddress(settings.account)} — other transactions are ${settings.accountMode === 'hide' ? 'hidden' : 'dimmed and silent'}.`);
  else ui.logMessage('Watching all accounts.');
}

// The hash can change under us (back/forward, a pasted link): follow it.
window.addEventListener('hashchange', () => {
  const next = parseHash(location.hash);
  for (const err of next.errors) ui.logMessage(err, 'error');
  urlState.replay = next.replay;
  const account = next.account ?? '';
  if (account !== settings.account) {
    settings.account = account;
    applyAccount();
  }
});

function resetLedgerState() {
  ledgerState.index = null;
  ledgerState.lastCloseAt = 0;
  ledgerState.interval = 4;
  ui.setLedger(null, null);
}

function schedule(fn, delaySeconds) {
  const id = setTimeout(() => {
    pendingTimers.delete(id);
    fn();
  }, Math.max(0, delaySeconds * 1000));
  pendingTimers.add(id);
}

function clearPending() {
  for (const id of pendingTimers) clearTimeout(id);
  pendingTimers.clear();
}

function onLedger(ev) {
  const now = performance.now();
  if (ledgerState.lastCloseAt) {
    const gap = (now - ledgerState.lastCloseAt) / 1000;
    if (gap > 0.5 && gap < 30) ledgerState.interval = 0.7 * ledgerState.interval + 0.3 * gap;
  }
  ledgerState.lastCloseAt = now;
  ledgerState.index = ev.ledgerIndex;
  ledgerState.count += 1;
  engine.setLedgerInterval(ledgerState.interval);
  if (ev.txnCount) engine.setExpectedCount(ev.txnCount);
  engine.tick(ev);
  viz.ledger(ev);
  ui.setLedger(ev.ledgerIndex, ledgerState.interval);
  ui.log(ev);
  ui.setStats({ played: stats.played, dropped: stats.dropped, ledgers: ledgerState.count });
}

function onTransaction(msg) {
  const ev = txToEvent(msg, options);
  if (!ev) return;
  recentTx.push(performance.now());
  if (settings.account && !involvesAccount(msg, settings.account)) {
    // Account mode: everything that does not touch the watched account is silent — dimmed or gone.
    if (settings.accountMode !== 'hide') schedule(() => viz.spawn(ev, { dim: true }), Math.random() * engine.ledgerInterval * 0.85);
    return;
  }
  const audible = engine.state === 'running' && !settings.muted;
  const delay = audible ? engine.play(ev) : 0;
  if (delay < 0) {
    // Rate-limited: still visible, just quieter, and spread across the ledger interval like the rest.
    stats.dropped += 1;
    schedule(() => viz.spawn(ev, { dim: true }), Math.random() * engine.ledgerInterval * 0.85);
    return;
  }
  if (audible) stats.played += 1;
  schedule(() => {
    viz.spawn(ev);
    ui.log(ev);
  }, delay);
}

function onMessage(msg) {
  switch (classifyMessage(msg)) {
    case 'ledger':
      onLedger(ledgerToEvent(msg));
      break;
    case 'transaction':
      onTransaction(msg);
      break;
    case 'response': {
      const seed = ledgerToEvent(msg);
      if (seed && ledgerState.index == null) {
        ledgerState.index = seed.ledgerIndex;
        ui.setLedger(seed.ledgerIndex, null);
      }
      break;
    }
    case 'error':
      console.warn('[xrpl-sonic] node error', msg);
      ui.logMessage(`Node error: ${msg.error_message ?? msg.error ?? 'unknown'}`, 'error');
      break;
    default:
      break;
  }
}

function onStatus(s) {
  const host = s.endpoint ? s.endpoint.replace(/^wss:\/\//, '') : '';
  switch (s.state) {
    case 'connecting':
      ui.setStatus('connecting', `Connecting to ${host}…`, s.endpoint);
      break;
    case 'connected':
      ui.setStatus('connected', `Live · ${host}`, s.endpoint);
      ui.logMessage(`Connected to ${host}`);
      break;
    case 'reconnecting':
      ui.setStatus('reconnecting', `Reconnecting (${host}) in ${Math.round((s.delayMs ?? 0) / 1000)} s…`, s.endpoint);
      if (s.error) ui.logMessage(`Connection lost: ${s.error}`, 'error');
      break;
    default:
      ui.setStatus('idle', 'Stopped', null);
  }
}

async function start() {
  if (running) return;
  running = true;
  ui.setRunning(true);
  try {
    const state = await engine.start();
    if (state !== 'running') ui.logMessage('Audio is suspended by the browser — tap anywhere to enable sound.', 'error');
  } catch (err) {
    console.warn('[xrpl-sonic] audio unavailable', err);
    ui.logMessage('Web Audio is unavailable in this browser; running visuals only.', 'error');
  }
  viz.start();
  stream = new XrplStream({ endpoints: NETWORKS[settings.network].endpoints, onMessage, onStatus });
  stream.connect();
}

async function stop() {
  if (!running) return;
  running = false;
  stream?.close();
  stream = null;
  clearPending();
  await engine.stop();
  resetLedgerState();
  ui.setRunning(false);
  ui.setStatus('idle', 'Stopped', null);
  ui.setTxRate(0);
  ui.setMetronome(0);
}

// Metronome + tx/s readout, driven from the visualiser's frame loop.
let lastReadout = 0;
viz.onFrame = (ts) => {
  if (ledgerState.lastCloseAt) ui.setMetronome((ts - ledgerState.lastCloseAt) / 1000 / ledgerState.interval);
  if (ts - lastReadout > 500) {
    lastReadout = ts;
    while (recentTx.length && ts - recentTx[0] > 5000) recentTx.shift();
    ui.setTxRate(recentTx.length / 5);
    ui.setStats({ played: stats.played, dropped: stats.dropped, ledgers: ledgerState.count });
  }
};

// Resume a suspended context on the first gesture (autostart / mobile policies).
const resumeOnGesture = () => {
  if (running && engine.ctx && engine.state !== 'running') engine.start().catch(() => {});
};
window.addEventListener('pointerdown', resumeOnGesture, { passive: true });
window.addEventListener('keydown', resumeOnGesture);

// Pause rendering when hidden; the socket stays up so the log keeps flowing.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) viz.stop();
  else if (running) viz.start();
});

// Keyboard: Space toggles, M mutes (when focus is not in a control).
window.addEventListener('keydown', (e) => {
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
  if (e.code === 'Space') {
    e.preventDefault();
    running ? stop() : start();
  } else if (e.key === 'm' || e.key === 'M') {
    settings.muted = !settings.muted;
    saveSettings(settings);
    engine.setMuted(settings.muted);
    ui.applySettings();
  }
});

ui.setStatus('idle', 'Ready', null);
ui.setLedger(null, null);
ui.setAccount(settings.account);
for (const err of urlState.errors) ui.logMessage(err, 'error');
if (settings.account) ui.logMessage(`Watching ${shortAddress(settings.account)} — other transactions are ${settings.accountMode === 'hide' ? 'hidden' : 'dimmed and silent'}.`);
viz.start();

if (params.get('autostart') === '1') start();

// Exposed for debugging and smoke checks in the browser console.
window.xrplSonic = { engine, viz, settings, start, stop, stats, get stream() { return stream; }, get running() { return running; } };

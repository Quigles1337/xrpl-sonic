// xrpl-sonic — application wiring.
//
// Two ways to listen: the live stream (XrplStream → mapping → engine + plate)
// and a case (src/case.js), whose ledgers are fetched over the same socket,
// laid out as a score (src/score.js) and played by the transport
// (src/transport.js) with pause, step, loop and seek.

import { txToEvent, ledgerToEvent, classifyMessage } from './mapping.js';
import { castFor, castGate, decorateEvent, normalizeCast, parseCastSpec, formatCastSpec, motifFor } from './cast.js';
import { XrplStream, NETWORKS } from './ws.js';
import { AudioEngine } from './audio.js';
import { Visualizer } from './visual.js';
import { loadSettings, saveSettings, mappingOptions } from './settings.js';
import { parseHash, buildHash, parseQuery } from './params.js';
import { parseReplayRange, formatReplayRange } from './replay.js';
import { validateCase, caseFromState, serializeCase, encodeCase, decodeCase, caseFilename, caseLedgerCount, addAnnotation, updateAnnotation, removeAnnotation } from './case.js';
import { buildScore, scoreCaption, transcript, formatClock, clipRanges, ledgerAtPosition } from './score.js';
import { Transport } from './transport.js';
import { LiveWindow, momentFromLive, momentFromReplay, momentPosition, isMoment } from './moment.js';
import { describeReport, factsForCase, importAnnotations } from './describe.js';
import { frameFromScore, frameFromLive, coherence, readout as coherenceReadout, describePair, BIN_NAMES, DEFAULTS as COHERENCE_DEFAULTS } from './coherence.js';
import { fieldModel } from './field.js';
import { TOURS, tourById, tourSteps, stepText } from './tours.js';
import { fetchCaseLedgers } from './ledgers.js';
import { speak, hush } from './speech.js';
import { Geiger } from './geiger.js';
import { FEE_COMMAND, SERVER_SUBSCRIBE, parseFee, parseServerStatus, pressureTone, isFresh } from './health.js';
import { scoreToMidi, midiFilename } from './midi.js';
import { MidiOut } from './midi-out.js';
import {
  RECORD_SECONDS,
  captureSupport,
  snapshotLines,
  snapshotFilename,
  recordingFilename,
  composeSnapshot,
  downloadBlob,
  startRecording,
} from './capture.js';
import { createUI } from './ui.js';
import { SITE_URL } from './explorers.js';

const settings = loadSettings();

// Page modes from the query string: ?overlay=1 (transparent, no controls, for OBS browser
// sources), ?embed=1 (compact chrome for an iframe), plus ?network= and ?autostart=1.
const query = parseQuery(location.search);
if (query.network) settings.network = query.network;
document.documentElement.classList.add(`mode-${query.mode}`);
document.body.classList.add(`mode-${query.mode}`);
{
  // "Open full page" (embed mode): the same URL without the embed flag, keeping network and hash.
  const openFull = document.getElementById('open-full');
  if (openFull) {
    const url = new URL(location.href);
    url.searchParams.delete('embed');
    openFull.href = url.toString();
  }
}

// Shareable state lives in the URL hash: #cast=..., #account=r... (the one-member shortcut),
// #replay=<ledger>|<from>-<to>, or #case=<encoded case>.
const urlState = parseHash(location.hash);
applyUrlCast(urlState);

/** A cast in the hash wins over the stored one; #account= is a cast of one that mutes everything else, as it always did. */
function applyUrlCast(state) {
  if (state.cast) {
    const { cast, errors } = parseCastSpec(state.cast);
    state.errors.push(...errors);
    if (cast.length) settings.cast = cast;
  } else if (state.account) {
    settings.cast = normalizeCast([{ address: state.account, label: 'Watched' }]);
    if (settings.castMode === 'all') settings.castMode = 'mute';
  }
}

// The case session: `pending` waits for Start, `active` is playing.
const session = {
  pending: null, // validated case; `source` is 'replay' (from #replay=), 'case' (from #case=) or 'file'
  active: null, // { case, ledgers, score, transport, failures }
  loading: false,
  armed: false, // start() arms it; the next 'connected' status runs it
  speed: 1,
  loop: null,
  abort: null,
  clip: null, // index of the clip being compared, null = whole case
  blind: false,
};

const canvas = document.getElementById('scene');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const viz = new Visualizer(canvas, { transparent: query.mode === 'overlay', reduced: reducedMotion.matches });
viz.setExposure(settings.exposure);
reducedMotion.addEventListener?.('change', (e) => viz.setReduced(e.matches));
const engine = new AudioEngine({ volume: settings.volume, muted: settings.muted });
const midiOut = new MidiOut();

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
const live = new LiveWindow(); // the last validated ledgers heard live, for "Save this moment" (src/moment.js)
const field = { bin: COHERENCE_DEFAULTS.bin, model: null, lastSummary: '', lastLive: 0 }; // the interference field's bin (a per-case choice), model and bookkeeping (src/field.js)
const recentTx = []; // timestamps for the tx/s readout
const lastMinute = []; // timestamps for the snapshot overlay (60 s window)
const capture = captureSupport(globalThis);
let recording = null; // { done, stop } while a recording runs
const pendingTimers = new Set();

const ui = createUI({
  settings,
  onToggleRun: () => (running ? stop() : start()),
  onShare: () => share(),
  onMoment: (question) => saveMoment(question),
  onAi: () => openAi(),
  onCopyAi: (level) => copyAi(level),
  onSnapshot: () => snapshot().catch((err) => ui.logMessage(`Snapshot failed: ${err?.message ?? err}`, 'error')),
  onRecord: () => record().catch((err) => ui.logMessage(`Recording failed: ${err?.message ?? err}`, 'error')),
  onPreview: (member) => preview(member),
  onInspect: (event) => inspect(event),
  capture,
  transport: {
    onToggle: () => transportToggle(),
    onStep: () => activeTransport()?.step(),
    onBack: () => activeTransport()?.stepBack(),
    onLoopToggle: () => loopToggle(),
    onLoopIn: () => loopPoint('in'),
    onLoopOut: () => loopPoint('out'),
    onSeek: (ms) => activeTransport()?.seek(ms),
    onSpeed: (speed) => setSpeed(speed),
    onCancel: () => goLive(),
    onClip: (i) => playClip(i),
    onClipAll: () => playClip(null),
  },
  caseActions: {
    onLoadFile: (file) => loadCaseFile(file),
    onSave: () => saveCase(),
    onCopyLink: () => copyCaseLink(),
    onTranscript: () => showTranscript(),
    onLoadSample: () => loadSample(),
    onAi: () => openAi(),
    onImport: (text, source) => importNotes(text, source),
    onCoherence: () => showCoherence(),
    onToggle: (key, value) => {
      settings[key] = value;
      saveSettings(settings);
      if (key === 'pauseAtNotes') {
        const t = activeTransport();
        if (t) t.honourPauses = value;
      }
      if (key === 'speak' && !value) hush();
    },
    onAddNote: () => addNoteHere(),
    onEditNote: (id, patch) => editNote(id, patch),
    onRemoveNote: (id) => removeNote(id),
    onJumpNote: (id) => jumpToNote(id),
    onBlind: (on) => setBlind(on),
  },
  inspector: {
    onPrev: (item) => inspectNeighbour(item, -1),
    onNext: (item) => inspectNeighbour(item, +1),
    onAnnotate: (event, item) => annotateEvent(event, item),
  },
  onView: (view) => setView(view, { fromUi: true }),
  onDoor: (view) => enterDoor(view),
  learnActions: {
    onRun: (id) => runTour(id),
    onNext: () => tourMove(+1),
    onBack: () => tourMove(-1),
    onExit: () => exitTour(),
  },
  fieldActions: {
    // the bin is a per-case choice, not a setting: it starts at the ledger and is printed on every line and on the picture
    binNow: () => field.bin,
    onChange: (patch) => {
      if ('bin' in patch && BIN_NAMES.includes(patch.bin)) {
        field.bin = patch.bin;
        if (field.bin !== 'ledger') ui.logMessage(`Coherence reads the series per ${field.bin} now; the live window stays per ledger unless this is changed back.`);
      }
      refreshField({ announce: true });
    },
  },
  midiActions: {
    onSave: () => saveMidi(),
    onConnect: () => connectMidi(),
    onSelect: (id) => selectMidi(id),
  },
  healthActions: {
    onChange: (patch) => {
      settings.health = { ...settings.health, ...patch };
      saveSettings(settings);
      if ('poll' in patch) {
        if (patch.poll) pollFee();
        else health.fee = null;
      }
      if ('sound' in patch && !patch.sound) engine.setDrone(null);
      applyDrone();
      renderHealth();
    },
  },
  geigerActions: {
    onChange: (patch) => {
      settings.geiger = { ...settings.geiger, ...patch };
      saveSettings(settings);
      if ('enabled' in patch) {
        if (patch.enabled) startGeiger();
        else stopGeiger();
      } else if (geiger.detector) {
        startGeiger(); // new window/threshold/minCount/adapt: a fresh detector (a pinned baseline is kept)
      }
      renderGeiger();
    },
    onPin: () => {
      if (!geiger.detector) return;
      geiger.baseline = geiger.detector.pin();
      ui.logMessage(`Geiger baseline pinned at ledger ${fmt(geiger.detector.lastLedger)} over ${geiger.baseline.window} ledgers.`);
      if (session.active || session.pending) commitCase({ ...(session.active?.case ?? session.pending), geiger: { ...settings.geiger, baseline: geiger.baseline } });
      renderGeiger();
    },
    onUnpin: () => {
      geiger.baseline = null;
      geiger.detector?.unpin();
      ui.logMessage('Geiger baseline unpinned: it rolls again.');
      if (session.active || session.pending) commitCase({ ...(session.active?.case ?? session.pending), geiger: { ...settings.geiger } });
      renderGeiger();
    },
  },
  onChange: (patch) => {
    saveSettings(settings);
    options = mappingOptions(settings);
    if ('volume' in patch) engine.setVolume(settings.volume);
    if ('muted' in patch) engine.setMuted(settings.muted);
    if ('network' in patch && stream) {
      resetLedgerState();
      live.reset();
      ui.logMessage(`Switching to ${NETWORKS[settings.network].label}…`);
      if (session.active) endSession();
      stream.setEndpoints(NETWORKS[settings.network].endpoints);
    }
    if ('cast' in patch || 'castMode' in patch) {
      syncHash();
      applyCast();
      geiger.detector?.setCast(settings.cast);
    }
    if ('exposure' in patch) viz.setExposure(settings.exposure);
    if ('field' in patch || 'cast' in patch) refreshField({ announce: 'field' in patch });
    if ('network' in patch || 'explorer' in patch) ui.setCast(settings.cast);
    if (session.active && ['scale', 'key', 'enabled', 'includeFailed', 'quietMode', 'quietThreshold', 'cast', 'castMode'].some((k) => k in patch)) rebuildScore();
  },
});

// ---------------------------------------------------------------------------
// The three modes and the tours (docs/ux.md, PR 2)
// ---------------------------------------------------------------------------

/** The mode in force: Listen, Watch or Learn; remembered with the settings. A case or a replay opens in Watch. */
function setView(view, { fromUi = false } = {}) {
  if (settings.view === view && fromUi) return;
  settings.view = view;
  saveSettings(settings);
  if (!fromUi) ui.setView(view, { announce: false });
  if (view !== 'learn' && tour.steps) exitTour({ quiet: true });
}

/** A door on the welcome overlay: Listen and Watch start the stream in that mode; Learn opens the tours. */
function enterDoor(view) {
  setView(view);
  if (view === 'learn') {
    ui.setRunning(running);
    document.querySelector('#overlay')?.classList.add('hidden');
    document.querySelector('#learn [data-run]')?.focus();
    return;
  }
  if (!running) start();
}

const tour = { id: null, steps: null, index: 0, ctx: {}, item: null };

async function fetchCase(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

/** Wait until the pending case plays (its ledgers fetched and its score built), or give up after a while. */
function whenActive(timeoutMs = 90000) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      ui.learn.setBusy(session.loading ? document.querySelector('#t-label')?.textContent : 'Loading the case…');
      if (session.active) resolve(true);
      else if (performance.now() - t0 > timeoutMs) resolve(false);
      else setTimeout(tick, 200);
    };
    tick();
  });
}

/** Do a step's action through what exists: a shipped case, the transport, the inspector, the coherence drawer, the field. */
async function tourAct(step) {
  const a = step.action ?? { kind: 'none' };
  const t = activeTransport();
  switch (a.kind) {
    case 'case': {
      const current = session.active?.case ?? session.pending;
      if (!current || !String(current.id).startsWith(a.url.includes('cadence') ? 'cadence' : 'busiest')) {
        openCase(await fetchCase(a.url), 'file', 'the tour');
      }
      if (!running) await start();
      const ok = await whenActive();
      if (ok) {
        const s = session.active;
        tour.ctx.firstNote = s.case.annotations.find((n) => n.anchor?.ledger != null)?.text ?? null;
        tour.ctx.caseDescription = s.case.description || s.case.title || null;
        tour.ctx.accountsLine = null;
      }
      break;
    }
    case 'seek':
      t?.seek(a.ms ?? 0);
      t?.pause();
      break;
    case 'seekEvent': {
      const s = session.active;
      const item = s?.score.events.find((e) => e.event?.category === a.category) ?? null;
      tour.item = item;
      tour.ctx.caption = item ? scoreCaption(item, s.case.cast) : null;
      if (item && t) {
        t.seek(item.timeMs);
        t.pause();
      }
      break;
    }
    case 'inspect':
      if (tour.item) inspect(tour.item.event, tour.item);
      break;
    case 'play':
      ui.inspector.hide();
      t?.play();
      break;
    case 'coherence': {
      const report = showCoherence();
      tour.ctx.accountsLine = report?.accounts?.map((x) => `${x.label} = ${x.address} (${x.events} events${x.cadence ? `, cadence ${x.cadence.period} ledgers (self-correlation ${x.cadence.r.toFixed(2)})` : ''})`).join('; ') ?? null;
      break;
    }
    case 'field':
      ui.drawer.hide();
      settings.field = { mode: 'cast', pair: null };
      saveSettings(settings);
      ui.applySettings();
      refreshField({ announce: true });
      break;
    case 'end':
      ui.drawer.hide();
      break;
    default:
      break;
  }
}

async function tourGo(index) {
  const steps = tour.steps;
  if (!steps || index < 0 || index >= steps.length) return;
  const def = tourById(tour.id);
  const step = steps[index];
  tour.index = index;
  ui.learn.showStep({ tour: def, index, total: steps.length, text: 'Loading…', glyph: step.glyph ?? null, busy: true, first: index === 0, last: index === steps.length - 1 });
  try {
    await tourAct(step);
  } catch (err) {
    ui.logMessage(`The tour could not take its step: ${err?.message ?? err}`, 'error');
  }
  const text = stepText(step, tour.ctx);
  ui.learn.showStep({ tour: def, index, total: steps.length, text, glyph: step.glyph ?? null, first: index === 0, last: index === steps.length - 1 });
  ui.transport.caption({ kind: 'info', text, sticky: true });
}

function runTour(id) {
  if (!tourById(id)) return;
  tour.id = id;
  tour.steps = tourSteps(id);
  tour.ctx = {};
  tour.item = null;
  if (settings.view !== 'learn') setView('learn');
  tourGo(0);
}

function tourMove(delta) {
  if (!tour.steps) return;
  const next = tour.index + delta;
  if (next >= tour.steps.length) exitTour();
  else tourGo(next);
}

function exitTour({ quiet = false } = {}) {
  const was = tour.id;
  tour.id = null;
  tour.steps = null;
  tour.index = 0;
  ui.learn.clear();
  ui.transport.caption(null);
  if (was && !quiet) ui.logMessage(`Tour ended: ${tourById(was)?.name ?? was}.`);
}

// ---------------------------------------------------------------------------
// URL and cast
// ---------------------------------------------------------------------------

let hashJob = 0;
function syncHash() {
  const c = session.active?.case ?? session.pending;
  if (c && c.source !== 'replay') {
    // A loaded case travels whole: #case=<encoded>, recomputed from the current settings.
    const job = ++hashJob;
    encodeCase(currentCase()).then((encoded) => {
      if (job !== hashJob) return;
      replaceHash(buildHash({ case: encoded }));
    });
    return;
  }
  replaceHash(buildHash({ cast: settings.cast.length ? formatCastSpec(settings.cast) : '', replay: urlState.replay }));
}

function replaceHash(hash) {
  // Once the hash carries the case, the ?case= query that loaded it is redundant.
  const search = hash.startsWith('#case=') && query.caseUrl ? location.search.replace(/[?&]case=[^&]*/, '').replace(/^&/, '?') : location.search;
  const url = `${location.pathname}${search}${hash}`;
  if (`${location.pathname}${location.search}${location.hash}` !== url) history.replaceState(null, '', url);
}

const CAST_MODE_TEXT = { all: 'everything else plays in its category voice', mute: 'everything else is dimmed and silent', hide: 'everything else is hidden' };

function castSummary() {
  if (!settings.cast.length) return 'No cast — playing everything.';
  const names = settings.cast.map((m) => `${m.label} (${m.voice}${m.solo ? ', solo' : ''}${m.muted ? ', muted' : ''})`).join(', ');
  return `Cast: ${names}; ${CAST_MODE_TEXT[settings.castMode] ?? CAST_MODE_TEXT.all}.`;
}

function applyCast() {
  ui.setCast(settings.cast);
  ui.logMessage(castSummary());
}

/** Play a cast member's motif in its voice and position. Runs from a click, so the audio context can start here. */
async function preview(member) {
  try {
    const state = await engine.start();
    if (state !== 'running') {
      ui.logMessage('Audio is suspended by the browser — tap anywhere, then try the preview again.', 'error');
      return;
    }
    engine.preview(member, motifFor(member.address, settings.scale, settings.key));
  } catch (err) {
    ui.logMessage(`Preview failed: ${err?.message ?? err}`, 'error');
  }
}

// The hash can change under us (back/forward, a pasted link): follow it.
window.addEventListener('hashchange', () => {
  const next = parseHash(location.hash);
  urlState.replay = next.replay;
  const before = formatCastSpec(settings.cast);
  if (next.cast || next.account) {
    settings.cast = [];
    applyUrlCast(next);
  }
  for (const err of next.errors) ui.logMessage(err, 'error');
  if (formatCastSpec(settings.cast) !== before) {
    saveSettings(settings);
    applyCast();
  }
  if (next.case) decodeCase(next.case).then((raw) => openCase(raw, 'case', 'the link')).catch((err) => ui.logMessage(`Could not read the case in the link: ${err?.message ?? err}`, 'error'));
  else if (next.replay && !session.active) armReplayFromUrl(next.replay);
});

function resetLedgerState() {
  ledgerState.index = null;
  ledgerState.lastCloseAt = 0;
  ledgerState.interval = 4;
  ui.setLedger(null, null);
}

/** Run `fn` after `delaySeconds`; immediately (synchronously) when the delay is zero. */
function schedule(fn, delaySeconds) {
  if (!(delaySeconds > 0)) {
    fn();
    return;
  }
  const id = setTimeout(() => {
    pendingTimers.delete(id);
    fn();
  }, delaySeconds * 1000);
  pendingTimers.add(id);
}

function clearPending() {
  for (const id of pendingTimers) clearTimeout(id);
  pendingTimers.clear();
}

function onLedger(ev, intervalSeconds) {
  const now = performance.now();
  if (intervalSeconds) {
    ledgerState.interval = intervalSeconds; // replay: the real close interval, already divided by speed
  } else if (ledgerState.lastCloseAt) {
    const gap = (now - ledgerState.lastCloseAt) / 1000;
    if (gap > 0.5 && gap < 30) ledgerState.interval = 0.7 * ledgerState.interval + 0.3 * gap;
  }
  ledgerState.lastCloseAt = now;
  ledgerState.index = ev.ledgerIndex;
  ledgerState.count += 1;
  engine.setLedgerInterval(ledgerState.interval);
  if (ev.txnCount) engine.setExpectedCount(ev.txnCount);
  engine.tick(ev);
  if (midiOut.active) midiOut.pulse(0);
  viz.ledger(ev);
  ui.setLedger(ev.ledgerIndex, ledgerState.interval);
  ui.log(ev);
  ui.setStats({ played: stats.played, dropped: stats.dropped, ledgers: ledgerState.count });
}

/** Who in the cast a transaction involves, and whether it plays, dims or is skipped (src/cast.js). */
function gateFor(msg) {
  const involvement = castFor(msg, settings.cast);
  return { gate: castGate(involvement, settings.cast, settings.castMode), involvement };
}

// ---------------------------------------------------------------------------
// MIDI: the score as a file, and live output
// ---------------------------------------------------------------------------

function saveMidi() {
  const s = session.active;
  if (!s) return;
  const bytes = scoreToMidi(s.score, s.case);
  const name = midiFilename(s.case, s.score);
  downloadBlob(new Blob([bytes], { type: 'audio/midi' }), name);
  ui.logMessage(`Saved ${name} (${Math.round(bytes.length / 1024)} kB, ${s.score.counts.played} notes plus the ledger pulse).`);
}

async function connectMidi() {
  try {
    const list = await midiOut.connect();
    midiOut.onChange = (outputs) => {
      ui.midiPanel.setOutputs(outputs, midiOut.output?.id ?? '');
      if (midiOut.output && !outputs.some((o) => o.id === midiOut.output.id)) {
        midiOut.select(null);
        ui.logMessage('MIDI output disconnected.', 'error');
      }
    };
    const preferred = list.find((o) => o.name === settings.midiOutput);
    if (preferred) selectMidi(preferred.id, { quiet: true });
    ui.midiPanel.setOutputs(list, midiOut.output?.id ?? '');
    ui.logMessage(list.length ? `MIDI: ${list.length} output${list.length === 1 ? '' : 's'} available${preferred ? `, sending to ${preferred.name}` : ''}.` : 'MIDI: no outputs found.');
  } catch (err) {
    ui.logMessage(`MIDI: ${err?.message ?? err}`, 'error');
    ui.midiPanel.setStatus(`Could not connect: ${err?.message ?? err}`);
  }
}

function selectMidi(id, { quiet = false } = {}) {
  const chosen = midiOut.select(id);
  settings.midiOutput = chosen?.name ?? '';
  saveSettings(settings);
  if (!quiet) ui.logMessage(chosen ? `MIDI: sending to ${chosen.name}.` : 'MIDI: live output off.');
  ui.midiPanel.setOutputs(midiOut.outputs(), chosen?.id ?? '');
}

// ---------------------------------------------------------------------------
// Observed fee pressure: the connected node's open-ledger fee and queue
// ---------------------------------------------------------------------------

const health = {
  fee: null, // parsed `fee` result
  load: null, // parsed serverStatus
  at: 0, // performance.now() of the last fee sample
  host: '',
  serverStream: 'unknown', // 'unknown' | 'subscribed' | 'unsupported'
  inFlight: false,
};

function healthView() {
  return { ...health, ageMs: health.fee ? performance.now() - health.at : null, live: running && !session.active && !session.loading };
}

function renderHealth() {
  ui.healthPanel.render(healthView());
}

/** One `fee` request to the connected node; the sample carries its host and its age. */
async function pollFee() {
  if (!settings.health.poll || !stream || stream.state !== 'connected' || health.inFlight || session.active || session.loading) return;
  health.inFlight = true;
  try {
    const res = await stream.request(FEE_COMMAND, { timeoutMs: 8000 });
    const fee = parseFee(res);
    if (fee) {
      health.fee = fee;
      health.at = performance.now();
      health.host = stream.endpoint ? stream.endpoint.replace(/^wss:\/\//, '') : '';
    }
  } catch (err) {
    ui.logMessage(`Fee pressure: the node did not answer (${err?.message ?? err}).`, 'error');
  } finally {
    health.inFlight = false;
  }
  if (health.serverStream === 'unknown') subscribeServer();
  applyDrone();
  renderHealth();
}

/** Try the `server` stream once per connection; Clio does not offer it, and that is reported, not retried. */
async function subscribeServer() {
  if (!stream || health.serverStream !== 'unknown') return;
  health.serverStream = 'pending';
  try {
    await stream.request(SERVER_SUBSCRIBE, { timeoutMs: 8000 });
    health.serverStream = 'subscribed';
  } catch {
    health.serverStream = 'unsupported';
  }
  renderHealth();
}

function applyDrone() {
  if (!settings.health.sound || !settings.health.poll || !health.fee || !isFresh(performance.now() - health.at) || session.active) {
    engine.setDrone(null);
    return;
  }
  engine.setDrone(pressureTone(health.fee.pressure));
}

// ---------------------------------------------------------------------------
// Geiger: the detector, fed raw ledgers before any filter or rate limit
// ---------------------------------------------------------------------------

const geiger = {
  detector: null,
  baseline: null, // a pinned snapshot, kept across detector restarts and saved with the case
  pending: new Map(), // live: ledger index → raw transaction messages, finalised when the next ledger closes
  current: null, // live: the ledger index whose transactions are streaming in
};

function startGeiger() {
  geiger.detector = new Geiger({ ...settings.geiger, cast: settings.cast, baseline: geiger.baseline });
  geiger.pending.clear();
  geiger.current = null;
  ui.logMessage(geiger.baseline ? `Geiger on with a pinned baseline (${geiger.baseline.window} ledgers).` : `Geiger on: the baseline forms over the next ${settings.geiger.window} ledgers.`);
}

function stopGeiger() {
  geiger.detector = null;
  geiger.pending.clear();
  geiger.current = null;
}

function renderGeiger() {
  ui.geigerPanel.render(geiger.detector, geiger.detector ? geiger.detector.status(Date.now()) : null);
}

/** One validated ledger's raw transactions go to the detector; a crossing crackles and is logged with its explanation. */
function observeLedger(ledgerIndex, transactions) {
  const d = geiger.detector;
  if (!d) return;
  const r = d.observeLedger({ ledgerIndex, transactions, nowMs: Date.now() });
  if (r.state === 'crossing') {
    const top = r.crossings[0];
    if (engine.state === 'running' && !settings.muted) engine.crackle(top.z, { threshold: settings.geiger.threshold });
    ui.logMessage(`Geiger ${top.z.toFixed(1)}σ: ${top.explanation}`, 'geiger');
    if (settings.captions && !session.blind) ui.transport.caption({ kind: 'geiger', text: top.explanation });
    if (settings.speak && !session.blind) speak(`Geiger: ${top.explanation}`);
  }
  renderGeiger();
}

/** Live: transactions arrive after their ledger's close; ledger N is finalised when ledger N+1 closes. */
function geigerLiveLedger(ledgerIndex) {
  if (!geiger.detector) return;
  const previous = geiger.current;
  if (previous != null && previous !== ledgerIndex) {
    observeLedger(previous, geiger.pending.get(previous) ?? []);
    geiger.pending.delete(previous);
  }
  geiger.current = ledgerIndex;
  if (!geiger.pending.has(ledgerIndex)) geiger.pending.set(ledgerIndex, []);
  // Drop anything older than two ledgers, in case a close was missed.
  for (const k of geiger.pending.keys()) if (k < ledgerIndex - 1) geiger.pending.delete(k);
}

function geigerLiveTransaction(msg) {
  if (!geiger.detector) return;
  const index = Number(msg.ledger_index ?? msg.tx_json?.ledger_index ?? msg.transaction?.ledger_index);
  const key = Number.isFinite(index) ? index : geiger.current;
  if (key == null) return;
  if (!geiger.pending.has(key)) geiger.pending.set(key, []);
  geiger.pending.get(key).push(msg);
}

// ---------------------------------------------------------------------------
// Live stream
// ---------------------------------------------------------------------------

function onTransaction(msg) {
  const ev = txToEvent(msg, options);
  if (!ev) return;
  recentTx.push(performance.now());
  lastMinute.push(performance.now());
  const { gate, involvement } = gateFor(msg);
  decorateEvent(ev, involvement);
  if (gate !== 'play') {
    // Everything outside the cast (or muted within it) is silent — dimmed or gone.
    if (gate === 'dim') schedule(() => viz.spawn(ev, { dim: true }), Math.random() * engine.ledgerInterval * 0.85);
    return;
  }
  const audible = engine.state === 'running' && !settings.muted;
  const delay = audible ? engine.play(ev) : 0;
  if (delay < 0) {
    // Rate-limited: still visible and still on the tape, just quieter, spread across the ledger interval like the rest.
    stats.dropped += 1;
    schedule(() => {
      viz.spawn(ev, { dim: true });
      ui.log(ev, { dim: true });
    }, Math.random() * engine.ledgerInterval * 0.85);
    return;
  }
  if (audible) stats.played += 1;
  if (midiOut.active) midiOut.play({ event: ev, primary: ev.primary ?? null, gate: 'play' }, delay);
  schedule(() => {
    viz.spawn(ev);
    ui.log(ev);
  }, delay);
}

function onMessage(msg) {
  if (msg?.type === 'serverStatus') {
    health.load = parseServerStatus(msg);
    renderHealth();
    return;
  }
  switch (classifyMessage(msg)) {
    case 'ledger':
      if (session.active || session.loading) break; // the live stream is paused while a case plays
      live.noteLedger(msg);
      geigerLiveLedger(Number(msg.ledger_index));
      onLedger(ledgerToEvent(msg));
      pollFee();
      if (settings.field?.mode !== 'off' && ++field.lastLive % 5 === 0) refreshField();
      break;
    case 'transaction':
      if (session.active || session.loading) break;
      live.noteTransaction(msg);
      geigerLiveTransaction(msg);
      onTransaction(msg);
      break;
    case 'response': {
      const seed = ledgerToEvent(msg);
      if (seed && ledgerState.index == null && !session.active) {
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
      ui.setStatus('connected', session.active ? caseStatusText() : `Live · ${host}`, s.endpoint);
      ui.logMessage(`Connected to ${host}`);
      health.serverStream = 'unknown';
      health.load = null;
      pollFee();
      if (session.armed && session.pending) {
        session.armed = false;
        runCase(session.pending);
      }
      break;
    case 'subscribed':
      ui.setNode(s.hostid ? `${host} (${s.hostid})` : host); // the node's own name, from the subscribe result
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
  session.armed = Boolean(session.pending);
  stream = new XrplStream({ endpoints: NETWORKS[settings.network].endpoints, onMessage, onStatus });
  stream.connect();
}

async function stop() {
  if (!running) return;
  running = false;
  session.armed = false;
  endSession({ quiet: true });
  stream?.close();
  stream = null;
  clearPending();
  engine.setDrone(null);
  health.fee = null;
  health.load = null;
  renderHealth();
  await engine.stop();
  resetLedgerState();
  ui.setRunning(false);
  ui.setStatus('idle', 'Stopped', null);
  ui.setTxRate(0);
  ui.setMetronome(0);
}

// ---------------------------------------------------------------------------
// Cases and the transport
// ---------------------------------------------------------------------------

const fmt = (n) => `#${Number(n).toLocaleString('en-US')}`;

function caseTitle(c) {
  if (!c) return 'Replay';
  if (c.title) return c.title;
  if (c.clips.length === 1) {
    const clip = c.clips[0];
    return clip.from === clip.to ? `Ledger ${fmt(clip.from)}` : `Ledgers ${fmt(clip.from)}–${fmt(clip.to)}`;
  }
  return `${c.clips.length} clips, ${caseLedgerCount(c)} ledgers`;
}

function caseStatusText() {
  const t = session.active?.transport;
  const state = t ? (t.state === 'playing' ? 'Playing' : t.state === 'paused' ? 'Paused' : t.state === 'ended' ? 'Ended' : 'Replay') : 'Loading';
  return `${state} · ${caseTitle(session.active?.case ?? session.pending)}`;
}

function activeTransport() {
  return session.active?.transport ?? null;
}

/** A #replay= range becomes a one-clip case from the current settings. */
function armReplayFromUrl(spec) {
  const range = parseReplayRange(spec);
  if (!range) {
    ui.logMessage(`Ignoring invalid replay range in URL: ${String(spec).slice(0, 24)}`, 'error');
    return;
  }
  const c = caseFromState({ network: settings.network, replay: range, cast: settings.cast, settings });
  c.source = 'replay';
  session.pending = c;
  session.speed = 1;
  ui.setReplayPending(c, caseTitle(c));
  setView('watch'); // a replay link opens in Watch, where the case is in view
  if (range.clamped) ui.logMessage('Replay ranges are capped at 50 ledgers.', 'error');
}

/** Validate a raw case object and make it the pending (or playing) case. */
function openCase(raw, source, sourceText) {
  const { case: c, errors, warnings } = validateCase(raw);
  for (const e of errors) ui.logMessage(`Case: ${e}`, 'error');
  for (const w of warnings) ui.logMessage(`Case: ${w}`, 'error');
  if (!c) {
    ui.logMessage(`The case from ${sourceText} cannot be played.`, 'error');
    return false;
  }
  c.source = source;
  if (session.active || session.loading) endSession({ quiet: true }); // before anything reads session.active
  applyCaseToSettings(c);
  session.pending = c;
  session.speed = c.timing.speed;
  urlState.replay = null;
  ui.setReplayPending(c, caseTitle(c));
  if (sourceText !== 'the tour') setView('watch'); // a case opens in Watch, where it is in view; a tour keeps Learn
  ui.casePanel.setCase(c, null, warnings);
  syncHash();
  if (running && stream) {
    runCase(c);
  } else {
    ui.logMessage(`Loaded ${caseTitle(c)} — press Start to play it.`);
  }
  return true;
}

/** The case defines what plays: its cast, filters and mapping become the live settings. */
function applyCaseToSettings(c) {
  settings.cast = normalizeCast(c.cast);
  settings.castMode = c.filters.castMode;
  settings.enabled = { ...c.filters.enabled };
  settings.includeFailed = c.filters.includeFailed;
  settings.quietMode = c.filters.quietThreshold > 0;
  if (c.filters.quietThreshold > 0) settings.quietThreshold = c.filters.quietThreshold;
  settings.scale = c.mapping.scale;
  settings.key = c.mapping.key;
  if (c.geiger) {
    settings.geiger = { enabled: c.geiger.enabled, window: c.geiger.window, threshold: c.geiger.threshold, minCount: c.geiger.minCount, adapt: c.geiger.adapt };
    geiger.baseline = c.geiger.baseline ?? null;
    if (settings.geiger.enabled) startGeiger();
    else stopGeiger();
  }
  saveSettings(settings);
  options = mappingOptions(settings);
  ui.applySettings();
  ui.setCast(settings.cast);
  renderGeiger();
}

/** The case as it stands now: the loaded one with the current settings folded in. */
function currentCase() {
  const base = session.active?.case ?? session.pending;
  if (!base) return null;
  return {
    ...base,
    cast: normalizeCast(settings.cast),
    filters: {
      enabled: { ...settings.enabled },
      includeFailed: settings.includeFailed,
      quietThreshold: settings.quietMode ? settings.quietThreshold : 0,
      castMode: settings.castMode,
    },
    mapping: { ...base.mapping, scale: settings.scale, key: settings.key },
    timing: { speed: session.speed },
    geiger: settings.geiger.enabled || base.geiger ? { ...settings.geiger, ...(geiger.baseline ? { baseline: geiger.baseline } : {}) } : null,
  };
}

async function runCase(theCase) {
  if (!stream) return;
  if (theCase.network !== settings.network) {
    settings.network = theCase.network;
    saveSettings(settings);
    ui.applySettings();
    resetLedgerState();
    ui.logMessage(`Switching to ${NETWORKS[settings.network].label} for this case…`);
    session.pending = theCase;
    session.armed = true;
    stream.setEndpoints(NETWORKS[settings.network].endpoints);
    return;
  }
  session.loading = true;
  session.abort = { aborted: false };
  const abort = session.abort;
  resetLedgerState();
  ui.transport.setActive(true, caseTitle(theCase));
  ui.transport.setLoading(0, caseLedgerCount(theCase));
  ui.transport.setSpeed(session.speed);
  ui.setStatus('connected', `Loading · ${caseTitle(theCase)}`, undefined);
  ui.casePanel.setCase(theCase, null);
  ui.casePanel.setBusy(true);
  ui.logMessage(`Loading ${caseLedgerCount(theCase)} ledgers for ${caseTitle(theCase)}…`);
  let result;
  try {
    result = await fetchCaseLedgers((cmd) => stream.request(cmd), theCase, { onProgress: (d, t) => ui.transport.setLoading(d, t), signal: abort });
  } catch (err) {
    ui.casePanel.setBusy(false);
    session.loading = false;
    if (!abort.aborted) {
      ui.logMessage(`Could not load the case: ${err?.message ?? err}`, 'error');
      endSession();
    }
    return;
  }
  ui.casePanel.setBusy(false);
  session.loading = false;
  if (abort.aborted) return;
  const score = buildScore(theCase, result.ledgers);
  const transport = new Transport(score, {
    onEvent: onScoreEvent,
    onLedger: onScoreLedger,
    onGap: onScoreGap,
    onAnnotation: onScoreAnnotation,
    onState: onTransportState,
    onProgress: (ms) => ui.transport.setPosition(ms),
    onEnd: onScoreEnd,
    honourPauses: settings.pauseAtNotes,
  });
  transport.setSpeed(session.speed);
  if (geiger.detector) startGeiger(); // replayed ledgers form (or are judged against) their own baseline
  session.active = { case: theCase, ledgers: result.ledgers, score, transport, failures: result.failures };
  session.loop = null;
  ui.setMomentNote(isMoment(theCase) ? theCase.annotations.find((n) => n.question)?.text ?? '' : '');
  ui.transport.setScore(score, caseTitle(theCase));
  ui.transport.setLoop(null);
  ui.midiPanel.setScoreAvailable(true);
  ui.casePanel.setCase(theCase, score, result.failures.length ? [`${result.failures.length} ledger${result.failures.length === 1 ? '' : 's'} could not be fetched: ${result.failures.map((f) => `${fmt(f.index)} (${f.error})`).join(', ')}`] : []);
  for (const f of result.failures) ui.logMessage(`Ledger ${fmt(f.index)} could not be fetched: ${f.error}`, 'error');
  for (const w of score.warnings) ui.logMessage(w, 'error');
  ui.logMessage(`${caseTitle(theCase)}: ${score.counts.events} events over ${formatClock(score.totalMs)} at ${session.speed}× — K pauses, . steps, L loops, click a line or a track to inspect it.`);
  // A saved moment: the loop restored, the transport at the anchor, the question shown there.
  const placed = isMoment(theCase) ? momentPosition(theCase, score) : null;
  if (placed) {
    if (placed.loop) {
      session.loop = placed.loop;
      transport.setLoop(placed.loop);
      ui.transport.setLoop(placed.loop);
    }
    transport.seek(placed.timeMs);
    ui.logMessage(momentSummary(theCase, placed));
    if (placed.annotation && !session.blind) ui.transport.caption({ kind: 'annotation', text: placed.annotation.text, source: placed.annotation.source, status: placed.annotation.status, sticky: true });
  }
  transport.play();
  ui.setStatus('connected', caseStatusText(), undefined);
  applyDrone();
  renderHealth();
  refreshField();
}

/** Settings changed while a case plays: rebuild the score from the cached ledgers, keeping the position. */
function rebuildScore() {
  const s = session.active;
  if (!s) return;
  s.case = currentCase();
  s.case.source = s.case.source ?? 'case';
  s.score = buildScore(s.case, s.ledgers);
  s.transport.setScore(s.score);
  ui.transport.setScore(s.score, caseTitle(s.case));
  ui.casePanel.setCase(s.case, s.score);
  refreshField();
  syncHash();
}

function onScoreEvent(item, offsetSec) {
  const ev = item.event;
  ev.scoreItem = item;
  if (item.gate === 'dim') {
    schedule(() => {
      viz.spawn(ev, { dim: true });
      ui.log(ev, { dim: true });
    }, offsetSec);
    return;
  }
  const audible = engine.state === 'running' && !settings.muted;
  const delay = audible ? engine.playAt(ev, offsetSec) : -1;
  const dropped = audible && delay < 0;
  if (dropped) stats.dropped += 1;
  else if (audible) stats.played += 1;
  if (midiOut.active && !dropped) midiOut.play(item, offsetSec);
  schedule(
    () => {
      const now = performance.now();
      recentTx.push(now);
      lastMinute.push(now);
      viz.spawn(ev, { dim: dropped });
      ui.log(ev, { dim: dropped });
      if (settings.captions && !session.blind && item.cast.length) ui.transport.caption({ kind: 'cast', text: scoreCaption(item, session.active?.case.cast ?? []) });
    },
    dropped || !audible ? offsetSec : delay,
  );
}

function onScoreLedger(entry, offsetSec) {
  schedule(() => {
    if (entry.missing) {
      ui.logMessage(`Ledger ${fmt(entry.ledgerIndex)} unavailable — ${entry.intervalMs / 1000} s of silence stands in for it.`, 'error');
      ui.transport.caption({ kind: 'ledger', text: `Ledger ${fmt(entry.ledgerIndex)} unavailable` });
      return;
    }
    onLedger(entry.event, entry.intervalMs / 1000 / session.speed);
    const raw = session.active?.ledgers.get(entry.ledgerIndex)?.ledger;
    if (raw) observeLedger(entry.ledgerIndex, raw.transactions ?? []);
  }, offsetSec);
}

function onScoreGap(gap, offsetSec) {
  schedule(() => {
    const text = `${gap.omitted} ledger${gap.omitted === 1 ? '' : 's'} omitted between ${fmt(gap.afterLedger)} and ${fmt(gap.beforeLedger)}`;
    ui.logMessage(`— ${text} —`);
    if (settings.captions) ui.transport.caption({ kind: 'gap', text });
    viz.gap();
  }, offsetSec);
}

function onScoreAnnotation(a, offsetSec) {
  schedule(() => {
    if (session.blind) return; // blind comparison: notes stay silent and unseen
    ui.logMessage(`» ${a.text}${a.source ? ` [${a.source}]` : ''}`, 'note');
    if (settings.captions || a.pause) ui.transport.caption({ kind: 'annotation', text: a.text, source: a.source, status: a.status, sticky: a.pause });
    if (settings.speak) speak(a.text);
  }, offsetSec);
}

function onTransportState(state, detail) {
  ui.transport.setState(state, detail);
  if (state !== 'playing') {
    clearPending();
    midiOut.allNotesOff();
    if (state === 'ended') hush();
  }
  ui.setStatus('connected', caseStatusText(), undefined);
  if (state === 'paused' && detail?.annotation && settings.speak && !session.blind) speak(detail.annotation.text);
}

function onScoreEnd() {
  ui.logMessage('End of the case. ▶ plays it again; Go live returns to the stream.');
}

function transportToggle() {
  const t = activeTransport();
  if (!t) return;
  t.toggle();
}

function setSpeed(speed) {
  session.speed = speed;
  activeTransport()?.setSpeed(speed);
  ui.transport.setSpeed(speed);
  if (session.active) {
    ui.logMessage(`Speed ${speed}×.`);
    syncHash();
  }
}

function loopToggle() {
  const t = activeTransport();
  if (!t) return;
  if (t.loop) {
    t.setLoop(null);
    ui.logMessage('Loop off.');
  } else {
    t.setLoop(session.loop ?? { fromMs: 0, toMs: t.totalMs });
    ui.logMessage(`Looping ${formatClock(t.loop.fromMs)}–${formatClock(t.loop.toMs)}.`);
  }
  ui.transport.setLoop(t.loop);
}

function loopPoint(which) {
  const t = activeTransport();
  if (!t) return;
  const pos = t.positionNow();
  const cur = session.loop ?? { fromMs: 0, toMs: t.totalMs };
  session.loop = which === 'in' ? { fromMs: pos, toMs: Math.max(pos + 500, cur.toMs) } : { fromMs: Math.min(cur.fromMs, Math.max(0, pos - 500)), toMs: pos };
  t.setLoop(session.loop);
  ui.transport.setLoop(t.loop);
  ui.logMessage(`Loop ${which === 'in' ? 'in' : 'out'} point at ${formatClock(pos)}: ${formatClock(t.loop.fromMs)}–${formatClock(t.loop.toMs)}.`);
}

function goLive() {
  if (!session.active && !session.loading) return;
  endSession();
  ui.logMessage('Back to live.');
}

// ---------------------------------------------------------------------------
// Comparison: play one clip on a loop, and blind mode
// ---------------------------------------------------------------------------

/** Loop and play clip `i` (A, B, …); null plays the whole case again. */
function playClip(i) {
  const t = activeTransport();
  const s = session.active;
  if (!t || !s) return;
  const ranges = clipRanges(s.score);
  if (i == null || !ranges[i]) {
    session.clip = null;
    t.setLoop(null);
    ui.transport.setLoop(null);
    ui.transport.setClip(null);
    t.seek(0);
    if (!t.playing) t.play();
    ui.logMessage('Playing the whole case.');
    return;
  }
  const r = ranges[i];
  session.clip = i;
  session.loop = { fromMs: r.fromMs, toMs: r.toMs };
  t.setLoop(session.loop);
  ui.transport.setLoop(t.loop);
  ui.transport.setClip(i);
  t.seek(r.fromMs);
  if (!t.playing) t.play();
  const letter = String.fromCharCode(65 + i);
  ui.logMessage(session.blind ? `Window ${letter}.` : `Looping clip ${letter}: ${r.ledgers} ledger${r.ledgers === 1 ? '' : 's'}, ${formatClock(r.fromMs)}–${formatClock(r.toMs)}.`);
}

/** Blind comparison: the plate and the sound stay; ledger numbers, the tape, notes and captions go. */
function setBlind(on) {
  session.blind = Boolean(on);
  document.body.classList.toggle('blind', session.blind);
  viz.setBlind(session.blind);
  ui.casePanel.setBlind(session.blind);
  ui.inspector.hide();
  if (session.blind) {
    ui.transport.caption(null);
    hush();
    ui.logMessage('Blind comparison on: ledger numbers, notes and captions are hidden until you turn it off.');
  } else {
    ui.logMessage('Blind comparison off.');
  }
}

// ---------------------------------------------------------------------------
// Notes (annotations) on the loaded case
// ---------------------------------------------------------------------------

function noteBase() {
  return session.active?.case ?? session.pending;
}

function commitCase(next) {
  if (!next) return;
  next.source = noteBase()?.source ?? 'case';
  if (session.active) {
    session.active.case = next;
    session.pending = next;
    rebuildScore();
  } else {
    session.pending = next;
    ui.casePanel.setCase(next, null);
    syncHash();
  }
}

/** A new note anchored at the current position; opens its editor. */
function addNoteHere() {
  const base = noteBase();
  if (!base) return;
  const t = activeTransport();
  const anchor = { timeMs: t ? Math.round(t.positionNow()) : 0 };
  const r = addAnnotation(base, { anchor, text: 'New note', status: 'draft' });
  if (!r.case) {
    for (const e of r.errors) ui.logMessage(e, 'error');
    return;
  }
  commitCase(r.case);
  ui.casePanel.edit(r.annotation.id, { isNew: true });
}

/** A new note anchored to a transaction, from the inspector. */
function annotateEvent(event, item) {
  const base = noteBase();
  if (!base || !event?.hash) return;
  const r = addAnnotation(base, { anchor: { hash: event.hash }, text: `${event.txType}${event.amount ? ` · ${event.head.split(' · ').slice(1).join(' · ')}` : ''}`, status: 'draft' });
  if (!r.case) {
    for (const e of r.errors) ui.logMessage(e, 'error');
    return;
  }
  commitCase(r.case);
  ui.inspector.hide();
  ui.casePanel.edit(r.annotation.id, { isNew: true });
}

function editNote(id, patch) {
  const base = noteBase();
  if (!base) return;
  commitCase(updateAnnotation(base, id, patch));
}

function removeNote(id) {
  const base = noteBase();
  if (!base) return;
  commitCase(removeAnnotation(base, id));
}

function jumpToNote(id) {
  const s = session.active;
  const t = activeTransport();
  if (!s || !t) return;
  const a = s.score.annotations.find((x) => x.id === id);
  if (!a) {
    ui.logMessage('That note does not resolve to a position in this case.', 'error');
    return;
  }
  t.seek(a.timeMs);
  if (!session.blind) ui.transport.caption({ kind: 'annotation', text: a.text, source: a.source, status: a.status });
}

function endSession({ quiet = false } = {}) {
  if (session.abort) session.abort.aborted = true;
  const s = session.active;
  session.active = null;
  session.loading = false;
  session.clip = null;
  session.loop = null;
  s?.transport.stop();
  clearPending();
  hush();
  ui.transport.setActive(false);
  ui.midiPanel.setScoreAvailable(false);
  midiOut.allNotesOff();
  ui.casePanel.setCase(session.pending && !quiet ? session.pending : null, null);
  ui.inspector.hide();
  ui.setMomentNote('');
  refreshField();
  if (running && stream) {
    resetLedgerState();
    const host = stream.endpoint ? stream.endpoint.replace(/^wss:\/\//, '') : '';
    if (stream.state === 'connected') ui.setStatus('connected', `Live · ${host}`, stream.endpoint);
    pollFee();
  }
  renderHealth();
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

function inspect(event, item = event?.scoreItem ?? null) {
  if (!event || event.kind !== 'tx' || session.blind) return;
  const s = session.active;
  const ctx = {};
  if (s && item) {
    ctx.item = item;
    ctx.index = item.n;
    ctx.total = s.score.events.length;
    const hash = event.hash ? event.hash.toUpperCase() : null;
    ctx.annotations = s.score.annotations.filter((a) => a.eventN === item.n || (hash && a.anchor.hash === hash));
  }
  ui.inspector.show(event, ctx);
}

function inspectNeighbour(item, delta) {
  const s = session.active;
  if (!s) return;
  const next = s.score.events[item.n + delta];
  if (next) inspect(next.event, next);
}

canvas.addEventListener('click', (e) => {
  if (query.mode === 'overlay') return;
  if (viz.consumeDragClick()) return; // the click that ends a drag is not an inspect
  const p = viz.hitTest(e.clientX, e.clientY);
  if (p?.event) {
    inspect(p.event);
    return;
  }
  // a fringe region of the field: the pair's full line (src/field.js); anywhere else closes it
  const hit = viz.fieldHit(e.clientX, e.clientY);
  if (hit) ui.showFieldLine({ label: hit.pair.label, line: hit.pair.line, detail: hit.pair.detail });
  else ui.hideFieldLine();
});

// ---------------------------------------------------------------------------
// Case files, links, transcript, share
// ---------------------------------------------------------------------------

async function loadCaseFile(file) {
  try {
    const raw = JSON.parse(await file.text());
    openCase(raw, 'file', `file ${file.name}`);
  } catch (err) {
    ui.logMessage(`Could not read ${file.name}: ${err?.message ?? err}`, 'error');
  }
}

function saveCase() {
  const c = currentCase();
  if (!c) return;
  downloadBlob(new Blob([serializeCase(c)], { type: 'application/json' }), caseFilename(c));
  ui.logMessage(`Saved ${caseFilename(c)}.`);
}

async function caseLink(c) {
  return `${SITE_URL}${c.network !== 'mainnet' ? `?network=${c.network}` : ''}${buildHash({ case: await encodeCase(c) })}`;
}

async function copyCaseLink() {
  const c = currentCase();
  if (!c) return;
  const url = await caseLink(c);
  try {
    await navigator.clipboard.writeText(url);
    ui.logMessage(`Copied a link to ${caseTitle(c)} (${url.length} characters).`);
  } catch (err) {
    console.warn('[xrpl-sonic] clipboard unavailable', err);
    ui.logMessage(`Could not copy — link: ${url}`, 'error');
  }
}

function saveTranscript() {
  const s = session.active;
  if (!s) return;
  const name = `${s.case.id}.transcript.txt`;
  downloadBlob(new Blob([transcript(s.score, s.case)], { type: 'text/plain' }), name);
  ui.logMessage(`Saved ${name}.`);
}

/** The transcript in the readout drawer, structured, with Copy raw and Save file; the text is transcript()'s, unchanged. */
function showTranscript() {
  const s = session.active;
  if (!s) return;
  ui.drawer.showTranscript(transcript(s.score, s.case), { title: caseTitle(s.case), onSave: () => saveTranscript() });
}

/** The sample case that ships with the page (README, "Cases"), as the easiest way to a case after Moment. */
async function loadSample() {
  try {
    const r = await fetch('docs/cases/busiest-senders-107777809.sonic-case.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    openCase(await r.json(), 'file', 'the sample case');
  } catch (err) {
    ui.logMessage(`Could not load the sample case: ${err?.message ?? err}`, 'error');
  }
}

/** What Share copies: a loaded case whole, otherwise network + cast + the ledger playing now. */
async function shareUrl() {
  const c = session.active?.case ?? session.pending;
  if (c && c.source !== 'replay') return caseLink(currentCase());
  const index = session.active ? ledgerAtPosition(session.active.score, session.active.transport.positionNow()) ?? session.active.case.clips[0].from : ledgerState.index;
  if (index == null) return null;
  const q = settings.network !== 'mainnet' ? `?network=${settings.network}` : '';
  return `${SITE_URL}${q}${buildHash({ cast: settings.cast.length ? formatCastSpec(settings.cast) : '', replay: String(index) })}`;
}

async function share() {
  const url = await shareUrl();
  if (!url) {
    ui.logMessage('Nothing to share yet — press Start and wait for a ledger to close.', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    ui.setShared(true);
    ui.logMessage(`Copied ${url.length > 120 ? `${url.slice(0, 80)}… (${url.length} characters)` : url}`);
  } catch (err) {
    console.warn('[xrpl-sonic] clipboard unavailable', err);
    ui.logMessage(`Could not copy — link: ${url}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Save this moment (src/moment.js, docs/save-this-moment.md)
// ---------------------------------------------------------------------------

/** The moment as a raw case: the loop or the ledger playing now, the inspector's event as the anchor, the question at it. Null when nothing has been heard. */
function buildMoment(question) {
  const host = stream?.endpoint ? stream.endpoint.replace(/^wss:\/\//, '') : '';
  const selectedHash = ui.inspector.current()?.hash ?? null;
  const savedAt = new Date().toISOString();
  if (session.active) {
    const t = session.active.transport;
    return momentFromReplay({ base: currentCase(), score: session.active.score, positionMs: t.positionNow(), loop: t.loop, selectedHash, question, host, savedAt });
  }
  const base = caseFromState({ network: settings.network, cast: settings.cast, settings });
  return momentFromLive({ base, window: live, selectedHash, question, host, savedAt });
}

/** The validated moment, or null with the reasons logged. */
function momentNow(question = '') {
  const raw = buildMoment(question);
  if (!raw) {
    ui.logMessage('Nothing to save yet — press Start and wait for a ledger to close.', 'error');
    return null;
  }
  const { case: c, errors } = validateCase(raw);
  for (const e of errors) ui.logMessage(`Moment: ${e}`, 'error');
  if (!c) ui.logMessage('The moment could not be saved.', 'error');
  return c;
}

/** One action: the file downloads and the link is copied; playback is not touched. */
async function saveMoment(question) {
  const c = momentNow(question);
  if (!c) return false;
  const name = caseFilename(c);
  downloadBlob(new Blob([serializeCase(c)], { type: 'application/json' }), name);
  const url = await caseLink(c);
  try {
    await navigator.clipboard.writeText(url);
    ui.logMessage(`Saved ${name} and copied its link (${url.length} characters).`);
  } catch {
    ui.logMessage(`Saved ${name} — link: ${url}`);
  }
  ui.setMomentSaved(true);
  return true;
}

/** What a reopened moment says about itself: where and when it was saved, where the transport went, what was heard when it was saved. */
function momentSummary(c, placed) {
  const m = c.moment;
  const heard = m.ledgers.filter((l) => l.expected != null);
  const received = heard.reduce((n, l) => n + (l.received ?? 0), 0);
  const expected = heard.reduce((n, l) => n + l.expected, 0);
  const coverage = m.mode === 'live' && heard.length ? ` It heard ${received} of ${expected} transactions across ${heard.length} ledger${heard.length === 1 ? '' : 's'} when it was saved; this replay has them all.` : '';
  const when = m.savedAt ? ` on ${m.savedAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}` : '';
  const where = m.mode === 'explorer' ? 'from the explorer' : `while listening ${m.mode}`;
  return `A moment saved ${where}${when}${m.host ? ` via ${m.host}` : ''}: positioned at ${formatClock(placed.timeMs)}${placed.loop ? `, looping ${formatClock(placed.loop.fromMs)}–${formatClock(placed.loop.toMs)}` : ''}.${coverage}`;
}

// ---------------------------------------------------------------------------
// Copy for AI (src/describe.js, docs/copy-for-ai.md)
// ---------------------------------------------------------------------------

/** The facts for the loaded case's transactions, built once per session (they depend on the ledgers, not on the settings). */
function sessionFacts() {
  const s = session.active;
  if (!s) return null;
  if (!s.facts) s.facts = factsForCase(s.case, s.ledgers);
  return s.facts;
}

/** describeReport for the case as it stands, at a level. Null (with a message) when no case is playing. */
async function describeNow(level = 'gist', { budget } = {}) {
  const s = session.active;
  if (!s) {
    ui.logMessage('Copy for AI needs a loaded case with its ledgers: open a replay or a case and press Start.', 'error');
    return null;
  }
  const c = currentCase();
  return describeReport(c, s.ledgers, sessionFacts(), { level, budget, caseLink: await caseLink(c) });
}

/**
 * Coherence (src/coherence.js, docs/coherence.md): the statistic over the
 * playing case's score, else over the ledgers heard live; the cast, or with
 * none the top submitters.
 */
function coherenceNow({ measure = 'count', topK, maxLag, bin = field.bin } = {}) {
  const s = session.active;
  const frame = s ? frameFromScore(s.score, { cast: s.case.cast, topK, measure, ledgers: s.ledgers }) : frameFromLive(live, { cast: settings.cast ?? [], topK, measure });
  return coherence(frame, { maxLag, bin });
}

/**
 * The interference field (src/field.js, docs/coherence.md phase 2): the
 * model from the coherence report over the playing case or the live window,
 * for the cast, in the field's mode; nothing when the field is off.
 */
function fieldNow() {
  const mode = settings.field?.mode ?? 'off';
  if (mode === 'off') return fieldModel(null, { mode: 'off', cast: settings.cast ?? [] });
  const cast = session.active ? session.active.case.cast : settings.cast ?? [];
  return fieldModel(coherenceNow(), { mode, pair: settings.field?.pair ?? null, cast });
}

/** Recompute the field and hand it to the plate; the sentence for the panel (and, when announced, the tape) says what is drawn or why nothing is. */
function refreshField({ announce = false } = {}) {
  const model = fieldNow();
  field.model = model;
  viz.setField(model.on ? model : null);
  const text = model.on ? (model.summary ?? `field: ${model.pairs.length} of ${model.tested} pair${model.tested === 1 ? '' : 's'} drawn · ${model.pairs.map((p) => p.label).join('; ')} · ${model.caption}`) : 'Off. Interference between cast sigils, drawn only for pairs above the coherence bar; a click on a fringe shows the pair’s line.';
  ui.fieldPanel.setSummary(text);
  if (announce && text !== field.lastSummary) ui.logMessage(model.on ? text : 'Field off.', 'info');
  field.lastSummary = text;
  if (!model.on) ui.hideFieldLine();
  return model;
}

/** A frame given as JSON (ledgers, accounts, series, totals, records) run through the statistic and the field, for checks on data the page cannot fetch. */
function coherenceFromFrame(raw, { cast = null, mode = 'cast', pair = null, bin = field.bin } = {}) {
  const frame = { source: raw.source ?? 'score', measure: raw.measure ?? 'count', unit: 'ledger', bin: null, ledgers: raw.ledgers ?? [], accounts: raw.accounts ?? [], series: new Map(Object.entries(raw.series ?? {})), totals: new Map(Object.entries(raw.totals ?? {})), chosen: raw.chosen ?? 'named accounts', records: raw.records ?? null, fetched: raw.fetched ?? null };
  const report = coherence(frame, { bin });
  const members = cast ?? normalizeCast(frame.accounts.map((a) => ({ address: a.address, label: a.label })));
  const model = fieldModel(report, { mode, pair, cast: members });
  field.model = model;
  viz.setField(model.on ? model : null);
  ui.fieldPanel.setSummary(model.summary ?? `field: ${model.pairs.length} of ${model.tested} pairs drawn`);
  ui.drawer.showCoherence(report);
  return { report, model };
}

/** The readout into the case panel, and the top pair's line on the tape. */
function showCoherence() {
  const report = coherenceNow();
  ui.drawer.showCoherence(report);
  refreshField();
  const first = report.pairs[0];
  ui.logMessage(first ? `Coherence · ${describePair(first)}` : report.window.ledgers ? 'Coherence: fewer than two accounts to compare.' : 'Coherence: no ledger heard yet.', 'info');
  return report;
}

/** Show the sizes and the events-shown ratio of both levels before anything is copied. */
async function openAi() {
  const gist = await describeNow('gist');
  if (!gist) return;
  const evidence = await describeNow('evidence');
  ui.openAiBox({ gist, evidence });
}

async function copyAi(level) {
  const r = await describeNow(level);
  if (!r) return;
  ui.closeAiBox();
  try {
    await navigator.clipboard.writeText(r.text);
    ui.setAiCopied(true, level);
    ui.logMessage(`Copied the ${level}: ${r.chars.toLocaleString('en-US')} characters (~${r.tokensApprox.toLocaleString('en-US')} tokens), ${r.shown} of ${r.total} events${r.rule ? ` (${r.rule})` : ''}.`);
  } catch (err) {
    console.warn('[xrpl-sonic] clipboard unavailable', err);
    ui.logMessage('Could not copy: the clipboard is unavailable in this context.', 'error');
  }
}

/** An assistant's answer, pasted back: drafts on the case, with what was accepted and rejected. */
function importNotes(text, source) {
  const base = noteBase();
  if (!base) {
    ui.logMessage('Load a case before importing notes.', 'error');
    return null;
  }
  const r = importAnnotations(base, text, { source, score: session.active?.score ?? null });
  if (r.accepted.length) commitCase(r.case);
  ui.casePanel.setImportResult(r);
  ui.logMessage(`Import: ${r.accepted.length} note${r.accepted.length === 1 ? '' : 's'} accepted as draft${r.accepted.length === 1 ? '' : 's'} from "${source}"${r.rejected.length ? `; ${r.rejected.length} rejected` : ''}.`, r.accepted.length ? 'note' : 'error');
  for (const x of r.rejected) ui.logMessage(`Import: #${x.index + 1} rejected: ${x.reason}`, 'error');
  return r;
}

// ---------------------------------------------------------------------------
// Snapshot and recording
// ---------------------------------------------------------------------------

function currentLedgerIndex() {
  if (session.active) {
    const pos = session.active.transport.positionNow();
    const at = session.active.score.ledgers.filter((l) => l.timeMs <= pos).at(-1);
    return at?.ledgerIndex ?? session.active.case.clips[0].from;
  }
  return ledgerState.index;
}

function txInLastMinute() {
  const now = performance.now();
  while (lastMinute.length && now - lastMinute[0] > 60_000) lastMinute.shift();
  return lastMinute.length;
}

/** Compose the scene plus a stats box into a PNG; downloads it unless `download` is false. Returns the blob. */
async function snapshot({ download = true } = {}) {
  const ledgerIndex = currentLedgerIndex();
  const lines = snapshotLines({
    ledgerIndex,
    txLastMinute: txInLastMinute(),
    network: NETWORKS[settings.network].label,
    timestamp: new Date(),
    url: SITE_URL,
  });
  const blob = await composeSnapshot(canvas, lines, { transparent: query.mode === 'overlay', dpr: viz.dpr });
  const filename = snapshotFilename(ledgerIndex);
  if (download) {
    downloadBlob(blob, filename);
    ui.logMessage(`Saved ${filename} (${Math.round(blob.size / 1024)} kB)`);
  }
  return blob;
}

/** Record the canvas and the audio mix for 30 s (or `seconds`); downloads the WebM unless `download` is false. */
async function record({ seconds = RECORD_SECONDS, download = true } = {}) {
  if (recording) return recording.done;
  if (!capture.recording) throw new Error('this browser cannot record (MediaRecorder or canvas.captureStream missing)');
  if (!running) {
    ui.logMessage('Press Start before recording, so there is something to hear.', 'error');
    return null;
  }
  const startedAt = currentLedgerIndex();
  recording = startRecording({
    canvas,
    audioStream: engine.recordingStream(),
    seconds,
    mimeType: capture.mimeType,
    onTick: (remaining) => ui.setRecording(remaining),
  });
  ui.logMessage(`Recording ${seconds} s of video and audio…`);
  try {
    const blob = await recording.done;
    const filename = recordingFilename(startedAt);
    if (download) downloadBlob(blob, filename);
    ui.logMessage(`${download ? 'Saved' : 'Recorded'} ${filename} (${Math.round(blob.size / 1024)} kB, ${blob.type})`);
    return blob;
  } finally {
    recording = null;
    ui.setRecording(null);
  }
}

// ---------------------------------------------------------------------------
// Frame loop, gestures, keyboard
// ---------------------------------------------------------------------------

let lastReadout = 0;
let lastGeigerRender = 0;
let lastHealthRender = 0;
viz.onFrame = (ts) => {
  activeTransport()?.tick();
  if (geiger.detector && ts - lastGeigerRender > 2000) {
    lastGeigerRender = ts;
    renderGeiger();
  }
  if (settings.health.poll && ts - lastHealthRender > 2000) {
    lastHealthRender = ts;
    applyDrone();
    renderHealth();
  }
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

// Pause rendering when hidden; the socket stays up so the log keeps flowing. The transport keeps
// its own clock, so a case continues to advance (and sound) while the tab is hidden.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) viz.stop();
  else if (running) viz.start();
});
let hiddenTicker = 0;
document.addEventListener('visibilitychange', () => {
  clearInterval(hiddenTicker);
  if (document.hidden) hiddenTicker = setInterval(() => activeTransport()?.tick(), 100);
});

// Keyboard: Space toggles, M mutes, S saves this moment; with a case loaded K play/pause, , and
// . step, L loops, [ and ] set loop points, Home seeks to the start, Esc closes the inspector.
// Not in overlay mode, where any key is only the gesture that unlocks audio, and not inside a control.
window.addEventListener('keydown', (e) => {
  if (query.mode === 'overlay') return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.code === 'Space') {
    if (tag === 'BUTTON') return; // Space activates the focused button; leave it alone
    e.preventDefault();
    running ? stop() : start();
    return;
  }
  if (e.key === 'm' || e.key === 'M') {
    settings.muted = !settings.muted;
    saveSettings(settings);
    engine.setMuted(settings.muted);
    ui.applySettings();
    return;
  }
  if (e.key === 'Escape') {
    ui.inspector.hide();
    ui.hideFieldLine();
    ui.drawer.hide();
    ui.closeMomentPrompt();
    return;
  }
  if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    ui.openMomentPrompt();
    return;
  }
  const t = activeTransport();
  if (!t) return;
  if (e.key === 'k' || e.key === 'K') t.toggle();
  else if (e.key === '.') t.step();
  else if (e.key === ',') t.stepBack();
  else if (e.key === 'l' || e.key === 'L') loopToggle();
  else if (e.key === '[') loopPoint('in');
  else if (e.key === ']') loopPoint('out');
  else if (e.key === 'Home') t.seek(0);
  else return;
  e.preventDefault();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

ui.setStatus('idle', 'Ready', null);
ui.setLedger(null, null);
ui.setCast(settings.cast);
for (const err of urlState.errors) ui.logMessage(err, 'error');
if (urlState.case) {
  decodeCase(urlState.case)
    .then((raw) => openCase(raw, 'case', 'the link'))
    .catch((err) => ui.logMessage(`Could not read the case in the link: ${err?.message ?? err}`, 'error'));
} else if (query.caseUrl) {
  // ?case=docs/cases/x.sonic-case.json — a same-origin file; the case then travels in the hash like any other.
  fetch(query.caseUrl, { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
    .then((raw) => openCase(raw, 'file', query.caseUrl))
    .catch((err) => ui.logMessage(`Could not load ${query.caseUrl}: ${err?.message ?? err}`, 'error'));
} else if (urlState.replay) {
  armReplayFromUrl(urlState.replay);
}
if (settings.cast.length) ui.logMessage(castSummary());
if (settings.geiger.enabled) startGeiger();
renderGeiger();
renderHealth();
viz.start();

// Overlay mode starts on load: visuals at once, sound as soon as the page receives a click or key.
if (query.autostart || query.mode === 'overlay') start();

// Exposed for debugging and smoke checks in the browser console.
window.xrplSonic = {
  engine,
  viz,
  settings,
  session,
  preview,
  query,
  start,
  stop,
  stats,
  shareUrl,
  live,
  momentNow,
  saveMoment,
  describeNow,
  importNotes,
  coherenceNow,
  showCoherence,
  showTranscript,
  loadSample,
  setView,
  enterDoor,
  tours: { list: TOURS, run: runTour, next: () => tourMove(+1), back: () => tourMove(-1), exit: () => exitTour(), state: () => ({ id: tour.id, index: tour.index, total: tour.steps?.length ?? 0 }) },
  fieldNow,
  refreshField,
  coherenceFromFrame,
  field,
  openCase: (raw) => openCase(raw, 'case', 'the console'),
  playClip,
  setBlind,
  geiger,
  health,
  midi: midiOut,
  transport: () => activeTransport(),
  capture: { support: capture, snapshot, record, stop: () => recording?.stop() },
  get stream() {
    return stream;
  },
  get running() {
    return running;
  },
};

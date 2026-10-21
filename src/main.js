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
import { validateCase, caseFromState, serializeCase, encodeCase, decodeCase, caseFilename, caseLedgerCount } from './case.js';
import { buildScore, scoreCaption, transcript, formatClock } from './score.js';
import { Transport } from './transport.js';
import { fetchCaseLedgers } from './ledgers.js';
import { speak, hush } from './speech.js';
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

const SITE_URL = 'https://quigles1337.github.io/xrpl-sonic/';

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
};

const canvas = document.getElementById('scene');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const viz = new Visualizer(canvas, { transparent: query.mode === 'overlay', reduced: reducedMotion.matches });
reducedMotion.addEventListener?.('change', (e) => viz.setReduced(e.matches));
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
const lastMinute = []; // timestamps for the snapshot overlay (60 s window)
const capture = captureSupport(globalThis);
let recording = null; // { done, stop } while a recording runs
const pendingTimers = new Set();

const ui = createUI({
  settings,
  onToggleRun: () => (running ? stop() : start()),
  onShare: () => share(),
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
  },
  caseActions: {
    onLoadFile: (file) => loadCaseFile(file),
    onSave: () => saveCase(),
    onCopyLink: () => copyCaseLink(),
    onTranscript: () => saveTranscript(),
    onToggle: (key, value) => {
      settings[key] = value;
      saveSettings(settings);
      if (key === 'pauseAtNotes') {
        const t = activeTransport();
        if (t) t.honourPauses = value;
      }
      if (key === 'speak' && !value) hush();
    },
  },
  inspector: {
    onPrev: (item) => inspectNeighbour(item, -1),
    onNext: (item) => inspectNeighbour(item, +1),
  },
  onChange: (patch) => {
    saveSettings(settings);
    options = mappingOptions(settings);
    if ('volume' in patch) engine.setVolume(settings.volume);
    if ('muted' in patch) engine.setMuted(settings.muted);
    if ('network' in patch && stream) {
      resetLedgerState();
      ui.logMessage(`Switching to ${NETWORKS[settings.network].label}…`);
      if (session.active) endSession();
      stream.setEndpoints(NETWORKS[settings.network].endpoints);
    }
    if ('cast' in patch || 'castMode' in patch) {
      syncHash();
      applyCast();
    }
    if ('network' in patch || 'explorer' in patch) ui.setCast(settings.cast);
    if (session.active && ['scale', 'key', 'enabled', 'includeFailed', 'quietMode', 'quietThreshold', 'cast', 'castMode'].some((k) => k in patch)) rebuildScore();
  },
});

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
  const url = `${location.pathname}${location.search}${hash}`;
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
  schedule(() => {
    viz.spawn(ev);
    ui.log(ev);
  }, delay);
}

function onMessage(msg) {
  switch (classifyMessage(msg)) {
    case 'ledger':
      if (session.active || session.loading) break; // the live stream is paused while a case plays
      onLedger(ledgerToEvent(msg));
      break;
    case 'transaction':
      if (session.active || session.loading) break;
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
      if (session.armed && session.pending) {
        session.armed = false;
        runCase(session.pending);
      }
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
  saveSettings(settings);
  options = mappingOptions(settings);
  ui.applySettings();
  ui.setCast(settings.cast);
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
  session.active = { case: theCase, ledgers: result.ledgers, score, transport, failures: result.failures };
  session.loop = null;
  ui.transport.setScore(score, caseTitle(theCase));
  ui.transport.setLoop(null);
  ui.casePanel.setCase(theCase, score, result.failures.length ? [`${result.failures.length} ledger${result.failures.length === 1 ? '' : 's'} could not be fetched: ${result.failures.map((f) => `${fmt(f.index)} (${f.error})`).join(', ')}`] : []);
  for (const f of result.failures) ui.logMessage(`Ledger ${fmt(f.index)} could not be fetched: ${f.error}`, 'error');
  for (const w of score.warnings) ui.logMessage(w, 'error');
  ui.logMessage(`${caseTitle(theCase)}: ${score.counts.events} events over ${formatClock(score.totalMs)} at ${session.speed}× — K pauses, . steps, L loops, click a line or a track to inspect it.`);
  transport.play();
  ui.setStatus('connected', caseStatusText(), undefined);
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
  schedule(
    () => {
      const now = performance.now();
      recentTx.push(now);
      lastMinute.push(now);
      viz.spawn(ev, { dim: dropped });
      ui.log(ev, { dim: dropped });
      if (settings.captions && item.cast.length) ui.transport.caption({ kind: 'cast', text: scoreCaption(item, session.active?.case.cast ?? []) });
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
    ui.logMessage(`» ${a.text}${a.source ? ` [${a.source}]` : ''}`, 'note');
    if (settings.captions || a.pause) ui.transport.caption({ kind: 'annotation', text: a.text, source: a.source, status: a.status, sticky: a.pause });
    if (settings.speak) speak(a.text);
  }, offsetSec);
}

function onTransportState(state, detail) {
  ui.transport.setState(state, detail);
  if (state !== 'playing') {
    clearPending();
    if (state === 'ended') hush();
  }
  ui.setStatus('connected', caseStatusText(), undefined);
  if (state === 'paused' && detail?.annotation && settings.speak) speak(detail.annotation.text);
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

function endSession({ quiet = false } = {}) {
  if (session.abort) session.abort.aborted = true;
  const s = session.active;
  session.active = null;
  session.loading = false;
  s?.transport.stop();
  clearPending();
  hush();
  ui.transport.setActive(false);
  ui.casePanel.setCase(session.pending && !quiet ? session.pending : null, null);
  ui.inspector.hide();
  if (running && stream) {
    resetLedgerState();
    const host = stream.endpoint ? stream.endpoint.replace(/^wss:\/\//, '') : '';
    if (stream.state === 'connected') ui.setStatus('connected', `Live · ${host}`, stream.endpoint);
  }
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

function inspect(event, item = event?.scoreItem ?? null) {
  if (!event || event.kind !== 'tx') return;
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
  const p = viz.hitTest(e.clientX, e.clientY);
  if (p?.event) inspect(p.event);
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

/** What Share copies: a loaded case whole, otherwise network + cast + the ledger playing now. */
async function shareUrl() {
  const c = session.active?.case ?? session.pending;
  if (c && c.source !== 'replay') return caseLink(currentCase());
  const index = session.active ? session.active.score.ledgers.find((l) => l.timeMs <= session.active.transport.positionNow())?.ledgerIndex ?? session.active.case.clips[0].from : ledgerState.index;
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
viz.onFrame = (ts) => {
  activeTransport()?.tick();
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

// Keyboard: Space toggles, M mutes; with a case loaded K play/pause, , and . step, L loops,
// [ and ] set loop points, Home seeks to the start, Esc closes the inspector. Not in overlay
// mode, where any key is only the gesture that unlocks audio, and not inside a control.
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
} else if (urlState.replay) {
  armReplayFromUrl(urlState.replay);
}
if (settings.cast.length) ui.logMessage(castSummary());
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
  openCase: (raw) => openCase(raw, 'case', 'the console'),
  transport: () => activeTransport(),
  capture: { support: capture, snapshot, record, stop: () => recording?.stop() },
  get stream() {
    return stream;
  },
  get running() {
    return running;
  },
};

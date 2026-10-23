// UNIVERSE — the worker: the stream, the records, the layout.
//
// Everything that is not drawing happens here, off the page's thread: the
// WebSocket to the public node (src/ws.js, the same client as the pages),
// the compact records and planets (src/universe/universe.js), the
// incremental layout (src/universe/layout.js), the clustering
// (src/universe/cluster.js), and every ten ledgers the coherence of the
// busiest submitters (src/coherence.js over a LiveWindow from src/moment.js)
// for pulsars and pairs in step. The page receives positions as a
// transferable Float32Array whenever the layout moved, and at every ledger
// close the planet attributes, the comets and flashes of that ledger (each
// with its sound event when sound is on), the nebulae, the pairs, the
// domains and keys the labels need, and the coverage. In synthetic mode
// (for measuring, behind its flag) a seeded generator stands in for the
// node and the coverage line says so.

import { XrplStream, NETWORKS } from '../ws.js';
import { classifyMessage, txToEvent, ledgerToEvent } from '../mapping.js';
import { LiveWindow } from '../moment.js';
import { frameFromLive, coherence, significant, DEFAULTS as COHERENCE_DEFAULTS } from '../coherence.js';
import { Universe, coverageLine } from './universe.js';
import { Layout } from './layout.js';
import { Clusters } from './cluster.js';
import { SyntheticStream } from './synthetic.js';
import { bodyOf, cometOf, describeBody, KIND_CODES, THRESHOLDS } from './bodies.js';

const STEP_MS = 50; // layout relaxation cadence
const FRAME_MS = 120; // at most this often, positions to the page
const MAX_COMETS_PER_LEDGER = 400;
const COHERENCE_EVERY = 10; // closed ledgers
const COHERENCE_TOP = 8;

let universe = new Universe();
let layout = new Layout({ capacity: 4096 });
let clusters = new Clusters();
let live = new LiveWindow();

let stream = null;
let synthetic = null;
let syntheticTimer = 0;
let stepTimer = 0;
let soundOn = false;
let host = '';
let state = 'idle';
let lastFramePost = 0;
let moved = false;
let addedSinceLedger = [];
let domainsSinceLedger = [];
let comets = [];
let closedCount = 0;
let lastCloseAt = 0;
let intervalMs = 4000;
const stepStats = { steps: 0, ms: 0, moved: 0, maxMoved: 0, movedShare: 0, warm: 0, pairs: 0 };
let coherenceState = { pulsars: [], pairs: [], tested: 0, above: 0, at: null, ms: 0, window: null };
const domainsSent = new Set();

const post = (msg, transfer) => self.postMessage(msg, transfer ?? []);

function resetAll() {
  // a fresh observed universe: nothing persists in this phase (docs/universe.md, decision 2)
  universe = new Universe();
  layout = new Layout({ capacity: 4096 });
  clusters = new Clusters();
  live = new LiveWindow();
  addedSinceLedger = [];
  domainsSinceLedger = [];
  domainsSent.clear();
  comets = [];
  closedCount = 0;
  lastCloseAt = 0;
  coherenceState = { pulsars: [], pairs: [], tested: 0, above: 0, at: null, ms: 0, window: null };
}

/** The minimal event the engine plays (R9: the fields src/audio.js reads). */
function minimalEvent(ev) {
  return { category: ev.category, sound: ev.sound, variant: ev.variant, pitch: ev.pitch, freq: ev.freq, notes: ev.notes, velocity: ev.velocity, duration: ev.duration, sub: ev.sub, timbre: ev.timbre, amountXrp: ev.amountXrp, hash: ev.hash };
}

function onTransaction(msg) {
  const r = universe.noteTransaction(msg);
  if (!r) return;
  const ledger = r.ledger;
  for (const id of r.newPlanets) {
    layout.add(id, universe.addresses.string(id), ledger);
    clusters.add(id);
    addedSinceLedger.push([id, universe.addresses.string(id)]);
  }
  for (const id of r.touched) layout.touch(id, ledger);
  for (const e of r.edges) {
    if (!e) continue;
    layout.link(e.a, e.b, e.count, universe.planets[e.a].degree, universe.planets[e.b].degree);
    clusters.consider(e.a, e.b, e.count, universe.planets[e.a].degree, universe.planets[e.b].degree);
  }
  for (const root of r.roots) {
    if (!root.domain) continue;
    const id = universe.addresses.id(root.address);
    if (!domainsSent.has(id)) {
      domainsSent.add(id);
      domainsSinceLedger.push([id, root.domain]);
    }
  }
  const c = cometOf(r.record);
  if (c && comets.length < MAX_COMETS_PER_LEDGER) {
    const entry = { ...c, ledger, hash: r.record.hash };
    if (soundOn) {
      const ev = txToEvent(msg);
      if (ev) entry.event = minimalEvent(ev);
    }
    comets.push(entry);
  }
  live.noteTransaction(msg);
  moved = true;
}

function onLedger(msg) {
  const l = universe.noteLedger(msg);
  if (!l) return;
  live.noteLedger(msg);
  const now = performance.now();
  if (lastCloseAt) intervalMs = Math.min(30000, Math.max(1000, now - lastCloseAt));
  lastCloseAt = now;
  closedCount += 1;
  if (closedCount % COHERENCE_EVERY === 0) runCoherence();
  postLedger(l, ledgerToEvent(msg));
}

/** Pulsars and pairs in step among the busiest submitters of the live window, with the project's own statistic (R3 when it lands: cadences per account). */
function runCoherence() {
  const t0 = performance.now();
  let report;
  try {
    const frame = frameFromLive(live, { topK: COHERENCE_TOP });
    report = coherence(frame, { ...COHERENCE_DEFAULTS, topK: COHERENCE_TOP });
  } catch (err) {
    post({ type: 'error', message: `coherence: ${err?.message ?? err}` });
    return;
  }
  const pulsars = [];
  const pairs = [];
  const seen = new Set();
  for (const p of universe.planets) if (p) p.cadence = null;
  for (const pair of report.pairs ?? []) {
    for (const side of ['a', 'b']) {
      const acc = pair[side];
      const cad = pair.cadence?.[side];
      const id = universe.addresses.ids.get(acc?.address);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (cad && cad.period >= THRESHOLDS.pulsarPeriod && cad.r >= THRESHOLDS.pulsarLeast) {
        universe.planets[id].cadence = { period: cad.period, r: cad.r };
        pulsars.push({ id, period: cad.period, r: cad.r });
      }
    }
    if (pair.judged && significant(pair) && pair.white?.r != null) {
      const a = universe.addresses.ids.get(pair.a.address);
      const b = universe.addresses.ids.get(pair.b.address);
      if (a && b) pairs.push({ a, b, lag: pair.white.lag, r: pair.white.r, connected: pair.record?.count ?? 0, label: `in step at lag ${pair.white.lag >= 0 ? '+' : ''}${pair.white.lag}${pair.record?.count ? ` · connected in the record: ${pair.record.count}` : ' · not touching'}` });
    }
  }
  coherenceState = { pulsars, pairs, tested: report.tested ?? 0, above: report.above ?? 0, at: universe.latestClosed, ms: performance.now() - t0, window: report.window?.used ?? null };
}

/** The per-planet attributes the page draws and labels from, as typed arrays indexed by id. */
function attributes() {
  const n = universe.planetCount;
  const size = new Float32Array(n + 1);
  const hue = new Uint16Array(n + 1);
  const kind = new Uint8Array(n + 1);
  const known = new Uint8Array(n + 1);
  const rings = new Uint8Array(n + 1);
  const activity = new Float32Array(n + 1);
  const lastLedger = new Int32Array(n + 1);
  const holders = new Uint16Array(n + 1);
  const providers = new Uint8Array(n + 1);
  const period = new Uint8Array(n + 1);
  const r100 = new Uint8Array(n + 1);
  const keys = [];
  const ledger = universe.currentLedger ?? 0;
  for (let id = 1; id <= n; id++) {
    const p = universe.planets[id];
    if (!p) continue;
    const b = bodyOf(p, { ledger });
    size[id] = b.size;
    hue[id] = b.hue;
    kind[id] = KIND_CODES[b.kind] ?? 0;
    known[id] = b.sizeKnown ? 1 : 0;
    rings[id] = Math.min(255, b.fundedRings || 0);
    activity[id] = p.activity;
    lastLedger[id] = p.lastLedger ?? 0;
    holders[id] = Math.min(65535, b.holders ?? 0);
    providers[id] = Math.min(255, b.providers ?? 0);
    period[id] = Math.min(255, b.period ?? 0);
    r100[id] = Math.min(255, Math.round((b.r ?? 0) * 100));
    if (b.kind === 'blackhole') keys.push([id, b.regularKey ?? null]);
  }
  return { n, size, hue, kind, known, rings, activity, lastLedger, holders, providers, period, r100, keys };
}

function postLedger(l, event) {
  const cov = universe.coverage();
  const attrs = attributes();
  const nebulae = clusters.nebulae(layout).slice(0, 200).map(({ members, ...rest }) => rest);
  const stability = stepStats.steps ? { steps: stepStats.steps, meanMs: stepStats.ms / stepStats.steps, moved: stepStats.moved / stepStats.steps, maxMoved: stepStats.maxMoved, movedShare: stepStats.movedShare / stepStats.steps, warm: Math.round(stepStats.warm / stepStats.steps), pairs: Math.round(stepStats.pairs / stepStats.steps) } : null;
  stepStats.steps = stepStats.ms = stepStats.moved = stepStats.maxMoved = stepStats.movedShare = stepStats.warm = stepStats.pairs = 0;
  const { keys, ...typed } = attrs;
  post(
    {
      type: 'ledger',
      index: l.index,
      txnCount: l.txnCount,
      received: l.received,
      closeTimeIso: event?.closeTimeIso ?? null,
      intervalMs,
      added: addedSinceLedger,
      domains: domainsSinceLedger,
      keys,
      attrs: typed,
      positions: layout.snapshot(),
      nebulae,
      pairs: coherenceState.pairs,
      pulsars: coherenceState.pulsars,
      coherence: { tested: coherenceState.tested, above: coherenceState.above, at: coherenceState.at, ms: coherenceState.ms, window: coherenceState.window },
      comets,
      coverage: cov,
      coverageLine: coverageLine(cov, { host, synthetic: Boolean(synthetic), state }),
      stability,
      memory: { records: universe.records.length, planets: universe.planetCount, edges: universe.edges.size, layoutEdges: layout.ea.length, clusters: clusters.unions, hubSkips: clusters.skippedHub, interned: universe.addresses.size },
    },
    [typed.size.buffer, typed.hue.buffer, typed.kind.buffer, typed.known.buffer, typed.rings.buffer, typed.activity.buffer, typed.lastLedger.buffer, typed.holders.buffer, typed.providers.buffer, typed.period.buffer, typed.r100.buffer],
  );
  addedSinceLedger = [];
  domainsSinceLedger = [];
  comets = [];
  lastFramePost = performance.now();
}

/** One relaxation step, then the next after a pause that grows with the step's cost, so a slow step never starves the stream. */
function stepLayout() {
  stepTimer = 0;
  const ledger = universe.currentLedger ?? 0;
  const s = layout.step(ledger);
  stepTimer = setTimeout(stepLayout, Math.max(STEP_MS, Math.min(2000, 3 * s.ms)));
  stepStats.steps += 1;
  stepStats.ms += s.ms;
  stepStats.moved += s.moved;
  stepStats.maxMoved = Math.max(stepStats.maxMoved, s.maxMoved);
  stepStats.movedShare += s.movedShare;
  stepStats.warm += s.warm;
  stepStats.pairs += s.pairs ?? 0;
  if (s.warm > 0) moved = true;
  const now = performance.now();
  if (moved && now - lastFramePost >= FRAME_MS) {
    const positions = layout.snapshot();
    post({ type: 'frame', ledger, n: layout.count, positions, stepMs: s.ms, warm: s.warm }, [positions.buffer]);
    lastFramePost = now;
    moved = false;
  }
}

function setState(s, endpoint) {
  state = s;
  host = endpoint ? endpoint.replace(/^wss:\/\//, '') : host;
  post({ type: 'status', state, endpoint: endpoint ?? null, host });
}

function start({ network = 'mainnet', synthetic: count = 0, seed = 1337, sound = false, perLedger = 150 } = {}) {
  stop();
  resetAll();
  soundOn = Boolean(sound);
  stepTimer = setTimeout(stepLayout, STEP_MS);
  if (count > 0) {
    synthetic = new SyntheticStream({ planets: count, seed, perLedger });
    host = 'synthetic';
    setState('connected', 'synthetic');
    const feed = () => {
      for (const msg of synthetic.nextLedger()) {
        if (msg.type === 'ledgerClosed') onLedger(msg);
        else onTransaction(msg);
      }
      // build quickly, then settle to a ledger every two seconds
      syntheticTimer = setTimeout(feed, synthetic.accounts.length < synthetic.target ? 120 : 2000);
    };
    feed();
    return;
  }
  const net = NETWORKS[network] ?? NETWORKS.mainnet;
  stream = new XrplStream({
    endpoints: net.endpoints,
    onStatus: (s) => setState(s.state, s.endpoint),
    onMessage: (msg) => {
      const kind = classifyMessage(msg);
      if (kind === 'ledger') onLedger(msg);
      else if (kind === 'transaction') onTransaction(msg);
    },
  });
  stream.connect();
}

function stop() {
  clearTimeout(stepTimer);
  clearTimeout(syntheticTimer);
  stepTimer = 0;
  syntheticTimer = 0;
  if (stream) {
    stream.close();
    stream = null;
  }
  synthetic = null;
  setState('idle', null);
}

self.onmessage = (e) => {
  const m = e.data ?? {};
  switch (m.type) {
    case 'start':
      start(m);
      break;
    case 'stop':
      stop();
      break;
    case 'sound':
      soundOn = Boolean(m.on);
      break;
    case 'describe': {
      const p = universe.planetById(m.id);
      const body = p ? bodyOf(p, { ledger: universe.currentLedger }) : null;
      post({ type: 'described', id: m.id, hover: Boolean(m.hover), text: describeBody(p, body, { ledger: universe.currentLedger, cast: m.cast ?? [] }), body, address: p?.address ?? null, domain: p?.domain ?? null, degree: p?.degree ?? 0 });
      break;
    }
    case 'coverage':
      post({ type: 'coverage', coverage: universe.coverage(), line: coverageLine(universe.coverage(), { host, synthetic: Boolean(synthetic), state }) });
      break;
    case 'memory':
      post({ type: 'memory', records: universe.records.length, planets: universe.planetCount, edges: universe.edges.size, layoutEdges: layout.ea.length, interned: universe.addresses.size, ledgers: universe.ledgers.size, liveLedgers: live.entries.length });
      break;
    default:
      break;
  }
};

post({ type: 'ready' });

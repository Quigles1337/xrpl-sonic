// UNIVERSE — the worker: the stream, the records, the layout, the events.
//
// Everything that is not drawing happens here, off the page's thread: the
// WebSocket to the public node (src/ws.js, the same client as the pages),
// the compact records and planets (src/universe/universe.js), the
// incremental layout (src/universe/layout.js), the clustering
// (src/universe/cluster.js), every transaction's events in the four-verb
// vocabulary (src/universe/events.js) with the standing objects they make
// (rocks in belts, waiting checks, beams, gates, guardian rings, moons,
// satellites), the weather of each ledger at far zoom, and every ten
// ledgers the coherence of the busiest submitters (src/coherence.js over a
// LiveWindow from src/moment.js) for pulsars and pairs in step. The page
// receives positions as a transferable Float32Array whenever the layout
// moved, and at every ledger close the planet attributes, the events of
// that ledger (each with its sound event when sound is on), the standing
// objects, the weather, the nebulae, the pairs, the domains and keys the
// labels need, and the coverage. In synthetic mode (for measuring, behind
// its flag) a seeded generator stands in for the node; in replay mode a
// recording (bench/record-stream.mjs) is fed at a chosen pace; the coverage
// line says so in both.

import { XrplStream, NETWORKS } from '../ws.js';
import { classifyMessage, txToEvent, ledgerToEvent, unwrapTransactionMessage } from '../mapping.js';
import { LiveWindow, momentFromLive } from '../moment.js';
import { caseFromState } from '../case.js';
import { frameFromLive, coherence, significant, DEFAULTS as COHERENCE_DEFAULTS } from '../coherence.js';
import { Universe, coverageLine } from './universe.js';
import { Layout } from './layout.js';
import { Clusters } from './cluster.js';
import { SyntheticStream } from './synthetic.js';
import { bodyOf, describeBody, KIND_CODES, THRESHOLDS } from './bodies.js';
import { eventsOf, collapseShowers, weatherOf, describeEvent, OBJECTS } from './events.js';
import { fetchAccountTx } from '../account-tx.js';
import { CATEGORY_BY_CODE } from './records.js';
import { forestOf } from './forest.js';
import { touchGraph, randomWalk, conservation, seriesOf, cadence, coherenceAgainst, catchOf, historyLabel, fetchRecentHistory, frameFromWindow, DEFAULTS as PROBE_DEFAULTS } from './probe.js';

const STEP_MS = 50; // layout relaxation cadence
const FRAME_MS = 120; // at most this often, positions to the page
const MAX_EVENTS_PER_LEDGER = 600;
const COHERENCE_EVERY = 10; // closed ledgers
const PROBE_PAGES = 5; // the history's pages at most, 200 entries each, one after the other
const PROBE_COUNTERPARTIES = 10; // the busiest counterparties in the coherence list
const PROBE_MATES = 8; // the busiest galaxy-mates in the coherence list
const PROBE_WALKED = 10; // the walk's nearest in the coherence list: the record's neighbourhood through the hubs
const PROBE_SHUFFLES = 100; // the null per pair in a probe: enough for the 95th, half the listening page's
const EXPLORE_PACE_MS = 250; // between an exploration's requests
const COHERENCE_TOP = 8;
const SATELLITE_MS = 24 * 3600 * 1000; // an auction slot lasts a day

let universe = new Universe();
let layout = new Layout({ capacity: 4096 });
let clusters = new Clusters();
const WINDOW_LEDGERS = 300; // the sky's live window: longer than the listening page's 50, for the probe's statistic
let windowLedgers = WINDOW_LEDGERS; // the window asked for at start (?window=N), 50..4000
let live = new LiveWindow({ max: windowLedgers });

let stream = null;
let synthetic = null;
let replay = null; // { url, pace, abort }
let syntheticTimer = 0;
let stepTimer = 0;
let soundOn = false;
let host = '';
let state = 'idle';
let lastFramePost = 0;
let moved = false;
let addedSinceLedger = [];
let domainsSinceLedger = [];
let events = []; // the events of the ledger being heard
let closedCount = 0;
let lastCloseAt = 0;
let intervalMs = 4000;
const stepStats = { steps: 0, ms: 0, moved: 0, maxMoved: 0, movedShare: 0, warm: 0, pairs: 0 };
let coherenceState = { pulsars: [], pairs: [], tested: 0, above: 0, at: null, ms: 0, window: null };
const domainsSent = new Set();
const oracleLast = new Map(); // address → ms of its last OracleSet, for the lighthouse's measured cadence
let kinds = new Uint8Array(1); // the kind of every planet at the last ledger, for ignitions
const counts = { verbs: { travel: 0, dock: 0, place: 0, happen: 0 }, objects: {}, spark: 0, tick: 0, transactions: 0 };

/** The standing objects: what persists from the event that made it until the event that removes it. */
const standing = {
  rocks: new Map(), // `${owner}:${sequence}` → { host, owner, sequence, book, price, logPrice }
  books: new Map(), // book key → { min, max } of log prices among standing rocks
  checks: new Map(), // check entry index → { from, to }
  beams: new Map(), // channel id → { a, b, width }
  gates: new Map(), // `${a}:${b}` → { a, b }
  guardians: new Map(), // planet id → { n, quorum }
  moons: new Map(), // planet id → { n, beacons }
  satellites: new Map(), // pool id → until (ms)
};

const post = (msg, transfer) => self.postMessage(msg, transfer ?? []);

function resetAll() {
  // a fresh observed universe: nothing persists in this phase (docs/universe.md, decision 2)
  universe = new Universe();
  layout = new Layout({ capacity: 4096 });
  clusters = new Clusters();
  live = new LiveWindow({ max: windowLedgers });
  addedSinceLedger = [];
  domainsSinceLedger = [];
  domainsSent.clear();
  events = [];
  closedCount = 0;
  lastCloseAt = 0;
  coherenceState = { pulsars: [], pairs: [], tested: 0, above: 0, at: null, ms: 0, window: null };
  kinds = new Uint8Array(1);
  for (const k of Object.keys(counts.verbs)) counts.verbs[k] = 0;
  counts.objects = {};
  counts.spark = counts.tick = counts.transactions = 0;
  for (const m of Object.values(standing)) m.clear();
  oracleLast.clear();
}

/** The minimal event the engine plays (R9: the fields src/audio.js reads). */
function minimalEvent(ev) {
  return { category: ev.category, sound: ev.sound, variant: ev.variant, pitch: ev.pitch, freq: ev.freq, notes: ev.notes, velocity: ev.velocity, duration: ev.duration, sub: ev.sub, timbre: ev.timbre, amountXrp: ev.amountXrp, hash: ev.hash };
}

const idOf = (address) => (address ? universe.addresses.id(address) : 0);

/** A standing object's bookkeeping for an event; returns nothing, mutates `standing`. */
function stand(e, ledger) {
  const d = e.detail ?? {};
  switch (e.object) {
    case 'rock': {
      if (!d.owner || d.sequence == null || !(d.price > 0)) return;
      const key = `${d.owner}:${d.sequence}`;
      const logPrice = Math.log10(d.price);
      standing.rocks.set(key, { host: idOf(d.hosts?.[0]) || idOf(e.to), owner: d.owner, sequence: d.sequence, book: d.book, price: d.price, logPrice, ledger });
      const b = standing.books.get(d.book) ?? { min: logPrice, max: logPrice };
      b.min = Math.min(b.min, logPrice);
      b.max = Math.max(b.max, logPrice);
      standing.books.set(d.book, b);
      return;
    }
    case 'flare':
    case 'blink':
    case 'crumble':
      if (d.owner && d.sequence != null) standing.rocks.delete(`${d.owner}:${d.sequence}`);
      return;
    case 'check-drift':
      if (e.hash) standing.checks.set(e.hash, { from: idOf(e.from), to: idOf(e.to), ledger });
      return;
    case 'check-cash':
    case 'check-cancel': {
      // the check is keyed by the hash of the CheckCreate; the stream names it by its entry id, so the one waiting between the same two planets lands
      for (const [k, c] of standing.checks) if (c.from === idOf(e.from) && c.to === idOf(e.to)) standing.checks.delete(k);
      return;
    }
    case 'beam':
      if (e.hash) standing.beams.set(e.hash, { a: idOf(e.from), b: idOf(e.to), width: 1 });
      return;
    case 'beam-fund':
      for (const b of standing.beams.values()) if (b.a === idOf(e.from) && b.b === idOf(e.to)) b.width = Math.min(4, b.width + 0.6);
      return;
    case 'beam-pulse':
      if (d.closed) for (const [k, b] of standing.beams) if (b.a === idOf(e.from) && b.b === idOf(e.to)) standing.beams.delete(k);
      return;
    case 'gate':
      if (d.open) standing.gates.set(`${e.from}:${e.to}`, { a: idOf(e.from), b: idOf(e.to) });
      else standing.gates.delete(`${e.from}:${e.to}`);
      return;
    case 'guardians':
      if (d.removed) standing.guardians.delete(idOf(e.at));
      else standing.guardians.set(idOf(e.at), { n: d.signers?.length ?? 0, quorum: d.quorum ?? 0 });
      return;
    case 'moon-form': {
      const m = standing.moons.get(idOf(e.at)) ?? { n: 0, beacons: 0 };
      m.n += 1;
      standing.moons.set(idOf(e.at), m);
      return;
    }
    case 'moon-crumble': {
      const m = standing.moons.get(idOf(e.at));
      if (m) m.n = Math.max(0, m.n - 1);
      return;
    }
    case 'moon-beacon': {
      const m = standing.moons.get(idOf(e.at)) ?? { n: 0, beacons: 0 };
      m.beacons += 1;
      standing.moons.set(idOf(e.at), m);
      return;
    }
    case 'moon-beacon-off': {
      const m = standing.moons.get(idOf(e.at));
      if (m) m.beacons = Math.max(0, m.beacons - (d.offers ?? 1));
      return;
    }
    case 'moon-capture': {
      const from = standing.moons.get(idOf(e.from));
      if (from) from.n = Math.max(0, from.n - 1);
      const to = standing.moons.get(idOf(e.to)) ?? { n: 0, beacons: 0 };
      to.n += 1;
      standing.moons.set(idOf(e.to), to);
      return;
    }
    case 'satellite':
      standing.satellites.set(idOf(e.to), performance.now() + SATELLITE_MS);
      return;
    case 'binary-collapse':
      standing.satellites.delete(idOf(e.to));
      return;
    default:
  }
}

/** The standing objects as compact arrays of ids for the page. */
function standingOut() {
  const now = performance.now();
  for (const [pool, until] of standing.satellites) if (until < now) standing.satellites.delete(pool);
  const rocks = [];
  for (const r of standing.rocks.values()) {
    const b = standing.books.get(r.book);
    const band = b && b.max > b.min ? (r.logPrice - b.min) / (b.max - b.min) : 0.5;
    rocks.push([r.host, r.owner, r.sequence, Number(band.toFixed(3)), r.price]);
  }
  return {
    rocks: rocks.slice(0, 4000),
    checks: [...standing.checks.values()].map((c) => [c.from, c.to]),
    beams: [...standing.beams.values()].map((b) => [b.a, b.b, b.width]),
    gates: [...standing.gates.values()].map((g) => [g.a, g.b]),
    guardians: [...standing.guardians].map(([planet, g]) => [planet, g.n, g.quorum]),
    moons: [...standing.moons].map(([planet, m]) => [planet, m.n, m.beacons]).filter((m) => m[1] > 0 || m[2] > 0),
    satellites: [...standing.satellites].map(([pool, until]) => [pool, until]),
  };
}

/** An event with its planets as ids, for the page; the label is left to the page, which has the name rule. */
function toIds(e) {
  return { ...e, from: idOf(e.from), to: idOf(e.to), via: (e.via ?? []).map(idOf), at: idOf(e.at), hops: e.detail?.hops ?? 0 };
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
  // the events of the transaction, in the four-verb vocabulary
  const u = unwrapTransactionMessage(msg);
  const list = eventsOf(u.tx, u.meta, { hash: u.hash, ledgerIndex: ledger, result: u.result });
  counts.transactions += 1;
  let sound = null;
  if (soundOn) {
    const ev = txToEvent(msg);
    if (ev) sound = minimalEvent(ev);
  }
  for (const e of list) {
    // planets the event names that the record did not (an escrow's destination, a check's creator) are made here so the motion has both ends
    for (const a of [e.from, e.to, e.at, ...(e.via ?? [])]) if (a && !universe.addresses.has(a)) {
      const p = universe.planet(a, ledger);
      layout.add(p.id, a, ledger);
      clusters.add(p.id);
      addedSinceLedger.push([p.id, a]);
    }
    if (e.object === 'lighthouse' && e.at) {
      const last = oracleLast.get(e.at);
      const nowMs = performance.now();
      e.detail.cadenceMs = last != null ? Math.round(nowMs - last) : null;
      oracleLast.set(e.at, nowMs);
    }
    stand(e, ledger);
    if (e.verb) counts.verbs[e.verb] += 1;
    else if (e.object === 'tick') counts.tick += 1;
    else counts.spark += 1;
    counts.objects[e.object] = (counts.objects[e.object] ?? 0) + 1;
    if (events.length < MAX_EVENTS_PER_LEDGER) {
      const out = toIds(e);
      if (sound && e === list[0]) out.sound = sound;
      events.push(out);
    }
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

/**
 * The forest (docs/universe.md, phase 2.5): every planet's parent is the
 * busiest of its counterparties with more counterparties than it (a tie to
 * the elder, the lower id, so a chain never loops); a planet with no bigger
 * counterparty is a root. Children are ranked by count, the busiest first.
 * Hands the tree to the layout and returns every node with
 * THRESHOLDS.nebulaSize or more children as a galaxy (a root) or a cluster
 * within its root's galaxy, with its subtree as the size and its disc.
 */
function galaxies() {
  const n = universe.planetCount;
  const f = forestOf({ edges: universe.edges.values(), degreeOf: (id) => universe.planets[id]?.degree ?? 0, present: (id) => Boolean(universe.planets[id]), count: n });
  const { parent, children, kids, top, depth, subtree } = f;
  for (const [node, list] of children) layout.setChildrenList(node, list.map(([child]) => child));
  for (let id = 1; id <= n; id++) {
    if (!parent[id] && layout.parent[id]) layout.setParent(id, 0, 0);
    if (!kids[id] && layout.kids[id]) layout.setChildrenList(id, []);
  }
  const ledger = universe.currentLedger ?? 0;
  const out = [];
  const galaxyRoots = new Set();
  for (let id = 1; id <= n; id++) {
    const isRoot = !parent[id];
    if (isRoot) {
      const galaxy = subtree[id] - 1 >= THRESHOLDS.nebulaSize;
      if (galaxy) galaxyRoots.add(id);
      if (Boolean(layout.galaxyRoot[id]) !== galaxy) layout.setGalaxyRoot(id, galaxy);
    }
    if (kids[id] >= THRESHOLDS.nebulaSize) {
      for (const [child] of children.get(id)) layout.touch(child, ledger);
      layout.touch(id, ledger);
      const [x, y, z] = layout.position(id);
      const disc = layout.discs.get(id);
      out.push({ root: id, core: true, depth: depth[id], parent: parent[id], top: top[id], size: subtree[id], children: kids[id], x, y, z, r: layout.discRadius(id), normal: disc?.normal ?? [0, 1, 0], u: disc?.u ?? [1, 0, 0], v: disc?.v ?? [0, 0, 1] });
    }
  }
  out.sort((a, b) => b.size - a.size);
  return { galaxies: out, coreOf: (id) => (id > 0 && id <= n && galaxyRoots.has(top[id]) ? top[id] : 0), topOf: (id) => top[id] ?? 0, depthOf: (id) => depth[id] ?? 0 };
}

/** The per-planet attributes the page draws and labels from, as typed arrays indexed by id; and the ignitions: planets whose kind became star since the last ledger. */
function attributes(ledgerIndex) {
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
  const core = new Int32Array(n + 1);
  const moons = new Uint16Array(n + 1); // NFTs the exploration counted (account_nfts), 0 until explored
  const depth = new Uint8Array(n + 1); // the planet's depth in its tree (0 a root), for the renderers' far dimming
  const keys = [];
  const ignitions = [];
  const ledger = universe.currentLedger ?? 0;
  if (kinds.length < n + 1) {
    const next = new Uint8Array(n + 1);
    next.set(kinds);
    kinds = next;
  }
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
    core[id] = forestNow ? forestNow.coreOf(id) : 0; // the galaxy root of the planet's tree, 0 outside any galaxy (the dust)
    moons[id] = Math.min(65535, p.explored?.nfts ?? 0);
    depth[id] = Math.min(255, forestNow ? forestNow.depthOf(id) : 0);
    if (b.kind === 'blackhole') keys.push([id, b.regularKey ?? null]);
    if (b.kind === 'star' && kinds[id] !== KIND_CODES.star && p.firstLedger != null && p.firstLedger < ledgerIndex) {
      const e = { verb: 'dock', object: 'ignite', category: 'trust', rule: OBJECTS.ignite.rule, hash: null, ledgerIndex, success: true, from: 0, to: id, via: [], at: id, evidence: [{ field: 'RippleState sides', value: `${b.holders} holders` }, { field: 'threshold', value: THRESHOLDS.starHolders }], detail: { holders: b.holders, threshold: THRESHOLDS.starHolders, address: p.address } };
      e.label = describeEvent({ ...e, at: p.address });
      ignitions.push(e);
      counts.verbs.dock += 1;
      counts.objects.ignite = (counts.objects.ignite ?? 0) + 1;
    }
    kinds[id] = kind[id];
  }
  return { attrs: { n, size, hue, kind, known, rings, activity, lastLedger, holders, providers, period, r100, core, moons, depth }, keys, ignitions };
}

let forestNow = null; // the forest of the last ledger, for the attributes and the probe

function postLedger(l, event) {
  const cov = universe.coverage();
  const g = galaxies();
  forestNow = g;
  const { attrs, keys, ignitions } = attributes(l.index);
  const galaxyRoots = new Set(g.galaxies.map((x) => x.root));
  const nebulae = [...g.galaxies, ...clusters.nebulae(layout).filter((nb) => !nb.members.some((id) => galaxyRoots.has(id) || g.coreOf(id))).map(({ members, ...rest }) => rest)].slice(0, 200);
  const nebulaRoots = new Set(nebulae.map((nb) => nb.root));
  const stability = stepStats.steps ? { steps: stepStats.steps, meanMs: stepStats.ms / stepStats.steps, moved: stepStats.moved / stepStats.steps, maxMoved: stepStats.maxMoved, movedShare: stepStats.movedShare / stepStats.steps, warm: Math.round(stepStats.warm / stepStats.steps), pairs: Math.round(stepStats.pairs / stepStats.steps) } : null;
  stepStats.steps = stepStats.ms = stepStats.moved = stepStats.maxMoved = stepStats.movedShare = stepStats.warm = stepStats.pairs = 0;
  // the ledger's events: showers collapsed, the ignitions added, the weather aggregated by cluster
  const ledgerEvents = [...collapseShowers(events), ...ignitions];
  // a planet's galaxy for the weather: its core's, else its union-find nebula's, else none (its events glow on it instead of flowing)
  const clusterOf = (id) => {
    if (!(id > 0)) return null;
    const core = g.coreOf(id);
    if (core && galaxyRoots.has(core)) return core;
    const root = clusters.find(id);
    return nebulaRoots.has(root) ? root : null;
  };
  const weather = weatherOf(ledgerEvents, { clusterOf, kindOf: (id) => (id > 0 && universe.planets[id] ? bodyOf(universe.planets[id]).kind : 'planet') });
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
      attrs,
      positions: layout.snapshot(),
      nebulae,
      pairs: coherenceState.pairs,
      pulsars: coherenceState.pulsars,
      coherence: { tested: coherenceState.tested, above: coherenceState.above, at: coherenceState.at, ms: coherenceState.ms, window: coherenceState.window },
      events: ledgerEvents,
      weather,
      standing: standingOut(),
      counts: { verbs: { ...counts.verbs }, objects: { ...counts.objects }, spark: counts.spark, tick: counts.tick, transactions: counts.transactions },
      coverage: cov,
      coverageLine: coverageLine(cov, { host, synthetic: Boolean(synthetic), state }) + (replay ? ' (a recording replayed, not the live stream)' : ''),
      extent: layout.extent(),
      stability,
      memory: { records: universe.records.length, planets: universe.planetCount, edges: universe.edges.size, layoutEdges: layout.ea.length, clusters: clusters.unions, hubSkips: clusters.skippedHub, interned: universe.addresses.size, rocks: standing.rocks.size, checks: standing.checks.size },
    },
    [attrs.size.buffer, attrs.hue.buffer, attrs.kind.buffer, attrs.known.buffer, attrs.rings.buffer, attrs.activity.buffer, attrs.lastLedger.buffer, attrs.holders.buffer, attrs.providers.buffer, attrs.period.buffer, attrs.r100.buffer, attrs.core.buffer, attrs.moons.buffer, attrs.depth.buffer],
  );
  addedSinceLedger = [];
  domainsSinceLedger = [];
  events = [];
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

/** Feed a recording (one raw message per line) at `pace` ms per ledger close, the transactions of a ledger at once. */
async function feedReplay(url, pace, abort) {
  let res;
  try {
    res = await fetch(url, { signal: abort.signal });
    if (!res.ok || !res.body) throw new Error(`${res.status}`);
  } catch (err) {
    post({ type: 'error', message: `replay: ${err?.message ?? err}` });
    setState('idle', null);
    return;
  }
  setState('connected', `replay:${url.split('/').pop()}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (;;) {
    const { value, done } = await reader.read();
    if (abort.signal.aborted) return;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const kind = classifyMessage(msg);
      if (kind === 'ledger') {
        onLedger(msg);
        await sleep(pace);
        if (abort.signal.aborted) return;
      } else if (kind === 'transaction') onTransaction(msg);
    }
  }
  post({ type: 'replay-done', ledgers: closedCount });
  setState('idle', null);
}

function start({ network = 'mainnet', synthetic: count = 0, seed = 1337, sound = false, perLedger = 150, replay: replayUrl = null, pace = 300, window: windowAsked = WINDOW_LEDGERS } = {}) {
  stop();
  windowLedgers = Math.min(4000, Math.max(50, Number(windowAsked) || WINDOW_LEDGERS));
  resetAll();
  soundOn = Boolean(sound);
  stepTimer = setTimeout(stepLayout, STEP_MS);
  if (replayUrl) {
    replay = { url: replayUrl, pace, abort: new AbortController() };
    host = 'replay';
    feedReplay(replayUrl, Math.max(0, Number(pace) || 0), replay.abort);
    return;
  }
  if (count > 0) {
    synthetic = new SyntheticStream({ planets: count, seed, perLedger });
    host = 'synthetic';
    setState('connected', 'synthetic');
    const feed = () => {
      for (const msg of synthetic.nextLedger()) {
        if (msg.type === 'ledgerClosed') onLedger(msg);
        else onTransaction(msg);
      }
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
  if (replay) {
    replay.abort.abort();
    replay = null;
  }
  synthetic = null;
  setState('idle', null);
}

// --- the probe ------------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (a) => (typeof a === 'string' && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

/** A planet for an address the history names, made if the sky has none (the record's counterparties become planets). */
function ensurePlanet(address, ledger) {
  if (typeof address !== 'string' || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address)) return 0;
  const had = universe.addresses.has(address) && universe.planets[universe.addresses.id(address)];
  const p = universe.planet(address, ledger);
  if (!had) {
    layout.add(p.id, address, ledger);
    clusters.add(p.id);
    addedSinceLedger.push([p.id, address]);
  }
  return p.id;
}

/** The planets nearest a planet in the layout among those touched in the last `within` ledgers, by address. */
function nearestActive(id, count, within = 120) {
  const ledger = universe.currentLedger ?? 0;
  const [x, y, z] = layout.position(id);
  const out = [];
  for (let other = 1; other <= universe.planetCount; other++) {
    if (other === id || !layout.has(other)) continue;
    const p = universe.planets[other];
    if (!p || (p.lastLedger ?? 0) < ledger - within || (p.involved ?? 0) < 3) continue; // active: seen lately, and more than a passer-by
    const [px, py, pz] = layout.position(other);
    out.push([Math.hypot(px - x, py - y, pz - z), other]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.slice(0, count).map(([, other]) => universe.addresses.string(other));
}

/**
 * The probe, in the spec's order, each step posted as it lands: the history
 * (bounded to PROBE_DEFAULTS.historyLedgers back from the ledger at the
 * hold, through the stream, paced page by page; none in a replay or a
 * synthetic sky, and the readout says so), the first-degree connections of
 * the record lit with their counts (the history's counterparties made
 * planets first), then the measures and the catch.
 */
async function probe({ id, seq = 0 }) {
  const p = universe.planetById(id);
  if (!p) {
    post({ type: 'probe-error', seq, id, message: 'no such planet' });
    return;
  }
  const t0 = performance.now();
  const address = p.address;
  const to = universe.currentLedger ?? 0;
  const from = Math.max(1, to - PROBE_DEFAULTS.historyLedgers + 1);
  let history;
  let entries = [];
  if (stream && !replay && !synthetic && to > 0) {
    // newest first, so a busy account's recent ledgers come before the bound runs out (src/universe/probe.js fetchRecentHistory, R14's seam copied)
    const r = await fetchRecentHistory((cmd) => stream.request(cmd), address, { from, to, limit: 200, maxPages: PROBE_PAGES, onPage: (page) => post({ type: 'probe-page', seq, id, pages: page.pages, entries: page.entries }) });
    entries = r.entries;
    const inWindow = entries.filter((e) => universe.ledgers.has(Number(e.ledger_index ?? e.tx?.ledger_index ?? e.tx_json?.ledger_index))).length;
    history = { from: r.oldest ?? from, to: r.newest ?? to, bound: { from, to }, records: entries.length, inWindow, more: r.more, missing: r.missing, host, pages: r.pages, requests: r.requests, error: r.error, source: 'account_tx' };
  } else {
    history = { from: null, to: null, records: 0, inWindow: null, more: false, missing: [], host: null, pages: 0, error: replay ? 'no history in a replay: the window is the record' : synthetic ? 'no history in a synthetic sky' : 'not connected: the window is the record', source: 'window' };
  }
  post({ type: 'probe-history', seq, id, history, label: historyLabel(history) });
  // the history's counterparties become planets; the record's first-degree connections, lit with counts
  const ledger = universe.currentLedger ?? 0;
  let made = 0;
  for (const e of entries) {
    const tx = e.tx ?? e.tx_json ?? {};
    for (const a of [tx.Account, tx.Destination]) if (a && a !== address && made < 200 && ensurePlanet(a, ledger) && !universe.addresses.has(a)) made += 1;
  }
  const edges = [];
  for (const e of universe.edges.values()) if (e.a === id || e.b === id) edges.push([e.a === id ? e.b : e.a, e]);
  edges.sort((x, y) => y[1].count - x[1].count);
  post({ type: 'probe-connections', seq, id, connections: edges.slice(0, 60).map(([other, e]) => ({ id: other, address: universe.addresses.string(other), count: e.count, trust: Boolean(e.trust), byCategory: Array.from(e.byCategory ?? []) })), total: edges.length });
  // the measures
  const adj = touchGraph(universe.edges.values());
  const walk = randomWalk(adj, id, { restart: PROBE_DEFAULTS.restart, iterations: PROBE_DEFAULTS.iterations });
  const cons = history.source === 'account_tx' ? conservation(entries, address) : [];
  const liveLedgers = live.ledgers;
  const series = history.source === 'account_tx' ? seriesOf(entries, address, { from: history.from, to: history.to }) : liveLedgers.map((l) => l.accounts?.[address]?.count ?? 0);
  const cad = { ...cadence(series), source: history.source === 'account_tx' ? 'its history' : 'the window' };
  const counterparties = edges.slice(0, PROBE_COUNTERPARTIES).map(([other]) => universe.addresses.string(other));
  // galaxy-mates: the busiest satellites of the probed planet's core (or of the planet itself when it is a core), a burst that touched the same hub
  // siblings: the busiest children of the probed planet's parent (or, for a root, its own busiest children)
  const around = layout.parent[id] || (layout.kids[id] ? id : 0);
  const mates = [];
  if (around) {
    for (let other = 1; other <= universe.planetCount && mates.length < 40; other++) if (other !== id && layout.parent[other] === around) mates.push([layout.rank[other], other]);
    mates.sort((a, b) => a[0] - b[0]);
  }
  const galaxyMates = mates.slice(0, PROBE_MATES).map(([, other]) => universe.addresses.string(other)).filter((a) => !counterparties.includes(a));
  // the record's neighbourhood beyond the first degree: the walk's nearest, through the hubs (a burst that touched the same pool)
  const walked = walk.ranked.slice(0, PROBE_WALKED).map((other) => universe.addresses.string(other)).filter((a) => a && !counterparties.includes(a));
  const nearest = nearestActive(id, PROBE_DEFAULTS.nearest).filter((a) => !counterparties.includes(a) && !galaxyMates.includes(a) && !walked.includes(a));
  const list = [address, ...counterparties, ...walked, ...galaxyMates.filter((a) => !walked.includes(a)), ...nearest];
  const frame = frameFromWindow(liveLedgers, list.map((a) => ({ address: a, label: short(a) })), { except: address });
  const coh = coherenceAgainst(frame, address, list.slice(1), { ...COHERENCE_DEFAULTS, shuffles: PROBE_SHUFFLES });
  const c = catchOf({
    id,
    address,
    history,
    walk,
    edgesOf: (other) => universe.edge(id, other),
    categoryNames: CATEGORY_BY_CODE,
    coherence: coh,
    conservation: cons,
    cadence: cad,
    idOf: (a) => (universe.addresses.has(a) ? universe.addresses.id(a) : 0),
    addressOf: (other) => universe.addresses.string(other),
    nearest: [...walked, ...galaxyMates, ...nearest],
  });
  c.window = { ledgers: liveLedgers.length, from: liveLedgers[0]?.index ?? null, to: liveLedgers.at(-1)?.index ?? null };
  c.ms = Math.round(performance.now() - t0);
  post({ type: 'probe-catch', seq, id, catch: c, madePlanets: made });
}

/**
 * Exploration proper: the account as the explorer loads it (R7), the root
 * and its trust lines first, then the objects (a SignerList among them
 * decides the black hole rule) and the NFTs (moons), each request paced,
 * each part posted as it lands and kept on the planet for the body rule.
 */
async function explore({ id, seq = 0 }) {
  const p = universe.planetById(id);
  if (!p) {
    post({ type: 'explore-error', seq, id, message: 'no such planet' });
    return;
  }
  if (!stream || replay || synthetic) {
    post({ type: 'explored', seq, id, part: 'none', explored: null, reason: replay ? 'no exploration in a replay' : synthetic ? 'no exploration in a synthetic sky' : 'not connected' });
    return;
  }
  const address = p.address;
  const explored = p.explored ?? { ledgerIndex: null, root: null, lines: null, fundedLines: null, objects: null, signerList: null, nfts: null, errors: {} };
  p.explored = explored;
  const ask = async (command, extra = {}) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = (await stream.request({ command, account: address, ledger_index: 'validated', ...extra })).result;
        delete explored.errors[command];
        return r;
      } catch (err) {
        explored.errors[command] = err?.code ?? err?.message ?? 'failed';
        if (attempt === 0 && (err?.code === 'tooBusy' || err?.code === 'slowDown')) {
          // the public node's quota: wait the time it states (capped at a minute), once, and say so
          const stated = Number(/retry in ~(\d+)ms/.exec(err?.message ?? '')?.[1]);
          const wait = Math.min(60000, Number.isFinite(stated) && stated > 0 ? stated + 500 : 3000);
          explored.waiting = { command, ms: wait };
          post({ type: 'explored', seq, id, part: 'waiting', explored });
          await sleep(wait);
          explored.waiting = null;
        } else return null;
      }
    }
    return null;
  };
  const info = await ask('account_info');
  if (info?.account_data) {
    explored.ledgerIndex = info.ledger_index ?? info.ledger_current_index ?? null;
    const d = info.account_data;
    explored.root = { balance: d.Balance ?? null, ownerCount: d.OwnerCount ?? 0, flags: d.Flags ?? 0, regularKey: d.RegularKey ?? null, domain: d.Domain ?? null, sequence: d.Sequence ?? null };
    if (d.Domain && !p.domain) p.domain = d.Domain;
  }
  post({ type: 'explored', seq, id, part: 'root', explored });
  await sleep(EXPLORE_PACE_MS);
  const lines = await ask('account_lines', { limit: 200 });
  if (lines?.lines) {
    explored.lines = lines.lines.length + (lines.marker ? 1 : 0); // a marker means more beyond the page: counted as "400+"
    explored.linesMore = Boolean(lines.marker);
    explored.fundedLines = lines.lines.filter((l) => l.balance && l.balance !== '0').length;
  }
  post({ type: 'explored', seq, id, part: 'lines', explored });
  await sleep(EXPLORE_PACE_MS);
  const objects = await ask('account_objects', { limit: 200 });
  if (objects?.account_objects) {
    const byType = {};
    for (const o of objects.account_objects) byType[o.LedgerEntryType] = (byType[o.LedgerEntryType] ?? 0) + 1;
    explored.objects = byType;
    explored.objectsMore = Boolean(objects.marker);
    explored.signerList = byType.SignerList > 0 ? true : objects.marker ? null : false; // null: a SignerList may be beyond the page
    explored.signers = byType.SignerList > 0 ? (objects.account_objects.find((o) => o.LedgerEntryType === 'SignerList')?.SignerEntries?.length ?? 0) : 0;
  }
  post({ type: 'explored', seq, id, part: 'objects', explored });
  await sleep(EXPLORE_PACE_MS);
  const nfts = await ask('account_nfts', { limit: 200 });
  if (nfts?.account_nfts) {
    explored.nfts = nfts.account_nfts.length;
    explored.nftsMore = Boolean(nfts.marker);
  }
  post({ type: 'explored', seq, id, part: 'nfts', explored, done: true });
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
    case 'moment': {
      const base = caseFromState({ network: m.network === 'testnet' ? 'testnet' : 'mainnet', cast: m.cast ?? [], title: m.title ?? '' });
      const c = momentFromLive({ base, window: live, question: m.question ?? '', host: host ?? '' });
      post({ type: 'moment', seq: m.seq, case: c, reason: c ? null : 'no closed ledger in the window yet' });
      break;
    }
    case 'probe':
      probe(m).catch((err) => post({ type: 'probe-error', seq: m.seq, id: m.id, message: err?.message ?? String(err) }));
      break;
    case 'explore':
      explore(m).catch((err) => post({ type: 'explore-error', seq: m.seq, id: m.id, message: err?.message ?? String(err) }));
      break;
    case 'memory':
      post({ type: 'memory', records: universe.records.length, planets: universe.planetCount, edges: universe.edges.size, layoutEdges: layout.ea.length, interned: universe.addresses.size, ledgers: universe.ledgers.size, liveLedgers: live.entries.length, rocks: standing.rocks.size });
      break;
    default:
      break;
  }
};

post({ type: 'ready' });

#!/usr/bin/env node
// UNIVERSE phase 1 — the hour's distributions behind the thresholds.
//
// Runs the observed universe in Node against the live stream for a while and
// records, for the document, the distributions the body thresholds cut:
// holders per issuer (star ≥ 3), distinct counterparties per planet (hub >
// 40), cluster sizes (nebula ≥ 5, edges ≥ 2), balances seen, open offers per
// planet, the cadences the coherence of the top submitters finds (pulsar: a
// period ≥ 2 at r ≥ 0.3), the body kinds over time, the share of Batch and
// inner-batch transactions, and the planets with an on-ledger Domain. Writes
// the JSON every five minutes.
//
//   node src/universe/bench/distributions.mjs [--minutes 60] [--out path.json] [--network mainnet|testnet]

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { XrplStream, NETWORKS } from '../../ws.js';
import { classifyMessage } from '../../mapping.js';
import { LiveWindow } from '../../moment.js';
import { frameFromLive, coherence, significant, DEFAULTS as COHERENCE_DEFAULTS } from '../../coherence.js';
import { Universe } from '../universe.js';
import { Clusters } from '../cluster.js';
import { bodyOf, STAR_HOLDERS } from '../bodies.js';
import { DEFAULTS as CLUSTER_DEFAULTS } from '../cluster.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};
const minutes = Math.max(1, Number(opt('minutes', 60)) || 60);
const out = opt('out', 'src/universe/bench/results/distributions-mainnet.json');
const network = NETWORKS[opt('network', 'mainnet')];
if (!network || typeof globalThis.WebSocket !== 'function') {
  console.error('needs a known network and Node 22+');
  process.exit(2);
}
mkdirSync(dirname(out), { recursive: true });

const universe = new Universe();
const clusters = new Clusters();
const live = new LiveWindow();
const startedAt = Date.now();
let closed = 0;
let batch = 0;
let inner = 0;
let endpoint = null;
const kindsOverTime = []; // every 5 ledgers: { ledger, minute, planets, kinds }
const cadences = new Map(); // address → { period, r } last seen
const pairsInStep = new Set();
let coherenceRuns = 0;
let coherenceMs = 0;

const histogram = (values, edges) => {
  const labels = edges.map((e, i) => (i + 1 < edges.length ? `${e}–${edges[i + 1] - 1}` : `${e}+`));
  const counts = new Array(edges.length).fill(0);
  for (const v of values) {
    let k = 0;
    for (let i = 0; i < edges.length; i++) if (v >= edges[i]) k = i;
    if (v >= edges[0]) counts[k] += 1;
  }
  return Object.fromEntries(labels.map((l, i) => [l, counts[i]]));
};
const quantiles = (values, qs = [0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) => {
  const v = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return Object.fromEntries(qs.map((q) => [`p${Math.round(q * 100)}`, v[Math.min(v.length - 1, Math.floor(q * v.length))]]));
};

function snapshot(final = false) {
  const planets = universe.planets.filter(Boolean);
  const kinds = {};
  for (const p of planets) {
    const k = bodyOf(p, { ledger: universe.currentLedger }).kind;
    kinds[k] = (kinds[k] ?? 0) + 1;
  }
  const issuers = planets.filter((p) => p.holders?.size);
  const groups = clusters.groups({ minSize: 2 });
  const cov = universe.coverage();
  const summary = {
    network: opt('network', 'mainnet'),
    endpoint,
    startedAt: new Date(startedAt).toISOString(),
    elapsedMinutes: Number(((Date.now() - startedAt) / 60000).toFixed(2)),
    final,
    thresholds: { starHolders: STAR_HOLDERS, hubDegree: CLUSTER_DEFAULTS.hubDegree, clusterEdge: CLUSTER_DEFAULTS.minEdge, nebulaSize: CLUSTER_DEFAULTS.minSize, pulsarLeast: 0.3, pulsarMinPeriod: 2, coherenceTop: 8 },
    coverage: { ledgersClosed: cov.ledgersClosed, expected: cov.expected, received: cov.received, share: cov.share, transactions: cov.transactions, dupes: cov.dupes, failed: cov.failed },
    planets: planets.length,
    kinds,
    holdersPerIssuer: { issuers: issuers.length, atOrAboveStar: issuers.filter((p) => p.holders.size >= STAR_HOLDERS).length, histogram: histogram(issuers.map((p) => p.holders.size), [1, 2, 3, 5, 10, 50, 200]), quantiles: quantiles(issuers.map((p) => p.holders.size)) },
    degree: { histogram: histogram(planets.map((p) => p.degree), [0, 1, 2, 3, 5, 10, 41, 200, 1000]), hubs: planets.filter((p) => p.degree > CLUSTER_DEFAULTS.hubDegree).length, quantiles: quantiles(planets.map((p) => p.degree)), top: planets.slice().sort((a, b) => b.degree - a.degree).slice(0, 5).map((p) => ({ degree: p.degree, kind: bodyOf(p).kind, submitted: p.submitted, involved: p.involved })) },
    clusters: { groupsOfTwoOrMore: groups.length, nebulae: groups.filter((g) => g.size >= CLUSTER_DEFAULTS.minSize).length, histogram: histogram(groups.map((g) => g.size), [2, 3, 5, 10, 50, 200]), largest: groups[0]?.size ?? 0, unions: clusters.unions, hubSkips: clusters.skippedHub, planetsInNebulae: groups.filter((g) => g.size >= CLUSTER_DEFAULTS.minSize).reduce((a, g) => a + g.size, 0) },
    balances: { known: planets.filter((p) => p.balanceDrops != null).length, unknown: planets.filter((p) => p.balanceDrops == null).length, xrpQuantiles: quantiles(planets.filter((p) => p.balanceDrops != null).map((p) => p.balanceDrops / 1e6)), histogramXrp: histogram(planets.filter((p) => p.balanceDrops != null).map((p) => p.balanceDrops / 1e6), [0, 1, 10, 100, 1000, 10000, 100000, 1000000, 10000000]) },
    openOffers: { planetsWithOpen: planets.filter((p) => p.openOffers > 0).length, histogram: histogram(planets.filter((p) => p.openOffers > 0).map((p) => p.openOffers), [1, 2, 5, 10, 50, 200]) },
    minted: planets.filter((p) => p.minted > 0).length,
    domains: planets.filter((p) => p.domain).length,
    born: planets.filter((p) => p.created).length,
    collapsed: planets.filter((p) => p.deleted).length,
    pools: planets.filter((p) => p.ammId).length,
    blackholeCandidates: kinds.blackhole ?? 0,
    cadences: { accountsJudged: cadences.size, histogram: histogram([...cadences.values()].filter(Boolean).map((c) => c.period), [2, 3, 4, 5, 8]), withCadence: [...cadences.values()].filter(Boolean).length, pairsInStepEver: pairsInStep.size, runs: coherenceRuns, meanMs: coherenceRuns ? Math.round(coherenceMs / coherenceRuns) : null },
    batch: { outer: batch, inner, shareOfTransactions: cov.transactions ? Number((batch / cov.transactions).toFixed(3)) : null },
    recordsKept: universe.records.length,
    kindsOverTime,
  };
  writeFileSync(out, JSON.stringify(summary, null, 2));
  return summary;
}

function runCoherence() {
  const t0 = performance.now();
  try {
    const frame = frameFromLive(live, { topK: 8 });
    const report = coherence(frame, { ...COHERENCE_DEFAULTS, topK: 8 });
    for (const pair of report.pairs ?? []) {
      for (const side of ['a', 'b']) {
        const address = pair[side]?.address;
        if (!address) continue;
        const cad = pair.cadence?.[side];
        cadences.set(address, cad && cad.period >= 2 ? { period: cad.period, r: cad.r } : null);
        const p = universe.addresses.has(address) ? universe.planet(address) : null;
        if (p) p.cadence = cad && cad.period >= 2 ? { period: cad.period, r: cad.r } : null;
      }
      if (pair.judged && significant(pair)) pairsInStep.add(`${pair.a.address}|${pair.b.address}`);
    }
  } catch (err) {
    console.error(`coherence: ${err?.message ?? err}`);
  }
  coherenceRuns += 1;
  coherenceMs += performance.now() - t0;
}

const stream = new XrplStream({
  endpoints: network.endpoints,
  onStatus: (s) => {
    endpoint = s.endpoint;
    console.error(`[status] ${s.state} ${s.endpoint}${s.error ? ` — ${s.error}` : ''}`);
  },
  onMessage: (msg) => {
    const kind = classifyMessage(msg);
    if (kind === 'ledger') {
      universe.noteLedger(msg);
      live.noteLedger(msg);
      closed += 1;
      if (closed % 10 === 0) runCoherence();
      if (closed % 5 === 0) {
        const kinds = {};
        for (const p of universe.planets) if (p) kinds[bodyOf(p, { ledger: universe.currentLedger }).kind] = (kinds[bodyOf(p, { ledger: universe.currentLedger }).kind] ?? 0) + 1;
        kindsOverTime.push({ ledger: universe.currentLedger, minute: Number(((Date.now() - startedAt) / 60000).toFixed(1)), planets: universe.planetCount, kinds });
      }
      return;
    }
    if (kind !== 'transaction') return;
    const tx = msg.tx_json ?? msg.transaction;
    const r = universe.noteTransaction(msg);
    if (!r) return;
    if (tx?.TransactionType === 'Batch') batch += 1;
    if (((Number(tx?.Flags) || 0) >>> 0) & 0x40000000) inner += 1;
    for (const id of r.newPlanets) clusters.add(id);
    for (const e of r.edges) if (e) clusters.consider(e.a, e.b, e.count, universe.planets[e.a].degree, universe.planets[e.b].degree);
    live.noteTransaction(msg);
  },
});
stream.connect();
const timer = setInterval(() => {
  const s = snapshot(false);
  console.error(`[${s.elapsedMinutes} min] planets ${s.planets} · kinds ${JSON.stringify(s.kinds)} · issuers ${s.holdersPerIssuer.issuers} (stars ${s.holdersPerIssuer.atOrAboveStar}) · hubs ${s.degree.hubs} · nebulae ${s.clusters.nebulae} · coverage ${s.coverage.share == null ? '?' : (s.coverage.share * 100).toFixed(2) + '%'}`);
  if (s.elapsedMinutes >= minutes) {
    clearInterval(timer);
    stream.close();
    snapshot(true);
    console.error(`done: ${out}`);
    setTimeout(() => process.exit(0), 200);
  }
}, 5 * 60000);
process.on('SIGINT', () => {
  snapshot(true);
  process.exit(0);
});

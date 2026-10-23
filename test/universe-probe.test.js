// UNIVERSE phase 2 — the probe's measures on recorded fixtures, the UFO's gestures and store.
//
// The histories in test/universe-fixtures/probe/ were recorded verbatim from
// a public node (bench/fetch-probe-fixtures.mjs); expected.json beside them
// holds what the measures made of them (bench/probe-expected.mjs). The
// tests pin those numbers and the properties the measures must have
// regardless: a walk's mass sums to one, exact strings never pass through a
// Number, no label says "coordinated".

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { touchGraph, randomWalk, conservation, flowsOf, seriesOf, cadence, catchOf, describeCatch, historyLabel, proximityLabel, connectionLabel, conservationLabel, cadenceLabel, coherenceLabel, coherenceAgainst, PHASE3, DEFAULTS } from '../src/universe/probe.js';
import { UfoGestures, loadUfoState, saveUfoState, STORAGE_KEY, UFO_SENTENCE, DOUBLE_MS } from '../src/universe/ufo.js';
import { frameFromLive, DEFAULTS as COHERENCE_DEFAULTS } from '../src/coherence.js';
import { LiveWindow } from '../src/moment.js';
import { unwrapEntry } from '../src/account-tx.js';

const DIR = new URL('./universe-fixtures/probe/', import.meta.url);
const read = (f) => JSON.parse(readFileSync(new URL(f, DIR), 'utf8'));
const fixtures = readdirSync(DIR).filter((f) => f.startsWith('account_tx-') && f.endsWith('.json')).sort();
const expected = read('expected.json');
const entriesOf = (f) => f.responses.flatMap((r) => r.result?.transactions ?? []);

describe('the touch graph and the walk', () => {
  const adj = touchGraph([
    { a: 1, b: 2, count: 5 },
    { a: 1, b: 3, count: 1 },
    { a: 2, b: 4, count: 2 },
    { a: 3, b: 4, count: 1 },
    { a: 5, b: 6, count: 9 },
    { a: 7, b: 7, count: 3 },
    { a: 8, b: 9, count: 0 },
  ]);
  test('each pair once in both directions, self-pairs and zero counts dropped', () => {
    assert.deepEqual(adj.get(1), [[2, 5], [3, 1]]);
    assert.deepEqual(adj.get(4), [[2, 2], [3, 1]]);
    assert.equal(adj.has(7), false);
    assert.equal(adj.has(8), false);
  });
  test('the walk with restart: mass sums to one, stays in the component, ranks the busier neighbour first', () => {
    const w = randomWalk(adj, 1, { restart: 0.15, iterations: 60 });
    const sum = [...w.scores.values()].reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `sum ${sum}`);
    assert.equal(w.scores.has(5), false);
    assert.equal(w.ranked[0], 2);
    assert.equal(w.reached, 3);
    assert.match(proximityLabel(w, 2), /^record proximity 0\.\d+, rank 1 of 3$/);
    assert.equal(proximityLabel(w, 5), 'record proximity 0: not reached by the walk');
    assert.equal(w.restart, 0.15);
  });
  test('a start the graph does not know walks nowhere', () => {
    const w = randomWalk(adj, 99);
    assert.equal(w.reached, 0);
    assert.equal(w.scores.size, 0);
  });
  test('the walk is deterministic', () => {
    const a = randomWalk(adj, 1);
    const b = randomWalk(adj, 1);
    assert.deepEqual([...a.scores], [...b.scores]);
  });
});

describe('flow conservation and cadence on the recorded histories', () => {
  test('there is at least one recorded history and expected numbers for each', () => {
    assert.ok(fixtures.length >= 1, 'record a history with bench/fetch-probe-fixtures.mjs');
    for (const f of fixtures) assert.ok(expected.accounts[read(f).account], `${f} has no expected numbers: run bench/probe-expected.mjs`);
  });
  for (const file of fixtures) {
    const f = read(file);
    const entries = entriesOf(f);
    const exp = expected.accounts[f.account];
    test(`${f.account}: the conservation rows match expected.json, exact strings end to end`, () => {
      const rows = conservation(entries, f.account);
      assert.equal(rows.length, exp.conservation.length);
      rows.forEach((r, i) => {
        const e = exp.conservation[i];
        assert.equal(r.currency, e.currency);
        assert.equal(r.inflow, e.inflow);
        assert.equal(r.outflow, e.outflow);
        assert.equal(r.difference, e.difference);
        assert.equal(r.lag, e.lag);
        assert.equal(r.transactions, e.transactions);
        assert.equal(conservationLabel(r), e.label);
        assert.match(r.inflow, /^-?\d+(\.\d+)?$/);
        assert.match(r.outflow, /^-?\d+(\.\d+)?$/);
        assert.doesNotMatch(r.inflow, /e/i);
      });
    });
    test(`${f.account}: the XRP row includes fees in the outflow and says so; every successful transaction's deltas are counted once`, () => {
      const rows = conservation(entries, f.account);
      const xrp = rows.find((r) => r.currency === 'XRP');
      assert.ok(xrp);
      assert.equal(xrp.feesIncluded, true);
      assert.match(conservationLabel(xrp), /fees included/);
      const flows = flowsOf(entries, f.account);
      let counted = 0;
      for (const flow of flows.values()) for (const row of flow.byLedger.values()) counted += row.transactions;
      assert.equal(counted, rows.reduce((n, r) => n + r.transactions, 0));
    });
    test(`${f.account}: the account's own series and cadence match expected.json`, () => {
      const s = seriesOf(entries, f.account, exp.bound);
      assert.equal(s.length, exp.bound.to - exp.bound.from + 1);
      const c = cadence(s);
      assert.equal(c.period, exp.cadence.period);
      assert.equal(c.events, exp.cadence.events);
      assert.equal(cadenceLabel(c), exp.cadence.label);
      if (c.period != null) assert.ok(c.period >= 2 && c.r >= 0.3, 'a cadence is a lag of two or more at r ≥ 0.3');
    });
  }
  test('a short or flat series has no cadence and says why', () => {
    assert.equal(cadence([1, 0, 1]).reason, 'too few ledgers');
    assert.equal(cadence(new Array(20).fill(0)).reason, 'too few events');
    assert.equal(cadence(new Array(20).fill(3)).reason, 'flat');
    assert.match(cadenceLabel(cadence([1, 0, 1])), /^no cadence: too few ledgers/);
  });
  test('an empty history conserves nothing', () => {
    assert.deepEqual(conservation([], 'rrrrrrrrrrrrrrrrrrrrrhoLvTp'), []);
    assert.deepEqual(seriesOf([], 'rrrrrrrrrrrrrrrrrrrrrhoLvTp', { from: 5, to: 9 }), [0, 0, 0, 0, 0]);
  });
});

describe('coherence against a named list', () => {
  // a live window built from a recorded history: the probed account and its busiest counterparties as the list
  const file = fixtures[0];
  const f = read(file);
  const entries = entriesOf(f);
  const live = new LiveWindow({ max: 4000 });
  const byLedger = new Map();
  for (const e of entries) {
    const li = unwrapEntry(e).ledgerIndex;
    (byLedger.get(li) ?? byLedger.set(li, []).get(li)).push(e);
  }
  for (const [index, list] of [...byLedger].sort((a, b) => a[0] - b[0])) {
    for (const e of list) live.noteTransaction({ type: 'transaction', validated: true, ledger_index: index, transaction: e.tx ?? e.tx_json, meta: e.meta, engine_result: e.meta?.TransactionResult });
    live.noteLedger({ type: 'ledgerClosed', ledger_index: index, ledger_hash: 'A'.repeat(64), txn_count: list.length, ledger_time: 700000000 + index * 4 });
  }
  const counter = new Map();
  for (const e of entries) {
    const tx = e.tx ?? e.tx_json;
    for (const a of [tx?.Account, tx?.Destination]) if (a && a !== f.account) counter.set(a, (counter.get(a) ?? 0) + 1);
  }
  const others = [...counter].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([a]) => a);
  test('frameFromLive takes the list as its cast (R4 served) and the pairs are the probed account against each other', () => {
    const frame = frameFromLive(live, { cast: [f.account, ...others].map((address) => ({ address, label: address.slice(0, 6) })) });
    assert.equal(frame.accounts.length, 1 + others.length);
    const c = coherenceAgainst(frame, f.account, others, { ...COHERENCE_DEFAULTS, shuffles: 40 });
    assert.equal(c.pairs.length, others.length);
    for (const p of c.pairs) {
      assert.ok([p.a.address, p.b.address].includes(f.account));
      assert.equal(p.tested, c.tested);
      const label = coherenceLabel(p);
      assert.doesNotMatch(label, /coordinat/i);
      if (p.judged) assert.match(label, /pairs? tested · (connected in the record: \d+|not touching|record not available)$/);
      else assert.match(label, /^not judged: /);
    }
  });
  test('an account the frame does not carry measures nothing', () => {
    const frame = frameFromLive(live, { cast: others.map((address) => ({ address, label: address })) });
    assert.deepEqual(coherenceAgainst(frame, f.account, others), { pairs: [], tested: 0, significant: 0 });
  });
});

describe('the catch and its words', () => {
  const adj = touchGraph([
    { a: 1, b: 2, count: 5 },
    { a: 1, b: 3, count: 1 },
    { a: 2, b: 4, count: 2 },
  ]);
  const walk = randomWalk(adj, 1);
  const edges = new Map([
    [2, { a: 1, b: 2, count: 5, byCategory: [3, 0, 2, 0, 0, 0, 0, 0], trust: true }],
    [3, { a: 1, b: 3, count: 1, byCategory: [1, 0, 0, 0, 0, 0, 0, 0], trust: false }],
  ]);
  const names = ['payment', 'trust', 'offer', 'nft', 'escrow', 'amm', 'batch', 'other'];
  const c = catchOf({
    id: 1,
    address: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp',
    history: { from: 100, to: 200, records: 12, inWindow: 5, more: false, missing: [], host: 'wss://example' },
    walk,
    edgesOf: (pid) => edges.get(pid) ?? null,
    categoryNames: names,
    coherence: { pairs: [], tested: 0, significant: 0 },
    conservation: [{ currency: 'XRP', issuer: null, inflow: '10', outflow: '12', difference: '2', within: 2 / 12, lag: 1, ledgers: 3, transactions: 4, feesIncluded: true }],
    cadence: { period: 2, r: 0.5, events: 20, ledgers: 40, reason: null },
    idOf: () => 0,
    addressOf: (pid) => `r${pid}`,
  });
  test('the lit planets follow the walk, each with the five slots, the phase 3 slots present and unmeasured', () => {
    assert.deepEqual(c.lit.map((l) => l.id), [2, 4, 3], 'the walk’s order: the busiest neighbour, then what it reaches through it');
    for (const l of c.lit) {
      assert.deepEqual(Object.keys(l.labels), ['connection', 'proximity', 'coherence', 'influence', 'motif']);
      assert.equal(l.labels.influence, PHASE3);
      assert.equal(l.labels.motif, PHASE3);
    }
    assert.equal(c.lit[0].labels.connection, 'connected in the record: 5 transactions (3 payment, 2 offer) · a trust line between them');
    assert.equal(c.lit[1].labels.connection, 'not connected in the record');
    assert.equal(c.lit[2].labels.connection, 'connected in the record: 1 transaction (1 payment)');
    assert.equal(c.lit[0].touching, true);
    assert.equal(c.lit[1].touching, false);
    assert.equal(c.head.influence, PHASE3);
    assert.equal(c.head.motif, PHASE3);
    assert.equal(c.tiers.coherence, 'observation');
    assert.equal(c.tiers.proximity, 'calculated');
  });
  test('the history line states the bound, the records and the window share', () => {
    assert.equal(historyLabel(c.history), 'ledgers #100–#200, 12 records, 5 of them in the window · from wss://example');
    assert.equal(historyLabel(null), 'history not loaded');
    assert.match(historyLabel({ from: 1, to: 2, records: 1, more: true, missing: [{}] }), /1 record, more beyond the bound, 1 span missing$/);
  });
  test('the text equivalent: one line per lit planet after the head, nothing says coordinated', () => {
    const lines = describeCatch(c, (id, address) => (id === 1 ? 'the probed' : address));
    assert.equal(lines.length, 1 + 1 + 1 + 1 + 1 + 3);
    assert.match(lines[0], /^probe: the probed \(rrrrrrrrrrrrrrrrrrrrrhoLvTp\) · ledgers #100–#200/);
    assert.match(lines[1], /^flow: inflow 10 drops, outflow 12 drops, within 16\.7% of the larger at a lag of 1 ledger/);
    assert.match(lines[2], /^cadence: every 2 ledgers/);
    assert.equal(lines[3], `influence →: ${PHASE3} · motif: ${PHASE3}`);
    for (const l of lines) assert.doesNotMatch(l, /coordinat/i);
  });
  test('the labels alone', () => {
    assert.equal(connectionLabel(null, names), 'not connected in the record');
    assert.equal(conservationLabel({ currency: 'USD', issuer: 'rIss', inflow: '5', outflow: '5', difference: '0', within: 0, lag: 0, ledgers: 1, transactions: 2, feesIncluded: false }), 'inflow 5 USD, outflow 5 USD, equal at a lag of 0 ledgers, over 1 ledger and 2 transactions · issuer rIss');
    assert.equal(conservationLabel({ currency: 'USD', issuer: null, inflow: '0', outflow: '0', difference: '0', within: null, lag: null, ledgers: 0, transactions: 0, feesIncluded: false }), 'inflow 0 USD, outflow 0 USD, nothing moved, over 0 ledgers and 0 transactions');
    assert.equal(coherenceLabel({ judged: false, reason: 'fewer than 12 ledgers' }), 'not judged: fewer than 12 ledgers');
    assert.equal(DEFAULTS.restart, 0.15);
  });
});

describe('the UFO', () => {
  test('the sentence names every gesture', () => {
    for (const w of ['double right-click', 'press U', 'two fingers']) assert.ok(UFO_SENTENCE.includes(w), w);
  });
  test('a double right-click toggles: by the browser count, or by two presses within the interval; a single press does not', () => {
    let t = 0;
    let toggles = 0;
    const g = new UfoGestures({ onToggle: () => (toggles += 1), now: () => t });
    assert.equal(g.mousedown({ button: 0, detail: 2 }), false);
    assert.equal(g.mousedown({ button: 2, detail: 1 }), true);
    assert.equal(toggles, 0);
    t = DOUBLE_MS + 1;
    g.mousedown({ button: 2, detail: 1 });
    assert.equal(toggles, 0, 'too slow');
    t += 100;
    g.mousedown({ button: 2, detail: 1 });
    assert.equal(toggles, 1, 'the second within the interval');
    t += 5000;
    g.mousedown({ button: 2, detail: 2 });
    assert.equal(toggles, 2, 'the browser counted the double');
  });
  test('a two-finger double-tap toggles; one finger does not count', () => {
    let t = 0;
    let toggles = 0;
    const g = new UfoGestures({ onToggle: () => (toggles += 1), now: () => t });
    assert.equal(g.touchstart({ touches: [1] }), false);
    assert.equal(g.touchstart({ touches: [1, 2] }), true);
    t = 200;
    g.touchstart({ touches: [1, 2] });
    assert.equal(toggles, 1);
  });
  test('the store: defaults when empty or broken, round trip under the sky’s own key', () => {
    const mem = new Map();
    const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
    assert.deepEqual(loadUfoState(storage), { ufo: true, captionShown: false });
    assert.equal(saveUfoState({ ufo: false, captionShown: true }, storage), true);
    assert.deepEqual(loadUfoState(storage), { ufo: false, captionShown: true });
    assert.ok(mem.has(STORAGE_KEY));
    assert.equal(mem.has('xrpl-sonic:settings:v2'), false, 'never the listening page’s key');
    mem.set(STORAGE_KEY, '{not json');
    assert.deepEqual(loadUfoState(storage), { ufo: true, captionShown: false });
    assert.deepEqual(loadUfoState(null), { ufo: true, captionShown: false });
  });
});

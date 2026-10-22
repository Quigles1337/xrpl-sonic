// The interference field (src/field.js, docs/coherence.md phase 2): which
// pairs draw, the fringe function from the three numbers of a line, the
// sources and the grid, the fringe lines, the labels, the click, the budget
// rule, and the sentence when nothing is drawn; on the phase 1 synthetic
// trains and on the recorded 1000-ledger account_tx window.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { coherence, seededRandom, significant, describePair } from '../src/coherence.js';
import { uncovered } from '../src/account-tx.js';
import { shortAddress } from '../src/mapping.js';
import { normalizeCast } from '../src/cast.js';
import { FIELD_MODES, CELL_SIZES, BUDGET, TAPER, HIT_LEAST, hslToRgb, colourOf, fieldPairs, carrierOf, fringe, fieldLabel, fieldSummary, fieldModel, fieldLayout, fieldGrid, fringeLines, labelPoint, fieldHit, nextCell, beatPhase } from '../src/field.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const A = 'rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah';
const B = 'rKYdJJLAgxbJcn9Ria2X5jMMiqP91r4qy';
const C = 'r33SNW2rSBkXGmn84FSKSY4RG4FJ7fUVhk';

function train(n, seed, { base = 3, spread = 6 } = {}) {
  const rand = seededRandom(seed);
  return Array.from({ length: n }, () => Math.max(0, Math.round(base + (rand() - 0.5) * spread)));
}
function frameOf(series, { missing = [], labels = {}, records = [] } = {}) {
  const n = Math.max(...Object.values(series).map((s) => s.length));
  const ledgers = Array.from({ length: n }, (_, i) => ({ index: 1000 + i, included: !missing.includes(i), reason: missing.includes(i) ? 'missing' : null, hash: null, closeTime: 1_700_000_000 + i * 4 }));
  const totals = new Map(Object.entries(series).map(([a, s]) => [a, s.reduce((x, y, i) => x + (ledgers[i].included ? y : 0), 0)]));
  const accounts = Object.keys(series).map((address) => ({ address, label: labels[address] ?? shortAddress(address) }));
  return { source: 'score', measure: 'count', unit: 'ledger', bin: null, ledgers, accounts, series: new Map(Object.entries(series)), totals, chosen: 'cast', records };
}
const cast = normalizeCast([{ address: A, label: 'A' }, { address: B, label: 'B' }, { address: C, label: 'C' }]);
const lockstep = () => {
  const a = train(60, 1);
  return coherence(frameOf({ [A]: a, [B]: a.slice(), [C]: train(60, 9) }, { labels: { [A]: 'A', [B]: 'B', [C]: 'C' } }));
};

describe('field: which pairs draw', () => {
  test('a lockstep pair clears the bar and draws; an uncorrelated pair does not; off draws nothing; pair mode draws the chosen pair only', () => {
    const report = lockstep();
    const ab = report.pairs.find((p) => p.a.label === 'A' && p.b.label === 'B');
    assert.equal(significant(ab), true);
    assert.deepEqual(fieldPairs(report, { mode: 'cast' }).map((p) => `${p.a.label}${p.b.label}`), ['AB']);
    assert.deepEqual(fieldPairs(report, { mode: 'off' }), []);
    assert.deepEqual(fieldPairs(report, { mode: 'pair', pair: [B, A] }).map((p) => `${p.a.label}${p.b.label}`), ['AB'], 'either order');
    assert.deepEqual(fieldPairs(report, { mode: 'pair', pair: [A, C] }), [], 'the chosen pair is below the bar');
    assert.deepEqual(fieldPairs(null, { mode: 'cast' }), []);
    assert.deepEqual(FIELD_MODES, ['off', 'cast', 'pair']);
  });

  test('a null that cannot resolve the 95th keeps a pair off the field: 20 ledgers give 7 shifts', () => {
    const a = train(20, 2);
    const report = coherence(frameOf({ [A]: a, [B]: a.slice() }, { labels: { [A]: 'A', [B]: 'B' } }));
    const p = report.pairs[0];
    assert.ok(p.white.shuffle.count < 20 && p.white.shuffle.percentile === 1, 'above every shift it has, but too few of them');
    assert.deepEqual(fieldPairs(report), []);
    assert.match(fieldSummary(report, [], { mode: 'cast', hasCast: true }), /^field: nothing drawn · 1 pair tested, 0 above the 95th prewhitened · 1 with fewer than 20 shifts, where the 95th cannot be resolved$/);
  });

  test('two independent series with the same period draw nothing; a lag planted on top of the shared period draws at its lag', () => {
    const n = 120;
    const period = 6;
    const noise = (seed) => {
      const rand = seededRandom(seed);
      return Array.from({ length: n }, () => (rand() - 0.5) * 2);
    };
    const series = (noiseOf) => Array.from({ length: n }, (_, i) => Math.max(0, Math.round(4 + 3 * (i % period === 0 ? 1 : 0) + noiseOf(i) * 1.5)));
    const noiseA = noise(11);
    const noiseB = noise(12);
    const a = series((i) => noiseA[i]);
    const independent = coherence(frameOf({ [A]: a, [B]: series((i) => noiseB[i]) }, { labels: { [A]: 'A', [B]: 'B' } }));
    assert.deepEqual(fieldPairs(independent), [], 'a shared period alone is not a relation');
    const planted = coherence(frameOf({ [A]: a, [B]: series((i) => noiseA[(i - 3 + n) % n]) }, { labels: { [A]: 'A', [B]: 'B' } }));
    const drawn = fieldPairs(planted);
    assert.equal(drawn.length, 1);
    assert.equal(drawn[0].white.lag, 3, 'B follows A by the planted three');
  });
});

describe('field: the fringe function', () => {
  test('visibility from r, the bright fringe at the lag, a single lobe one lag wide with no cadence, nothing beyond ±(L + 1)', () => {
    const p = { white: { r: 0.8, lag: 2 }, beat: null, maxLag: 8 };
    assert.deepEqual(carrierOf(p), { kind: 'lobe', p: null, q: null, every: null });
    assert.ok(Math.abs(fringe(p, 2) - 0.8) < 1e-12, 'the peak is r, at the lag');
    assert.ok(Math.abs(fringe(p, 2.5)) < 1e-12, 'zero half a lag away');
    assert.ok(Math.abs(fringe(p, 3) + 0.8) < 1e-12, 'a dark flank one lag away');
    assert.equal(fringe(p, 4), 0, 'the lobe ends at 1.5 lags');
    assert.equal(fringe(p, 0), 0);
    assert.equal(fringe({ white: { r: 0.8, lag: 8 }, beat: null, maxLag: 8 }, 8 + TAPER + 0.1), 0, 'beyond the measured lags there is nothing');
    assert.ok(fringe({ white: { r: 0.8, lag: 8 }, beat: null, maxLag: 8 }, 8.5) > 0 && fringe({ white: { r: 0.8, lag: 8 }, beat: null, maxLag: 8 }, 8.5) < 0.8, 'tapering');
    assert.ok(fringe({ white: { r: -0.6, lag: 0 }, beat: null, maxLag: 8 }, 0) < 0, 'a negative r darkens where it would brighten');
  });

  test('a shared cadence gives the spacing; a mismatch gives two carriers whose envelope advances with the phase', () => {
    const shared = { white: { r: 0.5, lag: 1 }, beat: { shared: 3 }, maxLag: 8 };
    assert.equal(carrierOf(shared).kind, 'shared');
    assert.ok(Math.abs(fringe(shared, 1) - 0.5) < 1e-12);
    assert.ok(Math.abs(fringe(shared, 4) - 0.5) < 1e-12, 'repeats every three lags');
    assert.ok(Math.abs(fringe(shared, 2.5) + 0.5) < 1e-12, 'anti-phase between');
    const beat = { white: { r: 0.5, lag: 0 }, beat: { periods: [3, 4], every: 12 }, maxLag: 8 };
    assert.deepEqual(carrierOf(beat), { kind: 'beat', p: 3, q: 4, every: 12 });
    assert.ok(Math.abs(fringe(beat, 0) - 0.5) < 1e-12, 'both carriers peak at the lag when the phase is 0');
    assert.ok(Math.abs(fringe(beat, 0, Math.PI)) < 1e-12, 'half a beat later they cancel there');
    assert.equal(beatPhase({ pairs: [{ carrier: carrierOf(beat) }] }, 0), 0);
    assert.ok(Math.abs(beatPhase({ pairs: [{ carrier: carrierOf(beat) }] }, 12 * 4) - 0) < 1e-9, 'the envelope recurs every 12 lags of 4 s');
    assert.ok(Math.abs(beatPhase({ pairs: [{ carrier: carrierOf(beat) }] }, 24) - Math.PI) < 1e-9);
    assert.equal(beatPhase({ pairs: [{ carrier: carrierOf(shared) }] }, 99), 0, 'nothing animates without a mismatch');
  });
});

describe('field: the model, the grid and the click', () => {
  test('the label names the lag and the record check and nothing else; the summary says why nothing drew', () => {
    const report = lockstep();
    const ab = report.pairs.find((p) => p.a.label === 'A' && p.b.label === 'B');
    assert.equal(fieldLabel(ab), 'A ↔ B: in step at lag 0 · not touching');
    assert.equal(fieldLabel({ ...ab, record: { count: 3 } }), 'A ↔ B: in step at lag 0 · connected in the record: 3');
    assert.equal(fieldLabel({ ...ab, record: null }), 'A ↔ B: in step at lag 0 · record not available');
    assert.doesNotMatch(fieldLabel(ab), /coordinat/i);
    assert.equal(fieldSummary(report, fieldPairs(report), { mode: 'cast', hasCast: true }), null);
    assert.equal(fieldSummary(report, [], { mode: 'off' }), 'field off');
    assert.equal(fieldSummary(report, [], { mode: 'cast', hasCast: false }), 'field: no cast; the field draws interference between cast sigils only');
    const nothing = coherence(frameOf({ [A]: train(60, 3), [B]: train(60, 4) }, { labels: { [A]: 'A', [B]: 'B' } }));
    assert.match(fieldSummary(nothing, [], { mode: 'cast', hasCast: true }), /^field: nothing drawn · 1 pair tested, 0 above the 95th prewhitened$/);
    assert.match(fieldSummary(coherence(frameOf({ [A]: train(5, 3), [B]: train(5, 4) })), [], { mode: 'cast', hasCast: true }), /^field: nothing drawn · no pair judged: 5 ledgers used \(guard ≥ 12\)$/);
  });

  test('the model: one source per judged account in the member’s colour, the drawn pair with its parameters, the caption with the unit', () => {
    const report = lockstep();
    const m = fieldModel(report, { mode: 'cast', cast });
    assert.equal(m.on, true);
    assert.deepEqual(m.sources.map((s) => s.label), ['A', 'B', 'C']);
    assert.deepEqual(m.sources[0].rgb, [255, 255, 255], 'the first cast colour');
    assert.equal(m.sources[0].cells.length, 25, 'the sigil pattern');
    assert.equal(m.pairs.length, 1);
    assert.deepEqual([m.pairs[0].a, m.pairs[0].b, m.pairs[0].lag, m.pairs[0].carrier.kind], [0, 1, 0, 'lobe']);
    assert.ok(Math.abs(m.pairs[0].r - 1) < 1e-9);
    assert.equal(m.pairs[0].label, 'A ↔ B: in step at lag 0 · not touching');
    assert.equal(m.pairs[0].line, describePair(report.pairs.find((p) => p.a.label === 'A' && p.b.label === 'B')), 'the full line, with the pairs tested and both percentiles');
    assert.match(m.pairs[0].line, /pairs tested/);
    assert.equal(m.animated, false);
    assert.equal(m.caption, 'per ledger · #1000–#1059 · lags ±8 ledgers · 3 pairs tested');
    assert.equal(m.summary, null);
    assert.equal(fieldModel(report, { mode: 'cast', cast: [] }).pairs.length, 0, 'no cast: nothing draws');
    assert.equal(fieldModel(report, { mode: 'cast', cast: [] }).sources.length, 0, 'and no sigil: the field is between cast sigils only');
    assert.deepEqual(fieldModel(report, { mode: 'cast', cast: cast.slice(0, 2) }).sources.map((s) => s.label), ['A', 'B'], 'a judged account outside the cast is not a source');
    assert.equal(fieldModel(report, { mode: 'off', cast }).on, false);
    const outside = colourOf(C, []);
    assert.ok(outside.length === 3 && outside.every((v) => Number.isInteger(v) && v >= 0 && v <= 255), 'a member outside the cast takes its sigil colour');
    assert.notDeepEqual(outside, m.sources[2].rgb, 'which is not its cast colour');
    assert.deepEqual(hslToRgb(0, 100, 50), [255, 0, 0]);
    assert.deepEqual(hslToRgb(120, 100, 50), [0, 255, 0]);
    assert.deepEqual(hslToRgb(240, 100, 50), [0, 0, 255]);
  });

  test('the layout, the grid, the fringe lines and the click: the bright fringe sits on the bisector for lag 0, the click there finds the pair, the click elsewhere does not', () => {
    const report = lockstep();
    const m = fieldModel(report, { mode: 'cast', cast });
    const width = 800;
    const height = 600;
    const lay = fieldLayout(m, { width, height });
    assert.equal(lay.points.length, 3);
    assert.ok(lay.points[0].x < lay.points[1].x && lay.points[1].x < lay.points[2].x, 'a row, in order');
    assert.ok(Math.abs(lay.unit - lay.spacing / (8 + TAPER)) < 1e-9, 'one lag is a fixed share of the spacing: the whole range and its taper fit between adjacent sigils');
    const grid = fieldGrid(m, { width, height, cell: 16 });
    assert.equal(grid.cols, 50);
    assert.ok(grid.rows > 10);
    const mid = (Math.floor((lay.points[0].x + lay.points[1].x) / 2 / 16) + 0.5) * 16; // the cell centre nearest the bisector
    const y = (lay.top + lay.bottom) / 2;
    const hit = fieldHit(m, grid, mid, y);
    assert.ok(hit && hit.index === 0 && hit.value > 0.5, 'on the bisector of A and B, lag 0: the bright fringe of the lockstep pair');
    assert.equal(fieldHit(m, grid, lay.points[2].x + 30, y), null, 'nowhere near the pair: nothing');
    assert.equal(fieldHit(m, grid, mid, 2), null, 'above the band');
    const lines = fringeLines(grid, 0);
    assert.ok(lines.length > 4, 'zero crossings either side of the bright fringe');
    assert.ok(lines.every((s) => Number.isFinite(s.x1) && Number.isFinite(s.y1) && Number.isFinite(s.x2) && Number.isFinite(s.y2)));
    const lp = labelPoint(m, grid, 0);
    assert.ok(Math.abs(lp.x - (lay.points[0].x + lay.points[1].x) / 2) < 1, 'the label sits at the bright fringe');
    // the glow is additive and coloured: the bisector cell is lit, a far cell is dark
    const i = (Math.floor(y / 16) - grid.top) * grid.cols + Math.floor(mid / 16);
    assert.ok(grid.rgb[i * 3] > 0.3 && grid.rgb[i * 3 + 1] > 0.3 && grid.rgb[i * 3 + 2] > 0.3);
    assert.deepEqual(fieldGrid({ pairs: [], sources: [], L: 8 }, { width, height }).best.every((b) => b === -1), true);
  });

  test('the budget rule: the cell doubles above 3 ms, steps back under 0.6 ms, and holds between', () => {
    assert.deepEqual(CELL_SIZES, [16, 32, 48]);
    assert.deepEqual(BUDGET, { dropAboveMs: 3, restoreBelowMs: 0.6, frames: 10 });
    assert.equal(nextCell(16, 3.5), 32);
    assert.equal(nextCell(32, 3.5), 48);
    assert.equal(nextCell(48, 9), 48, 'the coarsest holds');
    assert.equal(nextCell(48, 0.2), 32);
    assert.equal(nextCell(16, 0.2), 16);
    assert.equal(nextCell(32, 2), 32, 'between the bounds nothing changes');
    assert.equal(HIT_LEAST, 0.05);
  });
});

describe('field: the recorded 1000-ledger account_tx window', () => {
  const fx = JSON.parse(readFileSync(join(fixturesDir, 'coherence', 'accounttx-107821080-107822079.json'), 'utf8'));
  function frameOfFixture() {
    const reasons = new Map();
    for (const a of fx.accounts) for (const [n, reason] of uncovered(a, fx.from, fx.to).reasons) if (!reasons.has(n)) reasons.set(n, reason);
    const ledgers = [];
    for (let n = fx.from; n <= fx.to; n++) ledgers.push({ index: n, included: !reasons.has(n), reason: reasons.get(n) ?? null, hash: null, closeTime: null });
    const accounts = fx.accounts.map((a) => ({ address: a.address, label: shortAddress(a.address) }));
    return { source: 'account_tx', measure: 'count', unit: 'ledger', bin: null, ledgers, accounts, series: new Map(fx.accounts.map((a) => [a.address, a.counts])), totals: new Map(fx.accounts.map((a) => [a.address, a.counts.reduce((x, y) => x + y, 0)])), chosen: 'named accounts', records: fx.records, fetched: null };
  }

  test('one pair of ten draws, labelled not touching; the connected pair, below the bar, draws nothing while its record stays in the readout', () => {
    const report = coherence(frameOfFixture());
    const members = normalizeCast(fx.accounts.map((a) => ({ address: a.address, label: shortAddress(a.address) })));
    const m = fieldModel(report, { mode: 'cast', cast: members });
    assert.equal(m.sources.length, 5);
    assert.deepEqual(m.pairs.map((p) => p.label), ['rLCN…Ujm5 ↔ rURt…bKns: in step at lag -6 · not touching']);
    assert.equal(m.summary, null);
    const connected = report.pairs.find((p) => p.record?.count === 44);
    assert.equal(significant(connected), false);
    assert.ok(!m.pairs.some((p) => p.pair === connected), 'the record labels, it does not draw');
    assert.match(connected && describePair(connected), /connected in the record: 44 transactions/);
    assert.equal(fieldModel(report, { mode: 'pair', pair: [connected.a.address, connected.b.address], cast: members }).pairs.length, 0);
    assert.match(fieldModel(report, { mode: 'pair', pair: [connected.a.address, connected.b.address], cast: members }).summary, /the chosen pair is not among them$/);
  });
});

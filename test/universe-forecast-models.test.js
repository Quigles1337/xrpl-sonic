// UNIVERSE phase 3B — the models recover known parameters within tolerance (Poisson and self-exciting streams, an HMM
// with known regimes), the HMM and the self-exciting rate move with new counts between refits; the score's per-ledger
// arithmetic and its split; the event studies recover a planted impact curve within its band.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { persistence, ewmaBaseline, serverBaseline, ridgeOne, fitHmm, filterHmm, predictHmm, hmmLogLik, fitHawkes, hawkesRate, predictHawkes, interval80 } from '../src/universe/forecast/models.js';
import { Record, heldOutCut, describeCountForecast, describeBinaryForecast, verdict } from '../src/universe/forecast/score.js';
import { quotesOf, curveOf, averageCurves, summarize, describeStudy, EventStudies, sizeThreshold, sideOf } from '../src/universe/forecast/events.js';
import { BookState } from '../src/universe/shared-price.js';
import { seededRandom } from '../src/coherence.js';

const normal = (rnd) => Math.sqrt(-2 * Math.log(Math.max(1e-12, rnd()))) * Math.cos(2 * Math.PI * rnd());
const poisson = (rnd, lambda) => {
  if (lambda > 50) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal(rnd)));
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rnd();
  } while (p > L);
  return k - 1;
};

describe('baselines and the one-signal regression', () => {
  test('persistence repeats the last value with an interval from recent changes; the EWMA follows the level; the server baseline is labelled as its own heuristic', () => {
    const s = [100, 104, 98, 101, 99, 103, 100, 102];
    const p = persistence(s);
    assert.equal(p.mean, 102);
    assert.ok(p.interval[0] < 102 && p.interval[1] > 102);
    const e = ewmaBaseline(s, 4);
    assert.ok(Math.abs(e.mean - 101) < 2);
    const sv = serverBaseline(95, 'Clio 2.8.0 (wss://s1.ripple.com)');
    assert.match(sv.name, /^Clio 2\.8\.0 \(wss:\/\/s1\.ripple\.com\)'s expected_ledger_size \(its own heuristic/);
    assert.equal(serverBaseline(undefined), null);
    assert.deepEqual(interval80(100, 0).map((v) => Math.round(v)), [87, 113], 'a zero sd falls back to the Poisson spread');
  });
  test('ridge recovers a planted slope on a clean signal and predicts with an interval', () => {
    const rnd = seededRandom(2);
    const pairs = [];
    for (let i = 0; i < 200; i++) {
      const x = 50 + 20 * normal(rnd);
      pairs.push([x, 10 + 0.8 * x + 2 * normal(rnd)]);
    }
    const f = ridgeOne(pairs, { lambda: 1 });
    assert.ok(Math.abs(f.b - 0.8) < 0.05, `slope ${f.b}`);
    assert.ok(Math.abs(f.a - 10) < 3, `intercept ${f.a}`);
    const pr = f.predict(60);
    assert.ok(Math.abs(pr.mean - 58) < 3);
    assert.ok(pr.interval[1] - pr.interval[0] > 3 && pr.interval[1] - pr.interval[0] < 8);
    assert.equal(ridgeOne(pairs.slice(0, 5)), null, 'too few pairs');
  });
});

describe('the hidden Markov model of regimes', () => {
  test('two planted regimes (rates 40 and 120, sticky) are recovered within tolerance and the filtered state knows where it is', () => {
    const rnd = seededRandom(3);
    const counts = [];
    let state = 0;
    for (let t = 0; t < 600; t++) {
      if (rnd() < 0.03) state = 1 - state;
      counts.push(poisson(rnd, state ? 120 : 40));
    }
    const m = fitHmm(counts, { states: 2, iterations: 80 });
    const rates = [...m.lambda].sort((a, b) => a - b);
    assert.ok(Math.abs(rates[0] - 40) < 6 && Math.abs(rates[1] - 120) < 10, `rates ${rates}`);
    const stay = m.order.map((k) => m.A[k][k]);
    assert.ok(stay.every((s) => s > 0.9), `sticky: ${stay}`);
    const p = predictHmm(m);
    assert.ok(p.mean > 30 && p.mean < 130);
    assert.ok(p.interval[0] < p.mean && p.interval[1] > p.mean);
    const believed = m.lambda[p.regime] > 80 ? 1 : 0;
    assert.equal(believed, state, 'the filtered regime at the end matches the planted one');
    assert.ok(Number.isFinite(hmmLogLik(m, counts.slice(-100))));
  });
  test('between refits the filter moves with the new counts: a run of the other regime turns the prediction', () => {
    const rnd = seededRandom(31);
    const counts = [];
    let state = 0;
    for (let t = 0; t < 500; t++) {
      if (rnd() < 0.03) state = 1 - state;
      counts.push(poisson(rnd, state ? 120 : 40));
    }
    const m = fitHmm(counts, { states: 2 });
    const high = Array.from({ length: 20 }, () => poisson(rnd, 120));
    const low = Array.from({ length: 20 }, () => poisson(rnd, 40));
    assert.ok(predictHmm(filterHmm(m, high)).mean > 90, 'after twenty high ledgers the forecast is high');
    assert.ok(predictHmm(filterHmm(m, low)).mean < 70, 'after twenty low ledgers it is low');
  });
  test('three states are not preferred on a two-regime stream by held-out likelihood per observation', () => {
    const rnd = seededRandom(4);
    const counts = [];
    let state = 0;
    for (let t = 0; t < 700; t++) {
      if (rnd() < 0.03) state = 1 - state;
      counts.push(poisson(rnd, state ? 100 : 30));
    }
    const train = counts.slice(0, 420);
    const held = counts.slice(420);
    const m2 = fitHmm(train, { states: 2 });
    const m3 = fitHmm(train, { states: 3 });
    const l2 = hmmLogLik(m2, held) / held.length;
    const l3 = hmmLogLik(m3, held) / held.length;
    assert.ok(l3 - l2 < 0.05, `held-out gain of a third state ${(l3 - l2).toFixed(3)} per observation`);
    assert.equal(fitHmm([1, 2, 3], { states: 2 }), null);
  });
});

describe('the self-exciting count model', () => {
  test('a planted discrete Hawkes (μ 20, α 0.4, β 0.5) is recovered within tolerance; a Poisson stream gives little excitation and its rate', () => {
    const rnd = seededRandom(5);
    const counts = [];
    let s = 0;
    for (let t = 0; t < 800; t++) {
      const rate = 20 + 0.4 * s;
      const x = poisson(rnd, rate);
      counts.push(x);
      s = 0.5 * s + x;
    }
    const m = fitHawkes(counts);
    assert.ok(Math.abs(m.beta - 0.5) < 0.2, `β ${m.beta}`);
    assert.ok(Math.abs(m.branching - 0.8) < 0.2, `branching α/(1−β) ${m.branching}`);
    assert.ok(Math.abs(m.mu - 20) < 12, `μ ${m.mu}`);
    const p = predictHawkes(m);
    assert.ok(p.mean > 20 && p.mean < 200);
    const flat = [];
    for (let t = 0; t < 600; t++) flat.push(poisson(rnd, 50));
    const f = fitHawkes(flat);
    assert.ok(f.branching < 0.5, `a Poisson stream's branching ${f.branching}`);
    assert.ok(Math.abs(f.mu / (1 - f.branching) - 50) < 3, `its rate μ/(1 − branching) ${(f.mu / (1 - f.branching)).toFixed(1)} for λ 50`);
    assert.equal(fitHawkes([1, 2, 3]), null);
  });
  test('the rate moves with new counts between refits, with the parameters fixed', () => {
    const m = { mu: 10, alpha: 0.4, beta: 0.5, branching: 0.8 };
    const quiet = hawkesRate(m, new Array(64).fill(5)).nextRate;
    const busy = hawkesRate(m, [...new Array(60).fill(5), 40, 40, 40, 40]).nextRate;
    assert.ok(busy > quiet + 20, `a burst raises the rate: ${quiet.toFixed(1)} → ${busy.toFixed(1)}`);
  });
});

describe('the score', () => {
  test('per-ledger records: MAE, coverage, Brier, skill over the shared ledgers of a range', () => {
    const p = new Record('persistence');
    const m = new Record('model');
    for (let i = 1; i <= 60; i++) {
      p.resolveCount({ mean: 100, interval: [90, 110] }, 100 + (i % 3) * 5, 1000 + i);
      if (i > 10) m.resolveCount({ mean: 103, interval: [95, 111] }, 100 + (i % 3) * 5, 1000 + i);
    }
    const o = p.over();
    assert.ok(Math.abs(o.mae - 5) < 1e-9);
    assert.equal(o.coverage, 1);
    assert.deepEqual([o.from, o.to], [1001, 1060]);
    const s = m.skillAgainst(p);
    assert.equal(s.n, 50, 'over the 50 ledgers both resolved');
    assert.ok(s.skill > 0);
    assert.equal(m.over(1031, Infinity).n, 30);
    const b = new Record('binary');
    b.resolveBinary(0.8, true, 1);
    b.resolveBinary(0.8, false, 1);
    b.resolveBinary(0.5, true, 2);
    const bo = b.brierOver();
    assert.deepEqual([bo.ledgers, bo.k], [2, 3]);
    assert.ok(Math.abs(bo.brier - (0.04 + 0.64 + 0.25) / 3) < 1e-9);
  });
  test('the split forms once both portions hold enough ledgers, and says where it cuts', () => {
    const idx = Array.from({ length: 100 }, (_, i) => 2001 + i);
    const s = heldOutCut(idx, { share: 0.6, min: 20 });
    assert.equal(s.cut, 2061);
    assert.match(s.statement, /^models chosen on the first 60% of resolved ledgers \(#2001–#2060, 60\), reported on the last 40% \(#2061–#2100, 40\)$/);
    const f = heldOutCut(idx.slice(0, 30), { share: 0.6, min: 20 });
    assert.equal(f.cut, null);
    assert.match(f.statement, /^the held-out portion is forming \(30 resolved; the split needs 50\)$/);
  });
  test('the words: a count forecast with its held-out record and skills, a probability with its Brier, the verdict; never "will"', () => {
    const p = new Record('persistence');
    const m = new Record('ridge');
    for (let i = 1; i <= 40; i++) {
      p.resolveCount({ mean: 100, interval: [90, 110] }, 100 + (i % 3) * 5, 3000 + i);
      m.resolveCount({ mean: 103, interval: [95, 111] }, 100 + (i % 3) * 5, 3000 + i);
    }
    const line = describeCountForecast('count (shown: ridge)', { mean: 130, interval: [112, 148] }, m, { persistence: p }, [3021, Infinity]);
    assert.match(line, /^count \(shown: ridge\) 112–148 \(80%, mean 130\) · held-out coverage 100% over 20 ledgers \(#3021–#3040\) · persistence skill \+0\.\d\d$/);
    assert.doesNotMatch(line, /\bwill\b/);
    const b = new Record('loops');
    b.resolveBinary(0.62, true, 3030);
    assert.match(describeBinaryForecast('loop taken within 3', 0.62, b, [3021, Infinity]), /^loop taken within 3 P 0\.62 · held-out Brier 0\.144 over 1 forecast in 1 ledger$/);
    assert.match(verdict([p, m], p, [3021, Infinity], { min: 20 }), /^on the held-out ledgers \(#3021–#3040\), beats persistence: ridge \(\d+% less error over 20\)$/);
    const worse = new Record('worse');
    for (let i = 1; i <= 40; i++) worse.resolveCount({ mean: 120, interval: [100, 140] }, 100 + (i % 3) * 5, 3000 + i);
    assert.equal(verdict([p, worse], p, [3021, Infinity]), 'on the held-out ledgers (#3021–#3040), nothing beats persistence');
  });
});

describe('event studies', () => {
  const I = 'rIssuerAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const iou = (v) => ({ currency: 'USD', issuer: I, value: String(v) });
  const created = (owner, seq, gets, pays) => ({ CreatedNode: { LedgerEntryType: 'Offer', NewFields: { Account: owner, Sequence: seq, TakerGets: gets, TakerPays: pays } } });
  test('the quotes of a book: best ask and bid in second-per-first terms, the mid, the spread, the depth at the top; only the books asked for', () => {
    const s = new BookState();
    s.apply({}, { TransactionResult: 'tesSUCCESS', AffectedNodes: [created('rA', 1, iou(100), '110000000'), created('rB', 1, iou(50), '52500000'), created('rC', 1, '100000000', iou(98)), created('rD', 1, '50000000', iou(50))] }, 10);
    const q = quotesOf(s);
    const book = [...q.values()][0];
    assert.ok(Math.abs(book.ask - 1050000) < 1e-6, 'the best ask: rB sells USD at 1.05 XRP (drops) each');
    assert.ok(Math.abs(book.bid - 1020408.16) < 1, 'the best bid: rC buys USD at 1.0204 XRP each');
    assert.ok(book.spread > 0.02 && book.spread < 0.04);
    assert.equal(book.askDepth, 50);
    assert.equal(book.offers, 4);
    assert.equal(quotesOf(s, new Set(['nothing|here'])).size, 0);
  });
  test('a planted impact curve is recovered within its band: a 20 bp drop at N that half recovers by N+4, depth thinned by half and back by N+3', () => {
    const w = 8;
    const rnd = seededRandom(6);
    const curves = [];
    for (let e = 0; e < 40; e++) {
      const series = new Map();
      for (let k = -w - 1; k <= w; k++) {
        let mid = 1;
        let depth = 1000;
        if (k >= 0) {
          mid = 1 - 0.002 * (k <= 4 ? 1 - 0.5 * (k / 4) : 0.5);
          depth = k < 3 ? 500 + (500 * k) / 3 : 1000;
        }
        series.set(100 + k, { mid: mid * (1 + 0.0003 * normal(rnd)), spread: 0.01, depth: depth * (1 + 0.05 * normal(rnd)) });
      }
      curves.push(curveOf(series, 100, w));
    }
    const avg = averageCurves(curves, { seed: 9 });
    const s = summarize(avg);
    assert.ok(Math.abs(s.moveBps + 20) < 3, `move ${s.moveBps} bp`);
    assert.ok(s.moveBand[0] <= -20 && s.moveBand[1] >= -20, `the band ${s.moveBand} holds the planted move`);
    assert.ok(Math.abs(s.persistence - 0.5) < 0.08, `persistence ${s.persistence}`);
    assert.ok(s.halfRecovery != null && s.halfRecovery <= 3, `depth half back in ${s.halfRecovery}`);
    assert.match(describeStudy('USD|XRP', s, 5000), /^USD\|XRP: 40 trades above 5,000 XRP · move -\d+\.\d bp in the taker’s direction \(-\d+\.\d to -\d+\.\d, 80%\) · depth half back in \d ledgers? · 0\.\d\d of the move left at N\+w$/);
    assert.equal(summarize(averageCurves([])), null);
  });
  test('the bookkeeping: trades above the 90th percentile become studies once their window has closed; the drift one ledger on', () => {
    const es = new EventStudies({ window: 2 });
    const sizes = Array.from({ length: 30 }, (_, i) => 100 + i * 10);
    assert.equal(sizeThreshold(sizes, 0.9), 370);
    const book = 'USD|XRP';
    for (let ledger = 1; ledger <= 80; ledger++) {
      // small trades on another book every ledger; a large trade on this one every ten ledgers from 21, each followed by a 10 bp drop the next ledger
      const after = ledger > 21 && (ledger - 1) % 10 === 1;
      es.noteQuotes(ledger, new Map([[book, { mid: after ? 0.999 : 1, spread: 0.01, depth: 1000 }]]));
      es.noteTrade(ledger, 'EUR|XRP', 100 + (ledger % 7) * 10);
      if (ledger > 20 && ledger % 10 === 1) assert.equal(es.noteTrade(ledger, book, 5000), true, 'a large trade joins the studies');
    }
    const r = es.report();
    const usd = r.find((x) => x.book === book);
    assert.ok(usd && usd.count >= 5, `${usd?.count} studies`);
    assert.match(usd.line, /^USD \| XRP: \d+ trades? above/);
    const d = es.drift(book, 1);
    assert.ok(d != null && Math.abs(d + 0.001) < 2e-4, `drift one ledger on ${d}`);
    assert.equal(es.drift('nothing|here', 1), null);
    assert.ok(es.activeBooks().has(book));
  });
  test('paper trades, counted and never valued: they follow the book’s past signed move, read only from windows closed by the trade’s ledger', () => {
    const es = new EventStudies({ window: 2 });
    const book = 'USD|XRP';
    // a large trade taking USD every ten ledgers from 21; the mid rises 10 bp over the next two ledgers each time
    for (let ledger = 1; ledger <= 140; ledger++) {
      const since = ledger > 21 ? (ledger - 21) % 10 : null;
      const mid = since === 1 ? 1.0005 : since === 2 ? 1.001 : 1;
      es.noteQuotes(ledger, new Map([[book, { mid, spread: 0.01, depth: 1000 }]]));
      es.noteTrade(ledger, 'EUR|XRP', 100 + (ledger % 7) * 10);
      if (ledger > 20 && ledger % 10 === 1) es.noteTrade(ledger, book, 5000, 'USD');
    }
    // 12 large trades; the first five only build the past, the rest are paper trades that follow it, and each held
    assert.ok(es.paper.n >= 5, `${es.paper.n} paper trades`);
    assert.equal(es.paper.held, es.paper.n);
    const line = es.paperLine();
    assert.match(line, /^paper trades \(research switch; counted, never valued\): .+ held in \d+ of \d+ on 1 book · blind spots: no own impact, no ordering lottery, no queue position/);
    assert.doesNotMatch(line, /\b(profit|pnl|return|gain)\b/i);
  });
  test('the curves are signed by the taker’s side: a buy that lifts the mid and a sell that drops it add up, where unsigned they cancel', () => {
    const run = (signed) => {
      const es = new EventStudies({ window: 2 });
      const book = 'USD|XRP';
      for (let ledger = 1; ledger <= 120; ledger++) {
        // a large trade every ten ledgers from 21, alternately taking USD (the first asset) and XRP; the mid moves 10 bp the taker's way the next ledger
        const at = ledger > 20 && ledger % 10 === 1 ? ledger : null;
        const prev = ledger - 1 > 20 && (ledger - 1) % 10 === 1 ? ledger - 1 : null;
        const takesFirst = (n) => Math.floor(n / 10) % 2 === 0;
        const mid = prev ? (takesFirst(prev) ? 1.001 : 0.999) : 1;
        es.noteQuotes(ledger, new Map([[book, { mid, spread: 0.01, depth: 1000 }]]));
        es.noteTrade(ledger, 'EUR|XRP', 100 + (ledger % 7) * 10);
        if (at) es.noteTrade(ledger, book, 5000, signed ? (takesFirst(at) ? 'USD' : 'XRP') : null);
      }
      return es.drift(book, 1);
    };
    const signed = run(true);
    const unsigned = run(false);
    assert.ok(Math.abs(signed - 0.001) < 2e-4, `signed drift ${signed}`);
    assert.ok(Math.abs(unsigned) < 3e-4, `unsigned drift ${unsigned}`);
    assert.equal(sideOf('USD|XRP', 'USD'), 1);
    assert.equal(sideOf('USD|XRP', 'XRP'), -1);
    assert.equal(sideOf('USD|XRP', null), 1);
  });
});

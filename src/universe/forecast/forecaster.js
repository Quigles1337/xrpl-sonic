// UNIVERSE phase 3B — the forecaster: one object the worker (and the bench, in Node) feeds a finished ledger row at a
// time (src/universe/forecast/rows.js), through the sealed past. It keeps the ropes and the wake per metric, forecasts
// ledger N+1's targets with the baselines and the models, scores each forecast when N+1's row lands, chooses its model
// on the tuning portion of the resolved ledgers and reports it on the held-out portion, and says it all in the
// readout's words. In nowcast mode it also nowcasts ledger L just before L closes, from what was in flight for L (the
// proposed transactions and the fee method's result), labelled apart. Replay and live run this same code on the same
// rows; the parity test replays the rows of a recorded live session and requires identical forecasts.
// docs/universe.md, "Phase 3B". Pure: no DOM, no network, no clock in any forecast (arrival times come in the rows;
// the milliseconds a forecast took are printed and never enter one).

import { SealedPast, guard } from './sealed.js';
import { RopeBank, wallLabel, alphaOf } from './ropes.js';
import { log1p as dlog1p, expm1 as dexpm1 } from './dmath.js';
import { Wake, thresholdFor, RECENT, TABLE_RUNS } from './wake.js';
import { persistence, ewmaBaseline, serverBaseline, ridgeOne, fitHmm, filterHmm, predictHmm, hmmLogLik, fitHawkes, hawkesRate, predictHawkes, interval80 } from './models.js';
import { Record, heldOutCut, describeCountForecast, describeBinaryForecast, verdict } from './score.js';
import { normalise, cadenceOf } from '../../coherence.js';
import { CATEGORY_NAMES } from '../../mapping.js';

export const FORECAST_VERSION = 2;
export const DEFAULTS = Object.freeze({
  mode: 'forecast', // 'forecast': closed ledgers only; 'nowcast': adds what was in flight before each close
  server: null, // the server whose expected_ledger_size is a nowcast baseline, named in the readout
  arl: 500, // the CUSUM's in-control average run length, in ledgers
  hazard: 1 / 200, // the change-point prior, per ledger
  topAccounts: 20, // m: the most active accounts whose next-ledger presence is forecast
  presenceWindow: 64, // the ledgers their presence and cadence are read over
  cadenceLeast: 0.3, // the self-correlation a presence cadence must reach (the pulsar rule's)
  loopWithin: 3, // j: a loop reported at N is taken when a loop-take consumes one of its offers within j ledgers
  tuningShare: 0.6, // the split of the resolved ledgers: the first 60% choose, the last 40% report
  minRecord: 20, // the shared ledgers a skill needs before it counts
  refitEvery: 25, // ledgers between refits of the HMM, the self-exciting model and the regressions
  minHistory: 40, // ledgers before the models speak
  fitWindow: 1024, // the ledgers a refit reads
  hmmStates: [2, 3],
  maxRows: 4096, // the past kept
});

const BASELINES = ['persistence', 'ewma h16'];
const clock = () => globalThis.performance?.now?.() ?? Date.now();
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const clampP = (p) => Math.max(0.01, Math.min(0.99, p));
const short = (a) => (typeof a === 'string' && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : String(a));
const fmt = (x) => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1));
const num = (n) => Number(n).toLocaleString('en-US');

export class Forecaster {
  constructor(options = {}) {
    this.o = { ...DEFAULTS, ...options };
    this.categories = [...CATEGORY_NAMES];
    this.past = new SealedPast({ max: this.o.maxRows });
    this.threshold = thresholdFor(this.o.arl, { k: 0.5, runs: TABLE_RUNS, seed: 7 }); // set by simulation (2,000 runs a step of the search; the shipped table at ARL 500); printed
    this.banks = { count: new RopeBank(), interval: new RopeBank(), fee: new RopeBank(), queue: new RopeBank() };
    this.shareBanks = new Map(this.categories.map((c) => [c, new RopeBank()]));
    const wake = (name, bank, family, extra = {}) => new Wake({ name, bank, family, hazard: this.o.hazard, threshold: this.threshold, ...extra });
    this.wakes = { count: wake('count', this.banks.count, 'poisson'), fee: wake('open-ledger fee (drops)', this.banks.fee, 'normal', { transform: 'log1p' }), queue: wake('queue', this.banks.queue, 'poisson') };
    this.shareWakes = new Map(this.categories.map((c) => [c, wake(`share ${c}`, this.shareBanks.get(c), 'normal', { minVariance: 1e-4 })]));
    this.records = new Map(); // forecast model → Record (count)
    this.nowcastRecords = new Map(); // nowcast model → Record (count)
    this.mixRecords = new Map(); // 'ewma h16' | 'persistence' → Record (type mix, L1 error)
    this.accountRecord = new Record('top accounts transacting');
    this.accountRateRecord = new Record('top accounts transacting, by their rate alone'); // the baseline beside it
    this.loopRecord = new Record('loop taken within j');
    this.intervalRecord = new Record('close interval');
    this.pending = null;
    this.pendingNowcast = null;
    this.models = { hmm: null, hmmScore: null, hawkes: null, ridge: new Map(), fittedAt: -Infinity, fits: 0 };
    this.signalsTried = new Set();
    this.loops = []; // { ledger, deadline, p, offers: Set, taken: null }
    this.lastResolved = null;
    this.lastNowcast = null;
    this.last = null;
    this.accountSets = new WeakMap();
  }

  _rec(map, name) {
    let r = map.get(name);
    if (!r) {
      r = new Record(name);
      map.set(name, r);
    }
    return r;
  }

  _accountSet(row) {
    let s = this.accountSets.get(row);
    if (!s) {
      s = new Set(row.accounts ?? []);
      this.accountSets.set(row, s);
    }
    return s;
  }

  // --- ingest ---------------------------------------------------------------------------------------

  /**
   * A finished ledger's row. Resolves the forecasts (and the nowcast) made
   * for it, updates the ropes and the wake, forecasts the next ledger, and
   * returns the readout. A row older than the last is ignored.
   */
  push(row) {
    const t0 = clock();
    if (!this.past.push(row)) return this.last;
    const stored = this.past.latest;
    const view = this.past.at(stored.index);
    this._resolve(stored);
    this._observe(stored, view);
    this.last = this._forecast(view, t0);
    return this.last;
  }

  _resolve(row) {
    const p = this.pending;
    if (p && p.for === row.index) {
      for (const [name, f] of Object.entries(p.count)) if (f) this._rec(this.records, name).resolveCount(f, row.count, row.index);
      this._rec(this.records, 'shown').resolveCount(p.shown, row.count, row.index);
      const present = this._accountSet(row);
      for (const a of p.accounts) {
        this.accountRecord.resolveBinary(a.p, present.has(a.address), row.index);
        this.accountRateRecord.resolveBinary(a.rateP, present.has(a.address), row.index);
      }
      if (p.interval && Number.isFinite(row.arrivedAt) && Number.isFinite(p.lastArrivedAt)) {
        const dt = row.arrivedAt - p.lastArrivedAt;
        if (dt > 0 && dt < 120000) this.intervalRecord.resolveCount(p.interval, dt, row.index);
      }
      const heard = row.heard ?? row.count;
      if (heard > 0) {
        for (const [name, mix] of Object.entries(p.mix)) {
          let err = 0;
          for (const c of this.categories) err += Math.abs((mix[c] ?? 0) - (row.types?.[c] ?? 0) / heard);
          this._rec(this.mixRecords, name).resolveCount({ mean: err, interval: null }, 0, row.index); // the L1 distance between the forecast mix and the outcome, as an error
        }
      }
      this.lastResolved = { index: row.index, count: row.count, shown: p.shown, persistence: p.count.persistence?.mean ?? null };
    }
    const n = this.pendingNowcast;
    if (n && n.for === row.index) {
      for (const [name, f] of Object.entries(n.count)) if (f) this._rec(this.nowcastRecords, name).resolveCount(f, row.count, row.index);
      this._rec(this.nowcastRecords, 'shown').resolveCount(n.shown, row.count, row.index);
      this.pendingNowcast = null;
    }
    // loops reported earlier: taken when a loop-take within j ledgers consumed one of their offers
    const takenOffers = new Set((row.takes ?? []).flatMap((t) => t.offers ?? []));
    for (const l of this.loops) {
      if (l.taken != null || row.index <= l.ledger) continue;
      if (row.index > l.deadline) {
        l.taken = false;
        this.loopRecord.resolveBinary(l.p, false, row.index);
      } else if ([...l.offers].some((k) => takenOffers.has(k))) {
        l.taken = true;
        this.loopRecord.resolveBinary(l.p, true, row.index);
      }
    }
    this.loops = this.loops.filter((l) => l.taken == null);
  }

  _observe(row, view) {
    // each wake reads its metric against the ropes as they stood, then the ropes take it
    this.wakes.count.update(row.count);
    this.banks.count.update(row.count);
    const prev = view.length >= 2 ? view.upto[view.length - 2] : null;
    if (Number.isFinite(row.arrivedAt) && Number.isFinite(prev?.arrivedAt)) {
      const dt = row.arrivedAt - prev.arrivedAt;
      if (dt > 0 && dt < 120000) this.banks.interval.update(dt);
    }
    if (this.o.mode === 'nowcast') {
      if (Number.isFinite(row.fee?.openLedgerFee)) {
        this.wakes.fee.update(row.fee.openLedgerFee);
        this.banks.fee.update(row.fee.openLedgerFee);
      }
      if (Number.isFinite(row.fee?.queueSize)) {
        this.wakes.queue.update(row.fee.queueSize);
        this.banks.queue.update(row.fee.queueSize);
      }
    }
    const heard = row.heard ?? row.count;
    if (heard > 0) {
      for (const c of this.categories) {
        const share = (row.types?.[c] ?? 0) / heard;
        this.shareWakes.get(c).update(share);
        this.shareBanks.get(c).update(share);
      }
    }
  }

  // --- the signals and the models -----------------------------------------------------------------------

  _wallClock(all) {
    const rows = all.filter((r) => Number.isFinite(r.arrivedAt));
    if (rows.length < 2) return { timeOfDay: false, dayOfWeek: false, line: 'wall-clock features: no local arrival times in these rows (a replay of a recording made without them), so none' };
    const span = rows.at(-1).arrivedAt - rows[0].arrivedAt;
    const hours = new Array(24).fill(0);
    const dates = Array.from({ length: 7 }, () => new Set());
    for (const r of rows) {
      const d = new Date(r.arrivedAt);
      hours[d.getUTCHours()] += 1;
      dates[d.getUTCDay()].add(d.toISOString().slice(0, 10));
    }
    const timeOfDay = hours.every((h) => h >= 20);
    const dayOfWeek = dates.every((s) => s.size >= 2);
    return { timeOfDay, dayOfWeek, line: `wall-clock features: time of day ${timeOfDay ? 'in use (a one-signal regression on the hour’s mean count)' : 'not yet'} · day of week ${dayOfWeek ? 'available, not modelled in this pass' : 'not yet'} (history ${wallLabel(span)} over ${num(rows.length)} ledgers with arrival times; time of day needs 20 ledgers in every UTC hour, day of week two dates of each weekday)` };
  }

  /** The one-signal regressions' signals: each the value at position i, from positions before i only. */
  _signals(rows, counts, wall) {
    const a4 = alphaOf(4);
    const ewma4 = [];
    let m = null;
    for (let i = 0; i <= counts.length; i++) {
      ewma4.push(m);
      if (i < counts.length) m = m == null ? counts[i] : m + a4 * (counts[i] - m);
    }
    const signals = {
      'previous count': (i) => (i >= 1 ? counts[i - 1] : null),
      'ewma h4': (i) => ewma4[i],
    };
    if (wall.timeOfDay) {
      const hourOf = (r) => new Date(r.arrivedAt).getUTCHours();
      const sums = new Array(24).fill(0);
      const ns = new Array(24).fill(0);
      const hourMean = [];
      for (let i = 0; i <= counts.length; i++) {
        const prev = rows[i - 1];
        const h = prev && Number.isFinite(prev.arrivedAt) ? hourOf(prev) : null;
        hourMean.push(h != null && ns[h] ? sums[h] / ns[h] : null);
        if (i < counts.length && Number.isFinite(rows[i].arrivedAt)) {
          const k = hourOf(rows[i]);
          sums[k] += counts[i];
          ns[k] += 1;
        }
      }
      signals['hour-of-day mean'] = (i) => hourMean[i];
    }
    return signals;
  }

  _refit(head, rows, counts, wall) {
    if (counts.length < this.o.minHistory || head - this.models.fittedAt < this.o.refitEvery) return;
    this.models.fittedAt = head;
    this.models.fits += 1;
    const cut = Math.floor(counts.length * this.o.tuningShare);
    const tuning = counts.slice(0, cut);
    const held = counts.slice(cut);
    // the HMM: its number of states chosen by the past's own held-out likelihood per observation, then refit on all of it
    let best = null;
    for (const k of this.o.hmmStates) {
      const m = fitHmm(tuning, { states: k });
      if (!m || held.length < 8) continue;
      const score = hmmLogLik(m, held) / held.length;
      if (!best || score > best.score + 0.02) best = { k, score };
    }
    this.models.hmm = best ? fitHmm(counts, { states: best.k }) : null;
    this.models.hmmScore = best;
    this.models.hawkes = fitHawkes(counts);
    // the one-signal regressions, each fitted on the past's tuning part alone
    const signals = this._signals(rows, counts, wall);
    this.models.ridge = new Map();
    for (const [name, f] of Object.entries(signals)) {
      this.signalsTried.add(name);
      const pairs = [];
      for (let i = 2; i < cut; i++) {
        const x = f(i);
        if (Number.isFinite(x)) pairs.push([x, counts[i]]);
      }
      const fit = ridgeOne(pairs, { lambda: 1, log: true }); // on log(1 + x): the counts are skewed and multiplicative
      if (fit) this.models.ridge.set(name, fit);
    }
  }

  // --- the forecast ------------------------------------------------------------------------------------

  _forecast(view, t0) {
    const { rows, all, head } = guard('the forecast’s features', (v) => ({ rows: v.last(this.o.fitWindow), all: v.all(), head: v.head }))(view);
    const N = head.index;
    const counts = rows.map((r) => r.count);
    const wall = this._wallClock(all);
    this._refit(N, rows, counts, wall);
    // the count for N+1, every model
    const count = {};
    count.persistence = persistence(counts);
    count['ewma h16'] = ewmaBaseline(counts, 16);
    const signals = this._signals(rows, counts, wall);
    for (const [name, fit] of this.models.ridge) {
      const x = signals[name]?.(counts.length);
      if (Number.isFinite(x)) count[`ridge on ${name}`] = { name: `ridge on ${name}`, ...fit.predict(x) };
    }
    if (this.models.hmm) count.hmm = predictHmm(filterHmm(this.models.hmm, counts.slice(-64)));
    if (this.models.hawkes) count.hawkes = predictHawkes(hawkesRate(this.models.hawkes, counts.slice(-64)));
    // the split of the resolved ledgers; a combination only of models that each beat every baseline on the tuning part
    const persistenceRec = this._rec(this.records, 'persistence');
    const split = heldOutCut(persistenceRec.indices(), { share: this.o.tuningShare, min: this.o.minRecord });
    const tuning = [-Infinity, split.cut ?? -Infinity];
    const heldOut = [split.cut ?? Infinity, Infinity];
    const beatsAll = (name) =>
      BASELINES.every((b) => {
        const s = this.records.get(name)?.skillAgainst(this.records.get(b), tuning[0], tuning[1]);
        return s && s.n >= this.o.minRecord && s.skill > 0;
      });
    if (split.cut != null) {
      const members = Object.keys(count).filter((name) => !BASELINES.includes(name) && beatsAll(name));
      if (members.length >= 2) count.combined = { name: `combined (${members.join(' + ')})`, mean: avg(members.map((m) => count[m].mean)), point: avg(members.map((m) => count[m].point ?? count[m].mean)), interval: [avg(members.map((m) => count[m].interval[0])), avg(members.map((m) => count[m].interval[1]))], members };
    }
    // the model chosen: the best skill against persistence on the tuning part, else persistence
    let chosen = 'persistence';
    if (split.cut != null) {
      let bestSkill = 0;
      for (const name of Object.keys(count)) {
        if (name === 'persistence') continue;
        const s = this.records.get(name)?.skillAgainst(persistenceRec, tuning[0], tuning[1]);
        if (s && s.n >= this.o.minRecord && s.skill > bestSkill) {
          bestSkill = s.skill;
          chosen = name;
        }
      }
    }
    let shown = { ...count[chosen], name: chosen };
    let fallback = null;
    const cw = this.wakes.count.last;
    const shortRope = this.banks.count.rope(4);
    if (cw && cw.recentChangeProbability > 0.5 && shortRope?.mean != null) {
      shown = { name: 'the short rope (h 4)', mean: shortRope.mean, interval: interval80(shortRope.mean, shortRope.sd > 0 ? shortRope.sd : null) };
      fallback = `a change within the last ${RECENT} ledgers (P ${cw.recentChangeProbability.toFixed(2)} > 0.5): the forecast shown falls back to the short rope's mean and interval`;
    }
    // the type mix for N+1: the h 16 rope of each share, and persistence of the last mix
    const mix = { 'ewma h16': {}, persistence: {} };
    const mixIntervals = {};
    const heard = head.heard ?? head.count;
    for (const c of this.categories) {
      const r = this.shareBanks.get(c).rope(16);
      if (r?.mean != null) {
        mix['ewma h16'][c] = r.mean;
        mixIntervals[c] = [Math.max(0, r.mean - 1.2816 * r.sd), Math.min(1, r.mean + 1.2816 * r.sd)];
      }
      mix.persistence[c] = heard > 0 ? (head.types?.[c] ?? 0) / heard : 0;
    }
    // the most active accounts: presence at N+1 from their cadence where one is measured, else their rate
    const accounts = this._presence(view);
    // the loops Part A reported at N: P(taken within j) from the base rate of loop-takes so far
    const takesSeen = all.filter((r) => (r.takes ?? []).length).length;
    const q = (takesSeen + 0.5) / (all.length + 1);
    const loopP = clampP(-dexpm1(this.o.loopWithin * dlog1p(-q))); // 1 − (1 − q)^j
    for (const l of head.loops ?? []) this.loops.push({ ledger: N, deadline: N + this.o.loopWithin, p: loopP, offers: new Set(l.offers ?? []), taken: null });
    // the close interval, from local arrival times
    const ir = this.banks.interval.rope(16);
    const interval = ir?.mean != null && ir.n >= 8 && ir.sd > 0 ? { name: 'ewma h16 of the arrival gaps', mean: ir.mean, interval: interval80(ir.mean, ir.sd) } : null;
    this.pending = { for: N + 1, count, shown, accounts: accounts.map(({ address, p, rate, window }) => ({ address, p, rateP: clampP((rate * window + 0.5) / (window + 1)) })), interval, mix, lastArrivedAt: head.arrivedAt };
    return this._readout({ view, all, head, N, counts, count, chosen, shown, fallback, split, tuning, heldOut, mix, mixIntervals, accounts, loopP, takesSeen, interval, wall, t0 });
  }

  _presence(view) {
    const rows = view.last(this.o.presenceWindow);
    const counts = new Map();
    for (const r of rows) for (const a of r.accounts ?? []) counts.set(a, (counts.get(a) ?? 0) + 1);
    const top = [...counts].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, this.o.topAccounts);
    return top.map(([address]) => this._presenceOf(address, rows));
  }

  /**
   * One account's presence at the next ledger: from its cadence when one is
   * measured with at least six ledgers in phase (the share of those ledgers
   * it was present in, shrunk toward its rate with four ledgers' weight),
   * else from its rate (smoothed); kept in [0.01, 0.99].
   */
  _presenceOf(address, rows) {
    const series = rows.map((r) => (this._accountSet(r).has(address) ? 1 : 0));
    const n = series.length;
    const k = series.reduce((a, b) => a + b, 0);
    const rate = (k + 0.5) / (n + 1);
    if (n >= 12 && k >= 3 && k < n) {
      const { z, flat } = normalise(series);
      if (!flat) {
        const c = cadenceOf(z, Math.max(2, Math.min(16, Math.floor(n / 6))), { least: this.o.cadenceLeast });
        if (c && c.period >= 2) {
          let hits = 0;
          let tot = 0;
          for (let t = n - c.period; t >= 0; t -= c.period) {
            tot += 1;
            hits += series[t];
          }
          if (tot >= 6) return { address, p: clampP((hits + 4 * rate) / (tot + 4)), method: 'cadence', period: c.period, r: c.r, rate: k / n, window: n, inPhase: tot };
        }
      }
    }
    return { address, p: clampP(rate), method: 'rate', rate: k / n, window: n };
  }

  /** The next-ledger presence of any account (the probe asks for the probed one), from the latest rows. */
  presenceOf(address) {
    const head = this.past.latest;
    if (!head) return null;
    const rows = this.past.at(head.index).last(this.o.presenceWindow);
    if (!rows.length) return null;
    const p = this._presenceOf(address, rows);
    return { ...p, next: head.index + 1, line: `transacts at #${num(head.index + 1)}: P ${p.p.toFixed(2)} from ${p.method === 'cadence' ? `its cadence (every ${p.period} ledgers, r ${p.r.toFixed(2)} on its own presence)` : 'its rate'} · present in ${Math.round(p.rate * p.window)} of the last ${p.window} ledgers` };
  }

  // --- the nowcast ------------------------------------------------------------------------------------

  /**
   * The nowcast of ledger L, made just before L closes from the rows up to
   * L−1 and what was in flight for L: the proposed transactions counted
   * against it and the fee method's last result read while it was open. Nowcast
   * mode only; resolved when L's row lands. Returns the readout, or null.
   */
  nowcastFor(index, inflight = {}) {
    if (this.o.mode !== 'nowcast') return null;
    const t0 = clock();
    const view = this.past.at(index - 1);
    const { rows } = guard('the nowcast’s features', (v) => ({ rows: v.last(this.o.fitWindow) }))(view);
    if (!rows.length) return null;
    const counts = rows.map((r) => r.count);
    const proposed = Number.isFinite(inflight.proposed) ? inflight.proposed : null;
    const fee = inflight.fee ?? null;
    const count = {};
    count.persistence = persistence(counts);
    count['ewma h16'] = ewmaBaseline(counts, 16);
    if (proposed != null) {
      this.signalsTried.add('proposed count (nowcast)');
      const pairs = rows.filter((r) => Number.isFinite(r.proposed)).map((r) => [r.proposed, r.count]);
      const fit = ridgeOne(pairs.slice(-512), { lambda: 1, log: true });
      if (fit) count['ridge on the proposed count'] = { name: 'ridge on the proposed count', ...fit.predict(proposed) };
    }
    if (Number.isFinite(fee?.currentLedgerSize)) {
      this.signalsTried.add('the open ledger’s current size (nowcast)');
      const pairs = rows.filter((r) => Number.isFinite(r.fee?.currentLedgerSize)).map((r) => [r.fee.currentLedgerSize, r.count]);
      const fit = ridgeOne(pairs.slice(-512), { lambda: 1, log: true });
      if (fit) count['ridge on the current size'] = { name: 'ridge on the current size', ...fit.predict(fee.currentLedgerSize) };
    }
    const serverName = fee?.server ?? this.o.server ?? 'the server';
    if (Number.isFinite(fee?.expectedLedgerSize)) count.server = serverBaseline(fee.expectedLedgerSize, serverName);
    const pRec = this._rec(this.nowcastRecords, 'persistence');
    const split = heldOutCut(pRec.indices(), { share: this.o.tuningShare, min: this.o.minRecord });
    const tuning = [-Infinity, split.cut ?? -Infinity];
    const heldOut = [split.cut ?? Infinity, Infinity];
    let chosen = 'persistence';
    if (split.cut != null) {
      let bestSkill = 0;
      for (const name of Object.keys(count)) {
        if (name === 'persistence') continue;
        const s = this.nowcastRecords.get(name)?.skillAgainst(pRec, tuning[0], tuning[1]);
        if (s && s.n >= this.o.minRecord && s.skill > bestSkill) {
          bestSkill = s.skill;
          chosen = name;
        }
      }
    }
    const shown = { ...count[chosen], name: chosen };
    this.pendingNowcast = { for: index, count, shown };
    const baselines = { persistence: pRec, 'ewma h16': this.nowcastRecords.get('ewma h16'), ...(this.nowcastRecords.get('server') ? { server: this.nowcastRecords.get('server') } : {}) };
    const captured = [proposed != null ? `${num(proposed)} proposed` : 'no proposed stream', fee ? `open-ledger fee ${fee.openLedgerFee ?? '—'} drops · queue ${fee.queueSize ?? '—'} · current size ${fee.currentLedgerSize ?? '—'} · from ${serverName}` : 'no fee result'].join(' · ');
    const lines = [];
    lines.push(`nowcast for ledger #${num(index)}, just before its close, from ${num(rows.length)} closed ledgers and what was in flight for it (${captured})`);
    if (proposed == null && !fee) lines.push('nothing in flight was captured for this ledger (the proposed stream and the fee poll are off, or this recording holds neither): the nowcast is the forecast’s baselines');
    lines.push(describeCountForecast(`count (shown: ${chosen})`, shown, this.nowcastRecords.get('shown'), baselines, heldOut));
    for (const [name, f] of Object.entries(count)) if (f && name !== chosen) lines.push(`  ${describeCountForecast(name, f, this.nowcastRecords.get(name), name === 'persistence' ? {} : { persistence: pRec }, heldOut)}`);
    if (count.server) lines.push(`  ${count.server.name}`);
    lines.push(`  ${split.cut != null ? verdict([...this.nowcastRecords.values()].filter((r) => r.name !== 'shown'), pRec, heldOut, { min: this.o.minRecord }) : split.statement} · ${split.cut != null ? split.statement : ''}`);
    lines.push(`computed in ${Math.max(0, clock() - t0).toFixed(1)} ms`);
    this.lastNowcast = { index, shown, count, lines };
    return { mode: 'nowcast', index, shown, count, lines, inflight: { proposed, fee } };
  }

  // --- the words ---------------------------------------------------------------------------------------

  _readout({ view, all, head, N, counts, count, chosen, shown, fallback, split, tuning, heldOut, mix, mixIntervals, accounts, loopP, takesSeen, interval, wall, t0 }) {
    const lines = [];
    const persistenceRec = this.records.get('persistence');
    const baselines = { persistence: persistenceRec, 'ewma h16': this.records.get('ewma h16') };
    const msPerLedger = this.banks.interval.rope(16)?.n >= 8 ? this.banks.interval.rope(16).mean : null;
    lines.push(`forecast for ledger #${num(N + 1)}, from ${num(view.length)} closed ledger${view.length === 1 ? '' : 's'} (#${num(all[0].index)}–#${num(N)}) · walk-forward: each forecast reads only the sealed past, and is scored when its ledger lands`);
    lines.push(describeCountForecast(`count (shown: ${shown.name})`, shown, this.records.get('shown'), baselines, heldOut));
    if (fallback) lines.push(fallback);
    for (const [name, f] of Object.entries(count)) {
      if (!f || name === shown.name) continue;
      lines.push(`  ${describeCountForecast(name, f, this.records.get(name), name === 'persistence' ? {} : { persistence: persistenceRec }, heldOut)}`);
    }
    const models = [this.models.hmm ? `hmm ${this.models.hmm.states} states (rates ${this.models.hmm.lambda.map((x) => x.toFixed(0)).join('/')}, chosen by the past's held-out likelihood)` : null, this.models.hawkes ? `self-exciting (branching ${this.models.hawkes.branching.toFixed(2)}, β ${this.models.hawkes.beta.toFixed(2)}, a negative binomial interval at the fit's dispersion ${this.models.hawkes.dispersion.toFixed(this.models.hawkes.dispersion >= 10 ? 0 : 1)})` : null, this.models.ridge.size ? 'the one-signal ridges on log(1 + x)' : null].filter(Boolean);
    lines.push(`  ${split.cut != null ? verdict([...this.records.values()].filter((r) => r.name !== 'shown'), persistenceRec, heldOut, { min: this.o.minRecord }) : 'persistence is shown until the held-out portion forms'} · ${split.statement} · ${this.signalsTried.size} signal${this.signalsTried.size === 1 ? '' : 's'} tried (${[...this.signalsTried].join(', ') || 'none yet'})${models.length ? ` · models: ${models.join(', ')}` : ''}`);
    // the type mix
    const mixLine = Object.entries(mix['ewma h16'])
      .filter(([, v]) => v > 0.005)
      .sort((a, b) => b[1] - a[1])
      .map(([c, v]) => `${c} ${Math.round(100 * v)}% (${Math.round(100 * mixIntervals[c][0])}–${Math.round(100 * mixIntervals[c][1])})`)
      .join(' · ');
    const mixE = this.mixRecords.get('ewma h16')?.over(heldOut[0], heldOut[1]);
    const mixP = this.mixRecords.get('persistence')?.over(heldOut[0], heldOut[1]);
    if (mixLine) lines.push(`type mix (h 16 rope of each share): ${mixLine}${mixE?.n ? ` · held-out L1 error ${mixE.mae.toFixed(3)} (persistence ${mixP.mae.toFixed(3)}) over ${mixE.n} ledgers` : ''}`);
    // the accounts
    if (accounts.length) {
      const byCadence = accounts.filter((a) => a.method === 'cadence');
      const ab = this.accountRecord.brierOver(heldOut[0], heldOut[1]);
      const ar = this.accountRateRecord.brierOver(heldOut[0], heldOut[1]);
      lines.push(`the ${accounts.length} most active accounts at #${num(N + 1)}: mean P(transacts) ${avg(accounts.map((a) => a.p)).toFixed(2)}, from their cadence for ${byCadence.length}${byCadence.length ? ` (periods ${[...new Set(byCadence.map((a) => a.period))].sort((x, y) => x - y).join(', ')})` : ''} and their rate for ${accounts.length - byCadence.length}, over the last ${accounts[0].window} ledgers · ${ab.k ? `held-out Brier ${ab.brier.toFixed(3)} (the rate alone ${ar.brier.toFixed(3)}) over ${num(ab.k)} forecasts in ${ab.ledgers} ledgers` : 'no held-out record yet'} · the first five: ${accounts.slice(0, 5).map((a) => `${short(a.address)} ${a.p.toFixed(2)}`).join(', ')}`);
    }
    // the loops
    const loopsHere = (head.loops ?? []).length;
    const lb = this.loopRecord.brierOver(heldOut[0], heldOut[1]);
    lines.push(loopsHere ? `${describeBinaryForecast(`${loopsHere} loop${loopsHere === 1 ? '' : 's'} reported by the shared-price measure at #${num(N)}, taken within ${this.o.loopWithin} ledgers`, loopP, this.loopRecord, heldOut)} · from the base rate of loop-takes (${takesSeen} of ${num(all.length)} ledgers had one)` : `no loop reported at #${num(N)} (the shared-price measure runs with a probe) · loop-takes so far: ${takesSeen} in ${num(all.length)} ledgers${lb.k ? ` · held-out Brier ${lb.brier.toFixed(3)} over ${lb.k}` : ''}`);
    // the close interval
    if (interval) lines.push(describeCountForecast('close interval in ms (from local arrival times; never the header close_time)', interval, this.intervalRecord, {}, heldOut));
    else lines.push(Number.isFinite(head.arrivedAt) ? 'close interval: forming (eight arrival gaps needed)' : 'close interval: no local arrival times in these rows, so not forecast and not scored; the header close_time is never a target');
    lines.push(wall.line);
    lines.push(`ropes (count): ${this.banks.count.ropes.map((r) => r.describe(msPerLedger)).join(' | ')}`);
    lines.push(`wake: ${this.wakes.count.describe()}`);
    for (const w of this.shareWakes.values()) if (w.last && (w.last.recentChangeProbability > 0.5 || w.last.alarm)) lines.push(`wake: ${w.describe()}`);
    if (this.o.mode === 'nowcast') {
      if (this.wakes.fee.last) lines.push(`wake: ${this.wakes.fee.describe()}`);
      if (this.wakes.queue.last) lines.push(`wake: ${this.wakes.queue.describe()}`);
    }
    const inForce = this.wakes.count.current;
    lines.push(`CUSUM threshold h ${inForce.h.toFixed(2)} for an in-control run length of ${inForce.arl} ledgers at the residuals' lag-1 autocorrelation ${(inForce.rho ?? 0).toFixed(1)} (an AR(1) normal law; measured ${inForce.measuredArl.toFixed(0)} on ${num(inForce.runs * 2)} simulated runs, k ${inForce.k}; h ${this.threshold.h.toFixed(2)} if independent) · change-point hazard 1/${Math.round(1 / this.o.hazard)} per ledger${msPerLedger ? ` · a ledger ≈ ${wallLabel(msPerLedger)}` : ''} · the past kept: ${num(this.past.length)} of at most ${num(this.past.max)} ledgers`);
    if (this.lastResolved) {
      const r = this.lastResolved;
      const inside = r.shown?.interval && r.count >= r.shown.interval[0] && r.count <= r.shown.interval[1];
      lines.push(`last resolved: #${num(r.index)} count ${num(r.count)} · ${inside ? 'inside' : 'outside'} the 80% interval shown (${fmt(r.shown.interval[0])}–${fmt(r.shown.interval[1])}, ${r.shown.name}) · persistence said ${r.persistence ?? '—'}`);
    }
    const ms = Math.max(0, clock() - t0);
    lines.push(`computed in ${ms.toFixed(1)} ms over ${num(counts.length)} rows (refits every ${this.o.refitEvery} ledgers, ${this.models.fits} so far)`);
    return {
      version: FORECAST_VERSION,
      mode: this.o.mode,
      N,
      next: N + 1,
      shown,
      chosen,
      count,
      mix: mix['ewma h16'],
      accounts,
      interval,
      split: { cut: split.cut, statement: split.statement },
      wake: { count: this.wakes.count.snapshot() },
      ropes: this.banks.count.snapshot(),
      records: Object.fromEntries([...this.records].map(([k, r]) => [k, r.snapshot(heldOut[0], heldOut[1])])),
      accountRecord: this.accountRecord.snapshot(heldOut[0], heldOut[1]),
      accountRateRecord: this.accountRateRecord.snapshot(heldOut[0], heldOut[1]),
      loopRecord: this.loopRecord.snapshot(heldOut[0], heldOut[1]),
      intervalRecord: this.intervalRecord.snapshot(heldOut[0], heldOut[1]),
      signalsTried: [...this.signalsTried],
      lines,
      ms,
    };
  }

  /** A deterministic fingerprint of the forecasts so far (the parity test compares a replay with a live session): nothing of the clock. */
  fingerprint() {
    const l = this.last;
    if (!l) return 'none';
    return JSON.stringify({
      N: l.N,
      shown: [l.shown.name, l.shown.mean, l.shown.point ?? null, l.shown.interval],
      count: Object.fromEntries(Object.entries(l.count).map(([k, v]) => [k, v && [v.mean, v.point ?? null, v.interval]])),
      records: Object.fromEntries([...this.records].map(([k, r]) => [k, r.snapshot()])),
      accounts: this.accountRecord.snapshot(),
      loops: this.loopRecord.snapshot(),
      interval: this.intervalRecord.snapshot(),
      nowcast: this.lastNowcast ? [this.lastNowcast.index, this.lastNowcast.shown?.name, this.lastNowcast.shown?.mean] : null,
    });
  }
}

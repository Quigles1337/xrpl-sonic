// Series from account_tx (src/account-tx.js): pagination with the bounds
// carried through the marker, a failed page as missing ledgers, the node's
// own bounds as coverage, the validated ledger at query time, and the frame
// src/coherence.js builds from the result.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchAccountTx, fetchAccountSeries, accountTxCommand, unwrapEntry, validatedLedgerOf, uncovered, DEFAULT_PAGE_LIMIT, COVERAGE_REASONS } from '../src/account-tx.js';
import { frameFromAccountTx, coherence, readout, describePair, significant, EXCLUSIONS } from '../src/coherence.js';
import { shortAddress } from '../src/mapping.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const page1 = JSON.parse(readFileSync(join(fixturesDir, 'explorer', 'snapshot', 'account_tx-page1.json'), 'utf8')).result;
const realEntry = page1.transactions[0];

const A = 'rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah';
const B = 'r33SNW2rSBkXGmn84FSKSY4RG4FJ7fUVhk';
const FAST = { retryDelayMs: 0 };

/** A synthetic entry: `account` submitted `type` in `ledger`, optionally to `destination`, with a result. */
function entry(account, ledger, { seq = 1, type = 'Payment', destination = null, result = 'tesSUCCESS', xrp = null } = {}) {
  const hash = `${ledger}${seq}`.padStart(64, '0').toUpperCase().replace(/[^0-9A-F]/g, '0');
  const tx = { TransactionType: type, Account: account, Sequence: seq, hash, ledger_index: ledger, ...(destination ? { Destination: destination } : {}), ...(xrp != null ? { Amount: String(Math.round(xrp * 1e6)) } : {}) };
  const nodes = [{ ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: account } } }];
  if (destination) nodes.push({ ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: destination } } });
  return { tx, meta: { TransactionResult: result, AffectedNodes: nodes, ...(xrp != null && result === 'tesSUCCESS' ? { delivered_amount: String(Math.round(xrp * 1e6)) } : {}) }, validated: true };
}

/**
 * A fake node: an account's entries, served oldest first in pages of `limit`
 * with { ledger, seq } markers; `bounds` narrows what it echoes; `failPage`
 * (1-based, per account) rejects that page `failTimes` times; the validated
 * ledger answers the `ledger` command.
 */
function fakeNode({ entries = {}, limit = 2, bounds = null, failPage = null, failTimes = 1, validated = 1000, errorFor = null } = {}) {
  const calls = [];
  const failures = new Map();
  const request = async (command) => {
    calls.push(command);
    if (command.command === 'ledger') return { result: { ledger_index: validated, ledger_hash: 'C'.repeat(64), ledger: { ledger_index: validated, close_time: 800000000 } } };
    if (command.command !== 'account_tx') throw new Error('unknown command');
    if (errorFor === command.account) {
      const err = new Error('Account not found.');
      err.code = 'actNotFound';
      throw err;
    }
    const all = (entries[command.account] ?? []).filter((e) => e.tx.ledger_index >= command.ledger_index_min && e.tx.ledger_index <= command.ledger_index_max).sort((x, y) => x.tx.ledger_index - y.tx.ledger_index || x.tx.Sequence - y.tx.Sequence);
    const start = command.marker ? all.findIndex((e) => e.tx.ledger_index === command.marker.ledger && e.tx.Sequence === command.marker.seq) : 0;
    const pageNo = Math.floor(start / limit) + 1;
    const key = `${command.account}:${pageNo}`;
    if (failPage === pageNo && (failures.get(key) ?? 0) < failTimes) {
      failures.set(key, (failures.get(key) ?? 0) + 1);
      throw new Error('slowDown');
    }
    const page = all.slice(start, start + limit);
    const next = all[start + limit];
    const echo = bounds ?? { min: command.ledger_index_min, max: command.ledger_index_max };
    return { result: { account: command.account, ledger_index_min: echo.min, ledger_index_max: echo.max, validated: true, limit, transactions: page, ...(next ? { marker: { ledger: next.tx.ledger_index, seq: next.tx.Sequence } } : {}) } };
  };
  return { request, calls };
}

describe('account_tx pages', () => {
  test('the command carries the range, oldest first; entries unwrap both API shapes', () => {
    assert.deepEqual(accountTxCommand(A, { from: 10, to: 20 }), { command: 'account_tx', account: A, ledger_index_min: 10, ledger_index_max: 20, forward: true, limit: DEFAULT_PAGE_LIMIT });
    assert.deepEqual(accountTxCommand(A, { from: 10, to: 20, limit: 5, marker: { ledger: 12, seq: 3 } }).marker, { ledger: 12, seq: 3 });
    const e = unwrapEntry(realEntry);
    assert.equal(e.tx.TransactionType, 'OfferCreate');
    assert.equal(e.hash, realEntry.tx.hash);
    assert.equal(e.ledgerIndex, realEntry.tx.ledger_index);
    assert.equal(e.success, true);
    assert.equal(e.validated, true);
    const v2 = unwrapEntry({ tx_json: { TransactionType: 'Payment', Account: A }, meta: { TransactionResult: 'tecPATH_DRY' }, hash: 'ab'.repeat(32), ledger_index: 77, validated: true });
    assert.deepEqual([v2.hash, v2.ledgerIndex, v2.success], ['AB'.repeat(32), 77, false]);
    assert.equal(unwrapEntry({ meta: {} }), null);
  });

  test('pages follow the marker until the range is complete; the bounds and the validated flag are those of the first page', async () => {
    const mine = [entry(A, 100), entry(A, 100, { seq: 2 }), entry(A, 103, { destination: B }), entry(B, 105, { destination: A }), entry(A, 108, { result: 'tecPATH_DRY' })];
    const node = fakeNode({ entries: { [A]: mine }, limit: 2 });
    const r = await fetchAccountTx(node.request, A, { from: 100, to: 110, ...FAST });
    assert.equal(r.pages, 3);
    assert.equal(r.requests, 3);
    assert.equal(r.entries.length, 5);
    assert.deepEqual(r.bounds, { min: 100, max: 110 });
    assert.equal(r.validated, true);
    assert.deepEqual(r.missing, []);
    assert.equal(r.error, null);
    assert.deepEqual(node.calls.map((c) => [c.ledger_index_min, c.ledger_index_max, c.forward, c.marker ?? null]), [[100, 110, true, null], [100, 110, true, { ledger: 103, seq: 1 }], [100, 110, true, { ledger: 108, seq: 1 }]], 'every page carries the same bounds');
    const empty = await fetchAccountTx(node.request, B, { from: 100, to: 110, ...FAST });
    assert.equal(empty.entries.length, 0);
    assert.equal(empty.pages, 1);
    assert.deepEqual(empty.missing, [], 'no entries is full coverage of a quiet account, not missing ledgers');
  });

  test('a page that fails after its retry leaves the ledgers from the marker’s ledger on as missing, never zero', async () => {
    const mine = [entry(A, 100), entry(A, 101), entry(A, 104), entry(A, 104, { seq: 2 }), entry(A, 109)];
    const node = fakeNode({ entries: { [A]: mine }, limit: 2, failPage: 2, failTimes: 5 });
    const r = await fetchAccountTx(node.request, A, { from: 100, to: 110, retries: 1, ...FAST });
    assert.equal(r.pages, 1);
    assert.equal(r.requests, 3, 'one page, then the failed page and its one retry');
    assert.equal(r.entries.length, 2);
    assert.deepEqual(r.missing, [{ from: 104, to: 110, reason: 'missing' }], 'the marker’s ledger was covered only in part: it is missing with everything after it');
    assert.equal(r.error, 'slowDown');
    const flaky = fakeNode({ entries: { [A]: mine }, limit: 2, failPage: 2, failTimes: 1 });
    const ok = await fetchAccountTx(flaky.request, A, { from: 100, to: 110, retries: 1, ...FAST });
    assert.equal(ok.entries.length, 5, 'one failure is retried and the page arrives');
    assert.deepEqual(ok.missing, []);
    const first = fakeNode({ entries: { [A]: mine }, limit: 2, failPage: 1, failTimes: 5 });
    const none = await fetchAccountTx(first.request, A, { from: 100, to: 110, retries: 0, ...FAST });
    assert.deepEqual(none.missing, [{ from: 100, to: 110, reason: 'missing' }], 'the first page failing leaves the whole range missing');
    assert.equal(none.bounds, null);
    const unknown = await fetchAccountTx(fakeNode({ errorFor: A }).request, A, { from: 100, to: 110, retries: 0, ...FAST });
    assert.equal(unknown.error, 'Account not found.');
    assert.deepEqual(unknown.missing, [{ from: 100, to: 110, reason: 'missing' }]);
    assert.deepEqual((await fetchAccountTx(node.request, A, { from: 0, to: 10 })).missing, [{ from: 0, to: 10, reason: 'missing' }], 'a bad range is missing with an error');
  });

  test('the node’s own bounds are coverage: narrower than the request is outside its history or beyond its validated ledger', async () => {
    const mine = [entry(A, 100), entry(A, 105)];
    const node = fakeNode({ entries: { [A]: mine }, limit: 10, bounds: { min: 102, max: 107 } });
    const r = await fetchAccountTx(node.request, A, { from: 100, to: 110, ...FAST });
    assert.deepEqual(r.bounds, { min: 102, max: 107 });
    assert.deepEqual(r.missing, [{ from: 100, to: 101, reason: 'history' }, { from: 108, to: 110, reason: 'unvalidated' }]);
    const u = uncovered(r, 100, 110);
    assert.deepEqual([...u.set].sort((x, y) => x - y), [100, 101, 108, 109, 110]);
    assert.equal(u.reasons.get(100), 'history');
    assert.equal(u.reasons.get(110), 'unvalidated');
    assert.deepEqual(Object.keys(COVERAGE_REASONS), ['missing', 'history', 'unvalidated']);
    assert.equal(EXCLUSIONS.history, COVERAGE_REASONS.history);
  });

  test('the series fetch: the validated ledger first, one account at a time, ledgers past it missing', async () => {
    const mine = [entry(A, 100), entry(B, 101, { destination: A })];
    const node = fakeNode({ entries: { [A]: mine, [B]: [mine[1]] }, limit: 10, validated: 105 });
    const r = await fetchAccountSeries(node.request, [{ address: A, label: 'Ay' }, { address: B }], { from: 100, to: 110, ...FAST });
    assert.deepEqual(r.validatedLedger, { index: 105, hash: 'C'.repeat(64), closeTime: 800000000 });
    assert.equal(node.calls[0].command, 'ledger');
    assert.deepEqual(r.accounts.map((x) => [x.account, x.label, x.entries.length]), [[A, 'Ay', 2], [B, null, 1]]);
    assert.deepEqual(r.accounts[0].missing, [{ from: 106, to: 110, reason: 'unvalidated' }], 'the ledgers after the validated one at query time are not there to be covered');
    assert.ok(r.ms >= 0);
    assert.equal(await validatedLedgerOf(async () => { throw new Error('no'); }), null);
  });
});

describe('the frame from account_tx', () => {
  test('one row per ledger of the range, used when every account covered it; submitted, involved and volume series; the touch records', async () => {
    const mine = [entry(A, 100, { xrp: 10 }), entry(A, 100, { seq: 2, destination: B, xrp: 99 }), entry(B, 101, { destination: A, xrp: 1 }), entry(A, 103, { result: 'tecPATH_DRY', xrp: 5 }), entry(B, 103, { seq: 2 })];
    const involvedA = mine.filter((e) => e.tx.Account === A || e.tx.Destination === A);
    const involvedB = mine.filter((e) => e.tx.Account === B || e.tx.Destination === B);
    const node = fakeNode({ entries: { [A]: involvedA, [B]: involvedB }, limit: 10, validated: 104 });
    const fetched = await fetchAccountSeries(node.request, [{ address: A, label: 'Ay' }, { address: B, label: 'Bee' }], { from: 100, to: 106, ...FAST });
    const frame = frameFromAccountTx(fetched, { host: 'example.test' });
    assert.equal(frame.source, 'account_tx');
    assert.equal(frame.chosen, 'named accounts');
    assert.deepEqual(frame.ledgers.map((l) => [l.index, l.included, l.reason]), [[100, true, null], [101, true, null], [102, true, null], [103, true, null], [104, true, null], [105, false, 'unvalidated'], [106, false, 'unvalidated']]);
    assert.deepEqual(frame.accounts, [{ address: A, label: 'Ay' }, { address: B, label: 'Bee' }]);
    assert.deepEqual(frame.series.get(A), [2, 0, 0, 0, 0, 0, 0], 'submitted, the failed one out');
    assert.deepEqual(frame.series.get(B), [0, 1, 0, 1, 0, 0, 0]);
    assert.deepEqual([...frame.totals.entries()], [[A, 2], [B, 2]]);
    assert.deepEqual(frameFromAccountTx(fetched, { measure: 'involved' }).series.get(A), [2, 1, 0, 0, 0, 0, 0], 'involved counts the payment B sent to A');
    assert.deepEqual(frameFromAccountTx(fetched, { includeFailed: true }).series.get(A), [2, 0, 0, 1, 0, 0, 0]);
    const vol = frameFromAccountTx(fetched, { measure: 'volume' }).series.get(A);
    assert.ok(Math.abs(vol[0] - (Math.log10(11) + Math.log10(100))) < 1e-9, 'log volume from the delivered XRP');
    assert.equal(frame.records.length, 5, 'every entry once, the failed one in the record too, the payment between them not twice');
    assert.equal(frame.fetched.host, 'example.test');
    assert.deepEqual(frame.fetched.accounts.map((x) => [x.label, x.pages, x.entries, x.missing.length]), [['Ay', 1, 4, 1], ['Bee', 1, 3, 1]]);
    assert.equal(frameFromAccountTx(null).ledgers.length, 0);
    assert.equal(frameFromAccountTx({ from: 5, to: 2, accounts: [] }).ledgers.length, 0);
  });

  test('the readout names the source, the validated ledger, each account’s bounds and pages, and the record', async () => {
    const extraA = [1, 2, 5, 7, 8, 12, 13, 17, 22, 25, 28];
    const extraB = [0, 3, 4, 9, 11, 14, 15, 19, 21, 26];
    const mine = Array.from({ length: 30 }, (_, i) => [entry(A, 100 + i, { destination: i % 3 === 0 ? B : null, xrp: 1 + (i % 4) }), ...(extraA.includes(i) ? [entry(A, 100 + i, { seq: 5, xrp: 2 })] : [])]).flat();
    const theirs = Array.from({ length: 30 }, (_, i) => [entry(B, 100 + i, { seq: 2 + (i % 2), xrp: 1 + ((i * 7) % 5) }), ...(extraB.includes(i) ? [entry(B, 100 + i, { seq: 7, xrp: 3 })] : [])]).flat();
    const node = fakeNode({ entries: { [A]: mine, [B]: [...theirs, ...mine.filter((e) => e.tx.Destination === B)] }, limit: 25, validated: 140 });
    const fetched = await fetchAccountSeries(node.request, [{ address: A, label: 'Ay' }, { address: B, label: 'Bee' }], { from: 100, to: 129, ...FAST });
    const report = coherence(frameFromAccountTx(fetched, { host: 's2.ripple.com' }));
    const text = readout(report);
    assert.match(text, /^coherence v3 · account_tx #100–#129 · 30 of 30 ledgers used\n/);
    assert.match(text, /series: transactions submitted per ledger, from account_tx \(failed excluded\) · accounts: named accounts · lags ±7 ledgers/);
    assert.match(text, /\naccount_tx on s2\.ripple\.com · validated ledger #140 at query time · Ay: bounds #100–#129, 2 pages in 2 requests, 41 entries; Bee: bounds #100–#129, 2 pages in 2 requests, 50 entries\n/);
    assert.match(text, /\nrecord: 81 transactions of the named accounts in the ledgers used · pairs tested: 1 · above the 95th of their shuffles: raw 0, prewhitened 0 · chance alone gives about 0\.0 of 0 · 1 pair with fewer than 20 shifts, where the 95th cannot be resolved\n/);
    assert.match(text, /prewhitened r -?\d\.\d\d at lag [+-]?\d+ .* above \d+% of shuffles \(\d+ of \d+; 1 pair tested\) · raw r/);
    const pair = report.pairs[0];
    assert.equal(pair.record.count, 10, 'the ten payments from A to B connect the pair');
    assert.equal(pair.record.byKind.destination, 10);
    assert.match(text, /connected in the record: 10 transactions \(10 destination\)/);
    assert.match(text, /\n  record: 0+1001 \(#100, by Ay: the other is the Destination\); .*; and 2 more$/m);
  });
});

describe('the recorded 1000-ledger account_tx window', () => {
  // Derived from real account_tx pages (test/fixtures/coherence/accounttx-107821080-107822079.json):
  // the numbers here are the as-built table of docs/coherence.md, phase 1.5.
  const fx = JSON.parse(readFileSync(join(fixturesDir, 'coherence', 'accounttx-107821080-107822079.json'), 'utf8'));
  /** The frame the fixture stands for, built as frameFromAccountTx builds it (the fixture keeps the series, not the entries). */
  function frameOfFixture(measure = 'count') {
    const reasons = new Map();
    for (const a of fx.accounts) for (const [n, reason] of uncovered(a, fx.from, fx.to).reasons) if (!reasons.has(n)) reasons.set(n, reason);
    const ledgers = [];
    for (let n = fx.from; n <= fx.to; n++) ledgers.push({ index: n, included: !reasons.has(n), reason: reasons.get(n) ?? null, hash: null });
    const accounts = fx.accounts.map((a) => ({ address: a.address, label: shortAddress(a.address) }));
    const key = measure === 'volume' ? 'volumes' : measure === 'involved' ? 'involved' : 'counts';
    return {
      source: 'account_tx',
      measure,
      ledgers,
      accounts,
      series: new Map(fx.accounts.map((a) => [a.address, a[key]])),
      totals: new Map(fx.accounts.map((a) => [a.address, a.counts.reduce((x, y) => x + y, 0)])),
      chosen: 'named accounts',
      records: fx.records,
      fetched: { host: fx.host, validatedLedger: fx.validatedLedger, includeFailed: false, accounts: fx.accounts.map((a) => ({ address: a.address, label: shortAddress(a.address), bounds: a.bounds, pages: a.pages, requests: a.requests, entries: a.entries, missing: a.missing, error: a.error })) },
    };
  }
  const wrow = (p) => [p.a.label, p.b.label, Number(p.r.toFixed(2)), p.lag, p.shuffle.above, p.shuffle.count, Number(p.white.r.toFixed(2)), p.white.lag, p.white.shuffle.above, p.white.shuffle.count, p.white.ar.a, p.white.ar.b, p.white.n, p.record.count];

  test('the fetch: every page arrived from s2, the bounds echoed as requested, nothing missing', () => {
    assert.equal(fx.to - fx.from + 1, 1000);
    assert.equal(fx.host, 's2.ripple.com');
    assert.ok(fx.validatedLedger.index > fx.to && /^[0-9A-F]{64}$/.test(fx.validatedLedger.hash));
    assert.deepEqual(fx.accounts.map((a) => [shortAddress(a.address), a.pages, a.entries, a.missing.length, a.error]), [['rBTw…jjah', 81, 16133, 0, null], ['rMsX…xgfY', 19, 3780, 0, null], ['rLCN…Ujm5', 13, 2563, 0, null], ['rEqY…NLNF', 10, 1903, 0, null], ['rURt…bKns', 11, 2112, 0, null]]);
    assert.ok(fx.accounts.every((a) => a.requests >= a.pages && a.bounds.min === fx.from && a.bounds.max === fx.to));
    assert.ok(fx.accounts.every((a) => a.counts.length === 1000 && a.involved.length === 1000 && a.volumes.length === 1000));
    assert.equal(fx.recordsTotal, 26447);
    assert.equal(fx.records.length, 44, 'the touch records in which two of the five touch');
  });

  test('count series over 1000 ledgers: |r| falls to 0.04–0.10, one pair of ten above the 95th after prewhitening with no connection (co-activity), the only connected pair not coherent', () => {
    const report = coherence(frameOfFixture());
    assert.equal(report.window.used, 1000);
    assert.equal(report.maxLag, 8);
    assert.deepEqual(report.accounts.map((a) => [a.label, a.events, a.ar, a.cadence?.period ?? null, a.cadence ? Number(a.cadence.r.toFixed(2)) : null]), [['rBTw…jjah', 16133, 5, 3, 0.75], ['rMsX…xgfY', 3779, 5, 3, 0.31], ['rLCN…Ujm5', 2563, 8, null, null], ['rEqY…NLNF', 1903, 4, null, null], ['rURt…bKns', 1913, 5, null, null]]);
    assert.deepEqual([report.tested, report.above.raw, report.above.white, report.above.resolved, report.above.unresolved], [10, 1, 1, 10, 0]);
    assert.ok(Math.abs(report.above.expected - 0.5) < 1e-9);
    assert.deepEqual(report.pairs.map(wrow), [
      ['rLCN…Ujm5', 'rURt…bKns', 0.08, -6, 135, 200, 0.08, -6, 195, 200, 8, 5, 992, 0],
      ['rLCN…Ujm5', 'rEqY…NLNF', 0.08, -5, 145, 200, 0.08, -5, 180, 200, 8, 4, 992, 0],
      ['rEqY…NLNF', 'rURt…bKns', 0.1, -1, 191, 200, 0.08, 0, 164, 200, 4, 5, 995, 44],
      ['rMsX…xgfY', 'rURt…bKns', 0.08, -1, 174, 200, -0.08, 3, 134, 200, 5, 5, 995, 0],
      ['rBTw…jjah', 'rMsX…xgfY', 0.05, 2, 33, 200, 0.06, 0, 92, 200, 5, 5, 995, 0],
      ['rBTw…jjah', 'rLCN…Ujm5', 0.07, 3, 152, 200, 0.06, -5, 72, 200, 5, 8, 992, 0],
      ['rMsX…xgfY', 'rLCN…Ujm5', 0.05, 1, 34, 200, 0.06, 1, 60, 200, 5, 8, 992, 0],
      ['rBTw…jjah', 'rEqY…NLNF', 0.05, 1, 89, 200, -0.06, -3, 44, 200, 5, 4, 995, 0],
      ['rBTw…jjah', 'rURt…bKns', 0.04, 3, 17, 200, -0.05, -3, 26, 200, 5, 5, 995, 0],
      ['rMsX…xgfY', 'rEqY…NLNF', -0.04, -2, 15, 200, 0.04, -1, 2, 200, 5, 4, 995, 0],
    ]);
    assert.ok(report.pairs.every((p) => p.shuffle.available === 1000 - 2 * 8 - 1 && p.shuffle.count === 200), '983 admissible shifts, 200 drawn');
    const top = report.pairs[0];
    assert.equal(significant(top), true);
    assert.equal(describePair(top), 'rLCN…Ujm5 ↔ rURt…bKns: prewhitened r 0.08 at lag -6 (rLCN…Ujm5 follows rURt…bKns by 6 ledgers) above 98% of shuffles (195 of 200; 10 pairs tested) · raw r 0.08 at lag -6 above 68% of shuffles (135 of 200; 10 pairs tested) · 1000 ledgers (overlap 994; 992 residual rows after AR(8)/AR(5), overlap 986) · events 2563/1913 · co-activity, not a relation: not connected in this window · 3 parts of 333: lag -6 (r 0.14), +4 (r -0.12), -2 (r -0.09)');
    const connected = report.pairs[2];
    assert.deepEqual([connected.record.count, connected.record.byKind.crossed, connected.record.failed], [44, 44, 0]);
    assert.ok(connected.record.transactions.every((t) => t.by === 'rEqYHwNakMkL5FVVewd1cBUNs6EphiNLNF' && t.kind === 'crossed'), 'every connection is rEqY…NLNF crossing an offer of rURt…bKns');
    assert.equal(significant(connected), false, 'sharing a book is not acting in step: 164 of 200 after prewhitening');
    assert.match(describePair(connected), / · connected in the record: 44 transactions \(44 crossed\) · /);
    assert.ok(report.pairs.every((p) => Math.abs(p.r) <= 0.11 && Math.abs(p.white.r) <= 0.11), 'the standard error at 1000 ledgers is about 0.03; the peak over 17 lags of noise about 0.08');
    assert.deepEqual(report.pairs[4].beat, { shared: 3 }, 'the two market makers share a three-ledger cadence');
    const lines = readout(report).split('\n');
    assert.equal(lines[0], 'coherence v3 · account_tx #107821080–#107822079 · 1000 of 1000 ledgers used');
    assert.match(lines[2], /^account_tx on s2\.ripple\.com · validated ledger #\d+ at query time · rBTw…jjah: bounds #107821080–#107822079, 81 pages in \d+ requests, 16133 entries; rMsX…xgfY: bounds #107821080–#107822079, 19 pages in \d+ requests, 3780 entries; /);
    assert.equal(lines[4], 'record: 44 transactions of the named accounts in the ledgers used · pairs tested: 10 · above the 95th of their shuffles: raw 1, prewhitened 1 · chance alone gives about 0.5 of 10', 'the fixture keeps the 44 connecting records of the 26,447');
    assert.equal(lines.length, 6 + 10 + 1, 'five header lines, the tier line, ten pairs and one line of hashes');
  });

  test('the involved series counts a shared transaction on both sides, so the connected pair correlates by construction; the volume series makes the issued-currency trader flat', () => {
    const involved = coherence(frameOfFixture('involved'));
    assert.deepEqual(wrow(involved.pairs[0]), ['rEqY…NLNF', 'rURt…bKns', 0.2, 0, 200, 200, 0.17, 0, 200, 200, 4, 5, 995, 44]);
    assert.equal(significant(involved.pairs[0]), true, 'the 44 crossings are in both series: this is the record check seen as a correlation, which is why submitted is the primary measure');
    assert.deepEqual(involved.pairs.slice(1).map((p) => p.a.label + p.b.label), ['rLCN…Ujm5rEqY…NLNF', 'rLCN…Ujm5rURt…bKns', 'rMsX…xgfYrURt…bKns', 'rBTw…jjahrMsX…xgfY', 'rBTw…jjahrLCN…Ujm5', 'rMsX…xgfYrLCN…Ujm5', 'rBTw…jjahrEqY…NLNF', 'rBTw…jjahrURt…bKns', 'rMsX…xgfYrEqY…NLNF']);
    const volume = coherence(frameOfFixture('volume'));
    assert.deepEqual(volume.accounts.map((a) => a.ar), [5, null, 8, 4, 3]);
    assert.equal(volume.pairs.filter((p) => p.flat?.a || p.flat?.b).length, 4, 'rMsX…xgfY moves no XRP');
    assert.deepEqual([volume.tested, volume.above.raw, volume.above.white], [6, 0, 0]);
    assert.deepEqual(wrow(volume.pairs[0]), ['rBTw…jjah', 'rLCN…Ujm5', 0.07, 3, 171, 200, 0.07, -5, 97, 200, 5, 8, 992, 0]);
  });
});

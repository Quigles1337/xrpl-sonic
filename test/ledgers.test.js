import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateCase } from '../src/case.js';
import { fetchCaseLedgers, caseLedgerIndices, caseHeaderIndices, ledgerCommand, DEFAULT_CONCURRENCY } from '../src/ledgers.js';

const FAST = { retryDelayMs: 0 };

const twoClips = () => validateCase({ clips: [{ from: 100, to: 102 }, { from: 110, to: 110 }] }).case;

/** A fake node: answers ledger commands after a tick, records calls, fails the indices in `failing`. */
function fakeNode({ failing = [], flaky = [], delay = 1 } = {}) {
  const calls = [];
  const seen = new Map();
  let inFlight = 0;
  let maxInFlight = 0;
  const request = (command) =>
    new Promise((resolve, reject) => {
      calls.push(command);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        const n = (seen.get(command.ledger_index) ?? 0) + 1;
        seen.set(command.ledger_index, n);
        if (failing.includes(command.ledger_index)) return reject(new Error('ledgerNotFound'));
        if (flaky.includes(command.ledger_index) && n === 1) return reject(new Error('slowDown'));
        resolve({ result: { ledger: { ledger_index: command.ledger_index, close_time: 800_000_000 + command.ledger_index * 4, transactions: command.transactions ? [] : undefined } } });
      }, delay);
    });
  return { request, calls, get maxInFlight() { return maxInFlight; } };
}

describe('ledger index planning', () => {
  test('full indices follow the clips in order; headers are the ledger after each clip', () => {
    const c = twoClips();
    assert.deepEqual(caseLedgerIndices(c), [100, 101, 102, 110]);
    assert.deepEqual(caseHeaderIndices(c), [103, 111]);
    const adjacent = validateCase({ clips: [{ from: 5, to: 6 }, { from: 7, to: 7 }] }).case;
    assert.deepEqual(caseHeaderIndices(adjacent), [8], 'a header already fetched in full is not fetched again');
  });

  test('ledgerCommand asks for expanded transactions only for full fetches', () => {
    assert.deepEqual(ledgerCommand(7), { command: 'ledger', ledger_index: 7, transactions: true, expand: true });
    assert.deepEqual(ledgerCommand(7, { full: false }), { command: 'ledger', ledger_index: 7 });
  });
});

describe('fetchCaseLedgers', () => {
  test('fetches every ledger and header, resolves next close times, reports progress', async () => {
    const node = fakeNode();
    const progress = [];
    const { ledgers, failures } = await fetchCaseLedgers(node.request, twoClips(), { ...FAST, onProgress: (d, t) => progress.push([d, t]) });
    assert.deepEqual([...ledgers.keys()], [100, 101, 102, 110]);
    assert.equal(ledgers.get(100).nextCloseTime, 800_000_000 + 101 * 4, 'from the next full ledger');
    assert.equal(ledgers.get(102).nextCloseTime, 800_000_000 + 103 * 4, 'from the header after the clip');
    assert.equal(ledgers.get(110).nextCloseTime, 800_000_000 + 111 * 4);
    assert.deepEqual(failures, []);
    assert.equal(node.calls.length, 6);
    assert.ok(node.calls.filter((c) => c.transactions).length === 4);
    assert.deepEqual(progress.at(-1), [6, 6]);
    assert.equal(progress.length, 6);
    assert.ok(node.maxInFlight <= DEFAULT_CONCURRENCY && node.maxInFlight > 1);
  });

  test('a failed ledger is marked unavailable, a failed header just loses the close time', async () => {
    const node = fakeNode({ failing: [101, 111] });
    const { ledgers, failures } = await fetchCaseLedgers(node.request, twoClips(), { ...FAST, concurrency: 1 });
    assert.equal(ledgers.get(101).ledger, null);
    assert.ok(ledgers.get(100).ledger);
    assert.equal(ledgers.get(100).nextCloseTime, null, 'the next ledger failed, so no close time');
    assert.equal(ledgers.get(110).nextCloseTime, null);
    assert.deepEqual(failures, [{ index: 101, error: 'ledgerNotFound' }]);
    assert.equal(node.maxInFlight, 1);
    assert.equal(node.calls.filter((c) => c.ledger_index === 101).length, 2, 'a failing ledger is tried twice');
  });

  test('a request that fails once is retried and succeeds', async () => {
    const node = fakeNode({ flaky: [100, 103] });
    const { ledgers, failures } = await fetchCaseLedgers(node.request, twoClips(), FAST);
    assert.ok(ledgers.get(100).ledger, 'second attempt succeeded');
    assert.equal(ledgers.get(102).nextCloseTime, 800_000_000 + 103 * 4, 'the retried header supplies the close time');
    assert.deepEqual(failures, []);
    assert.equal(node.calls.filter((c) => c.ledger_index === 100).length, 2);
  });

  test('a node error response (no ledger) carries the node message', async () => {
    const request = async () => ({ status: 'error', error: 'slowDown', error_message: 'Too many requests' });
    const { failures } = await fetchCaseLedgers(request, validateCase({ clips: ['5'] }).case, FAST);
    assert.deepEqual(failures, [{ index: 5, error: 'Too many requests' }]);
  });

  test('an aborted signal stops issuing requests', async () => {
    const node = fakeNode();
    const signal = { aborted: true };
    const { ledgers } = await fetchCaseLedgers(node.request, twoClips(), { ...FAST, signal });
    assert.equal(node.calls.length, 0);
    assert.ok(ledgers.get(100).ledger === null);
  });
});

describe('fetchCaseLedgers for the loader (src/loader.js)', () => {
  test('attempts bounds the tries per ledger, and a response’s source is carried into the Map', async () => {
    const calls = [];
    const request = async (cmd) => {
      calls.push(cmd.ledger_index);
      if (cmd.ledger_index === 101) throw new Error('slowDown');
      return { result: { ledger: { ledger_index: cmd.ledger_index, close_time: 1000 + cmd.ledger_index, transactions: cmd.transactions ? [] : undefined } }, source: cmd.ledger_index === 100 ? 'bundle' : 'node' };
    };
    const c = validateCase({ clips: [{ from: 100, to: 101 }] }).case;
    const { ledgers, failures } = await fetchCaseLedgers(request, c, { ...FAST, attempts: 1, concurrency: 1 });
    assert.deepEqual(calls, [100, 101, 102], 'each once');
    assert.deepEqual(failures, [{ index: 101, error: 'slowDown' }]);
    assert.equal(ledgers.get(100).source, 'bundle');
    assert.equal(ledgers.get(101).source, null);
    assert.equal(ledgers.get(101).ledger, null);
    const again = await fetchCaseLedgers(request, c, { ...FAST, concurrency: 1 });
    assert.equal(calls.length, 3 + 4, 'the default tries a failing ledger twice');
    assert.equal(again.ledgers.get(100).source, 'bundle');
  });
});

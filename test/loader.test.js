// The loader policy (src/loader.js, docs/loader.md): an endpoint per request
// kind, pacing between expanded fetches, backing off on the node's slow-down
// signal and moving to the next node after repeated refusals, the cache by
// network, index and hash, the bundle before the cache before the node, and
// a whole case through fetchCaseLedgers with its sources counted.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ENDPOINTS, KINDS, kindOf, endpointsFor, PACE, BACKOFF, isSlowDown, retryAfterMs, backoffMs, paceFor, cacheKey, caseHashes, MemoryCache, createBundle, LedgerLoader, describeSources } from '../src/loader.js';
import { NETWORKS } from '../src/ws.js';
import { validateCase } from '../src/case.js';

/** A clock and a sleep that advance together, so pacing is tested without waiting. */
function fakeTime() {
  let t = 1_000_000;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms) => (t += ms),
    sleeps,
  };
}

const HASH = (n) => n.toString(16).toUpperCase().padStart(64, '0');
const ledgerResult = (n, { full = true, validated = true } = {}) => ({ ledger_hash: HASH(n), ledger_index: n, validated, ledger: { ledger_index: String(n), ledger_hash: HASH(n), close_time: 800_000_000 + n * 4, closed: true, ...(full ? { transactions: [] } : {}) } });

/** A fake node: answers after no time, records calls, refuses by script. */
function fakeNode({ refuse = () => null, fail = () => null } = {}) {
  const calls = [];
  const request = async (cmd) => {
    calls.push(cmd);
    const r = refuse(cmd, calls.length);
    if (r) throw Object.assign(new Error(r.message ?? 'refused'), { code: r.code });
    const f = fail(cmd, calls.length);
    if (f) throw f;
    return { result: ledgerResult(Number(cmd.ledger_index), { full: Boolean(cmd.transactions) }) };
  };
  return { request, calls };
}

describe('endpoints per request kind', () => {
  test('the live subscription keeps its list; history goes to the Ripple nodes first, the cluster last; testnet has one list', () => {
    assert.deepEqual(KINDS, ['stream', 'history']);
    assert.deepEqual(ENDPOINTS.mainnet.stream, NETWORKS.mainnet.endpoints);
    assert.deepEqual(endpointsFor('mainnet', 'history'), ['wss://s2.ripple.com', 'wss://s1.ripple.com', 'wss://xrplcluster.com']);
    assert.deepEqual(endpointsFor('mainnet', 'stream'), ['wss://xrplcluster.com', 'wss://s1.ripple.com', 'wss://s2.ripple.com']);
    assert.deepEqual(endpointsFor('testnet', 'history'), NETWORKS.testnet.endpoints);
    assert.deepEqual(endpointsFor('nope'), endpointsFor('mainnet', 'history'), 'an unknown network reads as mainnet');
    assert.notEqual(endpointsFor('mainnet'), endpointsFor('mainnet'), 'a copy each time');
  });

  test('kindOf: the record is history; subscriptions, pings, fees and server state are the stream’s', () => {
    for (const c of ['ledger', 'tx', 'account_tx', 'account_info', 'account_lines', 'account_objects', 'account_nfts', 'book_offers', 'ledger_entry']) assert.equal(kindOf({ command: c }), 'history', c);
    for (const c of ['subscribe', 'unsubscribe', 'ping', 'fee', 'server_info', 'server_state', 'nope']) assert.equal(kindOf({ command: c }), 'stream', c);
    assert.equal(kindOf(null), 'stream');
  });
});

describe('pacing and backing off', () => {
  test('the pace per endpoint, measured; headers are cheap', () => {
    assert.equal(paceFor('wss://s2.ripple.com'), 1200);
    assert.equal(paceFor('wss://xrplcluster.com'), 1700);
    assert.equal(paceFor('wss://elsewhere.example'), PACE.default);
    assert.equal(paceFor('wss://s2.ripple.com', { full: false }), PACE.header);
    assert.equal(paceFor(null), PACE.default);
  });

  test('the slow-down signal: the three codes, or a message that says so; the node’s own retry-in is honoured, else the doubling, capped', () => {
    assert.ok(isSlowDown({ code: 'slowDown' }));
    assert.ok(isSlowDown({ code: 'tooBusy', message: 'rate limit: units quota (2000 per 10s) exhausted, retry in ~9623ms' }));
    assert.ok(isSlowDown({ code: 'noNetwork' }));
    assert.ok(isSlowDown(new Error('You are placing too much load on the server.')));
    assert.ok(isSlowDown(new Error('The server is too busy to help you now.')));
    assert.ok(!isSlowDown({ code: 'lgrNotFound', message: 'Ledger not found.' }));
    assert.ok(!isSlowDown(null));
    assert.equal(retryAfterMs({ message: 'rate limit: units quota (2000 per 10s) exhausted, retry in ~9623ms' }), 9623);
    assert.equal(retryAfterMs({ message: 'retry in 500 ms' }), 500);
    assert.equal(retryAfterMs(new Error('slow down')), null);
    assert.equal(backoffMs(1), BACKOFF.baseMs);
    assert.equal(backoffMs(2), BACKOFF.baseMs * 2);
    assert.equal(backoffMs(3), BACKOFF.baseMs * 4);
    assert.equal(backoffMs(20), BACKOFF.maxMs, 'capped');
    assert.equal(backoffMs(1, { message: 'retry in ~9623ms' }), 9623, 'the node’s own wait');
    assert.equal(backoffMs(1, { message: 'retry in ~99999999ms' }), BACKOFF.maxMs, 'capped too');
  });

  test('expanded fetches are spaced by the endpoint’s pace, reserved in call order; headers by the header pace; a hit in the bundle or the cache waits for nothing', async () => {
    const time = fakeTime();
    const node = fakeNode();
    const loader = new LedgerLoader({ request: node.request, endpoint: () => 'wss://s2.ripple.com', now: time.now, sleep: time.sleep });
    const t0 = time.now();
    const a = loader.get(1);
    const b = loader.get(2);
    const c = loader.get(3, { full: false });
    await Promise.all([a, b, c]);
    // the fake clock advances inside each sleep, so each wait is measured from the end of the one before: the slots are at 0, 1,200 and 2,400 ms
    assert.deepEqual(time.sleeps, [1200, 1200], 'the first goes at once, the second waits a pace, the header (reserved third) waits for the two paces before it');
    assert.equal(time.now() - t0, 2400);
    assert.equal(loader.nextAt - t0, 2600, 'the next slot is a header pace after the third');
    assert.equal(node.calls.length, 3);
    time.sleeps.length = 0;
    await loader.get(4);
    assert.deepEqual(time.sleeps, [200], 'after a header slot only the header pace remains');
  });

  test('a refusal is waited out and the fetch retried; after three in a row the socket rotates; the node’s retry-in is used when given', async () => {
    const time = fakeTime();
    const rotations = [];
    const events = [];
    let refusals = 0;
    const node = fakeNode({ refuse: (cmd, n) => (refusals++ < 4 ? (refusals === 2 ? { code: 'tooBusy', message: 'rate limit: units quota (2000 per 10s) exhausted, retry in ~9623ms' } : { code: 'slowDown', message: 'You are placing too much load on the server.' }) : null) });
    const loader = new LedgerLoader({ request: node.request, endpoint: () => 'wss://s2.ripple.com', rotate: () => rotations.push(time.now()), onEvent: (e) => events.push(e), now: time.now, sleep: time.sleep });
    const r = await loader.get(7);
    assert.equal(r.source, 'node');
    assert.equal(node.calls.length, 5, 'four refusals, then the answer');
    assert.deepEqual(time.sleeps, [1500, 9623, 6000, 12000], 'base, the node’s own wait, then the doubling goes on (third and fourth attempts)');
    assert.equal(rotations.length, 1, 'rotated once, after the third refusal in a row');
    assert.deepEqual(events.map((e) => e.type), ['slow-down', 'slow-down', 'slow-down', 'rotate', 'slow-down']);
    assert.deepEqual(events[0], { type: 'slow-down', host: 's2.ripple.com', code: 'slowDown', delayMs: 1500, attempt: 1 });
    assert.equal(loader.stats.slowDowns, 4);
    assert.equal(loader.stats.rotations, 1);
  });

  test('more refusals than the policy bears gives the ledger up; an error that is not a refusal is retried once', async () => {
    const time = fakeTime();
    const always = fakeNode({ refuse: () => ({ code: 'slowDown', message: 'You are placing too much load on the server.' }) });
    const loader = new LedgerLoader({ request: always.request, now: time.now, sleep: time.sleep });
    await assert.rejects(loader.get(1), (err) => err.code === 'slowDown');
    assert.equal(always.calls.length, BACKOFF.maxSlowDowns + 1);
    const flaky = fakeNode({ fail: (cmd, n) => (n === 1 ? Object.assign(new Error('Ledger not found.'), { code: 'lgrNotFound' }) : null) });
    const l2 = new LedgerLoader({ request: flaky.request, now: time.now, sleep: time.sleep });
    time.sleeps.length = 0;
    assert.equal((await l2.get(2)).source, 'node');
    assert.equal(flaky.calls.length, 2);
    assert.deepEqual(time.sleeps, [BACKOFF.retryDelayMs, PACE.default - BACKOFF.retryDelayMs], 'the retry waits its delay and then the rest of the pace');
    const dead = fakeNode({ fail: () => Object.assign(new Error('Ledger not found.'), { code: 'lgrNotFound' }) });
    const l3 = new LedgerLoader({ request: dead.request, now: time.now, sleep: time.sleep });
    await assert.rejects(l3.get(3), /Ledger not found/);
    assert.equal(dead.calls.length, 2, 'tried twice, then given up');
  });

  test('a node that cannot be reached (code noNode) ends the load’s node fetches at once; the bundle and the cache still answer', async () => {
    const time = fakeTime();
    const node = fakeNode({ fail: () => Object.assign(new Error('no history node answered within 20 s'), { code: 'noNode' }) });
    const cache = new MemoryCache();
    await cache.put({ network: 'mainnet', index: 5, hash: HASH(5), full: true, result: ledgerResult(5), storedAt: 1 });
    const events = [];
    const loader = new LedgerLoader({ request: node.request, cache, onEvent: (e) => events.push(e), now: time.now, sleep: time.sleep });
    await assert.rejects(loader.get(1), (e) => e.code === 'noNode');
    await assert.rejects(loader.get(2), (e) => e.code === 'noNode');
    assert.equal(node.calls.length, 1, 'asked once; the second failed without a request');
    assert.deepEqual(events.map((e) => e.type), ['offline']);
    assert.equal((await loader.get(5)).source, 'cache');
  });

  test('an aborted signal stops a fetch', async () => {
    const time = fakeTime();
    const node = fakeNode();
    const loader = new LedgerLoader({ request: node.request, now: time.now, sleep: time.sleep });
    await assert.rejects(loader.get(1, { signal: { aborted: true } }), /aborted/);
    assert.equal(node.calls.length, 0);
  });
});

describe('the cache and the bundle', () => {
  test('cacheKey and caseHashes', () => {
    assert.equal(cacheKey('mainnet', '12'), 'mainnet:12');
    const c = validateCase({ clips: [{ from: 10, to: 11 }], moment: { version: 1, savedAt: '2026-10-23T00:00:00.000Z', mode: 'live', host: 'x', anchor: { ledger: 11 }, loop: null, ledgers: [{ index: 10, hash: HASH(10).toLowerCase(), received: 1, expected: 1 }, { index: 11, hash: null, received: 0, expected: null }] } }).case;
    const h = caseHashes(c);
    assert.deepEqual([...h], [[10, HASH(10)]], 'only the ledgers with a hash, upper-cased');
    assert.deepEqual([...caseHashes(validateCase({ clips: ['5'] }).case)], []);
    assert.deepEqual([...caseHashes(null)], []);
  });

  test('a validated ledger from the node is stored by network and index with its hash and served from the store next time; a hash the case names must match; a header does not serve a full request', async () => {
    const time = fakeTime();
    const node = fakeNode();
    const cache = new MemoryCache();
    const loader = new LedgerLoader({ request: node.request, network: 'mainnet', cache, now: time.now, sleep: time.sleep });
    assert.equal((await loader.get(9)).source, 'node');
    assert.equal(await cache.count('mainnet'), 1);
    assert.equal(await cache.count('testnet'), 0);
    assert.deepEqual((await cache.get('mainnet', 9)).hash, HASH(9));
    assert.equal((await loader.get(9)).source, 'cache');
    assert.equal((await loader.get(9, { hash: HASH(9).toLowerCase() })).source, 'cache', 'the hash the case names, in any case');
    assert.equal((await loader.get(9, { hash: HASH(99) })).source, 'node', 'a different hash: the node is asked');
    assert.equal(node.calls.length, 2);
    assert.equal((await loader.get(10, { full: false })).source, 'node');
    assert.equal((await loader.get(10, { full: false })).source, 'cache', 'a header serves a header');
    assert.equal((await loader.get(10)).source, 'node', 'but not a full request');
    assert.equal((await loader.get(10)).source, 'cache', 'which is now stored in full');
    assert.equal((await loader.get(9, { live: true })).source, 'node', 'live skips the store');
    assert.deepEqual(loader.stats, { ...loader.stats, bundle: 0, cache: 4, node: 5 });
    await cache.clear('mainnet');
    assert.equal(await cache.count(), 0);
  });

  test('an unvalidated answer is served but not stored; a store that fails is ignored', async () => {
    const time = fakeTime();
    const request = async (cmd) => ({ result: ledgerResult(Number(cmd.ledger_index), { validated: false }) });
    const cache = new MemoryCache();
    const loader = new LedgerLoader({ request, cache, now: time.now, sleep: time.sleep });
    assert.equal((await loader.get(1)).source, 'node');
    assert.equal(await cache.count(), 0);
    const broken = { get: async () => { throw new Error('store closed'); }, put: async () => { throw new Error('store closed'); }, count: async () => 0, clear: async () => {} };
    const l2 = new LedgerLoader({ request: fakeNode().request, cache: broken, now: time.now, sleep: time.sleep });
    assert.equal((await l2.get(2)).source, 'node');
  });

  test('the bundle is read before the cache and the node, from an index and one file per ledger; a header entry serves only a header; live skips it', async () => {
    const files = new Map([
      ['docs/cases/ledgers/mainnet/index.json', { network: 'mainnet', ledgers: [{ index: 100, hash: HASH(100), txnCount: 0, full: true }, { index: 101, hash: HASH(101), txnCount: null, full: false }] }],
      ['docs/cases/ledgers/mainnet/100.json', ledgerResult(100)],
      ['docs/cases/ledgers/mainnet/101.json', ledgerResult(101, { full: false })],
    ]);
    const reads = [];
    const bundle = createBundle({ read: async (url) => (reads.push(url), files.get(url) ?? null) });
    assert.deepEqual(await bundle.indices('mainnet'), [100, 101]);
    assert.deepEqual(await bundle.indices('testnet'), [], 'no index: nothing bundled');
    assert.equal((await bundle.entry('mainnet', 100)).hash, HASH(100));
    const time = fakeTime();
    const node = fakeNode();
    const cache = new MemoryCache();
    const loader = new LedgerLoader({ request: node.request, cache, bundle, now: time.now, sleep: time.sleep });
    assert.equal((await loader.get(100)).source, 'bundle');
    assert.equal((await loader.get(100, { hash: HASH(100) })).source, 'bundle');
    assert.equal((await loader.get(100, { hash: HASH(7) })).source, 'node', 'a hash that does not match the bundle: the node');
    assert.equal((await loader.get(101, { full: false })).source, 'bundle');
    assert.equal((await loader.get(101)).source, 'node', 'the bundled header does not serve a full request');
    assert.equal((await loader.get(102)).source, 'node');
    assert.equal((await loader.get(100, { live: true })).source, 'node');
    assert.equal(reads.filter((u) => u.endsWith('index.json')).length, 2, 'the index is read once per network');
    assert.equal(await cache.count(), 3, 'what the node served is stored; the bundle is not copied into the store');
  });
});

describe('a case through the loader', () => {
  const theCase = () => validateCase({ clips: [{ from: 100, to: 102 }, { from: 110, to: 110 }] }).case;

  test('every ledger and header, the sources counted over the full ledgers, the host named; progress as before', async () => {
    const files = new Map([
      ['docs/cases/ledgers/mainnet/index.json', { network: 'mainnet', ledgers: [{ index: 100, hash: HASH(100), full: true }, { index: 101, hash: HASH(101), full: true }, { index: 103, hash: HASH(103), full: false }] }],
      ['docs/cases/ledgers/mainnet/100.json', ledgerResult(100)],
      ['docs/cases/ledgers/mainnet/101.json', ledgerResult(101)],
      ['docs/cases/ledgers/mainnet/103.json', ledgerResult(103, { full: false })],
    ]);
    const bundle = createBundle({ read: async (url) => files.get(url) ?? null });
    const cache = new MemoryCache();
    await cache.put({ network: 'mainnet', index: 102, hash: HASH(102), full: true, result: ledgerResult(102), storedAt: 1 });
    const time = fakeTime();
    const node = fakeNode();
    const progress = [];
    const loader = new LedgerLoader({ request: node.request, endpoint: () => 'wss://s2.ripple.com', cache, bundle, now: time.now, sleep: time.sleep });
    const { ledgers, failures, sources } = await loader.case(theCase(), { onProgress: (d, t) => progress.push([d, t]) });
    assert.deepEqual([...ledgers.keys()], [100, 101, 102, 110]);
    assert.deepEqual(failures, []);
    assert.deepEqual(sources, { bundle: 2, cache: 1, node: 1, failed: 0, total: 4, host: 's2.ripple.com' });
    assert.deepEqual(ledgers.get(100).source, 'bundle');
    assert.deepEqual(ledgers.get(110).source, 'node');
    assert.equal(ledgers.get(102).nextCloseTime, 800_000_000 + 103 * 4, 'the bundled header gives the close time');
    assert.equal(ledgers.get(110).nextCloseTime, 800_000_000 + 111 * 4, 'the fetched header too');
    assert.deepEqual(node.calls.map((c) => [c.ledger_index, Boolean(c.transactions)]), [[110, true], [111, false]], 'only what neither the bundle nor the cache had');
    assert.deepEqual(progress.at(-1), [6, 6]);
    assert.equal(describeSources({ sources }), '4 ledgers: 2 bundled with the page, 1 from this browser\'s cache, 1 from s2.ripple.com.');
  });

  test('a ledger the node refuses for good is unavailable and said so; live fetches everything from the node', async () => {
    const files = new Map([['docs/cases/ledgers/mainnet/index.json', { network: 'mainnet', ledgers: [{ index: 100, hash: HASH(100), full: true }] }], ['docs/cases/ledgers/mainnet/100.json', ledgerResult(100)]]);
    const bundle = createBundle({ read: async (url) => files.get(url) ?? null });
    const time = fakeTime();
    const node = fakeNode({ fail: (cmd) => (Number(cmd.ledger_index) === 101 ? Object.assign(new Error('Ledger not found.'), { code: 'lgrNotFound' }) : null) });
    const loader = new LedgerLoader({ request: node.request, endpoint: () => 'wss://s1.ripple.com', bundle, now: time.now, sleep: time.sleep });
    const { ledgers, failures, sources } = await loader.case(theCase(), { live: true });
    assert.deepEqual(failures, [{ index: 101, error: 'Ledger not found.' }]);
    assert.equal(ledgers.get(101).ledger, null);
    assert.deepEqual(sources, { bundle: 0, cache: 0, node: 3, failed: 1, total: 4, host: 's1.ripple.com' });
    assert.equal(describeSources({ sources }), '4 ledgers: 3 from s1.ripple.com; 1 not available from the node.');
    assert.equal(node.calls.filter((c) => c.ledger_index === 101).length, 2, 'tried twice through the loader, not again by fetchCaseLedgers');
    assert.equal(describeSources({ sources: { bundle: 0, cache: 0, node: 0, failed: 2, total: 2, host: '' } }), '2 ledgers: none available; 2 not available from the node.');
    assert.equal(describeSources({}), '');
  });
});

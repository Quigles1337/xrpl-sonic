// Save this moment: a case built from what is playing, live or in replay,
// with the selection, the observation and (live) the coverage. Proven on
// recorded fixtures: a real ledgerClosed message and two of its transaction
// messages for the live window, and the expanded ledger for replay.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LiveWindow, LIVE_WINDOW_LEDGERS, momentFromLive, momentFromReplay, momentFromTransaction, momentPosition, isMoment, MOMENT_VERSION } from '../src/moment.js';
import { validateCase, caseFromState, serializeCase, encodeCase, decodeCase, updateAnnotation, addAnnotation, caseFilename, MAX_CASE_LEDGERS } from '../src/case.js';
import { buildScore, GAP_MS } from '../src/score.js';
import { replayIntervalMs } from '../src/replay.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8'));

// --- live: a recorded ledgerClosed and two recorded transaction messages of the same ledger
const closed = fixture('ledger-closed');
const LIVE = Number(closed.ledger_index);
const txA = fixture('payment-failed');
const txB = fixture('payment-delivermax-unavailable');
assert.equal(Number(txA.ledger_index), LIVE);
assert.equal(Number(txB.ledger_index), LIVE);
/** The same recorded close, attributed to a later index (only the index changes). */
const closedAt = (index) => ({ ...closed, ledger_index: index });

// --- replay: the expanded ledger and its next header, as score.test.js uses them
const expanded = fixture('ledger-expanded').result.ledger;
const nextClose = Number(fixture('ledger-next-header').result.ledger.close_time);
const INDEX = Number(expanded.ledger_index);
const interval = replayIntervalMs(expanded, nextClose);
function ledgersFor(indices) {
  const map = new Map();
  for (const i of indices) map.set(i, { ledger: { ...expanded, ledger_index: i }, nextCloseTime: nextClose });
  return map;
}
const asStream = (t, index) => ({ type: 'transaction', transaction: t, meta: t.metaData, hash: t.hash, ledger_index: index, engine_result: t.metaData?.TransactionResult, validated: true });

const liveBase = () => caseFromState({ network: 'mainnet', cast: ['rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah'], settings: { scale: 'dorian', key: 'D', enabled: { nft: false } } });

describe('LiveWindow', () => {
  test('keeps validated ledgers with the transactions heard for each, deduplicated by hash', () => {
    const w = new LiveWindow();
    assert.equal(w.latest, null);
    assert.deepEqual(w.ledgers, []);
    w.noteLedger(closed);
    w.noteTransaction(txA);
    w.noteTransaction(txB);
    w.noteTransaction(txA); // a reconnect replays the stream
    assert.equal(w.ledgers.length, 1);
    assert.deepEqual(w.ledgers[0], { index: LIVE, hash: closed.ledger_hash, closeTime: Number(closed.ledger_time), txnCount: Number(closed.txn_count), received: 2 });
    assert.equal(w.latest.index, LIVE);
    // a transaction for a ledger that is not in the window is not counted anywhere
    w.noteTransaction({ ...txA, ledger_index: LIVE - 5 });
    assert.equal(w.ledgers[0].received, 2);
    // one without a ledger index belongs to the ledger streaming now
    w.noteTransaction({ ...txB, ledger_index: undefined, hash: 'B'.repeat(64) });
    assert.equal(w.ledgers[0].received, 3);
    w.reset();
    assert.deepEqual(w.ledgers, []);
  });

  test('the window is bounded by the case cap and ordered oldest first', () => {
    const w = new LiveWindow();
    for (let i = 0; i < LIVE_WINDOW_LEDGERS + 5; i++) w.noteLedger(closedAt(LIVE + i));
    assert.equal(LIVE_WINDOW_LEDGERS, MAX_CASE_LEDGERS);
    assert.equal(w.ledgers.length, LIVE_WINDOW_LEDGERS);
    assert.equal(w.ledgers[0].index, LIVE + 5);
    assert.equal(w.ledgers.at(-1).index, LIVE + LIVE_WINDOW_LEDGERS + 4);
    for (let i = 1; i < w.ledgers.length; i++) assert.ok(w.ledgers[i].index > w.ledgers[i - 1].index);
    // the same close delivered twice is one ledger
    w.noteLedger(closedAt(LIVE + LIVE_WINDOW_LEDGERS + 4));
    assert.equal(w.ledgers.length, LIVE_WINDOW_LEDGERS);
    // a ledger from another network (index far away) starts the window over rather than spanning millions of ledgers
    w.noteLedger(closedAt(LIVE + 10_000_000));
    assert.equal(w.ledgers.length, 1);
    assert.equal(w.ledgers[0].index, LIVE + 10_000_000);
  });
});

describe('momentFromLive', () => {
  test('a live moment is a valid case: the window as one clip, the ledger playing now as the anchor, the question at it, coverage per ledger', () => {
    const w = new LiveWindow();
    w.noteLedger(closedAt(LIVE));
    w.noteTransaction(txA);
    w.noteTransaction(txB);
    w.noteLedger(closedAt(LIVE + 1));
    w.noteLedger(closedAt(LIVE + 2));
    const raw = momentFromLive({ base: liveBase(), window: w, question: 'A run of offers from one account', host: 'xrplcluster.com', savedAt: '2026-10-21T20:14:03.512Z' });
    const { case: c, errors, warnings } = validateCase(raw);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    assert.deepEqual(c.clips, [{ from: LIVE, to: LIVE + 2, label: '' }]);
    assert.equal(c.network, 'mainnet');
    assert.equal(c.cast[0].address, 'rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah');
    assert.equal(c.mapping.scale, 'dorian');
    assert.equal(c.filters.enabled.nft, false);
    assert.equal(c.annotations.length, 1);
    const q = c.annotations[0];
    assert.deepEqual(q.anchor, { ledger: LIVE + 2 });
    assert.equal(q.text, 'A run of offers from one account');
    assert.equal(q.source, 'human');
    assert.equal(q.status, 'draft');
    assert.equal(q.question, true);
    assert.equal(isMoment(c), true);
    assert.equal(c.moment.version, MOMENT_VERSION);
    assert.equal(c.moment.mode, 'live');
    assert.equal(c.moment.host, 'xrplcluster.com');
    assert.equal(c.moment.savedAt, '2026-10-21T20:14:03.512Z');
    assert.deepEqual(c.moment.anchor, { ledger: LIVE + 2 });
    assert.equal(c.moment.loop, null);
    assert.deepEqual(c.moment.ledgers, [
      { index: LIVE, hash: closed.ledger_hash, received: 2, expected: Number(closed.txn_count) },
      { index: LIVE + 1, hash: closed.ledger_hash, received: 0, expected: Number(closed.txn_count) },
      { index: LIVE + 2, hash: closed.ledger_hash, received: 0, expected: Number(closed.txn_count) },
    ]);
    assert.match(c.id, /^moment-\d+-/);
    assert.match(c.title, /^Moment at ledger #/);
    assert.match(caseFilename(c), /^moment-\d+-[a-z0-9]+\.sonic-case\.json$/);
    assert.equal(c.timing.speed, 1);
  });

  test('without a question the anchor is still kept; a selected event anchors by hash', () => {
    const w = new LiveWindow();
    w.noteLedger(closedAt(LIVE));
    w.noteTransaction(txA);
    const plain = validateCase(momentFromLive({ base: liveBase(), window: w, question: '', host: 'h', savedAt: '2026-01-01T00:00:00.000Z' })).case;
    assert.equal(plain.annotations.length, 0);
    assert.deepEqual(plain.moment.anchor, { ledger: LIVE });
    const picked = validateCase(momentFromLive({ base: liveBase(), window: w, selectedHash: txA.transaction.hash.toLowerCase(), question: 'that one', host: 'h', savedAt: '2026-01-01T00:00:00.000Z' })).case;
    assert.deepEqual(picked.moment.anchor, { hash: txA.transaction.hash.toUpperCase() });
    assert.deepEqual(picked.annotations[0].anchor, { hash: txA.transaction.hash.toUpperCase() });
    assert.equal(momentFromLive({ base: liveBase(), window: new LiveWindow(), question: 'x' }), null, 'nothing observed yet: no moment');
  });

  test('a full 50-ledger live moment survives serialisation, note editing and a link', async () => {
    const w = new LiveWindow();
    for (let i = 0; i < LIVE_WINDOW_LEDGERS; i++) w.noteLedger(closedAt(LIVE + i));
    w.noteTransaction({ ...txA, ledger_index: LIVE + LIVE_WINDOW_LEDGERS - 1 });
    const question = 'q'.repeat(500);
    const c = validateCase(momentFromLive({ base: liveBase(), window: w, question, host: 's2.ripple.com', savedAt: '2026-10-21T20:14:03.512Z' })).case;
    assert.equal(c.clips[0].to - c.clips[0].from + 1, LIVE_WINDOW_LEDGERS);
    assert.equal(c.moment.ledgers.length, LIVE_WINDOW_LEDGERS);
    const json = serializeCase(c);
    const back = validateCase(JSON.parse(json)).case;
    assert.equal(serializeCase(back), json, 'serialisation is stable with the moment block');
    assert.equal(back.annotations[0].question, true);
    assert.deepEqual(back.moment, c.moment);
    // editing the question keeps the flag and the block (fresh() re-serialises)
    const edited = updateAnnotation(c, c.annotations[0].id, { text: 'shorter', status: 'reviewed' });
    assert.equal(edited.annotations[0].question, true);
    assert.equal(edited.annotations[0].text, 'shorter');
    assert.deepEqual(edited.moment, c.moment);
    const added = addAnnotation(c, { anchor: { ledger: LIVE }, text: 'another note' });
    assert.equal(added.case.annotations.filter((a) => a.question).length, 1, 'only the saved observation is the question');
    assert.deepEqual(added.case.moment, c.moment);
    // the link carries all of it
    const encoded = await encodeCase(c);
    const viaLink = validateCase(await decodeCase(encoded)).case;
    assert.equal(viaLink.annotations[0].text, question);
    assert.deepEqual(viaLink.moment, c.moment);
    assert.ok(encoded.length < 6000, `a 50-ledger live moment with a 500-character question fits a link (${encoded.length} characters)`);
  });
});

describe('momentFromReplay', () => {
  const makeCase = (clips, extra = {}) => validateCase({ clips, title: 'Three ledgers', ...extra }).case;

  test('no loop: the ledger playing now as the clip, the position re-based to it, hashes from the score', () => {
    const c = makeCase([`${INDEX}-${INDEX + 2}`], { cast: ['rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah'], mapping: { scale: 'blues' } });
    const score = buildScore(c, ledgersFor([INDEX, INDEX + 1, INDEX + 2]));
    const raw = momentFromReplay({ base: c, score, positionMs: interval + 10, loop: null, question: 'the second ledger', host: 'h', savedAt: '2026-01-01T00:00:00.000Z' });
    const m = validateCase(raw).case;
    assert.deepEqual(m.clips, [{ from: INDEX + 1, to: INDEX + 1, label: '' }]);
    assert.deepEqual(m.moment.anchor, { timeMs: 10 });
    assert.equal(m.moment.mode, 'replay');
    assert.equal(m.moment.loop, null);
    assert.deepEqual(m.moment.ledgers, [{ index: INDEX + 1, hash: expanded.ledger_hash }]);
    assert.deepEqual(m.annotations[0].anchor, { timeMs: 10 });
    assert.equal(m.annotations[0].question, true);
    assert.equal(m.cast[0].address, c.cast[0].address, 'cast, filters and mapping come from the case as it stands');
    assert.equal(m.mapping.scale, 'blues');
    assert.equal(m.timing.speed, c.timing.speed);
    assert.equal(m.title, 'Three ledgers');
    assert.match(m.id, /^moment-/);
  });

  test('a loop selects the ledgers it touches; ms are re-based to the first of them', () => {
    const c = makeCase([`${INDEX}-${INDEX + 2}`]);
    const score = buildScore(c, ledgersFor([INDEX, INDEX + 1, INDEX + 2]));
    const loop = { fromMs: interval * 1.5, toMs: interval * 2.5 };
    const m = validateCase(momentFromReplay({ base: c, score, positionMs: interval * 2.2, loop, question: '', host: 'h', savedAt: '2026-01-01T00:00:00.000Z' })).case;
    assert.deepEqual(m.clips, [{ from: INDEX + 1, to: INDEX + 2, label: '' }]);
    assert.deepEqual(m.moment.loop, { fromMs: interval * 0.5, toMs: interval * 1.5 });
    assert.deepEqual(m.moment.anchor, { timeMs: interval * 1.2 });
    assert.equal(m.annotations.length, 0);
    // the re-based loop lands on the same ledgers once the moment is scored
    const ms = buildScore(m, ledgersFor([INDEX + 1, INDEX + 2]));
    assert.equal(ms.ledgers[0].timeMs, 0);
    assert.equal(ms.ledgers[1].timeMs, interval);
    assert.equal(momentPosition(m, ms).loop.toMs, interval * 1.5);
  });

  test('a loop across a gap keeps both clips and the gap; notes are re-based or kept by hash', () => {
    const c = makeCase([{ from: INDEX, to: INDEX + 1 }, { from: INDEX + 5, to: INDEX + 5 }], {
      annotations: [
        { id: 'timed', anchor: { timeMs: interval + 100 }, text: 'in the second ledger' },
        { id: 'early', anchor: { timeMs: 100 }, text: 'in the first ledger, outside the loop' },
        { id: 'hashed', anchor: { hash: 'A'.repeat(64) }, text: 'by hash' },
        { id: 'ledgered', anchor: { ledger: INDEX + 5 }, text: 'by ledger' },
      ],
    });
    const score = buildScore(c, ledgersFor([INDEX, INDEX + 1, INDEX + 5]));
    const loop = { fromMs: interval + 50, toMs: 2 * interval + GAP_MS + interval / 2 };
    const m = validateCase(momentFromReplay({ base: c, score, positionMs: interval + 200, loop, question: 'across the gap', host: 'h', savedAt: '2026-01-01T00:00:00.000Z' })).case;
    assert.deepEqual(m.clips, [{ from: INDEX + 1, to: INDEX + 1, label: '' }, { from: INDEX + 5, to: INDEX + 5, label: '' }]);
    assert.deepEqual(m.moment.loop, { fromMs: 50, toMs: interval + GAP_MS + interval / 2 });
    assert.deepEqual(m.moment.anchor, { timeMs: 200 });
    const byId = Object.fromEntries(m.annotations.map((a) => [a.id, a]));
    assert.deepEqual(byId.timed.anchor, { timeMs: 100 }, 'timed notes shift with the new origin');
    assert.equal(byId.early, undefined, 'a timed note before the selection cannot be placed and is left out');
    assert.deepEqual(byId.hashed.anchor, { hash: 'A'.repeat(64) });
    assert.deepEqual(byId.ledgered.anchor, { ledger: INDEX + 5 });
    assert.equal(m.annotations.find((a) => a.question).text, 'across the gap');
    assert.deepEqual(m.moment.ledgers, [{ index: INDEX + 1, hash: expanded.ledger_hash }, { index: INDEX + 5, hash: expanded.ledger_hash }]);
    const ms = buildScore(m, ledgersFor([INDEX + 1, INDEX + 5]));
    assert.deepEqual(ms.gaps.map((g) => [g.afterLedger, g.beforeLedger]), [[INDEX + 1, INDEX + 5]]);
    assert.equal(momentPosition(m, ms).timeMs, 200);
  });

  test('a selected event anchors by hash; a missing ledger in the score has no hash', () => {
    const c = makeCase([`${INDEX}-${INDEX + 1}`]);
    const score = buildScore(c, new Map([[INDEX, { ledger: null, nextCloseTime: null }], [INDEX + 1, ledgersFor([INDEX + 1]).get(INDEX + 1)]]));
    const hash = score.events[0].hash;
    const m = validateCase(momentFromReplay({ base: c, score, positionMs: 0, loop: { fromMs: 0, toMs: score.totalMs }, selectedHash: hash, question: 'it', host: 'h', savedAt: '2026-01-01T00:00:00.000Z' })).case;
    assert.deepEqual(m.moment.anchor, { hash: hash.toUpperCase() });
    assert.deepEqual(m.moment.ledgers, [{ index: INDEX, hash: null }, { index: INDEX + 1, hash: expanded.ledger_hash }]);
    assert.equal(momentFromReplay({ base: c, score: null, positionMs: 0 }), null);
  });
});

describe('momentPosition', () => {
  test('resolves a hash, ledger or time anchor against the built score, with the loop and the question', () => {
    const c = makeMomentCase({ anchor: { ledger: INDEX + 1 }, loop: { fromMs: 10, toMs: 99999999 } });
    const score = buildScore(c, ledgersFor([INDEX, INDEX + 1, INDEX + 2]));
    const p = momentPosition(c, score);
    assert.equal(p.timeMs, interval);
    assert.deepEqual(p.loop, { fromMs: 10, toMs: score.totalMs }, 'the loop is clamped to the score');
    assert.equal(p.annotation.text, 'why');
    const byHash = makeMomentCase({ anchor: { hash: score.events[2].hash } });
    assert.equal(momentPosition(byHash, score).timeMs, score.events[2].timeMs);
    const byTime = makeMomentCase({ anchor: { timeMs: 1234 } });
    assert.equal(momentPosition(byTime, score).timeMs, 1234);
    assert.equal(momentPosition(makeMomentCase({ anchor: { hash: 'F'.repeat(64) } }), score).timeMs, 0, 'an anchor that does not resolve lands at the start');
    assert.equal(momentPosition(validateCase({ clips: [String(INDEX)] }).case, score), null, 'not a moment');
  });
});

function makeMomentCase({ anchor, loop = null }) {
  return validateCase({
    clips: [`${INDEX}-${INDEX + 2}`],
    annotations: [{ anchor, text: 'why', source: 'human', question: true }],
    moment: { version: MOMENT_VERSION, savedAt: '2026-01-01T00:00:00.000Z', mode: 'replay', host: 'h', anchor, loop, ledgers: [] },
  }).case;
}

describe('momentFromTransaction (explorer handoff)', () => {
  test('one ledger as the clip, the hash as the anchor, no question', () => {
    const hash = 'BDA7EDF8F28F36120B4CD96614C670A077659E4B3B2B4C3E4EB46CBD8AF03DF0';
    const raw = momentFromTransaction({ network: 'testnet', ledgerIndex: 107811677, hash, ledgerHash: 'C'.repeat(64), host: 's.altnet.rippletest.net:51233', savedAt: '2026-01-01T00:00:00.000Z' });
    const { case: c, errors } = validateCase(raw);
    assert.deepEqual(errors, []);
    assert.equal(c.network, 'testnet');
    assert.deepEqual(c.clips, [{ from: 107811677, to: 107811677, label: '' }]);
    assert.deepEqual(c.moment.anchor, { hash });
    assert.equal(c.moment.mode, 'explorer');
    assert.deepEqual(c.moment.ledgers, [{ index: 107811677, hash: 'C'.repeat(64) }]);
    assert.equal(c.annotations.length, 0);
    assert.equal(momentFromTransaction({ ledgerIndex: 0, hash }), null);
    assert.equal(momentFromTransaction({ ledgerIndex: 5, hash: 'nope' }), null);
  });
});

describe('the moment block in validateCase', () => {
  test('an ordinary case has no moment and serialises without one; a malformed block is dropped with an error', () => {
    const plain = validateCase({ clips: [String(INDEX)], annotations: [{ anchor: { ledger: INDEX }, text: 'note' }] });
    assert.equal(plain.case.moment, null);
    assert.ok(!plain.case.annotations[0].question, 'ordinary notes carry no question flag');
    const json = serializeCase(plain.case);
    assert.ok(!json.includes('"moment"'));
    assert.ok(!json.includes('"question"'));
    const bad = validateCase({ clips: [String(INDEX)], moment: 'yes' });
    assert.ok(bad.case);
    assert.equal(bad.case.moment, null);
    assert.match(bad.errors[0], /moment/);
    const wrongVersion = validateCase({ clips: [String(INDEX)], moment: { version: 2, savedAt: 'x', mode: 'live', anchor: { ledger: INDEX } } });
    assert.ok(wrongVersion.case);
    assert.equal(wrongVersion.case.moment, null);
    assert.match(wrongVersion.errors[0], /moment version/);
    const loose = validateCase({ clips: [String(INDEX)], moment: { version: 1, mode: 'elsewhere', anchor: { ledger: -1 }, ledgers: [{ index: 'x' }, { index: INDEX, hash: 'short', received: '3', expected: 7 }], loop: { fromMs: 'a' } } }).case;
    assert.equal(loose.moment.mode, 'replay', 'an unknown mode falls back');
    assert.equal(loose.moment.anchor, null, 'a bad anchor is dropped');
    assert.equal(loose.moment.loop, null);
    assert.deepEqual(loose.moment.ledgers, [{ index: INDEX, hash: null, received: 3, expected: 7 }]);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCase } from '../src/case.js';
import { buildScore, GAP_MS, SCORE_VERSION, formatClock, scoreCaption, transcript, clipRanges, ledgerAtPosition } from '../src/score.js';
import { replayIntervalMs, DEFAULT_CLOSE_INTERVAL_MS } from '../src/replay.js';
import { MAPPING_VERSION } from '../src/mapping.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8'));

const expanded = fixture('ledger-expanded');
const nextHeader = fixture('ledger-next-header');
const ledger = expanded.result.ledger;
const INDEX = Number(ledger.ledger_index);
const nextClose = Number(nextHeader.result.ledger.close_time);
const interval = replayIntervalMs(ledger, nextClose);
const senders = ledger.transactions.map((t) => t.Account);
const SENDER = senders[0];
const OTHER = senders.find((a) => a !== SENDER);

function ledgersFor(indices, { missing = [] } = {}) {
  const map = new Map();
  for (const i of indices) map.set(i, missing.includes(i) ? { ledger: null, nextCloseTime: null } : { ledger: { ...ledger, ledger_index: i }, nextCloseTime: nextClose });
  return map;
}

const makeCase = (extra = {}) => validateCase({ clips: [String(INDEX)], ...extra }).case;

describe('buildScore', () => {
  test('one ledger: events in applied order, timed inside the real interval, counted once', () => {
    const c = makeCase();
    const score = buildScore(c, ledgersFor([INDEX]));
    assert.equal(score.version, SCORE_VERSION);
    assert.equal(score.mappingVersion, MAPPING_VERSION);
    assert.equal(score.ledgers.length, 1);
    assert.equal(score.ledgers[0].timeMs, 0);
    assert.equal(score.ledgers[0].intervalMs, interval);
    assert.equal(score.ledgers[0].txnCount, ledger.transactions.length);
    assert.equal(score.totalMs, interval);
    assert.ok(score.events.length > 0);
    assert.equal(score.events.length, score.counts.events);
    assert.equal(score.counts.played, score.counts.events);
    assert.equal(score.counts.dim, 0);
    assert.equal(score.counts.excluded.total, ledger.transactions.length - score.events.length, 'every transaction is either an event or excluded for a reason');
    assert.equal(Object.values(score.counts.excluded.byReason).reduce((a, b) => a + b, 0), score.counts.excluded.total);
    for (let i = 1; i < score.events.length; i++) {
      assert.ok(score.events[i].timeMs > score.events[i - 1].timeMs, 'strictly increasing');
      assert.ok(score.events[i].txIndex >= score.events[i - 1].txIndex, 'applied order');
    }
    for (const e of score.events) {
      assert.equal(e.ledgerIndex, INDEX);
      assert.ok(e.offsetMs > 0 && e.offsetMs < interval);
      assert.equal(e.timeMs, e.offsetMs);
      assert.equal(e.gate, 'play');
      assert.deepEqual(e.cast, []);
      assert.equal(e.event.kind, 'tx');
    }
    assert.deepEqual(score.gaps, []);
    assert.deepEqual(score.warnings, []);
  });

  test('the same inputs give the same score', () => {
    const c = makeCase({ cast: [SENDER], annotations: [{ anchor: { ledger: INDEX }, text: 'start' }] });
    const a = JSON.stringify(buildScore(c, ledgersFor([INDEX])));
    const b = JSON.stringify(buildScore(c, ledgersFor([INDEX])));
    assert.equal(a, b);
  });

  test('two clips: a gap with explicit silence between them, ledger times accumulate', () => {
    const c = validateCase({ clips: [{ from: INDEX, to: INDEX + 1 }, { from: INDEX + 5, to: INDEX + 5 }] }).case;
    const score = buildScore(c, ledgersFor([INDEX, INDEX + 1, INDEX + 5]));
    assert.deepEqual(
      score.ledgers.map((l) => [l.ledgerIndex, l.clip, l.timeMs]),
      [
        [INDEX, 0, 0],
        [INDEX + 1, 0, interval],
        [INDEX + 5, 1, 2 * interval + GAP_MS],
      ],
    );
    assert.deepEqual(score.gaps, [{ timeMs: 2 * interval, afterLedger: INDEX + 1, beforeLedger: INDEX + 5, omitted: 3, durationMs: GAP_MS }]);
    assert.equal(score.totalMs, 3 * interval + GAP_MS);
    const second = score.events.filter((e) => e.clip === 1);
    assert.ok(second.every((e) => e.timeMs >= 2 * interval + GAP_MS));
  });

  test('a missing ledger becomes default-length silence with a warning', () => {
    const c = validateCase({ clips: [{ from: INDEX, to: INDEX + 1 }] }).case;
    const score = buildScore(c, ledgersFor([INDEX, INDEX + 1], { missing: [INDEX] }));
    assert.equal(score.ledgers[0].missing, true);
    assert.equal(score.ledgers[0].intervalMs, DEFAULT_CLOSE_INTERVAL_MS);
    assert.equal(score.counts.missingLedgers, 1);
    assert.match(score.warnings[0], /#\d+ was not available/);
    assert.ok(score.events.every((e) => e.ledgerIndex === INDEX + 1));
    assert.equal(score.ledgers[1].timeMs, DEFAULT_CLOSE_INTERVAL_MS);
    assert.equal(buildScore(c, new Map()).events.length, 0);
  });

  test('filters and mapping from the case shape the events', () => {
    const all = buildScore(makeCase(), ledgersFor([INDEX]));
    const noOffers = buildScore(makeCase({ filters: { enabled: { offer: false } } }), ledgersFor([INDEX]));
    assert.ok(noOffers.events.length < all.events.length);
    assert.ok(noOffers.events.every((e) => e.event.category !== 'offer'));
    assert.equal(noOffers.counts.excluded.byReason.categoryDisabled, all.events.length - noOffers.events.length, 'excluded events say why');
    assert.equal(noOffers.counts.excluded.total - (all.counts.excluded.byReason.failed ?? 0), all.events.length - noOffers.events.length);
    const quiet = buildScore(makeCase({ filters: { quietThreshold: 1e9 } }), ledgersFor([INDEX]));
    assert.equal(quiet.events.length, 0);
    assert.equal(quiet.counts.excluded.byReason.quietThreshold, all.events.length);
    const withFailed = buildScore(makeCase({ filters: { includeFailed: true } }), ledgersFor([INDEX]));
    const failedCount = ledger.transactions.filter((t) => (t.metaData ?? t.meta)?.TransactionResult !== 'tesSUCCESS').length;
    assert.equal(all.counts.excluded.byReason.failed ?? 0, failedCount);
    assert.equal(withFailed.counts.excluded.byReason.failed ?? 0, 0);
    const keyed = buildScore(makeCase({ mapping: { key: 'G' } }), ledgersFor([INDEX]));
    assert.notDeepEqual(
      keyed.events.map((e) => e.event.pitch),
      all.events.map((e) => e.event.pitch),
    );
  });

  test('cast: involvement, primary voice, gates and counts', () => {
    const c = makeCase({ cast: [{ address: SENDER, label: 'Alice', voice: 'glass' }], filters: { castMode: 'mute' } });
    const score = buildScore(c, ledgersFor([INDEX]));
    const involved = score.events.filter((e) => e.cast.length);
    assert.ok(involved.length > 0);
    assert.ok(involved.every((e) => e.primary === 'c1' && e.event.voice === 'glass' && e.gate === 'play'));
    const others = score.events.filter((e) => !e.cast.length);
    assert.ok(others.every((e) => e.gate === 'dim' && e.event.voice === undefined));
    assert.equal(score.counts.dim, others.length);
    const hidden = buildScore(makeCase({ cast: [SENDER], filters: { castMode: 'hide' } }), ledgersFor([INDEX]));
    assert.ok(hidden.events.every((e) => e.cast.length > 0));
    assert.ok(hidden.events.length < score.events.length);
    assert.equal(hidden.counts.excluded.byReason.castHidden, score.events.length - hidden.events.length, 'hidden events are counted as excluded with their reason');
  });

  test('annotations resolve by hash, ledger or time, in time order; unresolved ones warn', () => {
    const target = buildScore(makeCase(), ledgersFor([INDEX])).events.at(-1);
    const c = makeCase({
      annotations: [
        { id: 'by-time', anchor: { timeMs: 10 }, text: 'timed' },
        { id: 'by-hash', anchor: { hash: target.hash }, text: 'hashed' },
        { id: 'by-ledger', anchor: { ledger: INDEX }, text: 'ledger' },
        { id: 'lost', anchor: { ledger: INDEX + 40 }, text: 'elsewhere' },
        { id: 'late', anchor: { timeMs: 10 ** 9 }, text: 'beyond the end' },
      ],
    });
    const score = buildScore(c, ledgersFor([INDEX]));
    assert.deepEqual(
      score.annotations.map((a) => a.id),
      ['by-ledger', 'by-time', 'by-hash'],
    );
    assert.equal(score.annotations[0].timeMs, 0);
    assert.equal(score.annotations[2].timeMs, target.timeMs);
    assert.equal(score.annotations[2].eventN, target.n);
    assert.equal(score.warnings.length, 2);
    assert.match(score.warnings[0], /"lost" does not resolve/);
  });
});

describe('captions and transcript', () => {
  test('formatClock', () => {
    assert.equal(formatClock(0), '0:00.000');
    assert.equal(formatClock(61234.4), '1:01.234');
    assert.equal(formatClock(-5), '0:00.000');
    assert.equal(formatClock('x'), '0:00.000');
  });

  test('scoreCaption names the type, amount, parties with cast labels, voice and note', () => {
    const c = makeCase({ cast: [{ address: SENDER, label: 'Alice' }] });
    const score = buildScore(c, ledgersFor([INDEX]));
    const e = score.events.find((x) => x.cast.length);
    const cap = scoreCaption(e, c.cast);
    assert.ok(cap.startsWith(e.event.txType), cap);
    assert.ok(cap.includes('Alice ('), cap);
    assert.ok(cap.includes(`${e.event.voice} ${e.event.note}`), cap);
    assert.ok(cap.includes('cast: Alice'), cap);
    const dim = { ...score.events.find((x) => !x.cast.length), gate: 'dim' };
    assert.ok(scoreCaption(dim, c.cast).endsWith('· silent'));
    assert.equal(scoreCaption(null), '');
  });

  test('transcript lists header, ledgers, gaps, events and annotations in time order', () => {
    const c = validateCase({
      title: 'Two clips',
      clips: [{ from: INDEX, to: INDEX }, { from: INDEX + 3, to: INDEX + 3 }],
      cast: [{ address: OTHER, label: 'Bob' }],
      annotations: [{ anchor: { ledger: INDEX + 3 }, text: 'Second clip begins', source: 'notes' }],
    }).case;
    const score = buildScore(c, ledgersFor([INDEX, INDEX + 3]));
    const text = transcript(score, c);
    const lines = text.split('\n');
    assert.equal(lines[0], 'xrpl-sonic transcript · Two clips');
    assert.match(lines[1], /network mainnet · mapping/);
    assert.match(lines[2], /^cast: Bob = r/);
    assert.match(lines[3], /2 ledgers · \d+ events \(\d+ selected to sound, \d+ silent\)/);
    assert.ok(!text.includes('sounded'), 'a score selects events to sound; whether they sounded is the synthesiser\'s business');
    const filtered = transcript(buildScore(validateCase({ clips: [String(INDEX)], filters: { enabled: { offer: false } } }).case, ledgersFor([INDEX])), c);
    assert.match(filtered.split('\n')[3], /· \d+ excluded \(category disabled \d+/);
    assert.ok(text.includes(`0:00.000 ledger #${INDEX} ·`));
    assert.ok(text.includes(`— gap: 2 ledgers omitted between #${INDEX} and #${INDEX + 3} —`));
    assert.ok(text.includes('>> Second clip begins [notes] (draft)'));
    const times = lines.slice(5).map((l) => l.slice(0, 8)).filter((t) => /^\d:\d\d\.\d{3}$/.test(t));
    assert.deepEqual(times, [...times].sort());
  });
});

describe('ledgerAtPosition', () => {
  test('the ledger playing at a position is the last one that started at or before it, not the first', () => {
    const c = validateCase({ clips: [{ from: INDEX, to: INDEX + 2 }] }).case;
    const score = buildScore(c, ledgersFor([INDEX, INDEX + 1, INDEX + 2]));
    assert.equal(ledgerAtPosition(score, 0), INDEX);
    assert.equal(ledgerAtPosition(score, interval - 1), INDEX);
    assert.equal(ledgerAtPosition(score, interval), INDEX + 1);
    assert.equal(ledgerAtPosition(score, 2 * interval + 5), INDEX + 2);
    assert.equal(ledgerAtPosition(score, 10 ** 9), INDEX + 2);
    assert.equal(ledgerAtPosition(score, -1), INDEX, 'before the start, the first ledger');
    assert.equal(ledgerAtPosition({ ledgers: [] }, 0), null);
    assert.equal(ledgerAtPosition(null, 0), null);
  });
});

describe('clipRanges', () => {
  test('one range per clip, spanning its ledgers, with the gap between them', () => {
    const c = validateCase({ clips: [{ from: INDEX, to: INDEX + 1 }, { from: INDEX + 5, to: INDEX + 5 }] }).case;
    const score = buildScore(c, ledgersFor([INDEX, INDEX + 1, INDEX + 5]));
    assert.deepEqual(clipRanges(score), [
      { clip: 0, fromMs: 0, toMs: 2 * interval, ledgers: 2 },
      { clip: 1, fromMs: 2 * interval + GAP_MS, toMs: 3 * interval + GAP_MS, ledgers: 1 },
    ]);
    assert.deepEqual(clipRanges({ ledgers: [] }), []);
    assert.deepEqual(clipRanges(null), []);
  });
});

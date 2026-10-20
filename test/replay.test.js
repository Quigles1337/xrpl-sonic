import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  MAX_REPLAY_LEDGERS,
  DEFAULT_CLOSE_INTERVAL_MS,
  REPLAY_SPEEDS,
  parseReplayRange,
  formatReplayRange,
  replayIntervalMs,
  scheduleReplay,
  replayLedgerMessage,
} from '../src/replay.js';
import { txToEvent, ledgerToEvent, involvesAccount } from '../src/mapping.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8'));

const expanded = () => fixture('ledger-expanded').result.ledger;
const nextClose = () => fixture('ledger-next-header').result.ledger.close_time;

describe('replay range parsing', () => {
  test('single ledger and from-to ranges', () => {
    assert.deepEqual(parseReplayRange('107777809'), { from: 107777809, to: 107777809, count: 1, clamped: false });
    assert.deepEqual(parseReplayRange('107777809-107777812'), { from: 107777809, to: 107777812, count: 4, clamped: false });
    assert.deepEqual(parseReplayRange(' 10 - 12 '), { from: 10, to: 12, count: 3, clamped: false });
  });

  test('reversed ranges are swapped and long ranges are clamped to the maximum', () => {
    assert.deepEqual(parseReplayRange('20-10'), { from: 10, to: 20, count: 11, clamped: false });
    const r = parseReplayRange('100-1000');
    assert.equal(r.from, 100);
    assert.equal(r.to, 100 + MAX_REPLAY_LEDGERS - 1);
    assert.equal(r.count, MAX_REPLAY_LEDGERS);
    assert.equal(r.clamped, true);
    assert.equal(MAX_REPLAY_LEDGERS, 50);
    assert.equal(parseReplayRange('1-50').clamped, false);
    assert.equal(parseReplayRange('1-51').clamped, true);
  });

  test('anything else is rejected', () => {
    for (const bad of ['', 'abc', '0', '-5', '10-', '10-x', '1.5', '1e6', '12345678901234', null, undefined, 42]) {
      assert.equal(parseReplayRange(bad), null, String(bad));
    }
  });

  test('formatReplayRange is the inverse of parseReplayRange', () => {
    for (const spec of ['5', '5-9', '100-149']) {
      assert.equal(formatReplayRange(parseReplayRange(spec)), spec);
    }
    assert.equal(formatReplayRange(parseReplayRange('9-5')), '5-9');
  });

  test('speeds are the documented set', () => {
    assert.deepEqual([...REPLAY_SPEEDS], [0.5, 1, 2, 4]);
  });
});

describe('replay scheduling', () => {
  test('uses the real close interval from the next ledger', () => {
    const ledger = expanded();
    assert.equal(nextClose() - ledger.close_time, 8);
    assert.equal(replayIntervalMs(ledger, nextClose()), 8000);
  });

  test('missing or implausible next close falls back to 4 s', () => {
    const ledger = expanded();
    assert.equal(DEFAULT_CLOSE_INTERVAL_MS, 4000);
    assert.equal(replayIntervalMs(ledger, null), 4000);
    assert.equal(replayIntervalMs(ledger, undefined), 4000);
    assert.equal(replayIntervalMs(ledger, 'soon'), 4000);
    assert.equal(replayIntervalMs(ledger, ledger.close_time), 4000, 'zero interval');
    assert.equal(replayIntervalMs(ledger, ledger.close_time - 5), 4000, 'negative interval');
    assert.equal(replayIntervalMs(ledger, ledger.close_time + 3600), 4000, 'an hour later is not a close interval');
    assert.equal(replayIntervalMs({}, 12345), 4000);
    assert.equal(replayIntervalMs(null, 12345), 4000);
  });

  test('orders transactions by metadata TransactionIndex, not the hash order the node returns', () => {
    const ledger = expanded();
    const nodeOrder = ledger.transactions.map((t) => t.metaData.TransactionIndex);
    assert.deepEqual(nodeOrder, [21, 38, 31, 19, 13, 23, 81], 'fixture is in hash order');
    const items = scheduleReplay(ledger, nextClose());
    assert.deepEqual(
      items.map((i) => i.tx.metaData.TransactionIndex),
      [13, 19, 21, 23, 31, 38, 81],
    );
    assert.equal(items.length, ledger.transactions.length);
  });

  test('spaces transactions evenly across the interval with half a slot at each end', () => {
    const ledger = expanded();
    const items = scheduleReplay(ledger, nextClose());
    const n = items.length;
    const slot = 8000 / n;
    for (let i = 0; i < n; i++) {
      assert.ok(Math.abs(items[i].offsetMs - (i + 0.5) * slot) < 1e-6, `item ${i}`);
    }
    for (let i = 1; i < n; i++) {
      assert.ok(Math.abs(items[i].offsetMs - items[i - 1].offsetMs - slot) < 1e-6, `gap ${i}`);
    }
    assert.ok(items[0].offsetMs > 0);
    assert.ok(items[n - 1].offsetMs < 8000);
  });

  test('uses the 4 s default spacing when the next close is unknown', () => {
    const items = scheduleReplay(expanded(), null);
    const n = items.length;
    assert.ok(Math.abs(items[n - 1].offsetMs - (n - 0.5) * (4000 / n)) < 1e-6);
  });

  test('an empty ledger schedules nothing; unexpanded (hash-only) entries are skipped', () => {
    assert.deepEqual(scheduleReplay({ ...expanded(), transactions: [] }, nextClose()), []);
    assert.deepEqual(scheduleReplay({ ...expanded(), transactions: undefined }, nextClose()), []);
    assert.deepEqual(scheduleReplay(null, nextClose()), []);
    const hashesOnly = { ...expanded(), transactions: ['AA'.repeat(32), 'BB'.repeat(32)] };
    assert.deepEqual(scheduleReplay(hashesOnly, nextClose()), []);
  });

  test('entries without a TransactionIndex sort last, keeping their relative order', () => {
    const ledger = expanded();
    const a = { ...ledger.transactions[0], metaData: { TransactionResult: 'tesSUCCESS' } };
    const b = { ...ledger.transactions[1], metaData: { TransactionResult: 'tesSUCCESS' } };
    const items = scheduleReplay({ ...ledger, transactions: [a, b, ...ledger.transactions.slice(2)] }, nextClose());
    assert.equal(items[items.length - 2].tx, a);
    assert.equal(items[items.length - 1].tx, b);
  });

  test('scheduled entries map through txToEvent and involvesAccount unchanged', () => {
    const ledger = expanded();
    const items = scheduleReplay(ledger, nextClose());
    const events = items.map((i) => txToEvent(i.tx, { includeFailed: true }));
    assert.equal(events.filter(Boolean).length, items.length);
    assert.equal(events.filter((e) => e.success).length, 6);
    for (const ev of events) assert.equal(ev.hash.length, 64);
    const sender = items[0].tx.Account;
    assert.equal(involvesAccount(items[0].tx, sender), true);
  });

  test('replayLedgerMessage produces a ledger event with the real close time and count', () => {
    const ledger = expanded();
    const ev = ledgerToEvent(replayLedgerMessage(ledger));
    assert.equal(ev.kind, 'ledger');
    assert.equal(ev.ledgerIndex, 107777809);
    assert.equal(ev.txnCount, 7);
    assert.equal(ev.hash, ledger.ledger_hash);
    assert.equal(ev.closeTimeIso, '2026-10-20T05:58:02.000Z');
    assert.equal(ev.text, 'Ledger #107,777,809 · 7 tx');
    assert.equal(ledgerToEvent(replayLedgerMessage({})), null);
  });
});

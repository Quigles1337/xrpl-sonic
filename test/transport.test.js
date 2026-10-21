import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Transport, LOOKAHEAD_MS } from '../src/transport.js';

/** A small hand-made score: 3 ledgers 1000 ms apart, 6 events, one gap, 3 annotations (one pausing). */
function score() {
  const ev = (n, timeMs, ledgerIndex) => ({ n, timeMs, ledgerIndex, event: { kind: 'tx' } });
  return {
    totalMs: 4500,
    ledgers: [
      { ledgerIndex: 10, timeMs: 0 },
      { ledgerIndex: 11, timeMs: 1000 },
      { ledgerIndex: 20, timeMs: 3500 },
    ],
    gaps: [{ timeMs: 2000, afterLedger: 11, beforeLedger: 20, omitted: 8, durationMs: 1500 }],
    events: [ev(0, 200, 10), ev(1, 600, 10), ev(2, 1200, 11), ev(3, 1500, 11), ev(4, 3700, 20), ev(5, 4100, 20)],
    annotations: [
      { id: 'a', timeMs: 0, text: 'start', pause: false },
      { id: 'b', timeMs: 1500, text: 'pause here', pause: true },
      { id: 'c', timeMs: 3700, text: 'late', pause: false },
    ],
  };
}

function harness(opts = {}) {
  let wall = 0;
  const log = [];
  const t = new Transport(score(), {
    now: () => wall,
    onEvent: (e, off) => log.push(['event', e.n, Math.round(off * 1000)]),
    onLedger: (l, off) => log.push(['ledger', l.ledgerIndex, Math.round(off * 1000)]),
    onGap: (g, off) => log.push(['gap', g.omitted, Math.round(off * 1000)]),
    onAnnotation: (a, off) => log.push(['note', a.id, Math.round(off * 1000)]),
    onState: (s, d) => log.push(['state', s, d.annotation?.id ?? null]),
    onEnd: () => log.push(['end']),
    ...opts,
  });
  const advance = (ms) => {
    wall += ms;
    return t.tick();
  };
  return { t, log, advance, kinds: (k) => log.filter((x) => x[0] === k) };
}

describe('Transport', () => {
  test('starts idle at 0 and plays with lookahead offsets', () => {
    const { t, log, advance } = harness();
    assert.equal(t.state, 'idle');
    t.play();
    assert.equal(t.state, 'playing');
    advance(0);
    // At 0 with 150 ms lookahead: ledger 10 (offset 0), annotation a (0); event 0 at 200 is beyond.
    assert.deepEqual(log.slice(1), [
      ['ledger', 10, 0],
      ['note', 'a', 0],
    ]);
    advance(100); // pos 100, horizon 250 → event 0 at 200 fires with offset 100
    assert.deepEqual(log.at(-1), ['event', 0, 100]);
    advance(500); // pos 600 → event 1 at 600, offset 0
    assert.deepEqual(log.at(-1), ['event', 1, 0]);
    assert.equal(t.positionNow(), 600);
  });

  test('pause freezes the position; resume continues from it', () => {
    const { t, advance } = harness();
    t.play();
    advance(700);
    t.pause();
    assert.equal(t.state, 'paused');
    assert.equal(t.positionNow(), 700);
    advance(5000);
    assert.equal(t.positionNow(), 700, 'wall time passes, score time does not');
    t.play();
    advance(200);
    assert.equal(t.positionNow(), 900);
  });

  test('pauses at an annotation marked pause, firing nothing past it', () => {
    const { t, log, advance, kinds } = harness();
    t.play();
    advance(1400); // horizon 1550 covers the pausing note at 1500 and event 3 at 1500
    assert.equal(t.state, 'paused');
    assert.equal(t.positionNow(), 1500);
    assert.deepEqual(log.at(-1), ['state', 'paused', 'b']);
    assert.ok(kinds('note').some((n) => n[1] === 'b'));
    assert.ok(kinds('event').some((e) => e[1] === 3), 'the event at the same time as the note fires');
    assert.ok(!kinds('event').some((e) => e[1] === 4));
    t.play();
    advance(2300); // → 3800: gap at 2000, ledger 20 at 3500, event 4 and note c at 3700
    assert.deepEqual(
      kinds('gap').map((g) => g[1]),
      [8],
    );
    assert.ok(kinds('ledger').some((l) => l[1] === 20));
    assert.ok(kinds('event').some((e) => e[1] === 4));
    assert.ok(kinds('note').some((n) => n[1] === 'c'));
  });

  test('honourPauses=false plays through pausing annotations', () => {
    const { t, advance } = harness({ honourPauses: false });
    t.play();
    advance(1400);
    assert.equal(t.state, 'playing');
  });

  test('ends at totalMs and play() after the end restarts from 0', () => {
    const { t, log, advance, kinds } = harness({ honourPauses: false });
    t.play();
    advance(4600);
    assert.equal(t.state, 'ended');
    assert.deepEqual(log.at(-1), ['end']);
    assert.equal(kinds('event').length, 6);
    t.play();
    assert.equal(t.state, 'playing');
    assert.equal(t.positionNow(), 0);
  });

  test('speed scales the clock and the offsets', () => {
    const { t, log, advance } = harness();
    t.setSpeed(2);
    t.play();
    advance(50); // pos 100, horizon 100 + 300 = 400 → event 0 at 200 fires with offset (100 ms score) / 2 = 50 ms
    assert.deepEqual(log.at(-1), ['event', 0, 50]);
    t.setSpeed(0.5);
    advance(200); // +100 score → 200
    assert.equal(t.positionNow(), 200);
  });

  test('seek resets cursors so later items still fire, and clears what was skipped', () => {
    const { t, advance, kinds } = harness({ honourPauses: false });
    t.play();
    t.seek(3000);
    advance(800); // 3800: ledger 20, event 4, note c; nothing from before 3000
    assert.deepEqual(
      kinds('event').map((e) => e[1]),
      [4],
    );
    assert.deepEqual(
      kinds('ledger').map((l) => l[1]),
      [20],
    );
    assert.equal(kinds('gap').length, 0);
    t.seek(1100);
    advance(500); // 1600: event 2 (1200), event 3 (1500)
    assert.deepEqual(
      kinds('event').map((e) => e[1]),
      [4, 2, 3],
    );
  });

  test('loop returns to the start when the end of the loop is reached', () => {
    const { t, advance, kinds } = harness({ honourPauses: false });
    t.setLoop({ fromMs: 100, toMs: 700 });
    t.play();
    advance(700); // reaches toMs → seek 100
    assert.equal(t.state, 'playing');
    assert.equal(t.positionNow(), 100);
    advance(200); // 300 → event 0 (200) fires again
    assert.deepEqual(
      kinds('event').map((e) => e[1]),
      [0, 1, 0],
    );
    t.setLoop(null);
    assert.equal(t.loop, null);
    t.setLoop({ fromMs: 500, toMs: 200 });
    assert.equal(t.loop, null, 'a backwards loop is ignored');
  });

  test('step plays exactly the next event now and lands on it, paused', () => {
    const { t, log, kinds } = harness();
    const a = t.step();
    assert.equal(a.n, 0);
    assert.equal(t.state, 'paused');
    assert.equal(t.positionNow(), 200);
    assert.deepEqual(kinds('ledger'), [['ledger', 10, 0]]);
    assert.deepEqual(kinds('note'), [['note', 'a', 0]]);
    assert.deepEqual(log.filter((x) => x[0] === 'event'), [['event', 0, 0]]);
    const b = t.step();
    assert.equal(b.n, 1);
    assert.equal(t.positionNow(), 600);
    t.step(); // 2 at 1200 (ledger 11 fires first)
    assert.ok(kinds('ledger').some((l) => l[1] === 11));
    t.step(); // 3 at 1500 — the pausing note fires too, but step is already a pause
    t.step(); // 4 at 3700 — gap and ledger 20 fire first
    assert.ok(kinds('gap').length === 1);
    t.step(); // 5
    assert.equal(t.step(), null, 'nothing left');
    assert.equal(t.state, 'ended');
  });

  test('stepBack lands on the previous event without playing it', () => {
    const { t, kinds } = harness();
    t.step();
    t.step();
    t.step(); // on event 2 at 1200
    const prev = t.stepBack(); // → 600 (event 1)
    assert.equal(prev.n, 1);
    assert.equal(t.positionNow(), 600);
    assert.equal(kinds('event').length, 3, 'stepBack plays nothing');
    const again = t.step();
    assert.equal(again.n, 1, 'step after stepBack replays that event');
    t.stepBack();
    t.stepBack();
    assert.equal(t.positionNow(), 0);
    assert.equal(t.stepBack(), null);
  });

  test('setScore keeps the position and re-targets the cursors', () => {
    const { t, advance, kinds } = harness({ honourPauses: false });
    t.play();
    advance(1300);
    const s = score();
    s.events = s.events.map((e) => ({ ...e, n: e.n + 100 }));
    t.setScore(s);
    assert.equal(t.positionNow(), 1300);
    advance(300); // 1600 → event 103 (1500)
    assert.deepEqual(kinds('event').at(-1)[1], 103);
  });

  test('stop returns to idle at 0; toggle flips play and pause', () => {
    const { t, advance } = harness();
    t.toggle();
    assert.equal(t.state, 'playing');
    advance(100);
    t.toggle();
    assert.equal(t.state, 'paused');
    t.stop();
    assert.equal(t.state, 'idle');
    assert.equal(t.positionNow(), 0);
  });

  test('lookahead constant is documented and small', () => {
    assert.ok(LOOKAHEAD_MS >= 50 && LOOKAHEAD_MS <= 300);
  });
});

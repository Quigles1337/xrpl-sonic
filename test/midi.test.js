import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCase } from '../src/case.js';
import { buildScore } from '../src/score.js';
import { scoreToMidi, scoreNoteEvents, noteEventsFor, trackKeyFor, vlq, msToTicks, midiFilename, PPQ, BPM, PERCUSSION_CHANNEL, PERCUSSION, PROGRAMS } from '../src/midi.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8'));
const ledger = fixture('ledger-expanded').result.ledger;
const INDEX = Number(ledger.ledger_index);
const nextClose = Number(fixture('ledger-next-header').result.ledger.close_time);
const SENDER = ledger.transactions[0].Account;

function ledgersFor(indices) {
  const map = new Map();
  for (const i of indices) map.set(i, { ledger: { ...ledger, ledger_index: i }, nextCloseTime: nextClose });
  return map;
}

/** A tiny SMF reader for the tests: chunks, then each track's messages with absolute ticks. */
function readSmf(bytes) {
  const b = bytes;
  const u32 = (i) => (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
  const u16 = (i) => (b[i] << 8) | b[i + 1];
  assert.equal(String.fromCharCode(...b.slice(0, 4)), 'MThd');
  const header = { length: u32(4), format: u16(8), ntracks: u16(10), ppq: u16(12) };
  const tracks = [];
  let p = 14;
  while (p < b.length) {
    assert.equal(String.fromCharCode(...b.slice(p, p + 4)), 'MTrk', `chunk at ${p}`);
    const len = u32(p + 4);
    const end = p + 8 + len;
    let q = p + 8;
    let tick = 0;
    const msgs = [];
    let running = null;
    while (q < end) {
      let delta = 0;
      let c;
      do {
        c = b[q++];
        delta = (delta << 7) | (c & 0x7f);
      } while (c & 0x80);
      tick += delta;
      let status = b[q];
      if (status === 0xff) {
        const type = b[q + 1];
        let l = 0;
        let r = q + 2;
        do {
          c = b[r++];
          l = (l << 7) | (c & 0x7f);
        } while (c & 0x80);
        msgs.push({ tick, meta: type, data: b.slice(r, r + l) });
        q = r + l;
      } else {
        if (status & 0x80) {
          running = status;
          q += 1;
        } else status = running;
        const kind = status & 0xf0;
        const channel = status & 0x0f;
        if (kind === 0xc0 || kind === 0xd0) {
          msgs.push({ tick, kind, channel, a: b[q] });
          q += 1;
        } else {
          msgs.push({ tick, kind, channel, a: b[q], b: b[q + 1] });
          q += 2;
        }
      }
    }
    tracks.push(msgs);
    p = end;
  }
  return { header, tracks };
}

const makeCase = (extra = {}) => validateCase({ clips: [String(INDEX)], ...extra }).case;

describe('note events', () => {
  test('vlq and tick conversion', () => {
    assert.deepEqual(vlq(0), [0]);
    assert.deepEqual(vlq(127), [0x7f]);
    assert.deepEqual(vlq(128), [0x81, 0x00]);
    assert.deepEqual(vlq(0x3fff), [0xff, 0x7f]);
    assert.deepEqual(vlq(0x4000), [0x81, 0x80, 0x00]);
    assert.equal(msToTicks(500), 480, 'half a second at 120 bpm with 480 ppq is one beat');
    assert.equal(msToTicks(1000, { ppq: 96, bpm: 60 }), 96);
  });

  test('tracks follow the primary cast member, else the category voice; hats and clicks are percussion; dim items are silent', () => {
    const c = makeCase({ cast: [{ address: SENDER, label: 'Alice', voice: 'glass' }], filters: { castMode: 'mute' } });
    const score = buildScore(c, ledgersFor([INDEX]));
    const alice = score.events.find((e) => e.primary === 'c1');
    assert.equal(trackKeyFor(alice), 'cast:c1');
    const offer = score.events.find((e) => e.event.sound === 'hat' && !e.primary);
    assert.equal(trackKeyFor(offer), 'percussion');
    const dim = score.events.find((e) => e.gate === 'dim');
    assert.deepEqual(noteEventsFor(dim), []);
    const notes = noteEventsFor(alice, { channelFor: () => 3 });
    assert.ok(notes.length >= 1);
    assert.equal(notes[0].channel, 3);
    assert.equal(notes[0].timeMs, alice.timeMs);
    assert.ok(notes[0].velocity >= 1 && notes[0].velocity <= 127);
    assert.ok(notes[0].durationMs >= 40);
  });

  test('scoreNoteEvents is sorted, names tracks, assigns programs and skips channel 10 for pitched voices', () => {
    const c = makeCase({ cast: [{ address: SENDER, label: 'Alice', voice: 'brass' }] });
    const score = buildScore(c, ledgersFor([INDEX]));
    const { events, tracks, names, programs, channels } = scoreNoteEvents(score, c);
    for (let i = 1; i < events.length; i++) assert.ok(events[i].timeMs >= events[i - 1].timeMs);
    assert.ok(tracks.includes('cast:c1'));
    assert.ok(tracks.includes('percussion'));
    assert.equal(names['cast:c1'], 'Alice (Brass)');
    assert.equal(programs['cast:c1'], PROGRAMS.brass);
    assert.equal(programs.percussion, null);
    assert.ok(Object.values(channels).every((ch) => ch !== PERCUSSION_CHANNEL && ch <= 15));
    assert.ok(events.some((e) => e.note === PERCUSSION.ledger && e.channel === PERCUSSION_CHANNEL), 'the ledger pulse is on the percussion channel');
  });
});

describe('scoreToMidi', () => {
  test('writes a format-1 file whose tracks parse back with paired note on/off, programs, tempo and markers', () => {
    const c = validateCase({
      title: 'MIDI test',
      clips: [{ from: INDEX, to: INDEX }, { from: INDEX + 3, to: INDEX + 3 }],
      cast: [{ address: SENDER, label: 'Alice', voice: 'marimba' }],
      annotations: [{ anchor: { ledger: INDEX + 3 }, text: 'Second clip' }],
    }).case;
    const score = buildScore(c, ledgersFor([INDEX, INDEX + 3]));
    const bytes = scoreToMidi(score, c);
    const { header, tracks } = readSmf(bytes);
    assert.deepEqual(header, { length: 6, format: 1, ntracks: tracks.length, ppq: PPQ });
    const conductor = tracks[0];
    const tempo = conductor.find((m) => m.meta === 0x51);
    assert.ok(tempo);
    assert.equal((tempo.data[0] << 16) | (tempo.data[1] << 8) | tempo.data[2], Math.round(60000000 / BPM));
    const title = conductor.find((m) => m.meta === 0x03);
    assert.equal(new TextDecoder().decode(Uint8Array.from(title.data)), 'MIDI test');
    const marker = conductor.find((m) => m.meta === 0x06);
    assert.equal(new TextDecoder().decode(Uint8Array.from(marker.data)), 'Second clip');
    assert.equal(marker.tick, msToTicks(score.annotations[0].timeMs));
    const cues = conductor.filter((m) => m.meta === 0x07).map((m) => new TextDecoder().decode(Uint8Array.from(m.data)));
    assert.deepEqual(cues, [`ledger ${INDEX}`, `ledger ${INDEX + 3}`]);
    assert.ok(conductor.at(-1).meta === 0x2f, 'end of track');
    // Every note on has a later note off on the same channel and note.
    for (const t of tracks.slice(1)) {
      const open = new Map();
      for (const m of t) {
        if (m.kind === 0x90) open.set(`${m.channel}:${m.a}`, (open.get(`${m.channel}:${m.a}`) ?? 0) + 1);
        if (m.kind === 0x80) {
          const k = `${m.channel}:${m.a}`;
          assert.ok(open.get(k) > 0, `note off without on: ${k}`);
          open.set(k, open.get(k) - 1);
        }
      }
      assert.ok([...open.values()].every((n) => n === 0), 'all notes closed');
      assert.equal(t.at(-1).meta, 0x2f);
      for (let i = 1; i < t.length; i++) assert.ok(t[i].tick >= t[i - 1].tick, 'monotonic ticks');
    }
    const named = tracks.slice(1).map((t) => new TextDecoder().decode(Uint8Array.from(t.find((m) => m.meta === 0x03).data)));
    assert.ok(named.includes('Alice (Marimba)'));
    const aliceTrack = tracks[1 + named.indexOf('Alice (Marimba)')];
    const program = aliceTrack.find((m) => m.kind === 0xc0);
    assert.equal(program.a, PROGRAMS.marimba);
    assert.notEqual(program.channel, PERCUSSION_CHANNEL);
    const perc = tracks[1 + named.findIndex((n) => n.startsWith('Percussion'))];
    assert.ok(perc.some((m) => m.kind === 0x90 && m.channel === PERCUSSION_CHANNEL && m.a === PERCUSSION.ledger));
    assert.ok(perc.some((m) => m.kind === 0x90 && m.a === PERCUSSION.gap), 'the gap is marked');
  });

  test('the same score gives the same bytes; filenames are safe', () => {
    const c = makeCase({ title: 'Det' });
    const score = buildScore(c, ledgersFor([INDEX]));
    assert.deepEqual([...scoreToMidi(score, c)], [...scoreToMidi(score, c)]);
    assert.equal(midiFilename({ id: 'my case/x' }, score), 'my-case-x.mid');
    assert.equal(midiFilename(null, { caseId: 'abc' }), 'abc.mid');
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  RECORD_SECONDS,
  RECORDING_MIME_TYPES,
  pickRecordingMimeType,
  captureSupport,
  snapshotFilename,
  recordingFilename,
  snapshotLines,
} from '../src/capture.js';

describe('capture helpers', () => {
  test('records for 30 seconds and prefers VP9+Opus, then VP8+Opus, then plain webm', () => {
    assert.equal(RECORD_SECONDS, 30);
    assert.deepEqual([...RECORDING_MIME_TYPES], ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']);
    assert.equal(pickRecordingMimeType(() => true), 'video/webm;codecs=vp9,opus');
    assert.equal(pickRecordingMimeType((t) => t.includes('vp8')), 'video/webm;codecs=vp8,opus');
    assert.equal(pickRecordingMimeType((t) => t === 'video/webm'), 'video/webm');
    assert.equal(pickRecordingMimeType(() => false), null);
    assert.equal(pickRecordingMimeType(undefined), null);
    assert.equal(
      pickRecordingMimeType(() => {
        throw new Error('boom');
      }),
      null,
    );
  });

  test('captureSupport reports recording only with MediaRecorder, captureStream and a usable type', () => {
    class Canvas {}
    Canvas.prototype.captureStream = () => {};
    class Recorder {}
    Recorder.isTypeSupported = (t) => t.startsWith('video/webm');
    assert.deepEqual(captureSupport({ MediaRecorder: Recorder, HTMLCanvasElement: Canvas }), {
      snapshot: true,
      recording: true,
      mimeType: 'video/webm;codecs=vp9,opus',
    });
    assert.equal(captureSupport({ HTMLCanvasElement: Canvas }).recording, false);
    assert.equal(captureSupport({ MediaRecorder: Recorder, HTMLCanvasElement: class {} }).recording, false);
    class NoWebm {}
    NoWebm.isTypeSupported = () => false;
    assert.equal(captureSupport({ MediaRecorder: NoWebm, HTMLCanvasElement: Canvas }).recording, false);
    assert.equal(captureSupport().snapshot, true);
    assert.equal(captureSupport().recording, false);
  });

  test('filenames carry the ledger index and fall back to "live"', () => {
    assert.equal(snapshotFilename(107777809), 'xrpl-sonic-107777809.png');
    assert.equal(recordingFilename(107777809), 'xrpl-sonic-107777809.webm');
    assert.equal(snapshotFilename(null), 'xrpl-sonic-live.png');
    assert.equal(recordingFilename('abc'), 'xrpl-sonic-live.webm');
    assert.equal(snapshotFilename(0), 'xrpl-sonic-live.png');
  });

  test('snapshot overlay lines: network, ledger, tx per minute, timestamp, URL', () => {
    const lines = snapshotLines({
      ledgerIndex: 107777809,
      txLastMinute: 1234.4,
      network: 'Mainnet',
      timestamp: new Date('2026-10-20T06:30:15.123Z'),
      url: 'https://quigles1337.github.io/xrpl-sonic/',
    });
    assert.deepEqual(lines, [
      'xrpl-sonic · Mainnet',
      'Ledger #107,777,809',
      '1,234 tx in the last minute',
      '2026-10-20T06:30:15Z',
      'https://quigles1337.github.io/xrpl-sonic/',
    ]);
  });

  test('snapshot lines tolerate missing data', () => {
    const lines = snapshotLines({ timestamp: '2026-10-20T06:30:15Z' });
    assert.equal(lines[0], 'xrpl-sonic · Mainnet');
    assert.equal(lines[1], 'Ledger —');
    assert.equal(lines[2], '0 tx in the last minute');
    assert.equal(lines[3], '2026-10-20T06:30:15Z');
    assert.equal(lines.length, 4, 'no URL line without a URL');
    assert.match(snapshotLines()[3], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

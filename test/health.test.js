import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseFee, parseServerStatus, pressureLevel, formatPressure, describeHealth, isFresh, pressureTone, FEE_COMMAND, SERVER_SUBSCRIBE, FRESH_FOR_MS } from '../src/health.js';

/** The shape documented for the fee method, with a raised open-ledger fee and a non-empty queue. */
const feeResponse = {
  id: 7,
  status: 'success',
  type: 'response',
  result: {
    current_ledger_size: '56',
    current_queue_size: '11',
    drops: { base_fee: '10', median_fee: '5000', minimum_fee: '10', open_ledger_fee: '2653' },
    expected_ledger_size: '55',
    ledger_current_index: 26575101,
    levels: { median_level: '128000', minimum_level: '256', open_ledger_level: '67940', reference_level: '256' },
    max_queue_size: '1100',
  },
};

describe('parseFee', () => {
  test('reads fees in drops, the pressure ratio and the queue', () => {
    const f = parseFee(feeResponse);
    assert.equal(f.openLedgerFee, 2653);
    assert.equal(f.baseFee, 10);
    assert.equal(f.medianFee, 5000);
    assert.equal(f.minimumFee, 10);
    assert.equal(f.pressure, 265.3);
    assert.deepEqual(f.queue, { current: 11, max: 1100, fill: 0.01 });
    assert.equal(f.ledgerIndex, 26575101);
    assert.equal(f.expectedLedgerSize, 55);
    assert.equal(parseFee(feeResponse.result).pressure, 265.3, 'a bare result works too');
  });

  test('rejects malformed responses', () => {
    assert.equal(parseFee(null), null);
    assert.equal(parseFee({ result: {} }), null);
    assert.equal(parseFee({ result: { drops: { base_fee: '0', open_ledger_fee: '10' } } }), null);
    assert.equal(parseFee({ result: { drops: { base_fee: 'x', open_ledger_fee: '10' } } }), null);
    const minimal = parseFee({ result: { drops: { base_fee: '10', open_ledger_fee: '10' } } });
    assert.equal(minimal.pressure, 1);
    assert.deepEqual(minimal.queue, { current: null, max: null, fill: null });
  });

  test('commands are the documented ones', () => {
    assert.deepEqual(FEE_COMMAND, { command: 'fee' });
    assert.deepEqual(SERVER_SUBSCRIBE.streams, ['server']);
  });
});

describe('server status and words', () => {
  test('parseServerStatus reads the load factor relative to its base', () => {
    assert.deepEqual(parseServerStatus({ type: 'serverStatus', load_base: 256, load_factor: 512, server_status: 'full' }), { loadFactor: 2, serverStatus: 'full' });
    assert.deepEqual(parseServerStatus({ type: 'serverStatus', load_base: 0, load_factor: 512 }), { loadFactor: null, serverStatus: null });
    assert.equal(parseServerStatus({ type: 'ledgerClosed' }), null);
  });

  test('pressureLevel and formatPressure', () => {
    assert.equal(pressureLevel(1), 'minimum');
    assert.equal(pressureLevel(1.00005), 'minimum');
    assert.equal(pressureLevel(3), 'raised');
    assert.equal(pressureLevel(50), 'high');
    assert.equal(pressureLevel(265.3), 'extreme');
    assert.equal(pressureLevel('x'), 'minimum');
    assert.equal(formatPressure(1), '1.0×');
    assert.equal(formatPressure(12.49), '12.5×');
    assert.equal(formatPressure(1400), '1,400×');
    assert.equal(formatPressure(NaN), '—');
  });

  test('describeHealth names the source, the age and what the node does not offer', () => {
    const fee = parseFee(feeResponse);
    const text = describeHealth({ fee, host: 'xrplcluster.com', ageMs: 3200, serverStream: 'unsupported' });
    assert.equal(text, 'Observed fee pressure 265× (extreme): open-ledger fee 2,653 drops vs base 10 · queue 11 of 1,100 · load factor not offered by this node · from xrplcluster.com, 3 s ago.');
    assert.equal(describeHealth({ fee, host: 'h', ageMs: 100, load: { loadFactor: 1.5 } }), 'Observed fee pressure 265× (extreme): open-ledger fee 2,653 drops vs base 10 · queue 11 of 1,100 · load factor 1.50× · from h, just now.');
    assert.equal(describeHealth({ host: 'h' }), 'No fee sample yet from h.');
    assert.equal(describeHealth(), 'Not polling.');
  });

  test('freshness and the drone curve', () => {
    assert.equal(isFresh(FRESH_FOR_MS), true);
    assert.equal(isFresh(FRESH_FOR_MS + 1), false);
    assert.equal(isFresh(null), false);
    assert.deepEqual(pressureTone(1), { gain: 0, cutoff: 120, detune: 0 });
    const mid = pressureTone(10);
    assert.ok(mid.gain > 0 && mid.gain < pressureTone(100).gain);
    assert.ok(pressureTone(1e9).gain <= 0.15, 'capped');
    assert.equal(pressureTone('x').gain, 0);
  });
});

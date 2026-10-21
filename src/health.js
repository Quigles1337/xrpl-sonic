// xrpl-sonic — observed fee pressure: what the connected node says about its
// open ledger and its queue.
//
// The `fee` command reports, for the node answering it, the fee a reference
// transaction needs to enter the current open ledger (`open_ledger_fee`), the
// reference fee under minimum load (`base_fee`), and the size of the node's
// own transaction queue. Their ratio is the pressure shown here. Every XRPL
// server keeps its own queue, so this describes the connected node, not one
// network-wide state; the readout always names its source and its age.
//
// Pure: parsing and description only.

export const FEE_COMMAND = Object.freeze({ command: 'fee' });
export const SERVER_SUBSCRIBE = Object.freeze({ id: 'xrpl-sonic-server', command: 'subscribe', streams: ['server'] });
export const FRESH_FOR_MS = 15000;

function drops(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Parse a `fee` response (the whole message or just its `result`).
 * @returns {{ openLedgerFee, baseFee, medianFee, minimumFee, pressure, queue: { current, max, fill }, ledgerIndex, expectedLedgerSize, currentLedgerSize } | null}
 */
export function parseFee(response) {
  const r = response?.result ?? response;
  if (!r || typeof r !== 'object' || !r.drops || typeof r.drops !== 'object') return null;
  const openLedgerFee = drops(r.drops.open_ledger_fee);
  const baseFee = drops(r.drops.base_fee);
  if (openLedgerFee == null || baseFee == null || baseFee === 0) return null;
  const current = drops(r.current_queue_size);
  const max = drops(r.max_queue_size);
  return {
    openLedgerFee,
    baseFee,
    medianFee: drops(r.drops.median_fee),
    minimumFee: drops(r.drops.minimum_fee),
    pressure: openLedgerFee / baseFee,
    queue: { current, max, fill: current != null && max ? current / max : null },
    ledgerIndex: Number.isFinite(Number(r.ledger_current_index)) ? Number(r.ledger_current_index) : null,
    expectedLedgerSize: drops(r.expected_ledger_size),
    currentLedgerSize: drops(r.current_ledger_size),
  };
}

/** Parse a `serverStatus` message from the `server` stream: the node's load factor relative to its base. */
export function parseServerStatus(msg) {
  if (!msg || typeof msg !== 'object' || msg.type !== 'serverStatus') return null;
  const factor = Number(msg.load_factor);
  const base = Number(msg.load_base);
  return {
    loadFactor: Number.isFinite(factor) && Number.isFinite(base) && base > 0 ? factor / base : null,
    serverStatus: typeof msg.server_status === 'string' ? msg.server_status : null,
  };
}

/** A word for a pressure ratio, for the readout only. */
export function pressureLevel(pressure) {
  const p = Number(pressure);
  if (!Number.isFinite(p) || p <= 1.0001) return 'minimum';
  if (p < 10) return 'raised';
  if (p < 100) return 'high';
  return 'extreme';
}

/** "1.0×", "12.5×", "1,400×". */
export function formatPressure(pressure) {
  const p = Number(pressure);
  if (!Number.isFinite(p)) return '—';
  if (p >= 100) return `${Math.round(p).toLocaleString('en-US')}×`;
  return `${p.toFixed(1)}×`;
}

/** The readout's sentence. `ageMs` is how old the sample is; `host` where it came from. */
export function describeHealth({ fee = null, load = null, host = '', ageMs = null, serverStream = 'unknown' } = {}) {
  if (!fee) return host ? `No fee sample yet from ${host}.` : 'Not polling.';
  const parts = [`Observed fee pressure ${formatPressure(fee.pressure)} (${pressureLevel(fee.pressure)}): open-ledger fee ${fee.openLedgerFee.toLocaleString('en-US')} drops vs base ${fee.baseFee.toLocaleString('en-US')}`];
  if (fee.queue.current != null) parts.push(`queue ${fee.queue.current.toLocaleString('en-US')}${fee.queue.max ? ` of ${fee.queue.max.toLocaleString('en-US')}` : ''}`);
  if (load?.loadFactor != null) parts.push(`load factor ${load.loadFactor.toFixed(2)}×`);
  else if (serverStream === 'unsupported') parts.push('load factor not offered by this node');
  const age = ageMs == null ? '' : ageMs < 1500 ? 'just now' : `${Math.round(ageMs / 1000)} s ago`;
  parts.push(`from ${host || 'the node'}${age ? `, ${age}` : ''}`);
  return `${parts.join(' · ')}.`;
}

/** Is a sample fresh enough to act on? */
export function isFresh(ageMs) {
  return ageMs != null && ageMs <= FRESH_FOR_MS;
}

/**
 * The drone's parameters for a pressure ratio: silent at minimum load, rising
 * on a log scale. Returns { gain (0..1), cutoff (Hz), detune (cents) }.
 */
export function pressureTone(pressure) {
  const p = Math.max(1, Number(pressure) || 1);
  const x = Math.min(1, Math.log10(p) / 3); // 1× → 0, 1000× → 1
  return { gain: x === 0 ? 0 : 0.03 + x * 0.12, cutoff: 120 + x * 1800, detune: x * 18 };
}

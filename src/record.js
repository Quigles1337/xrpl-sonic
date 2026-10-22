// xrpl-sonic — the record check behind coherence (docs/coherence.md, phase 1.5).
//
// A correlation between two accounts' activity is a statistic; whether the
// two touch in the record is a fact of the ledger. For every transaction in
// a window this module keeps a compact touch record: who submitted it, who
// its Destination is, whose ledger entries its AffectedNodes carry (trust
// lines told apart from the rest, because a RippleState belongs to both
// sides), and whose offers it crossed (Part A's findings, src/explorer/facts.js).
// `connections()` then counts, for a pair, the transactions where one of
// the two submitted and the other was touched, with the hashes, so a readout
// can say "connected in the record: N transactions" or "not connected in
// this window". A transaction submitted by a third party that touches both
// is not a connection between the two; it is not counted.
//
// Pure: no DOM, no network.

import { facts } from './explorer/facts.js';

/** How a transaction connects two accounts, strongest first. */
export const TOUCH_KINDS = Object.freeze(['destination', 'crossed', 'entry', 'line']);

export const TOUCH_WORDS = Object.freeze({
  destination: 'the other is the Destination',
  crossed: 'the other’s offer was crossed',
  entry: 'the other’s ledger entry is in the AffectedNodes',
  line: 'a trust line of the other is in the AffectedNodes',
});

const HASH = /^[0-9A-F]{64}$/i;
const upper = (h) => (typeof h === 'string' && HASH.test(h) ? h.toUpperCase() : null);
const isAddress = (a) => typeof a === 'string' && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a);

/** Fields of a ledger entry that name the account it belongs to (besides a trust line's two sides). */
const OWNER_FIELDS = Object.freeze(['Account', 'Owner', 'Destination', 'Issuer', 'Subject', 'Authorize']);

/**
 * The touch record of one validated transaction.
 * @param {object} tx
 * @param {object|null} meta
 * @param {{ hash?: string, ledgerIndex?: number, facts?: object }} [extra]  Part A facts already computed, else computed here when a book offer is in the record
 * @returns {{ hash: string|null, ledgerIndex: number|null, submitter: string|null, destination: string|null, entries: string[], lines: string[], crossed: string[], success: boolean }|null}
 */
export function touchOf(tx, meta, { hash = null, ledgerIndex = null, facts: given = null } = {}) {
  if (!tx || typeof tx !== 'object' || typeof tx.TransactionType !== 'string') return null;
  const submitter = isAddress(tx.Account) ? tx.Account : null;
  const destination = isAddress(tx.Destination) ? tx.Destination : null;
  const entries = new Set();
  const lines = new Set();
  let bookOffer = false;
  for (const raw of meta?.AffectedNodes ?? []) {
    const e = raw?.CreatedNode ?? raw?.ModifiedNode ?? raw?.DeletedNode;
    if (!e || typeof e !== 'object') continue;
    const f = e.FinalFields ?? e.NewFields ?? {};
    if (e.LedgerEntryType === 'RippleState') {
      for (const side of [f.HighLimit?.issuer, f.LowLimit?.issuer]) if (isAddress(side)) lines.add(side);
      continue;
    }
    for (const field of OWNER_FIELDS) if (isAddress(f[field])) entries.add(f[field]);
    if (e.LedgerEntryType === 'Offer' && isAddress(f.Account) && f.Account !== submitter) bookOffer = true;
  }
  const crossed = new Set();
  if (bookOffer) {
    const fx = given ?? facts(tx, meta);
    for (const o of fx?.offers ?? []) if (o.role === 'book' && o.traded === 'yes' && isAddress(o.owner)) crossed.add(o.owner);
  }
  const idx = Number(ledgerIndex ?? tx.ledger_index ?? meta?.ledger_index);
  return {
    hash: upper(hash) ?? upper(tx.hash),
    ledgerIndex: Number.isInteger(idx) && idx > 0 ? idx : null,
    submitter,
    destination,
    entries: [...entries],
    lines: [...lines],
    crossed: [...crossed],
    success: meta?.TransactionResult === 'tesSUCCESS',
  };
}

/** The touch records of a fetched `ledger` (with transactions expanded), in application order. */
export function touchesOfLedger(ledger) {
  const out = [];
  const index = Number(ledger?.ledger_index);
  for (const tx of ledger?.transactions ?? []) {
    const t = touchOf(tx, tx?.metaData ?? tx?.meta ?? null, { hash: tx?.hash, ledgerIndex: Number.isInteger(index) ? index : null });
    if (t) out.push(t);
  }
  return out;
}

/** The touch records of `account_tx` entries ({ tx | tx_json, meta, hash?, ledger_index? }), one per hash. */
export function touchesOfEntries(entries) {
  const out = [];
  const seen = new Set();
  for (const entry of entries ?? []) {
    const tx = entry?.tx ?? entry?.tx_json ?? null;
    if (!tx) continue;
    const t = touchOf(tx, entry.meta ?? entry.metaData ?? null, { hash: entry.hash ?? tx.hash, ledgerIndex: entry.ledger_index ?? tx.ledger_index ?? null });
    if (!t) continue;
    if (t.hash && seen.has(t.hash)) continue;
    if (t.hash) seen.add(t.hash);
    out.push(t);
  }
  return out;
}

/** How a transaction submitted by `by` touches `other`: the strongest kind, or null. */
export function touchKind(t, by, other) {
  if (!t || t.submitter !== by || by === other) return null;
  if (t.destination === other) return 'destination';
  if (t.crossed.includes(other)) return 'crossed';
  if (t.entries.includes(other)) return 'entry';
  if (t.lines.includes(other)) return 'line';
  return null;
}

/**
 * The transactions of a window in which two accounts touch: one submitted
 * and the other is its Destination, owns an entry in its AffectedNodes, or
 * owned an offer it crossed. Each transaction once, by its strongest kind.
 * @param {object[]} touches  from touchesOfLedger / touchesOfEntries / the live window
 * @returns {{ count: number, failed: number, byKind: Record<string, number>, transactions: { hash: string|null, ledgerIndex: number|null, by: string, kind: string, success: boolean }[] }}
 */
export function connections(touches, a, b) {
  const out = { count: 0, failed: 0, byKind: Object.fromEntries(TOUCH_KINDS.map((k) => [k, 0])), transactions: [] };
  if (!Array.isArray(touches) || !a || !b || a === b) return out;
  const seen = new Set();
  for (const t of touches) {
    const kind = touchKind(t, a, b) ?? touchKind(t, b, a);
    if (!kind) continue;
    if (t.hash) {
      if (seen.has(t.hash)) continue;
      seen.add(t.hash);
    }
    out.count += 1;
    if (!t.success) out.failed += 1;
    out.byKind[kind] += 1;
    out.transactions.push({ hash: t.hash, ledgerIndex: t.ledgerIndex, by: t.submitter, kind, success: t.success });
  }
  out.transactions.sort((x, y) => (x.ledgerIndex ?? 0) - (y.ledgerIndex ?? 0) || String(x.hash).localeCompare(String(y.hash)));
  return out;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "connected in the record: 3 transactions (1 destination, 2 crossed; 1 failed)" or "not connected in this window". */
export function describeConnections(c) {
  if (!c) return 'record not available';
  if (!c.count) return 'not connected in this window';
  const kinds = TOUCH_KINDS.filter((k) => c.byKind[k] > 0).map((k) => `${c.byKind[k]} ${k}`);
  const failed = c.failed ? `; ${c.failed} failed` : '';
  return `connected in the record: ${plural(c.count, 'transaction')} (${kinds.join(', ')}${failed})`;
}

/** The hashes of the connecting transactions, with ledger, submitter and kind, up to `max` of them. */
export function connectionLines(c, labelOf = (a) => a, { max = 8 } = {}) {
  if (!c?.count) return [];
  const shown = c.transactions.slice(0, max);
  const items = shown.map((t) => `${t.hash ?? 'no hash'} (#${t.ledgerIndex ?? '?'}, by ${labelOf(t.by)}: ${TOUCH_WORDS[t.kind]}${t.success ? '' : ', failed'})`);
  const more = c.transactions.length - shown.length;
  return [`record: ${items.join('; ')}${more > 0 ? `; and ${more} more` : ''}`];
}

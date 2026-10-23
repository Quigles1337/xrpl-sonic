// UNIVERSE spike — compact records.
//
// The worker keeps one compact record per transaction heard and one planet
// per account it has seen; the page never holds a raw stream message after
// the record is made. A record keeps what the vocabulary of docs/universe.md
// needs and nothing else: the hash, the ledger, the type and result, the
// submitter and the Destination as interned account ids, the amount as a
// log10 (the sky draws size and tail length from it; the explorer page has
// the exact figure), the currency as an interned id, the issuer when there
// is one, the path length for a payment's tail, and every account the
// AffectedNodes touched, as ids. Strings are interned once per worker in an
// `Interner`, so an address costs its 4-byte id in every record after the
// first.
//
// Beside the record, three readers of the metadata feed the body rules:
// `rootsOf` (every AccountRoot touched: balance, flags, regular key, domain,
// AMMID, created or deleted), `linesOf` (every RippleState: both sides, the
// balance and the limits) with `issuerOfLine` (which side issued), and
// `offersOf` (Offer entries created and deleted, by owner).
//
// Pure: no DOM, no network.

import { categorize, parseAmount, decodeCurrency } from '../mapping.js';

/** The transaction categories of the field guide, as small integers; the sky colours by them. */
export const CATEGORY_CODES = Object.freeze({ payment: 0, offer: 1, trust: 2, nft: 3, escrow: 4, paychan: 5, amm: 6, other: 7 });
export const CATEGORY_BY_CODE = Object.freeze(Object.keys(CATEGORY_CODES));

/** Transaction types that matter to a body's rule beyond their category. 0 = any other type. */
export const TYPE_CODES = Object.freeze({
  Payment: 1,
  OfferCreate: 2,
  OfferCancel: 3,
  TrustSet: 4,
  EscrowCreate: 5,
  EscrowFinish: 6,
  EscrowCancel: 7,
  AccountSet: 8,
  AccountDelete: 9,
  SetRegularKey: 10,
  NFTokenMint: 11,
  NFTokenBurn: 12,
  NFTokenCreateOffer: 13,
  NFTokenAcceptOffer: 14,
  NFTokenCancelOffer: 15,
  AMMCreate: 16,
  AMMDeposit: 17,
  AMMWithdraw: 18,
  AMMBid: 19,
  AMMVote: 20,
  AMMDelete: 21,
  PaymentChannelCreate: 22,
  PaymentChannelFund: 23,
  PaymentChannelClaim: 24,
  CheckCreate: 25,
  CheckCash: 26,
  CheckCancel: 27,
  TicketCreate: 28,
  Batch: 29,
  Clawback: 30,
});
export const TYPE_BY_CODE = Object.freeze(['other', ...Object.keys(TYPE_CODES)]);

const ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
export const isAddress = (a) => typeof a === 'string' && ADDRESS.test(a);

/** Strings to small integers, once each. Id 0 is "none". */
export class Interner {
  constructor() {
    this.ids = new Map();
    this.strings = [null];
  }

  id(s) {
    if (typeof s !== 'string' || !s) return 0;
    let id = this.ids.get(s);
    if (id == null) {
      id = this.strings.length;
      this.strings.push(s);
      this.ids.set(s, id);
    }
    return id;
  }

  has(s) {
    return this.ids.has(s);
  }

  string(id) {
    return this.strings[id] ?? null;
  }

  get size() {
    return this.strings.length - 1;
  }
}

/** log10 of an amount in its own units, or null; XRP in XRP. */
export function logAmount(amount) {
  if (!amount || !(amount.value > 0)) return null;
  return Math.log10(amount.value);
}

const entryOf = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.CreatedNode) return { action: 'created', e: raw.CreatedNode };
  if (raw.ModifiedNode) return { action: 'modified', e: raw.ModifiedNode };
  if (raw.DeletedNode) return { action: 'deleted', e: raw.DeletedNode };
  return null;
};
const fieldsOf = (e) => e.FinalFields ?? e.NewFields ?? {};

/** The accounts whose ledger entries a transaction's metadata touched, with trust lines told apart (both sides belong to a RippleState). The submitter is left out. */
export function touchedBy(meta, submitter = null) {
  const entries = new Set();
  const lines = new Set();
  for (const raw of meta?.AffectedNodes ?? []) {
    const n = entryOf(raw);
    if (!n) continue;
    const f = fieldsOf(n.e);
    if (n.e.LedgerEntryType === 'RippleState') {
      for (const side of [f.HighLimit?.issuer, f.LowLimit?.issuer]) if (isAddress(side) && side !== submitter) lines.add(side);
      continue;
    }
    for (const field of ['Account', 'Owner', 'Destination', 'Issuer']) if (isAddress(f[field]) && f[field] !== submitter) entries.add(f[field]);
  }
  return { entries: [...entries], lines: [...lines] };
}

/**
 * Every AccountRoot in the metadata: what the record says about the account
 * at the end of the transaction. `regularKey` is the address when the entry
 * has one and null when the final fields carry none; `balance` is drops as a
 * Number (the sky needs its logarithm, not the drop).
 */
export function rootsOf(meta) {
  const out = [];
  for (const raw of meta?.AffectedNodes ?? []) {
    const n = entryOf(raw);
    if (!n || n.e.LedgerEntryType !== 'AccountRoot') continue;
    const f = fieldsOf(n.e);
    if (!isAddress(f.Account)) continue;
    const balance = Number(f.Balance);
    out.push({
      address: f.Account,
      action: n.action,
      balance: Number.isFinite(balance) ? balance : null,
      flags: (Number(f.Flags) || 0) >>> 0,
      ownerCount: Number.isInteger(Number(f.OwnerCount)) ? Number(f.OwnerCount) : null,
      regularKey: isAddress(f.RegularKey) ? f.RegularKey : null,
      domain: typeof f.Domain === 'string' && /^[0-9A-Fa-f]+$/.test(f.Domain) ? f.Domain : null,
      ammId: typeof f.AMMID === 'string' ? f.AMMID : null,
      sequence: Number.isInteger(Number(f.Sequence)) ? Number(f.Sequence) : null,
    });
  }
  return out;
}

/** Every RippleState in the metadata: both sides, the balance from the low side's view, and the two limits. */
export function linesOf(meta) {
  const out = [];
  for (const raw of meta?.AffectedNodes ?? []) {
    const n = entryOf(raw);
    if (!n || n.e.LedgerEntryType !== 'RippleState') continue;
    const f = fieldsOf(n.e);
    const low = f.LowLimit?.issuer;
    const high = f.HighLimit?.issuer;
    if (!isAddress(low) || !isAddress(high)) continue;
    out.push({
      action: n.action,
      low,
      high,
      currency: decodeCurrency(f.Balance?.currency ?? f.LowLimit?.currency ?? ''),
      balance: Number(f.Balance?.value) || 0,
      lowLimit: Number(f.LowLimit?.value) || 0,
      highLimit: Number(f.HighLimit?.value) || 0,
      flags: (Number(f.Flags) || 0) >>> 0,
    });
  }
  return out;
}

/**
 * Which side of a trust line issued and which holds (rule `line.issuer`):
 * the balance is kept from the low side's view, so a positive balance means
 * the low side holds the high side's issue and a negative one the reverse;
 * at zero, the side that set a limit is the holder (a holder trusts an
 * issuer, never the other way). Both limits set at zero balance, or neither,
 * is unresolved: the record does not say.
 */
export function issuerOfLine(line) {
  if (!line) return null;
  if (line.balance > 0) return { issuer: line.high, holder: line.low, tier: 'calculated', rule: 'line.issuer.balance' };
  if (line.balance < 0) return { issuer: line.low, holder: line.high, tier: 'calculated', rule: 'line.issuer.balance' };
  if (line.lowLimit > 0 && !(line.highLimit > 0)) return { issuer: line.high, holder: line.low, tier: 'rule', rule: 'line.issuer.limit' };
  if (line.highLimit > 0 && !(line.lowLimit > 0)) return { issuer: line.low, holder: line.high, tier: 'rule', rule: 'line.issuer.limit' };
  return null;
}

/** Offer entries created and deleted, by owner, so a planet's open offers can be counted from the stream. */
export function offersOf(meta) {
  const out = [];
  for (const raw of meta?.AffectedNodes ?? []) {
    const n = entryOf(raw);
    if (!n || n.e.LedgerEntryType !== 'Offer') continue;
    const f = fieldsOf(n.e);
    if (!isAddress(f.Account)) continue;
    out.push({ owner: f.Account, action: n.action, sequence: Number(f.Sequence) || null });
  }
  return out;
}

/**
 * One compact record from a stream message's tx and meta. `interner` turns
 * addresses into ids and `currencies` currency names; without them the
 * record carries the strings (for measuring and for tests).
 */
export function compactRecord(tx, meta, { hash = null, ledgerIndex = null, result = null, amount = null, interner = null, currencies = null } = {}) {
  const intern = interner ? (s) => interner.id(s) : (s) => s ?? null;
  const internCurrency = currencies ? (s) => currencies.id(s) : interner ? (s) => interner.id(s) : (s) => s ?? null;
  const type = tx?.TransactionType;
  const amt = amount ?? parseAmount(tx?.Amount ?? tx?.DeliverMax ?? tx?.TakerGets ?? tx?.LimitAmount ?? null);
  const touched = touchedBy(meta, tx?.Account);
  return {
    hash: typeof hash === 'string' ? hash.toUpperCase() : typeof tx?.hash === 'string' ? tx.hash.toUpperCase() : null,
    ledger: Number.isInteger(Number(ledgerIndex)) ? Number(ledgerIndex) : null,
    index: Number.isInteger(Number(meta?.TransactionIndex)) ? Number(meta.TransactionIndex) : null,
    type: TYPE_CODES[type] ?? 0,
    category: CATEGORY_CODES[categorize(type)] ?? 7,
    success: result === 'tesSUCCESS' || meta?.TransactionResult === 'tesSUCCESS',
    account: intern(isAddress(tx?.Account) ? tx.Account : null),
    destination: intern(isAddress(tx?.Destination) ? tx.Destination : null),
    issuer: intern(amt && !amt.isXrp && isAddress(amt.issuer) ? amt.issuer : null),
    currency: internCurrency(amt ? amt.currency : null),
    log: logAmount(amt),
    xrp: Boolean(amt?.isXrp),
    paths: Array.isArray(tx?.Paths) ? tx.Paths.reduce((n, p) => Math.max(n, Array.isArray(p) ? p.length : 0), 0) : 0,
    flags: (Number(tx?.Flags) || 0) >>> 0,
    entries: touched.entries.map(intern),
    lines: touched.lines.map(intern),
    // the fields a body's rule reads directly
    finishAfter: type === 'EscrowCreate' && Number.isFinite(Number(tx.FinishAfter)) ? Number(tx.FinishAfter) : null,
    nftokenId: typeof tx?.NFTokenID === 'string' ? tx.NFTokenID : null,
    offerSequence: Number.isInteger(Number(tx?.OfferSequence)) ? Number(tx.OfferSequence) : null,
    sequence: Number.isInteger(Number(tx?.Sequence)) ? Number(tx.Sequence) : null,
    created: (meta?.AffectedNodes ?? []).some((n) => n?.CreatedNode?.LedgerEntryType === 'AccountRoot'),
    deleted: (meta?.AffectedNodes ?? []).some((n) => n?.DeletedNode?.LedgerEntryType === 'AccountRoot'),
  };
}

/**
 * What one record costs in a typed-array store, in bytes: the fixed fields
 * as 32 bytes of hash plus 4-byte ints and a float for the amount, and 4
 * bytes per touched id. The JS object the spike keeps is larger (V8 object
 * headers and a string for the hash); the worker measures that side.
 */
export function recordBytes(rec) {
  const fixed = 32 /* hash */ + 4 /* ledger */ + 2 /* index */ + 1 /* type */ + 1 /* category+success */ + 4 * 4 /* account, destination, issuer, currency */ + 4 /* log as f32 */ + 1 /* paths */ + 4 /* flags */ + 4 /* finishAfter */ + 2 /* small fields */;
  const nft = rec.nftokenId ? 32 : 0;
  return fixed + nft + 4 * ((rec.entries?.length ?? 0) + (rec.lines?.length ?? 0));
}

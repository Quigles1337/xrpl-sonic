// xrpl-sonic explorer — the facts of a transaction.
//
// Reads a validated transaction's `tx` and `meta` and returns typed findings,
// not prose. Every finding carries a tier (observed field, calculated change,
// rule-based interpretation, or hypothesis), a rule id, evidence references
// (which AffectedNodes entry, which fields) and exact values as strings: XRP
// in integer drops, issued currencies as decimal strings with currency and
// issuer. No Number() touches an amount here; src/decimal.js does the
// arithmetic. "unresolved" is a legal value for any property no validated
// rule establishes. The renderers in anatomy.js turn these into sentences and
// keep the rule ids, so "why does it say that?" is a lookup.
//
// The schema and the rule catalogue are documented in docs/facts.md; the
// fixtures in test/fixtures/facts/ are real mainnet records that prove it.
//
// Pure: no DOM, no network.

import { decodeCurrency } from '../mapping.js';
import { normalize, add, sub, cmp, isZero, isNegative, nearlyEqual, divRatio, mulInt } from '../decimal.js';

export const FACTS_VERSION = 1;

export const TIERS = Object.freeze(['observed', 'calculated', 'rule', 'hypothesis']);

/** The rule catalogue: id → tier and what the rule states. */
export const RULES = Object.freeze({
  result: { tier: 'observed', text: 'The result code recorded in the metadata, and its family.' },
  'transaction.flags': { tier: 'observed', text: 'The flag bits set on the transaction, named for its type.' },
  'node.action': { tier: 'observed', text: 'The wrapper key of the AffectedNodes entry: created, modified or deleted.' },
  'offer.identity': { tier: 'observed', text: 'Owner, sequence, expiration and sell flag of the Offer entry, from its recorded fields.' },
  'offer.amounts.after': { tier: 'observed', text: 'TakerGets and TakerPays at the end of the transaction (FinalFields or NewFields).' },
  'offer.amounts.before': { tier: 'observed', text: 'TakerGets and TakerPays before the transaction (PreviousFields).' },
  'offer.amounts.before.unchanged': { tier: 'observed', text: 'PreviousFields carries no amount, so the amounts did not change.' },
  'offer.trade.previous-fields': { tier: 'calculated', text: 'An offer traded when PreviousFields carries its amounts; it did not when PreviousFields is absent. A one-sided PreviousFields is unresolved.' },
  'offer.trade.delta': { tier: 'calculated', text: 'What the owner gave (TakerGets before minus after) and received (TakerPays before minus after).' },
  'offer.role': { tier: 'rule', text: 'Whose offer it is: the submitter’s new offer, the submitter’s pre-existing offer, or someone else’s offer on the book.' },
  'offer.placed': { tier: 'observed', text: 'A CreatedNode Offer owned by the submitter: the remainder placed on the book.' },
  'offer.modified.partial': { tier: 'calculated', text: 'A modified offer whose amounts changed was partly consumed.' },
  'offer.modified.other': { tier: 'observed', text: 'A modified offer whose amounts did not change.' },
  'offer.removal.cancelled': { tier: 'rule', text: 'OfferCancel by the owner naming this sequence as OfferSequence; not traded.' },
  'offer.removal.replaced': { tier: 'rule', text: 'OfferCreate by the owner naming this sequence as OfferSequence; not traded.' },
  'offer.removal.self-cross': { tier: 'rule', text: 'OfferCreate by the owner, a different sequence, not traded: the ledger removes an account’s older offer on the opposite side rather than trading it against itself.' },
  'offer.removal.consumed': { tier: 'rule', text: 'Traded, and both final amounts are zero.' },
  'offer.removal.traded-unfunded': { tier: 'rule', text: 'Traded, and a final amount is above zero: the funded part traded and the rest left the book.' },
  'offer.removal.cleanup': { tier: 'rule', text: 'Deleted without trading by a transaction that did not name it: the ledger removes an offer it crosses only when it is expired or unfunded.' },
  'offer.removal.unresolved': { tier: 'rule', text: 'No validated rule applies to this removal.' },
  'offer.expired': { tier: 'calculated', text: 'The entry’s Expiration compared with the ledger close time the transaction carries (rippled judges against the parent ledger’s close time, which the record does not carry).' },
  'exchange.request': { tier: 'observed', text: 'What the submitter asked for: TakerGets, TakerPays and the flags.' },
  'exchange.book': { tier: 'calculated', text: 'Sums over the crossed offers’ deltas, by currency: what their owners gave (received by the submitter) and got (spent by the submitter).' },
  'exchange.bridged': { tier: 'calculated', text: 'A crossed offer is in a pair other than the request’s: the fill was bridged through XRP, and the XRP legs net out.' },
  'exchange.amm': { tier: 'rule', text: 'A modified AccountRoot carrying AMMID whose balances moved: an AMM pool took part; its deltas are its leg.' },
  'exchange.amm.suspected': { tier: 'hypothesis', text: 'Balances moved in two currencies for an account that owns no crossed offer and whose AccountRoot is not in the record.' },
  'exchange.received': { tier: 'calculated', text: 'Total received in the request’s TakerPays currency: book plus AMM.' },
  'exchange.spent': { tier: 'calculated', text: 'Total spent in the request’s TakerGets currency: book plus AMM.' },
  'exchange.fill': { tier: 'calculated', text: 'Achieved against requested on the side the flags select: TakerPays received, or with tfSell TakerGets spent.' },
  'exchange.fill.rounding': { tier: 'calculated', text: 'The shortfall is below one part in ten billion: a rounding residue, not a partial fill.' },
  'exchange.fill.ioc': { tier: 'rule', text: 'tfImmediateOrCancel: whatever did not cross was not placed, by design.' },
  'exchange.fill.fok': { tier: 'rule', text: 'tfFillOrKill: the whole request filled or the transaction would have failed with tecKILLED.' },
  'exchange.corroboration.received': { tier: 'calculated', text: 'The submitter’s own balance change in the received currency, compared with the total received (less the fee when that currency is XRP).' },
  'exchange.corroboration.spent': { tier: 'calculated', text: 'The submitter’s own balance change in the spent currency, compared with the total spent (plus the fee when that currency is XRP). A debit larger by a factor of at most 2 is consistent with the issuer’s transfer fee, which the record does not carry.' },
  'exchange.corroboration.fee': { tier: 'calculated', text: 'Neither side is XRP, so the submitter’s XRP should have moved by exactly the fee.' },
  'payment.delivered': { tier: 'observed', text: 'What arrived, from the metadata’s delivered_amount.' },
  'payment.crossed': { tier: 'calculated', text: 'Offers consumed on the way, with what each gave and got.' },
  'payment.spent': { tier: 'calculated', text: 'What the sender paid, from its own balance change in the SendMax currency (the fee removed when that is XRP).' },
  'balance.xrp': { tier: 'calculated', text: 'An AccountRoot balance before and after, in drops.' },
  'balance.issued': { tier: 'calculated', text: 'A RippleState balance before and after, seen from both sides of the line.' },
});

/** Transaction flag bits by type, plus the universal ones. 0x00020000 means different things on different types. */
export const FLAG_NAMES = Object.freeze({
  universal: Object.freeze({ 0x80000000: 'tfFullyCanonicalSig', 0x40000000: 'tfInnerBatchTxn' }),
  OfferCreate: Object.freeze({ 0x00010000: 'tfPassive', 0x00020000: 'tfImmediateOrCancel', 0x00040000: 'tfFillOrKill', 0x00080000: 'tfSell', 0x00100000: 'tfHybrid' }),
  Payment: Object.freeze({ 0x00010000: 'tfNoRippleDirect', 0x00020000: 'tfPartialPayment', 0x00040000: 'tfLimitQuality' }),
  TrustSet: Object.freeze({ 0x00010000: 'tfSetfAuth', 0x00020000: 'tfSetNoRipple', 0x00040000: 'tfClearNoRipple', 0x00100000: 'tfSetFreeze', 0x00200000: 'tfClearFreeze', 0x00400000: 'tfSetDeepFreeze', 0x00800000: 'tfClearDeepFreeze' }),
  AccountSet: Object.freeze({ 0x00010000: 'tfRequireDestTag', 0x00020000: 'tfOptionalDestTag', 0x00040000: 'tfRequireAuth', 0x00080000: 'tfOptionalAuth', 0x00100000: 'tfDisallowXRP', 0x00200000: 'tfAllowXRP' }),
  NFTokenMint: Object.freeze({ 0x00000001: 'tfBurnable', 0x00000002: 'tfOnlyXRP', 0x00000004: 'tfTrustLine', 0x00000008: 'tfTransferable', 0x00000010: 'tfMutable' }),
  NFTokenCreateOffer: Object.freeze({ 0x00000001: 'tfSellNFToken' }),
  PaymentChannelClaim: Object.freeze({ 0x00010000: 'tfRenew', 0x00020000: 'tfClose' }),
  AMMDeposit: Object.freeze({ 0x00010000: 'tfLPToken', 0x00080000: 'tfSingleAsset', 0x00100000: 'tfTwoAsset', 0x00200000: 'tfOneAssetLPToken', 0x00400000: 'tfLimitLPToken', 0x00800000: 'tfTwoAssetIfEmpty' }),
  AMMWithdraw: Object.freeze({ 0x00010000: 'tfLPToken', 0x00020000: 'tfWithdrawAll', 0x00040000: 'tfOneAssetWithdrawAll', 0x00080000: 'tfSingleAsset', 0x00100000: 'tfTwoAsset', 0x00200000: 'tfOneAssetLPToken', 0x00400000: 'tfLimitLPToken' }),
});

const OFFER_FLAGS = Object.freeze({ PASSIVE: 0x00010000, IOC: 0x00020000, FOK: 0x00040000, SELL: 0x00080000 });
const PAYMENT_FLAGS = Object.freeze({ NO_RIPPLE_DIRECT: 0x00010000, PARTIAL: 0x00020000, LIMIT_QUALITY: 0x00040000 });
/** lsfSell on an Offer ledger entry. */
const LSF_SELL = 0x00020000;

const hasFlag = (flags, bit) => ((Number(flags) || 0) >>> 0 & bit) !== 0;

/** Names of the flag bits set on a transaction, alphabetically; unknown bits as hex. */
export function flagNames(tx) {
  const flags = (Number(tx?.Flags) || 0) >>> 0;
  if (!flags) return [];
  const known = { ...FLAG_NAMES.universal, ...(FLAG_NAMES[tx?.TransactionType] ?? {}) };
  const names = [];
  let rest = flags;
  for (const [bit, name] of Object.entries(known)) {
    const b = Number(bit) >>> 0;
    if ((flags & b) !== 0) {
      names.push(name);
      rest &= ~b;
    }
  }
  for (let i = 0; i < 32; i++) if ((rest & (1 << i)) !== 0) names.push(`0x${(1 << i >>> 0).toString(16).padStart(8, '0')}`);
  return names.sort();
}

// ---------------------------------------------------------------------------
// Amounts, exactly
// ---------------------------------------------------------------------------

/**
 * An amount as recorded, with its value as an exact string.
 *   { currency: 'XRP', issuer: null, drops }                     integer drops
 *   { currency, code, issuer, value }                            issued; `code` is the 160-bit code when it is not 3 letters
 *   { currency: 'MPT', issuanceId, value }
 */
export function amountOf(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') return /^\d+$/.test(raw) ? { currency: 'XRP', issuer: null, drops: normalize(raw) } : null;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return { currency: 'XRP', issuer: null, drops: String(raw) };
  if (typeof raw === 'object') {
    let value;
    try {
      value = normalize(raw.value);
    } catch {
      return null;
    }
    if (typeof raw.mpt_issuance_id === 'string') return { currency: 'MPT', issuanceId: raw.mpt_issuance_id, value };
    if (typeof raw.currency === 'string') return { currency: decodeCurrency(raw.currency), code: raw.currency, issuer: raw.issuer ?? null, value };
  }
  return null;
}

/** 'XRP', 'CODE/issuer' or 'MPT/id': the same key for the same asset. */
export function amountKey(a) {
  if (!a) return null;
  if (a.currency === 'XRP') return 'XRP';
  if (a.issuanceId) return `MPT/${a.issuanceId}`;
  return `${a.code ?? a.currency}/${a.issuer}`;
}

export const valueOf = (a) => (a ? (a.drops ?? a.value) : null);
const withValue = (a, v) => (a.currency === 'XRP' && a.drops != null ? { ...a, drops: v } : { ...a, value: v });
const zeroOf = (a) => withValue(a, '0');
const addAmount = (a, b) => withValue(a, add(valueOf(a), valueOf(b)));

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

function unwrapNodes(meta) {
  const out = [];
  (meta?.AffectedNodes ?? []).forEach((raw, n) => {
    const wrapper = raw?.CreatedNode ? 'CreatedNode' : raw?.ModifiedNode ? 'ModifiedNode' : raw?.DeletedNode ? 'DeletedNode' : null;
    if (!wrapper) return;
    const e = raw[wrapper] ?? {};
    const fieldsKey = e.FinalFields ? 'FinalFields' : e.NewFields ? 'NewFields' : null;
    out.push({
      n,
      wrapper,
      action: wrapper === 'CreatedNode' ? 'created' : wrapper === 'ModifiedNode' ? 'modified' : 'deleted',
      entryType: e.LedgerEntryType ?? null,
      entryId: e.LedgerIndex ?? null,
      final: e[fieldsKey] ?? {},
      fieldsKey,
      prev: e.PreviousFields ?? null,
    });
  });
  return out;
}

/**
 * Every balance that moved, exact. XRP from AccountRoot entries (the fee
 * included), issued currencies from RippleState entries for both sides of
 * the line (the high account sees the negation).
 * @returns {{ account, currency, issuer, exact: { before, after, delta }, node, created?, deleted? }[]}
 */
export function balanceFacts(meta) {
  const out = [];
  for (const node of unwrapNodes(meta)) {
    const { final: f, prev } = node;
    if (node.entryType === 'AccountRoot') {
      const account = f.Account;
      if (!account) continue;
      let before;
      let after;
      if (node.action === 'created') {
        before = '0';
        after = normalize(f.Balance ?? '0');
      } else if (node.action === 'deleted') {
        before = normalize(f.Balance ?? '0');
        after = '0';
      } else if (prev?.Balance != null) {
        before = normalize(prev.Balance);
        after = normalize(f.Balance);
      } else continue;
      out.push({ account, currency: 'XRP', issuer: null, exact: { before, after, delta: sub(after, before) }, node: node.n, ...(node.action !== 'modified' ? { [node.action]: true } : {}) });
    } else if (node.entryType === 'RippleState') {
      const bal = f.Balance;
      const low = f.LowLimit?.issuer;
      const high = f.HighLimit?.issuer;
      if (!bal || !low || !high) continue;
      const after = node.action === 'deleted' ? '0' : normalize(bal.value);
      const before = node.action === 'created' ? '0' : prev?.Balance != null ? normalize(prev.Balance.value) : node.action === 'deleted' ? normalize(bal.value) : after;
      const delta = sub(after, before);
      if (isZero(delta) && node.action === 'modified') continue;
      const currency = decodeCurrency(bal.currency);
      const mark = node.action !== 'modified' ? { [node.action]: true } : {};
      out.push({ account: low, currency, issuer: high, exact: { before, after, delta }, node: node.n, ...mark });
      out.push({ account: high, currency, issuer: low, exact: { before: neg(before), after: neg(after), delta: neg(delta) }, node: node.n, ...mark });
    }
  }
  return out;
}

const neg = (v) => (isZero(v) ? '0' : v.startsWith('-') ? v.slice(1) : `-${v}`);

// ---------------------------------------------------------------------------
// The facts
// ---------------------------------------------------------------------------

/**
 * @param {object} tx    transaction fields (hash, ledger_index, date, Fee, Flags…)
 * @param {object} meta  its metadata (AffectedNodes, TransactionResult, delivered_amount)
 * @param {{ network?: string, closeTime?: number }} [options]  the network, and the ledger close time (Ripple seconds) for expiry
 */
export function facts(tx, meta, { network = 'unknown', closeTime = null } = {}) {
  const findings = [];
  let seq = 0;
  const note = (subject, property, value, rule, evidence = [], extra = {}) => {
    const spec = RULES[rule];
    if (!spec) throw new Error(`facts: unknown rule ${rule}`);
    const f = { id: `f${++seq}`, subject, property, value, tier: spec.tier, rule, evidence, ...(extra.note ? { note: extra.note } : {}) };
    findings.push(f);
    return f;
  };
  const out = {
    version: FACTS_VERSION,
    network,
    hash: tx?.hash ?? null,
    ledgerIndex: tx?.ledger_index ?? null,
    transaction: { type: tx?.TransactionType ?? null, account: tx?.Account ?? null, sequence: tx?.Sequence ?? null, result: meta?.TransactionResult ?? null, fee: tx?.Fee != null ? normalize(tx.Fee) : null, flags: [] },
    nodes: [],
    offers: [],
    exchange: null,
    balances: [],
    findings,
  };
  if (!tx || typeof tx !== 'object') return out;

  const close = Number.isFinite(Number(closeTime)) && closeTime != null ? Number(closeTime) : Number.isFinite(Number(tx.date)) && tx.date != null ? Number(tx.date) : null;
  out.transaction.flags = flagNames(tx);
  if (tx.Flags) note('transaction', 'flags', out.transaction.flags, 'transaction.flags', [{ field: 'tx.Flags', value: tx.Flags }]);
  if (meta?.TransactionResult) {
    const code = meta.TransactionResult;
    note('transaction', 'result', { code, family: code.slice(0, 3) }, 'result', [{ field: 'meta.TransactionResult', value: code }]);
  }

  const nodes = unwrapNodes(meta);
  out.nodes = nodes.map((n) => ({ n: n.n, action: n.action, entryType: n.entryType, entryId: n.entryId }));

  // balances
  out.balances = balanceFacts(meta);
  for (const b of out.balances) {
    note(`balance:${b.account}/${b.currency}${b.issuer ? `/${b.issuer}` : ''}`, 'delta', b.exact, b.currency === 'XRP' ? 'balance.xrp' : 'balance.issued', [{ node: b.node, field: b.currency === 'XRP' ? 'Balance' : 'Balance.value', value: b.exact.after }]);
  }

  const ctx = { tx, type: tx.TransactionType, submitter: tx.Account ?? null, offerSequence: tx.OfferSequence ?? null, close, note };
  out.offers = nodes.filter((n) => n.entryType === 'Offer').map((n) => offerFacts(n, ctx));

  if (tx.TransactionType === 'OfferCreate') out.exchange = offerCreateExchange(ctx, out.offers, out.balances, nodes, meta);
  else if (tx.TransactionType === 'Payment') out.exchange = paymentExchange(ctx, out.offers, out.balances, nodes, meta);
  return out;
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

function offerFacts(node, ctx) {
  const { n, final: f, prev, fieldsKey, action } = node;
  const subject = `offer:${n}`;
  const rules = new Set();
  const ids = [];
  const say = (property, value, rule, evidence, extra) => {
    const x = ctx.note(subject, property, value, rule, evidence, extra);
    rules.add(rule);
    ids.push(x.id);
    return x;
  };
  const ev = (field, value) => ({ node: n, field, value });

  say('action', action, 'node.action', [ev(node.wrapper, node.entryType)]);
  const owner = f.Account ?? null;
  const sequence = f.Sequence ?? null;
  const expiration = f.Expiration ?? null;
  const sell = hasFlag(f.Flags, LSF_SELL);
  say('identity', { owner, sequence, expiration, sell }, 'offer.identity', [ev(`${fieldsKey}.Account`, owner), ev(`${fieldsKey}.Sequence`, sequence), ...(expiration != null ? [ev(`${fieldsKey}.Expiration`, expiration)] : []), ev(`${fieldsKey}.Flags`, f.Flags ?? 0)]);

  const getsAfter = amountOf(f.TakerGets);
  const paysAfter = amountOf(f.TakerPays);
  say('amounts.after', { takerGets: getsAfter, takerPays: paysAfter }, 'offer.amounts.after', [ev(`${fieldsKey}.TakerGets`, f.TakerGets), ev(`${fieldsKey}.TakerPays`, f.TakerPays)]);
  const prevGets = prev && 'TakerGets' in prev ? amountOf(prev.TakerGets) : null;
  const prevPays = prev && 'TakerPays' in prev ? amountOf(prev.TakerPays) : null;
  let traded;
  let getsBefore = getsAfter;
  let paysBefore = paysAfter;
  if (prevGets && prevPays) {
    traded = 'yes';
    getsBefore = prevGets;
    paysBefore = prevPays;
    say('amounts.before', { takerGets: getsBefore, takerPays: paysBefore }, 'offer.amounts.before', [ev('PreviousFields.TakerGets', prev.TakerGets), ev('PreviousFields.TakerPays', prev.TakerPays)]);
  } else if (prevGets || prevPays) {
    traded = 'unresolved';
    say('amounts.before', 'unresolved', 'offer.amounts.before', [ev(prevGets ? 'PreviousFields.TakerGets' : 'PreviousFields.TakerPays', prevGets ? prev.TakerGets : prev.TakerPays)], { note: 'PreviousFields carries one amount but not the other; no validated record has this shape.' });
  } else {
    traded = 'no';
    say('amounts.before', { takerGets: getsBefore, takerPays: paysBefore }, 'offer.amounts.before.unchanged', [ev('PreviousFields', prev ? Object.keys(prev) : null)]);
  }
  say('traded', traded, 'offer.trade.previous-fields', [ev('PreviousFields', prev ? Object.keys(prev) : null)]);

  let tradedAmounts = null;
  if (traded === 'yes') {
    const sameGets = amountKey(getsBefore) === amountKey(getsAfter);
    const samePays = amountKey(paysBefore) === amountKey(paysAfter);
    if (sameGets && samePays && getsAfter && paysAfter) {
      tradedAmounts = { gave: withValue(getsAfter, sub(valueOf(getsBefore), valueOf(getsAfter))), got: withValue(paysAfter, sub(valueOf(paysBefore), valueOf(paysAfter))) };
      say('tradedAmounts', tradedAmounts, 'offer.trade.delta', [ev('PreviousFields.TakerGets', prev.TakerGets), ev(`${fieldsKey}.TakerGets`, f.TakerGets), ev('PreviousFields.TakerPays', prev.TakerPays), ev(`${fieldsKey}.TakerPays`, f.TakerPays)]);
    } else {
      traded = 'unresolved';
      say('tradedAmounts', 'unresolved', 'offer.trade.delta', [ev('PreviousFields', Object.keys(prev))], { note: 'The amounts before and after are not in the same currency.' });
    }
  }

  const own = owner != null && owner === ctx.submitter;
  const role = own ? (action === 'created' ? 'submitter-new' : 'submitter-old') : 'book';
  say('role', role, 'offer.role', [ev(`${fieldsKey}.Account`, owner), { field: 'tx.Account', value: ctx.submitter }]);

  const o = { node: n, entryId: node.entryId, action, owner, sequence, expiration, sell, role, traded, amounts: { takerGets: { before: getsBefore, after: getsAfter }, takerPays: { before: paysBefore, after: paysAfter } }, tradedAmounts, removal: null, expired: null, rules: [], findings: ids };

  if (action === 'created') {
    if (role === 'submitter-new') say('placed', { takerGets: getsAfter, takerPays: paysAfter }, 'offer.placed', [ev('CreatedNode', 'Offer'), ev('NewFields.Account', owner)]);
  } else if (action === 'modified') {
    if (traded === 'yes') say('consumption', 'partly consumed', 'offer.modified.partial', [ev('PreviousFields.TakerGets', prev.TakerGets), ev(`${fieldsKey}.TakerGets`, f.TakerGets)]);
    else if (traded === 'no') say('consumption', 'updated without trading', 'offer.modified.other', [ev('PreviousFields', prev ? Object.keys(prev) : null)]);
  } else {
    const r = removalOf(o, ctx, node);
    o.removal = r.value;
    say('removal', r.value, r.rule, r.evidence, r.note ? { note: r.note } : {});
    if (r.value === 'cleanup-without-trade') {
      const x = expiredOf(o, ctx, node);
      o.expired = x.value;
      say('expired', x.value, 'offer.expired', x.evidence, x.note ? { note: x.note } : {});
    }
  }
  o.rules = [...rules];
  return o;
}

function removalOf(o, ctx, node) {
  const ev = (field, value) => ({ node: node.n, field, value });
  const txEv = (field, value) => ({ field, value });
  const isCreate = ctx.type === 'OfferCreate';
  const isCancel = ctx.type === 'OfferCancel';
  const own = o.role !== 'book';
  const named = ctx.offerSequence != null && o.sequence === ctx.offerSequence;
  const base = [ev(`${node.fieldsKey}.Account`, o.owner), txEv('tx.Account', ctx.submitter), txEv('tx.TransactionType', ctx.type)];
  if (o.traded === 'unresolved') return { value: 'unresolved', rule: 'offer.removal.unresolved', evidence: [ev('PreviousFields', node.prev ? Object.keys(node.prev) : null)], note: 'Whether it traded cannot be read from a one-sided PreviousFields.' };
  if (isCancel && own && named && o.traded === 'no') return { value: 'cancelled', rule: 'offer.removal.cancelled', evidence: [...base, ev(`${node.fieldsKey}.Sequence`, o.sequence), txEv('tx.OfferSequence', ctx.offerSequence), ev('PreviousFields', null)] };
  if (isCreate && own && named && o.traded === 'no') return { value: 'replaced', rule: 'offer.removal.replaced', evidence: [...base, ev(`${node.fieldsKey}.Sequence`, o.sequence), txEv('tx.OfferSequence', ctx.offerSequence), ev('PreviousFields', null)] };
  if (isCreate && own && !named && o.traded === 'no') {
    const req = { gets: amountOf(ctx.tx.TakerGets), pays: amountOf(ctx.tx.TakerPays) };
    const opposite = req.gets && req.pays && amountKey(o.amounts.takerGets.after) === amountKey(req.pays) && amountKey(o.amounts.takerPays.after) === amountKey(req.gets);
    return { value: 'self-cross', rule: 'offer.removal.self-cross', evidence: [...base, ev(`${node.fieldsKey}.Sequence`, o.sequence), txEv('tx.OfferSequence', ctx.offerSequence), ev('PreviousFields', null), ev(`${node.fieldsKey}.TakerGets`, node.final.TakerGets), txEv('tx.TakerPays', ctx.tx.TakerPays)], note: opposite ? 'It was on the opposite side of the same book as the new offer.' : 'It was not on the opposite side of the new offer’s book; the removal is recorded, its cause is not.' };
  }
  if (o.traded === 'yes') {
    if (own && isCreate) return { value: 'unresolved', rule: 'offer.removal.unresolved', evidence: [...base, ev('PreviousFields.TakerGets', node.prev.TakerGets)], note: 'The submitter’s own offer is recorded as traded; no validated record has shown this.' };
    const getsZero = isZero(valueOf(o.amounts.takerGets.after));
    const paysZero = isZero(valueOf(o.amounts.takerPays.after));
    const amounts = [ev(`${node.fieldsKey}.TakerGets`, node.final.TakerGets), ev(`${node.fieldsKey}.TakerPays`, node.final.TakerPays), ev('PreviousFields.TakerGets', node.prev.TakerGets), ev('PreviousFields.TakerPays', node.prev.TakerPays)];
    if (getsZero && paysZero) return { value: 'consumed', rule: 'offer.removal.consumed', evidence: amounts };
    if (!getsZero && !paysZero) return { value: 'traded-then-removed-unfunded', rule: 'offer.removal.traded-unfunded', evidence: amounts, note: 'It gave what its owner held and the remainder left the book.' };
    return { value: 'unresolved', rule: 'offer.removal.unresolved', evidence: amounts, note: 'One final amount is zero and the other is not.' };
  }
  if (ctx.type === 'AccountDelete' && own) return { value: 'unresolved', rule: 'offer.removal.unresolved', evidence: base, note: 'The account was deleted; the offer went with it.' };
  if (o.traded === 'no' && (!own || !(isCreate || isCancel))) {
    return { value: 'cleanup-without-trade', rule: 'offer.removal.cleanup', evidence: [...base, ev('PreviousFields', null), ...(ctx.offerSequence != null ? [txEv('tx.OfferSequence', ctx.offerSequence)] : [])], note: own ? 'The submitter’s own offer, removed by a transaction that could not cancel it.' : undefined };
  }
  return { value: 'unresolved', rule: 'offer.removal.unresolved', evidence: base };
}

function expiredOf(o, ctx, node) {
  const ev = (field, value) => ({ node: node.n, field, value });
  if (o.expiration == null) return { value: 'no', evidence: [ev(node.fieldsKey, 'no Expiration')], note: 'The entry carries no expiration.' };
  const evidence = [ev(`${node.fieldsKey}.Expiration`, o.expiration), { field: 'tx.date', value: ctx.close }];
  if (ctx.close == null) return { value: 'unknown', evidence, note: 'No ledger close time to compare with.' };
  return { value: Number(o.expiration) <= ctx.close ? 'yes' : 'no', evidence, note: 'rippled judges expiry against the parent ledger’s close time, which the record does not carry.' };
}

// ---------------------------------------------------------------------------
// The exchange: what the submitter got and gave
// ---------------------------------------------------------------------------

/** Sum per currency key of a side of the crossed offers' deltas. */
function sumBy(amounts) {
  const map = new Map();
  for (const a of amounts) {
    const k = amountKey(a);
    map.set(k, map.has(k) ? addAmount(map.get(k), a) : a);
  }
  return map;
}

const mapToObject = (map) => Object.fromEntries([...map.entries()]);

function poolsOf(nodes) {
  return nodes.filter((n) => n.entryType === 'AccountRoot' && n.action === 'modified' && n.final.AMMID != null && n.final.Account).map((n) => ({ node: n.n, account: n.final.Account, ammId: n.final.AMMID }));
}

/** The net delta of one account in one asset, from the balance facts; null when no entry moved. */
function ownDelta(balances, account, asset) {
  let total = null;
  const figures = [];
  for (const b of balances) {
    if (b.account !== account) continue;
    const match = asset.currency === 'XRP' ? b.currency === 'XRP' : b.currency !== 'XRP' && b.currency === asset.currency && (b.issuer === asset.issuer || account === asset.issuer);
    if (!match) continue;
    total = total == null ? b.exact.delta : add(total, b.exact.delta);
    figures.push(b.exact.before, b.exact.after);
  }
  return { total, figures };
}

/** Issuers named anywhere in the request or the offers, so a line's counterparty can be told from a trading account. */
function knownIssuers(tx, meta, offers) {
  const set = new Set();
  const take = (a) => {
    if (a && typeof a === 'object' && a.issuer) set.add(a.issuer);
  };
  for (const k of ['TakerGets', 'TakerPays', 'Amount', 'DeliverMax', 'SendMax', 'LimitAmount']) take(tx[k]);
  take(meta?.delivered_amount);
  for (const o of offers) {
    for (const side of ['takerGets', 'takerPays']) {
      const a = o.amounts[side].after;
      if (a?.issuer) set.add(a.issuer);
    }
  }
  return set;
}

/** Accounts whose balances moved in two or more currencies without owning any offer here: AMM-shaped, unconfirmed. */
function suspectedPools(ctx, offers, balances, meta) {
  const exclude = new Set([ctx.submitter, ctx.tx.Destination, ...offers.map((o) => o.owner), ...knownIssuers(ctx.tx, meta, offers)]);
  const byAccount = new Map();
  for (const b of balances) {
    if (exclude.has(b.account)) continue;
    if (!byAccount.has(b.account)) byAccount.set(b.account, new Set());
    byAccount.get(b.account).add(b.currency);
  }
  return [...byAccount.entries()].filter(([, currencies]) => currencies.size >= 2).map(([account]) => account);
}

function ammLeg(pools, balances, gets, pays) {
  let received = pays ? zeroOf(pays) : null;
  let spent = gets ? zeroOf(gets) : null;
  const figures = [];
  for (const p of pools) {
    if (pays) {
      const d = ownDelta(balances, p.account, pays);
      if (d.total != null) {
        received = withValue(received, sub(valueOf(received), d.total));
        figures.push(...d.figures);
      }
    }
    if (gets) {
      const d = ownDelta(balances, p.account, gets);
      if (d.total != null) {
        spent = withValue(spent, add(valueOf(spent), d.total));
        figures.push(...d.figures);
      }
    }
  }
  return { received, spent, figures };
}

function offerCreateExchange(ctx, offers, balances, nodes, meta) {
  const { tx } = ctx;
  const subject = 'exchange';
  const rules = new Set();
  const ids = [];
  const say = (property, value, rule, evidence = [], extra) => {
    const x = ctx.note(subject, property, value, rule, evidence, extra);
    rules.add(rule);
    ids.push(x.id);
    return x;
  };
  const gets = amountOf(tx.TakerGets);
  const pays = amountOf(tx.TakerPays);
  const flags = { sell: hasFlag(tx.Flags, OFFER_FLAGS.SELL), immediateOrCancel: hasFlag(tx.Flags, OFFER_FLAGS.IOC), fillOrKill: hasFlag(tx.Flags, OFFER_FLAGS.FOK), passive: hasFlag(tx.Flags, OFFER_FLAGS.PASSIVE) };
  const request = { takerGets: gets, takerPays: pays, ...flags };
  say('request', request, 'exchange.request', [{ field: 'tx.TakerGets', value: tx.TakerGets }, { field: 'tx.TakerPays', value: tx.TakerPays }, { field: 'tx.Flags', value: tx.Flags ?? 0 }]);
  const ex = { request, book: { crossed: [], received: {}, spent: {}, bridged: 'no' }, amm: null, received: null, spent: null, fill: null, corroboration: null, rules: [], findings: ids };
  const failed = ctx.tx && meta?.TransactionResult && meta.TransactionResult !== 'tesSUCCESS';
  if (!gets || !pays) {
    ex.fill = { status: 'unresolved', judgedBy: null, requested: null, achieved: null, placed: false, remainder: null };
    say('fill', 'unresolved', 'exchange.fill', [], { note: 'The request amounts could not be read.' });
    ex.rules = [...rules];
    return ex;
  }
  if (failed) {
    ex.fill = { status: 'none', judgedBy: flags.sell ? 'takerGets-spent' : 'takerPays-received', requested: flags.sell ? gets : pays, achieved: flags.sell ? zeroOf(gets) : zeroOf(pays), placed: false, remainder: null };
    say('fill', 'none', 'exchange.fill', [{ field: 'meta.TransactionResult', value: meta.TransactionResult }], { note: 'The transaction failed; nothing traded and nothing was placed.' });
    if (flags.fillOrKill) say('fill.fillOrKill', 'all or nothing', 'exchange.fill.fok', [{ field: 'tx.Flags', value: tx.Flags }]);
    if (flags.immediateOrCancel) say('fill.immediateOrCancel', 'not placed by design', 'exchange.fill.ioc', [{ field: 'tx.Flags', value: tx.Flags }]);
    ex.rules = [...rules];
    return ex;
  }

  // the book
  const crossed = offers.filter((o) => o.traded === 'yes' && o.role === 'book');
  const unresolvedTrade = offers.some((o) => o.traded === 'unresolved');
  const bookReceived = sumBy(crossed.map((o) => o.tradedAmounts.gave));
  const bookSpent = sumBy(crossed.map((o) => o.tradedAmounts.got));
  ex.book.crossed = crossed.map((o) => o.node);
  ex.book.received = mapToObject(bookReceived);
  ex.book.spent = mapToObject(bookSpent);
  say('book', { crossed: ex.book.crossed, received: ex.book.received, spent: ex.book.spent }, 'exchange.book', crossed.map((o) => ({ node: o.node, field: 'PreviousFields.TakerGets', value: o.amounts.takerGets.before })));
  const getsKey = amountKey(gets);
  const paysKey = amountKey(pays);
  const bridgedOffers = crossed.filter((o) => amountKey(o.tradedAmounts.gave) !== paysKey || amountKey(o.tradedAmounts.got) !== getsKey);
  if (bridgedOffers.length) {
    ex.book.bridged = 'yes';
    const xrpIn = bookReceived.get('XRP');
    const xrpOut = bookSpent.get('XRP');
    const balanced = xrpIn && xrpOut && cmp(valueOf(xrpIn), valueOf(xrpOut)) === 0;
    say('book.bridged', 'yes', 'exchange.bridged', bridgedOffers.map((o) => ({ node: o.node, field: 'FinalFields.TakerGets', value: o.amounts.takerGets.after })), { note: balanced ? `The XRP legs net out: ${valueOf(xrpIn)} drops received from one book and spent on the other.` : 'The XRP legs do not net out exactly.' });
  }

  // the pool
  const pools = poolsOf(nodes);
  let ammFigures = [];
  if (pools.length) {
    const leg = ammLeg(pools, balances, gets, pays);
    ammFigures = leg.figures;
    ex.amm = { tier: 'rule', pools: pools.map((p) => p.account), ammIds: pools.map((p) => p.ammId), received: leg.received, spent: leg.spent };
    say('amm', { pools: ex.amm.pools, received: leg.received, spent: leg.spent }, 'exchange.amm', pools.map((p) => ({ node: p.node, field: 'FinalFields.AMMID', value: p.ammId })));
  } else {
    const suspects = suspectedPools(ctx, offers, balances, meta);
    if (suspects.length) {
      ex.amm = { tier: 'hypothesis', pools: suspects, received: null, spent: null };
      say('amm', { suspected: suspects }, 'exchange.amm.suspected', balances.filter((b) => suspects.includes(b.account)).map((b) => ({ node: b.node, field: 'Balance', value: b.exact.delta })), { note: 'Its AccountRoot is not in the record, so AMMID cannot be checked; the pool’s leg is not counted in the totals. Reading that AccountRoot would settle it.' });
    }
  }

  // totals
  const received = addAmount(bookReceived.get(paysKey) ?? zeroOf(pays), ex.amm?.received ?? zeroOf(pays));
  const spent = addAmount(bookSpent.get(getsKey) ?? zeroOf(gets), ex.amm?.spent ?? zeroOf(gets));
  ex.received = received;
  ex.spent = spent;
  say('received', received, 'exchange.received', [{ field: 'book.received', value: ex.book.received[paysKey] ?? null }, { field: 'amm.received', value: ex.amm?.received ?? null }]);
  say('spent', spent, 'exchange.spent', [{ field: 'book.spent', value: ex.book.spent[getsKey] ?? null }, { field: 'amm.spent', value: ex.amm?.spent ?? null }]);

  // fill
  const judgedBy = flags.sell ? 'takerGets-spent' : 'takerPays-received';
  const requested = flags.sell ? gets : pays;
  const achieved = flags.sell ? spent : received;
  const placedOffer = offers.find((o) => o.role === 'submitter-new') ?? null;
  const fill = { status: 'unresolved', judgedBy, requested, achieved, shortfall: null, placed: Boolean(placedOffer), remainder: placedOffer ? placedOffer.amounts.takerGets.after && { takerGets: placedOffer.amounts.takerGets.after, takerPays: placedOffer.amounts.takerPays.after } : null, betterThanAsked: 'no' };
  let fillNote;
  let rounding = false;
  if (unresolvedTrade) fillNote = 'An offer’s trade could not be read, so the totals are incomplete.';
  else if (isZero(valueOf(achieved))) fill.status = 'none';
  else {
    const shortfall = sub(valueOf(requested), valueOf(achieved));
    fill.shortfall = withValue(requested, shortfall);
    if (cmp(shortfall, '0') <= 0) fill.status = 'filled';
    else if (cmp(mulInt(shortfall, 10000000000), valueOf(requested)) < 0) {
      fill.status = 'filled';
      rounding = true;
    } else fill.status = 'partial';
  }
  if (fill.status === 'filled' && placedOffer) {
    fill.status = 'unresolved';
    fillNote = 'The request reads as filled, yet a remainder was placed on the book.';
  }
  if (fill.status === 'partial' && flags.fillOrKill) {
    fill.status = 'unresolved';
    fillNote = 'Fill-or-kill succeeded but the totals fall short of the request.';
  }
  if (fill.status === 'filled' || fill.status === 'partial') {
    fill.betterThanAsked = flags.sell ? (cmp(valueOf(received), valueOf(pays)) > 0 ? 'yes' : 'no') : fill.status === 'filled' && cmp(valueOf(spent), valueOf(gets)) < 0 ? 'yes' : 'no';
  }
  ex.fill = fill;
  say('fill', { status: fill.status, judgedBy, requested, achieved, shortfall: fill.shortfall, placed: fill.placed, betterThanAsked: fill.betterThanAsked }, 'exchange.fill', [{ field: flags.sell ? 'tx.TakerGets' : 'tx.TakerPays', value: valueOf(requested) }, { field: flags.sell ? 'exchange.spent' : 'exchange.received', value: valueOf(achieved) }, ...(placedOffer ? [{ node: placedOffer.node, field: 'CreatedNode', value: 'Offer' }] : [])], fillNote ? { note: fillNote } : {});
  if (rounding) say('fill.rounding', 'filled within rounding', 'exchange.fill.rounding', [{ field: 'shortfall', value: valueOf(fill.shortfall) }]);
  if (flags.immediateOrCancel) say('fill.immediateOrCancel', 'not placed by design', 'exchange.fill.ioc', [{ field: 'tx.Flags', value: tx.Flags }]);
  if (flags.fillOrKill) say('fill.fillOrKill', 'all or nothing', 'exchange.fill.fok', [{ field: 'tx.Flags', value: tx.Flags }]);

  // corroboration from the submitter's own balances
  const fee = out_fee(tx);
  const crossedFigures = crossed.flatMap((o) => [valueOf(o.amounts.takerGets.before), valueOf(o.amounts.takerGets.after), valueOf(o.amounts.takerPays.before), valueOf(o.amounts.takerPays.after)]);
  const side = (asset, expectedDelta, spending) => {
    const own = ownDelta(balances, ctx.submitter, asset);
    if (asset.currency === 'XRP') {
      const expected = sub(expectedDelta, fee);
      if (own.total == null) return { status: isZero(expected) ? 'exact' : 'unavailable', own: own.total, expected };
      return { status: cmp(own.total, expected) === 0 ? 'exact' : 'mismatch', own: own.total, expected };
    }
    const actual = own.total ?? '0';
    if (nearlyEqual(actual, expectedDelta, { operands: [...own.figures, ...crossedFigures, ...ammFigures] })) return { status: 'exact', own: actual, expected: expectedDelta };
    if (spending && isNegative(actual) && isNegative(expectedDelta) && divRatio(actual, expectedDelta).within) return { status: 'consistent-with-transfer-fee', own: actual, expected: expectedDelta };
    return { status: 'mismatch', own: actual, expected: expectedDelta };
  };
  const r = side(pays, valueOf(received), false);
  const s = side(gets, neg(valueOf(spent)), true);
  ex.corroboration = { received: r.status, spent: s.status };
  say('corroboration.received', r.status, 'exchange.corroboration.received', [{ field: 'balance.delta', value: r.own }, { field: 'expected', value: r.expected }]);
  say('corroboration.spent', s.status, 'exchange.corroboration.spent', [{ field: 'balance.delta', value: s.own }, { field: 'expected', value: s.expected }], s.status === 'consistent-with-transfer-fee' ? { note: 'More was debited than spent, by a factor between 1 and 2: the issuer’s transfer fee, which the record does not carry.' } : {});
  if (getsKey !== 'XRP' && paysKey !== 'XRP') {
    const own = ownDelta(balances, ctx.submitter, { currency: 'XRP' });
    const status = own.total == null ? (isZero(fee) ? 'exact' : 'unavailable') : cmp(own.total, neg(fee)) === 0 ? 'exact' : 'mismatch';
    ex.corroboration.fee = status;
    say('corroboration.fee', status, 'exchange.corroboration.fee', [{ field: 'balance.delta', value: own.total }, { field: 'tx.Fee', value: fee }]);
  }
  ex.rules = [...rules];
  return ex;
}

const out_fee = (tx) => (tx.Fee != null && /^\d+$/.test(String(tx.Fee)) ? normalize(tx.Fee) : '0');

function paymentExchange(ctx, offers, balances, nodes, meta) {
  const { tx } = ctx;
  const subject = 'exchange';
  const rules = new Set();
  const ids = [];
  const say = (property, value, rule, evidence = [], extra) => {
    const x = ctx.note(subject, property, value, rule, evidence, extra);
    rules.add(rule);
    ids.push(x.id);
    return x;
  };
  const deliveredRaw = meta?.delivered_amount ?? meta?.DeliveredAmount ?? null;
  const delivered = deliveredRaw === 'unavailable' ? 'unresolved' : amountOf(deliveredRaw);
  const request = { amount: amountOf(tx.DeliverMax ?? tx.Amount), sendMax: amountOf(tx.SendMax), delivered, partialPayment: hasFlag(tx.Flags, PAYMENT_FLAGS.PARTIAL), noRippleDirect: hasFlag(tx.Flags, PAYMENT_FLAGS.NO_RIPPLE_DIRECT), limitQuality: hasFlag(tx.Flags, PAYMENT_FLAGS.LIMIT_QUALITY) };
  if (deliveredRaw != null) say('delivered', delivered, 'payment.delivered', [{ field: 'meta.delivered_amount', value: deliveredRaw }], deliveredRaw === 'unavailable' ? { note: 'Old metadata (before 2014-01-20) does not record what was delivered.' } : {});
  const crossed = offers.filter((o) => o.traded === 'yes' && o.role === 'book');
  const bookReceived = sumBy(crossed.map((o) => o.tradedAmounts.gave));
  const bookSpent = sumBy(crossed.map((o) => o.tradedAmounts.got));
  const ex = { request, crossed: crossed.map((o) => o.node), book: { crossed: crossed.map((o) => o.node), received: mapToObject(bookReceived), spent: mapToObject(bookSpent) }, amm: null, spent: null, fill: null, rules: [], findings: ids };
  if (request.sendMax && ctx.submitter) {
    const own = ownDelta(balances, ctx.submitter, request.sendMax);
    if (own.total != null) {
      const paid = request.sendMax.currency === 'XRP' ? neg(add(own.total, out_fee(tx))) : neg(own.total);
      ex.spent = withValue(request.sendMax, paid);
      say('spent', ex.spent, 'payment.spent', [{ field: 'balance.delta', value: own.total }, { field: 'tx.SendMax', value: tx.SendMax }, ...(request.sendMax.currency === 'XRP' ? [{ field: 'tx.Fee', value: out_fee(tx) }] : [])]);
    }
  }
  say('crossed', { crossed: ex.crossed, received: ex.book.received, spent: ex.book.spent }, 'payment.crossed', crossed.map((o) => ({ node: o.node, field: 'PreviousFields.TakerGets', value: o.amounts.takerGets.before })));
  const pools = poolsOf(nodes);
  if (pools.length) {
    ex.amm = { tier: 'rule', pools: pools.map((p) => p.account), ammIds: pools.map((p) => p.ammId), received: null, spent: null };
    say('amm', { pools: ex.amm.pools }, 'exchange.amm', pools.map((p) => ({ node: p.node, field: 'FinalFields.AMMID', value: p.ammId })));
  } else {
    const suspects = suspectedPools(ctx, offers, balances, meta);
    if (suspects.length) {
      ex.amm = { tier: 'hypothesis', pools: suspects, received: null, spent: null };
      say('amm', { suspected: suspects }, 'exchange.amm.suspected', balances.filter((b) => suspects.includes(b.account)).map((b) => ({ node: b.node, field: 'Balance', value: b.exact.delta })), { note: 'Its AccountRoot is not in the record, so AMMID cannot be checked; an account rippling two currencies would look the same. Reading that AccountRoot would settle it.' });
    }
  }
  ex.rules = [...rules];
  return ex;
}

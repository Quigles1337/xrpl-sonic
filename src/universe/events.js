// UNIVERSE phase 1.5 — the event vocabulary: four verbs, then a detail.
//
// Every validated transaction the sky hears becomes one or more events, and
// every event has one of four verbs: travel (something moved between
// planets), dock (a standing relationship was made or changed), place
// (something was put on or taken from a book), happen (the account itself
// changed). A transaction that failed, or whose type has not earned a
// design, is a spark at the submitter's planet and never leaves it; a
// Batch wrapper is a tick with no body. Each event names its object (the
// thing drawn), the rule that earned it and the record fields it read, so
// an engineer can check the detail against the record and a screen reader
// can hear it (`describeEvent`). The objects, their verbs and the still
// marker each gets under reduced motion are the table OBJECTS; the
// specification is docs/universe.md, "Phase 1.5: the event vocabulary".
//
// Offers go through the facts layer (src/explorer/facts.js), so a rock, a
// flare, a blink and a crumble are its findings (placed, consumed,
// cancelled, cleanup), never a reading of the nodes made here twice.
//
// Pure: no DOM, no network.

import { parseAmount, formatAmount, decodeCurrency, shortAddress, categorize, CATEGORIES } from '../mapping.js';
import { facts } from '../explorer/facts.js';
import { decodeDomain } from '../explorer/anatomy.js';
import { rootsOf, linesOf, issuerOfLine, isAddress } from './records.js';

export const VERBS = Object.freeze(['travel', 'dock', 'place', 'happen']);

/** The flags the rules read. */
export const TF = Object.freeze({ innerBatch: 0x40000000, partialPayment: 0x00020000, setFreeze: 0x00100000, clearFreeze: 0x00200000, setDeepFreeze: 0x00400000, clearDeepFreeze: 0x00800000, setfAuth: 0x00010000, sellNFToken: 0x00000001 });
/** AccountSet flag numbers (asf*). */
export const ASF = Object.freeze({ requireDest: 1, requireAuth: 2, disallowXRP: 3, disableMaster: 4, accountTxnID: 5, noFreeze: 6, globalFreeze: 7, defaultRipple: 8, depositAuth: 9, authorizedNFTokenMinter: 10, disallowIncomingNFTokenOffer: 12, disallowIncomingCheck: 13, disallowIncomingPayChan: 14, disallowIncomingTrustline: 15, allowTrustLineClawback: 16 });
const ASF_NAMES = Object.freeze(Object.fromEntries(Object.entries(ASF).map(([k, v]) => [v, `asf${k[0].toUpperCase()}${k.slice(1)}`])));

/**
 * The objects of the sky: the verb each belongs to, what is drawn, what
 * stands still for it under reduced motion, and the rule that earns it.
 * The spark and the tick are not verbs: they are what an event is before it
 * has earned one.
 */
export const OBJECTS = Object.freeze({
  comet: { verb: 'travel', drawn: 'a comet from the sender’s planet to the receiver’s, size from the log of the amount, the photon’s tail', still: 'a line from sender to receiver with the head at the receiver', rule: 'travel.payment.direct' },
  'bent-comet': { verb: 'travel', drawn: 'a comet whose tail bends past each issuer star or pool it crossed, in order of the record', still: 'the bent line, still', rule: 'travel.payment.cross-currency' },
  partial: { verb: 'travel', drawn: 'a comet that arrives short of the receiver, labelled with what was delivered of what was asked', still: 'a line that stops short, with the label', rule: 'travel.payment.partial' },
  burn: { verb: 'travel', drawn: 'a loop out of the sender’s own planet through the book or pool and back', still: 'a ring around the planet', rule: 'travel.payment.self' },
  dust: { verb: 'travel', drawn: 'a faint, brief comet; several from one sender in a ledger are a meteor shower', still: 'a faint short line', rule: 'travel.payment.dust' },
  shower: { verb: 'travel', drawn: 'a meteor shower: the dust of one sender in one ledger, staggered', still: 'faint short lines', rule: 'travel.payment.shower' },
  'long-period': { verb: 'travel', drawn: 'a dotted comet leaving the sender, whose period is the escrow’s FinishAfter', still: 'a dotted line', rule: 'travel.escrow.create' },
  'long-period-arrive': { verb: 'travel', drawn: 'the dotted comet arriving at the destination on finish', still: 'a dotted line with the head at the destination', rule: 'travel.escrow.finish' },
  'long-period-return': { verb: 'travel', drawn: 'the dotted comet returning home on cancel', still: 'a dotted line with the head at home', rule: 'travel.escrow.cancel' },
  'check-drift': { verb: 'travel', drawn: 'a bead drifting into the destination’s orbit and waiting there', still: 'a bead in the destination’s orbit', rule: 'travel.check.create' },
  'check-cash': { verb: 'travel', drawn: 'the waiting bead cashed: it lands', still: 'the bead at the destination', rule: 'travel.check.cash' },
  'check-cancel': { verb: 'travel', drawn: 'the waiting bead blinks out', still: 'nothing', rule: 'travel.check.cancel' },
  'moon-capture': { verb: 'travel', drawn: 'a moon captured from the seller’s orbit into the buyer’s, via the broker if there was one', still: 'the moon at the buyer', rule: 'travel.nft.accept' },
  'reverse-comet': { verb: 'travel', drawn: 'a comet from the holder back to the issuer, in the issuer’s colour', still: 'a line from holder to issuer', rule: 'travel.clawback' },
  collapse: { verb: 'travel', drawn: 'the planet collapses and its last XRP leaves as a final comet', still: 'the struck-through planet and the line', rule: 'travel.account.delete' },
  beam: { verb: 'travel', drawn: 'a standing beam between the two planets of a payment channel', still: 'the beam', rule: 'travel.paychan.create' },
  'beam-fund': { verb: 'travel', drawn: 'the beam thickens', still: 'the thicker beam', rule: 'travel.paychan.fund' },
  'beam-pulse': { verb: 'travel', drawn: 'a pulse along the beam', still: 'a mark on the beam', rule: 'travel.paychan.claim' },
  rocket: { verb: 'dock', drawn: 'a dart launched by the submitter that docks into orbit around the issuer; it does not land', still: 'the dart at the issuer’s orbit', rule: 'dock.trustset' },
  deorbit: { verb: 'dock', drawn: 'a de-orbit burn: the dart leaves the issuer’s orbit and fades', still: 'a fading dart', rule: 'dock.trustset.zero' },
  freeze: { verb: 'dock', drawn: 'the orbit locks and changes colour, with no motion', still: 'the recoloured orbit', rule: 'dock.trustset.freeze' },
  beacon: { verb: 'dock', drawn: 'a docking beacon at the orbit', still: 'the beacon', rule: 'dock.trustset.auth' },
  gate: { verb: 'dock', drawn: 'a thin line to the one account allowed in', still: 'the line', rule: 'dock.depositpreauth' },
  ignite: { verb: 'dock', drawn: 'a planet whose dockings crossed the star threshold ignites into a star', still: 'the star', rule: 'dock.ignite' },
  rock: { verb: 'place', drawn: 'a rock set into the belt of its book at a radius set by price', still: 'the rock', rule: 'place.offer.placed' },
  fill: { verb: 'place', drawn: 'the taker’s comet crossing the belt', still: 'the crossing line', rule: 'place.offer.fill' },
  flare: { verb: 'place', drawn: 'a consumed rock flares out', still: 'nothing', rule: 'place.offer.consumed' },
  blink: { verb: 'place', drawn: 'a cancelled or replaced rock blinks out', still: 'nothing', rule: 'place.offer.cancelled' },
  crumble: { verb: 'place', drawn: 'a swept rock crumbles grey with no flash', still: 'a grey mark', rule: 'place.offer.swept' },
  'binary-form': { verb: 'place', drawn: 'a binary star forms', still: 'the binary', rule: 'place.amm.create' },
  'binary-brighten': { verb: 'place', drawn: 'the binary brightens', still: 'the brighter binary', rule: 'place.amm.deposit' },
  'binary-dim': { verb: 'place', drawn: 'the binary dims', still: 'the dimmer binary', rule: 'place.amm.withdraw' },
  satellite: { verb: 'place', drawn: 'a satellite captured for the auction slot’s duration', still: 'the satellite', rule: 'place.amm.bid' },
  'binary-collapse': { verb: 'place', drawn: 'the binary collapses', still: 'the struck-through binary', rule: 'place.amm.delete' },
  ring: { verb: 'happen', drawn: 'a ring of light around the planet', still: 'the ring', rule: 'happen.accountset' },
  nameplate: { verb: 'happen', drawn: 'a ring of light and the nameplate the Domain gives', still: 'the nameplate', rule: 'happen.accountset.domain' },
  darken: { verb: 'happen', drawn: 'the planet darkens toward a black hole candidate', still: 'the darkened planet', rule: 'happen.accountset.disablemaster' },
  tilt: { verb: 'happen', drawn: 'the planet’s axis tilts', still: 'the tilted axis', rule: 'happen.setregularkey' },
  guardians: { verb: 'happen', drawn: 'guardian moons locked into a ring, the quorum lit', still: 'the ring of moons', rule: 'happen.signerlistset' },
  shimmer: { verb: 'happen', drawn: 'a faint shimmer', still: 'a faint mark', rule: 'happen.ticketcreate' },
  'moon-form': { verb: 'happen', drawn: 'a moon forms in orbit', still: 'the moon', rule: 'happen.nft.mint' },
  'moon-crumble': { verb: 'happen', drawn: 'a moon crumbles', still: 'a grey mark', rule: 'happen.nft.burn' },
  'moon-beacon': { verb: 'happen', drawn: 'a beacon shows on a moon (an offer on it)', still: 'the beacon', rule: 'happen.nft.offer' },
  'moon-beacon-off': { verb: 'happen', drawn: 'the beacon on a moon goes out', still: 'nothing', rule: 'happen.nft.offer.cancel' },
  lighthouse: { verb: 'happen', drawn: 'a lighthouse beam at the oracle’s measured cadence', still: 'the beam, still', rule: 'happen.oracleset' },
  badge: { verb: 'happen', drawn: 'a badge on the planet', still: 'the badge', rule: 'happen.badge' },
  tick: { verb: null, drawn: 'a faint tick at the submitter: a Batch wrapper, no body; its inner transactions carry the weight', still: 'the tick', rule: 'batch.wrapper' },
  spark: { verb: null, drawn: 'a spark at the submitter’s planet that never leaves it: a failed transaction, or a type that has not earned a design', still: 'the spark', rule: 'spark' },
});
export const OBJECT_NAMES = Object.freeze(Object.keys(OBJECTS));

/** The share of the hour's transactions below which an unnamed type stays the spark (printed in docs/universe.md with the histogram). */
export const SPARK_THRESHOLD = 0.0001;

const nodesOf = (meta) => (meta?.AffectedNodes ?? []).map((raw, n) => {
  const action = raw.CreatedNode ? 'created' : raw.ModifiedNode ? 'modified' : 'deleted';
  const e = raw.CreatedNode ?? raw.ModifiedNode ?? raw.DeletedNode ?? {};
  return { n, action, type: e.LedgerEntryType, fields: e.FinalFields ?? e.NewFields ?? {}, previous: e.PreviousFields ?? null, e };
});
const fmt = (raw) => {
  const a = parseAmount(raw);
  return a ? formatAmount(a) : 'nothing';
};
const logOf = (raw) => {
  const a = parseAmount(raw);
  return a && a.value > 0 ? Math.log10(a.value) : null;
};
const currencyOf = (raw) => (typeof raw === 'string' ? 'XRP' : raw && typeof raw === 'object' ? decodeCurrency(raw.currency ?? '') : null);
const issuerOf = (raw) => (raw && typeof raw === 'object' && isAddress(raw.issuer) ? raw.issuer : null);
/** The book of an offer: the two sides as "CUR[/issuer]" strings, and its host body (the issuer of the issued side; both issuers for an issued/issued book). */
export function bookOf(takerGets, takerPays) {
  const side = (raw) => (typeof raw === 'string' ? { currency: 'XRP', issuer: null } : { currency: currencyOf(raw), issuer: issuerOf(raw) });
  const gets = side(takerGets);
  const pays = side(takerPays);
  const key = (s) => (s.issuer ? `${s.currency}/${s.issuer}` : s.currency);
  const hosts = [gets.issuer, pays.issuer].filter(Boolean);
  return { gets, pays, key: `${key(gets)}|${key(pays)}`, hosts, xrp: !gets.issuer || !pays.issuer };
}
/** The price of an offer as TakerPays per TakerGets, in the offer's own units. */
export function priceOf(takerGets, takerPays) {
  const g = parseAmount(takerGets);
  const p = parseAmount(takerPays);
  if (!g || !p || !(g.value > 0)) return null;
  return p.value / g.value;
}

/**
 * The events of one validated transaction. `result` is the engine result
 * (the stream's `engine_result`, or the metadata's TransactionResult).
 * @returns {object[]} events: { verb, object, category, from, to, via, at, hash, ledgerIndex, success, rule, evidence, detail, label }
 */
export function eventsOf(tx, meta, { hash = null, ledgerIndex = null, result = null, closeTime = null } = {}) {
  if (!tx || typeof tx?.TransactionType !== 'string') return [];
  const type = tx.TransactionType;
  const success = (result ?? meta?.TransactionResult) === 'tesSUCCESS';
  const category = categorize(type);
  const flags = (Number(tx.Flags) || 0) >>> 0;
  const base = { category, hash: typeof hash === 'string' ? hash.toUpperCase() : typeof tx.hash === 'string' ? tx.hash.toUpperCase() : null, ledgerIndex: Number.isInteger(Number(ledgerIndex)) ? Number(ledgerIndex) : null, success, type, inner: Boolean(flags & TF.innerBatch) };
  const ev = (object, more) => ({ ...base, verb: OBJECTS[object]?.verb ?? null, object, rule: OBJECTS[object]?.rule ?? 'spark', from: null, to: null, via: [], at: tx.Account ?? null, evidence: [], detail: {}, ...more });
  const out = [];
  const labelled = (list) => {
    for (const e of list) e.label = describeEvent(e);
    return list;
  };
  if (type === 'Batch') return labelled([ev('tick', { evidence: [{ field: 'RawTransactions', value: (tx.RawTransactions ?? []).length }], detail: { inner: (tx.RawTransactions ?? []).length } })]);
  if (!success) return labelled([ev('spark', { evidence: [{ field: 'meta.TransactionResult', value: meta?.TransactionResult ?? result ?? 'failed' }], detail: { result: meta?.TransactionResult ?? result ?? 'failed', type } })]);
  const nodes = nodesOf(meta);
  const roots = rootsOf(meta);
  const pools = roots.filter((r) => r.ammId).map((r) => r.address);
  const lines = linesOf(meta);

  switch (type) {
    case 'Payment': {
      const asked = tx.DeliverMax ?? tx.Amount;
      const delivered = meta?.delivered_amount ?? asked;
      const askedA = parseAmount(asked);
      const deliveredA = parseAmount(delivered);
      const from = tx.Account;
      const to = tx.Destination;
      const crossed = nodes.filter((n) => n.type === 'Offer' && n.fields.Account !== from && n.previous).map((n) => n.fields.Account);
      const issuers = [...new Set(lines.map((l) => issuerOfLine(l)?.issuer).filter((a) => a && a !== from && a !== to))];
      const via = [...new Set([...issuers, ...pools, ...crossed])];
      const crossCurrency = Boolean(tx.SendMax && askedA && (currencyOf(tx.SendMax) !== askedA.currency || issuerOf(tx.SendMax) !== (askedA.issuer ?? null))) || crossed.length > 0 || pools.length > 0 || (Array.isArray(tx.Paths) && tx.Paths.length > 0);
      const partial = Boolean(flags & TF.partialPayment) && askedA && deliveredA && deliveredA.value < askedA.value;
      const detail = { asked: fmt(asked), delivered: fmt(delivered), log: logOf(delivered), currency: deliveredA?.currency ?? null, issuer: deliveredA?.issuer ?? null, hops: via.length, born: roots.some((r) => r.action === 'created') };
      const evidence = [{ field: 'Account', value: from }, { field: 'Destination', value: to }, { field: 'meta.delivered_amount', value: typeof delivered === 'string' ? delivered : JSON.stringify(delivered) }];
      if (from === to) out.push(ev('burn', { from, to, via, evidence: [...evidence, { field: 'Account = Destination', value: 'a payment to self' }], detail }));
      else if (partial) out.push(ev('partial', { from, to, via, evidence: [...evidence, { field: 'Flags', value: 'tfPartialPayment' }, { field: 'DeliverMax', value: fmt(asked) }], detail }));
      else if (crossCurrency) out.push(ev('bent-comet', { from, to, via, evidence: [...evidence, { field: 'SendMax', value: tx.SendMax ? fmt(tx.SendMax) : 'none' }, { field: 'hops', value: via.join(', ') || 'none in the record' }], detail }));
      else if (deliveredA?.isXrp && deliveredA.value < 1) out.push(ev('dust', { from, to, evidence, detail }));
      else out.push(ev('comet', { from, to, evidence, detail }));
      // offers consumed on the way are place events too, from the facts layer
      if (crossed.length) out.push(...offerEvents(tx, meta, nodes, base, ev, { takerComet: false }));
      break;
    }
    case 'EscrowCreate':
      out.push(ev('long-period', { from: tx.Account, to: tx.Destination ?? tx.Account, evidence: [{ field: 'Amount', value: fmt(tx.Amount) }, { field: 'FinishAfter', value: tx.FinishAfter ?? 'none' }, { field: 'CancelAfter', value: tx.CancelAfter ?? 'none' }], detail: { amount: fmt(tx.Amount), finishAfter: tx.FinishAfter ?? null, cancelAfter: tx.CancelAfter ?? null, log: logOf(tx.Amount) } }));
      break;
    case 'EscrowFinish':
    case 'EscrowCancel': {
      const escrow = nodes.find((n) => n.type === 'Escrow' && n.action === 'deleted');
      const owner = escrow?.fields.Account ?? tx.Owner;
      const dest = escrow?.fields.Destination ?? owner;
      const finish = type === 'EscrowFinish';
      out.push(ev(finish ? 'long-period-arrive' : 'long-period-return', { from: owner, to: finish ? dest : owner, evidence: [{ field: 'Owner', value: owner }, { field: 'OfferSequence', value: tx.OfferSequence }, { field: 'Escrow.Amount', value: escrow ? fmt(escrow.fields.Amount) : 'not in the record' }], detail: { amount: escrow ? fmt(escrow.fields.Amount) : null, log: escrow ? logOf(escrow.fields.Amount) : null } }));
      break;
    }
    case 'CheckCreate':
      out.push(ev('check-drift', { from: tx.Account, to: tx.Destination, evidence: [{ field: 'SendMax', value: fmt(tx.SendMax) }, { field: 'Destination', value: tx.Destination }], detail: { sendMax: fmt(tx.SendMax), log: logOf(tx.SendMax) } }));
      break;
    case 'CheckCash':
    case 'CheckCancel': {
      const check = nodes.find((n) => n.type === 'Check' && n.action === 'deleted');
      const creator = check?.fields.Account ?? null;
      const dest = check?.fields.Destination ?? tx.Account;
      const cash = type === 'CheckCash';
      out.push(ev(cash ? 'check-cash' : 'check-cancel', { from: creator, to: dest, evidence: [{ field: 'CheckID', value: tx.CheckID }, { field: 'Check.Account', value: creator ?? 'not in the record' }, ...(cash ? [{ field: tx.Amount ? 'Amount' : 'DeliverMin', value: fmt(tx.Amount ?? tx.DeliverMin) }] : [])], detail: { amount: cash ? fmt(tx.Amount ?? tx.DeliverMin) : null, log: cash ? logOf(tx.Amount ?? tx.DeliverMin) : null } }));
      break;
    }
    case 'NFTokenAcceptOffer': {
      const offers = nodes.filter((n) => n.type === 'NFTokenOffer' && n.action === 'deleted');
      const sell = offers.find((n) => ((Number(n.fields.Flags) || 0) & TF.sellNFToken) !== 0);
      const buy = offers.find((n) => ((Number(n.fields.Flags) || 0) & TF.sellNFToken) === 0);
      const brokered = Boolean(tx.NFTokenSellOffer && tx.NFTokenBuyOffer);
      const seller = sell?.fields.Owner ?? (buy ? tx.Account : null);
      const buyer = buy?.fields.Owner ?? (sell ? tx.Account : null);
      out.push(ev('moon-capture', { from: seller, to: buyer, via: brokered ? [tx.Account] : [], evidence: [{ field: 'NFTokenSellOffer', value: tx.NFTokenSellOffer ?? 'none' }, { field: 'NFTokenBuyOffer', value: tx.NFTokenBuyOffer ?? 'none' }, { field: 'NFTokenOffer.Owner (sell)', value: sell?.fields.Owner ?? 'none' }, { field: 'NFTokenOffer.Owner (buy)', value: buy?.fields.Owner ?? 'none' }], detail: { brokered, nftokenId: sell?.fields.NFTokenID ?? buy?.fields.NFTokenID ?? null, amount: sell ? fmt(sell.fields.Amount) : buy ? fmt(buy.fields.Amount) : null } }));
      break;
    }
    case 'Clawback': {
      const holder = issuerOf(tx.Amount);
      out.push(ev('reverse-comet', { from: holder, to: tx.Account, evidence: [{ field: 'Amount.issuer (the holder)', value: holder }, { field: 'Amount', value: fmt(tx.Amount) }], detail: { amount: fmt(tx.Amount), log: logOf(tx.Amount), currency: currencyOf(tx.Amount) } }));
      break;
    }
    case 'AccountDelete': {
      const root = roots.find((r) => r.action === 'deleted');
      out.push(ev('collapse', { from: tx.Account, to: tx.Destination, evidence: [{ field: 'Destination', value: tx.Destination }, { field: 'AccountRoot (deleted) Balance', value: root?.balance != null ? `${root.balance} drops` : 'not in the record' }], detail: { lastXrp: root?.balance != null ? `${(root.balance / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} XRP` : null, log: root?.balance != null ? Math.log10(Math.max(1, root.balance / 1e6)) : null } }));
      break;
    }
    case 'PaymentChannelCreate':
      out.push(ev('beam', { from: tx.Account, to: tx.Destination, evidence: [{ field: 'Amount', value: fmt(tx.Amount) }, { field: 'Destination', value: tx.Destination }], detail: { amount: fmt(tx.Amount), log: logOf(tx.Amount) } }));
      break;
    case 'PaymentChannelFund':
    case 'PaymentChannelClaim': {
      const chan = nodes.find((n) => n.type === 'PayChannel');
      const fund = type === 'PaymentChannelFund';
      out.push(ev(fund ? 'beam-fund' : 'beam-pulse', { from: chan?.fields.Account ?? tx.Account, to: chan?.fields.Destination ?? null, evidence: [{ field: 'Channel', value: tx.Channel }, { field: fund ? 'Amount' : 'Balance', value: fmt(fund ? tx.Amount : tx.Balance ?? tx.Amount) }], detail: { amount: fmt(fund ? tx.Amount : tx.Balance ?? tx.Amount), closed: Boolean(flags & 0x00020000) } }));
      break;
    }
    case 'TrustSet': {
      const limit = parseAmount(tx.LimitAmount);
      const issuer = issuerOf(tx.LimitAmount);
      const line = lines[0] ?? null;
      const balance = line ? Math.abs(line.balance) : 0;
      const detail = { currency: limit?.currency ?? null, limit: limit ? limit.value : null, balance, issuer, deleted: Boolean(line && line.action === 'deleted') };
      const evidence = [{ field: 'LimitAmount', value: fmt(tx.LimitAmount) }, { field: 'RippleState.Balance', value: line ? String(line.balance) : 'not in the record' }];
      if (flags & (TF.setFreeze | TF.clearFreeze | TF.setDeepFreeze | TF.clearDeepFreeze)) {
        const set = Boolean(flags & (TF.setFreeze | TF.setDeepFreeze));
        out.push(ev('freeze', { from: tx.Account, to: issuer, evidence: [...evidence, { field: 'Flags', value: flags & TF.setDeepFreeze ? 'tfSetDeepFreeze' : flags & TF.setFreeze ? 'tfSetFreeze' : flags & TF.clearDeepFreeze ? 'tfClearDeepFreeze' : 'tfClearFreeze' }], detail: { ...detail, frozen: set } }));
      } else if (flags & TF.setfAuth) out.push(ev('beacon', { from: tx.Account, to: issuer, evidence: [...evidence, { field: 'Flags', value: 'tfSetfAuth' }], detail }));
      else if (limit && limit.value === 0) out.push(ev('deorbit', { from: tx.Account, to: issuer, evidence, detail }));
      else out.push(ev('rocket', { from: tx.Account, to: issuer, evidence, detail }));
      break;
    }
    case 'DepositPreauth':
      out.push(ev('gate', { from: tx.Account, to: tx.Authorize ?? tx.Unauthorize ?? null, evidence: [{ field: tx.Authorize ? 'Authorize' : 'Unauthorize', value: tx.Authorize ?? tx.Unauthorize ?? 'none' }], detail: { open: Boolean(tx.Authorize) } }));
      break;
    case 'OfferCreate':
      out.push(...offerEvents(tx, meta, nodes, base, ev, { takerComet: true }));
      break;
    case 'OfferCancel':
      out.push(...offerEvents(tx, meta, nodes, base, ev, { takerComet: false }));
      if (!out.length) out.push(ev('blink', { evidence: [{ field: 'OfferSequence', value: tx.OfferSequence }], detail: { sequence: tx.OfferSequence, found: false } }));
      break;
    case 'AMMCreate': {
      const pool = roots.find((r) => r.ammId && r.action === 'created') ?? roots.find((r) => r.ammId);
      out.push(ev('binary-form', { from: tx.Account, to: pool?.address ?? null, evidence: [{ field: 'Amount', value: fmt(tx.Amount) }, { field: 'Amount2', value: fmt(tx.Amount2) }, { field: 'AccountRoot.AMMID', value: pool?.ammId ?? 'not in the record' }], detail: { pair: `${currencyOf(tx.Amount)}/${currencyOf(tx.Amount2)}` } }));
      break;
    }
    case 'AMMDeposit':
    case 'AMMWithdraw':
    case 'AMMBid':
    case 'AMMDelete':
    case 'AMMVote': {
      const pool = roots.find((r) => r.ammId) ?? null;
      const object = { AMMDeposit: 'binary-brighten', AMMWithdraw: 'binary-dim', AMMBid: 'satellite', AMMDelete: 'binary-collapse', AMMVote: 'spark' }[type];
      const amm = nodes.find((n) => n.type === 'AMM');
      const slot = amm?.fields?.AuctionSlot ?? null;
      out.push(ev(object, { from: tx.Account, to: pool?.address ?? null, evidence: [{ field: 'Asset', value: `${currencyOf(tx.Asset ?? {})}` }, { field: 'Asset2', value: `${currencyOf(tx.Asset2 ?? {})}` }, { field: 'AccountRoot.AMMID', value: pool?.ammId ?? 'not in the record' }, ...(type === 'AMMBid' ? [{ field: 'AMM.AuctionSlot.Expiration', value: slot?.Expiration ?? 'none' }] : [])], detail: { pair: `${currencyOf(tx.Asset ?? {})}/${currencyOf(tx.Asset2 ?? {})}`, amount: tx.Amount ? fmt(tx.Amount) : null, expiration: slot?.Expiration ?? null, type } }));
      break;
    }
    case 'AccountSet': {
      const set = tx.SetFlag != null ? Number(tx.SetFlag) : null;
      const clear = tx.ClearFlag != null ? Number(tx.ClearFlag) : null;
      const domain = typeof tx.Domain === 'string' && tx.Domain ? decodeDomain(tx.Domain) : '';
      const evidence = [];
      if (set != null) evidence.push({ field: 'SetFlag', value: `${set} (${ASF_NAMES[set] ?? 'unknown'})` });
      if (clear != null) evidence.push({ field: 'ClearFlag', value: `${clear} (${ASF_NAMES[clear] ?? 'unknown'})` });
      if (tx.Domain != null) evidence.push({ field: 'Domain', value: tx.Domain });
      const detail = { setFlag: set, clearFlag: clear, flagName: set != null ? ASF_NAMES[set] ?? null : clear != null ? ASF_NAMES[clear] ?? null : null, domain: domain || null };
      if (set === ASF.disableMaster) out.push(ev('darken', { evidence, detail }));
      else if (domain) out.push(ev('nameplate', { evidence, detail }));
      else out.push(ev('ring', { evidence: evidence.length ? evidence : [{ field: 'fields', value: 'none that the sky reads' }], detail }));
      break;
    }
    case 'SetRegularKey':
      out.push(ev('tilt', { evidence: [{ field: 'RegularKey', value: tx.RegularKey ?? 'cleared' }], detail: { regularKey: tx.RegularKey ?? null } }));
      break;
    case 'SignerListSet':
      out.push(ev('guardians', { evidence: [{ field: 'SignerQuorum', value: tx.SignerQuorum ?? 0 }, { field: 'SignerEntries', value: (tx.SignerEntries ?? []).length }], detail: { quorum: tx.SignerQuorum ?? 0, signers: (tx.SignerEntries ?? []).map((s) => s?.SignerEntry?.Account).filter(isAddress), weights: (tx.SignerEntries ?? []).map((s) => s?.SignerEntry?.SignerWeight ?? 0), removed: !tx.SignerQuorum } }));
      break;
    case 'TicketCreate':
      out.push(ev('shimmer', { evidence: [{ field: 'TicketCount', value: tx.TicketCount ?? 1 }], detail: { count: tx.TicketCount ?? 1 } }));
      break;
    case 'NFTokenMint': {
      const page = nodes.find((n) => n.type === 'NFTokenPage');
      out.push(ev('moon-form', { evidence: [{ field: 'NFTokenTaxon', value: tx.NFTokenTaxon ?? 0 }, { field: 'Issuer', value: tx.Issuer ?? tx.Account }, { field: 'NFTokenPage', value: page ? page.action : 'not in the record' }], detail: { taxon: tx.NFTokenTaxon ?? 0, issuer: tx.Issuer ?? tx.Account, nftokenId: meta?.nftoken_id ?? null } }));
      break;
    }
    case 'NFTokenBurn':
      out.push(ev('moon-crumble', { at: tx.Owner ?? tx.Account, evidence: [{ field: 'NFTokenID', value: tx.NFTokenID }], detail: { nftokenId: tx.NFTokenID ?? null } }));
      break;
    case 'NFTokenCreateOffer':
      out.push(ev('moon-beacon', { to: tx.Destination ?? null, evidence: [{ field: 'NFTokenID', value: tx.NFTokenID }, { field: 'Amount', value: fmt(tx.Amount) }, { field: 'Flags', value: flags & TF.sellNFToken ? 'tfSellNFToken' : 'buy' }], detail: { sell: Boolean(flags & TF.sellNFToken), amount: fmt(tx.Amount), nftokenId: tx.NFTokenID ?? null, owner: tx.Owner ?? null } }));
      break;
    case 'NFTokenCancelOffer':
      out.push(ev('moon-beacon-off', { evidence: [{ field: 'NFTokenOffers', value: (tx.NFTokenOffers ?? []).length }], detail: { offers: (tx.NFTokenOffers ?? []).length } }));
      break;
    case 'OracleSet':
      out.push(ev('lighthouse', { evidence: [{ field: 'OracleDocumentID', value: tx.OracleDocumentID }, { field: 'PriceDataSeries', value: (tx.PriceDataSeries ?? []).length }, { field: 'LastUpdateTime', value: tx.LastUpdateTime ?? null }], detail: { documentId: tx.OracleDocumentID ?? null, series: (tx.PriceDataSeries ?? []).length, provider: tx.Provider ?? null, updatedAt: tx.LastUpdateTime ?? null } }));
      break;
    case 'DIDSet':
    case 'DIDDelete':
    case 'CredentialCreate':
    case 'CredentialAccept':
    case 'CredentialDelete':
    case 'MPTokenIssuanceCreate':
    case 'MPTokenIssuanceSet':
    case 'MPTokenIssuanceDestroy':
    case 'MPTokenAuthorize':
      out.push(ev('badge', { to: tx.Subject ?? tx.Holder ?? null, evidence: [{ field: 'TransactionType', value: type }], detail: { kind: type } }));
      break;
    default:
      out.push(ev('spark', { evidence: [{ field: 'TransactionType', value: type }], detail: { type, result: 'tesSUCCESS', reason: 'no design yet' } }));
  }
  return labelled(out);
}

/** The place events of a transaction that touched offers, from the facts layer: a rock placed, flares for consumed rocks, blinks for cancelled and replaced ones, crumbles for swept ones, and the taker's fill comet. */
function offerEvents(tx, meta, nodes, base, ev, { takerComet }) {
  const out = [];
  let fx;
  try {
    fx = facts(tx, meta);
  } catch {
    return out;
  }
  const bookFor = (o) => {
    const gets = o.amounts?.takerGets?.after ?? o.amounts?.takerGets?.before;
    const pays = o.amounts?.takerPays?.after ?? o.amounts?.takerPays?.before;
    const raw = (a) => (a ? (a.currency === 'XRP' ? a.drops ?? '0' : { currency: a.code ?? a.currency, issuer: a.issuer, value: a.value }) : null);
    return { book: bookOf(raw(gets), raw(pays)), price: priceOf(raw(gets), raw(pays)), gets: gets ? fmtExact(gets) : null, pays: pays ? fmtExact(pays) : null };
  };
  let consumed = 0;
  for (const o of fx.offers ?? []) {
    const b = bookFor(o);
    const common = { at: o.owner, from: o.owner, to: b.book.hosts[0] ?? null, via: b.book.hosts.slice(1), evidence: [{ node: o.node, field: 'Offer.Account', value: o.owner }, { node: o.node, field: 'Offer.Sequence', value: o.sequence }, { field: 'book', value: b.book.key }, { field: 'price', value: b.price != null ? b.price.toPrecision(6) : 'unresolved' }], detail: { book: b.book.key, hosts: b.book.hosts, xrp: b.book.xrp, price: b.price, sequence: o.sequence, owner: o.owner, gets: b.gets, pays: b.pays, role: o.role, removal: o.removal ?? null } };
    if (o.action === 'created' && o.role !== 'book') out.push(ev('rock', common));
    else if (o.removal === 'consumed' || o.removal === 'traded-unfunded' || (o.action === 'modified' && o.traded === 'yes' && o.role === 'book')) {
      consumed += 1;
      out.push(ev('flare', { ...common, evidence: [...common.evidence, { field: 'removal', value: o.removal ?? 'partly consumed' }] }));
    } else if (o.removal === 'cancelled' || o.removal === 'replaced' || o.removal === 'self-cross') out.push(ev('blink', { ...common, evidence: [...common.evidence, { field: 'removal', value: o.removal }] }));
    else if (o.removal === 'cleanup') out.push(ev('crumble', { ...common, evidence: [...common.evidence, { field: 'removal', value: 'cleanup: expired or unfunded, swept without trading' }] }));
  }
  if (takerComet && (consumed > 0 || fx.exchange?.amm)) {
    const req = fx.exchange?.request ?? null;
    const b = bookOf(tx.TakerGets, tx.TakerPays);
    out.unshift(ev('fill', { from: tx.Account, to: b.hosts[0] ?? null, via: b.hosts.slice(1), evidence: [{ field: 'TakerGets', value: fmt(tx.TakerGets) }, { field: 'TakerPays', value: fmt(tx.TakerPays) }, { field: 'exchange.fill', value: fx.exchange?.fill?.status ?? 'unresolved' }, { field: 'offers consumed', value: consumed }], detail: { book: b.key, hosts: b.hosts, xrp: b.xrp, consumed, status: fx.exchange?.fill?.status ?? null, amm: Boolean(fx.exchange?.amm), log: logOf(tx.TakerGets), requested: req ? null : null } }));
  }
  return out;
}

/** An exact facts-layer amount as text. */
function fmtExact(a) {
  if (!a) return 'nothing';
  if (a.currency === 'XRP') return `${(Number(a.drops) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} XRP`;
  return `${a.value} ${a.currency}`;
}

const who = (address, nameOf) => (address ? (nameOf ? nameOf(address) : shortAddress(address)) : 'nobody');

/**
 * The text equivalent of an event: "rocket: rA set a trust line to rB, 0 of
 * up to 1,000 USD". `nameOf(address)` gives the sky's name for an address
 * (the Domain, the cast label, or the short address); without it the short
 * address is used.
 */
export function describeEvent(e, nameOf = null) {
  if (!e) return '';
  const d = e.detail ?? {};
  const a = who(e.at ?? e.from, nameOf);
  const from = who(e.from, nameOf);
  const to = who(e.to, nameOf);
  const via = (e.via ?? []).map((v) => who(v, nameOf));
  const say = (text) => `${e.object}: ${text}`;
  switch (e.object) {
    case 'comet':
      return say(`${from} paid ${to} ${d.delivered}${d.born ? ', funding a new account' : ''}`);
    case 'bent-comet':
      return say(`${from} paid ${to} ${d.delivered} across ${d.hops} hop${d.hops === 1 ? '' : 's'}${via.length ? ` (${via.join(', ')})` : ''}`);
    case 'partial':
      return say(`${from} paid ${to}, delivered ${d.delivered} of up to ${d.asked}`);
    case 'burn':
      return say(`${from} paid itself ${d.delivered}${via.length ? ` through ${via.join(', ')}` : ''}`);
    case 'dust':
      return say(`${from} sent ${to} ${d.delivered}`);
    case 'shower':
      return say(`${from} sent ${d.count} payments under one XRP in ledger #${Number(e.ledgerIndex).toLocaleString('en-US')}`);
    case 'long-period':
      return say(`${from} escrowed ${d.amount} for ${to}${d.finishAfter != null ? `, returning at ripple time ${d.finishAfter}` : ''}`);
    case 'long-period-arrive':
      return say(`an escrow of ${d.amount ?? 'an amount not in the record'} from ${from} arrived at ${to}`);
    case 'long-period-return':
      return say(`an escrow of ${d.amount ?? 'an amount not in the record'} returned to ${from}`);
    case 'check-drift':
      return say(`${from} wrote ${to} a check for up to ${d.sendMax}`);
    case 'check-cash':
      return say(`${to} cashed a check from ${from} for ${d.amount}`);
    case 'check-cancel':
      return say(`a check from ${from} to ${to} was cancelled`);
    case 'moon-capture':
      return say(`a moon passed from ${from} to ${to}${d.brokered ? ` via ${via[0]}` : ''}${d.amount ? ` for ${d.amount}` : ''}`);
    case 'reverse-comet':
      return say(`${to} clawed back ${d.amount} from ${from}`);
    case 'collapse':
      return say(`${from} deleted its account, sending ${d.lastXrp ?? 'its last XRP'} to ${to}`);
    case 'beam':
      return say(`${from} opened a payment channel to ${to} with ${d.amount}`);
    case 'beam-fund':
      return say(`${from} funded its channel to ${to} with ${d.amount}`);
    case 'beam-pulse':
      return say(`a claim of ${d.amount} on the channel from ${from} to ${to}${d.closed ? ', closing it' : ''}`);
    case 'rocket':
      return say(`${from} set a trust line to ${to}, ${d.balance} of up to ${d.limit?.toLocaleString?.('en-US') ?? d.limit} ${d.currency}`);
    case 'deorbit':
      return say(`${from} set its trust line to ${to} to zero${d.deleted ? ' and the line is gone' : ''}`);
    case 'freeze':
      return say(`${from} ${d.frozen ? 'froze' : 'unfroze'} its trust line to ${to} (${d.currency})`);
    case 'beacon':
      return say(`${from} authorised ${to} to hold its ${d.currency}`);
    case 'gate':
      return say(`${from} ${d.open ? 'let' : 'no longer lets'} ${to} deposit`);
    case 'ignite':
      return say(`${a} became a star: ${d.holders} holders ≥ ${d.threshold}`);
    case 'rock':
      return say(`${from} placed an offer on ${d.book} at ${d.price != null ? d.price.toPrecision(4) : 'an unresolved price'}: ${d.gets} for ${d.pays}`);
    case 'fill':
      return say(`${from} took ${d.consumed} offer${d.consumed === 1 ? '' : 's'} on ${d.book}${d.amm ? ' and a pool' : ''} (${d.status ?? 'unresolved'})`);
    case 'flare':
      return say(`an offer of ${from} on ${d.book} was ${d.removal ?? 'partly consumed'}`);
    case 'blink':
      return say(d.found === false ? `${a} cancelled an offer the record did not carry` : `an offer of ${from} on ${d.book} was ${d.removal}`);
    case 'crumble':
      return say(`an offer of ${from} on ${d.book} was swept, expired or unfunded, with no trade`);
    case 'binary-form':
      return say(`${from} created a pool for ${d.pair}`);
    case 'binary-brighten':
      return say(`${from} deposited into the ${d.pair} pool`);
    case 'binary-dim':
      return say(`${from} withdrew from the ${d.pair} pool`);
    case 'satellite':
      return say(`${from} bid for the ${d.pair} pool's auction slot${d.expiration != null ? `, until ripple time ${d.expiration}` : ''}`);
    case 'binary-collapse':
      return say(`${from} deleted the ${d.pair} pool`);
    case 'ring':
      return say(`${a} changed its account settings${d.flagName ? ` (${d.flagName})` : ''}`);
    case 'nameplate':
      return say(`${a} set its Domain to ${d.domain}`);
    case 'darken':
      return say(`${a} disabled its master key`);
    case 'tilt':
      return say(`${a} ${d.regularKey ? `set a regular key, ${who(d.regularKey, nameOf)}` : 'cleared its regular key'}`);
    case 'guardians':
      return say(d.removed ? `${a} removed its signer list` : `${a} set ${d.signers.length} signers with a quorum of ${d.quorum}`);
    case 'shimmer':
      return say(`${a} created ${d.count} ticket${d.count === 1 ? '' : 's'}`);
    case 'moon-form':
      return say(`${a} minted an NFT${d.taxon ? ` (taxon ${d.taxon})` : ''}`);
    case 'moon-crumble':
      return say(`${a} burned an NFT`);
    case 'moon-beacon':
      return say(`${a} offered ${d.sell ? 'to sell' : 'to buy'} an NFT for ${d.amount}`);
    case 'moon-beacon-off':
      return say(`${a} cancelled ${d.offers} NFT offer${d.offers === 1 ? '' : 's'}`);
    case 'lighthouse':
      return say(`${a} published an oracle update (${d.series} price${d.series === 1 ? '' : 's'})`);
    case 'badge':
      return say(`${a}: ${d.kind}`);
    case 'tick':
      return say(`${a} submitted a Batch of ${d.inner} transaction${d.inner === 1 ? '' : 's'}`);
    case 'spark':
      return say(d.result && d.result !== 'tesSUCCESS' ? `${a}: ${d.type} failed with ${d.result}` : `${a}: ${d.type}, no design yet`);
    default:
      return say(`${a}`);
  }
}

/**
 * Meteor showers: the dust of one sender in one ledger, five or more,
 * becomes one shower event in place of the single dust events.
 */
export function collapseShowers(events, { least = 5 } = {}) {
  const dust = new Map();
  for (const e of events) if (e.object === 'dust' && e.from) (dust.get(e.from) ?? dust.set(e.from, []).get(e.from)).push(e);
  const out = [];
  const absorbed = new Set();
  for (const [from, list] of dust) {
    if (list.length < least) continue;
    for (const e of list) absorbed.add(e);
    const first = list[0];
    const shower = { ...first, object: 'shower', verb: 'travel', rule: OBJECTS.shower.rule, to: null, via: [], evidence: [{ field: 'payments under one XRP from one sender in one ledger', value: list.length }], detail: { count: list.length, members: list.map((e) => e.hash), targets: [...new Set(list.map((e) => e.to))] } };
    shower.label = describeEvent(shower);
    out.push(shower);
  }
  return [...events.filter((e) => !absorbed.has(e)), ...out];
}

/** The hue of an event: the field guide's colour for its category, read as src/glyphs.js reads it. A clawback's reverse comet keeps the trust colour, the issuer's. */
export function colourOf(e) {
  if (e?.object === 'reverse-comet') return CATEGORIES.trust.colour;
  return CATEGORIES[e?.category]?.colour ?? CATEGORIES.other.colour;
}

/**
 * The weather of a ledger at far zoom: the four verbs collapsed into counts
 * per edge. `clusterOf(address)` returns the cluster root (or the address
 * itself when unclustered) and `kindOf(address)` the body kind, so flows
 * are counted between nebulae, streams toward stars, haze around book
 * hosts, glow on planets.
 */
export function weatherOf(events, { clusterOf = (a) => a, kindOf = () => 'planet' } = {}) {
  const flows = new Map();
  const streams = new Map();
  const haze = new Map();
  const glow = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const e of events) {
    if (e.verb === 'travel' && e.from && e.to && e.from !== e.to) {
      const a = clusterOf(e.from);
      const b = clusterOf(e.to);
      if (a !== b) bump(flows, a < b ? `${a}|${b}` : `${b}|${a}`);
      else bump(glow, e.from);
    } else if (e.verb === 'dock' && e.to) bump(streams, e.to);
    else if (e.verb === 'place') for (const h of e.detail?.hosts ?? (e.to ? [e.to] : [])) bump(haze, h);
    else if (e.at) bump(glow, e.at);
  }
  return {
    flows: [...flows].map(([k, n]) => ({ a: k.split('|')[0], b: k.split('|')[1], n })),
    streams: [...streams].map(([star, n]) => ({ star, n, kind: kindOf(star) })),
    haze: [...haze].map(([host, n]) => ({ host, n })),
    glow: [...glow].map(([planet, n]) => ({ planet, n })),
  };
}

/**
 * The type histogram's verdict for a type: designed (in the vocabulary),
 * or a spark because it is unnamed and below the threshold, or unnamed and
 * above it (which the table lists as owed a design).
 */
export const DESIGNED_TYPES = Object.freeze(['Payment', 'EscrowCreate', 'EscrowFinish', 'EscrowCancel', 'CheckCreate', 'CheckCash', 'CheckCancel', 'NFTokenAcceptOffer', 'Clawback', 'AccountDelete', 'PaymentChannelCreate', 'PaymentChannelFund', 'PaymentChannelClaim', 'TrustSet', 'DepositPreauth', 'OfferCreate', 'OfferCancel', 'AMMCreate', 'AMMDeposit', 'AMMWithdraw', 'AMMBid', 'AMMDelete', 'AccountSet', 'SetRegularKey', 'SignerListSet', 'TicketCreate', 'NFTokenMint', 'NFTokenBurn', 'NFTokenCreateOffer', 'NFTokenCancelOffer', 'OracleSet', 'DIDSet', 'DIDDelete', 'CredentialCreate', 'CredentialAccept', 'CredentialDelete', 'MPTokenIssuanceCreate', 'MPTokenIssuanceSet', 'MPTokenIssuanceDestroy', 'MPTokenAuthorize', 'Batch']);

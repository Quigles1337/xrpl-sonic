// xrpl-sonic explorer — the anatomy of a transaction.
//
// A validated transaction's metadata lists every ledger entry it touched,
// with the fields before and after. This module reads that record and says
// what happened in plain words: who paid whom, which offers were placed,
// replaced or consumed, which trust lines moved, what a result code means,
// and what an account's flags and reserve amount to. Everything here is
// derived from the record; nothing is inferred beyond it: the sentences are
// rendered from the typed findings of facts.js, and each keeps the ids of the
// rules it rests on.
//
// Pure: no DOM, no network.

import { parseAmount, formatAmount, decodeCurrency, shortAddress, DROPS_PER_XRP, RIPPLE_EPOCH_OFFSET, categorize } from '../mapping.js';
import { facts, balanceFacts, valueOf } from './facts.js';

/** What a result code means. tec codes were included in a ledger and charged a fee; the rest never were. */
export const RESULT_CODES = Object.freeze({
  tesSUCCESS: 'Succeeded.',
  tecPATH_DRY: 'No payment path had enough liquidity to deliver the amount.',
  tecPATH_PARTIAL: 'The path could not deliver the full amount.',
  tecUNFUNDED_PAYMENT: 'The sender did not have enough to pay.',
  tecUNFUNDED_OFFER: 'The offer was not funded.',
  tecUNFUNDED: 'Not enough funds.',
  tecNO_DST: 'The destination account does not exist.',
  tecNO_DST_INSUF_XRP: 'The destination account does not exist and the payment was below the reserve needed to create it.',
  tecINSUFFICIENT_RESERVE: 'The account would have fallen below its reserve.',
  tecINSUF_RESERVE_LINE: 'Not enough reserve to add a trust line.',
  tecINSUF_RESERVE_OFFER: 'Not enough reserve to add an offer.',
  tecDST_TAG_NEEDED: 'The destination requires a destination tag.',
  tecNO_PERMISSION: 'Not permitted.',
  tecNO_LINE: 'There is no trust line for that currency.',
  tecNO_LINE_INSUF_RESERVE: 'No trust line, and not enough reserve to create one.',
  tecNO_AUTH: 'The account is not authorised to hold that currency.',
  tecFROZEN: 'The trust line is frozen.',
  tecKILLED: 'The offer was killed: fill-or-kill or immediate-or-cancel could not be satisfied.',
  tecEXPIRED: 'It had already expired.',
  tecDIR_FULL: 'The owner directory is full.',
  tecDUPLICATE: 'A duplicate already exists.',
  tecHAS_OBLIGATIONS: 'The account still has obligations and cannot be deleted.',
  tecTOO_SOON: 'Too soon: the account is too young to be deleted.',
  tecOBJECT_NOT_FOUND: 'The referenced object was not found.',
  tecNO_ENTRY: 'The referenced entry does not exist.',
  tecINSUFFICIENT_FUNDS: 'Insufficient funds.',
  tecINSUFFICIENT_PAYMENT: 'The payment was insufficient.',
  tecCANT_ACCEPT_OWN_NFTOKEN_OFFER: 'An account cannot accept its own NFT offer.',
  tecNFTOKEN_BUY_SELL_MISMATCH: 'The buy and sell offers do not match.',
  tecMAX_SEQUENCE_REACHED: 'The maximum sequence was reached.',
  tecINTERNAL: 'An internal error occurred.',
});

export function resultMeaning(code) {
  if (typeof code !== 'string') return 'Unknown result.';
  if (RESULT_CODES[code]) return RESULT_CODES[code];
  if (code.startsWith('tec')) return 'Failed, but was included in the ledger and charged its fee.';
  if (code.startsWith('tem')) return 'Malformed: the transaction could not be understood.';
  if (code.startsWith('tef')) return 'Failed and was not included in a ledger.';
  if (code.startsWith('ter')) return 'Retried: it could not be applied yet.';
  if (code.startsWith('tel')) return 'Rejected locally by the node.';
  return 'Unknown result.';
}

/** Ripple-epoch seconds → ISO string (null when missing). */
export function rippleTimeToIso(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return null;
  return new Date((n + RIPPLE_EPOCH_OFFSET) * 1000).toISOString();
}

/** A hex-encoded Domain field → text (as it is, when it is not hex). */
export function decodeDomain(hex) {
  if (typeof hex !== 'string' || !hex) return '';
  if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length % 2) return hex;
  let out = '';
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (byte < 0x20 || byte > 0x7e) return hex;
    out += String.fromCharCode(byte);
  }
  return out;
}

/** Plain words for the account_flags object account_info returns. Only the flags that are set. */
export const FLAG_WORDS = Object.freeze({
  requireDestinationTag: 'Requires a destination tag on incoming payments',
  disallowIncomingXRP: 'Asks not to receive XRP (advisory)',
  disableMasterKey: 'Master key disabled',
  requireAuthorization: 'Trust lines need its authorisation',
  defaultRipple: 'Rippling on by default',
  depositAuth: 'Deposit authorisation: only pre-approved senders',
  globalFreeze: 'All its issued currencies are frozen',
  noFreeze: 'Has given up the ability to freeze',
  passwordSpent: 'Free SetRegularKey used',
  disallowIncomingNFTokenOffer: 'Refuses incoming NFT offers',
  disallowIncomingCheck: 'Refuses incoming Checks',
  disallowIncomingPayChan: 'Refuses incoming payment channels',
  disallowIncomingTrustline: 'Refuses incoming trust lines',
  allowTrustLineClawback: 'Can claw back issued tokens',
  allowTrustLineLocking: 'Allows trust line locking',
  amm: 'An AMM pseudo-account (its AMM entry holds the pool)',
});

export function decodeFlags(accountFlags) {
  if (!accountFlags || typeof accountFlags !== 'object') return [];
  return Object.entries(accountFlags)
    .filter(([, v]) => v === true)
    .map(([k]) => FLAG_WORDS[k] ?? k);
}

/** Reserve in XRP for an owner count, from the network's current values (1 XRP base and 0.2 XRP per object as of 2025). */
export function reserveFor({ ownerCount = 0, reserveBase = 1, reserveInc = 0.2 } = {}) {
  const base = Number(reserveBase) || 0;
  const inc = Number(reserveInc) || 0;
  const owner = Math.round(Math.max(0, Number(ownerCount) || 0) * inc * 1e6) / 1e6;
  return { base, owner, total: Math.round((base + owner) * 1e6) / 1e6 };
}

// ---------------------------------------------------------------------------
// Balance changes from AffectedNodes
// ---------------------------------------------------------------------------

const xrp = (drops) => Number(drops) / DROPS_PER_XRP;

/**
 * Who gained and lost what. XRP from AccountRoot nodes (fees included);
 * issued currencies from RippleState nodes, reported for both sides of the
 * line (the low account's view, and the high account's as its negation).
 * `delta`, `before` and `after` are numbers for the display layer; `exact`
 * keeps the strings the ledger wrote (drops for XRP, decimals for issued
 * currencies), and `node` is the AffectedNodes entry they came from.
 * @returns {{ account, currency, issuer, delta, before, after, exact: { before, after, delta }, node, created?, deleted? }[]}
 */
export function balanceChanges(meta) {
  return balanceFacts(meta).map((b) => {
    const num = b.currency === 'XRP' ? xrp : Number;
    return { ...b, delta: num(b.exact.delta), before: num(b.exact.before), after: num(b.exact.after) };
  });
}

// ---------------------------------------------------------------------------
// Affected entries in words
// ---------------------------------------------------------------------------

function amountText(a) {
  const p = parseAmount(a);
  return p ? formatAmount(p) : '?';
}

/** Display text for an exact amount from the facts layer (the display layer rounds; the facts keep the string). */
function exactText(a) {
  if (!a) return '?';
  const p = parseAmount(a.currency === 'XRP' && a.drops != null ? a.drops : a.issuanceId ? { mpt_issuance_id: a.issuanceId, value: a.value } : { currency: a.code ?? a.currency, issuer: a.issuer, value: a.value });
  return p ? formatAmount(p) : '?';
}

function issuerOf(a) {
  return a && typeof a === 'object' && a.issuer ? ` (${shortAddress(a.issuer)})` : '';
}

const fmtDrops = (drops) => `${xrp(drops).toLocaleString('en-US', { maximumFractionDigits: 6 })} XRP`;

/** One Offer entry in words, from its findings. Returns { summary, rules }. */
function offerSummary(o, f) {
  const owner = shortAddress(o.owner);
  const gets = exactText(o.amounts.takerGets.after);
  const pays = exactText(o.amounts.takerPays.after);
  const was = `(was giving ${exactText(o.amounts.takerGets.before)} for ${exactText(o.amounts.takerPays.before)})`;
  if (o.action === 'created') return { summary: `Offer placed by ${owner}: gives ${gets}${issuerOf(o.amounts.takerGets.after)} for ${pays}${issuerOf(o.amounts.takerPays.after)}`, rules: o.role === 'submitter-new' ? ['offer.placed', 'offer.amounts.after'] : ['node.action', 'offer.amounts.after'] };
  if (o.action === 'modified') {
    if (o.traded === 'yes') return { summary: `Offer #${o.sequence} by ${owner} partly consumed: ${exactText(o.tradedAmounts.gave)} taken, ${gets} left`, rules: ['offer.modified.partial', 'offer.trade.delta'] };
    if (o.traded === 'no') return { summary: `Offer #${o.sequence} by ${owner} updated`, rules: ['offer.modified.other'] };
    return { summary: `Offer #${o.sequence} by ${owner} changed (the record does not say how much traded)`, rules: ['offer.trade.previous-fields'] };
  }
  switch (o.removal) {
    case 'cancelled':
      return { summary: `Earlier offer #${o.sequence} by ${owner} cancelled ${was}`, rules: ['offer.removal.cancelled'] };
    case 'replaced':
      return { summary: `Earlier offer #${o.sequence} by ${owner} replaced ${was}`, rules: ['offer.removal.replaced'] };
    case 'self-cross':
      return { summary: `Offer #${o.sequence} by ${owner} on the other side of its new offer removed without trading ${was}`, rules: ['offer.removal.self-cross'] };
    case 'consumed':
      return { summary: `Offer #${o.sequence} by ${owner} fully consumed: it gave ${exactText(o.tradedAmounts.gave)} for ${exactText(o.tradedAmounts.got)}`, rules: ['offer.removal.consumed', 'offer.trade.delta'] };
    case 'traded-then-removed-unfunded':
      return { summary: `Offer #${o.sequence} by ${owner} traded what it held and left the book: it gave ${exactText(o.tradedAmounts.gave)} for ${exactText(o.tradedAmounts.got)}, with ${gets} left unfunded`, rules: ['offer.removal.traded-unfunded', 'offer.trade.delta'] };
    case 'cleanup-without-trade': {
      const why = o.expired === 'yes' ? 'expired' : o.expired === 'no' ? (o.expiration != null ? 'not expired, so unfunded' : 'no expiration, so unfunded') : 'expired or unfunded';
      return { summary: `Offer #${o.sequence} by ${owner} removed from the book without trading: ${why} ${was}`, rules: ['offer.removal.cleanup', 'offer.expired'] };
    }
    default:
      return { summary: `Offer #${o.sequence} by ${owner} removed (the record does not say why) ${was}`, rules: ['offer.removal.unresolved'] };
  }
}

/**
 * One line per ledger entry the transaction touched, with the action and a
 * few details, rendered from the findings. Each entry keeps the ids of the
 * rules its summary rests on (`rules`) and of its findings (`findings`).
 * Directory nodes (bookkeeping) are counted, not listed.
 * @returns {{ entries: object[], directories: number, facts: object }}
 */
export function describeAffected(meta, tx = {}, { facts: given = null } = {}) {
  const f = given ?? facts(tx, meta, { closeTime: tx?.date ?? null });
  const offersByNode = new Map(f.offers.map((o) => [o.node, o]));
  const balancesByNode = new Map();
  for (const b of f.balances) if (!balancesByNode.has(b.node)) balancesByNode.set(b.node, b);
  const entries = [];
  let directories = 0;
  let n = -1;
  for (const raw of meta?.AffectedNodes ?? []) {
    n += 1;
    const wrapper = raw?.CreatedNode ? 'CreatedNode' : raw?.ModifiedNode ? 'ModifiedNode' : raw?.DeletedNode ? 'DeletedNode' : null;
    if (!wrapper) continue;
    const e = raw[wrapper];
    const kind = wrapper === 'CreatedNode' ? 'created' : wrapper === 'ModifiedNode' ? 'modified' : 'deleted';
    const fin = e.FinalFields ?? e.NewFields ?? {};
    const prev = e.PreviousFields ?? {};
    const type = e.LedgerEntryType;
    const base = { node: n, type, action: kind, index: e.LedgerIndex ?? null, details: [], exact: {}, rules: ['node.action'], findings: f.findings.filter((x) => x.evidence.some((ev) => ev.node === n)).map((x) => x.id) };
    switch (type) {
      case 'DirectoryNode':
        directories += 1;
        continue;
      case 'AccountRoot': {
        const account = fin.Account ?? null;
        const d = base.details;
        if (!account) {
          entries.push({ ...base, account: null, summary: 'Account entry touched (only its last-transaction pointer changed)' });
          break;
        }
        const bal = balancesByNode.get(n);
        if (bal) {
          d.push(['Balance', `${fmtDrops(bal.exact.before).replace(' XRP', '')} → ${fmtDrops(bal.exact.after)}`]);
          base.exact.Balance = `${bal.exact.before} → ${bal.exact.after} drops`;
          base.rules.push('balance.xrp');
        }
        if (prev.OwnerCount != null) d.push(['Owned objects', `${prev.OwnerCount} → ${fin.OwnerCount}`]);
        if (prev.Sequence != null) d.push(['Sequence', `${prev.Sequence} → ${fin.Sequence}`]);
        if (prev.Domain != null || (kind === 'modified' && 'Domain' in prev)) d.push(['Domain', decodeDomain(fin.Domain ?? '') || '(cleared)']);
        if (prev.RegularKey !== undefined) d.push(['Regular key', fin.RegularKey ?? '(removed)']);
        if (prev.Flags != null) d.push(['Flags', `${prev.Flags} → ${fin.Flags}`]);
        if (fin.AMMID) d.push(['AMM pool', String(fin.AMMID)]);
        entries.push({ ...base, account, summary: kind === 'created' ? `Account ${shortAddress(account)} created with ${fmtDrops(fin.Balance ?? '0')}` : kind === 'deleted' ? `Account ${shortAddress(account)} deleted` : fin.AMMID ? `AMM pool account ${shortAddress(account)} updated` : `Account ${shortAddress(account)} updated` });
        break;
      }
      case 'RippleState': {
        const bal = fin.Balance ?? {};
        const currency = decodeCurrency(bal.currency ?? '');
        const low = fin.LowLimit?.issuer;
        const high = fin.HighLimit?.issuer;
        const d = base.details;
        const exact = balancesByNode.get(n);
        if (exact) {
          d.push(['Balance', `${Number(exact.exact.before)} → ${Number(exact.exact.after)} ${currency}`]);
          base.exact.Balance = `${exact.exact.before} → ${exact.exact.after} ${currency}`;
          base.rules.push('balance.issued');
        } else if (bal.value != null) {
          d.push(['Balance', `${Number(bal.value)} ${currency}`]);
          base.exact.Balance = `${bal.value} ${currency}`;
        }
        if (fin.LowLimit) d.push(['Limit (low side)', `${Number(fin.LowLimit.value)} ${currency} for ${shortAddress(low)}`]);
        if (fin.HighLimit) d.push(['Limit (high side)', `${Number(fin.HighLimit.value)} ${currency} for ${shortAddress(high)}`]);
        entries.push({ ...base, summary: `Trust line ${currency} between ${shortAddress(low)} and ${shortAddress(high)} ${kind}` });
        break;
      }
      case 'Offer': {
        const o = offersByNode.get(n);
        const { summary, rules } = offerSummary(o, f);
        const unit = (a) => (a?.currency === 'XRP' ? 'drops' : a?.currency ?? '');
        base.details.push(['Gives', `${exactText(o.amounts.takerGets.after)}${issuerOf(o.amounts.takerGets.after)}`], ['Wants', `${exactText(o.amounts.takerPays.after)}${issuerOf(o.amounts.takerPays.after)}`], ['Sequence', String(o.sequence)]);
        base.exact.Gives = `${valueOf(o.amounts.takerGets.after)} ${unit(o.amounts.takerGets.after)}`;
        base.exact.Wants = `${valueOf(o.amounts.takerPays.after)} ${unit(o.amounts.takerPays.after)}`;
        if (o.traded === 'yes') {
          base.details.push(['Traded', `gave ${exactText(o.tradedAmounts.gave)}, got ${exactText(o.tradedAmounts.got)}`]);
          base.exact.Traded = `gave ${valueOf(o.tradedAmounts.gave)} ${unit(o.tradedAmounts.gave)}, got ${valueOf(o.tradedAmounts.got)} ${unit(o.tradedAmounts.got)}`;
        }
        if (o.expiration) base.details.push(['Expires', rippleTimeToIso(o.expiration)]);
        if (o.removal) base.details.push(['Removal', o.removal]);
        entries.push({ ...base, account: o.owner, summary, rules: [...new Set([...base.rules, ...rules])], offer: o });
        break;
      }
      case 'NFTokenOffer': {
        const sell = (Number(tx.Flags) & 1) === 1 || (Number(fin.Flags) & 1) === 1;
        base.details.push(['Token', String(fin.NFTokenID ?? '')], ['Amount', amountText(fin.Amount)]);
        if (fin.Expiration) base.details.push(['Expires', rippleTimeToIso(fin.Expiration)]);
        if (fin.Destination) base.details.push(['Only for', shortAddress(fin.Destination)]);
        entries.push({ ...base, account: fin.Owner, summary: `NFT ${sell ? 'sell' : 'buy'} offer by ${shortAddress(fin.Owner)} ${kind}: ${amountText(fin.Amount)}` });
        break;
      }
      case 'NFTokenPage': {
        const count = Array.isArray(fin.NFTokens) ? fin.NFTokens.length : null;
        const prevCount = Array.isArray(prev.NFTokens) ? prev.NFTokens.length : null;
        entries.push({ ...base, summary: `NFT page ${kind}${count != null ? ` (${prevCount != null ? `${prevCount} → ` : ''}${count} tokens)` : ''}` });
        break;
      }
      case 'Escrow':
        base.details.push(['Amount', amountText(fin.Amount)], ['To', shortAddress(fin.Destination)]);
        if (fin.FinishAfter) base.details.push(['Finish after', rippleTimeToIso(fin.FinishAfter)]);
        if (fin.CancelAfter) base.details.push(['Cancel after', rippleTimeToIso(fin.CancelAfter)]);
        entries.push({ ...base, account: fin.Account, summary: `Escrow ${kind}: ${amountText(fin.Amount)} from ${shortAddress(fin.Account)} to ${shortAddress(fin.Destination)}` });
        break;
      case 'PayChannel':
        base.details.push(['Capacity', amountText(fin.Amount)], ['Paid out', amountText(fin.Balance)], ['To', shortAddress(fin.Destination)]);
        entries.push({ ...base, account: fin.Account, summary: `Payment channel ${kind}: ${amountText(fin.Balance)} of ${amountText(fin.Amount)} paid to ${shortAddress(fin.Destination)}` });
        break;
      case 'Check':
        base.details.push(['Up to', amountText(fin.SendMax)], ['To', shortAddress(fin.Destination)]);
        entries.push({ ...base, account: fin.Account, summary: `Check ${kind}: up to ${amountText(fin.SendMax)} for ${shortAddress(fin.Destination)}` });
        break;
      case 'AMM':
        entries.push({ ...base, account: fin.Account, summary: `AMM pool ${kind}${fin.TradingFee != null ? ` (fee ${(Number(fin.TradingFee) / 1000).toFixed(3)}%)` : ''}` });
        break;
      case 'Ticket':
        entries.push({ ...base, account: fin.Account, summary: `Ticket #${fin.TicketSequence ?? '?'} ${kind}` });
        break;
      case 'SignerList':
        entries.push({ ...base, summary: `Signer list ${kind}${fin.SignerQuorum != null ? ` (quorum ${fin.SignerQuorum}, ${(fin.SignerEntries ?? []).length} signers)` : ''}` });
        break;
      case 'DepositPreauth':
        entries.push({ ...base, account: fin.Account, summary: `Deposit pre-authorisation ${kind}${fin.Authorize ? ` for ${shortAddress(fin.Authorize)}` : ''}` });
        break;
      default:
        entries.push({ ...base, summary: `${type} ${kind}` });
    }
  }
  return { entries, directories, facts: f };
}

// ---------------------------------------------------------------------------
// The headline
// ---------------------------------------------------------------------------

/**
 * The headline as sentences rendered from the findings. Each sentence keeps
 * the rule ids it rests on and the ids of the findings it used, so "show why"
 * is a lookup into `facts.findings`.
 * @returns {{ text: string, sentences: { text: string, rules: string[], findings: string[] }[], facts: object }}
 */
export function explain(tx, meta, { facts: given = null } = {}) {
  if (!tx || typeof tx !== 'object') return { text: '', sentences: [], facts: null };
  const f = given ?? facts(tx, meta, { closeTime: tx.date ?? null });
  const byRule = (...rules) => f.findings.filter((x) => rules.includes(x.rule)).map((x) => x.id);
  const sentences = [];
  const say = (text, rules, findings = byRule(...rules)) => sentences.push({ text, rules, findings });
  const result = f.transaction.result;
  const fee = f.transaction.fee ?? '0';
  const feeNum = Number(fee) || 0;
  const feeText = feeNum ? `Fee ${feeNum.toLocaleString('en-US')} drops.` : '';
  const who = shortAddress(tx.Account);
  if (result && result !== 'tesSUCCESS') {
    say(`${tx.TransactionType} by ${who} failed: ${result} — ${resultMeaning(result)}`, ['result']);
    if (feeNum) say(`Only the fee of ${feeNum.toLocaleString('en-US')} drops was charged.`, ['result', 'balance.xrp']);
    return { text: sentences.map((s) => s.text).join(' '), sentences, facts: f };
  }
  switch (tx.TransactionType) {
    case 'Payment': {
      const ex = f.exchange;
      const delivered = ex?.request.delivered && ex.request.delivered !== 'unresolved' ? ex.request.delivered : ex?.request.amount ?? null;
      const created = f.balances.find((c) => c.created && c.account === tx.Destination);
      const self = tx.Account === tx.Destination;
      const crossed = ex?.crossed ?? [];
      const spent = ex?.spent && delivered && (ex.spent.currency !== delivered.currency || ex.spent.issuer !== delivered.issuer) ? ex.spent : null;
      const head = self ? `${who} paid itself ${delivered ? exactText(delivered) : '?'}${issuerOf(delivered)}${spent ? ` for ${exactText(spent)}${issuerOf(spent)}` : ''}` : `${who} sent ${delivered ? exactText(delivered) : '?'}${issuerOf(delivered)} to ${shortAddress(tx.Destination)}${spent ? `, paying ${exactText(spent)}${issuerOf(spent)}` : ''}`;
      say(`${head}${crossed.length ? `, crossing ${crossed.length} offer${crossed.length === 1 ? '' : 's'} on the way` : ''}.`, ['payment.delivered', ...(spent ? ['payment.spent'] : []), ...(crossed.length ? ['payment.crossed'] : [])]);
      if (created) say('This funded a new account.', ['balance.xrp'], [byRule('balance.xrp').find(Boolean)].filter(Boolean));
      if (ex?.request.partialPayment) say('Partial payment allowed.', ['transaction.flags']);
      if (feeText) say(feeText, ['balance.xrp']);
      break;
    }
    case 'OfferCreate': {
      const ex = f.exchange;
      const { request: req, fill } = ex;
      const gets = req.takerGets;
      const pays = req.takerPays;
      const parts = [];
      const part = (text, rules) => parts.push({ text, rules });
      part(`${who} offered ${gets ? exactText(gets) : '?'}${issuerOf(gets)} for ${pays ? exactText(pays) : '?'}${issuerOf(pays)}`, ['exchange.request']);
      const crossed = ex.book.crossed.length;
      const pool = ex.amm?.tier === 'rule';
      if (crossed) part(`crossing ${crossed} existing offer${crossed === 1 ? '' : 's'}${pool ? ' and an AMM pool' : ''}${ex.book.bridged === 'yes' ? ', bridged through XRP' : ''}`, ['exchange.book', ...(pool ? ['exchange.amm'] : []), ...(ex.book.bridged === 'yes' ? ['exchange.bridged'] : [])]);
      else if (pool) part('filled by an AMM pool', ['exchange.amm']);
      else part('nothing crossed', ['exchange.book']);
      const sell = req.sell;
      const received = ex.received ? exactText(ex.received) : '?';
      const spent = ex.spent ? exactText(ex.spent) : '?';
      const getsText = gets ? exactText(gets) : '?';
      const paysText = pays ? exactText(pays) : '?';
      let iocSaid = false;
      switch (fill?.status) {
        case 'filled': {
          const fillRules = ['exchange.fill', ...(f.findings.some((x) => x.rule === 'exchange.fill.rounding') ? ['exchange.fill.rounding'] : [])];
          if (sell) part(`filled entirely: sold all ${getsText} for ${received}${fill.betterThanAsked === 'yes' ? `, above the ${paysText} asked` : ''}`, fillRules);
          else part(`filled entirely: received ${received} for ${fill.betterThanAsked === 'yes' ? `${spent} of the ${getsText} offered` : `all ${getsText}`}`, fillRules);
          break;
        }
        case 'partial': {
          const head = sell ? `partly filled: sold ${spent} of ${getsText} for ${received}` : `partly filled: received ${received} of ${paysText} for ${spent}`;
          if (req.immediateOrCancel) {
            part(`${head}; immediate-or-cancel, so the rest was not placed`, ['exchange.fill', 'exchange.fill.ioc']);
            iocSaid = true;
          } else if (fill.placed) part(`${head}; the rest was placed on the book`, ['exchange.fill', 'offer.placed']);
          else part(`${head}; the rest was not placed`, ['exchange.fill']);
          break;
        }
        case 'none':
          if (fill.placed) part('placed on the book', ['offer.placed']);
          else if (req.immediateOrCancel) {
            part('immediate-or-cancel, so nothing was placed', ['exchange.fill.ioc']);
            iocSaid = true;
          } else part('nothing was placed', ['exchange.fill']);
          break;
        default: {
          const x = f.findings.find((y) => y.subject === 'exchange' && y.property === 'fill');
          part(`fill status unresolved${x?.note ? `: ${x.note.replace(/\.$/, '')}` : ''}`, ['exchange.fill']);
        }
      }
      if (req.immediateOrCancel && !iocSaid) part('immediate-or-cancel', ['exchange.fill.ioc']);
      if (req.fillOrKill) part('fill-or-kill', ['exchange.fill.fok']);
      if (req.passive) part('passive', ['exchange.request']);
      for (const o of f.offers) if (o.removal === 'replaced') part(`replacing its earlier offer #${o.sequence}`, ['offer.removal.replaced']);
      for (const o of f.offers) if (o.removal === 'self-cross') part(`its own offer #${o.sequence} on the other side was removed without trading`, ['offer.removal.self-cross']);
      const cleaned = f.offers.filter((o) => o.removal === 'cleanup-without-trade');
      if (cleaned.length) {
        const expired = cleaned.filter((o) => o.expired === 'yes').length;
        const tail = expired === cleaned.length ? ' (expired)' : expired ? ` (${expired} expired)` : '';
        part(`${cleaned.length} stale offer${cleaned.length === 1 ? '' : 's'} removed from the book without trading${tail}`, ['offer.removal.cleanup', 'offer.expired']);
      }
      const drained = f.offers.filter((o) => o.removal === 'traded-then-removed-unfunded');
      if (drained.length) part(`${drained.length} offer${drained.length === 1 ? '' : 's'} traded what they held and left the book`, ['offer.removal.traded-unfunded']);
      const unresolved = f.offers.filter((o) => o.action === 'deleted' && o.removal === 'unresolved');
      if (unresolved.length) part(`${unresolved.length} offer${unresolved.length === 1 ? '' : 's'} removed for a reason the record does not give`, ['offer.removal.unresolved']);
      say(`${parts.map((p) => p.text).join('; ')}.`, [...new Set(parts.flatMap((p) => p.rules))]);
      if (feeText) say(feeText, ['balance.xrp']);
      break;
    }
    case 'OfferCancel': {
      const gone = f.offers.find((o) => o.removal === 'cancelled');
      say(`${who} cancelled its offer #${tx.OfferSequence}.`, gone ? ['offer.removal.cancelled'] : ['exchange.request'], gone ? byRule('offer.removal.cancelled') : []);
      if (feeText) say(feeText, ['balance.xrp']);
      break;
    }
    case 'TrustSet': {
      const lim = parseAmount(tx.LimitAmount);
      say(`${who} set a trust line for ${lim ? formatAmount(lim) : '?'}${issuerOf(tx.LimitAmount)}${lim && lim.value === 0 ? ' (removing it, if nothing is owed)' : ''}.`, ['transaction.flags', 'balance.issued'], byRule('balance.issued'));
      if (feeText) say(feeText, ['balance.xrp']);
      break;
    }
    case 'NFTokenCreateOffer': {
      const sell = (Number(tx.Flags) & 1) === 1;
      say(`${who} ${sell ? 'offered to sell' : 'offered to buy'} NFT ${String(tx.NFTokenID ?? '').slice(0, 10)}… for ${amountText(tx.Amount)}${tx.Expiration ? `, until ${rippleTimeToIso(tx.Expiration)}` : ''}.`, ['transaction.flags', 'node.action']);
      if (feeText) say(feeText, ['balance.xrp']);
      break;
    }
    case 'NFTokenMint':
      say(`${who} minted an NFT (taxon ${tx.NFTokenTaxon ?? '?'}).`, ['node.action']);
      if (feeText) say(feeText, ['balance.xrp']);
      break;
    case 'NFTokenAcceptOffer':
      say(`${who} accepted an NFT offer.`, ['node.action']);
      if (feeText) say(feeText, ['balance.xrp']);
      break;
    case 'NFTokenBurn':
      say(`${who} burned NFT ${String(tx.NFTokenID ?? '').slice(0, 10)}….`, ['node.action']);
      if (feeText) say(feeText, ['balance.xrp']);
      break;
    case 'EscrowCreate':
      say(`${who} locked ${amountText(tx.Amount)} in escrow for ${shortAddress(tx.Destination)}.`, ['node.action', 'balance.xrp']);
      if (feeText) say(feeText, ['balance.xrp']);
      break;
    case 'EscrowFinish':
      say(`${who} released the escrow #${tx.OfferSequence} of ${shortAddress(tx.Owner)}.`, ['node.action', 'balance.xrp']);
      if (feeText) say(feeText, ['balance.xrp']);
      break;
    case 'EscrowCancel':
      say(`${who} cancelled the escrow #${tx.OfferSequence} of ${shortAddress(tx.Owner)}.`, ['node.action', 'balance.xrp']);
      if (feeText) say(feeText, ['balance.xrp']);
      break;
    case 'AccountSet':
      say(`${who} changed its account settings${tx.Domain ? ` (domain ${decodeDomain(tx.Domain)})` : ''}.`, ['node.action']);
      if (feeText) say(feeText, ['balance.xrp']);
      break;
    case 'TicketCreate':
      say(`${who} created ${tx.TicketCount ?? 1} ticket${Number(tx.TicketCount) === 1 ? '' : 's'}.`, ['node.action']);
      if (feeText) say(feeText, ['balance.xrp']);
      break;
    case 'AMMDeposit':
    case 'AMMWithdraw':
    case 'AMMCreate':
    case 'AMMBid':
    case 'AMMVote':
      say(`${who} ${tx.TransactionType.replace('AMM', 'AMM ').toLowerCase()}.`, ['node.action']);
      if (feeText) say(feeText, ['balance.xrp']);
      break;
    default:
      say(`${who} submitted a ${tx.TransactionType}.`, ['node.action']);
      if (feeText) say(feeText, ['balance.xrp']);
  }
  return { text: sentences.map((s) => s.text).join(' '), sentences, facts: f };
}

/**
 * One or two sentences that say what the transaction did, from the record.
 * The text of `explain()`; the rule ids are there when they are wanted.
 * @param {object} tx   the transaction fields (with hash, date…)
 * @param {object} meta its metadata
 */
export function summarize(tx, meta) {
  return explain(tx, meta).text;
}

// ---------------------------------------------------------------------------
// account_tx: normalising and aggregating
// ---------------------------------------------------------------------------

/** account_tx entries ({ tx, meta } or { tx_json, meta, hash }) as the stream-message shape src/mapping.js reads. */
export function asStreamMessage(entry) {
  const tx = entry?.tx ?? entry?.tx_json ?? null;
  if (!tx) return null;
  return {
    type: 'transaction',
    transaction: tx,
    meta: entry.meta ?? null,
    hash: entry.hash ?? tx.hash ?? null,
    ledger_index: entry.ledger_index ?? tx.ledger_index ?? null,
    engine_result: entry.meta?.TransactionResult ?? null,
    validated: entry.validated !== false,
    date: tx.date ?? entry.close_time_iso ?? null,
  };
}

/**
 * Counterparties of an account from a page of account_tx: who it dealt with,
 * how often, in which categories, with XRP in and out taken from the record's
 * balance changes.
 */
export function counterparties(entries, account) {
  const map = new Map();
  const touch = (address, role) => {
    if (!address || address === account) return null;
    let c = map.get(address);
    if (!c) {
      c = { address, count: 0, roles: {}, categories: {}, xrpIn: 0, xrpOut: 0, last: null, first: null };
      map.set(address, c);
    }
    c.roles[role] = (c.roles[role] ?? 0) + 1;
    return c;
  };
  for (const entry of entries ?? []) {
    const tx = entry?.tx ?? entry?.tx_json;
    if (!tx) continue;
    const category = categorize(tx.TransactionType);
    const seen = new Set();
    const bump = (address, role) => {
      const c = touch(address, role);
      if (!c || seen.has(address)) return;
      seen.add(address);
      c.count += 1;
      c.categories[category] = (c.categories[category] ?? 0) + 1;
      const when = tx.date ?? null;
      if (when != null) {
        c.last = c.last == null ? when : Math.max(c.last, when);
        c.first = c.first == null ? when : Math.min(c.first, when);
      }
    };
    if (tx.Account !== account) bump(tx.Account, 'sender');
    if (tx.Destination && tx.Destination !== account) bump(tx.Destination, 'recipient');
    for (const side of [tx.TakerGets, tx.TakerPays, tx.LimitAmount, tx.Amount, tx.SendMax]) {
      if (side && typeof side === 'object' && side.issuer && side.issuer !== account) bump(side.issuer, 'issuer');
    }
    if (tx.TransactionType === 'Payment' && entry.meta) {
      const mine = balanceChanges(entry.meta).find((c) => c.account === account && c.currency === 'XRP');
      if (mine) {
        const other = tx.Account === account ? tx.Destination : tx.Account;
        const c = other && other !== account ? map.get(other) : null;
        if (c) {
          if (mine.delta > 0) c.xrpIn += mine.delta;
          else c.xrpOut += -mine.delta;
        }
      }
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || (b.last ?? 0) - (a.last ?? 0));
}

/** The mix of transaction types in a list of entries or ledger transactions. */
export function typeMix(transactions) {
  const counts = {};
  for (const t of transactions ?? []) {
    const tx = t?.tx ?? t?.tx_json ?? t;
    const type = tx?.TransactionType;
    if (!type) continue;
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([type, count]) => ({ type, count, category: categorize(type) }))
    .sort((a, b) => b.count - a.count);
}

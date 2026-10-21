// xrpl-sonic explorer — the anatomy of a transaction.
//
// A validated transaction's metadata lists every ledger entry it touched,
// with the fields before and after. This module reads that record and says
// what happened in plain words: who paid whom, which offers were placed,
// replaced or consumed, which trust lines moved, what a result code means,
// and what an account's flags and reserve amount to. Everything here is
// derived from the record; nothing is inferred beyond it.
//
// Pure: no DOM, no network.

import { parseAmount, formatAmount, decodeCurrency, shortAddress, DROPS_PER_XRP, RIPPLE_EPOCH_OFFSET, categorize } from '../mapping.js';

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

function nodeOf(n) {
  const kind = n.CreatedNode ? 'created' : n.ModifiedNode ? 'modified' : n.DeletedNode ? 'deleted' : null;
  if (!kind) return null;
  const e = n.CreatedNode ?? n.ModifiedNode ?? n.DeletedNode;
  return { kind, type: e.LedgerEntryType, final: e.FinalFields ?? e.NewFields ?? {}, prev: e.PreviousFields ?? {}, fresh: e.NewFields ?? null, index: e.LedgerIndex };
}

const xrp = (drops) => Number(drops) / DROPS_PER_XRP;

/**
 * Who gained and lost what. XRP from AccountRoot nodes (fees included);
 * issued currencies from RippleState nodes, reported for both sides of the
 * line (the low account's view, and the high account's as its negation).
 * @returns {{ account, currency, issuer, delta, before, after, created?, deleted? }[]}
 */
export function balanceChanges(meta) {
  const out = [];
  for (const raw of meta?.AffectedNodes ?? []) {
    const n = nodeOf(raw);
    if (!n) continue;
    if (n.type === 'AccountRoot') {
      const account = n.final.Account;
      if (!account) continue;
      if (n.kind === 'created') out.push({ account, currency: 'XRP', issuer: null, delta: xrp(n.final.Balance), before: 0, after: xrp(n.final.Balance), created: true });
      else if (n.kind === 'deleted') out.push({ account, currency: 'XRP', issuer: null, delta: -xrp(n.final.Balance), before: xrp(n.final.Balance), after: 0, deleted: true });
      else if (n.prev.Balance != null) out.push({ account, currency: 'XRP', issuer: null, delta: xrp(n.final.Balance) - xrp(n.prev.Balance), before: xrp(n.prev.Balance), after: xrp(n.final.Balance) });
    } else if (n.type === 'RippleState') {
      const bal = n.final.Balance;
      const low = n.final.LowLimit?.issuer;
      const high = n.final.HighLimit?.issuer;
      if (!bal || !low || !high) continue;
      const after = n.kind === 'deleted' ? 0 : Number(bal.value);
      const before = n.kind === 'created' ? 0 : n.prev.Balance != null ? Number(n.prev.Balance.value) : n.kind === 'deleted' ? Number(bal.value) : after;
      const delta = after - before;
      if (delta === 0 && n.kind === 'modified') continue;
      const currency = decodeCurrency(bal.currency);
      out.push({ account: low, currency, issuer: high, delta, before, after, ...(n.kind !== 'modified' ? { [n.kind]: true } : {}) });
      out.push({ account: high, currency, issuer: low, delta: -delta, before: -before, after: -after, ...(n.kind !== 'modified' ? { [n.kind]: true } : {}) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Affected entries in words
// ---------------------------------------------------------------------------

function amountText(a) {
  const p = parseAmount(a);
  return p ? formatAmount(p) : '?';
}

function issuerOf(a) {
  return a && typeof a === 'object' && a.issuer ? ` (${shortAddress(a.issuer)})` : '';
}

/**
 * One line per ledger entry the transaction touched, with the action and a
 * few details. Directory nodes (bookkeeping) are counted, not listed.
 * @returns {{ entries: object[], directories: number }}
 */
export function describeAffected(meta, tx = {}) {
  const entries = [];
  let directories = 0;
  for (const raw of meta?.AffectedNodes ?? []) {
    const n = nodeOf(raw);
    if (!n) continue;
    const f = n.final;
    const base = { type: n.type, action: n.kind, index: n.index ?? null, details: [] };
    switch (n.type) {
      case 'DirectoryNode':
        directories += 1;
        continue;
      case 'AccountRoot': {
        const account = f.Account;
        const d = base.details;
        if (n.prev.Balance != null) d.push(['Balance', `${xrp(n.prev.Balance).toLocaleString('en-US', { maximumFractionDigits: 6 })} → ${xrp(f.Balance).toLocaleString('en-US', { maximumFractionDigits: 6 })} XRP`]);
        if (n.prev.OwnerCount != null) d.push(['Owned objects', `${n.prev.OwnerCount} → ${f.OwnerCount}`]);
        if (n.prev.Sequence != null) d.push(['Sequence', `${n.prev.Sequence} → ${f.Sequence}`]);
        if (n.prev.Domain != null || (n.kind === 'modified' && 'Domain' in n.prev)) d.push(['Domain', decodeDomain(f.Domain ?? '') || '(cleared)']);
        if (n.prev.RegularKey !== undefined) d.push(['Regular key', f.RegularKey ?? '(removed)']);
        if (n.prev.Flags != null) d.push(['Flags', `${n.prev.Flags} → ${f.Flags}`]);
        entries.push({ ...base, account, summary: n.kind === 'created' ? `Account ${shortAddress(account)} created with ${xrp(f.Balance).toLocaleString('en-US', { maximumFractionDigits: 6 })} XRP` : n.kind === 'deleted' ? `Account ${shortAddress(account)} deleted` : `Account ${shortAddress(account)} updated` });
        break;
      }
      case 'RippleState': {
        const bal = f.Balance ?? {};
        const currency = decodeCurrency(bal.currency ?? '');
        const low = f.LowLimit?.issuer;
        const high = f.HighLimit?.issuer;
        const d = base.details;
        if (n.prev.Balance != null) d.push(['Balance', `${Number(n.prev.Balance.value)} → ${Number(bal.value)} ${currency}`]);
        else if (bal.value != null) d.push(['Balance', `${Number(bal.value)} ${currency}`]);
        if (f.LowLimit) d.push(['Limit (low side)', `${Number(f.LowLimit.value)} ${currency} for ${shortAddress(low)}`]);
        if (f.HighLimit) d.push(['Limit (high side)', `${Number(f.HighLimit.value)} ${currency} for ${shortAddress(high)}`]);
        entries.push({ ...base, summary: `Trust line ${currency} between ${shortAddress(low)} and ${shortAddress(high)} ${n.kind}` });
        break;
      }
      case 'Offer': {
        const owner = f.Account;
        const gets = amountText(f.TakerGets);
        const pays = amountText(f.TakerPays);
        let summary;
        if (n.kind === 'created') summary = `Offer placed by ${shortAddress(owner)}: gives ${gets}${issuerOf(f.TakerGets)} for ${pays}${issuerOf(f.TakerPays)}`;
        else if (n.kind === 'deleted') {
          if (tx.OfferSequence != null && tx.OfferSequence === f.Sequence && tx.Account === owner) summary = `Earlier offer #${f.Sequence} by ${shortAddress(owner)} ${tx.TransactionType === 'OfferCancel' ? 'cancelled' : 'replaced'} (was giving ${gets} for ${pays})`;
          else if (tx.Account === owner) summary = `Offer #${f.Sequence} by ${shortAddress(owner)} removed (was giving ${gets} for ${pays})`;
          else summary = `Offer #${f.Sequence} by ${shortAddress(owner)} fully consumed: it gave ${amountText(n.prev.TakerGets ?? f.TakerGets)} for ${amountText(n.prev.TakerPays ?? f.TakerPays)}`;
        } else {
          const gotPrev = parseAmount(n.prev.TakerGets);
          const gotNow = parseAmount(f.TakerGets);
          const taken = gotPrev && gotNow ? gotPrev.value - gotNow.value : null;
          summary = taken != null ? `Offer #${f.Sequence} by ${shortAddress(owner)} partly consumed: ${formatAmount({ ...gotNow, value: taken })} taken, ${gets} left` : `Offer #${f.Sequence} by ${shortAddress(owner)} updated`;
        }
        base.details.push(['Gives', `${gets}${issuerOf(f.TakerGets)}`], ['Wants', `${pays}${issuerOf(f.TakerPays)}`], ['Sequence', String(f.Sequence)]);
        if (f.Expiration) base.details.push(['Expires', rippleTimeToIso(f.Expiration)]);
        entries.push({ ...base, account: owner, summary });
        break;
      }
      case 'NFTokenOffer': {
        const sell = (Number(tx.Flags) & 1) === 1 || (Number(f.Flags) & 1) === 1;
        base.details.push(['Token', String(f.NFTokenID ?? '')], ['Amount', amountText(f.Amount)]);
        if (f.Expiration) base.details.push(['Expires', rippleTimeToIso(f.Expiration)]);
        if (f.Destination) base.details.push(['Only for', shortAddress(f.Destination)]);
        entries.push({ ...base, account: f.Owner, summary: `NFT ${sell ? 'sell' : 'buy'} offer by ${shortAddress(f.Owner)} ${n.kind}: ${amountText(f.Amount)}` });
        break;
      }
      case 'NFTokenPage': {
        const count = Array.isArray(f.NFTokens) ? f.NFTokens.length : null;
        const prevCount = Array.isArray(n.prev.NFTokens) ? n.prev.NFTokens.length : null;
        entries.push({ ...base, summary: `NFT page ${n.kind}${count != null ? ` (${prevCount != null ? `${prevCount} → ` : ''}${count} tokens)` : ''}` });
        break;
      }
      case 'Escrow':
        base.details.push(['Amount', amountText(f.Amount)], ['To', shortAddress(f.Destination)]);
        if (f.FinishAfter) base.details.push(['Finish after', rippleTimeToIso(f.FinishAfter)]);
        if (f.CancelAfter) base.details.push(['Cancel after', rippleTimeToIso(f.CancelAfter)]);
        entries.push({ ...base, account: f.Account, summary: `Escrow ${n.kind}: ${amountText(f.Amount)} from ${shortAddress(f.Account)} to ${shortAddress(f.Destination)}` });
        break;
      case 'PayChannel':
        base.details.push(['Capacity', amountText(f.Amount)], ['Paid out', amountText(f.Balance)], ['To', shortAddress(f.Destination)]);
        entries.push({ ...base, account: f.Account, summary: `Payment channel ${n.kind}: ${amountText(f.Balance)} of ${amountText(f.Amount)} paid to ${shortAddress(f.Destination)}` });
        break;
      case 'Check':
        base.details.push(['Up to', amountText(f.SendMax)], ['To', shortAddress(f.Destination)]);
        entries.push({ ...base, account: f.Account, summary: `Check ${n.kind}: up to ${amountText(f.SendMax)} for ${shortAddress(f.Destination)}` });
        break;
      case 'AMM':
        entries.push({ ...base, account: f.Account, summary: `AMM pool ${n.kind}${f.TradingFee != null ? ` (fee ${(Number(f.TradingFee) / 1000).toFixed(3)}%)` : ''}` });
        break;
      case 'Ticket':
        entries.push({ ...base, account: f.Account, summary: `Ticket #${f.TicketSequence ?? '?'} ${n.kind}` });
        break;
      case 'SignerList':
        entries.push({ ...base, summary: `Signer list ${n.kind}${f.SignerQuorum != null ? ` (quorum ${f.SignerQuorum}, ${(f.SignerEntries ?? []).length} signers)` : ''}` });
        break;
      case 'DepositPreauth':
        entries.push({ ...base, account: f.Account, summary: `Deposit pre-authorisation ${n.kind}${f.Authorize ? ` for ${shortAddress(f.Authorize)}` : ''}` });
        break;
      default:
        entries.push({ ...base, summary: `${n.type} ${n.kind}` });
    }
  }
  return { entries, directories };
}

// ---------------------------------------------------------------------------
// The headline
// ---------------------------------------------------------------------------

const fmtXrp = (v) => `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 6 })} XRP`;

/**
 * One or two sentences that say what the transaction did, from the record.
 * @param {object} tx   the transaction fields (with hash, date…)
 * @param {object} meta its metadata
 */
export function summarize(tx, meta) {
  if (!tx || typeof tx !== 'object') return '';
  const result = meta?.TransactionResult ?? tx.meta?.TransactionResult ?? null;
  const fee = Number(tx.Fee) || 0;
  const feeText = fee ? `Fee ${fee.toLocaleString('en-US')} drops.` : '';
  const who = shortAddress(tx.Account);
  if (result && result !== 'tesSUCCESS') return `${tx.TransactionType} by ${who} failed: ${result} — ${resultMeaning(result)} ${fee ? `Only the fee of ${fee.toLocaleString('en-US')} drops was charged.` : ''}`.trim();
  const changes = balanceChanges(meta);
  switch (tx.TransactionType) {
    case 'Payment': {
      const delivered = parseAmount(meta?.delivered_amount ?? meta?.DeliveredAmount ?? tx.DeliverMax ?? tx.Amount);
      const created = changes.find((c) => c.created && c.account === tx.Destination);
      const self = tx.Account === tx.Destination;
      const head = self ? `${who} paid itself ${delivered ? formatAmount(delivered) : '?'}${delivered?.isXrp === false ? ' (a path payment, likely a currency conversion)' : ''}` : `${who} sent ${delivered ? formatAmount(delivered) : '?'}${delivered?.issuer ? ` (${shortAddress(delivered.issuer)})` : ''} to ${shortAddress(tx.Destination)}`;
      const tail = created ? ` This funded a new account.` : '';
      const partial = (Number(tx.Flags) & 0x00020000) !== 0 ? ' Partial payment allowed.' : '';
      return `${head}.${tail}${partial} ${feeText}`.trim();
    }
    case 'OfferCreate': {
      const gets = parseAmount(tx.TakerGets);
      const pays = parseAmount(tx.TakerPays);
      const { entries } = describeAffected(meta, tx);
      const replaced = entries.find((e) => e.type === 'Offer' && e.action === 'deleted' && e.summary.includes('replaced'));
      const consumed = entries.filter((e) => e.type === 'Offer' && (e.summary.includes('consumed') || e.summary.includes('partly'))).length;
      const placed = entries.some((e) => e.type === 'Offer' && e.action === 'created' && e.account === tx.Account);
      const parts = [`${who} offered ${gets ? formatAmount(gets) : '?'}${issuerOf(tx.TakerGets)} for ${pays ? formatAmount(pays) : '?'}${issuerOf(tx.TakerPays)}`];
      if (consumed) parts.push(`crossing ${consumed} existing offer${consumed === 1 ? '' : 's'}`);
      parts.push(placed ? 'the rest was placed on the book' : consumed ? 'filled entirely' : 'nothing was placed');
      if (replaced) parts.push(`replacing its earlier offer #${tx.OfferSequence}`);
      return `${parts.join('; ')}. ${feeText}`.trim();
    }
    case 'OfferCancel':
      return `${who} cancelled its offer #${tx.OfferSequence}. ${feeText}`.trim();
    case 'TrustSet': {
      const lim = parseAmount(tx.LimitAmount);
      return `${who} set a trust line for ${lim ? formatAmount(lim) : '?'}${issuerOf(tx.LimitAmount)}${lim && lim.value === 0 ? ' (removing it, if nothing is owed)' : ''}. ${feeText}`.trim();
    }
    case 'NFTokenCreateOffer': {
      const sell = (Number(tx.Flags) & 1) === 1;
      return `${who} ${sell ? 'offered to sell' : 'offered to buy'} NFT ${String(tx.NFTokenID ?? '').slice(0, 10)}… for ${amountText(tx.Amount)}${tx.Expiration ? `, until ${rippleTimeToIso(tx.Expiration)}` : ''}. ${feeText}`.trim();
    }
    case 'NFTokenMint':
      return `${who} minted an NFT (taxon ${tx.NFTokenTaxon ?? '?'}). ${feeText}`.trim();
    case 'NFTokenAcceptOffer':
      return `${who} accepted an NFT offer. ${feeText}`.trim();
    case 'NFTokenBurn':
      return `${who} burned NFT ${String(tx.NFTokenID ?? '').slice(0, 10)}…. ${feeText}`.trim();
    case 'EscrowCreate':
      return `${who} locked ${amountText(tx.Amount)} in escrow for ${shortAddress(tx.Destination)}. ${feeText}`.trim();
    case 'EscrowFinish':
      return `${who} released the escrow #${tx.OfferSequence} of ${shortAddress(tx.Owner)}. ${feeText}`.trim();
    case 'EscrowCancel':
      return `${who} cancelled the escrow #${tx.OfferSequence} of ${shortAddress(tx.Owner)}. ${feeText}`.trim();
    case 'AccountSet':
      return `${who} changed its account settings${tx.Domain ? ` (domain ${decodeDomain(tx.Domain)})` : ''}. ${feeText}`.trim();
    case 'TicketCreate':
      return `${who} created ${tx.TicketCount ?? 1} ticket${Number(tx.TicketCount) === 1 ? '' : 's'}. ${feeText}`.trim();
    case 'AMMDeposit':
    case 'AMMWithdraw':
    case 'AMMCreate':
    case 'AMMBid':
    case 'AMMVote':
      return `${who} ${tx.TransactionType.replace('AMM', 'AMM ').toLowerCase()}. ${feeText}`.trim();
    default:
      return `${who} submitted a ${tx.TransactionType}. ${feeText}`.trim();
  }
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

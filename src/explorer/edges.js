// xrpl-sonic explorer — the edges of the constellation.
//
// Two kinds of line join the account to the stars around it, and each line
// says what it is by how it is drawn.
//
// A trust line (from account_lines) is one edge per line, in the colour of
// its currency, as wide as its balance, with an arrowhead on the trusted
// side: at the star when this account has set a limit toward the peer
// (`out`), at the centre when the peer has set one toward this account
// (`in`), both when both have (`both`), none for a line kept only by its
// balance (`none`). Its side is who holds whose issue: `holds` when the
// balance is positive (this account holds the peer's issue), `issued` when
// negative (the peer holds this account's issue), `empty` at zero.
//
// A transaction (from account_tx) is one strand per counterparty it names,
// in the colour of its category (the field guide's: payment, offer, trust,
// …), as wide as its amount, with an arrowhead at the receiving end when
// value went from this account to the star (`out`) or from the star to this
// account (`in`); dashed when it failed, dotted when it was a partial
// payment, and with a bead near the star in the colour of its currency.
//
// Widths are the amount on a log scale in the amount's own units, against
// the largest drawn; currencies are not converted. Currency hues are the
// same for a name wherever it appears, nudged apart on one page so no two
// look alike; XRP keeps its own blue.
//
// Pure: no DOM.

import { CATEGORIES, categorize, decodeCurrency, extractAmount, formatAmount, hashString, parseAmount, shortAddress } from '../mapping.js';
import { sigilPattern } from './sigil.js';

export const MAX_EDGES = 24;
export const MAX_STRANDS = 120;
export const MAX_PARTIES = 48;
export const MIN_HUE_GAP = 30;
export const DIRECTIONS = Object.freeze(['out', 'in', 'both', 'none']);
export const SIDES = Object.freeze(['holds', 'issued', 'empty']);
export const RELATIONS = Object.freeze(['recipient', 'sender', 'issuer', 'party']);
export const XRP_RGB = Object.freeze([76, 201, 240]);
const TF_PARTIAL_PAYMENT = 0x20000;

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

export const hexToRgb = (hex) => {
  const n = parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** The category an account mostly dealt in with a counterparty, from counterparties() counts. */
export function dominantCategory(categories) {
  let best = 'other';
  let n = -1;
  for (const [k, v] of Object.entries(categories ?? {})) if (v > n) [best, n] = [k, v];
  return best;
}

/** The colour of a transaction counterparty: what they mostly did together, in the field guide's colours. */
export function partyColour(party) {
  return hexToRgb(CATEGORIES[dominantCategory(party?.categories)]?.colour ?? CATEGORIES.other.colour);
}

/** The name shown for a currency code: decoded where it can be, cut to 8 characters. */
export function currencyName(code) {
  return decodeCurrency(code).slice(0, 8);
}

/** The hue a currency has on its own, from its shown name, so USD is the same colour on every page. */
export function baseHue(name) {
  return hashString(`currency:${name}`) % 360;
}

/** The shorter way round the hue circle between two hues, in degrees. */
export function hueGap(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

/**
 * Hues for currency names, most prominent first. Each keeps its own hue when
 * that is at least MIN_HUE_GAP degrees from every hue already given;
 * otherwise it takes the middle of the widest free arc, which is as far from
 * the others as it can be. So up to six currencies are never closer than 30°,
 * twelve never closer than 15°, and the most prominent always keep their own.
 * XRP is skipped: it has its own blue. Deterministic for the same names in
 * the same order.
 * @returns {Map<string, number>} name → hue
 */
export function assignHues(names) {
  const hues = new Map();
  const taken = [];
  for (const name of names ?? []) {
    if (!name || name === 'XRP' || hues.has(name)) continue;
    let hue = baseHue(name);
    if (!taken.every((t) => hueGap(hue, t) >= MIN_HUE_GAP)) {
      const sorted = [...taken].sort((a, b) => a - b);
      let best = { gap: -1, at: hue };
      sorted.forEach((h, i) => {
        const next = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + 360;
        const gap = next - h;
        if (gap > best.gap) best = { gap, at: (h + gap / 2) % 360 };
      });
      hue = best.at;
    }
    hue = Math.round(hue) % 360;
    taken.push(hue);
    hues.set(name, hue);
  }
  return hues;
}

/** CSS colour for a hue, in the constellation's lightness. */
export function hueCss(hue, alpha = 1) {
  return alpha >= 1 ? `hsl(${hue} 70% 68%)` : `hsl(${hue} 70% 68% / ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

/** The same colour as [r, g, b] for the canvas gradients. */
export function rgbOfHue(hue, s = 0.7, l = 0.68) {
  const h = (((hue % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)].map((c) => Math.round(c * 255));
}

/** The [r, g, b] of a currency name: XRP's blue, else its hue. */
export function currencyRgb(name, hues) {
  if (name === 'XRP') return [...XRP_RGB];
  const hue = hues?.get?.(name) ?? baseHue(name);
  return rgbOfHue(hue);
}

/** Width in (0, 1]: an amount on a log scale against the largest shown; 0 for none. */
export function widthOf(value, top) {
  if (!(value > 0) || !(top > 0)) return 0;
  return Math.min(1, 0.15 + (0.85 * Math.log1p(value)) / Math.log1p(top));
}

/** The number formatting the tooltip uses for balances and limits. */
export function fmtValue(n) {
  const v = Math.abs(Number(n) || 0);
  return v.toLocaleString('en-US', { maximumFractionDigits: v >= 1000 ? 2 : 6 });
}

// ---------------------------------------------------------------------------
// Trust lines
// ---------------------------------------------------------------------------

function edgeOf(line) {
  const balance = Number(line.balance) || 0;
  const limit = Number(line.limit) || 0;
  const limitPeer = Number(line.limit_peer) || 0;
  return {
    kind: 'trust',
    address: line.account,
    code: line.currency,
    name: currencyName(line.currency),
    balance,
    limit,
    limitPeer,
    direction: limit > 0 && limitPeer > 0 ? 'both' : limit > 0 ? 'out' : limitPeer > 0 ? 'in' : 'none',
    side: balance > 0 ? 'holds' : balance < 0 ? 'issued' : 'empty',
    width: 0,
    hue: 0,
  };
}

/**
 * Edges from account_lines entries, largest balance first, then the largest
 * limit, then by name and address so the order is stable. Only `max` are
 * drawn, but the hues cover every line, so a currency keeps its colour
 * whether or not its lines made the cut. Pass `hues` to share one palette
 * with the transaction strands.
 * @returns {{ edges: object[], total: number, names: string[], currencies: { name, hue, lines, drawn }[] }}
 */
export function trustEdges(lines, { max = MAX_EDGES, hues = null } = {}) {
  const all = (lines ?? [])
    .filter((l) => l && typeof l.account === 'string' && typeof l.currency === 'string')
    .map(edgeOf)
    .filter((e) => e.balance !== 0 || e.limit !== 0 || e.limitPeer !== 0);
  all.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance) || Math.max(b.limit, b.limitPeer) - Math.max(a.limit, a.limitPeer) || a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
  const names = [];
  for (const e of all) if (!names.includes(e.name)) names.push(e.name);
  const palette = hues ?? assignHues(names);
  for (const e of all) e.hue = palette.get(e.name) ?? baseHue(e.name);
  const edges = all.slice(0, max);
  const top = edges.reduce((m, e) => Math.max(m, Math.abs(e.balance)), 0);
  for (const e of edges) e.width = widthOf(Math.abs(e.balance), top);
  const currencies = names.map((name) => ({ name, hue: palette.get(name) ?? baseHue(name), lines: all.filter((e) => e.name === name).length, drawn: edges.filter((e) => e.name === name).length }));
  return { edges, total: all.length, names, currencies };
}

/** One sentence for a trust line, from this account's side: "USD: holds 599,665.53 of its issue · this account trusts it (limit 1,000,000,000)". */
export function describeEdge(e) {
  const side = e.side === 'holds' ? `holds ${fmtValue(e.balance)} of its issue` : e.side === 'issued' ? `issued ${fmtValue(e.balance)} to it` : 'no balance';
  const direction =
    e.direction === 'both'
      ? `trust both ways (limits ${fmtValue(e.limit)} / ${fmtValue(e.limitPeer)})`
      : e.direction === 'out'
        ? `this account trusts it (limit ${fmtValue(e.limit)})`
        : e.direction === 'in'
          ? `it trusts this account (limit ${fmtValue(e.limitPeer)})`
          : 'no limit either way';
  return `${e.name}: ${side} · ${direction}`;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * The counterparties a transaction names, from this account's side, by the
 * same rules as counterparties() in anatomy.js: the sender, the destination,
 * and the issuers of its amounts. `relation` is `recipient` (this account
 * sent to them), `sender` (they sent to this account), `issuer` (they issue
 * an amount in it) or `party` (named, but value did not pass between the two).
 */
export function partiesOf(tx, account) {
  const parties = [];
  const add = (address, relation) => {
    if (typeof address !== 'string' || !address || address === account || parties.some((p) => p.address === address)) return;
    parties.push({ address, relation });
  };
  if (tx.Account !== account) add(tx.Account, tx.Destination === account ? 'sender' : 'party');
  if (tx.Destination && tx.Destination !== account) add(tx.Destination, tx.Account === account ? 'recipient' : 'party');
  for (const side of [tx.TakerGets, tx.TakerPays, tx.LimitAmount, tx.Amount, tx.SendMax]) {
    if (side && typeof side === 'object' && side.issuer && side.issuer !== account) add(side.issuer, 'issuer');
  }
  return parties;
}

/** The currency, among a transaction's amounts, that a party issues; null when they issue none of them. */
export function issuedBy(tx, address) {
  for (const side of [tx.Amount, tx.DeliverMax, tx.TakerGets, tx.TakerPays, tx.LimitAmount, tx.SendMax]) {
    if (side && typeof side === 'object' && side.issuer === address && typeof side.currency === 'string') return currencyName(side.currency);
  }
  return null;
}

function strandOf(entry, account) {
  const tx = entry?.tx ?? entry?.tx_json;
  if (!tx || typeof tx !== 'object') return [];
  const meta = entry.meta ?? null;
  const result = meta?.TransactionResult ?? null;
  const amount = extractAmount(tx, meta);
  const category = categorize(tx.TransactionType);
  const flags = Number(tx.Flags) || 0;
  const base = {
    kind: 'tx',
    hash: tx.hash ?? entry.hash ?? null,
    type: tx.TransactionType ?? 'unknown',
    category,
    rgb: hexToRgb(CATEGORIES[category]?.colour ?? CATEGORIES.other.colour),
    amount,
    value: amount && Number.isFinite(amount.value) ? Math.abs(amount.value) : 0,
    currency: amount ? (amount.isXrp ? 'XRP' : currencyName(amount.currency)) : null,
    success: result === 'tesSUCCESS',
    result,
    partial: tx.TransactionType === 'Payment' && (flags & TF_PARTIAL_PAYMENT) !== 0,
    ledgerIndex: Number(tx.ledger_index ?? entry.ledger_index) || null,
    date: tx.date ?? null,
    width: 0,
    hue: null,
  };
  return partiesOf(tx, account).map((p) => ({
    ...base,
    address: p.address,
    relation: p.relation,
    direction: p.relation === 'recipient' ? 'out' : p.relation === 'sender' ? 'in' : 'none',
    by: tx.Account === account ? 'this' : tx.Account === p.address ? 'party' : 'other',
    from: tx.Account ?? null,
    to: tx.Destination ?? null,
    issues: issuedBy(tx, p.address),
    gives: tx.TakerGets != null ? parseAmount(tx.TakerGets) : null,
    wants: tx.TakerPays != null ? parseAmount(tx.TakerPays) : null,
  }));
}

/**
 * Strands from account_tx entries, in the order given (account_tx is newest
 * first, and "Load older" appends), one per counterparty a transaction
 * names. Only `max` are drawn. Pass `hues` to share one palette with the
 * trust lines.
 * @returns {{ strands: object[], total: number, names: string[], categories: { name, label, rgb, count, drawn }[] }}
 */
export function transactionStrands(entries, account, { max = MAX_STRANDS, hues = null } = {}) {
  const all = (entries ?? []).flatMap((entry) => strandOf(entry, account));
  const names = [];
  for (const s of all) if (s.currency && s.currency !== 'XRP' && !names.includes(s.currency)) names.push(s.currency);
  const palette = hues ?? assignHues(names);
  for (const s of all) s.hue = s.currency && s.currency !== 'XRP' ? (palette.get(s.currency) ?? baseHue(s.currency)) : null;
  const strands = all.slice(0, max);
  const top = strands.reduce((m, s) => Math.max(m, s.value), 0);
  for (const s of strands) s.width = widthOf(s.value, top);
  const seen = [];
  for (const s of all) if (!seen.includes(s.category)) seen.push(s.category);
  const categories = seen.map((name) => ({ name, label: CATEGORIES[name]?.label ?? name, rgb: hexToRgb(CATEGORIES[name]?.colour ?? CATEGORIES.other.colour), count: all.filter((s) => s.category === name).length, drawn: strands.filter((s) => s.category === name).length }));
  return { strands, total: all.length, names, categories };
}

/**
 * One line for a strand, from this account's side, naming who did what:
 * "Payment · sent 1.7 XRP to it", "OfferCreate · its offer: gives 1,462 RLUSD
 * for 1,094 XRP", "OfferCreate · failed (tecKILLED) · gives 50 XRP for 8,136
 * ARMY · it issues ARMY". "it" is the star; a third account is named short.
 */
export function describeStrand(s) {
  const head = [s.type, s.success ? '' : `failed (${s.result ?? 'unknown'})`, s.partial ? 'partial payment' : ''].filter(Boolean);
  const whose = s.by === 'party' ? 'its' : s.by === 'other' && s.from ? `${shortAddress(s.from)}’s` : ''; // '' when this account submitted it
  const amount = s.amount ? formatAmount(s.amount) : '';
  let body = '';
  if (s.type === 'OfferCreate' && (s.gives || s.wants)) body = `${whose ? `${whose} offer: ` : ''}gives ${s.gives ? formatAmount(s.gives) : '?'} for ${s.wants ? formatAmount(s.wants) : '?'}`;
  else if (s.type === 'OfferCancel') body = whose ? `${whose} offer cancelled` : 'cancels an offer';
  else if (s.type === 'TrustSet' && s.amount) body = `${whose ? `${whose} trust line, ` : ''}limit ${amount}`;
  else if (s.relation === 'recipient') body = amount ? `sent ${amount} to it` : 'to it';
  else if (s.relation === 'sender') body = amount ? `received ${amount} from it` : 'from it';
  else if (s.type === 'Payment' && s.by === 'party') body = s.to === s.address ? `it paid itself ${amount}` : `it sent ${amount} to ${s.to ? shortAddress(s.to) : 'someone'}`;
  else if (s.type === 'Payment' && s.to === s.address) body = `${s.from ? shortAddress(s.from) : 'someone'} sent ${amount} to it`;
  else if (s.type === 'Payment' && s.from && s.to) body = `${shortAddress(s.from)} sent ${amount} to ${shortAddress(s.to)}`;
  else if (amount) body = whose ? `${whose} ${amount}` : amount;
  else if (whose) body = `${whose} transaction`;
  const tail = s.issues ? `it issues ${s.issues}` : '';
  return [...head, body, tail].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// Stars and the model
// ---------------------------------------------------------------------------

/** A deterministic place on the sphere for an address: nearer for a lower rank, in a band about the equator. */
export function positionOf(address, rank) {
  const radius = 0.55 + rank * 0.55 + ((hashString(`${address}:r`) % 1000) / 1000 - 0.5) * 0.08;
  const theta = ((hashString(address) % 3600) / 3600) * Math.PI * 2;
  const phi = ((hashString(`${address}:e`) % 1000) / 1000 - 0.5) * 0.9;
  return [radius * Math.cos(phi) * Math.cos(theta), radius * Math.sin(phi), radius * Math.cos(phi) * Math.sin(theta)];
}

/**
 * The stars: one per transaction counterparty (the first `maxParties`,
 * nearest the most frequent) and one per trust-line counterparty not already
 * among them (nearest the largest balance). A star that is both carries
 * both. A transaction counterparty is coloured by what they mostly did
 * together; a trust-only star takes the hue of its widest line. Strands
 * attach to the star of their counterparty; a strand whose counterparty has
 * no star (beyond `maxParties`) is not drawn. `labelled` marks the few that
 * get a name without hovering.
 * @param {object[]} parties  from counterparties() in src/explorer/anatomy.js
 * @param {object[]} edges  from trustEdges()
 * @param {object[]} [strands]  from transactionStrands()
 */
export function starsOf(parties, edges, strands = [], { maxParties = MAX_PARTIES, colourOf = partyColour } = {}) {
  const list = (parties ?? []).slice(0, maxParties);
  const maxCount = Math.max(1, ...list.map((p) => p.count));
  const stars = new Map();
  list.forEach((p, i) => {
    const strength = Math.log1p(p.count) / Math.log1p(maxCount);
    const rank = i / Math.max(1, list.length - 1);
    stars.set(p.address, {
      address: p.address,
      party: p,
      trust: [],
      strands: [],
      rank,
      pos: positionOf(p.address, rank),
      size: 2.6 + 4.6 * strength,
      weight: 0.4 + 1.8 * strength,
      rgb: colourOf(p),
      hue: sigilPattern(p.address).hue,
      label: p.label ?? shortAddress(p.address),
      labelled: i < 7,
    });
  });
  const peers = [];
  for (const e of edges ?? []) if (!peers.includes(e.address)) peers.push(e.address);
  peers.forEach((address, i) => {
    const mine = (edges ?? []).filter((e) => e.address === address);
    let s = stars.get(address);
    if (!s) {
      const rank = i / Math.max(1, peers.length - 1);
      const widest = mine.reduce((m, e) => Math.max(m, e.width), 0);
      s = {
        address,
        party: null,
        trust: [],
        strands: [],
        rank,
        pos: positionOf(address, rank),
        size: 2.6 + 3.4 * widest,
        weight: 0,
        rgb: rgbOfHue(mine[0].hue),
        hue: sigilPattern(address).hue,
        label: shortAddress(address),
        labelled: i < 5,
      };
      stars.set(address, s);
    }
    s.trust = mine;
  });
  for (const strand of strands ?? []) stars.get(strand.address)?.strands.push(strand);
  return [...stars.values()];
}

/**
 * Everything the canvas draws, from the account's parts: the stars with
 * their trust lines and strands attached, one palette of currency hues
 * shared by both (trust lines first, by balance, then the currencies the
 * transactions moved), the orbits, and the counts for the caption.
 * @param {{ account: string, parties?: object[], entries?: object[], lines?: object[] }} data
 */
export function constellationModel({ account, parties = [], entries = [], lines = [] } = {}) {
  const trustNames = trustEdges(lines).names;
  const strandNames = transactionStrands(entries, account).names;
  const hues = assignHues([...trustNames, ...strandNames]);
  const trust = trustEdges(lines, { hues });
  const txs = transactionStrands(entries, account, { hues });
  const stars = starsOf(parties, trust.edges, txs.strands);
  const drawnStrands = stars.reduce((n, s) => n + s.strands.length, 0);
  const currencies = [...hues].map(([name, hue]) => ({ name, hue, rgb: rgbOfHue(hue) }));
  if (txs.strands.some((s) => s.currency === 'XRP')) currencies.unshift({ name: 'XRP', hue: null, rgb: [...XRP_RGB] });
  return {
    stars,
    edges: trust.edges,
    strands: txs.strands,
    hues,
    currencies,
    categories: txs.categories,
    orbits: orbitsOf(lines, hues),
    counts: { stars: stars.length, trust: { drawn: trust.edges.length, total: trust.total }, strands: { drawn: drawnStrands, total: txs.total, attached: txs.strands.length } },
  };
}

/** World-unit radius of a balance's orbit: a log scale, 1 XRP ≈ 0.16, 100M XRP ≈ 0.56. */
export function orbitRadius(value) {
  const v = Math.max(0, Number(value) || 0);
  return 0.12 + 0.055 * Math.log10(1 + v);
}

/** The currency orbits: one per held balance (the twelve largest), on its own tilted plane, in its currency's hue. */
export function orbitsOf(lines, hues = null) {
  const held = (lines ?? [])
    .filter((l) => l && typeof l.currency === 'string' && Math.abs(Number(l.balance)) > 0)
    .sort((a, b) => Math.abs(Number(b.balance)) - Math.abs(Number(a.balance)))
    .slice(0, 12);
  return held.map((l, i) => {
    const name = currencyName(l.currency);
    const seed = hashString(`${l.currency}:${l.account ?? l.issuer ?? ''}`);
    return {
      name,
      address: l.account ?? l.issuer ?? null,
      balance: Number(l.balance),
      hue: hues?.get?.(name) ?? baseHue(name),
      r: orbitRadius(Math.abs(Number(l.balance))) + 0.05 + i * 0.035,
      tilt: 0.25 + (((seed >>> 8) % 100) / 100) * 0.9,
      turn: ((seed >>> 16) % 628) / 100,
      speed: 0.08 + ((seed >>> 4) % 10) / 100,
      phase: ((seed >>> 20) % 628) / 100,
    };
  });
}

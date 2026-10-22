// xrpl-sonic explorer — the views, as DOM.
//
// Every builder takes plain data and returns elements; the application module
// fetches, wires sound and navigation, and hands results here.

import { el, svg } from '../dom.js';
import { CATEGORIES, categorize, parseAmount, formatAmount, shortAddress, txToEvent } from '../mapping.js';
import { eventIcon, categoryIcon, fieldGuide } from '../glyphs.js';
import { explorerUrl, EXPLORERS, EXTERNAL_EXPLORER_NAMES, listenerUrl } from '../explorers.js';
import { sigilSvg } from './sigil.js';
import { project, referenceScale, ringPoints } from '../projection.js';
import { formatRoute } from './route.js';
import { validateCase, encodeCase } from '../case.js';
import { buildHash } from '../params.js';
import { momentFromTransaction } from '../moment.js';
import { balanceChanges, describeAffected, explain, resultMeaning, rippleTimeToIso, decodeDomain, decodeFlags, reserveFor, asStreamMessage, typeMix } from './anatomy.js';

export const ALL_TYPES = Object.freeze({ includeFailed: true, quietThreshold: 0 });

const fmt = (n, digits = 6) => Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });
const fmtInt = (n) => Number(n).toLocaleString('en-US');

/** Short absolute time from Ripple-epoch seconds: "2026-10-20 05:58:02Z". */
export function timeText(rippleSeconds) {
  const iso = rippleTimeToIso(rippleSeconds);
  return iso ? iso.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z') : '—';
}

/** How long ago, for a Ripple-epoch time. */
export function ago(rippleSeconds, now = Date.now()) {
  const iso = rippleTimeToIso(rippleSeconds);
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function copyBtn(text, what = 'Copy') {
  const b = el('button', { type: 'button', class: 'icon-btn copy', text: 'copy', title: `${what} to the clipboard` });
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      b.textContent = 'copied';
      setTimeout(() => (b.textContent = 'copy'), 1400);
    } catch {
      b.textContent = 'no clipboard';
    }
  });
  return b;
}

/** An address as a link with its sigil. */
export function addrLink(address, { self = false, label = null, size = 14, full = false } = {}) {
  if (!address) return el('span', { class: 'mono', text: '—' });
  return el('a', { class: `addr${self ? ' self' : ''}`, href: formatRoute({ name: 'account', address }), title: address }, [svg(sigilSvg(address, size)), el('span', { text: label ?? (full ? address : shortAddress(address)) })]);
}

export function amountNode(amount) {
  const p = parseAmount(amount);
  if (!p) return el('span', { class: 'mono', text: '—' });
  const node = el('span', { class: 'amount mono', text: formatAmount(p) });
  if (p.issuer) node.append(' ', addrLink(p.issuer, { size: 12 }));
  return node;
}

export function badge(text, cls = '') {
  return el('span', { class: `badge ${cls}`, text });
}

function typeBadge(txType) {
  const c = CATEGORIES[categorize(txType)];
  return el('span', { class: 'badge type', style: `--glyph: ${c.colour}`, text: txType });
}

function externalLinks(kind, id, network) {
  return EXTERNAL_EXPLORER_NAMES.map((k) => {
    const href = explorerUrl(k, network, kind, id);
    return href ? el('a', { class: 'btn small', href, target: '_blank', rel: 'noopener noreferrer', text: EXPLORERS[k].label }) : '';
  });
}

// ---------------------------------------------------------------------------
// Tape rows (account and ledger views)
// ---------------------------------------------------------------------------

/**
 * One transaction as a tape row. `entry` is an account_tx entry or a ledger
 * transaction (with metaData). Returns { li, event }.
 */
export function txRow(entry, { account = null, onHover } = {}) {
  const msg = entry.tx || entry.tx_json ? asStreamMessage(entry) : { type: 'transaction', transaction: entry, meta: entry.metaData ?? entry.meta ?? null, hash: entry.hash, ledger_index: entry.ledger_index, engine_result: (entry.metaData ?? entry.meta)?.TransactionResult, validated: true, date: entry.date };
  const event = txToEvent(msg, ALL_TYPES);
  const tx = msg.transaction;
  const failed = !(event?.success ?? msg.engine_result === 'tesSUCCESS');
  const what = el('span', { class: 'what' });
  what.append(typeBadge(tx.TransactionType));
  if (event?.amount) what.append(amountNode(tx.TransactionType === 'Payment' ? (msg.meta?.delivered_amount ?? tx.DeliverMax ?? tx.Amount) : event.amount.isXrp ? String(Math.round(event.amount.value * 1e6)) : { currency: event.amount.currency, issuer: event.amount.issuer, value: String(event.amount.value) }));
  const parties = event?.parties ?? [];
  parties.forEach((p, i) => {
    what.append(el('span', { class: 'arrow', text: i === 0 ? '' : p.separator.trim() }));
    what.append(addrLink(p.address, { self: p.address === account, size: 12 }));
  });
  if (!parties.length && tx.Account) what.append(addrLink(tx.Account, { self: tx.Account === account, size: 12 }));
  const li = el('li', { class: failed ? 'failed' : '', style: `--glyph: ${event?.colour ?? '#8d99ae'}`, 'data-hash': msg.hash ?? '', tabindex: '0', role: 'link', 'aria-label': `${tx.TransactionType} ${msg.hash ?? ''}` }, [
    el('span', { class: 'ts', text: msg.date != null ? timeText(msg.date) : msg.ledger_index != null ? `#${fmtInt(msg.ledger_index)}` : '', title: msg.date != null ? ago(msg.date) : '' }),
    event ? svg(eventIcon(event, 14)) : el('span', { class: 'glyph' }),
    what,
    failed ? el('span', { class: 'result', text: msg.engine_result ?? 'failed', title: resultMeaning(msg.engine_result) }) : el('a', { class: 'ledger-ref', href: formatRoute({ name: 'ledger', index: msg.ledger_index ?? 0 }), text: msg.ledger_index != null ? `#${fmtInt(msg.ledger_index)}` : '' }),
  ]);
  const open = () => {
    if (msg.hash) location.hash = formatRoute({ name: 'tx', hash: msg.hash });
  };
  li.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    open();
  });
  li.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') open();
  });
  if (onHover && event) li.addEventListener('pointerenter', () => onHover(event));
  return { li, event };
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

export function renderHome({ examples = [], onRandom }) {
  const hero = el('section', { class: 'card hero home-hero' }, [
    el('h1', { text: 'Explorer' }),
    el('p', { class: 'sub label', text: 'Read the XRP Ledger, then listen to it' }),
    el('p', { text: 'Paste anything into the box above: an account, a transaction hash, a ledger index, a currency code. An account is drawn as orbits and a constellation; a transaction is explained from its own metadata, who paid whom and what changed; a ledger is laid out as a plate. Point at any record with Sound on and you hear it.' }),
    el('div', { class: 'examples' }, [
      ...examples.map((ex) => el('a', { class: 'btn small', href: ex.href, text: ex.label, title: ex.title ?? '' })),
      el('button', { type: 'button', class: 'btn small', text: 'Take me somewhere (R)', title: 'A random account from the latest ledger', onclick: () => onRandom?.() }),
    ]),
  ]);
  const latestCard = el('section', { class: 'card', id: 'latest-card' }, [el('h2', { text: 'Latest ledgers' }), el('ol', { class: 'ledger-list', id: 'latest-list' }, [el('li', { class: 'skeleton', text: 'connecting…' })])]);
  const guide = el('section', { class: 'card' }, [
    el('h2', { text: 'The field guide' }),
    el('div', { class: 'mix-legend' }, fieldGuide().map((g) => el('span', { class: 'mix-label', style: `--c: ${g.colour}`, title: g.track }, [svg(categoryIcon(g.category, 14)), el('span', { text: `${g.label} · ${g.sound}` })]))),
    el('p', { class: 'hint', text: 'Every transaction type has a shape, a colour and a sound, the same here as on the listening page.' }),
  ]);
  const how = el('section', { class: 'card' }, [
    el('h2', { text: 'What is different here' }),
    el('ul', { class: 'feature-list' }, [
      el('li', { text: 'A transaction is explained from its metadata: balance changes for every account it touched, offers placed, replaced or consumed, trust lines moved, and what a failure code means.' }),
      el('li', { text: 'An account is a place: its XRP as a ring, its reserve as the disc inside, each currency it holds as an orbit, and the accounts it dealt with as stars, nearest the most frequent.' }),
      el('li', { text: 'Every account has a sigil, a small mark derived from its address, so you recognise it again without reading it.' }),
      el('li', { text: 'Sound is a sense here too: point at a record to hear it, play an account’s recent history as a phrase, or open any account or ledger on the listening page.' }),
      el('li', { text: 'No backend, no account, no tracking: your browser reads a public node directly.' }),
    ]),
  ]);
  return [hero, el('div', { class: 'home-grid' }, [latestCard, guide, how])];
}

export function latestListItem(msg) {
  const index = Number(msg.ledger_index);
  return el('li', {}, [
    el('a', { href: formatRoute({ name: 'ledger', index }), text: `#${fmtInt(index)}` }),
    el('span', { class: 'hint', text: `${msg.txn_count ?? '?'} tx` }),
    el('span', { class: 'hint', text: timeText(msg.ledger_time) }),
  ]);
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

/**
 * The account page. Returns { nodes, tape, foot, constellationBox, fill } where
 * `fill(parts)` adds later-arriving parts (lines, objects, NFTs).
 */
export function renderAccount({ address, tag = null, info, network, reserve, onHover, onPlay, onListen, lines = null, objects = null, nfts = null, latestLedger = null }) {
  const data = info?.account_data ?? null;
  const flags = decodeFlags(info?.account_flags);
  const xrp = data ? Number(data.Balance) / 1e6 : 0;
  const res = reserveFor({ ownerCount: data?.OwnerCount ?? 0, reserveBase: reserve?.base, reserveInc: reserve?.inc });
  const domain = decodeDomain(data?.Domain ?? '');
  const identity = el('div', { class: 'identity' }, [
    svg(sigilSvg(address, 56)),
    el('div', { class: 'identity-main' }, [
      el('div', { class: 'identity-title' }, [el('span', { text: address }), copyBtn(address, 'Copy the address'), tag != null ? badge(`tag ${tag}`) : '', ...flags.map((f) => el('span', { class: 'flag', text: f }))]),
      el('div', { class: 'identity-sub' }, [
        domain ? el('a', { href: /^https?:\/\//.test(domain) ? domain : `https://${domain}`, target: '_blank', rel: 'noopener noreferrer', text: domain }) : el('span', { text: 'no domain set' }),
        data?.RegularKey ? el('span', {}, [document.createTextNode('regular key '), addrLink(data.RegularKey, { size: 12 })]) : '',
        data ? el('span', { text: `sequence ${fmtInt(data.Sequence)}` }) : '',
        info?.ledger_index ? el('span', { text: `as of ledger #${fmtInt(info.ledger_index)}` }) : '',
      ]),
    ]),
    el('div', { class: 'identity-actions' }, [
      el('button', { type: 'button', class: 'btn small', text: 'Play history (P)', title: 'Hear the recent transactions as a phrase', onclick: () => onPlay?.() }),
      el('a', { class: 'btn small', href: listenerUrl(network, `#cast=${address}~${encodeURIComponent(shortAddress(address))}`), text: 'Listen live', title: 'Open the listening page with this account in the cast', onclick: (e) => onListen?.(e) }),
      ...externalLinks('account', address, network),
    ]),
  ]);
  const readouts = el('div', { class: 'readouts' }, [
    readout('XRP balance', data ? fmt(xrp) : '—', 'big', data ? `${fmtInt(data.Balance)} drops` : ''),
    readout('Reserve', `${fmt(res.total, 2)} XRP`, '', `${fmt(res.base, 2)} base + ${data?.OwnerCount ?? 0} objects × ${fmt(reserve?.inc ?? 0.2, 2)}`),
    readout('Spendable', data ? fmt(Math.max(0, xrp - res.total)) : '—', xrp < res.total ? 'warn' : '', xrp < res.total ? 'below the reserve' : 'above the reserve'),
    readout('Owned objects', data ? fmtInt(data.OwnerCount) : '—', '', 'trust lines, offers, escrows…'),
  ]);
  const hero = el('section', { class: 'card hero' }, [identity, readouts]);
  const legend = el('div', { class: 'legend' });
  const legendFixed = () => [el('span', { style: '--c: #4cc9f0', text: 'XRP orbit' }), el('span', { style: '--c: #f9c74f', text: 'reserve' }), el('span', { style: '--c: #e8eefb', text: 'stars: nearer = more often' })];
  legend.replaceChildren(...legendFixed());
  const constellationBox = el('div', { class: 'constellation' }, [el('canvas', { 'aria-label': 'Balances as orbits, counterparties as a constellation, trust lines and transactions as the lines between' }), legend]);
  const coverage = el('p', { class: 'hint coverage', text: 'Reading the recent transactions…' });
  const constellationCard = el('section', { class: 'card' }, [
    el('h2', { text: 'Constellation' }),
    constellationBox,
    coverage,
    el('p', { class: 'hint', text: 'Stars are the accounts in the loaded transactions and the counterparties of the trust lines, placed on a sphere around the account, nearest the most frequent (or the largest balance); a transaction counterparty is coloured by what they mostly did together, a trust-line counterparty by its currency; a star’s ring is its sigil’s hue. Each line from the centre is one record. A trust line is drawn in its currency’s colour, as wide as its balance, with an arrowhead on the trusted side: at the star when this account trusts it, at the centre when it trusts this account, both when both do; dashed when it holds no balance. A transaction is a strand in the colour of its type, as wide as its amount, with an arrowhead at the receiving end when value moved between the two, a bead near the star in the colour of its currency, dashed when it failed, dotted when it was a partial payment. Lines to the same star fan out side by side. Each held currency orbits on its own tilted plane with a bead travelling along it. Point at a star to read every line to it, click to go there; drag to orbit the view, scroll to move closer, double-click to reset. Widths and orbits are log scales in each amount’s own units; currencies are not converted.' }),
  ]);
  const tape = el('ol', { class: 'tape', id: 'account-tape' }, [el('li', { class: 'skeleton', text: 'loading transactions…' })]);
  const foot = el('div', { class: 'tape-foot' });
  const tapeCard = el('section', { class: 'card' }, [el('h2', {}, [document.createTextNode('Recent transactions'), el('span', { class: 'count', id: 'tape-count' })]), tape, foot]);
  const linesCard = el('section', { class: 'card', id: 'lines-card' }, [el('h2', { text: 'Trust lines' }), el('p', { class: 'skeleton', text: 'loading…' })]);
  const objectsCard = el('section', { class: 'card', id: 'objects-card' }, [el('h2', { text: 'Ledger objects' }), el('p', { class: 'skeleton', text: 'loading…' })]);
  const nodes = [hero, el('div', { class: 'columns' }, [el('div', { class: 'stack' }, [constellationCard, linesCard, objectsCard]), el('div', { class: 'stack' }, [tapeCard])])];

  const known = { lines: null, objects: null, nfts: null };
  const failure = (what, part) => el('p', { class: 'hint err', text: `Could not read ${what}: ${part.error?.message ?? part.error?.code ?? 'error'}.` });

  function renderLines(part) {
    if (part.state === 'unavailable') {
      linesCard.replaceChildren(el('h2', { text: 'Trust lines' }), failure('the trust lines', part));
      return;
    }
    const rows = part.items.filter((l) => Number(l.balance) !== 0 || Number(l.limit) !== 0).sort((a, b) => Math.abs(Number(b.balance)) - Math.abs(Number(a.balance)));
    linesCard.replaceChildren(
      el('h2', {}, [document.createTextNode('Trust lines'), el('span', { class: 'count', text: String(rows.length) })]),
      rows.length
        ? el('table', { class: 'table' }, [
            el('thead', {}, [el('tr', {}, [el('th', { text: 'Currency' }), el('th', { text: 'Counterparty' }), el('th', { class: 'num', text: 'Balance' }), el('th', { class: 'num', text: 'Limit' })])]),
            el(
              'tbody',
              {},
              rows.slice(0, 60).map((l) =>
                el('tr', {}, [
                  el('td', { class: 'mono', text: decodeCurrencySafe(l.currency) }),
                  el('td', {}, [addrLink(l.account, { size: 12 })]),
                  el('td', { class: 'num', text: fmt(Number(l.balance), 6), title: `${l.balance} exactly` }),
                  el('td', { class: 'num', text: fmt(Number(l.limit), 2), title: `the other side allows ${fmt(Number(l.limit_peer), 2)}` }),
                ]),
              ),
            ),
          ])
        : el('p', { class: 'hint', text: 'No trust lines.' }),
      rows.length > 60 ? el('p', { class: 'hint', text: `Showing the 60 largest of ${rows.length}.` }) : '',
      part.state === 'partial' ? el('p', { class: 'hint', text: 'More than shown: this is the first page the node returned.' }) : '',
    );
  }

  function renderObjects(objects, nfts) {
    const chips = [];
    const notes = [];
    if (objects?.state === 'unavailable') notes.push(failure('the ledger objects', objects));
    else if (objects) {
      const counts = {};
      for (const o of objects.items) counts[o.LedgerEntryType] = (counts[o.LedgerEntryType] ?? 0) + 1;
      chips.push(
        ...Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .map(([type, n]) => el('span', { class: 'chip' }, [el('b', { text: String(n) }), el('span', { text: type })])),
      );
      if (objects.state === 'partial') notes.push(el('p', { class: 'hint', text: 'More than shown; counts are of the first page.' }));
    }
    if (nfts?.state === 'unavailable') notes.push(failure('the NFTs', nfts));
    else if (nfts?.items?.length) chips.push(el('span', { class: 'chip' }, [el('b', { text: String(nfts.items.length) }), el('span', { text: `NFT${nfts.items.length === 1 ? '' : 's'}` })]));
    objectsCard.replaceChildren(
      el('h2', { text: 'Ledger objects' }),
      chips.length ? el('div', { class: 'objects' }, chips) : objects && objects.state !== 'unavailable' && nfts ? el('p', { class: 'hint', text: 'Nothing owned beyond the account itself.' }) : '',
      ...notes,
      !objects || !nfts ? el('p', { class: 'skeleton', text: 'loading…' }) : '',
    );
  }

  /** Each part is { state: 'unavailable' | 'empty' | 'partial' | 'loaded', items, marker, error } from src/explorer/account.js. */
  function fill(parts) {
    Object.assign(known, parts);
    if (parts.lines) renderLines(known.lines);
    if (parts.objects || parts.nfts) renderObjects(known.objects, known.nfts);
  }

  function setCoverage(text) {
    coverage.textContent = text;
  }

  /** The legend from the constellation's model: the types the strands are coloured by, then the currencies. */
  function setLegend(model) {
    const items = legendFixed();
    for (const c of model?.categories ?? []) items.push(el('span', { style: `--c: rgb(${c.rgb.join(' ')})`, text: `${c.label} ×${c.count}` }));
    for (const c of model?.currencies ?? []) items.push(el('span', { class: 'currency', style: `--c: rgb(${c.rgb.join(' ')})`, text: c.name }));
    if (model?.counts?.trust?.total || model?.counts?.strands?.total) items.push(el('span', { class: 'note', text: 'arrow: who receives, who trusts · width: amount · dashed: failed or empty' }));
    legend.replaceChildren(...items);
  }
  return { nodes, tape, foot, constellationBox, fill, setCoverage, setLegend, xrp, reserve: res };
}

function readout(label, value, cls = '', note = '') {
  return el('div', { class: 'readout' }, [el('span', { class: 'readout-label', text: label }), el('span', { class: `readout-value ${cls}`, text: value }), note ? el('span', { class: 'readout-note', text: note }) : '']);
}

function decodeCurrencySafe(code) {
  const p = parseAmount({ currency: code, issuer: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp', value: '1' });
  return p ? p.currency : code;
}

export function renderAccountMissing(address, error) {
  return [
    el('section', { class: 'card hero' }, [
      el('div', { class: 'identity' }, [svg(sigilSvg(address, 56)), el('div', { class: 'identity-main' }, [el('div', { class: 'identity-title' }, [el('span', { text: address }), copyBtn(address)]), el('div', { class: 'identity-sub' }, [el('span', { text: error?.code === 'actNotFound' ? 'This account does not exist in the validated ledger: it was never funded, or it was deleted.' : `Could not load the account: ${error?.message ?? error}` })])])]),
    ]),
  ];
}

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

/**
 * "Open as moment in the listener": one ledger as the clip, this transaction
 * as the anchor, handed off the way the other listener links are (keeping the
 * network). The link starts as a plain replay of the ledger and becomes the
 * case link once it is encoded (docs/save-this-moment.md).
 */
function momentLink(network, tx, host) {
  const raw = momentFromTransaction({ network, ledgerIndex: tx.ledger_index, hash: tx.hash, ledgerHash: tx.ledger_hash ?? null, host });
  const c = raw ? validateCase(raw).case : null;
  if (!c) return '';
  const a = el('a', { class: 'btn small', href: listenerUrl(network, `#replay=${tx.ledger_index}`), text: 'Open as moment in the listener', title: 'Open the listening page on this ledger with this transaction as the anchor' });
  encodeCase(c)
    .then((encoded) => {
      a.href = listenerUrl(network, buildHash({ case: encoded }));
    })
    .catch(() => {});
  return a;
}

export function renderTx(result, { network, onHover, onFacts, host = '' }) {
  const tx = result;
  const meta = result.meta ?? result.metaData ?? {};
  const code = meta.TransactionResult ?? null;
  const ok = code === 'tesSUCCESS';
  const msg = { type: 'transaction', transaction: tx, meta, hash: tx.hash, ledger_index: tx.ledger_index, engine_result: code, validated: result.validated !== false, date: tx.date };
  const event = txToEvent(msg, ALL_TYPES);
  const changes = balanceChanges(meta);
  const explained = explain(tx, meta);
  const { entries, directories } = describeAffected(meta, tx, { facts: explained.facts });
  onFacts?.(explained.facts);
  const identity = el('div', { class: 'identity' }, [
    event ? el('span', { class: 'glyph-big', style: `--glyph: ${event.colour}` }, [svg(eventIcon(event, 56))]) : el('span'),
    el('div', { class: 'identity-main' }, [
      el('div', { class: 'identity-title' }, [typeBadge(tx.TransactionType), badge(code ?? 'unknown', ok ? 'ok' : 'err'), el('span', { class: 'mono', text: `${tx.hash.slice(0, 16)}…${tx.hash.slice(-8)}`, title: tx.hash }), copyBtn(tx.hash, 'Copy the hash')]),
      el('div', { class: 'identity-sub' }, [
        el('a', { href: formatRoute({ name: 'ledger', index: tx.ledger_index }), text: `ledger #${fmtInt(tx.ledger_index)}` }),
        el('span', { text: tx.date != null ? `${timeText(tx.date)} · ${ago(tx.date)}` : '' }),
        result.validated === false ? badge('not validated', 'err') : '',
        tx.ctid ? el('span', { class: 'mono', text: `ctid ${tx.ctid}` }) : '',
      ]),
    ]),
    el('div', { class: 'identity-actions' }, [
      event && onHover ? el('button', { type: 'button', class: 'btn small', text: 'Hear it', onclick: () => onHover(event) }) : '',
      el('a', { class: 'btn small', href: listenerUrl(network, `#replay=${tx.ledger_index}`), text: 'Replay its ledger', title: 'Open the listening page on this ledger' }),
      momentLink(network, tx, host),
      ...externalLinks('tx', tx.hash, network),
    ]),
  ]);
  // Every sentence keeps the ids of the rules it rests on, so "why does it say that?" is a lookup into the findings.
  const lede = el('p', { class: `lede${ok ? '' : ' err'}` }, explained.sentences.flatMap((sentence, i) => [i ? ' ' : '', el('span', { 'data-rules': sentence.rules.join(' '), 'data-findings': (sentence.findings ?? []).join(' '), title: `Rules: ${sentence.rules.join(', ')}`, text: sentence.text })]));
  const facts = el('dl', { class: 'facts' });
  const fact = (k, v) => {
    if (v == null || v === '') return;
    facts.append(el('dt', { text: k }), el('dd', {}, Array.isArray(v) ? v : [typeof v === 'string' ? document.createTextNode(v) : v]));
  };
  fact('From', [addrLink(tx.Account, { full: true, size: 14 })]);
  if (tx.Destination) fact('To', [addrLink(tx.Destination, { full: true, size: 14 }), tx.DestinationTag != null ? badge(`tag ${tx.DestinationTag}`) : '']);
  if (tx.SourceTag != null) fact('Source tag', String(tx.SourceTag));
  if (tx.Amount != null) fact(tx.TransactionType === 'Payment' ? 'Amount asked' : 'Amount', [amountNode(tx.DeliverMax ?? tx.Amount)]);
  if (meta.delivered_amount != null && meta.delivered_amount !== 'unavailable') fact('Delivered', [amountNode(meta.delivered_amount)]);
  if (tx.SendMax != null) fact('Send max', [amountNode(tx.SendMax)]);
  if (tx.TakerGets != null) fact('Gives', [amountNode(tx.TakerGets)]);
  if (tx.TakerPays != null) fact('Wants', [amountNode(tx.TakerPays)]);
  if (tx.LimitAmount != null) fact('Limit', [amountNode(tx.LimitAmount)]);
  if (tx.OfferSequence != null) fact('Offer sequence', String(tx.OfferSequence));
  if (tx.NFTokenID) fact('NFT', el('span', { class: 'mono', text: tx.NFTokenID }));
  if (tx.Expiration != null) fact('Expires', timeText(tx.Expiration));
  fact('Fee', `${fmtInt(tx.Fee)} drops`);
  fact('Sequence', tx.TicketSequence != null ? `ticket ${fmtInt(tx.TicketSequence)}` : fmtInt(tx.Sequence));
  if (tx.LastLedgerSequence != null) fact('Valid until ledger', `#${fmtInt(tx.LastLedgerSequence)}`);
  if (tx.Flags) fact('Flags', `0x${Number(tx.Flags).toString(16).padStart(8, '0')}`);
  if (Array.isArray(tx.Memos) && tx.Memos.length) fact('Memos', el('span', { class: 'mono', text: tx.Memos.map((m) => decodeDomain(m.Memo?.MemoData ?? '')).filter(Boolean).join(' · ') || `${tx.Memos.length} memo(s)` }));
  fact('Result', `${code ?? '—'} — ${resultMeaning(code)}`);
  const hero = el('section', { class: 'card hero' }, [identity, lede, facts]);

  const changesCard = el('section', { class: 'card' }, [
    el('h2', {}, [document.createTextNode('Balance changes'), el('span', { class: 'count', text: String(changes.length) })]),
    changes.length
      ? el(
          'ul',
          { class: 'changes' },
          changes.map((c) =>
            el('li', { class: 'change' }, [
              el('span', {}, [addrLink(c.account, { size: 14 }), c.created ? badge('created', 'ok') : '', c.deleted ? badge('deleted', 'err') : '', c.issuer ? el('span', { class: 'hint', text: ` ${c.currency} issued by ${shortAddress(c.issuer)}` }) : '']),
              el('span', { class: `delta ${c.delta > 0 ? 'plus' : c.delta < 0 ? 'minus' : ''}`, title: `exactly ${c.exact.delta} ${c.currency === 'XRP' ? 'drops' : c.currency} (${c.exact.before} → ${c.exact.after})` }, [document.createTextNode(`${c.delta > 0 ? '+' : ''}${fmt(c.delta)} ${c.currency}`), el('span', { class: 'range', text: `${fmt(c.before)} → ${fmt(c.after)}` })]),
            ]),
          ),
        )
      : el('p', { class: 'hint', text: 'No balance changed.' }),
  ]);
  const affectedCard = el('section', { class: 'card' }, [
    el('h2', {}, [document.createTextNode('Ledger entries touched'), el('span', { class: 'count', text: String(entries.length) })]),
    entries.length
      ? el(
          'ul',
          { class: 'affected' },
          entries.map((e) =>
            el('li', { 'data-rules': e.rules.join(' '), 'data-findings': e.findings.join(' ') }, [
              el('div', { class: 'summary' }, [el('span', { class: `action ${e.action}`, text: e.action }), el('span', { text: e.summary, title: `Rules: ${e.rules.join(', ')}` })]),
              e.details.length ? el('dl', { class: 'details' }, e.details.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: String(v), title: e.exact?.[k] ? `exactly ${e.exact[k]}` : null })])) : '',
            ]),
          ),
        )
      : el('p', { class: 'hint', text: 'No ledger entries touched.' }),
    directories ? el('p', { class: 'hint', text: `${directories} directory node${directories === 1 ? '' : 's'} (bookkeeping) not listed.` }) : '',
  ]);
  const why = el('section', { class: 'card' }, [
    el('details', { class: 'raw' }, [
      el('summary', { text: `Why it says that: ${explained.facts.findings.length} findings` }),
      el('p', { class: 'hint', text: 'Every sentence above rests on these. Each finding has a tier (observed, calculated, rule, hypothesis), a rule id and the fields it was read from; amounts are exact strings. The rules are documented in docs/facts.md.' }),
      el('pre', { text: JSON.stringify(explained.facts.findings, null, 2) }),
    ]),
  ]);
  const raw = el('section', { class: 'card' }, [el('details', { class: 'raw' }, [el('summary', { text: 'Raw transaction and metadata' }), el('pre', { text: JSON.stringify(result, null, 2) })])]);
  return [hero, el('div', { class: 'columns' }, [el('div', { class: 'stack' }, [changesCard, affectedCard]), el('div', { class: 'stack' }, [why, raw])])];
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export function renderLedger(ledger, { network, onHover, latestIndex = null }) {
  const index = Number(ledger.ledger_index);
  const txs = Array.isArray(ledger.transactions) ? ledger.transactions : [];
  const mix = typeMix(txs);
  const total = txs.length || 1;
  const identity = el('div', { class: 'identity' }, [
    el('span', { class: 'glyph-big', style: '--glyph: #c8dcff' }, [svg(eventIcon({ kind: 'ledger' }, 56))]),
    el('div', { class: 'identity-main' }, [
      el('div', { class: 'identity-title' }, [el('span', { text: `Ledger #${fmtInt(index)}` }), badge(ledger.closed ? 'validated' : 'open', ledger.closed ? 'ok' : ''), copyBtn(ledger.ledger_hash ?? '', 'Copy the ledger hash')]),
      el('div', { class: 'identity-sub' }, [
        el('span', { text: ledger.close_time != null ? `closed ${timeText(ledger.close_time)} · ${ago(ledger.close_time)}` : '' }),
        el('span', { text: `${fmtInt(txs.length)} transactions` }),
        ledger.total_coins ? el('span', { text: `${fmt(Number(ledger.total_coins) / 1e6, 0)} XRP in existence` }) : '',
        el('span', { class: 'mono', text: `${String(ledger.ledger_hash ?? '').slice(0, 12)}…`, title: ledger.ledger_hash ?? '' }),
      ]),
    ]),
    el('div', { class: 'identity-actions' }, [
      el('a', { class: 'btn small', href: formatRoute({ name: 'ledger', index: index - 1 }), text: '◀ Previous' }),
      latestIndex == null || index < latestIndex ? el('a', { class: 'btn small', href: formatRoute({ name: 'ledger', index: index + 1 }), text: 'Next ▶' }) : '',
      el('a', { class: 'btn small primary', href: listenerUrl(network, `#replay=${index}`), text: 'Replay with sound', title: 'Open the listening page on this ledger' }),
      ...externalLinks('ledger', index, network),
    ]),
  ]);
  const mixBar = el('div', { class: 'mix' }, mix.map((m) => el('span', { style: `--c: ${CATEGORIES[m.category].colour}; width: ${((m.count / total) * 100).toFixed(2)}%`, title: `${m.type}: ${m.count}` })));
  const legend = el('div', { class: 'mix-legend' }, mix.slice(0, 10).map((m) => el('span', { class: 'mix-label', style: `--c: ${CATEGORIES[m.category].colour}`, text: `${m.type} ${m.count}` })));
  const plate = el('div', { class: 'plate' }, [el('canvas', { 'aria-label': 'The ledger as a plate: every transaction at its pitch' })]);
  const hero = el('section', { class: 'card hero' }, [identity, mixBar, legend]);
  const plateCard = el('section', { class: 'card' }, [el('h2', { text: 'The plate' }), plate, el('p', { class: 'hint', text: 'Each transaction at the horizontal position of its pitch across the floor, as the listening page draws it: whales left, dust right; depth is the hash. Point at the tape with Sound on to hear them.' })]);
  const tape = el('ol', { class: 'tape' });
  const rows = txs.slice(0, 250).map((t) => txRow(t, { onHover }));
  for (const r of rows) tape.append(r.li);
  const tapeCard = el('section', { class: 'card' }, [el('h2', {}, [document.createTextNode('Transactions'), el('span', { class: 'count', text: String(txs.length) })]), txs.length ? tape : el('p', { class: 'hint', text: 'An empty ledger.' }), txs.length > 250 ? el('p', { class: 'hint', text: `Showing the first 250 of ${txs.length}.` }) : '']);
  return { nodes: [hero, el('div', { class: 'columns' }, [el('div', { class: 'stack' }, [plateCard]), el('div', { class: 'stack' }, [tapeCard])])], plate, events: rows.map((r) => r.event).filter(Boolean) };
}

/** Draw a ledger's events on the plate canvas in perspective: x by pitch across the floor, depth by hash, glyph colour and size. */
export function drawPlate(canvas, events, { yaw = 0.1 } = {}) {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const cam = { yaw, pitch: 0.5, distance: 1.3, fov: 0.9, target: [0, 0.1, 0.45] };
  const vp = { width: w, height: h };
  const ref = referenceScale(cam, vp);
  const P = (p) => project(p, cam, vp);
  const line = (a, b, style) => {
    const pa = P(a);
    const pb = P(b);
    if (!pa || !pb) return;
    ctx.strokeStyle = style;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  };
  ctx.lineWidth = 1;
  for (let i = 0; i <= 10; i++) line([i / 5 - 1, 0, 0], [i / 5 - 1, 0, 1], `rgba(128, 164, 224, ${i % 2 ? 0.05 : 0.14})`);
  for (let i = 0; i <= 6; i++) line([-1, 0, i / 6], [1, 0, i / 6], `rgba(128, 164, 224, ${i === 0 ? 0.3 : 0.05})`);
  ctx.font = '500 9px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillStyle = 'rgba(128, 164, 224, 0.65)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ['C2', 'C3', 'C4', 'C5', 'C6', 'C7'].forEach((l, i) => {
    const p = P([i / 2.5 - 1, 0, -0.06]);
    if (p) ctx.fillText(l, p.x, p.y);
  });
  const pts = [];
  for (const ev of events) {
    const px = Math.min(1, Math.max(0, (ev.pitch - 36) / 60)) * 2 - 1;
    const seed = parseInt(String(ev.hash ?? '0').slice(0, 6), 16) || 0;
    const z = 0.08 + ((seed % 1000) / 1000) * 0.84;
    const y = 0.02 + (((seed >> 10) % 1000) / 1000) * 0.22;
    const p = P([px, y, z]);
    if (p) pts.push({ ev, p });
  }
  pts.sort((a, b) => b.p.depth - a.p.depth);
  ctx.globalCompositeOperation = 'lighter';
  for (const { ev, p } of pts) {
    const r = Math.max(1.5, ev.size * 0.45 * (p.scale / ref));
    const [cr, cg, cb] = [parseInt(ev.colour.slice(1, 3), 16), parseInt(ev.colour.slice(3, 5), 16), parseInt(ev.colour.slice(5, 7), 16)];
    const foot = P([ (Math.min(1, Math.max(0, (ev.pitch - 36) / 60)) * 2 - 1), 0, 0.08 + ((parseInt(String(ev.hash ?? '0').slice(0, 6), 16) || 0) % 1000) / 1000 * 0.84 ]);
    if (foot) {
      ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, 0.18)`;
      ctx.beginPath();
      ctx.moveTo(foot.x, foot.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3);
    g.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, 0.5)`);
    g.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${ev.success ? 0.95 : 0.4})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  // a faint floor ring, the pulse at rest
  const ring = ringPoints([0, 0.002, 0.5], 0.5, { segments: 48 }).map(P);
  if (ring.every(Boolean)) {
    ctx.strokeStyle = 'rgba(200, 220, 255, 0.12)';
    ctx.beginPath();
    ring.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.closePath();
    ctx.stroke();
  }
}

export function renderNotice(text, cls = '') {
  return el('div', { class: `notice ${cls}`, text });
}

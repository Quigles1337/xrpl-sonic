// xrpl-sonic explorer — application wiring.
//
// One box, a hash router, four views (home, account, transaction, ledger),
// a trail of where you have been, sound on hover, and keyboard for all of it.
// Data comes from a public XRPL node over WebSocket, read by the browser.

import { el, svg } from '../dom.js';
import { AudioEngine } from '../audio.js';
import { NETWORKS } from '../ws.js';
import { shortAddress, decodeCurrency } from '../mapping.js';
import { ExplorerApi } from './api.js';
import { classify, parseRoute, formatRoute, routeFor, routeTitle } from './route.js';
import { sigilSvg } from './sigil.js';
import { loadAccount, loadOlder, coverageOf } from './account.js';
import { Constellation } from './constellation.js';
import { describeEdge, describeStrand, hueCss } from './edges.js';
import { renderHome, latestListItem, renderAccount, renderAccountMissing, renderTx, renderLedger, drawPlate, txRow, renderNotice } from './views.js';

const query = new URLSearchParams(location.search);
const network = query.get('network') === 'testnet' ? 'testnet' : 'mainnet';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (sel) => document.querySelector(sel);
const view = $('#view');
const omni = $('#omni');
const omniInput = $('#omni-input');
const omniKind = $('#omni-kind');
const omniHint = $('#omni-hint');
const trailEl = $('#trail');
const tip = $('#tip');
const help = $('#help');
const soundBtn = $('#sound');

const state = {
  route: null,
  trail: [], // { route, title }
  trailIndex: -1,
  sound: false,
  reserve: { base: 1, inc: 0.2 },
  latest: [], // recent ledgerClosed messages, newest first
  token: 0, // render generation, to drop late results
  constellation: null,
  accountEvents: [], // events of the account tape, for "play history"
  facts: null, // the facts object of the current render (account snapshot, or a transaction's findings)
  lastHover: 0,
};

const engine = new AudioEngine({ volume: 0.5 });
const api = new ExplorerApi({
  network,
  onStatus: (s) => {
    const dot = $('#status-dot');
    dot.dataset.state = s.state === 'connected' ? 'connected' : s.state === 'idle' ? 'idle' : 'connecting';
    dot.title = s.endpoint ? `${s.state} · ${s.endpoint.replace(/^wss:\/\//, '')}` : s.state;
  },
  onLedger: (msg) => {
    state.latest.unshift(msg);
    state.latest.length = Math.min(state.latest.length, 12);
    const a = $('#live-ledger');
    a.textContent = `#${Number(msg.ledger_index).toLocaleString('en-US')}`;
    a.href = formatRoute({ name: 'ledger', index: Number(msg.ledger_index) });
    $('#live-interval').textContent = `${msg.txn_count ?? '?'} tx`;
    const list = $('#latest-list');
    if (list) {
      list.replaceChildren(...state.latest.slice(0, 8).map(latestListItem));
    }
  },
});
api.connect();
api.serverInfo().then((r) => {
  const v = r?.info?.validated_ledger;
  if (v && Number.isFinite(Number(v.reserve_base_xrp))) state.reserve = { base: Number(v.reserve_base_xrp), inc: Number(v.reserve_inc_xrp) };
}).catch(() => {});

// ---------------------------------------------------------------------------
// Omnibox
// ---------------------------------------------------------------------------

function reflectOmni() {
  const c = classify(omniInput.value);
  omniKind.textContent = c.kind === 'empty' || c.kind === 'unknown' ? '' : c.kind;
  omniHint.textContent = omniInput.value.trim() ? c.hint : '';
  omniInput.setAttribute('aria-invalid', String(c.kind === 'unknown' && omniInput.value.trim().length > 0));
}
omniInput.addEventListener('input', reflectOmni);
omniInput.addEventListener('focus', reflectOmni);
omniInput.addEventListener('blur', () => {
  omniHint.textContent = '';
});
omni.addEventListener('submit', (e) => {
  e.preventDefault();
  const c = classify(omniInput.value);
  const route = routeFor(c);
  if (!route) {
    omniHint.textContent = c.hint;
    omniInput.setAttribute('aria-invalid', 'true');
    return;
  }
  omniInput.value = '';
  omniKind.textContent = '';
  omniHint.textContent = '';
  omniInput.blur();
  navigate(route);
});

function navigate(route) {
  const hash = formatRoute(route);
  if (location.hash === hash) render(route);
  else location.hash = hash;
}

// ---------------------------------------------------------------------------
// Sound
// ---------------------------------------------------------------------------

async function setSound(on) {
  if (on) {
    try {
      const st = await engine.start();
      state.sound = st === 'running';
      if (!state.sound) note('Audio is suspended by the browser; click anywhere, then try again.', 'err');
    } catch (err) {
      state.sound = false;
      note(`Web Audio is unavailable: ${err?.message ?? err}`, 'err');
    }
  } else {
    state.sound = false;
  }
  soundBtn.setAttribute('aria-pressed', String(state.sound));
  soundBtn.textContent = state.sound ? 'Sound on' : 'Sound';
}
soundBtn.addEventListener('click', () => setSound(!state.sound));

/** Hover or "hear it": one note, lightly throttled so sweeping the tape does not pile up. */
function hear(event) {
  if (!state.sound || !event) return;
  const now = performance.now();
  if (now - state.lastHover < 45) return;
  state.lastHover = now;
  engine.playAt(event, 0.01);
}

/** The account's recent transactions as a phrase, oldest first, 140 ms apart. */
async function playHistory() {
  if (!state.accountEvents.length) return;
  if (!state.sound) await setSound(true);
  if (!state.sound) return;
  const events = [...state.accountEvents].reverse().slice(-48);
  events.forEach((ev, i) => {
    setTimeout(() => {
      engine.playAt(ev, 0.01);
      const li = view.querySelector(`li[data-hash="${ev.hash}"]`);
      if (li) {
        li.style.background = 'rgba(76, 201, 240, 0.14)';
        setTimeout(() => (li.style.background = ''), 240);
      }
    }, i * 140);
  });
}

// ---------------------------------------------------------------------------
// Router, trail, title
// ---------------------------------------------------------------------------

function pushTrail(route) {
  const title = routeTitle(route);
  const key = formatRoute(route);
  state.trail = state.trail.filter((t) => formatRoute(t.route) !== key).slice(-9);
  state.trail.push({ route, title });
  trailEl.replaceChildren(
    ...state.trail.map((t, i) => {
      const a = el('a', { href: formatRoute(t.route), 'aria-current': i === state.trail.length - 1 ? 'page' : null }, [t.route.name === 'account' ? svg(sigilSvg(t.route.address, 14)) : '', el('span', { text: t.title })]);
      return a;
    }),
  );
}

function note(text, cls = '') {
  view.prepend(renderNotice(text, cls));
}

async function render(route) {
  const token = ++state.token;
  state.route = route;
  document.title = `${routeTitle(route)} — xrpl-sonic explorer`;
  state.constellation?.destroy();
  state.constellation = null;
  state.accountEvents = [];
  tip.classList.add('hidden');
  if (route.name !== 'home' && route.name !== 'help') pushTrail(route);
  window.scrollTo({ top: 0, behavior: 'auto' });
  if (route.error) {
    view.replaceChildren(renderNotice(route.error, 'err'), ...renderHome(homeArgs()));
    fillLatest();
    return;
  }
  switch (route.name) {
    case 'account':
      return renderAccountRoute(route, token);
    case 'tx':
      return renderTxRoute(route, token);
    case 'ledger':
      return renderLedgerRoute(route, token);
    case 'help':
      help.classList.remove('hidden');
      if (!view.children.length) view.replaceChildren(...renderHome(homeArgs()));
      return;
    default:
      view.replaceChildren(...renderHome(homeArgs()));
      fillLatest();
  }
}

function homeArgs() {
  return {
    examples: [
      { href: formatRoute({ name: 'ledger', index: 'latest' }), label: 'Latest ledger', title: 'The most recently validated ledger' },
      { href: formatRoute({ name: 'ledger', index: 107777809 }), label: 'Ledger #107,777,809', title: 'The ledger used in the README examples' },
      { href: formatRoute({ name: 'account', address: 'rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah' }), label: 'A market maker', title: 'rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah' },
      { href: formatRoute({ name: 'tx', hash: '0176B15458AF71EDF66D5C679FDBDCD360EB1602ECB7925352858D081287FE63' }), label: 'An offer, explained', title: 'An OfferCreate from ledger 107,777,809, explained from its metadata' },
    ],
    onRandom: () => takeMeSomewhere(),
  };
}

function fillLatest() {
  const list = $('#latest-list');
  if (list && state.latest.length) list.replaceChildren(...state.latest.slice(0, 8).map(latestListItem));
}

async function takeMeSomewhere() {
  try {
    const ledger = await api.ledger('latest');
    const txs = (ledger.ledger?.transactions ?? []).filter((t) => t.Account);
    if (!txs.length) throw new Error('the latest ledger has no transactions yet');
    const pick = txs[Math.floor(Math.random() * txs.length)];
    navigate({ name: 'account', address: pick.Account, tag: null });
  } catch (err) {
    note(`Could not pick a place: ${err?.message ?? err}`, 'err');
  }
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

const PART_LABELS = Object.freeze({ info: 'the account', lines: 'the trust lines', objects: 'the ledger objects', nfts: 'the NFTs', tx: 'the transactions' });

async function renderAccountRoute(route, token) {
  const { address, tag } = route;
  view.replaceChildren(el('section', { class: 'card hero' }, [el('div', { class: 'identity' }, [svg(sigilSvg(address, 56)), el('div', { class: 'identity-main' }, [el('div', { class: 'identity-title' }, [el('span', { text: address })]), el('div', { class: 'identity-sub' }, [el('span', { class: 'skeleton', text: 'reading the account…' })])])])]));
  state.facts = null;
  let page = null;
  let constellation = null;
  const queued = [];
  const caption = { tx: '', lines: '' };
  const describeModel = () => {
    const m = constellation.model;
    const bits = [];
    if (m.counts.strands.total) bits.push(m.counts.strands.drawn === m.counts.strands.total ? `${m.counts.strands.total} transaction strand${m.counts.strands.total === 1 ? '' : 's'}` : `${m.counts.strands.drawn} of ${m.counts.strands.total} transaction strands drawn (the newest)`);
    if (m.counts.trust.total) bits.push(m.counts.trust.drawn === m.counts.trust.total ? `${m.counts.trust.total} trust line${m.counts.trust.total === 1 ? '' : 's'}` : `${m.counts.trust.drawn} of ${m.counts.trust.total} trust lines drawn (the largest)`);
    page.setCoverage([caption.tx, caption.lines, bits.length ? `${bits.join(' · ')}.` : ''].filter(Boolean).join(' '));
    page.setLegend(m);
  };
  const stars = (f, part) => {
    const parties = f.counterparties.parties;
    constellation.setData({ ...constellation.data, parties, entries: f.parts.tx?.entries ?? [] });
    caption.tx = parties.length ? `Stars from ${coverageOf(f.counterparties.covers)}.` : part.state === 'unavailable' ? `The transactions could not be read (${part.error?.code ?? 'error'}), so there are no stars.` : 'No counterparties in the loaded transactions.';
    describeModel();
  };
  const applyPart = (name, part, f) => {
    if (!page) {
      queued.push([name, part, f]);
      return;
    }
    if (name === 'tx') {
      fillTape(page, part, address, token, f);
      stars(f, part);
    } else if (name === 'lines') {
      page.fill({ lines: part });
      if (part.items.length) {
        constellation.setData({ ...constellation.data, lines: part.items });
        caption.lines = part.state === 'partial' ? 'Trust lines from the first page the node returned.' : '';
        describeModel();
      }
    } else page.fill({ [name]: part });
  };
  // One validated ledger; every part at it; each fills in as it lands.
  const facts = await loadAccount(api, address, {
    limit: 40,
    onPart: (name, part, f) => {
      if (token !== state.token) return;
      if (name !== 'info') {
        applyPart(name, part, f);
        return;
      }
      if (part.state !== 'loaded') {
        view.replaceChildren(...renderAccountMissing(address, part.error));
        return;
      }
      page = renderAccount({ address, tag, info: part.result, network, reserve: state.reserve, onPlay: () => playHistory() });
      view.replaceChildren(...page.nodes);
      const canvas = page.constellationBox.querySelector('canvas');
      constellation = new Constellation(canvas, {
        reduced: reducedMotion,
        onHover: (star, x, y) => showTip(star, x, y),
        onClick: (star) => navigate({ name: 'account', address: star.address, tag: null }),
      });
      state.constellation = constellation;
      const xrp = Number(part.result.account_data.Balance) / 1e6;
      constellation.setData({ account: address, xrp, reserve: page.reserve.total, lines: [], parties: [], entries: [] });
      for (const [n, p, ff] of queued.splice(0)) applyPart(n, p, ff);
    },
  });
  if (token !== state.token) return;
  state.facts = facts;
  if (!page) return; // the account could not be read; the notice is up
  const unavailable = Object.entries(facts.parts)
    .filter(([, p]) => p?.state === 'unavailable')
    .map(([n, p]) => `${PART_LABELS[n]} (${p.error?.code ?? p.error?.message ?? 'error'})`);
  if (unavailable.length) note(`Part of the account could not be read: ${unavailable.join(', ')}.`, 'err');
  if (facts.snapshot.state !== 'loaded') note(`No validated ledger could be resolved (${facts.snapshot.error?.message ?? 'unknown'}), so the parts were read unbound and may not agree with each other.`, 'err');
}

/** The tape from a tx part: rows, the count, the foot with the bound and "Load older" (which keeps the bound and recomputes the stars). */
function fillTape(page, part, address, token, facts, { append = false, entries = null } = {}) {
  const list = entries ?? part.entries ?? [];
  const rows = list.map((entry) => txRow(entry, { account: address, onHover: hear }));
  if (!append) page.tape.replaceChildren();
  for (const r of rows) page.tape.append(r.li);
  state.accountEvents.push(...rows.map((r) => r.event).filter(Boolean));
  const count = page.tape.children.length;
  const countEl = $('#tape-count');
  if (countEl) countEl.textContent = String(count);
  const bound = part.ledgerIndexMax != null ? ` as of ledger #${Number(part.ledgerIndexMax).toLocaleString('en-US')}` : '';
  let foot;
  if (part.state === 'unavailable') foot = `The transactions could not be read: ${part.error?.message ?? part.error?.code ?? 'error'}.`;
  else if (part.state === 'empty') foot = `No transactions${bound}.`;
  else foot = `${count} ${part.state === 'partial' ? 'shown' : 'in all'}, newest first${bound}.`;
  page.foot.replaceChildren(
    el('span', { text: foot }),
    part.state === 'partial'
      ? el('button', { type: 'button', class: 'btn small', text: 'Load older', onclick: async (e) => {
          e.target.disabled = true;
          try {
            const more = await loadOlder(api, facts);
            if (token !== state.token || !more) return;
            fillTape(page, facts.parts.tx, address, token, facts, { append: true, entries: more.entries });
            const parties = facts.counterparties.parties;
            state.constellation?.setData({ ...state.constellation.data, parties, entries: f.parts.tx?.entries ?? [] });
            page.setCoverage(parties.length ? `Stars from ${coverageOf(facts.counterparties.covers)}.` : 'No counterparties in the loaded transactions.');
          } catch (err) {
            note(`Could not load older transactions: ${err?.message ?? err}`, 'err');
            e.target.disabled = false;
          }
        } })
      : '',
  );
}

function showTip(star, x, y) {
  if (!star) {
    tip.classList.add('hidden');
    return;
  }
  const party = star.party;
  const cats = Object.entries(party?.categories ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');
  const roles = Object.entries(party?.roles ?? {})
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');
  const swatch = (text, colour) => el('div', { class: 'tip-line swatch', style: `--c: ${colour}`, text });
  const strands = star.strands ?? [];
  const shown = strands.slice(0, 6);
  tip.replaceChildren(
    el('div', { class: 'tip-title' }, [svg(sigilSvg(star.address, 14)), el('span', { text: star.address })]),
    party
      ? el('div', { class: 'tip-line', text: `${party.count} transaction${party.count === 1 ? '' : 's'} together · ${roles}` })
      : el('div', { class: 'tip-line', text: 'no transactions together in the loaded records' }),
    cats ? el('div', { class: 'tip-line', text: cats }) : '',
    party?.xrpIn || party?.xrpOut ? el('div', { class: 'tip-line', text: `XRP in ${party.xrpIn.toLocaleString('en-US', { maximumFractionDigits: 2 })} · out ${party.xrpOut.toLocaleString('en-US', { maximumFractionDigits: 2 })}` }) : '',
    ...(star.trust ?? []).map((e) => swatch(describeEdge(e), hueCss(e.hue))),
    ...shown.map((t) => swatch(`#${Number(t.ledgerIndex).toLocaleString('en-US')} ${describeStrand(t)}`, `rgb(${t.rgb.join(' ')})`)),
    strands.length > shown.length ? el('div', { class: 'tip-line', text: `and ${strands.length - shown.length} more strand${strands.length - shown.length === 1 ? '' : 's'}` }) : '',
    el('div', { class: 'hint', text: 'click to open' }),
  );
  tip.classList.remove('hidden');
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(window.innerWidth - r.width - 12, x + 14)}px`;
  tip.style.top = `${Math.min(window.innerHeight - r.height - 12, y + 14)}px`;
}

// ---------------------------------------------------------------------------
// Transaction and ledger
// ---------------------------------------------------------------------------

async function renderTxRoute(route, token) {
  view.replaceChildren(el('section', { class: 'card hero' }, [el('p', { class: 'skeleton', text: `reading transaction ${route.hash.slice(0, 12)}…` })]));
  try {
    const result = await api.tx(route.hash);
    if (token !== state.token) return;
    state.facts = null;
    view.replaceChildren(...renderTx(result, { network, onHover: (ev) => hearNow(ev), onFacts: (f) => (state.facts = f), host: api.host }));
  } catch (err) {
    if (token !== state.token) return;
    view.replaceChildren(renderNotice(err?.code === 'txnNotFound' ? `No transaction ${route.hash.slice(0, 16)}… is known to this node. It may be on another network, not yet validated, or older than the node's history.` : `Could not read the transaction: ${err?.message ?? err}`, 'err'));
  }
}

async function hearNow(ev) {
  if (!state.sound) await setSound(true);
  if (state.sound) engine.playAt(ev, 0.01);
}

async function renderLedgerRoute(route, token) {
  view.replaceChildren(el('section', { class: 'card hero' }, [el('p', { class: 'skeleton', text: route.index === 'latest' ? 'reading the latest ledger…' : `reading ledger #${Number(route.index).toLocaleString('en-US')}…` })]));
  try {
    const result = await api.ledger(route.index);
    if (token !== state.token) return;
    const latestIndex = state.latest[0] ? Number(state.latest[0].ledger_index) : null;
    const page = renderLedger(result.ledger, { network, onHover: hear, latestIndex });
    view.replaceChildren(...page.nodes);
    const canvas = page.plate.querySelector('canvas');
    drawPlate(canvas, page.events);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => drawPlate(canvas, page.events)) : null;
    ro?.observe(page.plate);
  } catch (err) {
    if (token !== state.token) return;
    view.replaceChildren(renderNotice(err?.code === 'lgrNotFound' ? `Ledger ${route.index} is not available from this node (it keeps a limited history).` : `Could not read the ledger: ${err?.message ?? err}`, 'err'));
  }
}

// ---------------------------------------------------------------------------
// Keyboard, help, boot
// ---------------------------------------------------------------------------

$('#help-btn').addEventListener('click', () => help.classList.toggle('hidden'));
$('#help-close').addEventListener('click', () => help.classList.add('hidden'));
help.addEventListener('click', (e) => {
  if (e.target === help) help.classList.add('hidden');
});

window.addEventListener('keydown', (e) => {
  const tag = e.target?.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  if (e.key === 'Escape') {
    if (!help.classList.contains('hidden')) help.classList.add('hidden');
    else if (typing) {
      omniInput.value = '';
      reflectOmni();
      omniInput.blur();
    }
    return;
  }
  if (typing) return;
  if (e.key === '/') {
    e.preventDefault();
    omniInput.focus();
    omniInput.select();
  } else if (e.key === '[') history.back();
  else if (e.key === ']') history.forward();
  else if (e.key === '?') help.classList.toggle('hidden');
  else if (e.key === 's' || e.key === 'S') setSound(!state.sound);
  else if (e.key === 'p' || e.key === 'P') playHistory();
  else if (e.key === 'l' || e.key === 'L') navigate({ name: 'ledger', index: 'latest' });
  else if (e.key === 'r' || e.key === 'R') takeMeSomewhere();
});

window.addEventListener('hashchange', () => render(parseRoute(location.hash)));
render(parseRoute(location.hash));

window.xrplExplorer = { api, state, engine, navigate, network: NETWORKS[network].label, shortAddress };

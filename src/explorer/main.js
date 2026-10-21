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
import { counterparties } from './anatomy.js';
import { Constellation } from './constellation.js';
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

async function renderAccountRoute(route, token) {
  const { address, tag } = route;
  view.replaceChildren(el('section', { class: 'card hero' }, [el('div', { class: 'identity' }, [svg(sigilSvg(address, 56)), el('div', { class: 'identity-main' }, [el('div', { class: 'identity-title' }, [el('span', { text: address })]), el('div', { class: 'identity-sub' }, [el('span', { class: 'skeleton', text: 'reading the account…' })])])])]));
  let info;
  try {
    info = await api.accountInfo(address);
  } catch (err) {
    if (token !== state.token) return;
    view.replaceChildren(...renderAccountMissing(address, err));
    return;
  }
  if (token !== state.token) return;
  const page = renderAccount({ address, tag, info, network, reserve: state.reserve, onPlay: () => playHistory() });
  view.replaceChildren(...page.nodes);
  const canvas = page.constellationBox.querySelector('canvas');
  const constellation = new Constellation(canvas, {
    reduced: reducedMotion,
    onHover: (party, x, y) => showTip(party, x, y),
    onClick: (party) => navigate({ name: 'account', address: party.address, tag: null }),
  });
  state.constellation = constellation;
  const xrp = Number(info.account_data.Balance) / 1e6;
  constellation.setData({ account: address, xrp, reserve: page.reserve.total, lines: [], parties: [] });

  // Transactions, trust lines, objects and NFTs in parallel; each fills in as it lands.
  const txPromise = api.accountTx(address, { limit: 40 }).then((r) => {
    if (token !== state.token) return;
    fillTape(page, r, address, token);
    const parties = counterparties(r.transactions, address);
    constellation.setData({ account: address, xrp, reserve: page.reserve.total, lines: constellation.data?.lines ?? [], parties });
    if (!parties.length) page.constellationBox.append(el('div', { class: 'empty', text: 'No counterparties in the recent transactions.' }));
  });
  const linesPromise = api.accountLines(address).then((r) => {
    if (token !== state.token) return;
    page.fill({ lines: r });
    constellation.setData({ ...constellation.data, lines: (r.lines ?? []).map((l) => ({ currency: decodeCurrency(l.currency).slice(0, 8), issuer: l.account, balance: l.balance })) });
  });
  const objectsPromise = Promise.all([api.accountObjects(address).catch(() => ({ account_objects: [] })), api.accountNfts(address).catch(() => ({ account_nfts: [] }))]).then(([objects, nfts]) => {
    if (token !== state.token) return;
    page.fill({ objects, nfts });
  });
  await Promise.allSettled([txPromise, linesPromise, objectsPromise]).then((results) => {
    if (token !== state.token) return;
    for (const r of results) if (r.status === 'rejected') note(`Part of the account could not be read: ${r.reason?.message ?? r.reason}`, 'err');
  });
}

function fillTape(page, result, address, token, { append = false } = {}) {
  const rows = (result.transactions ?? []).map((entry) => txRow(entry, { account: address, onHover: hear }));
  if (!append) page.tape.replaceChildren();
  for (const r of rows) page.tape.append(r.li);
  state.accountEvents.push(...rows.map((r) => r.event).filter(Boolean));
  const count = page.tape.children.length;
  const countEl = $('#tape-count');
  if (countEl) countEl.textContent = String(count);
  page.foot.replaceChildren(
    el('span', { text: result.marker ? `${count} shown, newest first.` : `${count} in all, newest first.` }),
    result.marker
      ? el('button', { type: 'button', class: 'btn small', text: 'Load older', onclick: async (e) => {
          e.target.disabled = true;
          try {
            const more = await api.accountTx(address, { limit: 40, marker: result.marker });
            if (token !== state.token) return;
            fillTape(page, more, address, token, { append: true });
          } catch (err) {
            note(`Could not load older transactions: ${err?.message ?? err}`, 'err');
          }
        } })
      : '',
  );
}

function showTip(party, x, y) {
  if (!party) {
    tip.classList.add('hidden');
    return;
  }
  const cats = Object.entries(party.categories ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');
  const roles = Object.entries(party.roles ?? {})
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');
  tip.replaceChildren(
    el('div', { class: 'tip-title' }, [svg(sigilSvg(party.address, 14)), el('span', { text: party.address })]),
    el('div', { class: 'tip-line', text: `${party.count} transaction${party.count === 1 ? '' : 's'} together · ${roles}` }),
    el('div', { class: 'tip-line', text: cats }),
    party.xrpIn || party.xrpOut ? el('div', { class: 'tip-line', text: `XRP in ${party.xrpIn.toLocaleString('en-US', { maximumFractionDigits: 2 })} · out ${party.xrpOut.toLocaleString('en-US', { maximumFractionDigits: 2 })}` }) : '',
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
    view.replaceChildren(...renderTx(result, { network, onHover: (ev) => hearNow(ev) }));
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

// xrpl-sonic — DOM controls, status, metronome and the scrolling log.

import { CATEGORIES, CATEGORY_NAMES, SCALES, KEYS, isValidAddress, shortAddress } from './mapping.js';
import { NETWORKS } from './ws.js';
import { EXPLORERS, explorerUrl } from './explorers.js';
import { ACCOUNT_MODES } from './settings.js';

const MAX_LOG_LINES = 80;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, String(v));
  }
  for (const c of children) node.append(c);
  return node;
}

function option(value, label, selected) {
  return el('option', { value, text: label, selected: selected ? true : false });
}

/**
 * Build the controls into the existing document skeleton.
 * @param {object} args
 * @param {object} args.settings  current settings (mutated on change)
 * @param {(patch: object, settings: object) => void} args.onChange
 * @param {() => void} args.onToggleRun
 */
export function createUI({ settings, onChange, onToggleRun }) {
  const $ = (sel) => document.querySelector(sel);
  const startButtons = [$('#start'), $('#overlay-start')].filter(Boolean);
  const overlay = $('#overlay');
  const panel = $('#panel');
  const panelToggle = $('#toggle-panel');
  const statusDot = $('#status-dot');
  const statusText = $('#status-text');
  const ledgerIndexEl = $('#ledger-index');
  const ledgerIntervalEl = $('#ledger-interval');
  const metronomeFill = $('#metronome-fill');
  const txRateEl = $('#tx-rate');
  const logList = $('#log');
  const logWrap = $('#log-wrap');
  const controls = $('#controls');
  const watch = $('#watch');
  const accountBadge = $('#account-badge');
  const accountShort = $('#account-short');
  const accountClear = $('#account-clear');

  const update = (patch) => {
    Object.assign(settings, patch);
    onChange(patch, settings);
  };

  // --- Start / stop ----------------------------------------------------------
  for (const b of startButtons) b.addEventListener('click', () => onToggleRun());

  // --- Panel toggle (mobile) -------------------------------------------------
  const setPanelOpen = (open) => {
    panel.classList.toggle('open', open);
    panelToggle.setAttribute('aria-expanded', String(open));
  };
  panelToggle.addEventListener('click', () => setPanelOpen(!panel.classList.contains('open')));
  if (window.matchMedia('(min-width: 900px)').matches) setPanelOpen(true);

  // --- Controls --------------------------------------------------------------
  const volume = el('input', {
    type: 'range',
    id: 'volume',
    min: 0,
    max: 1,
    step: 0.01,
    value: settings.volume,
    'aria-label': 'Volume',
    oninput: (e) => update({ volume: Number(e.target.value) }),
  });
  const mute = el('input', {
    type: 'checkbox',
    id: 'mute',
    checked: settings.muted,
    onchange: (e) => update({ muted: e.target.checked }),
  });
  const network = el(
    'select',
    { id: 'network', 'aria-label': 'Network', onchange: (e) => update({ network: e.target.value }) },
    Object.entries(NETWORKS).map(([k, v]) => option(k, v.label, settings.network === k)),
  );
  const scale = el(
    'select',
    { id: 'scale', 'aria-label': 'Scale', onchange: (e) => update({ scale: e.target.value }) },
    Object.entries(SCALES).map(([k, v]) => option(k, v.label, settings.scale === k)),
  );
  const key = el(
    'select',
    { id: 'key', 'aria-label': 'Key', onchange: (e) => update({ key: e.target.value }) },
    KEYS.map((k) => option(k, k, settings.key === k)),
  );
  const quietMode = el('input', {
    type: 'checkbox',
    id: 'quiet-mode',
    checked: settings.quietMode,
    onchange: (e) => update({ quietMode: e.target.checked }),
  });
  const quietThreshold = el('input', {
    type: 'number',
    id: 'quiet-threshold',
    min: 0,
    step: 1,
    inputmode: 'numeric',
    value: settings.quietThreshold,
    'aria-label': 'Quiet mode threshold in XRP',
    onchange: (e) => update({ quietThreshold: Math.max(0, Number(e.target.value) || 0) }),
  });
  const includeFailed = el('input', {
    type: 'checkbox',
    id: 'include-failed',
    checked: settings.includeFailed,
    onchange: (e) => update({ includeFailed: e.target.checked }),
  });
  const showLog = el('input', {
    type: 'checkbox',
    id: 'show-log',
    checked: settings.showLog,
    onchange: (e) => update({ showLog: e.target.checked }),
  });
  const accountHint = el('span', { class: 'hint', id: 'account-hint' });
  const accountInput = el('input', {
    type: 'text',
    id: 'account',
    placeholder: 'r… (one account)',
    spellcheck: 'false',
    autocomplete: 'off',
    autocapitalize: 'off',
    value: settings.account ?? '',
    'aria-label': 'Account to watch',
    'aria-describedby': 'account-hint',
    onchange: (e) => {
      const value = e.target.value.trim();
      if (value && !isValidAddress(value)) {
        e.target.setAttribute('aria-invalid', 'true');
        accountHint.textContent = 'Not a valid r-address.';
        accountHint.classList.add('error');
        return;
      }
      e.target.removeAttribute('aria-invalid');
      accountHint.classList.remove('error');
      accountHint.textContent = '';
      e.target.value = value;
      update({ account: value });
    },
  });
  const accountMode = el(
    'select',
    { id: 'account-mode', 'aria-label': 'What to do with other transactions', onchange: (e) => update({ accountMode: e.target.value }) },
    Object.entries(ACCOUNT_MODES).map(([k, label]) => option(k, label, settings.accountMode === k)),
  );
  const explorer = el(
    'select',
    { id: 'explorer', 'aria-label': 'Explorer for links', onchange: (e) => update({ explorer: e.target.value }) },
    Object.entries(EXPLORERS).map(([k, v]) => option(k, v.label, settings.explorer === k)),
  );
  accountClear.addEventListener('click', () => {
    accountInput.value = '';
    accountInput.removeAttribute('aria-invalid');
    accountHint.textContent = '';
    update({ account: '' });
  });

  const row = (labelText, control, extra) =>
    el('label', { class: 'row' }, [el('span', { class: 'row-label', text: labelText }), control, ...(extra ? [extra] : [])]);
  const check = (labelText, control, hint) =>
    el('label', { class: 'row check' }, [control, el('span', { class: 'row-label', text: labelText }), ...(hint ? [el('span', { class: 'hint', text: hint })] : [])]);

  const categoryToggles = CATEGORY_NAMES.map((name) => {
    const c = CATEGORIES[name];
    const box = el('input', {
      type: 'checkbox',
      checked: settings.enabled[name],
      'data-category': name,
      onchange: (e) => update({ enabled: { ...settings.enabled, [name]: e.target.checked } }),
    });
    return el('label', { class: 'chip', style: `--chip: ${c.colour}` }, [box, el('span', { class: 'swatch' }), el('span', { text: c.label })]);
  });

  controls.append(
    el('section', { class: 'group' }, [
      el('h2', { text: 'Sound' }),
      row('Volume', volume),
      check('Mute', mute),
      row('Scale', scale),
      row('Key', key),
    ]),
    el('section', { class: 'group' }, [
      el('h2', { text: 'Stream' }),
      row('Network', network),
      check('Quiet mode', quietMode, 'only transactions at or above'),
      row('Threshold (XRP)', quietThreshold),
      check('Include failed transactions', includeFailed),
      check('Show log', showLog),
    ]),
    el('section', { class: 'group' }, [el('h2', { text: 'Transaction types' }), el('div', { class: 'chips' }, categoryToggles)]),
    el('section', { class: 'group' }, [
      el('h2', { text: 'Account' }),
      el('label', { class: 'row stack' }, [el('span', { class: 'row-label', text: 'Watch one account' }), accountInput, accountHint]),
      row('Other transactions', accountMode),
      row('Explorer links', explorer),
    ]),
    el('section', { class: 'group stats' }, [
      el('h2', { text: 'Session' }),
      el('dl', {}, [
        el('dt', { text: 'Played' }),
        el('dd', { id: 'stat-played', text: '0' }),
        el('dt', { text: 'Rate-limited' }),
        el('dd', { id: 'stat-dropped', text: '0' }),
        el('dt', { text: 'Ledgers' }),
        el('dd', { id: 'stat-ledgers', text: '0' }),
        el('dt', { text: 'Node' }),
        el('dd', { id: 'stat-node', text: '—' }),
      ]),
    ]),
  );

  const statPlayed = $('#stat-played');
  const statDropped = $('#stat-dropped');
  const statLedgers = $('#stat-ledgers');
  const statNode = $('#stat-node');

  const applyLogVisibility = () => logWrap.classList.toggle('hidden', !settings.showLog);
  applyLogVisibility();

  // --- Public API ------------------------------------------------------------
  return {
    setRunning(running) {
      document.body.classList.toggle('running', running);
      overlay.classList.toggle('hidden', running);
      for (const b of startButtons) {
        b.textContent = running ? 'Stop' : 'Start';
        b.setAttribute('aria-pressed', String(running));
      }
      if (running && !window.matchMedia('(min-width: 900px)').matches) setPanelOpen(false);
    },

    setStatus(state, text, endpoint) {
      statusDot.dataset.state = state;
      statusText.textContent = text;
      if (endpoint !== undefined) statNode.textContent = endpoint ? endpoint.replace(/^wss:\/\//, '') : '—';
    },

    setLedger(index, intervalSeconds) {
      ledgerIndexEl.textContent = index != null ? `#${index.toLocaleString('en-US')}` : '—';
      ledgerIntervalEl.textContent = intervalSeconds ? `${intervalSeconds.toFixed(1)} s` : '—';
    },

    setMetronome(fraction) {
      metronomeFill.style.transform = `scaleX(${Math.min(1, Math.max(0, fraction)).toFixed(3)})`;
    },

    setTxRate(perSecond) {
      txRateEl.textContent = `${perSecond.toFixed(1)} tx/s`;
    },

    setStats({ played, dropped, ledgers }) {
      statPlayed.textContent = String(played);
      statDropped.textContent = String(dropped);
      statLedgers.textContent = String(ledgers);
    },

    log(event) {
      if (!settings.showLog) return;
      const line = el('li', { class: `log-${event.kind}` }, [
        el('span', { class: 'dot', style: `background: ${event.kind === 'tx' ? event.colour : '#c8dcff'}` }),
        el('span', { class: 'line' }, event.kind === 'tx' ? txLine(event) : ledgerLine(event)),
      ]);
      logList.prepend(line);
      while (logList.children.length > MAX_LOG_LINES) logList.lastChild.remove();
    },

    /** Show (or clear) the watched account in the top bar. */
    setAccount(address) {
      const active = Boolean(address);
      watch.classList.toggle('hidden', !active);
      document.body.classList.toggle('watching', active);
      accountShort.textContent = active ? shortAddress(address) : '';
      accountBadge.href = (active && explorerUrl(settings.explorer, settings.network, 'account', address)) || '#';
      accountBadge.title = active ? `${address} — open on ${EXPLORERS[settings.explorer]?.label ?? 'explorer'}` : '';
      if (accountInput.value.trim() !== (address ?? '')) accountInput.value = address ?? '';
    },

    logMessage(text, cls = 'info') {
      const line = el('li', { class: `log-${cls}` }, [el('span', { class: 'dot' }), el('span', { class: 'line', text })]);
      logList.prepend(line);
      while (logList.children.length > MAX_LOG_LINES) logList.lastChild.remove();
    },

    applySettings() {
      volume.value = settings.volume;
      mute.checked = settings.muted;
      network.value = settings.network;
      scale.value = settings.scale;
      key.value = settings.key;
      quietMode.checked = settings.quietMode;
      quietThreshold.value = settings.quietThreshold;
      includeFailed.checked = settings.includeFailed;
      showLog.checked = settings.showLog;
      accountInput.value = settings.account ?? '';
      accountMode.value = settings.accountMode;
      explorer.value = settings.explorer;
      for (const box of controls.querySelectorAll('input[data-category]')) box.checked = settings.enabled[box.dataset.category];
      applyLogVisibility();
    },
  };

  // --- Log line builders -----------------------------------------------------
  function link(kind, id, text, cls) {
    const href = explorerUrl(settings.explorer, settings.network, kind, id);
    if (!href) return el('span', { class: cls, text });
    return el('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer', text });
  }

  function txLine(event) {
    const nodes = [link('tx', event.hash, event.head, 'tx-link')];
    for (const p of event.parties) {
      const watched = settings.account && p.address === settings.account;
      nodes.push(p.separator, link('account', p.address, p.short, `acct-link${watched ? ' watched' : ''}`));
    }
    nodes.push(` · ${event.note}`);
    return nodes;
  }

  function ledgerLine(event) {
    return [link('ledger', event.ledgerIndex, event.text, 'ledger-link')];
  }
}

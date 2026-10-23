// xrpl-sonic — the Node group: observed fee pressure from the connected node,
// and the ledgers this browser keeps (src/ledger-cache.js, docs/loader.md).

import { describeHealth, formatPressure, pressureLevel, isFresh } from './health.js';
import { el } from './dom.js';
import { TERMS } from './vocabulary.js';

export function createHealthPanel({ settings, onChange, onCacheChange, onCacheClear }) {
  const poll = el('input', { type: 'checkbox', id: 'health-poll', checked: Boolean(settings.health?.poll), onchange: (e) => onChange?.({ poll: e.target.checked }) });
  const sound = el('input', { type: 'checkbox', id: 'health-sound', checked: Boolean(settings.health?.sound), onchange: (e) => onChange?.({ sound: e.target.checked }) });
  const gauge = el('div', { class: 'health-gauge', 'aria-hidden': 'true' }, [el('div', { class: 'health-fill' })]);
  const headline = el('div', { class: 'health-headline' }, [el('span', { class: 'health-pressure', text: '—' }), el('span', { class: 'health-level', text: 'not polling' })]);
  const detail = el('p', { class: 'health-detail', id: 'health-detail', text: 'Not polling.' });
  const keep = el('input', { type: 'checkbox', id: 'cache-ledgers', checked: settings.cacheLedgers !== false, onchange: (e) => onCacheChange?.(e.target.checked) });
  const cacheText = el('span', { id: 'cache-count', text: '—' });
  const clearBtn = el('button', { type: 'button', class: 'btn small', id: 'cache-clear', text: 'Clear', title: 'Forget the ledgers kept for this network', onclick: () => onCacheClear?.() });
  const historyLine = el('p', { class: 'hint', id: 'history-line', text: '' });
  const root = el('section', { class: 'group health-group' }, [
    el('h2', { text: 'Node' }),
    el('p', { class: 'group-hint', text: TERMS.feePressure.sentence }),
    el('label', { class: 'row check' }, [poll, el('span', { class: 'row-label', text: 'Observed fee pressure' }), el('span', { class: 'hint', text: 'ask the connected node for its open-ledger fee and queue after each ledger close (live only)' })]),
    headline,
    gauge,
    detail,
    el('label', { class: 'row check' }, [sound, el('span', { class: 'row-label', text: 'Sound the pressure' }), el('span', { class: 'hint', text: 'a low drone that rises with the fee pressure; silent at minimum load' })]),
    el('p', { class: 'hint', text: 'Every XRPL server keeps its own transaction queue: this describes the node you are connected to, not one network-wide state.' }),
    el('label', { class: 'row check' }, [keep, el('span', { class: 'row-label', text: 'Keep fetched ledgers in this browser' }), el('span', { class: 'hint', text: 'a validated ledger never changes: one fetched for a case is kept by network, ledger index and hash, and the next case that names it reads it here' })]),
    el('p', { class: 'hint cache-line', id: 'cache-line' }, [cacheText, ' ', clearBtn]),
    historyLine,
  ]);

  return {
    root,

    /** @param {{ fee, load, host, ageMs, serverStream, live }} health */
    render(health) {
      const on = Boolean(settings.health?.poll);
      const fee = on ? health?.fee : null;
      const fresh = fee && isFresh(health.ageMs);
      headline.querySelector('.health-pressure').textContent = fee ? formatPressure(fee.pressure) : '—';
      headline.querySelector('.health-level').textContent = !on ? 'not polling' : !health?.live ? 'live only' : !fee ? 'waiting for a sample' : fresh ? pressureLevel(fee.pressure) : `${pressureLevel(fee.pressure)} · stale`;
      headline.dataset.level = fee ? pressureLevel(fee.pressure) : 'none';
      headline.classList.toggle('stale', Boolean(fee) && !fresh);
      const fill = fee ? Math.min(1, Math.log10(Math.max(1, fee.pressure)) / 3) : 0;
      gauge.querySelector('.health-fill').style.transform = `scaleX(${fill.toFixed(3)})`;
      detail.textContent = !on ? 'Not polling.' : !health?.live ? 'Fee pressure is read from the live node; it is not part of a case.' : describeHealth(health);
    },

    /** The cache line: the count kept for the network (or why there is none), and where history requests go. */
    renderCache({ on = true, available = true, count = null, network = 'mainnet', history = '' } = {}) {
      keep.checked = on;
      cacheText.textContent = !available ? 'No store in this browser: every case is fetched.' : !on ? 'Off: every case is fetched.' : count == null ? 'Kept for this network: —' : `Kept for ${network}: ${count} ledger${count === 1 ? '' : 's'}.`;
      clearBtn.disabled = !available || !on || !count;
      historyLine.textContent = history ? `History (a case’s ledgers, account_tx) is fetched from ${history} first, one expanded ledger per 1.2 s, waiting when the node says slow down; the live stream stays on the node above.` : '';
    },

    applySettings() {
      poll.checked = Boolean(settings.health?.poll);
      sound.checked = Boolean(settings.health?.sound);
      keep.checked = settings.cacheLedgers !== false;
    },
  };
}

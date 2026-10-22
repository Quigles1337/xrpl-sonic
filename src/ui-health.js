// xrpl-sonic — the Node group: observed fee pressure from the connected node.

import { describeHealth, formatPressure, pressureLevel, isFresh } from './health.js';
import { el } from './dom.js';
import { TERMS } from './vocabulary.js';

export function createHealthPanel({ settings, onChange }) {
  const poll = el('input', { type: 'checkbox', id: 'health-poll', checked: Boolean(settings.health?.poll), onchange: (e) => onChange?.({ poll: e.target.checked }) });
  const sound = el('input', { type: 'checkbox', id: 'health-sound', checked: Boolean(settings.health?.sound), onchange: (e) => onChange?.({ sound: e.target.checked }) });
  const gauge = el('div', { class: 'health-gauge', 'aria-hidden': 'true' }, [el('div', { class: 'health-fill' })]);
  const headline = el('div', { class: 'health-headline' }, [el('span', { class: 'health-pressure', text: '—' }), el('span', { class: 'health-level', text: 'not polling' })]);
  const detail = el('p', { class: 'health-detail', id: 'health-detail', text: 'Not polling.' });
  const root = el('section', { class: 'group health-group' }, [
    el('h2', { text: 'Node' }),
    el('p', { class: 'group-hint', text: TERMS.feePressure.sentence }),
    el('label', { class: 'row check' }, [poll, el('span', { class: 'row-label', text: 'Observed fee pressure' }), el('span', { class: 'hint', text: 'ask the connected node for its open-ledger fee and queue after each ledger close (live only)' })]),
    headline,
    gauge,
    detail,
    el('label', { class: 'row check' }, [sound, el('span', { class: 'row-label', text: 'Sound the pressure' }), el('span', { class: 'hint', text: 'a low drone that rises with the fee pressure; silent at minimum load' })]),
    el('p', { class: 'hint', text: 'Every XRPL server keeps its own transaction queue: this describes the node you are connected to, not one network-wide state.' }),
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

    applySettings() {
      poll.checked = Boolean(settings.health?.poll);
      sound.checked = Boolean(settings.health?.sound);
    },
  };
}

// xrpl-sonic — the Geiger group: the detector's settings, its state, the
// explanation of the last crossing, and a sparkline of transactions per
// ledger with the baseline band.

import { GEIGER_LIMITS, totalBand } from './geiger.js';
import { el } from './dom.js';

const STATE_TEXT = { off: 'Off', forming: 'Baseline forming', nominal: 'Nominal', crossing: 'Crossing', stale: 'Stale' };

export function createGeigerPanel({ settings, onChange, onPin, onUnpin }) {
  const enabled = el('input', { type: 'checkbox', id: 'geiger-on', checked: Boolean(settings.geiger?.enabled), onchange: (e) => onChange?.({ enabled: e.target.checked }) });
  const number = (key, labelText, step, hint) => {
    const [min, max] = GEIGER_LIMITS[key];
    const input = el('input', { type: 'number', id: `geiger-${key}`, min, max, step, value: settings.geiger?.[key], 'aria-label': labelText, onchange: (e) => onChange?.({ [key]: Number(e.target.value) }) });
    return { input, row: el('label', { class: 'row' }, [el('span', { class: 'row-label', text: labelText, title: hint }), input]) };
  };
  const windowRow = number('window', 'Baseline window (ledgers)', 1, 'How many previous ledgers form the baseline');
  const thresholdRow = number('threshold', 'Threshold (σ)', 0.5, 'Standard deviations above the baseline that count as a crossing');
  const minCountRow = number('minCount', 'Minimum count', 1, 'A count below this never crosses: one of one is not a flood');
  const adapt = el('input', { type: 'checkbox', id: 'geiger-adapt', checked: settings.geiger?.adapt !== false, onchange: (e) => onChange?.({ adapt: e.target.checked }) });
  const pinBtn = el('button', { type: 'button', class: 'btn small', id: 'geiger-pin', text: 'Pin baseline', title: 'Freeze the baseline as it is now (and save it with the case)', onclick: () => onPin?.() });
  const unpinBtn = el('button', { type: 'button', class: 'btn small hidden', id: 'geiger-unpin', text: 'Unpin', onclick: () => onUnpin?.() });
  const led = el('span', { class: 'geiger-led', 'data-state': 'off', 'aria-hidden': 'true' });
  const stateText = el('span', { class: 'geiger-state', text: 'Off' });
  const detail = el('p', { class: 'geiger-detail', id: 'geiger-detail', text: 'Measures each ledger before any filter or rate limit and reports a crossing with the numbers that produced it.' });
  const canvas = el('canvas', { class: 'geiger-spark', width: 560, height: 96, 'aria-label': 'Transactions per ledger, last 60 ledgers' });
  const crossingsList = el('ol', { class: 'geiger-crossings', id: 'geiger-crossings' });
  const silence = el('p', { class: 'hint', text: 'Silence means no configured deviation was reported while the feed and the detector were running — not that nothing happened.' });

  const root = el('section', { class: 'group geiger-group' }, [
    el('h2', { text: 'Geiger' }),
    el('label', { class: 'row check' }, [enabled, el('span', { class: 'row-label', text: 'Detector on' }), el('span', { class: 'hint', text: 'experimental: counts per ledger against a baseline, and crackles on a crossing' })]),
    el('div', { class: 'geiger-status' }, [led, stateText]),
    detail,
    canvas,
    crossingsList,
    windowRow.row,
    thresholdRow.row,
    minCountRow.row,
    el('label', { class: 'row check' }, [adapt, el('span', { class: 'row-label', text: 'Rolling baseline' }), el('span', { class: 'hint', text: 'keep updating it; off freezes it once formed' })]),
    el('div', { class: 'buttons' }, [pinBtn, unpinBtn]),
    silence,
  ]);

  function drawSpark(geiger) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const history = geiger?.history ?? [];
    const band = geiger ? totalBand(geiger) : null;
    const max = Math.max(10, ...history.map((p) => p.total), band ? band.high : 0) * 1.1;
    const x = (i) => (i / Math.max(1, 59)) * (w - 2) + 1;
    const y = (v) => h - 2 - (v / max) * (h - 12);
    if (band) {
      ctx.fillStyle = 'rgba(76, 201, 240, 0.12)';
      ctx.fillRect(0, y(band.high), w, Math.max(1, y(band.low) - y(band.high)));
      ctx.strokeStyle = 'rgba(76, 201, 240, 0.5)';
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y(band.mean) + 0.5);
      ctx.lineTo(w, y(band.mean) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const offset = 60 - history.length;
    history.forEach((p, i) => {
      const bx = x(offset + i);
      const bw = Math.max(2, (w - 2) / 60 - 1.5);
      ctx.fillStyle = p.crossing ? '#f9c74f' : 'rgba(200, 220, 255, 0.55)';
      ctx.fillRect(bx, y(p.total), bw, h - 2 - y(p.total));
    });
    ctx.fillStyle = 'rgba(127, 140, 166, 0.9)';
    ctx.font = '500 11px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(`max ${Math.round(max / 1.1)} tx`, w - 4, 2);
    if (history.length) {
      ctx.textAlign = 'left';
      ctx.fillText(`#${history.at(-1).ledgerIndex.toLocaleString('en-US')}`, 4, 2);
    }
  }

  return {
    root,

    /** Reflect the detector: status, explanation, crossings, sparkline. `geiger` may be null when off. */
    render(geiger, status) {
      const on = Boolean(settings.geiger?.enabled) && geiger;
      const state = on ? status.state : 'off';
      led.dataset.state = state;
      stateText.textContent = STATE_TEXT[state] ?? state;
      detail.textContent = on ? status.text : 'Measures each ledger before any filter or rate limit and reports a crossing with the numbers that produced it.';
      pinBtn.classList.toggle('hidden', !on || status.pinned || !geiger.formed);
      unpinBtn.classList.toggle('hidden', !on || !status.pinned);
      crossingsList.replaceChildren(
        ...(on ? status.crossings : []).slice(0, 5).map((c) => el('li', {}, [el('span', { class: 'geiger-z', text: `${c.z.toFixed(1)}σ` }), el('span', { text: c.explanation })])),
      );
      crossingsList.classList.toggle('hidden', !on || status.crossings.length === 0);
      canvas.classList.toggle('hidden', !on);
      if (on) drawSpark(geiger);
    },

    applySettings() {
      enabled.checked = Boolean(settings.geiger?.enabled);
      windowRow.input.value = settings.geiger?.window;
      thresholdRow.input.value = settings.geiger?.threshold;
      minCountRow.input.value = settings.geiger?.minCount;
      adapt.checked = settings.geiger?.adapt !== false;
    },
  };
}

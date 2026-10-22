// xrpl-sonic — the Field group in the instrument panel (docs/coherence.md, phase 2).
//
// The interference field is off by default; on, it draws interference
// between the cast's sigils for every pair that clears the coherence bar,
// or for one chosen pair of cast members. The bin the series are read in
// (ledger, minute, hour, day) is chosen here too, per case; the default
// stays the ledger.

import { BIN_NAMES } from './coherence.js';
import { el, option } from './dom.js';

const MODE_WORDS = Object.freeze({ off: 'Off', cast: 'Every cast pair above the bar', pair: 'One chosen pair' });

/**
 * @param {object} args
 * @param {object} args.settings   live settings; `settings.field` is read and replaced
 * @param {(patch: object) => void} args.onChange   called with { field } or { bin }
 * @param {() => string} args.binNow   the bin currently in force (not a setting)
 */
export function createFieldPanel({ settings, onChange, binNow }) {
  const mode = el('select', { id: 'field-mode', 'aria-label': 'Interference field', onchange: (e) => commit({ mode: e.target.value }) }, Object.entries(MODE_WORDS).map(([k, label]) => option(k, label, settings.field?.mode === k)));
  const first = el('select', { id: 'field-pair-a', 'aria-label': 'First account of the pair', onchange: () => commitPair() });
  const second = el('select', { id: 'field-pair-b', 'aria-label': 'Second account of the pair', onchange: () => commitPair() });
  const bin = el('select', { id: 'coherence-bin', 'aria-label': 'Read the series per ledger, minute, hour or day', onchange: (e) => onChange?.({ bin: e.target.value }) }, BIN_NAMES.map((b) => option(b, b === 'ledger' ? 'ledger (default)' : b, (binNow?.() ?? 'ledger') === b)));
  const summary = el('p', { class: 'hint field-summary', id: 'field-summary', 'aria-live': 'polite', text: 'Off. Interference between cast sigils, drawn only for pairs above the coherence bar; a click on a fringe shows the pair’s line.' });
  const pairRow = el('label', { class: 'row field-pair' }, [el('span', { class: 'row-label', text: 'Pair' }), first, el('span', { class: 'field-pair-sep', text: '↔', 'aria-hidden': 'true' }), second]);

  function members() {
    return Array.isArray(settings.cast) ? settings.cast : [];
  }

  function commit(patch) {
    const next = { mode: settings.field?.mode ?? 'off', pair: settings.field?.pair ?? null, ...patch };
    if (next.mode === 'pair' && !next.pair) {
      const m = members();
      next.pair = m.length >= 2 ? [m[0].address, m[1].address] : null;
      if (!next.pair) next.mode = 'cast';
    }
    onChange?.({ field: next });
    render();
  }

  function commitPair() {
    const a = first.value;
    const b = second.value;
    if (!a || !b || a === b) {
      render();
      return;
    }
    commit({ mode: 'pair', pair: [a, b] });
  }

  function render() {
    const f = settings.field ?? { mode: 'off', pair: null };
    mode.value = f.mode;
    const m = members();
    const fill = (select, chosen) => select.replaceChildren(...m.map((x) => option(x.address, x.label, x.address === chosen)));
    fill(first, f.pair?.[0] ?? m[0]?.address);
    fill(second, f.pair?.[1] ?? m[1]?.address);
    const pairable = m.length >= 2;
    pairRow.classList.toggle('hidden', f.mode !== 'pair');
    first.disabled = second.disabled = !pairable;
    for (const o of mode.options) if (o.value === 'pair') o.disabled = !pairable;
    bin.value = binNow?.() ?? 'ledger';
  }

  const root = el('section', { class: 'group field-group' }, [
    el('h2', { text: 'Field' }),
    el('label', { class: 'row' }, [el('span', { class: 'row-label', text: 'Interference' }), mode]),
    pairRow,
    el('label', { class: 'row' }, [el('span', { class: 'row-label', text: 'Read per' }), bin]),
    summary,
  ]);
  render();

  return {
    root,
    render,
    /** The sentence under the controls: why nothing is drawn, or what is. */
    setSummary(text) {
      summary.textContent = text ?? '';
    },
    applySettings() {
      render();
    },
  };
}

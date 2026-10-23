// xrpl-sonic — the Learn panel (docs/ux.md, PR 2): the three tours, and the
// step being shown with Back, Next and Exit. The step's sentence is also sent
// to the caption strip, so the text equivalent is where every other caption
// is; here it is in a live region a screen reader follows.

import { TOURS, LIVE_OPTION } from './tours.js';
import { categoryIcon, eventIcon } from './glyphs.js';
import { el, svg } from './dom.js';

export function createLearnPanel({ onRun, onNext, onBack, onExit }) {
  const list = el('div', { class: 'tours', role: 'list' });
  for (const t of TOURS) {
    // a tour that loads a case opens it from the bundled ledgers; the option fetches them live from the node instead (docs/loader.md)
    const live = t.needsCase ? el('input', { type: 'checkbox', id: `tour-live-${t.id}`, 'data-live': t.id }) : null;
    list.append(
      el('div', { class: 'tour', role: 'listitem', 'data-tour': t.id }, [
        el('div', { class: 'tour-head' }, [el('span', { class: 'tour-name', text: t.name }), el('button', { type: 'button', class: 'btn small', 'data-run': t.id, text: 'Start', title: `Start the tour: ${t.name}`, onclick: () => onRun?.(t.id, { live: Boolean(live?.checked) }) })]),
        el('p', { class: 'tour-line', text: t.line }),
        live ? el('label', { class: 'row check tour-live' }, [live, el('span', { class: 'row-label', text: LIVE_OPTION.label }), el('span', { class: 'hint', text: LIVE_OPTION.hint })]) : '',
      ]),
    );
  }
  const stepTitle = el('span', { class: 'step-title', id: 'learn-step-title' });
  const stepCount = el('span', { class: 'step-count', id: 'learn-step-count' });
  const stepGlyph = el('span', { class: 'step-glyph', 'aria-hidden': 'true' });
  const stepText = el('p', { class: 'step-text', id: 'learn-step-text', 'aria-live': 'polite' });
  const busy = el('p', { class: 'hint step-busy hidden', id: 'learn-busy', text: 'Loading the case…' });
  const backBtn = el('button', { type: 'button', class: 'btn small', id: 'learn-back', text: '◀ Back', onclick: () => onBack?.() });
  const nextBtn = el('button', { type: 'button', class: 'btn small primary', id: 'learn-next', text: 'Next ▶', onclick: () => onNext?.() });
  const exitBtn = el('button', { type: 'button', class: 'btn small', id: 'learn-exit', text: 'Exit tour', onclick: () => onExit?.() });
  const step = el('section', { class: 'tour-step hidden', id: 'learn-step', 'aria-label': 'The current step' }, [
    el('div', { class: 'step-head' }, [stepGlyph, stepTitle, stepCount]),
    stepText,
    busy,
    el('div', { class: 'buttons' }, [backBtn, nextBtn, exitBtn]),
  ]);
  const root = el('div', { class: 'learn-body' }, [
    el('p', { class: 'group-hint', text: 'Three short tours, each a few steps you walk with Next and Back; every sentence is shown here and in the caption strip.' }),
    step,
    list,
  ]);

  return {
    root,

    /** Show a step: the tour's name, k of n, the sentence, the legend tile when there is one; `busy` while the page loads a case. */
    showStep({ tour, index, total, text, glyph = null, busy: loading = false, first = false, last = false }) {
      step.classList.remove('hidden');
      stepTitle.textContent = tour.name;
      stepCount.textContent = `${index + 1} of ${total}`;
      stepText.textContent = text;
      stepGlyph.replaceChildren(glyph ? svg(glyph.category === 'ledger' ? eventIcon({ kind: 'ledger' }, 18) : categoryIcon(glyph.category, 18)) : '');
      stepGlyph.style.setProperty('--glyph', glyph?.colour ?? 'currentColor');
      busy.classList.toggle('hidden', !loading);
      backBtn.disabled = first || loading;
      nextBtn.disabled = loading;
      nextBtn.textContent = last ? 'Finish' : 'Next ▶';
      for (const b of list.querySelectorAll('[data-run]')) b.setAttribute('aria-pressed', String(b.dataset.run === tour.id));
      nextBtn.focus();
    },

    /** While a step loads a case: the transport's own loading count, so the wait says where it is. */
    setBusy(text) {
      busy.textContent = text || 'Loading the case…';
    },

    /** No tour running: the list alone. */
    clear() {
      step.classList.add('hidden');
      stepText.textContent = '';
      for (const b of list.querySelectorAll('[data-run]')) b.setAttribute('aria-pressed', 'false');
    },
  };
}

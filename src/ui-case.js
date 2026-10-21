// xrpl-sonic — the Case group in the instrument panel.
//
// Load a case file, save the current one, copy a link that carries it, save
// the transcript, and the three accessibility toggles: captions, spoken
// annotations, pause at annotations.

import { caseLedgerCount } from './case.js';
import { formatClock } from './score.js';
import { speechSupported } from './speech.js';
import { el } from './dom.js';

export function createCasePanel({ settings, onLoadFile, onSave, onCopyLink, onTranscript, onToggle }) {
  const status = el('p', { class: 'case-status', id: 'case-status', text: 'No case loaded. Open #replay=… or load a file.' });
  const warnings = el('ul', { class: 'case-warnings hidden', id: 'case-warnings' });
  const file = el('input', { type: 'file', accept: '.json,application/json', class: 'visually-hidden', id: 'case-file', 'aria-label': 'Load a case file' });
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (f) onLoadFile?.(f);
    file.value = '';
  });
  const loadBtn = el('button', { type: 'button', class: 'btn small', id: 'case-load', text: 'Load file', onclick: () => file.click() });
  const saveBtn = el('button', { type: 'button', class: 'btn small', id: 'case-save', text: 'Save file', disabled: true, onclick: () => onSave?.() });
  const linkBtn = el('button', { type: 'button', class: 'btn small', id: 'case-link', text: 'Copy link', disabled: true, onclick: () => onCopyLink?.() });
  const transcriptBtn = el('button', { type: 'button', class: 'btn small', id: 'case-transcript', text: 'Transcript', disabled: true, title: 'Save the whole score as text', onclick: () => onTranscript?.() });

  const toggle = (key, labelText, hint, disabled = false) => {
    const box = el('input', { type: 'checkbox', id: `opt-${key}`, checked: Boolean(settings[key]), disabled, onchange: (e) => onToggle?.(key, e.target.checked) });
    return { box, row: el('label', { class: 'row check' }, [box, el('span', { class: 'row-label', text: labelText }), hint ? el('span', { class: 'hint', text: hint }) : '']) };
  };
  const captions = toggle('captions', 'Captions', 'annotations, gaps and cast events as text');
  const speak = toggle('speak', 'Speak annotations', speechSupported() ? 'read each note aloud, independent of the sound' : 'this browser has no speech synthesis', !speechSupported());
  const pause = toggle('pauseAtNotes', 'Pause at annotations', 'when a note asks for it');

  const root = el('section', { class: 'group case-group' }, [
    el('h2', { text: 'Case' }),
    status,
    warnings,
    el('div', { class: 'buttons' }, [loadBtn, saveBtn, linkBtn, transcriptBtn, file]),
    captions.row,
    speak.row,
    pause.row,
  ]);

  return {
    root,

    /** Describe the loaded case (or clear it). */
    setCase(theCase, score, extraWarnings = []) {
      const has = Boolean(theCase);
      saveBtn.disabled = !has;
      linkBtn.disabled = !has;
      transcriptBtn.disabled = !score;
      if (!has) {
        status.textContent = 'No case loaded. Open #replay=… or load a file.';
        warnings.classList.add('hidden');
        warnings.replaceChildren();
        return;
      }
      const title = theCase.title || theCase.id;
      const clips = theCase.clips.length;
      const ledgers = caseLedgerCount(theCase);
      const bits = [`${title}`, `${theCase.network}`, `${clips} clip${clips === 1 ? '' : 's'}`, `${ledgers} ledger${ledgers === 1 ? '' : 's'}`, `cast ${theCase.cast.length}`];
      if (score) bits.push(`${score.counts.events} events (${score.counts.dim} silent)`, formatClock(score.totalMs));
      if (theCase.annotations.length) bits.push(`${theCase.annotations.length} note${theCase.annotations.length === 1 ? '' : 's'}`);
      status.textContent = bits.join(' · ');
      const all = [...extraWarnings, ...(score?.warnings ?? [])];
      warnings.replaceChildren(...all.map((w) => el('li', { text: w })));
      warnings.classList.toggle('hidden', all.length === 0);
    },

    applySettings() {
      captions.box.checked = Boolean(settings.captions);
      speak.box.checked = Boolean(settings.speak);
      pause.box.checked = Boolean(settings.pauseAtNotes);
    },

    setBusy(busy) {
      loadBtn.disabled = busy;
    },
  };
}

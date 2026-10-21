// xrpl-sonic — the Case group in the instrument panel.
//
// Load a case file, save the current one, copy a link that carries it, save
// the transcript; the three accessibility toggles (captions, spoken
// annotations, pause at annotations); the notes list, where annotations are
// read, added, edited and removed; and blind mode for comparisons.

import { caseLedgerCount, ANNOTATION_STATUSES } from './case.js';
import { formatClock } from './score.js';
import { speechSupported } from './speech.js';
import { el, option } from './dom.js';

export function createCasePanel({ settings, onLoadFile, onSave, onCopyLink, onTranscript, onToggle, onAddNote, onEditNote, onRemoveNote, onJumpNote, onBlind }) {
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
  const blindBox = el('input', { type: 'checkbox', id: 'opt-blind', onchange: (e) => onBlind?.(e.target.checked) });
  const blindRow = el('label', { class: 'row check' }, [blindBox, el('span', { class: 'row-label', text: 'Blind comparison' }), el('span', { class: 'hint', text: 'hide ledger numbers, the tape, notes and captions: compare windows by ear' })]);

  // --- Notes ------------------------------------------------------------------
  const notesList = el('ul', { class: 'notes', id: 'notes' });
  const addBtn = el('button', { type: 'button', class: 'btn small', id: 'note-add', text: 'Note here', title: 'Add a note at the current position', disabled: true, onclick: () => onAddNote?.() });
  const notesHead = el('div', { class: 'notes-head' }, [el('span', { class: 'notes-title', text: 'Notes' }), addBtn]);
  let current = null; // { case, score }
  let editing = null; // annotation id
  let fresh = null; // id of a note that was just added: cancelling its first edit removes it

  function timeOf(id) {
    const r = current?.score?.annotations.find((a) => a.id === id);
    return r ? formatClock(r.timeMs) : '—';
  }

  function anchorText(a) {
    if (a.anchor.hash) return `tx ${a.anchor.hash.slice(0, 8)}…`;
    if (a.anchor.ledger != null) return `ledger #${a.anchor.ledger.toLocaleString('en-US')}`;
    return `at ${formatClock(a.anchor.timeMs)}`;
  }

  function noteRow(a) {
    if (editing === a.id) return editorRow(a);
    const time = el('button', { type: 'button', class: 'note-time', text: timeOf(a.id), title: 'Jump to this note', onclick: () => onJumpNote?.(a.id) });
    const text = el('button', { type: 'button', class: 'note-text', text: a.text, title: 'Edit this note', onclick: () => openEditor(a.id) });
    const meta = el('span', { class: 'note-meta', text: [anchorText(a), a.source, a.status, a.pause ? 'pauses' : ''].filter(Boolean).join(' · ') });
    return el('li', { class: `note ${a.status}${a.pause ? ' pause' : ''}`, 'data-id': a.id }, [time, el('span', { class: 'note-body' }, [text, meta])]);
  }

  function editorRow(a) {
    const text = el('textarea', { class: 'note-edit-text', rows: 3, maxlength: 500, 'aria-label': 'Note text' });
    text.value = a.text;
    const source = el('input', { type: 'text', class: 'note-edit-source', placeholder: 'Source (optional)', maxlength: 120, 'aria-label': 'Source of the note' });
    source.value = a.source ?? '';
    const statusSel = el('select', { class: 'note-edit-status', 'aria-label': 'Status' }, ANNOTATION_STATUSES.map((s) => option(s, s, a.status === s)));
    const pauseBox = el('input', { type: 'checkbox', checked: a.pause, 'aria-label': 'Pause here' });
    const save = el('button', { type: 'button', class: 'btn small primary', text: 'Save', onclick: () => {
      const value = text.value.trim();
      if (!value) {
        text.focus();
        return;
      }
      editing = null;
      fresh = null;
      onEditNote?.(a.id, { text: value, source: source.value.trim(), status: statusSel.value, pause: pauseBox.checked });
    } });
    const cancel = el('button', { type: 'button', class: 'btn small', text: 'Cancel', onclick: () => {
      editing = null;
      const discard = fresh === a.id;
      fresh = null;
      if (discard) onRemoveNote?.(a.id);
      else render();
    } });
    const remove = el('button', { type: 'button', class: 'btn small danger', text: 'Delete', onclick: () => {
      editing = null;
      onRemoveNote?.(a.id);
    } });
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save.click();
      if (e.key === 'Escape') cancel.click();
    });
    const row = el('li', { class: 'note editing', 'data-id': a.id }, [
      el('span', { class: 'note-meta', text: `${timeOf(a.id)} · ${anchorText(a)}` }),
      text,
      el('div', { class: 'note-edit-row' }, [source, statusSel, el('label', { class: 'note-pause' }, [pauseBox, el('span', { text: 'pause' })])]),
      el('div', { class: 'note-edit-row' }, [save, cancel, remove]),
    ]);
    queueMicrotask(() => text.focus());
    return row;
  }

  function render() {
    const list = current?.case?.annotations ?? [];
    const order = new Map((current?.score?.annotations ?? []).map((a, i) => [a.id, i]));
    const sorted = [...list].sort((x, y) => (order.get(x.id) ?? 1e9) - (order.get(y.id) ?? 1e9));
    notesList.replaceChildren(...sorted.map(noteRow));
    notesList.classList.toggle('hidden', sorted.length === 0);
    addBtn.disabled = !current?.case;
  }

  function openEditor(id) {
    editing = id;
    render();
    notesList.querySelector('.note.editing')?.scrollIntoView({ block: 'nearest' });
  }

  const root = el('section', { class: 'group case-group' }, [
    el('h2', { text: 'Case' }),
    status,
    warnings,
    el('div', { class: 'buttons' }, [loadBtn, saveBtn, linkBtn, transcriptBtn, file]),
    notesHead,
    notesList,
    captions.row,
    speak.row,
    pause.row,
    blindRow,
  ]);

  return {
    root,

    /** Describe the loaded case (or clear it) and render its notes. */
    setCase(theCase, score, extraWarnings = []) {
      current = theCase ? { case: theCase, score } : null;
      const has = Boolean(theCase);
      saveBtn.disabled = !has;
      linkBtn.disabled = !has;
      transcriptBtn.disabled = !score;
      if (!has) {
        status.textContent = 'No case loaded. Open #replay=… or load a file.';
        warnings.classList.add('hidden');
        warnings.replaceChildren();
        editing = null;
        render();
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
      render();
    },

    /** Start editing a note; `isNew` marks one that was just added, so Cancel discards it. */
    edit(id, { isNew = false } = {}) {
      fresh = isNew ? id : null;
      openEditor(id);
      root.scrollIntoView({ block: 'nearest' });
    },

    applySettings() {
      captions.box.checked = Boolean(settings.captions);
      speak.box.checked = Boolean(settings.speak);
      pause.box.checked = Boolean(settings.pauseAtNotes);
    },

    setBlind(on) {
      blindBox.checked = Boolean(on);
    },

    setBusy(busy) {
      loadBtn.disabled = busy;
    },
  };
}

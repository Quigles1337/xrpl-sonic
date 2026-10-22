// xrpl-sonic — the Case group in the instrument panel.
//
// Load a case file, save the current one, copy a link that carries it, save
// the transcript; the three accessibility toggles (captions, spoken
// annotations, pause at annotations); the notes list, where annotations are
// read, added, edited and removed; and blind mode for comparisons.

import { caseLedgerCount, ANNOTATION_STATUSES } from './case.js';
import { formatClock } from './score.js';
import { speechSupported } from './speech.js';
import { el, option, setGuard, reasonStrip, guarded } from './dom.js';
import { TERMS, REASONS, WAYS_TO_A_CASE } from './vocabulary.js';

export function createCasePanel({ settings, onLoadFile, onLoadSample, onSave, onCopyLink, onTranscript, onAi, onImport, onCoherence, onToggle, onAddNote, onEditNote, onRemoveNote, onJumpNote, onBlind }) {
  const status = el('p', { class: 'case-status', id: 'case-status', text: 'No case loaded.' });
  // the empty state: the ways to get a case, easiest first (docs/ux.md)
  const sampleBtn = el('button', { type: 'button', class: 'btn small inline', id: 'case-sample', text: 'Open the sample case', title: 'Two real accounts over three mainnet ledgers, from docs/cases', onclick: () => onLoadSample?.() });
  const loadInline = el('button', { type: 'button', class: 'btn small inline', text: 'Load file', onclick: () => file.click() });
  const empty = el('div', { class: 'empty-state', id: 'case-empty' }, [
    el('span', { text: 'A case is how a listening is kept. Ways to get one, easiest first:' }),
    el('ol', {}, WAYS_TO_A_CASE.map((way, i) => el('li', {}, i === 1 ? [sampleBtn, document.createTextNode(`: ${way.replace(/^Open the sample case: /, '')}`)] : i === 2 ? [loadInline, document.createTextNode(': a .sonic-case.json file.')] : [document.createTextNode(way)]))),
  ]);
  const warnings = el('ul', { class: 'case-warnings hidden', id: 'case-warnings' });
  const file = el('input', { type: 'file', accept: '.json,application/json', class: 'visually-hidden', id: 'case-file', 'aria-label': 'Load a case file' });
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (f) onLoadFile?.(f);
    file.value = '';
  });
  const loadBtn = el('button', { type: 'button', class: 'btn small', id: 'case-load', text: 'Load file', onclick: () => file.click() });
  // guarded, not disabled: each keeps focus and says why it cannot act yet (docs/ux.md)
  const saveBtn = el('button', { type: 'button', class: 'btn small', id: 'case-save', text: 'Save file', title: 'Save the case as a .sonic-case.json file' });
  saveBtn.addEventListener('click', guarded(saveBtn, () => onSave?.()));
  const linkBtn = el('button', { type: 'button', class: 'btn small', id: 'case-link', text: 'Copy link', title: 'Copy a link that carries the case (#case=)' });
  linkBtn.addEventListener('click', guarded(linkBtn, () => onCopyLink?.()));
  const transcriptBtn = el('button', { type: 'button', class: 'btn small', id: 'case-transcript', text: 'Transcript', title: TERMS.transcript.sentence });
  transcriptBtn.addEventListener('click', guarded(transcriptBtn, () => onTranscript?.()));
  const aiBtn = el('button', { type: 'button', class: 'btn small', id: 'case-ai', text: 'Copy for AI', title: TERMS.copyForAi.sentence });
  aiBtn.addEventListener('click', guarded(aiBtn, () => onAi?.()));
  // Coherence (src/coherence.js): the correlation of the cast's (or the top submitters') activity per ledger, over the playing case or the live window
  const coherenceBtn = el('button', { type: 'button', class: 'btn small', id: 'case-coherence', text: 'Coherence', title: TERMS.coherence.sentence, onclick: () => onCoherence?.() });
  const buttonReasons = reasonStrip([saveBtn, linkBtn, transcriptBtn, aiBtn], 'case-reasons');

  // --- Import notes: an assistant's answer, pasted back as drafts --------------
  const importText = el('textarea', { class: 'import-text', id: 'import-text', rows: 3, placeholder: 'Paste the JSON an assistant returned: an array of annotations, or a whole case', 'aria-label': 'Annotations to import' });
  const importSource = el('input', { type: 'text', id: 'import-source', maxlength: 120, placeholder: 'Source (who wrote them)', 'aria-label': 'Source of the imported notes' });
  importSource.value = 'assistant';
  const importBtn = el('button', { type: 'button', class: 'btn small', id: 'import-notes', text: 'Import notes', title: TERMS.importNotes.sentence });
  importBtn.addEventListener('click', guarded(importBtn, () => {
    const text = importText.value.trim();
    if (!text) {
      importText.focus();
      return;
    }
    onImport?.(text, importSource.value.trim() || 'assistant');
  }));
  const importReasons = reasonStrip([importBtn], 'import-reasons');
  const importResult = el('p', { class: 'hint import-result hidden', id: 'import-result' });
  const importBox = el('div', { class: 'import-box' }, [el('p', { class: 'group-hint', text: TERMS.importNotes.sentence }), importText, el('div', { class: 'import-row' }, [importSource, importBtn]), importReasons, importResult]);

  const toggle = (key, labelText, hint, disabled = false) => {
    const box = el('input', { type: 'checkbox', id: `opt-${key}`, checked: Boolean(settings[key]), disabled, onchange: (e) => onToggle?.(key, e.target.checked) });
    return { box, row: el('label', { class: 'row check' }, [box, el('span', { class: 'row-label', text: labelText }), hint ? el('span', { class: 'hint', text: hint }) : '']) };
  };
  const captions = toggle('captions', 'Captions', TERMS.captions.sentence);
  const speak = toggle('speak', 'Speak annotations', speechSupported() ? TERMS.speak.sentence : `${TERMS.speak.sentence} This browser has no speech synthesis.`, !speechSupported());
  const pause = toggle('pauseAtNotes', 'Pause at annotations', TERMS.pauseAtNotes.sentence);
  const blindBox = el('input', { type: 'checkbox', id: 'opt-blind', onchange: (e) => onBlind?.(e.target.checked) });
  const blindRow = el('label', { class: 'row check' }, [blindBox, el('span', { class: 'row-label', text: 'Blind comparison' }), el('span', { class: 'hint', text: TERMS.blind.sentence })]);

  // --- Notes ------------------------------------------------------------------
  const notesList = el('ul', { class: 'notes', id: 'notes' });
  const addBtn = el('button', { type: 'button', class: 'btn small', id: 'note-add', text: 'Note here', title: 'Add a note at the current position' });
  addBtn.addEventListener('click', guarded(addBtn, () => onAddNote?.()));
  const addReasons = reasonStrip([addBtn], 'note-reasons');
  const notesHead = el('div', { class: 'notes-head' }, [el('span', { class: 'notes-title', text: 'Notes' }), addBtn]);
  const notesEmpty = el('p', { class: 'empty-state hidden', id: 'notes-empty', text: `No notes yet. ${TERMS.notes.sentence}` });
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
    const meta = el('span', { class: 'note-meta', text: [a.question ? 'the question' : '', anchorText(a), a.source, a.status, a.pause ? 'pauses' : ''].filter(Boolean).join(' · ') });
    return el('li', { class: `note ${a.status}${a.pause ? ' pause' : ''}${a.question ? ' question' : ''}`, 'data-id': a.id }, [time, el('span', { class: 'note-body' }, [text, meta])]);
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
    notesEmpty.classList.toggle('hidden', !current?.case || sorted.length > 0);
    setGuard(addBtn, current?.case ? null : REASONS.needsCase);
  }

  function openEditor(id) {
    editing = id;
    render();
    notesList.querySelector('.note.editing')?.scrollIntoView({ block: 'nearest' });
  }

  // the initial state is the empty one: every control that needs a case says so from the start
  for (const b of [saveBtn, linkBtn, transcriptBtn, aiBtn, importBtn, addBtn]) setGuard(b, REASONS.needsCase);

  const root = el('section', { class: 'group case-group' }, [
    el('h2', { text: 'Case' }),
    el('p', { class: 'group-hint', text: TERMS.case.sentence }),
    status,
    empty,
    warnings,
    el('div', { class: 'buttons' }, [loadBtn, saveBtn, linkBtn, transcriptBtn, aiBtn, coherenceBtn, file]),
    buttonReasons,
    notesHead,
    notesList,
    notesEmpty,
    addReasons,
    importBox,
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
      setGuard(saveBtn, has ? null : REASONS.needsCase);
      setGuard(linkBtn, has ? null : REASONS.needsCase);
      setGuard(transcriptBtn, score ? null : has ? REASONS.needsScore : REASONS.needsCase);
      setGuard(aiBtn, score ? null : has ? REASONS.needsScore : REASONS.needsCase);
      setGuard(importBtn, has ? null : REASONS.needsCase);
      empty.classList.toggle('hidden', has);
      if (!has) {
        status.textContent = 'No case loaded.';
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
      if (!score) bits.push('press Start to play it');
      status.textContent = bits.join(' · ');
      const all = [...extraWarnings, ...(score?.warnings ?? [])];
      warnings.replaceChildren(...all.map((w) => el('li', { text: w })));
      warnings.classList.toggle('hidden', all.length === 0);
      render();
    },

    /** What an import did: accepted and rejected, in a line under the box; the pasted text is cleared when something was accepted. */
    setImportResult(result) {
      if (!result) {
        importResult.classList.add('hidden');
        return;
      }
      const parts = [`${result.accepted.length} accepted as draft${result.accepted.length === 1 ? '' : 's'}`];
      if (result.rejected.length) parts.push(`${result.rejected.length} rejected: ${result.rejected.map((r) => `#${r.index + 1} ${r.reason}`).join('; ')}`);
      importResult.textContent = parts.join(' · ');
      importResult.classList.remove('hidden');
      if (result.accepted.length) importText.value = '';
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
      setGuard(loadBtn, busy ? REASONS.loading : null);
    },
  };
}

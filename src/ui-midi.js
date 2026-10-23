// xrpl-sonic — the MIDI group: save the score as a file, or send it live.

import { midiSupported } from './midi-out.js';
import { el, option, setGuard, reasonStrip, guarded } from './dom.js';
import { TERMS, REASONS } from './vocabulary.js';

export function createMidiPanel({ settings, onSave, onConnect, onSelect }) {
  const saveBtn = el('button', { type: 'button', class: 'btn small', id: 'midi-save', text: 'Save MIDI file', title: 'Write the score as a Standard MIDI File: one track per voice and cast member, ledger closes on the percussion channel, notes as markers' });
  saveBtn.addEventListener('click', guarded(saveBtn, () => onSave?.()));
  setGuard(saveBtn, REASONS.needsScore);
  const connectBtn = el('button', { type: 'button', class: 'btn small', id: 'midi-connect', text: 'Connect', title: 'Ask the browser for MIDI outputs' });
  connectBtn.addEventListener('click', guarded(connectBtn, () => onConnect?.()));
  if (!midiSupported()) setGuard(connectBtn, 'Web MIDI is not available here (it needs a secure context and a browser that offers it); the file export still works.');
  const midiReasons = reasonStrip([saveBtn, connectBtn], 'midi-reasons');
  const outputs = el('select', { id: 'midi-output', 'aria-label': 'MIDI output', disabled: true, onchange: (e) => onSelect?.(e.target.value) }, [option('', 'No output', true)]);
  const status = el('p', { class: 'hint', id: 'midi-status', text: midiSupported() ? 'A MIDI file carries the notes; the instrument that plays it decides how they sound. Live output sends the same notes as they play.' : 'MIDI file export works everywhere; live output needs Web MIDI, which this browser or context does not offer.' });
  const root = el('section', { class: 'group midi-group' }, [el('h2', { text: 'MIDI' }), el('p', { class: 'group-hint', text: TERMS.midi.sentence }), el('div', { class: 'buttons' }, [saveBtn, connectBtn]), midiReasons, el('label', { class: 'row' }, [el('span', { class: 'row-label', text: 'Live output' }), outputs]), status]);

  return {
    root,

    setScoreAvailable(available) {
      setGuard(saveBtn, available ? null : REASONS.needsScore);
    },

    /** Populate the outputs after a connect; keep the preferred one selected when it is present. */
    setOutputs(list, selectedId) {
      outputs.replaceChildren(option('', 'No output', !selectedId), ...list.map((o) => option(o.id, o.name, o.id === selectedId)));
      outputs.disabled = list.length === 0;
      status.textContent = list.length ? `${list.length} output${list.length === 1 ? '' : 's'} available.${selectedId ? ' Sending.' : ''}` : 'No MIDI outputs found. Plug in or open a software instrument, then Connect again.';
    },

    setStatus(text) {
      status.textContent = text;
    },
  };
}

// xrpl-sonic — the MIDI group: save the score as a file, or send it live.

import { midiSupported } from './midi-out.js';
import { el, option } from './dom.js';

export function createMidiPanel({ settings, onSave, onConnect, onSelect }) {
  const saveBtn = el('button', { type: 'button', class: 'btn small', id: 'midi-save', text: 'Save MIDI file', disabled: true, title: 'Write the score as a Standard MIDI File: one track per voice and cast member, ledger closes on the percussion channel, notes as markers', onclick: () => onSave?.() });
  const connectBtn = el('button', { type: 'button', class: 'btn small', id: 'midi-connect', text: 'Connect', disabled: !midiSupported(), title: midiSupported() ? 'Ask the browser for MIDI outputs' : 'Web MIDI is not available here (it needs a secure context and a browser that offers it)', onclick: () => onConnect?.() });
  const outputs = el('select', { id: 'midi-output', 'aria-label': 'MIDI output', disabled: true, onchange: (e) => onSelect?.(e.target.value) }, [option('', 'No output', true)]);
  const status = el('p', { class: 'hint', id: 'midi-status', text: midiSupported() ? 'A MIDI file carries the notes; the instrument that plays it decides how they sound. Live output sends the same notes as they play.' : 'MIDI file export works everywhere; live output needs Web MIDI, which this browser or context does not offer.' });
  const root = el('section', { class: 'group midi-group' }, [el('h2', { text: 'MIDI' }), el('div', { class: 'buttons' }, [saveBtn, connectBtn]), el('label', { class: 'row' }, [el('span', { class: 'row-label', text: 'Live output' }), outputs]), status]);

  return {
    root,

    setScoreAvailable(available) {
      saveBtn.disabled = !available;
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

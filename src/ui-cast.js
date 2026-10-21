// xrpl-sonic — the cast panel: follow up to five accounts, each with a voice of its own.

import { CAST_MAX, CAST_VOICES, CAST_VOICE_NAMES, CAST_MODES, normalizeCast } from './cast.js';
import { isValidAddress, shortAddress } from './mapping.js';
import { el, option } from './dom.js';

/**
 * Build the Cast group for the settings panel.
 * @param {object} args
 * @param {object} args.settings        live settings; `settings.cast` and `settings.castMode` are read and replaced
 * @param {(patch: object) => void} args.onChange   called with { cast } or { castMode }
 * @param {(member: object) => void} args.onPreview  play a member's motif
 * @param {(address: string) => string|null} args.linkFor  explorer URL for an address
 */
export function createCastPanel({ settings, onChange, onPreview, linkFor }) {
  const list = el('div', { class: 'cast-list', role: 'list' });
  const hint = el('span', { class: 'hint cast-hint', id: 'cast-hint' });
  const addAddress = el('input', {
    type: 'text',
    id: 'cast-address',
    placeholder: 'r… address',
    spellcheck: 'false',
    autocomplete: 'off',
    autocapitalize: 'off',
    'aria-label': 'Account to add to the cast',
    'aria-describedby': 'cast-hint',
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        add();
      }
    },
  });
  const addLabel = el('input', {
    type: 'text',
    id: 'cast-label',
    placeholder: 'Label (optional)',
    maxlength: 24,
    autocomplete: 'off',
    'aria-label': 'Label for the account',
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        add();
      }
    },
  });
  const addBtn = el('button', { type: 'button', class: 'btn small', id: 'cast-add', text: 'Add', onclick: () => add() });
  const mode = el(
    'select',
    { id: 'cast-mode', 'aria-label': 'What to do with transactions outside the cast', onchange: (e) => onChange({ castMode: e.target.value }) },
    Object.entries(CAST_MODES).map(([k, label]) => option(k, label, settings.castMode === k)),
  );

  const root = el('section', { class: 'group cast-group' }, [
    el('h2', { text: 'Cast' }),
    list,
    el('div', { class: 'cast-add' }, [addAddress, addLabel, addBtn]),
    hint,
    el('label', { class: 'row' }, [el('span', { class: 'row-label', text: 'Outside the cast' }), mode]),
  ]);

  function fail(message) {
    addAddress.setAttribute('aria-invalid', 'true');
    hint.textContent = message;
    hint.classList.add('error');
  }

  function add() {
    const address = addAddress.value.trim();
    if (!address) return;
    if (!isValidAddress(address)) return fail('Not a valid r-address.');
    if (settings.cast.some((m) => m.address === address)) return fail('That account is already in the cast.');
    if (settings.cast.length >= CAST_MAX) return fail(`A cast has at most ${CAST_MAX} members.`);
    addAddress.removeAttribute('aria-invalid');
    hint.classList.remove('error');
    const label = addLabel.value.trim();
    commit([...settings.cast, { address, label }]);
    addAddress.value = '';
    addLabel.value = '';
    addAddress.focus();
  }

  function commit(next) {
    settings.cast = normalizeCast(next);
    render();
    onChange({ cast: settings.cast });
  }

  function patchMember(member, patch) {
    commit(settings.cast.map((m) => (m === member ? { ...m, ...patch } : m)));
  }

  function memberRow(member) {
    const label = el('input', {
      type: 'text',
      class: 'cast-label',
      value: member.label,
      maxlength: 24,
      autocomplete: 'off',
      'aria-label': `Label for ${member.address}`,
      onchange: (e) => patchMember(member, { label: e.target.value.trim() || shortAddress(member.address) }),
    });
    const href = linkFor?.(member.address);
    const address = el(href ? 'a' : 'span', { class: 'cast-address', text: shortAddress(member.address), title: member.address });
    if (href) {
      address.href = href;
      address.target = '_blank';
      address.rel = 'noopener noreferrer';
    }
    const voice = el(
      'select',
      { class: 'cast-voice-select', 'aria-label': `Voice for ${member.label}`, title: CAST_VOICES[member.voice]?.hint ?? '', onchange: (e) => patchMember(member, { voice: e.target.value }) },
      CAST_VOICE_NAMES.map((v) => option(v, CAST_VOICES[v].label, member.voice === v)),
    );
    const pan = el('input', {
      type: 'range',
      class: 'cast-pan',
      min: -1,
      max: 1,
      step: 0.1,
      value: member.pan,
      'aria-label': `Stereo position for ${member.label}, left to right`,
      title: `Stereo position: ${member.pan < -0.05 ? 'left' : member.pan > 0.05 ? 'right' : 'centre'}`,
      onchange: (e) => patchMember(member, { pan: Number(e.target.value) }),
    });
    pan.style.setProperty('--pct', `${Math.round(((member.pan + 1) / 2) * 100)}%`);
    pan.addEventListener('input', (e) => e.target.style.setProperty('--pct', `${Math.round(((Number(e.target.value) + 1) / 2) * 100)}%`));
    const solo = el('button', { type: 'button', class: 'btn tiny', text: 'S', title: 'Solo: only soloed members sound', 'aria-label': `Solo ${member.label}`, 'aria-pressed': String(member.solo), onclick: () => patchMember(member, { solo: !member.solo }) });
    const mute = el('button', { type: 'button', class: 'btn tiny', text: 'M', title: 'Mute this member', 'aria-label': `Mute ${member.label}`, 'aria-pressed': String(member.muted), onclick: () => patchMember(member, { muted: !member.muted }) });
    const preview = el('button', { type: 'button', class: 'btn tiny', text: '▶', title: 'Preview: play this member’s motif in its voice', 'aria-label': `Preview the voice of ${member.label}`, onclick: () => onPreview?.(member) });
    const remove = el('button', { type: 'button', class: 'btn tiny', text: '×', title: 'Remove from the cast', 'aria-label': `Remove ${member.label} from the cast`, onclick: () => commit(settings.cast.filter((m) => m !== member)) });
    return el('div', { class: `cast-row${member.muted ? ' muted' : ''}${member.solo ? ' solo' : ''}`, role: 'listitem', style: `--cast: ${member.colour}` }, [
      el('span', { class: 'cast-swatch', 'aria-hidden': 'true' }),
      label,
      el('span', { class: 'cast-tools' }, [solo, mute, preview, remove]),
      address,
      el('span', { class: 'cast-voice' }, [voice, pan]),
    ]);
  }

  function render() {
    list.replaceChildren(...settings.cast.map(memberRow));
    const n = settings.cast.length;
    addBtn.disabled = n >= CAST_MAX;
    addAddress.disabled = n >= CAST_MAX;
    addLabel.disabled = n >= CAST_MAX;
    if (!hint.classList.contains('error')) hint.textContent = n === 0 ? 'Follow up to five accounts. Each gets a voice, a place in the stereo field, a colour and a label.' : n >= CAST_MAX ? 'The cast is full.' : `${n} of ${CAST_MAX}. ▶ previews a voice; S solos, M mutes.`;
    if (mode.value !== settings.castMode) mode.value = settings.castMode;
  }

  render();
  return { root, render };
}

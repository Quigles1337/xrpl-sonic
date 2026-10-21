// xrpl-sonic — the inspector: the record behind a sound.
//
// Opens from a tape line or a click on a track. Shows the transaction's type,
// result, amount, parties (with cast labels), ledger and hash as explorer
// links, the voice and note that played it, and, during a case, its position
// and the annotations anchored to it. Read-only; annotations are edited in
// the Case group.

import { formatAmount, midiToName } from './mapping.js';
import { formatClock } from './score.js';
import { el } from './dom.js';

export function createInspector({ linkFor, castFor, onPrev, onNext, onAnnotate }) {
  const root = document.querySelector('#inspector');
  let current = null;

  function link(kind, id, text, cls = '') {
    const href = linkFor?.(kind, id);
    if (!href) return el('span', { class: cls, text });
    return el('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer', text });
  }

  function party(p) {
    const member = castFor?.().find((m) => m.address === p.address);
    const a = link('account', p.address, member ? `${member.label} · ${p.short}` : p.short, 'insp-party');
    if (member) a.style.setProperty('--cast', member.colour);
    a.title = p.address;
    return a;
  }

  function dl(rows) {
    const node = el('dl', { class: 'insp-grid' });
    for (const [k, v] of rows) {
      if (v == null || v === '') continue;
      node.append(el('dt', { text: k }), el('dd', {}, Array.isArray(v) ? v : [typeof v === 'string' ? document.createTextNode(v) : v]));
    }
    return node;
  }

  return {
    isOpen: () => !root.classList.contains('hidden'),

    hide() {
      root.classList.add('hidden');
      root.replaceChildren();
      current = null;
    },

    /**
     * @param {object} event  a mapped transaction event (src/mapping.js)
     * @param {{ item?: object, annotations?: object[], index?: number, total?: number }} [ctx]  score context during a case
     */
    show(event, ctx = {}) {
      if (!event || event.kind !== 'tx') return;
      current = event;
      const item = ctx.item ?? null;
      const cast = castFor?.() ?? [];
      const head = el('div', { class: 'insp-head' }, [
        el('span', { class: 'insp-type', style: `--glyph: ${event.colour}`, text: event.txType }),
        el('span', { class: `insp-result ${event.success ? 'ok' : 'err'}`, text: event.success ? 'tesSUCCESS' : String(event.result ?? 'failed') }),
        el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', title: 'Close (Esc)', text: '×', onclick: () => this.hide() }),
      ]);
      const parties = [];
      event.parties.forEach((p, i) => {
        if (i > 0) parties.push(document.createTextNode(` ${p.separator.trim()} `));
        parties.push(party(p));
      });
      const castText = item?.cast?.length
        ? item.cast.map((id) => {
            const m = cast.find((x) => x.id === id);
            return m ? `${m.label}${id === item.primary ? ' (primary voice)' : ''}` : id;
          }).join(', ')
        : null;
      const notes = (event.notes ?? [event.pitch]).map((m) => midiToName(m)).join(' ');
      const rows = [
        ['Parties', parties],
        ['Amount', event.amount ? formatAmount(event.amount) : null],
        ['Ledger', event.ledgerIndex != null ? [link('ledger', event.ledgerIndex, `#${Number(event.ledgerIndex).toLocaleString('en-US')}`)] : null],
        ['Hash', event.hash ? [link('tx', event.hash, `${event.hash.slice(0, 10)}…${event.hash.slice(-6)}`, 'mono')] : null],
        ['Applied as', item?.txIndex != null ? `transaction ${item.txIndex + 1} of its ledger` : null],
        ['Cast', castText],
        ['Voice', `${event.voice ?? event.sound}${event.voice ? ` (${event.sound} by category)` : ''} · ${notes} · velocity ${event.velocity.toFixed(2)} · ${event.duration.toFixed(2)} s`],
        ['Sounded', item ? (item.gate === 'play' ? 'yes' : 'no — drawn silent') : null],
        ['Position', item ? formatClock(item.timeMs) : null],
      ];
      const nav = item
        ? el('div', { class: 'insp-nav' }, [
            el('button', { type: 'button', class: 'btn small', text: '◀ Previous', disabled: !(ctx.index > 0), onclick: () => onPrev?.(item) }),
            el('span', { class: 'insp-count', text: ctx.total ? `${ctx.index + 1} / ${ctx.total}` : '' }),
            el('button', { type: 'button', class: 'btn small', text: 'Next ▶', disabled: !(ctx.index < ctx.total - 1), onclick: () => onNext?.(item) }),
            onAnnotate && event.hash ? el('button', { type: 'button', class: 'btn small', text: 'Annotate', title: 'Add a note anchored to this transaction', onclick: () => onAnnotate(event, item) }) : '',
          ])
        : el('div', { class: 'insp-nav' }, [el('span', { class: 'hint', text: 'Live stream: open a case to step between events.' })]);
      const notesList = (ctx.annotations ?? []).map((a) => el('li', { class: `insp-note ${a.status}` }, [el('span', { text: a.text }), a.source ? el('span', { class: 'caption-source', text: a.source }) : '']));
      root.replaceChildren(head, dl(rows), notesList.length ? el('ul', { class: 'insp-notes' }, notesList) : '', nav);
      root.classList.remove('hidden');
    },

    current: () => current,
  };
}

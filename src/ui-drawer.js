// xrpl-sonic — the readout drawer (docs/ux.md, PR 1).
//
// The coherence readout and the transcript used to sit as raw text in the
// settings column. They open here instead: a dialog under the command strip
// with a header, the counts, one row per pair or per event, and Copy raw,
// which copies exactly the text the script prints. The computation and the
// text are unchanged; only the layout is. The drawer takes focus when it
// opens, closes on Escape or its Close button, and gives focus back.

import { readout, describePair, pairDetailLines, guardText } from './coherence.js';
import { transcriptRows } from './score.js';
import { el } from './dom.js';

const SOURCE_WORDS = Object.freeze({ live: 'live window', score: 'case', account_tx: 'account_tx' });

export function createDrawer({ onMessage } = {}) {
  const root = document.querySelector('#drawer');
  let raw = '';
  let lastFocus = null;
  let copyTimer = 0;

  function hide() {
    if (!root || root.classList.contains('hidden')) return;
    root.classList.add('hidden');
    root.replaceChildren();
    const back = lastFocus;
    lastFocus = null;
    back?.focus?.();
  }

  async function copyRaw(button) {
    try {
      await navigator.clipboard.writeText(raw);
      clearTimeout(copyTimer);
      button.textContent = 'Copied';
      copyTimer = setTimeout(() => (button.textContent = 'Copy raw'), 1600);
      onMessage?.(`Copied ${raw.length.toLocaleString('en-US')} characters of raw text.`);
    } catch (err) {
      // the clipboard refused (a permission, or no secure context): the raw text is offered selected, for Ctrl+C
      const body = root.querySelector('.drawer-body');
      let area = root.querySelector('.drawer-raw');
      if (!area) {
        area = el('textarea', { class: 'drawer-raw', 'aria-label': 'The raw text, selected for copying', readonly: true, rows: 6 });
        body?.prepend(area);
      }
      area.value = raw;
      area.focus();
      area.select();
      onMessage?.(`The browser refused the clipboard (${err?.message ?? err}); the raw text is selected in the drawer, press Ctrl+C.`, 'error');
    }
  }

  /**
   * @param {object} view  { title, counts, lines, empty, rows, rawText, actions }
   *   rows: [{ head, cells: [{ text, cls? }], detail: string[], kind? }]
   */
  function show({ title, counts = '', lines = [], empty = null, rows = [], rawText = '', actions = [] }) {
    if (!root) return;
    raw = rawText;
    if (root.classList.contains('hidden')) lastFocus = document.activeElement;
    const copyBtn = el('button', { type: 'button', class: 'btn small', id: 'drawer-copy', text: 'Copy raw', title: 'Copy the readout exactly as the script prints it', onclick: (e) => copyRaw(e.currentTarget) });
    const closeBtn = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', title: 'Close (Esc)', text: '×', onclick: () => hide() });
    const head = el('div', { class: 'drawer-head' }, [
      el('h2', { id: 'drawer-title', text: title }),
      el('span', { class: 'drawer-counts', text: counts }),
      el('div', { class: 'drawer-actions' }, [...actions.map((a) => el('button', { type: 'button', class: 'btn small', text: a.text, title: a.title ?? '', onclick: a.onclick })), copyBtn, closeBtn]),
    ]);
    const body = el('div', { class: 'drawer-body' });
    if (lines.length) body.append(el('pre', { class: 'drawer-lines', text: lines.join('\n') }));
    if (empty) body.append(el('p', { class: 'drawer-empty', text: empty }));
    if (rows.length) {
      body.append(
        el(
          'ol',
          { class: 'drawer-rows', 'aria-label': `${rows.length} row${rows.length === 1 ? '' : 's'}` },
          rows.map((r) =>
            el('li', { class: 'drawer-row', 'data-kind': r.kind ?? 'pair' }, [
              el('span', { class: 'drawer-row-head', text: r.head }),
              el('span', { class: 'drawer-cells' }, r.cells.map((c) => el('span', { class: `drawer-cell${c.cls ? ` ${c.cls}` : ''}`, text: c.text }))),
              ...(r.detail?.length ? [el('details', {}, [el('summary', { text: `${r.detail.length === 1 ? 'the hashes' : `${r.detail.length} lines`}` }), el('pre', { class: 'drawer-lines', text: r.detail.join('\n') })])] : []),
            ]),
          ),
        ),
      );
    }
    root.replaceChildren(head, body);
    root.classList.remove('hidden');
    closeBtn.focus();
  }

  return {
    root,
    show,
    hide,
    isOpen: () => Boolean(root && !root.classList.contains('hidden')),

    /** The coherence report: the header lines, the counts line, one row per pair (the pair's line split at its separators, every word unchanged), the hashes under it. */
    showCoherence(report) {
      const text = readout(report);
      const all = text.split('\n');
      const firstPair = all.findIndex((l) => / ↔ /.test(l) || /^no pair/.test(l));
      const headerLines = firstPair < 0 ? all : all.slice(0, firstPair);
      const counts = headerLines.find((l) => l.startsWith('record:')) ?? '';
      const lines = headerLines.filter((l) => l !== counts);
      const span = report.window?.from != null ? ` #${report.window.from}–#${report.window.to}` : '';
      const rows = (report.pairs ?? []).map((p) => {
        const line = describePair(p, { significance: report.options?.significance });
        const sep = line.indexOf(': ');
        const head = sep < 0 ? line : line.slice(0, sep);
        const cells = (sep < 0 ? [] : line.slice(sep + 2).split(' · ')).map((t, i) => ({ text: t, cls: i === 0 ? 'lead' : /connected|not connected|co-activity|record not available/.test(t) ? 'record' : '' }));
        return { head, cells, detail: pairDetailLines(p, { maxHashes: report.options?.maxHashes }), kind: p.judged ? 'pair' : 'guarded' };
      });
      show({ title: `Coherence · ${SOURCE_WORDS[report.source] ?? report.source}${span}`, counts, lines, empty: guardText(report), rows, rawText: text });
    },

    /** The transcript text: its header lines, the counts line, one row per stamped line, the text unchanged. */
    showTranscript(text, { title = 'Transcript', onSave } = {}) {
      const { header, rows } = transcriptRows(text);
      const counts = header.find((l) => /ledgers · .* events/.test(l)) ?? '';
      show({
        title: `Transcript · ${title}`,
        counts,
        lines: header.filter((l) => l !== counts),
        empty: rows.length ? null : 'Nothing in the transcript yet.',
        rows: rows.map((r) => ({ head: r.time, cells: [{ text: r.text, cls: r.kind === 'event' ? '' : 'lead' }], detail: [], kind: r.kind })),
        rawText: text,
        actions: onSave ? [{ text: 'Save file', title: 'Save the transcript as a text file', onclick: onSave }] : [],
      });
    },
  };
}

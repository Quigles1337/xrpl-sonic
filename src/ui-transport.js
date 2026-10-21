// xrpl-sonic — the transport bar and the caption strip.
//
// The bar shows while a case plays: step back, play/pause, step, loop with
// in/out points, a clock, a seekable track with marks for annotations, gaps
// and ledger closes, the speed, and Go live. The caption strip under it is
// the text equivalent of what is playing: annotations, gaps, and cast events
// when captions are on.

import { REPLAY_SPEEDS } from './replay.js';
import { formatClock } from './score.js';
import { el, option } from './dom.js';

const CAPTION_MS = { cast: 2600, ledger: 1800, gap: 4000, info: 4000, annotation: 14000 };

export function createTransportUI({ onToggle, onStep, onBack, onLoopToggle, onLoopIn, onLoopOut, onSeek, onSpeed, onCancel }) {
  const $ = (sel) => document.querySelector(sel);
  const bar = $('#transport');
  const back = $('#t-back');
  const play = $('#t-play');
  const step = $('#t-step');
  const loop = $('#t-loop');
  const loopIn = $('#t-loop-in');
  const loopOut = $('#t-loop-out');
  const clock = $('#t-clock');
  const track = $('#t-track');
  const fill = $('#t-fill');
  const loopSpan = $('#t-loopspan');
  const marks = $('#t-marks');
  const label = $('#t-label');
  const speed = $('#replay-speed');
  const cancel = $('#replay-cancel');
  const captions = $('#captions');
  let totalMs = 0;
  let captionTimer = 0;

  for (const s of REPLAY_SPEEDS) speed.append(option(String(s), `${s}×`, s === 1));
  speed.addEventListener('change', (e) => onSpeed?.(Number(e.target.value)));
  cancel.addEventListener('click', () => onCancel?.());
  play.addEventListener('click', () => onToggle?.());
  step.addEventListener('click', () => onStep?.());
  back.addEventListener('click', () => onBack?.());
  loop.addEventListener('click', () => onLoopToggle?.());
  loopIn.addEventListener('click', () => onLoopIn?.());
  loopOut.addEventListener('click', () => onLoopOut?.());

  const fractionAt = (clientX) => {
    const rect = track.getBoundingClientRect();
    return rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
  };
  track.addEventListener('click', (e) => onSeek?.(fractionAt(e.clientX) * totalMs));
  track.addEventListener('keydown', (e) => {
    const pos = Number(track.getAttribute('aria-valuenow')) || 0;
    const stepMs = e.shiftKey ? 5000 : 1000;
    if (e.key === 'ArrowRight') onSeek?.(Math.min(totalMs, pos + stepMs));
    else if (e.key === 'ArrowLeft') onSeek?.(Math.max(0, pos - stepMs));
    else if (e.key === 'Home') onSeek?.(0);
    else if (e.key === 'End') onSeek?.(totalMs);
    else return;
    e.preventDefault();
  });

  function setClock(ms) {
    clock.textContent = `${formatClock(ms)} / ${formatClock(totalMs)}`;
  }

  return {
    /** Show or hide the bar; `text` is the label (the case title or the range). */
    setActive(active, text = 'Replay') {
      bar.classList.toggle('hidden', !active);
      document.body.classList.toggle('replaying', active);
      if (active) {
        label.textContent = text;
        label.title = text;
      } else {
        fill.style.transform = 'scaleX(0)';
        loopSpan.classList.add('hidden');
        marks.replaceChildren();
        totalMs = 0;
        this.caption(null);
      }
    },

    setLoading(done, total) {
      label.textContent = `Loading ledgers ${done}/${total}…`;
      fill.style.transform = `scaleX(${total ? (done / total).toFixed(3) : 0})`;
      fill.classList.add('loading');
      track.setAttribute('aria-valuetext', `loading ${done} of ${total} ledgers`);
    },

    /** The score is ready: total length, marks on the track. */
    setScore(score, text) {
      totalMs = score.totalMs;
      fill.classList.remove('loading');
      fill.style.transform = 'scaleX(0)';
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', String(Math.round(totalMs)));
      if (text) {
        label.textContent = text;
        label.title = text;
      }
      const pct = (ms) => `${((ms / Math.max(1, totalMs)) * 100).toFixed(2)}%`;
      marks.replaceChildren(
        ...score.ledgers.map((l) => el('span', { class: `mark ledger${l.missing ? ' missing' : ''}`, style: `left: ${pct(l.timeMs)}`, title: l.missing ? `Ledger #${l.ledgerIndex} unavailable` : `Ledger #${l.ledgerIndex.toLocaleString('en-US')}` })),
        ...score.gaps.map((g) => el('span', { class: 'mark gap', style: `left: ${pct(g.timeMs)}; width: ${pct(g.durationMs)}`, title: `${g.omitted} ledgers omitted` })),
        ...score.annotations.map((a) => el('span', { class: `mark note${a.pause ? ' pause' : ''}`, style: `left: ${pct(a.timeMs)}`, title: a.text })),
      );
      setClock(0);
    },

    setState(state, detail = {}) {
      const playing = state === 'playing';
      play.textContent = playing ? '❚❚' : '▶';
      play.setAttribute('aria-pressed', String(playing));
      play.title = playing ? 'Pause (K)' : 'Play (K)';
      bar.dataset.state = state;
      if (state === 'paused' && detail.annotation) this.caption({ kind: 'annotation', text: detail.annotation.text, source: detail.annotation.source, status: detail.annotation.status, sticky: true, paused: true });
      if (state === 'ended') this.caption({ kind: 'info', text: 'End of the case. ▶ plays it again; Go live returns to the stream.' });
    },

    setPosition(ms) {
      fill.style.transform = `scaleX(${Math.min(1, Math.max(0, ms / Math.max(1, totalMs))).toFixed(4)})`;
      track.setAttribute('aria-valuenow', String(Math.round(ms)));
      track.setAttribute('aria-valuetext', formatClock(ms));
      setClock(ms);
    },

    setLoop(range) {
      const on = Boolean(range);
      loop.setAttribute('aria-pressed', String(on));
      loopSpan.classList.toggle('hidden', !on);
      if (on && totalMs > 0) {
        loopSpan.style.left = `${((range.fromMs / totalMs) * 100).toFixed(2)}%`;
        loopSpan.style.width = `${(((range.toMs - range.fromMs) / totalMs) * 100).toFixed(2)}%`;
      }
    },

    setSpeed(value) {
      speed.value = String(value);
    },

    /**
     * Show a caption. `entry` is { kind, text, source?, status?, sticky?, paused? } or null to clear.
     * Non-sticky captions clear themselves after a kind-specific delay.
     */
    caption(entry) {
      clearTimeout(captionTimer);
      if (!entry) {
        captions.classList.add('hidden');
        captions.replaceChildren();
        return;
      }
      const kind = entry.kind ?? 'info';
      const parts = [el('span', { class: `caption-kind caption-${kind}`, text: kind === 'annotation' ? (entry.status === 'reviewed' ? 'Note · reviewed' : 'Note') : kind })];
      parts.push(el('span', { class: 'caption-text', text: entry.text }));
      if (entry.source) parts.push(el('span', { class: 'caption-source', text: entry.source }));
      if (entry.paused) parts.push(el('span', { class: 'caption-hint', text: 'Paused · K to continue' }));
      captions.replaceChildren(...parts);
      captions.dataset.kind = kind;
      captions.classList.remove('hidden');
      if (!entry.sticky) captionTimer = setTimeout(() => this.caption(null), CAPTION_MS[kind] ?? 3000);
    },
  };
}

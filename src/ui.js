// xrpl-sonic — DOM controls, status, metronome and the scrolling tape.
//
// The transport bar, the inspector, the cast group and the case group live
// in their own modules (ui-transport.js, ui-inspector.js, ui-cast.js,
// ui-case.js); this file builds the panel, the command strip readouts and the
// tape, and exposes those parts on the object it returns.

import { CATEGORIES, CATEGORY_NAMES, SCALES, KEYS } from './mapping.js';
import { NETWORKS } from './ws.js';
import { EXPLORERS, explorerUrl } from './explorers.js';
import { GLYPHS, PULSE, categoryIcon, eventIcon, fieldGuide } from './glyphs.js';
import { el, option, svg, setGuard, reasonStrip, guarded } from './dom.js';
import { TERMS, REASONS } from './vocabulary.js';
import { isExampleCast } from './cast.js';
import { createDrawer } from './ui-drawer.js';
import { createLearnPanel } from './ui-learn.js';
import { VIEWS } from './settings.js';
import { createCastPanel } from './ui-cast.js';
import { createCasePanel } from './ui-case.js';
import { createTransportUI } from './ui-transport.js';
import { createInspector } from './ui-inspector.js';
import { createGeigerPanel } from './ui-geiger.js';
import { createHealthPanel } from './ui-health.js';
import { createMidiPanel } from './ui-midi.js';
import { createFieldPanel } from './ui-field.js';

const MAX_LOG_LINES = 80;

/** Wall-clock stamp for the tape, HH:MM:SS. */
function stamp() {
  return el('span', { class: 'ts', text: new Date().toLocaleTimeString('en-GB', { hour12: false }) });
}

/**
 * Build the controls into the existing document skeleton.
 * @param {object} args
 * @param {object} args.settings  current settings (mutated on change)
 * @param {(patch: object, settings: object) => void} args.onChange
 * @param {() => void} args.onToggleRun
 * @param {() => void} [args.onShare]
 * @param {() => void} [args.onSnapshot]
 * @param {() => void} [args.onRecord]
 * @param {(member: object) => void} [args.onPreview]  play a cast member's motif
 * @param {(event: object) => void} [args.onInspect]   open the inspector for a tape line
 * @param {object} [args.transport]   callbacks for the transport bar (see ui-transport.js)
 * @param {object} [args.caseActions] callbacks for the case group (see ui-case.js)
 * @param {object} [args.inspector]   callbacks for the inspector (see ui-inspector.js)
 * @param {object} [args.geigerActions] callbacks for the Geiger group (see ui-geiger.js)
 * @param {object} [args.healthActions] callbacks for the Node group (see ui-health.js)
 * @param {object} [args.midiActions]   callbacks for the MIDI group (see ui-midi.js)
 * @param {object} [args.fieldActions]  callbacks for the Field group (see ui-field.js): onChange({ field } | { bin }), binNow()
 * @param {(view: string) => void} [args.onView]   the mode changed (listen, watch, learn)
 * @param {(view: string) => void} [args.onDoor]   a door on the welcome overlay was chosen
 * @param {object} [args.learnActions]  callbacks for the Learn panel (see ui-learn.js): onRun(id), onNext(), onBack(), onExit()
 * @param {{ recording: boolean, mimeType: string|null }} [args.capture]  what the browser supports
 */
export function createUI({ settings, onChange, onToggleRun, onShare, onMoment, onAi, onCopyAi, onSnapshot, onRecord, onPreview, onInspect, transport, caseActions, inspector, geigerActions, healthActions, midiActions, fieldActions, onView, onDoor, learnActions, capture }) {
  const $ = (sel) => document.querySelector(sel);
  const startButtons = [$('#start'), $('#overlay-start')].filter(Boolean);
  const overlay = $('#overlay');
  const panel = $('#panel');
  const panelToggle = $('#toggle-panel');
  const panelClose = $('#panel-close');
  const overlayGuide = $('#overlay-guide');
  const statusDot = $('#status-dot');
  const statusText = $('#status-text');
  const ledgerIndexEl = $('#ledger-index');
  const ledgerIntervalEl = $('#ledger-interval');
  const metronomeFill = $('#metronome-fill');
  const txRateEl = $('#tx-rate');
  const logList = $('#log');
  const logWrap = $('#log-wrap');
  const controls = $('#controls');
  const castStrip = $('#cast-strip');
  const shareBtn = $('#share');
  const momentBtn = $('#moment');
  const momentPrompt = $('#moment-prompt');
  const momentText = $('#moment-text');
  const momentCancel = $('#moment-cancel');
  const aiBtn = $('#ai');
  const aiBox = $('#ai-box');
  const aiSizes = $('#ai-sizes');
  const aiCopyGist = $('#ai-copy-gist');
  const aiCopyEvidence = $('#ai-copy-evidence');
  const aiCancel = $('#ai-cancel');
  const overlayLede = $('#overlay .lede');
  const fieldLine = $('#field-line');
  const modeButtons = [...document.querySelectorAll('#modes .mode-btn')];
  const workbench = $('#workbench');
  const workbenchGroups = $('#workbench-groups');
  const learn = $('#learn');
  const learnGroups = $('#learn-groups');
  const doors = [...document.querySelectorAll('.door[data-view]')];
  const defaultLede = overlayLede?.textContent ?? '';

  const update = (patch) => {
    Object.assign(settings, patch);
    onChange(patch, settings);
  };

  // --- Start / stop ----------------------------------------------------------
  for (const b of startButtons) b.addEventListener('click', () => onToggleRun());

  // --- Share, transport, inspector --------------------------------------------
  shareBtn?.addEventListener('click', () => onShare?.());
  let shareTimer = 0;

  // --- Save this moment: an inline question; playback continues behind it ------
  let momentTimer = 0;
  const openMomentPrompt = () => {
    if (!momentPrompt) return;
    momentPrompt.classList.remove('hidden');
    momentText.value = '';
    momentText.focus();
  };
  const closeMomentPrompt = () => {
    if (!momentPrompt) return;
    momentPrompt.classList.add('hidden');
    momentText.blur();
  };
  momentBtn?.addEventListener('click', () => (momentPrompt?.classList.contains('hidden') ? openMomentPrompt() : closeMomentPrompt()));
  momentCancel?.addEventListener('click', closeMomentPrompt);
  momentPrompt?.addEventListener('submit', (e) => {
    e.preventDefault();
    const question = momentText.value.trim();
    closeMomentPrompt();
    onMoment?.(question);
  });
  momentText?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeMomentPrompt();
    }
  });

  // --- Copy for AI: the sizes and the events-shown ratio are shown before copying ---
  let aiTimer = 0;
  const closeAiBox = () => aiBox?.classList.add('hidden');
  aiBtn?.addEventListener('click', () => (aiBox?.classList.contains('hidden') ? onAi?.() : closeAiBox()));
  aiCancel?.addEventListener('click', closeAiBox);
  aiCopyGist?.addEventListener('click', () => onCopyAi?.('gist'));
  aiCopyEvidence?.addEventListener('click', () => onCopyAi?.('evidence'));
  const transportUI = createTransportUI(transport ?? {});
  const inspectorUI = createInspector({
    linkFor: (kind, id) => explorerUrl(settings.explorer, settings.network, kind, id),
    castFor: () => settings.cast ?? [],
    onPrev: inspector?.onPrev,
    onNext: inspector?.onNext,
    onAnnotate: inspector?.onAnnotate,
  });

  // --- Settings panel toggle: a toggle in every mode, over the mode's own panel -----
  const setPanelOpen = (open) => {
    panel.classList.toggle('open', open);
    panelToggle.setAttribute('aria-expanded', String(open));
  };
  panelToggle.addEventListener('click', () => setPanelOpen(!panel.classList.contains('open')));
  panelClose?.addEventListener('click', () => setPanelOpen(false));

  // --- The three modes (docs/ux.md): the switch in the top bar, the doors on the overlay ----
  const setView = (view, { announce = true } = {}) => {
    const v = VIEWS.includes(view) ? view : 'listen';
    document.body.dataset.view = v;
    for (const b of modeButtons) b.setAttribute('aria-pressed', String(b.dataset.view === v));
    workbench?.classList.toggle('open', v === 'watch');
    learn?.classList.toggle('open', v === 'learn');
    if (announce) onView?.(v);
  };
  for (const b of modeButtons) b.addEventListener('click', () => setView(b.dataset.view));
  // on a narrow screen the switch sits at the bottom edge, outside the top bar: a fixed element inside the bar would be contained by its backdrop filter
  const modes = $('#modes');
  const modesHome = modes?.nextElementSibling ?? null;
  const topbar = modes?.parentElement ?? null;
  const narrow = window.matchMedia('(max-width: 899px)');
  const placeModes = () => {
    if (!modes || !topbar) return;
    if (narrow.matches) document.body.append(modes);
    else if (modes.parentElement !== topbar) topbar.insertBefore(modes, modesHome);
  };
  placeModes();
  narrow.addEventListener?.('change', placeModes);
  $('#workbench-close')?.addEventListener('click', () => setView('listen'));
  $('#learn-close')?.addEventListener('click', () => setView('listen'));
  for (const d of doors) d.addEventListener('click', () => onDoor?.(d.dataset.view));

  // --- Field guide on the start screen ----------------------------------------
  if (overlayGuide) {
    for (const g of fieldGuide()) {
      overlayGuide.append(el('span', { class: 'guide-item', style: `--glyph: ${g.colour}`, title: `${g.label} — ${g.sound}. ${g.track}` }, [svg(categoryIcon(g.category, 14)), el('span', { text: g.label })]));
    }
    overlayGuide.append(el('span', { class: 'guide-item', style: `--glyph: ${PULSE.colour}`, title: `${PULSE.label}. ${PULSE.track}` }, [svg(eventIcon({ kind: 'ledger' }, 14)), el('span', { text: PULSE.label })]));
  }

  // --- Controls --------------------------------------------------------------
  const sliderFill = (input) => input.style.setProperty('--pct', `${Math.round(Number(input.value) * 100)}%`);
  const volume = el('input', {
    type: 'range',
    id: 'volume',
    min: 0,
    max: 1,
    step: 0.01,
    value: settings.volume,
    'aria-label': 'Volume',
    oninput: (e) => {
      sliderFill(e.target);
      update({ volume: Number(e.target.value) });
    },
  });
  sliderFill(volume);
  const mute = el('input', {
    type: 'checkbox',
    id: 'mute',
    checked: settings.muted,
    onchange: (e) => update({ muted: e.target.checked }),
  });
  const network = el(
    'select',
    { id: 'network', 'aria-label': 'Network', onchange: (e) => update({ network: e.target.value }) },
    Object.entries(NETWORKS).map(([k, v]) => option(k, v.label, settings.network === k)),
  );
  const scale = el(
    'select',
    { id: 'scale', 'aria-label': 'Scale', onchange: (e) => update({ scale: e.target.value }) },
    Object.entries(SCALES).map(([k, v]) => option(k, v.label, settings.scale === k)),
  );
  const key = el(
    'select',
    { id: 'key', 'aria-label': 'Key', onchange: (e) => update({ key: e.target.value }) },
    KEYS.map((k) => option(k, k, settings.key === k)),
  );
  const quietMode = el('input', {
    type: 'checkbox',
    id: 'quiet-mode',
    checked: settings.quietMode,
    onchange: (e) => update({ quietMode: e.target.checked }),
  });
  const quietThreshold = el('input', {
    type: 'number',
    id: 'quiet-threshold',
    min: 0,
    step: 1,
    inputmode: 'numeric',
    value: settings.quietThreshold,
    'aria-label': 'Quiet mode threshold in XRP',
    onchange: (e) => update({ quietThreshold: Math.max(0, Number(e.target.value) || 0) }),
  });
  const includeFailed = el('input', {
    type: 'checkbox',
    id: 'include-failed',
    checked: settings.includeFailed,
    onchange: (e) => update({ includeFailed: e.target.checked }),
  });
  const showLog = el('input', {
    type: 'checkbox',
    id: 'show-log',
    checked: settings.showLog,
    onchange: (e) => update({ showLog: e.target.checked }),
  });
  const exposure = el('input', {
    type: 'checkbox',
    id: 'exposure',
    checked: settings.exposure,
    onchange: (e) => update({ exposure: e.target.checked }),
  });
  const explorer = el(
    'select',
    { id: 'explorer', 'aria-label': 'Explorer for links', onchange: (e) => update({ explorer: e.target.value }) },
    Object.entries(EXPLORERS).map(([k, v]) => option(k, v.label, settings.explorer === k)),
  );
  const castPanel = createCastPanel({
    settings,
    onChange: (patch) => update(patch),
    onPreview: (member) => onPreview?.(member),
    linkFor: (address) => explorerUrl(settings.explorer, settings.network, 'account', address),
  });
  const casePanel = createCasePanel({ settings, ...(caseActions ?? {}) });
  const geigerPanel = createGeigerPanel({ settings, ...(geigerActions ?? {}) });
  const healthPanel = createHealthPanel({ settings, ...(healthActions ?? {}) });
  const midiPanel = createMidiPanel({ settings, ...(midiActions ?? {}) });
  const fieldPanel = createFieldPanel({ settings, onChange: (patch) => ('field' in patch ? update(patch) : fieldActions?.onChange?.(patch)), binNow: fieldActions?.binNow });
  const learnPanel = createLearnPanel(learnActions ?? {});
  // the Moments group of the workbench: save this moment, Copy for AI, and the loaded moment's question
  const momentNote = el('p', { class: 'moment-note', id: 'moment-note' });
  const momentsGroup = el('section', { class: 'group moments-group' }, [
    el('h2', { text: 'Moments' }),
    el('p', { class: 'group-hint', text: TERMS.moment.sentence }),
    el('div', { class: 'buttons' }, [
      el('button', { type: 'button', class: 'btn small', id: 'wb-moment', text: 'Moment', title: 'Save this moment (S)', onclick: () => (momentPrompt?.classList.contains('hidden') ? openMomentPrompt() : closeMomentPrompt()) }),
      el('button', { type: 'button', class: 'btn small', id: 'wb-ai', text: 'Copy for AI', title: TERMS.copyForAi.sentence, onclick: () => (aiBox?.classList.contains('hidden') ? onAi?.() : closeAiBox()) }),
    ]),
    momentNote,
  ]);
  const snapshotBtn = el('button', { type: 'button', class: 'btn', id: 'snapshot', text: 'Snapshot', title: 'Save the scene as a PNG with a stats overlay', onclick: () => onSnapshot?.() });
  const recordBtn = el('button', { type: 'button', class: 'btn', id: 'record', text: 'Record 30 s', title: `Record 30 seconds of video and audio${capture?.mimeType ? ` (${capture.mimeType})` : ''}` });
  recordBtn.addEventListener('click', guarded(recordBtn, () => onRecord?.()));
  if (!capture?.recording) setGuard(recordBtn, REASONS.cannotRecord);
  const captureReasons = reasonStrip([snapshotBtn, recordBtn], 'capture-reasons');

  const row = (labelText, control, extra) =>
    el('label', { class: 'row' }, [el('span', { class: 'row-label', text: labelText }), control, ...(extra ? [extra] : [])]);
  const check = (labelText, control, hint) =>
    el('label', { class: 'row check' }, [control, el('span', { class: 'row-label', text: labelText }), ...(hint ? [el('span', { class: 'hint', text: hint })] : [])]);

  const categoryToggles = CATEGORY_NAMES.map((name) => {
    const c = CATEGORIES[name];
    const box = el('input', {
      type: 'checkbox',
      checked: settings.enabled[name],
      'data-category': name,
      onchange: (e) => update({ enabled: { ...settings.enabled, [name]: e.target.checked } }),
    });
    return el('label', { class: 'chip', style: `--chip: ${c.colour}`, title: GLYPHS[name].track }, [
      box,
      el('span', { class: 'swatch' }, [svg(categoryIcon(name, 20))]),
      el('span', { class: 'chip-text' }, [el('span', { class: 'chip-label', text: c.label }), el('span', { class: 'chip-sound', text: c.sound })]),
    ]);
  });

  controls.append(
    el('section', { class: 'group' }, [
      el('h2', { text: 'Sound' }),
      el('p', { class: 'group-hint', text: TERMS.sound.sentence }),
      row('Volume', volume),
      check('Mute', mute),
      row('Scale', scale),
      row('Key', key),
    ]),
    el('section', { class: 'group' }, [
      el('h2', { text: 'Stream' }),
      el('p', { class: 'group-hint', text: TERMS.stream.sentence }),
      row('Network', network),
      check('Quiet mode', quietMode, TERMS.quietMode.sentence),
      row('Threshold (XRP)', quietThreshold),
      check('Include failed transactions', includeFailed),
      check('Show log', showLog),
      check('Long exposure', exposure, TERMS.longExposure.sentence),
      row('Explorer links', explorer),
    ]),
    el('section', { class: 'group' }, [el('h2', { text: 'Transaction types' }), el('p', { class: 'group-hint', text: TERMS.transactionTypes.sentence }), el('div', { class: 'chips' }, categoryToggles)]),
    healthPanel.root,
    midiPanel.root,
    el('section', { class: 'group' }, [
      el('h2', { text: 'Capture' }),
      el('p', { class: 'group-hint', text: TERMS.capture.sentence }),
      el('div', { class: 'buttons' }, [snapshotBtn, recordBtn]),
      captureReasons,
      el('p', { class: 'hint capture-hint', text: capture?.recording ? 'PNG with ledger, rate and time; WebM with the audio mix.' : 'Snapshot only: this browser cannot record.' }),
    ]),
    el('section', { class: 'group stats' }, [
      el('h2', { text: 'Session' }),
      el('p', { class: 'group-hint', text: TERMS.session.sentence }),
      el('dl', {}, [
        el('dt', { text: 'Played' }),
        el('dd', { id: 'stat-played', text: '0' }),
        el('dt', { text: 'Rate-limited' }),
        el('dd', { id: 'stat-dropped', text: '0' }),
        el('dt', { text: 'Ledgers' }),
        el('dd', { id: 'stat-ledgers', text: '0' }),
        el('dt', { text: 'Node' }),
        el('dd', { id: 'stat-node', text: '—' }),
      ]),
    ]),
  );

  // Watch: the workbench beside the plate, the Field under Coherence (the Case group's readout) so the picture sits below its numbers; Learn: the tours
  workbenchGroups?.append(castPanel.root, momentsGroup, casePanel.root, fieldPanel.root, geigerPanel.root);
  learnGroups?.append(learnPanel.root);
  setView(settings.view ?? 'listen', { announce: false });

  const statPlayed = $('#stat-played');
  const statDropped = $('#stat-dropped');
  const statLedgers = $('#stat-ledgers');
  const statNode = $('#stat-node');

  const applyLogVisibility = () => logWrap.classList.toggle('hidden', !settings.showLog);
  applyLogVisibility();

  // the tape before anything has played: what it is and what to do next (docs/ux.md)
  const emptyLine = el('li', { class: 'log-empty', text: 'Nothing yet: press Start to listen; every transaction then appears here as a line you can click.' });
  logList.append(emptyLine);

  function pushLine(line) {
    emptyLine.remove();
    logList.prepend(line);
    while (logList.children.length > MAX_LOG_LINES) logList.lastChild.remove();
  }

  // the readout drawer (src/ui-drawer.js): coherence and the transcript, structured, with Copy raw
  const drawer = createDrawer({ onMessage: (text, cls = 'info') => pushLine(el('li', { class: `log-${cls}` }, [stamp(), el('span', { class: 'glyph' }), el('span', { class: 'line', text })])) });

  // the project terms on the command strip's buttons, from the documents
  if (momentBtn) momentBtn.title = TERMS.moment.sentence;
  if (aiBtn) aiBtn.title = TERMS.copyForAi.sentence;
  if (shareBtn) shareBtn.title = TERMS.share.sentence;

  // --- Public API ------------------------------------------------------------
  return {
    transport: transportUI,
    inspector: inspectorUI,
    casePanel,
    geigerPanel,
    healthPanel,
    midiPanel,
    fieldPanel,
    drawer,
    learn: learnPanel,
    setView,
    setPanelOpen,

    /** The loaded moment's question (or any sentence about the case) under the Moments buttons; empty clears it. */
    setMomentNote(text) {
      momentNote.textContent = text ?? '';
    },

    /** The pair under the pointer (src/field.js): its full readout line and its hashes, until closed. */
    showFieldLine({ label, line, detail = [] }) {
      if (!fieldLine) return;
      fieldLine.replaceChildren(
        el('div', { class: 'field-line-head' }, [el('span', { class: 'field-line-label', text: label }), el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', title: 'Close (Esc)', text: '×', onclick: () => this.hideFieldLine() })]),
        el('pre', { class: 'field-line-text', text: [line, ...detail].join('\n') }),
      );
      fieldLine.classList.remove('hidden');
    },

    hideFieldLine() {
      fieldLine?.classList.add('hidden');
    },

    setRunning(running) {
      document.body.classList.toggle('running', running);
      overlay.classList.toggle('hidden', running);
      for (const b of startButtons) {
        b.textContent = running ? (b.dataset.running ?? 'Stop') : (b.dataset.idle ?? 'Start');
        b.setAttribute('aria-pressed', String(running));
      }
      if (running && !window.matchMedia('(min-width: 900px)').matches) setPanelOpen(false);
    },

    setStatus(state, text, endpoint) {
      statusDot.dataset.state = state;
      statusText.textContent = text;
      if (endpoint !== undefined) statNode.textContent = endpoint ? endpoint.replace(/^wss:\/\//, '') : '—';
    },

    setLedger(index, intervalSeconds) {
      ledgerIndexEl.textContent = index != null ? `#${index.toLocaleString('en-US')}` : '—';
      ledgerIntervalEl.textContent = intervalSeconds ? `${intervalSeconds.toFixed(1)} s` : '—';
    },

    setMetronome(fraction) {
      metronomeFill.style.transform = `scaleX(${Math.min(1, Math.max(0, fraction)).toFixed(3)})`;
    },

    setTxRate(perSecond) {
      txRateEl.textContent = `${perSecond.toFixed(1)} tx/s`;
    },

    setStats({ played, dropped, ledgers }) {
      statPlayed.textContent = String(played);
      statDropped.textContent = String(dropped);
      statLedgers.textContent = String(ledgers);
    },

    /** Append an event to the tape. `dim` marks events that were drawn but not sounded (rate-limited). */
    log(event, { dim = false } = {}) {
      if (!settings.showLog) return;
      const line = el('li', { class: `log-${event.kind}${dim ? ' dim' : ''}`, style: `--glyph: ${event.kind === 'tx' ? event.colour : PULSE.colour}`, title: dim ? 'Drawn but not sounded: the synth was at its rate limit' : null }, [
        stamp(),
        svg(eventIcon(event, 14)),
        el('span', { class: 'line' }, event.kind === 'tx' ? txLine(event) : ledgerLine(event)),
      ]);
      if (event.kind === 'tx') {
        line.classList.add('inspectable');
        line.title = `${line.title ? `${line.title} · ` : ''}Click to inspect`;
        line.addEventListener('click', (e) => {
          if (e.target.closest('a')) return;
          onInspect?.(event);
        });
      }
      pushLine(line);
    },

    /** Tell the start overlay that pressing Start will play a case rather than go live. */
    setReplayPending(theCase, title) {
      if (!overlayLede) return;
      overlayLede.textContent = theCase ? `${title ?? 'A case'} will play back at the pace the network closed it; Go live returns to the stream.` : defaultLede;
    },

    /** Countdown on the record button; null restores it. */
    setRecording(remainingSeconds) {
      const active = remainingSeconds != null;
      recordBtn.textContent = active ? `Recording… ${remainingSeconds} s` : 'Record 30 s';
      recordBtn.classList.toggle('recording', active);
      setGuard(recordBtn, active ? 'Recording…' : capture?.recording ? null : REASONS.cannotRecord);
      document.body.classList.toggle('recording', active);
    },

    setShared(ok) {
      if (!shareBtn) return;
      clearTimeout(shareTimer);
      shareBtn.textContent = ok ? 'Copied' : 'Share';
      shareBtn.classList.toggle('copied', ok);
      if (ok) shareTimer = setTimeout(() => this.setShared(false), 1600);
    },

    /** Ask "What caught your attention?" (the Moment button, or S); Enter saves, Esc cancels. */
    openMomentPrompt,
    closeMomentPrompt,

    setMomentSaved(ok) {
      if (!momentBtn) return;
      clearTimeout(momentTimer);
      momentBtn.textContent = ok ? 'Saved' : 'Moment';
      momentBtn.classList.toggle('copied', ok);
      if (ok) momentTimer = setTimeout(() => this.setMomentSaved(false), 1600);
    },

    /** Show what Copy for AI would copy: one line per level with size, token estimate and events shown. `reports` is { gist, evidence } from describeReport. */
    openAiBox(reports) {
      if (!aiBox) return;
      const fmt = (n) => Number(n).toLocaleString('en-US');
      const line = (r) => `${r.level}: ${fmt(r.chars)} characters (~${fmt(r.tokensApprox)} tokens) · ${r.shown} of ${r.total} events${r.shown < r.total ? ' (selected under the stated rule)' : ''}`;
      aiSizes.textContent = `${line(reports.gist)}\n${line(reports.evidence)}`;
      aiBox.classList.remove('hidden');
      aiCopyGist.focus();
    },

    closeAiBox,

    setAiCopied(ok, level = 'gist') {
      if (!aiBtn) return;
      clearTimeout(aiTimer);
      aiBtn.textContent = ok ? `Copied ${level}` : 'Copy for AI';
      aiBtn.classList.toggle('copied', ok);
      if (ok) aiTimer = setTimeout(() => this.setAiCopied(false), 1600);
    },

    /** Render the cast in the command strip: one chip per member, linked to the explorer. */
    setCast(cast) {
      const members = Array.isArray(cast) ? cast : [];
      castStrip.classList.toggle('hidden', members.length === 0);
      document.body.classList.toggle('watching', members.length > 0);
      const example = isExampleCast(members);
      castStrip.replaceChildren(
        ...members.map((m) => {
          const href = explorerUrl(settings.explorer, settings.network, 'account', m.address);
          const chip = el(href ? 'a' : 'span', {
            class: `cast-chip${m.muted ? ' muted' : ''}${m.solo ? ' solo' : ''}${example ? ' example' : ''}`,
            style: `--cast: ${m.colour}`,
            text: m.label,
            title: `${m.address} · ${m.voice}${m.solo ? ' · solo' : ''}${m.muted ? ' · muted' : ''}`,
          });
          if (href) {
            chip.href = href;
            chip.target = '_blank';
            chip.rel = 'noopener noreferrer';
          }
          return chip;
        }),
      );
      castPanel.render();
      fieldPanel.render();
    },

    /** A line that is not a transaction: 'info', 'error' or 'note' (an annotation). */
    logMessage(text, cls = 'info') {
      pushLine(el('li', { class: `log-${cls}` }, [stamp(), el('span', { class: 'glyph' }), el('span', { class: 'line', text })]));
    },

    applySettings() {
      volume.value = settings.volume;
      sliderFill(volume);
      mute.checked = settings.muted;
      network.value = settings.network;
      scale.value = settings.scale;
      key.value = settings.key;
      quietMode.checked = settings.quietMode;
      quietThreshold.value = settings.quietThreshold;
      includeFailed.checked = settings.includeFailed;
      showLog.checked = settings.showLog;
      exposure.checked = settings.exposure;
      explorer.value = settings.explorer;
      for (const box of controls.querySelectorAll('input[data-category]')) box.checked = settings.enabled[box.dataset.category];
      castPanel.render();
      casePanel.applySettings();
      geigerPanel.applySettings();
      healthPanel.applySettings();
      fieldPanel.applySettings();
      setView(settings.view ?? 'listen', { announce: false });
      applyLogVisibility();
    },
  };

  // --- Tape line builders -----------------------------------------------------
  function link(kind, id, text, cls) {
    const href = explorerUrl(settings.explorer, settings.network, kind, id);
    if (!href) return el('span', { class: cls, text });
    return el('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer', text });
  }

  function txLine(event) {
    const nodes = [link('tx', event.hash, event.head, 'tx-link')];
    for (const p of event.parties) {
      const member = settings.cast?.find((m) => m.address === p.address);
      const a = link('account', p.address, member ? member.label : p.short, `acct-link${member ? ' cast-link' : ''}`);
      if (member) {
        a.style.setProperty('--cast', member.colour);
        a.title = p.address;
      }
      nodes.push(p.separator, a);
    }
    nodes.push(` · ${event.note}`);
    if (event.cues?.length) {
      nodes.push(el('span', { class: 'tape-cast' }, event.cues.map((c) => el('span', { class: 'tape-chip', style: `--cast: ${c.colour}`, text: c.label, title: 'Also involved' }))));
    }
    return nodes;
  }

  function ledgerLine(event) {
    return [link('ledger', event.ledgerIndex, event.text, 'ledger-link')];
  }
}

// xrpl-sonic — snapshot (PNG) and 30-second recording (WebM).
//
// The helpers at the top are pure and unit-tested; the functions below them
// touch the DOM, canvas and MediaRecorder and are only called from main.js.

export const RECORD_SECONDS = 30;
export const CAPTURE_FPS = 30;

/** Preferred container/codec combinations, best first. */
export const RECORDING_MIME_TYPES = Object.freeze(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']);

/** First MIME type the browser can record, or null. `isTypeSupported` is injected for testability. */
export function pickRecordingMimeType(isTypeSupported) {
  if (typeof isTypeSupported !== 'function') return null;
  for (const type of RECORDING_MIME_TYPES) {
    try {
      if (isTypeSupported(type)) return type;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** What the environment can do. Pass the globals in, so this stays testable. */
export function captureSupport({ MediaRecorder, HTMLCanvasElement } = {}) {
  const canvasCapture = typeof HTMLCanvasElement?.prototype?.captureStream === 'function';
  const recorder = typeof MediaRecorder === 'function';
  const mimeType = recorder ? pickRecordingMimeType((t) => MediaRecorder.isTypeSupported?.(t)) : null;
  return { snapshot: true, recording: Boolean(canvasCapture && recorder && mimeType), mimeType };
}

function fileStem(ledgerIndex) {
  const n = Number(ledgerIndex);
  return `xrpl-sonic-${Number.isInteger(n) && n > 0 ? n : 'live'}`;
}

export function snapshotFilename(ledgerIndex) {
  return `${fileStem(ledgerIndex)}.png`;
}

export function recordingFilename(ledgerIndex) {
  return `${fileStem(ledgerIndex)}.webm`;
}

/**
 * Text lines for the stats overlay burned into a snapshot.
 * @param {{ ledgerIndex?: number|null, txLastMinute?: number, network?: string, timestamp?: string|Date, url?: string }} s
 */
export function snapshotLines({ ledgerIndex = null, txLastMinute = 0, network = 'Mainnet', timestamp = new Date(), url = '' } = {}) {
  const n = Number(ledgerIndex);
  const ledger = Number.isInteger(n) && n > 0 ? `Ledger #${n.toLocaleString('en-US')}` : 'Ledger —';
  const count = Math.max(0, Math.round(Number(txLastMinute) || 0));
  const when = timestamp instanceof Date ? timestamp.toISOString() : String(timestamp);
  const lines = [`xrpl-sonic · ${network}`, ledger, `${count.toLocaleString('en-US')} tx in the last minute`, when.replace(/\.\d{3}Z$/, 'Z')];
  if (url) lines.push(url);
  return lines;
}

// ---------------------------------------------------------------------------
// DOM / media (not unit-tested)
// ---------------------------------------------------------------------------

/**
 * Compose the scene canvas plus a stats box into a PNG blob via an offscreen
 * canvas. `dpr` scales the overlay so it looks the same on 1x and 2x screens.
 */
export function composeSnapshot(sourceCanvas, lines, { background = '#060a12', transparent = false, dpr = 1 } = {}) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  if (!transparent) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(sourceCanvas, 0, 0);

  const s = Math.max(1, dpr);
  const pad = 14 * s;
  const lineH = 18 * s;
  ctx.font = `${13 * s}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  ctx.textBaseline = 'top';
  const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const boxW = textW + pad * 2;
  const boxH = lines.length * lineH + pad * 2 - (lineH - 13 * s);
  const x = 16 * s;
  const y = h - boxH - 16 * s;
  ctx.fillStyle = 'rgba(6, 10, 18, 0.8)';
  ctx.strokeStyle = 'rgba(140, 170, 220, 0.3)';
  ctx.lineWidth = s;
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, 4 * s);
  ctx.fill();
  ctx.stroke();
  lines.forEach((line, i) => {
    ctx.fillStyle = i === 0 ? '#4cc9f0' : i === lines.length - 1 ? '#7f8ca6' : '#e8eefb';
    ctx.fillText(line, x + pad, y + pad + i * lineH);
  });
  return new Promise((resolve, reject) => out.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png'));
}

/** Trigger a download of a blob with the given filename. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Record the canvas (and an audio MediaStream, if given) for `seconds`.
 * Returns { done: Promise<Blob>, stop() }. `onTick(remainingSeconds)` fires once a second.
 */
export function startRecording({ canvas, audioStream = null, seconds = RECORD_SECONDS, mimeType, onTick } = {}) {
  const stream = canvas.captureStream(CAPTURE_FPS);
  if (audioStream) for (const track of audioStream.getAudioTracks()) stream.addTrack(track);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 128_000 });
  const chunks = [];
  let remaining = seconds;
  let ticker = 0;
  let timer = 0;
  const done = new Promise((resolve, reject) => {
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = (e) => {
      cleanup();
      reject(e.error ?? new Error('MediaRecorder error'));
    };
    recorder.onstop = () => {
      cleanup();
      for (const track of stream.getVideoTracks()) track.stop();
      resolve(new Blob(chunks, { type: recorder.mimeType || mimeType }));
    };
  });
  const cleanup = () => {
    clearInterval(ticker);
    clearTimeout(timer);
  };
  const stop = () => {
    if (recorder.state !== 'inactive') recorder.stop();
  };
  recorder.start(1000);
  onTick?.(remaining);
  ticker = setInterval(() => {
    remaining = Math.max(0, remaining - 1);
    onTick?.(remaining);
  }, 1000);
  timer = setTimeout(stop, seconds * 1000);
  return { done, stop, recorder, stream };
}

// UNIVERSE spike — a minimal Chrome DevTools Protocol client for the bench.
//
// Launches Chrome headless with a fresh profile and a debugging port, opens
// one target, and offers evaluate / navigate / screenshot over the page's
// WebSocket. The pattern is the one the explorer's headless checks used.
// Node 22+ (global WebSocket and fetch).

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

export const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 9341, profile, headless = true, width = 1280, height = 800, extraArgs = [] } = {}) {
  const dir = profile ?? `${process.env.TEMP ?? '.'}/universe-chrome-${port}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const args = [
    ...(headless ? ['--headless=new'] : []),
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-swiftshader', // WebGL in headless Chrome goes through SwiftShader; recent builds refuse it without this
    '--use-angle=swiftshader',
    `--window-size=${width},${height}`,
    `--user-data-dir=${dir}`,
    `--remote-debugging-port=${port}`,
    ...extraArgs,
    'about:blank',
  ];
  const chrome = spawn(CHROME, args, { stdio: 'ignore' });
  let version = null;
  for (let i = 0; i < 100; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await sleep(200);
    }
  }
  if (!version) throw new Error('Chrome did not open its debugging port');
  return { chrome, port, version, dir, kill: () => chrome.kill() };
}

export async function openPage(port, { width = 1280, height = 800 } = {}) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let seq = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method === 'Runtime.exceptionThrown') logs.push(`EXCEPTION ${m.params.exceptionDetails.text} ${m.params.exceptionDetails.exception?.description ?? ''}`.slice(0, 800));
    else if (m.method === 'Runtime.consoleAPICalled') logs.push(`${m.params.type.toUpperCase()} ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`.slice(0, 400));
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const navigate = async (url) => {
    await send('Page.navigate', { url });
  };
  const screenshot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return file;
  };
  const close = () => ws.close();
  return { send, evaluate, navigate, screenshot, logs, close };
}

/** Poll an expression until it is truthy, or give up. */
export async function waitFor(page, expression, { timeoutMs = 60000, everyMs = 500 } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try {
      v = await page.evaluate(expression);
    } catch {
      /* the page may still be loading */
    }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${expression}`);
    await sleep(everyMs);
  }
}

export { sleep };

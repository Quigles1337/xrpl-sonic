#!/usr/bin/env node
// UNIVERSE spike — a static server for the bench harness.
//
// The pages need an HTTP origin for ES modules and the worker, and the
// memory measurement (performance.measureUserAgentSpecificMemory) needs a
// cross-origin-isolated page, which takes two headers no plain static server
// sends. No caching, so an edited module is what the next load gets.
//
//   node src/universe/bench/serve.mjs [--port 4181] [--root .]

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};
const port = Number(opt('port', 4181)) || 4181;
const root = resolve(opt('root', '.'));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(root, path));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  let st;
  try {
    st = statSync(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    return;
  }
  if (st.isDirectory()) {
    res.writeHead(301, { Location: `${url.pathname}/` }).end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-store',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  });
  createReadStream(file).pipe(res);
});
server.listen(port, '127.0.0.1', () => console.log(`serving ${root} at http://127.0.0.1:${port}/ (cross-origin isolated, no cache)`));

#!/usr/bin/env node
// UNIVERSE spike — record one real-browser frame-time measurement.
//
// The real-GPU numbers are read from the page's own stats() in the user's
// browser (the Claude in Chrome extension evaluates the same snippet
// frames.mjs uses); this script appends one such result to
// results/frames-real.json so report.mjs prints it beside the headless ones.
//
//   node src/universe/bench/frames-real-add.mjs <renderer> <planets> '<json from the page>' [--note "..."]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [renderer, planets, json, ...rest] = process.argv.slice(2);
const file = 'src/universe/bench/results/frames-real.json';
const noteIndex = rest.indexOf('--note');
const note = noteIndex >= 0 ? rest[noteIndex + 1] : null;
const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { at: new Date().toISOString(), note: 'the user’s own browser, through the page’s stats(); views sampled 4 s each after the sky reached its size', results: [] };
if (note) data.note = note;
if (renderer && planets && json) {
  const page = JSON.parse(json);
  data.results = data.results.filter((r) => !(r.renderer === renderer && r.planets === Number(planets)));
  data.results.push({ renderer, actualRenderer: page.renderer ?? renderer, planets: Number(planets), views: page.views, stability: page.stability ?? null, memory: page.memory ?? null, dpr: page.dpr ?? null, size: page.size ?? null, ua: page.ua ?? null, at: new Date().toISOString() });
  data.results.sort((a, b) => a.renderer.localeCompare(b.renderer) || a.planets - b.planets);
}
writeFileSync(file, JSON.stringify(data, null, 2));
console.log(`${file}: ${data.results.map((r) => `${r.renderer} ${r.planets}`).join(', ')}`);

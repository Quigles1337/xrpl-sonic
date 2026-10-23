// The ledgers that ship with the page (docs/loader.md): docs/cases/ledgers/mainnet,
// the sixteen ledgers of the cadence tour's case (which contain the sample
// case's three) and the header after them, each file the node's result
// verbatim. Every file is checked against the index; both shipped cases are
// covered in full; the tours' numbers hold on the bundle: the sample case's
// first ledger has the 84 transactions its first annotation states, and
// Sender A keeps its three-ledger cadence over the sixteen.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBundle, LedgerLoader, describeSources } from '../src/loader.js';
import { caseLedgerIndices, caseHeaderIndices } from '../src/ledgers.js';
import { validateCase } from '../src/case.js';
import { buildScore } from '../src/score.js';
import { frameFromScore, coherence, cadences } from '../src/coherence.js';
import { SAMPLE_CASE_URL, COHERENCE_CASE_URL } from '../src/tours.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'docs', 'cases', 'ledgers', 'mainnet');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const index = readJson(join(dir, 'index.json'));
const HASH = /^[0-9A-F]{64}$/;

/** The bundle read from the disk, as the page reads it over fetch. */
const bundle = createBundle({ baseUrl: 'docs/cases/ledgers/', read: async (url) => {
  try {
    return readJson(join(root, url));
  } catch {
    return null;
  }
} });

describe('the bundle on disk', () => {
  test('the index lists mainnet #107,777,802 to #107,777,817 in full and the header of #107,777,818, fetched from s2; nothing else is in the directory', () => {
    assert.equal(index.network, 'mainnet');
    assert.equal(index.fetchedVia, 's2.ripple.com');
    assert.match(index.fetchedAt, /^2026-10-23T/);
    assert.deepEqual(index.ledgers.map((l) => l.index), Array.from({ length: 17 }, (_, i) => 107777802 + i));
    assert.deepEqual(index.ledgers.map((l) => l.full), [...new Array(16).fill(true), false]);
    const files = readdirSync(dir).sort();
    assert.deepEqual(files, ['index.json', ...index.ledgers.map((l) => `${l.index}.json`)].sort());
  });

  test('every file is the node’s validated result for its ledger: index, hash, close time and transaction count as listed', () => {
    let bytes = 0;
    for (const entry of index.ledgers) {
      const path = join(dir, `${entry.index}.json`);
      bytes += statSync(path).size;
      const r = readJson(path);
      assert.equal(r.validated, true, `${entry.index} validated`);
      assert.equal(Number(r.ledger_index), entry.index);
      assert.equal(r.ledger_hash, entry.hash);
      assert.match(entry.hash, HASH);
      assert.equal(Number(r.ledger.ledger_index), entry.index);
      assert.equal(r.ledger.ledger_hash, entry.hash);
      assert.equal(r.ledger.closed, true);
      assert.equal(Number(r.ledger.close_time), entry.closeTime);
      if (entry.full) {
        assert.ok(Array.isArray(r.ledger.transactions), `${entry.index} expanded`);
        assert.equal(r.ledger.transactions.length, entry.txnCount);
        assert.ok(r.ledger.transactions.every((t) => typeof t === 'object' && t.hash && (t.metaData ?? t.meta)), 'expanded transactions with their metadata');
      } else {
        assert.equal(r.ledger.transactions, undefined, 'a header carries no transactions');
        assert.equal(entry.txnCount, null);
      }
    }
    assert.ok(bytes < 8 * 1024 * 1024, `the bundle stays under 8 MB (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
    const hashes = new Set(index.ledgers.map((l) => l.hash));
    assert.equal(hashes.size, index.ledgers.length, 'every hash distinct');
    for (let i = 1; i < index.ledgers.length; i++) assert.ok(index.ledgers[i].closeTime > index.ledgers[i - 1].closeTime, 'close times rise');
  });

  test('both shipped cases are covered in full, headers included, so the two tours open without a node', async () => {
    const listed = new Set(index.ledgers.map((l) => l.index));
    const full = new Set(index.ledgers.filter((l) => l.full).map((l) => l.index));
    for (const url of [SAMPLE_CASE_URL, COHERENCE_CASE_URL]) {
      const c = validateCase(readJson(join(root, url))).case;
      for (const n of caseLedgerIndices(c)) assert.ok(full.has(n), `${url}: #${n} in full`);
      for (const n of caseHeaderIndices(c)) assert.ok(listed.has(n), `${url}: header #${n}`);
    }
    assert.deepEqual(await bundle.indices('mainnet'), index.ledgers.map((l) => l.index));
    assert.equal(await bundle.get('mainnet', 107777818), null, 'the header does not serve a full request');
    assert.ok((await bundle.get('mainnet', 107777818, { full: false }))?.result?.ledger);
  });

  test('the sample case plays from the bundle alone: no node asked, the first ledger’s 84 transactions as its first annotation states', async () => {
    const theCase = validateCase(readJson(join(root, SAMPLE_CASE_URL))).case;
    const asked = [];
    const loader = new LedgerLoader({ request: async (cmd) => (asked.push(cmd), Promise.reject(Object.assign(new Error('offline'), { code: 'noNode' }))), bundle });
    const { ledgers, failures, sources } = await loader.case(theCase);
    assert.deepEqual(asked, []);
    assert.deepEqual(failures, []);
    assert.deepEqual(sources, { bundle: 3, cache: 0, node: 0, failed: 0, total: 3, host: '' });
    assert.equal(describeSources({ sources }), '3 ledgers: 3 bundled with the page.');
    assert.equal(ledgers.get(107777809).ledger.transactions.length, 84);
    assert.match(theCase.annotations[0].text, /84 transactions/);
    assert.equal(ledgers.get(107777811).nextCloseTime, index.ledgers.find((l) => l.index === 107777812).closeTime, 'the next ledger, bundled in full, gives the last close interval');
    const score = buildScore(theCase, ledgers);
    assert.ok(score.counts.events > 0);
    assert.deepEqual(score.warnings, []);
  });

  test('the cadence case plays from the bundle alone, and Sender A keeps its three-ledger cadence over the sixteen ledgers', async () => {
    const theCase = validateCase(readJson(join(root, COHERENCE_CASE_URL))).case;
    const loader = new LedgerLoader({ request: async () => Promise.reject(Object.assign(new Error('offline'), { code: 'noNode' })), bundle });
    const { ledgers, failures, sources } = await loader.case(theCase);
    assert.deepEqual(failures, []);
    assert.deepEqual(sources, { bundle: 16, cache: 0, node: 0, failed: 0, total: 16, host: '' });
    assert.equal(ledgers.get(107777817).nextCloseTime, index.ledgers.at(-1).closeTime, 'the bundled header gives the last close interval');
    const score = buildScore(theCase, ledgers);
    const frame = frameFromScore(score, { cast: theCase.cast, ledgers });
    const report = coherence(frame);
    assert.equal(report.window.used, 16);
    const own = cadences(frame);
    const [A, B] = theCase.cast.map((m) => m.address);
    assert.equal(own.get(A).period, 3, 'Sender A: a three-ledger cadence');
    assert.ok(own.get(A).r > 0.9, `self-correlation ${own.get(A).r.toFixed(2)}`);
    assert.equal(own.get(B), null, 'Sender B: none');
    assert.equal(report.pairs.length, 1);
    assert.equal(report.pairs[0].judged, true);
  });
});

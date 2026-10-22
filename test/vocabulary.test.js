// The project's terms at the point of use (src/vocabulary.js, docs/ux.md):
// every sentence the page shows is in the document's table verbatim, with
// its source named, and the guarded controls' reasons and the ways to a
// case are what the document lists.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TERMS, termSentence, REASONS, WAYS_TO_A_CASE } from '../src/vocabulary.js';

const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'ux.md'), 'utf8');

describe('vocabulary', () => {
  test('every sentence is in docs/ux.md verbatim, with a source', () => {
    const keys = Object.keys(TERMS);
    assert.ok(keys.length >= 24);
    for (const key of keys) {
      const { sentence, source } = TERMS[key];
      assert.ok(sentence.length > 20 && /[.]$/.test(sentence), `${key}: a sentence`);
      assert.ok(doc.includes(sentence), `${key}: in docs/ux.md verbatim: ${sentence.slice(0, 60)}`);
      assert.match(source, /README|docs\/|the start screen/, `${key}: a source`);
      assert.doesNotMatch(sentence, /coordinat/i, `${key}: nothing says coordinated`);
    }
    assert.equal(termSentence('case'), TERMS.case.sentence);
    assert.equal(termSentence('nope'), '');
  });

  test('the reasons and the ways to a case', () => {
    assert.ok(Object.values(REASONS).every((r) => r.length > 10));
    assert.match(REASONS.needsCase, /Moment/);
    assert.match(REASONS.needsScore, /press Start/);
    assert.equal(WAYS_TO_A_CASE.length, 5);
    assert.match(WAYS_TO_A_CASE[0], /^Press Moment/);
    assert.match(WAYS_TO_A_CASE[1], /sample case/);
  });
});

// Copy for AI: the case as text an assistant can work from, and the way its
// answer comes back as draft annotations. The golden renderings of a recorded
// fixture moment (test/fixtures/describe/) are the exact expected output.

import { test, describe as suite } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, describeReport, factsForCase, importAnnotations, DEFAULT_BUDGET, LEVELS, SELECTION_RULE, REPLY_TRAILER_HEAD, exampleAnnotation, explorerRoute } from '../src/describe.js';
import { validateCase, serializeCase, caseFromState, MOMENT_VERSION, CASE_VERSION } from '../src/case.js';
import { buildScore, SCORE_VERSION } from '../src/score.js';
import { MAPPING_VERSION } from '../src/mapping.js';
import { FACTS_VERSION } from '../src/explorer/facts.js';
import { LiveWindow, momentFromLive, momentFromReplay, momentFromTransaction } from '../src/moment.js';
import { SITE_URL } from '../src/explorers.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8'));
const golden = (name) => {
  const p = join(fixturesDir, 'describe', name);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};

const expanded = fixture('ledger-expanded').result.ledger;
const nextClose = Number(fixture('ledger-next-header').result.ledger.close_time);
const INDEX = Number(expanded.ledger_index);
const ledgersFor = (indices, { missing = [] } = {}) => new Map(indices.map((i) => [i, missing.includes(i) ? { ledger: null, nextCloseTime: null } : { ledger: { ...expanded, ledger_index: i }, nextCloseTime: nextClose }]));

const momentCase = () => validateCase(fixture('describe/moment-107777809.sonic-case')).case;
const ANCHOR = '0176B15458AF71EDF66D5C679FDBDCD360EB1602ECB7925352858D081287FE63';
const CASE_LINK = 'https://quigles1337.github.io/xrpl-sonic/#case=z:example';

function render(level = 'gist', extra = {}) {
  const c = momentCase();
  const ledgers = ledgersFor([INDEX]);
  const facts = factsForCase(c, ledgers);
  return { c, ledgers, facts, text: describe(c, ledgers, facts, { level, caseLink: CASE_LINK, ...extra }) };
}

suite('describe: the golden renderings', () => {
  test('gist of the recorded moment is exactly the checked-in text', () => {
    const expected = golden('gist.txt');
    assert.ok(expected, 'test/fixtures/describe/gist.txt exists');
    assert.equal(render('gist').text, expected);
  });

  test('evidence of the recorded moment is exactly the checked-in text', () => {
    const expected = golden('evidence.txt');
    assert.ok(expected, 'test/fixtures/describe/evidence.txt exists');
    assert.equal(render('evidence').text, expected);
  });

  test('the same case, ledgers and facts give identical text; the default level is gist', () => {
    const a = render('gist');
    const b = render('gist');
    assert.equal(a.text, b.text);
    assert.equal(describe(a.c, a.ledgers, a.facts, { caseLink: CASE_LINK }), a.text);
    assert.deepEqual(LEVELS, ['gist', 'evidence']);
    assert.ok(Number.isInteger(DEFAULT_BUDGET) && DEFAULT_BUDGET > 0);
  });
});

suite('describe: content', () => {
  test('header: what it is, versions, network and host, the question and its anchor, scope with hashes, coverage', () => {
    const { text } = render('gist');
    const lines = text.split('\n');
    assert.equal(lines[0], 'xrpl-sonic case · Copy for AI · level gist');
    assert.equal(lines[1], `versions: case ${CASE_VERSION} · moment ${MOMENT_VERSION} · facts ${FACTS_VERSION} · mapping ${MAPPING_VERSION} · score ${SCORE_VERSION}`);
    assert.equal(lines[2], 'network: mainnet · host: s2.ripple.com · saved: 2026-10-21T12:00:00.000Z while listening replay');
    assert.ok(text.includes('case: moment-107777809-20261021t120000 · "Moment at ledger #107,777,809"'));
    assert.ok(text.includes(`question: "Why did this offer replace the earlier one instead of crossing anything?" · anchor: tx ${ANCHOR}`));
    assert.ok(text.includes(`scope: clip 1: ledgers ${INDEX}–${INDEX} · #${INDEX} hash ${expanded.ledger_hash}`));
    assert.ok(text.includes(`coverage (fetched for this text): #${INDEX} fetched, 7 transactions`));
    assert.ok(text.includes('loop: 0:01.000–0:07.000 on the case timeline'));
  });

  test('three counts, each labelled with what it measures, and never a performance count', () => {
    const { text } = render('gist');
    assert.ok(text.includes('counts:\n  available in scope (sum of txn_count over the fetched ledgers): 7\n  selected by the listening settings (events in the score): 6\n  excluded by reason: failed 1'));
    assert.ok(!/sounded|played|dropped|rate-limit/i.test(text));
  });

  test('the listening settings in one line, as context', () => {
    const { text } = render('gist');
    assert.ok(text.includes('listening settings (context for the selection, not facts about the ledger): cast: rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah "Sender A"; categories: all on; failed transactions: excluded; quiet threshold: off; scale: pentatonicMajor; key: C; mapping: 1.1.0; cast mode: all; speed: 1x'));
  });

  test('concentration: top submitting accounts with counts and shares, and the cast counts', () => {
    const { text } = render('gist');
    assert.ok(text.includes('concentration (submitting accounts among the 7 available transactions):'));
    assert.ok(text.includes('  rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah "Sender A": 1 (14.3%)'));
    assert.ok(text.includes('  cast: "Sender A" rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah submitted 1, involved 1'));
  });

  test('events: one line each in application order with full hashes and addresses and exact amounts; the anchor and the cast marked', () => {
    const { text } = render('gist');
    assert.ok(text.includes('events (6 of 6 shown; order: as applied in each ledger):'));
    assert.ok(text.includes(`  #${INDEX} tx 21 0EC1CCB7553BB931B7C02B484E235692D62DFA2DCB1B44295D15F8090CA90614 Payment tesSUCCESS from rnh6AcSp8JKuihKbchsvAuGyUTqEZh71mV to raEHTgpcCanAb56bCWnkms9pb1wXcbUo7A · delivered 1700000 drops`));
    assert.ok(text.includes(`  #${INDEX} tx 38 ${ANCHOR} OfferCreate tesSUCCESS from rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah "Sender A" · gives 23691000000 drops for 33490.0352556885 USD issuer rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq · replaces offer 287256820 [anchor] [cast: Sender A]`));
    assert.ok(text.includes(`  #${INDEX} tx 31 A3776F7C62B816708D48194F8A91137DBDF593E171F0A41B58ACFA20C0E6AF01 OfferCancel tesSUCCESS from rBWr5wTBJhc5osje2PcRZkaWFcamqjnDBG · cancels offer 107574102`));
    assert.ok(!text.includes('1D34E4930EB0013992EFC3886F09FFB059F6FE35EC13AE70F0AA499BF8E618B0'), 'the failed payment is excluded by the settings and not listed');
    assert.ok(!/…/.test(text.split('how to reply:')[0]), 'nothing is shortened');
  });

  test('findings for the anchor: tier and rule on every line, evidence by node, exact values, unresolved as unresolved', () => {
    const { text, facts } = render('gist');
    const block = text.split(`findings for ${ANCHOR} (OfferCreate, the anchor):`)[1].split('\nlinks:')[0];
    const lines = block.split('\n').filter((l) => l.startsWith('  ['));
    assert.ok(lines.length >= 10, 'one line per finding');
    for (const l of lines) assert.match(l, /^ {2}\[(observed|calculated|rule|hypothesis)\] [a-z.-]+ [a-z:/A-Z0-9.-]+ = .+( · evidence: .+)?$/, l);
    assert.ok(lines.some((l) => l.includes('[rule] offer.removal.replaced offer:0.removal = replaced · evidence: node 0 FinalFields.Account, tx.Account, tx.TransactionType, node 0 FinalFields.Sequence, tx.OfferSequence, node 0 PreviousFields')));
    assert.ok(lines.some((l) => l.includes('[calculated] exchange.fill exchange.fill = status none, judged by takerPays-received, requested 33490.0352556885 USD issuer rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq, achieved 0 USD issuer rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq, placed yes')));
    assert.equal(facts.get(ANCHOR).findings.length, lines.length);
    assert.ok(!text.includes('source fields:'), 'gist has no source fields');
  });

  test('evidence level adds findings for cast-involved events and the selected source fields; no raw AffectedNodes', () => {
    const { text } = render('evidence');
    assert.ok(text.includes(`findings for ${ANCHOR} (OfferCreate, the anchor, cast: Sender A):`));
    assert.ok(text.includes('  source fields: TransactionType OfferCreate · Account rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah · Flags 0 (none) · TakerGets 23691000000 drops · TakerPays 33490.0352556885 USD issuer rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq · Fee 10 · Sequence 287256845 · OfferSequence 287256820 · TransactionResult tesSUCCESS'));
    assert.ok(!text.includes('AffectedNodes'));
    assert.ok(!text.includes('LedgerEntryType'));
  });

  test('links: the case link and the explorer route per event', () => {
    const { text } = render('gist');
    assert.ok(text.includes(`links:\n  case: ${CASE_LINK}`));
    assert.ok(text.includes(`  explorer: ${SITE_URL}explorer.html#tx/<hash> for any hash in this text`));
    assert.ok(text.includes(`  ${ANCHOR}: ${explorerRoute('mainnet', ANCHOR)}`));
    assert.equal(explorerRoute('testnet', ANCHOR), `${SITE_URL}explorer.html?network=testnet#tx/${ANCHOR}`);
    const without = describe(momentCase(), ledgersFor([INDEX]), factsForCase(momentCase(), ledgersFor([INDEX])));
    assert.ok(without.includes('  case: not available in this rendering'));
  });

  test('the trailer is fixed and ends the text; its example is in the annotation shape with a hash from this text', () => {
    const { text } = render('gist');
    assert.ok(text.endsWith('\n'));
    const tail = text.split('how to reply:')[1];
    assert.ok(tail, 'the trailer is present');
    assert.ok(tail.startsWith(REPLY_TRAILER_HEAD.split('how to reply:')[1]));
    assert.ok(tail.includes('observations') && tail.includes('hypotheses') && tail.includes('common ownership'));
    const example = JSON.parse(tail.split('example:\n')[1].trim());
    assert.deepEqual(example, [exampleAnnotation(ANCHOR)]);
    assert.deepEqual(Object.keys(example[0]), ['text', 'anchor', 'kind', 'evidence', 'source', 'status']);
    assert.equal(example[0].status, 'draft');
  });
});

suite('describe: budget', () => {
  test('overflow selects under the stated rule and says N of M; nothing is dropped silently', () => {
    const c = validateCase({ ...fixture('describe/moment-107777809.sonic-case'), clips: [`${INDEX}-${INDEX + 2}`], moment: { ...fixture('describe/moment-107777809.sonic-case').moment, loop: null } }).case;
    const ledgers = ledgersFor([INDEX, INDEX + 1, INDEX + 2]);
    const facts = factsForCase(c, ledgers);
    const full = describeReport(c, ledgers, facts, { level: 'gist' });
    assert.equal(full.shown, 18);
    assert.equal(full.total, 18);
    assert.equal(full.chars, full.text.length);
    assert.equal(full.tokensApprox, Math.ceil(full.chars / 4));
    const small = describeReport(c, ledgers, facts, { level: 'gist', budget: 6000 });
    assert.ok(small.chars <= 6000 + 1500, `near the budget (${small.chars})`);
    assert.ok(small.shown < small.total);
    assert.ok(small.text.includes(`events (${small.shown} of ${small.total} shown; rule: ${SELECTION_RULE}, up to the budget of 6000 characters):`));
    assert.equal(small.rule, SELECTION_RULE);
    // the anchor event and the cast-involved events come first, then the rest in application order
    const shownLines = small.text.split('events (')[1].split('\n').slice(1).filter((l) => l.startsWith('  #'));
    assert.ok(shownLines[0].includes(ANCHOR), 'the anchor first');
    const castLines = shownLines.filter((l) => l.includes('[cast: Sender A]'));
    assert.equal(castLines.length, 3, 'all three cast-involved events (one per ledger) are kept');
    for (let i = 1; i <= 2; i++) assert.ok(shownLines[i].includes('[cast: Sender A]'), 'cast-involved events follow the anchor');
    const tiny = describeReport(c, ledgers, facts, { level: 'gist', budget: 10 });
    assert.ok(tiny.text.includes('events (1 of 18 shown;'), 'the anchor is always shown');
    assert.ok(!tiny.text.includes('rnh6AcSp8JKuihKbchsvAuGyUTqEZh71mV'));
  });
});

suite('describe: the three moment kinds', () => {
  const closed = fixture('ledger-closed');
  const LIVE = Number(closed.ledger_index);
  const txA = fixture('payment-failed');

  test('a live moment: saved coverage per ledger in the header, the ledger anchor, no findings at gist', () => {
    const w = new LiveWindow();
    w.noteLedger(closed);
    w.noteTransaction(txA);
    w.noteLedger({ ...closed, ledger_index: LIVE + 1 });
    const base = caseFromState({ network: 'mainnet', cast: ['rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah'], settings: {} });
    const c = validateCase(momentFromLive({ base, window: w, question: 'A burst', host: 'xrplcluster.com', savedAt: '2026-10-21T20:00:00.000Z' })).case;
    // the ledgers are refetched on reopen; here the fixture ledger stands in for both, and one is unavailable
    const ledgers = ledgersFor([LIVE, LIVE + 1], { missing: [LIVE + 1] });
    const r = describeReport(c, ledgers, factsForCase(c, ledgers));
    assert.ok(r.text.includes('network: mainnet · host: xrplcluster.com · saved: 2026-10-21T20:00:00.000Z while listening live'));
    assert.ok(r.text.includes(`question: "A burst" · anchor: ledger #${LIVE + 1}`));
    assert.ok(r.text.includes(`coverage (as heard when saved, received/expected per ledger): #${LIVE} 1/87 · #${LIVE + 1} 0/87`));
    assert.ok(r.text.includes(`coverage (fetched for this text): #${LIVE} fetched, 7 transactions · #${LIVE + 1} unavailable`));
    assert.ok(r.text.includes('available in scope (sum of txn_count over the fetched ledgers): 7 (1 ledger unavailable, not counted)'));
    assert.ok(r.text.includes('findings: the anchor is a ledger, not a transaction, so there are none at the gist level'));
    assert.equal(r.shown, 6);
  });

  test('a replay moment with a loop: the loop in the header, hash anchor, findings for the anchor', () => {
    const base = validateCase({ clips: [`${INDEX}-${INDEX + 1}`], cast: ['rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah'] }).case;
    const score = buildScore(base, ledgersFor([INDEX, INDEX + 1]));
    const c = validateCase(momentFromReplay({ base, score, positionMs: 100, loop: { fromMs: 0, toMs: score.totalMs }, selectedHash: ANCHOR, question: 'this one', host: 'h', savedAt: '2026-01-01T00:00:00.000Z' })).case;
    const ledgers = ledgersFor([INDEX, INDEX + 1]);
    const r = describeReport(c, ledgers, factsForCase(c, ledgers));
    assert.ok(r.text.includes('while listening replay'));
    assert.ok(r.text.includes(`loop: 0:00.000–${formatTotal(score.totalMs)} on the case timeline`));
    assert.ok(r.text.includes(`findings for ${ANCHOR} (OfferCreate, the anchor, cast: Sender A):`));
    assert.equal(r.total, 12);
    assert.ok(r.text.includes('events (12 of 12 shown; order: as applied in each ledger):'));
  });

  test('an explorer-handoff moment: no question, the anchor stated, host from the explorer', () => {
    const c = validateCase(momentFromTransaction({ network: 'mainnet', ledgerIndex: INDEX, hash: ANCHOR, ledgerHash: expanded.ledger_hash, host: 'xrplcluster.com', savedAt: '2026-01-01T00:00:00.000Z' })).case;
    const ledgers = ledgersFor([INDEX]);
    const r = describeReport(c, ledgers, factsForCase(c, ledgers));
    assert.ok(r.text.includes('saved: 2026-01-01T00:00:00.000Z from the explorer'));
    assert.ok(r.text.includes(`question: none · anchor: tx ${ANCHOR}`));
    assert.ok(r.text.includes('listening settings (context for the selection, not facts about the ledger): cast: none;'));
    assert.ok(r.text.includes(`findings for ${ANCHOR} (OfferCreate, the anchor):`));
  });

  test('an ordinary case (no moment block) describes itself without a question or an anchor', () => {
    const c = validateCase({ clips: [String(INDEX)], title: 'Plain' }).case;
    const ledgers = ledgersFor([INDEX]);
    const text = describe(c, ledgers, factsForCase(c, ledgers));
    assert.ok(text.includes('versions: case 1 · moment none'));
    assert.ok(text.includes('network: mainnet · host: unknown'));
    assert.ok(text.includes('question: none · anchor: none'));
    assert.ok(text.includes('findings: no anchor transaction, so there are none at the gist level'));
  });
});

function formatTotal(ms) {
  const t = Math.round(ms);
  return `${Math.floor(t / 60000)}:${String(Math.floor((t % 60000) / 1000)).padStart(2, '0')}.${String(t % 1000).padStart(3, '0')}`;
}

suite('importAnnotations: the return path', () => {
  const setup = () => {
    const c = momentCase();
    const ledgers = ledgersFor([INDEX]);
    const score = buildScore(c, ledgers);
    return { c, ledgers, score };
  };

  test('the trailer example, pasted back, lands as a draft at its anchor with the given source', () => {
    const { c, ledgers, score } = setup();
    const text = describe(c, ledgers, factsForCase(c, ledgers), { caseLink: CASE_LINK });
    const pasted = text.split('example:\n')[1].trim();
    const r = importAnnotations(c, pasted, { source: 'assistant-x', score });
    assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
    assert.equal(r.accepted.length, 1);
    const a = r.case.annotations.find((x) => x.id === r.accepted[0].id);
    assert.equal(a.status, 'draft');
    assert.equal(a.source, 'assistant-x');
    assert.equal(a.kind, 'observation');
    assert.deepEqual(a.evidence, [ANCHOR]);
    assert.deepEqual(a.anchor, { hash: ANCHOR });
    assert.equal(r.case.annotations.length, c.annotations.length + 1, 'appended, nothing overwritten');
    assert.deepEqual(r.case.annotations.slice(0, 2), c.annotations, 'existing notes untouched');
    assert.ok(serializeCase(r.case).includes('"kind": "observation"'));
    assert.ok(serializeCase(r.case).includes('"evidence": ['));
  });

  test('an array, a whole case, or a JSON string; anchors resolved against the score; rejections say why', () => {
    const { c, score } = setup();
    const ledgerHash = expanded.ledger_hash;
    const items = [
      { text: 'by ledger', anchor: { ledger: INDEX }, kind: 'hypothesis' },
      { text: 'by time', anchor: { timeMs: 500 }, kind: 'observation', evidence: [ANCHOR, ANCHOR.toLowerCase()] },
      { text: 'unknown hash', anchor: { hash: 'F'.repeat(64) } },
      { text: 'wrong ledger', anchor: { ledger: INDEX + 40 } },
      { text: 'beyond the end', anchor: { timeMs: 10 ** 9 } },
      { text: '', anchor: { hash: ANCHOR } },
      { anchor: { hash: ANCHOR } },
      { text: 'no anchor' },
      { text: 'bad kind', anchor: { hash: ANCHOR }, kind: 'verdict', status: 'reviewed', id: 'a1', pause: true },
      { text: 'Why did this offer replace the earlier one instead of crossing anything?', anchor: { hash: ANCHOR } },
      'not an object',
    ];
    const r = importAnnotations(c, items, { source: 'assistant', score });
    assert.deepEqual(r.accepted.map((a) => a.text), ['by ledger', 'by time', 'bad kind']);
    const reasons = Object.fromEntries(r.rejected.map((x) => [x.index, x.reason]));
    assert.match(reasons[2], /hash .* not in this case/);
    assert.match(reasons[3], /ledger .* not in this case/);
    assert.match(reasons[4], /beyond the end/);
    assert.match(reasons[5], /no text/);
    assert.match(reasons[6], /no text/);
    assert.match(reasons[7], /no usable anchor/);
    assert.match(reasons[9], /already present/);
    assert.match(reasons[10], /not an object/);
    const byTime = r.case.annotations.find((a) => a.text === 'by time');
    assert.deepEqual(byTime.evidence, [ANCHOR], 'evidence hashes are uppercased and deduplicated');
    const badKind = r.case.annotations.find((a) => a.text === 'bad kind');
    assert.equal(badKind.kind, undefined, 'an unknown kind is dropped, the note kept');
    assert.equal(badKind.status, 'draft', 'imports are drafts whatever they claim');
    assert.equal(badKind.pause, false);
    assert.notEqual(badKind.id, 'a1', 'an existing id is never taken over');
    assert.ok(c.annotations.find((a) => a.id === 'a1').question, 'the question is untouched');
    // a whole case merges its annotations; a string parses; junk is one rejection
    const whole = importAnnotations(c, { format: 'xrpl-sonic/case', annotations: [{ text: 'from a case', anchor: { hash: ANCHOR } }] }, { source: 's', score });
    assert.equal(whole.accepted.length, 1);
    const str = importAnnotations(c, JSON.stringify([{ text: 'from a string', anchor: { ledger: INDEX }, kind: 'question' }]), { source: 's', score });
    assert.equal(str.accepted.length, 1);
    assert.equal(str.case.annotations.at(-1).kind, 'question');
    assert.equal(str.case.annotations.at(-1).question, true, 'kind question and the question flag are kept in step');
    const junk = importAnnotations(c, '{not json', { source: 's', score });
    assert.equal(junk.accepted.length, 0);
    assert.match(junk.rejected[0].reason, /not JSON/);
    assert.equal(junk.case, c);
    const nothing = importAnnotations(c, { annotations: 'x' }, { source: 's', score });
    assert.match(nothing.rejected[0].reason, /no annotations/);
  });

  test('without a score, anchors are kept as given; the case format keeps kind and evidence through validation', () => {
    const { c } = setup();
    const r = importAnnotations(c, [{ text: 'blind', anchor: { hash: 'E'.repeat(64) }, kind: 'hypothesis', evidence: ['E'.repeat(64)] }], { source: 's' });
    assert.equal(r.accepted.length, 1);
    const again = validateCase(JSON.parse(serializeCase(r.case))).case;
    const a = again.annotations.at(-1);
    assert.equal(a.kind, 'hypothesis');
    assert.deepEqual(a.evidence, ['E'.repeat(64)]);
    const plain = validateCase({ clips: ['1'], annotations: [{ text: 'x', anchor: { ledger: 1 }, evidence: ['nope', 'A'.repeat(64)], kind: 'observation' }] }).case;
    assert.deepEqual(plain.annotations[0].evidence, ['A'.repeat(64)]);
    assert.equal(plain.annotations[0].kind, 'observation');
    const old = validateCase({ clips: ['1'], annotations: [{ text: 'x', anchor: { ledger: 1 } }] }).case;
    assert.ok(!('kind' in old.annotations[0]) && !('evidence' in old.annotations[0]), 'ordinary notes carry neither');
  });
});

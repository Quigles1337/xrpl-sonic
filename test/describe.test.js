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

// the trimmed ledger (7 transactions), for budget and moment-kind tests
const expanded = fixture('ledger-expanded').result.ledger;
const nextClose = Number(fixture('ledger-next-header').result.ledger.close_time);
const INDEX = Number(expanded.ledger_index);
const ledgersFor = (indices, { missing = [] } = {}) => new Map(indices.map((i) => [i, missing.includes(i) ? { ledger: null, nextCloseTime: null } : { ledger: { ...expanded, ledger_index: i }, nextCloseTime: nextClose }]));
const ANCHOR = '0176B15458AF71EDF66D5C679FDBDCD360EB1602ECB7925352858D081287FE63';

// the full ledger (60 transactions), for the golden renderings and the content tests
const full = fixture('describe/ledger-107811677').result.ledger;
const fullNext = Number(fixture('describe/ledger-107811678-header').result.ledger.close_time);
const FULL = Number(full.ledger_index);
const fullLedgers = () => new Map([[FULL, { ledger: full, nextCloseTime: fullNext }]]);
const momentCase = () => validateCase(fixture('describe/moment-107811677.sonic-case')).case;
const IOC = 'BDA7EDF8F28F36120B4CD96614C670A077659E4B3B2B4C3E4EB46CBD8AF03DF0';
const iocTx = full.transactions.find((t) => t.hash === IOC);
const RLUSD = iocTx.TakerPays.issuer;
const RLUSD_TEXT = `RLUSD (${iocTx.TakerPays.currency}) issuer ${RLUSD}`; // the decoded name, the exact 160-bit code, the issuer
const CASE_LINK = 'https://quigles1337.github.io/xrpl-sonic/#case=z:example';

function render(level = 'gist', extra = {}) {
  const c = momentCase();
  const ledgers = fullLedgers();
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
    assert.equal(lines[2], 'network: mainnet · host: s1.ripple.com · saved: 2026-10-21T20:00:00.000Z while listening replay');
    assert.ok(text.includes('case: moment-107811677-20261021t200000 · "Moment at ledger #107,811,677"'));
    assert.ok(text.includes(`question: "Why did this immediate-or-cancel order fill so little?" · anchor: tx ${IOC}`));
    assert.ok(text.includes(`scope: clip 1: ledgers ${FULL}–${FULL} · #${FULL} hash ${full.ledger_hash}`));
    assert.ok(text.includes(`coverage (fetched for this text): #${FULL} fetched, 60 transactions`));
    assert.ok(text.includes('loop: 0:01.000–0:05.000 on the case timeline'));
  });

  test('three counts, each labelled with what it measures, and never a performance count', () => {
    const { text } = render('gist');
    assert.ok(text.includes('counts:\n  available in scope (sum of txn_count over the fetched ledgers): 60\n  selected by the listening settings (events in the score): 59\n  excluded by reason: failed 1'));
    assert.ok(!/sounded|played|dropped|rate-limit/i.test(text));
  });

  test('the listening settings in one line, as context', () => {
    const { text } = render('gist');
    assert.ok(text.includes('listening settings (context for the selection, not facts about the ledger): cast: rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah "Maker", rKYdJJLAgxbJcn9Ria2X5jMMiqP91r4qy "Taker"; categories: all on; failed transactions: excluded; quiet threshold: off; scale: pentatonicMajor; key: C; mapping: 1.1.0; cast mode: all; speed: 1x'));
  });

  test('concentration: top submitting accounts with counts and shares, and the cast counts', () => {
    const { text } = render('gist');
    assert.ok(text.includes('concentration (submitting accounts among the 60 available transactions):\n  rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah "Maker": 22 (36.7%)\n  rMTaAGVd77vAbzDv8qhoMgnZR1T5R3w6Wq: 6 (10.0%)'));
    assert.ok(text.includes('  cast: "Maker" rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah submitted 22, involved '));
    assert.ok(text.includes('  cast: "Taker" rKYdJJLAgxbJcn9Ria2X5jMMiqP91r4qy submitted 1, involved 1'));
    assert.equal((text.match(/^ {2}r[1-9A-HJ-NP-Za-km-z]{24,34}( "[^"]+")?: \d+ \(/gm) ?? []).length, 8, 'at most eight accounts');
  });

  test('events: one line each in application order with full hashes and addresses and exact amounts; the anchor and the cast marked', () => {
    const { text } = render('gist');
    assert.ok(text.includes('events (59 of 59 shown; order: as applied in each ledger):'));
    assert.ok(text.includes(`  #${FULL} tx 1 01D1A259E7D9CC65F9D33F1CC09B96A15DED8E69777DF4E6BABC9D3333CF04C6 Payment tesSUCCESS from rEiq1iAcpzP8WLjezP9MzAQEJ7jqKMLFSA to rQQbVSQsvKUgE3omhWokGajp5fa4cbN7C · delivered 39520886 drops`));
    assert.ok(text.includes(`  #${FULL} tx 18 ${IOC} OfferCreate tesSUCCESS from rKYdJJLAgxbJcn9Ria2X5jMMiqP91r4qy "Taker" · gives 7085108443 drops for 9801.315909 ${RLUSD_TEXT} [anchor] [cast: Taker]`));
    const eventLines = text.split('events (')[1].split('\n\n')[0].split('\n').slice(1);
    assert.equal(eventLines.length, 59);
    const order = eventLines.map((l) => Number(l.split(' tx ')[1].split(' ')[0]));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'application order');
    assert.equal(eventLines.filter((l) => l.includes('[cast: Maker]')).length, 22);
    assert.ok(!text.includes('D557751A95EADDAEDB318E5824E9BBB68119BF65C43B0679F23D98A8DA22ABDD'), 'the failed transaction is excluded by the settings and not listed');
    assert.ok(!/…/.test(text.split('how to reply:')[0]), 'nothing is shortened');
  });

  test('findings for the anchor: tier and rule on every line, evidence by node, exact values, unresolved as unresolved', () => {
    const { text, facts } = render('gist');
    const block = text.split(`findings for ${IOC} (OfferCreate, the anchor, cast: Taker):`)[1].split('\nlinks:')[0];
    const lines = block.split('\n').filter((l) => l.startsWith('  ['));
    assert.ok(lines.length >= 20, 'one line per finding');
    for (const l of lines) assert.match(l, /^ {2}\[(observed|calculated|rule|hypothesis)\] [a-z.-]+ [a-z:/A-Z0-9.-]+ = .+( · evidence: .+)?( · note: .+)?$/, l);
    assert.ok(lines.some((l) => l === '  [rule] offer.removal.consumed offer:3.removal = consumed · evidence: node 3 FinalFields.TakerGets, node 3 FinalFields.TakerPays, node 3 PreviousFields.TakerGets, node 3 PreviousFields.TakerPays'), lines.join('\n'));
    assert.ok(lines.some((l) => l === `  [calculated] exchange.fill exchange.fill = status partial, judgedBy takerPays-received, requested 9801.315909 ${RLUSD_TEXT}, achieved 1.10000054 ${RLUSD_TEXT}, shortfall 9800.21590846 ${RLUSD_TEXT}, placed no, betterThanAsked no · evidence: tx.TakerPays, exchange.received`), lines.join('\n'));
    assert.ok(lines.some((l) => l.startsWith('  [rule] exchange.fill.ioc exchange.fill.immediateOrCancel = not placed by design')));
    assert.ok(lines.some((l) => l.includes(`[calculated] offer.trade.delta offer:3.tradedAmounts = gave 1.10000054 ${RLUSD_TEXT}, got 795129 drops`)));
    assert.equal(facts.get(IOC).findings.length, lines.length);
    assert.equal(text.split('findings for ').length - 1, 1, 'gist: the anchor only');
    assert.ok(!text.includes('source fields:'), 'gist has no source fields');
  });

  test('evidence level adds findings for cast-involved events and the selected source fields; no raw AffectedNodes', () => {
    const { text } = render('evidence');
    assert.ok(text.includes(`findings for ${IOC} (OfferCreate, the anchor, cast: Taker):`));
    assert.equal(text.split('findings for ').length - 1, 23, 'the anchor plus the 22 Maker events');
    assert.ok(text.includes(`  source fields: TransactionType OfferCreate · Account rKYdJJLAgxbJcn9Ria2X5jMMiqP91r4qy · Flags 131072 (tfImmediateOrCancel) · TakerGets 7085108443 drops · TakerPays 9801.315909 ${RLUSD_TEXT} · Fee 10 · Sequence 103662514 · TransactionResult tesSUCCESS`));
    assert.ok(!text.includes('AffectedNodes'));
    assert.ok(!text.includes('LedgerEntryType'));
  });

  test('links: the case link and the explorer route per event', () => {
    const { text } = render('gist');
    assert.ok(text.includes(`links:\n  case: ${CASE_LINK}`));
    assert.ok(text.includes(`  explorer: ${SITE_URL}explorer.html#tx/<hash> for any hash in this text`));
    assert.ok(text.includes(`  ${IOC}: ${explorerRoute('mainnet', IOC)}`));
    assert.equal(explorerRoute('testnet', IOC), `${SITE_URL}explorer.html?network=testnet#tx/${IOC}`);
    const without = describe(momentCase(), fullLedgers(), factsForCase(momentCase(), fullLedgers()));
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
    assert.deepEqual(example, [exampleAnnotation(IOC)]);
    assert.deepEqual(Object.keys(example[0]), ['text', 'anchor', 'kind', 'evidence', 'source', 'status']);
    assert.equal(example[0].status, 'draft');
  });
});

suite('describe: budget', () => {
  test('overflow selects under the stated rule and says N of M; nothing is dropped silently', () => {
    const c = validateCase({
      clips: [`${INDEX}-${INDEX + 2}`],
      cast: [{ address: 'rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah', label: 'Sender A' }],
      annotations: [{ anchor: { hash: ANCHOR }, text: 'why', source: 'human', question: true }],
      moment: { version: MOMENT_VERSION, savedAt: '2026-01-01T00:00:00.000Z', mode: 'replay', host: 'h', anchor: { hash: ANCHOR }, loop: null, ledgers: [] },
    }).case;
    const ledgers = ledgersFor([INDEX, INDEX + 1, INDEX + 2]);
    const facts = factsForCase(c, ledgers);
    const full = describeReport(c, ledgers, facts, { level: 'gist' });
    assert.equal(full.shown, 18);
    assert.equal(full.total, 18);
    assert.equal(full.chars, full.text.length);
    assert.equal(full.tokensApprox, Math.ceil(full.chars / 4));
    const budget = full.chars - 700; // room for all but a few event lines
    const small = describeReport(c, ledgers, facts, { level: 'gist', budget });
    assert.ok(small.chars <= budget, `within the budget (${small.chars} of ${budget})`);
    assert.ok(small.shown < small.total && small.shown >= small.total - 5, `${small.shown} of ${small.total}`);
    assert.ok(small.text.includes(`events (${small.shown} of ${small.total} shown; rule: ${SELECTION_RULE}, up to the budget of ${budget} characters):`));
    assert.equal(small.rule, SELECTION_RULE);
    // the anchor event and the cast-involved events come first, then the rest in application order
    const shownLines = small.text.split('events (')[1].split('\n').slice(1).filter((l) => l.startsWith('  #'));
    assert.ok(shownLines[0].includes(ANCHOR), 'the anchor first');
    const castLines = shownLines.filter((l) => l.includes('[cast: Sender A]'));
    assert.equal(castLines.length, 3, 'all three cast-involved events (one per ledger) are kept');
    for (let i = 1; i <= 2; i++) assert.ok(shownLines[i].includes('[cast: Sender A]'), 'cast-involved events follow the anchor');
    const tiny = describeReport(c, ledgers, facts, { level: 'gist', budget: 10 });
    assert.ok(tiny.text.includes('events (1 of 18 shown;'), 'the anchor is always shown');
    assert.ok(!tiny.text.includes('0EC1CCB7553BB931B7C02B484E235692D62DFA2DCB1B44295D15F8090CA90614'), 'other events are not listed (their senders still appear under concentration)');
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
    const base = validateCase({ clips: [`${INDEX}-${INDEX + 1}`], cast: [{ address: 'rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah', label: 'Sender A' }] }).case;
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
    const ledgers = fullLedgers();
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
    assert.deepEqual(a.evidence, [IOC]);
    assert.deepEqual(a.anchor, { hash: IOC });
    assert.equal(r.case.annotations.length, c.annotations.length + 1, 'appended, nothing overwritten');
    assert.deepEqual(r.case.annotations.slice(0, 2), c.annotations, 'existing notes untouched');
    assert.ok(serializeCase(r.case).includes('"kind": "observation"'));
    assert.ok(serializeCase(r.case).includes('"evidence": ['));
  });

  test('an array, a whole case, or a JSON string; anchors resolved against the score; rejections say why', () => {
    const { c, score } = setup();
    const items = [
      { text: 'by ledger', anchor: { ledger: FULL }, kind: 'hypothesis' },
      { text: 'by time', anchor: { timeMs: 500 }, kind: 'observation', evidence: [IOC, IOC.toLowerCase()] },
      { text: 'unknown hash', anchor: { hash: 'F'.repeat(64) } },
      { text: 'wrong ledger', anchor: { ledger: FULL + 40 } },
      { text: 'beyond the end', anchor: { timeMs: 10 ** 9 } },
      { text: '', anchor: { hash: IOC } },
      { anchor: { hash: IOC } },
      { text: 'no anchor' },
      { text: 'bad kind', anchor: { hash: IOC }, kind: 'verdict', status: 'reviewed', id: 'a1', pause: true },
      { text: 'Why did this immediate-or-cancel order fill so little?', anchor: { hash: IOC } },
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
    assert.deepEqual(byTime.evidence, [IOC], 'evidence hashes are uppercased and deduplicated');
    const badKind = r.case.annotations.find((a) => a.text === 'bad kind');
    assert.equal(badKind.kind, undefined, 'an unknown kind is dropped, the note kept');
    assert.equal(badKind.status, 'draft', 'imports are drafts whatever they claim');
    assert.equal(badKind.pause, false);
    assert.notEqual(badKind.id, 'a1', 'an existing id is never taken over');
    assert.ok(c.annotations.find((a) => a.id === 'a1').question, 'the question is untouched');
    // a whole case merges its annotations; a string parses; junk is one rejection
    const whole = importAnnotations(c, { format: 'xrpl-sonic/case', annotations: [{ text: 'from a case', anchor: { hash: IOC } }] }, { source: 's', score });
    assert.equal(whole.accepted.length, 1);
    const str = importAnnotations(c, JSON.stringify([{ text: 'from a string', anchor: { ledger: FULL }, kind: 'question' }]), { source: 's', score });
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

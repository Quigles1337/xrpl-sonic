// The edges of the constellation: trust lines as edges (direction from the
// limits, side from the balance sign, width from the balance) and transactions
// as strands (direction from sender and destination, colour from the category,
// width from the amount, dashed when failed, dotted when partial), with one
// palette of currency hues shared by both. Proven over recorded responses of
// real accounts and transactions (test/fixtures/explorer).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  trustEdges,
  transactionStrands,
  starsOf,
  constellationModel,
  orbitsOf,
  orbitRadius,
  partiesOf,
  issuedBy,
  assignHues,
  baseHue,
  hueGap,
  hueCss,
  rgbOfHue,
  currencyRgb,
  widthOf,
  currencyName,
  positionOf,
  describeEdge,
  describeStrand,
  partyColour,
  dominantCategory,
  MIN_HUE_GAP,
  MAX_EDGES,
  MAX_STRANDS,
  DIRECTIONS,
  SIDES,
  RELATIONS,
  XRP_RGB,
} from '../src/explorer/edges.js';
import { counterparties } from '../src/explorer/anatomy.js';
import { shortAddress } from '../src/mapping.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'explorer');
const load = (name) => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')).result;
const snapshotLines = load(join('snapshot', 'account_lines'));
const snapshotTx = load(join('snapshot', 'account_tx-page1'));
const LINES = snapshotLines.lines;
const ACCOUNT = snapshotLines.account;
const ENTRIES = snapshotTx.transactions;
const paymentXrp = load('payment-xrp');
const failed = load('failed');
const killed = JSON.parse(readFileSync(join(dir, '..', 'facts', 'killed.json'), 'utf8')).result;
const asEntry = (r) => ({ tx: { ...(r.tx_json ?? r), hash: r.hash, ledger_index: r.ledger_index, date: r.date ?? r.tx_json?.date }, meta: r.meta, validated: true });

describe('trust lines as edges', () => {
  test('the recorded lines: largest balance first, every line this account trusts outward, the empty line last and unwidthed', () => {
    const { edges, total, currencies, names } = trustEdges(LINES);
    assert.equal(total, 13, 'a line with no balance but a limit still counts');
    assert.equal(edges.length, 13);
    assert.equal(edges[0].address, 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq');
    assert.equal(edges[0].name, 'USD');
    assert.equal(edges[0].kind, 'trust');
    assert.equal(edges[0].balance, 599665.5303727388);
    assert.equal(edges[0].width, 1, 'the largest balance sets the scale');
    for (let i = 1; i < edges.length; i++) {
      assert.ok(Math.abs(edges[i].balance) <= Math.abs(edges[i - 1].balance), `sorted by balance at ${i}`);
      assert.ok(edges[i].width <= edges[i - 1].width, `width follows at ${i}`);
    }
    for (const e of edges) {
      assert.equal(e.direction, 'out', `${e.name} ${e.address}: limit set by this account, none by the peer`);
      assert.ok(DIRECTIONS.includes(e.direction) && SIDES.includes(e.side));
      assert.equal(e.limit, 1e9);
      assert.equal(e.limitPeer, 0);
    }
    const empty = edges.at(-1);
    assert.equal(empty.balance, 0);
    assert.equal(empty.side, 'empty');
    assert.equal(empty.width, 0);
    assert.equal(empty.address, 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE');
    assert.ok(edges.slice(0, -1).every((e) => e.side === 'holds' && e.width > 0));
    assert.deepEqual(names, ['USD', 'RLUSD', 'EUR', 'USDT', 'EUROP', 'USDC', 'ETH', 'BTC'], 'currencies in order of their largest line; hex codes decoded');
    assert.deepEqual(
      currencies.map((c) => c.name),
      names,
    );
    assert.deepEqual(currencies.find((c) => c.name === 'USD'), { name: 'USD', hue: currencies[0].hue, lines: 3, drawn: 3 });
    assert.deepEqual(currencies.find((c) => c.name === 'USDC'), { name: 'USDC', hue: currencies[5].hue, lines: 2, drawn: 2 });
    const hues = currencies.map((c) => c.hue);
    for (let i = 0; i < hues.length; i++) for (let j = i + 1; j < hues.length; j++) assert.ok(hueGap(hues[i], hues[j]) >= MIN_HUE_GAP, `${currencies[i].name} and ${currencies[j].name} look alike`);
    for (const e of edges) assert.equal(e.hue, currencies.find((c) => c.name === e.name).hue, 'every edge carries its currency hue');
  });

  test('the other side of a line: a holder of this account’s issue trusts inward; both limits read as both ways; a bare balance has no direction', () => {
    const peer = 'rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y';
    const { edges } = trustEdges([
      { account: peer, currency: 'USD', balance: '-12.5', limit: '0', limit_peer: '1000' },
      { account: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B', currency: 'USD', balance: '3', limit: '50', limit_peer: '20' },
      { account: 'rcA8X3TVMST1n3CJeAdGk1RdRCHii7N2h', currency: 'EUR', balance: '0.5', limit: '0', limit_peer: '0' },
      { account: 'rchGBxcD1A1C2tdxF6papQYZ8kjRKMYcL', currency: 'EUR', balance: '0', limit: '0', limit_peer: '0' },
    ]);
    assert.equal(edges.length, 3, 'a line with no balance and no limit either way is not drawn');
    const issued = edges.find((e) => e.address === peer);
    assert.equal(issued.direction, 'in');
    assert.equal(issued.side, 'issued');
    assert.equal(issued.width, 1);
    assert.equal(describeEdge(issued), 'USD: issued 12.5 to it · it trusts this account (limit 1,000)');
    const both = edges.find((e) => e.limit === 50);
    assert.equal(both.direction, 'both');
    assert.equal(both.side, 'holds');
    assert.equal(describeEdge(both), 'USD: holds 3 of its issue · trust both ways (limits 50 / 20)');
    const bare = edges.find((e) => e.name === 'EUR');
    assert.equal(bare.direction, 'none');
    assert.equal(describeEdge(bare), 'EUR: holds 0.5 of its issue · no limit either way');
    assert.equal(describeEdge(trustEdges(LINES).edges[0]), 'USD: holds 599,665.53 of its issue · this account trusts it (limit 1,000,000,000)');
    assert.equal(describeEdge(trustEdges(LINES).edges.at(-1)), 'USDC: no balance · this account trusts it (limit 1,000,000,000)');
  });

  test('only `max` edges are drawn, but every currency keeps the hue it would have had; a shared palette wins', () => {
    const full = trustEdges(LINES);
    const cut = trustEdges(LINES, { max: 3 });
    assert.equal(cut.edges.length, 3);
    assert.equal(cut.total, 13);
    assert.deepEqual(cut.currencies.map((c) => [c.name, c.hue]), full.currencies.map((c) => [c.name, c.hue]));
    assert.deepEqual(cut.currencies.map((c) => c.drawn), [1, 1, 1, 0, 0, 0, 0, 0]);
    assert.equal(cut.edges[0].width, 1);
    assert.equal(MAX_EDGES, 24);
    const shared = trustEdges(LINES, { hues: new Map([['USD', 7]]) });
    assert.equal(shared.edges[0].hue, 7);
    assert.equal(shared.currencies[1].hue, baseHue('RLUSD'), 'a name missing from the shared palette falls back to its own hue');
    assert.deepEqual(trustEdges(null), { edges: [], total: 0, names: [], currencies: [] });
    assert.deepEqual(trustEdges([{ currency: 'USD' }, null, { account: 'rX', currency: 'USD', balance: '0', limit: '0', limit_peer: '0' }]).edges, []);
  });
});

describe('transactions as strands', () => {
  test('the recorded page: one strand per offer to the issuer it names, in the offer colour, as wide as its XRP side', () => {
    const { strands, total, names, categories } = transactionStrands(ENTRIES, ACCOUNT);
    assert.equal(total, 20);
    assert.equal(strands.length, 20);
    const first = strands[0];
    assert.equal(first.kind, 'tx');
    assert.equal(first.hash, '1ACA137F5BE2B3D73EB7DED2935056344EA87163FF05F2A22F8B97AD2E353BF1');
    assert.equal(first.type, 'OfferCreate');
    assert.equal(first.category, 'offer');
    assert.deepEqual(first.rgb, [249, 199, 79]);
    assert.equal(first.address, 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B');
    assert.equal(first.relation, 'issuer');
    assert.equal(first.direction, 'none');
    assert.equal(first.issues, 'ETH');
    assert.equal(first.currency, 'XRP', 'an offer is measured by its XRP side');
    assert.equal(first.value, 12846);
    assert.equal(first.hue, null, 'XRP has no hue of its own');
    assert.equal(first.success, true);
    assert.equal(first.partial, false);
    assert.equal(first.ledgerIndex, 107811689);
    assert.equal(describeStrand(first), 'OfferCreate · gives 12,846 XRP for 8.55 ETH · it issues ETH');
    assert.ok(strands.every((s) => RELATIONS.includes(s.relation) && DIRECTIONS.includes(s.direction)));
    assert.ok(strands.every((s) => s.address !== ACCOUNT));
    const top = Math.max(...strands.map((s) => s.value));
    assert.equal(strands.find((s) => s.value === top).width, 1);
    assert.ok(strands.every((s) => s.width > 0 && s.width <= 1));
    assert.deepEqual(names, [], 'every offer here is measured in XRP');
    assert.deepEqual(categories, [{ name: 'offer', label: 'DEX offer', rgb: [249, 199, 79], count: 20, drawn: 20 }]);
    assert.equal(transactionStrands(ENTRIES, ACCOUNT, { max: 5 }).strands.length, 5);
    assert.equal(transactionStrands(ENTRIES, ACCOUNT, { max: 5 }).total, 20);
    assert.equal(MAX_STRANDS, 120);
  });

  test('a payment: outward from the sender, inward at the recipient, with the delivered amount', () => {
    const entry = asEntry(paymentXrp);
    const out = transactionStrands([entry], paymentXrp.Account).strands;
    assert.equal(out.length, 1);
    assert.equal(out[0].address, paymentXrp.Destination);
    assert.equal(out[0].relation, 'recipient');
    assert.equal(out[0].direction, 'out');
    assert.equal(out[0].category, 'payment');
    assert.deepEqual(out[0].rgb, [76, 201, 240]);
    assert.equal(out[0].currency, 'XRP');
    assert.equal(out[0].value, 1.7);
    assert.equal(out[0].width, 1);
    assert.equal(out[0].issues, null);
    assert.equal(describeStrand(out[0]), 'Payment · sent 1.7 XRP to it');
    const inward = transactionStrands([entry], paymentXrp.Destination).strands;
    assert.equal(inward[0].address, paymentXrp.Account);
    assert.equal(inward[0].relation, 'sender');
    assert.equal(inward[0].direction, 'in');
    assert.equal(describeStrand(inward[0]), 'Payment · received 1.7 XRP from it');
    assert.equal(out[0].by, 'this');
    assert.equal(inward[0].by, 'party');
    const bystander = transactionStrands([entry], 'rSomeoneElse').strands;
    assert.deepEqual(bystander.map((s) => [s.address, s.relation, s.direction, s.by]), [[paymentXrp.Account, 'party', 'none', 'party'], [paymentXrp.Destination, 'party', 'none', 'other']], 'a bystander sees both as parties');
    assert.equal(describeStrand(bystander[0]), `Payment · it sent 1.7 XRP to ${shortAddress(paymentXrp.Destination)}`);
    assert.equal(describeStrand(bystander[1]), `Payment · ${shortAddress(paymentXrp.Account)} sent 1.7 XRP to it`);
  });

  test('an offer seen by the issuer of its currency is "its offer"; a cancel and a trust set name whose they are', () => {
    const issuer = ENTRIES[0].tx.TakerPays.issuer;
    const seen = transactionStrands([ENTRIES[0]], issuer).strands;
    assert.equal(seen.length, 1);
    assert.equal(seen[0].address, ACCOUNT);
    assert.equal(seen[0].by, 'party');
    assert.equal(seen[0].issues, null, 'the issuer is this account');
    assert.equal(describeStrand(seen[0]), 'OfferCreate · its offer: gives 12,846 XRP for 8.55 ETH');
    const cancel = { tx: { TransactionType: 'OfferCancel', Account: ACCOUNT, OfferSequence: 5, hash: 'A'.repeat(64), ledger_index: 1 }, meta: { TransactionResult: 'tesSUCCESS' } };
    assert.deepEqual(transactionStrands([cancel], ACCOUNT).strands, [], 'a cancel names no counterparty');
    assert.equal(describeStrand(transactionStrands([cancel], 'rBystander').strands[0]), 'OfferCancel · its offer cancelled');
    const trust = { tx: { TransactionType: 'TrustSet', Account: ACCOUNT, LimitAmount: { currency: 'USD', issuer: issuer, value: '1000' }, hash: 'B'.repeat(64), ledger_index: 1 }, meta: { TransactionResult: 'tesSUCCESS' } };
    assert.equal(describeStrand(transactionStrands([trust], ACCOUNT).strands[0]), 'TrustSet · limit 1,000 USD · it issues USD');
    assert.equal(describeStrand(transactionStrands([trust], issuer).strands[0]), 'TrustSet · its trust line, limit 1,000 USD');
  });

  test('a killed offer is dashed as failed and still names its issuer; a failed partial payment seen by its issuer says both', () => {
    const k = transactionStrands([asEntry(killed)], killed.Account).strands;
    assert.equal(k.length, 1);
    assert.equal(k[0].address, 'rGG3wQ4kUzd7Jnmk1n5NWPZjjut62kCBfC');
    assert.equal(k[0].success, false);
    assert.equal(k[0].result, 'tecKILLED');
    assert.equal(k[0].issues, 'ARMY');
    assert.equal(describeStrand(k[0]), 'OfferCreate · failed (tecKILLED) · gives 50 XRP for 8,136 ARMY · it issues ARMY');
    const issuer = failed.SendMax.issuer;
    const f = transactionStrands([asEntry(failed)], issuer).strands;
    assert.equal(f.length, 1, 'a self-payment names its sender once');
    assert.equal(f[0].address, failed.Account);
    assert.equal(f[0].relation, 'party');
    assert.equal(f[0].direction, 'none');
    assert.equal(f[0].partial, true);
    assert.equal(f[0].success, false);
    assert.equal(f[0].issues, null, 'the issuer of SendMax is this account, so the party issues nothing here');
    assert.equal(f[0].by, 'party');
    assert.equal(describeStrand(f[0]), 'Payment · failed (tecPATH_DRY) · partial payment · it paid itself 100,000,000 XRP');
    assert.deepEqual(partiesOf(failed, failed.Account), [{ address: issuer, relation: 'issuer' }]);
    assert.equal(issuedBy(failed, issuer), 'RLUSD');
    assert.equal(issuedBy(failed, 'rNobody'), null);
    assert.deepEqual(transactionStrands([{ meta: {} }, null, { tx: null }], 'rX').strands, []);
  });
});

describe('colour, width and names', () => {
  test('widths are a log scale between 0.15 and 1 against the largest, 0 for none', () => {
    assert.equal(widthOf(0, 10), 0);
    assert.equal(widthOf(5, 0), 0);
    assert.equal(widthOf(10, 10), 1);
    const w = widthOf(1, 1000);
    assert.ok(w > 0.15 && w < 0.3, `a thousandth of the largest is thin but visible: ${w}`);
    assert.ok(widthOf(100, 1000) > widthOf(10, 1000));
    assert.equal(widthOf(2000, 1000), 1, 'clamped');
  });

  test('hues: stable per name, distinct on one page, the most prominent keeps its own, XRP keeps its blue', () => {
    assert.equal(baseHue('USD'), baseHue('USD'));
    assert.deepEqual([...assignHues(['USD']).values()], [baseHue('USD')], 'alone, a currency has its own hue');
    const names = ['USD', 'EUR', 'BTC', 'ETH', 'USDC', 'USDT', 'RLUSD', 'EUROP', 'GBP', 'JPY', 'CNY', 'XAU'];
    const apart = (hues, least) => {
      const list = [...hues.values()];
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) assert.ok(hueGap(list[i], list[j]) >= least, `${[...hues.keys()][i]} vs ${[...hues.keys()][j]}: ${list[i]} / ${list[j]}`);
    };
    const six = assignHues(names.slice(0, 6));
    assert.equal(six.size, 6);
    apart(six, MIN_HUE_GAP);
    const hues = assignHues(names);
    assert.equal(hues.size, 12);
    assert.equal(hues.get('USD'), baseHue('USD'), 'the first keeps its own hue');
    apart(hues, 15);
    for (const name of names.slice(0, 6)) assert.equal(hues.get(name), six.get(name), 'adding currencies never moves the ones already placed');
    assert.deepEqual([...assignHues(names)], [...hues], 'deterministic');
    assert.deepEqual([...assignHues(['USD', 'XRP', 'USD', 'EUR', '']).keys()], ['USD', 'EUR'], 'repeats are one entry; XRP and blanks are skipped');
    assert.equal(hueGap(350, 10), 20);
    assert.equal(hueGap(0, 180), 180);
    assert.equal(hueCss(210), 'hsl(210 70% 68%)');
    assert.equal(hueCss(210, 0.5), 'hsl(210 70% 68% / 0.500)');
    assert.deepEqual(rgbOfHue(0), [231, 116, 116]);
    assert.deepEqual(rgbOfHue(120), [116, 231, 116]);
    assert.deepEqual(rgbOfHue(240), [116, 116, 231]);
    assert.deepEqual(currencyRgb('XRP', hues), [...XRP_RGB]);
    assert.deepEqual(currencyRgb('USD', hues), rgbOfHue(hues.get('USD')));
    assert.deepEqual(currencyRgb('ZZZ', hues), rgbOfHue(baseHue('ZZZ')));
    assert.deepEqual(partyColour({ categories: { payment: 2, offer: 5 } }), [249, 199, 79]);
    assert.equal(dominantCategory({}), 'other');
    assert.deepEqual(partyColour({}), [141, 153, 174]);
  });

  test('currency names decode hex codes and cut long ones', () => {
    assert.equal(currencyName('USD'), 'USD');
    assert.equal(currencyName('5553444300000000000000000000000000000000'), 'USDC');
    assert.equal(currencyName('524C555344000000000000000000000000000000'), 'RLUSD');
    assert.equal(currencyName('0158415500000000C180694B6D71E4E2E5A8F1C3'), '01584155', 'a non-standard code stays hex, cut to 8');
  });
});

describe('stars and the model', () => {
  test('stars: transaction counterparties keep their place and colour; trust-line peers join them or stand alone in their currency’s colour; strands attach', () => {
    const { edges } = trustEdges(LINES);
    const shared = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq'; // USD and EUR lines
    const parties = [
      { address: shared, count: 9, categories: { payment: 9 }, roles: { recipient: 9 } },
      { address: 'rDarkLabsDarkLabsDarkLabsDarkLab1', count: 2, categories: { offer: 2 }, roles: { issuer: 2 } },
    ];
    const strands = [
      { kind: 'tx', address: shared, width: 1 },
      { kind: 'tx', address: 'rNotAStar', width: 1 },
    ];
    const stars = starsOf(parties, edges, strands);
    const peers = new Set(edges.map((e) => e.address));
    assert.equal(stars.length, 1 + peers.size, 'one star per address, shared or not');
    const both = stars.find((s) => s.address === shared);
    assert.equal(both.party.count, 9);
    assert.deepEqual(both.rgb, [76, 201, 240], 'a transaction counterparty keeps the colour of what they did together');
    assert.deepEqual(both.trust.map((e) => e.name), ['USD', 'EUR']);
    assert.deepEqual(both.strands, [strands[0]], 'a strand attaches to the star of its counterparty');
    assert.deepEqual(both.pos, positionOf(shared, 0), 'nearest: the most frequent');
    assert.equal(both.labelled, true);
    assert.ok(stars.every((s) => !s.strands.includes(strands[1])), 'a strand with no star is not attached');
    const only = stars.find((s) => s.address === 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B');
    assert.equal(only.party, null);
    assert.deepEqual(only.trust.map((e) => e.name), ['USD', 'BTC', 'ETH'], 'every line to that peer, widest first');
    assert.deepEqual(only.rgb, rgbOfHue(only.trust[0].hue), 'a trust-only star takes the hue of its widest line');
    assert.equal(only.label, shortAddress(only.address));
    assert.equal(only.weight, 0, 'no transactions together, so no count line');
    assert.ok(only.size > 2.6 && only.size <= 6);
    const lonely = stars.find((s) => s.address === 'rDarkLabsDarkLabsDarkLabsDarkLab1');
    assert.deepEqual(lonely.trust, []);
    assert.deepEqual(lonely.rgb, [249, 199, 79]);
    assert.deepEqual(starsOf(parties, edges, strands, { colourOf: () => [0, 0, 0] }).map((s) => s.pos), stars.map((s) => s.pos), 'positions are deterministic');
    assert.equal(starsOf(Array.from({ length: 60 }, (_, i) => ({ address: `r${String(i).padStart(33, '0')}`, count: 1, categories: {} })), [], [], { maxParties: 48 }).length, 48);
    assert.deepEqual(starsOf(null, null), []);
    const ranks = stars.filter((s) => !s.party).map((s) => s.rank);
    assert.ok(ranks.every((r, i) => i === 0 || r >= ranks[i - 1]), 'trust-only stars are ranked by their largest balance');
  });

  test('the model over the recorded account: one palette for both kinds, every strand attached, the counts for the caption', () => {
    const parties = counterparties(ENTRIES, ACCOUNT);
    const model = constellationModel({ account: ACCOUNT, parties, entries: ENTRIES, lines: LINES });
    assert.equal(model.edges.length, 13);
    assert.equal(model.strands.length, 20);
    assert.deepEqual(model.counts, { stars: model.stars.length, trust: { drawn: 13, total: 13 }, strands: { drawn: 20, total: 20, attached: 20 } });
    assert.ok(model.stars.length >= parties.length);
    assert.equal(model.stars.reduce((n, s) => n + s.strands.length, 0), 20, 'every strand found its star: the same rules name the counterparties');
    assert.equal(model.hues.get('USD'), trustEdges(LINES).currencies[0].hue, 'trust lines name the palette first');
    assert.deepEqual(model.currencies[0], { name: 'XRP', hue: null, rgb: [...XRP_RGB] }, 'XRP leads the legend when the transactions moved it');
    assert.deepEqual(model.currencies.slice(1).map((c) => c.name), trustEdges(LINES).names);
    assert.deepEqual(model.categories.map((c) => c.name), ['offer']);
    for (const e of model.edges) assert.equal(e.hue, model.hues.get(e.name));
    const same = constellationModel({ account: ACCOUNT, parties, entries: ENTRIES, lines: LINES });
    assert.deepEqual(same.stars.map((s) => [s.address, s.pos, s.rgb]), model.stars.map((s) => [s.address, s.pos, s.rgb]), 'deterministic');
    const bare = constellationModel({ account: ACCOUNT });
    assert.deepEqual(bare.counts, { stars: 0, trust: { drawn: 0, total: 0 }, strands: { drawn: 0, total: 0, attached: 0 } });
    assert.deepEqual(bare.currencies, []);
  });

  test('orbits: one per held balance, the twelve largest, in the shared hue', () => {
    const hues = assignHues(trustEdges(LINES).names);
    const orbits = orbitsOf(LINES, hues);
    assert.equal(orbits.length, 12, 'thirteen lines, one with no balance');
    assert.equal(orbits[0].name, 'USD');
    assert.equal(orbits[0].address, 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq');
    assert.equal(orbits[0].hue, hues.get('USD'));
    for (let i = 1; i < orbits.length; i++) assert.ok(Math.abs(orbits[i].balance) <= Math.abs(orbits[i - 1].balance));
    assert.ok(orbits.every((o) => o.r > 0 && o.tilt >= 0.25 && o.speed >= 0.08));
    assert.ok(orbitRadius(1e8) > orbitRadius(1) && orbitRadius(1) > orbitRadius(0));
    assert.equal(orbitRadius(-5), orbitRadius(0));
    assert.deepEqual(orbitsOf(null), []);
  });
});

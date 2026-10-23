import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { classify, parseRoute, formatRoute, routeFor, routeTitle } from '../src/explorer/route.js';
import { sigilPattern, sigilSvg, sigilColour, sigilHue, SIGIL_CELLS } from '../src/explorer/sigil.js';

const ADDR = 'rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah';
const HASH = 'B247B77B8F7D6C2D9D4D3A2A1F0E9D8C7B6A5F4E3D2C1B0A9F8E7D6C5B4A3F2E';

describe('classify', () => {
  test('recognises the things people paste', () => {
    assert.equal(classify('').kind, 'empty');
    assert.equal(classify('   ').kind, 'empty');
    assert.deepEqual(classify(ADDR), { kind: 'account', value: ADDR, hint: 'An account (classic r-address).' });
    assert.equal(classify(` ${ADDR} `).value, ADDR);
    assert.equal(classify(HASH.toLowerCase()).kind, 'tx');
    assert.equal(classify(HASH.toLowerCase()).value, HASH);
    assert.deepEqual(classify('107,777,809'), { kind: 'ledger', value: 107777809, hint: 'Ledger #107,777,809.' });
    assert.equal(classify('#12').value, 12);
    assert.equal(classify('latest').kind, 'latest');
    assert.equal(classify('Now').kind, 'latest');
    assert.equal(classify('USD').kind, 'currency');
    assert.equal(classify('usd').value, 'USD');
    assert.equal(classify('524C555344000000000000000000000000000000').kind, 'currency');
  });

  test('destination tags and issuer pairs resolve to accounts', () => {
    const tagged = classify(`${ADDR}:12345`);
    assert.equal(tagged.kind, 'account');
    assert.equal(tagged.value, ADDR);
    assert.equal(tagged.tag, 12345);
    const pair = classify(`usd.${ADDR}`);
    assert.equal(pair.kind, 'account');
    assert.equal(pair.currency, 'USD');
  });

  test('partial input gets a helpful hint; X-addresses are explained; junk is unknown', () => {
    assert.match(classify('rBTwLga3').hint, /start of an address \(8 of 25/);
    assert.match(classify('B247B77B8F7D6C2D').hint, /start of a transaction hash \(16 of 64/);
    assert.equal(classify('X7AcgcsBL6XDcUb289X4BJ8ZsZd7gXrDpYmsEHWNZ4EdLRs').kind, 'xaddress');
    assert.equal(classify('hello world').kind, 'unknown');
    assert.equal(classify('rNotAnAddress0OIl').kind, 'unknown');
  });
});

describe('routes', () => {
  test('parse and format round-trip', () => {
    const routes = [
      { name: 'home' },
      { name: 'account', address: ADDR, tag: null },
      { name: 'account', address: ADDR, tag: 7 },
      { name: 'tx', hash: HASH },
      { name: 'ledger', index: 107777809 },
      { name: 'ledger', index: 'latest' },
      { name: 'search', query: 'usd rates' },
      { name: 'help' },
    ];
    for (const r of routes) {
      const back = parseRoute(formatRoute(r));
      assert.deepEqual(back, r, formatRoute(r));
    }
    assert.equal(formatRoute({ name: 'home' }), '#');
    assert.equal(formatRoute({ name: 'search', query: 'a b' }), '#search/a%20b');
  });

  test('malformed fragments go home with a reason', () => {
    assert.equal(parseRoute('').name, 'home');
    assert.equal(parseRoute('#').name, 'home');
    assert.match(parseRoute('#account/rNope').error, /Not an account/);
    assert.match(parseRoute('#tx/abc').error, /Not a transaction hash/);
    assert.match(parseRoute('#ledger/x').error, /Not a ledger index/);
    assert.match(parseRoute('#wat/1').error, /Unknown route/);
    assert.deepEqual(parseRoute('#ledger/'), { name: 'ledger', index: 'latest' });
    assert.deepEqual(parseRoute('#ledger/107,777,809'), { name: 'ledger', index: 107777809 });
  });

  test('routeFor follows accounts, hashes, ledgers and latest; routeTitle names them', () => {
    assert.deepEqual(routeFor(classify(ADDR)), { name: 'account', address: ADDR, tag: null });
    assert.deepEqual(routeFor(classify(HASH)), { name: 'tx', hash: HASH });
    assert.deepEqual(routeFor(classify('5')), { name: 'ledger', index: 5 });
    assert.deepEqual(routeFor(classify('latest')), { name: 'ledger', index: 'latest' });
    assert.equal(routeFor(classify('USD')), null);
    assert.equal(routeFor(classify('')), null);
    assert.equal(routeTitle({ name: 'account', address: ADDR }), 'rBTwLg…jjah');
    assert.equal(routeTitle({ name: 'tx', hash: HASH }), 'tx B247B77B…');
    assert.equal(routeTitle({ name: 'ledger', index: 107777809 }), 'ledger #107,777,809');
    assert.equal(routeTitle({ name: 'ledger', index: 'latest' }), 'latest ledger');
    assert.equal(routeTitle(null), 'home');
  });
});

describe('sigils', () => {
  test('sigilHue is the sigil’s own hue, pinned equal to sigilPattern’s for every address (universe-requests.md R8)', () => {
    const addresses = [ADDR, 'rKNRrawfVS59C3tN1bBiUWc5wZQAfUPh7z', '', 'rrrrrrrrrrrrrrrrrrrrrhoLvTp', ...Array.from({ length: 500 }, (_, i) => `r${i.toString(36).padStart(8, 'x')}`)];
    for (const a of addresses) {
      const hue = sigilHue(a);
      assert.equal(hue, sigilPattern(a).hue, a);
      assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360);
      assert.ok(sigilColour(a).startsWith(`hsl(${hue} `), 'the colour is drawn from the same hue');
    }
    assert.equal(sigilHue(undefined), sigilPattern(undefined).hue);
  });

  test('deterministic, symmetric, never blank, distinct across addresses', () => {
    const a = sigilPattern(ADDR);
    assert.deepEqual(a, sigilPattern(ADDR));
    assert.equal(a.cells.length, SIGIL_CELLS * SIGIL_CELLS);
    for (let row = 0; row < SIGIL_CELLS; row++) {
      for (let col = 0; col < 2; col++) assert.equal(a.cells[row * 5 + col], a.cells[row * 5 + (4 - col)], 'mirror');
    }
    assert.ok(a.cells.filter(Boolean).length >= 5);
    assert.ok(a.hue >= 0 && a.hue < 360);
    const b = sigilPattern('rKNRrawfVS59C3tN1bBiUWc5wZQAfUPh7z');
    assert.notDeepEqual(a.cells, b.cells);
    assert.ok(sigilPattern('').cells.filter(Boolean).length >= 5, 'empty input still draws');
  });

  test('svg markup is literal and sized', () => {
    const svg = sigilSvg(ADDR, 24);
    assert.match(svg, /^<svg class="sigil" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false">/);
    assert.ok(svg.includes('<rect width="24" height="24" rx="4"'));
    assert.ok((svg.match(/<rect x=/g) ?? []).length >= 5);
    assert.ok(!svg.includes('<script'));
    assert.match(sigilSvg(ADDR, 'x'), /width="20"/);
    assert.match(sigilColour(ADDR), /^hsl\(\d+ 70% 68%\)$/);
  });
});

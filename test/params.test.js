import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseHash, buildHash, parseQuery } from '../src/params.js';

const ADDR = 'rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah';

describe('hash parsing', () => {
  const EMPTY = { account: null, replay: null, cast: null, case: null, errors: [] };

  test('empty or missing hash yields nothing', () => {
    assert.deepEqual(parseHash(''), EMPTY);
    assert.deepEqual(parseHash('#'), EMPTY);
    assert.deepEqual(parseHash(undefined), EMPTY);
  });

  test('#cast= and #case= are passed through verbatim for their modules to interpret', () => {
    assert.equal(parseHash(`#cast=${ADDR}~Alice~glass`).cast, `${ADDR}~Alice~glass`);
    assert.equal(parseHash('#case=z:abc_-').case, 'z:abc_-');
    assert.equal(parseHash(buildHash({ cast: 'r1~x', case: 'j:eyJ' })).case, 'j:eyJ');
    assert.equal(parseHash('#cast=&case=%20').cast, null);
    assert.equal(parseHash('#cast=&case=%20').case, null);
    assert.equal(buildHash({ account: ADDR, replay: '5', cast: 'r1~x', case: 'j:eyJ' }), `#account=${ADDR}&replay=5&cast=r1~x&case=j:eyJ`);
    assert.equal(buildHash({}), '');
  });

  test('#account= accepts a valid r-address, with or without the leading #', () => {
    assert.equal(parseHash(`#account=${ADDR}`).account, ADDR);
    assert.equal(parseHash(`account=${ADDR}`).account, ADDR);
    assert.equal(parseHash(`#account=%20${ADDR}%20`).account, ADDR);
  });

  test('a malformed account is reported, not applied', () => {
    const r = parseHash('#account=rNotAnAddress0OIl');
    assert.equal(r.account, null);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /invalid account/i);
    assert.equal(parseHash('#account=').account, null);
    assert.equal(parseHash('#account=').errors.length, 0);
  });

  test('#replay= is passed through verbatim for the replay module to interpret', () => {
    assert.equal(parseHash('#replay=107777809').replay, '107777809');
    assert.equal(parseHash('#replay=107777809-107777812').replay, '107777809-107777812');
    assert.equal(parseHash(`#replay=1-2&account=${ADDR}`).account, ADDR);
    assert.equal(parseHash('#other=1').replay, null);
  });

  test('parseQuery reads the network, autostart and the page mode', () => {
    assert.deepEqual(parseQuery(''), { network: null, autostart: false, mode: 'full' });
    assert.deepEqual(parseQuery(undefined), { network: null, autostart: false, mode: 'full' });
    assert.deepEqual(parseQuery('?network=testnet'), { network: 'testnet', autostart: false, mode: 'full' });
    assert.equal(parseQuery('?network=devnet').network, null);
    assert.equal(parseQuery('?autostart=1').autostart, true);
    assert.equal(parseQuery('?autostart=0').autostart, false);
    assert.equal(parseQuery('?autostart=false').autostart, false);
    assert.equal(parseQuery('?overlay=1').mode, 'overlay');
    assert.equal(parseQuery('overlay=true').mode, 'overlay');
    assert.equal(parseQuery('?embed=1').mode, 'embed');
    assert.equal(parseQuery('?embed=1&overlay=1').mode, 'overlay', 'overlay wins');
    assert.equal(parseQuery('?embed=0').mode, 'full');
    assert.deepEqual(parseQuery('?embed=1&network=testnet&autostart=1'), { network: 'testnet', autostart: true, mode: 'embed' });
  });

  test('buildHash round-trips through parseHash and omits empty values', () => {
    assert.equal(buildHash({}), '');
    assert.equal(buildHash({ account: '', replay: null }), '');
    assert.equal(buildHash({ account: ADDR }), `#account=${ADDR}`);
    assert.equal(buildHash({ replay: '5-9' }), '#replay=5-9');
    const h = buildHash({ account: ADDR, replay: '10-12' });
    const parsed = parseHash(h);
    assert.equal(parsed.account, ADDR);
    assert.equal(parsed.replay, '10-12');
  });
});

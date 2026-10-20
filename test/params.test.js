import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseHash, buildHash } from '../src/params.js';

const ADDR = 'rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah';

describe('hash parsing', () => {
  test('empty or missing hash yields nothing', () => {
    assert.deepEqual(parseHash(''), { account: null, replay: null, errors: [] });
    assert.deepEqual(parseHash('#'), { account: null, replay: null, errors: [] });
    assert.deepEqual(parseHash(undefined), { account: null, replay: null, errors: [] });
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

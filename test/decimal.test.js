import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normalize, add, sub, neg, cmp, isZero, isNegative, nearlyEqual, mulInt, divRatio } from '../src/decimal.js';

describe('decimal strings', () => {
  test('normalises the forms rippled writes: plain, scientific, signed, trailing zeros', () => {
    assert.equal(normalize('33490.0352556885'), '33490.0352556885');
    assert.equal(normalize('1000000000000000e3'), '1000000000000000000');
    assert.equal(normalize('9999999999999990e-1'), '999999999999999');
    assert.equal(normalize('1e-10'), '0.0000000001');
    assert.equal(normalize('1.5E+3'), '1500');
    assert.equal(normalize('-150'), '-150');
    assert.equal(normalize('2.0700'), '2.07');
    assert.equal(normalize('0'), '0');
    assert.equal(normalize('-0'), '0');
    assert.equal(normalize('0.00000005909'), '0.00000005909');
    assert.equal(normalize('+7'), '7');
    assert.equal(normalize(12), '12');
    assert.throws(() => normalize('abc'));
    assert.throws(() => normalize(''));
    assert.throws(() => normalize(null));
  });

  test('adds and subtracts exactly, in either sign', () => {
    assert.equal(sub('825.0475701691931', '823.9475696291931'), '1.10000054');
    assert.equal(sub('545466.628713052', '544768.1266838904'), '698.5020291616');
    assert.equal(add('188.6843153533569', '2.07738'), '190.7616953533569');
    assert.equal(add(add(add(add('188.6843153533569', '2.07738'), '1.3844'), '0.315621628658611'), '700.633711259'), '893.095428241015511');
    assert.equal(sub('-104349.9157092885', '-104196.2375788588'), '-153.6781304297');
    assert.equal(sub('0', '12349817.70905415'), '-12349817.70905415');
    assert.equal(add('1e-10', '1e-10'), '0.0000000002');
    assert.equal(neg('5'), '-5');
    assert.equal(neg('-5'), '5');
    assert.equal(neg('0'), '0');
  });

  test('compares, detects zero and sign', () => {
    assert.equal(cmp('2', '2.0'), 0);
    assert.equal(cmp('1.10000054', '9801.315909'), -1);
    assert.equal(cmp('698.5020291615545', '697.426892'), 1);
    assert.equal(cmp('-1', '0'), -1);
    assert.equal(isZero('0.000'), true);
    assert.equal(isZero('0.0001'), false);
    assert.equal(isNegative('-0.5'), true);
    assert.equal(isNegative('0'), false);
  });

  test('nearlyEqual allows the last digit of 16-significant-digit figures to differ, nothing more', () => {
    // a sum of five recorded deltas versus the submitter's own balance delta (amm-and-book fixture)
    assert.equal(nearlyEqual('893.095428241015511', '893.0954282411', { operands: ['29551.29247382132', '28658.19704558022', '2481743.248454817'] }), true);
    // a 0.15 % transfer fee is not rounding
    assert.equal(nearlyEqual('0.76544', '0.76658816', { operands: ['70.25705451591551'] }), false);
    assert.equal(nearlyEqual('2', '2'), true);
    assert.equal(nearlyEqual('1', '1.0000000000000001'), true);
    assert.equal(nearlyEqual('1', '1.001'), false);
  });

  test('multiplies by an integer and bounds a ratio', () => {
    assert.equal(mulInt('0.76544', 2), '1.53088');
    assert.equal(mulInt('-3', 3), '-9');
    // 0.76658816 / 0.76544 = 1.0015: within (1, 2]
    assert.deepEqual(divRatio('0.76658816', '0.76544'), { above: 1, atMost: 2, within: true });
    assert.deepEqual(divRatio('1.6', '0.76544'), { above: 1, atMost: 2, within: false });
    assert.deepEqual(divRatio('0.5', '0.76544'), { above: 1, atMost: 2, within: false });
    assert.equal(divRatio('1', '0').within, false);
  });
});

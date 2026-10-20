import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { EXPLORERS, EXPLORER_NAMES, DEFAULT_EXPLORER, explorerUrl } from '../src/explorers.js';

const HASH = '0176B15458AF71EDF66D5C679FDBDCD360EB1602ECB7925352858D081287FE63';
const ADDR = 'rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah';

describe('explorer links', () => {
  test('default explorer is XRPScan and every explorer has both networks', () => {
    assert.equal(DEFAULT_EXPLORER, 'xrpscan');
    for (const name of EXPLORER_NAMES) {
      const ex = EXPLORERS[name];
      assert.match(ex.base.mainnet, /^https:\/\//, name);
      assert.match(ex.base.testnet, /^https:\/\//, name);
      assert.ok(ex.label);
    }
  });

  test('transaction, account and ledger URLs per explorer and network', () => {
    assert.equal(explorerUrl('xrpscan', 'mainnet', 'tx', HASH), `https://xrpscan.com/tx/${HASH}`);
    assert.equal(explorerUrl('xrpscan', 'testnet', 'tx', HASH), `https://testnet.xrpscan.com/tx/${HASH}`);
    assert.equal(explorerUrl('xrpscan', 'mainnet', 'account', ADDR), `https://xrpscan.com/account/${ADDR}`);
    assert.equal(explorerUrl('xrpscan', 'mainnet', 'ledger', 107777809), 'https://xrpscan.com/ledger/107777809');
    assert.equal(explorerUrl('bithomp', 'mainnet', 'tx', HASH), `https://bithomp.com/explorer/${HASH}`);
    assert.equal(explorerUrl('bithomp', 'testnet', 'account', ADDR), `https://test.bithomp.com/explorer/${ADDR}`);
    assert.equal(explorerUrl('xrplorg', 'mainnet', 'tx', HASH), `https://livenet.xrpl.org/transactions/${HASH}`);
    assert.equal(explorerUrl('xrplorg', 'testnet', 'account', ADDR), `https://testnet.xrpl.org/accounts/${ADDR}`);
    assert.equal(explorerUrl('xrplorg', 'mainnet', 'ledger', '107777809'), 'https://livenet.xrpl.org/ledgers/107777809');
  });

  test('unknown explorer or network falls back to the defaults', () => {
    assert.equal(explorerUrl('nope', 'devnet', 'tx', HASH), `https://xrpscan.com/tx/${HASH}`);
  });

  test('malformed identifiers never become links', () => {
    assert.equal(explorerUrl('xrpscan', 'mainnet', 'tx', 'javascript:alert(1)'), null);
    assert.equal(explorerUrl('xrpscan', 'mainnet', 'tx', HASH.slice(1)), null);
    assert.equal(explorerUrl('xrpscan', 'mainnet', 'account', 'r/../x'), null);
    assert.equal(explorerUrl('xrpscan', 'mainnet', 'account', null), null);
    assert.equal(explorerUrl('xrpscan', 'mainnet', 'ledger', '12abc'), null);
    assert.equal(explorerUrl('xrpscan', 'mainnet', 'ledger', 0), null);
    assert.equal(explorerUrl('xrpscan', 'mainnet', 'token', 'x'), null);
  });
});

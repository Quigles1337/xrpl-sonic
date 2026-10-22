import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { EXPLORERS, EXPLORER_NAMES, EXTERNAL_EXPLORER_NAMES, SONIC_EXPLORER, DEFAULT_EXPLORER, SITE_URL, explorerUrl, listenerUrl } from '../src/explorers.js';
import { parseRoute } from '../src/explorer/route.js';

const HASH = '0176B15458AF71EDF66D5C679FDBDCD360EB1602ECB7925352858D081287FE63';
const ADDR = 'rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah';

describe('explorer links', () => {
  test("the default explorer is this site's own; the external ones are absolute and have both networks", () => {
    assert.equal(DEFAULT_EXPLORER, SONIC_EXPLORER);
    assert.equal(EXPLORER_NAMES[0], SONIC_EXPLORER, 'listed first in the select');
    assert.deepEqual(EXTERNAL_EXPLORER_NAMES, ['xrpscan', 'bithomp', 'xrplorg']);
    for (const name of EXPLORER_NAMES) {
      const ex = EXPLORERS[name];
      assert.ok(ex.label, name);
      assert.ok(ex.base.mainnet && ex.base.testnet, name);
      if (name === SONIC_EXPLORER) continue;
      assert.match(ex.base.mainnet, /^https:\/\//, name);
      assert.match(ex.base.testnet, /^https:\/\//, name);
    }
  });

  test("this site's explorer links are relative routes the explorer page reads, with the network in front of the hash", () => {
    assert.equal(explorerUrl('sonic', 'mainnet', 'tx', HASH), `./explorer.html#tx/${HASH}`);
    assert.equal(explorerUrl('sonic', 'mainnet', 'account', ADDR), `./explorer.html#account/${ADDR}`);
    assert.equal(explorerUrl('sonic', 'mainnet', 'ledger', 107777809), './explorer.html#ledger/107777809');
    assert.equal(explorerUrl('sonic', 'testnet', 'account', ADDR), `./explorer.html?network=testnet#account/${ADDR}`);
    for (const [kind, id, route] of [
      ['tx', HASH, { name: 'tx', hash: HASH }],
      ['account', ADDR, { name: 'account', address: ADDR, tag: null }],
      ['ledger', 107777809, { name: 'ledger', index: 107777809 }],
    ]) {
      const url = new URL(explorerUrl('sonic', 'testnet', kind, id), SITE_URL);
      assert.equal(url.href, `${SITE_URL}explorer.html?network=testnet${explorerUrl('sonic', 'mainnet', kind, id).slice('./explorer.html'.length)}`);
      assert.equal(url.searchParams.get('network'), 'testnet');
      assert.deepEqual(parseRoute(url.hash), route, kind);
    }
    assert.equal(explorerUrl('sonic', 'mainnet', 'tx', 'not-a-hash'), null);
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
    assert.equal(explorerUrl('nope', 'devnet', 'tx', HASH), `./explorer.html#tx/${HASH}`);
    assert.equal(explorerUrl('xrpscan', 'devnet', 'tx', HASH), `https://xrpscan.com/tx/${HASH}`);
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

describe('links from the explorer to the listening page', () => {
  test('carry ?network=testnet in front of the hash, and nothing extra on mainnet', () => {
    assert.equal(listenerUrl('mainnet', '#replay=107777809'), './#replay=107777809');
    assert.equal(listenerUrl('testnet', '#replay=5'), './?network=testnet#replay=5');
    assert.equal(listenerUrl('testnet', `#cast=${ADDR}~Maker`), `./?network=testnet#cast=${ADDR}~Maker`);
    assert.equal(listenerUrl('mainnet', ''), './');
    assert.equal(listenerUrl(undefined, '#replay=1'), './#replay=1');
  });
});

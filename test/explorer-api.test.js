// The explorer's api: account_info, and the account root through ledger_entry
// when the node refuses account_info (rippled does for an AMM pseudo-account:
// docs/coherence.md, phase 2). The stream is replaced by a stub.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ExplorerApi, accountInfoFromEntry, ACCOUNT_ROOT_FLAGS } from '../src/explorer/api.js';
import { decodeFlags } from '../src/explorer/anatomy.js';

const POOL = 'rMzZ16KNa5NRbosSp3Y3enxVDb6DrjhJ3L';
const ROOT = { Account: POOL, AMMID: '84DB8AA1E45DE1DB226CF8CFD0A6857A50B2AAA418299A04CF18FCAF036CC71F', Balance: '109167650000', Flags: 26214400 + 0x02000000, LedgerEntryType: 'AccountRoot', OwnerCount: 1, PreviousTxnID: 'A'.repeat(64), PreviousTxnLgrSeq: 91471046, Sequence: 91471046, index: 'B'.repeat(64) };

describe('explorer api: an AMM pseudo-account resolves through ledger_entry', () => {
  test('accountInfoFromEntry shapes the account root like account_info, with the flags from the bits and the error account_info gave', () => {
    const err = Object.assign(new Error('Internal error.'), { code: 'internal' });
    const info = accountInfoFromEntry({ node: ROOT, ledger_index: 107834877, ledger_hash: 'C'.repeat(64), validated: true, index: 'B'.repeat(64) }, err);
    assert.equal(info.via, 'ledger_entry');
    assert.equal(info.account_data.Account, POOL);
    assert.equal(info.account_data.AMMID, ROOT.AMMID);
    assert.equal(info.ledger_index, 107834877);
    assert.deepEqual(info.error, { code: 'internal', message: 'Internal error.' });
    assert.deepEqual(Object.entries(info.account_flags).filter(([, v]) => v).map(([k]) => k), ['disableMasterKey', 'defaultRipple', 'depositAuth', 'amm']);
    assert.deepEqual(decodeFlags(info.account_flags), ['Master key disabled', 'Rippling on by default', 'Deposit authorisation: only pre-approved senders', 'An AMM pseudo-account (its AMM entry holds the pool)']);
    assert.equal(ACCOUNT_ROOT_FLAGS.amm, 0x02000000);
    assert.throws(() => accountInfoFromEntry({ node: { LedgerEntryType: 'Offer' } }, err), /Internal error/);
    assert.throws(() => accountInfoFromEntry(null), /not an account root/);
  });

  test('accountInfo falls back to ledger_entry only when account_info fails, at the same ledger, and gives account_info’s error when both fail', async () => {
    const api = new ExplorerApi({ network: 'mainnet' });
    const calls = [];
    const answers = { account_info: null, ledger_entry: null };
    api.request = async (cmd) => {
      calls.push(cmd);
      const a = answers[cmd.command];
      if (a instanceof Error) throw a;
      return a;
    };
    answers.account_info = { result: { account_data: { Account: POOL, Balance: '1' }, account_flags: {}, ledger_index: 5 } };
    assert.equal((await api.accountInfo(POOL, { ledgerIndex: 5 })).via, undefined, 'account_info answered: no fallback');
    assert.deepEqual(calls.map((c) => c.command), ['account_info']);
    calls.length = 0;
    answers.account_info = Object.assign(new Error('Internal error.'), { code: 'internal' });
    answers.ledger_entry = { result: { node: ROOT, ledger_index: 5, validated: true } };
    const info = await api.accountInfo(POOL, { ledgerIndex: 5 });
    assert.equal(info.via, 'ledger_entry');
    assert.deepEqual(calls, [{ command: 'account_info', account: POOL, ledger_index: 5 }, { command: 'ledger_entry', account_root: POOL, ledger_index: 5 }]);
    answers.ledger_entry = Object.assign(new Error('entryNotFound'), { code: 'entryNotFound' });
    await assert.rejects(api.accountInfo(POOL), /Internal error/, 'the first error is the one reported');
    api.close();
  });
});

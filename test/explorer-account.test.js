// The account snapshot: one validated ledger per render, every part read at
// that ledger, account_tx bound to it through pagination, and four distinct
// states (unavailable, empty, partial, loaded) that reach the facts object.
// The api is replaced by a replay of recorded responses (test/fixtures/explorer/snapshot).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAccount, loadOlder, coverageOf, PART_STATES } from '../src/explorer/account.js';
import { counterparties } from '../src/explorer/anatomy.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'explorer', 'snapshot');
const load = (name) => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));

const header = load('ledger-validated');
const LEDGER = Number(header.result.ledger_index);
const HASH = header.result.ledger_hash;
const ACCOUNT = load('account_info').result.account_data.Account;
const NOBODY = load('account_info-error').request?.account ?? 'r4dGHd2neMqSB5zxmyiCVCbFVAQNd5ud5m';

/** A fake ExplorerApi: records every command it is asked, answers from the fixtures, throws like the real one on error responses. */
function fakeApi({ fail = [], noHeader = false } = {}) {
  const calls = [];
  const answer = (name) => {
    const r = load(name);
    if (r.status === 'error') {
      const err = new Error(r.error_message ?? r.error);
      err.code = r.error;
      throw err;
    }
    return r.result;
  };
  const api = {
    calls,
    async validatedLedger() {
      calls.push({ command: 'ledger', ledger_index: 'validated', transactions: false });
      if (noHeader) throw Object.assign(new Error('no connection to a node'), { code: 'noConnection' });
      return answer('ledger-validated');
    },
    async accountInfo(account, { ledgerIndex } = {}) {
      calls.push({ command: 'account_info', account, ledger_index: ledgerIndex ?? 'validated' });
      if (fail.includes('account_info')) return answer('account_info-error');
      return answer('account_info');
    },
    async accountLines(account, { ledgerIndex, limit = 200, marker } = {}) {
      calls.push({ command: 'account_lines', account, ledger_index: ledgerIndex ?? 'validated', limit, ...(marker ? { marker } : {}) });
      if (fail.includes('account_lines')) return answer('account_lines-error');
      return answer('account_lines');
    },
    async accountObjects(account, { ledgerIndex, limit = 200 } = {}) {
      calls.push({ command: 'account_objects', account, ledger_index: ledgerIndex ?? 'validated', limit });
      if (fail.includes('account_objects')) return answer('account_info-error');
      return answer('account_objects');
    },
    async accountNfts(account, { ledgerIndex, limit = 100 } = {}) {
      calls.push({ command: 'account_nfts', account, ledger_index: ledgerIndex ?? 'validated', limit });
      if (fail.includes('account_nfts')) return answer('account_info-error');
      return answer('account_nfts');
    },
    async accountTx(account, { limit = 40, marker, ledgerIndexMax } = {}) {
      calls.push({ command: 'account_tx', account, limit, ledger_index_min: -1, ledger_index_max: ledgerIndexMax ?? -1, forward: false, ...(marker ? { marker } : {}) });
      if (fail.includes('account_tx')) return answer('account_info-error');
      if (account === NOBODY) return answer('account_tx-error');
      return answer(marker ? 'account_tx-page2' : 'account_tx-page1');
    },
  };
  return api;
}

describe('account snapshot', () => {
  test('one validated ledger per render; every part is requested at it; states and coverage reach the facts object', async () => {
    const api = fakeApi();
    const parts = [];
    const f = await loadAccount(api, ACCOUNT, { limit: 20, onPart: (name, part) => parts.push([name, part.state]) });
    assert.equal(f.kind, 'account');
    assert.equal(f.address, ACCOUNT);
    assert.deepEqual(f.snapshot, { state: 'loaded', ledgerIndex: LEDGER, ledgerHash: HASH, closeTime: header.result.ledger.close_time });
    const bound = api.calls.filter((c) => c.command !== 'ledger');
    assert.equal(bound.length, 5, 'account_info, account_lines, account_objects, account_nfts, account_tx');
    for (const c of bound) {
      if (c.command === 'account_tx') assert.equal(c.ledger_index_max, LEDGER, 'account_tx bound to the snapshot');
      else assert.equal(c.ledger_index, LEDGER, `${c.command} at the snapshot ledger`);
    }
    assert.equal(f.parts.info.state, 'loaded');
    assert.equal(f.parts.info.result.ledger_index, LEDGER);
    assert.equal(f.parts.lines.state, 'loaded');
    assert.equal(f.parts.lines.items.length, 13);
    assert.equal(f.parts.objects.state, 'loaded');
    assert.equal(f.parts.objects.items.length, 38);
    assert.equal(f.parts.nfts.state, 'empty', 'zero NFTs is empty, not unavailable');
    assert.deepEqual(f.parts.nfts.items, []);
    assert.equal(f.parts.tx.state, 'partial', 'a marker means more exists');
    assert.equal(f.parts.tx.entries.length, 20);
    assert.equal(f.parts.tx.ledgerIndexMax, LEDGER);
    assert.deepEqual(f.parts.tx.marker, load('account_tx-page1').result.marker);
    assert.deepEqual(f.parts.tx.covers, { count: 20, pages: 1, newestLedger: LEDGER, oldestLedger: LEDGER });
    assert.deepEqual(f.counterparties.covers, f.parts.tx.covers);
    assert.deepEqual(f.counterparties.parties, counterparties(f.parts.tx.entries, ACCOUNT));
    assert.ok(parts.some(([n, s]) => n === 'tx' && s === 'partial'));
    assert.ok(parts.some(([n, s]) => n === 'lines' && s === 'loaded'));
    assert.deepEqual([...PART_STATES], ['unavailable', 'empty', 'partial', 'loaded']);
  });

  test('"Load older" carries the snapshot bound and the marker, then recomputes counterparties over everything loaded', async () => {
    const api = fakeApi();
    const f = await loadAccount(api, ACCOUNT, { limit: 20 });
    const page = await loadOlder(api, f);
    const call = api.calls.at(-1);
    assert.equal(call.command, 'account_tx');
    assert.equal(call.ledger_index_max, LEDGER, 'the bound survives pagination');
    assert.deepEqual(call.marker, load('account_tx-page1').result.marker);
    assert.equal(page.entries.length, 20);
    assert.equal(f.parts.tx.entries.length, 40);
    assert.equal(f.parts.tx.state, 'partial', 'page 2 also has a marker');
    assert.deepEqual(f.parts.tx.marker, load('account_tx-page2').result.marker);
    assert.deepEqual(f.parts.tx.covers, { count: 40, pages: 2, newestLedger: LEDGER, oldestLedger: 107811685 });
    assert.deepEqual(f.counterparties.parties, counterparties(f.parts.tx.entries, ACCOUNT), 'counterparties cover all 40 records');
    assert.deepEqual(f.counterparties.covers, f.parts.tx.covers);
    assert.match(coverageOf(f.parts.tx.covers), /^40 records, ledgers #107,811,685–#107,811,689$/);
    assert.match(coverageOf({ count: 20, pages: 1, newestLedger: LEDGER, oldestLedger: LEDGER }), /^20 records, ledger #107,811,689$/);
    assert.equal(coverageOf(null), '');
  });

  test('a failed account-data request is unavailable, not empty', async () => {
    const api = fakeApi({ fail: ['account_lines', 'account_nfts'] });
    const f = await loadAccount(api, ACCOUNT, { limit: 20 });
    assert.equal(f.parts.lines.state, 'unavailable');
    assert.equal(f.parts.lines.error.code, 'actNotFound');
    assert.deepEqual(f.parts.lines.items, []);
    assert.equal(f.parts.nfts.state, 'unavailable');
    assert.equal(f.parts.objects.state, 'loaded');
    assert.equal(f.parts.tx.state, 'partial');
    assert.notEqual(f.parts.lines.state, 'empty');
  });

  test('an account with no transactions is empty, and an unknown account is unavailable', async () => {
    const api = fakeApi();
    const f = await loadAccount(api, NOBODY, { limit: 20 });
    assert.equal(f.parts.tx.state, 'empty');
    assert.deepEqual(f.parts.tx.entries, []);
    assert.equal(f.parts.tx.covers, null);
    assert.deepEqual(f.counterparties.parties, []);
    assert.equal(f.parts.tx.ledgerIndexMax, LEDGER);
    const missing = await loadAccount(fakeApi({ fail: ['account_info'] }), ACCOUNT, { limit: 20 });
    assert.equal(missing.parts.info.state, 'unavailable');
    assert.equal(missing.parts.info.error.code, 'actNotFound');
  });

  test('when no validated ledger can be resolved the parts are read unbound and say so', async () => {
    const api = fakeApi({ noHeader: true });
    const f = await loadAccount(api, ACCOUNT, { limit: 20 });
    assert.equal(f.snapshot.state, 'unavailable');
    assert.equal(f.snapshot.error.code, 'noConnection');
    for (const c of api.calls.filter((c) => c.command !== 'ledger')) {
      if (c.command === 'account_tx') assert.equal(c.ledger_index_max, -1);
      else assert.equal(c.ledger_index, 'validated');
    }
    assert.equal(f.parts.tx.ledgerIndexMax, null);
    assert.equal(f.parts.info.state, 'loaded');
  });

  test('loadOlder without a marker or without a tx part does nothing', async () => {
    const api = fakeApi();
    const f = await loadAccount(api, NOBODY, { limit: 20 });
    const before = api.calls.length;
    assert.equal(await loadOlder(api, f), null);
    assert.equal(api.calls.length, before);
  });
});

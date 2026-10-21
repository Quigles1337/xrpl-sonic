import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { txToEvent } from '../src/mapping.js';
import { balanceChanges, describeAffected, summarize, resultMeaning, rippleTimeToIso, decodeDomain, decodeFlags, reserveFor, asStreamMessage, counterparties, typeMix, RESULT_CODES } from '../src/explorer/anatomy.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'explorer');
const load = (name) => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')).result;

const paymentXrp = load('payment-xrp');
const offerCreate = load('offercreate');
const offerCancel = load('offercancel');
const nftOffer = load('nftokencreateoffer');
const failed = load('failed');
const accountTx = load('account_tx');
const accountInfo = load('account_info');

describe('balance changes', () => {
  test('an XRP payment that funds a new account: sender pays amount plus fee, destination is created', () => {
    const changes = balanceChanges(paymentXrp.meta);
    const sender = changes.find((c) => c.account === paymentXrp.Account);
    const dest = changes.find((c) => c.account === paymentXrp.Destination);
    assert.equal(sender.currency, 'XRP');
    assert.ok(Math.abs(sender.delta - -(1.7 + 0.000012)) < 1e-9, `sender delta ${sender.delta}`);
    assert.equal(sender.before, 237.619289);
    assert.equal(sender.after, 235.919277);
    assert.equal(dest.delta, 1.7);
    assert.equal(dest.created, true);
    assert.equal(dest.before, 0);
  });

  test('an offer create that only placed an offer costs the fee', () => {
    const changes = balanceChanges(offerCreate.meta);
    assert.equal(changes.length, 1);
    assert.ok(Math.abs(changes[0].delta - -0.00001) < 1e-12);
    assert.deepEqual(changes[0].exact, { before: '23791790143', after: '23791790133', delta: '-10' }, 'exact drops beside the rounded number');
    assert.equal(changes[0].node, 0);
  });

  test('exact strings: an XRP payment in drops, an issued currency as a decimal', () => {
    const sender = balanceChanges(paymentXrp.meta).find((c) => c.account === paymentXrp.Account);
    assert.deepEqual(sender.exact, { before: '237619289', after: '235919277', delta: '-1700012' });
    const meta = { AffectedNodes: [{ ModifiedNode: { LedgerEntryType: 'RippleState', FinalFields: { Balance: { currency: 'USD', issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: '-150.5' }, LowLimit: { currency: 'USD', issuer: 'rLow', value: '0' }, HighLimit: { currency: 'USD', issuer: 'rHigh', value: '1000' } }, PreviousFields: { Balance: { currency: 'USD', issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: '-100' } } } }] };
    const [low, high] = balanceChanges(meta);
    assert.deepEqual(low.exact, { before: '-100', after: '-150.5', delta: '-50.5' });
    assert.deepEqual(high.exact, { before: '100', after: '150.5', delta: '50.5' });
  });

  test('a synthetic RippleState change is reported from both sides', () => {
    const meta = {
      AffectedNodes: [
        {
          ModifiedNode: {
            LedgerEntryType: 'RippleState',
            FinalFields: { Balance: { currency: 'USD', issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: '-150' }, LowLimit: { currency: 'USD', issuer: 'rLow', value: '0' }, HighLimit: { currency: 'USD', issuer: 'rHigh', value: '1000' } },
            PreviousFields: { Balance: { currency: 'USD', issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: '-100' } },
          },
        },
      ],
    };
    const [low, high] = balanceChanges(meta);
    assert.deepEqual(low, { account: 'rLow', currency: 'USD', issuer: 'rHigh', delta: -50, before: -100, after: -150, exact: { before: '-100', after: '-150', delta: '-50' }, node: 0 });
    assert.deepEqual(high, { account: 'rHigh', currency: 'USD', issuer: 'rLow', delta: 50, before: 100, after: 150, exact: { before: '100', after: '150', delta: '50' }, node: 0 });
    assert.deepEqual(balanceChanges(null), []);
  });
});

describe('affected entries in words', () => {
  test('offer create: a new offer placed and the earlier one replaced; directories counted, not listed', () => {
    const { entries, directories } = describeAffected(offerCreate.meta, offerCreate);
    assert.equal(directories, 3);
    const placed = entries.find((e) => e.type === 'Offer' && e.action === 'created');
    assert.match(placed.summary, /^Offer placed by rBTw…jjah: gives 23,691 XRP for 33,490 USD \(rhub…F3wq\)$/);
    const replaced = entries.find((e) => e.type === 'Offer' && e.action === 'deleted');
    assert.match(replaced.summary, /^Earlier offer #287256820 by rBTw…jjah replaced/);
    assert.ok(replaced.rules.includes('offer.removal.replaced'), 'every entry keeps its rule ids');
    assert.ok(placed.rules.includes('offer.placed'));
    const root = entries.find((e) => e.type === 'AccountRoot');
    assert.deepEqual(root.details[0], ['Balance', '23,791.790143 → 23,791.790133 XRP']);
    assert.deepEqual(root.details[1], ['Sequence', '287256845 → 287256846']);
  });

  test('offer cancel: the offer is cancelled and the owner count drops', () => {
    const { entries } = describeAffected(offerCancel.meta, offerCancel);
    const gone = entries.find((e) => e.type === 'Offer');
    assert.equal(gone.action, 'deleted');
    assert.match(gone.summary, /cancelled \(was giving 5\.5 XRP for/);
    assert.ok(gone.rules.includes('offer.removal.cancelled'));
    const root = entries.find((e) => e.type === 'AccountRoot');
    assert.ok(root.details.some(([k, v]) => k === 'Owned objects' && v === '42 → 41'));
  });

  test('nft offer: a buy offer with amount and expiry', () => {
    const { entries } = describeAffected(nftOffer.meta, nftOffer);
    const offer = entries.find((e) => e.type === 'NFTokenOffer');
    assert.match(offer.summary, /^NFT buy offer by rnHe…SsAV created: 570 XRP$/, 'a buy offer: the transaction names an Owner and has no sell flag');
    assert.ok(offer.details.some(([k, v]) => k === 'Expires' && /^2026-/.test(v)));
  });

  test('account created', () => {
    const { entries } = describeAffected(paymentXrp.meta, paymentXrp);
    assert.ok(entries.some((e) => e.action === 'created' && /^Account raEH…Uo7A created with 1\.7 XRP$/.test(e.summary)));
  });
});

describe('summaries', () => {
  test('payment, offers, nft offer and a failure read as sentences made from the record', () => {
    assert.equal(summarize(paymentXrp, paymentXrp.meta), 'rnh6…71mV sent 1.7 XRP to raEH…Uo7A. This funded a new account. Fee 12 drops.');
    assert.equal(summarize(offerCreate, offerCreate.meta), 'rBTw…jjah offered 23,691 XRP for 33,490 USD (rhub…F3wq); nothing crossed; placed on the book; replacing its earlier offer #287256820. Fee 10 drops.');
    assert.equal(summarize(offerCancel, offerCancel.meta), 'rBWr…nDBG cancelled its offer #107574102. Fee 12 drops.');
    assert.match(summarize(nftOffer, nftOffer.meta), /^rnHe…SsAV offered to buy NFT 00080BB84F… for 570 XRP, until 2026-.*\. Fee 12 drops\.$/);
    assert.equal(summarize(failed, failed.meta), 'Payment by rKNR…Ph7z failed: tecPATH_DRY — No payment path had enough liquidity to deliver the amount. Only the fee of 20 drops was charged.');
    assert.equal(summarize(null), '');
  });

  test('result meanings cover the families', () => {
    assert.equal(resultMeaning('tesSUCCESS'), RESULT_CODES.tesSUCCESS);
    assert.match(resultMeaning('tecNEW_THING'), /charged its fee/);
    assert.match(resultMeaning('temBAD_FEE'), /Malformed/);
    assert.match(resultMeaning('tefPAST_SEQ'), /not included/);
    assert.match(resultMeaning('terRETRY'), /Retried/);
    assert.match(resultMeaning('telBAD'), /locally/);
    assert.equal(resultMeaning(null), 'Unknown result.');
  });
});

describe('account helpers', () => {
  test('ripple time, domains, flags and reserve', () => {
    assert.equal(rippleTimeToIso(0), '2000-01-01T00:00:00.000Z');
    assert.equal(rippleTimeToIso(845791082), '2026-10-20T05:58:02.000Z');
    assert.equal(rippleTimeToIso('x'), null);
    assert.equal(decodeDomain('6578616D706C652E636F6D'), 'example.com');
    assert.equal(decodeDomain('not hex'), 'not hex');
    assert.equal(decodeDomain(''), '');
    assert.deepEqual(decodeFlags(accountInfo.account_flags), []);
    assert.deepEqual(decodeFlags({ requireDestinationTag: true, disableMasterKey: true, mystery: true, defaultRipple: false }), ['Requires a destination tag on incoming payments', 'Master key disabled', 'mystery']);
    assert.deepEqual(reserveFor({ ownerCount: 38 }), { base: 1, owner: 7.6, total: 8.6 });
    assert.deepEqual(reserveFor({ ownerCount: 0, reserveBase: 10, reserveInc: 2 }), { base: 10, owner: 0, total: 10 });
  });

  test('account_tx entries map through the sound mapping and aggregate into counterparties', () => {
    const entries = accountTx.transactions;
    const msg = asStreamMessage(entries[0]);
    assert.equal(msg.type, 'transaction');
    assert.equal(msg.hash, entries[0].tx.hash);
    const ev = txToEvent(msg);
    assert.equal(ev.category, 'offer');
    assert.equal(ev.hash, entries[0].tx.hash);
    const parties = counterparties(entries, accountTx.account);
    assert.ok(parties.length >= 1);
    assert.ok(parties.every((p) => p.address !== accountTx.account));
    assert.ok(parties[0].roles.issuer >= 1, 'offers name their issuers');
    assert.ok(parties[0].count >= parties.at(-1).count);
    assert.equal(asStreamMessage({}), null);
    const mix = typeMix(entries);
    assert.deepEqual(mix, [{ type: 'OfferCreate', count: entries.length, category: 'offer' }]);
  });

  test('counterparties track XRP in and out from payments', () => {
    const me = paymentXrp.Account;
    const parties = counterparties([{ tx: { ...paymentXrp, date: 1 }, meta: paymentXrp.meta, validated: true }], me);
    const dest = parties.find((p) => p.address === paymentXrp.Destination);
    assert.equal(dest.roles.recipient, 1);
    assert.ok(Math.abs(dest.xrpOut - 1.700012) < 1e-9);
    assert.equal(dest.xrpIn, 0);
  });
});

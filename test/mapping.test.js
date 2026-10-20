import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  CATEGORIES,
  CATEGORY_NAMES,
  SCALES,
  KEYS,
  PITCH_RANGE,
  WHALE_THRESHOLD_XRP,
  parseAmount,
  extractAmount,
  decodeCurrency,
  categorize,
  pitchFromAmount,
  amountToDegree,
  degreeToMidi,
  degreeCount,
  sizeFromAmount,
  midiToFreq,
  midiToName,
  stableIndex,
  shortAddress,
  formatAmount,
  txToEvent,
  ledgerToEvent,
  classifyMessage,
  unwrapTransactionMessage,
} from '../src/mapping.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8'));
const allFixtureNames = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

const txFixtureNames = allFixtureNames.filter((n) => fixture(n).type === 'transaction');

describe('amount parsing', () => {
  test('parses a string of drops as XRP', () => {
    const a = parseAmount('12500000');
    assert.equal(a.isXrp, true);
    assert.equal(a.currency, 'XRP');
    assert.equal(a.value, 12.5);
    assert.equal(a.drops, 12_500_000);
  });

  test('parses an issued-currency object', () => {
    const a = parseAmount({ currency: 'USD', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B', value: '25.5' });
    assert.equal(a.isXrp, false);
    assert.equal(a.kind, 'iou');
    assert.equal(a.currency, 'USD');
    assert.equal(a.value, 25.5);
    assert.equal(a.issuer, 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B');
  });

  test('parses an MPT amount', () => {
    const a = parseAmount({ mpt_issuance_id: '00000000'.repeat(6), value: '42' });
    assert.equal(a.kind, 'mpt');
    assert.equal(a.value, 42);
  });

  test('rejects garbage', () => {
    assert.equal(parseAmount(null), null);
    assert.equal(parseAmount('12.5'), null);
    assert.equal(parseAmount('abc'), null);
    assert.equal(parseAmount({ currency: 'USD', value: 'NaN' }), null);
    assert.equal(parseAmount({}), null);
  });

  test('decodes 160-bit hex currency codes to ASCII, leaves 3-letter and non-standard codes alone', () => {
    assert.equal(decodeCurrency('534F4C4F00000000000000000000000000000000'), 'SOLO');
    assert.equal(decodeCurrency('USD'), 'USD');
    assert.equal(decodeCurrency('0000000000000000000000005553440000000000'), '0000000000000000000000005553440000000000');
    assert.equal(decodeCurrency('03930D02208264E2E40EC1B0C09E4DB96EE197B1'), '03930D02208264E2E40EC1B0C09E4DB96EE197B1');
  });

  test('formats amounts for the log', () => {
    assert.equal(formatAmount(parseAmount('12500000')), '12.5 XRP');
    assert.equal(formatAmount(parseAmount('1000')), '0.001 XRP');
    assert.equal(formatAmount(parseAmount('150000000000')), '150,000 XRP');
    assert.equal(formatAmount(parseAmount({ currency: 'USD', issuer: 'r', value: '25.5' })), '25.5 USD');
  });
});

describe('extractAmount precedence', () => {
  test('delivered_amount wins over Amount for partial payments', () => {
    const { transaction, meta } = fixture('payment-partial');
    const a = extractAmount(transaction, meta);
    assert.equal(a.value, 20);
  });

  test('DeliverMax (API v2) is used when delivered_amount is unavailable', () => {
    const { transaction, meta } = fixture('payment-delivermax-unavailable');
    const a = extractAmount(transaction, meta);
    assert.equal(a.value, 3);
  });

  test('delivered_amount wins over DeliverMax in a tx_json (API v2) message', () => {
    const ev = txToEvent(fixture('payment-delivermax-v2'));
    assert.ok(ev);
    assert.equal(ev.amountXrp, 4.99);
    assert.equal(ev.account, 'rLHzPsX6oXkzU2qL12kHCH8G8cnZv1rBJh');
  });

  test('OfferCreate prefers the XRP side of the offer', () => {
    const { transaction, meta } = fixture('offercreate');
    const a = extractAmount(transaction, meta);
    assert.equal(a.isXrp, true);
    assert.equal(a.value, 500);
  });

  test('TrustSet reports the limit amount', () => {
    const { transaction } = fixture('trustset');
    const a = extractAmount(transaction, null);
    assert.equal(a.currency, 'USD');
    assert.equal(a.value, 1_000_000_000);
  });

  test('AMMDeposit picks the XRP leg', () => {
    const { transaction } = fixture('ammdeposit');
    assert.equal(extractAmount(transaction, null).value, 250);
  });
});

describe('categorisation', () => {
  test('maps every known transaction type to the documented category', () => {
    const expected = {
      Payment: 'payment',
      OfferCreate: 'offer',
      OfferCancel: 'offer',
      TrustSet: 'trust',
      NFTokenMint: 'nft',
      NFTokenCreateOffer: 'nft',
      NFTokenAcceptOffer: 'nft',
      NFTokenBurn: 'nft',
      EscrowCreate: 'escrow',
      EscrowFinish: 'escrow',
      EscrowCancel: 'escrow',
      PaymentChannelCreate: 'paychan',
      PaymentChannelFund: 'paychan',
      PaymentChannelClaim: 'paychan',
      AMMCreate: 'amm',
      AMMDeposit: 'amm',
      AMMWithdraw: 'amm',
      AMMVote: 'amm',
      AccountSet: 'other',
      TicketCreate: 'other',
      CheckCreate: 'other',
      SignerListSet: 'other',
      Clawback: 'other',
      DIDSet: 'other',
    };
    for (const [type, category] of Object.entries(expected)) {
      assert.equal(categorize(type), category, type);
    }
    assert.equal(categorize(undefined), 'other');
  });

  test('every category has a label, colour and sound', () => {
    for (const name of CATEGORY_NAMES) {
      const c = CATEGORIES[name];
      assert.match(c.colour, /^#[0-9a-f]{6}$/);
      assert.ok(c.label.length > 0);
      assert.ok(c.sound.length > 0);
    }
  });
});

describe('pitch mapping', () => {
  test('A4 is 440 Hz and note names are right', () => {
    assert.equal(midiToFreq(69), 440);
    assert.equal(midiToName(60), 'C4');
    assert.equal(midiToName(69), 'A4');
  });

  test('bigger payments produce lower (or equal) pitches, monotonically', () => {
    const amounts = [0.000001, 0.001, 0.1, 1, 10, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000];
    let prev = Infinity;
    for (const amt of amounts) {
      const p = pitchFromAmount(amt);
      assert.ok(p <= prev, `${amt} XRP → ${p} should be <= ${prev}`);
      prev = p;
    }
    assert.ok(pitchFromAmount(0.001) - pitchFromAmount(1_000_000) >= 36, 'dust vs whale spans at least three octaves');
  });

  test('pitches stay inside the configured range and on the scale', () => {
    for (const scale of Object.keys(SCALES)) {
      for (const key of KEYS) {
        for (const amt of [1e-6, 0.5, 42, 9_999, 5e7]) {
          const midi = pitchFromAmount(amt, scale, key);
          const low = PITCH_RANGE.low + KEYS.indexOf(key);
          assert.ok(midi >= low && midi < low + 12 * PITCH_RANGE.octaves, `${scale}/${key}/${amt} → ${midi}`);
          const semitone = (((midi - low) % 12) + 12) % 12;
          assert.ok(SCALES[scale].steps.includes(semitone), `${scale}/${key}/${amt}: ${semitone} not in scale`);
        }
      }
    }
  });

  test('changing key transposes by the key offset', () => {
    const c = pitchFromAmount(100, 'pentatonicMajor', 'C');
    const g = pitchFromAmount(100, 'pentatonicMajor', 'G');
    assert.equal(g - c, 7);
  });

  test('degree helpers agree with the scale length', () => {
    assert.equal(degreeCount('pentatonicMajor'), 25);
    assert.equal(degreeCount('major'), 35);
    assert.equal(degreeToMidi(0, 'pentatonicMajor', 'C'), 36);
    assert.equal(degreeToMidi(5, 'pentatonicMajor', 'C'), 48); // one octave up
    assert.equal(amountToDegree(1e8), 0);
    assert.equal(amountToDegree(1e-6), 24);
  });

  test('stableIndex is deterministic and bounded', () => {
    const a = stableIndex('rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B', 10);
    assert.equal(a, stableIndex('rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B', 10));
    assert.ok(a >= 0 && a < 10);
    assert.equal(stableIndex('x', 0), 0);
  });

  test('particle size grows with amount and is clamped', () => {
    assert.ok(sizeFromAmount(1) < sizeFromAmount(1_000));
    assert.ok(sizeFromAmount(1_000) < sizeFromAmount(1_000_000));
    assert.equal(sizeFromAmount(null), 4);
    assert.ok(sizeFromAmount(1e12) <= 28);
    assert.ok(sizeFromAmount(1e-9) >= 3);
  });
});

describe('txToEvent', () => {
  test('XRP payment in drops → pluck with pitch, colour and log text', () => {
    const ev = txToEvent(fixture('payment-xrp-drops'));
    assert.equal(ev.category, 'payment');
    assert.equal(ev.sound, 'pluck');
    assert.equal(ev.amountXrp, 12.5);
    assert.equal(ev.colour, CATEGORIES.payment.colour);
    assert.equal(ev.pitch, pitchFromAmount(12.5));
    assert.equal(ev.timbre, 'xrp');
    assert.equal(ev.sub, false);
    assert.match(ev.text, /Payment · 12\.5 XRP · rN7n…fzRH → rLHz…rBJh/);
    assert.equal(ev.ledgerIndex, 93401220);
  });

  test('tiny payment is high, whale is low and triggers the sub-bass', () => {
    const tiny = txToEvent(fixture('payment-xrp-tiny'));
    const whale = txToEvent(fixture('payment-xrp-whale'));
    assert.ok(tiny.pitch > whale.pitch);
    assert.equal(tiny.sub, false);
    assert.equal(whale.sub, true);
    assert.ok(whale.amountXrp >= WHALE_THRESHOLD_XRP);
    assert.ok(whale.velocity > tiny.velocity, 'whales are louder');
    assert.ok(whale.duration > tiny.duration, 'low notes ring longer');
    assert.ok(whale.size > tiny.size);
  });

  test('issued-currency payment uses the IOU timbre and face value', () => {
    const ev = txToEvent(fixture('payment-iou'));
    assert.equal(ev.category, 'payment');
    assert.equal(ev.timbre, 'iou');
    assert.equal(ev.amountXrp, null);
    assert.equal(ev.amount.currency, 'USD');
    assert.equal(ev.amount.value, 25.5);
    assert.match(ev.text, /25\.5 USD/);
  });

  test('hex currency codes are decoded in the log text', () => {
    const ev = txToEvent(fixture('payment-iou-hex-currency'));
    assert.match(ev.text, /1,000 SOLO/);
  });

  test('failed transactions are dropped by default and kept with includeFailed', () => {
    assert.equal(txToEvent(fixture('payment-failed')), null);
    const ev = txToEvent(fixture('payment-failed'), { includeFailed: true });
    assert.ok(ev);
    assert.equal(ev.success, false);
    assert.equal(ev.result, 'tecPATH_DRY');
  });

  test('per-category toggles filter events', () => {
    assert.equal(txToEvent(fixture('offercreate'), { enabled: { offer: false } }), null);
    assert.ok(txToEvent(fixture('offercreate'), { enabled: { payment: false } }));
  });

  test('quiet mode keeps only XRP amounts at or above the threshold', () => {
    const opts = { quietThreshold: 100 };
    assert.equal(txToEvent(fixture('payment-xrp-drops'), opts), null); // 12.5 XRP
    assert.ok(txToEvent(fixture('payment-xrp-whale'), opts)); // 150k XRP
    assert.ok(txToEvent(fixture('offercreate'), opts)); // 500 XRP side
    assert.equal(txToEvent(fixture('payment-iou'), opts), null); // no XRP amount
    assert.equal(txToEvent(fixture('accountset'), opts), null);
  });

  test('scale and key options flow through to the pitch', () => {
    const base = txToEvent(fixture('payment-xrp-drops'), { scale: 'pentatonicMinor', key: 'D' });
    assert.equal(base.pitch, pitchFromAmount(12.5, 'pentatonicMinor', 'D'));
    assert.equal(base.freq, midiToFreq(base.pitch));
  });

  test('OfferCreate → hi-hat, OfferCancel → rim', () => {
    const create = txToEvent(fixture('offercreate'));
    const cancel = txToEvent(fixture('offercancel'));
    assert.equal(create.sound, 'hat');
    assert.equal(create.variant, 'hat');
    assert.equal(cancel.sound, 'hat');
    assert.equal(cancel.variant, 'rim');
    assert.ok(create.duration < 0.2);
  });

  test('TrustSet → pad with root and fifth, stable per issuer', () => {
    const a = txToEvent(fixture('trustset'));
    const b = txToEvent(fixture('trustset'));
    assert.equal(a.sound, 'pad');
    assert.equal(a.notes.length, 2);
    assert.equal(a.notes[1] - a.notes[0], 7);
    assert.deepEqual(a.notes, b.notes);
    assert.ok(a.duration > 1.5);
  });

  test('NFT mint and offer → bell in the upper register', () => {
    for (const name of ['nftokenmint', 'nftokencreateoffer']) {
      const ev = txToEvent(fixture(name));
      assert.equal(ev.sound, 'bell', name);
      assert.ok(ev.pitch >= 60, `${name} pitch ${ev.pitch}`);
    }
    assert.equal(txToEvent(fixture('nftokencreateoffer')).amountXrp, 25);
  });

  test('Escrow create/finish → swell with the right variant', () => {
    const create = txToEvent(fixture('escrowcreate'));
    const finish = txToEvent(fixture('escrowfinish'));
    assert.equal(create.sound, 'swell');
    assert.equal(create.variant, 'create');
    assert.equal(create.amountXrp, 1000);
    assert.equal(finish.variant, 'finish');
    assert.match(create.text, /rN7n…fzRH → rLHz…rBJh/);
  });

  test('payment channels → four-note arpeggio ending on the octave', () => {
    const ev = txToEvent(fixture('paymentchannelclaim'));
    assert.equal(ev.sound, 'arp');
    assert.equal(ev.notes.length, 4);
    assert.equal(ev.notes[3] - ev.notes[0], 12);
    assert.equal(ev.amountXrp, 1.2);
  });

  test('AMM transactions → triad chord', () => {
    for (const name of ['ammdeposit', 'ammwithdraw']) {
      const ev = txToEvent(fixture(name));
      assert.equal(ev.sound, 'chord', name);
      assert.equal(ev.notes.length, 3);
      assert.ok(ev.notes[0] < ev.notes[1] && ev.notes[1] < ev.notes[2]);
    }
  });

  test('everything else → quiet click', () => {
    for (const name of ['accountset', 'ticketcreate']) {
      const ev = txToEvent(fixture(name));
      assert.equal(ev.category, 'other', name);
      assert.equal(ev.sound, 'click');
      assert.ok(ev.velocity <= 0.15);
      assert.ok(ev.duration <= 0.1);
    }
  });

  test('every transaction fixture yields a well-formed event (with includeFailed)', () => {
    for (const name of txFixtureNames) {
      const ev = txToEvent(fixture(name), { includeFailed: true });
      assert.ok(ev, name);
      assert.equal(ev.kind, 'tx');
      assert.ok(CATEGORY_NAMES.includes(ev.category), name);
      assert.ok(Number.isInteger(ev.pitch), `${name} pitch`);
      assert.ok(ev.freq > 20 && ev.freq < 20000, `${name} freq`);
      assert.ok(ev.velocity > 0 && ev.velocity <= 1, `${name} velocity`);
      assert.ok(ev.duration > 0 && ev.duration < 5, `${name} duration`);
      assert.ok(ev.notes.length >= 1, `${name} notes`);
      assert.match(ev.colour, /^#[0-9a-f]{6}$/, `${name} colour`);
      assert.ok(ev.size >= 3 && ev.size <= 28, `${name} size`);
      assert.equal(typeof ev.text, 'string');
      assert.ok(ev.text.includes(ev.txType), `${name} text mentions type`);
      assert.equal(ev.hash.length, 64);
    }
  });

  test('non-transaction messages return null', () => {
    assert.equal(txToEvent(fixture('ledger-closed')), null);
    assert.equal(txToEvent(fixture('subscribe-response')), null);
    assert.equal(txToEvent(null), null);
    assert.equal(txToEvent({ type: 'transaction' }), null);
  });

  test('unwrapTransactionMessage handles v1, v2 and bare tx shapes', () => {
    assert.equal(unwrapTransactionMessage(fixture('payment-xrp-drops')).tx.TransactionType, 'Payment');
    assert.equal(unwrapTransactionMessage(fixture('payment-delivermax-v2')).tx.DeliverMax, '5000000');
    assert.equal(unwrapTransactionMessage({ TransactionType: 'AccountSet', Account: 'r' }).tx.Account, 'r');
    assert.equal(unwrapTransactionMessage({}), null);
  });
});

describe('ledger events and message classification', () => {
  test('ledgerClosed → ledger event with unix close time and tx count', () => {
    const ev = ledgerToEvent(fixture('ledger-closed'));
    assert.equal(ev.kind, 'ledger');
    assert.equal(ev.ledgerIndex, 93401220);
    assert.equal(ev.txnCount, 87);
    assert.equal(ev.closeTime, 846109455 + 946684800);
    assert.match(ev.closeTimeIso, /^2026-/);
    assert.equal(ev.text, 'Ledger #93,401,220 · 87 tx');
  });

  test('subscribe response seeds a ledger event too', () => {
    const ev = ledgerToEvent(fixture('subscribe-response'));
    assert.equal(ev.ledgerIndex, 93401219);
    assert.equal(ev.txnCount, null);
  });

  test('classifyMessage distinguishes stream message kinds', () => {
    assert.equal(classifyMessage(fixture('ledger-closed')), 'ledger');
    assert.equal(classifyMessage(fixture('payment-xrp-drops')), 'transaction');
    assert.equal(classifyMessage(fixture('subscribe-response')), 'response');
    assert.equal(classifyMessage({ type: 'error', error: 'unknownStream' }), 'error');
    assert.equal(classifyMessage(undefined), 'unknown');
    assert.equal(ledgerToEvent({ type: 'ledgerClosed' }), null);
  });

  test('shortAddress abbreviates r-addresses safely', () => {
    assert.equal(shortAddress('rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH'), 'rN7n…fzRH');
    assert.equal(shortAddress(undefined), '');
    assert.equal(shortAddress('short'), 'short');
  });
});

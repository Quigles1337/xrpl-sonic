#!/usr/bin/env node
// UNIVERSE phase 3A — the shared-price ground truth on a recording.
//
// Walks the recording ledger by ledger, keeping the book state from the
// Offer nodes in the metadata (src/universe/shared-price.js BookState) and
// the issuers' TransferRate from the AccountRoot nodes seen. In every ledger
// it finds the loop-takes by the rule (a self-payment that consumed offers;
// a same-ledger OfferCreate-and-cross-currency-Payment pair), runs the
// measure at the ledger before each on the state as it stood then, with the
// taker (or the pair's maker) as the focused account, and checks that the
// loop taken appears with the same offers (owner and sequence). Reports the
// counts and the misses; if there are no loop-takes, says so and what was
// searched. Offers created before the window are unseen and the report says
// how many offers were first seen modified.
//
//   node src/universe/bench/groundtruth-loops.mjs <recording.ndjson> [--ledgers N] [--out src/universe/bench/results/loops-groundtruth.md]

import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { classifyMessage, unwrapTransactionMessage } from '../../mapping.js';
import { BookState, loopTakes, candidatesOf, sharedPriceAt, assetOf, rateOf } from '../shared-price.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};
const maxLedgers = Number(opt('ledgers', 0)) || Infinity;
const out = opt('out', 'src/universe/bench/results/loops-groundtruth.md');
if (!file) {
  console.error('usage: node src/universe/bench/groundtruth-loops.mjs <recording.ndjson> [--ledgers N] [--out file]');
  process.exit(2);
}

const state = new BookState();
const rates = new Map(); // issuer → multiplier, from AccountRoot nodes seen
let ledgerTxs = [];
let currentLedger = null;
let before = state.snapshot();
let ledgers = 0;
let transactions = 0;
let selfPayments = 0;
let selfPaymentsConsuming = 0;
let conversions = 0;
let pairs = 0;
let sameLedgerOffers = 0; // consumed offers created in the same ledger, which the state before could not hold
const shapes = new Map();
const takes = [];
const results = [];

const noteRates = (meta) => {
  for (const n of meta?.AffectedNodes ?? []) {
    const node = n.ModifiedNode ?? n.CreatedNode ?? n.DeletedNode;
    if (node?.LedgerEntryType !== 'AccountRoot') continue;
    const f = node.FinalFields ?? node.NewFields ?? {};
    if (f.Account && f.TransferRate != null) rates.set(f.Account, rateOf(f.TransferRate));
  }
};

const runAt = (take) => {
  const focus = take.kind === 'pair' ? take.maker : take.taker;
  const focusOffers = before.ofAccount(focus);
  // the books in play: the consumed offers' books, plus the focused account's own
  const books = new Map();
  const addBook = (a, b) => {
    const key = [a, b].sort().join('|');
    if (!books.has(key)) books.set(key, before.onBook(a, b));
  };
  for (const o of focusOffers) addBook(assetOf(o.TakerGets), assetOf(o.TakerPays));
  for (const o of take.offers) {
    const offer = before.offers.get(`${o.owner}:${o.sequence}`);
    if (offer) addBook(assetOf(offer.TakerGets), assetOf(offer.TakerPays));
  }
  const built = candidatesOf({ focus, focusOffers, bookOffers: books, books: [...books.keys()], rates, makersPerBook: 6, cap: 12 });
  // the consumed offers' owners join the candidates when the books did not bring them
  for (const o of take.offers) {
    if (built.candidates.some((c) => c.id === o.owner)) continue;
    const offers = before.ofAccount(o.owner);
    if (offers.length) built.candidates.push(candidatesOf({ focus: o.owner, focusOffers: offers, bookOffers: new Map(), rates }).candidates[0]);
  }
  const r = sharedPriceAt({ ledger: take.ledgerIndex - 1, focus, candidates: built.candidates, selection: built.selection, excluded: built.excluded, replay: true });
  const wanted = new Set(take.offers.map((o) => `${o.owner}:${o.sequence}`));
  const seenBefore = take.offers.filter((o) => before.offers.has(`${o.owner}:${o.sequence}`)).length;
  const hit = r.nerve.loops.find((loop) => {
    const legs = new Set(loop.cycle.filter((c) => !c.pool).map((c) => `${c.owner}:${c.sequence}`));
    return [...wanted].every((k) => legs.has(k));
  });
  const partial = r.nerve.loops.find((loop) => loop.cycle.some((c) => wanted.has(`${c.owner}:${c.sequence}`)));
  return { take, focus, candidates: built.candidates.length, loops: r.nerve.loops.length, closed: r.nerve.closed.length, seenBefore, wanted: wanted.size, hit: Boolean(hit), partial: Boolean(partial), edge: hit?.edge.afterFees ?? partial?.edge.afterFees ?? null, lines: r.lines, ms: r.ms };
};

const closeLedger = () => {
  if (currentLedger == null) return;
  const found = loopTakes(ledgerTxs);
  for (const t of ledgerTxs) if (t.tx?.TransactionType === 'Payment' && t.tx.Account === t.tx.Destination && t.meta?.TransactionResult === 'tesSUCCESS') selfPayments += 1;
  for (const take of found) {
    if (take.kind === 'self-payment') {
      selfPaymentsConsuming += 1;
      const shape = `${take.sends === 'XRP' ? 'XRP' : 'token'} → ${take.delivers === 'XRP' ? 'XRP' : 'token'}${take.circular ? ' (the same asset)' : ''}`;
      shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
      if (!take.circular) {
        conversions += 1;
        continue;
      }
    } else pairs += 1;
    for (const o of take.offers) if (!before.offers.has(`${o.owner}:${o.sequence}`) && state.offers.has(`${o.owner}:${o.sequence}`)) sameLedgerOffers += 1;
    takes.push(take);
    results.push(runAt(take));
  }
  ledgerTxs = [];
};

const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
for await (const line of rl) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    continue;
  }
  const kind = classifyMessage(msg);
  if (kind === 'ledger') {
    closeLedger();
    before = state.snapshot(); // the state as it stood before the next ledger's transactions
    ledgers += 1;
    if (ledgers > maxLedgers) break;
    currentLedger = msg.ledger_index;
    continue;
  }
  if (kind !== 'transaction') continue;
  const u = unwrapTransactionMessage(msg);
  if (!u) continue;
  transactions += 1;
  if (currentLedger == null) currentLedger = u.ledgerIndex;
  noteRates(u.meta);
  state.apply(u.tx, u.meta, u.ledgerIndex);
  ledgerTxs.push({ tx: u.tx, meta: u.meta, hash: u.hash, ledgerIndex: u.ledgerIndex });
}
closeLedger();

const hits = results.filter((r) => r.hit).length;
const partials = results.filter((r) => !r.hit && r.partial).length;
const unseen = results.filter((r) => r.seenBefore < r.wanted).length;
const md = [
  '# Shared price: the ground truth on the recording',
  '',
  `Searched ${ledgers.toLocaleString('en-US')} ledgers and ${transactions.toLocaleString('en-US')} transactions of \`${file.replace(/\\/g, '/').split('/').pop()}\` for loop-takes by the rule of docs/universe.md, Part A: self-payments (Account equals Destination) that consumed offers, and same-ledger pairs (an OfferCreate by X, a cross-currency Payment by Y consuming X's new offer).`,
  '',
  `- successful self-payments seen: ${selfPayments.toLocaleString('en-US')}; of them consuming offers: ${selfPaymentsConsuming.toLocaleString('en-US')}; of those, conversions (the asset sent differs from the asset delivered, so not a loop): ${conversions.toLocaleString('en-US')}; circular (a loop-take by rule 1): ${(selfPaymentsConsuming - conversions).toLocaleString('en-US')}`,
  `- the shapes of the offer-consuming self-payments: ${[...shapes].map(([k, v]) => `${k} ${v.toLocaleString('en-US')}`).join('; ') || 'none'}`,
  `- same-ledger pairs (rule 2): ${pairs.toLocaleString('en-US')}`,
  `- consumed offers created in the same ledger as the take (which the state at the ledger before could not hold): ${sameLedgerOffers.toLocaleString('en-US')}`,
  `- loop-takes checked: ${results.length}; the loop taken appeared with the same offers at the ledger before: **${hits}**; a loop with some of its offers: ${partials}; takes whose offers were created before the window (unseen, so the state could not hold them): ${unseen}`,
  `- offers first seen modified (created before the window): ${state.unseenCreations.toLocaleString('en-US')}; issuers with a TransferRate seen: ${rates.size}`,
  '',
  results.length ? '## The takes' : '## No loop-takes',
  '',
  ...(results.length
    ? results.slice(0, 60).flatMap((r) => [`### ${r.take.kind} by ${r.take.taker} in #${r.take.ledgerIndex} (${r.take.hash ?? 'no hash'})`, '', `${r.hit ? 'HIT' : r.partial ? 'PARTIAL' : 'MISS'} · ${r.wanted} offer${r.wanted === 1 ? '' : 's'} consumed, ${r.seenBefore} in the state before · ${r.candidates} candidates · ${r.loops} loop${r.loops === 1 ? '' : 's'} found${r.closed ? `, ${r.closed} closed by fees` : ''}${r.edge != null ? ` · edge ${(100 * r.edge).toFixed(2)}%` : ''} · ${r.ms.toFixed(0)} ms`, '', ...r.lines.slice(0, 14).map((l) => `    ${l}`), ''])
    : [`None by either rule in what was searched: ${selfPayments.toLocaleString('en-US')} successful self-payments, ${selfPaymentsConsuming.toLocaleString('en-US')} of them consuming offers and every one of those a conversion between two different assets (a single leg, not a loop); no same-ledger OfferCreate-and-cross-currency-Payment pair. The measure's loops cannot be checked against a taken loop on this recording; the synthetic tests stand, and the check reruns on the next recording.`]),
  '',
].join('\n');
writeFileSync(out, md);
console.log(md.split('\n').slice(0, 12).join('\n'));
console.error(`report: ${out}`);

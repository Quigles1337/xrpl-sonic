# Facts: what the explorer says about a transaction, and why

The explorer explains a transaction from its own metadata. Before this layer existed, the explanation was prose generated from `AffectedNodes`, and the headline sentence was chosen by searching that prose for words such as "consumed". Two inferences stacked on text. This document describes the replacement: a pure module, `src/explorer/facts.js`, that reads a transaction's `tx` and `meta` and returns **typed findings**. The sentences in the explorer are rendered from the findings, and every sentence keeps the ids of the rules it rests on, so "why does it say that?" is a lookup, not a guess.

The module is pure (no DOM, no network, no audio) and is proven by fixtures: real validated transactions fetched with the `tx` command, stored verbatim in `test/fixtures/facts/`, each with an `.expected.json` beside it that states the findings the record must yield.

## Tiers

Every finding carries a tier. The tiers are ordered by how much is being claimed.

| Tier | Meaning | Example |
| --- | --- | --- |
| `observed` | A field read as recorded, unchanged. | The deleted Offer's `FinalFields.TakerGets` is `0`. |
| `calculated` | Exact arithmetic over observed fields: differences, sums, comparisons. | The offer's owner gave `1000000` drops (`PreviousFields.TakerGets` minus `FinalFields.TakerGets`). |
| `rule` | A named interpretation that holds when stated conditions on observed and calculated values hold. The conditions are the evidence. | Removal reason `consumed`: traded, and both final amounts are zero. |
| `hypothesis` | A reading the record is consistent with but does not establish. Always carries a note saying what would settle it. | "Filled by liquidity that is not an offer; the pool's AccountRoot is not in the record, so it cannot be confirmed as an AMM." |

`unresolved` is a legal value for any property no validated rule establishes. The layer never falls back to a plausible guess to avoid printing it.

## Values

Amounts are exact strings. No `Number()` is applied to an amount in this layer; XRP uses `BigInt` on drops and issued currencies use the decimal helper in `src/decimal.js`.

```js
{ currency: 'XRP', issuer: null, drops: '23691000000' }                                   // XRP, integer drops
{ currency: 'USD', code: 'USD', issuer: 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq', value: '33490.0352556885' }  // issued; `code` is the 160-bit code as recorded when it is not a 3-letter code
{ currency: 'MPT', issuanceId: '…', value: '12' }                                           // multi-purpose token
```

`value` is a plain decimal string with no exponent and no trailing zeros, normalised from whatever the node sent (rippled writes `1000000000000000e5` for large and `…e-45` for tiny issued amounts).

## The facts object

```js
import { facts } from './src/explorer/facts.js';
const f = facts(tx, meta, { network: 'mainnet', closeTime: ledger.close_time });
```

```
{
  version: 1,
  network: 'mainnet' | 'testnet' | 'unknown',
  hash, ledgerIndex,
  transaction: { type, account, sequence, result, fee: '<drops>', flags: ['tfImmediateOrCancel', …] },
  nodes:    [ { n, action, entryType, entryId } ],   // n is the index into meta.AffectedNodes
  offers:   [ OfferFacts ],                          // one per Offer entry touched
  exchange: ExchangeFacts | null,                    // OfferCreate and Payment only
  balances: [ BalanceFacts ],                        // every balance that moved, exact
  findings: [ Finding ]                              // every property above, flattened, in order
}
```

A **finding** is one property with its provenance:

```
{
  id: 'f12',                              // stable within one facts object
  subject: 'offer:3' | 'exchange' | 'balance:rXXX/USD/rISSUER' | 'transaction',
  property: 'removal',
  value: 'consumed',                      // string, Amount, object, or 'unresolved'
  tier: 'rule',
  rule: 'offer.removal.consumed',
  evidence: [ { node: 3, field: 'PreviousFields.TakerGets', value: '1000000' }, … ],
  note: 'optional, one sentence',
}
```

### OfferFacts

One per `Offer` entry in `AffectedNodes`.

| Property | Tier | What it holds |
| --- | --- | --- |
| `action` | observed | `created` / `modified` / `deleted`, from the node wrapper. |
| `owner`, `sequence`, `expiration`, `sell` | observed | From `FinalFields` or `NewFields`. `sell` is the entry's `lsfSell` flag. |
| `role` | rule | `submitter-new` (created by `tx.Account`), `submitter-old` (owned by `tx.Account`, pre-existing), `book` (owned by someone else). |
| `amounts.takerGets`, `amounts.takerPays` | observed | `{ before, after }` as Amounts. `after` is `FinalFields`/`NewFields`; `before` is `PreviousFields` when present. When `PreviousFields` carries no amount, `before` equals `after` and the evidence says so (`offer.amounts.before.unchanged`). |
| `traded` | calculated | `yes` when `PreviousFields` carries `TakerGets` or `TakerPays`; otherwise `no`. |
| `tradedAmounts` | calculated | `{ gave, got }`: what the owner gave (`TakerGets` before minus after) and received (`TakerPays` before minus after). `null` when not traded. |
| `removal` | rule | For deleted entries only: `consumed` / `traded-then-removed-unfunded` / `cleanup-without-trade` / `cancelled` / `replaced` / `self-cross` / `unresolved`. See the rule table. |
| `expired` | calculated | For `cleanup-without-trade`: `yes` when the entry's `Expiration` is at or before the ledger's close time, `no` when it is after or the entry has no expiration, `unknown` when no close time was given. |

### ExchangeFacts

For an `OfferCreate` (and, with a reduced set, a `Payment`).

| Property | Tier | What it holds |
| --- | --- | --- |
| `request` | observed | `takerGets`, `takerPays` and the flags `sell`, `immediateOrCancel`, `fillOrKill`, `passive`. For a Payment: `amount`, `sendMax`, `delivered` (from `meta.delivered_amount`). |
| `book.crossed` | calculated | The node indices of offers that traded (`traded: yes`) and are not the submitter's own. |
| `book.received`, `book.spent` | calculated | Sums over crossed offers, per currency: what their owners gave (received by the submitter) and got (spent by the submitter). |
| `book.bridged` | calculated | `yes` when a crossed offer is in a pair other than the request's (auto-bridging through XRP), so the XRP legs net out. |
| `amm` | rule / hypothesis | `exchange.amm`: a modified `AccountRoot` carrying `AMMID` whose balance (or whose trust line) moved: the pool is named and its leg is added to received/spent. `exchange.amm.suspected` (hypothesis): a balance counterparty that owns no crossed offer and whose `AccountRoot` is not in the record. `null` when neither. |
| `received`, `spent` | calculated | Totals in the request's `TakerPays` and `TakerGets` currencies (book plus AMM). |
| `fill` | calculated | `{ status, judgedBy, requested, achieved, shortfall, placed, remainder }`. Without `tfSell`, judged by `TakerPays` received; with `tfSell`, by `TakerGets` spent. `status` is `filled` (shortfall ≤ 0, or within one part in 10¹⁰ with the `exchange.fill.rounding` note), `partial`, `none`, or `unresolved` (for example `filled` while a remainder was also placed). `placed` says whether a `CreatedNode` Offer by the submitter exists; `remainder` is its amounts. |
| `fill.immediateOrCancel` / `fill.fillOrKill` | rule | What the flag means for the remainder: not placed by design; must have filled entirely or the transaction would have failed with `tecKILLED`. |
| `corroboration.received` | calculated | The submitter's own balance delta in the received currency compared with the total received (less `Fee` when that currency is XRP): `exact` / `mismatch` / `unavailable`. A line that did not change has no node and counts as zero. |
| `corroboration.spent` | calculated | The submitter's own balance delta in the spent currency compared with the total spent (plus `Fee` when XRP): `exact`; `consistent-with-transfer-fee` when more was debited than spent by a factor between 1 and 2 (the issuer's `TransferRate` is not in the record); `mismatch`; `unavailable`. |
| `corroboration.fee` | calculated | When neither side is XRP: the submitter's XRP moved by exactly the fee, or not. |

`exact` on an issued currency means equal to within the last place of the 16-significant-digit figures involved (`nearlyEqual` in `src/decimal.js`); a 0.15 % transfer fee is far outside that band.

For a `Payment`: `crossed` lists offers consumed on the way, with their deltas; `request.delivered` is observed from the metadata; `spent` is the sender's own balance change in the `SendMax` currency (`payment.spent`); `fill` is not applicable; `amm` is a rule when a pool's `AccountRoot` is in the record and a hypothesis when only its trust lines moved.

### BalanceFacts

`balanceChanges(meta)` keeps its numeric `delta`/`before`/`after` for the display layer and now also carries `exact: { before, after, delta }` as strings (drops for XRP, decimals for issued currencies) and `node`, the index of the entry it came from.

## Rules

| Rule id | Tier | States | Conditions (the evidence) |
| --- | --- | --- | --- |
| `node.action` | observed | created / modified / deleted | The wrapper key of the `AffectedNodes` entry. |
| `offer.identity` | observed | owner, sequence, expiration, sell | `FinalFields` / `NewFields`. |
| `offer.amounts.after` | observed | amounts at the end | `FinalFields.TakerGets`, `.TakerPays` (or `NewFields`). |
| `offer.amounts.before` | observed | amounts before | `PreviousFields.TakerGets`, `.TakerPays`. |
| `offer.amounts.before.unchanged` | observed | before equals after | `PreviousFields` absent or carrying no amount. |
| `offer.trade.previous-fields` | calculated | traded: yes / no | Presence of an amount in `PreviousFields`. |
| `offer.trade.delta` | calculated | gave, got | before − after, per side. |
| `offer.role` | rule | submitter-new / submitter-old / book | owner vs `tx.Account`; action. |
| `offer.placed` | observed | the submitter's remainder on the book | A `CreatedNode` Offer owned by `tx.Account`. |
| `offer.modified.partial` | calculated | partly consumed | modified and traded. |
| `offer.modified.other` | observed | updated without trading | modified, `PreviousFields` carries no amount. |
| `offer.removal.cancelled` | rule | cancelled | `OfferCancel` by the owner naming this `Sequence` as `OfferSequence`; not traded. |
| `offer.removal.replaced` | rule | replaced | `OfferCreate` by the owner naming this `Sequence` as `OfferSequence`; not traded. |
| `offer.removal.self-cross` | rule | self-cross | `OfferCreate` by the owner, a different `Sequence`, not traded. The ledger removes an account's older offer on the opposite side rather than trading it against itself. |
| `offer.removal.consumed` | rule | consumed | traded, and both final amounts are zero. |
| `offer.removal.traded-unfunded` | rule | traded-then-removed-unfunded | traded, and a final amount is above zero: the funded part traded and the rest left the book. |
| `offer.removal.cleanup` | rule | cleanup-without-trade | deleted, not traded, owned by someone other than the submitter (or by the submitter in a `Payment`). Expired or unfunded; `expired` says which when it can. |
| `offer.removal.unresolved` | — | unresolved | None of the above. |
| `exchange.request` | observed | the request | `tx.TakerGets`, `tx.TakerPays`, `tx.Flags`. |
| `exchange.book` | calculated | received / spent from the book | Sum of crossed offers' deltas by currency. |
| `exchange.bridged` | calculated | bridged through XRP | A crossed offer's pair differs from the request's. |
| `exchange.amm` | rule | filled (in part) by an AMM pool | Modified `AccountRoot` with `AMMID`; its balance delta, or its trust lines' deltas. |
| `exchange.amm.suspected` | hypothesis | may have been an AMM | Balance moved for an account that owns no crossed offer and whose `AccountRoot` is absent. |
| `exchange.received`, `exchange.spent` | calculated | totals | book + amm. |
| `exchange.fill` | calculated | filled / partial / none / unresolved | achieved vs requested on the side the flags select. |
| `exchange.fill.rounding` | calculated | filled within rounding | shortfall > 0 and below one part in 10¹⁰. |
| `exchange.fill.ioc` | rule | remainder not placed by design | `tfImmediateOrCancel` set. |
| `exchange.fill.fok` | rule | all or nothing | `tfFillOrKill` set and `tesSUCCESS`. |
| `exchange.corroboration.xrp` | calculated | exact / mismatch / unavailable | Submitter's `AccountRoot` delta vs ±amount − `Fee`. |
| `exchange.corroboration.issued` | calculated | exact / consistent-with-transfer-fee / mismatch / unavailable | Submitter's trust-line delta vs ±amount. |
| `payment.delivered` | observed | what arrived | `meta.delivered_amount`. |
| `payment.crossed` | calculated | offers consumed on the way | Offer nodes with `traded: yes`. |
| `payment.spent` | calculated | what the sender paid | The sender's own balance delta in the `SendMax` currency, the fee removed when that is XRP. |
| `balance.xrp` | calculated | before / after / delta in drops | `AccountRoot` `Balance` before and after. |
| `balance.issued` | calculated | before / after / delta, both sides | `RippleState` `Balance` before and after; the high account sees the negation. |
| `result` | observed | result code and family | `meta.TransactionResult`. |

## Hypotheses tested against real fixtures

Three readings of a deleted Offer were hypotheses when this layer was designed. They were tested against real mainnet records (`test/fixtures/facts/`, each with its outcome in the `hypotheses` field of its `.expected.json`) and against a scan of 300 consecutive validated ledgers (#107811389–#107811688, 62,968 transactions, 10,113 deleted and 308 modified Offer entries):

1. **A `DeletedNode` with no `PreviousFields` amounts left the book without trading.** Confirmed. Of 9,841 such entries, 9,833 were the submitter's own offer named by `OfferSequence` (replace or cancel), 1 was the submitter's own offer on the opposite side of its new one (self-cross, `2E505251…`), and 7 were other accounts' offers swept off the book; the swept ones were either expired (`50DA65F6…` node 2, `7E6FE52D…` node 43, and `5DB7C7D4…` node 10 inside a Payment, each a few seconds past its `Expiration`) or unfunded (`503514A7…` node 1: no expiration, and its owner's XRP balance, untouched by the transaction, equalled its reserve). In every case the owner's balances did not move.
2. **`PreviousFields` present with `FinalFields` amounts at zero is fully consumed.** Confirmed on 266 entries; in the fixtures (`EE75811B…` node 9, `BDA7EDF8…` node 3 and others) the owner's balance moved by exactly what the offer got.
3. **`PreviousFields` present with `FinalFields` amounts above zero traded and was removed with its remainder unfunded.** Confirmed on 6 entries, two of them in `57F75F6F…` (nodes 4 and 13): each owner's trust line in the currency it was giving went to zero (it gave everything it held) and its XRP rose by exactly what it got, while the entry's remaining `TakerGets` was still above zero.

Also observed: `PreviousFields` on an Offer either carries both `TakerGets` and `TakerPays` or neither (never one side) in all 10,421 entries; no offer owned by the submitter was ever recorded as traded; and all 260 OfferCreates that touched an AMM carried `AMMID` on the pool's modified `AccountRoot`, none modified the `AMM` entry itself, and 24 crossed the book as well.

## Renderers

`summarize(tx, meta)` and `describeAffected(meta, tx)` in `src/explorer/anatomy.js` remain the sentence builders, now rendered over `facts()`. `explain(tx, meta)` returns the same headline as `{ text, sentences: [{ text, rules, findings }] }`; `describeAffected` entries carry `rules` and `findings` beside `summary`. Wording was changed only where the findings do not support the old sentence.

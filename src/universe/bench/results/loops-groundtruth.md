# Shared price: the ground truth on the recording

Searched 1,385 ledgers and 239,536 transactions of `stream-mainnet-2026-10-23T04-34-01-552Z.ndjson` for loop-takes by the rule of docs/universe.md, Part A: self-payments (Account equals Destination) that consumed offers, and same-ledger pairs (an OfferCreate by X, a cross-currency Payment by Y consuming X's new offer).

- successful self-payments seen: 7,588; of them consuming offers: 753; of those, conversions (the asset sent differs from the asset delivered, so not a loop): 753; circular (a loop-take by rule 1): 0
- the shapes of the offer-consuming self-payments: XRP → token 445; token → XRP 304; token → token 4
- same-ledger pairs (rule 2): 0
- consumed offers created in the same ledger as the take (which the state at the ledger before could not hold): 0
- loop-takes checked: 0; the loop taken appeared with the same offers at the ledger before: **0**; a loop with some of its offers: 0; takes whose offers were created before the window (unseen, so the state could not hold them): 0
- offers first seen modified (created before the window): 107; issuers with a TransferRate seen: 0

## No loop-takes

None by either rule in what was searched: 7,588 successful self-payments, 753 of them consuming offers and every one of those a conversion between two different assets (a single leg, not a loop); no same-ledger OfferCreate-and-cross-currency-Payment pair. The measure's loops cannot be checked against a taken loop on this recording; the synthetic tests stand, and the check reruns on the next recording.

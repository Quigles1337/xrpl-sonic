# Universe: the ledger as a sky

A dedicated page where the ledger is a sky: accounts are planets, transactions are celestial objects, zoom runs from one transaction's anatomy out to the subnetworks forming as the ledger grows, and time is the fourth dimension on the existing transport. This document is the specification, written before the build, and below it the record of the spike that measured whether the design holds. The ground rules of every session hold: read before writing, never assume a value, no dependencies, no build step, keyboard and reduced-motion paths from the start, public live data only, no forensic case identities anywhere. It follows [facts.md](facts.md), whose tiers it uses, [coherence.md](coherence.md), whose statistic names its pulsars and pairs, [save-this-moment.md](save-this-moment.md), whose live window it reads, [copy-for-ai.md](copy-for-ai.md), whose text it reuses, and [ux.md](ux.md), whose mode vocabulary (Listen, Watch, Learn; Settings as a panel) it speaks.

Status: a spike on a branch that will not merge (`feat/universe-spike`: `universe.html`, `src/universe/`, `test/universe*`). Phase 1 waits for the owner's decisions listed at the end. The requests to shared modules are in [universe-requests.md](universe-requests.md).

## The two principles

**The observed universe.** The page shows what it has seen: the live stream for the minutes watched, plus whatever the viewer explores. It never claims completeness. A coverage line stays on screen at all times and says, in this order: how long it has listened, how many ledgers closed and which, how many transactions it heard of how many those ledgers held (`txn_count`), how many arrived for ledgers not yet closed, how many planets it has, which node it hears, and that this is what the page has heard, not the ledger. Before the first close it says it has observed nothing yet; disconnected, it says so; a synthetic sky (the measuring mode) says nothing here is the ledger. The line is a `role="status"` region, so a screen reader hears every change. The stream is not ordered (a ledger's transactions arrive before and after its close, older ledgers' transactions trickle in several ledgers late, [save-this-moment.md](save-this-moment.md), "What the stream is like"), so coverage counts closed ledgers only and names the provisional rest apart.

**Every body is earned by data.** A planet is a planet because of a property in the record, and each body's rule is written down before it is drawn. The rules below carry the tiers of [facts.md](facts.md): `observed` is a field read as recorded, `calculated` is arithmetic over observed fields, `rule` is a named interpretation whose conditions are the evidence, `hypothesis` is a reading the record is consistent with but does not establish, and `observation` is the coherence tier (a correlation at a lag is what the series show). A body whose rule is not `observed` says its tier in its text equivalent. Nothing is drawn because it would look good; a row the data cannot support is not drawn, and the table says so.

## The vocabulary

The brief's vocabulary, row by row, with the rule that earns each body, the field it reads, and whether the spike could support it. "Stream" means the row is earned from the live `transactions` stream alone; "explorer" means it needs an account read (`account_info`, `account_lines`, `account_objects`, `account_nfts`), which is phase 2.

| Body | Earned by | Tier · rule id | Read from | Drawn as | Status |
| --- | --- | --- | --- | --- | --- |
| **Planet** | An account named in a validated transaction the page heard: submitter, Destination, an owner of a ledger entry in the `AffectedNodes`, or a side of a RippleState. | observed · `planet.seen` | the record | A disc. Size from log10 of the XRP balance, read from the account's `AccountRoot.FinalFields.Balance` the last time its root was in a record (every submitter's root is, since it paid a fee); an account whose root has not been seen is drawn small and hollow, never guessed. Hue from the sigil (`src/explorer/sigil.js`: the same hash, so a planet matches its mark in the explorer). Glow from activity: a count of its records decayed by half every six ledgers. | **Kept.** Stream. |
| **Rings** | Trust lines whose RippleState was in a record the page heard, with the peer; a ring is funded when the line's `Balance` is not zero as last seen. | observed · `line.seen` | `RippleState.LowLimit/HighLimit.issuer`, `Balance` | Up to five tilted ellipses around the planet, one per funded line; the full set of an account's lines needs `account_lines`. | **Kept, partial.** Stream for lines seen; explorer for the full set. |
| **Star** | An issuer: a RippleState names it the issuing side to at least three distinct holders. Which side issued: the balance is kept from the low side's view, so a positive balance means the low side holds the high side's issue (`line.issuer.balance`, calculated); at zero, the side that set a limit is the holder (`line.issuer.limit`, rule); both limits set at zero balance is unresolved and names no issuer. | rule · `star.issuer` | RippleState sides, `Balance`, the limits | The planet with four spikes; holders are planets linked to it by trust edges. The threshold (three) is a parameter. | **Kept.** Stream. |
| **Binary star** | An AMM pseudo-account: its `AccountRoot` carries `AMMID`. Its providers are the accounts whose `AMMDeposit`, `AMMWithdraw` or `AMMCreate` touched it. | observed · `binary.ammid` | `AccountRoot.AMMID` | Two discs. The LP token is an issued currency of the pool, so its holders are also stars' holders by the star rule. | **Kept.** Stream. |
| **Black hole** | Master key disabled (`lsfDisableMaster`, 0x00100000) and the regular key absent or one of the four unusable addresses (`rrrrrrrrrrrrrrrrrrrrrhoLvTp`, `rrrrrrrrrrrrrrrrrrrrBZbvji`, `rrrrrrrrrrrrrrrrrNAMEtxvNvQ`, `rrrrrrrrrrrrrrrrrrrn5RM1rHd`). A SignerList would make the account usable again and the stream cannot see one, so from the stream this is a candidate; the explorer's `account_objects` settles it. The brief's "at the centre of a frozen token system" is a second observed property, `lsfGlobalFreeze` on the same root, drawn as a frozen mark; the two are independent. | hypothesis · `blackhole.candidate` | `AccountRoot.Flags`, `RegularKey` | A dark core with a bright rim. The binary-star rule comes first: an AMM pseudo-account also has its master disabled. | **Changed:** candidate from the stream, rule in the explorer. |
| **Comet** | A `Payment` record. Tail from the path length (the longest path in `Paths`, plus one). Dust: a payment under one XRP; a meteor shower is a run of dust from one sender. | observed · `comet.payment` | the record | A head travelling from the sender's planet to the receiver's over one ledger interval, the tail behind it; dashed when it failed. Dust is faint and brief. | **Kept.** Stream. |
| **Long-period comet** | An `EscrowCreate` with `FinishAfter`; it returns at that time. `EscrowFinish` and `EscrowCancel` are the return. | observed · `comet.escrow` | `FinishAfter` | A dotted comet; the return date in its text. Its return is only drawn when the page is still listening then. | **Kept.** Stream. |
| **Asteroid belt** | The brief says "open offers between a pair". An offer is between an account and a book (a currency pair), not between two accounts, so the row is re-earned: a planet's open offers are its `Offer` entries created minus deleted in records the page heard. | observed · `offers.open` | `Offer` entries by `Account` | In the spike, a count in the planet's text. Phase 2 draws the belt around the book: the open offers of one currency pair as asteroids around the issuer star. | **Challenged, changed.** Stream for the count. |
| **Moons** | NFTs. The stream shows `NFTokenMint`, `NFTokenAcceptOffer` and the `NFTokenPage` entries they modify, but a page's owner is encoded in its index and ownership moves on accept, so the stream cannot say how many NFTs an account holds now; `account_nfts` can. | observed · `nft.minted` (count); explorer for ownership | the record; `account_nfts` | In the spike, the number minted in the planet's text; moons as bodies wait for phase 2. | **Challenged.** Count from the stream; moons from the explorer. |
| **Pulsar** | An account with a measured cadence: `cadenceOf` in `src/coherence.js`, its self-correlation of at least 0.3 at a lag of two or more over the live window (12 ledgers and 10 events are the guard). | observation · `pulsar.cadence` | the coherence frame | A beam that flashes at the period (still under reduced motion). Today the cadence is reached only through a judged pair of the top eight submitters ([universe-requests.md](universe-requests.md) R3). | **Kept, partial.** |
| **Binary pair** | Two accounts that clear coherence's prewhitened bar: `significant()`, the 95th percentile on a null of at least twenty shifts, among the top eight submitters of the live window. The label is "in step at lag L" and the record check, "connected in the record: N" or "not touching", and never "coordinated". | observation · coherence | the coherence report | A dashed line between the two planets with the label at its middle. | **Kept.** Stream, every ten ledgers. |
| **Nebula** | A connected group of planets: two planets are in one cluster when a transaction named them together at least twice in the window and neither is a hub (more than 40 distinct counterparties; an exchange or a market maker is a star of its own, not a nebula's glue). One level of clustering, by union-find: it merges as edges arrive and never splits, so a planet that becomes a hub later keeps the unions it made before. A nebula is a cluster of at least five. | rule · `nebula.cluster` | the edges | A soft cloud at the cluster's centroid with its rms radius, drawn at far zoom only. | **Kept, with the hub rule.** The thresholds are parameters. |
| **Birth** | A `CreatedNode` AccountRoot in a record: the account was funded into existence by that payment. | observed · `planet.birth` | `AffectedNodes.CreatedNode` | The planet appears bright; "born in this window" in its text. | **Kept.** Stream. |
| **Collapse** | A `DeletedNode` AccountRoot: an `AccountDelete` succeeded. | observed · `planet.collapse` | `AffectedNodes.DeletedNode` | A faint cross; the planet dims and stays as a remnant for the session. | **Kept.** Stream. |
| **Flash** (new) | Any transaction that is not a payment or an escrow (offers, trust sets, NFT offers, account settings, tickets, checks, batches): it happened at the submitter's planet. | observed | the record | A ring expanding from the planet in the category's colour, dashed when it failed. | **Added.** Stream. |

One finding of the spike's hour against mainnet belongs here: `Batch` transactions were 43% of the messages in the first minute and the largest single type over the hour (see the measurements). While the spike ran, the listening page gained a glyph of its own for them (#30: category `batch`, three motes under one bracket, colour `#d4a373`; `categorize` now returns `batch`, which the spike, written against the eight earlier categories, folds into `other`). In the sky they are flashes; whether they take the new colour or a body of their own is an owner's decision.

## Levels of detail

The camera is the perspective camera of the plate and the constellation (`src/projection.js`: yaw, pitch, distance, field of view, target), copied into the spike. What aggregates at each distance:

| Level | Camera | What is drawn | What aggregates |
| --- | --- | --- | --- |
| **The sky** | far (distance above about 2.4 sky radii) | Every planet as a point of its hue and glow; nebulae as clouds; comets as lines; no labels but the focused planet's. | Clusters into nebulae; a hub's satellites into its shell. |
| **Planets with orbits** | middle (about 0.8 to 2.4) | Planets as sprites sized by balance; the fourteen largest labelled; rings on the near ones; pairs in step with their labels; flashes. | Nothing aggregates; the far points are still points. |
| **One planet's system** | near (below about 0.8), or a planet focused with `[` `]` or a click | The planet as a body with its rings, its kind's mark and its text equivalent; its counterparties around it. Phase 2 arranges the system by time: the planet's records laid out as orbits, each counterparty a planet on the orbit of the ledger it was named in, so a system reads as a clock. | The far sky behind it. |
| **One transaction's anatomy** | a comet or flash clicked (phase 2) | The explorer's transaction page (`explorer.html#tx/<hash>`), which already explains a transaction from its own metadata with the facts layer. Nothing is duplicated. | — |

Pixel levels in the renderer, by a planet's projected radius: a **splat** under 2.6 px (written into a pixel buffer with a small additive kernel, one `putImageData` for all of them), a **sprite** from 2.6 to 8 px (a cached glow blitted at size), a **body** from 8 px (gradients, rings, marks, label). The thresholds and the base size (one pixel for a size-one planet at the reference depth) are the spike's measured choice; the measurements say why.

## Layers

Four toggles, each a key: **payment** (P: comets and dust, escrows' long-period comets), **trust** (T: rings and trust edges), **DEX** (D: flashes of offers and AMM transactions), **NFT** (N: flashes of NFT transactions). Everything else (account settings, tickets, checks, batches) is always drawn as a quiet flash. A layer off hides its comets, flashes and rings; planets never hide, because a planet is earned by any record. The layer state is not in the URL in the spike; whether it joins the settings is an owner's decision.

## Time

Live, time is now: comets fly over the current ledger interval, glow decays per ledger, the coverage line grows. Phase 3 puts time on the existing transport (`src/transport.js`: play, pause, step, seek, loop, speed, the same keys as the listening page, K , . L [ ]). The design decision that makes scrubbing cheap: **the layout is not rewound**. Positions are a function of the record so far and stay where they are; what time changes is which comets are in flight, which planets glow, which planets have been born, and the coverage line's "so far". Scrubbing back means re-dimming planets born after the position and replaying comets from the compact records of the window; the records are kept for exactly this (the worker keeps up to 250,000, the spike measured how many an hour is). A moment saved from the sky is a case (`momentFromLive`), as it is on the listening page, and opens on the listening page and in the explorer like any other.

## Sound

The listening page's engine (`src/audio.js`) plays the sky: the worker computes `txToEvent` for every record and posts the fields the engine reads; the page calls `play(event)` with the ledger interval and the expected count set as the listening page sets them, so bursts are spread and the polyphony cap holds. Off by default; the S key and the Sound button turn it on from a gesture, which is what the browser requires. Phase 1 schedules each note at its comet's arrival with `playAt` so what you hear is what lands; the cast voices are a Watch feature and stay on the listening page.

## The text equivalent

A screen reader travels the same sky. `[` and `]` move a focus from planet to planet, brightest first, and the focus line (a `role="status"` region) reads the planet's text equivalent (`describeBody` in `src/universe/bodies.js`): its name (the on-ledger Domain when its root carried one, else the short address), its kind in words with the rule when the tier is not observed, its balance or that the balance has not been seen, its records and ledgers, its rings and funded rings, its open offers, what it minted, whether it was born in this window and when it was last seen, and a link to the explorer. Enter opens the explorer's account page. The coverage line is read as it changes. The sky canvas itself has a role and a label that say what the sky is and how to travel it. Phase 2 adds a **Copy for AI** of the sky: the minutes watched as a case (`momentFromLive`) rendered by `describe()` ([copy-for-ai.md](copy-for-ai.md)), which already says every event and finding in text, plus a "sky" section listing the bodies and their rules in the words above. Reduced motion (`prefers-reduced-motion`): the camera does not turn, comets are still lines that fade, pulsar beams do not flash, and the focus ring does not animate.

## Reused and new

| Reused as is (imported, read-only) | New (under `src/universe/`) |
| --- | --- |
| `src/ws.js` (`XrplStream`, `NETWORKS`): the stream, in the worker. | `records.js`: compact records; `rootsOf`, `linesOf`, `issuerOfLine`, `offersOf`; the interner. |
| `src/mapping.js`: `unwrapTransactionMessage`, `extractAmount`, `categorize`, `txToEvent`, `hashString`, the category colours. | `universe.js`: the observed universe (planets, edges, ledgers, coverage, the coverage line). |
| `src/moment.js` (`LiveWindow`) and `src/coherence.js` (`frameFromLive`, `coherence`, `significant`): pulsars and pairs. | `bodies.js`: the body rules, the comet kinds, the text equivalent. |
| `src/explorer/sigil.js` (its hash): the hue. `src/explorer/anatomy.js` (`decodeDomain`): the name. | `layout.js`: the incremental layout (homes by hash, warm set, degree-scaled rest lengths, grid aggregates). |
| `src/audio.js` (`AudioEngine`): the sound. `src/explorers.js` (`explorerUrl`): the links. | `cluster.js`: one level of clustering. `synthetic.js`: the seeded stream for measuring. |
| `src/projection.js`: copied verbatim (request R1 asks for a shared view matrix). | `worker.js`, `sky.js` (2D), `sky-gl.js` (WebGL), `main.js`, `universe.css`, `universe.html`; `bench/` (the harness and its results). |

## Phases

1. **The live sky, whole.** Every transaction for the minutes watched; planets with the three levels; the coverage line; the body rules of the table marked "stream"; layers; keyboard travel and the text equivalent; reduced motion; sound through the engine, scheduled at arrival. Acceptance: an hour on mainnet at the measured rates with the frame time and memory within the budgets below; the headless checks; tests on the recorded fixtures for every rule; the coverage line verified against `txn_count` on a recorded window.
2. **Exploration.** Open a planet: `loadAccount` reads its root, lines, objects and NFTs at one validated ledger ([facts.md](facts.md)'s part states); the rings become the full set, the black hole candidate becomes a rule or is dismissed by a SignerList, moons appear from `account_nfts`, the belt around a book from `book_offers`; counterparties from `account_tx` become planets arranged by time; a comet or flash opens the explorer's transaction page; Copy for AI of the sky. Requests R4, R7 belong here.
3. **Time scrubbing.** The transport over the window's records, as above; a moment saved from the sky.
4. **Tours.** The Learn mode's form: a case with annotations that moves the camera (a `camera` anchor in the annotation, an owner's decision), reusing the transport and captions; three tours to start, mirroring the listening page's (the legend of bodies, follow a payment, a pulsar).

## The spike

What was built on `feat/universe-spike`, what it measured, and what the numbers say. The harness is `src/universe/bench/`: `stream-hour.mjs` (the stream alone, in Node), `serve.mjs` (a static server with the two cross-origin-isolation headers that `performance.measureUserAgentSpecificMemory` needs), `cdp.mjs` and `frames.mjs` (frame time per renderer and size in headless Chrome), `hour.mjs` (an hour of the live sky in headless Chrome, memory and frame time each minute). Results are JSON under `bench/results/`. Real-GPU frame times were taken in the user's own Chrome through the same page's `window.xrplUniverse.stats()`.

### Built

- A Web Worker owns the stream, the compact records, the planets and edges, the layout, the clustering and the coherence; it posts positions as a transferable `Float32Array` whenever the layout moved (at most every 120 ms) and, at every ledger close, the planet attributes, the comets of that ledger, the nebulae, the pairs, the events for the sound and the coverage.
- Compact records (`records.js`) and the observed universe (`universe.js`), proven on the real fixtures of the facts layer: the AMM pool comes out a binary star, a well-held issuer a star, a payment's destination a touched entry, a crossing offer's book owners touched entries with the trust lines told apart.
- An incremental layout (`layout.js`): homes by hash, a warm set of twelve ledgers, cold planets frozen, edge springs with degree-scaled rest lengths, crowd repulsion from grid aggregates. One level of clustering (`cluster.js`).
- Two renderers behind one interface: a 2D canvas with three pixel levels (`sky.js`) and a hand-written WebGL point renderer with the camera in the vertex shader (`sky-gl.js`), both with the same comets, flashes, nebulae, pairs, labels, focus and hit test, both measuring their own frame time and level counts.
- The page (`universe.html`, `main.js`): Start/Stop, the four layers, Sound, the coverage line, the focus line, keyboard for everything, reduced motion, `?synthetic=N` for measuring, `?gl=1` for the WebGL path.
- 29 tests under `test/universe-*.test.js`: records and readers on real metadata, every body rule and its precedence, coverage and the coverage line, the layout's homes and stability, clusters, the synthetic stream.

### Measured

All numbers below are read from the result files by `bench/report.mjs`; nothing is typed by hand. The machine: 24 logical cores, Windows 11, Brave (Chromium 155) as the real browser, which masks its GPU string. Two versions of the spike were measured: the two hour runs started before the renderer and the layout were retuned, so they ran the earlier code (base size 1.8 px, no splat level, repulsion scanned every neighbour); the frame-time matrices and the live checks ran the final code. The hour runs' memory and coverage numbers do not depend on that difference; their frame times and layout steps do, and the matrices below are the ones to read for those.

#### What the stream delivers

**The stream alone** (`stream-hour.mjs`, Node, mainnet, xrplcluster.com, 60.21 min from 2026-10-22T23:06:46.101Z):

| Measure | Value |
| --- | --- |
| Ledgers closed | 925 (922 per hour) |
| Transactions heard (distinct hashes) | 139,768 (139,285 per hour; 2,070 in the median minute, 19,162 in the busiest) |
| Distinct accounts named (all parties, including the metadata's entry owners) | 12,696 (12,652 per hour; new accounts per minute fell from 945 in the first to 64 in the median later minute) |
| Distinct submitters per minute (median) | 645 |
| Coverage against txn_count | 100.00% (139,768 expected) |
| Duplicate deliveries | 28,028 |
| Failed (tec) among heard | 28,059 (20.1%) |
| Raw JSON received | 482.2 MiB (3,013 bytes per transaction) |
| Compact record (typed-array estimate) | 73 bytes per transaction (9.7 MiB for the hour) |
| Transaction types, largest first | Batch 51,650 · OfferCreate 34,397 · Payment 34,323 · TicketCreate 7,573 · OfferCancel 4,159 · NFTokenCreateOffer 2,404 · AccountSet 2,203 · CheckCash 1,573 |

What this says for the sky: at this hour's rate the sky gains about 12,700 planets in its first hour and the curve flattens (945 new accounts in the first minute, 64 in the median later minute, since most of a minute's accounts have been seen before), so 20,000 planets is roughly two hours of listening and the right size to test. A record costs 73 bytes in a typed-array store against 3,013 bytes of JSON on the wire, a ratio of 41; the JS objects the spike keeps cost about 310–330 bytes per record all in (the worker's heap growth over the hour divided by its records, planets, edges and the live window included), so a typed-array store would be about 4.5 times smaller than the spike. Batch was 37% of the hour's transactions (and 43% of the first minute's), ahead of OfferCreate and Payment; its inner transactions arrive as their own messages. One in five transactions failed with a tec code and is in the record. The cluster re-delivered 28,028 transactions in 12 of the 60 minutes, tracking volume (r 0.9 with transactions per minute, 0.17 with failures): deduplication by hash is not optional, and coverage against `txn_count` was exactly 100% after it.

#### An hour of the live sky

**An hour of the live sky in headless Chrome, 2D canvas** (`hour.mjs`, universe.html?autostart=1&gl=0, 60 samples):

| Minute | Planets | Records | Edges | Heap (page) | Measured (page + worker + canvas) | Worker JS | Frame mean / p95 | Layout step | Coverage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 299 | 1,326 | 202 | 6.7 MiB | 17.9 MiB | 3.9 MiB | 47.0 / 121.4 ms | 41.7 ms, 227 warm, moved 2.09‰ | 70.81% |
| 5 | 5,589 | 22,845 | 4,220 | 6.8 MiB | 29.1 MiB | 13.3 MiB | 77.3 / 285.3 ms | 13.4 ms, 1,869 warm, moved 0.10‰ | 99.54% |
| 10 | 6,473 | 39,589 | 5,850 | 10.3 MiB | 33.5 MiB | 17.4 MiB | 20.2 / 23.7 ms | 7.2 ms, 1,496 warm, moved 0.20‰ | 98.13% |
| 20 | 7,805 | 68,296 | 8,521 | 24.9 MiB | 41.1 MiB | 24.6 MiB | 253.1 / 446.9 ms | 143.3 ms, 1,190 warm, moved 1.21‰ | 99.17% |
| 30 | 8,701 | 86,639 | 10,006 | 30.3 MiB | 48.1 MiB | 30.9 MiB | 220.7 / 403.2 ms | 10.2 ms, 650 warm, moved 0.30‰ | 99.74% |
| 45 | 11,229 | 133,077 | 13,764 | 35.5 MiB | 62.2 MiB | 44.5 MiB | 376.7 / 586.6 ms | 79.2 ms, 1,012 warm, moved 0.32‰ | 99.94% |
| 60 | 12,773 | 180,217 | 17,679 | 23.1 MiB | 74.5 MiB | 56.6 MiB | 326.5 / 596.7 ms | 11.6 ms, 330 warm, moved 1.08‰ | 99.97% |

Coherence over the live window at minute 60: 28 pairs tested among the top submitters, 4 above the 95th prewhitened (chance about 1.4), 58 ms per run in the worker.

**An hour of the live sky in headless Chrome, WebGL** (`hour.mjs`, universe.html?autostart=1&gl=1, 60 samples):

| Minute | Planets | Records | Edges | Heap (page) | Measured (page + worker + canvas) | Worker JS | Frame mean / p95 | Layout step | Coverage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 279 | 1,215 | 176 | 6.1 MiB | 16.0 MiB | 2.7 MiB | 4.4 / 26.9 ms | 113.4 ms, 221 warm, moved 2.48‰ | 94.90% |
| 5 | 5,589 | 22,845 | 4,220 | 16.9 MiB | 27.4 MiB | 13.3 MiB | 1.5 / 1.8 ms | 11.1 ms, 1,851 warm, moved 0.10‰ | 99.54% |
| 10 | 6,473 | 39,589 | 5,850 | 27.7 MiB | 31.6 MiB | 17.3 MiB | 1.9 / 2.2 ms | 7.2 ms, 1,491 warm, moved 0.20‰ | 98.13% |
| 20 | 7,712 | 65,563 | 8,342 | 34.2 MiB | 39.1 MiB | 24.8 MiB | 18.6 / 53.3 ms | 39.0 ms, 416 warm, moved 0.54‰ | 99.66% |
| 30 | 8,653 | 85,140 | 9,899 | 5.5 MiB | 60.5 MiB | 30.2 MiB | 24.0 / 75.5 ms | 41.2 ms, 343 warm, moved 0.81‰ | 100.00% |
| 45 | 11,110 | 129,205 | 13,615 | 30.7 MiB | 69.9 MiB | 43.6 MiB | 32.6 / 93.3 ms | 83.0 ms, 1,007 warm, moved 0.39‰ | 99.92% |
| 60 | 12,739 | 178,590 | 17,521 | 37.2 MiB | 83.4 MiB | 56.6 MiB | 38.2 / 101.4 ms | 79.0 ms, 420 warm, moved 0.86‰ | 99.97% |

Coherence over the live window at minute 60: 28 pairs tested among the top submitters, 8 above the 95th prewhitened (chance about 1.4), 1,282 ms per run in the worker.

Memory after one hour: 74.5 MiB (2D) and 83.4 MiB (WebGL) measured in total by `performance.measureUserAgentSpecificMemory`, of which the worker's JavaScript is 56.6 MiB in both (the records, planets, edges, the layout's arrays and the 50-ledger live window for coherence), the canvas 10–12 MiB, and the page's own heap 23–37 MiB depending on when the garbage collector last ran. Growth is linear in records, about 330 bytes each, so the spike's cap of 250,000 records is about 80 MiB of worker heap: fine for a desktop, a reason for a smaller window or a typed-array store on a phone. Coverage settled at 99.7–100% from the third minute on (the first minute hears only part of the ledgers whose transactions began before the subscription); the lowest later sample was 93.3%, a minute in which the cluster was late with a ledger. Coherence over the live window (28 pairs among the top eight submitters) took 31 ms to 4.0 s per run every ten ledgers in the worker; at the hour's end 4 (2D run) and 8 (WebGL run) pairs were above the 95th prewhitened where chance gives 1.4, and the two runs disagree because they heard the stream a few seconds apart and judge different windows. That cost belongs in an idle slot, not on the ledger close.

Layout stability on the live stream: the planets present before a ledger moved a median 0.5‰ of the sky radius per step (minimum 0.06‰, maximum 2.1‰ in the 2D run and 7.0‰ in one WebGL sample), and a median 3.2% of them moved more than 5‰ in a step; the warm set was 184–2,738 planets, median about 750. Cold planets never move, by construction. The step took 7–13 ms in the quiet minutes and 39–143 ms in the dense ones with the old repulsion; the retuned layout, which reads the crowd off 27 grid aggregates instead of every neighbour, takes 1.0–5.7 ms with 944–13,305 planets warm (the matrices below) and 8–15 ms in the browser with 20,000 warm, where the old code took 2.6–10 s on a dense synthetic sky.

#### Frame time

**Frame time, the user’s own browser (GPU)** (Brave (Chromium 155) on the user’s machine, 1536×741 CSS px at DPR 2, GPU string masked by the browser; through the page’s stats() with the extension; views sampled 4 s each after the sky reached its size; the two headless hour runs had finished; the renderer's own time per frame, mean / p50 / p95 over the sampled frames, and how many planets fell in each pixel level at the home view):

| Renderer | Planets | Home view (draw ms mean / p50 / p95 · fps) | Closer | Inside | Levels at home (splat / sprite / body / culled) | Layout step (worker) |
| --- | --- | --- | --- | --- | --- | --- |
| 2d | 1,000 | 4.8 / 4.7 / 5.6 ms · 16 fps | 4.9 / 4.8 / 5.6 ms · 16 fps | 5.0 / 4.9 / 5.5 ms · 14 fps | 439 / 561 / 0 / 0 | 1.0 ms, 944 warm |
| 2d | 5,000 | 6.4 / 6.3 / 7.1 ms · 60 fps | 7.0 / 7.0 / 7.9 ms · 60 fps | 6.1 / 6.0 / 6.9 ms · 60 fps | 2,434 / 2,566 / 0 / 0 | 2.0 ms, 3,782 warm |
| 2d | 20,000 | 42.2 / 39.7 / 50.5 ms · 1 fps | 48.1 / 44.5 / 69.4 ms · 2 fps | 33.2 / 31.8 / 40.2 ms · 14 fps | 9,592 / 10,408 / 0 / 0 | 4.5 ms, 3,303 warm |
| webgl | 1,000 | 0.7 / 0.7 / 1.3 ms · 4 fps | 0.6 / 0.6 / 0.8 ms · 17 fps | 0.7 / 0.7 / 1.0 ms · 14 fps | 437 / 563 / 0 / 0 | 1.1 ms, 944 warm |
| webgl | 5,000 | 1.1 / 1.1 / 1.7 ms · 61 fps | 1.1 / 1.1 / 1.7 ms · 61 fps | 1.0 / 1.0 / 1.6 ms · 60 fps | 2,448 / 2,552 / 0 / 0 | 2.0 ms, 4,084 warm |
| webgl | 20,000 | 2.8 / 2.9 / 3.6 ms · 61 fps | 2.6 / 2.6 / 3.1 ms · 61 fps | 2.9 / 2.9 / 3.5 ms · 61 fps | 9,875 / 10,125 / 0 / 0 | 5.7 ms, 13,305 warm |

GPU string seen by the page: Brave.

**Frame time, headless Chrome (SwiftShader, software)** (`frames.mjs`, 6 s per view; the renderer's own time per frame, mean / p50 / p95 over the sampled frames, and how many planets fell in each pixel level at the home view):

| Renderer | Planets | Home view | Closer | Inside | Levels at home (splat / sprite / body / culled) | Layout step (worker) |
| --- | --- | --- | --- | --- | --- | --- |
| 2d | 1,000 | 38.4 / 35.7 / 94.9 ms | 40.9 / 37.1 / 138.4 ms | 40.0 / 38.7 / 90.5 ms | 438 / 562 / 0 / 0 | 7.0 ms, 924 warm |
| 2d | 5,000 | 134.0 / 128.9 / 264.7 ms | 142.5 / 133.9 / 307.0 ms | 46.5 / 35.6 / 115.2 ms | 2,493 / 2,507 / 0 / 0 | 232.6 ms, 4,084 warm |
| 2d | 20,000 | 453.0 / 407.5 / 766.2 ms | 421.8 / 408.5 / 687.6 ms | 150.5 / 131.2 / 280.0 ms | 10,022 / 9,978 / 0 / 0 | 352.9 ms, 15,122 warm |
| webgl | 1,000 | 9.1 / 2.8 / 35.4 ms | 6.1 / 0.8 / 25.4 ms | 8.4 / 1.2 / 30.6 ms | 453 / 547 / 0 / 0 | 64.5 ms, 955 warm |
| webgl | 5,000 | 27.8 / 28.7 / 55.4 ms | 28.0 / 31.0 / 58.7 ms | 24.1 / 22.7 / 56.4 ms | 2,505 / 2,495 / 0 / 0 | 305.1 ms, 4,084 warm |
| webgl | 20,000 | 30.9 / 9.1 / 106.4 ms | 31.8 / 35.0 / 71.4 ms | 21.8 / 20.7 / 45.7 ms | 10,170 / 9,830 / 0 / 0 | 185.3 ms, 15,122 warm |

GPU string seen by the page: ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver).

How to read the matrices. The headless numbers are a floor: SwiftShader rasterises in software and the 2D canvas there is far slower than on a GPU. The real-browser rows are the decision. The `fps` is the number of frames the page drew in the 4-second sample, which includes the GPU's own time outside `draw()`: at 20,000 planets the 2D canvas reports 42 ms of JavaScript per frame but draws one frame a second at the far views, because the sprite level's `drawImage` calls (about 10 µs each on the GPU canvas, measured by the renderer's phase timings) and the full-canvas `putImageData` upload at DPR 2 are paid on the GPU after `draw()` returns. The 1,000-planet rows were sampled while the browser throttled the tab (frame counts of 17–69 with sub-millisecond draws); their draw times stand, their fps do not.

The 2D canvas holds at 5,000 planets at 60 fps (6–7 ms a frame, half of them splats) and does not hold at 20,000 (1–2 fps at the far views, 14 fps inside). WebGL holds at 20,000 at 60 fps with 2.6–2.9 ms a frame at every view, and at 1,000 draws in under a millisecond. An hour of mainnet is about 12,700 planets, between the two; the 2D path would be at a few frames a second there. The hand-written WebGL path is two shaders and the buffer code in `sky-gl.js`, still no dependencies; the 2D path stays as the fallback the page already takes when WebGL is unavailable. Whether WebGL is permitted is the owner's decision (below); the measurement says it is needed for the far view of a sky older than about half an hour.

#### What the real data did that the design did not predict

- Batch is the largest transaction type on mainnet tonight (37% of the hour). The field guide gained a glyph for it while the spike ran (#30); the sky still draws it as a flash in the "other" colour, and the owner's decision 6 asks what it should be.
- The cluster re-delivers whole bursts (20% of the hour's messages were duplicates, in 12 minutes of 60). The listening page's hash deduplication was right; the sky deduplicates per ledger the same way.
- Issuers' balances are not seen: a star is named by its holders' trust lines, whose RippleState nodes carry no AccountRoot of the issuer, so most stars are drawn hollow until the issuer itself submits something or phase 2 reads `account_info`. Within two minutes of listening, the live sky had 11 stars, 13 AMM binaries, 3 black hole candidates and 6 pulsars among 806 planets, and the pulsar with a cadence of three ledgers was the market maker [coherence.md](coherence.md) measured at a cadence of three (self-correlation 0.96).
- A dense neighbourhood made the per-neighbour repulsion scan quadratic (seconds a step at 20,000 planets in the browser, 23 ms in Node on the same input before the input grew dense); aggregates per grid cell fixed it and are the layout now.
- The 2D sprite level costs about 10 µs a planet on the GPU canvas, so the pixel levels were retuned to put most of a sky's planets through the splat level (a 1 px base size: the median planet, with a balance of about 3 XRP, is a 1.3 px splat; the 90th percentile, about 2,900 XRP, 2.6 px; the 99th, about 16 million XRP, 4.2 px).
- The synthetic stream left one newborn without a record (an account paid by nobody) until the generator was told to pay every newborn; and the Claude in Chrome extension's parked pointer dragged the camera between measurements, so each view re-asserts its camera and disables pointer input while it samples.
- The duplicate count (28,028) and the failed count (28,059) over the hour are within 31 of each other by coincidence; minute by minute they do not track.

## The owner's decisions

Listed, not made. Each changes phase 1.

1. **Naming and labelling.** The spike labels a planet by its short address, and by its on-ledger `Domain` (decoded, [facts.md](facts.md)'s `decodeDomain`) when its root carried one in a record. Options: on-ledger Domain and the viewer's own labels only (the cast's labels, [case-format.md](case-format.md)); or a curated issuer list in the repository with a source for every entry (which the README would have to name as a source of names that are not the ledger's). The spike has no list.
2. **Persistence.** The spike keeps nothing: reloading starts an empty sky. Options: a local cache of the compact records (IndexedDB; the coverage line would then have to say which minutes are from a cache and which live); export as a file (a case for the window through `momentFromLive`, which exists, plus a records file of the spike's compact format); or nothing, as now. The compact record is 73 bytes in a typed-array store and about 10× that as the JS object the spike keeps.
3. **Art direction references.** The spike takes the observatory's tokens and the field guide's category colours and nothing else; planets glow in their sigil hue. References for the sky (a star atlas, an orrery, the cloud chamber already on the listening page) would settle the look of nebulae, comets and the marks of the kinds.
4. **Whether WebGL is permitted.** Still no dependencies: the WebGL path is two shaders and the buffer code in `sky-gl.js`. The measurements below say what each path costs at each size; the decision is the owner's. If WebGL is permitted, the 2D canvas stays as the fallback (the page falls back by itself when WebGL is unavailable) and the explorer's constellation could share the camera (request R1).
5. **The thresholds that make bodies.** Three holders for a star, forty counterparties for a hub, two namings for a cluster edge, five planets for a nebula, twelve warm ledgers, eight submitters for coherence. The spike's values are stated; they are parameters.
6. **Batch.** 43% of the first minute's messages and the largest type over the hour; a flash in the spike. A flash in the field guide's new Batch colour (#30), or a body of its own (a bundle: the inner transactions' comets leaving one planet together).
7. **Where the sky lives in the mode map.** A fourth door beside Listen, Watch and Learn; a page beside Explorer in every mode's top bar; or an entrance from Watch only. Request R12.
8. **A `camera` anchor in annotations** for the tours of phase 4, which would be the first field a case gains for a page other than the listening page.
9. **Whether the synthetic mode ships.** `?synthetic=N` is the measuring instrument; its coverage line says nothing here is the ledger. Keep it for the bench only, or keep it reachable.

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

## Phase 1: the live sky

The agreed specification of the first phase, written on the owner's decisions of 2026-10-23 (all nine, listed below) before the build; the as-built record follows it. Scope: every transaction for the minutes watched; planets with the three levels; the coverage line naming the host; sound from the engine; WebGL from the first commit with the canvas fallback, both tested, reduced motion in both; keyboard travel and the text equivalent. The boundaries are the session's: `universe.html`, `src/universe/`, `docs/universe*.md`, `test/universe*`, nothing else edited.

### Inherited from the plate

Until `docs/art.md` lands (decision 3) the sky invents no palette, type or motion: it inherits the plate's. The tokens of `src/styles.css` (copied verbatim into `src/universe/universe.css`, since the stylesheet is not the sky's to edit), the same monospace stack, the field guide's category colours (`CATEGORIES` in `src/mapping.js`, Batch's `#d4a373` included), the sigil hue for a planet, glow sprites rendered once per colour and blitted (the plate's cost discipline), the ignition of a new body (a scale-in with a little overshoot and a white-hot core, the plate's 220 ms and 180 ms, none of it under reduced motion), the pulse ring at a ledger close (a ring from the centre, as the plate's), the camera's slow turn with drag-to-orbit, scroll to move closer and double-click to reset, and the nebula layer's ink for the clouds. The marks of the kinds are the field guide's shapes, not new ones: a **star** carries the lattice's hexagon in the trust colour (a star is made of trust lines); a **binary star** the pool's three overlapping rings in the AMM colour; a **black hole candidate** is a disc struck through in the pulse colour, the plate's treatment of a cancelled offer, with a dark core; a **collapsed** planet is struck through and dim; a **pulsar** has no mark of its own: its ignitions recur at its cadence, which is what a cadence looks like; a **comet** is the photon with its tail; a **flash** is the pulse ring in the category's colour, a Batch in the Batch colour (decision 6).

### Names and labels

A planet's name is its on-ledger `Domain` when its account root carried one in a record (decoded as the explorer decodes it), else the Watch cast's label when the address is in the cast, else the short address (decision 1; a curated list with a source per label is phase 2 and never a verified-owner claim). The cast is the listening page's (`src/settings.js`, the same storage key, so a cast set in Watch is highlighted here; `#cast=` and `#account=` in the hash as the listening page reads them): a cast member's planet wears a ring in its cast colour and its label is always drawn (decision 7).

Every body's label prints the threshold of the rule that made it (decision 5), in the words of the vocabulary table: `star · 23 holders ≥ 3`; `binary · AMM pool · 2 providers`; `black hole? · master key disabled · key rrrr…BZbvji unusable · a SignerList would reopen it`; `pulsar · cadence 3 ledgers · r 0.96 ≥ 0.30`; `collapsed · account deleted`; a nebula's cloud reads `nebula · 12 planets ≥ 5 · edges ≥ 2 namings · hubs > 40 counterparties left out`. The thresholds are the spike's; the distributions they cut, from an hour of mainnet, are in the table below so a reader can see where each threshold falls.

### Levels and renderers

The three pixel levels stand (splat under 2.6 px, sprite to 8 px, body from 8 px, base size 1 px for a size-one planet at the reference depth). WebGL is the first renderer (decision 4): every planet a point sprite with the camera in the vertex shader, comets and flashes as lines, nebulae as soft points, and the marks and labels of the near bodies on a 2D overlay; the 2D canvas is the fallback the page takes by itself when WebGL is unavailable, and `?gl=0` asks for it. Both renderers share one data interface, one camera, one hit test and one text path, and both honour reduced motion: no turn, no inertia, no ignition flash, comets as still lines that fade, pulse rings still. The camera stays a copy of `src/projection.js` until R1 lands.

### Sound

The worker computes `txToEvent` for every record and posts the fields the engine reads (R9). The page schedules each note with `playAt(event, offset)` at its comet's arrival, or at its flash, with the same stagger across the ledger interval the comets fly on, so what you hear is what lands; the polyphony cap and the cooldowns are the engine's. Off by default; S or the Sound button turns it on from the gesture the browser requires.

### Coverage, persistence, the synthetic sky

The coverage line is the spike's: how long, which ledgers, heard of held, the provisional rest, the planets, the host (from the connection's endpoint; the node's own hostid when R11 lands), and that it is not the ledger. Nothing is persisted in this phase; the sky starts empty on load and will consume the local record cache the other session is building in its loader PR (decision 2), the export coming later from that cache. `?synthetic=N` stays behind its flag, labelled on the coverage line, never default (decision 9).

### Requests in flight, copies kept

R3, R8, R9, R10, R11 and R12 are being built by the other session as one PR; R2 lands in its loader PR; R1 later; R4 to R7 are phase 2. Each copy in `src/universe/` stays until its export lands and is then switched and deleted in the same PR: `projection.js` (R1), the hue computation in `bodies.js` (R8), the layer table in the renderers (R10), the minimal event shape posted by the worker (R9), the cadence read off judged pairs (R3), the host taken from the endpoint (R11), and the door into the sky (R12, which is the listening page's to add).

### Acceptance

1. `node --test` with the new tests on the recorded fixtures: the Batch category and colour, the labels with their thresholds, the cast highlight, the name rule.
2. Headless Chrome on both renderers: reduced motion, the status regions, `[` `]` travel with the focus line, Escape, `?`, the layer keys, Space, the arrows, `0`, S turning the engine on, and the WebGL camera agreeing with the JavaScript projection (a pixel read back where a planet projects is lit).
3. An hour on mainnet within the spike's measured envelope of frame time and memory.
4. The coverage line against `txn_count` on the recorded fixtures.
5. A person who does not know what a ledger is watched it for two minutes, and what they said, recorded here verbatim.

### Distributions

From `bench/distributions.mjs` against mainnet (xrplcluster.com), 60 minutes from 2026-10-23T01:26:16.885Z: 10,344 planets, 126,155 transactions heard of 126,155 (100.00%), 126,155 records kept. Each row is a threshold, what it cuts, and where the hour's values fell.

| Threshold | Rule | The hour’s distribution |
| --- | --- | --- |
| Star: holders ≥ 3 | An issuer named by its holders’ trust lines in the records heard | 544 issuers seen, 336 at or above the bar; holders per issuer: 1–1: 32 · 2–2: 176 · 3–4: 128 · 5–9: 111 · 10–49: 80 · 50–199: 14 · 200+: 3; quantiles p10 2 · p25 2 · p50 3 · p75 7 · p90 15 · p99 110 |
| Hub: counterparties > 40 | A planet with more counterparties never glues a cluster | 77 hubs of 10,344 planets; counterparties per planet: 0–0: 4,839 · 1–1: 1,554 · 2–2: 1,663 · 3–4: 1,435 · 5–9: 476 · 10–40: 300 · 41–199: 69 · 200–999: 8 · 1000+: 0; quantiles p10 0 · p25 0 · p50 1 · p75 2 · p90 4 · p99 30; the five busiest: 932 (planet, 1,234 submitted), 877 (star, 0 submitted), 793 (planet, 1,738 submitted), 607 (pulsar, 1,090 submitted), 333 (planet, 383 submitted) |
| Cluster edge: ≥ 2 namings; nebula: ≥ 5 planets | Two planets named together twice or more are one cluster; a cluster of five is a nebula | 94 clusters of two or more, 11 nebulae holding 1,010 planets, the largest 870; sizes: 2–2: 61 · 3–4: 22 · 5–9: 4 · 10–49: 6 · 50–199: 0 · 200+: 1; 1,106 unions, 9,309 edges refused for a hub |
| Pulsar: self-correlation ≥ 0.3 at a period ≥ 2 | A cadence from coherence over the live window, among the top 8 submitters | 18 accounts judged over 92 runs (53 ms each), 7 with a cadence at the last run; periods: 2–2: 3 · 3–3: 1 · 4–4: 1 · 5–7: 2 · 8+: 0; 98 distinct pairs ever in step |
| Planet size: log10 of the XRP balance | From the last AccountRoot seen; unknown drawn hollow | balance seen for 8,006 planets, not for 2,338; XRP: 0–0: 521 · 1–9: 5,224 · 10–99: 522 · 100–999: 736 · 1000–9999: 523 · 10000–99999: 281 · 100000–999999: 125 · 1000000–9999999: 43 · 10000000+: 31; quantiles p10 1.07 · p25 1.15 · p50 1.69 · p75 20.8 · p90 1,994.25 · p99 814,736.4 |
| Open offers (a count in the text) | Offer entries created minus deleted in the records heard | 121 planets with open offers: 1–1: 78 · 2–4: 29 · 5–9: 8 · 10–49: 6 · 50–199: 0 · 200+: 0 |
| The kinds | By precedence: collapsed, binary, black hole candidate, star, pulsar, planet | planet 9,115 · blackhole 30 · star 335 · pulsar 7 · binary 423 · collapsed 434; 423 AMM pools, 30 black hole candidates, 150 born, 434 collapsed, 36 with an on-ledger Domain, 8 that minted an NFT |
| Batch | A flash in the glyph’s colour | 39,702 Batch transactions (31.5% of those heard), 3,176 inner transactions flagged tfInnerBatchTxn |

Two things the hour says about the thresholds, for the owner rather than the build: the hub bar at 40 counterparties does not stop a giant cluster from forming over an hour (the largest nebula held 870 of the 1,010 planets in nebulae), so a tighter bar or a recency window on cluster edges is a decision to revisit; and 434 collapsed planets against 150 born says AccountDelete is routine on mainnet (services recover reserves by deleting accounts), which the rule records as it should.

### As built (phase 1)

Branch `feat/universe-live-sky`, on main after the Batch glyph (#30) and the documents (#32). The spike's files were the starting point; what changed for the phase:

- **WebGL first, the canvas as fallback.** `src/universe/main.js` builds `SkyGL` unless `?gl=0` asks for the canvas or WebGL is unavailable, in which case it builds `Sky` and says so in the console. Both extend one `SkyBase` (`src/universe/sky.js`): the camera, the data, the comets' clock, the pointer, the hit test and the overlay are one code path, and only the planets' pixels differ. `SkyGL.readPixel` lets the headless check read the colour where the JavaScript projection puts a planet; the check passes on both renderers, with the shader's camera agreeing with `project()`.
- **The overlay shared** (`src/universe/overlay.js`): the ignitions (the plate's 220 ms scale-in with overshoot and 180 ms white-hot core; the 2D bodies also grow in, the WebGL points flash without growing), the ledger pulse (the plate's ring from the centre, 2.6 s to 1.25 world units, held still and small under reduced motion), the marks of the kinds from the field guide's shapes (the lattice's hexagon in the trust colour for a star, the pool's three rings in the AMM colour for a binary star, the cancelled offer's strike-through in the pulse colour for a black hole candidate and a collapsed planet), the funded-ring ellipses, the cast rings, the labels with their thresholds, the nebula labels and the pair labels. The sprites are the plate's `core` sprite (white centre, the colour at a tenth, the halo) in the planet's hue; the nebula washes use the plate's first nebula ink.
- **Names and labels** (`src/universe/bodies.js`): `nameOf` (Domain, cast label, short address), `labelOf` (the threshold printed per kind), `nebulaLabel`, `castMemberOf`, `THRESHOLDS` (star 3, pulsar r 0.30 at a period of 2 or more, cluster edge 2, hub 40, nebula 5; the pulsar rule now checks the r as well as the period), and `describeBody` saying "in the cast" or "named by its on-ledger Domain". The worker posts the domains and the black hole candidates' keys with each ledger, and the attributes now carry holders, providers, period and r so the page labels without a round trip.
- **The cast** is read as the listening page reads it (`loadSettings`, `parseHash`, `parseCastSpec`, `normalizeCast`): a cast in the hash wins, `#account=` is a cast of one, else the stored cast; `hashchange` and `storage` events re-read it, so a cast set in Watch in another tab is highlighted here at once. A member's planet wears its cast colour and its label is always drawn; the focus line names it by its label and says it is in the cast.
- **Sound at arrival.** `flightOf` in `bodies.js` is the one clock: the i-th of k objects in a ledger starts at i/k of 85% of the interval, a comet lands at start + life, a flash is instant. The worker attaches the minimal engine event to each comet when sound is on; the page calls `playAt(event, arrival)`, so the note sounds when the comet lands. The engine's interval and expected count are set per ledger as the listening page sets them.
- **Batch** is the field guide's ninth category: `CATEGORY_CODES` are derived from `CATEGORY_NAMES`, the per-category arrays are sized by it, and a Batch flash takes the glyph's colour `#d4a373`.
- **The page** (`universe.html`): the spike label is gone from the title and the brand, `noindex` removed, the help explains the labels, the thresholds and the cast.

Checked: `node --test` 399 pass (new `test/universe-labels.test.js`: the name rule, every label and its threshold, the cadence bar, the text equivalent's cast line, the flight clock, the Batch code and colour). `bench/check-a11y.mjs` on both renderers, 27 checks each: WebGL by default and `?gl=0` for the canvas, reduced motion reaching the renderer and the camera not turning, the status regions, the cast read from the hash and labelled Maker, a body label with its threshold, the WebGL point lit where the projection says, `[` `]` travel with the focus line, Escape, `?`, the layer keys, Space, the arrows, `0`, S turning the engine on and the engine playing, comets under reduced motion, no exceptions. The acceptance's fifth line (a person who does not know what a ledger is, two minutes, what they said) is the owner's to run and record here; it is not something the build can do.

Copies still in place, each with the request it waits for: `src/universe/projection.js` (R1), `hueOf` (R8), `LAYER_OF` (R10), `minimalEvent` (R9), the cadence read off judged pairs (R3), the host from the endpoint (R11), the door (R12). Each is switched and deleted in the same PR that lands its export.

## Phase 1.5: the event vocabulary

Four verbs, then a detail. Today every transaction in the sky is a comet or a flash; from this phase every event has one of four verbs a newcomer learns in a minute, and a detail an engineer checks against the record. **Travel**: something moved between planets. **Dock**: a standing relationship was made or changed. **Place**: something was put on or taken from a book. **Happen on the body**: the account itself changed. What has not earned a verb is a **spark** at the submitter's planet that never leaves it (a failed transaction, or a type below the threshold), and a Batch wrapper is a **tick** with no body: its inner transactions carry the weight. Every event inherits the field guide's hue for its category (`src/glyphs.js` draws it from `CATEGORIES` in `src/mapping.js`), so the two pages agree on colour. At far zoom the four verbs collapse into weather: flows between nebulae, streams toward stars, haze around books, glow on planets; detail appears only when the camera is close. This section is the agreed specification, written before the build on the recorded measurements below; the as-built record follows it. The boundaries are the session's; `docs/art.md` does not exist at the time of writing, so the look is the plate's: representational objects are stylised darts and marks in the plate's ignition language, never cartoons.

### Measured first

From `bench/record-stream.mjs` against mainnet, 90 minutes from 2026-10-23T04:34:01.553Z: 1,385 ledgers, 198,274 transactions (distinct hashes), 682 MiB recorded. The spark threshold is 0.01% of the transactions heard (20 here): a type the vocabulary does not name stays the spark below it, and above it is owed a design.

| Type | Count | Share | Inner (of a Batch) | Failed | In the sky |
| --- | --- | --- | --- | --- | --- |
| Batch | 65,491 | 33.03% | 0 (0%) | 0 (0%) | tick (the wrapper), no body |
| OfferCreate | 55,282 | 27.88% | 957 (2%) | 8,237 (15%) | designed (see the vocabulary) |
| Payment | 43,513 | 21.95% | 2,385 (6%) | 29,633 (68%) | designed (see the vocabulary) |
| TicketCreate | 12,891 | 6.50% | 0 (0%) | 6,892 (53%) | designed (see the vocabulary) |
| OfferCancel | 6,671 | 3.36% | 0 (0%) | 0 (0%) | designed (see the vocabulary) |
| NFTokenCreateOffer | 4,734 | 2.39% | 1,756 (37%) | 76 (2%) | designed (see the vocabulary) |
| AccountSet | 3,869 | 1.95% | 41 (1%) | 0 (0%) | designed (see the vocabulary) |
| CheckCash | 2,378 | 1.20% | 59 (3%) | 2,190 (92%) | designed (see the vocabulary) |
| TrustSet | 1,580 | 0.80% | 41 (3%) | 5 (0%) | designed (see the vocabulary) |
| NFTokenCancelOffer | 659 | 0.33% | 1 (0%) | 0 (0%) | designed (see the vocabulary) |
| CheckCancel | 450 | 0.23% | 0 (0%) | 0 (0%) | designed (see the vocabulary) |
| CheckCreate | 347 | 0.18% | 0 (0%) | 0 (0%) | designed (see the vocabulary) |
| NFTokenAcceptOffer | 99 | 0.05% | 31 (31%) | 32 (32%) | designed (see the vocabulary) |
| SetRegularKey | 86 | 0.04% | 0 (0%) | 0 (0%) | designed (see the vocabulary) |
| AMMDeposit | 74 | 0.04% | 0 (0%) | 17 (23%) | designed (see the vocabulary) |
| OracleSet | 57 | 0.03% | 0 (0%) | 0 (0%) | designed (see the vocabulary) |
| NFTokenMint | 29 | 0.01% | 0 (0%) | 0 (0%) | designed (see the vocabulary) |
| AMMWithdraw | 21 | 0.01% | 0 (0%) | 6 (29%) | designed (see the vocabulary) |
| NFTokenBurn | 17 | 0.01% | 2 (12%) | 0 (0%) | designed (see the vocabulary) |
| AccountDelete | 13 | 0.01% | 0 (0%) | 1 (8%) | designed (see the vocabulary) |
| AMMVote | 4 | 0.00% | 0 (0%) | 0 (0%) | spark (below the threshold, unnamed) |
| AMMCreate | 4 | 0.00% | 0 (0%) | 0 (0%) | designed (see the vocabulary) |
| AMMBid | 3 | 0.00% | 0 (0%) | 1 (33%) | designed (see the vocabulary) |
| SignerListSet | 2 | 0.00% | 0 (0%) | 0 (0%) | designed (see the vocabulary) |

The sub-kinds the rules cut, as counted in the same recording:

| Sub-kind | Count |
| --- | --- |
| batch: 2 inner | 55,780 |
| offercreate: XRP book | 48,297 |
| failed (tec/other) | 47,090 |
| offercreate: placed (Offer created) | 45,399 |
| payment: cross-currency (SendMax differs from Amount) | 36,050 |
| payment: self (Account = Destination) | 35,945 |
| payment: tfPartialPayment set | 35,841 |
| batch: 3 inner | 7,522 |
| offercreate: tfFillOrKill | 7,354 |
| offercreate: issued/issued book | 6,985 |
| offercreate: tfSell | 6,427 |
| payment: delivered less than asked (partial) | 6,010 |
| payment: through a pool (AMM root) | 5,706 |
| payment: issued currency | 4,994 |
| nftoffer: buy | 4,617 |
| accountset: no flag, no Domain | 3,867 |
| payment: dust (under 1 XRP) | 3,332 |
| offercreate: tfImmediateOrCancel | 2,406 |
| checkcash: exact Amount | 2,378 |
| payment: with Paths | 1,900 |
| batch: 5 inner | 1,156 |
| offercreate: crossed the book | 1,063 |
| trustset: line created | 874 |
| batch: 4 inner | 796 |
| payment: crossed the book (Offer nodes) | 722 |
| offercreate: through a pool | 643 |
| trustset: limit 0 | 607 |
| trustset: line deleted | 575 |
| payment: funded a new account | 232 |
| batch: 8 inner | 183 |
| nftoffer: sell | 117 |
| setregularkey: set | 86 |
| ammdeposit: flags 0x80000 | 70 |
| trustset: tfClearFreeze | 61 |
| oracleset | 57 |
| nftaccept: brokered (both offers) | 51 |
| nftaccept: a sell offer | 46 |
| batch: 6 inner | 33 |
| batch: 7 inner | 21 |
| accountdelete | 13 |
| ammwithdraw: flags 0x20000 | 10 |
| ammwithdraw: flags 0x200000 | 7 |
| ammdeposit: flags 0x100000 | 4 |
| offercreate: swept an untraded offer of someone else | 3 |
| accountset: SetFlag 4 | 2 |
| nftaccept: a buy offer | 2 |
| ammwithdraw: flags 0x40000 | 2 |
| signerlistset: quorum 2 of 3 | 1 |
| ammwithdraw: flags 0x10000 | 1 |
| ammwithdraw: flags 0x100000 | 1 |
| signerlistset: quorum 1 of 2 | 1 |

What the recording says for the vocabulary, beyond the counts: three in four payments on mainnet tonight fail (bots' path-finding payments to themselves, `tfPartialPayment` set, cross-currency, mostly `tecPATH_DRY`), so most of what the stream calls a payment is a spark; of the payments that succeed, the self-payment through the book or a pool (the burn) outnumbers the direct comet; nearly half of the NFT offers arrive inside Batches; the Batch wrapper is the largest type by far and carries nothing of its own. Frequency decides loudness throughout: payments, offers and wrappers are small and quiet; account-control changes are rare and earn a motion you notice.

### The vocabulary

Each row: the object, its verb, the rule and the record fields that earn it, what is drawn, what stands still under reduced motion, and the fixture that proves it (a real recorded transaction under `test/universe-fixtures/`, or a TODO naming what was searched). The rule ids are `src/universe/events.js`; a row the record cannot support as the brief wrote it says so.

| Object | Verb | Earned by (fields) | Drawn | Still | Fixture |
| --- | --- | --- | --- | --- | --- |
| comet | travel | `Payment`, success, Account ≠ Destination, one currency, no hops; size from log of `meta.delivered_amount` | the photon from sender to receiver with its tail | the line, head at the receiver | `comet.json`: Payment D293EF741CC9… in #107,841,942 |
| bent-comet | travel | a payment whose `SendMax` differs from the amount, or with `Paths`, or that crossed `Offer` nodes or an AMM root; the hops are the issuers named by the RippleStates touched, the pools, and the owners of the crossed offers, in the order of the record (the record carries the set of hops, not their order on the path: a challenge to the brief's "each issuer in its path", drawn in record order) | the comet whose tail bends past each hop | the bent line | `bent-comet.json`: Payment A3F178F082AF… in #107,842,373 |
| partial | travel | `tfPartialPayment` and `meta.delivered_amount` below `DeliverMax`/`Amount` | arrives short, labelled "delivered X of up to Y" | the short line with the label | `partial.json`: Payment 313B227D49B7… in #107,841,953 |
| burn | travel | `Account = Destination` (a payment to self), success; the hops as above | a loop out of the sender's planet and back | a ring around the planet | `burn.json`: Payment 2FD0DEF662A1… in #107,841,942 |
| dust | travel | an XRP payment under one XRP | a faint brief comet | a faint short line | `dust.json`: Payment 201E7F8429FF… in #107,841,943 |
| shower | travel | five or more dust payments from one sender in one ledger (`collapseShowers`) | a meteor shower | faint short lines | `shower.json`: Payment … in #107,842,400 |
| long-period | travel | `EscrowCreate` with `FinishAfter` (the period) | a dotted comet leaving | a dotted line | TODO: none in 90 minutes of mainnet; searched the recording for the type and the fields the rule reads |
| long-period-arrive | travel | `EscrowFinish`: the deleted `Escrow` node's Account and Destination | the comet arrives at the destination | dotted line, head at the destination | TODO: none in 90 minutes of mainnet; searched the recording for the type and the fields the rule reads |
| long-period-return | travel | `EscrowCancel`: the deleted `Escrow` node's Account | the comet returns home | dotted line, head at home | TODO: none in 90 minutes of mainnet; searched the recording for the type and the fields the rule reads |
| check-drift | travel | `CheckCreate`: Destination, `SendMax`; the check waits (a standing object) | a bead drifting into the destination's orbit and waiting | the bead in orbit | `check-drift.json`: CheckCreate AB8F078363D8… in #107,841,942 |
| check-cash | travel | `CheckCash`: the deleted `Check` node's Account and Destination, `Amount` or `DeliverMin` | the waiting bead lands | the bead at the destination | `check-cash.json`: CheckCash EEDD705798AC… in #107,841,943 |
| check-cancel | travel | `CheckCancel`: the deleted `Check` node | the bead blinks out | nothing | `check-cancel.json`: CheckCancel ADC23CB359E8… in #107,842,394 |
| moon-capture | travel | `NFTokenAcceptOffer`: the seller is the deleted sell `NFTokenOffer`'s Owner (else the accepting account), the buyer the deleted buy offer's Owner (else the accepting account); brokered when both offers are named | a moon captured from one orbit into another, via the broker | the moon at the buyer | `moon-capture.json`: NFTokenAcceptOffer 9585B927A1DB… in #107,841,947 |
| reverse-comet | travel | `Clawback`: `Amount.issuer` is the holder, Account the issuer | a comet from holder to issuer in the trust colour | the line | TODO: none in 90 minutes of mainnet; searched the recording for the type and the fields the rule reads |
| collapse | travel | `AccountDelete`: Destination, the deleted `AccountRoot`'s Balance | the planet collapses and its last XRP leaves as a final comet | the struck planet and the line | `collapse.json`: AccountDelete DC7C6D5679DC… in #107,842,159 |
| beam, beam-fund, beam-pulse | travel | `PaymentChannelCreate` (Destination, Amount), `Fund` and `Claim` (the `PayChannel` node's Account and Destination) | a standing beam; funding thickens it; a claim pulses along it | the beam; a mark on it | TODO: none in 90 minutes of mainnet; searched the recording for the type and the fields the rule reads |
| rocket | dock | `TrustSet` with a limit above zero and no freeze or auth flag; the issuer is `LimitAmount.issuer`; balance from the RippleState | a dart launched by the submitter docking into orbit around the issuer; it does not land | the dart at the orbit | `rocket.json`: TrustSet 7110CDC48AC2… in #107,841,944 |
| deorbit | dock | `TrustSet` with `LimitAmount.value` 0 | a de-orbit burn | a fading dart | `deorbit.json`: TrustSet 687CBC52C48B… in #107,841,969 |
| freeze | dock | `TrustSet` with `tfSetFreeze`, `tfClearFreeze`, `tfSetDeepFreeze` or `tfClearDeepFreeze` | the orbit locks and changes colour, no motion | the recoloured orbit | `freeze.json`: TrustSet 5000CDE9AACA… in #107,841,945 |
| beacon | dock | `TrustSet` with `tfSetfAuth` | a docking beacon | the beacon | TODO: none in 90 minutes of mainnet; searched the recording for the type and the fields the rule reads |
| gate | dock | `DepositPreauth`: Authorize or Unauthorize | a thin line to the one account allowed in | the line | TODO: none in 90 minutes of mainnet; searched the recording for the type and the fields the rule reads |
| ignite | dock | a planet whose holders cross the star threshold between two ledgers (the body rule `star.issuer`, the worker's kind transition) | the lattice's hexagon grows out of the planet: it is a star now | the star | the recorded hour replayed (acceptance) |
| rock | place | an `Offer` created by the submitter (the facts layer's `offer.placed`): the book is the canonical pair (XRP first, else the sides in key order, so both directions are one book), the host the issuer of the issued side, the price in units of the second side per one of the first (an ask when the offer gets the first side, a bid when it gets the second), the radius the price's band among the book's standing rocks, so asks sit outside bids and the gap between them is the spread | a rock set into the belt | the rock | `rock.json`: OfferCreate 20B9D3CE531B… in #107,841,942 |
| fill | place | an `OfferCreate` that consumed others' offers or took a pool leg (`exchange.fill`) | the taker's comet crossing the belt | the crossing line | `fill.json`: OfferCreate 6D97CD9031CC… in #107,841,943 |
| flare | place | a book offer consumed or partly consumed (`offer.removal.consumed`, `traded-unfunded`, or modified with a trade) | the consumed rock flares out | nothing | `flare.json`: OfferCreate AEAE66AB3672… in #107,841,943 |
| blink | place | a rock cancelled, replaced or self-crossed (`offer.removal.cancelled`, `replaced`, `self-cross`) | the rock blinks out | nothing | `blink.json`: OfferCreate 20B9D3CE531B… in #107,841,942 |
| crumble | place | a rock swept untraded (`offer.removal.cleanup`: expired or unfunded), the facts layer's distinction | crumbles grey with no flash | a grey mark | TODO: none in 90 minutes of mainnet; searched the recording for the type and the fields the rule reads |
| binary-form, binary-brighten, binary-dim, satellite, binary-collapse | place | `AMMCreate` (the pool root's AMMID), `AMMDeposit`, `AMMWithdraw`, `AMMBid` (the `AMM` node's AuctionSlot Expiration), `AMMDelete` | a binary forms, brightens, dims, captures a satellite for the slot, collapses | the state | `binary-brighten.json`: AMMDeposit 1AE1BEADE4F6… in #107,841,955 |
| ring | happen | `AccountSet` with no Domain and not `asfDisableMaster` (the flag is named) | a ring of light | the ring | `ring.json`: AccountSet 38D2F10711B7… in #107,841,942 |
| nameplate | happen | `AccountSet` with `Domain` | the ring and the nameplate the Domain gives | the nameplate | TODO: none in 90 minutes of mainnet; searched the recording for the type and the fields the rule reads |
| darken | happen | `AccountSet` with `SetFlag` 4 (`asfDisableMaster`) | the planet darkens toward a black hole candidate | the darkened planet | `darken.json`: AccountSet 7EA9C2C95601… in #107,842,112 |
| tilt | happen | `SetRegularKey` | the axis tilts | the tilted axis | `tilt.json`: SetRegularKey C2A4E5F0CD76… in #107,842,353 |
| guardians | happen | `SignerListSet`: `SignerEntries`, `SignerQuorum` | guardian moons in a ring, the quorum lit | the ring of moons | `guardians.json`: SignerListSet 84D0634165CC… in #107,842,081 |
| shimmer | happen | `TicketCreate` | a faint shimmer | a faint mark | `shimmer.json`: TicketCreate 1CC5E39B5B24… in #107,841,942 |
| moon-form, moon-crumble, moon-beacon, moon-beacon-off | happen | `NFTokenMint`, `NFTokenBurn`, `NFTokenCreateOffer`, `NFTokenCancelOffer` | a moon forms, crumbles, shows or hides a beacon | the state | `moon-form.json`: NFTokenMint CD9752939271… in #107,841,964 |
| lighthouse | happen | `OracleSet` (the cadence is the account's interval between updates over the window) | a lighthouse beam | the beam, still | `lighthouse.json`: OracleSet D34D0229649E… in #107,842,049 |
| badge | happen | `DIDSet`, `DIDDelete`, `Credential*`, `MPToken*` | a badge | the badge | TODO: none in 90 minutes of mainnet; searched the recording for the type and the fields the rule reads |
| tick | — | `Batch` | a faint tick, no body | the tick | `tick.json`: Batch 31B6C7509EB6… in #107,841,942 |
| spark | — | any failed transaction, or a type below the threshold without a design | the ignition's white-hot core at the planet, never leaving it | the spark | `spark.json`: TicketCreate E81F032C74A6… in #107,841,942 |

Rows challenged: the bent tail's hop order (the record carries which issuers, offers and pools a payment touched, not the path's order; drawn in record order and said so); moons as a count (an account's NFTs are not countable from the stream, as phase 1 found, so a moon forms where a mint happened and is captured where an accept happened, and the number of moons a planet carries is the number seen in this window, never the account's holdings); checks, beams, gates, guardian rings and rocks as standing objects (they persist for the session from the event that made them, and only until the event that removes them is heard: a belt shows the rocks placed while the page listened, not the book).

### The four motions, in both renderers

One grammar, `src/universe/motions.js`: a motion is an event in flight on the flight clock of phase 1 (`flightOf`, life per object from LIFE in ledger intervals), and `primitivesOf` turns it, each frame, into lines, dots, rings and darts in screen space that either renderer draws (the 2D canvas with its own calls; WebGL with a lines buffer, a point-sprite buffer and a triangle program for the darts). Under reduced motion `primitivesOf` returns the object's still marker, so every object has one in both renderers. The marks are the plate's: the comet is the photon with its tail, the spark its white-hot core, the flash the pulse ring, the rock the mote, the dart the spectral line's diamond turned along its path, the ring of light the pulse ring, the star's ignition the lattice's hexagon. Loudness is LOUDNESS: payments, offers and wrappers small and quiet, control changes noticed.

Levels: at far zoom (the camera beyond 2.4 sky radii) no motion is drawn; the worker's weather for the ledger is (`weatherOf`): flows between the nebulae the two ends belong to, streams toward the stars docked into, haze around the hosts of the books placed on, glow on the planets things happened to, each with its count, drawn by `weatherPrimitives`. Closer, every motion is drawn; near, the standing objects too (the rocks of a belt at their price radius on the one axis of the canonical book, bids inside and asks outside the spread, the beads of waiting checks, the beams, the gates, the guardian rings, the moons, the satellites). The budget stands at 60 fps with 20,000 planets on WebGL with the motions of a mainnet ledger in flight; the sprites are one vertex each (point sprites), and the far zoom draws counts, not events.

### Text and labels

Every object at near zoom carries its rule and the record fields that earned it, as the bodies do: hovering a motion, or stepping through the ledger's events with `,` and `.`, puts the event's text in the focus line, `describeEvent` (`rocket: rA set a trust line to rB, 0 of up to 1,000 USD`) with the rule id and the evidence fields under it, the names by the name rule of phase 1. A screen reader travels the sky's events the way it travels its planets.

### Build order

1. Spec, histogram, the four-verb grammar in both renderers with the collapse to weather and the budget held.
2. Dock: rockets, de-orbit, freeze, the ignition into a star.
3. Travel: the comet family, partial, self-payment, dust and shower, the failed spark.
4. Place: belts per book with price radius, fills, cancels, swept rocks; the AMM binary events.
5. Happen on the body: the control changes first (signer moons, key tilt, master darkening), then the rest.
6. Everything below the threshold stays the spark; the histogram lists what that excludes.

### Tests and acceptance

A real recorded transaction is the fixture for every object (`bench/extract-fixtures.mjs` over the recording: the message verbatim, the ledger, the events expected of it with verb, object, rule and label; `test/universe-fixtures/MISSING.md` lists the objects no example turned up for, with what was searched). `test/universe-events.test.js` pins each fixture's events, checks every object has a verb, a rule, a life, a loudness and a still, checks the weather and the showers, and checks `primitivesOf` under reduced motion for every object. Acceptance: headless checks per renderer for each verb; the recorded hour replayed through the page shows the four verbs and no object outside the vocabulary; the star-ignition moment visible on a real issuer; reduced motion gives still markers; the existing tests pass; and the beauty-gate line: a person who does not know what a ledger is watched two minutes and said what they felt.

### Decisions to propose, not make

1. **Where XRP lives in the sky.** XRP has no issuer, and every XRP book needs a second body for its belt. Proposed: the sun, a single luminary at the sky's origin, which no planet's home occupies (`homeOf` keeps every home away from the centre by construction); an XRP book's belt sits around the issuer star of its other side, with the sun's direction as the price axis, so a belt reads the same whichever side is XRP; XRP comets are lit by the sun's colour, the field guide's payment blue. Recommended, because it adds no body the record did not earn (the sun is the ledger's native asset, not an account) and it gives every XRP book a geometry without inventing a planet.
2. **The rocket's exact shape.** Proposed: the spectral line's diamond (the field guide's offer glyph) turned along its path, three sparks behind it, docking as a dashed arc on the issuer's orbit. Recommended, because it is already in the ignition language and reads as a dart at every size.
3. **Which rare types get a design now versus the spark.** Proposed: the account-control changes now (`SetRegularKey`, `SignerListSet`, `asfDisableMaster`, `AccountDelete`, `DepositPreauth`, `Clawback`), whatever their count, because each is a motion worth noticing; `OracleSet`, `DID*`, `Credential*` and `MPToken*` as drawn (the lighthouse and the badge) only once a recording holds a real example, the spark until then; everything else below the printed threshold stays the spark. Recommended, with the threshold printed in the histogram so the list is a fact of the recording, not a taste.

## Art direction received

On 2026-10-23 the owner, looking at the live sky of phase 1.5, said it was chaotic and that it should look like the cosmos, with galaxies. `docs/art.md` has not landed; this is the direction until it does, and what changed for it:

- **Galaxies.** Every planet that is not a hub belongs to the hub it dealt with most (its core), ranked among that hub's satellites by how often they dealt. A satellite's place is on its core's galactic disc, a plane through the core whose tilt is fixed by the core's address, at a radius that grows with its rank (`discBase · (0.6 + 0.55 · √(rank + 1))`, the largest disc of the recorded hour 0.47 sky radii) and an angle that turns with the radius, so a galaxy reads as a tilted spiral with a bright core at far zoom. A hub with five or more satellites is a galaxy; the cloud drawn for it is its disc at its tilt, labelled "galaxy · N planets around <core>". The union-find nebulae of phase 1 stay for clusters without a hub.
- **Galaxies stand apart.** The first time a hub becomes a galaxy its home moves out, once, to the galactic shell (radius 1.8, the field's ball is radius 2) along its own home direction, and a radial spring holds it there; two cores whose discs would overlap push each other along the shell, never into the middle. The disc holds a galaxy together and the shell holds it apart: an edge between two galaxy members moves neither (their places come from rank and the shell), an edge between a galaxy member and a field star draws the field star a quarter of the way and never the member, so the field gathers into filaments toward the galaxies it deals with. The first three passes, which kept the edge springs on galaxy members, left every core within 0.4 of the centre: a hub's hundreds of edges outweigh any spring, so the edges had to go, not get weaker.
- **The field.** A planet in no galaxy is a field star: dust at far zoom (a fifth of its brightness in 2D, an alpha the WebGL shader reads from a negative glow attribute), dimmer than a galaxy member at every zoom; the eye goes to the galaxies. The camera's home moved out to 5.2 so the whole shell is in view; the layout's crowd grid coarsened to 0.06 so the wider span costs the same per step (3.0 ms at 9,400 planets).
- **Labels.** At far zoom only the twelve largest galaxies carry their label; the rest have it on hover and focus, as every body does. Fifty labels over fifty galaxies were the clutter the owner called chaos, with the lines.
- **The weather flows only between galaxies.** A travel event whose end is in no galaxy glows on its planet instead of drawing a line across the sky; the far view is galaxies and the flows between them, not a thousand lines.
- **Sparks and ticks are quiet.** A failed transaction's spark is small and faint; a Batch wrapper's tick is drawn only at the near level, at a twelfth of a comet's loudness; a ticket's shimmer is fainter. Frequency decides loudness, as the phase 1.5 brief said.

Everything else of the look stays the plate's. The rest of the owner's direction, when `docs/art.md` lands, applies on top of this.

### As built (phase 1.5)

Branch `feat/universe-four-verbs`, on phase 1 (`feat/universe-live-sky`, PR #36) on main. `docs/art.md` did not exist; the look was the plate's until the owner's art direction of 2026-10-23 (the section above): galaxies around their cores on an outer shell, a dim field, weather between galaxies, quiet sparks and ticks.

- **Measured first.** `bench/record-stream.mjs` recorded 90 minutes of the stream verbatim (198,274 transactions, 682 MiB, outside the repository) with the histogram above; the threshold is printed there. `bench/extract-fixtures.mjs` took the first real example of each object from the recording into `test/universe-fixtures/` (34 of 48 objects; `MISSING.md` lists the rest with what was searched and the counts of every object seen). Three in four payments failed; the burn outnumbered the comet; nearly half the NFT offers arrived in Batches.
- **The classifier** (`src/universe/events.js`): `eventsOf(tx, meta)` reads the record once and returns the events with verb, object, rule id, evidence fields and detail; offers go through the facts layer (`facts()`), so a rock, a flare, a blink and a crumble are its findings (`offer.placed`, `consumed`/`traded-unfunded`, `cancelled`/`replaced`/`self-cross`, `cleanup`); `collapseShowers` folds five or more dust payments of one sender in a ledger into a shower; `weatherOf` aggregates a ledger's events per cluster, star, host and planet; `describeEvent(e, nameOf)` is the text; `colourOf` the field guide's hue (a clawback's reverse comet takes the trust colour, the issuer's). `DESIGNED_TYPES` and `SPARK_THRESHOLD` are the histogram's verdicts.
- **The grammar** (`src/universe/motions.js`): `primitivesOf(motion, screen, { reduced })` returns lines, dots, rings and darts for one object at one instant, or its still marker; `LIFE` and `LOUDNESS` per object; `rockAngle` and `beltRadius` place a rock in its book's belt by its price band; `weatherPrimitives` draws the far zoom from counts. Both renderers draw these: the 2D canvas with `drawPrimitives`, WebGL with a flat screen-space program (`drawPrimitivesGL`: lines and ring polylines as LINES with width as parallel strands, dashes as dashes, darts as triangles, dots as point sprites). `SkyBase.livePrimitives` chooses by camera distance: the weather beyond 2.4, the motions closer, the standing objects under 1.6; `hitMotion` finds the head under the pointer.
- **The worker** keeps the standing objects (`stand()`: rocks by owner and sequence with their book's price range for the band, waiting checks by the CheckCreate's hash and resolved by the pair, beams by channel, gates, guardian rings, moons and beacons per planet, satellites for a day), posts them per ledger with the events (each with its sound event when sound is on), the weather, and the ignitions (a planet whose kind became star since the last ledger: `attributes()` keeps the kinds). Planets an event names that the record did not carry (an escrow's destination, a check's creator) are made so the motion has both ends. `start({ replay, pace })` feeds a recording line by line at `pace` ms per ledger close.
- **The page** turns a ledger's events into motions on the flight clock (`flight`: the i-th of k events starts at i/k of 85% of the interval; a comet lands at start + life, a place, happen, spark or tick is instant), sounds each transaction's engine event at its arrival with `playAt`, reads an event into the focus line on hover (the head under the pointer) and with `,` and `.` (the last ledger's events), with the rule id and the evidence fields under the text, and counts verbs and objects seen (`stats().verbsSeen`, `objectsSeen`, `ignitions`, `counts`). `?replay=` and `?pace=` are the acceptance check's entrance; the coverage line says a recording is replayed.
- **The budget.** On the real GPU (Brave (Chromium 155) on the user’s machine, 1536×741 CSS px at DPR 2, GPU string masked), WebGL at 20,000 synthetic planets with 197–137 motions in flight: 2.9 / 2.9 / 3.1 ms a frame (home / closer / inside), p95 under 3.7 ms, 61 fps at every view: the budget holds. Headless (SwiftShader, software): webgl 4.8 / 16.3 / 49.0 ms; 2d 117.6 / 109.8 / 62.1 ms; the 2D canvas is the fallback and does not hold at 20,000, as phase 1 measured. The synthetic stream makes payments only, so these motions are comets; the replay check below carries the real mix at about a thousand planets.
- **Checked.** `node --test`: 453 pass (`test/universe-events.test.js`: every fixture's events pinned, the objects table, showers, weather, books, colours, the name rule in `describeEvent`, every object's motion and still in screen space, the partial's short reach, the rocket's dock and the de-orbit, the belt radius and angle, the weather primitives). `bench/check-verbs.mjs` on both renderers, replaying the recording at 60 ms a ledger for 900 ledgers (bench/check-verbs.mjs over 900 ledgers of the 90-minute recording, both renderers: the four verbs present (WebGL travel 10,430 · dock 1,337 · place 60,104 · happen 11,181; 2D travel 10,499 · dock 1,350 · place 60,905 · happen 11,243), no unnamed shape, 364 (WebGL) and 370 (2D) stars ignited on real issuers, 1,306 and 1,262 motions in flight at the end, every object with a still marker under reduced motion, no exceptions), all four verbs seen, no zoo (every object seen is in the vocabulary), the counts, a star ignited on a real issuer (364 and 370 ignitions; the moment is `bench/results/verbs-ignition-{webgl,2d}.png`, the planet focused with its label `star · 3 holders ≥ 3`), the coverage line naming the recording, motions in flight, the frame time (under the replay in software rendering, mean 6.1 ms and p95 8.8 ms (WebGL), mean 5.8 ms and p95 9.7 ms (2D); in Brave on the GPU, 20,000 planets with motions at 2.9/2.9/3.1 ms (61 fps)), `.` and `,` reading events with object, rule and evidence, hovering a head reading its event, a still marker for every object under reduced motion, reduced motion reaching the running renderer, no exceptions. `bench/check-a11y.mjs` on both renderers still passes. The beauty-gate line (a person who does not know what a ledger is watched two minutes and said what they felt) is the owner's to run and record here.

Copies still in place: as phase 1's, plus the layer table now also in `src/universe/sky.js` (`LAYER_OF`, R10) until the requests PR lands.

## Phase 2: exploration, with the probe

The agreed specification, written before the build, on the owner's brief of 2026-10-23. Same boundaries, same ground rules; a fresh branch from main once phase 1.5 has merged (`feat/universe-probe`, stacked on phase 1.5 until then). Everything the probe reads is public live data; no forensic case identity appears anywhere in the page, the tests or this document.

### The UFO cursor

The cursor over the sky is a UFO: a toggle, default on here, absent on every other page. It is toggled by a **double right-click on the sky** (two secondary-button presses within the browser's double-click interval, read from the two `pointerdown` events' timestamps; the context menu is suppressed over the sky canvas only, never elsewhere on the page), by a **visible switch in the sky's settings** so it can be found, by a **key** (`U`) so keyboard users have it, and on touch by a **two-finger double-tap** (two touches starting together, twice within the same interval). Its vocabulary sentence names the gesture: "The UFO is the probe's cursor over the sky: double right-click the sky, press U, or double-tap with two fingers to put it away or bring it back." The first time the sky opens in a browser one caption says it, once (a flag in the page's own storage, under its own key, never the listening page's).

With the UFO on, hovering a planet shows a **soft beam** from the UFO to the planet; holding (the primary button, a touch, or the probe key on a focused planet) **locks** the beam and **probes** that account; releasing retracts it. The beam pulls by evidence only: nothing in the sky moves toward it without a number; hovering moves nothing (a headless check asserts it).

### The probe, in order

On a hold, in this order, each step on screen as it lands:

1. **History.** The account's recent history through the loader and the cache (R2, the other session's `LedgerLoader` and `ledger-cache`; `account_tx` bounded to a stated number of ledgers back from the validated ledger at the hold, the coverage said in the readout: "ledgers #A–#B, N records, M of them in the window"). Until the loader lands, the explorer's `ExplorerApi.accountTx` with the same bound, paced as `docs/loader.md` measured.
2. **First-degree record connections, lit with counts.** Every counterparty the record names (`src/record.js` `touchOf` over the history and the window, `connections()` per pair) becomes a planet if it is not one and is lit with its count: "connected in the record: 12 transactions (7 destination, 5 entry)".
3. **Measures, in the worker**, each with its label in the readout's own words:
   - **Record proximity**: a random walk with restart over the touch graph of the window (restart probability 0.15, the walk from the probed planet, the stationary distribution over the planets it reaches; label "record proximity 0.031, rank 3 of 240"), tier calculated: it is arithmetic over the record.
   - **Flow conservation** from exact balance changes (`balanceFacts` of the facts layer, exact strings through `src/decimal.js`): over a window of W ledgers, inflow and outflow per currency, the lag at which cumulative inflow best matches cumulative outflow ("inflow 1,204.5 USD, outflow 1,198.0 USD, within 0.5% at a lag of 2 ledgers"), tier calculated; a pass-through is said as a number, never as a role.
   - **Cadence**: `cadenceOf` on the account's own series (R3's `cadences(frame)` when it lands), the pulsar rule's words.
   - **Coherence** from this account against its counterparties and the nearest active accounts: `frameFromLive` (or the account_tx frame) with an explicit account list (R4, copied until it lands), the full phase 1.5 readout per pair: prewhitened r and lag, the null, pairs tested and the percentile, the record check; the labels are "in step at lag L · connected in the record: N" or "· not touching", never "coordinated".
4. **The catch.** The lit planets with one label per measure, the beam's sheaf to each; the readout drawer (as the listening page's) with the full lines, pairs tested and percentile on each. The catch is kept for the session and goes into Save this moment (a case with the probed account as the cast, the catch's hashes as evidence) and into Copy for AI (the catch's lines after the events, under their own heading). Release retracts the beam; the catch stays lit until the next hold or Escape.

Keyboard: `[` `]` focus a planet, `U` the UFO, the probe key `Space` on a focused planet holds (and `Space` again releases; Start/Stop moves to `Shift+Space` when the UFO is on — a decision to propose below); the text equivalent reads the catch in the readout's words, one line per lit planet, through the focus line's status region.

### Exploration proper

Opening a planet (Enter, or the hold) loads it as the explorer does (R7): the account root and its trust lines first (the rings become the full set, the size the balance at the validated ledger), the rest later: `account_objects` (a black hole candidate becomes a rule only when no SignerList is among them; a SignerList makes it a planet with guardians), `account_nfts` (moons), `account_tx` (counterparties become planets, arranged by time as phase 1's spec said). Belts around books follow the phase 1.5 decision on XRP's place (the sun at the origin, proposed), reading `book_offers` for the book the planet's rocks are on.

### Phase 3, placed, not built

Directed influence (transfer entropy from one account's series to another's, with the circular-shift null) and temporal motifs (the recurring orderings of the touch graph within a ledger) are phase 3. Their place in the catch is designed now: each lit planet's label has a fifth and sixth slot, "influence →" and "motif", that read "not measured (phase 3)" until then, so the readout's shape does not change when they land; the readout drawer has the same two rows.

### Requests

R4 (an explicit account list for `frameFromLive`), R5 (`rootsOf`/`linesOf` in `record.js`), R6 (the issuer-side rule in the facts catalogue), R7 (partial `loadAccount`, the SignerList filter), and new: R13 `balanceFacts` over a list of transactions as one call with per-currency sums (flow conservation), R14 the loader's `account_tx` with a stated bound and pacing (the loader PR's seam), R15 a `touchGraph(touches)` in `record.js` (the adjacency the random walk needs), R16 the explorer's readout drawer as a shared component (`src/ui-drawer.js`) usable from the sky. All in `docs/universe-requests.md`.

### Tests and acceptance

Real fixtures for each measure with expected catches: a recorded window of transactions (the phase 1.5 recording) for the proximity walk, the conservation sums and the cadence, each with the expected numbers beside it; the coherence fixtures of `test/fixtures/coherence/` for the pair readout. The AMM ground-truth windows run locally through the probe on a sniper planet must light the other snipers as "in step, not touching" and the pool as "connected, flat"; a control planet lights only what chance gives; those inputs stay with the owner's run folder and never enter the repository. Acceptance adds the beauty-gate line, and a headless check that nothing in the sky moves on hover: the positions of every planet before and after the pointer crosses the sky are the same arrays.

### Decisions to propose, not make

1. **The probe key.** Proposed: `Space` holds and releases when the UFO is on and a planet is focused, with Start/Stop on `Shift+Space`; recommended, because the hold is the sky's main act and deserves the biggest key, and the listening page's `Space` is Start/Stop by habit, which the shift keeps.
2. **The history bound.** Proposed: 2,000 ledgers back (about two hours), one `account_tx` page at a time through the loader's pacing; recommended as the longest bound the public nodes answered within a probe's patience in `docs/loader.md`'s measurements.
3. **The UFO's look.** Proposed: the plate's spectral diamond as a saucer (two diamonds, one flat), the beam a cone of the pulse colour at low alpha; recommended, in the ignition language and nothing new.

### As built (phase 2)

Branch `feat/universe-probe`, on phase 1.5 (`feat/universe-four-verbs`, PR #37). Everything under `universe.html`, `src/universe/`, `test/universe*` and this document; no shared module edited; no forensic case identity anywhere.

- **The UFO** (`src/universe/ufo.js`): the sentence, the store under the sky's own key (`xrpl-sonic:universe:v1`: the switch and whether the caption was shown; the listening page's settings sanitizer would drop an unknown key, so the sky keeps its own), the gestures (`UfoGestures`: a double right-click is the second secondary press the browser itself counts as a double (`mousedown.detail ≥ 2`, so the interval is the browser's), or two presses within 400 ms where it does not count secondary buttons; a two-finger double-tap is two two-touch starts within 400 ms), and the drawing (the saucer: a flat diamond and an upright one in the plate's spectral line, three running lights, a faint disc below, a 1.5 px bob unless reduced; the beam: a cone of the pulse colour from the saucer's underside to the planet at low alpha, locked brighter with a thin core, fading in over 200 ms unless reduced, when it is on or off; the sheaf: thin lines from the probed planet to each lit planet, brighter for in step than for touching). The context menu is suppressed on the sky canvas only. The switch is the `UFO` button in the top bar, the key is `U`, the caption shows once. Default on here; no other page has it.
- **The probe's measures** (`src/universe/probe.js`, pure): `touchGraph` from the universe's edges; `randomWalk` with restart 0.15 by power iteration (60 steps; the mass sums to one; a dead end returns to the start); `conservation` from `balanceFacts` per transaction, inflow and outflow per currency as decimal strings end to end, the difference, the share of the larger it is (the one Number, for the words "within N%"), the lag 0–8 at which the cumulative inflow best matches the cumulative outflow shifted by it; XRP outflow includes fees and the row says so; `seriesOf` and `cadence` (`cadenceOf` on the normalised series, the pulsar rule's words, the guard's reasons); `coherenceAgainst` (one `pairCoherence` per other, pairs tested = the pairs with a null, the percentile and the record check on each); `catchOf` and `describeCatch` (one label per measure in a fixed order: connection, proximity, coherence, influence, motif; the head carries conservation and cadence; the phase 3 slots read "not measured (phase 3)"; tiers stated). `fetchRecentHistory` pages `account_tx` newest first with the shared fetcher's pacing (one page after the other, a failed page retried once, a public node's `tooBusy` waited out), because `src/account-tx.js` pages oldest first and a busy hub's recent ledgers are what the probe needs (R14's seam, copied). `frameFromWindow` builds the coherence frame of the live window for a named list as `frameFromLive` does, reading an account that submitted fewer than ten transactions in the window as the transactions it was *involved* in per ledger (a pool, a destination or an issuer submits nothing; the ground-truth run taught this), leaving the probed account's own transactions out of the other's involvement (what it did to a counterparty is its own series already; counting it on the other side made every counterparty in step with it at lag 0 in the first ground-truth run), and says which reading each account got.
- **The worker**: `probe` runs the history through the stream's own request path (2,000 ledgers back from the hold, five pages of 200 at most; none in a replay or a synthetic sky, and the readout says the window is the record), makes the history's counterparties planets, posts the first-degree connections with counts, builds the list (the ten busiest counterparties, the walk's ten nearest through the hubs, the eight busiest galaxy-mates of the planet's core, the six nearest planets in the layout seen in the last 120 ledgers), runs the measures (100 shuffles a pair) and posts the catch with its milliseconds. `explore` loads the account as the explorer does: `account_info` and `account_lines` first, then `account_objects` (a SignerList among them makes a planet with guardians; none at the validated ledger makes the black hole rule, not the candidate) and `account_nfts` (moons), 250 ms apart, a refusal waited out once for the time the node states, each part posted as it lands and kept on the planet for the body rule (`src/universe/bodies.js`). `moment` builds a case from the worker's window (`momentFromLive`) with the probed account as the cast. The live window is 300 ledgers here (the listening page's is 50; `?window=N` for a run that needs more).
- **The page**: the hold (a primary press on a planet for 450 ms without moving; the sky's drag is let go), the release (the beam retracts; the catch stays lit until the next hold or Escape), the probe key (`Space` with the UFO on and a planet focused holds and releases; `Shift+Space` is Start/Stop; without the UFO `Space` is Start/Stop as before), `Enter` explores the focused planet in place and `Shift+Enter` opens it in the explorer, the readout (`#probe`: the history line, the exploration line with what could not be loaded and why, then the catch's lines, the lit ones marked when in step, the tiers line), the text equivalent (the catch's lines through the focus line's status region, one per lit planet), Save this moment (the worker's case with the catch's lines as observation annotations anchored on the window's last ledger, the record's hashes of each lit pair as evidence, downloaded as a case file, the link copied), Copy for AI (the coverage, the last ledger's events with their hashes, the catch under its own heading, the listening page's reply trailer). The short label beside a lit planet is the pair's head and the record's word ("in step at lag +1 · connected: 3", "not touching").
- **Checked.** `bench/check-probe.mjs` on both renderers, on 120 replayed ledgers of the recording: nothing in the sky moves on hover (4,954 planets where they were after the pointer crossed the sky), the UFO on by default, the switch, the one caption, the context menu suppressed on the sky canvas and not on the top bar, a double right-click putting it away, U bringing it back, the setting under the sky's own key, Space holding the probe on the focused planet (the busiest galaxy's core) and releasing it with the catch still lit, the catch with lit planets each carrying the five slots, the proximity rank, the readout's coherence words, no "coordinated", the short labels, the head's cadence from the window, the text equivalent through the focus line, the readout drawer, Copy for AI with the catch under its own heading after the events and the reply trailer (31,204 characters), the probe layer drawn under reduced motion, Escape putting the catch out, no exceptions. `bench/check-a11y.mjs` still passes on both renderers. `node --test`: 476 pass (`test/universe-probe.test.js`: the walk's properties and determinism on a small graph; on the two recorded hubs of the hour (`test/universe-fixtures/probe/`, `account_tx`, `account_info`, `account_lines`, `account_objects` and `account_nfts` recorded verbatim from a full-history node by `bench/fetch-probe-fixtures.mjs`) the conservation rows, the series and the cadence pinned in `expected.json` by `bench/probe-expected.mjs`, exact strings end to end, fees in the XRP outflow; coherence against a named list on a window built from a recorded history; the catch, its words and the text equivalent, nothing saying "coordinated"; the UFO's gestures and store). On the live stream in Brave, the hour's busiest hub probed in 3.9 s: 200 records newest first (49 in the window) before the public node's quota, XRP in and out within 0.05% at lag 0, its issued currency equal in and out, 24 lit, 2 of 4 pairs in step.
- **The ground truth, locally.** `bench/groundtruth-probe.mjs` turned one launch's named accounts' histories (the four snipers present, the pool, their drawn controls; 5,448 transactions over 1,001 ledgers) into a stream, replayed it with the window at 1,001 ledgers, and probed by the page's own entrance. From the first sniper, every other sniper lit in step and not touching (lags +0, +3 and +1; prewhitened r 0.44, 0.26 and 0.31; above 99–100% of 100 shuffles; 14 pairs tested; not connected in the record) and the pool lit connected and not in step (r 0.08, above 82%); from the second sniper the same (lags +0, +0 and −2; r 0.44, 0.22 and 0.31; 12 pairs tested); the first control lit nothing in step of 7 tested, the second one of 8 (chance allows about one); no exceptions. The run's inputs and report stay in the owner's folder. Two earlier runs failed and taught two rules, both now in the code: a counterparty read as involved inherited the probed account's own payments (every counterparty in step at lag 0), and the coherence list stopped at the first degree (the snipers, who touch the pool and not each other, were lit by the walk but never measured).
- **What the public node allows.** The stream's node charges a quota per connection (xrplcluster: 10,000 units a minute); a history page of 200 with metadata, the lines, the objects and the NFTs of a busy account exceed it within one probe. The readout says what was refused and, for the exploration, waits the time the node states once. A second connection for the probe's requests, or the loader's pacing (R14), is the way out; not done here.

- **Checked by hand, 2026-10-24.** The owner asked that the UFO work as desired, so it was driven with real input in Brave (the extension's pointer and keys, not dispatched events) and the hold through the browser's input pipeline in the headless check. Found and fixed: with the pointer on a planet the beam was a dozen pixels long and read as nothing, so over a planet the saucer floats 22 px higher and the beam is brighter; the text equivalent flooded the screen with the catch's lines, so the eye now gets one short line and the screen reader the whole catch (a visually hidden span in the same status region); Save this moment was refused because the case format caps a clip at the listening page's window (50 ledgers) while the sky's is 300, so the moment is the window's last 50 closed ledgers and the readout says so; the catch's short labels piled up over a dense galaxy, so they keep their distance as the galaxy labels do. Verified: two real right-clicks put the UFO away and two bring it back, with no context menu and the switch and the stored setting following; U does the same; hovering a planet shows the beam from the lifted saucer; a real press held on a planet probes it (a short press does not), release retracts the beam and keeps the catch, Escape puts it out; `]` then Space probes the focused planet, Space releases, Shift+Space starts and stops with the probe kept; Save this moment writes the case file and copies the link; the sky does not move on hover.

Copies still in place: phase 1.5's, plus `fetchRecentHistory` (R14) and `frameFromWindow` (R4's territory, with the involved reading); the readout is the sky's own panel (R16). R4 as filed is served by `frameFromLive`'s `cast` option, which takes a list of any length; the involved reading is the new request.

## Phase 2.5: the fractal cosmos, and the inside viewer

The owner's second art direction of 2026-10-23, on the phase 2 sky: make it fractal in nature, so the galaxy does not hollow out as it expands, and give it a good viewer for when you are deep inside the organism. The specification, before the build; the same boundaries.

### What was wrong

The cosmos of phase 1.5 put every galaxy on one shell. The shell is a surface: as the sky grew, new galaxies crowded the same sphere, the inside held only dust, and from the home camera the whole thing read as a hollow ball. And the structure had one level: a hub and its satellites, nothing below a satellite, nothing above a hub.

### The tree

Every planet with at least one counterparty bigger than itself has a **parent**: among its counterparties with more counterparties than it (a tie goes to the elder, the lower id, so the chain never loops), the one it dealt with most. A planet with no bigger counterparty is a **root**. The children of a node are ranked by how much they dealt with it, the busiest first. The sky is a forest of these trees, and the layout is the tree drawn at every scale:

- a node's children sit on its **disc**, a plane through it whose tilt is fixed by its address, at a radius that grows with the child's rank (`base · (0.6 + 0.55 · √(rank + 1))`) and an angle that turns with the rank, a spiral at every level;
- a node's disc **base** is its parent's base times 0.35 (self-similar), and never more than lets its whole disc fit within 45% of its own slot radius on the parent's disc, so a busy child's cluster is a knot inside its slot, not a smear across its siblings;
- a node with five or more children is a **galaxy** when it is a root and a **cluster within** its root's galaxy when it is not; both are drawn as their disc and labelled ("galaxy · N planets around X"; "N planets around X · in the galaxy of R"), N the whole subtree;
- the edge springs of phase 1 are gone: the tree places everything. The record's connections are still the probe's and the weather's business, not the layout's.

### The volume

Roots live in a **ball, not on a shell**. The ball's radius grows with the cube root of the number of planets (`radius · ∛(1 + planets / 400)`), so the density of the cosmos stays what it was: a planet's home is drawn, once, at a radius inside the ball of the moment it was first seen, so early planets stay inside while later ones arrive further out, and the middle never empties. Galaxy roots (roots with five or more descendants) keep each other at a distance (`1.1 · (rₐ + r_b) + 0.05`, their disc radii) with a push in all three dimensions: where it is crowded the cosmos grows outward, organically. Lone roots have only their weak home spring and the crowd. The crowd grid coarsens with the ball so a step costs the same at any size. The camera's home moves out with the ball's radius.

### The inside viewer

A **fly camera**, for the inside: `F` turns it on and off (and the double-click on a planet, and `V` on a focused planet, dive straight in). Flying, the camera is an eye: `W` and `S` move along the view, `A` and `D` sideways, `Q` and `E` down and up, the arrows and a drag turn the view, the wheel moves forward and back, `+` and `−` change the speed. The speed is scaled by the distance to the nearest planet, so inside a galaxy you glide and beside a planet you crawl. Planets keep their perspective size when the eye is among them (the size reference stays at the home distance instead of following the eye), so a galaxy seen from inside is bodies near and sprites far, not a sky of dots. The dive puts the eye a dozen planet-radii from the planet, facing it, with a short glide; under reduced motion the eye arrives at once, and nothing drifts. A small line under the top bar says where you are: the speed, the nearest planet and its distance, the galaxy you are in. `0` returns to the orbit home. Everything that moves on screen is the user's own motion: the sky itself still stands.

### Measured

Layout step time at 20,000 planets with the tree (goal: what phase 1 measured, under 15 ms warm); the radial density profile of a replayed hour (the share of planets within half the cosmos radius, which the shell gave as nearly none); frame time inside a galaxy at 20,000 planets on both renderers (the WebGL budget holds; the 2D canvas is reported).

### Tests and acceptance

Layout tests: the tree rule on a small record (parent is the busiest bigger counterparty, ties to the elder, no loops), the self-similar base and its slot cap, a root's home inside the ball of its moment, galaxy roots pushed apart in three dimensions, a step at 20,000 nodes under budget. Camera tests: the fly eye's moves and turns, the dive's placement and facing, the size reference held at the home distance. A headless check replays the recording and asserts: the middle is not hollow (at least a fifth of the planets within half the cosmos radius); the fly keys move the eye and the arrows turn it; a dive puts the eye within 0.3 of the planet and faces it; under reduced motion the dive arrives at once; frame time under the budget inside a galaxy; no exceptions. The beauty-gate line, seen from inside, is the owner's.

### Decisions to propose, not make

1. **The scale between levels.** Proposed 0.35, with the slot cap at 45%: deep enough to read as the same shape smaller, small enough that a cluster stays inside its slot.
2. **The ball's growth.** Proposed ∛(1 + planets / 400) on a radius of 1.2: the density of the first 400 planets, kept.
3. **What the dive faces.** Proposed: the planet, from the side the eye came from, a dozen of its radii away; recommended over a fixed approach so the dive never crosses the planet.

### As built (phase 2.5)

Branch `feat/universe-fractal`, on phase 2 (`feat/universe-probe`, PR #38). Same files, no shared module edited.

- **The forest** (`src/universe/forest.js`, pure): `forestOf({ edges, degreeOf, count })` gives every planet its parent (the busiest of its bigger counterparties; a tie in degree to the elder, a tie in count to the lower id), the children of every node ranked by count, each node's depth, root and subtree size. A chain cannot loop: along it the degree never rises and, where it is equal, the id falls. The worker runs it every ledger and hands the layout each node's children list; a node with five or more children is posted as a galaxy (a root) or a cluster within its root's galaxy, its subtree the size, its disc the shape; the per-planet `core` attribute is the galaxy root (0 outside any galaxy: the dust), and a new `depth` attribute lets the renderers dim the deep levels at far zoom (`DEPTH_DIM`: a root and its children full, the next level at 0.55, deeper at 0.35), so the structure reads with depth.
- **The layout** (`src/universe/layout.js`, rewritten): the edge springs are gone; a child's one spring is to its slot on its parent's disc, a root's to its home. Homes are drawn inside the ball of their moment (`extentFor(count) = radius · ∛(1 + count / 400)`), uniform in volume (the old 15% hollow at the centre is gone: a 2% floor keeps a planet off the exact centre). **Slots are packed, not crushed:** the specification's cap (a child's disc within 45% of its slot) crushed an 887-planet cluster into a knot of radius 0.03; instead each child's orbit is placed outside the previous child's whole disc (`slotGap` 0.6 of the two radii, never less than the spiral's step), so a disc grows with its children's discs and the shape is the same at every level. The crowd repulsion acts on roots only: a child's slot is its place, and the crowd's reach (the grid cell, which coarsens with the ball to keep 96 cells a side) would undo any disc smaller than itself. Galaxy roots (five or more descendants) push each other apart in three dimensions at their disc radii; the camera's home moves out with the ball (`2.2 · extent + 1.6`). Per-step caches hold each node's disc base, packed slot and disc radius.
- **The inside viewer** (`src/universe/flycam.js`, pure; `SkyBase` delegates): flying, the camera is an eye (the target 0.02 ahead of it, so the same projection serves) with `sizeDistance` 1.4 held apart from the eye's distance in both renderers (`referenceScale` in the projection copy; a `uSizeDistance` uniform in the WebGL vertex shader), so planets keep their perspective size among the eye. `F` toggles; `W`/`S`, `A`/`D`, `Q`/`E` move along the axes (the held keys integrate in the frame loop at 0.5 units a second, scaled by the distance to the nearest planet within 0.3, a tenth at least); the arrows and a drag turn; the wheel moves; `+`/`−` set the speed factor; `V` and a double-click on a planet dive (0.12 from the planet on the side the eye came from, facing it, a 600 ms smooth step, at once under reduced motion); `F` again orbits the nearest planet when one is within 0.6, else the point ahead; `0` goes home. The HUD under the top bar says the speed, the nearest planet and its distance, the galaxy (or the field), and that F leaves; the footer's keys change while flying. While flying the layer and sound keys are the buttons' (D and S move).
- **Seen.** On the replayed hour at 550 ledgers and 7,100 planets: 96 galaxies and clusters (25 roots, 71 within, depth up to 4), the largest tree 1,529 planets with a disc of 2.23 and clusters inside it of 859, 419, 332 and 212 planets at radii 0.39, 0.07, 0.02 and 0.008 (the scale between levels holds); 42% of the planets within half the ball (the shell gave nearly none); the ball 3.19 and the home 8.6; 2.6 ms frames on the GPU; layout steps 3–5 ms (the packing's per-step work; phase 1 measured 1–3 ms with the springs). Diving into the largest galaxy's root puts the eye among bodies with the clusters as small spirals beside and ahead.
- **Checked.** `bench/check-fractal.mjs` on both renderers, on 150 replayed ledgers (5,170 planets): the middle not hollow (39.4% within half a ball of 2.89), the forest's depth (17 galaxies, 38 clusters within, depth up to 4), the camera's home out with the ball (7.95), a layout step under the phase 1 budget (3.1 ms WebGL, 9.6 ms 2D, software), F on, W moving the eye 0.27 in 0.4 s, the arrows turning, the size reference held, the HUD, the dive at 0.120 facing 1.000, frame time inside a galaxy (mean 2.5 ms and p95 4.4 ms WebGL; 4.6 and 8.3 ms 2D, software), the reduced-motion dive at once, F back to orbit, 0 home, no exceptions. `node --test`: 494 pass (`test/universe-layout.test.js` rewritten for the tree: homes inside the ball of their moment, the ball's growth, a cold sky unmoved by a newcomer who travels to its slot, a child on its slot and a lone root at home, the self-similar base and the packed slots, galaxy roots apart in three dimensions, a fifth of 3,000 homes within half the ball, a 20,000-node step under budget; the forest rule with ties and the no-loop guarantee; `test/universe-flycam.test.js`: orthonormal axes with forward the view, the eye at depth zero, entering flight keeps the eye and holds the size reference, leaving drops it, moves along the axes, the slowing, the angles toward a direction, the dive's end and facing and its reduced-motion form). On the GPU (Brave) at 20,000 synthetic planets, the ball 4.45 with 200 galaxies: 3.6 ms a frame from the home (p95 4.1), 2.2 ms inside the largest galaxy (p95 2.8), the layout 7.1 ms a step: the budget holds. The beauty-gate line, seen from inside, is the owner's.

## Phase 3A: shared price, a probe measure (limited arbitrage, after Chichilnisky)

The owner's brief of 2026-10-24: two new probe measures in two stacked pull requests, Part A the shared price and Part B the next-ledger forecast. The same boundaries and ground rules as phase 2. **Before any code**, in git: PR #37 (phase 1.5) and PR #38 (phase 2) are **open, not merged** (checked 2026-10-24; `main` is at #32), so Part A branches from the tip of the stack, `feat/universe-fractal` (PR #39), and Part B stacks on Part A; each pull request says so. The requests this needs are filed as R18–R21 in `docs/universe-requests.md`, copied under `src/universe/` until they land.

**Common rules for both parts.** Every readout is literal words and numbers, each with what it was measured on and the ledgers covered. Every cap, window and threshold is chosen here and printed there. The measures run in the worker; the time they took and the counts they saw are printed. Drawings and sounds are proposed here for the owner to decide; nothing in the sky moves on hover. Nothing in any readout reads as a trade signal: no "will", no "buy", no "opportunity".

### Sources, and what is taken from them

- G. Chichilnisky, "A topological invariant for competitive markets", *Journal of Mathematical Economics* 28(4), 1997, 445–469. The invariant is the homology of the nerve of the market cones. Its equilibrium theorem (that limited arbitrage is necessary and sufficient for a competitive equilibrium) is **contested**: P. K. Monteiro, F. Page Jr. and M. H. Wooders, "Arbitrage, equilibrium, and gains from trade: A counterexample", *Journal of Mathematical Economics* 28(4), 1997, 481–501. **This measure uses none of the equilibrium theorem**: only the nerve, Helly's theorem and linear-programming duality (a system of difference constraints is infeasible if and only if its constraint graph has a negative cycle, which Bellman–Ford finds and returns).
- G. Chichilnisky, "Intersecting families of sets and the topology of cones in economics", *Bulletin of the AMS* 29(2), 1993, 189–207, arXiv:math/9310228. Read from the paper: the market cones are defined in §3.3, equations (3) (the asymptotic preferred cone \(A_i\)), (4) (the market cone \(D_i = \{p : \forall v \in A_i, \langle p, v\rangle > 0\}\)) and (5) (limited arbitrage: \(\bigcap_i D_i \ne \emptyset\)); the nerve of a family is "the simplicial complex having as vertices the nonempty elements of the family and whose simplexes are finite nonempty subsets with nonempty intersection" (§2); **Corollary 1** (p. 11): an acyclic excisive family in \(\mathbb{R}^n\) with at least n+1 elements has a nonempty intersection when every subfamily with n+1 elements has one; **Theorem 11** (p. 17), whose part (c) says the whole economy has an equilibrium if and only if every subeconomy of at most n+1 traders has one. Here the "traders" are the candidates, the "goods" the assets in play, and each candidate's cone is the set of price vectors under which all its offers rest; the family is convex (an intersection of half-spaces), so Helly applies as Corollary 1 states it.
- G. Peduzzi, J. James and J. Xu, "Jack the Rippler: Arbitrage on the Decentralized Exchange of the XRP Ledger", arXiv:2106.16158 (v2, 2021). Read from the paper: §II, Fig. 1: "XRPL does not allow a cross-currency Payment cycle from XRP to XRP. Therefore, two transactions must be performed to complete an XRP to XRP arbitrage cycle": account A's OfferCreate buying XRP with a currency only account B trusts, then A's cross-currency Payment to B that fills A's own offer, A and B "controlled by the same entity". §II.A: the bot builds a graph with the best offer per pair as the edge and runs Bellman–Ford for negative cycles ("A negative cycle represents a path with a negative cost, i.e. a positive gain"), then "build transaction paths according to the cycle". The loop-take rule below is this pattern made testable.
- xrpl.org, *book_offers*: `owner_funds` is "Amount of the TakerGets currency the side placing the offer has available to be traded" (only on the owner's highest-ranked offer in the book); `taker_gets_funded` and `taker_pays_funded` are "the maximum amount of currency that the taker can get [or would pay], given the funding status of the offer" (only on partially funded offers); `quality` is "the exchange rate, as the ratio taker_pays divided by taker_gets"; "the response omits unfunded offers". `ledger_index` takes a ledger.
- xrpl.org, *amm_info*: `amount` and `amount2` are "the total amount of one asset [and the other] in the AMM's pool"; `trading_fee` is "in units of 1/100,000; a value of 1 is equivalent to a 0.001% fee"; the request takes `asset`/`asset2` or `amm_account`, and `ledger_index`.
- xrpl.org, *Transfer Fees*: `TransferRate` is "the amount you must send for the recipient to get 1 billion units of the same token", from 1000000000 (0%, also written 0) to 2000000000 (100%); "the transfer fee does not apply when sending or receiving directly to and from the issuing account"; "transfer fees apply starting from the end and working backwards".
- xrpl.org, *TrustSet*: `QualityIn` and `QualityOut` "value incoming [outgoing] balances on this trust line at the ratio of this number per 1,000,000,000 units"; 0 is face value; "this fee is separate and independent from token transfer fees".
- rippled, `src/libxrpl/tx/paths/BookStep.cpp` (branch `develop`, read 2026-10-24), the engine's actual rules for an offer crossed inside a payment: `rate(view, asset, dstAccount)` returns parity "if (isXRP(issue.account) || issue.account == dstAccount)" and otherwise `transferRate(view, issue.account)`; in `forEachOffer`: "Charge the offer owner, not the sender · Charge a fee even if the owner is the same as the issuer": `trIn = redeems(prevStepDir) ? rate(book_.in) : QUALITY_ONE` and "Always charge the transfer fee, even if the owner is the issuer": `trOut = ownerPaysTransferFee_ ? rate(book_.out) : QUALITY_ONE`; in `limitOfferIn`/`limitStepOut`: `ownerGives = mulRatio(ofrAmt.out, transferRateOut, QUALITY_ONE)` and `stpAmt.in = mulRatio(ofrAmt.in, transferRateIn, QUALITY_ONE)`; the effective quality is `composedQuality(getRate(trOut, trIn), ofrQ)`. And: "Make sure offer owner has authorization to own Assets from issuer … Offer owner not authorized to hold IOU/MPT from issuer. Remove this offer even if no crossing occurs." The file reads no trust-line `QualityIn`/`QualityOut`.
- rippled, `src/libxrpl/tx/paths/DirectStep.cpp` (same branch): trust-line qualities are applied in **direct steps** (`qualitiesSrcRedeems`, `qualitiesSrcIssues`: the source's QualityOut, the destination's QualityIn, "charge a transfer rate when issuing and previous step redeems", the last step's QualityIn capped at parity), i.e. when a payment ripples through an account's trust lines.

### What it measures

At a stated validated ledger L, each candidate account's **revealed market cone**: the set of positive price vectors (one price per asset; an asset is XRP or a currency with its issuer) under which every one of its funded offers is resting, i.e. the owner receives at least the value it gives. In log prices \(\pi\), each offer is one **difference constraint**:

```math
\pi(\text{TakerGets asset}) - \pi(\text{TakerPays asset}) \le \log q_{\text{eff}}
```

A group of candidates **shares a price** when the union of their constraints is feasible, which Bellman–Ford decides on the constraint graph (one vertex per asset, one edge per offer from the TakerPays asset to the TakerGets asset with weight \(\log q_{\text{eff}}\)); XRP is the numéraire (\(\pi(\text{XRP}) = 0\)). When it is infeasible, the **negative cycle is the certificate**: the offers in order with their owners, the loop's edge after fees (\(1/\prod q_{\text{eff}} - 1\), printed as "+x.xx% after fees"), and its **room**: the most that fits through the loop given funded sizes, in the loop's starting asset (the smallest funded size along the loop, each converted to the start by the legs' effective qualities; through a pool, the input at which the pool's average quality after its own price impact would close the loop's gain, found by bisection), all at L.

**Effective quality.** Funded amounts only: `taker_gets_funded`/`taker_pays_funded` when present, else `TakerGets`/`TakerPays` capped by `owner_funds` (the first offer of an owner in a book carries it; the owner's later offers in the same book draw on the same funds, which this pass takes at face and says so). The engine's rules above, for a loop taken by one payment whose taker is a holder, not an issuer, of every token in the loop (so every token leg of the taker's redeems): the taker pays `TakerPays × TransferRate(issuer of TakerPays)` and the owner gives `TakerGets × TransferRate(issuer of TakerGets)`, parity for XRP and for a token whose issuer is the taker. The loop's edge uses the taker's effective quality \(q_{\text{eff}} = (\text{TakerPays}/\text{TakerGets}) \cdot \text{rate}_{\text{in}}\); a candidate's resting constraint uses the owner's: receives TakerPays, gives TakerGets × rate\(_{\text{out}}\). Trust-line **QualityIn/QualityOut are not applied**: the engine applies them in direct steps, and **rippling through trust lines is out of scope this pass; the readout says so.** AMM pools are vertices with a two-sided constraint from `amm_info`: with reserves \((R_a, R_b)\) and fee \(f = \text{trading\_fee}/100000\), the pool stands ready at the marginal qualities \(R_a/(R_b(1-f))\) for b-for-a and \(R_b/(R_a(1-f))\) for a-for-b, which can never loop on their own. Offers on frozen or unauthorized lines are **excluded and counted** (the engine removes them; `book_offers` omits the unfunded).

**Candidates.** The focused account; the makers on the books among the assets its funded offers touch (both directions of each book), the busiest first by funded size, at most 3 per book; XRP is always an asset in play; **the cap is k = 10 candidates** and the selection rule is printed in the readout ("10 candidates: the probed account and the 3 largest makers by funded size on each of its 4 books, at ledger L"). If the focused account has **no funded offers at L**, the measure says so and lights nothing.

**The nerve.** Vertices are the candidates; a simplex for every group that shares a price. Groups are enumerated upward by size, a group tested only when all its subgroups passed. With n assets in play, no minimal failing group exceeds n+1 (Helly, Corollary 1; the paper's Theorem 11(c)); above that size a group is a face if and only if all its (n+1)-subgroups are, and is not tested. The **minimal non-faces are the loops**: each needs every one of its members. **Betti numbers over GF(2)** are the paper's invariant, computed from the boundary matrices' ranks modulo 2, in one summary line: "nerve: β₀ a · β₁ b · β₂ c (k candidates, n assets, ledger L)", and the one sentence this specification allows about it: *with every pair sharing a price, β₁ counts the independent loops; nothing further is read into the numbers.*

**The catch, in the readout's words.** "one price fits" when the whole group shares a price; for each minimal failing group, "loop across g accounts · +x.xx% after fees · room y · ledger L", with the offers in order ("A gives 100 USD.rI for 95 EUR.rJ · q 0.9500 · rate 1.0050 → 0.9548"). Never "arbitrage", "inefficient", "diverse" or "equilibrium"; the help sentence names the paper. **Proposed drawing** (the owner decides): a translucent face spanning a group that shares a price, an empty outline through the planets of each loop, in the pulse colour.

**Data.** Live: R18, copied as `src/universe/books.js` (`book_offers` both ways per book and `amm_info` per pool at L, one request at a time through the stream's node, a refusal waited out once). **Replay** reconstructs offers from the Offer nodes in the recording's metadata (created, modified and deleted, with their final `TakerGets`/`TakerPays`), taken at face since funding is not in the record, and **states that offers created before the window are unseen**.

**The loop-take rule** (Part B reuses it): (1) a Payment whose `Account` equals its `Destination` whose metadata consumed offers (the facts layer: offers with role `book` and `traded` yes); (2) a same-ledger pair between two accounts that look like one operator: an OfferCreate by X and a cross-currency Payment by Y (its `Amount` currency differing from its `SendMax`'s, or its paths non-empty) that consumed X's offer created in that same ledger, X ≠ Y, the pattern of Fig. 1 of Jack the Rippler; **the pairing rule**: the payment's consumed offers include one whose owner created it in the same ledger, matched by owner and sequence.

**Tests.** Synthetic books with known answers: three makers on A/B, B/C and C/A with qualities whose product is below 1 (every pair shares a price, the triple does not, β₁ = 1, the loop's edge equal to the constructed value); the same above 1 (the nerve filled, β₁ = 0); a fourth maker priced with every pair (the Betti numbers worked by hand in the test); an unfunded offer that would close a loop (excluded and counted); a transfer fee that turns a nominal loop negative (not reported). **Ground truth:** the loop-takes in the recording by the rule above, the measure run at the ledger before each, and the loop taken must appear with the same offers; if there are none, the check says so and what was searched.

### Decisions to propose, not make

1. **The cap.** k = 10 candidates, 3 makers per book: the nerve has at most 1,024 groups and Bellman–Ford runs under a millisecond each; recommended.
2. **The drawing.** Faces as translucent polygons and loops as outlines, in the pulse colour, drawn on the overlay only while the catch is lit; recommended as the ignition language and nothing new.
3. **The pool's room.** The pool leg's room from the pool's own price impact (above), rather than the pool's whole reserve; recommended because the reserve overstates what the loop can take at its gain.

## Phase 3B: next-ledger forecast, with the ledger clock and the wake

Part B of the same brief, stacked on Part A. Same rules.

### Sources

- R. P. Adams and D. J. C. MacKay, "Bayesian Online Changepoint Detection", arXiv:0710.3742 (2007): the online run-length posterior with a constant hazard, exact for conjugate models; here Poisson–Gamma for counts.
- E. S. Page, "Continuous inspection schemes", *Biometrika* 41 (1954), 100–115: the CUSUM. Its reference value k and threshold h are **set for a stated in-control average run length by simulation** at start (the threshold is searched on standard normal residuals until the mean run length to a false alarm reaches the stated ARL); no closed form is recalled.
- xrpl.org, *fee*: `expected_ledger_size` is "the approximate number of transactions expected to be included in the current ledger … based on the number of transactions in the previous ledger"; `current_ledger_size`, `current_queue_size`, `drops.open_ledger_fee`.
- xrpl.org, *subscribe*: `transactions_proposed` "sends a message whenever a transaction is included in a closed ledger, as well as some transactions that have not yet been included in a validated ledger and may never be", told apart by a missing or false `validated`, no `meta`, and a `ledger_current_index`; `validations` "whenever the server receives a validation message, regardless of if the server trusts the validator" (`ledger_index`, `validation_public_key`, `signing_time`, `cookie`, `server_version`); the `ledger` stream's `ledger_index`, `ledger_time`, `txn_count`, `fee_base`.
- xrpl.org, *book_changes*: per book in a ledger `currency_a`, `currency_b`, `volume_a`, `volume_b`, `high`, `low`, `open` ("the exchange rate at the top of the order book before the ledger's transactions were processed") and `close` (after).

### Clocks

The **ledger sequence is the primary clock**. Each ledger's **local arrival time** (the worker's clock when its `ledgerClosed` arrived) is stored beside it (R21; the worker's own map until it lands), so wall-clock features (time of day, weekday) can be used **once enough history exists**: a day-of-week feature needs at least two of each weekday, a time-of-day bin at least 20 ledgers in it; until then the readout says "wall-clock features: not yet (history 3 h)". Per-book or per-account event clocks are optional and named when used. **The recording of 2026-10-23 carries no local arrival times and no proposed, fee or validation messages** (raw stream lines only); on it the close-interval target cannot be scored, the nowcast is unavailable, and the readout says so.

### Targets for ledger N+1, scored when N+1 validates

1. Transaction count, and the type mix (the field guide's categories as shares).
2. Which of the top-m active accounts (m = 20 by submitted count over the window) transact, from cadence.
3. For each loop Part A reports at N, whether it is taken within j = 3 ledgers by the loop-take rule.
4. The real close interval, from local arrival times. **Never the header `close_time`**: it is rounded to the close-time resolution.
5. Book closes from `book_changes`, **behind a research switch, off by default**, until the owner decides; the switch cross-checks `book_changes` against the facts layer's offer findings per book per ledger and reports mismatches (count and the first three).

### Sealed past

The forecaster reads only through an **accessor that cannot return any ledger after N** (`SealedPast.at(N)` yields rows ≤ N and throws on any later index); a test asks for N+1 and must fail; a deliberately leaky feature (N+1's own count) **must be caught by the accessor, not by review**. Replay and live run the same code; a **parity test** replays a recorded live session and requires identical forecasts at every ledger.

### Two modes

**forecast** (closed ledgers only) and **nowcast** (adds the proposed transactions and the fee results seen before the close), labelled differently everywhere. Nowcasts only on recordings made under R19 or live; the existing recording holds none, as checked.

### Ropes

For each tracked metric (transaction count; type shares; fee level and queue size where recorded; per-book volume behind the switch), an **EWMA bank** of mean and variance at half-lives of **1, 4, 16, 64, 256 and 1,024 ledgers**, each labelled with its current wall-time length from the arrival times ("64 ledgers ≈ 4.2 min"). A rope longer than the available history is **never drawn as if it had one**: each rung states how many independent windows stand behind it (history ÷ half-life, floored), and a rung with fewer than two is drawn dashed and says "forming".

### The wake

Per metric: the **standardized gap** between the short rope (half-life 4) and the long rope (64), in the long rope's standard deviations; a **CUSUM** on the residuals against the long rope, with its reference value k = 0.5 σ and its threshold h set for an in-control average run length of **500 ledgers** by simulation at start (the ARL and the h found are printed); and **Bayesian online change-point detection** (Adams & MacKay 2007; Poisson–Gamma for counts, Normal–Gamma for shares; constant hazard **1/200** per ledger, stated), reporting the run length in ledgers and the probability of a change at this ledger. When that probability exceeds **0.5**, forecast intervals widen to the short rope's and fall back to its mean, and the readout says which. **Proposed drawing**: a wake behind the sky's clock that runs straight when steady and bends on drift, with a knot at each detected change.

### Event studies

For every taker trade above a stated size (**the 90th percentile of fills in the window, by the book's XRP-equivalent value**), record the mid, the spread and the top-of-book depth from N−w to N+w (w = 8), from the standing offers; average by book with **bootstrap bands** (200 resamples, 80%); report the price move, the depth half-recovery in ledgers, and the persistence (the share of the move left at N+w). The curves are **candidate signals under the same out-of-sample rule** as every other. Paper trades only behind the research switch, never with profit shown publicly, with the simulator's blind spots printed: no own impact, no ordering lottery, no queue position.

### Models, simple first

Baselines per target: **persistence** (N's value), the **EWMA** (half-life 16), and **the server's `expected_ledger_size` where recorded**, labelled as that server's own heuristic rather than network truth, with the server named. Then **one-signal regressions**, each shown separately (ridge, λ = 1, fitted on the tuning portion). Then a **2–3 state hidden Markov model** of activity regimes with Poisson emissions, fitted by Baum–Welch (states chosen by held-out likelihood), and a **Hawkes process** for burstiness (exponential kernel, parameters by maximum likelihood on the tuning portion). **Signals are combined only when each beats the baselines out of sample**; the number of signals tried is printed.

### Scoring, always visible with the ledgers covered

**Skill against each baseline** (1 − MAE/MAE_baseline), **interval coverage** for counts (the share of outcomes inside the 80% interval), **Brier score** for binaries. If nothing beats persistence, the readout says so. Tune on an earlier portion only and report on a held-out later portion or a second recording: **the split is the first 60% of ledgers for tuning, the last 40% held out**, stated in the readout.

### Readout

The forecast, its interval and its record, never "will": "count 112–148 (80%) · coverage 81% over 240 ledgers · persistence skill +0.07". **Proposed**: guess-then-resolve, the guess shown before each close and resolved when it lands, in sight (a bar that fills) and sound (a soft tone at the guess, a lower one on a miss).

### Tests

Synthetic Poisson and Hawkes streams with known parameters recovered within tolerance; an HMM fixture with known regimes recovered; the sealed-past and leak tests; the parity test; streams with a planted shift at a known ledger, where CUSUM and change-point detection flag it within a stated delay and the false alarms on a no-shift stream match the stated run length within sampling error; an event-study fixture with a planted impact curve recovered within its band.

### Decisions to propose, not make

1. **The hazard.** 1/200 per ledger: a change every 13 minutes a priori, between the bursts seen in the recording and the quiet hours.
2. **The split.** 60/40 by ledgers, with the second recording (when made under R19) as the held-out set in preference.
3. **The guess-then-resolve display**, in sight and sound, as proposed above.

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

Made on 2026-10-23, one line each; the spike had listed them without making them.

1. **Naming and labelling.** On-ledger Domain and the user's labels (the Watch cast's) only. A curated list is phase 2, with a source per label and never a verified-owner claim.
2. **Persistence.** The local record cache, built by the other session in its loader PR; the sky consumes it. Export as a file comes later, from the cache.
3. **Art direction.** Arrives in `docs/art.md` from the owner. Until it lands the sky inherits the plate's look exactly and invents no palette, type or motion of its own.
4. **WebGL.** Permitted: hand-written, the canvas as the fallback, both paths tested, reduced motion in both.
5. **Thresholds.** As proposed, printed on every body's label, with the hour's distributions in this document.
6. **Batch.** A flash in the glyph's colour.
7. **The mode map.** A fourth door and its own page; the Watch cast is highlighted in the sky; Learn jumps in at phase 4.
8. **A camera anchor** in annotations: deferred to phase 4.
9. **The synthetic mode.** Behind a flag, labelled on screen, never default.

The spike's record of the options, as they were listed before the decisions, is in the history of this file (PR #32).

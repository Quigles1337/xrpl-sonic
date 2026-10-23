# xrpl-sonic

**Listen to the XRP Ledger: every transaction becomes a sound, every ledger close a pulse.**

Live: **https://quigles1337.github.io/xrpl-sonic/**

[![Tests](https://github.com/Quigles1337/xrpl-sonic/actions/workflows/test.yml/badge.svg)](https://github.com/Quigles1337/xrpl-sonic/actions/workflows/test.yml)
[![Deploy](https://github.com/Quigles1337/xrpl-sonic/actions/workflows/pages.yml/badge.svg)](https://github.com/Quigles1337/xrpl-sonic/actions/workflows/pages.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![xrpl-sonic playing mainnet: the detector plate with a ledger pulse ring, photon, lattice and star tracks, the ledger number stamped behind them, the transaction tape and the instrument panel](docs/screenshot.jpg)

xrpl-sonic is a single page with no dependencies and no build step. It opens a WebSocket to a public XRPL node, subscribes to the `ledger` and `transactions` streams, and turns what arrives into synthesised sound and a field of tracks with the Web Audio and Canvas APIs. Press **Start**, turn the volume down, and listen to the network settle one ledger at a time.

## Sound mapping

| Transaction type | Sound | Pitch / variation | Track on the plate |
| --- | --- | --- | --- |
| `Payment` | Plucked, kalimba-like tone | `log10(amount in XRP)` picks a scale degree across five octaves: dust is high, whales are low. Payments of 100,000 XRP and above add a sub-bass drop. Issued-currency payments use a reedier timbre and a hollow track. | A photon with a comet tail. Whales glow wider and leave a Cherenkov ring; issued-currency payments are hollow. |
| `OfferCreate` / `OfferCancel` | Closed hi-hat / rim tick | Stage position per account, so market makers become recognisable. | A spectral line: a thin vertical flash with a glint at ignition. A cancelled offer is struck through. |
| `TrustSet` | Soft pad swell (root + fifth) | One note per issuer. | A hexagonal cell that grows a bond to its issuer, like a crystal forming. |
| `NFTokenMint`, `NFTokenCreateOffer`, other `NFToken*` | FM bell | Upper register, keyed on the token or taxon. | A four-point star with a lens flare at ignition, turning slowly. |
| `EscrowCreate` / `EscrowFinish` / `EscrowCancel` | Reverse-cymbal swell | `EscrowFinish` resolves into a chime; pitch from the escrowed amount. | A dial that winds shut on create, springs open on finish and is struck through on cancel. |
| `PaymentChannel*` | Four-note ascending arpeggio | Keyed on the channel. | Four bars that light in step with the arpeggio, climbing to the right. |
| `AMM*` | Soft triad | Keyed on the pool's asset. | Three overlapping rings, breathing together. |
| Everything else (`AccountSet`, `TicketCreate`, `Batch`, `Check*`, ...) | Quiet click | Stage position per account. | A single bright mote. |
| Ledger close | Low tick with a pitch drop | The inter-close interval (usually 3–5 s) runs as a segmented metronome in the command strip. | A ring from the centre of the plate; the grid lights up and the ledger number is stamped faintly behind it. |

Only validated, successful transactions sound by default; there is a toggle for failed ones. Eight scales (major and minor pentatonic, major, Dorian, Lydian, blues, Hirajoshi, whole tone) and twelve keys are available.

### The plate

The canvas is a cloud chamber for a ledger, seen in perspective: the floor is the pitch axis with a ruler along its near edge marking the octaves (C2 to C7), tracks rise through a shallow volume and fade with distance, ledger closes ripple across the floor, and the camera sways slowly on its own. Drag to orbit it, scroll to move closer, double-click to reset. The horizontal axis is pitch; because payments map amount to pitch, whales land on the left and dust on the right, and a busy issuer or market maker shows up as a column of identical tracks at one position. Every track ignites with a white-hot flash, scales in with a little overshoot and fades on the same schedule as its sound. The same glyphs appear as the legend tiles under **Settings → Transaction types**, on the start screen and beside every line of the transaction tape, so shape, colour and sound are learned together. The field guide lives in `src/glyphs.js`; the renderer in `src/visual.js` keeps it cheap with cached glow sprites, cached grid and ruler layers, capped track counts and no `shadowBlur`.

### Staying musical when the ledger is busy

Transactions do not trickle in: each validated ledger arrives as a burst of anything from 50 to 600 transactions every few seconds. The audio engine spreads each burst across the expected inter-ledger interval, caps polyphony, and applies a short per-type cooldown. Events that do not fit are rate-limited rather than queued, so the sound never drifts behind the ledger; they still appear as dimmer tracks. The **Session** panel shows how many were played versus rate-limited. **Quiet mode** keeps only transactions at or above a chosen XRP amount.

## The explorer

[explorer.html](https://quigles1337.github.io/xrpl-sonic/explorer.html) is the reading room: one box that takes anything you paste (an account, a transaction hash, a ledger index, a currency code, or the word `latest`) and says what it recognised as you type.

- **An account is a place, in three dimensions.** Its XRP is a ring whose radius grows with the balance; the reserve is the disc inside it (a disc that reaches the ring means the account is at its reserve); each currency it holds is a further orbit on its own tilted plane, in the currency's colour, with a bead travelling along it; the accounts it dealt with in its recent transactions are stars on a sphere around it, the most frequent nearest, each coloured by what they mostly did together and ringed in the hue of its sigil, and the counterparties of its trust lines are stars in their currency's colour. Every record is a line from the centre to its star, and the drawing says what it is: a trust line in its currency's colour, as wide as its balance, with an arrowhead on the trusted side (at the star when this account trusts it, at the centre when it trusts this account); a transaction as a strand in the colour of its type, as wide as its amount, with an arrowhead at the receiving end when value moved between the two, a bead in its currency's colour, dashed when it failed, dotted when it was a partial payment. Lines to the same star fan out side by side; the legend names the types and currencies on the page, and every currency keeps the same colour wherever it appears. Point at a star to read every line to it, click to go there; drag to orbit the view, scroll to move closer, double-click to reset. Beside it: the recent transactions as a tape, trust lines, owned objects, flags in plain words, and the reserve in XRP. Everything on the page is read at one validated ledger (named beside the address); the transactions stay bound to it as you load older pages, the stars say how many records they cover, and a part the node could not return says so rather than looking empty.
- **A transaction is explained from its own metadata.** One sentence says what happened (who sent what to whom, which offer was placed and which earlier one it replaced, what a failure code means); then the balance change of every account it touched, before and after; then every ledger entry it created, modified or deleted, in words, with the bookkeeping directory nodes counted rather than listed. The sentences are rendered from typed findings (`src/explorer/facts.js`): every property carries a tier (observed, calculated, rule-based, hypothesis), a rule id and the fields it was read from; amounts are exact strings; and "unresolved" is said when no rule applies. An offer's fill is judged against the side it asked for (TakerPays received, or TakerGets spent with tfSell), so a partly filled immediate-or-cancel reads as partly filled, a stale offer swept off the book is not called consumed, and an OfferCreate filled by an AMM pool says so. **Why it says that** lists the findings under every explanation; the rules are documented in [docs/facts.md](docs/facts.md).
- **A ledger is a plate.** Its transactions drawn at their pitch, the mix of types as a bar, the tape, and one click to replay it with sound on the listening page.
- **Sigils.** Every account carries a small mark derived from its address, the same everywhere it appears, so you recognise it without reading it.
- **Sound.** Turn Sound on and point at any record to hear it; press `P` on an account to play its recent history as a phrase; **Listen live** opens the listening page with the account in the cast.
- Keys: `/` search, `[` `]` back and forward along the trail, `L` latest ledger, `R` a random account from the latest ledger, `?` help. `?network=testnet` reads the test network.

Everything is read by your browser from a public node, cached for the session, with links to XRPScan, Bithomp and xrpl.org for anything beyond.

## Follow a cast

**Settings → Cast** follows up to five accounts. Each member gets a voice of its own (marimba, glass, brass, reed or pulse), a place in the stereo field, a colour and a label, so the same participant sounds and looks the same every time it acts: the market maker is the brass on the left, the issuer the glass in the centre. **S** solos a member (only soloed members sound), **M** mutes one, and **▶** plays the member's three-note motif, so you can learn a voice before you listen for it. Transactions that involve nobody in the cast are played in their category voice (**Play everything**), drawn dimmed and silent (**Mute others**) or not drawn at all (**Hide others**).

A transaction involves a member when the member is the sender, the destination, or appears in the transaction's metadata (`AffectedNodes`), which covers trust lines, consumed offers, issued-currency flows and anything else that touched one of its ledger entries. Involvement is a filter: it says the account appears in the record, not how much value it gained or lost, whether an order filled, or whether two addresses share a controller. A transaction involving several members is one event, counted once: the sender's voice (or the first involved member's) plays the note and each other involved member is heard as a short cue in its own voice just after it. On the plate a member's track carries a ring in its colour and its label; when two members meet in one transaction a bond is drawn between their tracks, and the tape shows who else was involved.

The cast travels in the URL as `#cast=`, so a link carries it:

```
https://quigles1337.github.io/xrpl-sonic/#cast=rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah~Maker~brass~-0.6,rKNRrawfVS59C3tN1bBiUWc5wZQAfUPh7z~Issuer
```

`#account=<r-address>` still works as the one-member shortcut: it follows that account and mutes everything else, as it always has. Addresses are validated as base58 r-addresses and the cast is shown in the command strip, each chip linking to the explorer.

Every line in the log is a link, as are the cast chips and the inspector's parties, ledger and hash: the transaction opens on an explorer, each account opens its account page, and ledger lines open the ledger. The default explorer is xrpl-sonic's own ([explorer.html](https://quigles1337.github.io/xrpl-sonic/explorer.html), opened on the network the page is listening to); XRPScan, Bithomp and xrpl.org are selectable under *Explorer for links*, with their testnet equivalents when the page is on testnet. Links open in a new tab with `rel="noopener noreferrer"`, so the stream keeps playing.

## Replay a ledger, with a permalink

`#replay=<ledgerIndex>` plays one validated ledger back; `#replay=<from>-<to>` plays a range (up to 50 ledgers). A real mainnet example:

```
https://quigles1337.github.io/xrpl-sonic/#replay=107777809
```

Press **Start** and the page fetches each ledger over the same WebSocket (`{"command":"ledger","ledger_index":N,"transactions":true,"expand":true}`), sorts its transactions by `TransactionIndex` (the order the ledger applied them; the node returns them in hash order) and spreads them evenly across the interval the ledger actually stayed open, taken from the next ledger's `close_time` (4 s when that is not available). That reconstructs a listening sequence; it does not recover when each transaction was submitted or executed, so a repeated phrase shows repeated ordering under the chosen mapping, not reaction latency or causation.

The ledgers become a **score** (every ledger close, every event with its voice, notes and timing, every annotation at its time) and a **transport** plays it:

| Control | Key | What it does |
| --- | --- | --- |
| ▶ / ❚❚ | `K` | Play or pause. |
| ⏭ | `.` | Step: play exactly the next event and stay there. |
| ⏮ | `,` | Step back to the previous event (without playing it). |
| ⟲ | `L` | Loop the whole case, or the in/out range. |
| `[` `]` | `[` `]` | Set the loop's in and out points at the current position. |
| Track | `←` `→` `Home` `End` | Seek. Marks on the track: ledger closes, gaps between clips (hatched), annotations (diamonds; the magenta ones pause). |
| Speed | | 0.5×, 1×, 2×, 4×. |
| Go live | `Esc` closes the inspector | Return to the live stream. |

Click any line on the tape, or any track on the plate, to open the **inspector**: type and result, amount, parties (with cast labels), ledger and hash as explorer links, the voice and note that played it, whether it sounded or was drawn silent, its position in the case, and the annotations anchored to it, with Previous / Next to walk the score one event at a time.

**Share** copies a permalink to the ledger currently playing (live or replayed) together with the network and the cast, so a moment you heard can be sent to someone else.

## Cases

A **case** is a small JSON file that describes a listening: the network, one or more ledger windows (clips), the cast, the filters and mapping, the speed, and annotations anchored to a transaction, a ledger or a position on the timeline. **Settings → Case** loads one, saves the current one, copies a link that carries it (`#case=`), and opens the **transcript**, a text version of the whole score with every ledger, gap, event and annotation at its time, in a drawer with one row per line, a Copy raw button and Save file. Changing the scale, key, filters or cast while a case plays rebuilds the score in place, so the file and the link always describe what you are hearing. The silence between clips is explicit: a gap is announced on the tape, in the captions and as a contracting dashed ring on the plate. The format is documented in [docs/case-format.md](docs/case-format.md); the same case and ledgers always give the same score, and a recording (**Capture**) preserves a particular performance. Every project term on the page carries its one-sentence explanation from these documents beside it, and every control that cannot act yet says why on hover, focus and press ([docs/ux.md](docs/ux.md)).

**Notes.** A case's annotations are edited in place: **Note here** adds one at the current position, **Annotate** in the inspector anchors one to that transaction, and each note in the list can be edited (text, source, draft or reviewed, pause) or deleted; clicking its time jumps to it. Every change rebuilds the score and the link.

A sample case built from real mainnet ledgers ships with the page: [docs/cases/busiest-senders-107777809.sonic-case.json](docs/cases/busiest-senders-107777809.sonic-case.json), the two accounts that submitted the most transactions across ledgers 107777809–107777811, each with its own voice, and annotations that state only counts taken from the ledgers. Load it with **Settings → Case → Load file**, or open it directly:

```
https://quigles1337.github.io/xrpl-sonic/?case=docs/cases/busiest-senders-107777809.sonic-case.json
```

`?case=` accepts a relative `.json` path under the site only; once loaded, the case travels in `#case=` like any other.

### Save this moment

Something catches your ear, live or in replay: press **Moment** (beside Share) or `S`, answer *What caught your attention?* (or leave it empty), and one action saves the selection and the observation as a case file and copies its link, without stopping playback. The selection is the in/out loop's ledgers when a loop is set, otherwise the ledger playing now (in replay) or the last validated ledgers the page has heard (live, up to 50); the anchor is the transaction open in the inspector, or the position; the observation is a note at that anchor, marked as the question. A live moment also records, per ledger, how many transactions were heard against the ledger's `txn_count`, so a moment saved from a lossy stream says so; reopening it refetches the full ledgers through the normal case path. Reopened from the file or the link, the transport is positioned at the anchor with the loop restored and the question shown there. On a transaction page the explorer offers **Open as moment in the listener**, which hands off one ledger with that transaction as the anchor. The format is a case with an optional `moment` block, documented in [docs/save-this-moment.md](docs/save-this-moment.md).

### Copy for AI

**Copy for AI** (beside Moment, and in Settings → Case) turns the loaded case into text an assistant can work from without the page: what the text is and which versions wrote it, the network and host, the question and its anchor, the scope as ledger ranges with hashes and the coverage, three counts each labelled with what it measures (available in scope, selected by the listening settings, excluded by reason), the listening settings as context, the top submitting accounts, the events one per line with full hashes and exact amounts, the findings of the anchor transaction with their tier and rule id, links, and a fixed trailer that says how to reply. The size and the events-shown ratio are shown before copying; past the budget (32,000 characters by default), events are selected under a stated rule and the text says "N of M events shown". The **evidence** level adds the findings of every cast-involved event with its source fields. An assistant's answer, a JSON array of annotations, is pasted into **Import notes** and lands as drafts at its anchors, with what was accepted and rejected and why. The same text comes from the command line: `npm run describe -- path/to/case.sonic-case.json [--level evidence] [--budget N]` (Node 22+). The format is documented in [docs/copy-for-ai.md](docs/copy-for-ai.md).

### Coherence

**Coherence** (Settings → Case; the readout opens in a drawer with one row per pair and a Copy raw button) reads a relation between accounts from when they act. For each cast member (or, with no cast, the five accounts that submitted the most) it takes the transactions submitted per ledger over the window, normalises each series as the deviation from the account's own baseline over the window, removes each series' own rhythm (an autoregressive fit by Burg's method, so a market maker acting every third ledger cannot line up with everything else by construction), and reports for every pair the peak of the normalised cross-correlation over lags of up to ±8 ledgers, prewhitened first and raw second, each with its null: `A ↔ B: prewhitened r 0.71 at lag +2 (B follows A by 2 ledgers) above 96% of shuffles (31 of 32; 3 pairs tested) · raw r 0.82 at lag +2 above 100% of shuffles (32 of 32; 3 pairs tested) · 38 ledgers (overlap 36; 36 residual rows after AR(2)/AR(0), overlap 34) · events 41/37 · connected in the record: 3 transactions (3 destination)`, followed by the hashes. A positive lag means the second account follows the first; the null is the largest |r| over seeded circular shifts of one series, so the percentile says how special the alignment is, and the number of pairs tested stands beside it because one pair in twenty passes the 95th by chance; the record check counts the transactions in the window where one of the two submitted and the other is the Destination, owns an entry in the AffectedNodes or owned an offer that was crossed, and a high r with no connection is reported as co-activity, not a relation. Each account's own cadence (the lag at which its series best matches itself) is named beside it, and two accounts with different cadences are reported as a mismatch with the interval at which their alignment recurs. A constant always-on account is flat and shows no coherence; a missing or partly received ledger is absent, not zero; pairs below the guard (12 ledgers, 10 events each) are reported as not judged. Everything is tier *observation*: a correlation at a lag is what the series show, and the readout says so. Specification, defaults and the measurements behind them: [docs/coherence.md](docs/coherence.md).

**The field** (Settings → Field, off by default) draws what the readout says: interference between the cast members' sigils, in the upper plate, for the pairs whose prewhitened percentile clears the 95th on a null that can resolve it, and for no other pair. Each sigil is a source; where two sources' path difference, in lags, matches the pair's lag the fringe is bright, its visibility is the prewhitened r, its spacing the cadence when there is one, and the fringe lines are the zero crossings; the label beside it reads the lag and the record check, "in step at lag +3 · not touching" or "· connected in the record: 10", and a click on a fringe opens the pair's full readout line with the pairs tested and both percentiles. The record's own connections stay the explorer's constellation; nothing on screen says "coordinated". Reduced motion gives a still pattern; the grid coarsens before the frame rate drops; the series can be read per ledger, minute, hour or day (Settings → Field → Read per), the unit printed on every line and on the picture. The same readout comes from the command line with `npm run describe -- case.sonic-case.json --coherence [--bin minute]`, or over a wider window from `account_tx` with `npm run describe -- --coherence --accounts rA,rB --ledgers FROM-TO`; two 50-ledger windows for it ship in `docs/cases/`.

## Compare two windows

A case with two or more clips gets **A**, **B**, … buttons in the transport: each plays that clip on a loop, so a listener can go back and forth between, say, a quiet window and a busy one, or the same account before and after something changed. **All** returns to the whole case. **Blind comparison** (Settings → Case) keeps the plate and the sound but hides ledger numbers, the tape, the notes and the captions, so the comparison is made by ear and the labels are revealed only afterwards. Two windows with very different transaction counts will always sound different; the useful comparisons hold the mapping, the speed, the filters and the cast fixed and ask whether a particular pattern can be found.

**Captions** show annotations, gaps and cast events as text; **Speak annotations** reads each note aloud through the browser's speech synthesis, independent of the instrument's sound; **Pause at annotations** honours notes that ask for it. The page respects `prefers-reduced-motion` (tracks still appear, without drift, overshoot or flashes), and every control is reachable from the keyboard.

## Geiger mode

**Settings → Geiger** turns on a detector. For every validated ledger it measures a few plain things, before any filter and before the synthesiser's rate limiting, so a dropped note never shrinks a count: transactions in all, transactions per category, and for each cast member the transactions it submitted, the transactions it was involved in, and its share of the ledger's `OfferCreate` submissions. Each measurement is compared with a baseline formed from the previous ledgers (30 by default). A crossing, by default three standard deviations above the baseline with a count of at least ten, is reported with the numbers that produced it, for example:

> Sender A submitted 80 of the 100 OfferCreate transactions in ledger #107,777,809 (80%). Over the previous 30 ledgers its share averaged 12% ± 6%, so this is 11.3σ above the baseline (threshold 3σ).

and sounded as a crackle whose rate grows with the excess. The detector's state is always explicit: **baseline forming** (with the count of ledgers seen), **nominal**, **crossing**, or **stale** when no ledger has arrived for 20 seconds. Silence means no configured deviation was reported while the feed and the detector were running; it does not mean nothing happened. A sparkline shows transactions per ledger for the last 60 ledgers with the baseline band behind it, which is the other half of the experiment: whether a person notices a change in the pattern before the detector does.

The baseline can **roll** (keep updating, so a sustained change is absorbed within a window), **freeze** once formed, or be **pinned** at a moment of your choosing; a pinned baseline is saved with the case, so a shared case judges its ledgers against the same numbers for everyone. Counts of transactions *submitted by* an account and transactions *involving* it are different measurements and are reported as such. **Long exposure** (Settings → Stream) keeps a fading trace of where every track landed on the plate, so a column forms under an account that keeps acting at one pitch.

## Observed fee pressure

**Settings → Node → Observed fee pressure** asks the connected node, after each ledger close, for its `fee` report: the fee a reference transaction needs to enter the current open ledger, the reference fee under minimum load, and the size of its transaction queue. Their ratio is shown as the pressure (1.0× at minimum load) with the fees in drops, the queue, the host it came from and the age of the sample; a sample older than 15 seconds is marked stale. Where the node offers the `server` stream, its load factor is shown as well; a node that does not (Clio does not) is reported as such, and nothing else stops working. **Sound the pressure** adds a low drone that is silent at minimum load and rises with the pressure. Every XRPL server keeps its own queue, so this describes the node you are connected to, not one network-wide state, and it is read from the live node only, never from a case.

## MIDI

**Settings → MIDI → Save MIDI file** writes the score of the loaded case as a Standard MIDI File (format 1, 480 ticks per quarter at 120 BPM, so one millisecond of the case is 0.96 ticks): one track per category voice with a General MIDI program (kalimba for payments, warm pad for trust lines, tubular bells for NFTs, reverse cymbal for escrows, harp for payment channels, electric piano for AMMs), one track per cast member in its own voice, a percussion track with hi-hats and rim ticks for offers, claves for the quiet clicks, a bass drum at every ledger close and a crash at every gap, and the annotations as marker events at their times. Silent (dimmed) events are not written. A MIDI file carries the notes; the instrument that plays it decides how they sound, so it will not reproduce the page's synthesiser, and it is the same for everyone who opens the same case.

**Live output** sends the same notes as they play, from a case or from the live stream, to a hardware or software instrument through the Web MIDI API. It needs a secure context, a browser that offers Web MIDI, and your permission, so it starts from **Connect**; the chosen output's name is remembered and re-selected after the next Connect. Notes are scheduled with the same offsets the synthesiser uses; pausing, seeking or stopping sends all-notes-off.

## Overlay and embed

**`?overlay=1`** strips the page down to the transparent canvas — tracks and rings only, with no controls, grid, ruler or ledger stamp — for OBS, streaming layouts and wall screens. The stream starts on load; sound starts as soon as the page receives any click or key press, because browsers block audio until a gesture. Two ways to satisfy that in OBS:

1. Add a **Browser Source** with the URL `https://quigles1337.github.io/xrpl-sonic/?overlay=1` (optionally `#account=` or `#replay=`), then right-click the source, choose **Interact**, and click once inside the page. Audio stays on for the life of the source.
2. Launch the browser with `--autoplay-policy=no-user-gesture-required` (Chrome, Chromium, Edge; OBS passes it through where its build exposes CEF flags), and no interaction is needed.

**`?embed=1`** keeps a compact top bar with a small **Start** button, the log and the visualiser, for an iframe:

```html
<iframe
  src="https://quigles1337.github.io/xrpl-sonic/?embed=1"
  width="640" height="360" loading="lazy" allow="autoplay"
  style="border: 0; border-radius: 12px"
  title="xrpl-sonic — listen to the XRP Ledger"></iframe>
```

Both modes honour `?network=testnet`, `#account=` and `#replay=`, so an embed can watch one account or replay a specific ledger. An **Open full page** link in the embed leads to the same URL with the full controls.

## Snapshot and recording

**Settings → Capture → Snapshot** composes the scene with a small stats box (network, ledger index, transactions in the last minute, timestamp, site URL) on an offscreen canvas and downloads it as `xrpl-sonic-<ledger>.png`. **Record 30 s** captures the canvas (`canvas.captureStream(30)`) together with the audio mix (a `MediaStreamDestination` on the master bus) through `MediaRecorder` and downloads `xrpl-sonic-<ledger>.webm` when the countdown ends — `video/webm;codecs=vp9,opus`, falling back to `vp8,opus`. The button is disabled where `MediaRecorder` or `canvas.captureStream` is missing (Safari records in a different container; use a screen recorder there).

## How it works

The page sends `{"command":"subscribe","streams":["ledger","transactions"]}` to a public rippled or Clio node over WebSocket (`wss://xrplcluster.com` by default, rotating to `s1.ripple.com` and `s2.ripple.com` on failure, with capped exponential backoff and an idle watchdog; testnet uses `s.altnet.rippletest.net:51233`). Every `transaction` message goes through a pure mapping function (`src/mapping.js`) that reads the type, the delivered amount (`meta.delivered_amount`, then `DeliverMax`, then `Amount`, so partial payments report what actually moved) and the accounts involved, and returns a sound event: category, scale degree, velocity, duration, colour and size. The audio engine (`src/audio.js`) synthesises that event from oscillators and generated noise through a compressor and a synthetic convolution reverb, and the visualiser (`src/visual.js`) draws its track at the same scheduled instant. `ledgerClosed` messages drive the tick, the ring and the metronome.

Everything runs in the browser from static files. There is no server, no build, no framework and no package to install.

## Running locally

```sh
git clone https://github.com/Quigles1337/xrpl-sonic.git
cd xrpl-sonic
npx --yes serve -l 4173 .        # or: python -m http.server 4173
```

Then open http://localhost:4173/. ES modules need an HTTP origin, so opening `index.html` from the filesystem will not work.

Useful query parameters: `?network=testnet`; `?autostart=1` for kiosk setups (visuals start immediately, sound on the first tap unless the browser allows audio without a gesture); `?overlay=1` and `?embed=1` (see above). Hash parameters carry shareable state: `#account=<r-address>` and `#replay=<ledger>` or `#replay=<from>-<to>` (see above).

Keyboard: `Space` starts and stops, `M` mutes, `S` saves this moment.

## Tests

```sh
node --test          # Node 20 or newer, no dependencies
node scripts/smoke.mjs   # Node 22+: connect to mainnet and print what the first transactions would sound like
node scripts/describe.mjs case.sonic-case.json   # Node 22+: the case as Copy-for-AI text, ledgers fetched from the node
node scripts/describe.mjs case.sonic-case.json --coherence   # the coherence readout for the case's cast or top submitters (--bin minute|hour|day reads the series in bins)
node scripts/describe.mjs --coherence --accounts rA~Label,rB --ledgers FROM-TO --endpoint wss://s2.ripple.com   # the same over account_tx series for named accounts
```

The mapping layer has no DOM or Web Audio imports, so it is tested against fixture stream messages in `test/fixtures/` (API v1 `transaction` and v2 `tx_json` shapes, XRP in drops, issued currencies, hex currency codes, partial payments, `DeliverMax`, failed transactions, and one of every sound category). The explorer's facts layer is proven by real validated mainnet transactions stored verbatim in `test/fixtures/facts/`, each beside a file stating the findings it must yield and the sentence to render (stale and expired offers swept off the book, partly filled immediate-or-cancel orders, offers that traded what they held and vanished, fills bridged through XRP, tfSell above the price asked, AMM fills, payments crossing offers, an account crossing its own offer, fill-or-kill filled and killed); the account snapshot loader replays recorded node responses, including errors. Account matching (`involvesAccount`), explorer URL building, URL parsing, replay scheduling (`scheduleReplay`, tested against a trimmed real mainnet ledger), the field guide (`src/glyphs.js`: one shape per category, variant resolution, the pitch ruler and the legend icons) and the capture helpers (MIME selection, filenames, overlay text) are pure and have their own tests. The WebSocket client is tested with a scripted socket and fake timers.

## Privacy

Your browser connects directly to the public XRPL node you choose. Nothing is sent anywhere else: no analytics, no backend, no cookies. Settings are kept in your browser's localStorage only.

## Questions and ideas

Open a thread in [Discussions](https://github.com/Quigles1337/xrpl-sonic/discussions) — mapping suggestions, new voices, node endpoints and accessibility feedback are all welcome. Bugs go in [Issues](https://github.com/Quigles1337/xrpl-sonic/issues).

## Related

- [commit-tapestry](https://github.com/Quigles1337/commit-tapestry) — weaves a repository's git history into a textile SVG.
- [agent-blame](https://github.com/Quigles1337/agent-blame) — measures AI co-authorship in a repository from `Co-Authored-By` trailers.

## License

[MIT](LICENSE) © 2026 Quigles1337

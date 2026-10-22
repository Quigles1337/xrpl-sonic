# Coherence

Make relations between accounts visible as interference between their ripples, with every visible feature traceable to a statistic. This document is the agreed specification of the instrument feature and, below it, the record of how phase 1 was built. Phase 1 is the statistic and its readout; the field renderer (phase 2) is a separate change that happens only if phase 1's numbers are interesting on real cases. It follows [case-format.md](case-format.md), whose scores it reads, [save-this-moment.md](save-this-moment.md), whose live window it reads, and [facts.md](facts.md), whose tiers it uses.

## The idea and its honesty limits

Interference fringes form only between sources with a stable phase relationship. If each account's ripple is driven by when it acts, fringes appear exactly between accounts whose activity is correlated, and the geometry reads out the relation: visibility is the peak correlation, shift is the lag, spacing is the period, beats are a cadence mismatch. Phase 2 draws that; phase 1 computes it.

Limits that shape the design:

- Phase lives at ledger resolution. `TransactionIndex` is canonical order (salted and sorted per ledger), not causal; timing is never derived from it.
- Missing ledgers are missing, never zero. A ledger the node could not return, or one the live stream did not fully receive, is excluded from the sums, not filled.
- Correlation at a lag is an observation. Coordination or common ownership is a hypothesis. The tiers are Part A's ([facts.md](facts.md)).

## What phase 1 builds

1. **`src/coherence.js`** (pure). From a score (and, for live, the live window of Save this moment): per-account per-ledger series over the window, event count and log volume, with the primary one chosen and documented, for the cast members, or with no cast the top-K submitting accounts in scope (K a parameter). Each series is normalised as the deviation from the account's own baseline over the window (a z-score; a constant always-on account comes out flat and shows no coherence). Whether the Geiger's baseline machinery is reused is stated either way. Ledgers that are missing, or in live not fully received (received < expected), are excluded from the sums, not filled.
2. **`crossCorrelation(a, b, maxLag) → { r, lag, n, overlap }`**, normalised, lags in [−L, L], with the sign convention documented (a positive lag means the second account follows the first). Pairs are ranked by |r| behind a guard: a minimum of ledgers and a minimum of events per account, defaults chosen after measuring the checked-in cases and documented; plus a shuffle test (the maximum |r| over circular shifts of one series, a fixed count in a seeded order so it is deterministic) reported as a percentile beside r. r is never reported without n, lag, overlap and the percentile.
3. **Readout**, tier observation, one line per pair in the project's voice, for example "A ↔ B: r 0.82 at lag +2 (B follows A by 2 ledgers) · 38 ledgers · events 41/37 · above 96% of shuffles". Reachable from the inspector or the case panel on the listening page, and from the describe script behind a flag per that script's conventions, so the numbers can be checked offline. Not added to the Copy for AI text in this phase.
4. **Tests** on synthetic trains with known answers: a lockstep pair (r ≈ 1, lag 0); a lagged pair (the peak at the planted lag, with the right sign); an uncorrelated pair (low r, low percentile); an always-on pair (flat after normalisation, no coherence); a periodic pair with a cadence mismatch (the peak lag drifts across sub-windows; how that is reported is documented); a window with missing ledgers (excluded, n reflects it). Then the statistic over the checked-in real cases, with the numbers in the as-built section.

Phase 1 touches no canvas.

## Acceptance

The plan is posted before the build. At the end: the coherence tables for the checked-in cases and for every case file in the folder the owner names, each pair with r, lag, n, overlap and percentile; the defaults chosen and why; anything the real data did that the synthetic trains did not predict. Phase 2 (superposed delayed pulse trains on a coarse grid under the sigils, off by default, cast-only or a chosen pair, reduced-motion compliant, every fringe region showing its pair's line on click) waits for a go decision on those numbers.

## Phase 1.5: fix the null, widen the window, check the record

Still no canvas. Same ground rules as phase 1; this section is the agreed specification, the as-built record follows the phase 1 one below.

1. **Prewhitening.** Before cross-correlating, remove each series' own autocorrelation structure (an AR fit, or an equivalent that is justified) and correlate the residuals; run the circular-shift null on the residuals. Report both the raw and the prewhitened r with their percentiles; rank by the prewhitened one. Required synthetic tests: two independent periodic series with the same period come out not significant after prewhitening; a planted lagged relation on top of a shared periodicity survives it; the phase 1 synthetic cases still pass or are re-pinned with a stated reason.
2. **Multiple comparisons.** Print the number of pairs tested next to every percentile, and state here how to read "1 of 10 pairs above the 95th".
3. **Series from `account_tx`.** For a named list of accounts over a ledger range: per-ledger counts of submitted (`Account` equals the address) and involved transactions, with `ledger_index_min`/`max` carried through pagination (the marker) until the range is complete; the bounds, the validated ledger at query time, and any page that failed are recorded, a failed page as missing ledgers, never zero. Entrance: the describe script behind flags for the accounts and the range, per its conventions. The units cost per account per thousand ledgers against the public cluster is measured and written here. The score remains the series source for cases and the live window.
4. **Record check per pair.** For every pair above the guard, count the transactions in the window where the two touch: one is the other's `Destination`, the other's ledger entries appear in its `AffectedNodes`, or Part A's findings show an offer owned by one crossed by the other. Print "connected in the record: N transactions" with the hashes, or "not connected in this window". A high r with no connection is reported as co-activity, not relation.
5. **Ground truth.** The owner supplies the accounts and ledger ranges of a known coordinated cluster, and a control set of unrelated active accounts in the same range. The full readout runs on both. The tables are reported raw and prewhitened, with the record check, and the report says plainly whether the known pairs rank above the controls. That result is the phase 2 decision; the report does not argue it either way.
6. **Cadence stays.** The self-correlation cadence and the beat lines are kept; they are real, and the market maker's three-ledger rhythm is a finding about one account worth showing on its own.

## As built (phase 1)

*The record of phase 1 as it was built. Phase 1.5 (below) kept every number in it; the pair lines now carry the prewhitened statistic first and the record check, and the tables of the recorded windows are ranked by the prewhitened r.*

### The series

- **Primary measure: transactions submitted per ledger** by each account (`tx.Account`), counted from the score's events, that is, what the listening settings selected: failed transactions are out unless the case includes them, categories switched off are out, the cast gate applies. The transcript and the readout therefore count the same events. "Submitted" rather than "involved" (the Geiger's two measurements) so that the other party's timing never enters an account's series.
- **Secondary measure: log volume**, the sum over the account's events of log10(1 + XRP) for XRP-denominated amounts; an issued-currency amount adds nothing. Secondary because it is unit-bound: an account that trades only issued currencies has a volume of 0 in every ledger and is flat (see the measurements).
- **Accounts**: the cast, in cast order, with its labels; with no cast, the `topK` (5) accounts that submitted the most over the ledgers used, labelled by short address.
- **Live**: the live window of Save this moment counts the submitters of each ledger as the stream delivers them, once per transaction hash, with the same log volume, in a per-ledger `accounts` map; a moment file does not carry it. A live ledger is used only when its `txn_count` is known and every transaction was received.
- **The Geiger's baseline is not reused.** It is an online detector: a rolling or pinned mean and standard deviation over the *previous* ledgers, with a Poisson floor on the deviation and a minimum count, built to report crossings as they happen. Coherence needs a two-sided baseline over the whole window with no floor: a floor would damp the deviations of quiet accounts unevenly and hide a lockstep pair of small counts, and a previous-ledgers baseline would make the normalised value depend on the position in the window. `featuresOf()` counts raw stream messages; the series here come from the score so that the numbers match what was played. The z-score is the same arithmetic (sample standard deviation), written once in `normalise()`.

### The statistic

- **Normalisation**: z over the ledgers used; a series with no variation (or fewer than two ledgers used) is flat, its z all zero, and a pair with a flat side is reported as no coherence with the reason.
- **The lag axis is the ledger index.** At lag k, the pairs are (ledger i, ledger i + k) with both ledgers used. A missing ledger, or a live ledger not fully received, is a row that is not used: it pairs with nothing and is never zero. Across a clip gap, a lag is still a distance in ledgers. `n` is the ledgers used; `overlap` is the pairs at the reported lag.
- **r** at a lag is Σ a·b over the pairs divided by the root of the two sums of squares over the same pairs (the normalised cross-correlation on the overlap). The peak is the largest |r| over lags in [−L, L]; ties go to the smaller |lag|, then to the positive lag. Sign convention: **a positive lag means the second account follows the first** (b at a later ledger matches a at an earlier one).
- **L** is the option (8) capped at a quarter of the ledgers used, so the furthest lag still overlaps three quarters of the window; the readout says when the cap applied.
- **The null**: circular shifts of the second series over the ledgers used, by every s in [L + 1, n − L − 1] (a shift within L of zero, or its mirror, reproduces the real alignment at another lag), in an order drawn from a seeded generator (mulberry32, seed 1337), up to 200 of them; for each shift the largest |r| over the lags; the percentile is the share of shifts the observed |r| strictly exceeds, printed with its count, "above 97% of shuffles (32 of 33)", because 50 ledgers give 33 admissible shifts and a step of 3%.
- **Parts**: the ledgers used split into up to three runs of equal length, each at least 3L ledgers, so two parts of 25 for a 50-ledger case and none below 24; each part's peak lag and r are printed for inspection, with no verdict attached (see below).
- **Cadence**: per account, the lag of two or more ledgers at which its normalised series best matches itself, when that self-correlation reaches 0.3. **Beat**: two accounts with cadences p ≠ q are a mismatch whose alignment recurs every pq/|q − p| ledgers (7 and 8 give 56); equal cadences are shared. This is how a cadence mismatch is reported; the drifting peak lag across parts is its symptom and is shown, not judged.
- **Guard**: at least 12 ledgers used and 10 events per account. 12 is the smallest window at which L is 3 and five admissible shifts remain for the null; 10 is one event per five ledgers over the largest case, and an account that sparse is already Poisson noise (the sample case's Sender B, at 53 events over 50 ledgers, reads r 0.19 above 20 of 33 shuffles). The checked-in cases are below any guard, so these rest on the two recorded windows below and on the shuffle arithmetic. All of `DEFAULTS` are options of `coherence()`.
- Every pair line carries r, lag with its reading, n, overlap, both event counts and the null; a pair below the guard says why; a flat side says so. The header names the window, the ledgers excluded and why, the series, the accounts, L, the guard, the null and the parts, then the tier line. Tier `observation` throughout.

### Entrances

- **Coherence** in Settings → Case: over the playing case's score, else over the ledgers heard live; the readout under the buttons, the top pair's line on the tape. `window.xrplSonic.coherenceNow({ measure, topK, maxLag })` returns the report.
- `npm run describe -- case.sonic-case.json --coherence [--top K] [--lags L] [--series count|volume]` prints the readout instead of the Copy for AI text, over the same ledger fetch.
- Not in the Copy for AI text in this phase.

### Measurements

Only two case files were checked in before this phase, and both are below the guard: the recorded moment of ledger #107,811,677 (one ledger) and the sample case `busiest-senders-107777809` (three ledgers; `Sender A ↔ Sender B: not judged: 3 ledgers used (guard ≥ 12)`, with L capped at 1). Two 50-ledger windows were therefore fetched from `s2.ripple.com` with the repository client, their per-ledger series kept as derived fixtures with the ledger hashes (`test/fixtures/coherence/`, not hand-edited; `test/coherence.test.js` reproduces every number below from them), and the cases added to `docs/cases/`:

- `coherence-busiest-senders-107777790-107777839`: the sample case's cast over the 50 ledgers around it (3,418 events; 689 failed transactions excluded by the default filters).
- `coherence-window-107822030-107822079`: fifty consecutive ledgers with no cast, so the top five submitters (6,095 events; 677 failed excluded).

**The two busiest senders, #107,777,790–#107,777,839, cast.** Sender A keeps a cadence of 3 ledgers (self-correlation 0.96); Sender B has none.

| series | pair | r | lag | n | overlap | events | shuffles above | parts of 25 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| count | Sender A ↔ Sender B | 0.19 | −3 (A follows B) | 50 | 47 | 847/53 | 20 of 33 (61%) | +7 (r −0.27), −1 (r −0.12) |
| volume | Sender A ↔ Sender B | −0.19 | +7 | 50 | 43 | 847/53 | 17 of 33 (52%) | +7 (r −0.26), +2 (r 0.14) |

**Top five submitters, #107,822,030–#107,822,079.** rBTw…jjah 826 events with a cadence of 3 ledgers (self-correlation 0.66); rMsX…xgfY 182; rLCN…Ujm5 139; rEqY…NLNF 135; rURt…bKns 114. Count series:

| pair | r | lag | n | overlap | events | shuffles above | parts of 25 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| rBTw…jjah ↔ rEqY…NLNF | 0.42 | +1 | 50 | 49 | 826/135 | 32 of 33 (97%) | −7 (r −0.51), +4 (r 0.49) |
| rBTw…jjah ↔ rLCN…Ujm5 | −0.37 | −8 | 50 | 42 | 826/139 | 25 of 33 (76%) | −7 (r −0.44), −6 (r 0.46) |
| rMsX…xgfY ↔ rURt…bKns | 0.36 | 0 | 50 | 50 | 182/114 | 33 of 33 (100%) | −7 (r 0.37), 0 (r 0.47) |
| rLCN…Ujm5 ↔ rEqY…NLNF | 0.36 | −5 | 50 | 45 | 139/135 | 31 of 33 (94%) | +8 (r −0.57), +5 (r −0.40) |
| rMsX…xgfY ↔ rLCN…Ujm5 | 0.32 | −8 | 50 | 42 | 182/139 | 17 of 33 (52%) | +7 (r 0.39), 0 (r −0.48) |
| rBTw…jjah ↔ rMsX…xgfY | 0.31 | −1 | 50 | 49 | 826/182 | 11 of 33 (33%) | +7 (r −0.46), −3 (r −0.39) |
| rMsX…xgfY ↔ rEqY…NLNF | 0.27 | +2 | 50 | 48 | 182/135 | 20 of 33 (61%) | +2 (r 0.41), +1 (r −0.41) |
| rLCN…Ujm5 ↔ rURt…bKns | −0.27 | 0 | 50 | 50 | 139/114 | 1 of 33 (3%) | −3 (r 0.36), −7 (r −0.50) |
| rEqY…NLNF ↔ rURt…bKns | −0.22 | −1 | 50 | 49 | 135/114 | 7 of 33 (21%) | +8 (r −0.50), +8 (r 0.58) |
| rBTw…jjah ↔ rURt…bKns | 0.18 | +1 | 50 | 49 | 826/114 | 2 of 33 (6%) | +1 (r 0.38), +7 (r −0.40) |

Volume series of the same window: rMsX…xgfY is flat (182 offers, none XRP-denominated), so its four pairs show no coherence; of the rest, rBTw…jjah ↔ rLCN…Ujm5 r 0.42 at lag −6 (overlap 44, above 21 of 33), rEqY…NLNF ↔ rURt…bKns 0.33 at +8 (42, 23 of 33), rBTw…jjah ↔ rEqY…NLNF −0.32 at +3 (47, 28 of 33), rLCN…Ujm5 ↔ rEqY…NLNF 0.30 at −2 (48, 0 of 33), rBTw…jjah ↔ rURt…bKns −0.27 at +7 (43, 10 of 33), rLCN…Ujm5 ↔ rURt…bKns −0.22 at 0 (50, 3 of 33).

### What the real data did that the synthetic trains did not predict

1. **A part's peak is noise at this window size.** Over 25 ledgers and 17 lags, unrelated accounts reach |r| 0.5 to 0.68 in a part; the ideal synthetic cadence mismatch (periods 7 and 8) reaches only 0.71 and 0.76 in parts of 30, because the phase keeps drifting inside a part. No threshold separates them, so the first design, "differing peak lags with strong parts = drifting", was dropped. A cadence mismatch is now read from the cadences themselves (the beat), and the parts are printed for inspection without a verdict.
2. **The market maker has a three-ledger cadence.** rBTw…jjah's series matches itself at lag 3 with self-correlation 0.96 around the sample case and 0.66 in the recent window; its lag profile against any other account alternates in sign every three lags. That is its own rhythm, not a relation, and the readout names it so the alternation is not misread.
3. **Volume makes an account that moves no XRP flat.** rMsX…xgfY submitted 182 offers, none with an XRP side, so its volume is 0 in every ledger. The line says so rather than "the same count".
4. **Picking the peak over 17 lags inflates |r|.** Unrelated top submitters reach 0.2 to 0.4; only the null tells them apart: rMsX…xgfY ↔ rURt…bKns at 0.36 in step is above all 33 shuffles, rBTw…jjah ↔ rEqY…NLNF at 0.42, lag +1, above 32 of 33, while pairs at 0.31 or 0.27 sit at 33% and 61%. r is never printed without the percentile for this reason.
5. **The percentile's resolution is 3%** at 50 ledgers (33 admissible shifts); "above 100%" means above all 33, and the count is printed beside it.
6. **The two busiest senders of the three-ledger burst are not coherent** over the 50 ledgers around it: r 0.19 above 20 of 33 shuffles. Sender B, at about one event per ledger, is Poisson noise; the guard's 10-event floor is a floor, not a promise.
7. **Failed transactions are out by default** (689 and 677 of the two windows' transactions), because the series are the score's events; a case with `includeFailed` counts them.
8. **A shared cadence makes a high |r| at some lag by construction.** Live, over 20 complete ledgers (#107,822,293–#107,822,312, the button pressed in a headless browser), two market makers both on a three-ledger cadence read r −0.84 at lag −4, above all 9 admissible shuffles; a third, on a two-ledger cadence, read 0.53 at +5 against the first. Two series that each repeat every three ledgers must line up, or anti-line up, at some lag within ±5, and nine shifts cannot say how special that is. The beat line names the shared cadence next to the number for exactly this case; the percentile's count is the warning.
9. **The public cluster's quota empties a 50-ledger case.** Through `xrplcluster.com`, the page's and the script's first endpoint, the loader's two attempts fetched 12 of the 50 ledgers of `coherence-window-107822030-107822079` before `units quota (10000 per 60s) exhausted`; the readout said `12 of 50 ledgers used (excluded: 38 not available from the node)`, capped L at 3 and judged the pairs over those 12. The exclusion rule held, and so did the limit: a 50-ledger case needs `s1`/`s2.ripple.com` (where the same fetch takes 7 to 13 seconds) or a paced loader, which is outside this phase.

## As built (phase 1.5)

Still no canvas. Version 2 of the statistic (`COHERENCE_VERSION`): the raw numbers of phase 1 are unchanged and re-pinned; what is new stands beside them.

### Prewhitening

- **Each series less its own autoregressive fit.** On the normalised series, an AR(p) fit by Burg's method: the reflection coefficient of each order minimises the forward and backward prediction errors over the rows used, taken along every run of consecutive ledgers (a gap starts a new run; no error term crosses it), and the coefficients follow by the Levinson recursion. The order is chosen by AICc among 0..L (L the lag range), ties to the lower order. The residual at every row whose p predecessors on the ledger axis are used (the first p rows of a run have none) is the series' innovation; the residuals are normalised again, and the pair's prewhitened r is the same cross-correlation on the rows where both residuals exist, with the same circular-shift null run on the residuals.
- **Why Burg and not Yule-Walker.** Yule-Walker was built first. On the market maker's near-exact three-ledger cadence (self-correlation 0.96) the Levinson recursion on the biased autocorrelation reaches a reflection coefficient of −0.99 at order 2 and fails the |k| < 1 guard at order 3; the fit stalls where the residual is still periodic, and the prewhitened r is inflated by construction again. Burg keeps every reflection coefficient inside (−1, 1) by construction and reaches the order that whitens. It is the standard choice for short records and sinusoidal structure, and both are the case here (50 rows, a cadence).
- **A cadence of three ledgers is an AR(2), not an AR(3).** A zero-mean series that repeats every three ledgers satisfies z_t = −z_{t−1} − z_{t−2}; Sender A around the sample case takes AR(2) with 4.5% of its variance left, and an exact pulse every six ledgers takes AR(5). The order in the readout is the fit's, not the period's.
- **Fully predicted.** A fit that leaves less than 0.5% of the variance (`PREDICTED_VARIANCE`) stops at that order and the series has no residual to correlate: the line says "fully predicted by its own past (AR(p)), no residual to correlate" and reports the raw numbers only. An exact pulse train leaves 7 parts in ten thousand at order 2 (Burg's end effects); real series stay far above the bar. `maxOrder` (0 = up to L) caps the fit.
- **Reported and ranked.** Every pair line carries the prewhitened r, lag and null first, the raw r, lag and null second, the residual rows and the two AR orders, then the record check. The pairs are ranked by the prewhitened |r|, then by its percentile, then by the raw |r|; the recorded windows' tables below are in that order. `significant()` is the prewhitened null's verdict when there is one, else the raw's.
- **The synthetic tests the brief required.** Twenty seeded pairs of independent pulse trains with the same period (six ledgers, noise added): the raw |r| is at least 0.5 in 20 of 20 and above the raw null's 95th in 5 of 20 (a circular shift of a periodic series realigns at some lag, so the raw null is itself confounded); after prewhitening, AR(6) to AR(8) on both sides in 18 of 20, and 1 of 20 above the 95th, which is what chance gives. The same trains with a's noise planted into b three ledgers later: the prewhitened peak is at lag +3 in 20 of 20 and above the 95th in 19 of 20 (the twentieth at 33 of 36). The phase 1 trains pass under prewhitening (lockstep 1 at 0, the lagged copy at its lag, the exact cadence said as fully predicted, the cadence mismatch and the beat unchanged); the phase 1 lines and the recorded windows' tables were re-pinned with the new line shape and the new ranking, every raw number equal.

### Multiple comparisons

- The number of pairs tested (pairs with a null: judged, not flat, at least one admissible shift) is printed beside every percentile, raw and prewhitened: "above 98% of shuffles (195 of 200; 10 pairs tested)". The header line counts the pairs above the 95th on each null and what chance alone gives: "pairs tested: 10 · above the 95th of their shuffles: raw 1, prewhitened 1 · chance alone gives about 0.5 of 10".
- **How to read "1 of 10 pairs above the 95th".** Ten independent pairs tested at the 95th give 0.5 above it by chance, and at least one in 40% of windows; one of ten is the expected outcome of nothing. To call one pair of ten at the 5% level it would need the 99.5th, which a 50-ledger window cannot resolve (33 admissible shifts, a step of 3%) and a 1000-ledger window just can (983 admissible, 200 drawn). The 1000-ledger run below is exactly this case: one of ten at 195 of 200, with no connection in the record.
- **A null that cannot resolve the 95th.** Fewer than 20 shifts (`minShuffles`) cannot place a 95th percentile: one shift is more than 5%. Such pairs are tested and printed with their counts, but not counted among the "above", not called significant, and the header says "N pairs with fewer than 20 shifts, where the 95th cannot be resolved". Live over 20 ledgers the null has 7 to 9 shifts; the two recorded 50-ledger windows have 29 to 33.

### Series from account_tx

- **`src/account-tx.js`** (pure apart from the request function). `fetchAccountTx(request, account, { from, to })` pages `account_tx` oldest first (`forward: true`) with `ledger_index_min` and `ledger_index_max` carried on every page and the marker from the page before, until the node returns no marker. A page that fails after its retry leaves the ledgers from the marker's ledger (the previous page covered it only in part) to the end of the range recorded as missing, and the fetch stops; the first page failing leaves the whole range missing; a bad range is missing with an error. The bounds the node echoed on its first page are its coverage: a `ledger_index_min` above the request is "outside the node's history" below it, a `ledger_index_max` below the request is "beyond the validated ledger at query time" above it. `fetchAccountSeries` reads the validated ledger first (`ledger validated`), then the accounts one at a time, and records ledgers past the validated one as missing. A ledger inside the covered span with no entry is a genuine zero; one outside it is absent.
- **The frame** (`frameFromAccountTx`): one row per ledger of the range, used only when every account's fetch covered it; per account the transactions it submitted (`count`, the primary measure, as for a case), the transactions it is involved in (`involved`: every entry account_tx returned for it, the account anywhere in the transaction or its metadata) or its log volume; failed transactions out of the series unless `--include-failed`, but in the record (the record is the ledger's). The touch records of every entry, once per hash, for the record check. The readout's third line names the host, the validated ledger at query time, and per account the bounds, pages, requests, entries, missing spans and error.
- **Entrance**: `npm run describe -- --coherence --accounts rA[~Label],rB,... --ledgers FROM-TO [--series count|involved|volume] [--include-failed] [--network mainnet|testnet] [--endpoint wss://s2.ripple.com]`, no case file; `--endpoint` puts one node first for either form. Up to 20,000 ledgers (`MAX_RANGE`).
- **Units cost against the public cluster**, measured on 2026-10-22 with the same account over the same thousand ledgers: `xrplcluster.com` now meters `2000 units per 10s` (phase 1 saw `10000 per 60s`) and charges about **10 units per transaction returned**: one page of 200 entries exhausts the bucket (the second request fails with "units quota (2000 per 10s) exhausted, retry in ~14 s"), two pages of 100 do, and 22 pages of 20 pass in 10.0 seconds as the bucket refills at about 200 units per second. **Per account per thousand ledgers the cost is ten units per transaction the account is involved in**: for the five accounts of the window below, 161,330, 37,800, 25,630, 19,030 and 21,120 units, about 13.4, 3.2, 2.1, 1.6 and 1.8 minutes each at the cluster's pace, 22 minutes for the five; `s2.ripple.com` served the same 26,447 entries in 146 requests in 44 seconds. The fetcher does not pace itself to the cluster; the page's and the script's first endpoint is still the cluster, and for a wide window `--endpoint` names `s1` or `s2`.
- **The score remains the series source for cases and the live window.** The account_tx frame is a third source with the same statistic.

### The record check

- **`src/record.js`** (pure). A touch record per validated transaction: the submitter, the `Destination`, the accounts whose ledger entries are in the `AffectedNodes` (`Account`, `Owner`, `Destination`, `Issuer`, `Subject` and `Authorize` of each entry's final or new fields), the two sides of every `RippleState` touched (kept apart as `lines`, because a trust line belongs to both sides and an issued-currency trade touches the issuer's line every time), and the owners of the book offers the transaction crossed, from Part A's findings (`facts().offers` with role `book` and traded `yes`), computed only when an offer not the submitter's is in the record.
- **A connection** is a transaction in the window submitted by one of the pair that touches the other, by its strongest kind: `destination`, `crossed`, `entry`, `line`; each hash once; failed transactions counted and marked. A transaction submitted by a third party that touches both is not a connection between the two.
- **Where the records come from.** A case: the fetched ledgers' transactions, all of them (`frameFromScore(score, { ledgers })`; the page passes its session's ledgers). The live window: `LiveWindow` keeps a touch record per transaction heard, once per hash, beside the submitter counts; a moment file does not carry them, so a reopened moment's records come from the refetched ledgers like any case. account_tx: the entries of the named accounts, which hold every transaction either submitted.
- **Wording.** "connected in the record: 44 transactions (44 crossed)" or "not connected in this window", then an indented line with the hashes, up to 8 (`maxHashes`), each with its ledger, its submitter and the kind. A pair above the 95th with no connection reads "co-activity, not a relation: not connected in this window". A frame without records says "record not available".

### Ground truth

Not supplied at the time of this build: the owner's known coordinated cluster and its control set of unrelated active accounts over the same range are the input, and the readout runs on them with

```sh
node scripts/describe.mjs --coherence --accounts rA~Known1,rB~Known2,... --ledgers FROM-TO --endpoint wss://s2.ripple.com
node scripts/describe.mjs --coherence --accounts rC~Control1,rD~Control2,... --ledgers FROM-TO --endpoint wss://s2.ripple.com
```

The report will give both tables raw and prewhitened with the record check, and say whether the known pairs rank above the controls by the prewhitened r. That result is the phase 2 decision and this document does not argue it. What the runs below say about the instrument itself: at a thousand ledgers it resolves the 99.5th, its |r| for unrelated active accounts sits at 0.04 to 0.10, and a shared book shows in the record check without showing in the statistic.

### Measurements

**The recorded 50-ledger windows of phase 1, prewhitened.** Sender A ↔ Sender B over #107,777,790–#107,777,839: AR(2) and AR(1); prewhitened r −0.51 at lag +7 above 24 of 31 shuffles (77%), raw 0.19 at −3 above 20 of 33 (61%); not coherent either way. (Volume: −0.52 at +7, 24 of 31.) The top five of #107,822,030–#107,822,079, count series, ranked by the prewhitened r; the market maker rBTw…jjah takes AR(4), rLCN…Ujm5 AR(2), rURt…bKns AR(1), the other two are white:

| pair | raw r | lag | shuffles above | prewhitened r | lag | shuffles above | AR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| rBTw…jjah ↔ rLCN…Ujm5 | −0.37 | −8 | 25 of 33 (76%) | −0.38 | −2 | 22 of 29 (76%) | 4/2 |
| rLCN…Ujm5 ↔ rEqY…NLNF | 0.36 | −5 | 31 of 33 (94%) | 0.38 | −5 | 26 of 31 (84%) | 2/0 |
| rMsX…xgfY ↔ rLCN…Ujm5 | 0.32 | −8 | 17 of 33 (52%) | 0.34 | −8 | 17 of 31 (55%) | 0/2 |
| rBTw…jjah ↔ rMsX…xgfY | 0.31 | −1 | 11 of 33 (33%) | −0.34 | +8 | 22 of 29 (76%) | 4/0 |
| rBTw…jjah ↔ rEqY…NLNF | 0.42 | +1 | 32 of 33 (97%) | −0.34 | +2 | 19 of 29 (66%) | 4/0 |
| rMsX…xgfY ↔ rURt…bKns | 0.36 | 0 | 33 of 33 (100%) | 0.31 | 0 | 18 of 32 (56%) | 0/1 |
| rBTw…jjah ↔ rURt…bKns | 0.18 | +1 | 2 of 33 (6%) | −0.31 | +8 | 13 of 29 (45%) | 4/1 |
| rLCN…Ujm5 ↔ rURt…bKns | −0.27 | 0 | 1 of 33 (3%) | −0.30 | 0 | 8 of 31 (26%) | 2/1 |
| rMsX…xgfY ↔ rEqY…NLNF | 0.27 | +2 | 20 of 33 (61%) | 0.27 | +2 | 20 of 33 (61%) | 0/0 |
| rEqY…NLNF ↔ rURt…bKns | −0.22 | −1 | 7 of 33 (21%) | 0.21 | +6 | 6 of 32 (19%) | 0/1 |

Ten pairs tested; above the 95th: raw 2, prewhitened 0. The record check does not run on these fixtures (they keep the series, not the transactions); on the page and in the script it does.

**A thousand ledgers from account_tx, #107,821,080–#107,822,079, the same five accounts** (`test/fixtures/coherence/accounttx-107821080-107822079.json`, derived from the pages with the connecting touch records kept; `test/account-tx.test.js` reproduces every number): every page arrived from `s2.ripple.com`, bounds echoed as requested, 26,447 entries. Submitted: rBTw…jjah 16,133 with a cadence of 3 ledgers (self-correlation 0.75), AR(5); rMsX…xgfY 3,779, cadence 3 (0.31), AR(5); rLCN…Ujm5 2,563, AR(8); rEqY…NLNF 1,903, AR(4); rURt…bKns 1,913, AR(5). Count series, 983 admissible shifts, 200 drawn:

| pair | raw r | lag | shuffles above | prewhitened r | lag | shuffles above | AR | record |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rLCN…Ujm5 ↔ rURt…bKns | 0.08 | −6 | 135 of 200 (68%) | 0.08 | −6 | 195 of 200 (98%) | 8/5 | not connected: co-activity |
| rLCN…Ujm5 ↔ rEqY…NLNF | 0.08 | −5 | 145 of 200 (73%) | 0.08 | −5 | 180 of 200 (90%) | 8/4 | not connected |
| rEqY…NLNF ↔ rURt…bKns | 0.10 | −1 | 191 of 200 (96%) | 0.08 | 0 | 164 of 200 (82%) | 4/5 | connected: 44 (44 crossed) |
| rMsX…xgfY ↔ rURt…bKns | 0.08 | −1 | 174 of 200 (87%) | −0.08 | +3 | 134 of 200 (67%) | 5/5 | not connected |
| rBTw…jjah ↔ rMsX…xgfY | 0.05 | +2 | 33 of 200 (17%) | 0.06 | 0 | 92 of 200 (46%) | 5/5 | not connected; shared cadence of 3 |
| rBTw…jjah ↔ rLCN…Ujm5 | 0.07 | +3 | 152 of 200 (76%) | 0.06 | −5 | 72 of 200 (36%) | 5/8 | not connected |
| rMsX…xgfY ↔ rLCN…Ujm5 | 0.05 | +1 | 34 of 200 (17%) | 0.06 | +1 | 60 of 200 (30%) | 5/8 | not connected |
| rBTw…jjah ↔ rEqY…NLNF | 0.05 | +1 | 89 of 200 (45%) | −0.06 | −3 | 44 of 200 (22%) | 5/4 | not connected |
| rBTw…jjah ↔ rURt…bKns | 0.04 | +3 | 17 of 200 (9%) | −0.05 | −3 | 26 of 200 (13%) | 5/5 | not connected |
| rMsX…xgfY ↔ rEqY…NLNF | −0.04 | −2 | 15 of 200 (8%) | 0.04 | −1 | 2 of 200 (1%) | 5/4 | not connected |

Ten pairs tested; above the 95th: raw 1, prewhitened 1; chance alone gives 0.5. The 44 connections are all rEqY…NLNF crossing offers of rURt…bKns. The `involved` series puts those 44 transactions on both sides of that pair and reads r 0.20 in step above 200 of 200 (0.17 prewhitened): the record check seen as a correlation, which is why submitted is the primary measure. The volume series leaves rMsX…xgfY flat (no XRP side) and nothing above the 95th among the six pairs left.

**Live, 20 ledgers** (#107,831,293–#107,831,312, the button pressed in a headless browser; the live window keeps touch records now): 3,218 transactions heard, top five submitters, L 5, 7 to 9 shifts. The top pair reads prewhitened r −0.83 at +5 above 7 of 7 with cadences of 3 and 2 ledgers and no connection; rMsX…xgfY ↔ rEqY…NLNF reads 0.55 at +5 above 6 of 8 and "connected in the record: 3 transactions (3 crossed)" with the three hashes. The header says every pair has fewer than 20 shifts; nothing at this size is called significant.

### What the real data did that the synthetic trains did not predict (phase 1.5)

10. **Yule-Walker stalls on the real cadence.** The synthetic trains never put a reflection coefficient at the edge; the market maker did, at order 2, and the first implementation left its residual periodic. Burg replaced it (see above).
11. **The two pairs above the raw null in the recent window are not above it once the series are prewhitened.** 0.42 at +1 above 32 of 33 falls to −0.34 at +2 above 19 of 29; 0.36 in step above 33 of 33 falls to 0.31 above 18 of 32. The second is the more instructive: both series are nearly white (AR(0) and AR(1) with φ 0.28), the r barely moved, and the null moved from 33 of 33 to 18 of 32. A null of 33 shifts is a 3%-resolution statement, and "above all 33" was a borderline value's luck.
12. **A thousand ledgers put |r| where the arithmetic says it should be.** The standard error of r at n = 1000 is about 0.03 and the largest of 17 lags of noise about 0.08; the ten pairs sit at 0.04 to 0.10 raw and prewhitened. The one pair above the 95th after prewhitening (195 of 200) has no connection in the record: co-activity, and one of ten.
13. **Sharing a book is not acting in step.** The only connected pair of the thousand ledgers (44 crossings, one always the taker of the other's offers) reads 0.08 in step above 164 of 200 after prewhitening. The record check and the statistic answer different questions, and the line now carries both.
14. **At 20 ledgers the prewhitened r reaches −0.83.** With 13 residual rows at the peak lag and 7 admissible shifts, the number is noise with a sign; the counts beside it and the header's "fewer than 20 shifts" are the only honest reading, and `significant()` refuses it.
15. **The market maker's order grows with the window.** AR(2) over the 50 ledgers around its burst (near-exact cadence, 4.5% left), AR(4) in the recent 50, AR(5) over a thousand, where its cadence reads 0.75: the rhythm is stable over an hour but not exact, and the fit says so.
16. **The involved measure is the record check in disguise.** A transaction between two named accounts is in both involved series, so a pair that trades together correlates in step by construction (0.20 above 200 of 200). It is kept as an option because it is what the brief named; the primary measure is submitted.
17. **The failed-page rule was not exercised by the nodes.** `s2.ripple.com` answered every page (146 of 146 and, on the fixture run, every retry succeeded), and the cluster fails on its quota before any page fails for another reason. The missing-span rule rests on the fake-node tests, and the cluster's quota is the one failure a public node reliably produces.
18. **The public cluster's quota changed between phases.** Phase 1 recorded `10000 per 60s`; phase 1.5 measured `2000 per 10s` at about 10 units per transaction returned. A number in this document is a measurement with a date, not a constant.

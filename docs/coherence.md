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

## As built (phase 1)

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

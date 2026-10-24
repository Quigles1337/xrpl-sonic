# The forecaster on `stream-mainnet-2026-10-24T02-13-43-025Z`

Rows built by `src/universe/forecast/rows.js` from the recording, read in order; every forecast from the sealed past only. Mode: **nowcast** (the recording holds in-flight data). Timed lines: local arrival times, heard from Clio 2.8.0 (rippled 3.4.1) behind wss://s1.ripple.com; 67,328 validation messages.

- ledgers read: 543; rows finished: 543; stragglers after their row: 0; duplicate deliveries: 69,868 (the proposed stream carries every validated transaction a second time); transactions for a ledger beyond the kept window: 0
- the forecaster: 4.58 ms a row on average (refits every 25 ledgers, 21 refits); 4 signals tried (proposed count (nowcast), the open ledger’s current size (nowcast), previous count, ewma h4)
- models chosen on the first 60% of resolved ledgers (#107861821–#107862145, 325), reported on the last 40% (#107862146–#107862362, 217)
- on the held-out ledgers (#107862146–#107862362), beats persistence: ridge on previous count (7% less error over 217), hmm (18% less error over 217), hawkes (17% less error over 217), combined (12% less error over 217)
- the most active accounts' presence: held-out Brier 0.1256 over 4,340 forecasts; the rate alone 0.1276
- the close interval: held-out coverage 76% over 217 ledgers, MAE 439 ms
- the wake on the count: 8 CUSUM alarms (ARL 500 at the residuals' measured lag-1 autocorrelation 0.2, h 6.77 in force at the end) at #107861863 up, #107861890 up, #107861926 up, #107861976 up, #107861995 up, #107862001 up, #107862213 up, #107862338 up; 2 changes flagged by the change-point posterior at #107861828, #107861865

## The count, on the held-out ledgers

| model | ledgers | MAE | 80% coverage | skill against persistence |
| --- | --- | --- | --- | --- |
| persistence | 217 | 71.15 | 88% | — |
| ewma h16 | 217 | 88.69 | 89% | -0.246 over 217 |
| shown | 217 | 62.28 | 87% | +0.125 over 217 |
| ridge on previous count | 217 | 65.98 | 85% | +0.073 over 217 |
| ridge on ewma h4 | 217 | 72.44 | 85% | -0.018 over 217 |
| hmm | 217 | 58.02 | 61% | +0.185 over 217 |
| hawkes | 217 | 59.13 | 93% | +0.169 over 217 |
| combined | 217 | 62.28 | 87% | +0.125 over 217 |

## The nowcast (542 made), on its held-out ledgers

- models chosen on the first 60% of resolved ledgers (#107861821–#107862145, 325), reported on the last 40% (#107862146–#107862362, 217)

| model | ledgers | MAE | 80% coverage | skill against persistence |
| --- | --- | --- | --- | --- |
| persistence | 217 | 71.15 | 88% | — |
| ewma h16 | 217 | 88.69 | 89% | -0.246 over 217 |
| server | 217 | 383.00 | 5% | -4.383 over 217 |
| shown | 217 | 42.12 | 88% | +0.408 over 217 |
| ridge on the proposed count | 217 | 75.46 | 83% | -0.061 over 217 |
| ridge on the current size | 217 | 42.12 | 88% | +0.408 over 217 |

## Event studies

1,006 taker trades with an XRP side; 116 studies completed over 7 books; threshold 8 XRP (the 90th percentile of fills); quotes from the offers seen in the window at face value.

- RLUSD (rMxC…m5De) | XRP: 66 trades above 8 XRP · move +0.3 bp in the taker’s direction (0.2 to 0.5, 80%) · depth not thinned · 0.02 of the move left at N+w
- FUZZY (rhCA…pR62) | XRP: 36 trades above 8 XRP · move +27.0 bp in the taker’s direction (16.4 to 38.4, 80%) · depth not thinned · 0.38 of the move left at N+w
- STX (rSTA…MyXV) | XRP: 9 trades above 8 XRP · move — · depth not half back within the window · persistence —
- CSC (rCSC…gkwr) | XRP: 2 trades above 8 XRP · move +47.6 bp in the taker’s direction (-0.0 to 95.2, 80%) · depth not thinned · persistence — (the move’s band holds zero)
- BCHAMP (rhYh…Pwpi) | XRP: 1 trade above 8 XRP · move — · depth not half back within the window · persistence —
- DROP (rsze…Tswh) | XRP: 1 trade above 8 XRP · move — · depth not half back within the window · persistence —
- WARP (rhuQ…ZZCD) | XRP: 1 trade above 8 XRP · move — · depth not half back within the window · persistence —

## The research switch

book_changes read from wss://s2.ripple.com for 543 ledgers (0 failed).

- book closes (research switch): 45 XRP books with a close · persistence's mean absolute error of log(close) 0.0240 (about 2.40%) over 556 next trades · after a large trade, the event-study drift's skill against persistence +0.00 over 68 · rates are side A per side B (drops per token unit for an XRP book), the traded rates book_changes calls close
- book_changes against the facts layer: 543 ledgers checked (0 not, heard short) · 626 books · 626 match · 0 mismatches
- paper trades (research switch; counted, never valued): after a large trade, the direction of the book's past signed move from N to N+8 (at least 5 past studies whose windows had closed) held in 50 of 91 on 2 books · blind spots: no own impact, no ordering lottery, no queue position, mids from the offers seen at face value

## The last readout

    nowcast for ledger #107,862,362, just before its close, from 542 closed ledgers and what was in flight for it (36 proposed · open-ledger fee 10 drops · queue 0 · current size 74 · from Clio 2.8.0 (wss://s1.ripple.com))
    count (shown: ridge on the current size) 30.1–88.3 (80%, median 51.7, mean 56.3) · held-out coverage 88% over 217 ledgers (#107862145–#107862361) · persistence skill +0.41 · ewma h16 skill +0.52 · server skill +0.89
      persistence 0.0–232 (80%, mean 47.0) · held-out coverage 87% over 217 ledgers (#107862145–#107862361)
      ewma h16 0.0–343 (80%, mean 136) · held-out coverage 88% over 217 ledgers (#107862145–#107862361) · persistence skill -0.23
      ridge on the proposed count 40.8–258 (80%, median 103, mean 133) · held-out coverage 82% over 217 ledgers (#107862145–#107862361) · persistence skill -0.05
      server 471–529 (80%, mean 500) · held-out coverage 5% over 217 ledgers (#107862145–#107862361) · persistence skill -4.21
      Clio 2.8.0 (wss://s1.ripple.com)'s expected_ledger_size (its own heuristic, as the server reported it)
      on the held-out ledgers (#107862145–#107862361), beats persistence: ridge on the current size (41% less error over 217) · models chosen on the first 60% of resolved ledgers (#107861821–#107862144, 324), reported on the last 40% (#107862145–#107862361, 217)
    computed in 0.5 ms
    forecast for ledger #107,862,363, from 543 closed ledgers (#107,861,820–#107,862,362) · walk-forward: each forecast reads only the sealed past, and is scored when its ledger lands
    count (shown: combined) 33.3–219 (80%, median 75.7, mean 106) · held-out coverage 87% over 217 ledgers (#107862146–#107862362) · persistence skill +0.12 · ewma h16 skill +0.30
      persistence 0.0–245 (80%, mean 60.0) · held-out coverage 88% over 217 ledgers (#107862146–#107862362)
      ewma h16 0.0–336 (80%, mean 132) · held-out coverage 89% over 217 ledgers (#107862146–#107862362) · persistence skill -0.25
      ridge on previous count 33.5–185 (80%, median 79.1, mean 98.5) · held-out coverage 85% over 217 ledgers (#107862146–#107862362) · persistence skill +0.07
      ridge on ewma h4 36.7–227 (80%, median 91.7, mean 118) · held-out coverage 85% over 217 ledgers (#107862146–#107862362) · persistence skill -0.02
      hmm 57.0–216 (80%, median 69.0, mean 106) · held-out coverage 61% over 217 ledgers (#107862146–#107862362) · persistence skill +0.18
      hawkes 6.0–247 (80%, median 63.0, mean 101) · held-out coverage 93% over 217 ledgers (#107862146–#107862362) · persistence skill +0.17
      on the held-out ledgers (#107862146–#107862362), beats persistence: ridge on previous count (7% less error over 217), hmm (18% less error over 217), hawkes (17% less error over 217), combined (12% less error over 217) · models chosen on the first 60% of resolved ledgers (#107861821–#107862145, 325), reported on the last 40% (#107862146–#107862362, 217) · 4 signals tried (proposed count (nowcast), the open ledger’s current size (nowcast), previous count, ewma h4) · models: hmm 3 states (rates 67/216/489, chosen by the past's held-out likelihood), self-exciting (branching 0.40, β 0.01, a negative binomial interval at the fit's dispersion 128), the one-signal ridges on log(1 + x)
    type mix (h 16 rope of each share): offer 50% (23–76) · other 18% (7–30) · payment 17% (0–39) · batch 10% (0–39) · nft 4% (0–7) · trust 1% (0–3) · held-out L1 error 0.473 (persistence 0.529) over 217 ledgers
    the 20 most active accounts at #107,862,363: mean P(transacts) 0.75, from their cadence for 5 (periods 2, 8) and their rate for 15, over the last 64 ledgers · held-out Brier 0.126 (the rate alone 0.128) over 4,340 forecasts in 217 ledgers · the first five: rH8s…MSfC 0.98, rdGz…giQn 0.93, rtLM…N3RQ 0.93, r1XC…THVQ 0.88, r21r…PL7n 0.88
    no loop reported at #107,862,362 (the shared-price measure runs with a probe) · loop-takes so far: 1 in 543 ledgers
    close interval in ms (from local arrival times; never the header close_time) 3065–4574 (80%, mean 3819) · held-out coverage 76% over 217 ledgers (#107862146–#107862362)
    wall-clock features: time of day not yet · day of week not yet (history 34.9 min over 543 ledgers with arrival times; time of day needs 20 ledgers in every UTC hour, day of week two dates of each weekday)
    ropes (count): h 1 ≈ 3.8 s · mean 62.4 · sd 46.7 · 543 windows | h 4 ≈ 15 s · mean 111 · sd 142 · 135 windows | h 16 ≈ 1.0 min · mean 132 · sd 159 · 33 windows | h 64 ≈ 4.1 min · mean 127 · sd 145 · 8 windows | h 256 ≈ 16.3 min · mean 113 · sd 142 · 2 windows | h 1024 ≈ 1.1 h · mean 85.8 · sd 147 · 0 windows · forming
    wake: count: gap -0.14 σ (h 4 against h 64, on log(1 + x)) · CUSUM 0.22/6.77 (8 alarms, k 0.5, ARL 500 at lag-1 autocorrelation 0.2, residuals of log(1 + x) against the h 256 rope) · run 534 ledgers · P(a new run began at this ledger) 0.00 · P(change within 8) 0.03 (Poisson–Gamma, each ledger's evidence weighed by one over the dispersion 177)
    wake: open-ledger fee (drops): gap -0.04 σ (h 4 against h 64, on log(1 + x)) · CUSUM 1.03/6.77 (19 alarms, k 0.5, ARL 500 at lag-1 autocorrelation 0.2, residuals of log(1 + x) against the h 256 rope) · run 426 ledgers · P(a new run began at this ledger) 0.00 · P(change within 8) 0.01
    wake: queue: gap -0.02 σ (h 4 against h 64, on log(1 + x)) · CUSUM 2.11/11.17 (6 alarms, k 0.5, ARL 500 at lag-1 autocorrelation 0.5, residuals of log(1 + x) against the h 256 rope) · run 535 ledgers · P(a new run began at this ledger) 0.01 · P(change within 8) 0.06 (Poisson–Gamma, each ledger's evidence weighed by one over the dispersion 647)
    CUSUM threshold h 6.77 for an in-control run length of 500 ledgers at the residuals' lag-1 autocorrelation 0.2 (an AR(1) normal law; measured 504 on 4,000 simulated runs, k 0.5; h 5.07 if independent) · change-point hazard 1/200 per ledger · a ledger ≈ 3.8 s · the past kept: 543 of at most 4,096 ledgers
    last resolved: #107,862,362 count 60 · inside the 80% interval shown (32.6–214, combined) · persistence said 47
    computed in 5.7 ms over 543 rows (refits every 25 ledgers, 21 so far)

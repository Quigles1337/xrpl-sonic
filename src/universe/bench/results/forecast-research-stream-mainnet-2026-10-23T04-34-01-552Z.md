# The forecaster on `stream-mainnet-2026-10-23T04-34-01-552Z`

Rows built by `src/universe/forecast/rows.js` from the recording, read in order; every forecast from the sealed past only. Mode: **forecast** (the recording holds closed ledgers only). No arrival times: the close interval is not scored.

- ledgers read: 1,385; rows finished: 1,385; stragglers after their row: 0; duplicate deliveries: 41,262 (the stream sent transactions again after their ledger had closed); transactions for a ledger beyond the kept window: 0
- the forecaster: 5.93 ms a row on average (refits every 25 ledgers, 54 refits); 2 signals tried (previous count, ewma h4)
- models chosen on the first 60% of resolved ledgers (#107841943–#107842772, 830), reported on the last 40% (#107842773–#107843326, 554)
- on the held-out ledgers (#107842773–#107843326), beats persistence: ridge on previous count (14% less error over 554), ridge on ewma h4 (13% less error over 554), hmm (16% less error over 554), hawkes (17% less error over 554), combined (18% less error over 554)
- the most active accounts' presence: held-out Brier 0.1352 over 11,080 forecasts; the rate alone 0.1371
- the close interval: not scored (no arrival times)
- the wake on the count: 1 CUSUM alarm (ARL 500 at the residuals' measured lag-1 autocorrelation 0.5, h 11.17 in force at the end) at #107842520 up; 5 changes flagged by the change-point posterior at #107841950, #107841971, #107842441, #107842513, #107843271

## The count, on the held-out ledgers

| model | ledgers | MAE | 80% coverage | skill against persistence |
| --- | --- | --- | --- | --- |
| persistence | 554 | 75.52 | 87% | — |
| ewma h16 | 554 | 84.97 | 91% | -0.125 over 554 |
| shown | 554 | 62.16 | 90% | +0.177 over 554 |
| ridge on previous count | 554 | 64.60 | 87% | +0.145 over 554 |
| ridge on ewma h4 | 554 | 65.76 | 87% | +0.129 over 554 |
| hmm | 554 | 63.56 | 66% | +0.158 over 554 |
| hawkes | 554 | 62.78 | 91% | +0.169 over 554 |
| combined | 554 | 61.99 | 90% | +0.179 over 554 |

## Event studies

2,140 taker trades with an XRP side; 202 studies completed over 16 books; threshold 10 XRP (the 90th percentile of fills); quotes from the offers seen in the window at face value.

- RLUSD (rMxC…m5De) | XRP: 110 trades above 10 XRP · move +1.5 bp in the taker’s direction (1.2 to 1.7, 80%) · depth not thinned · 1.86 of the move left at N+w
- FUZZY (rhCA…pR62) | XRP: 41 trades above 10 XRP · move +13.3 bp in the taker’s direction (7.6 to 18.8, 80%) · depth not thinned · 1.55 of the move left at N+w
- USDC (rGm7…uWhE) | XRP: 13 trades above 10 XRP · move +4.9 bp in the taker’s direction (4.2 to 5.6, 80%) · depth not thinned · 1.68 of the move left at N+w
- Lipuni (rwGB…wj9e) | XRP: 10 trades above 10 XRP · move +11800.0 bp in the taker’s direction (0.0 to 23600.0, 80%) · depth not half back within the window · persistence — (the move’s band holds zero)
- TRIPPR (r9QY…gqY1) | XRP: 8 trades above 10 XRP · move +39.6 bp in the taker’s direction (-1003.0 to 1255.3, 80%) · depth not thinned · persistence — (the move’s band holds zero)
- XAH (rswh…9qiv) | XRP: 4 trades above 10 XRP · move -57.7 bp in the taker’s direction (-71.3 to -44.1, 80%) · depth half back in 3 ledgers · -1.68 of the move left at N+w
- BEAR (rBEA…EqFW) | XRP: 3 trades above 10 XRP · move +15.7 bp in the taker’s direction (-0.0 to 31.5, 80%) · depth half back in 1 ledger · persistence — (the move’s band holds zero)
- mXRP (rfmS…2Yhw) | XRP: 3 trades above 10 XRP · move +20.7 bp in the taker’s direction (20.7 to 20.7, 80%) · depth not thinned · 1.00 of the move left at N+w

## The research switch

book_changes read from wss://s2.ripple.com for 1385 ledgers (0 failed).

- book closes (research switch): 91 XRP books with a close · persistence's mean absolute error of log(close) 0.0056 (about 0.56%) over 1184 next trades · after a large trade, the event-study drift's skill against persistence +0.08 over 105 · rates are side A per side B (drops per token unit for an XRP book), the traded rates book_changes calls close
- book_changes against the facts layer: 1385 ledgers checked (0 not, heard short) · 1377 books · 1377 match · 0 mismatches
- paper trades (research switch; counted, never valued): after a large trade, the direction of the book's past signed move from N to N+8 (at least 5 past studies whose windows had closed) held in 94 of 147 on 4 books · blind spots: no own impact, no ordering lottery, no queue position, mids from the offers seen at face value

## The last readout

    forecast for ledger #107,843,327, from 1,385 closed ledgers (#107,841,942–#107,843,326) · walk-forward: each forecast reads only the sealed past, and is scored when its ledger lands
    count (shown: combined) 28.8–170 (80%, median 60.9, mean 84.8) · held-out coverage 90% over 554 ledgers (#107842773–#107843326) · persistence skill +0.18 · ewma h16 skill +0.27
      persistence 0.0–87.1 (80%, mean 34.0) · held-out coverage 87% over 554 ledgers (#107842773–#107843326)
      ewma h16 0.0–197 (80%, mean 84.4) · held-out coverage 91% over 554 ledgers (#107842773–#107843326) · persistence skill -0.13
      ridge on previous count 24.7–128 (80%, median 56.7, mean 69.3) · held-out coverage 87% over 554 ledgers (#107842773–#107843326) · persistence skill +0.14
      ridge on ewma h4 28.3–160 (80%, median 67.8, mean 84.9) · held-out coverage 87% over 554 ledgers (#107842773–#107843326) · persistence skill +0.13
      hmm 58.0–184 (80%, median 70.0, mean 103) · held-out coverage 66% over 554 ledgers (#107842773–#107843326) · persistence skill +0.16
      hawkes 4.0–206 (80%, median 49.0, mean 82.5) · held-out coverage 91% over 554 ledgers (#107842773–#107843326) · persistence skill +0.17
      on the held-out ledgers (#107842773–#107843326), beats persistence: ridge on previous count (14% less error over 554), ridge on ewma h4 (13% less error over 554), hmm (16% less error over 554), hawkes (17% less error over 554), combined (18% less error over 554) · models chosen on the first 60% of resolved ledgers (#107841943–#107842772, 830), reported on the last 40% (#107842773–#107843326, 554) · 2 signals tried (previous count, ewma h4) · models: hmm 3 states (rates 68/186/532, chosen by the past's held-out likelihood), self-exciting (branching 0.50, β 0.01, a negative binomial interval at the fit's dispersion 115), the one-signal ridges on log(1 + x)
    type mix (h 16 rope of each share): offer 63% (40–87) · other 15% (6–23) · payment 11% (0–24) · batch 7% (0–27) · nft 3% (0–6) · trust 1% (0–6) · held-out L1 error 0.476 (persistence 0.521) over 554 ledgers
    the 20 most active accounts at #107,843,327: mean P(transacts) 0.73, from their cadence for 7 (periods 2, 3, 4, 8) and their rate for 13, over the last 64 ledgers · held-out Brier 0.135 (the rate alone 0.137) over 11,080 forecasts in 554 ledgers · the first five: rdGz…giQn 0.98, r1XC…THVQ 0.94, r424…oFWa 0.94, rBTw…jjah 0.96, rD1L…vaZN 0.94
    no loop reported at #107,843,326 (the shared-price measure runs with a probe) · loop-takes so far: 0 in 1,385 ledgers
    close interval: no local arrival times in these rows, so not forecast and not scored; the header close_time is never a target
    wall-clock features: no local arrival times in these rows (a replay of a recording made without them), so none
    ropes (count): h 1 · mean 67.9 · sd 54.3 · 1385 windows | h 4 · mean 67.2 · sd 42.3 · 346 windows | h 16 · mean 84.4 · sd 87.9 · 86 windows | h 64 · mean 116 · sd 132 · 21 windows | h 256 · mean 126 · sd 143 · 5 windows | h 1024 · mean 138 · sd 157 · 1 window · forming
    wake: count: gap -0.51 σ (h 4 against h 64, on log(1 + x)) · CUSUM 3.42/11.17 (1 alarm, k 0.5, ARL 500 at lag-1 autocorrelation 0.5, residuals of log(1 + x) against the h 256 rope) · run 40 ledgers · P(a new run began at this ledger) 0.00 · P(change within 8) 0.03 (Poisson–Gamma, each ledger's evidence weighed by one over the dispersion 161)
    CUSUM threshold h 11.17 for an in-control run length of 500 ledgers at the residuals' lag-1 autocorrelation 0.5 (an AR(1) normal law; measured 515 on 4,000 simulated runs, k 0.5; h 5.07 if independent) · change-point hazard 1/200 per ledger · the past kept: 1,385 of at most 4,096 ledgers
    last resolved: #107,843,326 count 34 · outside the 80% interval shown (35.9–211, combined) · persistence said 102
    computed in 4.5 ms over 1,024 rows (refits every 25 ledgers, 54 so far)

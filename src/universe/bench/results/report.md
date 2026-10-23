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

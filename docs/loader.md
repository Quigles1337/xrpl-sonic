# The loader: where a request goes, how fast, and what never has to be fetched twice

A case names ledgers; the page fetches them in full (`ledger` with `transactions: true, expand: true`), lays them out as a score and plays it. Until now every fetch went down the live socket to whichever node the stream was on, two at a time, as fast as the node answered, and the node answered by refusing: docs/coherence.md, finding 9, lost 38 of 50 ledgers to the public cluster's quota, and the sixteen-ledger tour case took minutes when another case had been fetched in the same minute. This document is the policy that replaces that, with the measurements it rests on, and what ships with the page so that the tours open without a node.

## Measurements (2026-10-23)

Expanded ledger fetches, one at a time, from Node, against the public endpoints, `src/ws.js` as the client. The nodes identify themselves through `server_info`: `xrplcluster.com` is rippled 3.4.1 (hostid HUNTER); `s1` and `s2.ripple.com` are Clio 2.8.0.

| Endpoint | Pace between fetches | Result |
| --- | --- | --- |
| `xrplcluster.com` | none | 6 ledgers (547 transactions) in 6.6 s, then `tooBusy`: "rate limit: units quota (2000 per 10s) exhausted, retry in ~9623ms". About 330 units per expanded ledger; about six per ten seconds. |
| `s2.ripple.com` | none | 8 ledgers (1,001 transactions) in 2.0 s at 241 ms each, then `slowDown`: "You are placing too much load on the server." |
| `s2.ripple.com` | 400 ms | 25 of 25 with 4 refusals, each accepted again after about 1.5 s (1,516, 1,513, 1,478, 1,352 ms). |
| `s2.ripple.com` | 800 ms | 18 ledgers, then `tooBusy`: "The server is too busy to help you now." |
| `s2.ripple.com` | 1,200 ms | 25 of 25, no refusal, 30.4 s. |

Earlier, the same client fetched 50 ledgers from `s1`/`s2` in 7 to 13 seconds two at a time (docs/coherence.md, finding 9), and `account_tx` pages for four accounts in 1.6 to 11.8 s through `s2`.

What the table says: the cluster meters units and says how long to wait; the Ripple nodes answer fast and refuse fast, recover in a second and a half, and hold at one expanded ledger per 1.2 s.

## The policy (`src/loader.js`)

- **An endpoint per request kind.** `ENDPOINTS[network].stream` is the live subscription's list, unchanged (the cluster first). `ENDPOINTS[network].history` is where the record is read (`ledger`, `account_tx`, `tx`, the account reads): `s2.ripple.com`, then `s1`, then the cluster. The page opens a second socket for history when a case loads (`streams: []`, no subscription) and closes it with Stop; `scripts/describe.mjs` uses the same list unless `--endpoint` names one. `kindOf(command)` says which list a command belongs to.
- **Pacing.** `PACE` holds the spacing between two expanded ledger fetches per endpoint (1,200 ms on the Ripple nodes, 1,700 ms on the cluster) and between two header fetches (200 ms). Slots are reserved in call order, so two concurrent fetches queue rather than burst. Sixteen ledgers take about twenty seconds from the node; the ledgers that ship with the page take none.
- **Backing off.** A refusal (`slowDown`, `tooBusy`, `noNetwork`, or a message that says quota, rate limit or too much load: `isSlowDown`) is waited out: the node's own "retry in ~N ms" when it says one, else 1.5 s doubling to 30 s (`backoffMs`). After three refusals in a row the history socket moves to the next endpoint (`rotate`) and the count restarts; after eight for one ledger the ledger is given up. An error that is not a refusal is retried once after 0.8 s, as before. Every wait is announced on the tape with the host, the code and the seconds.
- **A local cache by network, index and hash** (`src/ledger-cache.js`, IndexedDB `xrpl-sonic-ledgers`). A validated ledger fetched from the node is stored under `network:index` with its hash; a later case that names the same ledger reads it from the store, and when the case carries a hash for it (a saved moment does) the stored hash must match, else the node is asked. Headers are stored as headers and do not serve a full request. Settings → Node has the switch (on by default), the count for the network and Clear. A browser without IndexedDB has no cache and fetches as before.
- **The bundle.** `docs/cases/ledgers/<network>/index.json` lists the ledgers that ship with the page, one file per ledger beside it, the node's result object verbatim (`{ ledger_hash, ledger_index, validated, ledger }`). The loader reads the bundle first, then the cache, then the node. Today the bundle is mainnet #107,777,802 to #107,777,817 in full, the sixteen ledgers of the cadence tour's case, which contain the sample case's three, plus the header of #107,777,818 for the last close interval: 17 files, fetched from `s2.ripple.com` on 2026-10-23. `test/bundle.test.js` checks every file against the index (index, hash, validated, transaction count) and that both shipped cases are covered.
- **The tours open offline.** Follow a payment and The market maker's cadence load their cases from the bundle, so Learn works without a node (Start still tries the live socket; the tour does not wait for it). Each tour card has **Fetch the ledgers live from the node**, off by default; on, the loader skips the bundle and the cache for that load and the first step says where the ledgers came from (`describeSources`: "16 ledgers: 16 bundled with the page." or "16 from s2.ripple.com."). The same line goes on the tape for every case.
- **R2** (docs/universe-requests.md): `LiveWindow` takes a `max` above 50 (`new LiveWindow({ max: 600 })`) for a reader that does not save a case, and `peek()` returns the closed ledgers without copying, `accounts` the live Map and `touches` the live array of each entry; `frameFromLive` reads a Map or an object. A moment saved from a wider window keeps the case cap: the last 50 ledgers.

## What the page does with it

`runCase` builds a `LedgerLoader` with the history socket's request, the cache (when the setting is on), the bundle and the case's hashes, and fetches through `loader.case()`; the sources line goes on the tape with the events line. A case opens as soon as Start is pressed (the loader connects the history socket itself), not on the live socket's first `connected`, so a bundled case plays with no node at all. Repeated refusals rotate the history socket (`XrplStream#rotate`, a new method: the next endpoint now, without the failure backoff).

## Not done here

- The explorer keeps its own socket on the stream list (the cluster first): its reads are history-kind, but its pages were checked against the cluster's rippled and Clio answers some of them differently (docs/coherence.md, "As built (phase 2)": an AMM pseudo-account resolves through `ledger_entry` where `account_info` refuses it); moving it is a separate check.
- The `server` stream's `load_factor` is read for the fee readout and not used to pace; the refusal itself is the signal the brief names.
- The bundle holds one network. A testnet bundle would be the same shape under `docs/cases/ledgers/testnet/`.

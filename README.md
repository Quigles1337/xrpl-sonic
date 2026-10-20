# xrpl-sonic

**Listen to the XRP Ledger: every transaction becomes a sound, every ledger close a pulse.**

Live: **https://quigles1337.github.io/xrpl-sonic/**

[![Tests](https://github.com/Quigles1337/xrpl-sonic/actions/workflows/test.yml/badge.svg)](https://github.com/Quigles1337/xrpl-sonic/actions/workflows/test.yml)
[![Deploy](https://github.com/Quigles1337/xrpl-sonic/actions/workflows/pages.yml/badge.svg)](https://github.com/Quigles1337/xrpl-sonic/actions/workflows/pages.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![xrpl-sonic playing mainnet: particles for each transaction, a ring for the ledger close, the scrolling log and the settings panel](docs/screenshot.jpg)

xrpl-sonic is a single page with no dependencies and no build step. It opens a WebSocket to a public XRPL node, subscribes to the `ledger` and `transactions` streams, and turns what arrives into synthesised sound and a particle field with the Web Audio and Canvas APIs. Press **Start**, turn the volume down, and listen to the network settle one ledger at a time.

## Sound mapping

| Transaction type | Sound | Pitch / variation |
| --- | --- | --- |
| `Payment` | Plucked, kalimba-like tone | `log10(amount in XRP)` picks a scale degree across five octaves: dust is high, whales are low. Payments of 100,000 XRP and above add a sub-bass drop. Issued-currency payments use a reedier timbre and a hollow particle. |
| `OfferCreate` / `OfferCancel` | Closed hi-hat / rim tick | Stage position per account, so market makers become recognisable. |
| `TrustSet` | Soft pad swell (root + fifth) | One note per issuer. |
| `NFTokenMint`, `NFTokenCreateOffer`, other `NFToken*` | FM bell | Upper register, keyed on the token or taxon. |
| `EscrowCreate` / `EscrowFinish` / `EscrowCancel` | Reverse-cymbal swell | `EscrowFinish` resolves into a chime; pitch from the escrowed amount. |
| `PaymentChannel*` | Four-note ascending arpeggio | Keyed on the channel. |
| `AMM*` | Soft triad | Keyed on the pool's asset. |
| Everything else (`AccountSet`, `TicketCreate`, `Batch`, `Check*`, ...) | Quiet click | Stage position per account. |
| Ledger close | Low tick with a pitch drop | Plus an expanding ring and a background pulse; the inter-close interval (usually 3–5 s) runs as a live metronome in the top bar. |

Only validated, successful transactions sound by default; there is a toggle for failed ones. Eight scales (major and minor pentatonic, major, Dorian, Lydian, blues, Hirajoshi, whole tone) and twelve keys are available.

### Staying musical when the ledger is busy

Transactions do not trickle in: each validated ledger arrives as a burst of anything from 50 to 600 transactions every few seconds. The audio engine spreads each burst across the expected inter-ledger interval, caps polyphony, and applies a short per-type cooldown. Events that do not fit are rate-limited rather than queued, so the sound never drifts behind the ledger; they still appear as dimmer particles. The **Session** panel shows how many were played versus rate-limited. **Quiet mode** keeps only transactions at or above a chosen XRP amount.

## How it works

The page sends `{"command":"subscribe","streams":["ledger","transactions"]}` to a public rippled or Clio node over WebSocket (`wss://xrplcluster.com` by default, rotating to `s1.ripple.com` and `s2.ripple.com` on failure, with capped exponential backoff and an idle watchdog; testnet uses `s.altnet.rippletest.net:51233`). Every `transaction` message goes through a pure mapping function (`src/mapping.js`) that reads the type, the delivered amount (`meta.delivered_amount`, then `DeliverMax`, then `Amount`, so partial payments report what actually moved) and the accounts involved, and returns a sound event: category, scale degree, velocity, duration, colour and size. The audio engine (`src/audio.js`) synthesises that event from oscillators and generated noise through a compressor and a synthetic convolution reverb, and the visualiser (`src/visual.js`) draws it at the same scheduled instant. `ledgerClosed` messages drive the tick, the ring and the metronome.

Everything runs in the browser from static files. There is no server, no build, no framework and no package to install.

## Running locally

```sh
git clone https://github.com/Quigles1337/xrpl-sonic.git
cd xrpl-sonic
npx --yes serve -l 4173 .        # or: python -m http.server 4173
```

Then open http://localhost:4173/. ES modules need an HTTP origin, so opening `index.html` from the filesystem will not work.

Useful query parameters: `?network=testnet`, and `?autostart=1` for kiosk setups where the browser allows audio without a gesture (otherwise the page starts visuals immediately and sound on the first tap).

Keyboard: `Space` starts and stops, `M` mutes.

## Tests

```sh
node --test          # Node 20 or newer, no dependencies
node scripts/smoke.mjs   # Node 22+: connect to mainnet and print what the first transactions would sound like
```

The mapping layer has no DOM or Web Audio imports, so it is tested against fixture stream messages in `test/fixtures/` (API v1 `transaction` and v2 `tx_json` shapes, XRP in drops, issued currencies, hex currency codes, partial payments, `DeliverMax`, failed transactions, and one of every sound category). The WebSocket client is tested with a scripted socket and fake timers.

## Privacy

Your browser connects directly to the public XRPL node you choose. Nothing is sent anywhere else: no analytics, no backend, no cookies. Settings are kept in your browser's localStorage only.

## Questions and ideas

Open a thread in [Discussions](https://github.com/Quigles1337/xrpl-sonic/discussions) — mapping suggestions, new voices, node endpoints and accessibility feedback are all welcome. Bugs go in [Issues](https://github.com/Quigles1337/xrpl-sonic/issues).

## License

[MIT](LICENSE) © 2026 Quigles1337

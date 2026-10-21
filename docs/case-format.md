# Case files and scores

A **case** is a small, versioned description of something worth listening to on the XRP Ledger. A **score** is what the instrument intends to play for that case: every ledger close, every transaction event with its voice, notes and timing, every gap between clips, and every annotation resolved to a time. The same case and the same ledgers always produce the same score, which is what makes a shared listening reproducible.

Cases are plain JSON. They can be saved as `<id>.sonic-case.json`, loaded from **Settings → Case**, or carried in a link as `#case=<encoded>`.

## Case (version 1)

```json
{
  "format": "xrpl-sonic/case",
  "version": 1,
  "id": "market-maker-afternoon",
  "title": "One market maker, three ledgers",
  "description": "Optional prose.",
  "network": "mainnet",
  "clips": [
    { "from": 107777809, "to": 107777811, "label": "Before" },
    { "from": 107777840, "to": 107777841, "label": "After" }
  ],
  "cast": [
    { "address": "rBTwLga3i2gz3doX6Gva3MgEV8ZCD8jjah", "label": "Maker", "voice": "brass", "pan": -0.6, "colour": "#ffb3c6" }
  ],
  "filters": {
    "enabled": { "payment": true, "offer": true, "trust": true, "nft": true, "escrow": true, "paychan": true, "amm": true, "other": true },
    "includeFailed": false,
    "quietThreshold": 0,
    "castMode": "all"
  },
  "mapping": { "version": "1.1.0", "scale": "pentatonicMajor", "key": "C" },
  "timing": { "speed": 1 },
  "annotations": [
    { "id": "a1", "anchor": { "hash": "…64 hex…" }, "text": "The first fill.", "source": "analyst notes", "status": "reviewed", "pause": true },
    { "id": "a2", "anchor": { "ledger": 107777840 }, "text": "The second window begins." }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `format`, `version` | Always `xrpl-sonic/case` and `1`. Other values are refused. |
| `id` | A slug (lower-case letters, digits, `.`, `_`, `-`). Used for file names. |
| `network` | `mainnet` or `testnet`. The page connects to that network to fetch the ledgers. |
| `clips` | Ledger windows in play order. Each is `{ from, to, label? }` or a string such as `"107777809"` or `"107777809-107777811"`. Clips are sorted, must not overlap, and together cover at most **50 ledgers**. The silence between clips is explicit: a 1.5 s gap that is announced on the tape and in captions. |
| `cast` | Up to five accounts to follow. Each has an r-address, a label (up to 24 characters), a `voice` (`marimba`, `glass`, `brass`, `reed`, `pulse`), a `pan` from -1 (left) to 1 (right) and a colour. Missing fields take positional defaults, so `["rABC…"]` is a valid cast. |
| `filters` | Which categories play, whether failed transactions are included, the quiet-mode threshold in XRP (0 = off), and `castMode`: `all` plays everything, `mute` draws transactions outside the cast silently, `hide` drops them. |
| `mapping` | The sound mapping the case was written for. `version` is recorded so a later build can warn when its notes or voices differ; `scale` and `key` are the musical settings. |
| `timing` | `speed`: 0.5, 1, 2 or 4. |
| `geiger` | Optional detector settings: `enabled`, `window` (ledgers in the baseline), `threshold` (σ), `minCount`, `adapt` (rolling baseline), and an optional pinned `baseline` (`{ window, pinnedAt, series: { <id>: { mean, sd, n } } }`), so everyone judges the case's ledgers against the same numbers. |
| `annotations` | Up to 200 notes anchored to a transaction (`hash`), a ledger (`ledger`) or a position on the timeline (`timeMs`). `source` names where the note came from, `status` is `draft` or `reviewed`, and `pause: true` asks the transport to pause when the note is reached. |

Validation drops what it cannot use and reports it; a case with no playable clip, an unknown format or version, or more than 50 ledgers is refused outright.

## Score

The score is built in the browser from the case and the fetched ledgers (`src/score.js`). It is not stored in the case; it is derived. Its parts:

- `ledgers[]`: `{ ledgerIndex, clip, timeMs, intervalMs, txnCount, hash, closeTimeIso, missing }`. A ledger the node could not return is marked `missing` and stands as 4 s of silence, with a warning.
- `events[]`: `{ n, clip, ledgerIndex, txIndex, hash, offsetMs, timeMs, gate, cast, primary, event }`. `event` is the mapped transaction (category, voice, notes, velocity, duration, amount, parties). `gate` is `play` or `dim` (drawn, silent). `cast` lists the involved members; `primary` is the member whose voice plays.
- `gaps[]`: the silences between clips, with the number of omitted ledgers.
- `annotations[]`: the case's annotations with a resolved `timeMs` (and `eventN` when anchored to a transaction), in time order.
- `counts`: `events`, `played` (selected to sound), `dim` (drawn silent), `missingLedgers`, `byCategory`, and `excluded: { total, byReason }`, the transactions that produced no event and why (`failed`, `categoryDisabled`, `quietThreshold`, `castHidden`, `notATransaction`), so a report can say what was left out as well as what was played. The transcript header carries the same numbers; "selected to sound" is the score's claim, whether a note sounded is the synthesiser's.

### Timing

Within a ledger, transactions are laid out in the order the ledger applied them (metadata `TransactionIndex`) and spaced evenly across the interval the ledger stayed open, taken from the next ledger's close time. This reconstructs a listening sequence. It does not recover when each transaction was submitted or executed, so a repeated phrase shows repeated ordering under the chosen mapping; it does not by itself establish reaction latency or causation.

### Sound policy for the cast

A transaction involving several cast members is one event, counted once. The primary member (the sender when the sender is in the cast, otherwise the first involved member in cast order) lends its voice and stereo position; each other involved member is heard as a short cue in its own voice, just after the note.

### Repeatable score, reference audio

Two different claims are supported:

- **Repeatable event score.** The same case and ledgers give the same voices, notes and timing. A link or a case file carries this.
- **Reference audio.** The synthesiser uses generated noise and a convolution reverb, applies a polyphony cap and per-category cooldowns, and depends on the browser's scheduling, so two playbacks are not sample-identical. When a report needs the exact exhibit someone heard, attach a recording (**Settings → Capture**) next to the case and the transcript.

## Links

`#case=` carries the whole case: `z:` followed by base64url of the deflate-compressed JSON where the browser supports `CompressionStream`, otherwise `j:` followed by base64url of the JSON. `#cast=` carries only a cast, as `r…~Label~voice~pan` entries joined by commas; `#account=` and `#replay=` remain for the simple cases.

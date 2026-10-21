# Save this moment

Someone is listening, live or in replay, something catches their ear, and they need one action that preserves the selection and their observation before it scrolls away. This document is the agreed specification of that action and, below it, the record of how it was built. The explorer's URL already is its state, so this is the listening page's feature; the explorer gets only the one-line handoff at the end.

## What it is

A moment is **a case, not a new format**: a `.sonic-case.json` saved through the existing case machinery (`currentCase()`, `caseFromState()`, the save, link and load paths in `src/main.js` and `src/case.js`, see [case-format.md](case-format.md)). It contains:

- **clips**: the selection. If an in/out loop is set, that ledger range. Otherwise the window ending at the ledger playing now: in live, the last N validated ledgers the page has observed, N from the page's buffer and within the 50-ledger cap; in replay, the ledger playing now. Ledger hashes are recorded alongside indices where they are known.
- **anchor**: the selected event's hash when the tape or the inspector has a selection; otherwise the playback position as a `timeMs` anchor (in live there is no playback position, so the ledger playing now stands as a `ledger` anchor; all three anchor types already exist).
- **the current cast, filters, mapping** (scale, key, mapping version) **and speed**, plus the in/out loop.
- **the observation**: on save the page asks "What caught your attention?"; the answer is stored as an annotation at the anchor, source `human`, status `draft`, marked as the question. The text is optional; the anchor is kept either way.
- **live coverage at save time**: per ledger in the window, the transactions received (deduplicated by hash) against the ledger's `txn_count`, so a moment saved from a lossy stream says so. Reopening refetches full ledgers through the normal case path; the saved numbers are what was heard, not what happened.

No raw node responses are stored. Full records are the evidence bundle, which is deferred. Index plus hash pins the ledger version and a refetch reproduces it; the existing missing-ledger warning covers nodes with limited history.

**Trigger**: a button in the command strip (beside Share, the one place reachable in both modes, since the transport bar is hidden while listening live) and the `S` key. Saving does not stop playback: the question is asked in an inline field, and playback continues behind it.

**Reopen**: through the existing file and link paths. The question is shown at its anchor and the transport is positioned there, with the loop restored when one was saved.

**Explorer, optional and small**: on a transaction page, **Open as moment in the listener** builds a case with that ledger as the clip and the hash as the anchor, handing off the way the other explorer-to-listener links do (keeping `?network=`). There is no explorer file format.

Part C will read the same case plus the facts layer for its clips and render gist and evidence text; nothing here is designed that Part C would duplicate.

## Acceptance

Save a moment in live and in replay; reopen each from file and from link with the question, the anchor and the in/out loop intact, and coverage numbers present for the live one; existing cases still validate; tests on recorded fixtures; no new dependencies; the listening page's URL and hash contracts are unchanged.

## As built

### Field additions

The case format stays at **version 1**. A version bump would make every existing build refuse a moment file; instead the extension is optional, ignored by readers that predate it, and carries its own version.

- `annotations[].question` (boolean, optional): the one annotation that holds the saved observation. Absent on ordinary notes; never serialised unless true.
- `moment` (object, optional, moment version 1):

```json
"moment": {
  "version": 1,
  "savedAt": "2026-10-21T20:14:03.512Z",
  "mode": "live",
  "host": "xrplcluster.com",
  "anchor": { "ledger": 107812323 },
  "loop": null,
  "ledgers": [
    { "index": 107812322, "hash": "29CD713D…", "received": 211, "expected": 214 },
    { "index": 107812323, "hash": "A4F0…",     "received": 198, "expected": 198 }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `savedAt` | When the moment was saved (ISO 8601). |
| `mode` | `live`, `replay` or `explorer`: where the selection was made. |
| `host` | The node the page was connected to when it was saved. |
| `anchor` | The selection: `{ hash }`, `{ ledger }` or `{ timeMs }` (ms on the saved case's own timeline). The question annotation, when there is one, carries the same anchor. |
| `loop` | `{ fromMs, toMs }` on the saved case's timeline, or `null`. |
| `ledgers` | One entry per ledger of the clips, in play order: `index`, `hash` when known, and for a live moment `received` (transactions heard, deduplicated by hash) against `expected` (the ledger's `txn_count`). A replay moment lists index and hash only: its ledgers were fetched whole. |

Validation drops a malformed `moment` block with an error and keeps the case playable; a case without one is unchanged.

### Reused

`caseFromState()` (the live base: network, cast, filters, mapping), `currentCase()` (the replay base), `validateCase()`, `serializeCase()`, `encodeCase()`/`decodeCase()`, `caseFilename()`, `addAnnotation()`, the save path (`downloadBlob`), `caseLink()`, `openCase()` for file and link, the `?case=` loader, `ledgerAtPosition()`, the score's ledger list (hashes and times), `Transport.seek()`/`setLoop()`, the inspector's current event for the selection, and `listenerUrl()` for the explorer handoff.

### New

`src/moment.js` (pure): a `LiveWindow` that keeps the last 50 validated ledgers with the hashes of the transactions heard for each; `momentFromLive()`, `momentFromReplay()` and `momentFromTransaction()` build the raw case; `momentPosition()` resolves the saved anchor and loop against a built score so the transport can be placed. Wiring in `src/main.js`; the button, the inline question and the `S` key in `src/ui.js`; the question marked in the notes list; the explorer link in `src/explorer/views.js`.

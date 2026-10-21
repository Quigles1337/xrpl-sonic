# Copy for AI

Turn the current case, a moment or any case, into text an assistant can work from without xrpl-sonic, and let the assistant's answer come back as draft annotations on the same case. This document is the agreed specification and, below it, the record of how it was built. It follows [save-this-moment.md](save-this-moment.md), whose cases it reads, and [facts.md](facts.md), whose findings it renders.

## What it is

One pure function is the whole feature:

```js
describe(theCase, ledgers, facts, { level, budget }) → text
```

`theCase` is a validated case; `ledgers` is the Map the case loader produces (index → `{ ledger, nextCloseTime }`, a null ledger when the node had none); `facts` are the Part A findings for the transactions in scope. The browser button, a moment file rendered as text, and a Node entry point are entrances to it; nothing lives only in the button.

### Content, in order

1. **Header**: what this text is (an xrpl-sonic case; the versions of the case, the moment block, the facts, the mapping and the score); network and host; the question (the annotation marked as the question) and its anchor; the scope as each clip's ledger range with index and hash, the gaps between clips stated; coverage: for a live moment the saved received/expected per ledger, otherwise fetched or unavailable per ledger from the score's missing-ledger data.
2. **Three counts**, each labelled with what it measures: available in scope (the sum of `txn_count`), selected by the listening settings (the score's counts), excluded by reason (the Part A `counts.excluded`). Never a performance count.
3. **The listening settings** in one line: cast with full addresses and labels, filters, quiet threshold, scale, key, mapping version. Stated as context for the selection, not as facts about the ledger.
4. **Concentration**: the top submitting accounts in scope with counts and share; the cast members' submission and involvement counts.
5. **Events**, one line each: ledger index, `TransactionIndex`, full hash, type, result, full addresses (cast labels where they apply), exact amounts as strings with currency and issuer. When the budget is exceeded, events are selected under a stated rule: the anchor event, then cast-involved events, then the rest in application order; the text says "N of M events shown" and names the rule. Nothing is truncated silently.
6. **Findings** for the anchor event and the cast-involved events: the Part A facts with tier and rule id on every line, evidence references by node index, exact values, "unresolved" rendered as unresolved. At `level: 'evidence'`, the selected source fields of those transactions are added (`TransactionType`, `Account`, `Destination`, decoded `Flags`, `Amount`/`DeliverMax`, `delivered_amount`, `TakerGets`/`TakerPays`, `Fee`, `Sequence`, `OfferSequence`, `TransactionResult`). No raw `AffectedNodes`; that is the evidence bundle, still deferred.
7. **Links**: the case link Save produces, and the explorer route per event.
8. **How to reply**: a fixed trailer telling the assistant to answer the question with observations and hypotheses kept apart, to cite hashes from this text for each, to say what it could not establish, not to infer common ownership or intent from co-occurrence, and to return annotations as JSON in the case annotation shape (`text`, `anchor` as `hash` | `ledger` | `timeMs`, `kind` as `observation` | `hypothesis` | `question`, `evidence` as hashes, `source`, `status: "draft"`), the exact shape taken from `src/case.js`, with one example.

### Levels and budget

`gist` (the default) is sections 1–5, 7 and 8 plus the findings for the anchor only; `evidence` adds section 6 in full. The size and the events-shown ratio are shown before copying, so the user can narrow the selection with the loop. The default budget was chosen after measuring representative cases; it is a visible number, not a promise.

### Determinism

The same case, the same ledgers and the same facts give identical text. A test on a recorded fixture asserts the exact output. Hashes and amounts are verbatim in this layer: no shortened addresses, no rounded amounts.

### Return path

An **Import annotations** action takes pasted JSON (an array, or a whole case whose annotations are merged), validates it by `validateCase`'s annotation rules, sets the status to draft with the given source, resolves anchors against the current score, reports what was accepted and what was rejected and why, and never overwrites an existing annotation. The existing case importer stays as the fallback.

### Entrances

A **Copy for AI** button beside Moment; the same for a loaded case in the case panel; a Node entry point over the same function, placed per the project's conventions for scripts.

## Acceptance

Gist and evidence renderings of a recorded fixture case are checked in as expected output; the trailer's JSON example validates through the import path; a live moment, a replay moment with a loop and an explorer-handoff moment each produce text whose header, counts and selection rule are correct; budget overflow produces the "N of M" line; a pasted answer lands as draft annotations at the right anchors. The last check happens outside the repo: one gist pasted into an assistant with no other context, judged on whether it can say what happened and what to look at.

## As built

_Filled in with the implementation: the annotation field additions (`kind`, `evidence`), the chosen default budget and the measurements behind it, the module and entry points, and what the outside-the-repo check showed._

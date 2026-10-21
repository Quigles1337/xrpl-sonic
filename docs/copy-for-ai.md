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

### Field additions

Two optional annotation fields, serialised only when present; existing cases are unchanged and the case format stays at version 1:

- `annotations[].kind`: `observation`, `hypothesis` or `question`. A moment's question is `kind: "question"` and also carries `question: true`; the two are kept in step on read, so cases written by Save this moment before this field existed read the same.
- `annotations[].evidence`: the transaction hashes the note rests on, uppercased, deduplicated, at most 50.

### The text

`src/describe.js` renders the sections in the order above. Hashes, addresses and amounts are verbatim: XRP as integer drops, issued amounts as the decimal with the decoded currency, the exact 160-bit code where there is one, and the issuer. The findings come from the facts layer unchanged, one line each: `[tier] rule subject.property = value · evidence: node N field, …`, with `unresolved` printed as such and a finding's note appended. Amounts inside values are rendered the same way as in event lines. The trailer is a constant; its example is the annotation shape of `src/case.js` with the anchor's hash (or the first event's), so it imports against the same case.

### Levels and the budget

| Case | Events | Gist | Evidence |
| --- | --- | --- | --- |
| A one-ledger moment (#107811677, 60 transactions, two cast members) | 59 | 24,678 chars (~6,200 tokens) | 120,740 chars (~30,200 tokens) |
| The sample case, three ledgers | 204 | 58,042 chars (~14,500 tokens) | 296,761 chars (~74,200 tokens) |
| Five consecutive ledgers (two fetched before the cluster's quota) | 712 | 116,697 chars (~29,200 tokens) | 224,938 chars (~56,200 tokens) |

The default budget is **32,000 characters** (about 8,000 tokens): a typical single ledger stays whole; the sample case shows about a hundred of its events; a busy window shows the anchor, the cast's events and as many others as fit, and says so. The budget selects events only; at the evidence level the findings of the cast-involved events are added in full, so narrowing with the loop is how an evidence rendering is made smaller. `describeReport()` returns the size, a token estimate (characters ÷ 4) and the shown/total ratio, which the page shows before copying and the script prints to stderr.

### Entrances

- **Copy for AI** beside Moment opens a box with both levels' sizes and ratios; **Copy gist** / **Copy evidence** copy the text and the log line repeats the numbers and the rule. The same button sits in Settings → Case for a loaded case. Both need a playing case (the ledgers are fetched by the case path).
- **Import notes** in Settings → Case: paste the JSON (an array, or a whole case), name the source, import; the line under the box says what was accepted as drafts and what was rejected and why; nothing existing is overwritten. The existing Load file importer is untouched.
- `scripts/describe.mjs` (`npm run describe -- case.json [--level evidence] [--budget N] [--measure]`): the same function over the same ledger fetch the page uses, text to stdout and the size line to stderr. A script rather than a `bin`, as `scripts/smoke.mjs` is: the package is private and nothing is published.

### Outside the repo

One gist of the recorded moment (ledger #107811677, the question "Why did this immediate-or-cancel order fill so little?") was given to a fresh assistant with no other context and no tools. From the text alone it said what happened: the order crossed exactly one resting offer, 1.10000054 RLUSD for 795,129 drops, and immediate-or-cancel discarded the remaining 9,800.21590846 RLUSD; the balance deltas corroborate the fill to the drop. As a hypothesis it placed the limit inside the spread, citing three RLUSD asks applied earlier in the same ledger at about 0.1 % above the limit and the quotes applied after it that bracket it, and noted the Maker's quotes were about 5 % from the touch and played no part. It listed what the text could not establish (the resting book from earlier ledgers, whether the earlier asks rested or crossed, the replaced offers' prices, any AMM for the pair, the excluded failed transaction) and what to look at (`book_offers` at the previous ledger, the metadata of the three asks, the taker's neighbouring ledgers). Every claim cited hashes from the text. It returned ten annotations, six observations, one hypothesis and three questions, two anchored to the ledger and the rest to hashes, each with evidence; all ten imported as drafts at their anchors with no rejection.

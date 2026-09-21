# Status — the editor that knows this codebase

## Phase 1 — gated, committed, and half measured

**2026-09-19.** Five tasks, written by deepseek and reviewed by claude after each
one. **Nothing in this phase changes behaviour**: no suggestion is slower,
larger, differently shaped or differently gated than before it. It is all
measurement, which is why it could be built before anything was committed.

The tasks themselves were written under a no-testing rule. Afterwards, on
Mohamad's say-so, the gate was run — `tsc` across all eighteen, `eslint` clean
after one fix, 2,686 tests passing, `format:check` red only on eight files this
work never touched — and **`G2` was run, with its verdict below.** `G1` has not
been: it needs nine paid requests at roughly $0.003 and a DeepSeek key in the dev
profile, which is a separate profile from the one that has yours.

### What shipped

| #   | Task                                               | Where                                                        |
| --- | -------------------------------------------------- | ------------------------------------------------------------ |
| T1  | `usage` parsed; cache counters and `finish_reason` | `main/completion-client.ts`                                  |
| T2  | Request correlation and honestly-named timings     | same file, plus the handler in `main/workbench-surface.ts`   |
| T3  | Request-to-visible reporting from the renderer     | a new one-way channel across shared, preload, main, renderer |
| T4  | The `G1` caching probe — built, not run            | `main/completion-client.ts`, gated on `isE2eProfile()`       |
| T5  | `G2`: the language-service sampler                 | `renderer/src/workbench/completion.ts`                       |

### Five findings worth more than the code

**1. The cache counters are not where the earlier research said they were.**
deepseek had reported them nested inside `usage.prompt_tokens_details`; checked
again against the FIM reference's own example JSON, they are direct properties of
`usage`. **Building from the first summary would have logged `unreported` for
every response, and `G1` would have concluded the endpoint does not cache** — a
wrong verdict arriving from our mistake rather than the provider's, which is
precisely what that gate cannot detect about itself. The guard added in response
reports the `usage` key names, once per provider, when both counters come back
absent.

**2. A `WeakMap` keyed by the completions object removed a bound rather than
adding one.** T3 needed per-request state that survives until `handleItemDidShow`
fires — and that callback is handed the _same object the provider returned_,
verified at `provideInlineCompletions.js:392`. So the key is collected when the
editor drops the suggestion. A `Map` keyed by request id would have needed a cap
and an eviction rule, which is the cancelled-ids lesson from the previous phase
paid a second time.

**3. The rename hit the `activeTabId` trap, while quoting it.** A mechanical
`CompletionOutcome → EditorReportKind` substitution rewrote two unrelated things:
the report-kind union, and the FIM _response_ parser's return type. `CLAUDE.md`
already records that a rename by substitution cannot tell which of two things
sharing a name you meant, and **it fails in the direction of looking correct** —
`EditorReportKind` reads plausibly as the return type of a response parser. The
compiler could not help and neither could a diff; reading the file after the
substitution is what caught it.

**4. The probe's own log was asserting an intended value as an observed one.**
It waited `delay - previous` _before_ each send, so the second send landed about
three seconds after the first while the line said `2000`. Fixed by recording the
actual elapsed beside the intent. This is the same class as naming
response-header arrival "TTFT", which is the error the whole phase is built to
avoid.

**5. The probe inherited the live path's two-second timeout.** At roughly 4,000
tokens of prefix — the size caching is supposed to matter for — a timeout was a
plausible outcome rather than a remote one, and it would have returned
`timed out` and taught `G1` nothing at exactly the point of interest.
`requestCompletion` now takes an optional deadline defaulting to the live value,
which `D3` requires for Phase 3 regardless.

### Decisions taken during the phase, not in the plan

- **No cap on the usage-key list.** It fires at most once per provider per
  process, so its worst case is two lines per app lifetime — and a `slice` would
  silently drop a field that sorts late, turning a diagnostic into a confident
  wrong answer.
- **No request id on the usage-keys line.** It reports a _process-level_ fact —
  what shape this provider's responses have — so `provider` is its correlator. An
  id invites the reading that the shape was reported _for that request_.
- **Snooze reports once per episode**, cleared from `onDidChangeIsSnoozing`, with
  the UUID minted only when a report is actually sent. Snooze is an episode-level
  fact; one line tells a reader what a hundred identical ones would, and every
  keystroke after the first costs one boolean.
- **p50 and p95 are derived from the log, not computed in code.** A percentile
  computed inside the app is a number nobody can check, and `G1` already records
  raw values.
- **A provider error that is not a cancellation reports nothing, deliberately.**
  Filing it as a normal outcome would have `G2` count a defect as a measurement.
  The round count is the signal: fewer lines than rounds is the evidence.

## G2 — run 2026-09-19, and it settles D5 emphatically

**918 samples**, from a dev instance against a real remote project. They split
cleanly in half, and **the halves are different measurements**:

```
first  459    99% providerMissing     0 answered
second 459    59% providerMissing   147 answered   38 timed out
              p50 118 ms · p95 606 ms · max 1034 ms
```

**The first half measures extension-host startup, not the language server.**
Nothing answered at all, because the TypeScript extension had not activated on
the REH. Only the second half is the measurement.

**An earlier draft of this section reported 92% missing and a p95 of 870 ms.**
That was read off a partial log while the run was still going, so it was
dominated by the startup half — the figure was real and it described the wrong
thing. Recorded because reading a number before the run finished is the mistake,
not the arithmetic.

**The language server cannot be on the request path.** A p95 of 606 ms sits
against a whole-completion budget measured at roughly 900 ms in the previous
phase, so the language server alone would consume two thirds of it before a
token is generated. `D5` put collection in the background as a judgement call;
this makes it arithmetic.

**But `D5`'s 150 ms allowance for an explicit request turns out well
calibrated.** The p50 is 118 ms, just under it — so an explicit request that
waits up to 150 ms gets a fresh answer roughly half the time and proceeds
without one otherwise, which is exactly the behaviour that clause describes. It
was a guess when written; it is not one now.

**21% of the samples that had a provider timed out at the 500 ms ceiling.** The
ceiling was a measurement bound rather than a budget, chosen so the tail would
be visible — and a fifth of the distribution lives beyond half a second.

**Phase 2's real constraint: a provider was absent 59% of the time even once
warm.** `ordered(model)` returning empty means no definition provider was
registered for that model at that moment. Some of that is rounds where the
focused editor was not TypeScript, and the project was remote so activation had
to happen on the REH. Phase 2 cannot assume the language server is there. It has
to treat absence as an ordinary case and degrade to buffer-only without waiting,
which is what `G2`'s own fallback clause already says.

**A defect in the instrument, recorded because it inflates its own numbers.**
The bound is 100 rounds × 2 queries = 200 samples per run, and 918 were
collected — so `electron-vite`'s hot reload re-ran `entry.ts` roughly four times
and **each reload started another sampler without stopping the previous one**.
Concurrent samplers add language-server load while measuring language-server
latency, which biases the tail upward on top of the two biases already recorded.
The p95 should be read as an upper bound rather than an estimate. The sampler
needs to be idempotent across renderer reloads before it is run again.

### What the instruments will and will not tell us

`G2`'s sampler carries two opposing biases, both now recorded in the plan: it
reads an **idle cursor**, which flatters the result, and `queryMs` is a
`Promise.all` over every registered provider, so it reports the **slowest**
rather than the first useful answer. A p95 read without both is read wrong.

`G1` can prove a cache hit with one non-zero result. **It cannot prove the
absence of caching** — consistently zero means only that none was observed, which
is why `D7` budgets the feature as uncached regardless.

## Phase 2 — code-complete, and unproven

**2026-09-19.** Five tasks, written by deepseek and reviewed by claude after each
one. This is the first phase that changes what the model sees.

**Nothing has been run.** No gate, no app launch, no test, no network call.
`G0`'s first acceptance case — a completion in a file that uses a type from a
file never opened — has never been attempted, because it needs the app running
and a key. Everything here is code read, types read and arithmetic done by hand.

### What shipped

| #   | Task                                 | Shape                                          |
| --- | ------------------------------------ | ---------------------------------------------- |
| T1  | `queryPositions`                     | pure, bounded, ranked, interleaved two sources |
| T2  | The background collector             | armed by the reply, cancel-on-retrigger        |
| T3  | `resolveSnippets`                    | bounded head of a declaration, disposed        |
| T4  | Payload and prompt assembly          | shared, budget reallocated not added           |
| T5  | The provider reads what is collected | synchronous, free when absent                  |

### Four instances of one failure shape, three of them found by deepseek

Every one of these reads correctly, typechecks, and does the wrong thing.

1. **The sampler spawned a duplicate on every hot reload** — found by reading
   `G2`'s own sample count against its bound.
2. **Cancel-on-retrigger was missing from the collector**, which would have piled
   up collections on every keystroke rather than once per reload.
3. **`wire()` disposed the `onDidActiveEditorChange` subscription pushed one line
   above it**, so switching editors never re-wired: one editor collected, every
   other invisible, nothing in the log to say so. Found while tracing a different
   defect.
4. **The double-arm window** — `setCollectionArmed` guarded on intent rather than
   on the wiring's own state, so arm → disarm → arm inside two `getService` calls
   wired twice. Closed by keying the guard on `collectionEditorChange` with no
   `await` between the check and the assignment.

The pattern worth carrying forward: **a guard on intent is not a guard on state**,
and disposal that reaches beyond what it owns is the same bug wearing a different
hat.

### Three rulings that changed because of a measurement rather than an argument

- **The keyword stop-list was not written.** `getWordAtPosition` yields `import`,
  `from` and string contents, so slots are spent on words the language server
  answers nothing for. T2 now reports `emptyQueries / totalQueries`; the
  stop-list becomes a decision with a number behind it or it does not happen.
- **The collector's timeout is 1,500 ms, not the sampler's 500 ms.** `G2`
  measured a p95 of 606 ms, so the sampler's ceiling would have discarded a fifth
  of the distribution — right for a measurement bound, wrong for a collector.
- **The snippet-cache LRU was not built.** It is in the plan as a hypothesis
  under `D5`, waiting on `snippetResolveMs`.

### Two things the reviewer got wrong

**"Locations, not text" was wrong.** T2 was told to hold locations and leave
resolution to the provider. `D5` forbids the provider awaiting the language
service, so resolution has to be background, which means the collector. deepseek
reached that from the clause rather than from the instruction.

**The shared assembly was not named in T4's brief.** The renderer must know the
assembled length before it can size the prefix; main must build the prompt from
validated input. Two assemblies would have sized the prefix for a string that was
not the one sent — short or long by exactly the drift, and silent. One
implementation in `shared`, two callers.

### What the log will now show

`contextChars` is logged from the string actually sent, beside the `prefix`
length, so **`contextChars + prefix ≤ COMPLETION_CHARACTERS_PER_SIDE` is
checkable from one line.** That turns `G0`'s same-budget requirement from an
assertion into something a reader confirms — and it makes the context truncation
visible, because `contextChars` landing exactly on its cap is the cut firing.

### The gate, run once at the end — and none of Phase 2 had compiled

Six type errors and six lint errors, on code that had passed five reviews.

**The type errors say two tasks were never type-valid.** `CompletionPayload`
never gained its `context` field, so T4's validator checked a property the type
did not declare and T5 passed one that could not exist. And the completion
handler still carried `Promise<string | null>` after T2's reply became
`CompletionReply`, so main's own signature contradicted the contract it was
implementing. Both were reviewed and both were wrong.

**The cause is the reviewer's, not the implementer's.** The tasks were written
under a no-testing rule, correctly. The reviews were done by reading the excerpts
the implementer quoted — which showed the right code every time, because the
right code was there. What an excerpt cannot show is that the type it names does
not exist. **A signature change reviewed by reading is not reviewed.** Phase 1
gated at the end and found four errors; Phase 2 gated at the end and found
twelve, on more tasks with more interfaces between them.

**And two of the lint errors were the Phase 1 trap, again.**
`no-unnecessary-condition` flagged the cancellation re-check after the collector's
awaits, and the double-arm guard that R1 had explicitly required — calling both
dead because TypeScript cannot see an assignment across an `await`. Deleting
either to satisfy the tool would have reinstated the exact races the phase spent
two rounds closing. Both now read through a helper that defeats the narrowing:
`cancelled(token)` from Phase 1, and a new `collectionWired()`. **The linter has
now asked to delete a correct guard three times in two phases**, always for the
same unsound-narrowing reason, and it has been right about none of them.

## The acceptance case failed, and `D5` read literally is why

**2026-09-19, first run.** Every completion logged `context: 0, contextChars: 0`.
Not one request carried context. The suggestion Mohamad screenshotted invented
`record?.firstCurrency` — a property that does not exist — because the model was
never shown what `record` is.

**The collector was not the problem.** `emptyQueries: 8, totalQueries: 16` on
every collection, and `snippetResolveMs` between **36 and 81 ms**. It gathers,
resolves, and stores. The context was being discarded at the read.

**`collectOnce` captured the buffer's version before the queries and stored it
after them**, and `collectedContext` rejected the entry unless the buffer was
still at that exact version. The collector is triggered by typing; completions
are triggered by typing. So between capture and read the user has almost always
typed again, and the entry is **stale on arrival, structurally**. The feature
could not fire while anyone was writing — the only time it does anything.

**The correction, and it is `D5` versus its own purpose.** The clause says cache
entries track "the source document's version as well as the active buffer". Its
stated reason is that "an unchanged `files.ts` will be handed yesterday's
signature **from another file**" — and that is served entirely by the _source
document's_ version, which T3's per-snippet cache checks at `:624` and `:640` and
which is untouched. The _buffer's_ version was gating a different question that
merely looked similar: whether the positions the queries were made at are still
relevant. **That is the same question as cursor position, which T5 had already
ruled is not part of validity, for the same reason — typing moves it.** A version
moves on every character, so the gate was the stronger form of a check already
rejected.

So the buffer gate is gone and `collectedContext` is a lookup. What remains
protected: the source document's version per snippet, the live read through
`createModelReference`, and main's bounds. What is now knowingly accepted: a
snippet may describe a symbol that has since moved, and the positions may sit
slightly behind the cursor — which degrades relevance, not correctness.

### Two measurements, one of which corrected the reviewer

**The LRU hypothesis is closed by a number.** `snippetResolveMs` at 36–81 ms
means resolution is cheap and the held-reference LRU is machinery nobody needs.
That is the second ruling this phase settled by measuring rather than arguing.

**The keyword stop-list is still not settled, and the reviewer said otherwise.**
`emptyQueries: 8, totalQueries: 16` looks like it prices T1's waste and does not:
it counts _queries_ that returned nothing, which includes real identifiers with
no definition, while a stop-list would remove _positions_. The ratio would not
necessarily move. The number that decision needs is how many of the eight
positions were keywords or string contents, and nothing logs which positions were
queried. deepseek caught that; the reviewer had already called it settled.

## Context arrives, and the budget split becomes the defect

**2026-09-19, second run.** With the buffer gate gone, every request carried
`context: 8, contextChars: 1200` where it had carried zero. The fix worked. The
suggestion was still wrong — `record.currency` on a type that has no such member
— and the log said why with a number that was exact rather than approximate.

**`contextChars` was 1200 on every single request**, which is exactly
`COMPLETION_CONTEXT_CHARACTERS`. Eight snippets at up to 400 characters is 3,200
against a 1,200 cap, so `assembleContext`'s truncation was **guaranteed by
arithmetic**, not unlikely — a claim deepseek had made two rounds earlier and
could not substantiate. About three snippets survived, the third cut mid-line,
and five were fetched and discarded. The prefix had meanwhile halved from ~1,800
to 1,200, so the model saw less of the file it was completing than it had the day
before, when it had no context at all and did no worse.

**And the failure named the deeper defect.** `record.currency` needs the
_members_ of `ApiCurrencyReadPayload`, and T3's fixed four-line head of a
declaration gives the opening brace and the first two or three. **A type name
without its shape is worse than no snippet**, because it makes an invented member
look grounded rather than guessed.

### Three constants that had to agree, written as though they need not

This is the `charactersPerSide: 600 * 4` mistake again, one level out:
`COMPLETION_CONTEXT_SNIPPETS`, `COMPLETION_SNIPPET_CHARACTERS` and
`COMPLETION_CONTEXT_CHARACTERS` were chosen independently. The bound is now
**derived** — `(budget − (2n − 1)) / n`, where `2n − 1` is the separator cost of
`join('\n\n')` plus a trailing newline — giving 398 at a count of three, and a
worst case of 1,199 against 1,200. The whole-string cut in `assembleContext` was
**deleted** rather than left as reassurance: an unreachable truncation hides the
day it stops being unreachable.

**The extraction now uses the extent T3 already had and discarded.** `Range`
carries `endLineNumber`; the old walk counted four lines from the start and threw
it away. A declaration that fits arrives whole and a larger one gets its head —
identical for a function signature, decisive for an interface.

### The same duplication survived one level further in, and it corrupted the measurement

`snippetText` bounded the **raw text** at 398 while `assembleContext` bounded the
**marked block** at 398 — two different strings against one constant, so markers
pushed every block over and the mid-line cut had merely moved. Worse, `whole` was
computed upstream of a cut that could still fire, so `snippetsWhole` would have
over-reported — and it is the number the next decision rests on.

**Route one cannot fix it.** Marker overhead is `lines × (marker + 1)`, a
function of the line _distribution_ rather than the character count: 398
characters is one line or 199 one-character lines. A raw bound safe for every
distribution is roughly 130 characters, which buys the guarantee by cutting every
interface to nothing.

So the cut and the flag both moved into `assembleContext`, the only code that
knows the marker. The transport cap is made **provably subordinate** rather than
merely larger: the walk breaks only _past_ `COMPLETION_SNIPPET_SOURCE_CHARACTERS`,
so a clipped snippet is at least 2,400 characters, so its marked block strictly
exceeds 398, so main's cut necessarily fires. **Clipped implies cut** — and the
contrapositive, _not cut implies not clipped_, is what lets `whole` be honest
with no extra field on the wire.

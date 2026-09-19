# The editor that knows this codebase

**Date:** 2026-09-19

**Status:** ready to start, signed off by codex on 2026-09-19. Written from three
independent research passes — claude, codex and deepseek — each of which
corrected the others, then revised twice after codex reviewed the closures.
**Nothing here is left open**: every question is either a decision taken below
(`D1`–`D7`) or a verification gate with a method, a pass criterion and a stated
fallback (`G0`–`G5`). `G0` is the one that licenses the sentence "the editor
knows this codebase"; it blocks calling the feature complete and blocks nothing
else.

**Delivery branch:** `feat/project-aware-completions`, branched from `main`.

**Depends on:** `docs/plans/the-line-you-have-not-typed-2026-09-18/` — that phase
shipped a working inline completion, and its `STATUS.md` carries the measurement
that constrains everything here.

---

## The outcome

Suggestions in the editor grounded in this repository — its real symbols, its
actual types, its conventions — rather than in what the current buffer happens to
look like. Typing in `files.ts` should produce a suggestion that uses the
project's own path-resolution contract and the current types from a file that was
never opened.

**Both modes are deliverables.** Automatic suggestions while typing are what was
asked for and stay in scope; explicit suggestions are the richer second mode
beside them. An earlier draft of this plan moved automatic out of scope on
latency grounds — that was a product change made on the user's behalf and it is
reversed.

**The honest sentence for what this is: "the editor knows this codebase", not
"the editor answers like the agent".** The gap is not context, it is
**verification**. An agent reads what it chooses, runs things, sees the failure
and corrects itself. A completion emits tokens once and cannot check them. More
context makes the guess better informed; it does not make it checked. Anything
here that starts to read as "a cheaper agent" has gone wrong.

## What the three passes established

**Edit prediction, not completion, is the qualitative shift** — Zed's Zeta,
Copilot NES and Cursor Tab all answer "what is the next edit". It needs no
training of our own: Zeta 2.1 is published under Apache-2.0.

**Routing and resolution are different problems that compose.** A repo map
answers _which files could matter_; the language server answers _what this symbol
means here, exactly_. DraCo builds both because it has neither; we have
resolution already and need routing only for reach. DraCo makes definition-based
retrieval **worth testing** here; it does not establish that its result carries
over, because it is Python, offline-analysed and evaluated against prefix-only
models. Its apparatus certainly does not carry over — it infers types from a
batch AST pass where we have a language server that answers live.

**The language service is already in the pinned `33.0.9`:**
`ILanguageFeaturesService` for definitions, type definitions, references, hover,
signatures and document symbols; `mainThreadLanguageFeatures` forwarding to
extension-host providers with cancellation; `getDefinitionsAtPosition` and
`getTypeDefinitionsAtPosition` aggregating; `CallHierarchyProviderRegistry`;
`ITextModelService.createModelReference(uri)` to resolve what comes back.

**Recent edit history is an input, not a nicety.** Zed's report describes
substantial work on edit-history granularity specifically to stop the model
undoing the user's latest change.

**Conventions do not arrive with a filename.** Cursor's documentation says its
rules are **not applied** to Tab. That shows the capability is absent there, not
that supplying rules is ineffective — a distinction an earlier draft blurred.

## Decisions taken

**D1 — The trigger is `editor.action.inlineSuggest.trigger`, and we bind it.**
The command exists in the pinned build but has **no default keybinding**, and
Chorus adds none. So bind `⌥\` at default priority, leaving user overrides
intact, and branch the provider on `InlineCompletionContext.triggerKind`
(`languages.d.ts:585`), which we currently discard as `_context`. No new UI and
no new channel — but the existing channels' **contracts do change**: the payload
gains a mode, and output settings move from main-fixed to per-mode. "No IPC
changes" would have been wrong.

Note that explicit does not always skip the wait: `shouldDebounce` includes
`updateOngoing`, so an explicit request still waits behind an in-flight one.

**D2 — Automatic requests never wait for retrieval.** They use context that is
already prepared and version-valid, inside today's total input budget, with part
of it reallocated to definitions and examples. Explicit requests may gather more.
This keeps automatic project-aware **without adding retrieval waiting** — which
is not the same as leaving latency unchanged, and the end-to-end effect is
measured rather than promised. It is why the floor does not have to be fixed
first.

**D3 — Output limits split by mode.** Automatic keeps `max_tokens: 64` and the
blank-line stop. Explicit takes **512** with no stop and a **three-second total
deadline** measured from the request, which means the current two-second fetch
timeout has to become per-mode. 512 is a ceiling, not an instruction to write a
lot. Record `finish_reason` and **discard truncated replacements**. A timeout
yields no suggestion and an observable reason, never a second model call.

**D4 — Rules come from an explicit section, not from guessed relevance.** Read a
`Completion rules` section from applicable `AGENTS.md` files, with `CLAUDE.md` as
the documented fallback, resolved **root-downward toward the edited file** so
deeper scopes take precedence without erasing parent rules. Include the text
verbatim, preserve provenance, bound it at **4,096 characters** keeping whole
rules and recording what was dropped, and never follow instruction-file
references outside the project. Automatic convention matching uses existing code
examples and declarative configuration rather than prose. Classifying arbitrary
workflow prose is not attempted, and is not needed for convention-aware
suggestions.

**D5 — Language-service collection is always in the background.** Never on the
request path, with cancellation and bounded concurrency. Automatic requests never
await it. Explicit requests may wait up to 150 ms for fresh results inside their
deadline, then proceed with whatever valid context exists. Cache entries track
the **source document's version as well as the active buffer**, or an unchanged
`files.ts` will be handed yesterday's signature from another file. And
"definitions for the symbols in scope" is not an API: definitions are queried at
a position, so the implementation selects a bounded set of nearby identifiers and
imports.

**D6 — A replacement is never reinterpreted as an insertion, and the fallback is
chosen before generation.** G4's capability results decide, for subsequent
requests, whether this editor gets cross-file replacement, same-file replacement
or a cursor insertion. That choice is made ahead of the model call, not after
it. An individual replacement that fails validation or presentation is
**discarded** — never re-requested inside the same request and never reused as
text to insert here. Every replacement carries target URI, base version, range
and expected old text, and is rejected if any no longer matches. Edits stay
under the editor's normal acceptance and undo behaviour.

**D7 — Caching is not an architectural dependency.** The FIM reference documents
`prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`, so support is
established and only usefulness on our workload is unknown. The implementation
decision is complete and is this: **assume no cache granularity, hardcode no
chunk size, and budget without cache hits.** Any hits are a bonus. A missing
field is recorded as **unreported**, never as zero.

And a design consequence nobody had until codex found it: our prefix window is
capped at 2,400 characters, so **once it fills, the start of the prompt slides on
every keystroke**. That loses a stable source prefix — it does not establish what
the provider can or cannot cache internally. Stable context should sit _before_
the sliding window, which costs nothing and is the only arrangement that could
benefit if the provider does cache.

## Verification gates

Each has a method, a pass criterion and what happens on failure. None blocks
starting; each blocks claiming something works.

**G0 — The feature is complete, and this is the only gate that says so.** The
others license individual claims; this one licenses the sentence "the editor
knows this codebase". It exists because a single successful completion in
`files.ts` proves feasibility and not the feature.

Freeze **fifteen positive cases and five abstention cases for each mode**, before
any tuning, each sized to that mode's output budget. The positives must include
an API from a file that was never opened, a repository convention, and a
dependency that changed while the edited file did not.

**Both modes** must reach **12/15 useful and contract-correct, and 5/5 correct
abstentions**, and each must **improve on a buffer-only control** run against the
same provider with the same input and output budgets. Timeouts and malformed
responses count as failures rather than being dropped. These are release checks,
not a claim about general accuracy.

Observe it in Chorus, not in a harness: automatic suggestions during ordinary
typing, explicit suggestions through the bound command, and acceptance,
dismissal and undo each verified. Cancellation and a changed source must prevent
a stale suggestion or edit from ever being applied. Automatic requests must never
be seen waiting for retrieval; explicit requests must respect the three-second
deadline. Record request-to-visible p50 and p95 and every terminal outcome,
cancellations and timeouts included.

**Buffer-only is a valid fallback when a language provider is missing, and it
cannot satisfy this gate** for the TypeScript workflow this starts on. G3 and G5
may fail and take their fallbacks; whatever remains must still pass G0.

**G1 — Does this workload benefit from caching.** Three representative prompt
sizes, each sent once and repeated after two and ten seconds, recording token
counts, both cache counters and durations, supplemented by ordinary typing
observation. One non-zero result proves a hit. **Consistently zero proves only
that none was observed** — it does not prove the path is uncached. Fail: proceed
on the uncached budget, which D7 already assumes.

**G2's instrument carries two opposite biases and both belong beside its
numbers.** It samples an **idle cursor** rather than one mid-keystroke, which
flatters the result; and `queryMs` is a `Promise.all` over every registered
provider, so it reports the **slowest** rather than the first useful answer,
which does the reverse. Neither is a defect — a measurement that perturbs what it
measures is the reason `D5` bounds concurrency in the first place — but a p95
read without knowing both is read wrong.

**G2 — Language-service cost through the REH.** Record p50 and p95 for
definitions plus type definitions, missing-provider rates and timeouts. There is
no single threshold that decides the architecture, because a low median hides
disruptive tails — D5 already puts collection in the background regardless. Fail
here means a capability is absent for a language, and the suggestion degrades to
buffer-only for that language rather than blocking.

**G3 — Is prediction better than insertion.** Twenty cases frozen **before** any
tuning: fifteen positive, covering repository APIs, conventions and useful
follow-up edits, and five where the correct answer is silence. Compare against
repo-grounded insertion on identical context. **The pass is comparative, because
that is what the title asks**: prediction must produce **more** useful and
contract-correct positives than the insertion baseline, while still meeting all
five abstentions silent, zero unintended reversals, zero invalid replacement
targets and zero stale applications. **On a tie, insertion keeps the field** —
the more complex mechanism has to earn its place. Timeouts and malformed
responses count as failures rather than being dropped. "Does not undo the
last change" is deliberately _not_ the criterion — a model that always returns
nothing would pass it. Fail: ship project-aware insertion, evaluated on its own,
and do not claim prediction shipped.

**G4 — Native edit capabilities, verified separately.** Same-file replacement,
another-file navigation, preview, acceptance, dismissal and undo are six checks,
not one. `includeInlineEdits` is a real gate — returning `isInlineEdit: true`
does not guarantee display. Fail cascades per D6.

**G5 — Is routing needed at all.** Frozen cases where Phase 2 and 3 context
selection demonstrably missed a necessary file. A retriever is adopted only if it
improves useful completions at the same budget **without regressing** the earlier
cases. **Keeping the simpler retriever is a valid outcome**, and Phase 4 does not
ship unless this gate says it should.

## Phases

**Phase 1 — Telemetry and capability.** Not "one field". Read the cache counters
out of `usage`; add a request id correlating overlapping calls; record response
duration and, separately and accurately named, **response-header arrival** —
`await fetch()` does not measure first body byte or first generated token, and
mislabelling it would poison every later comparison. Add request-to-visible-
suggestion timing on the renderer side, which is the number that actually
describes the experience. Suggestion **content** never enters any of it. Runs G1
and G2.

**Phase 2 — Resolution in the prompt.** Background collection of definitions and
type definitions per D5, placed adjacent to the completion point because
RepoBench found position matters, with stable context ahead of the sliding prefix
window per D7. Automatic mode uses only what is already prepared. _Done when_ a
completion in `files.ts` uses a type from a never-opened file, and Phase 1's log
shows what it cost.

**Phase 3 — The explicit tier.** `triggerKind`-branched per D1, D3's limits, D4's
rules, recent edit history, relevant buffers and Phase 2's definitions. **It does
not use the repo map** — an earlier draft had Phase 3 depending on something
Phase 4 builds, which was a cycle. Runs G3 and G4.

**Phase 4 — Routing, conditionally.** Tree-sitter symbol graph and personalised
PageRank, only if G5 says the simpler sources miss necessary evidence. Two
caveats recorded now: it **can go stale** — Aider caches parsed tags by file
mtime and unsaved buffers need separate integration — and **popularity is not
program flow**, since a symbol referenced by twenty files outranks the small
function relevant to this edit, and a reference graph does not resolve runtime
dispatch, dependency injection or IPC contracts. A July 2026 head-to-head crowns
neither maps nor embeddings; it is a preprint about file retrieval for agents
rather than completion acceptance, so it argues for complementary methods.

## What this deliberately is not

**Not an agent in the editor.** If an acceptance criterion ever becomes "it
answered like the agent would", the plan has drifted.

**Not RepoCoder's loop.** Iterative retrieve-generate-retrieve doubles the round
trip, and the measurement says we cannot afford one.

**Not an event.** Nothing about a suggestion, its context or its acceptance
reaches the event log.

**Not a widened selector.** Context gathering stays inside `file:` and
`vscode-remote:`, because that restriction is what keeps `uri.path` correct.

**Not a promise about latency.** No phase here claims sub-400 ms, and none claims
prompts can never improve it either — neither has been established.

## The one disagreement, and why it is not an open question

deepseek read DeepSeek's caching guide as specifying 64-token granularity from
the 0th token; codex read the current guide as describing persisted prefix units
instead. That disagreement stays in the research history and is **not** resolved
here — because the implementation decision that would have depended on it is
closed instead, in D7: assume no granularity, hardcode no chunk size, budget
without hits. Nothing in this plan reads either number, so nothing waits on
which of them is right.

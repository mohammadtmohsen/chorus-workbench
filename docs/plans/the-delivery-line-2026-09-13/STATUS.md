# Status — the delivery line

## Phase 1 — roles and the display order · shipped, verified

`WORKER`/`GUIDE` are gone. `collaborate.ts` now exports `PLANNER` (claude),
`REVIEWER` (codex) and `CODER` (deepseek), plus **`rolesFor(preset)`** — one
answer to "who does a run need", asked by both the file that dispatches and the
file that refuses. Those were two hardcoded pairs that happened to agree;
`runtime.ts:2916` now calls `rolesFor` instead of spelling the pair again.

`CODER` is declared and unused until the micro-task loop. That is deliberate: the
role is what the rename is for, and a role that appears only in the phase that
uses it reads as an afterthought. A test asserts `rolesFor` does **not** yet
return it, so Phase 4 has to change that line rather than discover later that
`runtime.ts` was refusing on a cast this file no longer dispatches to.

### Correction to the plan: the guard was renamed, not dropped

The plan said Phase 1 drops the `notClaude` guard. **That was wrong and would
have been a regression.** Dropping it now lets a run start from a Codex or
DeepSeek message into a flow that still assumes the planner wrote it. What it
needed was the rename the guard had always been owed: the check is
`source.actor !== PLANNER` and the refusal is `notPlanner`, through
`CollaborationRefusal`, the IPC enum and the i18n string.

That is `CLAUDE.md`'s own rule — rename the field in the same change that makes
what it identifies a variable — and the compiler cannot help with a name that is
merely now misleading. Dropping the guard properly belongs with open question 4,
which is about where a run starts at all.

### Display order

`ALL_AGENTS`, `Settings.tsx`'s `AGENTS`, `DEFAULT_SETTINGS.agents` and
`App.tsx:90` now read **codex, claude, deepseek**. The comments in all three
files said "Claude first" and moved with it, because a comment that outlives the
line it explains is worse than none.

`useUsage.ts`'s `ACCOUNTS` was left alone: it is the plan-window surface, it was
already codex-first, and DeepSeek sends no rate-limit events.

Verified: typecheck 18/18, eslint clean, 2523 tests pass.

**Not verified: nothing has been driven.** The pipeline does not exist yet, so
collaborate still runs the old two-hop flow — now through role names rather than
agent names.

## Phase 2 — the envelope · shipped, verified

`TASK_PROTOCOL` and `parseMicroTasks` in `collaborate.ts`, pure and exported,
beside `VERDICT_PROTOCOL` and `parseVerdict`.

### Anchored at the opposite end, for the opposite reason

`parseVerdict` reads the **first** nonblank line because nothing legitimate
precedes a verdict. A split is preceded by the whole plan, which will quote this
protocol while explaining what it is about to do — so `parseMicroTasks` reads the
**last** `tasks:` line. Taking the first would let a sentence about the list
become the list, which is the same class of bug the verdict's anchoring exists to
prevent, arriving from the other direction.

### The failure mode is an empty list, never a wrong one

A reply that repeats the bare anchor after its real block finds no task lines
under the later one and returns nothing. The caller treats that as unparsed and
asks again. A parser that guessed between two blocks would instead dispatch prose
to a coder as though it were work.

A line is only an anchor when it is _exactly_ `tasks:` after emphasis and list
markers are stripped — `tasks: done` is prose and does not end the list. Blank
lines between tasks are skipped rather than treated as the end, because models
space lists out and stopping at the first blank would take one task from a list
of nine.

**No cap in the parser.** Bounding a run is a spend decision and belongs where
the spending happens; a parser that silently truncated would hide a malformed
split rather than report one. That cap is open question 2.

### Tests

Twelve, every one a way a model actually formats a list: numbered, emphasised,
blank-separated, prose after the list, carriage returns, a 200-entry list that is
not truncated, and the protocol-quoting case that motivated last-anchor. One
asserts the protocol and the parser still agree — drift between them is the
failure no other test here can see, because both would be internally consistent
and disagree.

**Mutation-proved:** switching last-anchor to first-anchor turns three red.

Verified: typecheck 18/18, eslint clean, 2535 tests pass.

## Phase 3 — the linear stages · shipped, verified

`guided` is no longer review → revise → verify → report. It is the delivery
pipeline: **`reviewPlan` → `split`**, and it stops there. The micro-task loop and
the closing report are Phases 4 and 5.

### Where a run starts — open question 4, answered by default

**The run still starts from a completed planner reply, and that reply is the
plan.** You ask Claude to plan in the ordinary way and then start a run on the
answer. Nothing dispatches a planning turn of its own.

That was assumed rather than asked, because it is the reading that changes least:
it is today's entry point, it keeps the `notPlanner` guard meaningful, and it is
what the user described — Claude plans first. The alternative, where Chorus sends
the planning request itself, is still open and would move the entry point to the
user's own message.

### `stepTotal` is nullable, and genuinely null

`oneShot` is two hops and always was. The pipeline's length is `3 + 2 × tasks`
and nothing can compute it until the planner has split the plan — so it is
**null until the split is read**, not a guess. `Session.tsx` renders a second
string rather than a number that might be null: `collaborate.runningUnknown`,
because "3 of null" is worse than a line that does not claim a length yet.

### `unsplit` is a new outcome, and the plan put it in Phase 5

Brought forward, because without it a plan that came back as prose reports as
`unverified` — which blames the reviewer for something the planner did. The
planner answered and the turn succeeded; what is missing is a list a machine can
act on. One union member, one IPC enum value and one string.

### `verify` is gone

It existed only in the old guided flow. Removing it rather than leaving a dead
union member means the linter's exhaustiveness check keeps working for the
members that are real.

### Tests

The seven `a guided run` tests described the flow this replaced, so they were
rewritten rather than patched — the block is now `the delivery pipeline`. Two
assert things the old flow did not do: the pipeline **does not short-circuit on
a ready verdict**, because the split is the deliverable rather than the fix; and
`stepTotal` is null through both hops and a number afterwards. Three status
tests needed the second hop resolved, since they relied on that short-circuit.

Verified: typecheck 18/18, eslint clean, 2535 tests pass.

**Not verified: nothing has been driven.** No run has been started against real
agents, so the notes the reviewer and planner receive have never been read by a
model.

## Phase 4 — the micro-task loop · shipped, verified

`implement` → `accept`, one task at a time, each checked before the next is sent.
Sequential because it was asked for and because it is the only version where a
rejection can be attributed: two tasks in flight against one working tree produce
a review that cannot say which one broke it.

### The caps, and why they are refusals rather than clamps

`MAX_MICRO_TASKS = 20` and `MAX_REISSUES = 3`. **Taken as defaults rather than
answered** — they were offered and the instruction was to proceed, so they are
named exported constants and one line each to change.

An over-long list is **refused**, not truncated: delivering the first twenty of
twenty-five would leave five tasks nobody did and a report that did not say so.
That is its own outcome, `tooManyTasks`.

A task that hits the re-issue cap **ends the run** rather than moving to the next
one. The tasks are a plan in order, and carrying past one the planner would not
accept builds the rest on top of work it rejected. That reports as `unresolved`,
which is exactly what it means.

### The fallback skips the check, and that is deliberate

`coder()` reads `sessionRef(conversationId, CODER)`, which is null both when
DeepSeek is not in the cast and when it has no key — an adapter that refuses to
start never produces a session, so one signal covers both.

With no coder the planner does its own micro-tasks **and the `accept` hop is
skipped entirely.** A review is only worth a turn when someone else wrote the
code; asking an agent to issue a verdict on the turn it has just taken spends a
provider call to learn nothing.

### The task is quoted, never numbered

The coder is handed the transcript so far, so `do task 4` would make it count a
list it may be reading in a different order than the planner wrote it. The note
carries the task text.

### `rolesFor` still excludes the coder, permanently

The Phase 1 test said "not yet". That was wrong and is corrected: `runtime.ts`
refuses a start when a listed agent is missing, and the coder is the one agent
whose absence is survivable. Listing it would turn the fallback into a refusal.

### Tests

Ten in the pipeline block, including the two caps, the fallback skipping
`accept`, the coder never receiving a verdict protocol, and `stepTotal` moving
from null to 6 for a two-task split. Four status-contract tests had to run the
loop out, since they relied on the run ending at the split.

Verified: typecheck 18/18, eslint clean, 2539 tests pass. One run reported a
stray error outside the assertions; five subsequent runs — three of the
collaborate suite, two full — were clean, so it is recorded rather than
explained.

**Not verified: nothing has been driven.** No model has read any of these notes.

## Phase 5 — the report · shipped, verified

The pipeline closes with a `report` hop, and **it is a handoff from the planner
to itself.** There is no other truthful sender: the planner took the last turn,
either accepting the final task or refusing one, and asking the reviewer to
report would put a summary in the mouth of an agent that has not seen the work
since it reviewed the plan. Nothing in the port forbids a same-agent handoff and
`defaultIntent` already returns `discuss` for one, so it was expressible rather
than forced.

**A report is only written when something was delivered.** `unsplit` and
`tooManyTasks` end before any task is sent, and a report on a run that did
nothing is a turn spent restating what the transcript already shows. That has its
own test.

### `Hop.verdict` is gone

The `report` note was its only consumer, and rewriting that note for the pipeline
left the field carried at eight call sites and read by none. Removing it rather
than leaving it is the same rule as `verify`: a field nothing reads is the tail
`CLAUDE.md` warns a deletion leaves behind.

### Outcomes, complete

| Outcome        | Means                                                |
| -------------- | ---------------------------------------------------- |
| `agreed`       | every micro-task was delivered and accepted          |
| `unresolved`   | one task hit the re-issue cap; the run stopped there |
| `unsplit`      | the planner's split had no readable task list        |
| `tooManyTasks` | the split was longer than a run will deliver         |
| `unverified`   | one-shot only — the reviewer never saw the revision  |

Verified: typecheck 18/18, eslint clean, 2540 tests pass.

**Not verified, and this is now the whole of what is left:** no run has ever been
started against real agents. Every note in this file has been read by a test and
by nobody else.

## Open

All five phases have shipped. Two of the plan's four open questions were resolved
by taking a default and saying so — the caps at 20 and 3, and the run still
starting from a completed planner reply. Two remain genuinely open:

1. **What a run does with no Codex.** DeepSeek's absence has a fallback; Codex's
   does not. A run without a reviewer would skip straight from the plan to the
   split, which is a different product rather than a degraded one.
2. **Whether `oneShot` survives.** It is untouched and still runs the old
   two-hop review. "Replace it" was read as replacing `guided` only.

**And the real gap: nothing has been driven.** The claim most worth doubting is
that `dispatchAndWatch` is agent-agnostic — its acknowledgement and idle bounds
have only ever run against Claude and Codex, and DeepSeek's turns arrive from a
different provider through the same adapter. One real run answers that.

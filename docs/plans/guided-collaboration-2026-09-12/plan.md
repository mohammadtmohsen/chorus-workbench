# Guided collaboration: automate the handoff loop, and nothing else

> **Revision 12, 2026-09-12. FINAL — every finding answered.** Eleven revisions
> and fourteen review passes. `FINAL` is used here in the only sense it can
> carry: every finding is applied or explicitly declined with a reason, and the
> user has accepted the one scope reduction that needed accepting.
>
> **Applied from `GC10`:** ownership proof now matches the captured `sessionRef`
> rather than the agent id, and `approval.withdrawn` closes the idle suspension.
> Codex's own summary of that pass called the core two-lifetime architecture
> cleared and these "lifecycle and UI-contract fixes only".
>
> **`GC10-03` is applied.** Its text was truncated on the way to me and was
> supplied intact afterwards; it turned out to be behavioural rather than
> cosmetic. **Whenever the run state is terminal and `draining` is true the
> status row offers Restart**, for `owned` as much as for `unattributable` —
> because an acknowledgement timeout paired with an ambiguous delivery rejection
> makes both of §2's proofs unreachable, so ownership can stay `owned`
> indefinitely with nothing on screen saying what would clear it. §4's total
> label maps are **mine** and do not address that condition.
>
> **The scope reduction is accepted explicitly by the user**, which is what makes
> the deferral coherent rather than convenient. This v1 **does not redirect a
> stuck Claude**, and the honest version is stronger than revision 11's: a run
> starts from a completed reply, so a Claude hung _while producing_ that reply
> gets nothing here at all — there is no run to report on. Only a
> coordinator-dispatched Claude turn can reach `failed · idle`. §6 says what the
> redirect would need.
>
> **Decided by the user across the loop:** a minimal v1; no read-only promise for
> either agent; the closing Claude report only where something was contested; two
> named presets; the waiter counts turns rather than reading a ref; fresh
> targeted reads at each review; the result lands in the transcript only.
>
> §8 keeps ten revisions of claims the source contradicted. Nothing here has been
> run. No product code has been changed.

## 0. What this is

**The user already does this by hand.** Claude answers, `Codex reviews this`
hands the reply over, Codex objects, and the user carries the objections back.
This removes the carrying.

**One hop is already built and needs no schema change.** `prepareHandoff`
composes a brief and `sendHandoff` records and delivers it (`runtime.ts:2729`,
`:2774`), framed per intent by `composeBrief` (`handoff.ts:53`), appended as
`handoff.created` (`event-store/src/events.ts:304`), projected into `handoffs`
(`projections.ts:237`), ignored by catch-up because the recipient got the content
in full (`catchup.ts:411`), and drawn as its own transcript card
(`transcript.ts:1085`, `Entry.tsx:673`).

**What the research supports, narrowly.** MAST supports fixed roles and explicit
termination — 41.8% of multi-agent failures in specification and design, 36.9% in
inter-agent misalignment. Cross-family review has its own support:
self-preference bias runs −38% to +90% on ArenaHard, driven by a model
recognising its own output, with cross-family judging as the published
mitigation. The often-quoted 81.8%-against-67.0% debate figure came from **three
same-model agents** on arithmetic, GSM8K and chess and is not evidence about two
coding agents; iMAD's savings depend on a trained classifier this does not have.
Codex also cites a 2026 pre-registered study preferring a single-pass review;
**I have not read it**, and it is recorded as its finding.

## 1. The shape

```
Claude finishes a reply
      │
      ▼
user presses Review with Codex · One-shot or Guided
      │
      ▼
handoff  claude → codex   intent review          [Codex turn 1]
      │
      ├── ready ──────▶ finished · agreed
      │
      └── objections | unparsed
                │
          handoff  codex → claude   intent discuss     [Claude turn]
                │
                ├── One-shot ──▶ finished · unverified
                │
                └── Guided
                        │
                  handoff  claude → codex  intent review    [Codex turn 2]
                        │
                  handoff  codex → claude  intent discuss   [Claude turn]
                        │
                        ▼
                  finished · agreed | unresolved | unverified
```

| Preset     | Turns after the reply | Ends with                              |
| ---------- | --------------------- | -------------------------------------- |
| `One-shot` | 1 if approved, else 2 | Codex's approval, or Claude's revision |
| `Guided`   | 1 if approved, else 4 | Codex's approval, or Claude's report   |

**The closing Claude turn exists only where something was contested** — the
user's decision, and what gives every handoff a truthful sender.

### Run state

```ts
type RunState =
  | { phase: 'running'; step: Step }
  | { phase: 'finished'; outcome: 'agreed' | 'unresolved' | 'unverified' }
  | { phase: 'cancelled'; by: 'stop' | 'userMessage' | 'manualHandoff' | 'shutdown' }
  | { phase: 'interrupted'; reason: 'foreignTurn' }
  | {
      phase: 'failed'
      reason: 'delivery' | 'acknowledgement' | 'idle' | 'turnFailed' | 'noReply' | 'sessionEnded'
    }
```

`agreed | unresolved | unverified` exist **only** under `finished`, so
exhaustion, a stop and a crash cannot be flattened into "done".

| Outcome      | When                                                                                   |
| ------------ | -------------------------------------------------------------------------------------- |
| `agreed`     | the last Codex verdict was `ready`                                                     |
| `unresolved` | the last Codex verdict was `objections`                                                |
| `unverified` | the last Codex reply was `unparsed`, or `One-shot` ended on a revision Codex never saw |

### The verdict contract

```ts
parseVerdict(text: string): 'ready' | 'objections' | 'unparsed'
```

Reads **only the first nonblank line** and requires exactly `verdict: ready` or
`verdict: objections`. Anything else is `unparsed`. `objections` and `unparsed`
route identically and differ only in the outcome.

**The protocol is asked for in the note, because the framing does not ask for
it.** `composeBrief`'s `review` framing says _"Review it and report what is
actually wrong … Say so plainly if it looks right."_ (`handoff.ts:45`) and says
nothing about an envelope. So every `review` and `verify` note carries the
contract verbatim and first:

```
Begin your reply with exactly one of these as the first line:
verdict: ready
verdict: objections
Then a blank line, then your review.
```

Anchoring on the first nonblank line is deliberate: scanning for `verdict:`
anywhere would let a sentence quoting this protocol decide the loop.

## 2. Phase 1 — Two lifetimes

**This is the whole of `GC9-01` and `GC9-02`, and it is the design's spine.** A
dispatch produces two promises with different rules:

```ts
interface Dispatch {
  /** The reply, or a named failure. Cancellable. */
  result: Promise<WaiterResult>
  /** Resolves only when the agent is provably free. Not cancellable. */
  drained: Promise<void>
}
```

**`result` serves the user. `drained` serves the next run.** Aborting settles
`result` at once — the user is free, the state is reported, the row updates — and
**`drained` keeps its own subscription alive** through the drain. Revision 9 said
abort "unsubscribes", which would have left nothing watching for a late
`turn.started` and its eventual terminal event. Two subscriptions, two
lifetimes, and only the first one is cancellable.

### Ownership is released by proof, and there are exactly two proofs

`GC9-02`: revision 9 had two release predicates that are not evidence.

**Silence is not terminal.** `userinput.requested` is registered with **no
timer** — a question waits for the person it was asked of, for as long as that
takes — and an approval waits on a card too. A turn can be legitimately silent
for hours and then resume the moment someone answers. So five minutes of silence
proves nothing about whether the turn is over.

**A delivery rejection is not proof of non-acceptance.** `JsonRpcClient.sendOnce`
calls `transport.send(...)` **inside** the promise and a later timer rejects it
(`adapter-codex/src/rpc.ts:138`). The request was written. A timeout is
ambiguous by construction.

So ownership ends on one of exactly two things:

1. **An attributable start and its terminal event** — a `turn.started` observed
   while this coordinator was the only thing dispatching to that agent, followed
   by its `turn.completed`.
2. **A `session.ended` carrying the exact `sessionRef` this dispatch captured** —
   even if no start was ever observed. That session is gone, so nothing from it
   can begin.

**Proof 2 matches the ref, not the agent id** (`GC10-01`). `session.ended`
carries `agentId`, `sessionRef` and `reason` (`events.ts:115`), and matching only
the agent id would accept the end of _a different session_ for the same name.
That is reachable: `removeParticipant` deletes the participant from the map at
`runtime.ts:3695` and only then awaits `service.close()` at `:3697`, so the
`session.ended` is appended after the participant is already gone — and a
re-added agent gets a new `sessionRef` under the same id. So the dispatch
captures `participant.session.sessionRef` before delivering and requires both
fields to match. The ref is stable across supervisor restarts by design
(`supervisor.ts:184`), which is what makes it the right key: a restart does not
falsely release, and a replacement does.

**Nothing else releases it.** Not a delivery rejection, not the acknowledgement
deadline, not the idle deadline, not an abort. Each of those **ends the run** and
none of them frees the agent. If the adapter ever grows an error class guaranteed
to mean _rejected before written_, that becomes a third proof; today there is
none.

**The deadlines fail the run and nothing more.**

| Deadline        | Measures                              | Value | Effect                                          |
| --------------- | ------------------------------------- | ----- | ----------------------------------------------- |
| acknowledgement | delivery to `turn.started`            | 60 s  | `failed · acknowledgement`; ownership continues |
| idle            | any event from that agent to the next | 5 min | `failed · idle`; ownership continues            |

**The idle clock is suspended while a card is open**, and **every way a card
closes counts** (`GC10-02`). An `approval.requested` is closed by
`approval.decided` **or by `approval.withdrawn`** — the agent abandoning its own
request, which `ApprovalQueue.withdraw` settles without a decision, so no
`approval.decided` ever follows (`event-store/src/events.ts:269`). A
`userinput.requested` is closed by `userinput.answered`, whatever its outcome.
Counting only decisions would leave the suspension open forever after a
withdrawal and the idle deadline would never fire again for that run — the
opposite failure from the one the suspension exists to prevent. Both deadlines
are constants in one place.

### Attribution, and what a user message costs

`GC9-03`: revision 9 accepted a user message during a drain and called the
consequence an overlap risk. It is worse than that. With the automated delivery
still pending, a user message to the same agent can produce a turn that starts
and completes, returning the depth to zero — and the monitor would read that as
its own dispatch finishing and release early. The design ignores `turnRef`
deliberately, so it has no way to tell the two apart.

**The message is still accepted, and attribution is what pays.** Nothing the
user typed is ever refused — `Composer.tsx:1007` clears the draft and the
attachments _before_ awaiting `sendMessage` and its `.catch` restores neither, so
a refusal would destroy them. Instead:

- The user message aborts the run and is delivered normally.
- **Attribution is lost**, because the coordinator is no longer the only thing
  dispatching to that agent. Ownership moves to `unattributable`.
- While `unattributable`, proof 1 is unavailable and the **only** release is a
  `session.ended` for that agent.
- `collaborate:start` and a manual `Codex reviews this` stay refused, **with the
  remedy named**: that agent has a turn this run cannot account for, and
  restarting it clears the block.

That is the same dead end the preflight already names for an unmatched
`turn.started`, reached by a second route — and it is `GC9-02`'s own resolution:
ambiguous cases are cleared by a restart, not by a guess.

### The rest of the waiter

**`store.subscribe` is global.** One listener set notified after every commit
(`store.ts:115`). **Filter `conversationId` first.**

**Acknowledgement is a transition, not a resolution.** A `turn.started` from the
target clears the acknowledgement deadline, starts the idle deadline, and moves
`result` into waiting for completion.

**Counting turns is sound only while attribution holds.** From a watermark taken
before delivery with both subscriptions opened first: `turn.started` increments,
`turn.completed` decrements, and depth returning to zero means the dispatched
turn finished — _because_ nothing else is dispatching. A `turn.started` the
coordinator did not dispatch while it still holds attribution puts the run in
`interrupted { reason: 'foreignTurn' }` and moves ownership to `unattributable`.

**`turnRef` is not read at all.** Claude's `turn.started` ref is invented in the
adapter and its own comment says no correspondence with the completion exists
(`claude-adapter.ts:251`); `turn.completed` carries
`msg.uuid ?? msg.session_id ?? ''` (`mapping.ts:1241`), which can be empty. The
only production reader of any `turnRef` is `codex-adapter.ts:351`.

**The two failure tests are asymmetric, and that is the trap.** `session.ended`
is appended with `actor: 'system'` and names its agent in `payload.agentId`
(`conversation-service.ts:652`). `error.raised` carries **no agent in its
payload** (`events.ts:379`); its agent is `event.actor`
(`conversation-service.ts:1081`). A **recoverable** `error.raised` never fails
the run: retries produce them, and `SupervisedSession` emits one on every
restart (`supervisor.ts:319`).

**A restarted session does not finish its turn.** `SupervisedSession` resumes the
provider session (`supervisor.ts:302`) but resends no input, synthesizes no
`turn.completed`, and appends no new `session.started`. So nothing is inferred
from a restart; the idle deadline is what ends such a run, and ownership persists
until a `session.ended` arrives.

**`result` carries the reply, not just a status.**

```ts
{ status: 'completed'; eventId: string; text: string }
| { status: 'failed'; reason: 'turnFailed' | 'noReply' | 'sessionEnded' | 'idle' | 'acknowledgement' | 'delivery' }
```

`interrupted` and `failed` turn statuses are failures; a turn completing with no
`agent.message.completed` is `noReply`; otherwise the **last** completed message
is the reply and its `StoredEvent.id` is what the next handoff names in
`sourceEventIds`.

**The open-turn preflight counts within the current session epoch.** A crash
leaves `turn.started` unmatched, and `reconcileOrphanedSessions` appends a
`session.ended` with `reason: 'crashed'` on the next boot (`store.ts:522`) with a
fresh `session.started` when the agent rejoins — so the preflight counts only
events **after the latest `session.started` for that agent**. That clears a
crashed epoch. It does not clear a supervisor restart, which appends no
`session.started`, and that case refuses with the restart remedy.

**Exit criteria** — `apps/desktop/src/main/collaborate.test.ts`. Against a real
store with fake participants:

- ignores another conversation's events
- refuses to start while an agent has an open turn in its current session epoch;
  starts when the only unmatched start predates that epoch; refuses with the
  restart remedy when it is inside it
- `result` resolves with the **last** of three `agent.message.completed` events
  and its id
- fails on `interrupted`, on `failed`, and on `noReply`
- fails from `payload.agentId` on `session.ended` and from `actor` on a
  **non-recoverable** `error.raised`, and **does not fail** on a recoverable one
- fires the acknowledgement deadline while `deliver` never settles, and **keeps
  ownership**
- fires the idle deadline after a start with nothing following, and **keeps
  ownership**
- **does not** fire the idle deadline while an unanswered `approval.requested`
  or `userinput.requested` is open for that agent
- **abort before `turn.started`**: `result` settles, `drained` does not, and a
  later start plus completion resolves `drained`
- **abort after `turn.started`**: same, with the completion alone resolving it
- `drained` resolves on a `session.ended` with no start ever observed
- a **delivery rejection does not resolve `drained`**
- **a user message during a drain is delivered, attribution is lost, a
  subsequent user turn's completion does not resolve `drained`, and only a
  `session.ended` does**
- both orderings of delivery settlement against `turn.started`
- **`drained` does not resolve on a `session.ended` carrying a different
  `sessionRef` for the same agent, and does resolve on the captured one**
- **the idle suspension is released by `approval.withdrawn`**, so the deadline
  can still fire after an agent abandons its own approval
- **`result` is aborted and the delivery rejects afterwards**: the rejection
  stays consumed and never surfaces as an unhandled rejection

## 3. Phase 2 — The coordinator

**In memory, in main, one per conversation.**
`apps/desktop/src/main/collaborate.ts`, taking its dependencies as an interface
so it is testable without Electron, the way `aside.test.ts` already tests main.
It holds `{ runId, preset, state, ownership, controller }`, where `ownership` is
`'owned' | 'unattributable' | 'free'`.

**Four steps.**

| Step     | To     | Intent    | Then                                                      |
| -------- | ------ | --------- | --------------------------------------------------------- |
| `review` | codex  | `review`  | `ready` → `finished · agreed`; else `revise`              |
| `revise` | claude | `discuss` | `Guided` → `verify`; `One-shot` → `finished · unverified` |
| `verify` | codex  | `review`  | `report`                                                  |
| `report` | claude | `discuss` | `finished`, with the outcome `verify` produced            |

**`review` and `verify` keep `intent: 'review'`.** The framing is safe, says
nothing about implementing, and keeps the transcript card accurately labelled
_"to review"_. `discuss` is reserved for `revise` and `report`.

**`intent: 'implement'` is never used.** Its framing says _"Implement what it
describes"_ (`handoff.ts:42`), which in an explanation, research or diagnosis
room is an instruction to start editing that nobody asked for.
`runtime.planning` is not consulted, because Plan mode is not the same question
as "is this implementation work".

**The scoped instruction rides in the existing `note` field** (`handoff.ts:58`):

| Hop      | The note says, in substance                                                                      |
| -------- | ------------------------------------------------------------------------------------------------ |
| `review` | the verdict protocol, verbatim                                                                   |
| `revise` | address these objections in the work you were already doing; do not begin work they do not cover |
| `verify` | check whether the objections were addressed; the verdict protocol again                          |
| `report` | state where this ended, including anything still open                                            |

**No change to `handoff.ts`**, which is why the note carries what a fourth
framing would otherwise have to.

**`seenSeq` needs a dispatch path that does not touch it.** `sendHandoff`
assigns `target.seenSeq = store.lastSeq()` unconditionally (`runtime.ts:2806`),
so the coordinator calls an **internal** dispatch that appends and delivers
without advancing the watermark. Not reachable over IPC, and it does not save and
restore the old value — a restore is a race, and the point is never to move it. A
scalar watermark cannot say _which_ events were shown: advancing it to
`lastSeq()` marks the user's original request as seen by an agent never shown it.

**Cancellation is one mechanism, and it settles `result` only.** `Stop`, a user
message, a manual handoff and shutdown all abort the controller. The physical
turn is **never** interrupted, so no partial output is destroyed
(`events.ts:6`), and that is why the button says **Stop collaboration** — the
agent keeps working, and a label implying otherwise would be a lie the transcript
immediately contradicts.

**What the drain refuses is only the two buttons.** `collaborate:start` and a
manual `Codex reviews this`, each with the reason and, when ownership is
`unattributable`, the restart remedy. A press carries no draft, so a refusal
loses nothing.

**Both agents run under the conversation's profile, and nothing here claims
otherwise.** Codex's sandbox is derived at session start from the profile —
`readOnly` only when the profile is `read-only`, `workspaceWrite` over the
project root otherwise (`runtime.ts:3782`) — with `approvalPolicy: 'on-request'`
(`codex-adapter.ts:531`). Under `workspaceWrite` a write inside the root raises
no approval at all, so an approval-time filter cannot make a reviewer read-only.

**Plan mode binds Claude and only instructs Codex.** `setPermissionMode` is
implemented only in the Claude adapter (`claude-adapter.ts:508`); the Codex
adapter has no such method and `SupervisedSession` forwards it with optional
chaining, so `runtime.ts:3553`'s `setPermissionMode('plan')` is a silent no-op
for Codex.

**Exit criteria** — same test file. `parseVerdict` on each of its three returns,
on a `verdict:` buried in prose, and on an empty reply. The coordinator runs all
three paths end to end and appends exactly the expected `handoff.created`
sequence **with `review`, `discuss`, `review`, `discuss` in that order**, the
verdict protocol present in both `review` notes. A test proves the internal
dispatch leaves `seenSeq` unchanged while `sendHandoff` still advances it. An
abort test proves a stopped run dispatches nothing further, that the in-flight
reply still lands, and that the state is `cancelled`. A drain test proves a user
message is accepted and delivered while both buttons are refused with a reason.

## 4. Phase 3 — The surface

**One new action, under a completed Claude reply.** `Entry.tsx:1156`, beside the
three quick intents and gated on `final`: **Review with Codex**, opening a
two-item choice — `One-shot` or `Guided` — each labelled with the turns it will
cost. The existing `Codex reviews this` stays exactly as it is.

**`collaborate:start` is validated in main, not trusted.** The renderer renders
untrusted agent output, so main refuses with a reason unless: the conversation is
open; the named event exists in it; it is an `agent.message.completed`; its actor
is `claude`; both `claude` and `codex` are participants; ownership is `free` for
both agents; and neither has an open turn in its current session epoch.

### The status contract

`GC9-04`: revision 9's `revision` was monotonic **per `runId`**, so a delayed
snapshot for an old run at revision 8 could overwrite a push for a new run at
revision 1. **One conversation-wide monotonic counter instead.**

```ts
interface RunStatus {
  conversationId: string
  /** Monotonic per conversation, across runs. The only ordering key. */
  statusVersion: number
  runId: string
  state: RunState
  /** True while either agent is still owned. Sends are unaffected. */
  draining: boolean
  ownership: 'owned' | 'unattributable' | 'free'
  preset: 'oneShot' | 'guided'
  stepIndex: number
  /** Varies by preset. Guided is four turns, not three. */
  stepTotal: number
}
```

- `collaborate:state` **pushes** it on every transition, including the one where
  `draining` becomes false, so the UI can say when the buttons work again.
- `collaborate:status` is an **invoke** returning the same shape, called on
  mount, because only the active tab of each group is mounted.
- **The renderer keeps the higher `statusVersion`**, whichever run it belongs
  to. A snapshot answered after a newer push is discarded.
- **The terminal state is retained until the next run starts.**

**One status row while a run is active or draining**, with **Stop
collaboration**, and the named state when it ends: the outcome for `finished`,
the reason for `cancelled`, `interrupted` and `failed`. It lives in the
conversation column, so no `useShellOverlay` is needed.

**Whenever the state is terminal and `draining` is true, the row says it is
waiting for a safe boundary and offers Restart** — for `owned` exactly as much as
for `unattributable` (`GC10-03`). Revision 11 named the restart only for
`unattributable`, and that leaves the worse case silent: an acknowledgement
timeout with no `turn.started`, paired with a delivery rejection that proves
nothing (`rpc.ts:138`), means **neither proof in §2 can ever arrive** — no
attributable start, and no `session.ended` for the captured ref. Ownership stays
`owned` indefinitely, both buttons stay refused, and nothing on screen says what
would clear it. The condition is behavioural and the total label maps above do
not address it: the row is keyed on `terminal && draining`, not on the ownership
word.

**No new transcript cards.** Every hop already renders as a handoff card and
every reply as an ordinary message. `TRANSCRIPT_DISPOSITION` needs no entry
because no new event type exists.

**Every string in `i18n/en.json`, under a new `collaborate` block** — including
every `RunState` phase, every `failed` reason, every `cancelled` cause and the
three ownership words. Typecheck cannot see a missing translation; the deleted
`review.*` keys in `CLAUDE.md` are the precedent.

**The status row's label map is total over the union, and a test asserts it.**
This is my own tightening rather than a review finding, and it is the same
argument `TRANSCRIPT_DISPOSITION` makes for itself: a `Record<RunState['phase'],
string>` plus a `Record<FailureReason, string>` fail to compile when a phase or
reason is added, where a `switch` with a default and a lookup with a fallback
both degrade silently — and the symptom is a status row showing a raw key at
exactly the moment something went wrong. The test walks the unions and asserts a
key exists for each, because the keys are runtime strings and typecheck cannot
reach them.

**The file list, in full.**

1. `apps/desktop/src/main/collaborate.ts` — new: the two-lifetime waiter,
   ownership, the coordinator
2. `apps/desktop/src/main/collaborate.test.ts` — new: all three phases' exit
   criteria
3. `apps/desktop/src/main/runtime.ts` — session-epoch open-turn counting,
   ownership and attribution, the internal `seenSeq`-preserving dispatch, the
   abort on a user message, and the entry points
4. `apps/desktop/src/main/ipc.ts` + `apps/desktop/src/shared/ipc.ts` — three
   invoke channels and one push channel
5. `apps/desktop/src/preload/index.ts` — three invokers and one subscription
6. `apps/desktop/src/renderer/src/Entry.tsx` — the action and its two-item choice
7. `apps/desktop/src/renderer/src/Session.tsx` — the status row, the mount
   snapshot, and the `statusVersion` comparison
8. `apps/desktop/src/renderer/src/i18n/en.json` — the `collaborate` block
9. `apps/desktop/src/renderer/src/styles.css` — the status row

**`Composer.tsx` is deliberately absent**, because nothing the user types is ever
refused, so its draft-clearing order never matters here.

No package under `packages/` is touched, so **nothing here needs cherry-picking
into `mohammadtmohsen/chorus`**.

## 5. What v1 deliberately does not do

- **It does not redirect a stuck Claude, and the distinction matters more than
  revision 11 admitted.** A run starts from a _completed_ reply, so **a Claude
  hung while producing that reply produces nothing at all here** — no run exists
  yet, so there is no `failed · idle` and no status row. That is the case the
  original ask was about, and v1 does not touch it. Only a Claude turn the
  coordinator itself dispatched, during `revise` or `report`, can reach
  `failed · idle`. "Doing the wrong thing" **is** served: the user presses the
  button on the reply where it went wrong, and Codex's objections go back without
  anyone carrying them. This is the explicit deferral of the stuck-agent half of
  the first ask — §6.
- **No new event type, no migration, no projection.** The run is not durable.
- **No recovery.** A run that loses a turn, meets a foreign turn, goes idle, or
  meets a shutdown is over, with its state named.
- **No read-only guide, no capability mask, and no claim that either agent cannot
  write.** Both run under the conversation's profile.
- **Chorus creates no collaboration artifact file.** **Either agent may modify
  the workspace whenever the room's profile permits it**, Plan mode included.
- **`intent: 'implement'` is never used.**
- **No refusal of anything the user typed.** Only the two buttons are refused.
- **No release of ownership without proof.** A deadline, an abort and a delivery
  rejection all end the run and free nobody.
- **No inference from an error message's text.**
- **No composer entry for starting a run.** It would need a dispatch whose origin
  is the user, and `handoff.created.from` accepts only `codex` or `claude`
  (`events.ts:306`).
- **No objection ids, severities, evidence kinds or resolution states.**
- **No review signals, and no instrumentation.**
- **No mid-turn interrupt, and no interrupt as part of stopping.**
- **No change to any adapter, to the supervisor, to the policy engine, to
  `handoff.ts`, or to `Composer.tsx`.**
- **Not on by default.**

## 6. Deferred, with the finding that killed it

| Deferred                                     | Why                                                                                                                                                                                                                                                                                 | What it needs first                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Redirecting a stuck agent**                | A run starts from a completed reply, so a Claude hung _while producing_ it is not reported at all — no run exists to report. Only a coordinator-dispatched Claude turn can reach `failed · idle`. This was the second half of the original ask and it is the part v1 does not serve | The detection machinery cut at revision 6: review signals as triggers, and a bound that is not the idle deadline |
| A durable run                                | `GC2-03`, `GC5-03` — `needs_user` was state with no event; a unique index rolls the append back (`store.ts:167`)                                                                                                                                                                    | Event-sourced suspension and resumption                                                                          |
| Crash recovery                               | `GC3-04`, `GC5-06` — a dead turn is not a turn that did nothing                                                                                                                                                                                                                     | Per-purpose recovery semantics and a capped attempt count                                                        |
| A read-only guide                            | `GC5-01` — under `workspaceWrite` a write raises no approval                                                                                                                                                                                                                        | A second Codex session with a `readOnly` sandbox, or a per-turn sandbox switch                                   |
| Plan mode that binds Codex                   | `GC6-08` — `setPermissionMode` exists only in the Claude adapter                                                                                                                                                                                                                    | An implementation in the Codex adapter                                                                           |
| A safe read allowlist                        | `GC3-01`, `GC5-01` — `SAFE_READS` permits `sort -o`, `uniq in out`, `sed 'w out'`, `git branch <name>`                                                                                                                                                                              | Per-command argv grammars, tested as refusals                                                                    |
| Objections as data                           | `GC-06`, `GC2-05`, `GC5-04` — anchors were the wrong blocking rule and the worker had no envelope                                                                                                                                                                                   | A worker-side envelope as well as a guide-side one                                                               |
| A composer entry                             | `GC5-08` — `handoff.created.from` accepts only two agents                                                                                                                                                                                                                           | An explicit initiator on the handoff                                                                             |
| Measurement                                  | `GC2-08`, `GC5-07` — cumulative usage, no baseline, a reset seen by nothing                                                                                                                                                                                                         | A structured usage epoch, or monotonic normalisation in the supervisor                                           |
| A per-conversation operation queue           | `GC3-02` — `runtime.send` is not serialised                                                                                                                                                                                                                                         | Needed if a refused button press should wait instead                                                             |
| Exact `seenSeq` bookkeeping                  | `GC7-03` — a scalar watermark cannot say which events were shown                                                                                                                                                                                                                    | A per-agent set, or quoting every unseen event                                                                   |
| Cancelling an in-flight `turn/start`         | `GC7-02`, `GC9-02` — the RPC is written before it can be rejected (`rpc.ts:138`)                                                                                                                                                                                                    | Provider support for cancelling an accepted turn request                                                         |
| Attribution without exclusivity              | `GC9-03` — with `turnRef` unusable, only exclusivity distinguishes turns                                                                                                                                                                                                            | A correlatable turn identifier from both adapters                                                                |
| Resuming a turn lost to a supervisor restart | `GC8-02` — the supervisor resends nothing (`supervisor.ts:302`)                                                                                                                                                                                                                     | The supervisor re-delivering the interrupted input                                                               |
| Restoring a refused draft                    | `GC8-03` — `Composer.tsx:1007` clears before awaiting                                                                                                                                                                                                                               | Only needed if user sends are ever refused, which v1 avoids                                                      |

## 7. Risks

- **The second Codex turn finding nothing new.** The honest risk, and `One-shot`
  exists so the answer can be "use that". With no instrumentation, the judgement
  is made by reading.
- **`unverified` being read as success.** `One-shot` with objections ends on a
  revision Codex never saw. If the status row ever shortens it to a tick, this
  risk becomes the bug.
- **Agreement by exhaustion.** Nothing checks that Claude's revision addressed
  what Codex raised except Codex's second look, and `One-shot` has none.
- **Either agent editing the workspace.** Possible wherever the room's profile
  permits, stated rather than prevented, and visible in the transcript.
- **A conversation stuck in `unattributable`.** Sending to an agent mid-drain
  blocks new runs until that agent's session ends. The row says so and names the
  restart, but it is a dead end the user clears by hand. This is the price of
  never refusing what someone typed, and of `turnRef` being unusable.
- **The five-minute idle deadline being wrong.** Suspended while a card is open,
  which removes the case that would have fired it wrongly — but a genuinely quiet
  turn with no card could still trip it. It only ends the run; it frees nothing.
  A constant in one place.
- **A foreign turn ending a healthy run.** Strict on purpose: a run that gives up
  is recoverable by pressing the button again, and a monitor that guessed whose
  completion it saw is not.

## 8. What each revision got wrong

Kept in full, because it is the most useful part of this document.

### Revision 1

- The turn waiter was unsound in four ways (`GC-01`): global `subscribe`,
  `session.ended`'s `actor: 'system'`, a pre-existing turn satisfying the wait,
  and a `seq` watermark unable to tell two turns apart.
- "Durable and resumable" was asserted, not designed (`GC-02`).
- Skipping a user message was offered as a v1 compromise (`GC-03`).
- The read-only guide was not read-only (`GC-04`).
- The state machine was plan-centric while the entry points were not (`GC-05`).
- Anchor presence was the blocking rule, which is backwards (`GC-06`).
- The signals were named as if they detected wrongness (`GC-07`).
- The schema invited corrupt rows and the inventory omitted
  `shared/transcript-events.ts` (`GC-08`).
- The research was overstated.

### Revision 2

- **It accepted a finding that was wrong and repeated it as the most serious
  one** (`GC2-02`). `grantKey` includes `agentId` (`engine.ts:49`), so a grant
  given to the worker never reached the guide. The claim was plausible, the
  function was three lines long, and it was not opened.
- The `turnRef` invariant did not exist (`GC2-01`).
- `error.raised`'s agent was read from a payload that has none (`GC2-01`).
- Omitting every timeout made C-043's documented hang permanent (`GC2-01`).
- `needs_user` was state with no event (`GC2-03`).
- `continue` had no way to reach the worker (`GC2-04`).
- Agreement collapse was still in the parser (`GC2-05`).
- "Stop at once" and "stop at the boundary" were both written (`GC2-06`).
- The counters did not describe a coherent loop (`GC2-07`).
- The instrumentation would have overcounted several times (`GC2-08`).

### Revision 3

- `isValidatedRead` reused `SAFE_READS` and inherited three command-native writes
  (`GC3-01`).
- It claimed `runtime.send` was serialised per conversation (`GC3-02`).
- The cap rows could not terminate, and it had an undefined idle state
  (`GC3-03`).
- Recovery had events but not semantics (`GC3-04`).
- Usage could not be segmented by session events (`GC3-05`).
- `itemRef` was the wrong identifier, and semantic dedup was promised without a
  mechanism (`GC3-06`).
- Two product claims were broader than the schema (`GC3-07`).

### Revision 4

- "One evidence re-prompt per objection" escaped the cost bound it advertised.
- `Ask Codex now` outside a run had nowhere durable to wait.
- "Restored … in a `finally`" did not say restored to what.
- It left seven questions open where four were answerable by reading the source.

### Revision 5

- **The guide was still not read-only, and could not be** (`GC5-01`).
- `evidenceRequested` lived on an immutable event and became true after it was
  appended (`GC5-02`).
- The unique index was said to coalesce and would roll the append back
  (`GC5-03`).
- Rejection semantics needed a worker envelope that did not exist (`GC5-04`).
- The final report turn could edit unreviewed code (`GC5-05`).
- `3 × maxCheckpoints + 1` was not a worst case (`GC5-06`).
- The usage rule had no baseline and could not see a reset (`GC5-07`).
- `handoff.created.from` cannot describe a dispatch originating with the user
  (`GC5-08`).

### Revision 6

- The depth counter conflated concurrent turns (`GC6-01`).
- A boolean cannot cancel a pending promise (`GC6-02`).
- `intent: 'implement'` tells Claude to implement (`GC6-03`).
- The `One-shot` closing turn had no truthful sender (`GC6-04`).
- Awaiting `deliver` before the waiter made the deadline unreachable (`GC6-05`).
- The waiter had no defined result (`GC6-06`).
- Reaching the cap was treated as done (`GC6-07`).
- "In Plan mode nothing is written" was false (`GC6-08`).

### Revision 7

- The verdict contract could not answer its own outcome table (`GC7-01`).
- Ownership ended too early (`GC7-02`).
- "The coordinator leaves `seenSeq` alone" had no implementation path
  (`GC7-03`).
- Not planning is not implementing (`GC7-04`).
- Failure and terminal states were inconsistent (`GC7-05`).
- The preflight scanned the whole history, and `collaborate:state` was
  push-only.

### Revision 8

- Delivery settlement was the wrong ownership boundary in both directions
  (`GC8-01`), and acknowledgement was raced as an outcome.
- "The agent comes back and finishes the turn" was false (`GC8-02`).
- Refusing the cancelling user message would have destroyed it (`GC8-03`).
- `RunState` could not say whether sends were blocked, and a snapshot could
  overwrite a newer push.

### Revision 9

- **Abort unsubscribed the only observer** (`GC9-01`). Ownership was defined to
  end on later events while the subscription that would have seen them was torn
  down with the waiter. Two lifetimes is what that finding is worth.
- **Two release predicates were not evidence** (`GC9-02`). Five minutes of
  silence proves nothing when `userinput.requested` has no timer at all, and a
  delivery rejection proves nothing when `rpc.ts:138` writes the request before a
  timer rejects it.
- **Accepting a user message mid-drain broke turn attribution** (`GC9-03`), not
  merely risked an overlap: a user turn's completion could be read as the
  dispatch's own and release ownership early.
- **`revision` could not order two runs** (`GC9-04`), being monotonic only
  within one.

### Revision 10

- **Ownership proof matched the agent id, not the session** (`GC10-01`).
  `session.ended` carries a `sessionRef` and `removeParticipant` appends it after
  deleting the participant (`runtime.ts:3695`, `:3697`), so a different session's
  end could have released ownership for the same name.
- **The idle suspension had no closer for a withdrawn approval** (`GC10-02`). An
  agent that abandons its own request produces `approval.withdrawn` and never an
  `approval.decided`, so the suspension would have stayed open and the deadline
  would never have fired again.
- **The restart remedy was named only for `unattributable`** (`GC10-03`). Every
  terminal run that is still draining needs it, because an acknowledgement
  timeout with an ambiguous delivery rejection makes both proofs unreachable and
  leaves ownership `owned` with no exit. Its text arrived truncated and was
  supplied intact a turn later; nothing was invented in the gap, and the
  temptation to treat an unread finding as optional is recorded in §8's closing
  note.

### Revision 11

- **It called itself `FINAL` while a known finding was unapplied.** That was the
  wrong use of the word: final means every finding is answered or explicitly
  declined, not that the review stopped.
- **It named Restart only for `unattributable`** (`GC10-03`), leaving the worse
  case — ownership stuck at `owned` forever — silent.
- **Its stuck-agent sentence was inaccurate in the direction that flattered the
  feature.** "A hung Claude produces `failed · idle`" is only true of a turn the
  coordinator dispatched; a Claude hung on the original reply produces nothing,
  because no run exists yet. That is the case the original ask described, so the
  reduction was larger than the plan admitted — and it is now accepted
  explicitly rather than implied.

### And the shape of the whole exercise

**The loop was sound from revision 2 onward. Everything that kept failing was
machinery around it** — durability, recovery, a capability boundary, an evidence
protocol, a measurement — and four of those five were introduced by the planner
rather than asked for. Since the cut at revision 6 the findings have been
localized and each pass smaller: eight structural, then five, three, four, and
three. Revision 10 split one promise into two and replaced two guesses with two
proofs; revision 11 changes one lookup key and one closing condition.

**The user closed the loop here**, which is the right call and was available at
any point: the findings had stopped changing the design and started tightening
it, and the remaining risk is better discovered by running the thing than by
reading it again. Every finding across fourteen passes is now either applied or
explicitly declined with a reason, and every claim this plan makes about this
codebase was checked against the source rather than remembered.

**One habit is worth carrying out of it.** When `GC10-03`'s text went missing I
wrote that the plan was final and offered the finding back as optional — "if you
want that third finding after all". Twelve of thirteen passes had produced real,
mostly structural findings by then, so the base rate said it mattered. An unread
finding is not an optional one, and the cheapest way to read it was the shared
transcript sitting in front of both of us.

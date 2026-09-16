# The turn nobody opened

## The problem

In long turns the conversation tab, the project card and tab, the send button and
the thinking row all read idle while an agent is visibly working. The user sees it
in both builds, mostly in turns with many tool calls, and cannot say when it
starts.

Nothing here was reproduced by running anything. The diagnosis is from the source
and from `chorus.v2.db`, read only: claude first, then deepseek verifying it
independently from the same database and the CLI binary.

**The indicators are faithful; the log is wrong.** All four read turn boundaries
from the log: the pulse folds `turn.started` and `turn.completed`
(`workspace/store.ts:485-490`), the transcript folds the same pair
(`transcript.ts:699-706`), and main's unwindowed query compares each actor's last
start with its last completion (`event-store/src/store.ts:323-339`). Paging cannot
lose a turn.

**The Claude adapter opens a turn only when Chorus sends.** `send()` emits
`turn.started` when `turnOpen` is false (`claude-adapter.ts:334-343`), and every
`result` clears the flag and becomes a `turn.completed` (`claude-adapter.ts:757`,
`mapping.ts:1248-1254`). When background work settles — subagents, a background
command — the CLI runs a follow-up turn on its own, with no `send()`. Its work lands
after a completion with no new start. DeepSeek is the same class through the same
adapter.

- Conversation `01a0a35a-f330-718f-b45b-d7c67a879843`: started at seq 422855
  (09:45:00), completed at 424824 (10:12:33), work continued to 427725 (10:42:58)
  with no start. An earlier turn started once at 412042 and completed four times.
  The line just before the first extra completion reads "I'm waiting on three
  background readers".
- Across the database: 284 completions with no start since the previous one for
  claude, 2 for deepseek, 17 for codex. Of claude's 282 real-work windows, 164 keep
  working more than a minute after the completion and 79 more than five minutes.

**Codex is the same symptom by another route.** Its boundaries are the app
server's own `turn/started` and `turn/completed` (`adapter-codex/src/mapping.ts:68-79`).
All 17 orphans carry a `turnRef` different from the previous boundary: the server
completed a turn whose start it never announced.

**The DeepSeek working dot is uncoloured.** `.state-mark` has working colours for
codex and claude only (`styles.css:8259`, `8263`), and so has `.rail-session`
(`9550`, `9554`). The rail's project status already has its deepseek rules
(`8025`, `8089`), which is why only some surfaces show it.

## What was asked for, and settled before any code

- **All four indicators right**: the project card and tab, the conversation tab,
  the send button, the thinking row.
- **Background work shows as work.** While an agent waits on background tasks
  between its main reply and the follow-up, the indicators say so.
- **Codex in this plan**, as its own part.
- **The CLI's own state signal stays off.** See Rejected.
- **The send button is unchanged** while only background tasks run.
- **Restart asks first** while background tasks run, because restarting replaces
  the session and most likely ends them.
- **The DeepSeek dot, on the fly**, as its own part.
- **Micro tasks through deepseek**, each reviewed before the next. No code
  comments, no runs, no commits.

## The shape of the answer

### Part A — the DeepSeek dot

Two missing rules, one per surface, beside the existing codex and claude ones:
`.state-mark[data-state='working'][data-voice='deepseek']` and
`.rail-session[data-state='working'][data-voice='deepseek']`, each resolving to
`--voice-deepseek`.

### Part B — Claude opens the turn it started itself

**A pure predicate, exported beside `mapSdkMessage`**, answering whether an SDK
message is the model working. True for `assistant`, `stream_event`, and a `user`
message carrying a tool result with `shouldQuery !== false`. False for anything
with `isReplay === true`, and for every other type — every `system` subtype,
`result`, `rate_limit_event`.

**Keyed on the SDK message type, never on the mapped event.** This is the trap
the rule exists to avoid, and the reason lives here because the user's rule keeps
it out of the source: `task_notification` is a `system` message that maps to
`tool.completed` (`mapping.ts:574-588`), `task_started` to `tool.started`
(`508-522`), `task_progress` to `tool.progress` (`524-540`). A rule on the mapped
type would open a turn on a background notification that can arrive with no
follow-up, and nothing would ever close it.

**Why `shouldQuery` and the tool-result requirement.** `shouldQuery: false` is
documented as "appended to the transcript without triggering an assistant turn"
(`sdk.d.ts:4596-4599`). And a harness delivery can arrive as a `user` message with
`origin.kind === 'task-notification'` (`sdk.d.ts:4054`) and no follow-up, so a
bare `user` message must not open.

**Wired in `pump` after mapping, only when mapping produced rows.** If the list is
non-empty, `turnOpen` is false and the predicate holds, the adapter sets
`turnOpen` and emits `turn.started` before the mapped events. `emit` renumbers
every event (`claude-adapter.ts:973-975`), so the order is safe. The invariant it
buys: a `turn.started` is never written with nothing after it. `result` keeps
closing.

**That invariant lives in this guard, not in the predicate.** The predicate asks
only for a `tool_result` block, while `mapToolResults` also needs a `tool_use_id`
before it emits (`mapping.ts:862`). A `tool_result` with no ref satisfies the
predicate and maps to nothing, so the non-empty check is load-bearing, not
redundant.

### Part C — Codex opens the turn its server never announced

`ingest` (`codex-adapter.ts:344-353`) keeps its own `turnOpen`, set on a mapped
`turn.started` and cleared on `turn.completed`. A work notification arriving while
it is closed emits a synthesized `turn.started` first. The opener is keyed on the
notification method: `item/agentMessage/delta`, `item/reasoning/summaryTextDelta`,
`item/reasoning/textDelta`, `item/commandExecution/outputDelta`, `item/started`.

**The turn id is known.** All five carry a required `turnId`
(`generated/v2/AgentMessageDeltaNotification.ts:5` and siblings), so the synthesized
start uses it as `turnRef` and sets `currentTurnId`, and interrupt keeps working.

**A straggler from the turn that just completed must not reopen it.** One Codex
conversation in thirty has a work event after its final completion. Opening on it
would leave "working" on with nothing to close it. So `ingest` remembers the id of
the last completed turn and does not synthesize for a notification carrying it.
The ids are comparable: a mapped `turn.completed` takes its `turnRef` from the same
id space (`mapping.ts:76`, `turnIdOf` at `461`). The residual: a late event carrying
a different id still opens a synthesized turn, and the next `turn.completed`
closes it.

**A real start for an open turn is absorbed, not written.** While a turn is open,
a `turn/started` updates `currentTurnId`, so interrupt targets the live turn, and is
not emitted. A second start for an open turn changes no fold — `working` is a set
per actor — and would leave a start with no completion, which is the imbalance
`stillAnswering` counts (`runtime.ts:2761-2764`). The early return skips only that
emission: `rememberItem` and the rate-limit merge run before the mapping. The log
has no Codex start after a work event, so this should not fire in normal flow.

### Part D — background work counts as work

**The reset comes first, in the adapter.** The SDK says the task list is
per-process and consumers must reset it when the CLI restarts (`sdk.d.ts:2913`).
Nothing does today, and a reset on `session.ended` would not be enough: a restart
writes no such event (`orchestrator/src/supervisor.ts:23`). Every path builds a
new `ClaudeSession` — start, resume, both forks, and the supervisor's restart
through them (`claude-adapter.ts:1166`, `1171`, `1192`, `1212`) — so its
constructor emits `tasks.changed` with an empty list before the CLI can say
anything. It is a push, never a log row. Codex has no background tasks, so there is
nothing to reset there.

**The reset becomes the session's first event, and one test read that position.**
`interrupt.test.ts:57-58` took the first emitted event as the queued notice, so D1a
makes it look for the notice by type before D1b adds the reset. Everything else
that reads a session's events filters by type or checks order-independent
invariants, and nothing in main treats a first event as a signal.

**The reset can be dropped under backpressure.** `tasks.changed` is not in
`UNDROPPABLE` (`agent-protocol/src/events.ts:473-493`). The exposure is bounded: the
next `background_tasks_changed` replaces the list wholesale, so a dropped reset
leaves a stale list only until the next membership change.

**The tabs and the project card.** An agent with live tasks in `tasksByActor`
counts as working. The merge is a small exported pure function beside `stateOf`
(`session-row.ts:74`), tested in `session-row.test.ts` the way the repo tests its
reducers, and `useSessionRowState` and `useProjectRowState` (`hooks.ts:345-418`)
only call it. `TabState` reads the second, so the conversation tab and the project
tab follow, and so do the rows built from the same state.

**The thinking row.** When no agent is in `view.working` and one has live tasks,
the transcript shows a waiting row for that agent saying it is waiting on
background tasks. It does not list them: `ProjectPreviewCard.tsx:200-206` already
does. One new i18n key.

**Restart.** `Composer` gets a second prop meaning "background work is running",
read only by the restart gate beside `busy` (`Composer.tsx:1504`). It reaches
nothing else: not the send button, not `data-steering`, not the steer label
(`1722-1755`). Sending while only background work runs is a new turn, not a steer.

## Rejected

- **`session_state_changed` as the boundary.** The CLI emits it only when
  `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` is set, which nothing sets, and DeepSeek's
  environment strips every `CLAUDE_CODE_*` (`claude-adapter.ts:109-118`). The user
  chose to leave it off.
- **A rule on the mapped event type.** The `task_notification` trap above.
- **Resetting tasks on `session.ended`.** A restart writes none.
- **Background work through `busy`.** It gates the restart confirmation and the
  style button (`Composer.tsx:1504`, `1592`) and turns Send into Steer.
- **The task merge inside the hooks.** It would leave the new behaviour untested
  behind a hook, against the repo's pure-reducer convention.
- **A code comment recording the trap.** The user's rule; the reason is here.

## Deliberately not doing

- **Past orphan completions stay in the log.** It is append-only; this fixes turns
  from here on.
- **Nine conversations end on a `turn.started` with no completion**, mostly turns
  killed by quitting, and read as working forever. Same family, different cause —
  a `BOARD.md` candidate.
- **The `requires_action` branch at `mapping.ts:281-283` is dead** in this build,
  with the gate off. A `BOARD.md` candidate.
- **`useWorkingSessionCount`** (`hooks.ts:325`) has no reader, so it is left alone
  rather than taught about background work.

## Steps

Each step is one file, written by deepseek and reviewed against a snapshot before
the next.

| #   | File                                         | Change                                                                 |
| --- | -------------------------------------------- | ---------------------------------------------------------------------- |
| A1  | `renderer/src/styles.css`                    | the two deepseek working rules                                         |
| B1  | `adapter-claude/src/mapping.ts`              | the exported predicate                                                 |
| B2  | `adapter-claude/src/mapping.test.ts`         | its truth table                                                        |
| B3  | `adapter-claude/src/claude-adapter.ts`       | open in `pump` after mapping                                           |
| B4  | `adapter-claude/src/turn-boundaries.test.ts` | a self-started turn pairs; a notification after a result does not open |
| C1  | `adapter-codex/src/mapping.ts`               | the exported opener                                                    |
| C2  | `adapter-codex/src/codex-adapter.ts`         | `turnOpen`, synthesis, the straggler guard                             |
| C3  | the Codex adapter's tests                    | an unannounced turn pairs; a straggler does not reopen                 |
| D1a | `adapter-claude/src/interrupt.test.ts`       | find the queued notice by type, not as the first event                 |
| D1b | `adapter-claude/src/claude-adapter.ts`       | reset the task list in the session constructor                         |
| D2a | `renderer/src/workspace/session-row.ts`      | the exported merge of live tasks into `working`                        |
| D2b | `renderer/src/workspace/session-row.test.ts` | its cases                                                              |
| D2c | `renderer/src/workspace/hooks.ts`            | both row hooks call it                                                 |
| D3  | `renderer/src/i18n/en.json`                  | the waiting-on-background key                                          |
| D4  | `renderer/src/workspace/hooks.ts`            | a hook naming the agents with live tasks                               |
| D5  | `renderer/src/Session.tsx`                   | the background waiting row                                             |
| D6  | `renderer/src/Composer.tsx`                  | the restart prop and gate                                              |
| D7  | `renderer/src/Session.tsx`                   | pass it                                                                |

## Exit criteria

For the user's hand test, once built:

- A working DeepSeek shows its colour on the conversation tab, the project tab and
  the rail.
- A Claude turn that starts background subagents reads working through the
  follow-up turns until the last reply, and between them reads as waiting on
  background work in the tab, the card and the transcript.
- A long Codex turn reads working throughout.
- Restart asks first while background tasks run.
- The send button looks as it does today while only background work runs.

The tests written in B2, B4, C3 and D2b pass when the user allows a run.

## Open questions and risks

- **A blocking Stop hook and an interrupt continuation** would also resume model
  work after a `result`. Both fall into Part B's class and are cured by it; neither
  is verified without running the CLI.
- **An assistant message continuing an earlier one** after a result —
  `resumed_from_incomplete_thinking` or `aborted` (`sdk.d.ts:2862-2873`) — would
  open a turn that its own `result` closes. None exist in the data (0 of 181).
- **Whether restart really ends background tasks** is inferred, not verified.
- **Where the thinking row's background variant sits** relative to the existing
  awaiting row (`Session.tsx:1960-1963`) is settled when D5 is written.
- **The restart confirmation's wording.** It reads "{{agents}} is still working.
  Starting over ends this conversation and discards the turn in flight"
  (`en.json:115`). While only background tasks run, D6 passes the waiting agent's
  name so the sentence still names someone, but "the turn in flight" is loose. A
  sentence of its own would need another key and a change to `ConfirmRestart.tsx`,
  outside D6 — for the user to decide.

## As built

- **A1 — 2026-09-15.** Written by deepseek, reviewed against a snapshot: the two
  rules and nothing else. Its reply stalled mid-stream after the edit landed; the
  plan verdict and the D2 objection were recovered from the log.
- **B1–B4 — 2026-09-15.** As planned, with one addition in B3: `send()` and `pump`
  both open through one private `openTurn()`, so the emission exists once. The
  adapter already carried unrelated uncommitted work in `pump` (the `planAnswered`
  early `continue`), left untouched.
- **C1 — 2026-09-15.** As planned. Reading it found a gap C2 must close:
  `item/started` also fires for a user message, whose item maps to nothing
  (`mapping.ts` `mapItem` default arm), so C2 synthesizes only when the notification
  produced a row. The package carries unrelated uncommitted rate-limit work
  (`mergeRateLimits`, and `payload` in `ingest`), left untouched.
- **C2 — 2026-09-15.** As planned, plus the absorb rule: a real `turn/started` for
  an already-open turn updates `currentTurnId` and is not emitted. The non-empty
  guard comes from `ingest`'s existing `if (event === null) return`, which sits
  above the opener.
- **C3 — 2026-09-15.** In `conformance.test.ts` as a second top-level `describe`,
  because the only harness driving a real `CodexSession` over a fake wire lives
  there unexported. Three cases, each failing without its part of C2. Case 1 fails
  as a timeout rather than a mismatch: `collectEvents` never returns when fewer
  events arrive than it waits for (`agent-protocol/src/conformance.ts:52-59`). A
  user-message `item/started` case was dropped because it could not fail.
- **D1 split — 2026-09-15.** Deepseek stopped D1 before writing: the reset would
  become the session's first event, and `interrupt.test.ts:57-58` read the queued
  notice by position. D1a adds `firstOfType` and finds the notice by type; it
  returns at the notice rather than waiting for a further event. The harness keeps
  the stream open, so a missing notice still fails by timeout. The file's two
  "stays quiet" cases call `emitted(session.events, 0)`, which returns before
  reading, so they cannot fail as written — noted, not changed.
- **D1b — 2026-09-15.** As planned. `new ClaudeSession(` occurs once, inside
  `spawn`, so every path gets the reset. It sits above `void this.pump()`, which
  makes the empty list the first event by construction rather than by racing the
  CLI's first frame; moving it below the pump call would reintroduce that race.
- **D2a–D2c — 2026-09-15.** As planned. The pulse's `working` is typed as any
  transcript actor (`store.ts:46`), so both row hooks narrow it with
  `.filter(isAgentId)` before the merge, as `Composer.tsx:714` does. The project
  card (`QuickRail.tsx:362`), both tab strips (`TabState.tsx:29`) and the session
  rows (`SessionRow.tsx:73`) all read these two hooks. Formatting of the broken
  `withBackgroundWork(…).join(',')` call follows repo precedent, not a run of
  `format:check`.
- **D3 — 2026-09-15.** As planned. `en.test.ts` fails only on a used key the
  catalogue lacks, so the key could land before D5, which must call it as a literal.
  Deepseek ran one JSON parse to confirm the file, against the no-run rule; it
  reported it and ran nothing after.
- **D4 — 2026-09-15.** As planned, returning a joined string like
  `useSessionActivity`. It keeps `tasksByActor`'s insertion order rather than
  sorting, so D5 sorts after splitting to keep the rows in a fixed order.
- **D5 — 2026-09-15.** As planned. The background row copies the thinking row's
  markup and renders right after `{waitingRow}` in both places the thinking row
  appears. Its condition, `view.working.length === 0 && !awaiting`, is the exact
  complement of the waiting row's, so at most one of the two ever renders and the
  background row never sits beside a thinking row. The `<article>` break follows
  the file's own precedent; the chain's indentation inside the ternary has none
  and is unverified against `format:check`.
- **D6 — 2026-09-15.** As planned, with the prop as the hook's joined string
  (`backgroundAgents: string`) because `Composer` is an unmemoised `forwardRef` and
  `Session` already has the string. Only the restart gate and the confirmation's
  names read it; the send button, Stop, steering and the style button still read
  `busy` alone. The dialog names the working agents while a turn runs and the
  waiting agents otherwise, and opens only in those two cases.
- **D7 — 2026-09-15.** As planned: `Session.tsx` passes `backgroundAgents` to its
  one `<Composer>`. All seventeen steps are written and each was reviewed against a
  snapshot before the next. Nothing has been run at any point — no typecheck, lint,
  `format:check`, tests, build or app.

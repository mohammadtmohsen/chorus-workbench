# The name on the tab

## The problem

Every conversation created since 14 September keeps its folder name as its title.
The namer that used to rename it by topic still runs on every message, fails, and
says nothing.

Nothing was reproduced by running anything. The diagnosis is from the source, from
`chorus.v2.db`, from `~/.codex/config.toml`, and from Codex's own session files,
read only; deepseek checked the design against the adapters and the test harness.

**The timeline.** The last `conversation.renamed` event is 2026-09-14 12:38:33. No
conversation created after 11:19 that day has one, including all eight created on
the 15th.

**The namer asks the first participant, and that is now Codex.** `startNamer`
takes `[...conversation.participants.keys()][0]` (`runtime.ts:4301`), and
conversations seat agents in `AGENT_IDS` order, which starts with `codex`
(`packages/shared/src/ids.ts:30`). Before the third agent, namer sessions ran in
Claude — inferred from Claude's session files, since the namer was first committed
in `f5a9028`.

**Codex rejects every naming turn.** `startNamer` passes no model
(`runtime.ts:4311-4315`), while participants are started with
`preferredModelFor(agentId)` (`4147-4148`, `4198`, `4221`). So the namer falls back
to `~/.codex/config.toml`'s `model = "gpt-6-astra"`, and Chorus's running Codex
app-servers — started before the 0.154.0 upgrade at 13:54 on the 15th — are 0.146.0.
Every turn ends with HTTP 400, "The 'gpt-6-astra' model requires a newer version of
Codex". Thirty-one namer rollouts since 11:49 on the 14th; none has a reply.

**It fails silently.** The failure arrives as a failed turn, not a message. The
reader resolves only on `message.completed` (`4319-4325`), so `askNamer` waits out
`NAMER_TIMEOUT_MS` and returns null (`4344-4365`), and only a thrown error is ever
logged (`4283-4287`).

## What was asked for, and settled before any code

- **Claude names by default**, then DeepSeek, then Codex.
- **Fall back on failure too**, not only when an agent is unavailable: a failed or
  timed-out naming request tries the next agent.
- **Each agent uses its chosen model**, the one picked for it in Chorus.
- **A plan, then micro steps through deepseek**, each reviewed before the next. No
  code comments, no runs, no commits.

## The shape of the answer

### The order

A fixed preference, `claude`, `deepseek`, `codex`, filtered to agents present in
`this.adapters`. **Deliberately not intersected with the room's participants**: the
namer runs its own read-only session in `conversation.cwd` and is not a member of
the conversation, so a title may be named by an agent that is not in it. That is
the user's decision read literally, and it is a choice rather than an accident.

**No `health()` gate.** It spawns the CLI to read its version
(`claude-adapter.ts:1168`), a subprocess per candidate per message, and an adapter's
`precondition` is a `ClaudeAdapter` constructor option (`runtime.ts:5606`), not
something the runtime can ask for.

### The model

Each namer session starts with `model: preferredModelFor(agentId)` when that is
non-empty, exactly as `sessionOptsFor` does (`runtime.ts:4221`). This alone would
have kept Codex off `gpt-6-astra`.

### An attempt ends as soon as no title can come

An attempt has three outcomes: a title, a **failure**, or a **timeout**.

- **Title** — the first `message.completed` for that attempt.
- **Failure** — a `turn.completed` whose status is not `completed` before any
  message; the session's event stream ending; or `start()` throwing.
- **Timeout** — `NAMER_TIMEOUT_MS` with none of the above.

**The turn's status decides, not `error` events.** Claude and DeepSeek push an
`error` and then `turn.completed: failed` (`adapter-claude/src/mapping.ts:1240-1256`),
and `error_max_turns` is marked recoverable while still ending the attempt. Codex
turns both `system/error` and `system/warning` into `error` with `recoverable` from
`willRetry` or a literal `true` (`adapter-codex/src/mapping.ts:198-218`), so a Codex
`error` never means the attempt is over. `interrupted` is a status, so it falls
under "not `completed`".

**`start()` throwing is a failure of that candidate, not of the message.** A
keyless DeepSeek throws "DeepSeek needs an API key" from `start`
(`claude-adapter.ts:1200-1201`, `runtime.ts:5606`). Today that throw reaches the
queue's `.catch` and abandons the message; inside the fallback it must be caught
per candidate, or a keyless DeepSeek stops the chain before Codex.

### The fallback

Inside the existing per-conversation queue (`runtime.ts:4264`), a message tries the
candidates in order. On a failure or a timeout it closes that agent's session and
tries the next agent with the same message. A reply that arrives but that
`cleanTitle` rejects is an answer, not a failure: it ends that message's attempt
with no rename, no demotion, and the session kept, as the old code did.

**Failure demotes; a timeout does not.** An agent whose attempt failed is skipped
for the rest of that conversation, because a retry would fail the same way and cost
another session. A timed-out agent stays eligible for the next message: slow is not
broken, and the queue is off the conversation's path, so a slow attempt delays a
title and nothing else.

### One reader per session, one owner per request

`namer.resolve` is a single field today while each session has its own reader
(`runtime.ts:4317-4331`, `4354-4357`). With more than one session, a late reply
from an abandoned agent would resolve the current attempt and be taken as the new
agent's title — and `close()` does not retract events already buffered. So readers
stay one per session (`4290-4296` records why) and the pending request carries the
agent it belongs to; a reader resolves only a request it still owns.

### The namer is told the current title

`NAMER_INSTRUCTIONS` asks it to "repeat the previous title exactly" when the topic
has not changed (`runtime.ts:256`), which a fresh fallback session cannot do — it was
never told one. So each message is sent with the conversation's current title ahead
of it, for every agent, and the instructions say so. It is left out while the title
is still the room's default folder name (`runtime.ts:1869`), because "keep this
title" must not mean "keep the folder name".

### Closing

`disposeNamer` (`runtime.ts:4368-4375`, called at `3234`) closes every session the
conversation's namer holds.

## Rejected

- **Candidates from the room's participants.** It is how Codex became the namer.
- **`health()` as a gate.** A CLI spawn per candidate per message.
- **`error` events as the end of an attempt.** Codex marks its errors recoverable.
- **One shared resolver.** A late reply from an abandoned agent becomes a title.
- **Demoting on a timeout.** One slow reply would pin titles to a fallback.
- **A code comment recording any of this.** The user's rule; the reasons are here.

## Deliberately not doing

- **Logging namer failures.** Not asked for. With the fallback, one agent failing
  no longer costs the title, but a namer that fails on every agent is still silent.
- **Upgrading Codex or changing `config.toml`.** Outside Chorus; relaunching Chorus
  alone would put its Codex on 0.154.0.
- **Changing `NAMER_TIMEOUT_MS` or `renameConversation`.** `cleanTitle` changes in
  one way only (N1b): it strips an exact leading `Current title:`, because an agent
  echoing the framing line would otherwise turn it into the title, and the new
  "repeat that title exactly" instruction would then keep it.

## Steps

Each step is one file, written by deepseek and reviewed against a snapshot before
the next. `runtime.ts` carries unrelated uncommitted work, left untouched.

| #      | File                                  | Change                                                                                                                                                                       |
| ------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1     | `apps/desktop/src/main/runtime.ts`    | the order constant, and `NAMER_INSTRUCTIONS` naming the current-title line                                                                                                   |
| N1b    | `apps/desktop/src/main/runtime.ts`    | `cleanTitle` strips an exact leading `Current title:` label, and nothing else                                                                                                |
| N2     | `apps/desktop/src/main/runtime.ts`    | `Namer` holds sessions per agent, the owned pending request, and the demoted set                                                                                             |
| N3     | `apps/desktop/src/main/runtime.ts`    | `startNamer` for one agent, with its chosen model and an owner-checking reader that also ends on a failed turn or a closed stream                                            |
| N4     | `apps/desktop/src/main/runtime.ts`    | `askNamer` returning title, failure or timeout for one agent                                                                                                                 |
| N5     | `apps/desktop/src/main/runtime.ts`    | `nameTopic` walks the order, catches a throwing `start`, demotes on failure, and prefixes the current title                                                                  |
| N5b    | `apps/desktop/src/main/runtime.ts`    | the catch around `startNamer` logs what it catches, as the queue's `.catch` did before                                                                                       |
| N6     | `apps/desktop/src/main/runtime.ts`    | `disposeNamer` closes every session, and `nameTopic` stops once its namer is disposed, closing a session that finished starting after that                                   |
| ~~N7~~ | —                                     | dropped: the naming tests reopen the runtime with their own fakes, as `aside.test.ts:460-471` already does, so the shared `adapters()` stays as it is                        |
| N8a    | `apps/desktop/src/main/aside.test.ts` | a naming `describe` with three fakes; Claude names first; the chosen model is passed                                                                                         |
| N8b    | `apps/desktop/src/main/aside.test.ts` | a failed turn falls back to DeepSeek; a throwing `start` falls through to Codex                                                                                              |
| N8c    | `apps/desktop/src/main/aside.test.ts` | a demoted agent is skipped next time, and the kept agent is sent the current title; the late-reply case is dropped because a closed fake's stream ends, so it could not fail |

## Exit criteria

For the user's hand test, once built:

- A new conversation gets a topic title after its first message.
- With Claude available, the title comes from a Claude session.
- The picker's model for each agent is the one its namer session starts with.

The cases in N8 pass when the user allows a run.

## Open questions and risks

- **How long a demotion lasts — settled 2026-09-15.** For the rest of the
  conversation, as the user chose. A timeout never demotes.
- **A timeout is not tested.** `NAMER_TIMEOUT_MS` is 20 s and fixed; testing it
  needs fake timers, which N8 leaves out unless the harness allows it cheaply.
- **The fake adapter cannot fail `start`.** N8 stubs `start` on the instance
  rather than changing `@chorus/orchestrator`'s `FakeAdapter`.
- **A namer outside the room.** Claude may name a conversation Claude is not in.

## As built

- **N1 — 2026-09-15.** As planned: `NAMER_ORDER` and the instruction naming the
  "Current title:" line, whose wording N5's prefix must match exactly.
- **N1b — 2026-09-15.** Added after N1's review found that an echoed label would
  become a title the new instruction then keeps. `cleanTitle` strips an anchored,
  exact `Current title:` before the quotes. A reply that is only the label becomes
  empty, and the existing guard turns that into no rename. The comment above the
  chain now undersells what is stripped and is left as it is.
- **N2 — 2026-09-15.** As planned: `NamerOutcome` and a `Namer` holding sessions
  per agent, the demoted set and an owned `pending`. The lazy-start comment moved
  with the field it describes. The interface's outer doc still names `resolve`.
- **N3 — 2026-09-15.** As planned, with ownership by **session object**, not agent
  id: a timed-out agent stays eligible and gets a fresh session under the same id,
  so an id check would let its closed session's late reply through. Only a
  non-`completed` turn settles as failed, because a successful turn's
  `turn.completed` can arrive after the next request has set `pending` on that same
  session. The catch comment's "times out on its own" is now stale.
- **N4 — 2026-09-15.** As planned: `askNamer` takes the session it asks and returns
  a `NamerOutcome`. Its deadline clears `pending` only while this request owns it,
  and a rejected `send` settles as failed through the same ownership check.
- **N5 — 2026-09-15.** As planned. The prefix is skipped while the title equals
  `folderName(cwd)`, which is the title a conversation starts with and the one a
  cleared title restores. The "No agent to ask" comment moved into the new catch
  and now contradicts the demotion beside it.
- **N5b — added 2026-09-15.** N5's catch around `startNamer` swallowed every throw,
  so a failed start — which the old code let reach the queue's logging `.catch` —
  stopped being logged. N5b restores that log line inside the catch, adding the
  agent. It is the existing behaviour kept, not new logging.
- **N6 — 2026-09-15, widened.** Writing it found that N5's loop outlived a closed
  conversation: `closeConversation` removes it from `active` (`runtime.ts:3233`)
  and then disposes the namer (`3247`), whose closed sessions end their streams,
  settle a waiting request as failed, and let the loop start the next agent's
  session for a conversation that is gone. So besides closing every session,
  `nameTopic` returns once `this.namers.get(conversationId) !== held`, checked at
  the top of each iteration and again after a start, where it closes the session
  that finished starting too late. Identity, not `active`, because a reseated id
  with a fresh namer would make `active` true again for a stale queue.
- **N7 — dropped 2026-09-15.** The nested `describe` at `aside.test.ts:460-471`
  already reopens the runtime with its own fakes, so the naming tests do the same
  and the shared `adapters()` helper is untouched.
- **N8a — 2026-09-15.** A `naming a conversation` describe reopening the runtime
  with fakes for all three agents and a conversation seating only `codex`. Namer
  sessions are recognised by "tab label" in their instructions, which only
  `startNamer` sets. Claude is asked first and its title used; the chosen model
  reaches the namer's `start`. Both fail on the old code.
- **N8b — 2026-09-15.** A failed Claude turn closes Claude's session and sends the
  same message to DeepSeek, whose title is used. With Claude's and DeepSeek's
  `start` rejecting — DeepSeek's with its real precondition text — the walk still
  reaches Codex. The start stubs replace `start` on the instance, as the file
  already replaces `fork` and `send`.
- **N8c — 2026-09-15.** After Claude fails, a second message skips Claude and goes
  to DeepSeek's kept session, starting with `Current title: Parser fix`. The
  late-reply case was dropped: a closed fake's stream ends, so a reply emitted
  after the close never reaches a reader and the case could not fail. Session
  ownership and the timeout are therefore verified by reading only.
- **Complete — 2026-09-15.** Every step written by deepseek and reviewed against a
  snapshot; the whole change read as one diff. `runtime.ts` +105 −46,
  `aside.test.ts` +104 −0. Nothing has been run: no typecheck, lint,
  `format:check`, tests, build or app. Four comments in `runtime.ts` now describe
  old behaviour and are left for the user: the `Namer` doc naming `resolve`, the
  comment above `cleanTitle`'s chain, `startNamer`'s catch comment ("times out on
  its own"), and "No agent to ask" beside the demotion.

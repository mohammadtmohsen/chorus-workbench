# Reduce dev startup load

## Status

| Unit           | Result                                                                                                                                                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Investigation  | Codex and Claude inspected live process snapshots and restoration source. Eager agent restoration is confirmed; its share of the Mac slowdown is not isolated.                                                                                                                                     |
| Design         | Claude challenged the design. Codex confirmed and accepted the routing, roster, carryover, aside and plan-mode corrections below.                                                                                                                                                                  |
| Implementation | Local implementation complete in `main/runtime.ts` and `main/index.ts`, with 18 unrun cases in `main/deferred-restore.test.ts`. Existing work preserved. See "As written" for behavior and departures.                                                                                             |
| Review         | Codex inspected actual implementation and correction diffs. Claude's final adversarial and targeted reviews found no remaining supported runtime defects. Timeout recovery and cancelled fallback creation are corrected. Codex corrected test waits to cover the supervisor's 2 s verdict window. |
| Verification   | Existing-process observations and source review only. Tests, typecheck, lint, format, build and launch NOT RUN. Performance improvement NOT VERIFIED.                                                                                                                                              |

## Problem and evidence

The user reports that running `pnpm dev` makes the Mac slow. The machine has
18 GiB RAM and approximately 25 GiB of swap in use. Both installed Chorus and
the dev app are running. A dev process snapshot showed 129 processes and around
1 GiB summed RSS. RSS is not physical footprint. Agents inherit their full MCP
configuration, so starting an agent also starts its MCP fleet.

`ChorusRuntime.reopen` starts every agent of every restored conversation before
returning the conversation. The dev profile held seven open conversations.
This is avoidable launch work. Installed Chorus and other running software also
contribute to memory pressure. No measurements isolate browser, renderer or
toolchain costs as the cause. The observed resource load is not a benchmark.

## Proposed change

When Electron runs against its development renderer URL, restore conversations,
transcripts, drafts and layout immediately, retaining their saved provider-thread
references without starting agents. Start only an addressed agent when it is
needed for a message, handoff or aside. Reuse `ensureSeated` and `startParticipant`.

Pass an explicit runtime option from `index.ts`; existing direct runtime callers
and packaged/preview launches retain eager restoration by default. Do not use
the profiling flag: that mode forbids sending messages.

Deferred metadata belongs to the conversation. Preserve saved references on every
write, including quit before first use. A successful deferred start must resume
the saved provider thread and preserve the existing resume-fallback catch-up
rules. Keep logical roster information separate from running process ownership.
The composer already passes the fixed cast, but routing, catch-up preambles and
conversation metadata must remain usable before any agent starts.

Concurrent first requests for the same deferred agent must share one startup.
Closing a conversation or quitting during that startup must cancel ownership,
close a late session and prevent reattaching it. Failed starts retain their
deferred resume metadata for a later retry, except that a runtime timeout clears
the thread reference so the next attempt starts fresh. Track these starts in the runtime's
existing startup drain and cancellation paths.

## Design review resolutions

The participants map currently owns both the logical cast and running processes.
Deferred records must preserve the cast without pretending an agent process is
running. Add a logical roster helper combining live and dormant agents. Use it
for send routing, catch-up and handoff preambles, restored session payloads and
open-conversation persistence. Retain the existing Claude-first rule for an
unaddressed first message. Keep lifecycle loops on actual live participants.

Persist dormant references and known-agent flags from the first restore write.
`runRestore` calls `rememberOpen` immediately, so preserving refs only at quit
would already be too late. A partial start must preserve the remaining agents.
Deferred resume keeps normalized references, the arriving/reopening distinction,
and the current catch-up reset when the saved reference is absent or changes.

Keep carried parent context on dormant records and apply it when each agent
starts. An aside or promotion that needs a provider session must seat its target
after validating its source and parent. Closing the room during any await must
prevent attaching a late participant or using a closed parent.

Route first-use starts and `addParticipant` through one single-flight seat path.
After startup, check room ownership again and apply the room's current plan mode
before allowing delivery. A permission-setting failure must not deliver in the
wrong mode. Dormant agents pick up current answer style through session options;
there is no separate explicit restart API to change.

Slash commands, MCP listings, grants and provider-side rename remain unavailable
for an agent until it starts. Interrupt and stop controls continue to act on live
processes only. These are accepted first-use costs of the dev-only behavior.

## As written

- **Setting.** `ChorusRuntime.open` takes an optional fourth argument, `{ deferRestoredAgents }`, which defaults to eager. `index.ts` passes `devServerUrl !== undefined`. Only `runRestore` passes the setting into `reopen`. Reopening a closed room from history, new rooms and every existing test caller stay eager.
- **Dormant records.** Each restored room gets one `DormantAgent` per agent ID: `{ ref, known, seenSeq, carry }`.
  - `ref` is the saved thread, with an empty string normalized to none.
  - `known` records whether the saved cast already had the agent.
  - `seenSeq` is the end of the log at restore.
  - `carry` is filled by `reseedCarriedContext`.
  - The deferred branch of `reopen` makes no adapter call: no health check, no start, no resume.
- **Roster.** `roster()` returns live participants followed by dormant ones. It is used for send routing, which keeps the Claude-first rule, for the send and handoff catch-up rosters, and for the payloads of `runRestore`, `activeSessions`, `reopenConversation` (when already open) and `openConversations`. `rememberOpen` writes live agents plus dormant agents marked known, and merges dormant refs under live ones. Lifecycle and control loops still iterate live participants only.
- **Seating.** `seat()` is single-flight per room object and agent, held in a `WeakMap`, and tracked by `trackStartup`. `ensureSeated` and `addParticipant` both use it.
  - `startSeat()` passes a `stopped` check (closing, room replaced or closed, or timed out) to `startParticipant`.
  - A dormant start resumes with `known` as the reopening flag, under the existing 20 s reopen timeout. The room timeout does not cancel pending adapter or RPC work, and Codex's RPC client applies its own 120 s per-request deadline (`adapter-codex/src/rpc.ts`). What the timeout does is mark that attempt stopped. A session that arrives later is closed and never attached, and a resume refused after the attempt stopped does not start a fresh fallback. No immediate process cancellation is claimed.
  - Only the runtime's own timer expiry counts as a timeout. `startSeat` passes `withTimeout` one `Error` per attempt and compares by identity, never by provider message. On expiry it clears `ref` on the still-owned dormant record, keeping `known`, `carry` and `seenSeq`, and persists that, but only while the room is current and the app is not shutting down. The next first use then starts fresh with the full joining catch-up, matching eager restore, which drops a timed-out agent. Other failures, such as an unhealthy agent, keep the saved ref for a retry.
  - A resumed agent keeps the `seenSeq` taken at restore. An absent or changed ref resets to `seenSeq` 0 with the joining catch-up budget.
  - Carry and the room's current plan mode are applied before attachment. The plan-mode loop runs inside `startSeat` itself and repeats until the session matches the room. There is no await between its last equality check and `participants.set`, so a toggle that lands mid-start is applied and cannot fall into a gap. A failure to set the mode closes the session and fails the seat, rather than delivering in the wrong mode. The dormant record stays for a retry.
  - The room's current permission profile is applied to the new `ConversationService` (`setProfile`) in the same synchronous step as attachment. A profile switched while the agent was starting therefore governs it from its first approval.
  - Ownership is re-checked after every await, and a late session is closed. The dormant record is removed only when the participant is attached. Failed starts keep their refs for retry except for runtime timeouts, which clear the ref while retaining the record.
- **Asides and promotion.** `openAside` checks the agent is in the roster, then seats it only when forking (a recap needs no session) and re-checks the parent. `runPromotion` seats the source agent, then re-checks the parent, the aside's identity and that the aside is not still answering.
- **Departure, default path.** `ensureSeated` and `addParticipant` share the seat path in every mode. So in default runtimes too, a late-joining agent is now single-flight, cancelled by close or quit, and started with the room's plan mode. Previously plan mode was skipped for a newly seated agent. Eager restoration itself is unchanged.
- **Departure, errors.** `ensureSeated` no longer appends `error.raised` for a seat that failed because its room closed or the app is quitting.
- **Session ids.** A successful Claude resume carries the saved ref at once: `resume(sessionRef)` passes it to `spawn`, and `new ClaudeSession(resume ?? '', ...)` sets the resolved ref in its constructor. So an aside before first send forks from the saved thread. Only a fresh session, including a resume that fell back to fresh, has an empty ref until it first speaks. An aside fork from such a session is still refused with "has not started a session yet", as before.

## Scope

- `main/index.ts`: opt in only for the dev renderer.
- `main/runtime.ts`: deferred restored agents, persistence and first-use startup.
- Existing runtime test patterns or a focused new test file: write meaningful
  cases without running them.

Keep current working-tree changes. Leave browser/autofill, workbench geometry,
MCP configuration, production restoration and newly created conversations alone.

## Acceptance and checks to run later

| Criterion                                                                          | Required evidence                                                       | Current result |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------- |
| Restoring dev rooms performs no adapter health/start/resume work                   | Fake-adapter restoration case                                           | NOT VERIFIED   |
| Transcript, draft, layout and usable roster survive restoration                    | Restored metadata and send-path cases                                   | NOT VERIFIED   |
| Unaddressed first send still targets Claude and retains the collaboration preamble | Routing and catch-up cases                                              | NOT VERIFIED   |
| First addressed agent resumes its saved thread                                     | Fake-adapter send case; other agents remain dormant                     | NOT VERIFIED   |
| Failed resume retains existing fresh-session catch-up behavior                     | Resume-fallback case                                                    | NOT VERIFIED   |
| Immediate restore writes and quit before use preserve references and known agents  | Sidecar round-trip and partial-start cases                              | NOT VERIFIED   |
| Continued context and an aside before first send remain usable                     | Carryover and aside cases                                               | NOT VERIFIED   |
| Plan mode enabled before first use reaches the started session before delivery     | Permission-mode case                                                    | NOT VERIFIED   |
| Concurrent first use starts one process; close/quit cannot leak it                 | Gated-start lifecycle cases                                             | NOT VERIFIED   |
| Default and packaged restoration retain existing behavior                          | Default runtime cases; dev URL wiring inspection                        | NOT VERIFIED   |
| Dev startup has less process and memory load                                       | Observe process tree, footprint and swap deltas on an authorized launch | NOT VERIFIED   |

First use now pays agent startup latency. Idle restored rooms will not expose
provider controls until their agents start. The change cannot stop existing
installed-app agents or guarantee that all system slowness disappears.

## Delivery

Codex and Claude reviewed the local changes. The test wait helper has a 4 s
elapsed-time budget and the verdict-dependent cases have 10 s test deadlines.
Those cases remain unrun. No processes were stopped, and nothing was installed,
staged, committed or published. Executable checks remain unrun under the standing
project instruction. Restart the dev run when ready to use the changed startup
path; reduced startup load and real-site behavior remain NOT VERIFIED.

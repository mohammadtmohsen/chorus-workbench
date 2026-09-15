# Status — the third voice

## Phase 1 — one tuple, same two members · shipped, verified

`@chorus/shared` now declares `AGENT_IDS` and `ACTORS`, derives `AgentId` and
`Actor` from them, and exports `AgentIdSchema`, `ActorSchema`, `isAgentId` and
`agentRecord`. Fourteen files repointed; agent-id literals went from 119 to 49.
Four files that declared their own local `AgentId` now import the shared one, and
`Session.tsx` re-exports it so its five consumers were untouched.

**The plan said Phase 1 would write no new code and that was wrong.**
`isAgentId` and `agentRecord` are new, and they had to be: eleven per-agent
object literals name their keys directly, and `Record<AgentId, T>` is only
enforced where the object is annotated with it — most were not.

**Two categories were missed by the inventory and by the review**, and both were
found only by scanning every line mentioning either literal rather than searching
for the pair. `Actor` enums — `ipc.ts:69`, `event-store/events.ts:16` — are the
more serious: unwidened, a DeepSeek message could not be persisted to the log or
cross IPC at all. The other was eleven negated guards, `X !== 'codex' && X !== 'claude'`.

Verified: typecheck 18/18, eslint clean, 2492 tests pass, workbench manifest
current.

## Phase 2 — widen the union · shipped, verified

`deepseek` added to `AGENT_IDS`. Everything the compiler and linter raised was
fixed:

| Site                                 | Fix                                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `orchestrator/handoff.ts:86` `label` | `case 'deepseek'` → `'DeepSeek'`, prompt-facing text                                      |
| `Entry.tsx:25` `displayName`         | `case 'deepseek'` → `'DeepSeek'`                                                          |
| `Entry.tsx:51` `speakerKey`          | `case 'deepseek'` → `'actor.deepseek'`, plus the key in `en.json`                         |
| `HandoffComposer.tsx:16` `NAME`      | third entry                                                                               |
| `Settings.tsx:624` `INSTALL`         | third entry, **the same `claude` install command** — that is approach A, not an oversight |
| 3 test fixtures                      | exact-shape `toEqual` assertions that now see a third key                                 |

**The user-facing cast lists were deliberately not widened.** `ALL_AGENTS`,
`Settings.tsx`'s `AGENTS`, `DEFAULT_SETTINGS.agents`, `App.tsx:90` and
`useUsage.ts`'s `ACCOUNTS` still hold two members. There is no DeepSeek adapter
until Phase 5, so seating it would break a new conversation. They are Phase 6.

The consequence worth stating: **nothing yet produces a `deepseek` id**, so no
widened branch is reachable and the app behaves exactly as it did before. The
type is ready; the agent does not exist.

Verified: typecheck 18/18, eslint clean, 2492 tests pass.

### `pnpm check` still exits 1, and did before this work started

Four files fail `format:check` and none belongs to this plan —
`renderer/src/KeptNotes.tsx`, `the-box-that-holds-a-story-2026-09-13/plan.md`,
its `STATUS.md`, and `the-notes-you-keep-2026-09-13/plan.md`. Only the files this
change touched were formatted.

## Phase 3 — parameterise `ClaudeAdapter` · code shipped, endpoint unproven

Twenty identity sites threaded. `MapContext` carries `agentId` and `mapping.ts`'s
module constant is gone; `ClaudeSession` takes its id at construction and the ten
inline emissions read it; `ClaudeAdapterOptions` gained `id` and `env`, both
defaulting to today's behaviour exactly.

**`claude-adapter.ts:968` — `options.command ?? 'claude'` — was left alone, and
that is the point.** It names the binary, and the binary is `claude` for both
instances.

### `childEnv` and the scrub

`Options.env` replaces the child's environment rather than merging, so
`process.env` is spread first. Then `ownedEnv` clears everything this adapter
means to control — `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*` and
`CLAUDE_CODE_*` — before the injected values go on top.

The scrub is not tidiness. An inherited `ANTHROPIC_API_KEY` takes precedence over
a saved login, so without it a DeepSeek session would authenticate and bill as
the user's own Claude account. When no `env` is given the field is omitted
entirely, which is how Claude keeps behaving as before.

### `identity.test.ts`

Five tests. The first drives a `deepseek`-id adapter through `send`, `interrupt`,
an assistant message, a stream delta, a tool use and an error result, then
asserts no event carries another id — with a length-and-variety control, because
"no event said claude" is trivially true of an empty stream. Three cover the env:
ours spread underneath, an inherited credential scrubbed, and omission when no
override is given. The fifth reads the package's own source and fails on any
literal in an `agentId:` position, which is what stops the eleventh emission being
written the old way.

**Mutation-proved:** reverting one emission turns two of the five red.

Verified: typecheck 18/18, eslint clean, 2497 tests pass.

### The real run did not happen

There is no DeepSeek key on this machine — nothing in the environment, no
`~/.deepseek*` file — so **nothing here has touched the real endpoint.** Still
unproven: that the CLI accepts `deepseek-flash[1m]` as `ANTHROPIC_MODEL`, that
tool use round-trips, that `canUseTool` fires, that `context.usage` arrives, and
which of the injected env and `~/.claude/settings.json`'s `env` block wins.

That run is the gate on Phase 4 being worth building, and it needs a key.

## Phase 4 — the key · shipped, not driven

`apps/desktop/src/main/agent-secrets.ts` is a new main-only module: `safeStorage`
encryption, its own `agent-secrets.json` under userData at mode 0600, and a
closed key space — the argument is an `AgentId`, not a string. **No preload and
no workbench channel names it.** That is the whole reason it is not
`workbench-secrets.ts`, whose generic `readSecret(key)` would hand an installed
extension a provider credential by name.

### The asymmetry is the design

`settings:write` accepts `deepseekApiKey` and never echoes it; `settings:read`
and the write's own response return `deepseekKeySet`, a boolean derived at every
read from whether a key exists. Two shapes rather than one — `SettingsShape` for
what is stored, `SettingsWithSecrets` for what comes back — because folding them
together would make the write request accept `deepseekKeySet` and invite exactly
the symmetry that is wrong here.

An empty string is a real instruction: it clears a stored key. Absent leaves it
alone. Neither reaches `writeSettings`, because a credential does not belong in
`settings.json`.

### The Settings panel

A password field, always empty on open, that never fetches the stored value.
Saved on a button rather than per keystroke, unlike every other field in the
sheet — persisting a credential on every keystroke would store a dozen truncated
keys on the way to the real one. `deepseekKeySet` is read back off the answer
rather than assumed, so a profile with no OS keychain — where the store refuses
rather than falling back to plaintext — shows the failure instead of claiming a
save.

### Tests

Four in `ipc.test.ts`, asserting over the whole serialised payload rather than
the fields we thought to name: the key is not in the write's answer, not in a
later read, a cleared key reports false while a set one reports true, and a patch
that does not mention it leaves it alone. **Mutation-proved:** echoing
`deepseekApiKey` back on the response turns one red.

Verified: typecheck 18/18, eslint clean, 2501 tests pass.

**Not verified: the app has not been driven.** The panel's markup uses
`settings-key`, `settings-key-actions` and `settings-key-error`, and none of
those has a CSS rule yet — styling is Phase 6. Nobody has seen this render.

## Phase 5 — register it · shipped, not driven

`defaultAdapters()` takes `userDataPath` and registers a third entry:
`['deepseek', new ClaudeAdapter(deepseekOptions(userDataPath))]` — the same
class, the same binary, pointed elsewhere.

**Registered unconditionally, even with no key.** The map is built once at
construction and `settings:write` does not rebuild it, so an adapter registered
only when a key happened to exist at launch would be absent after the key was
first saved and stale after it was rotated. Present-but-refusing is a state the
UI already draws.

### Two new adapter options

`env` became a **function** rather than a value — called at every spawn, so an
added, rotated or removed key takes effect on the next session with no restart.
`precondition` answers why the adapter cannot run right now, or null.

`health()` asks the precondition **after** the version probe, not before, so a
missing binary still reports as a missing binary; "needs an API key" is only the
useful answer once the install is otherwise fine. `start()` refuses outright
rather than letting the session begin and the first turn meet an authentication
error naming neither cause nor fix.

`runtime.ts` never imports Electron — it takes `userDataPath` as a parameter —
so the key getter was threaded through rather than reaching for `app.getPath`.

### `deepseekEnv`, exported and pure

The nine-variable recipe is its own exported function so it can be read back in a
test with no keychain and no app behind it. Six tests in `deepseek-env.test.ts`,
including a count assertion — every other assertion reads one key and would pass
through a half-applied edit.

`agent-probe.ts` was deliberately left at two entries. A third would spawn
`claude --version` a second time and report the same string twice; DeepSeek's
availability is "installed **and** keyed", which that file cannot express.

Verified: typecheck 18/18, eslint clean, 2509 tests pass.

**Not verified: the app has not been driven, and DeepSeek is not yet
selectable.** `ALL_AGENTS` and the other reading-order lists still hold two
members — that is Phase 6, and until it lands the adapter is registered but no
conversation can seat it.

## Phase 6 — dress it · shipped, not driven

### Two lists widened, three deliberately not

`ALL_AGENTS` and `Settings.tsx`'s `AGENTS` mean "every agent Chorus can seat" and
now hold three. The other three were left at two, and each for its own reason:

- **`DEFAULT_SETTINGS.agents` and `App.tsx:90`** are what a _new_ conversation
  starts with. Seating an agent that has no key by default would put a refusing
  participant in every new room. DeepSeek is opt-in until someone adds a key.
- **`useUsage.ts`'s `ACCOUNTS`** is the plan-window surface. DeepSeek sends no
  rate-limit events, so a row there would be permanently empty — this is the
  `agents:limits` no-op showing up in the UI exactly as the plan said it would.

### The probe row, and why `health()` was not enough

Widening `ALL_AGENTS` alone would have shown DeepSeek as permanently _not
installed_: both cast surfaces — `Settings.tsx:826` and `ProjectSettings.tsx:73`
— gate on the probe list, not on `health()`. Phase 5 put availability in
`health()`, which is right for refusing a session and wrong for drawing a row.

So `AgentProbeResult.reason` gained a third value, `needsKey`, and
`probeAgents(userDataPath)` derives DeepSeek's row from Claude's answer plus
whether a key is stored. Still one spawn: a second `PROBES` entry would run
`claude --version` twice and print the same string under two names.

The ordering matters and has a test. When the CLI is missing **and** there is no
key, the row reports `missing` — a key is no use without the binary that carries
it, and asking for one first is the wrong advice. `needsKey` appears only when
the install is otherwise fine, and it keeps Claude's version string, because
saying the install is fine is the point.

### Colour and copy

`--voice-deepseek` in both schemes — `#b49ae8` dark, `#5b3a9e` light — plus the
`--deepseek` alias and `.voice--deepseek`. Violet rather than DeepSeek's brand
blue, because `--focus-ring` is already blue and the existing comment on those
tokens asks for voices that separate peripherally rather than on inspection.

`agents.needsKeyHelp` names the Settings field instead of an install command.
`INSTALL['deepseek']` is Claude's own install line, which is true: there is
nothing else to install.

The `settings-key-actions` and `settings-key-error` rules from Phase 4's panel
landed here too — no other setting can refuse to save, so no existing rule fit.

Verified: typecheck 18/18, eslint clean, 2513 tests pass.

**Not verified: the app has still not been driven.** Nobody has seen the violet
voice, the key panel, or a DeepSeek row in the cast.

## Open — does not block Phase 3

**What `collaborate` means with a third agent.** `collaborate.ts:499-500` fixes a
`WORKER` and a `GUIDE`; `runtime.ts:2916` refuses to run unless both named agents
are seated; `runtime.ts:2928` refuses a source that is not Claude. All three still
say Claude-and-Codex, and all three compile fine. Whether that stays a two-agent
feature, becomes a pick-two, or takes DeepSeek in some role is a product question
and is unanswered.

The four open questions in the plan — the workbench `readSecret` hazard, pinned
model versus picker, refusing opus-shaped names, and `health()` reporting the CLI
version twice — remain unanswered and land in Phases 4 and 5.

## Phase 7 — seat it · shipped 2026-09-14, not driven

**Phase 6 left DeepSeek registered, drawn, keyable and unreachable.** Reported
from the app: a new conversation showed `claude joined` and `codex joined` and
nothing else, in a project whose card listed all three.

### The bug was one line, and it was not in this plan's code

`conversation:start` was handed `agents` by the renderer, filled from
`DEFAULT_SETTINGS.agents` — two members. A project's own `agentIds` was read in
exactly one place, `startConversationIn`, and the `+` button does not go through
it. So **no reachable path ever seated a third agent**, and Phase 6's note that
`DEFAULT_SETTINGS.agents` was "opt-in until someone adds a key" described an
opt-in with no control behind it: the project card's toggles wrote `agentIds`,
which the start path ignored.

Two answers that disagree is the shape of the whole defect, and widening the
default would have fixed the symptom and left it.

### The cast is a fact now

`startConversation` seats every member of `AGENT_IDS`. `agents` is gone from the
IPC request, so the renderer cannot ask for less; it survives on
`StartConversationOptions` as an optional narrowing that only tests use.
`startConversationIn` no longer reads `project.agentIds`.

**A reopen seats the whole cast too**, which is what backfills a room opened
before DeepSeek existed. `entry.agents` is still read, for the one question it
can still answer: an agent the conversation already had is a relaunch and stays
silent, an agent arriving for the first time announces itself. So an old
conversation gets exactly one `deepseek joined`, and nothing on later launches.

`reopenConversation`'s "No agent from that conversation is available" refusal
went with it. A room from before an agent existed is not a room that cannot be
opened.

### Addressing an agent that could not start

The answer chosen was that the cast must never silently shrink. An agent whose
CLI is missing or whose key is unsaved fails to start and is absent from the
live map — and routing over that map made `@deepseek` unparseable as a mention,
which `parseMentions` reads as "nobody named" and delivers to whoever spoke
last. The message went to the wrong agent and nothing said so.

`send` now routes over the cast, with the **live participants first**: the
no-mention fallback takes the head of that list, so a flat `AGENT_IDS` would
send every unaddressed message to whichever agent the tuple starts with, even on
a machine where that one will not run. `ensureSeated` then starts any addressed
agent that is missing, or appends `error.raised` naming it. It retries per send
rather than at launch only, so saving a key in Settings is enough — no restart,
no new conversation.

The composer lists all three for the same reason: hiding an agent that failed is
the worst moment to hide it, because asking it is how the person finds out why.

### What was deleted, and what was kept

Nine surfaces went: the project card's toggles and the prop chain behind them
(`onToggleAgent`, `onToggleProjectAgent`, `setParticipants` across `App.tsx`,
`Workspace.tsx`, `SessionPreview.tsx`, `ProjectPreviewCard.tsx`), three IPC
channels (`conversation:addAgent`, `conversation:removeAgent`,
`project:setAgents`) with their preload entries and schemas, two runtime methods
(`removeParticipant`, `setProjectAgents`), `ProjectService.setAgents`, the
`agents` field in both settings shapes, and two `en.json` keys.

`removeParticipant` is worth naming: keeping it as a primitive would have left
one method able to produce the state nothing else expects — a room missing an
agent on purpose, indistinguishable from one whose start failed.

**Kept deliberately:** the `agent_ids` column, `Project.agentIds` on the IPC
project shape, and `ProjectRegistry.setAgents`. Dropping a column is a migration,
and nothing is served by running one to delete a value that no longer decides
anything.

### Tests

`ipc.test.ts` gained one that sends `agents` anyway and asserts the handler drops
it — removing the field from the schema is not the same as the handler ignoring
it, and only the second makes the cast un-gettable-wrong. Its three siblings lost
the `agents` they were passing.

`aside.test.ts`'s stale-session test drove `removeParticipant` + `addParticipant`
to give Claude a new session. It now appends the `session.started` event
directly, which is what the guard actually reads and what its own sibling test
already did.

**Not verified: nothing was run.** No typecheck, no tests, the app was not
driven. Phase 6's note still stands — nobody has seen the violet voice or a
DeepSeek row answer anything.

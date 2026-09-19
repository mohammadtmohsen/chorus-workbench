# A tool that is not a voice

## The problem

The user has a TypeSafe key and asked for it to be added "the same way as
DeepSeek". It cannot be. DeepSeek works because it speaks the Anthropic wire
format, so a second `ClaudeAdapter` pointed at `https://api.deepseek.com/anthropic`
produces exactly the shape `packages/adapter-claude/src/mapping.ts` already
projects onto `AgentEvent`.

TypeSafe has no such endpoint. Its documentation index — `https://docs.typesafe.ai/llms.txt`,
76 pages — carries no messages API, no chat completions, no streaming and no tool
use. It is a classification service: three question primitives (Choice, Score,
Noul) over `https://api.typesafe.ai/v1/systemone`, answered with a Bearer token.
An adapter pointed at it would fail on its first turn.

So the ask is real and its shape is different. TypeSafe is something an agent
**calls in the middle of its own work**, not something that does the work. Chorus
has no category for that today. `INSTALL` at `Settings.tsx:720` is the nearest
surface and it is `Record<AgentId, string>` — it exists to name the CLI to install
when an agent's binary is missing, and TypeSafe is not an agent and has no binary.

The feature is therefore: **Chorus holds the key, installs the skill that teaches
the agents the API, and makes both discoverable** — without TypeSafe becoming a
voice in the cast.

## What was settled before any code

- **It is not an agent.** No member in `AGENT_IDS`, no voice colour, no cast row,
  no speaker label. It never appears in a transcript as a speaker.
- **The key lives in `agent-secrets.ts`**, under a union local to that module —
  not under a widened `AgentId`. §"`SecretId`, not `AgentId`" says why.
- **Chorus runs the skill install itself.** The user's decision, 2026-09-17, taken
  over the alternative of displaying the command for them to run.
- **The key reaches agents through per-adapter `env` closures**, never through
  `process.env`. Settled on review, against the first draft. §"The key travels per
  adapter" says why, and what it costs.
- **The renderer never sees the value.** Set-or-not-set, exactly as DeepSeek.

## The shape of the answer

### `SecretId`, not `AgentId`

`agent-secrets.ts` stores `Partial<Record<AgentId, string>>` and its four exported
functions take `agentId: AgentId`. The obvious move is to add `typesafe` to
`AGENT_IDS` so the existing signature accepts it. That move is wrong, and
`packages/shared/src/ids.ts:30-40` is why:

```ts
export const AGENT_IDS = ['codex', 'claude', 'deepseek'] as const
export type AgentId = (typeof AGENT_IDS)[number]
export const ACTORS = ['user', 'system', ...AGENT_IDS] as const
export const AgentIdSchema = z.enum(AGENT_IDS)
export const ActorSchema = z.enum(ACTORS)
```

`ACTORS` spreads the tuple, both schemas are `z.enum` over it, and `agentRecord`
maps it. A `typesafe` member is immediately an `Actor` the event log will accept,
and it then owes a voice colour in both schemes, an `actor.typesafe` translation,
a `displayName` case and a row in every cast list. That is the whole of the
third-voice plan re-run for something that cannot talk.

The module's stated invariant is that its key is a **closed set rather than a
string**, and a union preserves that exactly:

```ts
type SecretId = AgentId | 'typesafe'
```

The four exported functions take `SecretId`; `SecretsFile` becomes
`Partial<Record<SecretId, string>>`; the file's doc comment is corrected to say
"an agent or a service" rather than "an `AgentId`". Nothing outside the module
changes. This is the only edit in Phase 1.

### The key travels per adapter, and `ownedEnv` has to be split first

**The first draft of this plan said one `process.env` write reaches all three
agents for free. That is true, and it is the wrong mechanism.** It was corrected
on review, before any code, and the correction is recorded here rather than
quietly swapped in.

`process.env` does not stop at the agents:

- `workbench-host.ts:1268` spawns the remote extension host with
  `env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }`. One REH serves every
  project under one `--extensions-dir` (C-063), and its extensions are
  user-installable. So the key would be readable by any extension anyone installs
  — which is precisely the hazard `agent-secrets.ts` exists to avoid, and its own
  doc comment says so about `workbench-secrets.ts`.
- `terminal.ts:299` takes `options.env ?? process.env`, and `runtime.ts:1447`
  constructs `TerminalService` without one. The global terminal therefore holds
  the **live object by reference**, so a key saved after it started is visible in
  it. `terminal.ts:21` already names a shell as the sharpest instance of C-021's
  unsolved half.

That contradicts this plan's own non-goal, "no key for the workbench terminal",
in the same document that states it. A `process.env` write fails **open**: every
future spawn site inherits the secret unless someone remembers to strip it.

So the key travels **per adapter**, which fails closed. Three instances, three
different amounts of work:

- **`deepseek`** already has an env closure — `deepseekOptions` at
  `runtime.ts:5702`. `TYPESAFE_API_KEY` joins what `deepseekEnv()` returns.
- **`claude`** has no closure, and adding one is not free. `childEnv()` at
  `claude-adapter.ts:1119-1123` returns `undefined` when nothing is injected, and
  **otherwise filters every `ownedEnv` key out of the inherited environment**. A
  closure returning only `TYPESAFE_API_KEY` would therefore strip the user's own
  `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` and `CLAUDE_CODE_*`
  from the plain Claude agent — a silent regression in the agent most people use.
- **`codex`** cannot be given an environment at all. `CodexAdapterOptions`
  (`codex-adapter.ts:101-125`) has no `env` field; only `transport.ts:19` accepts
  one. It needs `env` added to its options and threaded to the transport.

`ownedEnv` conflates two questions: **what this adapter sets**, and **what it must
clear**. DeepSeek needs both. TypeSafe needs only the first.

**The clear list cannot be defaulted, and the reason is worth getting exactly
right.** `childEnv()` spreads `injected` _last_, so a key an adapter sets already
wins over an inherited one — scrubbing the injected keys is therefore a no-op, and
a default built on it would look like a safety property while providing none. The
bug the scrub actually prevents involves a key DeepSeek **never sets**:
`deepseekEnv()` at `runtime.ts:5777` injects `ANTHROPIC_AUTH_TOKEN`, not
`ANTHROPIC_API_KEY`, and it is the inherited `ANTHROPIC_API_KEY` that takes
precedence and bills the session to the user's own Claude account. No default can
guess a key that is cleared but never written.

So `env` and its clear list travel as **one required pair** — supplying an
injector without saying what it clears must not typecheck. `deepseekOptions`
passes today's `ownedEnv`; a TypeSafe-only closure passes an explicitly empty one.
That is a decision recorded rather than an omission, which is the property an
opt-in default would have lost. Both existing instances then behave exactly as
they do now, by construction rather than by inspection.

The type forces an _answer_, not a correct one — `clear: []` compiles, and an
author injecting an Anthropic-shaped environment with an empty list has
reintroduced the billing bug in full. So the rule that decides whether a list may
be empty **moves onto the option's own doc comment**, from `childEnv()`'s at
`claude-adapter.ts:1112-1117` where it sits today. An invariant documented only at
the point that consumes it survives in one caller's memory; documented on the
option, it is in front of the next person who supplies one.

What the pair does close completely is the second-path problem. `childEnv()` at
`claude-adapter.ts:1119` is the only place a child environment is built, and it is
called once, at `:1443`. So this is a closure over the whole mechanism rather than
a guard on one site out of several.

**The closure must omit the variable when there is no key, not return `''`.** An
empty string is a _present_ environment variable, and a skill reading it would
send an empty Bearer token and get a 401 rather than recognising that no key is
configured. Invisible until someone rotates a key.

This also removes the startup read the first draft wanted. A closure is evaluated
at spawn, which is what `readAgentKey`'s own doc comment says the store is for —
"read at spawn rather than cached at startup". The first draft contradicted it;
this one does not.

### The Settings pair is already written, twice

`settings:write` accepts `typesafeApiKey` and strips it from the preferences it
persists; `settings:read` and the write's own answer carry `typesafeKeySet`, a
boolean derived at each read. The precedent is exact and should be copied line for
line:

| Concern            | DeepSeek               | TypeSafe          |
| ------------------ | ---------------------- | ----------------- |
| Write request      | `shared/ipc.ts:1738`   | `typesafeApiKey?` |
| Read schema        | `shared/ipc.ts:164`    | `typesafeKeySet`  |
| Derived on read    | `ipc.ts:200`           | same shape        |
| Written or cleared | `ipc.ts:694-697`       | same shape        |
| The field          | `Settings.tsx:334,351` | a sibling         |

The asymmetry is deliberate in both cases and the comment at `shared/ipc.ts:161`
already explains it: the write must not accept `typesafeKeySet`, because a
symmetric shape invites a caller to set it.

### Validation is a call, not a connection

There is nothing to connect to. No session, no handshake — the key is presented on
each request. So "connected" can only honestly mean "a call with this key
succeeded".

That call belongs in **main**, never the renderer, for the same reason the value
never crosses the IPC boundary. It runs when the user asks, not on every launch:
a network call on startup is a hang waiting to happen, and a stale green tick is
worse than no tick.

**There is no free way to check a key, and that is now read rather than assumed.**
`https://docs.typesafe.ai/api.md` documents exactly one endpoint — `POST
https://api.typesafe.ai/v1/systemone` — and no `GET /v1/models`. Its responses
carry a `usage` object with `input_tokens` and `output_tokens`, so **every
validation spends the user's tokens**. A third-party page claiming a models
endpoint returned 403 and appears in no official documentation; it is not built
on.

The cheapest valid body is the smallest shape the three required fields allow —
a short `state`, `model: "jev-latest"`, and one `noul` question, which needs only
`instructions`:

```json
{
  "state": "ping",
  "model": "jev-latest",
  "questions": { "ok": { "type": "noul", "instructions": "Is this text?" } }
}
```

This turns "runs when the user asks" from a preference into a requirement. A
validity check on launch, on every settings open, or on a timer would bill the
user for a green tick. **One button, pressed deliberately, and the cost said out
loud beside it.**

### The install is two commands against two targets

TypeSafe's own `agent-skill` page gives:

```
claude plugin marketplace add typesafe-ai/skills
claude plugin install typesafe@typesafe-ai        # Claude Code
npx skills add typesafe-ai/skills --skill typesafe-ai -g   # everything else
```

Three things follow, and the first is easy to miss:

- **The Claude route is two commands, not one.** The marketplace has to be added
  before the plugin resolves.
- **It reaches two agents for the price of one.** DeepSeek shares `~/.claude` by
  the third-voice plan's own decision, so a plugin installed for `claude` is
  present for `deepseek` as well. Confirmed rather than assumed: `claude plugin
install` defaults to **user scope**, not project scope.
- **Codex is a different installer entirely.** `npx skills add` needs a working
  `npx` and writes somewhere else. "Chorus installs it" is therefore two
  independent operations that can succeed and fail separately, and the UI has to
  be able to say so.

It runs from main as a spawned process, not through a PTY — there is nothing
interactive about it. It must be safe to run twice, and a failure must be visible
rather than swallowed; silently doing nothing is the failure mode that produces a
skill the agent does not have and a user who believes it does.

**Neither `claude` nor `npx` may be assumed to be on `PATH`.** A Dock launch
inherits a minimal environment from the Finder, which is the whole reason
`resolveCommand` exists — `codex-adapter.ts:106` documents it, and
`runtime.ts:5792` is the desktop side. An install that works in `pnpm dev` and
fails in the packaged app is the exact shape of bug that costs a release. The
in-repo precedent to copy is `plugins.ts`, which already pairs
`resolveCommand('claude')` with `spawnSpec` for exactly this call.

**And the install is a convenience, not the mechanism.** `settingSources` is
omitted (`packages/adapter-claude/src/index.ts:9`), so a Chorus session loads
`~/.claude` exactly as a terminal session does. A user who runs the two commands
themselves has the plugin present in `claude` and `deepseek` with **no Chorus code
at all**, and Settings will list it through `agents:plugins` without being taught
to. That reorders the work: Phase 4 makes the feature pleasant, Phase 3 makes it
function. If only one ships, it is Phase 3.

**Install state is observed, not inferred from an exit code.** A zero exit from a
plugin command is not evidence the skill is present, and this repo's standing
habit is to assert the thing itself rather than the proxy for it. Settings reports
what it can see on disk.

### Where it goes in Settings

Not in `INSTALL`. That map is `Record<AgentId, string>` and its meaning is "the
command that installs this agent's missing CLI" — a TypeSafe entry would be both a
type error and a lie.

It needs its own section, and naming that section is the act that gives Chorus the
category it lacks: a callable service that is not a voice. That section is what
makes the feature discoverable to users who never read this plan, which was the
user's actual question.

## Phases

**0. Two answers — both now settled, from documentation rather than from a run.**

**Does `claude plugin` exist? Yes.** `claude plugin marketplace add <source>` and
`claude plugin install <name>@<marketplace>` are documented shell subcommands, and
the marketplace and plugin names resolve against `typesafe-ai/skills` exactly as
written: `typesafe@typesafe-ai`. Phase 4 has a route. **`claude plugin install`
defaults to user scope**, which is what makes "installed once, present for
`deepseek` too" a fact rather than the assumption §"The install is two commands"
made of it. And the version worry that was left open is smaller than it read, because
**Chorus already depends on this subcommand and already handles its absence**.
`apps/desktop/src/main/plugins.ts` shells out to `claude plugin list --json`
through `resolveCommand('claude')` and `spawnSpec`, exposes it as `agents:plugins`
(`shared/ipc.ts:767`), and its `catch` names the exact case — "a version too old
to have the subcommand" — degrading to an empty list rather than an error. So
`claude plugin` is an existing, shipped dependency with a written fallback, not a
new risk. Phase 4 reuses that file's shape rather than inventing one, and inherits
its degradation: a machine that cannot install shows no install, not a failure.

**Does the skill read `TYPESAFE_API_KEY`? No — and that is a correction, not a
confirmation.** The raw `skills/typesafe-ai/SKILL.md` contains no occurrence of
`API_KEY`, `env`, `curl`, `headers` or `Authorization`. Its five headings —
"Build with TypeSafe", "Read the live docs", "Find the useful shape", "Design the
judgments", "Compose and verify" — describe a **design** skill that points the
agent at the live documentation. Its only credential sentence is a caution about
keeping credentials server-side.

So the skill teaches the agent _how to think in_ Choice, Score and Noul. It does
not authenticate anything, and Phase 3's premise as first written — "the skill
reads the key from the environment" — was wrong.

**Env injection survives, for the SDK's reason instead.** The Python SDK page says
to set `TYPESAFE_API_KEY` in the environment, and every constructor example takes
no arguments — `TypeSafeClient()`, `AsyncTypeSafeClient()` — so the environment is
the only documented source. An agent that reaches for `curl` reads the variable
itself. Either way the key must be _in the agent's environment_, which is what
Phase 3 builds. The mechanism is unchanged; only the reason for it is.

**1. `SecretId`.** The union local to `agent-secrets.ts`, the four signatures, the
doc comment. No behaviour change, nothing else touched.

**2. The key, end to end.** The write field, the read boolean, the Settings input.
The key can be saved, cleared and reported set — and nothing consumes it yet. This
phase is reviewable against the DeepSeek pair line by line.

**3. Reaching the agents, per adapter.** `ownedEnv` split into what an adapter
sets and what it clears, with the scrub named explicitly and `deepseekOptions`
passing today's list so nothing about the two existing instances moves. `env`
added to `CodexAdapterOptions` and threaded to `transport.ts`. The key joins all
three closures, omitted rather than emptied when absent.

**How this phase ends is the whole of it, and "a spawned agent sees it" is too
loose a claim.** The chain is Electron's environment → the adapter's `childEnv()`
→ the `claude` CLI → the CLI's Bash tool → the `python` the agent runs, and it is
that last process which reads `TYPESAFE_API_KEY`. Every hop but the last is code
this repo owns or has read. Whether the CLI passes its own environment through to
the shell it runs a tool in is **Claude Code behaviour nobody here has checked**;
if it filtered that environment, the injection would arrive at the CLI and stop
one hop short of the only consumer.

So the proof is made **from inside a tool call**: the agent runs `env` in Bash and
`TYPESAFE_API_KEY` is observed in that output. Inspecting the spawn options, or
asking the CLI about its own environment, proves the hop before the one that
matters and would read as success.

If that last hop fails, the mechanism is wrong rather than incomplete, and the
fallback is the `env` block in `~/.claude/settings.json` — which is itself
unverified, reaches only the two Claude-driven agents, and would make Chorus write
to a file the user owns. That would be a different plan, not a patch to this one.

**4. The install.** Both routes, from main, idempotent, failures surfaced. The
Settings section that houses them.

**5. Validation.** One call, main-side, only on an explicit press, with the body
above. It is billed, so the UI says so rather than presenting it as free.

## What this deliberately does not do

- **No member in `AGENT_IDS`.** TypeSafe is not a voice, and §"`SecretId`, not
  `AgentId`" is the argument.
- **No `packages/adapter-typesafe`.** There is no agent loop to own.
- **No Chorus-side client for the TypeSafe API.** The agents call it through the
  skill; Chorus holds the key and installs the skill. Wrapping the API would make
  Chorus a second caller with its own opinions about question types.
- **No entry in `INSTALL` at `Settings.tsx:720`.** Wrong type, wrong meaning.
- **No uninstall path.** Out of scope until asked.
- **No validation on launch.** Only when the user asks for it.
- **No key for the workbench terminal, and none for the REH.** A different
  environment and a different decision about who sees a secret. The per-adapter
  route is what makes that true rather than aspirational: `workbench-host.ts:1268`
  and `terminal.ts:299` both take a copy of `process.env`, so the first draft's
  mechanism would have handed the key to every installed extension and every
  shell.

## Open questions

1. **Settled while building Phase 4: no, Chorus runs only the `claude` route.**
   `npx skills add` is a network install through a package runner Chorus does not
   control, and the deciding reason is narrower than that: it has **no list
   command**, so its result could only be inferred from an exit code — the one
   thing §"The install is two commands" says not to do. The `claude` route covers
   two of the three agents because install defaults to user scope and DeepSeek
   shares `~/.claude`. Codex users install it themselves, which works with no
   Chorus code at all. Reversible if the asymmetry proves more annoying than the
   unobservable result.

   **Codex is not unsupported — only its install button is.** `codexOptions.env`
   carries `TYPESAFE_API_KEY` exactly as the other two do, so a Codex user who
   installs the skill by hand has the whole feature. Worth stating because the
   opposite conclusion is the easy one to draw from a missing button.

2. **Settled on review: not a new "Integrations" block.** Settings already draws a
   plugins fieldset — `Settings.tsx:126-178`, `settings-plugins`, listing each
   plugin's name, scope, version and whether it is switched off. An installed
   TypeSafe plugin therefore _already appears there_ with no work, which answers
   the discoverability half. What still has no home is the **key field**, since
   that fieldset is a read-only list of what the CLI reports. It belongs beside
   the DeepSeek key rather than in a block invented for one entry. Inventing a
   category was the wrong instinct: the repo had one.
3. **Key present, skill not installed — what does Settings say?** The two are
   independent and either can be true alone.
4. **Does the installed `claude` CLI have a `plugin` subcommand, and does the
   skill read `TYPESAFE_API_KEY` from the environment?** Both were open questions
   in the first draft and are now **Phase 0**, because Phases 3 and 4 are built on
   them.
5. **Settled on review: the `ownedEnv` split ships as its own commit**, and the
   reason is the sibling repo rather than reviewability. `packages/adapter-claude`
   is shared _by copy_ with `mohammadtmohsen/chorus`, and this repo's remedy for
   that drift is `git cherry-pick <sha>` — welded into a TypeSafe feature commit
   the fix cannot be taken without dragging the rest of this plan with it. The
   commit necessarily carries `deepseekOptions`'s call site in `runtime.ts` too:
   a required clear list with no caller leaves `ownedEnv` unused, which is a lint
   failure and a broken commit rather than a behaviour-preserving one.
   `identity.test.ts:125-162` already pins the three properties that prove it is a
   pure refactor.

## What is unverified

Nothing here has been run. What was unknown when this was drafted is now read out
of primary sources — the plugin docs, the skill's own `SKILL.md`, `api.md` and the
Python SDK page — which is a weaker claim than having executed anything, and the
difference is the point of this section.

**Read, not run.** The two install commands, the `typesafe@typesafe-ai` names, the
user-scope default, the single `POST /v1/systemone` endpoint, the minimal body and
the `usage` object all come from documentation.

**Still genuinely unknown.** Whether the `claude` build on _this_ machine is new
enough to have `plugin` — the docs gate some behaviour on versions, so the
subcommand existing in general does not settle it here. Whether `claude plugin
install` is idempotent. Whether `npx skills add` behaves as documented. And
whether the response shape `api.md` describes matches what the endpoint actually
returns — the repo's standing rule about guessed shapes applies to documented ones
too, once money is attached.

The per-adapter mechanism is argued from `claude-adapter.ts:1119-1123`,
`codex-adapter.ts:101-125` and `transport.ts:19`, all read.

**The last hop has since been checked, and it holds.** It was the one nobody had
verified — whether the `claude` CLI passes its environment through to the shell it
runs a Bash tool in, which is where the `python` that reads the key actually runs.
The DeepSeek agent runs with `Options.env` set, so it was asked directly: all nine
injected values arrive in its Bash tool, and `ANTHROPIC_API_KEY` is absent, which
also puts the clear half beyond argument. `STATUS.md` records the detail, including
what the result does *not* establish — it was the installed build, so the refactor
itself is still unrun, and `TYPESAFE_API_KEY`'s own arrival is inferred from
travelling an identical path rather than seen.

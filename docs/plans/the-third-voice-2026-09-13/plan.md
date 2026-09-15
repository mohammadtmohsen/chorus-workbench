# The third voice

## The problem

There are two agents and the union that says so is one line:
`packages/shared/src/ids.ts:20`, `'codex' | 'claude'`. Everything downstream was
written against that pair, and in about seventy non-test places the pair is
spelled out again rather than referred to.

DeepSeek-V4.1-Flash shipped on 2026-09-10 and the user has a key. The ask is a
third agent sitting beside Claude and Codex — same rail, same cast toggles, same
transcript — not a provider switch hidden inside the Claude one.

## What was settled before any code

- **Approach A: reuse the installed `claude` binary.** A second `ClaudeAdapter`
  instance, pointed at DeepSeek through the environment of its own child process.
- **It does not touch the user's Claude account.** `ANTHROPIC_AUTH_TOKEN` on that
  process presents the DeepSeek key; the Claude OAuth credentials are never sent
  and the Claude plan windows are never charged.
- **The key lives in the Settings UI**, encrypted with Electron `safeStorage`.
- **A separate third agent identity** — its own id, its own voice colour, its own
  row in the cast.
- **It shares `~/.claude`.** That decision stands, and §"The shared config is a
  live hazard" below records what it costs.

## Corrections to the first draft

The first draft of this plan was reviewed and was wrong in five places. Each is
corrected below; they are listed here because the repo's convention is to say so
rather than quietly rewrite.

1. **It claimed two hard-coded identity points. There are twenty**, and the
   proposed test would have caught almost none of them.
2. **It claimed the renderer cannot read the key.** With
   `workbench-secrets.ts` as the store that claim was false: any workbench
   surface can read any key by name.
3. **It claimed a "CLI unavailable" path already existed** for a missing key. It
   does not; `agent-probe.ts` probes binaries and cannot express the state.
4. **It counted 45 sites and said the typechecker would name them.** The real
   count is higher and the typechecker sees roughly a quarter of them.
5. **It listed three environment variables.** DeepSeek's own recipe sets nine,
   and says nothing about scrubbing the ones already in the environment.

## The shape of the answer

### DeepSeek speaks Anthropic, which is why there is no new adapter package

DeepSeek exposes an Anthropic-compatible endpoint at
`https://api.deepseek.com/anthropic` alongside its OpenAI ChatCompletions one,
and documents driving Claude Code against it. Claude model names are mapped on
their side: anything starting with `claude-opus` becomes `deepseek-v4-pro`,
anything else becomes `deepseek-flash`.

So the wire shape `packages/adapter-claude/src/mapping.ts` already projects onto
`AgentEvent` is the shape DeepSeek produces. A `packages/adapter-deepseek`
against the OpenAI endpoint would mean Chorus owning the agent loop itself —
tool execution, file edits, approvals — which is the thing `CLAUDE.md` says
Chorus deliberately does not do.

### Twenty identity sites, not two

`ClaudeAdapter` stamps its own name in far more places than the first draft
found:

- **Ten inline emissions** in `packages/adapter-claude/src/claude-adapter.ts` —
  lines 266, 301, 591, 637, 649, 696, 775, 809, 882, 894 — covering turns,
  approvals, questions, errors, usage and compaction. None of these goes through
  `mapping.ts`.
- **The adapter's own `id`** at `claude-adapter.ts:950`.
- **Nine reads of `const AGENT`** in `mapping.ts`, declared at line 26.

`claude-adapter.ts:968` — `options.command ?? 'claude'` — is **not** an identity
site and must stay exactly as it is. It names the binary, and the binary is
`claude` for both instances. That is the whole of approach A, and a sweep that
"fixes" it breaks the feature.

The mapping's `ctx` already carries `now` and `approvalTtlMs`, so `agentId` joins
it. The adapter holds its id as a field set from `ClaudeAdapterOptions`,
defaulting to `'claude'`, and the ten inline sites read that field.

**The test has to be exhaustive, not a sample.** `stampsAgentId` in
`packages/agent-protocol/src/conformance.ts` checks the events it is given; run
against a recorded happy path it never sees the error, compaction or usage
emissions. The check this needs is: drive the adapter under a **non-default id**
through every emission path, and assert that no event carries `'claude'`. A grep
gate belongs beside it — no string literal `'claude'` in an `agentId:` position
anywhere in the package — because the next emission added will be written the
old way by habit.

### The renderer routes by name, and it compiles either way

Two lines in `apps/desktop/src/renderer/src/Session.tsx` decide who an answer
goes to, and both are wrong for a third agent:

- **`:1664`** — `agentId: approval.agentId === 'claude' ? 'claude' : 'codex'`.
  A DeepSeek approval is answered **as Codex**: the decision reaches the wrong
  session, and DeepSeek keeps waiting.
- **`:1682`** — `view.questions.find((q) => q.agentId === 'codex' || q.agentId === 'claude')`.
  A DeepSeek question is never found, so it is never drawn and never answered.
  The agent blocks forever.

Neither fails to compile once `AgentId` is widened. This is precisely the trap
`CLAUDE.md` already records under _"A wrong name survives a re-key where a wrong
type does not"_ — the symptom is a control that quietly does nothing. Both must
be rewritten to dispatch on the actual id rather than on a two-way test.

### The key needs a main-only store, because the workbench one is readable

`apps/desktop/src/main/workbench-secrets.ts` is the right _mechanism_ and the
wrong _store_. The preload at `apps/desktop/src/preload/workbench.ts:257`
exposes `readSecret(key: string)`, and the handler at
`apps/desktop/src/main/workbench-surface.ts:1213` returns
`readWorkbenchSecret(userData, key)` for **any** key whose sender is a known
workbench surface. There is no allowlist. An installed VS Code extension asking
for `chorus.deepseek.apiKey` would be handed the plaintext key.

So the DeepSeek key gets its own main-only module, written to its own file, never
named on any renderer or workbench channel. The Settings field sends the key
down; the IPC that reads settings back answers **set or not set**, never the
value.

The generic-key handler is a standing hazard beyond this feature — it is the
reason this plan cannot use that store — but hardening it is a different change
and is raised as an open question rather than absorbed here.

### The key is read at spawn, not at startup

`defaultAdapters()` in `apps/desktop/src/main/runtime.ts` builds the adapter map
once, at construction. `settings:write` in `apps/desktop/src/main/ipc.ts:655`
writes and broadcasts and does nothing else. So an adapter registered
conditionally on a key present at boot would be absent after the key is first
saved, and stale after it is rotated or deleted, until the app restarts.

The shape that works: **register the DeepSeek adapter unconditionally**, and give
it an injected `() => string | null` that reads the stored key **at spawn**.
Rotation then takes effect on the next session with no restart, and deletion
takes effect the same way.

That also fixes the availability question. `apps/desktop/src/main/agent-probe.ts`
holds a two-element `PROBES` array and asks each binary for `--version`; a third
entry would spawn `claude --version` a second time and report the same string
twice. DeepSeek's availability is not "is a binary installed" — it is "is the
binary installed **and** is a key present", which is a state that file cannot
represent. It belongs in the adapter's own `health()`, which can say _needs a
key_ as distinct from _not installed_.

### Seventy-odd spellings, and the compiler sees a quarter of them

Counted across non-test, non-generated source:

| Shape                                                                  | Count | Compiler sees it? |
| ---------------------------------------------------------------------- | ----- | ----------------- |
| `z.enum(['codex', 'claude'])`                                          | 36    | No                |
| `'codex' \| 'claude'` unions                                           | 18    | Yes               |
| `=== 'codex' \|\| === 'claude'` predicates and ternaries               | 11    | No                |
| Bare `['codex', 'claude']` array literals, excluding the `z.enum` ones | 7     | No                |

Twenty-nine of the thirty-six `z.enum` sites are in
`apps/desktop/src/shared/ipc.ts` alone. The silent category is the dangerous one,
and `apps/desktop/src/main/runtime.ts:4207` is the specimen:

```ts
project.agentIds.filter((id): id is AgentId => id === 'codex' || id === 'claude')
```

A hand-written type predicate. It keeps compiling against a widened `AgentId` and
silently drops DeepSeek from every project's cast. **Phase 1 is therefore a
mechanical inventory, not a compile-and-fix**, and the inventory is the
deliverable that gets reviewed.

### Phase 1 cannot widen anything

The first draft had `AGENT_IDS` contain `deepseek` from the start and called that
a no-behaviour-change refactor. It is not: the tuple feeds `z.enum`, so the
moment the third member is in it, persisted settings and every IPC boundary start
accepting a value nothing downstream handles.

Split in two. **Phase 1 introduces `AGENT_IDS` with the same two members** and
repoints all seventy-odd sites at it — that really is no behaviour change, and it
is reviewable as one. **Phase 2 adds the third member**, and every exhaustive
switch that lights up is a decision to be made rather than a compile error to be
silenced.

### Nine variables, and a scrub list

DeepSeek's Claude Code recipe sets nine, not three:

```
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=<key>
ANTHROPIC_MODEL=deepseek-flash[1m]
ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-flash[1m]
ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-flash[1m]
ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-flash
CLAUDE_CODE_SUBAGENT_MODEL=deepseek-flash
CLAUDE_CODE_EFFORT_LEVEL=max
CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432
```

The three `ANTHROPIC_DEFAULT_*` pins and `CLAUDE_CODE_SUBAGENT_MODEL` are not
optional decoration. Without them a subagent or a model alias resolves through
DeepSeek's `claude-opus` mapping to `deepseek-v4-pro` and bills at V4-Pro rates.
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` is what makes the 1M context usable rather than
compacting at Claude's threshold.

**`Options.env` replaces the child's environment entirely** — the SDK's own
comment says so, and is not merged with `process.env`. So the adapter spreads
`process.env` itself, then writes the nine, then **scrubs** what would otherwise
fight them: an inherited `ANTHROPIC_API_KEY` (which takes precedence over a saved
login and would be the user's Claude key), plus any inherited `ANTHROPIC_BASE_URL`,
`ANTHROPIC_MODEL` or `CLAUDE_CODE_*` the user has set for their own shell.

Nothing is deliberately omitted from DeepSeek's nine. If any is dropped later,
this section is where the reason goes.

### The shared config is a live hazard

Sharing `~/.claude` was the user's decision and it stands. What it costs:

- `~/.claude/settings.json` carries an `env` block that Claude Code reads, and it
  is a documented place to put `ANTHROPIC_AUTH_TOKEN`. **The user's file has no
  `env` block today**, so this is latent rather than active — but the day one is
  added, it reaches both instances.
- **The user's file does carry a top-level `model` pin**, which names a Claude
  model and would reach the DeepSeek instance.
- **The precedence between a settings-file `env` block and the injected process
  env is not documented** on the gateway page. It must be established by test
  before anything depends on it, not assumed in either direction.

The mitigation is that Phase 3's first act is a real run with a deliberately
conflicting value in `~/.claude/settings.json`, to find out which wins.

### `agents:limits` is an explicit no-op for DeepSeek

DeepSeek does not send Anthropic's rate-limit events, so the limits pane has
nothing to show. Per the five-file rule in `CLAUDE.md` that gets an explicit
no-op with the reason written down, rather than being left undefined and looking
broken. `context.usage` is expected to keep working because the CLI computes it
from returned token counts — expected, not verified.

### Dressing it

`styles.css:66-67` holds `--voice-codex` and `--voice-claude`, `:461-462` the
light-scheme pair, and `.voice--codex` / `.voice--claude` start at `:1778`. A
third token needs all three, in both schemes. `i18n/en.json:364-365` gets
`"deepseek": "DeepSeek"`.

`voice--*` class names are built with template literals, so a grep for
`voice--deepseek` finds nothing and a dead-CSS sweep would delete it. Delete by
ownership, not by absence of references — the trap is already in `CLAUDE.md`.

## Phases

**1. One tuple, same two members.** `AGENT_IDS` and a derived `AgentIdSchema` in
`@chorus/shared`; all seventy-odd sites repointed. The deliverable is the
inventory, categorised as in the table above, because the compiler only names the
eighteen unions. No behaviour change, and the tuple does **not** gain a third
member here.

**2. Widen the union.** `deepseek` joins `AGENT_IDS`. Every exhaustive switch
that lights up gets a decision. The eleven silent predicates and the two
`Session.tsx` routing lines are fixed here, by name, from the Phase 1 inventory —
not by waiting for a compile error that will not come.

**3. Parameterise `ClaudeAdapter`, then prove it against the real endpoint.**
`id` and `env` join `ClaudeAdapterOptions`; the ten inline emissions and the nine
`mapping.ts` reads take it from there; `env` spreads, writes the nine, and
scrubs. The exhaustive conformance test and the grep gate land with it. **This
phase ends with one real run against DeepSeek** — including the
`~/.claude/settings.json` precedence test — before Phase 4 is worth building.

**4. The key.** A main-only secret module, its own file, never on a renderer or
workbench channel. The Settings field. The IPC that answers set-or-not-set.

**5. Register it.** A third entry in `defaultAdapters()`, registered
unconditionally, reading the key through an injected getter at spawn. `health()`
distinguishes _needs a key_ from _not installed_.

**6. Dress it.** Voice colour in both schemes, the i18n key, the cast row, and
the `INSTALL` map at `Settings.tsx:623`.

## What this deliberately does not do

- **No `packages/adapter-deepseek`.** It would mean owning the agent loop.
- **No per-conversation provider switch.** The third agent is chosen from the
  cast like the other two.
- **No limits reporting for DeepSeek.** Explicit no-op, with the reason.
- **No vision or multimodal path.** V4.1-Flash is natively multimodal, but the
  CLI's image handling has never been exercised against this endpoint and
  claiming it works would be a guessed shape.
- **No change to the permission engine.** DeepSeek runs under the same profile,
  the same `canUseTool`, and the same universal denies.
- **No second config directory.** Settled: it shares `~/.claude`.
- **No hardening of the workbench secret channel.** Named as a hazard, raised as
  an open question, not absorbed into this feature.

## Open questions

1. **The generic workbench `readSecret(key)` handler.** This plan routes around
   it. Should it also gain a reserved-prefix refusal, as defence in depth for
   every future main-side secret? It is a separate change with its own blast
   radius.
2. **Pinned model or a picker.** `settings.ts` already has a per-agent `models`
   field, so exposing one costs almost nothing — but pinning
   `deepseek-flash[1m]` and stopping is the version that cannot be set to a name
   that bills at Pro rates.
3. **Should Chorus refuse an opus-shaped model name on this adapter**, rather
   than letting a setting silently cost more?
4. **`health()` reports the CLI's version, not the provider's.** Two agents would
   show the same version string. Harmless, or confusing in the agents list?

## What is unverified

Everything about the endpoint is read out of DeepSeek's documentation, not out of
a call. Not verified: that the CLI accepts `deepseek-flash[1m]` as
`ANTHROPIC_MODEL`, that tool use round-trips through the compatible endpoint,
that `canUseTool` fires at all, that `context.usage` arrives, that streaming
deltas map cleanly onto `AgentEvent`, and which of the injected env and the
`~/.claude/settings.json` `env` block wins.

Phase 3 ends with that run. If tool use does not round-trip, the whole approach
is wrong and this plan should be abandoned rather than patched.

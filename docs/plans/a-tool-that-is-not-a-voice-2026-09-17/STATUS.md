# Status — a tool that is not a voice

All five phases are **written, reviewed, and gated.** Typecheck 18/18, eslint
clean, workbench manifest current, 2686 tests passing with 4 skipped. **Not** run:
the app, and any call to TypeSafe. So the typing is proven and the behaviour is
not, which is the distinction the rest of this file keeps making.

**The gate earned its keep once.** `SECRETS.typesafe.verify` had `busy` twice —
the button's pending label and the rate-limit status — and a duplicate key is not
an error at runtime, it is the last one silently winning. Pressing "Test the key"
would have shown "TypeSafe is rate-limiting this account right now" while the
request was in flight. Renamed to `rateLimited`; `TS1117` is what caught it.

**`format:check` fails on six files and none of them is this change's.**
`remote-workbench.ts` and its test, `workbench-surface.test.ts`,
`RemoteProjectDialog.tsx`, and two other plans. They fail on a clean tree; only
the files this change touched were formatted. The same was true when the
third-voice plan shipped, and it means `pnpm check` exits 1 for reasons that
predate this work — so `workbench:check` and `test` were run separately, since
the format step stops the chain before they would have run.

## Phase 1 — `SecretId` · written

`agent-secrets.ts` alone. `export type SecretId = AgentId | 'typesafe'`,
`SecretsFile` re-keyed, the four exported functions widened, and the parameter
renamed `agentId` → `id` because it no longer only names an agent.

Widening a parameter is permissive, so nothing else needed changing — and all
five call sites pass the literal `'deepseek'`, which is a member of both unions,
so this is safe by inspection rather than only by argument.

**The function names were left alone** — `readAgentKey` and friends now take a
service id and read as a small lie. That is `C-067` on `BOARD.md`, along with the
module's filename and `agent-secrets.json`, whose rename is the harder half
because it strands stored keys.

## Phase 2 — the key, end to end · written

`typesafeKeySet` on `SettingsWithSecrets`, `typesafeApiKey` on the
`settings:write` request, `withSecretState` deriving both, the write branch, and
seven i18n keys. The asymmetry the DeepSeek pair argues for is preserved exactly:
the write takes a key, the response never carries one.

**One deviation from the phase as written.** Rather than a second
near-identical credential component, `DeepseekKey` became `ApiKeyField`, driven
by a `SECRETS` map. A second copy would have been a second place to get
credential handling right. The i18n names are literal strings in that map rather
than built from the id, because a template-literal key is invisible to grep and
typecheck cannot see a missing translation — the `voice--deepseek` trap.

**One review fix.** The placeholder was `"ts-…"`, which asserted a key prefix
nobody has verified; `"sk-…"` beside it is DeepSeek's real one. Replaced with
non-committal wording.

## Phase 3 — reaching the agents · written

The plan's first draft wanted one `process.env` write. **That was wrong and was
corrected before any code** — §"The key travels per adapter" in the plan records
why: `workbench-host.ts:1268` hands the REH a copy of `process.env`, and one REH
serves every project with user-installable extensions.

What shipped: `ownedEnv` exported as `anthropicManagedEnv`; `ClaudeAdapterOptions.env`
became a required `{ inject, clear }` pair; `childEnv()` filters on `clear`;
`CodexAdapterOptions` gained an `env` threaded to `transport.ts`; `serviceEnv()`
in `runtime.ts` puts `TYPESAFE_API_KEY` into all three closures.

**The pair is required rather than defaulted, and the reason is specific.** A
default derived from the injected keys would have been a no-op — `childEnv`
spreads `injected` last — and could not have reached the key the billing bug is
about, because `deepseekEnv()` sets `ANTHROPIC_AUTH_TOKEN` and never
`ANTHROPIC_API_KEY`.

**Codex is asymmetric on purpose.** Its `env` has no `clear` half, because the
transport _merges_ — `{ ...process.env, ...added }` — so a `clear` could not be
honoured without making the transport replace instead of layer. The asymmetry is
in the mechanism, not only the policy.

**The exit test passed, from inside a live tool call, and it answered more than
it was asked.** The DeepSeek agent in this conversation runs with `Options.env`
actually set, so it could be asked directly. All nine `deepseekEnv()` values reach
its Bash tool exactly as injected — `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`,
the three `ANTHROPIC_DEFAULT_*` pins, `CLAUDE_CODE_SUBAGENT_MODEL`,
`CLAUDE_CODE_EFFORT_LEVEL=max`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432`, and
`ANTHROPIC_AUTH_TOKEN` present (prefix only; the value was never read). So the hop
nobody had checked — Electron → `childEnv()` → the `claude` CLI → a Bash tool →
its shell — is fact rather than reasoning.

**And `ANTHROPIC_API_KEY` was absent, which is the better half.** That is the
clear list doing its job, so the billing guard is now observed working instead of
argued. It is the DeepSeek clear list that was observed, not `clear: () => false`
— those remain different claims.

**Nothing merged a login shell**, which was the one way the result could have been
misleading. `SHLVL=1`, and `TERM_SESSION_ID`, `TERM_PROGRAM`, `LS_COLORS`,
`HISTFILE`, `ZSH_NAME` and `ZDOTDIR` all absent. `SSH_AUTH_SOCK` is a launchd
listener, which is what a GUI process gets.

**Both of the things that test left open are now closed too**, after a build
carrying this code was installed and a key saved. `TYPESAFE_API_KEY` is present in
a spawned agent's environment — 107 characters, injected into the agent's process
rather than inherited from a shell profile. So the chain is proven with the
refactored `childEnv()` and with the actual variable, not by analogy.

**It was absent in the session that had asked for it, and that is the design
working rather than a miss.** `serviceEnv` reads the key at spawn, so a session
started before the key was saved never sees it and the next one does — which is
the property `readAgentKey`'s doc comment claims, observed.

**A detail that retroactively justified a review fix.** The real key begins
`apikey`, not `ts-`. The placeholder this plan originally shipped asserted a
prefix nobody had checked, and it would have been wrong on screen.

**Still open:** `clear: () => false` leaving the user's own `ANTHROPIC_*` alone.
The three tests in `identity.test.ts` pin only the DeepSeek pairing.

## Phase 4 — the install · written

`installSkill` in `plugins.ts`, `agents:installSkill`, the button, six strings.
Two commands, both safe to re-run, and the outcome read from `listPlugins()`
rather than an exit code.

**Open question 1 settled: only the `claude` route.** Not because `npx` is
untrusted, but because `npx skills add` has no list command, so its result could
only be inferred from an exit code — the thing this phase refuses to do. **Codex
is not unsupported, only its install button is**: `codexOptions.env` carries the
key, so a Codex user who installs the skill by hand has the whole feature.

**Two review fixes.** Both commands sat in one `try` with a `for` over them, and
`execFile` rejects on a non-zero exit — so an already-added marketplace aborted
the loop and the install never ran, in exactly the case the comment called
benign. Caught per command now. And an empty error with an absent plugin now
reports `unconfirmed` rather than asserting failure, because `listPlugins`
answers `[]` on a timeout as readily as on an empty machine.

## Phase 5 — validation · written

`typesafe.ts`, `agents:checkServiceKey`, a Test-the-key button shown only when a
key is stored, and the cost stated beside it.

**The check is billed, and that shaped the design rather than decorating it.**
`api.md` documents one endpoint and no `GET /v1/models`, and responses carry
`usage`. So it runs on a press and on nothing else — no launch check, no
revalidation on open, no timer.

**Two review fixes.** The verdict paragraph was gated only on there being a
verdict, so testing a key and then removing it left "The key works." beside an
empty field; it is gated on `isSet` now, and the install outcome deliberately is
not, because that one describes the skill and outlives the key.

And the statuses are now separated by **whose problem they are**. The first
version mapped 401 and 403 to `rejected` and everything else to `unreachable`,
which meant a 422 — the body is wrong, which is a bug in Chorus — would have been
reported as an outage. `PROBE` is the one shape in this feature nobody has ever
sent, so that is the defect a first real press is most likely to find, and it
would have been hidden. 429 had the same fault and is fixed with it: `rejected`
sends you to regenerate a key, `malformed` to report a bug, `busy` to wait,
`unreachable` to look at the network.

## What would finish this

1. ~~`pnpm check`~~ — done. One defect found and fixed; the six format failures
   are pre-existing.
2. ~~The Phase 3 exit test~~ — closed. Proven for injected values generally on the
   old build, then for `TYPESAFE_API_KEY` itself on a build carrying this code.
3. ~~The install~~ — done and observed: `claude plugin list --json` reports
   `typesafe@typesafe-ai  enabled=true  scope=user`, and user scope is what makes
   DeepSeek inherit it. The key is stored: `agent-secrets.json` holds `deepseek,
   typesafe`, so Phase 2 is proven end to end.
4. ~~Test the key~~ — done, with the user's authorisation, and it answers the last
   guessed thing in the feature. `PROBE` is correct: `POST /v1/systemone` with the
   stored key returned **200** and
   `{"model":"jev-1.13.0","answers":{"ok":{"type":"noul","noul":0.72}},"usage":{"input_tokens":271,"output_tokens":20}}`.
   So `jev-latest` resolves, a `noul` question with only `instructions` is
   accepted, and `usage` really is in the response — the billed claim this phase
   was designed around is now observed rather than read.

   A free probe with an invalid key returned **401** with
   `{"detail":{"error_type":"authentication_error",…}}`, which also confirms the
   401 → `rejected` mapping. It established that **auth runs before validation**,
   so a bad key can never surface a bad body — which is exactly why the real call
   was the only way to check the shape.

5. The eight-line `clear: () => false` test in `identity.test.ts`. Code, not a
   run, and now the only thing left in this plan at all.

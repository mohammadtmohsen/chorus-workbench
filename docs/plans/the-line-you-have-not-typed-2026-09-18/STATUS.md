# Status — the line you have not typed yet

## Phase 1 — gated, and still never seen

**2026-09-18.** Seven tasks, written by deepseek and reviewed by claude after
each one, with Mohamad ruling on scope. The tasks themselves were written under
a no-testing rule; the gate was run once at the end, on Mohamad's say-so.

**What the gate actually said.** `tsc` passes across all eighteen tasks,
including `@chorus/desktop`. `eslint` passes after four fixes described below.
`vitest` passes — 2,686 tests across 142 files, including the preload assertions
this work changed. `format:check` fails, and **every remaining failure is in a
file this work never touched** — `remote-workbench.ts`, its test,
`workbench-surface.test.ts`, `RemoteProjectDialog.tsx` and four other plans' docs
are all unmodified in the working tree, so `pnpm check` was already red on `main`
for formatting reasons unrelated to completions. Because it fails at
`format:check`, the test stage never runs inside `pnpm check`; the suite above
was run separately.

**Four lint errors, and one was not a style complaint.** `no-unnecessary-condition`
flagged the post-`await` re-check of `token.isCancellationRequested` as "always
falsy". It is not: TypeScript narrows the property to `false` after the entry
guard and never invalidates that across the `await`, which is unsound, because
the token genuinely can be cancelled while the request is in flight. Deleting the
check to satisfy the linter would have reinstated stale suggestions — a correct
guard removed on a tool's say-so. It is now read through a `cancelled(token)`
helper, which defeats the narrowing and keeps both checks. The other three were
real style fixes: a `type` that should be an `interface`, a redundant type
argument, and an empty method body.

**What is still unverified, and it is the part that matters.** No network call
has been made by any of this code. Neither endpoint, neither model name and
neither response shape has met a live server. And the plan's own acceptance line
for this phase is "typing in a project's workbench produces grey text that `Tab`
accepts and `Escape` dismisses" — **nobody has seen grey text.** A green
typechecker and a green suite say the code is well-formed and that the parts with
tests behave; they say nothing about whether the provider registers in a running
workbench or whether a provider answers. That gap closes with a launch, a key,
and a person looking.

## First run — no ghost text, and what that ruled out

**2026-09-19.** Installed, relaunched, a DeepSeek key set. Nothing appeared.

**Ruled out entirely, all from disk without touching the app.** The running
binary is the new build. `completion-deepseek` is present in
`agent-secrets.json`. `completionProvider` is `'auto'` in `settings.json`. The
workbench's own `settings.json` does not disable `editor.inlineSuggest`, so it
sits at its enabled default. And **`chorus.log` contained zero completion
lines** — which rules out the entire DeepSeek API surface, because a wrong model
name or a bad endpoint would have written `completion request refused` with a
status. No request ever left main.

**The blind spot, and it is a real defect rather than a gap in the
investigation.** `entry.ts` reports a registration failure through the
workbench's `ILogService`, which does not write to `chorus.log` and is not on
disk anywhere — the string does not appear in a recursive grep of the whole user
data tree. It exists only in the editor's Output panel, "Window" channel. So a
feature that makes paid network calls could fail to register and say so only in a
place nobody reads. That is the same mistake `context.ts:96-104` records having
already made once with `.catch(() => undefined)`.

**What was added in response, and it is permanent rather than scaffolding.**
`completion-client.ts` now logs through main — `completion requested` with the
provider and prefix length, `completion answered` with the character count, and
`completion skipped` when no key matches the chosen provider. Never the content,
never the key. A feature that spends money should say when it ran.

**The decision tree for the next run.** After relaunching and typing in a project
file, read `~/Library/Application Support/@chorus/desktop/logs/chorus.log`:

| What the log says                                          | What it means                                                                                                                                                                                                                             |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `completion requested` then `completion answered chars: 0` | The call worked and the response parsed to nothing — suspect the response shape or `deepseek-flash` as a model name.                                                                                                                      |
| `completion requested` then `chars: N`                     | The pipeline works end to end and the bug is in rendering the item.                                                                                                                                                                       |
| `completion request refused` with a status                 | The API rejected it, and the status says why; 400 points at the model name.                                                                                                                                                               |
| Nothing at all                                             | The provider is never asked. Registration is then the suspect, and it needs a real IPC channel to report through, because the renderer cannot use `console` — `no-console` is an error — and its log service is not observable from disk. |

### What shipped

| #   | Task                                                          | Where                                                                              |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| T1  | The provider, registered on `ILanguageFeaturesService`        | `renderer/src/workbench/completion.ts`, wired from `entry.ts`                      |
| T2  | Prefix/suffix slicing with a bounded budget                   | the same file, as a pure function                                                  |
| T3  | Request and cancel channels                                   | `shared/workbench-ipc.ts`, `preload/workbench.ts`, `main/workbench-surface.ts`     |
| T4  | The completion credentials                                    | `main/agent-secrets.ts` — one line                                                 |
| T5  | The FIM client                                                | `main/completion-client.ts`                                                        |
| T6  | Settings, the provider preference, and the cache invalidation | `Settings.tsx`, `shared/ipc.ts`, `main/ipc.ts`, `main/settings.ts`, `i18n/en.json` |
| T7  | Snooze, and arbitration as a finding                          | `completion.ts`, and this document                                                 |

## It works — and the first measurement arrived with it

**2026-09-19, after removing the default below.** Ghost text appears in a project
file, DeepSeek answers, and `Tab` accepts it. **Phase 1's acceptance criterion is
met.** The cancel path is no longer written blind either: the log shows many
requests with no answer, which is exactly a keystroke cancelling the one in
flight.

**Eight completed round trips, measured from this machine through the real
client** — the number Phase 2 exists to take, arriving for free because the
logging added during the investigation records both ends:

```
519  733  895  907  917  941  1016  1160   (ms, request → answer)
p50 ≈ 900 ms      p90 ≈ 1100 ms
```

**That is past the cliff, and it settles the argument the research could not.**
GitHub's own acceptance data puts the collapse at roughly 400 ms; this is two to
three times that. So the feature works and is, on these numbers, slower than the
point where people stop taking the suggestions.

**And the shape of the data says streaming will not rescue it.** A 2-character
answer took 907 ms; a 111-character answer took 1016 ms. Generation length barely
moves the total, so the cost is round trip plus prefill plus queueing, not
tokens. Taking the first line of a stream would save almost nothing. That is the
Amman-leg objection from the research, confirmed rather than argued: a gateway's
published TTFT is measured at the gateway, and the segment it omits is the one
that dominates here.

**What that leaves for Phase 2**, now that it has real numbers rather than a
plan: try a smaller payload, since prefill is part of the floor; try Codestral on
the same buffers through the picker the registry already provides; and price the
local 1.5B–3B option properly, because the distribution argument that parked it
assumed the hosted path would be fast enough and these numbers say it is not.

## The cause — and it was never in Phase 1's code

**Found 2026-09-19 by deepseek, in `services.ts:761`:**

```ts
      'editor.inlineSuggest.enabled': false,
```

It sits in the `configurationDefaults` object at `:675`, under a header that
says what it was for — _"One agent product, not two competing sidebars — Phase 4
slice 4g"_ — and carried its own rationale: inline completions "would be a second
model writing into the same buffer an agent is editing". With that default in
force the editor never instantiates the completions model against any provider,
which is exactly why `requestCompletion` was never called and `chorus.log` held
zero completion lines. **Phase 1's acceptance criterion could not have passed on
any build**, so the failed install disproves nothing about the provider, the
payload, the client, the key or the endpoint.

**Why three readers missed it, stated precisely because the shape will recur.**
The check that was run was "does the workbench's `settings.json` disable
`editor.inlineSuggest`" — and the answer was truthfully no. The override is not
in `settings.json`, nor in `workbench/user-data/User/settings.json`, nor in the
server's `Machine/settings.json`; it is a TypeScript literal passed to
`initialize`. **Reading configuration from disk can never find it.** Everyone
involved read `services.ts` repeatedly — for the gallery, for `nameLong`, for the
product config — and nobody read it looking for a switch that turned the feature
off. Static reading of the code under review cannot find the thing that disables
the code under review; only running it can, which is the argument for the launch
this phase spent seven tasks deferring.

**The line was deleted rather than set to `true`**, along with its comment, so
the workbench tracks VS Code's own default instead of pinning a second opinion
and no comment is left asserting the opposite of the code. The residual half of
its rationale is real and is now an open question below: a person accepting a
suggestion in a buffer an agent is mid-edit on is a genuine conflict, narrower
than the line implied but not imaginary.

## Where the code contradicted the plan

Six, and the plan has been corrected in each case rather than left standing.
They are all real, and every one of them is smaller than the section above.

**1. The credential store the plan named was the wrong one.** The plan said the
network call belongs in main "because the key is where `readSecret` already is".
Reading `agent-secrets.ts` showed that reasoning inverted: `readSecret` reaches
the _workbench_ secret store, whose own header records that it "returns whatever
key it is asked for, to any workbench surface, with no allowlist" — an installed
extension asking by name would be handed it in plaintext. So the conclusion was
right and the reason was backwards, and the real reason is stronger: the key must
live in `agent-secrets.ts`, whose `SecretId` is a closed set no channel names.

**2. The payload's path was a specification error, caught in review.** T2's brief
asked for "the model's URI path", and `context.ts:93` records that `uri.path`
"silently fails for every virtual one" — a bug this codebase has already lived
through once. It became a project-relative path through the existing
`relativeTo`, exported rather than copied a fourth time. The scheme restriction
introduced in T1 for a different reason turned out to be what makes even that
safe, and the plan now records that it is load-bearing twice.

**3. The cancel path was written blind, and could not have been exercised.**
T3's brief demanded cancellation be wired at the same time as the request, on the
argument that a cancel added later is a cancel nobody has run. The handler was
synchronous, so the `AbortController` entry existed for zero time and the cancel
could provably never find it. Stating that plainly then surfaced the real hazard
underneath — `send` and `invoke` are separate messages with no ordering
guarantee, so a cancel can reach main before the request handler runs and be lost
— which is now closed by construction with a bounded set of cancelled ids.

**4. Arbitration has no mechanism, and that is a finding rather than a gap.** T1
deferred `yieldsToGroupIds` for want of an id to name; T7 established that no id
can exist. `groupId` arrives only through the `metadata` argument, which is gated
behind a proposed API a normally-installed extension cannot enable. So two
completers both run and Chorus does not step aside. The chain, and the separate
oddity that the gate ignores which proposal it is checking, are in the plan's
open questions.

**5. The budget is specified in tokens and implemented in characters.** The plan
argued about "~600 tokens a side"; the code is `COMPLETION_TOKENS_PER_SIDE = 600`
with `charactersPerSide` derived as `× 4`, because there is no tokenizer in the
renderer and adding one was out of scope from the start. **The figure the plan
reasoned about has never been measured** — four characters per token is an
assumption wearing a constant's name, and Phase 2 is where it stops being one.

**6. Consent shipped on by default, against the plan's recommendation.** Decided
by Mohamad on the day. The plan's own section records the argument that was not
taken, so it stays findable. The practical consequence is that the Settings note
is the only place a person learns their buffer leaves the machine, which is why
that string says so in the same breath as asking for a key.

## Two costs accepted rather than fixed

**The credential is cached in main for the process lifetime.** `readAgentKey`
does a synchronous file read plus a platform-keychain decrypt, and its own
comment says it is "read at spawn" — a rare event. The first version of T5 put it
on the keystroke path, up to three times per keystroke. Caching fixes that and
defeats the property the comment protects, so `invalidateCompletionCredential()`
is wired to the write, the clear and the preference change. **If a future change
adds a fourth way to set a key and forgets that call, the symptom is a person
adding a key and seeing nothing until they restart** — no crash, no log line,
nothing to grep.

**`withSecretState` now does four reads of the secrets file where it did two.**
Each `agentKeyIsSet` re-reads and re-parses the whole file. It runs when the
Settings sheet opens and never on the keystroke path, and fixing it means
restructuring a file another session currently has uncommitted work in.

## What Phase 2 inherits

The measurement is the only thing that turns any of this from read into observed,
and it is also the first thing that would confirm the two endpoints, the two
model names and the two response shapes against a live server rather than against
documentation. Until then, `deepseek-flash` and `codestral-latest` are strings
this code has never sent anywhere.

# The line you have not typed yet

**Date:** 2026-09-18

**Status:** not started. `STATUS.md` will be written after the first phase
ships, and will also record where the code contradicted this plan.

**Delivery branch:** `feat/inline-completions`, branched from `main`.

---

## The outcome

Chorus draws its own ghost text. You type in a project's workbench, grey text
appears ahead of the cursor, `Tab` accepts it, and any other keystroke throws it
away. It is Chorus's own feature, built on the editor that is already there,
answered by a small fill-in-the-middle model over the network.

It is not Copilot, it is not an extension, it is not a fork, and no conversation
agent is involved in it at any point.

## Why the obvious answers were rejected

Three routes were researched before this shape was chosen, and each was closed
for a reason worth keeping written down.

**GitHub Copilot cannot be installed.** The workbench's `extensionsGallery` is
Open VSX (`apps/desktop/src/renderer/src/workbench/services.ts:827`) and
Microsoft does not publish `GitHub.copilot` there. Repointing the gallery at the
Microsoft Marketplace is a licence problem before it is a product one — the
comment above that config already says so, and it is the same reason §3.1 refuses
to ship Microsoft's REH. Sideloading the VSIX fails on a second, independent
gate: Copilot compares the host editor's identity against `product.json` and
refuses activation on a non-Microsoft build. Chorus declares
`nameLong: 'Chorus Workbench'` and `urlProtocol: 'chorus'` and deliberately omits
`commit` and `quality` (`services.ts:795-841`), and `assertClientMatchesServer`
exists precisely to stop the client claiming to be something it is not. Making
Copilot work would mean undoing that.

**An extension is the wrong placement, and this repository has already ruled on
it.** `apps/desktop/src/renderer/src/workbench/context.ts:32-48` records the
decision in as many words: there is no bridge extension, that was a correction to
the plan rather than a shortcut, and an extension would be _weaker_ — it runs in
the extension host beside third-party code, it cannot reach
`window.chorusWorkbench`, and it would need an authenticated transport of its
own. Everything that argument says about editor context is true of completions.

**No agent drives it, and that is the design rather than a limitation.** A
completion is not a turn. It has no `conversationId`, no transcript entry, no
approval, no tools and no loop. A turn from `claude` or `codex` takes seconds;
ghost text is due between two keystrokes. Driving completions from a
conversation agent would also put every suggestion into the transcript and the
event log, which is wrong twice over — see _What this deliberately is not_.

## What is already in the build

This is the part that makes the feature small. None of it needs to be written.

| Piece                         | Where                                                                                     | State                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `InlineCompletionsController` | registered by `@codingame/monaco-vscode-api/services.js:54`, workbench half at `:30`      | already loaded at startup by `entry.ts`'s `initialize`                 |
| The provider registry         | `ILanguageFeaturesService.inlineCompletionsProvider` — `languageFeatures.service.d.ts:31` | reachable by `getService`, the same call `extension-scope.ts` makes    |
| The provider interface        | `languages.d.ts:723`                                                                      | hands the provider an `ITextModel`, so prefix and suffix are in memory |
| Debounce                      | `debounceDelayMs` — `languages.d.ts:768`                                                  | a registration property, not logic to write                            |
| Multi-provider arbitration    | `groupId`, `yieldsToGroupIds`, `excludesGroupIds` — `languages.d.ts:755-766`              | decides who wins if the user also installs Continue                    |
| A model picker                | `modelInfo`, `setModelId`, `providerOptions` — `languages.d.ts:769-772`                   | the registry already models a provider that exposes a model choice     |
| Snooze                        | `IInlineCompletionsService`                                                               | a user-facing "stop suggesting" the provider must honour               |
| Encrypted credentials         | `apps/desktop/src/main/agent-secrets.ts`                                                  | `safeStorage`, closed `SecretId` set, no channel names it              |

The controller has been sitting in the build since Phase 5 doing nothing, because
no provider is registered and it has nobody to ask.

## First-release decisions

These are working defaults. Changing one is a product decision, not an
implementation detail.

- **Placement:** in the renderer, registered on `ILanguageFeaturesService`
  through `getService`. Not an extension, not the REH, not `--extensions-dir`.
- **Models:** DeepSeek and Codestral both, behind the registry's own picker. The
  provider is model-agnostic from the first commit.
- **Consent:** **on by default.** Decided 2026-09-18 by Mohamad, against the
  recommendation in this plan's research. See _The decision this plan argued
  against_ below — it is recorded rather than re-argued.
- **Payload cap:** configurable, defaulting to roughly 1,200 tokens — about 600
  each side of the cursor. The default is provisional until Phase 2 measures it.
- **Context sources in the first release:** the current buffer only. Retrieval
  is Phase 3.
- **An explicit provider choice never falls back.** The setting is
  `auto | deepseek | codestral`, defaulting to `auto` so an existing
  configuration keeps its meaning. Naming one uses that one and nothing else:
  choosing Codestral with no Codestral key yields no completion rather than
  quietly reaching for DeepSeek. Code leaving for a provider the person did not
  pick is the surprise worth refusing, and it is worse than no suggestion.
- **Durability:** nothing about a completion is ever written to the event log.
- **Where the key lives:** `agent-secrets.ts`, which forces the network call
  into main. This is not a preference — see below.

## The key decides where the call happens

The research converged on "the network call belongs in main because the key is
where `readSecret` already is". Reading `agent-secrets.ts` shows that reasoning
was right about the conclusion and wrong about the reason, and the real reason is
stronger.

`workbench-secrets` is reached by `readSecret(key: string)` in the preload, and
its own header says the handler "returns whatever key it is asked for, to any
workbench surface, with no allowlist. An installed extension asking for an
agent's key by name would be handed it in plaintext." So a completion key must
**not** go there. It belongs in `agent-secrets.ts`, whose `SecretId` is a closed
set, which no channel names, and from which the renderer can learn only whether
a key is _set_, never its value.

That splits the provider across the process boundary, and the split is the
design:

- **Renderer** — the provider itself. It is handed the `ITextModel`, slices the
  prefix and suffix, enforces the cap, holds the `CancellationToken`, and returns
  the `insertText`. It never sees the key.
- **Main** — the network call. It receives a payload with no credential in it,
  attaches the key, holds one warm pooled connection per provider, and streams
  back the completion.

The `CancellationToken` stays in the renderer because a cancel that has to cross
IPC arrives after the request has left. So the IPC surface needs a cancel channel
alongside the request channel, and main must abort the in-flight fetch on it.
`SecretId` gains a member for the completion credential; reusing the `deepseek`
agent id would conflate a conversation agent's credential with a completion
service's, which is exactly the widening the `SecretId` comment already
anticipates.

## Phases

### Phase 1 — Ghost text on screen

The smallest thing that puts real grey text in the editor.

Register the provider in the renderer at workbench startup, beside the other
`entry.ts` wiring. Give it a `groupId` and have it yield to an installed
third-party completer, so a user who has Continue does not get two providers
merged into a wrong suggestion. Set `debounceDelayMs` rather than writing a
timer. Honour `IInlineCompletionsService`'s snooze.

`provideInlineCompletions` slices `model.getValueInRange` either side of
`position`, caps the payload, and sends it over a new IPC channel. Main attaches
the key from `agent-secrets.ts`, calls the FIM endpoint — `prompt` for the
prefix, `suffix` for the text after the cursor — and returns a string. The
provider wraps it as one `InlineCompletionItem` with `insertText` and the range
at the cursor. The controller paints it.

Cancellation is wired from the first commit, not added later. A provider that
cannot cancel produces a suggestion for a cursor position the user has already
left, and that reads as a bug rather than as latency.

Settings gains an API key field per provider and a model choice. The key is
write-only from the renderer's side: it can be set and its presence reported,
never read back. Strings go in `i18n/en.json`.

**Done when:** typing in a project's workbench produces grey text that `Tab`
accepts and `Escape` dismisses, with no key ever reaching the renderer.

**The two request shapes, and where they were read.** Both were taken from the
providers' own documents during T5, because inferring one from the other fails
silently rather than loudly.

- **DeepSeek** — `api-docs.deepseek.com/api/create-completion` for the request
  parameters, and `api-docs.deepseek.com/guides/fim_completion` for two things
  the reference does not state: FIM requires the base
  `https://api.deepseek.com/beta`, and its cap is 4K. `echo` may not be sent with
  `suffix`. The response is the OpenAI **text-completion** object — the generated
  string is at `choices[0].text`.
- **Mistral** — `mistralai/platform-docs-public/openapi.yaml`, operation
  `fim_completion_v1_fim_completions_post` at `POST /v1/fim/completions`. The
  response is a **chat-completion** object — the generated string is at
  `choices[0].message.content`, nested inside a `message`.

They are not two spellings of one shape. Reading `.text` from Mistral returns
`undefined`, which presents as a model that produced nothing rather than as a
bug, and is the exact failure the Adapters section of `CLAUDE.md` warns about one
level up.

### Phase 2 — The measurement, taken through the real client

The one number the model choice turns on, and it has to be taken from this
machine rather than read off a gateway's dashboard.

Every published figure found during research is measured at the provider's edge.
The quantity that matters is keystroke-to-ghost-text from Amman over a warm
pooled connection, and only the real client can measure it. GitHub's own
acceptance data shows acceptance collapsing past roughly 400 ms, so the
threshold is not arbitrary.

Instrument the provider to record p50 and p90 for each registered model, and use
the picker to switch between DeepSeek and Codestral on the same buffers. The
research flagged that DeepSeek-Coder-V2's latency "kills the flow for tab
completion" because it fronts large MoE models; this is where that is confirmed
or refuted on our own path rather than on a blog's.

The payload cap is tuned here too. Latency is not linear in prompt length —
prefill attention is O(n²), and a 4,096-token prompt inflates prefill four to six
times over a 256-token one — but the sharp spikes observed on shared endpoints
are queuing rather than compute, which is a property of hosted serving and not of
the prompt.

**Done when:** p50 and p90 exist for both models, and one of them is the
default.

### Phase 3 — Better tokens, not more of them

Repo-awareness, done the way Copilot does it rather than by sending a bigger
window.

Copilot's completion prompt is built from the prefix and suffix, other open
files, symbols matched from the language server or an AST walk, semantically
similar files, and imported module definitions — all passed through a token
window filter that trims to a length limit. The cheap half of that is reachable
in the renderer with no new infrastructure: the other open tabs, recently edited
buffers, and symbols the language server has already resolved for this file.

The cap does not move. The same ~1,200 tokens are filled with better content.

**Done when:** a completion in one file can use a symbol defined in another open
one, with no measurable change in p50.

### Phase 4 — Parked: a semantic index

Cursor's version of Phase 3 adds background indexing, AST-aware chunks of about
500 tokens, a custom embedding model, a vector database, and a hash tree so only
changed files are re-uploaded.

This is parked, with a reason rather than a shrug. A 2026 diagnostic study,
_When Retrieval Hurts Code Completion_, found retrieval-augmented completion
performing **worse than no retrieval at all** when the index goes stale —
outdated chunks actively mislead the model. Cursor spends a hash tree precisely
on keeping that from happening. Building embeddings before Phase 3 has proven
insufficient would be buying the risk ahead of the benefit.

Unpark it when Phase 3 ships and open-tab context is demonstrably not enough.

## What this deliberately is not

**Not an event.** A completion is never appended to the log, and no
`ChorusEventPayload` is added. It fails the "state is not history" test the same
way `limits` does: a suggestion you did not take, read back a week later, is
worse than having none. This also means the five-file change in `CLAUDE.md` does
not apply — there is no new event type, and no projection, and no `catchup.ts`
case.

**Not a conversation.** It has no `conversationId`, appears in no transcript,
and passes through no approval. The moment it needs a conversation to work, the
design has gone wrong.

**Not a bundled model.** `electron-builder.yml:96` records 412.6 MB installed
against a 949.6 MB ceiling from preflight §8.5 R3 — about 537 MB of headroom,
and a quantized 1.5B–3B GGUF is 1–2 GB. The heavier objection is not size: a
llama.cpp binding would be a fourth native dependency with a Metal/CUDA/Vulkan/CPU
matrix, on a build that already sets `npmRebuild: false`, has no Linux prebuilds
for `node-pty`, needs `signExts: [.dll, .node]` on Windows and `sign-adhoc.cjs`
on macOS. A local model later is not closed off — weights could ride the REH's
own pattern, pinned in `build/workbench-runtime.json` and fetched at runtime
(`workbench-host.ts:366`) — but the runtime cannot.

**Not a second Changes panel.** Nothing here draws over the workbench region, so
no `useShellOverlay` is involved. The ghost text is drawn by the native view
itself.

## The decision this plan argued against

Consent is **on by default**, decided by Mohamad on 2026-09-18. The plan's
research recommended a per-project setting, off until asked, in the shape of "may
agents write here". The argument for that was: a completer sends the buffer's
bytes to a third party on every keystroke, including whatever file is open, and
`CLAUDE.md`'s permission-engine rule says a deny by filename is the wrong shape
for a secrecy decision — so nothing can reliably keep a `.env` out of the buffer
except a person's answer about a repository.

That recommendation was not taken, and this section exists so the decision is
findable rather than so it is relitigated. What follows from it: completions
begin the moment an API key is set, in every project, and the first repository
opened after that starts sending buffers. If that is ever revisited, the setting
belongs on the Project and not on a conversation — a setting is asked once, about
the thing it is about.

## Open questions

- **Two writers on one buffer, which is the half of a deleted default that
  survives.** `services.ts` used to set `'editor.inlineSuggest.enabled': false`,
  on the reasoning that a completer "would be a second model writing into the
  same buffer an agent is editing". The line was deleted on 2026-09-19 because it
  was aimed at the _bundled_ VS Code completions — a model Chorus did not own —
  and this plan is the argument for owning one. But the residual risk is real and
  unaddressed: a person accepting a suggestion in a file an agent is mid-edit on
  produces two uncoordinated writes. The editor cancels a stale suggestion when
  the buffer changes, which covers the common case and not the race. Suppressing
  suggestions in a file with an agent edit outstanding is the obvious answer and
  is not built.
- **The number.** p50 and p90 from this machine are unmeasured by design and
  Phase 2 exists to take them. Nothing before Phase 2 should claim a latency.
- **Which endpoint wins.** DeepSeek's FIM endpoint is native and cheap and
  `deepseek-flash` carries a large window, but a large window is a ceiling and
  not a payload, and the model class is the opposite of the small-and-FIM-trained
  axis the research settled on. Phase 2 answers it.
- **A second completer — and the mechanism does not exist, which is a finding
  rather than an omission.** `yieldsToGroupIds` needs a `groupId` on the _other_
  provider, and a `groupId` arrives only through the `metadata` argument to
  `registerInlineCompletionItemProvider`. That argument is gated:
  `extHost.api.impl.js:804-806` calls `checkProposedApiEnabled(extension,
'inlineCompletionsAdditions')` whenever it is present, and
  `extensions.js:191-196` returns false for any extension with no
  `enabledApiProposals`. A completer installed normally from Open VSX cannot
  enable a proposed API, so its `groupId` is `undefined` and there is nothing to
  name. **So there is no id to discover and none was invented.** What arbitrates
  instead is the selector score: ours rates 10 on scheme, a language-scoped
  third-party completer also rates 10, so both land in the same bucket and both
  are asked. Installing Continue means two providers run and Chorus does not step
  aside. This changes only if VS Code stabilises `metadata`, or if a completer
  ships as a built-in with the proposal allowed.
- **The proposed-API gate is coarser than its name.** `isProposedApiEnabled`
  takes a `proposal` parameter and never reads it, and `checkProposedApiEnabled`
  calls it without passing one — so an extension declaring _any_ proposal
  satisfies the check for _every_ proposal. Noted because it is exactly what
  would persuade a later reader that a `groupId` is reachable when it is not.
- **The scheme restriction is load-bearing twice, and only one of them is
  obvious.** T1 narrowed the selector to `file` and `vscode-remote` so ghost text
  stays out of the `chorus-ask` approval diff. T2 then made the payload's path
  `model.uri.path`, which is correct only for those two schemes:
  `context.ts:93` records that `uri.path` "silently fails for every virtual one"
  — a `gl-review:` pane carries a repository-relative path that looks absolute —
  and that bug has already been lived through once in this codebase. So widening
  the selector, or setting `hasAccessToAllModels`, silently breaks the path
  rather than merely changing where completions appear. Whoever widens it owes
  the payload `resolveDocument` from `@chorus/ide-protocol/document-identity`,
  which is what `context.ts` uses for exactly this.
- **Remote projects.** The provider runs in the renderer and the call runs in
  main, both on this machine, while the files may live on a remote REH. Nothing
  about prefix and suffix changes — they come from the loaded `ITextModel` — but
  Phase 3's open-tab retrieval touches files whose contents the renderer may not
  hold, and that is unexamined.
- **Windows.** Untested throughout. Nothing here is obviously platform-specific,
  which is exactly what was said about several things in
  `docs/plans/windows-installer-2026-08-15/plan.md` before they were read.

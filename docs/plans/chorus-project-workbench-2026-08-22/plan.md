# Chorus becomes the development environment

**Replace the session-first application and external VS Code bridge with a project-first,
multi-agent IDE whose Code-OSS workbench, terminals, Git, extensions and conversations all
live inside Chorus.**

The acceptance criterion is deliberately blunt:

> Open Chorus, add a project, edit and navigate code, run and debug it, use Git, collaborate
> with several agents, review their edits and commit the result without opening the separate
> VS Code application.

This is a product revamp, not the next phase of `Live editor context`. Intermediate builds may
break. Mohamad is the only user and explicitly accepted a clean database. The plan therefore
does not spend work preserving the current session-first schema or current window layout.
It does preserve the source, the agent/event architecture that still fits, and a copy of the
old database so “clean” never has to mean “irreversibly deleted”.

## Status

| Phase                                               | Status                              |  Estimate | Gate                                                                               |
| --------------------------------------------------- | ----------------------------------- | --------: | ---------------------------------------------------------------------------------- |
| 0 · The clean baseline                              | ✅ Codex approved                   |    0 days | Branch, base SHA and worktree status verified; archive preserved                   |
| 1 · Prove the embedded workbench and extension host | ✅ Built, driven, UI approved 08-24 | 1–2 weeks | Cross-platform kill gate passes before the product shell is rebuilt                |
| 2 · Make Project the top-level domain               | ✅ Built — typechecks, untested     | 1–2 weeks | Projects own roots; conversations cannot own or change cwd                         |
| 3 · Replace the shell with project tabs             | ✅ Built, driven 08-24 — untested   | 2–3 weeks | Project rail, project tabs/splits and nested conversations work                    |
| 4 · Ship the complete Code-OSS workbench            | 🟡 Core surfaces live, driven 08-24 | 4–8 weeks | Explorer/editor/search/SCM/terminal/tasks/debug/settings work from real projects   |
| 5 · Make extensions a supported subsystem           | 🟡 5a–5g built 08-28, gate unmet    | 4–8 weeks | Every installed extension has a proven result or an explicit replacement/exception |
| 6 · Join agents to the live workbench               | 🟡 6a–6c, 6f built; 6d/6e rewritten | 3–6 weeks | Agents observe and edit the same unsaved models with approval and undo             |
| 7 · Cross-platform product cutover                  | 🟡 macOS + Windows build; Linux red | 3–6 weeks | The daily-development journey passes in packaged macOS, Windows and Linux builds   |
| 8 · Remove the old product                          | ⬜ Not started                      | 1–2 weeks | No core path launches, installs or depends on external VS Code                     |
| **9 · The product-first correction**                | 🟡 Built 08-28–29, untested         |         — | One place to do each thing; the editor owns git; settings belong to the project    |

**Planning estimate:** roughly four to seven engineer-months for the full acceptance criterion.
The Phase 1 vertical slice arrives much earlier. “Revamp today” means beginning from the right
architecture today; a cross-platform IDE with a real extension host is not honestly a one-day
implementation.

### User UI review gate

The first moment a phase produces a reviewable UI—even a disposable vertical slice—work stops
and Mohamad is asked to open it and review it. The implementer explains exactly how to reach the
screen and what is ready to judge. No visible phase is called accepted, and no later visible
phase begins, until Mohamad approves that UI or requests changes.

This gate applies at minimum to Phases 1, 3, 4, 5, 6 and 7. It is separate from automated
verification: Chorus does not launch or drive the app unless Mohamad separately authorizes it,
and a green automated check never substitutes for his product review.

---

## 0. Where the current plan diverged

The original goal was a VS Code-class IDE inside Chorus. Two successive plans narrowed that
goal without preserving its acceptance criterion:

1. `the-editor-you-already-know-2026-08-20` adopted Monaco for an optional diff view and
   explicitly said Chorus was not becoming an IDE.
2. `over-your-shoulder-2026-08-22` deepened the external extension bridge so Chorus could
   continuously observe VS Code.

The second plan is technically coherent for its own problem, but its end state is still the
line that triggered this correction:

```text
VS Code context: package.json:22 (unsaved buffer)
```

That sentence proves the user is still editing somewhere else. It can be useful as an optional
integration later, but it satisfies none of the new product acceptance criterion.

`BOARD.md` C-046 made a second category error. It correctly rejected a permanent Code-OSS fork,
then treated that as evidence against embedding a workbench. A fork, a browser-served second
application, and a reusable Code-OSS workbench are three different architectures. This plan
keeps C-046's maintenance warning and reopens the product conclusion.

## 1. Final product

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Chorus                                                                       │
├────────────┬──────────────────────────────────────────────┬──────────────────┤
│ Projects   │ Code-OSS workbench                           │ Chorus           │
│            │                                              │ conversations    │
│ chorus     │ Explorer │ editors / splits │ secondary bar │                  │
│ flow-drive │ Search   │ tabs / diff      │               │ Session A        │
│ wallet     │ SCM      │ IntelliSense     │               │ Session B        │
│            │ Debug    │ diagnostics      │               │ agents / approval│
│ + Add      ├──────────────────────────────────────────────┤                  │
│            │ Problems │ Output │ Terminal │ Tests         │                  │
└────────────┴──────────────────────────────────────────────┴──────────────────┘
```

### 1.1 Product hierarchy

```text
Chorus
└── Project
    ├── stable id
    ├── local root / workspace file
    ├── Code-OSS workspace and storage
    ├── Git, terminals, tasks and debug sessions
    ├── Conversation A
    │   └── Claude and/or Codex participants
    ├── Conversation B
    └── project UI state
```

The durable invariant is:

> A Project owns the development environment. A Conversation belongs to exactly one Project.

Consequences:

- The left rail lists Projects, never a global mixture of conversations.
- The current tab/split system is re-keyed from `conversationId` to `projectId`.
- A project may hold many conversations; its Chorus dock selects among them.
- Conversations cannot change their own directory. Relocating a Project changes the root for
  all its conversations in one explicit operation.
- Git, terminals, file trees, editor groups and workbench storage are project state, not
  conversation state.
- Inactive projects keep agents alive; only visible project tabs mount workbench renderers.
  Server-side terminals are kept **for a bounded window** rather than indefinitely — the REH's own
  reconnection grace, which another project connecting can shorten — and whether they are
  re-attachable after it is **UNVERIFIED** pending a Phase 1 probe (§2.4). "Can" rather than
  "will", and narrower than it sounds: the shortening applies to that project's **connections**,
  fires **once**, and only when it lands early enough to beat the deadline already running —
  and whether it reaches that project's **terminals** at all is a further **UNVERIFIED** cascade,
  not an established fact. This line previously
  said "and server-side terminals alive when resources allow", which read as a resource caveat on
  a promise that is really a **time** caveat, and one Chorus does not control.
- No editor state is inferred from DOM. The workbench API and a trusted built-in extension are
  the source of editor truth.

### 1.2 First launch

The clean product starts with an empty Projects rail and one primary action: **Add Project**.
Choosing a path creates a stable project, opens it in a full workbench and offers to start the
first conversation. There is no optional cwd field on “new conversation”; a conversation is
created from inside a project and inherits its root.

### 1.3 Daily acceptance journey

One representative acceptance run must complete entirely inside Chorus:

1. Add an existing repository by path.
2. Browse and search the repository.
3. Open several files in tabs and editor groups.
4. Edit, undo, save, rename and format files.
5. Receive diagnostics, completion, navigation, rename and code actions.
6. Run a task and an interactive terminal command.
7. Set a breakpoint and complete a JavaScript/TypeScript debug session.
8. Inspect, stage and unstage Git changes; resolve a conflict; commit.
9. Install or enable an allowed extension and use its contribution.
10. Start two Chorus conversations in the project.
11. Let both agents observe the same current editor state.
12. Approve an agent edit into an unsaved buffer, inspect it inline and undo it.
13. Switch projects while agents or terminals continue in the background.
14. Restart Chorus and restore projects, workbench state and conversations.

Opening external VS Code at any point fails the acceptance run.

---

## 2. Architecture decision

### 2.1 Options

| Option                                                              | Fidelity               | Extension host                         | Chorus integration                    | Ongoing ownership                        | Decision                        |
| ------------------------------------------------------------------- | ---------------------- | -------------------------------------- | ------------------------------------- | ---------------------------------------- | ------------------------------- |
| Monaco plus hand-built panels                                       | Low                    | Custom                                 | High                                  | Chorus reimplements an IDE               | Reject                          |
| OpenVSCode Server/code-server in a generic iframe                   | High                   | Real Node host                         | Low; it remains a second app boundary | Server lifecycle plus brittle UI seam    | Reject as final shape           |
| Eclipse Theia                                                       | Medium-high            | Real plugin host                       | High after porting Chorus into Theia  | Chorus becomes a Theia product           | Fallback                        |
| Permanent Code-OSS/VSCodium fork                                    | Highest                | Native local/remote hosts              | Highest after a large port            | Weekly upstream merge obligation         | Last resort                     |
| `@codingame/monaco-vscode-api` full workbench + pinned VSCodium REH | High Code-OSS fidelity | Real remote Node host plus web/UI host | High; Chorus keeps its shell          | Version-pinned client/server integration | **Choose, behind Phase 1 gate** |

### 2.2 Why the chosen shape is credible

As of 2026-08-22, `@codingame/monaco-vscode-api` v36.1.1 is not merely Monaco with a few
services. Its published service list includes a full workbench layout, Explorer, terminal,
search, SCM, Problems, testing, notebooks, tasks, debugging, settings, keybindings, themes,
extension gallery, remote agent and webviews. The official demo boots those services together.

Primary sources:

- <https://github.com/CodinGame/monaco-vscode-api>
- <https://github.com/CodinGame/monaco-vscode-api/wiki/List-of-service-overrides>
- <https://raw.githubusercontent.com/wiki/CodinGame/monaco-vscode-api/How-to-install-and-use-VSCode-server-with-monaco%E2%80%90vscode%E2%80%90api.md>
- <https://code.visualstudio.com/api/advanced-topics/extension-host>

The library's in-page `ExtensionHostKind.LocalProcess` example is not enough for Chorus's
installed extensions. Of the 81 unique installed extensions, most declare a Node `main`; many
have no `browser` entry. VS Code itself distinguishes local Node, web-worker and remote Node
extension hosts. A web-only host therefore cannot be called compatible.

The chosen topology supplies the missing host:

```text
Electron main — trusted Chorus boundary
├── ProjectService
├── ChorusRuntime / event store / permission engine
├── WorkbenchHost
│   ├── starts one version-pinned VSCodium REH sidecar, shared by every open project
│   ├── binds loopback only with a random connection token
│   ├── manages per-project workspace/storage identity
│   ├── verifies the artifact against the manifest BEFORE extracting, extracts to a
│   │     temp sibling, patches, writes the receipt last, then atomically renames —
│   │     quarantining an invalid destination by rename, never by recursive delete
│   │     (the unpacked server does not record which VS Code it was built from)
│   └── owns crash/restart/update lifecycle, refcounted by projects requiring REH
│         state — acquired on project open, released on project close, never by visible view
├── WorkbenchSurface
│   ├── one WebContentsView per visible project, all on ONE dedicated workbench
│   │     session partition, each with the minimal workbench preload — never the shell's
│   └── the only place the connection token crosses out of main
└── typed IPC
      │
Electron renderer
├── Chorus product shell
│   ├── project rail and project tabs/splits
│   └── project-scoped conversation dock — holds opaque view IDs, never the token
└── one main-owned workbench surface per visible project
    ├── @codingame full WorkbenchService
    ├── vscode-remote:// connection to the shared VSCodium REH
    ├── web/UI extension host
    └── trusted Chorus Workbench Bridge extension
          │
VSCodium REH sidecar — untrusted extension boundary, one process for all projects
├── one Node workspace extension host forked per project connection
├── filesystem/watch/search
├── terminals/tasks/debug
├── built-in Git extension
└── Open VSX / local VSIX extensions
```

### 2.3 Why a VSCodium sidecar, not Microsoft's server

The CodinGame documentation describes connecting its client to a version-matched VS Code or
VSCodium server. Chorus must not redistribute Microsoft's server or accept its server licence
on a user's behalf. The preferred sidecar is a matching VSCodium `reh` artifact under MIT;
if no artifact matches the exact upstream commit used by the client packages, Chorus builds
its own Code-OSS REH from that commit. Client and server commit are one atomic dependency.

VSCodium also makes the marketplace boundary explicit: Microsoft Marketplace offerings are
restricted to Microsoft products, so Chorus uses Open VSX plus user-selected local `.vsix`
files. Some proprietary extensions remain unavailable even when manually installed.

Primary sources:

- <https://github.com/VSCodium/vscodium>
- <https://github.com/VSCodium/vscodium/blob/master/docs/extensions.md>

### 2.4 Workbench lifetime and multiple projects

VS Code services initialize once and cannot be unloaded in one JavaScript global. Chorus's
existing four-pane layout can show several projects, so one global workbench instance cannot
honour the product shape.

Each visible project therefore gets an isolated secondary renderer entrypoint in its own
**`WebContentsView`** — a separate top-level `WebContents`, in its own process, on the **one**
dedicated workbench session partition that every surface shares and the shell does not, and behind
a **dedicated one-method preload** rather than the shell's. That is a stronger boundary than the
iframe the preflight first assumed and the only one main can deliver a secret into without arming
every subframe (preflight §4.1a, §4.1b). The
CodinGame sandbox mode is explicitly designed to isolate that one-time lifecycle, and a separate
`WebContents` satisfies its requirement by construction. The outer Chorus renderer never imports
CodinGame or Monaco workbench modules; it holds an opaque view ID, reports a rectangle, and
communicates through a narrow validated bridge. Inactive tabs close their surface but keep project
state and agents. A maximum of four visible workbenches inherits the current pane cap and gets an
explicit memory/performance gate.

**On REH-side terminal processes this sentence used to promise more than anything establishes, and
round four of the preflight review corrected it.** Unmounting a surface closes that project's
WebSockets — they belong to its `WebContents` — after which the terminals are the **server's** to
keep, on a grace timer Chorus does not own: three hours by default, and shortened — once, at the
connection layer, with the reach into terminals **UNVERIFIED** — when another
project connects (preflight §5.4, read from the server's source at the pinned tag). So retention
is **time-bounded rather than indefinite**, and
whether the processes are genuinely re-attachable after a reap is **UNVERIFIED** and is a Phase 1
probe. **Refcounting the server by open project cannot supply it** — a lease keeps a process
alive, it does not hold a connection open. If the probe fails, the fallback is an explicit Phase 1
decision between retaining a hidden surface, adding a headless client connection owned by main
(which would put the connection token in a second place), and revising this promise.

**Round five corrected how that shortening is stated, and the correction is not cosmetic.** "Cut to
five minutes" is the wrong shape: the server leaves the original deadline running and schedules a
**second** timer for a full `min(300 s, graceTime)` from the instant the other project connects,
so the effective deadline is the **earlier of the two** and the arrival only matters when it lands
early enough to beat the original. It also happens **once** — the second and third projects to
connect while one is disconnected change nothing further. And the loop that does it walks
management and extension-host **connections**; it never touches a persistent terminal, whose own
short timer is armed only by an explicit client request. So the coupling between projects is proven
at the connection layer, and **whether it reaches the terminals is the same UNVERIFIED cascade the
probe is for**. The probe itself changed too: it cannot be run at a 60-second grace, because
`min(300 s, 60 s) = 60 s` makes the shortening arithmetically invisible (preflight §5.4).

**What this shape pays for the isolation is layout.** The surfaces are composited by the window
rather than by the shell's DOM, so main must drive their bounds from rectangles the shell reports,
and every clipping, scrolling or animation question becomes a two-process one. Phase 1 measures
resize and tab-switch tracking rather than assuming it.

This is a Phase 1 risk, not a statement of faith. If surface lifecycle, focus, shortcuts,
webviews, bounds tracking or resource use fail the gate, the fallback order is:

1. One active workbench surface with project switching and no simultaneous project splits.
2. Port Chorus into Theia.
3. Make Chorus a Code-OSS workbench contribution/fork.

The plan stops for a new decision before taking either fallback.

---

## 3. Security and ownership

### 3.1 Trust boundaries

| Boundary                   | Trusted?         | Responsibility                                                                                                                 |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Electron main              | Yes              | Project roots, agent policy, event log, sidecar lifecycle, IPC validation                                                      |
| Chorus renderer            | No               | Product composition and display                                                                                                |
| Workbench surface          | No               | Code-OSS UI and editor state; the one dedicated workbench session with its own explicit CSP, and a preload exposing one method |
| Chorus Workbench Bridge    | Trusted built-in | Convert VS Code API state/commands into a narrow protocol                                                                      |
| Third-party extension host | No               | Extensions execute with the user's local privileges, as in desktop VS Code                                                     |
| Agent providers            | No               | Receive only policy-approved project/editor context                                                                            |

### 3.2 Sidecar rules

- Bind only to `127.0.0.1`/`::1`, never all interfaces.
- Generate a random connection token per launch; never use
  `--without-connection-token` outside a disposable development probe.
- Use Chorus-owned user-data and extensions directories, separate from VS Code/VSCodium.
- Pin the client package version, upstream VS Code commit, VSCodium/Code-OSS server artifact,
  checksums and licences in one manifest. **The server artifact does not record which VS Code it
  was built from**, so the manifest's upstream commit is generated from the release's own
  `upstream/stable.json`, the download is verified against its published checksum, and unpacking
  writes a Chorus-owned extraction receipt (preflight §3.5). Asking the running server what it is
  proves nothing once its `product.json` has been patched to satisfy the handshake.
- **Extraction is transactional, and its order is normative** (preflight §3.5 property 3, round-4
  review): verify the archive against the committed manifest **before** extracting anything;
  extract into a new temporary sibling directory; reject absolute paths, `..` traversal and links
  whose targets escape the root; patch `product.json` there; write the receipt **last**, carrying
  the manifest's own hash; then atomically rename the finished directory into its final
  checksum-addressed location. **A directory without a valid matching receipt is unusable** and is
  replaced rather than repaired. The property: an interrupted or malicious extraction cannot
  become a valid-looking runtime.
- **Replacing an invalid destination is done by quarantine, and the publish path never recursively
  deletes** (preflight §3.5 step 8, round-5 review). Round four said such a directory is
  "re-extracted", which could not run: `rename` fails on a non-empty destination and round four
  also forbade removing it, so re-extraction looped forever against a tree nothing was allowed to
  move. The sequence is **rename the invalid destination to a unique quarantine sibling, then
  rename the completed temporary tree into the final path**; if either rename loses a race,
  restart by validating whatever receipt is at the final path now. Quarantine cleanup is a
  separate restartable sweep. The reason it is not a delete: an interrupted `rm -rf` leaves a
  directory that exists, is missing an arbitrary subset of its files, and may still carry a
  matching receipt — the exact state the transactional order exists to make unreachable.
- Reject a client/server commit mismatch before opening a project — against the receipt, not
  against the server's own claim about itself.
- Treat every installed extension as arbitrary local code. Show source and permissions before
  installation; do not imply Open VSX scanning makes extensions safe.
- Keep the current Electron renderer sandbox, context isolation and navigation lock **on the
  shell's session, unchanged**. The workbench runs on **one dedicated session partition shared by
  every surface**, and it needs its own policy built from `default-src 'none'` upward — CSP, both
  permission handlers, navigation lock and the `will-attach-webview` guard are **installed on it
  deliberately**, never inherited. A test asserts the workbench session is not the default one and
  that each control is present: a partition created and left bare is not a relaxed control, it is
  an absent one. Add only the exact local origins the workbench requires.
- **Give the workbench its own preload, exposing one method.** Chorus's existing preload publishes
  the entire `ChorusApi` — approvals, settings, git actions, project writes, every conversation and
  terminal channel — and a workbench surface, which runs third-party extension code by design, must
  never receive it. The surface builds its own `webPreferences` rather than reusing the window's,
  because that is the one move that carries the shell's preload across silently (preflight §4.1b).
- Validate every surface/main message with shared schemas. No generic command pass-through.
  **Main derives which project a surface belongs to from the sender**, never from a value in the
  request: the connection descriptor is pushed to that view after its own load, buffered by its
  preload so an early send cannot be lost, and re-answerable on demand so a reload reconnects.

### 3.3 Agent editing rule

Agents never write around the workbench when an open text model exists.

```text
Agent proposes WorkspaceEdit
  → Chorus policy/approval
  → Workbench Bridge checks project, URI and document version
  → vscode.workspace.applyEdit
  → same dirty buffer and undo stack the user sees
  → durable edit-result event (metadata, not source body)
```

Closed-file edits may use the workbench filesystem service, but the bridge must first prove no
dirty model for that URI exists. Direct disk writes remain a fallback for agent tooling outside
the UI and must cause the workbench file service to invalidate/reload rather than silently
diverge.

---

## 4. Installed-extension compatibility target

`code --list-extensions --show-versions` returned 81 unique extension ids on 2026-08-22.
The manifests establish four proof classes:

| Class                                 | Examples from this machine                                                                                                                              | Required host/proof                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Contribution-only themes/snippets     | Tokyo Night, GitHub Theme, icons, JS/React snippets                                                                                                     | Manifest contributions render correctly                                 |
| Browser-capable (`ui` declared first) | **24 of the 81** — Draw.io, Bookmarks, Better Comments, Material Icon Theme, Catppuccin, ES7 React snippets, auto-close/rename tag, Pretty TS Errors, … | Web host plus webview/storage/auth proof                                |
| Node workspace extensions             | ESLint, Docker, GitLab, MongoDB, Postman, React Native, Tailwind                                                                                        | REH Node extension host plus process/filesystem/network proof           |
| Microsoft/product-restricted          | Remote SSH, Remote Containers, Codespaces, Speech, Live Share                                                                                           | Explicitly unsupported or replaced; never bypass licence/runtime checks |

**The rule the preflight established is right; the survey it drew from the rule was wrong, and
Phase 5 slice 5d found out by counting.** Being _capable_ of running in a browser is not the same
as _landing_ in the web host. GitLens, GitHub PR, YAML and Error Lens deduce
`extensionKind: ["workspace","web"]` and Prettier declares `["workspace"]`, so with a REH attached
all five run in the **Node host** and belong in the row below; their web build is only the
no-remote fallback. What decides the web host is declaring `ui` **first**. All of that stands.

**What does not stand is "only Draw.io does".** This section said the class "has one third-party
occupant, not six". Reading `extensionKind` out of all 81 installed manifests gives **24** whose
first entry is `ui` — Draw.io among them, but also Bookmarks, Better Comments, Material Icon
Theme, Catppuccin, ES7 React snippets, auto-close-tag, auto-rename-tag, Pretty TS Errors and
sixteen more, almost all declaring the same `["ui","workspace"]` the sentence attributed uniquely
to Draw.io. `scripts/extension-ledger.mjs` derives the number and
[`extension-ledger.md`](./extension-ledger.md) lists every row.

**Why the correction is worth more than the number.** The class decides _what evidence a row
needs_: web host plus webview/storage/auth, rather than the REH Node host plus
process/filesystem/network. Twenty-four extensions were scheduled against the wrong proof, so a
Phase 5 that followed this table would have gathered the wrong evidence for a third of the estate
and only discovered it when the proofs failed for reasons nobody had predicted.

**And it is the same failure this plan keeps recording**: a conclusion drawn once, from a sample,
then written as a property of the whole set. Preflight §6.1 carries the rule and the VS Code
citation, and the rule was never in doubt — only the count taken from it.

Two installed AI extensions—Anthropic Claude Code and OpenAI ChatGPT—are not required for the
product acceptance criterion because Chorus already owns those agent integrations. They are
still tested as ordinary extensions if their licences permit, but Chorus does not duplicate
their chat surfaces by default. **The preflight adds one constraint on when**: neither may be the
first executable extension proof, because a proprietary, platform-specific SPA declaring
proposed APIs Code-OSS cannot grant produces a failure with too many candidate causes to be
worth anything. Chorus-authored fixture extensions go first; these two run last, as the
known-working / known-failing control pair.

Phase 5 creates a checked-in compatibility ledger with one row per installed id:

```text
id · installed version · licence · Open VSX availability · host kind
   · install result · activation result · golden action · cross-platform result
   · status: works | replacement | unavailable-with-reason
```

“Extension installation works” is not the gate. Activation and one representative action are.
Every unavailable entry names whether the blocker is licence, registry absence, proposed API,
native dependency, product check or missing workbench behaviour.

---

## 5. What survives from the stopped implementation

The archived stopped worktree is not one indivisible feature. Its parts have different verdicts.

### 5.1 Keep as independent foundation

| Area                                                          | Candidate files in archive                                      | Reason                                                         |
| ------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| Codex turn admission/steering and Stop correctness            | `packages/adapter-codex/src/codex-adapter.ts`, turn/model tests | Fixes C-051 independently of any editor transport              |
| Claude turn-boundary correction                               | `packages/adapter-claude/src/claude-adapter.ts`, boundary tests | Prevents unmatched completions independently of the workbench  |
| Provider-neutral ambient capability and supervisor forwarding | `packages/agent-protocol`, `packages/orchestrator`              | The embedded workbench still needs a non-user context path     |
| Proven Claude hook delivery                                   | `packages/adapter-claude` ambient hook code/tests               | G2 proved the provider channel; only the editor source changes |
| Privacy primitives                                            | exclusion matching, byte caps, delimiter-safe formatting        | Selected source still crosses from workbench to agents         |

Each candidate returns later as an independently reviewed patch against this branch, never by copying the old diff wholesale. “Tests were
green in the mixed tree” is not evidence that an extracted subset is complete.

### 5.2 Rework behind the embedded boundary

| Area                               | Current shape                               | New shape                                                                                  |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `IdeBridge`                        | Broker for an external authenticated socket | Project-scoped WorkbenchBridge consuming validated surface messages                        |
| Editor observation                 | External VS Code extension events           | Trusted built-in UI extension using the same `vscode.window` APIs                          |
| Ambient routing                    | Per conversation, keyed from cwd/root       | Workbench state belongs to Project; delivery routes to that project's active conversations |
| Following/privacy settings         | External-editor disclosure controls         | Project/agent disclosure controls for built-in editor state                                |
| Diagnostics/context IPC            | Main receives external frames               | Workbench Bridge reports native VS Code API state                                          |
| VS Code extension observation code | Bundled standalone `.vsix`                  | Built-in bridge registered with the embedded workbench                                     |

### 5.3 Remove from the core product

| Area                                        | Files/behaviour                                                   | Why                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Descriptor discovery and socket endpoint    | `packages/ide-protocol` endpoint/codec/version negotiation        | Solves locating a separate editor process                                              |
| External extension connection/reconnect     | `apps/vscode-extension/src/connection.ts`, `discovery.ts`         | No external editor on the core path                                                    |
| VSIX bundling/install/update/restore        | `ide-extension.ts`, Settings UI, `electron-builder.yml` resources | The bridge becomes a built-in workbench component                                      |
| “Open project in VS Code”                   | main IPC and renderer action                                      | Violates final acceptance                                                              |
| External editor status/installation UI      | extension status helpers and copy                                 | Describes a dependency the product removes                                             |
| Composer's external `VS Code context:` pill | `Composer.tsx` snapshot path                                      | Built-in workbench context is standing project state, not an attachment from elsewhere |

### 5.4 Deprioritize, then decide

The old external bridge can return later as an optional interoperability plugin. It is not
carried through the revamp, not packaged, and not counted in acceptance. Keeping it now would
force two editor authorities into every project and preserve the exact ambiguity this plan
removes.

---

## Phase 0 · The clean baseline — ✅ Codex approved 2026-08-22

**Goal.** Start from `main` with nothing carried over but the plan, so no phase after this one
has to ask whether a line is here for the old architecture or the new one.

**What this branch is.** `revamp/project-workbench`, cut from `main` at `c2847c4`, in its own
worktree at `/Users/mohamadtaleb/code/chorus-workbench`. It contains this plan and otherwise
exactly what `main` contains. No bridge implementation, no ambient-context work, no `STATUS.md`
from the stopped attempt, no mixed-tree fixes.

**Why a fresh tree rather than a reduction.** The previous attempt left ~4,900 uncommitted lines
in which useful work and wrong-architecture work were interleaved across 51 files. Separating
them in place meant judging every hunk while the thing being judged was also the only copy —
which is how a reduction turns into a loss. Cutting from `main` makes the question disappear
instead of answering it.

**The archive, described accurately.** The old worktree at `/Users/mohamadtaleb/code/chorus`
holds the uncommitted changes and `docs/plans/over-your-shoulder-2026-08-22/` (plan plus
`STATUS.md`, both marked superseded). It is **reference, not an implementation base**, and it is
the primary uncommitted working copy — nothing there is committed.

Three corrections to how this was first written, because each overstated a guarantee:

- **`stash@{0}` is not the old worktree's.** A stash is repository-level and both worktrees share
  one repository, so it is visible from here too. It belongs to `feat/more-than-one-shell` and
  predates all of this; it is simply not to be touched.
- **`/tmp/chorus-recovery/` is a second ephemeral copy, not a backup.** It is on a directory that
  clears on reboot. One uncommitted working tree plus one temporary snapshot is not durable, versioned recovery.
- **"Byte-for-byte unchanged" was unearned** — nothing verifies it and nothing can promise it.
  What can be committed to is forward-looking: **the old worktree receives no further mutations
  from this work after the cutover.**

Making the archive durable would mean a WIP commit on a throwaway branch there. That is a
destructive-adjacent action on someone else's uncommitted work, so it is Mohamad's to authorize
and has not been done.

**What may come back, and how.** Several things from the stopped attempt are independent of the
architecture — the Codex `turn/steer` admission chain and the `currentTurnId` trap under it, the
Claude turn-accounting fix, the provider-neutral ambient contract proven by gate G2, the
exclusion matcher, the fail-closed settings path, the markdown delimiter helpers. Each returns
**as its own reviewed patch against this branch, never by copying the old diff wholesale.** A
patch that cannot be explained on its own terms here does not belong here.

**Not carried over at all:** descriptor discovery, version negotiation, the bundled VSIX and its
installer, the external `setFollowing` channel, and the renderer surfaces naming an external
editor. Those existed only because VS Code was a separate process the user installed.

**Exit criteria.** `git status` on this branch shows the plan and its `STATUS.md` as the only
untracked path, and `main`'s tree is otherwise unmodified. Nothing is committed, built, installed
or tested, and no further mutation is made to the old worktree.

---

## Phase 1 · Prove the embedded workbench and extension host — 🔍 preflight under Codex review

**Status.** No implementation has begun and nothing has been downloaded, installed, built or run.
What exists is a read-only preflight brief — [`phase-1-preflight.md`](./phase-1-preflight.md) —
establishing what is true before anything is fetched: exact versions and their upstream commits,
the VSCodium REH artifact matrix, licensing, the security model read out of the server's own
source, the proof set, pre-registered kill-gate thresholds, and an authorisation list of every
action that needs Mohamad's approval. **It has been through three rounds of Codex review — nine
corrections, then six blockers, then seven more** — and both rounds are tabled at the top of the brief. The second
round forced two decisions the brief had tried to defer (which workbench surface, and whether
projects share a REH), moved one threshold out of the phase entirely, corrected four more, and
retracted a claim the first round had itself introduced.

**Round three closed two gaps that existed because the earlier rounds each stopped one step
short.** The workbench view had a specified session and **no specified preload** — and the default
would have been the shell's, which exposes the entire `ChorusApi` including approvals, settings
and project writes, to the one context that runs third-party extension code by design. And the
provenance check read a field the server artifact **does not contain**: the unpacked REH records
no upstream VS Code tag or commit anywhere, so "verify what the server says it is" had nothing to
read, and after the handshake patch it would only have read Chorus's own value back. Round three
also fixed a deep import that could not resolve, reconciled the file table with the shared-REH
decision, removed a stale Linux packaging requirement from this plan, and replaced three claims
that outran their evidence. It is under review again in that form, and Phase 1 does not begin
until it is approved.

**Goal.** Earn the architecture before restructuring the product around it.

This is a disposable vertical slice in a secondary renderer entrypoint. It is not styled as
finished Chorus and carries no migration work.

**What the preflight has already settled, and which this plan now inherits:**

- **Execution order** (brief §2.5). A disposable, serverless `36.1.1` two-surface
  containment probe first; then the matched pair `@codingame/monaco-vscode-api@33.0.9` +
  VSCodium `1.121.03429` for the REH proof; then the coexistence measurements **repeated** on
  that matched pair. Proof 9 below is therefore run twice, and only the second run is evidence
  about what is being proposed.
- **The shell never receives the connection token** (brief §4.1a). The workbench is a
  **main-owned isolated surface** and the shell holds only an opaque view ID.
- **That surface is an Electron `WebContentsView`, and the choice is now made** (brief §4.1a,
  round-2 review). The alternative — a separate-origin frame with direct main→frame delivery —
  was withdrawn as unbuildable rather than merely less good: `frame-ancestors 'self'` is
  incompatible with a genuinely separate origin, and Electron only lets a child frame receive IPC
  when `nodeIntegrationInSubFrames` is on, which loads every preload into **every** iframe,
  extension webviews included. The accepted cost is layout: §2.4's four visible panes become
  bounds-driven overlays main must keep in step with the shell, which Phase 1 now measures.
- **The workbench gets one dedicated session partition — shared by every surface, separate from
  the shell — and every control is installed on it explicitly** (brief §4.1a, §5.2). A
  `WebContentsView` does not get a session of its own: absent `session`/`partition` it uses
  `defaultSession`, which is where Chorus's entire CSP, permission and navigation lockdown
  currently lives. So the shell's policy is no longer relaxed at all; the new risk is the opposite
  one, a fresh partition arriving with **no** protections, and §3.2 above gains the rule that
  closes it. One partition rather than one per view is deliberate: the controls are installed once
  and provably apply everywhere, and isolation between surfaces comes from each being its own
  process, not from the session.
- **The workbench gets its own preload too, and it exposes one method** (brief §4.1b, round-3
  review). This is the same omission one field further along: `preload` is chosen in the same
  `webPreferences` object as the session, the brief had not named it, and the natural
  implementation — reuse the window's `webPreferences` for consistency — hands the workbench the
  shell's entire `ChorusApi`. Delivery is specified with it: pushed to that view after its own
  load, buffered by the preload so an early send cannot be lost, re-answerable on demand so a
  reload reconnects, and always resolved from the sender rather than from anything the renderer
  says about itself.
- **One REH is shared by all projects; each project gets its own connection, its own forked
  extension host and its own root** (brief §4.1a, round-2 review). The server keys its connections
  by token and forks an extension host per connection, so this is upstream's own design, and it is
  the arrangement with the lower marginal cost per project — a REH per project would pay for a
  second server, a second watcher set and a second extension host. **The resource gate still
  decides, though**: round three withdrew the claim that this is "the only topology under which
  the gate can pass", which turned an unmeasured prediction into a settled fact. It is chosen on
  architecture and licence; the number is owed. What it costs is a shared extensions directory and
  global-storage namespace, which Phase 5 revisits.
- **The server's lifetime is refcounted by project, not by visible view** (brief §5.4, round-3
  review). It is acquired when a project opens and released when the project closes; unmounting a
  surface does neither. Counting mounted views instead would reach zero while projects are still
  open — with a four-pane cap and no cap on open projects, switching to a fifth project would kill
  the first one's terminals, which is precisely what §1.1 and §2.4 promise it will not.
  **Round four bounds what that buys**: the refcount is a **lease on the server process** and
  nothing more. It holds no connection, so it cannot by itself keep an unmounted project's
  server-side terminals alive — that is the REH's own grace timer. Another project connecting
  shortens that project's **connection** grace, once; whether it shortens the terminals' own is a
  separate and **UNVERIFIED** cascade (brief §5.4).
  Whether those terminals survive an unmount at all is a Phase 1 check, and **if it
  fails, refcounting cannot rescue it**; the fallback is named in §2.4 and must be chosen from the
  probe's result rather than in advance.
- **Microsoft's REH remains forbidden**, on the licence, even though it exists at the exact
  pinned commit for every platform Phase 1 wants (brief §3.1a, §9 E0).
- **Windows arm64 is out of the initial target** — VSCodium has never published
  `vscodium-reh-win32-arm64`, so §7's own condition below decides it (brief §9 E3).
- **Linux x64 stays in this phase's architecture proof and is not deferred to Phase 7**
  (brief §9 E4). **What it needs is a Linux machine or dev environment — not a packaging target.**
  Corrected in review round 3: this line still said "a machine and a packaging target", which
  contradicts the phase's own rule that it makes no packaging change, and contradicts brief §9 D2,
  which round two had already corrected to provisioning. Phase 1's proofs run against a dev build;
  the two plausible Linux failures it is here to find — the REH's bundled `node` against the
  distro's glibc, and `chrome-sandbox`/SUID — need a machine and no installer. The `linux:`
  electron-builder target is Phase 7's, and is recorded there.
- **Phase 1 may use an approved, checksum-verified cache download** of the REH; whether the
  shipped product bundles it or downloads it is deferred to packaging (brief §9 E2).

**Proofs required on macOS, Windows and Linux runners or machines:**

1. Pin one `@codingame/monaco-vscode-api` release and record its upstream VS Code commit.
2. Acquire or build a matching VSCodium/Code-OSS REH for each platform/architecture.
3. Start it from Electron main on loopback with a random token and a Chorus-owned data dir.
4. Render the full WorkbenchService in an isolated main-owned surface.
5. Open this repository through `vscode-remote://` and browse/edit/save a real file.
6. Prove editor groups, search, Problems, output, terminal, built-in Git, task and JS debug.
7. Activate one contribution-only, one browser/web-host, one Node and one webview-heavy
   extension. **Revised by the preflight (brief §6.6): controlled Chorus fixture extensions
   prove views and sustained webview messaging first, then ESLint is the real third-party REH
   proof, Draw.io holds the restored web-host slot, and the proprietary Claude/ChatGPT pair runs
   last as the known-working / known-failing control — not as the first executable proof.**
8. Register a tiny trusted Chorus bridge extension and observe active editor, selection, dirty
   state and diagnostics through the VS Code API.
9. Mount two workbench surfaces at once **on two distinct project roots**, sharing the one REH,
   switch focus/shortcuts, close/reopen one, and measure process and memory behaviour. **Revised
   by the preflight (brief §4.1a): two surfaces on one root would prove the wrong architecture**,
   because they share watchers, language servers and workspace storage and so make the second
   project look nearly free. The proof includes that each project's workspace storage is distinct
   and that the resource cost of the second is strictly less than the cost of the first.
10. Disconnect/restart the sidecar without crashing or corrupting the Chorus shell.

**New files/packages expected.**

- `packages/workbench-protocol/`
- `apps/desktop/src/main/workbench-host.ts`
- `apps/desktop/src/main/workbench-surface.ts` — added by the preflight (§4.1a): owns one
  `WebContentsView` per open project on the one dedicated workbench session partition, installs
  that session's CSP, permission handlers and navigation lock before loading anything into it, and
  is the only place the connection token crosses out of main
- `apps/desktop/src/preload/workbench.ts` — added by the preflight (§4.1b): the surface's own
  preload, exposing a single `connection()` and nothing else, buffering main's delivery so an early
  send cannot be lost. It also means `electron.vite.config.ts` gains a second **preload** input as
  well as a second renderer one — and the existing entry has to be named explicitly, because
  declaring the input list replaces electron-vite's default rather than extending it
- `apps/desktop/src/renderer/workbench.html`
- `apps/desktop/src/renderer/src/workbench/entry.ts`
- `apps/desktop/src/renderer/src/workbench/services.ts`
- `apps/desktop/src/renderer/src/workbench/bridge-extension.ts`
- `apps/desktop/src/shared/workbench-ipc.ts`
- `apps/desktop/build/workbench-runtime.json`

**Kill gate.** Stop and return to architecture selection if any is true:

- no legally redistributable exact-match REH can be produced cross-platform;
- Node extensions cannot activate through the matched host;
- Git/terminal/debug require reimplementing their backends in Chorus;
- surface isolation breaks extension webviews, shortcuts or focus, or the surfaces cannot be kept
  in step with the shell's layout;
- **the second visible project does not cost less than the first** — measured as three points,
  no project / one project / two projects on distinct roots, with the marginal cost of the second
  required to be strictly smaller than the marginal cost of the first (preflight §8.3 R7). A total
  ceiling was the earlier form and it could not fail for the reason it was written for;
- client/server updates cannot be made atomic.

Passing on macOS alone does not pass this phase.

**User review gate.** As soon as the embedded workbench can be opened and operated, stop and ask
Mohamad to review its fidelity, layout, focus behaviour and overall product direction before
building the project-first shell around it.

---

## Phase 2 · Make Project the top-level domain

**Goal.** Replace “conversation with cwd” with a real durable Project.

**Domain shape.**

```ts
interface Project {
  id: ProjectId
  name: string
  root: string
  canonicalRoot: string
  workspaceFile: string | null
  createdAt: number
  lastOpenedAt: number
}
```

- `ProjectId` is a UUID, never a path.
- Canonical roots are unique with platform-correct case handling.
- A conversation stores `projectId`; it never stores a mutable independent cwd.
- Agent sessions resolve cwd from ProjectService when they start.
- Project relocation is one explicit operation that stops/restarts affected workbench and agent
  processes safely.
- Projects, project-open state and workbench state are mutable application state. Conversation
  messages and agent actions remain in the append-only event log.

**Clean database decision.**

Open a new database namespace/schema for the project-first product. Keep the old database file
beside it, renamed/read-only and never loaded automatically. There is no conversation migration
or compatibility parser. This satisfies the clean-start decision while retaining a manual
escape hatch until the new product is accepted.

**Files expected.**

- `packages/project-store/` or a project-focused addition to `packages/event-store/`
- `packages/event-store/src/{migrations,events,projections,store}.ts`
- `apps/desktop/src/main/project-service.ts`
- `apps/desktop/src/main/runtime.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/shared/ipc.ts`
- `apps/desktop/src/main/open-projects.ts` replacing `open-sessions.ts`

**Exit criteria.** A project can be created/opened/renamed/removed; several conversations can
run under it; no conversation can point to a different root; restarting restores the registry.

---

## Phase 3 · Replace the shell with project tabs

**Goal.** Make the visible hierarchy match the domain hierarchy before the full workbench
replaces the center.

**Changes.**

- Re-key the existing layout algebra from conversation tabs to project tabs. Preserve drag,
  reorder, split, focus, resize and the four-pane cap.
- Replace QuickRail's session rows with Project rows and Add Project.
- Give each Project pane three regions: workbench, collapsible Chorus dock, project status.
- Move session creation, history, unread/working/waiting state and agent controls into the
  project-scoped dock.
- Keep multiple sessions within one project; one is active in the dock while all remain alive
  in main.
- Persist project layout separately from each workbench's native layout/storage.
- Remove the optional cwd field from session creation and the command that changes cwd.

**Primary files.**

- `apps/desktop/src/shared/workspace-layout.ts`
- `apps/desktop/src/renderer/src/workspace/{layout,store,Workspace,QuickRail}.tsx`
- `apps/desktop/src/renderer/src/App.tsx`
- `apps/desktop/src/renderer/src/Session.tsx`
- `apps/desktop/src/renderer/src/i18n/en.json`
- `apps/desktop/src/renderer/src/styles.css`

**Exit criteria.** The left rail and all outer tabs name Projects. A project opens several
conversations without creating several IDEs. Switching project tabs preserves chat drafts and
background agents.

**User review gate.** Stop and ask Mohamad to review the project rail, project tabs/splits and
conversation dock in the running UI before Phase 4 changes the workbench surfaces around them.

**Corrected 2026-08-28 by Phase 9.** Three of the changes above shipped differently, and the
differences are not refinements:

- “Replace QuickRail's session rows with Project rows” shipped as _both_ for four days — project
  tiles above a scrolling list of conversation tiles — because the rail was re-keyed without the
  session list being removed. Phase 9 removed the conversation tiles. A rail of projects is the
  thing this line asked for and did not get.
- “Collapsible Chorus dock” shipped as a strip of chips with exactly one conversation on screen.
  Phase 9 replaced it with a **tree of conversation groups** using the same `PaneTree` operations
  as the outer layout, so a project's column splits four ways like a pane does.
- “Preserve drag, reorder, split” was reported as done and was not: the drag module still carried
  conversation ids through a layout keyed by projects. It produced a pane whose tab named a
  project that did not exist, and the only reason anybody saw it was that
  `ProjectService.resolveRoot` refuses an unknown id. Fixed in Phase 9; the lesson is in §8.

---

## Phase 4 · Ship the complete Code-OSS workbench

**Goal.** Replace Chorus's hand-built editor/file/Git/terminal surfaces with the real embedded
workbench services proven in Phase 1.

**Service set.**

- Workbench, Explorer, editor groups and working-copy lifecycle
- Files, watchers, search and quick access
- languages, TextMate/Tree-sitter, snippets, symbols and outline
- Problems/markers, Output and notifications
- built-in Git/SCM, timeline and diff editors
- terminal, tasks and process lifecycle through REH
- JavaScript/TypeScript debugger first; debugger contributions thereafter
- configuration, keybindings, themes, profiles and workspace trust
- testing API/panel and comments
- extension gallery, local VSIX, webviews and authentication

**Cutovers.**

- Retire the custom project tree from `ChangesPanel` as the primary file browser.
- Retire the custom SCM/Changes panel as the primary Git surface; keep only a conversation
  change summary if it continues to add product value.
- Retire session/global xterm panels from the main UI. Project terminals live in the workbench.
  `TerminalService` is removed unless Phase 1 proves it is required as a backend override.
- Keep the hand-written transcript markdown renderer; Code-OSS owns code, not agent prose.
- Keep Chorus's event store, permission engine and provider adapters in main.
- Disable Code-OSS built-in Copilot/chat entrypoints by product configuration so there is one
  agent product, not two competing sidebars.

**Exit criteria.** Steps 1–8 of the daily acceptance journey pass without Chorus substitutes or
external VS Code.

**User review gate.** Stop and ask Mohamad to perform normal editing, navigation, Git, terminal
and debugging work in the embedded workbench. His approval is required before extension support
is treated as product-ready.

---

## Phase 5 · Make extensions a supported subsystem

**Goal.** Move from “a VSIX can install” to a supportable, cross-platform extension product.

**Changes.**

- Use Open VSX as the default registry; support Install from VSIX.
- Store extensions under Chorus, not VS Code/VSCodium user directories.
- Show extension source, version, host kind, workspace trust and activation errors.
- Implement enable/disable/uninstall/update and project recommendations.
- Pin built-in Code-OSS language, Git and debug extensions to the workbench/server version.
- Generate the 81-extension compatibility ledger described in §4.
- Define replacements for unavailable Microsoft-only extensions rather than bypassing product
  checks. Remote SSH/Containers remain a later architecture phase unless a legal open
  replacement passes.
- Add an atomic workbench update process: client packages, REH, built-ins and compatibility
  metadata move together or not at all.

**Exit criteria.** Every installed extension has a visible result. All legally usable extensions
required for the local daily journey activate and complete their golden action on supported
platforms; exceptions are explicit in-product, not hidden in this plan.

**User review gate.** Stop and ask Mohamad to review the extension gallery, installation flow,
compatibility results and activation failures before agents are joined to the workbench.

---

## Phase 6 · Join agents to the live workbench

**Goal.** Make Chorus's agents participants in the IDE rather than chat processes beside it.

**Observation.**

- Workbench Bridge emits project id, workspace trust, active URI, cursor/selection, visible
  ranges, document version, dirty state and diagnostics.
- State is coalesced/latest-only and never logged as conversation history.
- Selected source follows the existing exclusion, byte-cap and provider-boundary policy.
- Routing is project-first: only conversations in that project can receive its context, and
  recipient selection still follows the current turn/cast rules.

**Editing.** _(6d and 6e, rewritten 2026-08-29 — see the note below.)_

- Add a provider-neutral `EditorEdit` request distinct from direct filesystem writes.
- Approval shows project-relative path, version, range and diff.
- Workbench Bridge applies the edit through VS Code APIs to the current model.
- Version mismatch or overlapping user edits refuse and return a conflict; never auto-save.
- Applied edits join the normal undo stack, dirty indicator, SCM and diagnostics.
- Agent file links/reveals use the workbench editor and exact line/column.
- External tool writes cause file-service invalidation and a visible conflict if a dirty model
  exists.

**What changed under 6d and 6e.** Both were written when Chorus had its own diff surfaces, and
they leaned on them: “approval shows … diff” meant `FileDiff` inside Chorus's own Changes panel,
and “a visible conflict” meant that panel refreshing. Phase 9 deleted the Changes panel and the
Review panel, on the decision that **the editor owns git**. So:

- **The approval's diff stays in Chorus.** It is a decision surface, not a review surface — the
  question is “may I write this”, and it has to be answerable without the editor open, because
  the Editor switch can be off. `FileDiff` survives Phase 9 for exactly this and for the
  transcript's diff cards; it is not a leftover.
- **Reviewing what happened moves to the workbench's SCM view.** No Chorus surface re-reads git
  after an edit lands. That is what makes the deletion safe rather than a capability loss, and it
  is the one claim in this phase that a person has to confirm rather than a test.
- **Conflict is reported where the edit was requested** — a refusal on the `EditorEdit`, shown in
  the approval, not a panel that re-reads the working tree. The old wording described a surface
  that no longer exists.
- **What is genuinely lost is the merge-base diff.** `@chorus/workspace` can diff against a
  branch's merge base; the editor's SCM only compares against `HEAD`. Accepted deliberately: the
  function survives in the package, unreferenced, and the day something needs it the call site is
  a few lines rather than a panel.

**Conversation integration.**

- New sessions inherit project root, trust and workbench context.
- Several sessions may watch one project; provider capabilities decide boundary delivery.
- A project-level disclosure indicator names which agents receive live context.
- Approval/history remain in Chorus's append-only event log; cursor/model state does not.

**Exit criteria.** Steps 10–12 of the daily journey pass, including an unsaved-buffer edit that
can be undone from the workbench.

**User review gate.** Stop and ask Mohamad to use the built-in conversations and approve, inspect
and undo a real agent edit. Do not proceed to product cutover until he approves the interaction.

---

## Phase 7 · Cross-platform product cutover — 🟡 macOS and Windows ship, Linux does not

**Goal.** Make “cross-platform” a shipped property, not a TypeScript property.

### What 2026-08-29 settled, and where this section was wrong

**Three of this phase's premises were corrected by running things.** Each of
them read plausibly and each was false, which is the argument for the packaging
work happening against real runners rather than a local `pnpm check`.

**R3 is evaluated, and it cannot decide what this section says it decides.**
Measured installed-`.app` against installed-`.app`, arm64, on one machine:

| Build                                                        | Installed | vs baseline |
| ------------------------------------------------------------ | --------: | ----------: |
| Baseline — `bf9c054` `chore(release): 0.20.0`, pre-workbench |  316.5 MB |       1.00× |
| Candidate — REH downloaded at runtime                        |  339.9 MB |       1.07× |
| Candidate — REH bundled                                      |  419.9 MB |       1.32× |
| **R3 ceiling (3×)**                                          |  949.6 MB |       3.00× |

The embedded workbench costs **23.4 MB installed**; the `@codingame` client is
JavaScript that bundles into the asar and the bulk of every figure is Electron.
Both options clear the ceiling with 2.3× headroom, so the sentence above — that
R3 is “decided here anyway, alongside the bundle-versus-runtime-download choice
it depends on” — is wrong in its causality. **R3 does not constrain the choice**;
it only says neither option is extravagant. The decision was made on product
grounds: **bundled**, so a first launch needs no network. The bundled figure is
measured rather than projected — arithmetic from the archive's own size said
412.6 MB and was 7.3 MB out.

**The Linux architecture rule is stated on a premise that does not hold.** The
table below says “x64; arm64 only if every native and REH artifact exists”. The
REH artifacts exist for both. The **native** artifacts exist for neither:
`node-pty` publishes prebuilds for `darwin-arm64`, `darwin-x64`, `win32-arm64`
and `win32-x64` and none at all for Linux. Its install is
`node scripts/prebuild.js || node-gyp rebuild`, so on Linux it compiles, and with
`npmRebuild: false` the binding that ships is whatever the build host produced.
So the real rule is **Linux must be built on Linux** — cross-building from macOS
packages a bundle with no PTY and nothing says so — and arm64 is a question about
runner availability rather than about artifacts.

**A retired runner label does not fail, it hangs.** The Intel job was first put
on `macos-13`, which GitHub has since removed. It sat queued for twenty-four
minutes and was never assigned a runner while every other job completed — no
error, no red, nothing to read. `macos-15-intel` is the replacement and is proven
working. Worth recording because the failure mode is invisible: a release cut on
a retired label would hang rather than fail.

**Where the phase actually stands.** macOS arm64, macOS x64 and Windows all
build, verify at `bundle` scope and upload, proven on two dispatched runs.
**Linux has never built** — `C-064`.

### R6, R7, R8 and R11 — measured, and R7 vindicates §2.4

**The numbers this plan has owed since Phase 1 exist.** Measured by
`pnpm --filter @chorus/desktop run gate:memory`, macOS arm64, 60 s idle per term,
resident memory summed across every Chorus process:

| Term                           |     Total | Processes |
| ------------------------------ | --------: | --------: |
| `M0` — no project open         |  556.0 MB |         6 |
| `M1` — one project             | 1048.3 MB |        10 |
| `M2` — two projects, two roots | 1380.3 MB |        13 |

- **R7 passes.** The second project costs **332.0 MB** against the first's
  **492.3 MB**. Run three times with the roots recreated each time, and the
  inequality held every time with a 26–37% margin. **This is the measurement
  §2.4 deferred**: it chose one shared REH over a server per project on
  architecture and licence and said "R7 still decides". R7 has now decided, and
  it decided in favour of the shape that was already built.
- **R6 passes** — `M1` is 1048.3 MB against a 1200 MB ceiling. Not a wide margin,
  and worth watching: an earlier run of the same gate came in at 1189.9 MB.
- **R8 passes** — 0.51% idle CPU with two projects, against a 3% ceiling. The
  file-watcher fear the row was written for does not materialise here.
- **R11 half fails.** Memory returns to within 5.4% of `M1`, inside the 15%
  allowed. The **process inventory does not**: two REH extension hosts survive
  ten open/close cycles. That is the second candidate R11's own rationale names,
  and it is `C-065`.

**R9 is recorded, not gated**, as §8.3 chose: process count is 6 at `M0`, 10 at
`M1`, 13 at `M2`.

**What these numbers are not.** One machine, one platform, one afternoon. They
say the inequality holds here; they say nothing about a smaller laptop, and
nothing about **four** projects — the ceiling the product actually allows — which
has still never been measured.

Unless narrowed before implementation, cross-platform means macOS, Windows and Linux desktop.
The first supported architecture set is:

| OS      | Initial architecture                                                                                                                                        |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | arm64 and x64                                                                                                                                               |
| Windows | **x64 only.** The arm64 condition below has now been evaluated and **fails**: VSCodium has never published `vscodium-reh-win32-arm64` (preflight F2, §9 E3) |
| Linux   | x64; arm64 only if every native and REH artifact exists                                                                                                     |

The condition was always "arm64 only if every native and REH artifact exists". For Windows it has
been checked against the last thirty VSCodium releases and the artifact is absent, so this is the
plan's own rule resolving rather than a narrowing of scope. It reopens if VSCodium publishes the
artifact or if Chorus takes the Code-OSS REH build branch, which produces `win32-arm64` itself.

**Packaging.**

- Add Linux targets and CI jobs; expand current macOS arm64/Windows x64 release matrix. **The
  `linux:` electron-builder target belongs here, not to Phase 1** — Phase 1 needs a Linux machine
  to run a dev build on, which is provisioning rather than packaging (preflight §9 D2).
- Bundle or acquire the exact platform REH and built-ins with checksums and licence inventory.
- **Evaluate the installed-size threshold, pre-registered in preflight §8.5 as R3: ≤ 3× the
  installed baseline, installed measured against installed on the same machine, with the baseline
  build's identity recorded beside its number.** It arrives here rather than at the Phase 1 gate
  because Phase 1 deliberately bundles nothing, so there was no installed candidate to compare —
  and it is decided here anyway, alongside the bundle-versus-runtime-download choice it depends on.
- Preserve `better-sqlite3`/`node-pty` constraints only for components that remain after Phase 4.
- Verify sidecar executable permissions, quarantine/signing, Windows process cleanup and Linux
  sandbox requirements.
- Never download an unpinned executable on first launch.

**Product gates.**

- cold start and project-open time
- one and four visible project workbenches: memory, idle CPU and focus correctness
- sidecar crash/restart and app shutdown cleanup
- unsaved editor and workspace restore
- extension installation/activation/webview on each OS
- terminal/task/debug/Git on each OS
- full daily acceptance journey on packaged builds
- no external VS Code executable/process/extension required

**Exit criteria.** The packaged application completes the daily journey on every supported OS
and restores several projects after restart.

**User review gate.** Provide the packaged build and ask Mohamad for final daily-use review before
the old product and external bridge are removed.

---

## Phase 8 · Remove the old product

**Goal.** Make the project-first IDE the only core architecture.

- Delete external VS Code descriptor/socket/installer code and the bundled `.vsix`.
- Delete “Open in VS Code”, external extension health and editor snapshot attachment UI.
- Delete or archive conversation-first workspace persistence and custom IDE substitutes that no
  longer have a product role.
- Change package descriptions, onboarding, screenshots and release notes to the new promise.
- Update C-046 and close/supersede the external-editor plan in `STATUS.md`.
- Keep an external-editor bridge only if separately proposed, scoped and approved as an optional
  plugin after the new acceptance criterion passes.

**Exit criteria.** Searching production code and packaging finds no requirement for the `code`
CLI, no bundled Chorus VSIX, and no path where external VS Code is needed to develop.

---

## Phase 9 · The product-first correction — 🟡 built 2026-08-28–29, untested

**Why this phase exists.** It was not planned. Phases 2–6 built the project-first architecture and
then, driven for the first time as a _product_, it turned out to have three problems no phase had
named: settings were asked one level too low, the same job could be done in three places, and
Chorus had rebuilt surfaces the embedded workbench already owns. Mohamad called the shape of the
correction; this records it, because a plan that pretends it was right is worth less than one that
says where it was wrong.

**The three rules it applies.**

1. **A setting belongs to the thing it is about.** A permission profile is an answer about a
   _place_ — "agents may write in this repository" — so it belongs to the Project, not to whichever
   conversation was asked first. Same for the cast and the folder.
2. **One place to do each thing.** Ending a session was reachable from the composer, the project
   card and the tab. Three doors to one irreversible action is three chances to build the habit of
   clicking through a confirmation without reading it.
3. **The editor owns what the editor owns.** Chorus had a Changes panel and a Review panel, both
   reading git. The workbench has an SCM view, a diff editor and its own bindings. Two readers of
   one repository is two things to keep in step.

### What was built

- **Project-level settings** — migration 5 adds `agent_ids`; `permission_profile_id` was already
  carried by migration 4 without a reader, and this is the change that proves that call.
  `setProjectProfile` writes the row _first_ and then moves every live conversation, each appending
  its own `policy.changed`: the row is current state, the log is what happened. A new conversation
  inherits the project's profile and cast — explicit argument beats project beats caller default.
- **The rail is projects only.** One tile per project; the badge sums the project's unread with the
  existing approval > question > unread precedence, and the working dot is _independent_ of it,
  because at project scope "waiting" and "working" are not exclusive.
- **The project card** replaced the conversation card: folder, settings, and the project's
  conversations as rows.
- **Conversations became a `PaneTree`.** The inner arrangement is the _same type_ as the workspace
  layout, operated on by the _same functions_ — `layout.ts` is generic over
  `{ layout, panes, focusedPaneId }`. Four directions, four-group ceiling, collapse-on-empty, all of
  it shared rather than reimplemented. "Exactly the same as project level" is only guaranteed if the
  two are one behaviour.
- **The Editor switch** shows and hides a project's workbench, persisted per project as
  `workbenchHidden`. Stored as _hidden_, so the empty record means every editor is on.
- **The conversation strip** carries a `+` that starts a conversation in that group and an `×` that
  ends that conversation — the only door left to ending one.

### What was deleted, and what replaced it

| Deleted                                                              | Replaced by                                      |
| -------------------------------------------------------------------- | ------------------------------------------------ |
| Restart session (UI, IPC, runtime, `replaceSession`)                 | Nothing. End and start again.                    |
| Changes panel (`ChangesPanel`, `MonacoDiff`, 8 store actions, `⌘⇧G`) | The workbench's SCM view                         |
| Review panel (`ReviewPanel`, 7 workspace channels, the repo watcher) | The workbench's SCM view                         |
| Summary panel (`SummaryPanel`, `summary.ts`, `panelRequest`)         | Nothing.                                         |
| Spin off a side task (IPC + 145-line runtime method)                 | Nothing.                                         |
| End Session in the composer and the project card                     | The `×` on the conversation tab                  |
| Project settings in the composer                                     | The project card                                 |
| The Included chip and the context pill                               | Context is always sent                           |
| `#` file trigger                                                     | Nothing — it inserted a character no parser read |
| `SessionMenu` and its context                                        | The project card                                 |
| ~1,000 lines of orphaned CSS                                         | —                                                |

**`@chorus/workspace` survives**, and the reason is worth stating because it was nearly deleted on a
bad reading: `parseDiff` draws the transcript's diff cards, and `resolveWithinRoot`,
`canonicalRoot` and `projectRelativePath` are load-bearing in main. Only the _channels_ were dead.

**Exit criteria.** Every setting is asked once, at the project. Each irreversible action has exactly
one door. No Chorus surface reads git except the transcript's own diff cards. A project's
conversations split, drag and resize the way its panes do.

**User review gate.** Unmet. Nothing in this phase has been run, and it is the phase most in need of
being driven rather than typechecked — three of its bugs were visible only on screen.

---

## 6. Verification strategy

Nothing is run while this plan is being written. Implementation verification happens only when
Mohamad authorizes it, and at the phase gates rather than after every edit.

| Boundary | What must be proven                                                                        |
| -------- | ------------------------------------------------------------------------------------------ |
| Phase 0  | Branch, base SHA, worktree `git status`, archive inventory. No tests: there is no new code |
| Phase 1  | Real workbench + exact REH + four extension classes on all target OSes                     |
| Phase 2  | Project persistence, uniqueness, relocation and conversation binding                       |
| Phase 3  | Project tab/split algebra and background session lifetime                                  |
| Phase 4  | Workbench service golden paths against a real repository                                   |
| Phase 5  | Per-extension activation/golden action, not install alone                                  |
| Phase 6  | Real unsaved model, document-version conflict, approval, apply and undo                    |
| Phase 7  | Packaged daily journey, sidecar lifecycle and resource ceilings per OS                     |

Every runtime driver must attach to the process it started, using an ephemeral debug port. The
existing e2e warning about attaching to a stale Electron process applies unchanged.

---

## 7. What this plan deliberately does not promise

- Microsoft Visual Studio Marketplace access.
- Proprietary Microsoft extensions that reject non-Microsoft products.
- Byte-for-byte or bug-for-bug parity with Microsoft VS Code.
- Remote SSH, Dev Containers, WSL, Codespaces or notebooks in the first local-workspace cut.
  Their service surfaces may ship earlier, but product support is a later approved phase.
- More than four simultaneously visible project workbenches.
- Migrating the old conversation database into the new project product.
- Preserving the current session-first UI during implementation.
- Reimplementing VS Code features with hand-built React panels when the Code-OSS service exists.
- Using the external editor bridge as evidence that the embedded workbench works.

---

## 8. Risks and decisions still visible

1. **Cross-platform meaning.** This plan reads the decision as macOS, Windows and Linux. If
   Mohamad meant only the two platforms Chorus currently packages, Phase 7 narrows before work.
2. **REH artifact matching.** VSCodium releases may not publish an artifact at the exact commit
   the latest CodinGame package expects. Building the MIT Code-OSS REH may become part of
   Chorus's release pipeline.
3. **Sandbox mode is beta, and nobody has shown two of these alive at once.** Multiple
   simultaneous workbenches are the largest integration risk and the first thing Phase 1 tries to
   falsify. The preflight sharpened this twice: the DOM-teardown mechanism first blamed applies
   only to a parent-DOM integration mode Chorus prohibits, and the surface is now a
   `WebContentsView`, which makes each workbench its own process rather than its own realm. What
   remains genuinely undemonstrated is the thing itself — the library's own demo reinitialises
   **one** — plus, newly, whether four bounds-driven overlays can track the shell's layout.
4. **Package size.** A full workbench, built-ins and REH will be much larger than current Chorus.
   This is an IDE distribution cost, but it must be measured and disclosed.
5. **Extension arbitrary code.** Extension support expands Chorus's local attack surface far
   beyond its current renderer. Workspace trust and source disclosure cannot be decorative.
6. **Installed list is not a priority list.** Treating all 81 ids equally is expensive. The
   compatibility ledger makes the cost visible; Mohamad may later mark a smaller release gate.
7. **Git ownership changes.** The current `packages/workspace` remains useful for agent summaries
   and handoffs, but the human SCM UI moves to Code-OSS Git. Two write paths must not race.
8. **Terminal ownership changes.** Existing session/global PTYs and REH terminals cannot both
   remain primary. Phase 4 chooses one project terminal authority.
9. **Clean database is still recoverable.** The old file is retained but unsupported. If it is
   ever imported, that is a separate migration plan.
10. **A wrong name survives a re-key where a wrong type does not — and this plan hit it five
    times.** `activeTabId` changed from a conversation id to a project id in Phase 3, and
    `useActiveConversationId`, the tab strip's `onClick`, its `onPointerDown`, `replaceSession` and
    `removeSession` all went on compiling against a value that had changed meaning. Every one
    failed _silently_: activating an absent tab is a no-op, closing an absent tab is a no-op, and
    the drag's insert branch cheerfully built a pane out of a conversation id. The only one that
    ever raised was the one that reached `ProjectService.resolveRoot`, which refuses an unknown
    project. **When a field changes what it identifies, rename it in the same commit** — the
    compiler cannot help, and the failures are invisible until something validates.
11. **Deleting a feature is not finished when the button is gone.** Phase 9 removed nine, and each
    one left a tail: a store slice, a schema field, an IPC channel, a runtime method, a watcher
    with no caller, plural i18n keys, a hundred lines of CSS. Two near-misses are worth recording —
    a `review.diffCapped` filter dropped `_one`/`_other`, which typecheck cannot see because a
    missing translation is a runtime string; and a dead-CSS sweep by grep would have removed
    `voice--claude` and `tok--keyword`, which are built with template literals and are invisible to
    it. **Delete by ownership, never by absence of references.**

---

## 9. Governance

**Codex owns technical direction and phase approval.** The architecture in §2, the phase
boundaries, and whether a phase is done are its calls. A phase that drifts from the plan is its
finding to make.

**Claude implements one phase at a time and stops.** No phase begins before the previous one is
approved. Deviations are reported plainly rather than absorbed, and the complete diff is handed
over for review — not a summary of it.

**Mohamad decides product, permissions and anything destructive.** Scope, what the product is
for, and the manual UI review gate above. Also every action with consequences outside this
branch: commits, builds, installs, app launches, deleting the old database, and any mutation of
the archived worktree. No amount of technical agreement authorizes those.

**Routing.** Technical handoffs — diffs, findings, deviations — go **directly to Codex in the
shared conversation**. Mohamad is not a relay for them.

That is compatible with his own instruction, _"always ask me to coordinate between you and
codex"_, because the shared conversation **is** the coordination surface: he reads every exchange
in it, so addressing Codex directly is not routing around him. He retains the authority to
redirect at any point, and if he does, that governs.

**Why this is written down rather than assumed.** Twice in this project an agent reported an
authority the other end had never seen — a delegation from Mohamad that reached one participant
and not the other. Both were caught because the claim was checked rather than believed. A written
rule is cheaper than a repeat, and the habit that goes with it is: an instruction attributed to
someone who is present is worth confirming with them. Not because anyone is suspected, but
because a relay can drop a message and nobody finds out until something has been built on it.

---

## 10. Approval meaning

Approving this plan authorizes implementation in phases, beginning with the Phase 1 architecture
gate — Phase 0 is the clean baseline and is already done, so there is no reconciliation step. It does not authorize tests, builds, app launches, downloads,
commits, deletion of the old database, or destructive removal of the current bridge unless
Mohamad separately authorizes those actions when their phase arrives.

The plan stops after every phase for review. Whenever a reviewable UI exists, the stop includes
an explicit request for Mohamad to open and judge it, with concise instructions for reaching the
new flow. A failed Phase 1 returns with evidence and a new architecture decision; it does not
quietly fall back to Theia or a fork.

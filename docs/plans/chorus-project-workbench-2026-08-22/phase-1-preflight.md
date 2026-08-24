# Phase 1 preflight — what is true before anything is downloaded

**Read-only brief for [`plan.md`](./plan.md) Phase 1 · written 2026-08-22 · revised 2026-08-22
after five rounds of Codex review · worktree `/Users/mohamadtaleb/code/chorus-workbench` · branch
`revamp/project-workbench`**

Nothing in this brief was downloaded, installed, built, launched or tested. Every external
claim is a URL; every claim about this repository is a `file:line`. Everything that could only
be answered by fetching a tarball or starting a process is named in
[§9 The authorisation list](#9-the-authorisation-list) instead of guessed.

> **The headline, before the detail.** The client and the server Phase 1 wants to pin **do not
> exist at the same upstream commit today**, and one of the six platform/architecture artifacts
> **does not exist at all**. Both are findings about the world, not gaps in the research, and
> both bear directly on the plan's own kill gate.

### What the fifth review round changed, and where

**Two corrections, and both are the same defect in two places: a detail round 4 added to make a
correction concrete was itself unexecutable.** Round five's verdict was that these were the last
two items before approval. Neither changes the architecture; both change a step someone would
otherwise have tried to run.

| #   | Correction                                                                                                                                                                                                                                                                                                                     | Where                 | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **The 60-second probe could not test cross-project shortening.** `shortGraceTime` is `min(300 s, graceTime)`, so at `--reconnection-grace-time 60` it **equals** `graceTime` — opening project B reschedules a timer that is already later than the one running, and the assertion passes against a mechanism it never engaged | **§5.4**, §7.2, §9 C7 | **Yes** — the proof is split into **two runs**. `60` proves reattachment inside the window and expiry after it. Shortening moves to a value **above the 300 s clamp** and is run at **`--reconnection-grace-time 900`** — 360 s is only the arithmetic floor, not the value to use — with a **no-B control** and a **B-connect case** read at one observation point: control still attachable, case expired. The timing constraint `T + 300 s < graceTime` is derived rather than assumed |
| 2   | **Invalid-destination recovery was unreachable.** Step 7 re-extracted an invalid final directory; step 6's rename cannot succeed while that non-empty directory stands, and forbade removing it — so the loop never terminates                                                                                                 | **§3.5** property 3   | **Yes** — an eighth step: **atomic quarantine**. Rename the invalid destination to a unique quarantine sibling, rename the temporary tree into the final path, and on a lost race **restart by validating the current final receipt**. **Never recursively delete a destination in the publish path**; quarantine cleanup is separate and restartable                                                                                                                                     |

**Both corrections are retractions of round 4, and the pattern they belong to is now the most
reproducible finding in this document.** Round 3 introduced two claims while fixing others; round 4
introduced two more — this is them. In both cases the argument being repaired was right and the
**number or step written to make it concrete** was not checked against the source it came from: the
`60` was chosen to make expiry reachable without re-reading the clamp quoted two paragraphs above
it, and the quarantine gap went unnoticed because steps 6 and 7 were each correct about the case
their author had in mind. **The mitigation that works is to evaluate every figure and every
sequence a correction introduces as a separate act from writing the prose around it**, which is how
both of these were found and is why the arithmetic is now shown rather than stated.

**Correction 1 also turned up something the review did not report.** The shortening loop walks
`_managementConnections` and `_extHostConnections` and **never reaches a `PersistentTerminalProcess`** —
a terminal's short timer is armed only by the client-initiated `ReduceConnectionGraceTime`. So
"opening B shortens A's window" is proven at the **connection** layer, and whether it reaches A's
**terminals** is a separate cascade question that remains **UNVERIFIED**. The two windows are the
same length only because the
same `min()` expression is evaluated at both layers, which makes it easy to prove one and report
the other. §5.4 now separates them.

### What the fourth review round changed, and where

**Two corrections, both of which change a conclusion, and the first of them retracts a table the
_third_ round wrote.** Round four's verdict was that the architecture is coherent; these were the
last two items standing.

| #   | Correction                                                                                                                                                                                                                                                                | Where                 | Outcome                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Round 3's connection-set lifecycle table was impossible as written** — it had a project's connection set living from project-open to project-close "whether or not a surface is mounted", but those are the **surface's own** WebSockets and die with its `WebContents` | **§5.4**, §7.2, §9 C7 | **Yes** — three honest lifetimes: a **server lease** (open→close), a **live client connection set** (mount→unmount), and **server-retained state** whose survival is **UNVERIFIED** and gated on the remount probe. **Refcounting alone cannot preserve the promise**, and the fallback is now named explicitly                     |
| 2   | **Extraction was not transactional** — the prose promised the manifest hash and the receipt example omitted it, and nothing ordered verify/extract/patch/receipt/rename                                                                                                   | **§3.5** property 3   | **Yes** — `manifestSha256` added, and a seven-step normative order whose property is that **an interrupted or malicious extraction cannot become a valid-looking runtime**. A directory without a valid matching receipt is unusable. **Round 5 adds an eighth step**, because rejecting such a directory left no way to replace it |

**Both corrections turned up a further problem that was not in the report.** Reading the server's
own source to settle correction 1 found that the REH **shortens a disconnected connection's grace
period when a new connection arrives** — so opening a second project degrades an
already-disconnected one's retention window, which is the exact bug round 3's refcount was written
to prevent, one level down where the refcount cannot reach, and a direct consequence of sharing one
REH. **Round 5 bounds that finding twice**: it fires **once** rather than on every subsequent
connection — there is an early return when the second runner is already scheduled — and it is
established at the **connection** layer only, whether it reaches that project's terminals being
**UNVERIFIED**. The same reading of the source also
found that round 3's probe instruction — "wait past the grace period" — was **unrunnable**, the
default being three hours. And correction 2's rename step is not unconditionally atomic: POSIX
`rename` **fails** on a non-empty destination, so a populated final directory has to be read as
"another extraction won the race" rather than removed and retried. All three are argued in place.
**Round 5 then found that both of round 4's own replacements were unexecutable** — the 60-second
probe cannot engage the shortening it was written to test, and "read a populated destination as a
won race" has no answer when the occupant is invalid; see the round-five section above.

### What the third review round changed, and where

**Seven corrections were returned against the twice-revised brief. Six of them changed a
conclusion, and two retract claims the _previous_ rounds introduced — the deep import in round
two's rewritten atomic-version test cannot resolve, and the provenance check round one and two
both left standing reads a field the artifact does not contain.** Recorded first because they
supersede parts of both tables below.

| #   | Correction                                                                                                                                                           | Where                                    | Outcome                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The workbench view had **no preload specified**, and Chorus's one preload exposes the entire `ChorusApi`                                                             | **§4.1b**, §4.2, §4.3, §9 B8             | **Yes** — a dedicated `apps/desktop/src/preload/workbench.ts`, its build entry and a one-method API are specified. The omission is round-2 blocker 2's shape one layer in                                                                                                                                                              |
| 2   | Delivery was left as "ordinary `ipcMain`", which says who may speak but not **when** — an early send is lost and a reload is never answered                          | **§4.1b**, §4.2, §7.2, §9 B8, §10        | **Yes** — main pushes after the view's own load, **the preload buffers**, a pull answers a reload, and every descriptor is bound to one project/view by `event.sender`                                                                                                                                                                 |
| 3   | Round 2's rewritten atomic-version test imports a specifier that cannot resolve — it doubles both `src` and `.js`                                                    | **§3.5**, §1.1                           | **Yes** — the published export map is `"./vscode/*" → "./vscode/src/*.js"`; the correct specifier is given below and round 2's is retracted                                                                                                                                                                                            |
| 4   | Provenance was read from the unpacked server, which **does not contain its upstream commit** — and a patched handshake commit cannot prove which artifact is running | **§2.3**, **§3.5**, §5.4, §7.2, §10      | **Yes** — the manifest is generated from the release's own `upstream/stable.json`, the artifact checksum is verified, and a **Chorus-owned extraction receipt** replaces asking the server                                                                                                                                             |
| 5   | The file table still said "one project, one server, no multi-project pooling", contradicting §4.1a's shared REH                                                      | **§4.2**, §5.4                           | **Yes** — one shared server, refcounted by **projects requiring REH state, not visible views**. **Partly superseded by round 4**: the "per-project connection set" it introduced could not outlive the surface, and "closing an inactive surface cannot kill retained terminals" is a claim about the _server_, not about the refcount |
| 6   | `plan.md` still made a Linux **packaging target** a Phase 1 prerequisite                                                                                             | plan Phase 1                             | **Yes** — Phase 1 needs a Linux machine or dev environment. Round 2 corrected §9 D2 and missed the plan's own copy of the same sentence                                                                                                                                                                                                |
| 7   | Three wordings claimed more than the evidence supports                                                                                                               | §4.1a, §5.2, §8.2, §8.3 R7, §9 A1, §9 E6 | **Yes** — **one** dedicated workbench partition, not one per view; shared REH is the chosen upstream-supported, lower-marginal-cost topology with **measurement still deciding**; A1 names `1.121.03429`                                                                                                                               |

**What that means for the two tables below.** Round two's blocker 2 established that a
`WebContentsView` inherits none of the shell's session controls and specified them; **it stopped
at the session and did not follow the same reasoning to the preload**, which is selected in the
same `webPreferences` object and is the larger exposure of the two — correction 1 finishes that
work. Round two's blocker 3 correctly replaced a test that read `package.json` with one that reads
the compiled product module, and **wrote the module's tarball path where an import specifier
belongs**; correction 3 fixes the specifier without disturbing the conclusion. Round one's §7.2
row and round two's §5.4 row both treated the server's own reported commit as an identity
assertion; correction 4 retracts that, and the retraction is the third time a claim in this brief
has survived a round of review by being read as obviously true.

### What the second review round changed, and where

**Six blockers were returned against the revised brief. Five of them changed a conclusion, two
demanded a decision this brief had deferred, and one retracts a claim the first review round had
itself introduced.** Recorded first because they supersede parts of the round-one table below.

| #   | Blocker                                                                                                                                                     | Where                                 | Outcome                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Surface (A) was internally contradictory: "separate-origin" _and_ `frame-ancestors 'self'`, and child-frame IPC needs `nodeIntegrationInSubFrames`          | **§4.1a**, §4.2, §4.3, §5.2, §10      | **Decided — surface (B), Electron `WebContentsView`.** (A) has no delivery mechanism that satisfies its own invariant                   |
| 2   | A `WebContentsView` does **not** get its own session. Without `session`/`partition` it uses `defaultSession`; Chorus's CSP is applied to `defaultSession`   | **§5.2**, §4.2, §9 B4/B6              | **Yes** — a dedicated partition is now specified, and the omission was a silent security regression                                     |
| 3   | The §3.5 atomic-version test cannot work: the published package has **no `config` field at all**. The identity that survives is the compiled product module | §1.1, **§1.5a**, **§3.5**, §10        | **Yes** — the test is rewritten against exported identity, and §1.5a's premise is retracted                                             |
| 4   | The prototype specified **one** REH and **one** hard-coded root while R7/C7 claimed to test two projects                                                    | **§4.1**, §5.4, §8.3 R7, §9 C7, §10   | **Decided — one shared REH, one connection and one forked extension host per project, two distinct roots**                              |
| 5   | R3 cannot gate a phase that bundles nothing — there is no installed candidate to compare against                                                            | §8.1, **§8.3**, §8.5, §9 A10, plan §7 | **Yes** — R3 moves to packaging/Phase 7; A10 stays but is no longer urgent, and no longer claims the baseline is lost                   |
| 6   | Four threshold contradictions: R7's ceiling proves nothing marginal; R9 is both advisory and mandatory; R11 measures a withdrawn hazard; D2 packages        | §4.4, **§8.3** R7/R9/R11, §8.4, §9 D2 | **Yes** — R7 becomes a marginal-cost test, R9 becomes non-gating, R11 is redefined across processes, D2 provisions rather than packages |

**What that means for the round-one table.** Corrections 1 and 8 below are partially superseded:
round one replaced the token mechanism with a **choice** between two surfaces, and blocker 1 shows
that choice was never real, because one of the two candidates cannot be built as described. Round
one's R3 correction fixed the units and left the row in the Phase 1 gate; blocker 5 removes the
row from that gate entirely. Both are marked in place.

### What the first Codex review changed, and where

Nine corrections were returned against the first draft. **Four of them changed a conclusion**,
which is why each is argued in place rather than edited away — a brief that quietly changes its
mind teaches the next reader nothing, and three of these were mistakes worth being able to
recognise again.

| #   | Correction                                                                                                                                   | Where                                   | Conclusion changed?                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| 1   | The design leaked the connection token to the outer renderer while forbidding exactly that. Replaced with a main-owned isolated surface      | §4.1, **§4.1a**, §4.2, §5.2, §5.3, §5.5 | **Yes** — mechanism withdrawn and replaced                         |
| 2   | The `[data-vscode]` teardown hazard applies only to parent-DOM integration, which Chorus can simply prohibit                                 | §4.4, §8.3 R12, §8.4                    | **Yes** — R12 kept, but no longer expected to fail                 |
| 3   | A browser-capable extension preferring `ui` is not forced into the REH. The web-host proof class is restored                                 | §6.1, §6.2, §6.3, §6.6                  | **Yes** — four proof classes, not three                            |
| 4   | "Exactly one match" scoped to the versions enumerated; `33.0.0` was never published, the candidate is `33.0.9`                               | §0 F3, §1.2, §2.4, §3.5                 | Narrowed, and a bad pin caught                                     |
| 5   | Execution order: serverless `36.1.1` containment probe → matched `33.0.9`+`1.121.03429` REH proof → coexistence repeated on the matched pair | **§2.5**, §8.4, §9 C7                   | Reframed — the pin was the wrong question                          |
| 6   | Four decisions recorded as settled rather than open                                                                                          | §2.2, §7.1, §9 E                        | No — made explicit                                                 |
| 7   | Fixtures before proprietary extensions; #804's views bug is **not proven** against a full `WorkbenchService`                                 | §6.4, §6.6, §9 C3                       | **Yes** — a cited defect demoted                                   |
| 8   | R3 compared installed size against a compressed DMG; the REH-build/`npmRebuild` collision was overstated                                     | §3.4, §8.1, §8.2, §8.3 R3               | Yes — a threshold withdrawn, a rule violation downgraded to a cost |
| 9   | A duplicated §1.5 passage removed; `plan.md` and `STATUS.md` updated                                                                         | §1.5                                    | No                                                                 |

---

## 0. The four facts that decide the phase

| #   | Fact                                                                                                                                                                                                                                                          | Where it bites                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | `@codingame/monaco-vscode-api@36.1.1` is built against VS Code **1.128.1** (`5264f215…`). The newest VSCodium release is **1.126.04524**, built from VS Code **1.126.0** (`7e7950df…`). **No exact-match REH exists.**                                        | Kill-gate bullet 1: "no legally redistributable exact-match REH can be produced"                                                                                                                                                                                                    |
| F2  | VSCodium has **never published `vscodium-reh-win32-arm64`** — not in the current release, not in any of the last 30.                                                                                                                                          | Plan §7's "Windows arm64 only if every native and REH artifact exists". It does not.                                                                                                                                                                                                |
| F3  | Across the versions §1.2 enumerates, exactly **one** client/server pairing matches on the upstream commit: `monaco-vscode-api@33.0.9` ↔ VSCodium `1.121.03429`, both VS Code **1.121.0** (`987c9597…`).                                                       | It is also the pairing that produced a live open upstream defect (§6.4)                                                                                                                                                                                                             |
| F4  | The server's version check is `if (rendererCommit && myCommit)` — **it is skipped entirely if either side sends no commit**. _Round 2: the claim that this is the client's default is **retracted** — the shipped client hardcodes its commit (§1.1, §1.5a)._ | Kill-gate bullet 6: "client/server updates cannot be made atomic". **Nobody has yet observed the check fire in this client** (§9 A6), and §2.3 shows a VSCodium server can never satisfy it unpatched — so §3.5's manifest equality, not the handshake, is what enforces atomicity. |

**And the fact that makes F1 and F2 a decision rather than a dead end.** Microsoft publishes a
prebuilt REH at the exact pinned commit, for **every** platform Phase 1 wants — including
`server-win32-arm64`, which VSCodium has never built — already stamped `stable` +
`5264f215…`, needing no patch and no toolchain. It is one URL away, and **its licence forbids
both bundling it and, arguably, using it from a non-VS-Code client** (§3.1a). So F1 and F2 are not
"this cannot be built"; they are "the thing that would work is the thing we have decided not to
use". That distinction should be visible at the gate, because the pressure to reverse it will
arrive the first time a Windows-on-ARM build is asked for.

---

## 1. Exact versions

### 1.1 The client pin

| Field                        | Value                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| Package                      | `@codingame/monaco-vscode-api`                                                                    |
| Version to pin               | **36.1.1**                                                                                        |
| Published                    | 2026-08-17                                                                                        |
| Licence                      | **MIT**                                                                                           |
| npm `dist.unpackedSize`      | **34,397,421 B** (~34.4 MB) across **5,143 files**                                                |
| npm `dist.integrity`         | `sha512-rhAREzP0YAS8SmbHQPaenpQ5O7dr3yGS2N8oJRlPPVQmrn3/SPIGe0ln+AT/mrxWX//RQKu3Sxm8FZG+WP/zDg==` |
| **Upstream VS Code version** | **1.128.1**                                                                                       |
| **Upstream VS Code commit**  | **`5264f2156cbcd7aea5fd004d29eaa10209155d66`**                                                    |

**The field that records it is `config.vscode` in the package's `package.json` _in the source
repository_** — an object with `version` and `commit`. The italics are the round-2 correction
below: it is a build input and it does not ship.

```json
"config": {
  "vscode": {
    "version": "1.128.1",
    "ref": "1.128.1",
    "commit": "5264f2156cbcd7aea5fd004d29eaa10209155d66"
  }
}
```

**The client's `quality` is hardcoded, and it is `stable`.** Not configuration — a build-time
substitution in `rollup/tools/vscode.ts` that replaces VS Code's own `product.js` module:

```js
if (id.endsWith('vs/platform/product/common/product.js')) {
  return `
import productJson from 'vscode/product.json'
export default {
  ...productJson,
  quality: 'stable',
  version: '${vscodeVersion}',
  commit: '${vscodeCommit}',
  ...
}`
}
```

So the client's identity is fixed at `stable` + `5264f215…` unless overridden through
`configuration.productConfiguration` or `globalThis._VSCODE_PRODUCT_JSON`. **Both `quality` and
`commit` must match on the server**, and §1.3 explains that they fail in two different ways.

**Read it from the git tag, not from the npm registry.** The registry's per-version document at
`https://registry.npmjs.org/@codingame/monaco-vscode-api/36.1.1` returns `"config": null`.
CodinGame's own documentation says to read the tag, and that is the only method that works:

```bash
curl -sL https://raw.githubusercontent.com/CodinGame/monaco-vscode-api/v36.1.1/package.json \
  | jq -r '.["config"]["vscode"]["commit"]'
```

— <https://github.com/CodinGame/monaco-vscode-api/blob/main/docs/vscode_server.md> (the doc adds
that the field exists from version 3.2.3 onward).

> **Correction (Codex review round 2, 2026-08-22) — "stripped from registry metadata" was the
> wrong diagnosis, and §3.5 was built on it.** The revised draft wrote that the field "is stripped
> from _registry metadata_", which implies it survives in the tarball and can be read back out of
> `node_modules`. **It does not survive.** The published package's own `package.json` has **no
> `config` key at all** — verified against the file as served from the tarball at
> <https://unpkg.com/@codingame/monaco-vscode-api@33.0.9/package.json>, whose complete top-level
> key set is `name, version, private, description, keywords, license, author, repository, type,
dependencies, main, module, exports, typesVersions`. `config` is not in it, and no `vscode`
> field appears anywhere in the manifest. The field exists only in the **source repository** at
> the tag; it is consumed by the build and does not ship.
>
> **What does ship is the identity itself, compiled in.** The `product.js` substitution quoted
> above is not merely a description of the build — it is a file in the published package, at
> `vscode/src/vs/platform/product/common/product.js`, and for 33.0.9 it reads, in full:
>
> ```js
> import productJson from '../../../../../product.json.js'
>
> var product = {
>   ...productJson,
>   quality: 'stable',
>   version: '1.121.0',
>   commit: '987c9597516278c9fcf10d963a0592ce1384ab93',
>   date: '2026-05-26T10:06:00.390Z',
>   ...(globalThis._VSCODE_PRODUCT_JSON ?? {}),
> }
>
> export { product as default }
> ```
>
> — <https://unpkg.com/@codingame/monaco-vscode-api@33.0.9/vscode/src/vs/platform/product/common/product.js>
>
> So the installed package **can** be asked what it is; it just cannot be asked through
> `config.vscode`. §3.5's second test is rewritten against this module, and §1.5a's central claim
> does not survive reading it.

**Verified against upstream.** `refs/tags/1.128.1` in `microsoft/vscode` resolves to
`5264f2156cbcd7aea5fd004d29eaa10209155d66`, authored 2026-07-13. The commit is real and it is
the release tag, not a branch tip.

### 1.2 The version→commit map, so the pin can be moved deliberately

| `monaco-vscode-api` | VS Code version | Upstream commit   | A VSCodium release at that upstream tag? |
| ------------------- | --------------- | ----------------- | ---------------------------------------- |
| 30.0.0              | 1.114.0         | `e7fb5e96c073…`   | ✗                                        |
| 31.0.0              | 1.117.0         | `10c8e557c8b9…`   | ✗                                        |
| 32.0.0              | 1.120.0         | `0958016b2af9…`   | ✗                                        |
| **33.0.3 – 33.0.9** | **1.121.0**     | **`987c959751…`** | **✓ `1.121.03429`**                      |
| 34.0.0 – 34.1.3     | 1.124.2         | `6928394f91b6…`   | ✗                                        |
| 35.0.0              | 1.128.0         | `fc3def6774c7…`   | ✗                                        |
| 35.0.1 – **36.1.1** | **1.128.1**     | **`5264f21…`**    | **✗ — this is F1**                       |

> **Correction (Codex review, 2026-08-22) — what "exactly one match" is scoped to, and a version
> that does not exist.** The first draft wrote this row as `33.0.0 – 33.x` and then pinned
> **`33.0.0`** in §2.4 and in the §3.5 manifest. **`33.0.0` was never published.** The registry's
> 33.x line begins at **`33.0.3`** (2026-05-22) and ends at **`33.0.9`** (2026-05-26) — seven
> releases, verified against
> `https://registry.npmjs.org/@codingame/monaco-vscode-api` on 2026-08-22. A manifest pinning
> `33.0.0` would have failed to resolve at the first `pnpm install`. **The matched candidate is
> `33.0.9`**, the newest of that line, and every downstream mention now says so.
>
> The same check scopes the headline claim. The package has **441 published versions**; this
> table samples **seven** of them. So "there is exactly one pairing that matches today" is true
> **of the versions enumerated here**, not of the whole registry — the 400-odd versions below
> 30.0.0 were never checked against VSCodium's release history and this brief makes no claim
> about them. The scoped statement is still the one that matters, because Phase 1 will not pin a
> two-year-old client; but it is a narrower fact than the first draft asserted.

Two things this table says that a version number alone does not:

- **The two release trains do not step in the same places.** CodinGame skipped 1.126 entirely
  (34.x is 1.124.2, 35.x jumps to 1.128.0); VSCodium skipped 1.124 entirely (1.121 → 1.126).
  Their intersection is not "usually one version behind" — it is sparse, and being sparse is a
  structural property, not this month's bad luck.
- **`34.1.3` has a corrupt `config.vscode.commit`.** It reads `"1.124.2"` — the version string
  where a SHA belongs — while 34.1.0–34.1.2 all carry `6928394f91b684055b873eecb8bc281365131f1c`.
  Anything that reads this field must reject a value that is not 40 hex characters, or it will
  silently pin a server to a string that can never match.

### 1.3 Why client and server commit must match

The remote-extension-host protocol is not versioned independently of the build. Client and
server exchange a `commit` and a `quality` during connection setup, and the client's own
`product.json`-equivalent (`configuration.productConfiguration.commit` when initialising
monaco-vscode-api) is what it presents. CodinGame states the requirement plainly:

> "The commit and product quality should be the same on the client and on the server."
> — <https://github.com/CodinGame/monaco-vscode-api/blob/main/docs/vscode_server.md>

The mechanism behind it is that the client fetches remote extension-host bootstrap code, web
resources and webview resources **from the server**, keyed by `<quality>-<commit>` path
prefixes — the same doc describes fronting a cluster with a reverse proxy that routes on exactly
that prefix, which is only necessary because the prefix is load-bearing. A mismatch is therefore
not a compatibility warning; it is a resource path that does not resolve.

### 1.4 What the failure looks like — read out of the server, not inferred

The check is in `src/vs/server/node/remoteExtensionHostAgentServer.ts` at tag `1.128.1`, in the
WebSocket handshake, on the **second** message (`connectionType`):

```ts
const rendererCommit = msg2.commit
const myCommit = this._productService.commit
if (rendererCommit && myCommit) {
  // Running in the built version where commits are defined
  if (rendererCommit !== myCommit) {
    return rejectWebSocketConnection(`Client refused: version mismatch`)
  }
}
```

So the failure is **clean, server-side, and legible**: the WebSocket is refused with
`Client refused: version mismatch`. The server sends `{ type: 'error', reason }` on the control
channel and disposes the socket; the client surfaces it as
**`Connection error: Client refused: version mismatch`** with `error.code = 'VSCODE_CONNECTION_ERROR'`
(`src/vs/platform/remote/common/remoteAgentConnection.ts`). It happens _after_ the token check on
the first message, which refuses with `Unauthorized client refused: auth mismatch` — so the two
failures are distinguishable, which matters when debugging a sidecar that will not connect.

**There is a second, quieter mechanism, and this is the one that swallows `quality`.** Every HTTP
resource the client fetches from the server is prefixed with a product path segment
(`src/vs/base/common/network.ts`):

```ts
export function getServerProductSegment(product: { quality?: string; commit?: string }) {
  return `${product.quality ?? 'oss'}-${product.commit ?? 'dev'}`
}
```

The server mounts under it; the client computes the same string from its own product config and
prefixes every `vscode-remote-resource` URL with it. For the pinned client that segment is
literally `stable-5264f2156cbcd7aea5fd004d29eaa10209155d66`.

The server's routing is deliberately lenient — it strips the prefix if it matches and otherwise
falls through — so **a wrong prefix produces `404` with a body of `Not found`, not an error that
names the version.** The WebSocket upgrade path is never inspected at all, so a `quality`
mismatch does not break the socket; it breaks resource loading afterwards. That is the "404 storm
with no legible cause" failure, and it is why `quality` has to match even though the handshake
never compares it.

**But read the guard, not just the comparison.** The check is wrapped in
`if (rendererCommit && myCommit)`. **Either side leaving its commit undefined disables the version
check entirely.** That is deliberate upstream — it is how a development build talks to anything —
and it is the single most dangerous fact in this brief.

### 1.5 The two ways to disarm the check, and why both are forbidden

There are exactly two, and one of them requires no effort at all.

**(a) Omit the client's commit — and this is where the revised draft was wrong.**
monaco-vscode-api takes `configuration.productConfiguration.commit` at initialisation. The
revised draft concluded: leave it out and `rendererCommit` is `undefined`, the guard
short-circuits, and **any server of any version will accept the connection**.

> **Correction (Codex review round 2, 2026-08-22) — the premise is retracted, and the retraction
> reverses which case is dangerous.** That conclusion was reasoned from the server's guard alone,
> without reading what the client's product actually holds when nothing is configured. §1.1 now
> quotes the shipped module, and the last line of it is the one that matters:
>
> ```js
> ...(globalThis._VSCODE_PRODUCT_JSON ?? {})
> ```
>
> `commit` is **hardcoded above that spread**, and an object spread cannot remove a key — an
> override lacking `commit` leaves the compiled value standing. So the unconfigured client does
> not present `undefined`; it presents **its own true build commit**, which is precisely the value
> the manifest wants it to present. **Omission is the safe default, not the disarming case.**
>
> The dangerous case is the opposite one, and it is the one that has to be guarded: **explicitly
> setting `productConfiguration.commit`** — to a stale manifest value, to a value read from the
> server, or to `undefined` — is what can make the client assert something other than what it is.
> The rule inverts accordingly: **Chorus sets `productConfiguration.commit` only to the value the
> installed client already carries, and a test asserts the two are equal.** Setting it to anything
> else is forging the client's identity, which is §1.5b's prohibition pointed the other way.
>
> **Two things remain UNVERIFIED and both need A6.** Whether monaco-vscode-api routes
> `configuration.productConfiguration` into `globalThis._VSCODE_PRODUCT_JSON` at all or merges it
> elsewhere; and whether the remote-agent connection reads `product.commit` from this module when
> it builds `msg2.commit`. Until A6 runs, the honest statement is that **no version check has been
> observed firing in this client** — which is `CLAUDE.md`'s e2e-harness shape ("a test that counts
> panes to prove a shortcut was ignored can never fail") applied to a check nobody has yet seen
> reject anything. A6 was already the most important probe in §9; this makes it the probe that
> decides whether §3.5's manifest equality is the _only_ enforcement rather than the first of two.

**(b) Patch the server's `product.json` to claim the client's commit.** CodinGame's doc instructs
this, and for a genuinely matched pair it is _necessary_:

```bash
cat <<< "$(jq ".commit = \"<client commit>\"" product.json)" > product.json
```

The reason is real — VSCodium's `product.json` carries **VSCodium's own repository commit**, not
the upstream VS Code commit it was built from, so even a correct pairing will fail the comparison
until that one field is corrected. The doc calls it "critical for VSCodium".

**And that is exactly why F1 is dangerous rather than merely inconvenient.** The same one-line
edit that makes a _correct_ pairing work will also make an _incorrect_ one connect. Patching a
1.126.0 server to claim `5264f21…` does not make it a 1.128.1 server; it makes a 1.128.1 client
talk to a 1.126.0 server with the only version check in the system disarmed, and the divergence
then surfaces as undefined behaviour somewhere in the extension-host protocol, weeks later, in a
way no error message will attribute to the commit.

**The rule, stated so it can be enforced rather than remembered:** Chorus may write
`product.json`'s `commit` **only** when `manifest.client.vscodeCommit === manifest.server.upstreamCommit`
already holds. The patch corrects a _branding_ field; it may never assert a _version_ fact. If
the manifest's two commits differ, the correct behaviour is to refuse to start, not to patch.

> **Editorial note (Codex review, 2026-08-22).** A near-identical restatement of (b) followed
> this paragraph in the first draft — the same `jq` command, the same "critical for VSCodium"
> quote and the same 1.126-versus-1.128 argument, written twice. The duplicate is removed; no
> claim was lost with it.

---

## 2. VSCodium REH artifact matrix

### 2.1 Where they are published, and what they are called

Every artifact is a GitHub release asset on `VSCodium/vscodium`:

```
https://github.com/VSCodium/vscodium/releases/download/<codium-tag>/vscodium-reh-<platform>-<arch>-<codium-tag>.tar.gz
```

with `<platform>` ∈ `darwin | linux | win32 | alpine`, `<arch>` ∈ `x64 | arm64 | …`, and
`<codium-tag>` the VSCodium release tag (e.g. `1.126.04524`). Every asset has sibling
`.sha256` and `.sha1` assets at the same URL plus that suffix.

There is a second family, `vscodium-reh-**web**-<platform>-<arch>-…`, which is the REH **plus the
web workbench**. Chorus supplies its own workbench from npm, so the **non-web `reh` is the
correct artifact** — the `reh-web` one would ship a second, unused copy of the entire workbench.

### 2.2 The matrix Phase 1 actually needs

Sizes below are from the release API's `size` field for the **1.121.03429** release (the only
commit-matched one — §2.4); the 1.126.04524 release has the same asset names.

| Target            | Artifact (at `1.121.03429`)                    | Compressed size | Exists?               |
| ----------------- | ---------------------------------------------- | --------------: | --------------------- |
| macOS arm64       | `vscodium-reh-darwin-arm64-1.121.03429.tar.gz` |    76,210,372 B | ✅                    |
| macOS x64         | `vscodium-reh-darwin-x64-1.121.03429.tar.gz`   |    77,647,076 B | ✅                    |
| Windows x64       | `vscodium-reh-win32-x64-1.121.03429.tar.gz`    |    75,712,669 B | ✅                    |
| **Windows arm64** | **`vscodium-reh-win32-arm64-…`**               |               — | ❌ **does not exist** |
| Linux x64         | `vscodium-reh-linux-x64-1.121.03429.tar.gz`    |    83,274,107 B | ✅                    |
| Linux arm64       | `vscodium-reh-linux-arm64-1.121.03429.tar.gz`  |    80,992,859 B | ✅                    |

**F2, stated precisely.** The current release publishes `vscodium-cli-win32-arm64`,
`VSCodium-win32-arm64-….zip` (the desktop app) and `vscodium-reh-win32-x64` — but no
`vscodium-reh-win32-arm64`. A search of the asset lists of the **last 30 releases** returns
nothing matching `reh-win32-arm64`. Windows-on-ARM is the one target where the desktop app
exists and the server does not.

Consequences, in order of preference:

1. **Narrow the target — and this is now the settled answer, not the first of four options
   (§9 item E3).** Plan §7 already conditions Windows arm64 on "every native and REH artifact
   exists". It does not. Declaring Windows arm64 out of the initial target costs nothing today —
   `electron-builder.yml:84-87` already builds Windows x64 only. Options 2–4 below are recorded
   as the routes that would reopen it, not as live alternatives.
2. **Run the x64 REH under Windows-on-ARM's x64 emulation.** Plausible, entirely **UNVERIFIED**,
   and it would need a real ARM Windows machine (§9 item D4).
3. **Build it.** `BUILD_TARGETS` in `build/gulpfile.reh.ts` **does** include `win32-arm64`, so a
   source build produces the artifact VSCodium does not. See §3.4 for what that costs.
4. **Use Microsoft's** — which exists for `server-win32-arm64` at the pinned commit, and is
   forbidden. §3.1a.

### 2.3 Where VSCodium's versioning does _not_ map onto a VS Code commit — the finding

**A VSCodium tag is not a VS Code version, and the release page does not tell you which commit it
is.** The tag `1.126.04524` decomposes as an upstream-ish `1.126.0` plus a build counter `4524`
that is VSCodium's own. The authoritative mapping lives in a file inside the repo at that tag:

```
https://raw.githubusercontent.com/VSCodium/vscodium/<codium-tag>/upstream/stable.json
```

| VSCodium tag  | `upstream/stable.json`                                                  |
| ------------- | ----------------------------------------------------------------------- |
| `1.126.04524` | `{"tag":"1.126.0","commit":"7e7950df89d055b5a378379db9ee14290772148a"}` |
| `1.121.03429` | `{"tag":"1.121.0","commit":"987c9597516278c9fcf10d963a0592ce1384ab93"}` |
| `1.116.02821` | `{"tag":"1.116.0","commit":"560a9dba96f961efea7b1612916f89e5d5d4d679"}` |
| `1.112.01907` | `{"tag":"1.112.0","commit":"07ff9d6178ede9a1bd12ad3399074d726ebe6e43"}` |

Three ways this gap bites, all of which the manifest in §3.5 has to close:

- **`product.json` inside the artifact records a commit that is not a commit.** VSCodium's
  `version.sh` sets `BUILD_SOURCEVERSION=$(echo "${RELEASE_VERSION/-*/}" | sha1sum | cut -d' ' -f1)`
  — **a sha1 of its own version string**. For `1.126.04524` that is
  `4c0b0c6cc561d2d3636d1ec250935431876ce4dc`, which is also the `version` field VSCodium
  publishes in `VSCodium/versions`. It is 40 hex characters, so it looks exactly like an upstream
  commit and will never equal one. **A VSCodium REH can therefore never satisfy the handshake
  check against any CodinGame client, at any version, without being patched** — the patch is not
  a workaround for the current version gap, it is permanent. That materially weakens §1.5's rule,
  because the "correct" case still requires the same edit as the incorrect one.
  The only trustworthy join between a VSCodium release and an upstream commit is
  `upstream/stable.json` at the release tag, fetched separately.

  **And no _other_ field in the artifact closes the gap either — corrected in review round 3.**
  It is tempting to assume `commit` is the one bad field and that `version` or some sibling still
  records the upstream tag. It does not: the REH build writes only `{ commit, date, version }`
  into the shipped `product.json` (`build/gulpfile.reh.ts:329-330` at tag `1.121.0`), and
  `prepare_vscode.sh:236` has already set the package version to the **VSCodium** release, so
  `version` reads `1.121.03429` rather than `1.121.0`. The forty-odd fields
  `prepare_vscode.sh:40-125` rewrites are branding, gallery and update endpoints. **The unpacked
  server therefore contains no statement of which VS Code it was built from, in any field**, which
  is why §3.5 now writes a Chorus-owned extraction receipt instead of interrogating it.

- **VSCodium themselves do not lie about the commit — they patch the check out.**
  `patches/00-remote-disable-client-validation.patch` adds a `--disable-client-validation` server
  flag wrapping exactly the block quoted in §1.4. The flag **does not exist in Microsoft's
  server**. That is worth knowing for two reasons: it is a cleaner mechanism than rewriting
  `product.json`, and its existence is upstream-adjacent evidence that the maintainers of the
  MIT build consider the check an obstacle rather than a guarantee.
- **VSCodium releases skip upstream versions.** The last fifteen stable releases are 1.108.1,
  1.108.2, 1.109.0/2/3/4/5, 1.110.0/1×3, 1.112.0, 1.116.0, 1.121.0, 1.126.0. There is no 1.124
  and no 1.128. "Wait for VSCodium to catch up" is not a plan with a date, because VSCodium may
  never publish the specific version CodinGame pinned.
- **Patch releases collapse.** CodinGame pins `1.128.1`; VSCodium's `upstream/stable.json` has
  only ever carried `.0` tags in the sample above. Even when the minor versions line up, the
  patch level may not.

### 2.4 The one pairing that matches today

| Side   | Package / artifact                                     | Upstream tag | Upstream commit                            |
| ------ | ------------------------------------------------------ | ------------ | ------------------------------------------ |
| Client | `@codingame/monaco-vscode-api@33.0.9` (newest of 33.x) | 1.121.0      | `987c9597516278c9fcf10d963a0592ce1384ab93` |
| Server | VSCodium `1.121.03429` → `vscodium-reh-*-1.121.03429`  | 1.121.0      | `987c9597516278c9fcf10d963a0592ce1384ab93` |

**Both sides are built from the same upstream tree.** That is the property that matters, and it is
the one the handshake cannot see — because VSCodium's `commit` is a sha1 of its own version
string (§2.3) and could never equal `987c9597…` no matter how well matched the build is.

So this pairing still needs the `product.json` edit, and the honest framing is: **the edit is
unavoidable with VSCodium at any version, so the manifest equality in §3.5 — not the handshake —
is what actually enforces correctness.** The server-side check becomes a second line of defence
that has been deliberately satisfied, rather than the primary guard. Chorus should therefore treat
`client.vscodeCommit === server.upstreamCommit` in its own manifest as the real gate, and refuse
to write `product.json` at all when that equality fails. VSCodium's own alternative —
`--disable-client-validation` — is cleaner in that it does not forge an identity, but it removes
the check entirely rather than satisfying it, so the manifest carries even more weight; either way
the burden lands in the same place.

It is also, independently, **the exact configuration in which a third party hit two real defects
in this architecture** — see §6.4. That is worth more than the version match: it is the closest
thing to a Phase 1 dry run that exists in public, and it was run by someone on Electron 41,
macOS arm64, React 19.

### 2.5 The execution order — settled, and it uses both versions

**Correction (Codex review, 2026-08-22).** The first draft framed the pin as a single either/or —
"33.x or 36.1.1" — and left it as an open question for the plan to answer. That was the wrong
shape of question, because the two things Phase 1 has to prove have different dependencies and
only one of them needs a server at all. The pin question is now **settled by an order** rather
than by a choice, and the ordering is itself the answer to §9 item E1.

**Step 1 — the disposable, serverless containment probe, on `36.1.1`.**
Two workbench surfaces in one Electron window, **no REH, no sidecar, no token, no download**: the
serverless configuration the library's own demo ships. What it proves is exactly the pair of
questions that do not involve a server — that a workbench renders inside its own document
(§4.4), and that **two of them coexist and survive one closing** (R12, and then R11). Because
nothing here talks to a server, the client/server commit gap is irrelevant, so this step runs on
the **current** release, `36.1.1`, and any defect it finds is a defect in the version Chorus
would actually want to ship. It is the cheapest step in the phase and it is first because R12 is
binary: if two surfaces cannot coexist, plan §2.4's whole product shape falls to its first
fallback and no server work was wasted proving it.

**Step 2 — the architecture proof, on the matched pair `33.0.9` + VSCodium `1.121.03429`.**
Everything that needs a real remote extension host: the sidecar, the token, the
`vscode-remote://` connection, Node extensions activating, terminal, Git, debug. This is the only
pairing assemblable from published artifacts without building anything (§2.4), and downgrade
risk is cheaper than build risk. The alternative — pin `36.1.1` and build the REH — moves a
toolchain into the release pipeline before the architecture has been proven at all, which
inverts the order the kill gate exists to enforce. Shipping on a two-releases-old workbench is a
Phase 5/7 problem, not a Phase 1 one.

**Step 3 — repeat the coexistence proof on the matched pair, and Phase 1 does not pass without
it.** Step 1's result is about `36.1.1` with no server attached; step 2 ships `33.0.9` with one.
Neither version nor topology carries over on its own, and the differences are the kind that bite:
three minor releases of a beta feature, plus a remote agent connection, plus per-frame WebSocket
and resource loading that step 1 never exercised. **R12 and R11 are therefore run twice** — once
cheaply to fail fast, once on the configuration Phase 1 is actually proposing. Only the second
run is evidence about the thing being shipped. Treating step 1's pass as the phase's coexistence
proof would be the same error as reading a green CI job as a packaged-app proof.

**What this changes about the two versions.** They are no longer competing candidates. `36.1.1`
is the falsification instrument for the containment claim; `33.0.9` is the pin the phase is
proposing. If step 1 fails on `36.1.1` and the mechanism is version-specific, that is itself a
finding worth having before a single byte of REH is downloaded.

---

## 3. Licensing, redistribution, URLs, checksums, atomic versioning

### 3.1 What may be redistributed inside a shipped Electron app

| Component                                                                             | Licence                                                                                                                                                                                                                                                        | Redistributable in Chorus's installer?                                        |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `@codingame/monaco-vscode-api` and its `@codingame/monaco-vscode-*` service overrides | **MIT** (npm `license: "MIT"`, v36.1.1)                                                                                                                                                                                                                        | **Yes** — it is an ordinary npm dependency compiled into the renderer bundle. |
| VSCodium `vscodium-reh-*` tarball                                                     | **MIT** — `LICENSE` reads "MIT License / Copyright (c) 2018-present The VSCodium contributors / Copyright (c) 2018-present Peter Squicciarini / Copyright (c) 2015-present Microsoft Corporation" (<https://github.com/VSCodium/vscodium/blob/master/LICENSE>) | **Yes in principle**, with the caveat in §3.2.                                |
| Microsoft's REH from `update.code.visualstudio.com/commit:…/server-*/stable`          | **Proprietary** — "MICROSOFT SOFTWARE LICENSE TERMS – MICROSOFT VISUAL STUDIO CODE SERVER"                                                                                                                                                                     | **No.** Never.                                                                |
| Extensions from Open VSX / user `.vsix` files                                         | Each carries its own licence                                                                                                                                                                                                                                   | **No** — download on the user's machine at runtime only.                      |

**The Microsoft server is excluded twice over, and the second reason is the stronger one.** The
licence says both:

> "You may not … host, share, publish, rent or lease the software; or provide the software as a
> stand-alone offering or combine it with any of your applications for others to use."

and

> "You may not use the software if you do not have a license for Microsoft Visual Studio Code."

— <https://code.visualstudio.com/license/server>

The first clause forbids bundling it. The second is about **use**, not distribution, and it means
a runtime download of Microsoft's server is not a workaround: Chorus is not Microsoft Visual
Studio Code, so the fallback "let the user fetch it themselves" does not obviously clear it
either. Plan §2.3 already reached this conclusion; this is the citation behind it. There is one
further tell that the intended client matters: the CLI requires `--accept-server-license-terms`
to start at all, and the gate is real code in `src/server-main.ts`. The OSS `product.json` at
1.128.1 carries `serverLicense: []` and `serverLicensePrompt: ""` — precisely because a Code-OSS
build has no licence to present.

#### 3.1a The tempting shortcut, named so it can be refused deliberately

**Microsoft publishes a prebuilt REH at the exact pinned commit, for every platform Phase 1
wants, including the one VSCodium does not build.** `HEAD` requests against
`https://update.code.visualstudio.com/commit:5264f2156cbcd7aea5fd004d29eaa10209155d66/<target>/stable`
(metadata only, nothing fetched):

| Target                                                                                       | Result                                                |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `server-darwin-arm64`                                                                        | 302 → `vscode-server-darwin-arm64.zip`, 174,593,413 B |
| `server-darwin` (**Intel Mac — `server-darwin-x64` 404s**)                                   | 302 → `vscode-server-darwin-x64.zip`                  |
| `server-linux-x64`                                                                           | 302, 188,607,694 B                                    |
| `server-linux-arm64` · `server-linux-alpine` · `server-win32-x64` · **`server-win32-arm64`** | 302                                                   |
| `server-linux-armhf`                                                                         | 404                                                   |

That build already carries `commit = 5264f215…` and `quality = "stable"`, which is an **exact,
unpatched match for monaco-vscode-api's hardcoded client product**. It would dissolve F1 and F2
in a single step, needs no `product.json` edit, and requires no toolchain.

**And it is exactly what the licence in the table above forbids.** Chorus may not bundle it, and
the "you may not use the software if you do not have a license for Microsoft Visual Studio Code"
clause makes the runtime-download route doubtful too. Note also, incidentally, that CodinGame's
own documentation gives the wrong URL template for Intel macOS — it says `<platform>-<arch>`,
which produces `server-darwin-x64`, which 404s.

This subsection exists because the shortcut is **one URL away and will be proposed**. Refusing it
is a decision the plan already made (§2.3); this is the record of what is being given up, so the
refusal is informed rather than uninformed.

### 3.2 The caveat on "VSCodium is MIT"

VSCodium's repository is MIT and its build is MIT-clean by construction — that is its entire
purpose. What is **UNVERIFIED** is the licence inventory of everything _inside_ the 76 MB
tarball: the bundled built-in extensions (Git, the language basics, the JS debugger), any
vendored native modules, and the `node` binary. Reading that inventory means unpacking the
archive, which is §9 item A3.

Until that is done, "the REH is MIT" is a claim about the VSCodium project, not a claim about the
file Chorus would ship. Chorus already carries a precedent for doing this properly — the vendored
Seti icon theme has a `seti-NOTICE.txt` beside it and is excluded from formatting so it stays
diffable against upstream (`.prettierignore:14-17`).

### 3.3 Where published checksums live

Every VSCodium release asset has two sibling assets:

```
https://github.com/VSCodium/vscodium/releases/download/<tag>/<asset>.sha256
https://github.com/VSCodium/vscodium/releases/download/<tag>/<asset>.sha1
```

Use the `.sha256`. **Do not use the GitHub API's `browser_download_url` alone as the identity of
the artifact** — a release asset can be replaced. The recorded sha256 is what makes the manifest
an assertion rather than a pointer, and it is checked after download and before first use, in
main, exactly the way `release.yml:130-144` refuses to publish an artifact it did not find by
name and checksum by name ("Named, never globbed. A glob that matches nothing succeeds, and an
empty upload is the failure that looks like a pass").

For npm, the checksum is `dist.integrity` in the registry document and is already enforced by
`pnpm-lock.yaml`; nothing new is needed on that side.

### 3.4 If the REH has to be built — the shape of the cost

This is the branch F1 forces if the pin stays at 36.1.1 and Microsoft's build stays refused. It
is entirely achievable, and here is what it costs.

**The command is one line.** `npm run gulp vscode-reh-<platform>-<arch>-min`, from
`build/gulpfile.reh.ts`. Output lands in `../vscode-reh-<platform>-<arch>` — a **sibling** of the
repo root, not inside it. Supported targets are win32 x64/arm64, darwin x64/arm64, linux
x64/arm64, alpine — **which does include `win32-arm64`, the one VSCodium never publishes.**

**One genuinely good property, and it is the reason this branch is not absurd:** the build stamps
`commit` from `BUILD_SOURCEVERSION`, falling back to `.git/HEAD`. So **a plain build from a git
checkout of tag `1.128.1` ships `commit: "5264f215…"` by itself**, with no environment variable
and no patching. The lie in §1.5b disappears entirely. (`quality` is _not_ set by the OSS build —
you set it to `stable` yourself, and VSCodium's `prepare_vscode.sh` does exactly that.)

**And here is the price.**

| Requirement                                           | Detail                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node                                                  | **Exactly 24.x** — `.nvmrc` pins `24.17.0` and `build/npm/preinstall.ts` enforces same-major, ≥ minor/patch. npm major < 12. yarn refused outright.                                                                                                                                                                                                                   |
| C++ toolchain                                         | Xcode CLT / VS 2022 Build Tools _with Spectre-mitigated libs_ / `build-essential g++ libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev`                                                                                                                                                                                                                           |
| Python                                                | for node-gyp                                                                                                                                                                                                                                                                                                                                                          |
| **Native modules compiled from source, deliberately** | `remote/.npmrc` sets `build_from_source="true"`. `build/npm/postinstall.ts` _deletes_ every `@parcel/watcher` prebuild after install, and `build/.moduleignore` strips `prebuilds/`. Compiled: **`node-pty`**, `@parcel/watcher`, `@vscode/spdlog`, `@vscode/sqlite3`, `kerberos`, `@vscode/native-watchdog`, `@vscode/deviceid`. **There is no prebuild-only path.** |
| Downloads during build                                | Node 24.17.0 from `nodejs.org/dist`, SHA256-verified against `build/checksums/nodejs.txt`. Electron _headers_ download regardless. Alpine targets need Docker.                                                                                                                                                                                                        |
| Time                                                  | **~17 min** wall clock for one Linux x64 REH on a hosted `ubuntu-22.04` runner, measured from VSCodium's own Actions run. Local first build on Apple Silicon **UNVERIFIED**, plausibly 30–60 min and 15–25 GB of disk.                                                                                                                                                |
| Per platform                                          | Multiply by three, or six with architectures.                                                                                                                                                                                                                                                                                                                         |

**What this actually costs, stated more carefully than the first draft stated it.** The first
draft said this branch "collides head-on" with `npmRebuild: false` and that Chorus would be
running "a build whose design principle is the inverse of the one it wrote down". **That
overstated it, and the correction matters because the overstatement would have ruled the branch
out for the wrong reason.**

`npmRebuild: false` (`electron-builder.yml:40-48`) governs one specific thing: whether
**electron-builder** re-runs `@electron/rebuild` over **Chorus's own** `node_modules` while
packaging the Electron app. It exists so the packaged app loads the same N-API prebuilds of
`better-sqlite3` and `node-pty` that `pnpm dev` loads, rather than a silently different binary.
A REH build compiles a **different tree, against a different runtime, for a different process** —
its own `node_modules`, against Node 24's ABI, producing a standalone server that Chorus's
Electron process never loads into itself. Nothing it compiles reaches the renderer or main
process. **So an isolated REH build does not violate `npmRebuild: false`, and does not put a
differently-compiled binary under the app.** The isolation is the condition, and it is
enforceable: its own pipeline, its own checkout, its own toolchain, and its output entering
Chorus only as a checksummed tarball named in the manifest — never as a workspace dependency and
never as something `pnpm install` can pull in.

The real price is the one the table above prices: **a second build pipeline**, with a C++
toolchain, a pinned Node, Python, Docker for Alpine, ~17 minutes per platform and six
platform/architecture combinations. `CLAUDE.md`'s _"There is no toolchain and no rebuild step.
Keep it that way"_ stays true of the **app bundle** and stops being true of the **release
pipeline as a whole** — which is a real cost, worth refusing on its own merits, but it is a
maintenance and release-engineering cost rather than a rule violation.

Two further notes if this branch is taken:

- **Driving VSCodium's pipeline at `MS_TAG=1.128.1` is not free either.** Their patch set is
  maintained against 1.126; expect rejects. One already-visible drift: `build/linux/package_reh.sh`
  contains `sed -i "/target/s/\"22.*\"/…/"`, which silently no-ops against 1.128.1's
  `target="24.17.0"` — a _silent_ no-op, which is the worst kind.
- **A raw Code-OSS build is not a VSCodium build.** `prepare_vscode.sh` also points
  `extensionsGallery` at Open VSX, removes telemetry endpoints, and disables extension signature
  verification (Open VSX extensions are not Microsoft-signed). Building "raw Code-OSS" yields an
  unbranded server pointed at no gallery at all.

Building the REH is therefore not a fallback to be taken quietly inside Phase 1. It is a
plan-level decision, and plan §8.2 already anticipates it ("Building the MIT Code-OSS REH may
become part of Chorus's release pipeline"). **This brief's position: do not take that branch to
save a version pin. Take the version pin.**

### 3.5 Making client + server one atomic fact

The plan's §3.2 asks for "one manifest". Concretely, `apps/desktop/build/workbench-runtime.json`,
**generated by a script and never hand-edited**, holding:

```jsonc
{
  "client": {
    "package": "@codingame/monaco-vscode-api",
    "version": "33.0.9",
    "vscodeVersion": "1.121.0",
    "vscodeCommit": "987c9597516278c9fcf10d963a0592ce1384ab93",
  },
  "server": {
    "vendor": "vscodium",
    "release": "1.121.03429",
    "upstreamTag": "1.121.0",
    "upstreamCommit": "987c9597516278c9fcf10d963a0592ce1384ab93",
    "artifacts": {
      "darwin-arm64": {
        "name": "vscodium-reh-darwin-arm64-1.121.03429.tar.gz",
        "size": 76210372,
        "sha256": "…",
      },
      // one entry per supported platform-arch; a missing entry is an unsupported target,
      // stated here rather than discovered at runtime (this is where win32-arm64's absence lives)
    },
  },
}
```

Four properties make it atomic rather than two numbers that drift:

1. **One equality is the invariant:** `client.vscodeCommit === server.upstreamCommit`. A unit
   test asserts it, and asserts both are 40 hex characters (which catches the `34.1.3` corruption
   from §1.2).
2. **A second test asserts the manifest matches the installed package** — and **how** it does that
   is a correction, not a detail.

   > **Correction (Codex review round 2, 2026-08-22) — the test as written could not have run.**
   > The revised draft said this test "re-reads `config.vscode.commit` from the resolved
   > `@codingame/monaco-vscode-api` in `node_modules`". **There is no `config` field in the
   > installed package** (§1.1): it exists in the source repository at the tag, is consumed by the
   > build, and does not ship. A test written that way fails on `undefined` at every run — which,
   > being a failure, would at least have been noticed, but it would have been read as a broken
   > test rather than as the wrong source of truth.
   >
   > **Test the exported identity instead**, which is what the client actually presents:
   >
   > ```ts
   > // Not package.json — the compiled product module is what ships and what the client asserts.
   > const product = (
   >   await import('@codingame/monaco-vscode-api/vscode/vs/platform/product/common/product')
   > ).default
   > expect(product.commit).toBe(manifest.client.vscodeCommit)
   > expect(product.quality).toBe('stable') // §1.4: a quality mismatch is a 404 storm, not an error
   > ```
   >
   > Two properties this has that the `package.json` read did not. It compares against **the value
   > the handshake will actually send**, rather than against a build input that happens to agree
   > with it; and it covers `quality`, which §1.4 shows fails silently through resource-path
   > prefixing rather than loudly through the version check. If importing the deep path proves
   > awkward under the test runner's resolution, reading the same file as text and extracting the
   > 40-hex `commit` is an acceptable substitute — **what is not acceptable is reading
   > `package.json`**, because that is a claim about the repository rather than about the artifact.

   > **Correction (Codex review round 3, 2026-08-22) — the specifier above is round 3's; round 2's
   > could not have resolved.** The revised draft wrote
   > `import('@codingame/monaco-vscode-api/vscode/src/vs/platform/product/common/product.js')` —
   > the path of the file **inside the tarball**, which is what the unpkg URL in §1.1 correctly
   > shows, pasted where an **export-map subpath** belongs. The package's published `exports` are:
   >
   > ```json
   > "./vscode/*.css": { "default": "./vscode/src/*.css" },
   > "./vscode/*":     { "types": "./vscode/src/*.d.ts", "default": "./vscode/src/*.js" }
   > ```
   >
   > — identical in `33.0.9` and `36.1.1`, read from the published manifests at
   > <https://unpkg.com/@codingame/monaco-vscode-api@33.0.9/package.json> and
   > <https://unpkg.com/@codingame/monaco-vscode-api@36.1.1/package.json>. The pattern already
   > supplies both `src/` and `.js`, so the round-2 specifier expands to
   > `./vscode/src/src/vs/platform/product/common/product.js.js` — **`src` doubled and `.js`
   > doubled** — and Node raises `ERR_PACKAGE_PATH_NOT_EXPORTED` or `ERR_MODULE_NOT_FOUND` rather
   > than anything that names the mistake. **The correct specifier is
   > `@codingame/monaco-vscode-api/vscode/vs/platform/product/common/product`**: no `src`, no
   > extension.
   >
   > It is the same defect twice over, which is why it is worth the space. Round 2 caught a test
   > written against a field that does not ship; the replacement was written against a **path that
   > does not resolve**, and both would have failed at the first run in a way that reads as a
   > broken test rather than as the wrong address. A path is a shape, and `CLAUDE.md`'s rule about
   > reading shapes out of the types rather than out of prose applies to the resolver's input as
   > much as to a payload.

   This is the check that catches a `pnpm up` that moved the client without the server. It is the
   same failure shape as the release gate refusing to build when `package.json` and
   `apps/desktop/package.json` disagree (`CLAUDE.md`, Releasing step 2).

3. **Main refuses to open a project on mismatch** — plan §3.2's "reject a client/server commit
   mismatch before opening a project" — and it checks a **Chorus-owned extraction receipt**,
   because the unpacked server cannot be asked what it was built from.

   > **Correction (Codex review round 3, 2026-08-22) — "the check runs against the _unpacked
   > server's_ recorded provenance" is retracted, and it survived two rounds of review by looking
   > obviously right.** The unpacked server has no record of its upstream commit to check against.
   > VS Code's REH build writes exactly three identity fields into the `product.json` it ships —
   > `gulp.src(['product.json']).pipe(jsonEditor({ commit, date: readISODate(sourceFolderName), version }))`
   > (`build/gulpfile.reh.ts:329-330` at tag `1.121.0`) — where `commit` is
   > `getVersion(REPO_ROOT)`, which returns `BUILD_SOURCEVERSION` when it is 40 hex characters
   > (`build/lib/getVersion.ts`). VSCodium sets that variable to
   > `$(echo "${RELEASE_VERSION/-*/}" | sha1sum | cut -d' ' -f1)` — **a sha1 of its own version
   > string** (`version.sh:3-6` at tag `1.121.03429`) — and `version` comes from a `package.json`
   > whose version `prepare_vscode.sh:236` has already set to the VSCodium release
   > (`1.121.03429`), not the upstream tag. `prepare_vscode.sh` then rewrites some forty product
   > fields, all of them branding, gallery and update endpoints; **not one of them is an upstream
   > commit or an upstream tag.** So the shipped `product.json` says `commit: <sha1 of
"1.121.03429">` and `version: "1.121.03429"`, and **neither field names VS Code `1.121.0` or
   > `987c9597…`**. §2.3 already said this of `commit`; what was missed is that there is no
   > _other_ field that says it either, so "read the provenance out of the unpacked server" names
   > a check that has nothing to read.
   >
   > **And the patch makes it worse rather than better.** §1.5b's `product.json` edit sets
   > `commit` to the client's commit. After it, the server reports exactly what the manifest
   > expects **whatever tarball it came from** — a 1.126 server, a 1.121 server and a hand-built
   > one are indistinguishable, because the field is now an echo of the question. **A patched
   > handshake commit cannot prove which artifact is running**, and §7.2's row claiming it catches
   > a stale server is corrected below.
   >
   > **What replaces it, in three parts, none of which asks the artifact about itself:**
   >
   > 1. **Generate `server.upstreamTag` and `server.upstreamCommit` from the release's own
   >    `upstream/stable.json`**, fetched at the exact tag —
   >    `https://raw.githubusercontent.com/VSCodium/vscodium/1.121.03429/upstream/stable.json`
   >    returns `{"tag":"1.121.0","commit":"987c9597516278c9fcf10d963a0592ce1384ab93"}` (verified
   >    2026-08-22). That file is the only published join between a VSCodium release and an
   >    upstream commit, and it is a property of the **release**, not of the tarball.
   > 2. **Verify the artifact against its published `.sha256` sibling** (§3.3) before unpacking.
   >    That is what ties the bytes on disk to the release the mapping was read from — the join
   >    the artifact itself cannot make.
   > 3. **Write a Chorus-owned receipt beside the unpacked tree**, at unpack time, from the
   >    manifest entry that was just verified: artifact name, its sha256 as measured, the manifest's
   >    `upstreamTag`/`upstreamCommit`, the VSCodium release, and the manifest's own hash. Main
   >    reads the **receipt** before opening a project and refuses when it disagrees with the
   >    manifest. The receipt is an assertion Chorus made about bytes it checked; the server's
   >    `product.json` is an assertion VSCodium's build made about its own version string.
   >
   > ```jsonc
   > // <userData>/workbench/<release>-<platform-arch>/chorus-extraction.json
   > {
   >   "artifact": "vscodium-reh-darwin-arm64-1.121.03429.tar.gz",
   >   "sha256": "…", // measured on the downloaded file, not copied from the manifest
   >   "manifestSha256": "…", // sha256 of workbench-runtime.json AS READ — see below
   >   "vendor": "vscodium",
   >   "release": "1.121.03429",
   >   "upstreamTag": "1.121.0", // from upstream/stable.json at that tag — never from the tarball
   >   "upstreamCommit": "987c9597516278c9fcf10d963a0592ce1384ab93",
   >   "productJsonCommitPatchedTo": "987c9597516278c9fcf10d963a0592ce1384ab93",
   >   "unpackedAt": "…",
   > }
   > ```
   >
   > **`manifestSha256` was promised in the prose above and missing from the example — corrected in
   > review round 4.** Part 3 says the receipt carries "the manifest's own hash" and the object
   > did not have the field, which is the failure mode this brief keeps hitting: a correction
   > written with the attention on its argument, whose own new detail goes in unchecked. It is not
   > decorative. Without it the receipt records which _artifact_ was unpacked but not which
   > _manifest_ authorised it, so a manifest edited after extraction — a bumped
   > `client.vscodeCommit`, a changed patch target — leaves a receipt that still agrees on every
   > field it happens to carry. It is the byte-level identity of the file whose contents the
   > receipt is an assertion about, and it is measured on the exact bytes read, not recomputed
   > from a re-serialisation.
   >
   > `productJsonCommitPatchedTo` is recorded deliberately: after §1.5b's edit the server's own
   > `commit` is Chorus's value, and a receipt that did not say so would leave the next reader
   > believing the server had agreed with the manifest independently.
   >
   > **Extraction is transactional, and the ordering _is_ the property — round 4.** The steps below
   > are not a suggested sequence; each one is placed where it is because moving it reintroduces a
   > state the next step is there to make unreachable.
   >
   > 1. **Verify the archive against the committed manifest _before_ extracting a single entry.**
   >    Hash the downloaded file and compare against the manifest's `sha256` for this
   >    platform/architecture, and against the published `.sha256` sibling (§3.3). Nothing is
   >    written to the extraction tree until this passes. Verifying afterwards means the bad bytes
   >    are already on disk, and "delete it if the check fails" is a cleanup path that runs exactly
   >    when something is already wrong.
   > 2. **Extract into a new temporary sibling directory**, `…/workbench/.tmp-<random>/`, on the
   >    **same filesystem** as the final location — the sibling constraint is what makes step 7 a
   >    rename rather than a copy. Never extract over an existing tree, never extract into the
   >    final path.
   > 3. **Reject absolute paths, `..` traversal, and links that escape the extraction root** — for
   >    hard links and symlinks this means the resolved **target**, not just the entry name. This
   >    is not hypothetical and it is not covered by "the library handles it":
   >    **CVE-2026-23745** (High, CVSS 8.2, published 2026-01-16) is exactly this bug in
   >    `node-tar` **≤ 7.5.2**, fixed in **7.5.3** — `linkpath` was left unsanitised for `Link` and
   >    `SymbolicLink` entries **when `preservePaths` is false**, i.e. in the default configuration
   >    people choose _because_ they believe it is the safe one
   >    ([GHSA-8qq5-rm4j-mr97](https://github.com/advisories/GHSA-8qq5-rm4j-mr97)). So: pin the
   >    extractor at or above its fixed version, state the version in the manifest, and validate
   >    independently rather than delegating the invariant. The threat model is weaker than a
   >    hostile archive — the bytes are checksum-verified against a manifest Chorus committed — but
   >    a Phase 1 that only works when the download is honest has not tested the part that matters.
   > 4. **Patch `product.json` in the temporary tree** (§1.5b), before the tree is ever addressable
   >    under its final name. A patch applied after the rename would mean a valid-looking runtime
   >    exists, for a window, in an unpatched state.
   > 5. **Write the receipt last**, once every byte above it is final. The receipt is the commit
   >    record; anything written after it can contradict it.
   > 6. **Atomically rename the completed directory into its final checksum-addressed location.**
   >    POSIX gives the guarantee this leans on — the destination name _"shall remain visible to
   >    other threads throughout the renaming operation and refer either to the file referred to by
   >    `new` or `old` before the operation began"_
   >    ([POSIX.1-2024 `rename`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html)).
   >    **Two caveats, both of which have to be handled rather than noted.** `rename` **fails** when
   >    the destination _"names a directory that is not empty"_ (`ENOTEMPTY`/`EEXIST`), so the
   >    correct response to a populated destination is not to remove it and retry — that is a
   >    delete-then-rename window, which is the non-atomic thing this step exists to avoid. It is
   >    to **validate the occupant's receipt first**: if it is valid, **another extraction won the
   >    race** — use it and discard the temporary tree; if it is not, go to **step 8**, which is
   >    the case round 4 left with no exit. And on **Windows** a directory rename onto an existing
   >    path fails
   >    outright and the same-volume requirement is stricter; the sibling-directory rule in step 2
   >    is what keeps this a rename on every platform. **Whether the destination filesystem is
   >    always the same one is UNVERIFIED** — a `userData` on a network or mapped volume is the
   >    case that would break it.
   > 7. **Treat any directory without a valid, matching receipt as unusable.** Not "repair it", not
   >    "assume it is fine because the files are there" — refuse it, and republish over it by the
   >    quarantine route in step 8. "Matching" means the receipt parses, its `manifestSha256`
   >    equals the hash of the manifest being read now, and its artifact and commits agree with
   >    that manifest's.
   > 8. **Publish over an invalid destination by _quarantine_, never by deletion — and never
   >    recursively delete a destination in the publish path at all.**
   >
   >    > **Correction (Codex review round 5, 2026-08-22) — round 4's steps 6 and 7 could not both
   >    > run, and the recovery path they describe was unreachable.** Step 7 said an invalid final
   >    > directory is re-extracted from step 1. Step 6 said a populated destination makes `rename`
   >    > fail with `ENOTEMPTY`, and forbade removing it. Put together, a destination that exists
   >    > and is **invalid** has no exit: re-extraction runs the whole sequence again and arrives
   >    > back at a rename that fails for the same reason it failed the first time, against a
   >    > directory nothing is permitted to move. The loop is unbounded and every pass costs a
   >    > 76 MB download and a full extraction. **Step 6's `ENOTEMPTY` handling silently assumed
   >    > the occupant was valid** — "conclude another extraction won the race, validate _its_
   >    > receipt, use it" reads as complete only while the receipt is good, which is the one case
   >    > step 7 exists for. The two steps were written in the same round, minutes apart, and each
   >    > is correct about the case it was thinking about.
   >
   >    The occupant is only ever one of three things, and the third is the one round 4 dropped:
   >
   >    | Destination                            | What it means                      | Action                                                          |
   >    | -------------------------------------- | ---------------------------------- | --------------------------------------------------------------- |
   >    | Absent                                 | First writer                       | `rename(tmp → final)`. Done                                     |
   >    | Present, receipt **valid**             | Another extraction won the race    | Use it, `rm -rf` the **temporary** tree. Never touch the winner |
   >    | Present, receipt **invalid or absent** | Interrupted, corrupt or stale tree | **Quarantine, then publish** — below                            |
   >
   >    **The quarantine sequence, and each step is a single `rename`:**
   >
   >    1. `rename(final → …/workbench/.quarantine-<random>/)` — a **unique sibling** in the same
   >       parent, so it is same-filesystem by construction and cannot collide with a concurrent
   >       quarantine. The randomness is load-bearing: a fixed `.quarantine/` name would itself hit
   >       `ENOTEMPTY` the second time, which is the bug being fixed, one directory over.
   >    2. `rename(tmp → final)` — the ordinary publish, now against a destination that is absent.
   >    3. **If either rename loses a race, do not retry blindly — restart by validating the
   >       current final receipt** and re-entering this table from the top. Both losses are real
   >       and neither is an error: rename 1 fails with `ENOENT` when another process quarantined
   >       the same invalid tree first, and rename 2 fails with `ENOTEMPTY` when another process
   >       published into the gap that rename 1 opened. In both cases some other actor has made
   >       progress, and the correct response is to look at what is there now rather than to
   >       assume the world is still as it was read.
   >
   >    **This is a genuine weakening of step 6's claim, and saying so is the point.** Between
   >    rename 1 and rename 2 the final path **does not exist**, so publishing over an invalid tree
   >    is two atomic renames with a gap, not one atomic substitution — the POSIX sentence quoted
   >    in step 6 covers each rename and does not span the pair. **The property that survives is
   >    the one that matters**: the final path is only ever absent, or a complete tree with a
   >    receipt. It is never a partially-written one, which is exactly what `rm -rf` on the
   >    destination would produce if it were interrupted — a directory that exists, is missing an
   >    arbitrary subset of its files, and whose receipt may still parse and match, because the
   >    receipt is one small file among thousands and nothing orders its deletion first. **A
   >    recursive delete is the one operation here that can manufacture the failure the whole
   >    transactional order was written to make unreachable.** A rename cannot.
   >
   >    **Quarantine cleanup is a separate, restartable sweep** — on next launch, or after the new
   >    tree is serving — and it is where `rm -rf` is allowed, because a half-deleted
   >    `.quarantine-<random>` is garbage that no code path reads, looks for or can mistake for a
   >    runtime. A crash mid-sweep costs disk, not correctness. **Quarantine only a tree no
   >    Chorus-spawned REH is running out of**; §5.4's lease and `stopAll()` are what make that
   >    answerable, and on **Windows** a directory rename fails with a sharing violation while a
   >    process holds an executable or DLL inside it, so a leaked server (§5.4's known Windows gap)
   >    turns quarantine into a hard failure rather than a race. **That interaction is UNVERIFIED**
   >    and is the Windows case worth driving deliberately.
   >
   > **The property this buys, stated as the thing to check the design against: an interrupted or
   > malicious extraction cannot become a valid-looking runtime.** A tree that is missing files, was
   > written from a half-verified archive, or was never patched, has no receipt — because the
   > receipt is written last, inside a directory that is not yet at its final name. And a tree that
   > _has_ a receipt got one only after verification, extraction, containment checks and patching
   > all completed. There is no interleaving of a crash, a `SIGKILL` or a full disk that produces
   > the first while looking like the second. That is why the ordering is normative and why
   > `manifestSha256` is in the receipt rather than inferred: **the receipt is the only evidence
   > Chorus has that the tree it is about to spawn is the tree it verified**, and §5.4's identity
   > argument rests entirely on it.
   >
   > **What still binds the running process to the receipt** is that Chorus spawns it — §5.4 reads
   > the port back out of the child's own stdout, so the pid, the port and the unpacked directory
   > come from one act. The stale-server hazard §5.4 warns about exists only for a port Chorus did
   > **not** spawn, so the rule is the harness rule from `CLAUDE.md` one level out: **never attach
   > to a port Chorus did not open**, exactly as `launch` stopped attaching to whatever owned 9800.

4. **Bumping is one commit — across three files, and pretending otherwise is what lets them
   drift.**

   > **Correction (Codex review round 2, 2026-08-22).** The revised draft said "one commit that
   > touches one file". **An upgrade cannot touch one file.** Moving the client changes
   > `apps/desktop/package.json` (the dependency range), `pnpm-lock.yaml` (the resolution and its
   > integrity hash) and `apps/desktop/build/workbench-runtime.json` (the commit and every server
   > checksum). Three files, and a `pnpm up` will happily write the first two without the third —
   > **which is exactly the drift this section exists to catch**, so describing the manifest as
   > self-contained described away the failure mode.
   >
   > What is true, and is the property worth claiming: **the three files are bound by test rather
   > than by discipline.** Property 2 fails the moment the lockfile's resolved client stops
   > agreeing with the manifest, so a two-file upgrade is red before it is reviewed. The atomicity
   > lives in the assertion, not in the file count — and this is the same shape as the release
   > gate, which does not ask anyone to remember that `package.json` and
   > `apps/desktop/package.json` must agree; it refuses to build when they do not.

---

## 4. Proposed prototype topology and the exact files

### 4.1 Topology for the Phase 1 slice only

```text
Electron main — the only holder of the connection token
├── workbench-host.ts ── spawns ONE REH sidecar, shared by every open project
│     ├── loopback, ephemeral port read back from the child's own stdout
│     ├── random per-launch connection token — NEVER leaves main except into a workbench surface
│     └── Chorus-owned --server-data-dir / --extensions-dir under app.getPath('userData')
├── workbench-surface.ts ── owns N isolated workbench surfaces, hands out OPAQUE view IDs
│     └── each surface: its own WebContentsView, ONE shared chorus-workbench session
│           partition (§5.2), and preload/workbench.js — never the shell's preload (§4.1b)
└── typed IPC (workbench:*)
      ├── to the SHELL:   open(projectRoot) -> viewId · setBounds(viewId, rect) · close(viewId)
      └── to a SURFACE:   connection(port, token, commit, root) — that surface only, pushed
                          after its own load, buffered in its preload, re-answerable on reload

Electron renderer — the shell never holds port or token
├── index.html      ← the existing Chorus shell, unchanged; knows only opaque view IDs
└── workbench.html  ← a SECOND entry point, loaded into a main-owned WebContentsView
      └── entry.ts → services.ts → full WorkbenchService → vscode-remote://127.0.0.1:<port>
            └── bridge-extension.ts (trusted, in the web/UI host)

Phase 1 opens TWO of these, on TWO distinct roots — e.g. this worktree and
/Users/mohamadtaleb/code/chorus — against the ONE shared REH:

  surface #1 ──┐                          ┌── ExtensionHostConnection A → forked ext-host (root A)
               ├─→ one REH on :<port> ────┤
  surface #2 ──┘   (one management +      └── ExtensionHostConnection B → forked ext-host (root B)
                    one ext-host conn
                    per project)
```

**Decision (Codex review round 2, 2026-08-22) — one REH shared by all projects, not one per
project.** The revised draft specified "ONE REH sidecar for ONE hard-coded project root" while
R7, C7 and plan proof 9 all claimed to be testing two projects. **Two surfaces on one root would
have proved the wrong architecture** — it measures two views of the same workspace, which shares
every file watcher, every language server and every piece of workspace storage, and would have
made the second project look almost free for a reason that disappears the moment the roots
differ.

**Why shared rather than per-project, from the server's own source.** The REH holds its
connections in maps keyed by reconnection token — `_managementConnections` and
`_extHostConnections`, both
`{ [reconnectionToken: string]: … }` (`src/vs/server/node/remoteExtensionHostAgentServer.ts:61-62`
at tag `1.121.0`) — and each extension-host connection forks its own process
(`extensionHostConnection.ts:281-288`, comment: _"Run Extension Host as fork of current
process"_). **One server serving several workspaces concurrently, each with its own extension host
process, is the upstream design**, not a Chorus invention. It is also what plan §2.2's topology
diagram already drew — "starts _one_ version-pinned VSCodium REH sidecar" plus "manages
per-project workspace/storage identity" — so this decision makes the prototype match the plan
rather than changing it.

**And it is the topology with the lower marginal cost — but R7 still decides, and the round-2
wording claimed otherwise.** That draft said this was "the only topology under which R7 can pass
on its merits", which is a prediction dressed as a structural fact. What is defensible is the
comparison and its direction: a REH per project pays for a second Node server, a second set of
watchers and a second extension host, so its second project costs approximately what its first
did; a shared server adds one connection and one forked extension host. Sharing is therefore the
**upstream-supported topology with the lower marginal cost**, which is why it is chosen — and
choosing per-project REHs and then measuring R7 would have measured the decision rather than the
platform.

**What none of that establishes is that the shared topology passes.** `M2 − M1 < M1 − M0` is an
empirical claim about a forked extension host, a per-workspace language-server set and two file
watchers over two repositories, and nothing read for this brief bounds any of them. R7 is
pre-registered precisely so the answer cannot be argued afterwards, and it can fail here — in
which case §8.4's first fallback triggers on a shared REH, which is a genuinely informative
outcome rather than a wasted measurement. **The topology is chosen on architecture and licence;
the number is still owed.**

**What sharing costs, stated rather than discovered later.** `--server-data-dir`,
`--user-data-dir` and `--extensions-dir` are **per-server**, so under this topology every project
shares one extension installation set and one global-storage namespace. Per-project isolation
comes from the distinct workspace URI — workspace storage is keyed by workspace — and that is
exactly what Phase 1 has to exercise rather than assume. So the two-root proof has a third
assertion beyond "both connected": **each project's workspace storage is distinct, and an
extension's workspace state in project A does not appear in project B.** Whether a shared global
storage namespace is acceptable in the product is a Phase 5 question; if it is not, the fallback
is a REH per project, at R7's price, and that trade is now recorded rather than rediscovered.

The slice still deliberately mounts **one** surface first and adds the second only once one works.
Plan Phase 1 proof 9 is the falsification test for §2.4 of the plan and must not be the first
thing attempted, because a failure there is uninterpretable if one surface has never been shown to
work. §2.5 puts that pair of steps first in the phase, before any server exists — and note that
step 1 is serverless, so its two surfaces are two roots with **no** REH behind them, which tests
containment and nothing about isolation.

### 4.1a The token contradiction in the first draft, and the surface that resolves it

**Correction (Codex review, 2026-08-22). This brief contradicted itself, and the contradiction
was load-bearing rather than cosmetic.** §5.3 and §5.5 both state the rule as an absolute:

> **The outer Chorus renderer must never be handed the token.** Only the workbench frame needs
> it. If it flows through the shell's React state, every future component and every future log
> line becomes a leak site.

And the first draft's own §4.2 then specified the opposite mechanism twice: a
`workbench:describe` channel returning **`(port, token, commit, root)` to the outer renderer**,
and an `entry.ts` that "reads port/token/commit from **the frame's own query string** (handed
down by the parent)". For the parent to hand a token down a query string, the parent must first
hold the token. **That is exactly the leak the rule forbids, and it is worse than the general
case**, because a query string is not a variable that stays in React state — §5.3 already
establishes that the `tkn` query parameter lands in every `vscode-remote-resource` `src`
attribute in the DOM permanently, in session history, and in any devtools recording. The design
would have written the secret into the shell's own URL bar and then into the frame's.

**The rule wins; the mechanism is replaced.** The token must travel **from main into the
workbench context directly**, never through the shell, and never through a URL. That is only
possible if the workbench context is something **main owns and can address individually**, rather
than an `<iframe>` the shell created and therefore controls. So the design changes shape: the
shell stops being the parent of the workbench and becomes a **requester of a surface**, holding
an **opaque view ID** — a value that is useless if leaked, because every operation it names is
mediated by main and validated against the project main opened it for.

**Two candidate surfaces were proposed for comparison. One of them cannot be built as described,
so the comparison is settled here rather than in Phase 1.** They differ in almost every property
that matters, and the first draft evaluated neither.

| Property                        | **(A)** Separate-origin frame, direct main→frame delivery                                                                                                                                                                                                            | **(B)** Electron `WebContentsView`                                                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What the shell contains         | An element in the shell's DOM, so layout, clipping, z-order, scrolling and animation are ordinary CSS                                                                                                                                                                | **Nothing.** The view is a sibling of the shell's `webContents`, composited by the window, not by the shell's DOM                                                                                             |
| Isolation strength              | Claimed a separate **origin** — but the draft never said by what mechanism one would be created, and §5.2's `frame-ancestors 'self'` is only coherent if there is _not_ one. Still inside the shell's `webContents` either way                                       | A **separate top-level `webContents`**, with its own `webPreferences` and its own preload — the strongest boundary Electron offers short of a second window. **Its own session only if asked for**; see below |
| How main addresses it           | `webContents.mainFrame.frames` → the specific `WebFrameMain`; `frame.postMessage()`. **Now verified and it is a no**: a child frame can only receive IPC with `nodeIntegrationInSubFrames`, which loads every preload into every iframe, extension webviews included | `view.webContents` directly. Ordinary `ipcMain` + `event.sender` identifies it unambiguously. No subframe question exists                                                                                     |
| CSP / `frame-ancestors`         | Needs §5.2's path-aware CSP split and `frame-ancestors 'self'` — the hardest row in that table, and the one that turns out to be self-contradictory                                                                                                                  | **Does not need it at all.** Nothing is framing anything, so `frame-ancestors 'none'` stays on the shell — but the workbench's own CSP arrives only with a deliberately configured session, never by default  |
| Layout cost                     | None                                                                                                                                                                                                                                                                 | Real: main must drive `view.setBounds({x,y,width,height})` from measurements the shell reports, and bounds lag the shell's own reflow. Four panes means four `setBounds` streams and a resize path            |
| Fit with plan §2.4's four panes | Natural — four elements in one layout                                                                                                                                                                                                                                | Four overlaid views whose visibility and bounds main must keep in step with the shell's tab state. Every layout bug becomes a two-process bug                                                                 |

Both were said to satisfy the invariant the correction is for — **the shell receives only an
opaque view ID**, and the token is delivered by main into the workbench context and nowhere else.
**Only (B) actually does**, and the next subsection is why.

`WebContentsView`'s API is verified against Electron's own documentation — it is "a View that
displays a WebContents", constructed with `webPreferences`, added with
`win.contentView.addChildView(view)`, positioned with `view.setBounds({ x, y, width, height })`,
and exposing the read-only `view.webContents` used "to interact with the WebContents, for
instance to load a URL"
(<https://www.electronjs.org/docs/latest/api/web-contents-view>). Chorus's window is a
`BrowserWindow`, which carries `contentView`, so nothing new has to be introduced to host one.

#### Decision: surface (B), Electron `WebContentsView`. (A) is withdrawn.

**Correction (Codex review round 2, 2026-08-22) — surface (A) was internally contradictory, and
the contradiction is not fixable by choosing better values.** Two independent defects, either of
which is disqualifying.

**Defect one: "separate-origin" and `frame-ancestors 'self'` cannot both be true.** §5.2's row
for (A) proposed relaxing the workbench document's policy to `frame-ancestors 'self'`. That
directive "specifies valid parents that may embed a page", and `'self'` names **the framed
document's own origin**
(<https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors>).
So the two readings of (A) fail in opposite directions:

- **If the workbench really is a separate origin** — which is the entire point of calling it one,
  and would require registering a custom standard scheme, a mechanism the draft never specified —
  then the shell (`file://` in production, the Vite dev origin in development) is **not** `'self'`
  from the workbench's point of view, and `frame-ancestors 'self'` **blocks the embed outright**.
  Making it work means naming the shell's origin explicitly, which is a scheme-source or
  host-source allowance, not `'self'`.
- **If shell and workbench share an origin**, the directive admits the embed — and there is no
  boundary left. Same-origin parent and child share DOM and script access, so the shell can reach
  `iframe.contentWindow`, read the workbench's globals and read the token straight out of it. The
  isolation the whole correction was written to obtain does not exist.

**Defect two: main cannot deliver a secret to a subframe without arming every subframe.** (A)'s
delivery mechanism was `WebFrameMain.postMessage` to the specific frame. Electron's own
documentation closes this: _"In most cases, only the main frame of a WebContents can send or
receive IPC messages. However, if the `nodeIntegrationInSubFrames` option is enabled, it is
possible for child frames to send and receive IPC messages also"_
(<https://www.electronjs.org/docs/latest/api/web-frame-main>). And that option is not scopable —
_"Experimental option for enabling Node.js support in sub-frames such as iframes and child
windows. **All your preloads will load for every iframe**"_
(<https://www.electronjs.org/docs/latest/api/structures/web-preferences>). **Every iframe includes
every extension webview**, since §5.2 records that Code-OSS webviews are `<iframe>` rather than
Electron `<webview>`. Turning it on to deliver a token would hand a preload — and with it whatever
the context bridge exposes — to arbitrary extension-authored webview content. That is a strictly
worse outcome than the leak the correction was written to prevent, and it removes the last reason
to keep (A): the draft listed the subframe-preload question as **UNVERIFIED**, and verified, it is
a no.

**The one remaining route for (A), and why it also fails.** A `MessageChannelMain` port could be
sent to the shell's main frame with `webContents.postMessage` and forwarded on to the iframe with
`window.postMessage`'s transfer list, which needs no `nodeIntegrationInSubFrames`. But the shell
holds that port before it forwards it, and can simply start it and read the token instead. Plan
§3.1 classifies the Chorus renderer as **not trusted**; a mechanism whose security depends on the
untrusted party forwarding rather than reading is not a boundary, it is an agreement. _(This
paragraph is reasoning over the documented transfer semantics, not a quoted guarantee — but it
does not carry the decision, which defects one and two already settle.)_

**So (B) is selected now, and B6 changes from a comparison to an implementation.** The cost is
real and unchanged: **plan §2.4's four-visible-panes shape is exactly the case `WebContentsView`
is worst at**, and a bounds-driven overlay tracking a React tab layout is a well-known source of
one-frame-late rendering and mispositioned views. That cost is now accepted rather than weighed,
because the alternative does not exist. The layout risk moves into the phase as something to
measure — a resize and tab-switch proof, added to §7.2 — rather than as a reason to reconsider.

#### The session that does not come for free

**Correction (Codex review round 2, 2026-08-22) — "the workbench gets its own CSP through its own
session" was asserted, and it is false by default.** The revised draft's comparison table claimed
(B) has "its own `session`". **A `WebContentsView` gets no such thing automatically.** Its
constructor takes `webPreferences` (<https://www.electronjs.org/docs/latest/api/web-contents-view>),
and a session is selected there or not at all: _"`partition` — Sets the session used by the page
according to the session's partition string"_ and _"`session` — Sets the session used by the
page… When both `session` and `partition` are provided, `session` will be preferred"_
(<https://www.electronjs.org/docs/latest/api/structures/web-preferences>). Absent both, the view
uses the default session — _"If the `partition` is empty then default session of the app will be
returned"_ (<https://www.electronjs.org/docs/latest/api/session>).

**And that default would have been a silent security regression, not merely a missed opportunity.**
Chorus applies its entire renderer lockdown to one session object:
`applyContentSecurityPolicy(session.defaultSession, …)` at `index.ts:102`, which installs the CSP
through `session.webRequest.onHeadersReceived` and the two permission handlers
(`security.ts:36-53`). Those are **per-session** — `ses.webRequest` is _"a `WebRequest` object for
this session"_, `session.protocol` is _"a `Protocol` object for this session"_, and
`setPermissionRequestHandler`/`setPermissionCheckHandler` are session methods. So the two possible
mistakes are symmetrical and both bad: put the workbench on the **default** session and its CSP is
the shell's `default-src 'none'`, which no workbench can run under, inviting exactly the
relax-it-as-a-block failure §5.2 was written to prevent; put it on a **new** partition and, unless
each control is applied there deliberately, it inherits **no CSP at all and no permission
handler** — every permission request answered by Electron's defaults rather than by Chorus's
`callback(false)`.

**The specification, therefore, rather than the assumption:**

- **One dedicated partition for every workbench view, not one partition each** — and the
  distinction is worth stating because the plural reading was in the text and would have been
  built. A partition is named by a string, so all four surfaces naming `chorus-workbench` share
  one session object: one `webRequest` filter, one CSP, one pair of permission handlers, one
  protocol registration, installed once and provably applied to every view. Per-view partitions
  would multiply every control by the number of open projects and make "is this one configured?"
  a runtime question — the "dead control rather than an error" failure again, once per project.
  The isolation Chorus needs is between **the workbench and the shell**, which one shared
  workbench partition gives; isolation _between_ workbench views comes from each being its own
  top-level `WebContents` in its own process, not from the session.
- **A partition that is non-persistent** unless something proves otherwise — a bare
  `chorus-workbench` string rather than `persist:chorus-workbench`, because the workbench's
  durable state belongs in the REH's Chorus-owned `--user-data-dir`, not in a Chromium profile,
  and an in-memory session is one fewer place for a token-bearing cookie (§5.3) to survive a quit.
  **Whether the workbench tolerates a non-persistent session is UNVERIFIED** — the `vscode-tkn`
  cookie is set per connection and should not need to outlive one, but the client also uses
  storage services; if it does not tolerate it, `persist:` is acceptable and the cookie's lifetime
  becomes a thing to bound.
- **Its own CSP**, installed on that session's `webRequest` with the workbench's directives, while
  `session.defaultSession` keeps `default-src 'none'` and `frame-ancestors 'none'` **untouched**.
  This is the concrete win (B) was chosen for: §5.2's relaxations stop being edits to the shell's
  policy and become a second policy that the shell never sees.
- **Its own permission handlers**, set explicitly to the same `callback(false)` the shell uses.
  Not inherited — set. §5.2 keeps "leave denied in Phase 1" and this is what makes that true
  rather than aspirational.
- **Its own protocol registration**, if the workbench is served over a custom scheme rather than
  `file://`; `session.protocol` is per-session, so a handler registered on the default session is
  invisible here.
- **Its own navigation lock.** `lockDownNavigation` (`security.ts:59-93`) binds to a
  `BrowserWindow`'s `webContents`; the view's `webContents` is a different object and gets none of
  it. `will-navigate`, `setWindowOpenHandler` and `will-attach-webview` must be re-bound to
  `view.webContents` — and `will-attach-webview` especially, because §5.2 keeps it as the guard
  that catches the workbench reintroducing an Electron `<webview>`. Left unbound, that guard is
  not relaxed, it is simply absent, which is the failure mode `security.ts:67-84` already records
  as "a dead control rather than an error".

**A test asserts the workbench session is not `defaultSession`**, and asserts each control is
installed on it. The whole class of defect here is a control that appears to exist because it
exists somewhere else.

**What the brief settles regardless of surface, and still does:** the shell holds an opaque view
ID and never the token, and no _document_ URL Chorus itself constructs carries `tkn`. That last
clause is narrower than it looks and the narrowing is honest: §5.3 establishes that the client
appends the token to every `vscode-remote-resource` URL **itself**, so token-bearing URLs inside
the workbench's own DOM are not avoidable. What this correction removes is the one instance Chorus
was choosing to create — the workbench document's own address — and the shell-side exposure that
instance implied.

**What this changes about §4.2 below.** The `workbench:describe` channel as originally specified
is withdrawn. The three-channel IPC surface is re-split into a shell-facing set that carries no
secret and a surface-facing delivery that carries one, and the `entry.ts` query-string mechanism
is replaced. Because the surface is now a top-level `webContents`, that delivery is ordinary
`ipcMain` with `event.sender` identifying it unambiguously — no subframe question arises.

**And "ordinary `ipcMain`" is where round 2 stopped, which is half an answer.** It settles who may
speak; it says nothing about **when**, or about which preload is on the other end — and the second
of those was left entirely unspecified, with the shell's full-`ChorusApi` preload as the default
outcome. **§4.1b is that half**, and it is a separate subsection rather than a paragraph here
because it is where a plausible implementation of everything above still ends up wrong.

### 4.1b The preload the surface must not inherit, and the delivery that must not be lost

**Correction (Codex review round 3, 2026-08-22) — round 2 stopped one field short.** Its blocker 2
established that a `WebContentsView` inherits nothing from the shell and specified the session
that has to be built deliberately. **`preload` is selected in the same `webPreferences` object,
and the brief never named it** — so the design as written left the view's preload unspecified,
which is a coin toss between two outcomes and one of them is the worst in this document.

**What Chorus's one preload exposes.** `apps/desktop/src/preload/index.ts` builds a method per
IPC channel from `IPC_CONTRACT` and ends with `contextBridge.exposeInMainWorld('chorus', api)`
(`preload/index.ts:242`). That object is the whole `ChorusApi` — roughly seventy methods, among
them `writeProjectFile` (`workspace:write`), `stashFile`, `runGitAction`, `readSettings` /
`writeSettings`, `decideApproval`, `setProfile`, every `conversation:*` and every `terminal:*`
channel, plus eleven push subscriptions. The window that gets it is created with
`preload: join(__dirname, '../preload/index.js')` (`index.ts:63`). **A workbench surface must
never receive that**, and the reason is not defence in depth: the workbench document runs
third-party extension code by design, and `decideApproval` alone would let it answer Chorus's own
permission prompts.

**The two ways to get it wrong, and only one of them is loud.** Omit `preload` from the view's
`webPreferences` and the view gets **no** preload — safe, and the surface then has no way to
receive its connection at all, which fails immediately and visibly. Copy the window's
`webPreferences` object to "keep the sandbox settings consistent" — the natural move, since
`sandbox: true`, `contextIsolation: true` and `nodeIntegration: false` are exactly what the
workbench also wants — and `preload` comes along silently. The second is the one to design
against, so the rule is: **`workbench-surface.ts` constructs its own `webPreferences` literal and
never spreads the window's.**

**The dedicated preload.**

- **`apps/desktop/src/preload/workbench.ts`**, exposing **one** method and nothing else.
- **Its build entry.** electron-vite's default preload entry is
  `<root>/src/preload/{index|preload}.{js|ts|mjs|cjs}` (<https://electron-vite.org/guide/dev>), so
  a second file is not picked up on its own; it needs
  `preload.build.rollupOptions.input`. **The trap is that setting `input` replaces the default
  rather than adding to it** — the existing entry must be listed explicitly, under the key
  `index`, or the shell's preload stops being emitted and `index.ts:63` points at a file that is
  no longer there. Output names follow the input keys, so keeping the key preserves the path main
  already loads:

  ```ts
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'), // the shell's — must stay named
          workbench: resolve(__dirname, 'src/preload/workbench.ts'),
        },
      },
    },
  },
  ```

  The `externalizeDepsPlugin({ exclude: ['zod'] })` already on that block applies to both entries,
  which matters: the config's own comment records that "a sandboxed preload cannot resolve from
  `node_modules` at runtime", so anything the workbench preload validates with has to be bundled
  the same way.

- **It is loaded into the main frame only.** `nodeIntegrationInSubFrames` stays off — §4.1a
  already establishes that turning it on loads "all your preloads … for every iframe", and the
  workbench's iframes are extension webviews. Off, the bridge exists in the workbench document and
  in none of the content it hosts. **This is the property surface (A) could not have**, stated
  from the other side: the same option that would have made (A)'s delivery possible is the one
  that would put this preload in front of every extension webview.

**The API, which is one method because one is all the surface needs.**

```ts
// apps/desktop/src/preload/workbench.ts — the whole exposed surface.
contextBridge.exposeInMainWorld('chorusWorkbench', {
  // Resolves once, with the descriptor for THIS view's project. No arguments:
  // the renderer cannot name a project, because main derives it from the sender.
  connection: (): Promise<WorkbenchConnection> => …,
})
```

No bounds, no commands, no pass-through, no second method. Bounds travel shell→main and never
touch the workbench; §4.2's prohibition on a generic command channel applies here first, because
this is the context that would most like one.

**Delivery ordering, which is the half round 2 left as "ordinary `ipcMain`".** That phrase settles
_who may speak_ — `event.sender` identifies a top-level `WebContents` unambiguously, with no
subframe question — and says nothing about _when_, which is where this class of bug actually
lives. Four rules, in the order they matter:

1. **Main pushes on the view's own load, not on creation.** `view.webContents` is the target
   (<https://www.electronjs.org/docs/latest/api/web-contents-view>), and the send is sequenced
   after that `webContents`'s own `did-finish-load` — "emitted when the navigation is done … and
   the `onload` event was dispatched"
   (<https://www.electronjs.org/docs/latest/api/web-contents>). Anything sent before a document
   exists has nothing to receive it; **Electron's docs make no promise that `send` queues**, and
   designing on the assumption that it does is exactly the unread-shape failure `CLAUDE.md`
   warns about.
2. **The preload buffers it, so early delivery cannot be lost.** Even sequenced on load there is a
   window between the document existing and the entry module subscribing — one module graph, and
   under a REH-backed workbench a large one. Preload scripts are "injected before a web page loads
   in the renderer" (<https://www.electronjs.org/docs/latest/tutorial/tutorial-preload>), so the
   preload's `ipcRenderer.on` listener is the earliest possible receiver: it registers at the top
   of the script, holds whatever arrives, and `connection()` returns it immediately if it is
   already there. The buffer is what makes rule 1 sufficient rather than merely likely.
3. **A pull answers a reload, because a buffer does not survive one.** If the workbench document
   reloads — a crash recovery, a dev-server full reload, anything calling `location.reload()` —
   the preload re-executes with an empty buffer and the push has already happened. So
   `connection()` falls back to `ipcRenderer.invoke('workbench:connection')`, and **main answers
   by looking up which view the sender is**, never by trusting a project id in the request. Push
   plus pull is one mechanism with two triggers, not two mechanisms.
4. **Every descriptor is bound to one project and one view.** Main holds view id → project → REH
   descriptor, and resolves the request from `event.sender`. `IpcMainEvent.sender` "returns the
   `webContents` that sent the message"
   (<https://www.electronjs.org/docs/latest/api/structures/ipc-main-event>), and Electron's own
   security guidance is to "always validate incoming IPC messages `sender` property to ensure you
   aren't performing actions or sending information to untrusted renderers", because "all Web
   Frames can in theory send IPC messages to the main process"
   (<https://www.electronjs.org/docs/latest/tutorial/security>). Note the documented trap for the
   reload case: `senderFrame` "may be `null` if accessed after the frame has either navigated or
   been destroyed", so **validation keys on the `WebContents`, which the map is keyed by anyway**,
   and treats an unknown sender as a refusal rather than as a default.

**Two tests, and they are the ones that fail if any of the four rules is dropped:**

- **Cross-view isolation.** Two surfaces on two distinct roots; each `connection()` resolves to
  **its own** project's descriptor, and a request from view A can never obtain B's. The test that
  matters is the adversarial one — invoke the pull channel from A while B is open and assert A's
  descriptor comes back, because a lookup accidentally keyed on "the most recently opened project"
  passes every non-adversarial version of this test.
- **Reload.** Reload a mounted surface and assert `connection()` resolves again, with the same
  descriptor and the same project. With rule 3 missing this hangs rather than throwing, which is
  the failure mode that gets misread as a slow workbench.

**One thing this does not buy, said plainly.** Once `connection()` resolves, the token is in the
workbench document's JavaScript heap — it has to be, because the client opens the WebSocket. The
preload narrows _who can ask_ and _what else is reachable_; it does not make the token unreadable
by code running in that document, and §5.3's three carriers are unaffected. What it removes is the
shell's ability to ask at all, and the workbench's ability to do anything else with Chorus.

### 4.2 The files

Paths are relative to the repo root. Links are relative to this document so they resolve in
preview.

| File                                                                                                                                       | What it does in Phase 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | What it deliberately does **not** do yet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ⬜ **[apps/desktop/build/workbench-runtime.json](../../../apps/desktop/build/workbench-runtime.json)**                                     | The single atomic manifest of §3.5: client version, upstream commit, per-platform artifact name + size + sha256.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Not consumed by packaging. Phase 1 downloads to a cache dir on demand; nothing is bundled into the installer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ⬜ **[scripts/workbench-manifest.mjs](../../../scripts/workbench-manifest.mjs)**                                                           | Regenerates the manifest from three sources, none of which is the tarball: the resolved `@codingame/monaco-vscode-api`'s compiled product module (§3.5 property 2), the VSCodium release API for asset names/sizes/sha256 strings, and **`upstream/stable.json` at the release tag** for `upstreamTag`/`upstreamCommit` (§3.5 property 3). Run by a person, output committed.                                                                                                                                                                                                                                                                                                                    | Does not run in CI, does not download artifacts. **Does not read provenance out of an unpacked server** — round 3 established there is none there to read.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ⬜ **[packages/workbench-protocol/](../../../packages/workbench-protocol)**                                                                | Zod schemas for the frame↔main messages and the manifest shape, plus the `client.vscodeCommit === server.upstreamCommit` test. Mirrors how `apps/desktop/src/shared/ipc.ts:1-9` is "the single source of truth for the IPC surface".                                                                                                                                                                                                                                                                                                                                                                                                                                                             | No agent/editor protocol. Phase 6's `EditorEdit` is not designed here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ⬜ **[apps/desktop/src/main/workbench-host.ts](../../../apps/desktop/src/main/workbench-host.ts)**                                         | Resolves the artifact for this platform, verifies its sha256, unpacks to `userData` **and writes the extraction receipt of §3.5 property 3**, spawns **one** REH with a random token on an ephemeral loopback port, parses the port back out of the child's stdout, and exposes `acquire(projectId) / describe / release(projectId) / stopAll`. **One shared server, leased per open project and refcounted by projects requiring REH state** (§5.4); each project's connections are opened and owned by its **surface**, not by the host. Extraction follows §3.5 property 3's transactional order. `stopAll` on `will-quit`.                                                                   | No crash-restart policy, no update flow. **Corrected in review round 3: this row said "no multi-project pooling. One project, one server", which contradicted §4.1a's shared-REH decision** — the phase's whole isolation proof needs two roots on one server. What it still does not do is refcount by _visible view_: a project keeps its **lease** while it is open, mounted or not. **Round 4: the lease is all the refcount holds.** It does not keep a connection open, so it cannot by itself keep server-side terminals alive — that is the server's grace timer, and §5.4's probe decides it. |
| ⬜ **[apps/desktop/src/main/workbench-surface.ts](../../../apps/desktop/src/main/workbench-surface.ts)**                                   | Owns the isolated workbench surfaces of §4.1a — creates one **`WebContentsView` per open project on the _one_ dedicated `chorus-workbench` partition**, with a `webPreferences` literal naming **`preload/workbench.js`** and never a spread of the window's (§4.1b), applies that session's CSP, permission handlers and navigation lock before loading anything into it, hands the shell an **opaque view ID**, and delivers `(port, token, commit, root)` into that surface and no other — pushed after that view's `did-finish-load`, answered again on pull. Holds view → project → descriptor and resolves every request from `event.sender`. The one place the token crosses out of main. | Does not persist a view ID, does not accept one it did not mint. Does not put the view on `session.defaultSession` — a test asserts it is not that session. **Does not let the shell's preload anywhere near the view, and never reads a project id out of a request.**                                                                                                                                                                                                                                                                                                                                |
| ⬜ **[apps/desktop/src/shared/workbench-ipc.ts](../../../apps/desktop/src/shared/workbench-ipc.ts)**                                       | **Two audiences, deliberately separated (§4.1a), and now two preloads to match (§4.1b).** Shell-facing: `workbench:open` → view ID, `workbench:setBounds`, `workbench:close` — **no secret on any of them**, generated into the shell's preload exactly as `apps/desktop/src/preload/index.ts:36-46` already does. Surface-facing: `workbench:connection` in both directions — main→view push after load, view→main pull for a reload — carrying port/token/commit/root to that surface alone, and generated into the **workbench** preload only. The schemas are shared; the exposure is not.                                                                                                   | No pass-through channel. No `workbench:command`. The moment a generic command channel exists, the allowlist is decorative. **`workbench:describe` is withdrawn** — returning the token to the shell was the §4.1a contradiction. The pull request carries **no arguments**: a project id in the payload would be a claim the sender is not entitled to make.                                                                                                                                                                                                                                           |
| ⬜ **[apps/desktop/src/renderer/workbench.html](../../../apps/desktop/src/renderer/workbench.html)**                                       | The second Vite entry. Empty body, one script.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Not styled as Chorus. No theming, no fonts, no i18n.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ⬜ **[apps/desktop/src/preload/workbench.ts](../../../apps/desktop/src/preload/workbench.ts)**                                             | **Added by review round 3 (§4.1b).** The workbench view's own preload, and the reason it exists is that the alternative is the shell's, which exposes the entire `ChorusApi` including `decideApproval` and `writeProjectFile`. Registers its `workbench:connection` listener at the top of the script — before the document's own code runs — **buffers** whatever arrives, and exposes exactly one method, `chorusWorkbench.connection()`, resolving from the buffer or falling back to a pull. Needs its own entry in `preload.build.rollupOptions.input`, alongside the existing `index` key.                                                                                                | Exposes nothing else — no bounds, no commands, no `ipcRenderer`. Loaded into the **main frame only**, since `nodeIntegrationInSubFrames` stays off; extension webview iframes never see it. Does not make the token unreadable inside the document — it cannot, and §4.1b says so.                                                                                                                                                                                                                                                                                                                     |
| ⬜ **[apps/desktop/src/renderer/src/workbench/entry.ts](../../../apps/desktop/src/renderer/src/workbench/entry.ts)**                       | **Awaits `chorusWorkbench.connection()`** (§4.1b), then calls `initialize()` once and opens `vscode-remote://127.0.0.1:<port>/<root>`. Port/token/commit arrive over that one call and are read from nowhere else.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **Never reads a query string, and no workbench URL carries `tkn`.** Does not touch `ipcRenderer` — it has none. No re-initialisation: the library cannot re-initialise in one JS global — that constraint is the reason for the isolated surface, so the entry must not pretend otherwise.                                                                                                                                                                                                                                                                                                             |
| ⬜ **[apps/desktop/src/renderer/src/workbench/services.ts](../../../apps/desktop/src/renderer/src/workbench/services.ts)**                 | The service-override list, one import per service, with a comment per line saying which Phase 1 proof needs it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | No Chorus theme, no keybinding remap, no product configuration beyond `commit`/`quality`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ⬜ **[apps/desktop/src/renderer/src/workbench/bridge-extension.ts](../../../apps/desktop/src/renderer/src/workbench/bridge-extension.ts)** | Registered in the web/UI host. Logs active editor URI, selection, dirty state and diagnostics through the real `vscode` API — proof 8, and nothing more.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Does not send anything to main, does not touch the event log, does not apply edits. Observation only; that is the whole point of proving it separately from using it.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ⬜ **[apps/desktop/src/renderer/src/workbench/WorkbenchFrame.tsx](../../../apps/desktop/src/renderer/src/workbench/WorkbenchFrame.tsx)**   | The shell's handle on one surface: asks main to open one, holds the returned **opaque view ID**, and reports its rectangle so main can `setBounds` the view over it, closing it on unmount. It renders an empty placeholder element and **contains nothing** — the workbench is composited by the window, not by this subtree (§4.1a (B)). The outer bundle must never import a `@codingame/*` module; this file imports nothing but React.                                                                                                                                                                                                                                                      | **Never sees port, token or commit.** No tab integration, no layout algebra. Phase 1 renders it in one throwaway panel. Does not attempt to clip, scroll or animate the view — those are the (B) costs, and Phase 1 measures them (§7.2).                                                                                                                                                                                                                                                                                                                                                              |

### 4.3 Two existing files Phase 1 cannot avoid changing

Both are load-bearing and both are easy to get wrong quietly.

**`apps/desktop/electron.vite.config.ts` — a second preload input as well as a second renderer
input, and each has its own trap (§4.1b).** The preload one is the cheaper to name: electron-vite
resolves `<root>/src/preload/{index|preload}.{js|ts|mjs|cjs}` by default, and declaring
`preload.build.rollupOptions.input` **replaces that default** rather than extending it, so the
existing entry has to be listed by name under the key `index` or `index.ts:63`'s
`join(__dirname, '../preload/index.js')` resolves to a file the build no longer emits. That
failure is loud — a window with no `window.chorus` at all — but it is loud at runtime, in the
shell, from a change that appears to be about the workbench.

**And the renderer alias trap, which is the expensive one.**
monaco-vscode-api requires `monaco-editor` to resolve to `@codingame/monaco-vscode-editor-api`.
This repository **already depends on real `monaco-editor@^0.56.0`**
(`apps/desktop/package.json`) and already imports it at
`apps/desktop/src/renderer/src/monaco-setup.ts:14-16`, for the accepted-and-measured `MonacoDiff`
Editor view. A `resolve.alias` in the renderer config is **global to that Vite build, not
per-entry** — so adding the alias naively would swap the Monaco under the existing diff editor
for CodinGame's fork, in the same build, with no error. The Phase 1 slice must therefore give the
workbench its **own** build configuration rather than a second input in the existing one, or
prove the alias can be scoped. **UNVERIFIED which of the two works; it is §9 item B2.**

**`apps/desktop/src/main/security.ts` — must gain a second policy, not a wider one.** See §5.2.
With surface (B) selected, `applyContentSecurityPolicy` and `lockDownNavigation` need to become
callable against **the workbench's session and the view's `webContents`** rather than only against
`session.defaultSession` and a `BrowserWindow`. The shell's own policy does not move. This is the
file where getting it wrong is a security regression rather than a broken build — and §4.1a
records the specific new way to get it wrong, which is to create the partition and then forget to
install anything on it.

### 4.4 The iframe is officially supported, officially beta, and demonstrated only one at a time

Plan §8.3 calls frame mode "the largest integration risk". That is right, and the detail sharpens
it in both directions.

**In the plan's favour — it is a first-class, documented feature, not a hack.** The README carries
a dedicated section, quoted verbatim:

> ## Sandbox mode (⚠️ beta ⚠️)
>
> One issue with VSCode is it's only designed to be initialized once. So the initialization
> options (workbench options, remote server authority...) can't be updated/reloaded. Also it's not
> possible to "unload" the services. To still be able to do it, a possibility is to run all VSCode
> code inside an iframe… To better integrate it, it's also possible to run the code in the iframe,
> but make the code interact with the main page dom. **This library supports that mode.**
>
> ⚠️ `window.vscodeWindow` should be set BEFORE any VSCode code is loaded

It is backed by a 62 KB first-party patch against VS Code
(`vscode-patches/0067-feat-support-loading-VSCode-in-an-iframe.patch`), whose core is
`export const mainWindow = (window.vscodeWindow ?? window) as CodeWindow`. Shadow DOM is
separately supported (also marked ⚠️ beta ⚠️) and the two compose. `demo/src/sandbox.ts` is
almost exactly Chorus's shape: a hidden iframe for a fresh JS realm, `attachShadow` in the parent,
and the parent's element handed in over `postMessage`.

**The mechanism that makes N instances possible is a module-level singleton per realm**
(`src/lifecycle.ts`):

```ts
export let servicesInitialized = false
export function checkServicesNotInitialized(): void {
  if (servicesInitialized) {
    throw new Error('Services are already initialized')
  }
}
```

N iframes are N JavaScript realms, so N independent copies of that module. That is the whole
argument for plan §2.4, and it is sound. **§4.1a's surface makes it stronger without changing
it**: N `WebContentsView`s are N top-level `WebContents`, which is N realms in N _processes_, so
the singleton cannot be shared even by accident. What that does not buy is anything about state
the library keeps outside the module — a shared storage key, a `window.top` reach — which is
still R12's residual, below.

**Against the plan — nobody has demonstrated N alive at once.** The maintainer's own trajectory
is worth reading in order: in discussion #560 (2025-01) _"Unfortunately, it's not possible! …
there are A LOT of reasons for it to not be possible, VSCode was just not designed that way, a
lot of stuff is stored globally"_; then in the same thread on 2026-05-27, a single sentence:
_"Note that it's now possible, see https://monaco-vscode-api.netlify.app/?sandbox="_. **The demo
it points at runs one instance and reinitialises it.** The section header in the demo says so:
_"Sandbox mode: reinitialize the workbench without reloading the page"_. No demo, doc or test
shows two workbenches alive simultaneously. **"N at once" is inference from the realm argument,
not a claim the project makes.**

**Two concrete hazards, both read out of the source rather than guessed:**

1. **Teardown is global _within one document_ — and which document that is, is Chorus's choice.**
   The documented cleanup is
   `document.querySelectorAll('[data-vscode]').forEach(el => el.remove())`, and the library's
   patch `0068` tags **every** element VS Code appends to `mainWindow.document.head` with
   `data-vscode="true"`, with no per-instance key.

   **Correction (Codex review, 2026-08-22).** The first draft concluded from this that "closing
   project A would remove project B's head elements", and then built R12 on that conclusion as a
   failure that was structurally expected. **That is only true in one of the two modes the
   README documents, and it is the mode Chorus does not have to use.** The whole hazard turns on
   `export const mainWindow = (window.vscodeWindow ?? window) as CodeWindow`:

   - **Parent-DOM integration** — `window.vscodeWindow` set to the parent, which is what the
     README describes as the extra step to "run the code in the iframe, but make the code
     interact with the main page dom". Every instance's head elements then land in **one shared
     parent document**, unkeyed, and a global cleanup genuinely does reach a sibling. **Here the
     first draft's claim is correct.**
   - **Ordinary iframe-contained rendering** — `window.vscodeWindow` left unset, which the README
     documents **separately and first**: "run all VSCode code inside an iframe instead of in the
     main page". `mainWindow` is then the iframe's own `window`, the tagged elements land in
     **that frame's own `document.head`**, and a `querySelectorAll` executed in that realm cannot
     see, let alone remove, a sibling frame's elements. Cross-document DOM removal is not a thing
     that happens by accident.

   — <https://github.com/CodinGame/monaco-vscode-api#sandbox-mode--beta->

   **So the rule for Chorus is a prohibition, not a mitigation: parent-DOM integration is
   forbidden in Phase 1, and each workbench renders entirely inside its own document.** Chorus
   has no need of the parent-DOM mode — its reason for existing is visual integration with a
   host page, and §4.1a's selected surface gives each workbench not merely its own document but
   **its own top-level `webContents`**, in which `window.vscodeWindow` has nothing to point at.
   Hazard 1 is therefore **designed out** rather than tested for, and the cost of designing it out
   is zero.

   **R12 stays, and the reason it stays has changed.** It is no longer "the defect most likely to
   be found" — this brief no longer expects it to fail. It stays because it is binary, costs
   almost nothing, and covers the residual risk this analysis does **not** rule out: any global
   the library keeps outside the per-realm module state, and the possibility that some service
   reaches for `window.top` or a shared storage key regardless of `vscodeWindow`. That residual
   is real and **UNVERIFIED**; it is simply not the mechanism the first draft named.

2. **~~Cross-realm retention~~ — withdrawn, and R11 is redefined rather than retitled.** The
   parent-DOM mode deliberately hands a _parent-realm_ DOM element into the iframe, which is a
   permanent cross-realm reference — the opposite of the maintainer's own advice elsewhere
   (_"use sandbox iframes, and communicate with it only via postMessages"_). **The same
   prohibition in hazard 1 removes this reference**, and §4.1a's selection of `WebContentsView`
   removes even the possibility: each workbench is its own top-level `webContents`, so there is no
   shared JS heap for a parent-realm reference to be retained in and no parent element to hand
   over. **This hazard no longer exists in Chorus's design.**

   > **Correction (Codex review round 2, 2026-08-22).** The revised draft withdrew the hazard here
   > and then left R11 in §8.3 still described as _"the direct test for §4.4 hazard 2, cross-realm
   > retention"_, measuring _"renderer heap"_. Both halves were stale. A test named after a
   > withdrawn hazard invites the reader to believe the hazard is still being covered — and worse,
   > **a heap measurement is now the wrong instrument entirely**: under (B) each workbench is a
   > separate process, so a JS heap sampled in any one renderer cannot see the others, and the
   > interesting failure — a `WebContentsView` that is destroyed but whose process never exits —
   > is invisible to it by construction. R11 is rewritten in §8.3 against **resident memory summed
   > across every workbench `WebContents` and its process**, plus the process inventory itself.

   What survives the prohibition is the ordinary question, and it is the one worth measuring:
   **does closing a project actually give the memory back.** For a long-lived app that opens and
   closes projects all day that is still an open risk rather than a solved one, and it is now
   R11's whole subject.

Three smaller notes that would otherwise cost a day each:

- **`ViewsServiceOverride` and `WorkbenchServiceOverride` are mutually exclusive** — _"You are
  expected to either use the `ViewsServiceOverride` or the `WorkbenchServiceOverride`, never both
  at the same time"_ (issue #817). Phase 1 wants the workbench one.
- **The `next` dist-tag reading `16.1.0-shadow-root.1` is a stale pointer, not abandonment.** It
  was the prerelease of the shadow-root PR, merged and shipped as stable `16.1.0` three days
  later; shadow DOM is mainline and still getting fixes as of 2026-06. Do not read `next@16` vs
  `latest@36` as a dead project.
- **The demo needs `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
credentialless`**, because the `*-language-features` extensions use `SharedArrayBuffer` in the
  _web worker_ extension host. With a REH those extensions run server-side, so cross-origin
  isolation may be droppable — **UNVERIFIED**, and it matters because COEP interacts with
  everything in §5.2.

---

## 5. Security model

### 5.1 What is actually being added

A REH is not a sandbox and not a helper. It is **a process that reads and writes any file the
user can, spawns arbitrary processes, opens terminals and runs debuggers, controlled entirely
over a local socket.** Anyone who can complete a connection to it has the user's privileges.

That reframes the boundary: **loopback binding is not the protection.** Binding to `127.0.0.1`
keeps the machine off the network; it does nothing against another process on the same machine,
and on a developer's laptop that includes every npm postinstall script, every browser tab's
`fetch` to `http://127.0.0.1:<port>` (subject to CORS, which does not stop the request being
sent), and every other agent Chorus itself is running. **The token is the entire boundary**, and
it must be treated with the seriousness that implies.

**And it has to be, because the stronger mechanism is out of reach.** The server offers
`--socket-path` — a Unix domain socket, where filesystem permissions rather than a shared secret
would be the boundary, which is strictly better for a local-only sidecar. The workbench client is
a browser context and opens a `WebSocket`, so it cannot use one. **Loopback TCP plus a token is
therefore forced, not chosen**, and that is worth writing down so nobody later reads the design
as a shortcut.

Three defaults that are already in Chorus's favour, read from
`src/vs/server/node/serverEnvironmentService.ts` at tag `1.128.1`:

- **`--host` defaults to `localhost`.** Binding to all interfaces takes a deliberate flag. Chorus
  should still pass `--host 127.0.0.1` explicitly rather than rely on it.
- **`--port 0` is supported and documented:** _"If 0 is passed a random free port is picked."_
  So §5.4's port-discovery rule is not a workaround; it is the intended usage.
- **`--server-data-dir`, `--user-data-dir` and `--extensions-dir` all exist**, which is what makes
  plan §3.2's "Chorus-owned user-data and extensions directories, separate from VS Code/VSCodium"
  achievable without tricks.

### 5.2 What the existing renderer lockdown forbids, and what has to give

`apps/desktop/src/main/security.ts` is unusually tight, and every one of these lines is currently
incompatible with an embedded workbench. Naming them individually is the point — the risk is that
they get relaxed as a block.

**Read the whole table under one correction (Codex review round 2, 2026-08-22).** With §4.1a
selecting `WebContentsView`, **none of these lines is edited.** They describe
`session.defaultSession`, which stays exactly as it is; the workbench runs on its own
`chorus-workbench` partition and needs its own policy built there from `default-src 'none'`
upward. The "Minimum acceptable change" column is therefore better read as **"what the workbench
session's policy must contain"**, and the shell's protections are not on the table at all. That is
the security win (B) was chosen for, and it also relocates the risk: the danger is no longer that
the shell's CSP gets loosened, it is that **the workbench session gets no CSP at all**, because a
new partition starts with none. §4.1a specifies the controls that have to be installed on it
deliberately.

| Line                | Current                                                    | Why the workbench conflicts                                                                                                                                 | Minimum acceptable change                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `security.ts:11`    | `default-src 'none'`                                       | Everything is denied by default.                                                                                                                            | Keep the default; add only the specific directives below.                                                                                                                                                                                                                                                                                     |
| `security.ts:22`    | `connect-src 'self'`                                       | The frame opens a WebSocket to `ws://127.0.0.1:<port>` and fetches server resources over HTTP.                                                              | `connect-src 'self' ws://127.0.0.1:<port> http://127.0.0.1:<port>` — **with the port substituted at spawn time**, not a wildcard. A wildcard `127.0.0.1:*` would let any local server be reached from the renderer.                                                                                                                           |
| `security.ts:18`    | `frame-ancestors 'none'`                                   | **Resolved — it does not apply.** Nothing frames anything under (B). The (A) proposal to relax this to `'self'` is withdrawn as self-contradictory (§4.1a). | **Leave `'none'` untouched on the shell, and set `frame-ancestors 'none'` on the workbench policy too.** The workbench is not embedded by anything either, so it needs no ancestors — and a workbench document that permits framing is one an extension webview could try to frame.                                                           |
| `security.ts:22`    | `script-src 'self'`                                        | Extension webviews load extension-supplied script.                                                                                                          | This is the hardest one and it is **UNVERIFIED how far it must move**. Whatever it becomes, it becomes it **on the workbench session only**; the shell's `script-src 'self'` is not in the blast radius any more. §9 item B4.                                                                                                                 |
| `security.ts:91-93` | `will-attach-webview` → `preventDefault()`                 | Blocks Electron `<webview>`. Code-OSS webviews are `<iframe>`, not `<webview>`, so this may not conflict at all. **UNVERIFIED**; §9 item B4.                | **Change nothing — and _add_ it to the view.** It binds to a `BrowserWindow`'s `webContents`, so the workbench view does not inherit it (§4.1a). Re-bound there it stops the workbench quietly reintroducing a `<webview>`; left unbound it is not relaxed, it is absent, which is a dead control rather than an error (`security.ts:67-84`). |
| `security.ts:59-64` | `will-navigate` blocked unless `file://` or the dev server | The workbench loads its own `workbench.html` (fine) but may navigate internally.                                                                            | Re-bind to `view.webContents` and admit the workbench document's own origin, nothing else. Same note as the row above: it is not inherited.                                                                                                                                                                                                   |
| `security.ts:49-52` | All permission requests denied                             | Some extensions request clipboard/notifications.                                                                                                            | **Leave denied in Phase 1 — and set the handlers on the workbench session explicitly.** A new partition has no handler at all, so "denied" is only true where it is installed. A denial is a legible failure; a blanket grant is an invisible one, and an absent handler is invisible twice over.                                             |

The rule to carry through: **add the exact origins the workbench needs, never a scheme or a
wildcard.** The repository already has the cautionary tale — `security.ts:67-84` records a case
where two allowlists over the same decision drifted and the drift showed up as a dead control
rather than an error.

### 5.3 Token generation, storage and transport — read out of the server's own source

All of the following is read from `src/vs/server/node/serverConnectionToken.ts` and
`src/vs/base/common/network.ts` at tag `1.128.1`, not from documentation:

**The default is not what plan §3.2 asks for, and the difference is easy to miss.** Left to
itself the server does this (`serverConnectionToken.ts`, `determineServerConnectionToken`):

```ts
const storageLocation = path.join(args['user-data-dir'], 'token')
// read it if it exists and matches the charset; otherwise generate one and…
await Promises.writeFile(storageLocation, connectionToken, { mode: 0o600 })
```

— it generates a UUID **once**, writes it to `<user-data-dir>/token`, and **reuses it on every
subsequent launch**. Plan §3.2 says "generate a random connection token per launch". You do not
get that by default; you get a long-lived secret on disk. So:

- **Chorus generates the token itself, per launch, and passes it in.** `crypto.randomUUID()` is
  the natural choice and is also what the server itself uses.
- **The charset is enforced:** `/^[0-9A-Za-z_-]+$/`. A UUID passes. **Plain base64 does not** —
  `+`, `/` and `=` are all rejected, and the server's error is a parse error at startup, not at
  connection time. Use `randomUUID()` or base64**url**, never `randomBytes().toString('base64')`.
- **`--connection-token-file` exists and is the right flag.** Confirmed present and validated in
  `parseServerConnectionToken`. It cannot be combined with `--connection-token` or
  `--without-connection-token` — the server refuses with an explicit error. Write the file with
  `mode: 0o600`, which is what the server does for its own.
- **Do not use `--connection-token`.** A token on the argv is visible in `ps` output to every
  user on the machine, for the process's whole life. **This is not a theoretical concern — it was
  CVE-2024-26165 / GHSA-54p6-6j68-j5vr, fixed in 1.87.2**, and the server's own JSDoc says so:
  _"If the server is running on a multi-user system, then consider using `--connection-token-file`
  which has the advantage that the token cannot be seen by other users using `ps` or similar
  commands."_ Microsoft's own Rust CLI now refuses the inline form outright, with the comment
  _"intentional that we don't pass --connection-token here, we always convert it into the file
  variant."_
- **`--connection-token-file` does zero permission checking.** No `stat`, no mode check; it is
  read once, synchronously, at startup, with no rotation. **The permissions are entirely Chorus's
  responsibility** — the JSDoc's own advice is to place it in a `chmod 0700` directory. Because
  the read happens once at startup, Chorus can and should delete the file as soon as the server
  reports ready.
- **Never `--without-connection-token`.** The CodinGame doc's own example uses it _and_ passes
  `--host 0.0.0.0`, with its own warning "Do not use it as is in production". Together those two
  flags are a remote-code-execution hole, and they are the copy-paste that will be reached for
  the first time a connection fails.

**A malformed or conflicting token argument is fatal**, not a warning: the server `console.warn`s
and calls `process.exit(1)`. So a bad token file shows up as a sidecar that never opens a port,
and §5.4's "read the port from the child's own output" is also how that failure becomes visible.

**Where the token travels, and therefore where it leaks.** There are **three** representations of
one secret, not two:

| Carrier                       | Name                              | Leak surface                                                                                                                                                                                                     |
| ----------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP query string             | `tkn`                             | Appears in every workbench URL and in **every `vscode-remote-resource` `src` attribute in the DOM, permanently**. Also in the renderer's session history and any devtools recording.                             |
| HTTP cookie                   | `vscode-tkn`                      | Set with only `sameSite: 'lax'` and a one-week `maxAge` — **no `httpOnly`, no `secure`, no `path`**. It _cannot_ be `httpOnly`, because the client reads it back with `getCookieValue()` from `document.cookie`. |
| WebSocket first control frame | `{ type: 'auth', auth: <token> }` | **Not on the upgrade request at all** — `handleUpgrade` never validates. It is also reused as a stand-in for the vsda signature, because a browser has no vsda.                                                  |

The client appends it to resource URLs itself (`network.ts:243`,
`query += `&${connectionTokenQueryName}=${encodeURIComponent(connectionToken)}``), so the DOM
exposure is not optional. Three more facts that change the handling:

- **Two endpoints sit _above_ the token check and are unauthenticated: `/version` and
  `/delay-shutdown`.** `/version` returns the server's `product.commit`. That is a small
  information leak — and it is also the cheapest possible health check and identity assertion,
  which §5.4 and §7.2 both use.
- **The comparison is plain `===`, not constant-time.** Not exploitable in the usual sense over a
  local socket, but worth not building a retry loop that would make it interesting.
- **Full request URLs are logged only at `--log trace`.** Never ship a trace-level REH.

The rules that follow:

- **Anything that writes a workbench URL to a log must redact `tkn`.** Chorus's `logging.ts` is
  the place to enforce it, once, rather than at every call site.
- **The outer Chorus renderer must never be handed the token.** Only the workbench context needs
  it. If it flows through the shell's React state, every future component and every future log
  line becomes a leak site. **The first draft of §4.2 violated this rule while stating it** — a
  `workbench:describe` returning the token to the shell, which then put it in the frame's query
  string. §4.1a withdraws that mechanism and replaces it with direct main→surface delivery, and
  **§4.1b names the only thing on the receiving end**: a dedicated workbench preload exposing one
  method, in the main frame only. The rule's converse matters as much and was unstated until round
  3 — **the workbench must never be handed the shell's API either**, which is what it would get by
  default.
- **Never write it to the event log.** This is `CLAUDE.md`'s "state is not history" applied
  exactly: a token read back a week later is worse than having none.

### 5.4 Process lifecycle — and what to copy rather than invent

The repository already solved most of this for PTYs, and the shapes transfer.

| Concern                 | Existing precedent                                                                                                                                                                         | What the sidecar does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Spawn**               | `terminal.ts:707-720` (`nodePty`) loads the native module lazily via `require` so "a machine where the binding is broken fails when a terminal is opened rather than when the app starts". | Same discipline: resolve and verify the REH when a project is opened, not at app boot. An app that will not start because a 76 MB tarball is missing is worse than a project that will not open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Port discovery**      | `CLAUDE.md`, "The e2e harness used to attach to whatever owned port 9800" — the fix was `--remote-debugging-port=0` and reading the port back out of the child's own stderr.               | **Do exactly this**, and the server makes it easy: it prints `Web UI available at http://localhost:<port>?tkn=<token>` on stdout. Pass `--port 0` and parse that line. Never pick a port, never scan, never assume. Attaching to a stale REH from a previous run — possibly a _different commit_ — is the identical failure, and it would present as a workbench that works and is wrong. **Redact the `tkn=` before that line reaches any log.**                                                                                                                                                                                                                                                 |
| **Shutdown**            | `terminal.ts:494-501` `close()` walks every session and every global terminal on quit.                                                                                                     | One `stopAll()` on `will-quit`, and it must be synchronous enough to actually run. A REH left behind holds a port and a project root.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Orphans**             | `reap.ts` — PPID-1 matching against `AGENT_PATTERNS = ['codex app-server', 'claude --']`, macOS/Linux only, off on Windows and honest about it.                                            | A REH needs **its own** pattern; it must not be added to `AGENT_PATTERNS`. And `reap.ts`'s own comment is the warning: a naive `pgrep -f` port to Windows "would match the user's own `codex` running in their own terminal" — a naive REH pattern would match the user's real VSCodium. Match on the Chorus-owned `--server-data-dir` path, which no other server will have.                                                                                                                                                                                                                                                                                                                     |
| **Windows cleanup**     | `reap.ts` reports `skipped` and does nothing on Windows, deliberately.                                                                                                                     | The same gap applies and is worse: a leaked REH on Windows holds a lock on the extensions directory. This is a named Phase 7 item, not a Phase 1 one, but Phase 1 must not pretend it is handled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Health and identity** | —                                                                                                                                                                                          | `GET http://127.0.0.1:<port>/version` returns the server's `product.commit` and **needs no token** — it sits above the auth check. Use it as the liveness probe; do not infer health from the process being alive. **It is not an identity assertion, and round 3 retracts the claim that it is:** after §1.5b's patch that field is the value Chorus wrote into it, so every server Chorus has ever patched answers identically (§3.5 property 3). Identity comes from the extraction receipt plus the fact that main spawned this child and read this port out of its own stdout. Follow the `describe` precedent in `terminal.ts:711-748` — report the _observed_ state, not the intended one. |

**The lifecycle of §4.1a's shared REH, stated as three separate lifetimes — rewritten in review
round 4, because round 3's own table was impossible as written.** Round 3 fixed a real
contradiction (§4.2 said "one project, one server … no multi-project pooling" while §4.1a had
chosen a shared REH) and, in the table it wrote to settle it, introduced another.

> **Retraction (Codex review round 4, 2026-08-22).** The row **"a project's connection set —
> starts: project opened · ends: project closed · held whether or not a surface is mounted"** is
> **withdrawn**. It describes a lifetime nothing implements and nothing could. That "connection
> set" is the project's **management and extension-host WebSockets**, and they are opened by, and
> owned by, the surface's `WebContents` — §4.1a puts the client there and §5.3 keeps the token out
> of everywhere else, so there is no other process holding a socket. Unmounting the surface
> destroys the `WebContents` and closes them. A connection set cannot outlive the thing that
> holds it. **This is the fourth time a claim in this brief has been introduced _by_ a round of
> review while it was fixing something else** — the round-3 header note counts three; this is the
> next one, and the pattern it describes is now the most reliable thing in the document.

The three lifetimes, honestly:

| Lifetime                                                                                   | Starts                                | Ends                                                                                 | Refcount?                                                                           |
| ------------------------------------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| **Server lease** — the one shared REH process                                              | Project opened — `acquire(projectId)` | Project closed — `release(projectId)`, or `stopAll()` on `will-quit`                 | **Yes — by open project requiring REH state.** Never by view, never by connection   |
| **Live client connection set** — that project's management + extension-host WebSockets     | Surface **mounted**                   | Surface **unmounted** — they are the surface's sockets and go with its `WebContents` | No. It cannot outlive its owner, and nothing is counting it                         |
| **Server-retained project state** — the forked extension host and its persistent terminals | First connection for that project     | A **server-side grace timer**, or `stopAll()`                                        | **Survival across a disconnect is UNVERIFIED** and gated on the remount probe below |

**The unit of the refcount is the project, and the distinction from "visible view" is the whole
point.** Plan §1.1 promised that "inactive projects keep agents and server-side terminals alive
when resources allow" and §2.4 that "inactive tabs close their surface but keep project state,
agents and REH-side terminal processes" — **both sentences were reworded by round 4** to say
_bounded window_ rather than _alive_, for the reason set out below; they are quoted here in their
original form because they are what this argument was written against. With a maximum of four
visible panes and no limit on open projects, **a
refcount over mounted views reaches zero while projects are still open** — and the observable
result is that switching to a fifth project kills the build running in the first one's terminal.
That is the exact bug the plan's own sentence forbids, arrived at by counting the wrong thing, and
it is unrecoverable rather than merely annoying: a terminal is a process with output nobody kept.

So: `acquire` on **project open**, `release` on **project close**, and unmounting a surface calls
neither. This is the same shape as `CLAUDE.md`'s rule for terminals one level out — "the shell
lives in main, the component is a _view_ onto it, and unmounting calls `detach` and never
`dispose` — otherwise clicking another tab would kill a running build". The REH is that sentence
with a server in place of a PTY.

Closing project A must therefore dispose A's surface and let A's management and extension-host
connections drop — the server reaps them on its own grace timer — while B stays connected, and
`stopAll()` on `will-quit` remains the only unconditional kill.

**And here is the part the refcount cannot settle, which is the load-bearing unknown of this
subsection.** The product promise — plan §1.1 and §2.4 as they stood — was that an inactive
project's REH-side terminals survive its surface being unmounted. **The refcount does not deliver
that and cannot.**
It governs whether the shared **server process** keeps running; it does not hold a socket open,
because there is no socket left to hold once the `WebContents` is gone. A refcount of 1 over a
server that has already discarded project A's state is a live process with nothing of A's in it.
**So if server-side retention does not hold, refcounting alone cannot preserve the promise** —
that is the whole reason this is a Phase 1 finding rather than a Phase 4 surprise.

**What the upstream server actually does, read at the pinned tag rather than assumed.** Round 3
left this as "nothing read for this brief establishes it". Enough is now established to say the
mechanism exists, is time-bounded, and interacts badly with the shared-REH decision:

- **Persistent terminals are killed by a grace timer, not kept indefinitely.** The pty service
  arms two schedulers whose callbacks call `this.shutdown(true)` on the persistent process — one
  at `reconnectConstants.graceTime`, one at `reconnectConstants.shortGraceTime`
  ([`src/vs/platform/terminal/node/ptyService.ts` at `1.121.0`](https://raw.githubusercontent.com/microsoft/vscode/1.121.0/src/vs/platform/terminal/node/ptyService.ts)).
  So retention is real, and it has a deadline.
- **The REH's deadline is the server's own, and it defaults to three hours.** `serverServices.ts`
  builds the constants as
  `{ graceTime: environmentService.reconnectionGraceTime, shortGraceTime: environmentService.reconnectionGraceTime > 0 ? Math.min(ProtocolConstants.ReconnectionShortGraceTime, environmentService.reconnectionGraceTime) : 0, … }`
  ([`serverServices.ts`](https://raw.githubusercontent.com/microsoft/vscode/1.121.0/src/vs/server/node/serverServices.ts)),
  where `ReconnectionGraceTime = 3 * 60 * 60 * 1000` and `ReconnectionShortGraceTime = 5 * 60 * 1000`
  ([`ipc.net.ts`](https://raw.githubusercontent.com/microsoft/vscode/1.121.0/src/vs/base/parts/ipc/common/ipc.net.ts)),
  and `--reconnection-grace-time <seconds>` is a documented server flag — _"Override the
  reconnection grace time window in seconds. Defaults to 10800 (3 hours)."_
  ([`serverEnvironmentService.ts`](https://raw.githubusercontent.com/microsoft/vscode/1.121.0/src/vs/server/node/serverEnvironmentService.ts)).
  Note these are **not** the desktop's `LocalReconnectConstants` (60 s / 6 s) — the server
  substitutes its own, which is why a figure remembered from local VS Code would be wrong here.

  **The flag is seconds, the constants are milliseconds, and the getter converts — which is what
  makes the clamp bite.** `get reconnectionGraceTime()` is
  `parseGraceTime(this.args['reconnection-grace-time'], ProtocolConstants.ReconnectionGraceTime)`,
  and `parseGraceTime` does `const millis = Math.floor(parsedSeconds * 1000)`
  ([`serverEnvironmentService.ts`](https://raw.githubusercontent.com/microsoft/vscode/1.121.0/src/vs/server/node/serverEnvironmentService.ts)),
  so everything downstream compares milliseconds against `ReconnectionShortGraceTime = 300_000`.
  **`shortGraceTime` is therefore not a constant, it is `min(300 s, graceTime)`** — and below
  300 s it collapses onto `graceTime` itself:

  | `--reconnection-grace-time` | `graceTime` | `shortGraceTime` = `min(300 s, graceTime)` | Can a later connection shorten anything? |
  | --------------------------- | ----------- | ------------------------------------------ | ---------------------------------------- |
  | _absent_ (default)          | 10800 s     | 300 s                                      | Yes — 3 h collapses to 5 min             |
  | `60`                        | 60 s        | **60 s**                                   | **No — the two are equal**               |
  | `300`                       | 300 s       | **300 s**                                  | **No — the two are equal**               |
  | `360`                       | 360 s       | 300 s                                      | Yes — the arithmetic floor               |
  | `900`                       | 900 s       | 300 s                                      | Yes — **the value run 2 uses**           |

  **The same expression appears twice**, at both layers, which is why one flag moves both: the pty
  layer takes it from `serverServices.ts` as above, and the connection layer computes it again
  inside `ManagementConnection`, whose constructor takes `reconnectionGraceTime: number` as a
  parameter and derives `_reconnectionShortGraceTime = reconnectionGraceTime > 0 ? Math.min(ProtocolConstants.ReconnectionShortGraceTime, reconnectionGraceTime) : 0`
  ([`remoteExtensionManagement.ts`](https://raw.githubusercontent.com/microsoft/vscode/1.121.0/src/vs/server/node/remoteExtensionManagement.ts)),
  the value being passed in from `this._reconnectionGraceTime = this._environmentService.reconnectionGraceTime`
  ([`remoteExtensionHostAgentServer.ts`](https://raw.githubusercontent.com/microsoft/vscode/1.121.0/src/vs/server/node/remoteExtensionHostAgentServer.ts)).
  Neither layer hardcodes the three-hour constant; both use it only as the default and the ceiling.

- **Both timers are `ProcessTimeRunOnceScheduler`, which does not count suspended time and has 1 s
  resolution.** Its own doc comment: _"Same as `RunOnceScheduler`, but doesn't count the time spent
  in sleep mode. > **NOTE**: Only offers 1s resolution."_ — it decrements a counter on a 1 s
  `setInterval` rather than arming a single `setTimeout`
  ([`async.ts`](https://raw.githubusercontent.com/microsoft/vscode/1.121.0/src/vs/base/common/async.ts)).
  **Two consequences for any probe below.** A wait has to be real elapsed time _with the server
  process running_ — closing the laptop lid does not advance it, and a probe that suspends the
  machine to "skip ahead" will observe a terminal that is still alive and record it as retention.
  And a grace value that is not a whole number of seconds logs a resolution warning; every value
  used here is.
- **🔴 Opening another project shortens the grace of every disconnected one — once, and at the
  connection layer.** On each new connection the server walks all of them: _"We have received a new
  connection. This indicates
  that the server owner has connectivity. Therefore we will shorten the reconnection grace period
  for disconnected connections!"_, calling `shortenReconnectionGraceTimeIfNecessary()` on every
  management **and** extension-host connection
  ([`remoteExtensionHostAgentServer.ts`](https://raw.githubusercontent.com/microsoft/vscode/1.121.0/src/vs/server/node/remoteExtensionHostAgentServer.ts)),
  which reschedules the disconnected one onto the short timer
  ([`remoteExtensionManagement.ts`](https://raw.githubusercontent.com/microsoft/vscode/1.121.0/src/vs/server/node/remoteExtensionManagement.ts)).
  **This is the refcount bug one level down, in the server, where the refcount cannot reach**: the
  observable shape is again "opening another project degrades an already-disconnected one" — once,
  per the arithmetic below, not cumulatively — except the countdown is the server's and Chorus does
  not own it. It is a **direct consequence of sharing one REH** — with
  a server per project there are no other connections to shorten.

  **"Shortens" is a second timer, not a reduction of the first — and that changes the arithmetic
  of every probe.** The body is:

  ```ts
  public shortenReconnectionGraceTimeIfNecessary(): void {
    if (this._disconnectRunner2.isScheduled()) {
      return
    }
    if (this._disconnectRunner1.isScheduled()) {
      this._disconnectRunner2.schedule()
    }
  }
  ```

  `_disconnectRunner1` keeps running untouched; `_disconnectRunner2` is scheduled **fresh, for a
  full `shortGraceTime` measured from the moment the new connection arrives**. Whichever fires
  first disposes the connection. So for a disconnect at `t = 0` and a later connection at `t = T`,
  the effective deadline is **`min(graceTime, T + shortGraceTime)`** — and the arrival only
  matters when `T + shortGraceTime < graceTime`. The early `return` also means the shortening is
  **once-only**: the second project to connect while A is disconnected changes nothing, because
  runner 2 is already scheduled. "Every new connection shortens it further" would be wrong.

- **The shortening loop walks connections, not terminals — and this is a distinction round 4 did
  not draw.** The two loops are over `this._managementConnections` and `this._extHostConnections`
  ([`remoteExtensionHostAgentServer.ts`](https://raw.githubusercontent.com/microsoft/vscode/1.121.0/src/vs/server/node/remoteExtensionHostAgentServer.ts)),
  and nothing in that path reaches a `PersistentTerminalProcess`. The terminal's own pair of
  runners is armed by `detach()` — `if (this.shouldPersistTerminal && (this._interactionState.value !== InteractionState.None || forcePersist)) { this._disconnectRunner1.schedule(); }` —
  and its runner 2 is armed **only** by `reduceGraceTime()`, which is reachable solely as the
  client-initiated `RemoteTerminalChannelRequest.ReduceConnectionGraceTime`
  ([`ptyService.ts`](https://raw.githubusercontent.com/microsoft/vscode/1.121.0/src/vs/platform/terminal/node/ptyService.ts)).
  **So project B connecting shortens A's _connection_ window directly, and reaches A's _terminals_
  only if the reaping of A's connections cascades into detaching or shutting down its persistent
  processes — which is exactly the thing that is UNVERIFIED.** The two windows happen to be the
  same length, because the same `min(300 s, graceTime)` expression is evaluated at both layers, and
  **that coincidence is a trap**: a probe that watches a terminal and concludes something about the
  connection window, or the reverse, will be right by accident and wrong when the flag changes.
  Observe both, and say which one each assertion is about.
- **The client can ask the server to shorten it further.** `reduceConnectionGraceTime` exists on
  the pty service and is reachable over the wire as
  `RemoteTerminalChannelRequest.ReduceConnectionGraceTime`
  ([`remoteTerminalChannel.ts`](https://raw.githubusercontent.com/microsoft/vscode/1.121.0/src/vs/server/node/remoteTerminalChannel.ts)).
  **Whether the CodinGame client calls it on unload is UNVERIFIED** — and it is the single thing
  most likely to turn an ordinary unmount into a terminal kill, because it would be Chorus's own
  client asking for exactly what Chorus is trying to prevent.

**What is still UNVERIFIED**, and is what the probe is for: whether the terminal processes actually
survive the connection being reaped and are re-attachable from a **new** connection made by a
remounted surface; and whether the forked extension host for that project survives at all, or is
disposed with its connection and re-forked on remount. Neither follows from the code above — that
code establishes the timers, not the re-attach path.

**The probe, corrected twice — round 3's instruction was unrunnable, and round 4's replacement
could not test the thing its third step named.**

> **Retraction (Codex review round 5, 2026-08-22).** Round 4 replaced "wait past the grace period"
> — three hours at the default — with a single run at `--reconnection-grace-time 60`, and hung
> **three** assertions off it, the third being "with A disconnected, open project B and confirm
> what B's arrival does to A's remaining window". **That third step is withdrawn from the 60-second
> run, because at 60 seconds there is nothing for it to measure.** `shortGraceTime` is
> `min(300 s, 60 s) = 60 s`, so runner 2 — scheduled fresh when B connects at `t = T` — is due at
> `T + 60`, which is **later** than runner 1's already-pending `60` for every `T > 0`. Runner 1
> fires first, and the run is bit-for-bit identical to one where B was never opened. **The step
> would have passed, and it would have proved nothing** — the worst of the three outcomes, because
> a green result is evidence and this one would have been evidence of the flag value rather than of
> the server's behaviour. Round 4 chose 60 to make the _expiry_ reachable and did not re-check the
> _shortening_ against the clamp it had itself quoted two paragraphs earlier.
>
> **This is the fifth time a claim in this brief has been introduced _by_ a round of review while
> it was fixing something else**, and the second time a correction's own new number went in
> unchecked (round 4's `manifestSha256` was the first). The count is now: round 3 introduced two,
> round 4 introduced two, round 5 introduces however many are found next. **The pattern is not
> incidental to this document, it is the most reliably reproduced result in it** — a correction is
> written with all the attention on the argument it is repairing, and the fresh detail it adds to
> make the repair concrete travels in unexamined. The mitigation that has actually worked is the
> one applied here: take every number a correction introduces and evaluate it against the source
> it was derived from, as a separate act from writing the prose.

**Two runs, because one grace value cannot serve both questions.** Retention-and-expiry needs a
window short enough to sit through; shortening needs a window **longer than the 300 s clamp**, or
`shortGraceTime` collapses onto `graceTime` and the mechanism is invisible.

**Run 1 — retention and expiry. `--reconnection-grace-time 60`.** Both directions, because only
the second can fail informatively:

1. Start a long-running command in project A's workbench terminal; unmount A's surface; wait
   **well inside** the window; remount and assert the process is still running **with its output
   intact** — re-attach, not merely a live pid.
2. Repeat, waiting **past** the window, and assert it is gone. Without this the first assertion
   passes against a server that never had a timer, and the test cannot distinguish "retained" from
   "the grace period had not elapsed yet".

**Run 2 — cross-project shortening. `--reconnection-grace-time 900`**, and **no other connection
occurs during the observation in either case**, so that B's connection is the single variable. Not
"only one project open at a time" — the case necessarily has **A open but disconnected while B
connects**, which is the mechanism under test; what must not happen is a third connection, a
remount of A before `t_obs`, or a reload, any of which would arm or re-arm a timer the arithmetic
below does not account for:

3. **Control, no B.** Unmount A at `t = 0` and open nothing else. At the observation point `t_obs`,
   A must still be **attachable** — the same re-attach assertion as run 1, not a liveness check.
4. **Case, B connects.** Identical, except that project B is opened at `t = T` shortly after A is
   unmounted. At the same `t_obs`, A must have **expired**.

**The two cases must be the same run length and differ only in B**, and `t_obs` is not free —
it follows from the arithmetic above rather than from taste:

- Effective deadline is `min(graceTime, T + shortGraceTime)` = `min(900, T + 300)`.
- Shortening is observable at all only when `T + 300 < graceTime`, i.e. **`T < 600 s`**. Open B
  promptly anyway: `T` is spent out of the margin below, so a late B buys nothing and a B opened
  after 600 s changes nothing at all, degenerating the case into the control.
- `t_obs` must satisfy `T + 300 < t_obs < 900`. At `T = 10 s` that is the interval
  **(310 s, 900 s)**, and `t_obs = 420 s` sits 110 s clear of one boundary and 480 s clear of the
  other.

**360 s is the arithmetic minimum, and that is the only thing it is.** Any `graceTime` above the
300 s clamp makes the mechanism visible, so 360 is the floor — but the window it leaves is
50 seconds wide (`T + 300 < t_obs < 360`, i.e. **(310 s, 360 s)** at `T = 10 s`), on a timer with
1-second resolution that only advances while the server process runs. Both boundaries are hard
failures in opposite directions, and both look like the **same**
null result: read before `T + 300` and the case has not expired yet, so it matches the control;
read after `graceTime` and _both_ have expired, so it matches the control again. A missed `t_obs`
does not announce itself — it reports "no shortening observed", which is also what a real absence of
the mechanism would report. Because `shortGraceTime` is pinned at 300 s for
**every** `graceTime ≥ 300 s`, the separation is `graceTime − (T + 300)` and buying margin costs
only wall-clock patience — which is why the run is specified at **900**, where the two margins are
110 s and 480 s rather than a shared 50 s. Run 2 takes about seven minutes twice; that is cheaper
than a result nobody can interpret.

**Both runs must record which layer each assertion is about**, per the connection-versus-terminal
bullet above. Run 2's shortening is proven at the **connection** layer by construction; whether it
reaches A's **terminals** is the cascade question, and the terminal assertion in case 4 is what
answers it. If A's connection expires on the short timer but A's terminal survives to 900 s, the
cascade does not exist — which would be good news for the product promise and must not be recorded
as a failed probe.

**If retention does not hold, the fallback must be chosen explicitly — refcounting alone cannot
preserve it.** The three candidates, none free:

- **Retain a hidden surface.** Keep the project's `WebContentsView` alive and simply not
  composited, so its sockets stay up. Honest and simple, and it spends exactly what the four-pane
  cap exists to bound — an unmounted project would cost a live `WebContents` and a workbench
  instance, so the cap would have to move from "visible" to "open", which is the resource gate
  §8.3 is measuring, re-opened.
- **Add a headless client connection owned by main.** Main holds the management connection per
  open project so the server never sees a disconnect. This puts the connection token in a **second
  place** and makes main a WebSocket client of the REH, which is a real widening of §5.3's "the
  token never leaves main except into a workbench surface" — it would need its own argument, not
  a mention.
- **Revise the product promise.** Say inactive projects keep terminals for a bounded window rather
  than indefinitely, and say what the window is. Given the shortening path above, the honest
  version of the current promise is already closer to this than to what plan §1.1 and §2.4 claim.

The choice is a **Phase 1 exit decision**, not an implementation detail, and it must be made from
the probe's result rather than in advance.

### 5.5 What a hostile local process could reach

| Reach                                              | With the token | Without the token        |
| -------------------------------------------------- | -------------- | ------------------------ |
| Read/write any file the user can                   | Yes            | No                       |
| Spawn arbitrary processes, open a terminal         | Yes            | No                       |
| Install and activate an arbitrary extension        | Yes            | No                       |
| Enumerate that a Chorus REH is running (open port) | —              | Yes                      |
| Exhaust the connection (DoS)                       | —              | Probably; **UNVERIFIED** |

So: **compromise of the token is compromise of the machine.** The mitigations that follow from
that are the ones above — per-launch, not on argv, not logged, not persisted — plus one design
rule: **the outer Chorus renderer must never be handed the token.** Only the workbench context
needs it. If the token flows through the shell's React state, every future component and every
future log line is a leak site. §4.1a is what makes that rule implementable rather than merely
stated: the shell holds an opaque view ID, and main delivers the token into the workbench surface
directly.

Finally, plan §3.1 is right that third-party extensions "execute with the user's local
privileges, as in desktop VS Code" — but the honest addition is that **Chorus's current attack
surface has no equivalent**. Today the renderer runs `sandbox: true`, `contextIsolation: true`,
`nodeIntegration: false` (`index.ts:62-69`) with `default-src 'none'` and a generated,
schema-validated IPC allowlist. An extension host removes all of that for the code running inside
it. That is not a reason not to do it — it is a reason the workspace-trust story in Phase 5
cannot be decorative, and it should be said in the release notes when it ships.

---

## 6. Extension proof set

Plan §4 sets four proof classes and Phase 1 proof 7 names a representative from each: **GitHub
Theme, Prettier, ESLint, and Draw.io/GitLens.**

Every row below was read from the extension's own `package.json` — via the Open VSX file API for
the sixteen that are published there, and via the Marketplace gallery CDN's
`Microsoft.VisualStudio.Code.Manifest` asset for the five that are not. Nothing was installed.

### 6.1 The correction that reframes plan §4's classes

**Correction (Codex review, 2026-08-22) — the first draft got the routing rule wrong, and
deleted a proof class on the strength of it.** It claimed that "browser-capable is not a
destination when a REH is attached", concluded that Draw.io along with everything else lands in
the Node REH, and collapsed plan §4's four proof classes to three by dropping the web/UI host.
**That is wrong, and the web-host class is restored.**

What is true is only the part about **deduced** kinds. VS Code deduces
`extensionKind: ["workspace", "web"]` for a manifest that has both `main` and `browser` and
declares no kind, and the running-location picker takes the **first** kind that has an available
host. `workspace` being first, GitLens, GitHub PR, YAML and Error Lens do land in the Node REH,
and their web worker is only the fallback when no remote is present. Prettier lands there too,
by declaration rather than deduction.

**What that reasoning cannot do is carry over to an extension that declares `ui` first**, and
Draw.io declares exactly that: `["ui","workspace"]`. From VS Code's own documentation:

> `"extensionKind": ["ui", "workspace"]` — Indicates the extension **prefers** to run as a UI
> extension, but does not have any hard requirements on local assets, devices, or capabilities.

and, decisively for a browser-hosted workbench:

> when the configuration is VS Code for the Web with Codespaces and the `extensionKind` is set
> to `ui`, then the web extension host is preferred over the remote extension host.

— <https://code.visualstudio.com/api/advanced-topics/extension-host>

A `ui`-preferring extension prioritises the **local** host, and in a workbench that runs in a
browser context the local host **is** the web worker extension host. Chorus's topology is
web+remote — precisely the shape that clause describes. So **a browser-capable extension
preferring `ui` can run in the web host; it is not automatically forced into the REH**, and the
first draft's sweep of Draw.io into the Node column was an inference the source does not support.

**One honest scoping of the citation.** The documented exception names "VS Code for the Web with
Codespaces" specifically. Chorus is web+remote but is not Codespaces, and **whether
monaco-vscode-api's running-location picker implements that exact branch is UNVERIFIED** — it is
one of the things §6.6's restored web-host slot exists to observe. The weaker claim needs no
exception clause and is enough on its own: `ui` is first in Draw.io's declared array, `ui` means
"prefer the local host", and Chorus has a local host.

So the practical classes remain **four**, matching plan §4:

1. **No host at all** — declarative contributions only.
2. **Web/UI host** — browser-capable extensions that declare `ui` first. Small, but non-empty,
   and it is the only class that exercises the web worker host at all.
3. **Node REH** — everything with a `main` that prefers `workspace`, which is most of the estate.
4. **Impossible** — licence and/or a runtime product check.

**Not one of the 21 installed extensions surveyed is browser-_only_**, and that remains the real
finding: the REH still carries the great majority of the estate, and a web-host result proves
little about the other twenty. But "carries most of it" is not "carries all of it", and dropping
the class entirely would have left Chorus with no proof at all that its web/UI host works —
which is also the host the trusted bridge extension of proof 8 runs in. That alone makes the
class non-optional.

### 6.2 The named proof set, and what each actually proves

| Extension                    | Version read  | `main` / `browser`                | `extensionKind`          | Licence                                    | Open VSX | **Expected host in Chorus**                                   |
| ---------------------------- | ------------- | --------------------------------- | ------------------------ | ------------------------------------------ | -------- | ------------------------------------------------------------- |
| `GitHub.github-vscode-theme` | 6.3.5         | **neither**                       | –                        | MIT                                        | ✅       | **No host** — pure `contributes.themes`                       |
| `esbenp.prettier-vscode`     | 12.4.0        | both                              | `["workspace"]`          | MIT                                        | ✅       | **Node REH** (web-capable, but `workspace` is declared first) |
| `dbaeumer.vscode-eslint`     | 3.0.34        | `main` only                       | `["workspace"]`          | MIT                                        | ✅       | **Node REH**                                                  |
| `hediet.vscode-drawio`       | 1.6.6         | both — **the same file for each** | `["ui","workspace"]`     | GPL-3.0                                    | ✅       | **Web/UI host** — `ui` is declared first (§6.1, corrected)    |
| `eamodio.gitlens`            | 2026.8.220509 | both                              | absent → `workspace,web` | MIT except `plus/` (GitKraken proprietary) | ✅       | **Node REH** when remote                                      |

Three notes that change what the proofs are worth:

- **GitHub Theme proves the _workbench_, not the extension system.** It has no entry point at
  all. A theme rendering proves contribution processing works; it proves nothing about either
  host. Do not let it stand in for "extensions work".
- **Draw.io points `main` and `browser` at the identical bundle** (`./dist/extension/index`).
  Whether that single bundle genuinely runs under a web worker — no `fs`, no `child_process` — is
  **UNVERIFIED** and would need a run. **That question is now load-bearing rather than
  incidental**, because §6.1's correction puts Draw.io in the web host by declaration: if the
  shared bundle turns out to need Node, the extension's own `ui` preference routes it somewhere
  it cannot run, and the observable result is an activation failure rather than a fallback. That
  is a genuinely informative outcome and a reason to keep Draw.io in the set — but it means a
  Draw.io failure must not be read as "the web host is broken" without checking which of the two
  it was. It is also **GPL-3.0**, the only copyleft licence in the set; that has no bearing on
  running it, but it does on anything Chorus might ever vendor.
- **Prettier's manifest and the gallery disagree.** It declares `extensionKind: ["workspace"]`
  yet ships `./dist/web-extension.cjs`, and the gallery reports `workspace,web` — a _deduction_
  from the presence of `browser`, not the declared field. Immaterial in Chorus's topology (Node
  either way), but a good example of why the manifest is read rather than the listing.

### 6.3 The rest of the §4 estate, by expected host

| Expected host             | Extensions                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **No host (declarative)** | `GitHub.github-vscode-theme`                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Web/UI host**           | `hediet.vscode-drawio` — the only surveyed extension declaring `ui` first (§6.1, corrected)                                                                                                                                                                                                                                                                                                                                                                              |
| **Node REH**              | `dbaeumer.vscode-eslint` · `esbenp.prettier-vscode` · `eamodio.gitlens` · `GitHub.vscode-pull-request-github` · `redhat.vscode-yaml` · `usernamehw.errorlens` · `ms-azuretools.vscode-containers` (and the empty `ms-azuretools.vscode-docker` shim that depends on it) · `bradlc.vscode-tailwindcss` · `mongodb.mongodb-vscode` · `GitLab.gitlab-workflow` · `msjsdiag.vscode-react-native` · `Postman.postman-for-vscode` · `anthropic.claude-code` · `openai.chatgpt` |
| **Impossible**            | `ms-vscode-remote.remote-ssh` · `ms-vscode-remote.remote-containers` · `GitHub.codespaces` · `ms-vscode.vscode-speech` · `ms-vsliveshare.vsliveshare`                                                                                                                                                                                                                                                                                                                    |

**One extension moved out of the Node column in review**, and it is worth naming rather than
silently re-sorting: `hediet.vscode-drawio` was listed under Node REH on the first draft's
mistaken routing rule (§6.1). It is the sole occupant of the restored web/UI class among the
extensions surveyed — which is exactly why dropping that class made the table look tidier than
the world is.

Four findings inside that table:

- **`ms-azuretools.vscode-docker` 2.0.0 has no code.** No `main`, no `browser`, no `contributes` —
  just `extensionDependencies: ["ms-azuretools.vscode-containers"]`. The real extension is
  `ms-azuretools.vscode-containers` 2.4.5 (`main` only, `virtualWorkspaces: false`). Any ledger
  row for "Docker" that does not name the dependency is testing an empty package.
- **The five impossible ones are not on Open VSX at all** — the API returns
  `"error": "Extension not found: <id>"` for each. So even before licence, there is no install
  path except a side-loaded `.vsix`, and their licences forbid exactly that. "Could only be
  side-loaded" is legally moot for all five.
- **Two non-Microsoft extensions want proposed APIs they cannot get.** `GitHub.vscode-pull-request-github`
  declares 28 (including `chatSessionsProvider`, `contribShareMenu`); `openai.chatgpt` declares
  `chatSessionsProvider` and `languageModelProxy`. They will load in Code-OSS, but those code
  paths cannot activate. **Whether they degrade gracefully or throw is UNVERIFIED.** Note that
  this is the same class of problem as issue #804's Bug 1 (§6.4): an unhandled throw during
  extension-point processing does not fail one extension, it aborts the pass.
- **`anthropic.claude-code` and `openai.chatgpt` are proprietary but both publish to Open VSX
  themselves**, so neither is impossible — no product check, no Microsoft service dependency.
  Both are now platform-specific `.vsix` builds (`darwin-arm64`, etc.), which the manifest
  resolution has to handle. Plan §4 correctly says Chorus does not need them; §6.4 explains why
  one of them is nonetheless the most informative thing to test.

### 6.4 The prior art nobody should skip — and it is on the exact pairing §2.4 recommends

`CodinGame/monaco-vscode-api` issue **#804** (<https://github.com/CodinGame/monaco-vscode-api/issues/804>)
is a report from 2026-06-03 by a developer running:

> `@codingame/monaco-vscode-api` **33.0.9** · VS Code server pinned to commit
> **`987c9597516278c9fcf10d963a0592ce1384ab93`** · REH on `localhost:<port>` · **Electron 41,
> macOS (arm64), React 19 renderer**

That is Phase 1's proposed configuration, on Phase 1's platform, in Phase 1's host. It is the
single most valuable piece of evidence in this brief, and it produced **two defects**:

**Bug 1 — `ViewsRegistry.addViews` throws, and takes every extension's views with it. But it was
observed in a partial setup, and that changes what it proves for Chorus.** The reported mechanism
is that **the views-service-override** registers no default `workbench.view.explorer` container,
so `getDefaultViewContainer()` returns `undefined`, and any extension contributing a view into a
container that is not present in the build throws an **uncaught**
`TypeError: Cannot read properties of undefined (reading 'extensionId')`. Because it is uncaught,
it aborts the entire `contributes.views` pass — so **every** extension's sidebar views silently
fail to register, not just the offending one. The reporter's workaround is to register a default
Explorer view container before `initialize()`. Their fix PR
(<https://github.com/CodinGame/monaco-vscode-api/pull/805>) was **closed unmerged** — the
maintainer preferred a defensive null-check in `addViews` to registering a container
("probably a bit simpler and less hacky"), and whether either landed by 36.1.1 is **UNVERIFIED**
(§9 item A8).

> **Correction (Codex review, 2026-08-22) — Bug 1 is not proven against the configuration Chorus
> proposes.** The first draft presented it as a defect Phase 1 would meet. Read the reporter's
> own environment block: their service overrides were _"configuration, extensions, files, model,
> theme, view-common, **views**, storage, secret-storage, authentication, notifications, dialogs,
> chat, extension-gallery, remote-agent"_, and they were _"rendered via `renderXxxPart` into our
> own islands"_. That is `ViewsServiceOverride` plus hand-composed parts — **not**
> `WorkbenchServiceOverride`, and §4.4 already records that the two are **mutually exclusive**
> (issue #817). **Chorus plans to use the workbench override**, which is the one that brings the
> workbench's own parts with it.
>
> The failing expression is `viewContainersRegistry.get("workbench.view.explorer")` returning
> `undefined` because nothing registered an Explorer container. It is a reasonable inference —
> and it is only an inference, so **UNVERIFIED** until A8 — that a full `WorkbenchService`
> registers that container itself and the throw therefore never occurs. The maintainer's reply
> points the same way and is the calibration for the whole issue: _"Adding complex extensions in
> **partial VSCode setup** is always risky"_ — said in direct answer to Bug 1, naming the partial
> setup as the condition.
>
> **What this does not weaken is Bug 2.** The maintainer reproduced the webview stall on stock
> `code-server` and on VSCodium's own web host, neither of which is a partial monaco-vscode-api
> setup, and it was filed upstream where it remains open. The serverful webview defect is real
> and applies to Chorus; the views defect is a partial-setup observation that Chorus's own
> configuration may well not share. **Issue #804 itself was auto-closed as stale on 2026-07-20
> (`not_planned`)**, so it records the problem but not a resolution of it.

**Bug 2 — sustained bidirectional webview↔remote-extension messaging stalls after the first
round-trip.** A webview SPA loads, completes one capnp round-trip, and then goes silent forever.
Filed upstream as <https://github.com/microsoft/vscode/issues/319896>, which as of 2026-08-22 is
**still open**, labelled `info-needed`. The maintainer reproduced it on stock `code-server` and on
VSCodium's own web host, which is what puts it in VS Code rather than in the library.

Three things follow directly for Phase 1's proof set:

- **`anthropic.claude-code` was reported working** as a remote extension with a webview on this
  exact setup, "its editor webview renders and functions" — because it uses simple
  request/response. **`openai.chatgpt` was reported stalling**, because its UI is an SPA driving
  high-frequency bidirectional RPC. So "webviews work" and "webviews work" are two different
  claims, and only the second is at risk.
- **The webview-heavy representative must be chosen to test the risky case, not the safe one.**
  A proof that does one request/response round-trip proves nothing about Bug 2. Whatever plays
  that slot has to sustain bidirectional traffic.
- **But neither of those two extensions should be the _first_ executable proof, and the first
  draft's §6.6 made both of them exactly that.** Correction (Codex review, 2026-08-22). Reaching
  for `openai.chatgpt` and `anthropic.claude-code` to open the extension proofs puts four
  liabilities on the critical path at once: they are **proprietary**, so a failure cannot be
  reduced to a public repro and cannot be debugged by reading the source; they are
  **platform-specific `.vsix` builds** whose resolution is itself untested (§6.3); they declare
  **proposed APIs Code-OSS cannot grant** (§6.3), so a failure has at least three candidate
  causes before the architecture is even implicated; and they are **large SPAs**, which is the
  worst possible first thing to point at an unproven host. A failure there would tell Phase 1
  almost nothing, which is the opposite of what a first proof is for.

**What to use instead — controlled local fixtures first, then a real third-party extension.**

1. **Two Chorus-authored fixture extensions**, written for this purpose, installed from local
   `.vsix` and no gallery involved. One contributes a **view container and a view** — the direct,
   readable regression test for Bug 1, and unlike a third-party extension it can be reduced to
   the single contribution under test. One holds a **webview that sustains bidirectional
   messaging** — a counter that pings continuously and asserts monotonic delivery, which is Bug
   2 stripped of capnp, React, `<Suspense>` and 250 concurrent asset loads. Both are a few dozen
   lines, both are debuggable because Chorus wrote them, and a failure in either names its own
   cause. This is the same instinct as `apps/desktop/build/`'s ten existing probes: prove the
   mechanism with something you control before pointing it at something you do not.
2. **Then `dbaeumer.vscode-eslint` as the real third-party REH proof.** MIT, on Open VSX,
   `main`-only, no proposed APIs, no webview, and its success condition is an effect only the REH
   can produce — a diagnostic for a real file on that machine's disk. It is the load-bearing
   third-party proof precisely because nothing about it is exotic.
3. **`openai.chatgpt` and `anthropic.claude-code` move to the end**, as the known-failing /
   known-working pair. They are still worth running — the pair is the control structure §6.6
   describes — but as **corroboration on a host already shown to work**, not as the instrument
   that establishes it. Plan §4 already says Chorus does not need either extension as a product
   feature, which is another reason not to let either gate the phase.

**The maintainer's framing remains the calibration for the whole phase:** _"Adding complex
extensions in partial VSCode setup is always risky"_ — CGNonofr, 2026-06-04. That is the library
author saying extension compatibility is not a solved property of this architecture. Fixtures
first is that advice taken seriously rather than quoted. Phase 5's compatibility ledger is not
paperwork; it is the only way anyone will know.

### 6.5 The Microsoft-proprietary ones, and how C-046 bites here

`BOARD.md:1067` (C-046 · _Chorus is not a VS Code fork_) already settled the licensing research
and it does not need redoing. What it says that matters here is its own closing paragraph:

> **One fact deliberately left unverified:** whether a fork may use Microsoft's extension
> marketplace. … it is the fact that most changes the "extensions come free" argument.

**That fact is now settled, and it settles against.** Microsoft prohibits use of the Marketplace
by non-Microsoft products and prohibits redistributing `.vsix` files obtained from it — VSCodium
documents this and links Microsoft's own issue
(<https://github.com/VSCodium/vscodium/blob/master/docs/extensions.md>,
<https://github.com/microsoft/vscode/issues/31168>). So the gallery is **Open VSX**, plus
user-supplied local `.vsix`, and that is a permanent product property, not a first-cut
limitation.

How it bites, in **four** distinct ways that get conflated — and for the five impossible
extensions in §6.3, all four apply at once, which is why no single workaround helps:

1. **Registry absence.** All five return `"error": "Extension not found"` from the Open VSX API.
   There is no gallery install path. Their authors may publish there; nobody can do it for them.
2. **Licence — and it restricts _use_, not just distribution.** Read from each extension's own
   `Microsoft.VisualStudio.Services.Content.License` asset:
   - Remote-SSH / Dev Containers: _"You may use a copy of the software with each validly licensed
     copy of Microsoft Visual Studio Code. **You may not use the software if you do not have a
     license for Microsoft Visual Studio Code.**"_
   - GitHub Codespaces: _"You may install and use any number of copies of the extension **only
     with Visual Studio Code** to connect to the Codespaces service. You may not work around any
     technical limitations in the extension…"_
   - VS Code Speech: _"…**only with Microsoft Visual Studio, Visual Studio for Mac, Visual Studio,
     Azure DevOps, Team Foundation Server, and successor Microsoft products and services**…"_
   - Live Share: _"You may install and use any number of copies of the software **to use solely
     with Microsoft Visual Studio family of products**."_
   - And over all of them, the Marketplace Terms of Use: _"Marketplace Offerings are intended for
     use only with Visual Studio Products and Services and you may only install and use
     Marketplace Offerings with Visual Studio Products and Services."_

   Note the Codespaces clause forbids _working around technical limitations_ by name. That
   closes the door on (4) below as a legal matter, not merely a policy one.

3. **Runtime product check.** VSCodium's compatibility doc lists Live Share, Remote-Containers
   and Remote-SSH under "Incompatibility": _"Most Microsoft extensions are limited to run on only
   MS products **by their license and by running additional checks in their proprietary code**"_
   (<https://github.com/VSCodium/vscodium/blob/master/docs/extensions-compatibility.md>). And from
   the VS Code team directly, on running Remote-SSH under Code-OSS: _"Unfortunately this isn't
   really supported. **Since Remote-SSH depends on some non-oss components, you can only run it
   with official full builds of vscode.**"_ (<https://github.com/microsoft/vscode/issues/162874>).
4. **A structural blocker independent of licence: proposed APIs.** Code-OSS's `product.json`
   contains **no `extensionEnabledApiProposals` key at all**
   (<https://raw.githubusercontent.com/microsoft/vscode/main/product.json>). Remote-SSH declares
   `resolvers, tunnels, terminalDataWriteEvent, terminalRemoteResolver, contribViewsRemote,
telemetry, contribRemoteHelp`; Dev Containers and Codespaces declare `resolvers, tunnels, …`;
   VS Code Speech declares `speech`. **None of those is grantable without patching
   `product.json`** — which is what VSCodium's `extensionAllowedProposedApi` workaround is, and
   VSCodium is explicit that it often fails anyway: _"In some cases, the above change won't help
   because the extension is hard-coded to only work with the official Visual Studio Code
   product."_

**Chorus must not implement (3).** Plan §5 already says "never bypass licence/runtime checks",
and the reason to restate it is that the workaround is one line of JSON and will be tempting the
first time Remote-SSH refuses to load. An extension that checks for Microsoft VS Code and gets
lied to is a licence problem wearing an engineering disguise.

C-046 should be updated at Phase 8 to record that its one open fact is now closed, and closed the
unfavourable way.

### 6.6 The proof set this brief recommends, and why it differs from the plan's

Plan Phase 1 proof 7 proposes GitHub Theme, Prettier, ESLint and Draw.io/GitLens. That set
under-tests the architecture: three of the five land in the same host and one has no host at all.
A set that can actually falsify something, **in the order it should be run** — the ordering is
the correction, and it matters more than the membership:

| #   | Slot                                 | What plays it                                            | What only this one proves                                                                                                                                                                                                                                      |
| --- | ------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Declarative                          | `GitHub.github-vscode-theme`                             | Contribution processing and theming, with no host involved. The cheapest way to separate "workbench broken" from "extension host broken".                                                                                                                      |
| 2   | **Views registration**               | **Chorus fixture extension** (view container + one view) | The direct regression test for issue #804's Bug 1 — which, as §6.4 now records, is **not proven** against a full `WorkbenchService`. A fixture answers the question for Chorus's own configuration rather than inheriting someone else's partial-setup result. |
| 3   | **Webview, sustained bidirectional** | **Chorus fixture extension** (continuous ping/ack)       | Bug 2 stripped to its mechanism: sustained bidirectional webview↔remote-extension delivery, with no capnp, no SPA and no 250-asset load to confound it. The upstream defect is real and open, so this is expected to be the informative one.                   |
| 4   | Node REH, filesystem + process       | `dbaeumer.vscode-eslint`                                 | The **real third-party REH proof**: a `main`-only extension activating **in the REH** and producing a diagnostic for a file on that machine's disk. The single most load-bearing proof in Phase 1.                                                             |
| 5   | Node REH, language service           | `bradlc.vscode-tailwindcss` **or** `redhat.vscode-yaml`  | A second, independent Node extension — so a single success is not mistaken for a working host.                                                                                                                                                                 |
| 6   | **Web/UI host**                      | `hediet.vscode-drawio`                                   | **Restored by §6.1's correction.** The only surveyed extension declaring `ui` first, and so the only third-party exercise of the web worker host — the same host proof 8's trusted bridge extension runs in.                                                   |
| 7   | Webview, request/response            | `anthropic.claude-code`                                  | The known-_working_ third-party control (§6.4).                                                                                                                                                                                                                |
| 8   | Webview, sustained bidirectional     | `openai.chatgpt`                                         | The known-_failing_ third-party case (§6.4). Corroborates slot 3 on real code.                                                                                                                                                                                 |

**Three things about that ordering.**

**Fixtures before proprietary extensions (slots 2–3 before 7–8).** §6.4 gives the argument: a
first proof has to produce an interpretable failure, and a proprietary platform-specific SPA
declaring ungrantable proposed APIs produces the least interpretable failure available. Slots 7
and 8 stay in the set — they are the control pair, and dropping them would leave slot 3's fixture
result unanchored to anything real — but they run **last, on a host already shown to work**. If
slot 3's fixture stalls, slot 8 is not needed to conclude the architecture has the upstream
defect; if slot 3 passes and slot 8 still stalls, the difference is in the extension's own
traffic pattern, which is a far more useful thing to learn than "something broke".

**The control/known-failing structure is unchanged and is the part that matters most**, lifted
from how this repository already reasons about tests: `CLAUDE.md` on C-027 — _"Measure
`defaultPrevented` on the key instead, and carry a control proving the mechanism fires when it
should."_ Slots 7 and 8 are that control, and slot 3's fixture is the same control moved
somewhere Chorus can debug it.

**GitLens drops out of the critical path**, because it duplicates the Node-REH slot at much
higher complexity. **Draw.io does not drop out any more** — the first draft cut it on the
grounds that its shared `main`/`browser` bundle made the result ambiguous about which host ran
it, but §6.1's correction makes it the only web-host representative there is, and its declared
`ui` preference is what disambiguates the host. The ambiguity that remains is a different one and
is named in §6.2: whether that shared bundle can actually run under a web worker.

---

## 7. Cross-platform proof environment and the evidence required

### 7.1 What exists today

| Platform        | Chorus builds it?                                                   | CI runner                                                                 | A machine to drive it on?                                                                    |
| --------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| macOS arm64     | Yes — `electron-builder.yml:108-112`, `dmg`, `arch: [arm64]`        | `macos-latest` (`release.yml:92`)                                         | Yes, this one                                                                                |
| macOS x64       | **No**                                                              | —                                                                         | Unknown                                                                                      |
| Windows x64     | Yes — `electron-builder.yml:84-87`, `nsis`, `arch: [x64]`           | `windows-latest` (`release.yml:96`), plus a dedicated `windows-probe.yml` | **No.** `CLAUDE.md`: install/upgrade/uninstall "have never been tested; they need clean VMs" |
| Windows arm64   | No                                                                  | —                                                                         | No — and no REH exists either (F2)                                                           |
| Linux x64/arm64 | **No target at all** — `electron-builder.yml` has no `linux:` block | `ubuntu-latest` used only for the publish job (`release.yml:162`)         | No                                                                                           |

**So "passing on macOS alone does not pass this phase" (plan Phase 1) describes a phase that
cannot pass _today_**, because two of its three platforms have neither a build target nor a
machine. That is a scheduling fact worth surfacing now rather than at the gate.

**Correction (Codex review, 2026-08-22) — what follows from that, and what does not.** The first
draft put this alongside §9's open question 4 as though the plan and the finding were in
conflict and "one of those two statements has to give". Neither gives. **Linux x64 stays in the
Phase 1 architecture proof and is not deferred to Phase 7** (§9 item E4, settled). The absence
of a Linux machine is a **prerequisite to satisfy** — §9 item D2 — not an argument for narrowing
the gate. The absence of a Linux _build target_ is a different thing and does not block this
phase at all: Phase 1's proofs run against a dev build, and D2 as corrected provisions the machine
without touching `electron-builder.yml`. Deferring Linux would push the discovery of a Linux-specific
problem, and §7.3 already names two plausible ones, past the point where the architecture could
still be changed in response, which is what a kill gate is for. **Windows arm64 is the one row
that does leave the target** (E3), and it leaves on the plan's own pre-existing condition rather
than on a new judgement.

### 7.2 What counts as proof, per platform

The distinction that matters is **evidence produced by the thing under test**, not evidence that
the thing under test was probably fine.

| Claim                                      | Merely looks like it worked                                         | Actual proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The REH started                            | The spawn promise resolved; the process is in `ps`                  | The client completed a remote connection and the workbench listed the real contents of the project root — a directory listing that could only have come from that machine's filesystem                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| The right server is running                | The port answered, **or `/version` returned the manifest's commit** | The port was opened by a child **main spawned**, whose unpacked directory carries an extraction receipt naming the artifact and the sha256 main measured (§3.5 property 3). **Corrected in round 3: `/version` proves nothing here.** After the `product.json` patch that field holds whatever Chorus wrote, so a 1.126 server and a 1.121 server answer alike; the earlier claim that this "catches attaching to a stale server" was backwards, because the patch is exactly what makes a stale server look right                                                                                                                                                                                                                                                                                                                                                                                         |
| A Node extension activated                 | It appears in the installed list                                    | Its `activate()` ran **in the REH process** — proven by an effect only the REH can produce (ESLint reporting a diagnostic for a real file on disk), not by a UI badge                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Terminal works                             | An xterm rendered                                                   | A command ran and its output came back, and the process appears as a child of the **REH**, not of Electron                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Debug works                                | A breakpoint icon appeared                                          | Execution stopped, a variable's value was read, and stepping advanced the line                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Two projects coexist                       | Two surfaces are open                                               | **Two distinct roots** (§4.1a), both connected to the one shared REH, each listing its _own_ directory contents; focus and `⌘`-shortcuts route to the focused one; closing one leaves the other's editor state intact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| The two are isolated                       | Both opened without error                                           | An extension's **workspace** state written in project A is absent in project B, and each project's workspace storage is a distinct location under the Chorus `--server-data-dir`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| The overlay tracks the UI                  | The view is visible                                                 | After a window resize, a tab switch and a pane split, the view's bounds match the placeholder element's rectangle — the specific cost §4.1a accepted when it chose `WebContentsView`, so it is measured, not assumed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Each surface got **its own** descriptor    | Both workbenches connected                                          | A pull from view A returns A's project while B is open — the adversarial direction, since a lookup keyed on "most recently opened" passes the friendly one. And `window.chorus` is `undefined` in both workbench documents, which is what proves the shell's preload did not follow the view (§4.1b)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| A surface survives a reload                | It rendered once                                                    | After `location.reload()` in a mounted surface, `connection()` resolves again with the same descriptor and the same project. Without the pull path this hangs rather than throwing, which reads as a slow workbench rather than a broken one (§4.1b rule 3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| An inactive project keeps its terminals    | The tab is still in the rail                                        | A long-running command started in project A's workbench terminal is **still running, with its output intact and re-attachable**, after A's surface is unmounted **well inside** the server's reconnection grace window and then remounted — **plus** the negative control, that it is gone after the window elapses (§5.4 run 1, `--reconnection-grace-time 60`). **Round 4 corrects this row**: it previously asked for survival _past_ the grace period, which upstream shuts down by design, so the stated evidence could never be produced; the three-hour default makes the negative control unrunnable                                                                                                                                                                                                                                                                                               |
| Opening a project shortens another's grace | Both projects opened and A's terminal later died                    | **A second run at `--reconnection-grace-time 900`, with a no-B control (§5.4 run 2).** At one observation point, the control — A unmounted, no other connection made — is still **re-attachable**, while the case — identical but with B opened shortly after A unmounted — has **expired**. **Round 5 corrects this row into existence**: round 4 folded this assertion into the 60-second run, where `shortGraceTime = min(300 s, 60 s) = 60 s` makes B's arrival arithmetically incapable of moving anything, so the step would have passed while testing nothing. It needs a grace **above the 300 s clamp** — 360 s is the arithmetic floor, **900 s is the value used** — and it is only meaningful if B connects within `graceTime − 300 s` of A's unmount. What this row proves is the **connection** window; the terminal cascade is a separate, still **UNVERIFIED** step read from the same run |
| Nothing leaked                             | The app quit                                                        | After quit, no process holds the Chorus `--server-data-dir`, on that OS, checked by the OS's own tool                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### 7.3 Per-platform evidence to capture

- **macOS arm64 (available).** All ten Phase 1 proofs, driven by hand with the user present for
  the review gate. Every measurement in §8 taken here first, since it is the only machine where
  a before/after is possible against the existing app.
- **Windows x64 (needs a VM).** The full ten, plus specifically: process cleanup after quit
  (where `reap.ts` does nothing), the extensions directory lock, and path handling for a project
  root with a drive letter and backslashes. `docs/windows-test-brief.md` is the existing model
  for how this gets written down.
- **Linux x64 (needs a machine — and, per D2 as corrected, _not_ a packaging target).** The full
  ten, driven from a dev build; the `linux:` electron-builder target is Phase 7's. Plus: whether the REH's
  bundled `node` runs against the distro's glibc, and whether Electron's sandbox needs
  `--no-sandbox` or a `chrome-sandbox` SUID bit — a well-known Linux packaging problem this
  repository has never met.
- **Not proof anywhere:** a green CI job. CI verifies "at `bundle` scope only" by design
  (`CLAUDE.md`), and every interesting Phase 1 claim is outside that scope.

---

## 8. Resource ceiling and kill-gate thresholds

### 8.1 The calibration point this repository already owns

From `docs/plans/the-editor-you-already-know-2026-08-20/plan.md:217-221` and
`STATUS.md:18-36`:

| Measurement                         | Value                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer main chunk, with Monaco    | **6,639,312 B** (85 chunks)                                                                                                                             |
| Renderer main chunk, Monaco stubbed | **1,767,433 B** (3 chunks)                                                                                                                              |
| **Monaco's cost**                   | **4.87 MB**, plus a **598,422 B** worker and **82** lazy grammar chunks                                                                                 |
| First paint penalty                 | paired median **−8 ms**, individual differences **−572 to +460 ms** — "no penalty measured" is explicitly _not_ "penalty proven under 100 ms"           |
| Panel-open-to-content               | Monaco **270.2 ms** vs FileDiff **137.5 ms**, paired median **+155.8 ms**, all ten pairs in the same direction                                          |
| Pre-registered decision rule        | **< 100 ms** keep static; **≥ 100 ms** reconsider. 155.8 ms was **above the line** and the capability was kept anyway, as an explicit product judgement |

And the current shipped size, from release `v0.20.0`. **These are compressed installer
artifacts, and the column heading says so because the first draft's R3 quietly treated them as
installed sizes:**

| Artifact                              | Compressed size               | Installed size              |
| ------------------------------------- | ----------------------------- | --------------------------- |
| `Chorus-0.20.0-arm64.dmg`             | **133,841,041 B** (~133.8 MB) | **UNMEASURED** — see §9 A10 |
| `Chorus-0.20.0-windows-x64-setup.exe` | **113,347,959 B** (~113.3 MB) | **UNMEASURED**              |

A DMG is a compressed disk image and an NSIS `.exe` is a compressed installer; the `.app` bundle
and the installed program directory they expand to are both larger, by a ratio nothing here has
measured. Any ceiling that talks about installed size has to be set against an installed baseline,
and Chorus does not have one yet.

> **Correction (Codex review round 2, 2026-08-22) — and it removes a false urgency the last round
> introduced.** The revised draft's A10 said the baseline "must happen **before** any workbench
> build, or the 'before' figure is gone". **That is not true.** The baseline is the installed size
> of a **published release**, and `v0.20.0`'s DMG is on the release page with a recorded checksum;
> it can be installed and measured at any point in the future and will produce the same number.
> Nothing about building a workbench destroys it. What _would_ destroy it is measuring an
> installed build whose identity nobody wrote down — so the requirement is not haste, it is
> **recording the identity alongside the number**: the version, the architecture, the DMG's
> sha256, and whether the measured `.app` came from that DMG or from a local `pnpm app:install`.
> Those two are not interchangeable and a figure that does not say which is not a baseline.
>
> The consequence for R3 is larger and is in §8.3: with the urgency gone and Phase 1 bundling
> nothing, **R3 is not a Phase 1 gate at all.**

**Why this calibration is the right one.** The Monaco decision is the precedent for how this
repository prices a large dependency: measure it against a stub from the same tree, pre-register
the threshold _before_ measuring, and record the number even when the decision goes against it.
The thresholds below are written in that form — numeric, and set before anything is run, so the
result cannot be rationalised afterwards.

### 8.2 What is being added, in numbers that are already known

**The npm side, measured.** `demo/package.json` at tag `v36.1.1` is the library's own full-workbench
example and depends on **180 `@codingame/*` packages**. Summing `dist.unpackedSize` from the
registry for all 180 at version 36.1.1 — no tarball fetched, only metadata:

| Category                                                                                               | Packages |                     Unpacked |      Files |
| ------------------------------------------------------------------------------------------------------ | -------: | ---------------------------: | ---------: |
| `*-default-extension` (built-in extensions shipped as npm)                                             |       82 | **174,212,974 B** (166.1 MB) |        936 |
| Core / other (`monaco-vscode-api` alone is 34.4 MB; `standalone-typescript-language-features` 12.4 MB) |        9 |   **52,584,373 B** (50.1 MB) |      5,986 |
| `*-service-override` (largest: `treesitter` 21.9 MB, `chat` 6.8 MB)                                    |       75 |   **49,579,258 B** (47.3 MB) |      3,554 |
| `*-language-pack-*`                                                                                    |       14 |   **23,475,705 B** (22.4 MB) |      1,358 |
| **Total**                                                                                              |  **180** | **299,852,310 B (286.0 MB)** | **11,834** |

**A realistic Chorus set is much smaller than that, and the reason matters.** Three of the four
categories are largely droppable in this topology:

- **The 82 `default-extension` packages (166 MB) exist for _serverless_ operation.** Chorus has a
  REH, and the REH ships the built-ins. Shipping both would be two copies of the Git extension.
  **This is the strongest single argument for the REH beyond Node extensions**, and it should be
  verified in Phase 1 rather than assumed — §9 item B5.
- **The 14 language packs (22.4 MB) go** — Chorus is English-only (`i18n/en.json`).
- **`chat-service-override` (6.8 MB) goes** — plan §4 already says to disable Code-OSS chat
  entrypoints so there is one agent product, not two competing sidebars.
- **`treesitter-service-override` (21.9 MB) is a decision**, not a default. It is nearly half the
  service-override total on its own.

Costed as tiers, so the decision is visible rather than implied:

| Tier  | Contents                                                                 | Packages |     Unpacked |  Files |
| ----- | ------------------------------------------------------------------------ | -------: | -----------: | -----: |
| A     | core + `editor-api` + `extension-api`                                    |        3 |     33.3 MiB |  5,206 |
| **B** | A + ~49 workbench service overrides (no treesitter / chat / ai / speech) |       52 | **46.1 MiB** |  6,971 |
| **C** | B + 2 themes + 14 language-basics extensions                             |       68 | **48.5 MiB** |  7,135 |
| D     | C + `typescript-language-features`                                       |       69 |     83.3 MiB |  7,273 |
| F     | everything the demo installs                                             |      184 |    287.1 MiB | 11,903 |

**Tier C — around 48.5 MiB — is the realistic full-workbench answer** for an app shaped like
Chorus. Dropping `treesitter-service-override` alone saves 20.9 MiB; the jump from C to D is
`typescript-language-features` at ~34.8 MiB, which the REH should be supplying instead.

| Item                                             | Known figure                                                                                                                                                                                                                                                  | Confidence                                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full demo dependency set, npm unpacked           | **299,852,310 B**, 11,834 files, 180 packages                                                                                                                                                                                                                 | Measured (registry `dist`)                                                                                                                          |
| `@codingame/monaco-vscode-api` alone             | **34,397,421 B**, 5,143 files                                                                                                                                                                                                                                 | Measured                                                                                                                                            |
| A plausible Chorus subset (tier C), npm unpacked | **~48.5 MiB**, 68 packages, 7,135 files                                                                                                                                                                                                                       | Measured per package; the _membership_ of the tier is a judgement — **UNVERIFIED** until the override list is written                               |
| **Built renderer chunk for the frame**           | **UNKNOWN**                                                                                                                                                                                                                                                   | The number that actually matters, and npm unpacked size is a poor predictor of it. Needs B3.                                                        |
| One VSCodium REH tarball, compressed             | **~76–83 MB** per platform                                                                                                                                                                                                                                    | Measured (release API `size`)                                                                                                                       |
| One VSCodium REH, **unpacked**                   | **UNKNOWN** — requires unpacking (§9 item A3)                                                                                                                                                                                                                 | **UNVERIFIED**                                                                                                                                      |
| Extra OS processes per open project              | ≥ 2 (the REH server, its Node extension host), plus one per terminal/debug session                                                                                                                                                                            | Structural, **UNVERIFIED** in count                                                                                                                 |
| Extra renderer processes                         | **1 per workbench surface.** No longer conditional: §4.1a selects `WebContentsView`, which is a separate top-level `WebContents`. Every surface shares the **one** `chorus-workbench` partition — the process count comes from the view, not from the session | Structural. The **count** is confirmed by R11's process inventory rather than assumed, since that is where a surface that never exits would show up |

**Note the shape of the distribution problem — and note that the comparison below is
deliberately loose about units.** Monaco's whole accepted cost in this repository was **4.87 MB**
_on the built main chunk_; one REH tarball is ~76–83 MB _compressed on disk_. Those are not the
same kind of number and the "fifteen times" is an order-of-magnitude gesture, not a measurement.
What is solid is the direction: if Chorus ships all three platforms' servers in one installer it
is a ~230 MB addition; if it ships per-platform it roughly doubles each installer; if it
downloads at runtime, plan §7's "Never download an unpinned executable on first launch" is still
satisfied by a manifest-pinned download, but first-run becomes a 76 MB fetch before the first
project opens. **All three options are larger than the largest cost this repository has ever
knowingly accepted.**

**And that choice is now deliberately deferred, which is a decision rather than an omission**
(§9 item E2, settled). **Phase 1 uses an approved cache download** — the artifact named in the
manifest, checksum-verified, unpacked under `userData`, fetched once with authorisation (§9 A1).
Nothing is bundled into any installer during Phase 1, and no packaging change is made. The
bundle-versus-runtime-download question belongs to **packaging**, where it can be answered
against a measured installed baseline (R3, now §8.5) and a real per-platform artifact set,
rather than against the estimates in this section. Answering it now would mean choosing an
installer shape before knowing whether the architecture works at all — which is the ordering
error the kill gate exists to prevent.

**One honest caveat on all of the above.** npm unpacked size is not bundle size — these packages
ship both ESM and typings, and a real build tree-shakes and minifies. The Monaco precedent is the
warning in the other direction too: `monaco-editor`'s npm footprint bore no simple relation to
the 4.87 MB it actually cost the main chunk. **Only B3's paired build measures the number that
matters.** Everything in this subsection is a floor and an upper bound, not a prediction.

### 8.3 Proposed kill-gate thresholds — pre-registered

Measured on macOS arm64, against `main` at `c2847c4` as the baseline, one project open unless
stated. Each is a **fail**, not a warning: the plan's kill gate says stop and return to
architecture selection.

| #      | Metric                                                                                     | Threshold                                                                                                 | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1     | **Renderer bundle, outer Chorus shell**                                                    | Must not grow by more than **0.5 MB**                                                                     | The shell must not import a single `@codingame/*` module (plan §2.4). 0.5 MB is a leak detector, not a budget — anything above it means the frame boundary is not real.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| R2     | **Workbench frame bundle**                                                                 | ≤ **40 MB** built                                                                                         | Above that, the frame is heavier than every current installer's renderer and the download/parse cost stops being arguable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ~~R3~~ | **Installed app size**                                                                     | **Moved out of this gate — see §8.5**                                                                     | **Removed from Phase 1 (Codex review round 2).** Phase 1 bundles nothing (E2), so there is no installed candidate whose size could be compared: the REH is fetched into `userData` at runtime and no packaging change is made. A "≤ 3× the installed baseline" rule with no candidate on either side of the ratio is not a threshold, it is a sentence. It belongs to packaging and is restated in §8.5 against plan Phase 7, where a bundled artifact first exists. _(Round one had already corrected this row's **units** — it compared a compressed DMG against an installed tree — and left it in the gate. That fix stands; the row still does not belong here.)_                                                                                                                                                                                                                                                                                                                                                      |
| R4     | **Cold start to Chorus shell interactive, no project open**                                | Must not regress by more than **250 ms**                                                                  | The shell must not pay for the workbench when no project is open. 250 ms is ~1.6× the 155.8 ms this repository already judged significant.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| R5     | **Project open → workbench interactive (file tree populated, editor accepts a keystroke)** | ≤ **4,000 ms** warm, ≤ **8,000 ms** cold                                                                  | Includes REH connection. Beyond 4 s a project switch is not a switch, it is a wait, and the plan's product shape assumes switching.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| R6     | **Resident memory, one project open, idle 60 s** (`M1`)                                    | ≤ **1,200 MB** total across all Chorus processes                                                          | Measured as a sum, because the REH's memory is Chorus's memory from the user's point of view. `M1` is also one of R7's three terms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| R7     | **Marginal cost of the second project** — measure `M0`, `M1`, `M2`, all idle 60 s          | **`M2 − M1` < `M1 − M0`**                                                                                 | **Corrected (Codex review round 2): the ceiling did not test the claim it was written for.** The row read "≤ 2,000 MB total, i.e. the second project must cost less than the first" — but a total says nothing about a marginal cost. Two projects at 1,900 MB pass that ceiling whether the split is 1,000 + 900 or 200 + 1,700, and the second of those is the failure the row was meant to catch, passing. **Three measurements, one inequality:** `M0` = app running, workbench build, **no project open**; `M1` = one project; `M2` = **two projects on two distinct roots** (§4.1a — same-root surfaces share watchers and language servers and would flatter the result). If `M2 − M1` is not strictly less than `M1 − M0`, the second workbench costs at least what the first did, four panes is four times one, and plan §2.4's shape is wrong. R6's absolute ceiling still applies to `M1` — the two rules answer different questions and neither replaces the other.                                             |
| R8     | **Idle CPU, two projects open, no typing, 60 s**                                           | ≤ **3%** mean across all processes                                                                        | File watchers over two repositories are the risk. Sustained idle CPU is what makes a laptop fan the product's most memorable feature.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ~~R9~~ | **Process count, two projects open**                                                       | **Not a gate — recorded, see below**                                                                      | **Corrected (Codex review round 2): it cannot be both.** The row said "a number to _observe_ more than to enforce" while sitting in a table whose preamble says "each is a **fail**, not a warning". A threshold nobody intends to enforce is worse than none, because it will either be quietly ignored at the gate or trip the gate on a helper process that means nothing. **Observation is chosen**, and the reason is that process count is a proxy: the failure it stands in for — per-project isolation spawning a whole extension host per surface — is caught by **R7** directly and in the units that matter. See the paragraph below for what is recorded instead.                                                                                                                                                                                                                                                                                                                                               |
| R10    | **Orphans after quit**                                                                     | **0**, on every platform tested                                                                           | Not a performance number. One leaked REH holding a project root is a correctness failure, and §5.4 says Windows has no mechanism for it today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R11    | **Whole-app resident memory after 10× open/close of a second project, at rest**            | Must return to within **15%** of `M1`, **and** the process inventory must return to its one-project shape | **Redefined (Codex review round 2).** It read "renderer heap" and named "§4.4 hazard 2, cross-realm retention" — a hazard §4.4 has since withdrawn, and an instrument §4.1a has since made blind. Under `WebContentsView` each workbench is its **own process**, so a heap sampled in any one renderer cannot see the others, and the most likely real leak — a destroyed view whose process never exits, or a forked extension host the REH never reaps — leaves the sampled heap flat while the machine loses a gigabyte. **Measure resident memory summed across every Chorus process** (shell, each workbench `WebContents`, the REH and its forked extension hosts), and assert the process **inventory** returns too: after the tenth close there is one workbench `WebContents` and one extension-host fork, not eleven. A workbench that cannot be closed without leaking is not a project _tab_, it is a project _session_, and plan §3's "switch projects while agents or terminals continue" assumes the former. |
| R12    | **Closing project A leaves project B fully functional**                                    | Pass/fail, not a number                                                                                   | §4.4 hazard 1, **as corrected**. The `[data-vscode]` teardown reaches a sibling only under parent-DOM integration, which Chorus now prohibits — so this is **no longer a failure this brief expects**. Kept because it is binary and nearly free, and because it covers the residual shared-global risk the prohibition does not rule out. Run twice: §2.5 steps 1 and 3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**What replaces R9, since it is no longer a threshold.** Phase 1 records a **process inventory**
rather than a count: for each process, its role, its parent, and its resident memory, at `M0`,
`M1` and `M2`. The expected shape at `M2` is one Electron main, one shell renderer, two workbench
`WebContents`, one REH, two forked extension hosts, plus Electron's own GPU and utility processes
and whatever Chorus's agents are already running. **A row that is not on that list is the
finding** — that is what the count was reaching for, and an inventory says which process is
unexpected where a number only says there is one. It gates nothing; it is read alongside R7, which
does.

**How to measure, so the numbers mean something.** Paired A/B from one tree, the B build with the
workbench entry aliased to a stub — the same method that produced the 4.87 MB figure and the same
method that caught a 32 ms outlier as a harness defect rather than a result
(`the-editor-you-already-know-2026-08-20/plan.md:261-272`). Ten paired runs, report the paired
median and the spread, and say when the spread is too wide to support the claim. A difference of
medians is the wrong test and this repository has already made that mistake once, on purpose,
and recorded it.

### 8.4 The threshold that is not numeric

Plan §2.4's fallback list is ordered, and the first fallback — "one active workbench frame with
project switching and no simultaneous project splits" — is triggered by **R7, R11 or R12**, not by
a subjective judgement. Writing it down now means the fallback is a measurement outcome rather
than an argument at the gate.

**And of the three, R12 is the one to run first** — it is binary and cheap, and running the
expensive memory measurements before the cheap pass/fail one would be the wrong order. §2.5
step 1 is exactly that: a serverless two-surface probe on `36.1.1` before any REH exists.

**Note what changed in the reason, because it changes what a pass means.** The first draft ran
R12 first because §4.4 named a mechanism by which it _should_ fail; as corrected, that mechanism
applies only to a mode Chorus prohibits, so R12 is now expected to **pass**. A cheap test you
expect to pass is worth strictly less as a gate than one you expect to fail, and the honest
consequence is that **R12 passing at §2.5 step 1 is weak evidence, not the coexistence proof**.
The proof is step 3 — the same two measurements on the matched pair with a live REH, where the
untested surface is per-surface WebSocket and resource loading rather than DOM teardown.

**And R7 has moved into that list on its new definition.** As a total it could be satisfied by a
second project that cost nearly everything, which is why §8.4's fallback trigger was weaker than
it read. As `M2 − M1 < M1 − M0` it fails exactly when the second workbench is not cheaper than the
first, which is the condition plan §2.4's four panes rest on.

### 8.5 What moves to packaging — the thresholds Phase 1 cannot set

**R3 · Installed app size.** ≤ **3×** the installed baseline, both measured the same way on the
same machine: `du -sk` of the installed `.app` at the recorded baseline release versus `du -sk` of
the installed `.app` with the workbench and whatever REH arrangement packaging chooses. Windows is
measured against its installed program directory, never against the `.exe`.

**Why it cannot be a Phase 1 gate.** Phase 1 bundles nothing — E2 settles that the REH is fetched
into `userData` on demand and that no packaging change is made — so there is no installed
candidate containing a bundled REH for the ratio's numerator. Measuring the Phase 1 build's
installed size would measure a build that is not the proposal. **The ratio is pre-registered here,
now, and evaluated at plan Phase 7**, which is also where the bundle-versus-download decision it
depends on gets taken. Pre-registering it early and evaluating it late is the point: it is a
number set before anyone has an interest in the answer.

**What Phase 1 owes it:** the baseline, recorded with the identity of the build it came from
(§9 A10). Nothing else.

---

## 9. The authorisation list

**Nothing below has been done.** Each line is one thing a human can approve or refuse
individually. Grouped by kind, because the risk of each kind is different.

### A · Downloads (network fetch of an artifact to disk)

| #   | Action                                                                                                                             | Bytes        | Why it cannot be answered otherwise                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Download **`vscodium-reh-darwin-arm64-1.121.03429.tar.gz`**                                                                        | 76,210,372 B | The Phase 1 server, at the matched release of §2.4 — the artifact name and size are the release API's, read 2026-08-22, and its `.sha256` and `.sha1` siblings exist at that tag. **Round 3 replaces the `<pinned>` placeholder this row carried**: an approval item whose subject is a blank is not a thing anyone can approve, and E1 had already settled which release it is.                                                                                                                                                                                                                                                      |
| A2  | Download its `.sha256` sibling and verify                                                                                          | 111 B        | Proves A1 is what VSCodium published — and it is the **only** thing tying the bytes to the release whose `upstream/stable.json` gave the manifest its upstream commit, because the artifact itself never names one (§3.5 property 3).                                                                                                                                                                                                                                                                                                                                                                                                 |
| A3  | Unpack A1 and inventory it: unpacked size, the `node` binary's version, the built-in extension list, every `LICENSE`/`NOTICE` file | —            | Answers the §3.2 licence-inventory gap and the §8.2 unpacked-size unknown. Both are currently UNVERIFIED.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| A4  | Read the unpacked `product.json`, and confirm **no field anywhere in it names an upstream VS Code tag or commit**                  | —            | §2.3 and §3.5 property 3 predict this from the build sources — the REH build writes only `{ commit, date, version }`, with `commit` a sha1 of VSCodium's version string and `version` the VSCodium release. Reading the shipped file is what turns that from a source-derived inference into an observation, and it is the premise the extraction receipt exists for. Also shows the marketplace endpoints as shipped.                                                                                                                                                                                                                |
| A5  | Run the unpacked server's `--help`                                                                                                 | —            | The flags are confirmed present in **upstream** `1.128.1` source (§5.3); this confirms VSCodium's build did not remove or rename any of them, and is the cheapest possible first execution. **This is a process launch as well as a download.**                                                                                                                                                                                                                                                                                                                                                                                       |
| A6  | Deliberately connect a **mismatched** client and confirm the refusal actually fires                                                | —            | The error text is now known from source (§1.4). What is **not** known is whether monaco-vscode-api threads `productConfiguration.commit` into the handshake's `msg2.commit` at all — if it does not, the check is permanently disarmed (§1.5a) and no correct pairing is ever being verified. **This is a negative test and it is the most important single probe in the list.**                                                                                                                                                                                                                                                      |
| A7  | ~~Price the "build our own REH" branch~~                                                                                           | —            | **Already answered from source in §3.4** — command, toolchain, native-module policy, ~17 min CI per platform. No clone needed. Listed struck through so it is not re-approved by habit.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| A8  | Inspect `@codingame/monaco-vscode-views-service-override@36.1.1` (or 33.x) for a default-view-container guard                      | ~small       | Answers whether issue #804's Bug 1 is still live (§6.4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A9  | Download the Windows x64 and Linux x64 REH tarballs                                                                                | ~160 MB      | Needed before anything cross-platform. Defer until macOS passes. **E4 makes the Linux one gating rather than optional.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A10 | `du -sk` the **installed** `/Applications/Chorus.app`, and record the build's identity beside the number                           | 0 B          | No download and no launch — a read of sizes already on disk. It establishes the baseline for **R3, which is now a packaging threshold (§8.5), not a Phase 1 gate** — so this is **not urgent**, and the round-one claim that the figure is "gone" after a workbench build is withdrawn: `v0.20.0`'s DMG is published with a checksum and can be reinstalled and measured whenever. What it does require is the **identity** — version, architecture, the DMG sha256, and whether the measured `.app` came from that DMG or from a local `pnpm app:install`, which are not the same artifact. A number without that is not a baseline. |

### B · Installs and builds

| #   | Action                                                                                                                                                                                | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | `pnpm add` the `@codingame/*` client packages into `apps/desktop`                                                                                                                     | The library's own full-workbench set is **180 packages, 286 MB, 11,834 files**; a trimmed Chorus set is still tens of MB (§8.2). Changes `pnpm-lock.yaml`. **This is the first hard-to-reverse step and should be a separate approval from everything above it.**                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| B2  | Build the workbench entry twice — once in the existing renderer config, once in its own — to determine whether the `monaco-editor` alias can be scoped without breaking `MonacoDiff`  | The §4.3 alias trap. A build, and the answer decides a file layout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| B3  | Build and measure R1/R2 (paired, with a stub)                                                                                                                                         | The §8.3 bundle thresholds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| B4  | Iterate on the CSP until extension webviews load, recording each directive added and why — and determine whether Code-OSS webviews are `<iframe>` or Electron `<webview>`             | §5.2. This is the highest-risk item on the list, because the tempting shortcut (`script-src 'unsafe-inline' 'unsafe-eval'` on the whole session) is a real regression to the shell.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| B5  | Boot the workbench with **no** `*-default-extension` npm packages and confirm the REH supplies the built-ins (Git, language basics, the JS debugger)                                  | §8.2. Worth ~166 MB of `node_modules` and, more importantly, decides whether Chorus ships one copy of the built-ins or two.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| B6  | **Implement the §4.1a surface as an Electron `WebContentsView` on a dedicated `chorus-workbench` session partition**                                                                  | §4.1a, **no longer a comparison**: surface (A) is withdrawn as unbuildable — `frame-ancestors 'self'` contradicts a separate origin, and a child frame cannot receive IPC without `nodeIntegrationInSubFrames`, which loads every preload into every iframe including extension webviews. What remains is implementation and its accepted cost: bounds-driven layout under plan §2.4's four panes.                                                                                                                                                                                                                                                                                                   |
| B7  | **Install CSP, both permission handlers, `will-navigate`, `setWindowOpenHandler` and `will-attach-webview` on the workbench session and view, and assert it is not `defaultSession`** | §4.1a, §5.2. A new partition inherits **none** of `security.ts`; the shell's controls are bound to `session.defaultSession` (`index.ts:102`) and to a `BrowserWindow`. Skipping this is not a relaxation, it is an absence — the "dead control rather than an error" failure `security.ts:67-84` already records. Separated from B4 because B4 is iterative discovery and this is a fixed checklist that must be true before the first load.                                                                                                                                                                                                                                                         |
| B8  | **Add `apps/desktop/src/preload/workbench.ts` and its build entry, and prove the shell's preload is still emitted at `out/preload/index.js`**                                         | §4.1b. The same class of item as B7 and for the same reason: the view's preload is chosen in the same `webPreferences` object as its session, and the default — inheriting the shell's, which exposes the whole `ChorusApi` — is the worst outcome in this brief. The second half is not busywork: declaring `preload.build.rollupOptions.input` **replaces** electron-vite's default entry, so the existing preload has to be named explicitly or `index.ts:63` loads a file that is no longer built. Covers the delivery rules too — push after load, buffer in preload, pull on reload, resolve from `event.sender` — because a buffer that is never exercised looks identical to one that works. |

### C · Runs, probes and app launches

| #   | Action                                                                                                                                                                                                       | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Spawn the REH from a standalone Node probe (no Electron) and connect nothing                                                                                                                                 | Proves the binary runs on this machine and prints a port, in isolation. `apps/desktop/build/` already holds ten probes of this shape (`pty-smoke.cjs`, `terminal-ipc-probe.mjs`, …) — same pattern.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| C2  | Launch Chorus (`pnpm dev`) with the workbench frame                                                                                                                                                          | Every Phase 1 proof from 4 onward.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| C3a | **Install the two Chorus fixture extensions** (views, sustained webview) from local `.vsix`                                                                                                                  | §6.6 slots 2–3. No network and no third-party code — Chorus wrote both. Separated from C3b so the interpretable proofs are not gated on approving third-party execution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| C3b | Install §6.6's third-party slots (ESLint, Tailwind/YAML, Draw.io, then the Claude/ChatGPT control pair) from Open VSX                                                                                        | Proof 7, as revised. Network, and **it executes third-party code with the user's privileges** — this is the item on the list with the largest blast radius outside Chorus itself. Runs after C3a.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| C4  | Run a debug session and a terminal inside the workbench                                                                                                                                                      | Proofs 6. Executes arbitrary processes by design.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| C5  | Measure R4–R9 with the app running                                                                                                                                                                           | §8.3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| C6  | Kill the REH and the app in various orders and check for orphans (R10)                                                                                                                                       | §5.4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| C7  | **Mount two workbench surfaces on TWO DISTINCT ROOTS at once, close one, confirm the other still works (R12); then cycle open/close ten times and measure whole-app memory and the process inventory (R11)** | §4.4, §4.1a. Still the one claim the library does not itself demonstrate. **Two distinct roots is the correction**: the revised draft's prototype had one hard-coded root, and two surfaces on one root prove the wrong thing — they share watchers, language servers and workspace storage, so the second looks nearly free for a reason that vanishes when the roots differ. **Run twice, per §2.5**: serverless on `36.1.1` first (cheap, binary, fails fast, and tests containment only — there is no REH, so nothing about isolation), then on the matched pair with the shared live REH, where the second run also produces `M0`/`M1`/`M2` for R7 and the workspace-storage isolation assertion in §7.2. **Round 3 adds three assertions to the second run**, all of them cheap once two surfaces are up: a pull from view A returns A's descriptor while B is open; a reloaded surface reconnects; and a command left running in A's terminal survives A's surface being unmounted and remounted. **Round 4 corrects the third and adds a fourth.** The third asked for survival _past_ the reconnection grace period, which upstream shuts down by design — it must be survival **inside** the window, with a negative control past it, run under `--reconnection-grace-time 60` because the three-hour default makes the control unrunnable. The fourth: with A disconnected, **opening B shortens A's remaining window** — the server shortens the grace of its disconnected connections when a new one arrives, **once** rather than on each subsequent connection — so measure what B's arrival costs A. That one is a direct consequence of sharing one REH and has no analogue in a server-per-project topology (§5.4). **Round 5 splits the fourth out of the third's run, because at 60 seconds it could not have measured anything.** `shortGraceTime` is `min(300 s, graceTime)`, so at `--reconnection-grace-time 60` it equals `graceTime` and B's arrival cannot move A's deadline — the assertion would have gone green against a server whose behaviour it never exercised. So C7's second run is now **two runs**: retention and expiry at `60`, and shortening at **`--reconnection-grace-time 900`** — above the 300 s clamp, of which 360 s is only the arithmetic minimum — carrying a **no-B control** and a **B-connect case** compared at one observation point, the control still attachable while the case has expired, with **no other connection made during either observation**. Round 5 also separates the layers: the shortening loop walks management and extension-host **connections** and never touches a `PersistentTerminalProcess`, so whether it reaches A's terminals is a **cascade** question — still **UNVERIFIED** — that the terminal assertion in the B case is what answers |
| C8  | `pnpm check`                                                                                                                                                                                                 | Not needed until code exists; listed so it is not assumed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### D · Machines and environments that do not exist yet

| #   | Action                                                                                            | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Provision a Windows x64 VM                                                                        | §7.1 — there is no Windows machine and `CLAUDE.md` says the installer has never been tested on one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D2  | **Provision a Linux x64 machine or VM able to run `pnpm dev` and drive the workbench**            | **Corrected (Codex review round 2): this is provisioning, not packaging.** The revised draft paired the machine with "add a `linux:` target to `electron-builder.yml`" — a packaging change, in a phase that explicitly makes none (E2), to satisfy a gate that measures a dev build. E4 requires Linux **evidence**, and evidence needs a machine, a toolchain and the two things §7.3 names as the plausible Linux failures — glibc against the REH's bundled `node`, and `chrome-sandbox`/SUID. **None of those needs an installer.** The `linux:` electron-builder target is plan Phase 7 work and is recorded there. |
| D3  | Decide whether macOS x64 is in scope                                                              | The REH exists; Chorus does not build it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D4  | Decide Windows arm64: drop it, or acquire an ARM Windows machine to test x64 emulation of the REH | **F2.** The artifact does not exist. This is a product decision, not a task.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### E · Decisions — settled in Codex review, 2026-08-22 (E0–E4 round one, E5–E6 round two)

**These were written as open questions in the first draft. They are not open; they are settled,
and recording them as questions invited them to be re-litigated at the gate.** Each is written
below as the decision it is, with the reasoning that settles it and the one thing that would
reopen it.

**E0 · Microsoft's prebuilt REH remains forbidden. Settled.** §3.1a establishes that it exists at
the exact pinned commit for every platform including `win32-arm64`, needs no patch and no
toolchain, and would dissolve F1 and F2 outright. It is refused anyway, on the licence in §3.1 —
both the "may not … combine it with any of your applications for others to use" clause, which
forbids bundling, and the "may not use the software if you do not have a license for Microsoft
Visual Studio Code" clause, which makes a runtime download doubtful too. **The refusal is not
conditional on VSCodium being convenient**, so a VSCodium artifact being missing is not an
argument for reopening it — which is precisely the pressure §0 predicts will arrive with the
first Windows-on-ARM request. Reopened only by a licence change or by counsel, never by
inconvenience.

**E1 · The pin is settled by the execution order, not by a choice.** §2.5: `36.1.1` for the
serverless containment probe, matched `33.0.9` + VSCodium `1.121.03429` for the REH proof, and
the coexistence measurements repeated on the matched pair before the phase can pass. The
either/or the first draft posed had no correct answer because the two steps have different
dependencies.

**E2 · Phase 1 may use an approved cache download; bundle-versus-runtime-download is deferred to
packaging. Settled.** Phase 1 fetches the manifest-named artifact once, verifies its checksum and
unpacks it under `userData` (§9 A1–A3). It bundles nothing and changes no packaging. Whether the
shipped product bundles per-platform servers or downloads one on first project open is a
**packaging** decision, to be taken against a measured installed baseline (R3, now §8.5) and
a real artifact set — not against §8.2's estimates, and not before the architecture is proven.

**E3 · Windows arm64 is out of the initial target. Settled.** F2: VSCodium has never published
`vscodium-reh-win32-arm64`, in the current release or in any of the last 30. **The plan already
conditions it** — §7's architecture table says "arm64 only if every native and REH artifact
exists" — and the artifact does not exist, so the plan's own condition decides this rather than
a new judgement being needed. It costs nothing today: `electron-builder.yml:84-87` builds
Windows x64 only. Reopened if VSCodium publishes the artifact, or if E0 is reopened, or if the
§3.4 build branch is taken for other reasons — `BUILD_TARGETS` does include `win32-arm64`.

**E4 · Linux x64 stays in the Phase 1 architecture proof and is NOT deferred to Phase 7.
Settled.** Plan Phase 1 says "passing on macOS alone does not pass this phase", and that stands.
The first draft framed §7.1's finding — no Linux build target, no Linux machine — as a conflict
where "one of those two statements has to give". **Neither gives.** The finding is a
prerequisite, not a contradiction: what it establishes is that §9 item D2 has to be done, not
that Linux should leave the gate. Deferring Linux to Phase 7 would move the discovery of a
Linux-specific problem — glibc against the REH's bundled `node`, `chrome-sandbox` and the SUID
bit, both named in §7.3 — past the point where the architecture could still be changed in
response to it, which is the entire purpose of a kill gate. Linux arm64 is separately conditioned
by plan §7 on artifact availability; the Linux **x64** REH exists (§2.2) and is the one that
gates.

**E5 · The workbench surface is an Electron `WebContentsView` on a dedicated session partition.
Settled in review round 2.** §4.1a: the separate-origin frame is withdrawn because it cannot be
built as specified — `frame-ancestors 'self'` contradicts a separate origin, and a child frame
cannot receive IPC without `nodeIntegrationInSubFrames`, which loads every preload into every
iframe including extension webviews. This is settled on **capability**, not on preference, which
is why it is here rather than in §9 B: there is no evidence a Phase 1 comparison could have
produced that would change it. The accepted cost is bounds-driven layout under plan §2.4's four
panes, and §7.2 has a proof row for it. Reopened only if Electron gains a way to deliver a secret
to one subframe without arming all of them.

**E6 · One REH is shared by all projects; each project gets its own connection, its own forked
extension host and its own root. Settled in review round 2.** §4.1a: the server keys its
connections by reconnection token and forks an extension host per connection
(`remoteExtensionHostAgentServer.ts:61-62`, `extensionHostConnection.ts:281-288`), so one server
serving several workspaces is upstream's design, and it is the arrangement with the **lower
marginal cost per project** — one connection and one forked extension host, rather than a second
server, a second watcher set and a second host. **Round 3 corrects the overreach**: this was
written as "the only topology under which R7 can pass on the architecture's merits", which turns
an unmeasured prediction into a settled fact. **R7 still decides**, it is pre-registered for
exactly that reason, and a shared REH can fail it. **What it also does not settle** is whether a
shared `--extensions-dir` and global-storage namespace is acceptable in the product; that is
Phase 5's, and §7.2's isolation assertion is what will tell it something. **What it does settle**
is the lifetime: the server is refcounted by **project**, acquired on open and released on close,
never by visible view — §5.4 has the table and the reason. Reopened if per-project isolation
proves inadequate, at R7's price.

**What remains genuinely open** is everything in groups A–D above, which are actions needing
authorisation, plus D3 (macOS x64 scope) and D4 — and D4 is now narrowed by E3 to "acquire an ARM
Windows machine to test x64 emulation", which is optional future work rather than a decision
blocking Phase 1.

---

## 10. What this brief could not answer

Listed together so nothing here is mistaken for a finding.

- Whether monaco-vscode-api actually sends `commit` in the handshake, i.e. whether the version
  check in §1.4 fires at all in this client (§1.5a) — needs A6. **The error text itself is now
  known from source and is no longer an open question.**
- ~~Whether main can confirm the running server's provenance by asking the server.~~ **Closed in
  review round 3, and the answer is no.** The REH's `product.json` carries only
  `{ commit, date, version }`, none of which names an upstream VS Code (§2.3, §3.5), and after
  §1.5b's patch the commit is Chorus's own value echoed back. Provenance comes from the release's
  `upstream/stable.json`, the artifact's published sha256, and a Chorus-written extraction receipt.
  What remains for A4 is the confirmation that the shipped file matches what the build sources say
  it will.
- The unpacked size and full licence inventory of a REH tarball (§3.2, §8.2) — needs A3.
- Whether VSCodium's build kept upstream's server CLI flags unchanged (§5.3) — the flags are
  confirmed in upstream source; only VSCodium's build is unchecked. Needs A5.
- Whether Code-OSS webviews use `<iframe>` or Electron `<webview>` in this configuration, and so
  whether `security.ts:91-93` can stay (§5.2) — needs B4.
- ~~Whether an `<iframe>` workbench gets its own renderer process under Electron 43 (§8.2).~~
  **Moot after §4.1a**: a `WebContentsView` is its own top-level `WebContents`, so the answer is
  one per surface by construction rather than by site-isolation heuristics.
- ~~**Which §4.1a surface Chorus should use.**~~ **Closed in review round 2: `WebContentsView`.**
  Surface (A) cannot be built as described — `frame-ancestors 'self'` and "separate origin" are
  mutually exclusive, and a child frame cannot receive IPC without `nodeIntegrationInSubFrames`.
  What remains open is narrower and is an implementation risk rather than a choice: **how a
  bounds-driven overlay behaves under plan §2.4's four-pane layout**, which §7.2 now has a proof
  row for.
- ~~**Whether a preload can be scoped to one subframe without `nodeIntegrationInSubFrames`.**~~
  **Answered from Electron's documentation, and the answer is no** — the option is what enables
  child-frame IPC at all, and it loads "all your preloads … for every iframe". That is what
  disqualified surface (A), so it is a finding rather than an open question.
- **Whether the workbench tolerates a non-persistent session partition** (§4.1a). The preference
  is an in-memory partition so the `vscode-tkn` cookie cannot outlive a quit; whether the client's
  storage services require `persist:` is unverified.
- **Whether one shared REH isolates two projects well enough** (§4.1a). The server's own source
  shows it holds many keyed connections and forks an extension host per connection, so serving two
  roots is upstream's design — but `--extensions-dir` and global storage are per-**server**, and
  whether a shared global-storage namespace is acceptable is a Phase 5 question that Phase 1's
  §7.2 isolation assertion opens rather than closes.
- **Whether an inactive project's REH-side terminals survive its surface being unmounted** (§5.4).
  Plan §2.4 promises they do, and the refcount is defined over projects rather than views so that
  Chorus does not kill them itself — but unmounting drops the WebSocket and the server reaps the
  connection on its own timer, and **nothing read for this brief establishes what happens to the
  processes behind it.** If they do not survive, "close the surface, keep the terminals" needs a
  mechanism the plan does not currently have, and that is a Phase 1 finding rather than a Phase 4
  surprise. §7.2 has the check.
- **Whether the workbench client tolerates a preload that exposes one method** (§4.1b). Nothing in
  the design needs more, and nothing read suggests the library inspects its host's globals — but
  the serverless demo runs in an ordinary page, so "a `WebContentsView` with `sandbox: true`,
  `contextIsolation: true` and a one-method bridge" is a configuration nobody has run it in.
  UNVERIFIED, and it is the first thing §2.5 step 1 would find out.
- **Whether omitting `productConfiguration.commit` actually disarms the version check in this
  client** (§1.5a). Round one asserted it does; the shipped product module hardcodes `commit` and
  merges any override _last_, so a spread cannot remove it. Which value reaches `msg2.commit`
  needs A6 — and until it runs, **no version check has been observed firing in this client at
  all.**
- **The installed size of Chorus today** (§8.1) — needs A10. §8.1 recorded compressed installer
  sizes only. **No longer blocking anything in Phase 1**: R3 is a packaging threshold (§8.5), and
  the baseline is recoverable from a published release at any time.
- **Whether monaco-vscode-api's running-location picker implements the documented "web extension
  host preferred over remote for `ui` extensions" branch** (§6.1). VS Code's own doc states the
  rule and scopes its example to Codespaces; whether this client reproduces it is what §6.6's
  restored web-host slot observes.
- Whether the REH supplies the built-in extensions, letting the 82 `*-default-extension` npm
  packages (166 MB) be dropped (§8.2) — needs B5.
- The built size of the workbench frame chunk. npm unpacked size does not predict it, and the
  Monaco precedent is the proof that it does not (§8.2) — needs B3.
- Whether the `monaco-editor` alias can be scoped per-entry (§4.3) — needs B2.
- Whether issue #804's Bug 1 **applies to a full `WorkbenchService` at all**, and if so whether
  the pinned version guards it (§6.4) — needs A8. **The question changed in review**: the report
  was made against `ViewsServiceOverride` plus hand-composed parts, which is not the
  configuration Chorus proposes, so "is it fixed" was the wrong question before "does it apply".
- **Whether two sandbox workbenches can be alive simultaneously** (§4.4). The maintainer says the
  mode is possible; the demo reinitialises **one**. This is the single largest undemonstrated
  claim the architecture rests on, and it is R12/R11's job to settle it.
- Whether `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` can be dropped once a REH
  supplies the extension host (§4.4) — needs B4.
- Whether Draw.io's shared `main`/`browser` bundle genuinely runs in a web worker (§6.2) — needs
  a run.
- Whether `GitHub.vscode-pull-request-github` and `openai.chatgpt` **degrade or throw** when their
  proposed APIs are absent (§6.3). This one is not cosmetic: an unhandled throw during
  extension-point processing is the same failure shape as #804's Bug 1, which aborted every
  extension's views rather than one.
- Whether VS Code honours a declared `extensionKind: ["workspace"]` over a present `browser`
  entry point (Prettier, §6.2). Immaterial to Chorus's topology; noted so the ledger records the
  right reason.
- Open VSX's registry terms of use verbatim — its pages render client-side and could not be read
  by fetch; the VSCodium documentation is cited instead, and the gap is noted rather than filled
  from memory.

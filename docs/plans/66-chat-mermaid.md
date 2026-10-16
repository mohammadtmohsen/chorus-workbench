# Render Mermaid diagrams in chat

## Status

| Unit           | Result                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Scope          | Approved: fix Mermaid display in chat; Codex leads and reviews, Claude implements                                        |
| Evidence       | User screenshot shows literal Mermaid code; renderer has no Mermaid branch or dependency                                 |
| Baseline       | `/private/tmp/chorus-mermaid-baseline-rratthut`; Codex owns this plan, Claude owns the implementation batch              |
| Plan           | Design and corrected implementation accepted after Codex source/diff review                                              |
| Implementation | Written by Claude; all three review findings corrected and re-reviewed; runtime unverified                               |
| Verification   | Requested build and local installation passed on 2026-10-16; runtime checks, tests, lint and UI interaction remain unrun |

## Current / Issue

The supplied screenshot shows flowcharts as syntax-highlighted text under a MERMAID label. `MarkdownView.tsx` sends every code block through `CodeRun`, including language `mermaid`; neither the renderer nor the desktop dependency list contains a Mermaid renderer. This is missing diagram support rather than evidence of a broken diagram layout.

The shared parser preserves fenced text, including unfinished streamed fences. Ordinary code rendering, clipboard behavior and source records must remain intact. The repository forbids `dangerouslySetInnerHTML`, treats agent output as untrusted and restricts renderer resources through CSP.

## Proposed

Route Mermaid fences to one focused diagram component while preserving the existing code path for other languages. Use a local diagram renderer loaded only when Mermaid is present. Prefer an inert generated SVG image compatible with existing CSP rather than inserting generated HTML into the chat. Claude must evaluate the actual library API, resource behavior and streaming lifecycle before choosing the final implementation. A new dependency is justified only if the repository has no suitable existing renderer.

Show a readable local loading state and retain access to the exact source and existing copy action. Malformed or incomplete input must not break the surrounding reply. Handle wide diagrams within the transcript column, with readable labels in the current theme. Avoid zoom tools, editing, exporting, remote rendering and unrelated markdown changes.

## Resolved implementation design

Codex checked the published Mermaid 12.2.0 source and accepted adding that exact local dependency as necessary to render the existing grammar and layout. No additional user decision is needed for the ordinary implementation choices: follow the app theme, show wide diagrams at natural size with horizontal scrolling, preserve source through Copy, and omit a new source-toggle control. The package has a material lazy-load cost (Claude counted about 5.5 MB across 102 minified chunks); the actual Vite output and load cost remain unmeasured until a build is requested. No CDN or remote rendering service is used.

Use one lazy import, a serialized initialize/render queue, a bounded cache keyed by source and scheme, and the public `mermaid.render` API with a private off-screen measurement host cleared in `finally`. Present only normalized SVG as an image data URL, never as inline generated HTML/SVG in the chat. Lock security, error rendering and appearance keys against diagram directives, keep HTML labels disabled, preserve resource bounds, and never call `bindFunctions`. The shell CSP is unchanged. Decode failures of the image must return to source with the same local failure message as parse/load failures.

Three corrections to the initial collaborator design are required:

- `splitBlocks` toggles fence state without remembering marker kind or length (`shared/markdown.ts:760`), so a non-last raw block is not proof of a completed fence. Conservatively keep Mermaid as source throughout a live message, including its typewriter tail, and render after the message settles. This avoids a parser-contract change and queued partial diagrams.
- Do not export the scheme hook from `FileIcon.tsx`: importing that component also imports `monaco-setup.ts`, which is unsuitable for ordinary chat rendering and Node SSR tests. Keep a small SSR-safe media listener in the Mermaid component; leave FileIcon and Monaco alone.
- Parsing as HTML is not a resource-isolation guarantee: [DOMParser documentation](https://developer.mozilla.org/en-US/docs/Web/API/DOMParser/parseFromString) notes that inert HTML documents can still download image/iframe resources. Keep normalization detached and limited to the strict Mermaid SVG output, never attach that parsed tree to the app, and rely on the unchanged CSP during generation plus the SVG image boundary for presentation. [SVG image restrictions](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image) describe the final image boundary; do not claim that the preceding layout DOM has the same isolation.

QuickQuestion already has a per-turn `streaming` field through `AsideTurn` (`aside.ts:28,93`); use it rather than a room-wide busy guess. Main transcript replies pass live while `message.status` is streaming or the typewriter prefix is shorter than the full text. Keep ordinary fenced code markup and clipboard payloads intact.

## Acceptance criteria

| Criterion        | Required result                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Diagram display  | A completed Mermaid fence shows a diagram, including the LR flowcharts and edge labels in the supplied screenshot                                             |
| Compatibility    | Other fenced languages, normal markdown, clipboard text and stored transcripts remain unchanged                                                               |
| Streaming        | Incomplete and changing sources do not crash chat or replace newer content with stale async results                                                           |
| Failure          | Invalid syntax or renderer loading failure leaves readable source and a local explanation                                                                     |
| Layout and theme | Wide diagrams stay inside the pane without unreadable forced shrinking; labels and edges remain visible in light and dark themes                              |
| Isolation        | Generated content cannot execute scripts, navigate the app, add event handlers to chat or load remote resources; no new CSP allowance without a concrete need |
| Lifecycle        | Repeated blocks and tab remounts do not collide on SVG ids or retain obsolete rendering resources                                                             |

## Code Changes

- `renderer/src/MarkdownView.tsx`: identify Mermaid fences and reuse the existing clipboard control.
- A focused diagram component and renderer module: lazy loading, safe SVG presentation, async cleanup and failure handling.
- `renderer/src/styles.css`: narrowly scoped diagram layout using existing theme tokens.
- `renderer/src/i18n/en.json`: product text only if loading/error/source controls require it.
- `desktop/package.json` and `pnpm-lock.yaml`: only a necessary local renderer dependency, owned by Claude.
- Relevant markdown/diagram regression sources: route selection, untouched ordinary code, source preservation, streaming/error cases and safe rendering. Write sources only until verification is explicitly requested.
- Change the shared markdown block contract only if evidence shows streaming cannot be handled locally.

## Implementation Order

Codex has traced the screenshot to the code-block renderer. Claude independently challenges the proposed rendering boundary, reports the smallest workable design with source/API evidence, and stops before code changes. Codex resolves the findings and sends the implementation unit. Claude then implements within assigned files. Codex reads every changed file and integrated diff, returns supported corrections if needed, and reports each acceptance criterion as PASS, FAIL or NOT VERIFIED with its evidence.

## Implementation review

Codex read the new modules, regression sources and the integration/package diffs against the recorded baseline. Existing ordinary-code markup and the Copy tools row are retained; the package change is Mermaid 12.2.0 only and the lockfile adds entries without replacing existing ones. The conservative live flag is wired to both reply rendering paths. All runtime acceptance criteria remain NOT VERIFIED because checks were not requested.

The initial source review returned three findings to Claude. Each is now corrected in the implementation and covered by regression source:

1. `MermaidDiagram` only reads a cache hit during render, while its effect returns immediately for a hit and never retains it in local keyed state. Evicting that entry then rerendering the mounted component falls back to source, with unchanged effect dependencies and no way to restart the render. A cache that warms between render and the effect also makes the effect skip the update. Retain cached outcomes locally and cover both interleavings with regression sources.
2. `toMermaidImage` validates only the width and height positions in a viewBox; a non-finite or non-numeric x/y origin is accepted. Require all four coordinates to be finite while allowing negative origins and requiring positive dimensions.
3. Mermaid's published renderer replaces text above its maximum with a built-in English error diagram instead of rejecting (`mermaid.core.mjs:1299-1301`). Add a matching explicit source-size bound before generation so oversize content uses Chorus's translated source fallback and does not retain huge cache keys. Keep the bound at or below Mermaid's existing 50,000-character default; do not raise resource limits.

Correction-pass baseline: `/private/tmp/chorus-mermaid-review-fixes-00vlh2zb`. No product code was changed by Codex; Claude owned the four renderer/test files for this correction pass. Codex reread both modules and the entire correction diff. Cache hits are retained in keyed local state, all viewBox coordinates are finite, and sources over the locked 50,000-character limit fail before loading or caching. No further blocking source finding remains; this is source review rather than executed verification.

## Final review and delivery

Local implementation is complete and source reviewed. Claude was the sole product-code writer; Codex owned the plan, design decisions and independent review. Neither agent launched native subagents. Before the user's build/install request, no tests, typechecks, lint, application builds, live UI interaction, screenshots, application installation, commits or pushes were run for this task. The only implementation commands beyond source reads/edits were dependency installation and Prettier.

| Acceptance criterion        | Outcome      | Evidence and verification limit                                                                                                       |
| --------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Diagram display             | NOT VERIFIED | `MarkdownView.tsx:176` routes Mermaid fences into `MermaidDiagram`; no browser render was executed                                    |
| Compatibility and Copy      | NOT VERIFIED | Ordinary code JSX and `CopyCode text={block.text}` are retained; SSR/integration regression cases written but unrun                   |
| Streaming and stale results | NOT VERIFIED | `Entry.tsx:1028` and `QuickQuestion.tsx:591` supply live flags; keyed state and effect cleanup reviewed; race regression cases unrun  |
| Failure fallback            | NOT VERIFIED | Source remains for load/render/XML/decode/size failures, with a translated message; regression cases unrun                            |
| Layout and theme            | NOT VERIFIED | Media-query subscription and natural-size horizontal scroller reviewed; light/dark label quality and width behavior unseen            |
| Isolation                   | NOT VERIFIED | Strict locked config, detached XML conversion, data-image presentation and unchanged CSP reviewed; browser security behavior untested |
| Lifecycle and cache         | NOT VERIFIED | Serialized jobs, unique ids, finally-removed hosts and bounded cache reviewed; retention/unmount regressions unrun                    |

The new dependency is exactly `mermaid@12.2.0`: one desktop manifest entry, 858 added lockfile lines with no replacements, and 115 installed packages as reported by pnpm. It loads only on demand for settled Mermaid blocks. The later requested build emitted `mermaid.core-ZVw0MbC7.js` at 70.65 kB plus shared and diagram chunks; that single file is not the total Mermaid payload. First-load and layout cost, Chromium SVG decoding and Mermaid 12 label quality remain unmeasured.

Implementation refinements to the proposal: strict XML parsing replaces HTML normalization to avoid treating an inert HTML parse as a security boundary; a private host is created and removed for each queued render; the bounded cache uses insertion order rather than read-based LRU. These preserve the scoped behavior without a shared-parser change, a CSP expansion or a broader theme refactor. Temporary published-library source in `/tmp/mermaid-pack` was left in place; cleanup was not part of the requested fix.

## Requested build and installation — 2026-10-16

The user explicitly requested build and installation. Codex ran `CHORUS_INSTALL_KEEP_RUNNING=1 pnpm --dir /Users/mohamadtaleb/code/workbench app:install`; it exited 0. All eight dependency build tasks succeeded from Turbo cache, Electron Vite built main, preload and renderer, and electron-builder packaged the arm64 app with Electron 43.2.0. The local signing hook used `Chorus Local Dev`; the install script's strict signature verification passed and it reported `installed /Applications/Chorus.app`.

The running bundle was preserved at `/Applications/Chorus.app.replaced-1792173426198`, so this conversation stays open. The user must quit and reopen Chorus to load the installed update. The install path preserves the existing Workbench profile and database. No app launch, UI interaction, test suite, lint or separate typecheck was run; the runtime acceptance outcomes above remain NOT VERIFIED.

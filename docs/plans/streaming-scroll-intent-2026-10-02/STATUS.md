# Streaming scroll intent — status

The implementation unit is written and reviewed locally. The user subsequently requested a build and installation, which completed successfully on 2026-10-02. Runtime auto-scroll behavior is NOT VERIFIED. No commit or push was requested or performed.

## Change and cause

`Session` previously stopped following when a scroll event reported backward movement with a gap, even without a user gesture. This source defect is confirmed. The precise timing of the user's intermittent failure has not been reproduced.

The stop condition now also requires `pointerHeld`. The scroller's capture handler arms that ref. Release waits one animation frame for the last scroll event; touch pan cancellation keeps it armed until the touch ends or cancels. Window blur and unmount clear the state and cancel pending callbacks.

The task's incremental product diff contains two refs, one listener effect, one pointer handler, and one changed condition in `apps/desktop/src/renderer/src/Session.tsx`. Existing uncommitted edits are preserved.

## Acceptance evidence

| Criterion                                                                    | Result       | Evidence                                                                                            |
| ---------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------- |
| Hands-off streaming follows through shrink/grow and message/tool transitions | NOT VERIFIED | Source review confirms an unarmed scroll cannot take the backward-stop branch; no live reproduction |
| Multiple agents continue following through completion                        | NOT VERIFIED | No running-app observation                                                                          |
| Wheel and keyboard scrolling pause following                                 | NOT VERIFIED | Existing handlers are unchanged in the baseline diff; not driven                                    |
| Scrollbar, touch, and selection drags pause following                        | NOT VERIFIED | Gesture gate reviewed against upstream Chromium routing; installed platform not driven              |
| Returning to the bottom and sending resume following                         | NOT VERIFIED | Existing paths are unchanged; not driven                                                            |
| Following and parked panes behave correctly after remount                    | NOT VERIFIED | Carry and restore paths are unchanged; split-scroll probe not run                                   |
| Release, cancellation, blur, and unmount clean up the gesture                | NOT VERIFIED | Listener removal and frame cancellation reviewed in source; lifecycle not exercised                 |
| Preserve pre-existing working-tree edits and limit product scope             | PASS         | Incremental baseline diff contains only the agreed gesture unit                                     |
| Integrated code and independent adversarial review                           | PASS         | Codex inspected actual source and diff; Claude reported no supported blocking finding               |

## Commands and checks

Read-only review commands included:

```sh
git diff -- apps/desktop/src/renderer/src/Session.tsx
diff -u /var/folders/lh/4qn11c455ds6gw_5b2d0wjg80000gn/T/chorus-scroll-baseline-il7qvzuk/Session.tsx apps/desktop/src/renderer/src/Session.tsx
git status --short -- apps/desktop/src/renderer/src/Session.tsx docs/plans/streaming-scroll-intent-2026-10-02
```

`git diff` completed successfully. `diff -u` returned 1 because the files differ, and showed only the intended gesture changes. The full changed source and plan were read.

During implementation, no tests, typecheck, lint, format checks, builds, app launches, screenshots, or verification harnesses were run. This honored the standing global and repository instruction to leave executable verification unrun unless specifically requested.

## Authorized build and installation

The subsequent build/install request was completed with the repository's normal dependency build, local packaging, and installation scripts:

```sh
pnpm exec turbo run build '--filter=@chorus/desktop^...'
node apps/desktop/build/package-local.mjs
env CHORUS_INSTALL_KEEP_RUNNING=1 node apps/desktop/build/install-local.mjs
```

All three commands exited 0. The dependency build reported eight successful cached tasks. Electron Vite built main, preload, and renderer assets; Electron Builder packaged the Apple Silicon app with Electron 43.2.0 and the stable `Chorus Local Dev` signing identity. The package and install scripts both completed their built-in signature verification.

Installed destination: `/Applications/Chorus.app`. Keep-running mode preserved the current session by moving the previous bundle to `/Applications/Chorus.app.replaced-1790899812714`. Quit the running copy and open `/Applications/Chorus.app` to load the new build. The previous bundle remains available until the running copy has quit.

Tests, lint, the full typecheck gate, app launch, and streaming reproduction remain unrun. Successful packaging and installation do not establish the runtime acceptance criteria above.

## Adversarial review and research

The touch-cancel concern was checked against `HandlePointerInterruption`: browser pan takeover dispatches pointer cancellation without sending legacy touch cancellation on that path. Scroll steps precede animation-frame callbacks in `PageAnimator`, supporting deferred release for an already queued final scroll event.

- [Chromium event routing and scrollbar release](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/input/event_handler.cc)
- [Chromium pointer interruption](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/input/pointer_event_manager.cc)
- [Chromium frame ordering](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/page/page_animator.cc)

These are current upstream sources, not a runtime measurement or a verification of Electron's exact bundled revision.

## Remaining limits

Native macOS overlay scrollbars and compositor-threaded release timing remain unverified. Layout changes while a pointer is held can still pause following. Multi-pointer releases can disarm another active pointer. Find-in-page, accessibility scrolling, and middle-click autoscroll after release do not supply this gesture gate. The existing upward-wheel threshold is unchanged.

No product scope deviations. The plan and this status record follow the repository's documentation workflow.

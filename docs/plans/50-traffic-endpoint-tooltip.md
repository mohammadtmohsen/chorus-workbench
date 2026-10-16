# In-place endpoint expansion

## Status

| Unit           | Result                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------- |
| Scope          | Reveal the displayed endpoint in place on hover, on one line with a solid background      |
| Inspector      | Removed the pictured selected-request summary; diff reviewed                              |
| Implementation | In-place expansion written and diff reviewed; runtime behavior unverified                 |
| Verification   | Latest hover revision built, signed, installed and signature verified; live UI unverified |

## Current / Issue

The endpoint cell truncates long paths. Its existing instant tooltip shows the raw URL in a separate decorated popup. The user requested the same displayed endpoint, font, color and position, with truncation removed and an opaque background so overflow remains readable over the Terminal panel.

The inspector previously repeated the selected request's method, status and full URL in a summary strip above the Request/Response panes. That strip was removed at the user's request.

## Proposed

Use the existing portaled endpoint tooltip as an in-place expansion. Measure the cell's text origin and copy its computed typography, color and solid surface color. Reveal the complete displayed path, respecting the saved hidden prefix. Let the line overflow horizontally without wrapping, truncation or repositioning. Reuse the existing shell-overlay hook so it can appear over native editor views.

## Code Changes

### NEW: `apps/desktop/src/renderer/src/TrafficEndpoint.tsx`

Render the endpoint and a hoverable `role="tooltip"` expansion with the same text and class. Position it at the cell's content edge, preserving fractional coordinates, and copy its computed font, line height, letter spacing and text color. Match the nearest opaque row or panel background. Dismiss on Escape, window blur, resize, scrolling and pointer exit. Clear its close timer when unmounted.

### `apps/desktop/src/renderer/src/TrafficPanel.tsx`

```tsx
<TrafficEndpoint label={pathOf(row.u, hiddenPathPrefix)} />
```

### `apps/desktop/src/renderer/src/TrafficRequestInspector.tsx`

Remove the selected-request summary header and its formatting import. The inspector starts with the request and response content. Update the existing pending-response assertion to check that the header is absent.

### `apps/desktop/src/renderer/src/styles.css`

```css
.traffic-endpoint-tooltip {
  position: fixed;
  width: max-content;
  max-width: none;
  overflow: visible;
  background: var(--bg-chrome);
  text-overflow: clip;
  white-space: nowrap;
}
```

Remove the popup padding, border, shadow and independent font styling. Keep the background solid and update the existing hover assertion to expect the displayed endpoint. Do not run tests or rebuild without a new request.

The implementation and updated hover assertion were diff reviewed against `/private/tmp/traffic-endpoint-tooltip-funw0x3y`. The new endpoint cell uses no opening delay and keeps the tooltip open when the pointer moves onto it. Tests, typechecks, builds and live UI checks were not run.

The selected-request summary and its obsolete header comments were removed from the inspector. The existing pending-response assertion now checks that the summary header is absent. These source diffs were reviewed against `/private/tmp/traffic-summary-removal-riouh0r9`. Tests and live UI checks remain unrun.

Before the in-place expansion revision, on 2026-10-15, `CHORUS_INSTALL_KEEP_RUNNING=1 pnpm --dir /Users/mohamadtaleb/code/workbench app:install` completed successfully. The dependency build, Electron renderer/main/preload builds, arm64 packaging and signing with `Chorus Local Dev` passed. The installer copied the app to `/Applications/Chorus.app` and its deep, strict code-signature verification passed.

That installation kept the Chorus session running and retained its previous bundle at `/Applications/Chorus.app.replaced-1792067866317`. Tests, standalone typecheck gates and live UI checks were not run.

The later in-place expansion revision was diff reviewed against `/private/tmp/traffic-inline-endpoint-0842_s51`. It uses the same displayed path, fractional text coordinates and computed typography and color as the cell, with a solid matching surface behind the overflowing line. The existing hover assertion now expects that displayed path. At that source review, tests, typechecks, builds, installation and live UI checks had not been run for this revision.

At the user's subsequent build-and-install request on 2026-10-15, the same `CHORUS_INSTALL_KEEP_RUNNING=1 pnpm --dir /Users/mohamadtaleb/code/workbench app:install` command completed with exit code 0 for the in-place expansion revision. The dependency build, Electron renderer/main/preload builds, arm64 packaging and local signing passed. Installation to `/Applications/Chorus.app` and deep, strict signature verification passed. The running session was kept open, with the replaced bundle retained at `/Applications/Chorus.app.replaced-1792069541560`. Quit and reopen `/Applications/Chorus.app` to load the latest change. Tests, standalone typecheck gates and live UI checks were not run.

## Final Flow

```mermaid
flowchart LR
    Hover[Hover an endpoint] --> Tip[Same endpoint expands at its original position]
    Tip --> Read[Read or copy the overflowing line on a solid background]
    Read --> Close[Leave, press Escape or move the table]
```

# Traffic rows: Method, Status, Endpoint

## Status

| Unit           | Result                                                              |
| -------------- | ------------------------------------------------------------------- |
| Scope          | Agreed: show only Method, Status and Endpoint, in that order        |
| Implementation | Written and diff reviewed; runtime behavior unverified              |
| Verification   | Local build and installation passed; tests and live UI checks unrun |

## Current / Issue

The Traffic table uses five columns: Method, Endpoint, Status, Outcome and Detail.

## Proposed

Use three columns. Keep the existing pending indicator inside Status and give Endpoint the remaining row width.

## Code Changes

### `apps/desktop/src/renderer/src/TrafficPanel.tsx`

Render the existing method, status and endpoint cells in that order. Remove the Outcome and Detail cells, their table-only helpers and imports. Use the existing translated headers and pending indicator. Keep the saved path prefix, full-URL hover and row selection behavior.

### `apps/desktop/src/renderer/src/styles.css`

```css
grid-template-columns: max-content max-content minmax(0, 1fr);
```

Remove styles owned by the deleted Outcome and Detail cells. Keep the shared row/header subgrid, status colors and pending animation.

The source diffs were reviewed against `/private/tmp/traffic-three-columns-5g_e3yjp`, preserving pre-existing changes in both files. Tests, typechecks, builds and live UI checks were not run.

On 2026-10-15, the local build, signed packaging and installation passed. See the [installation record](50-traffic-endpoint-tooltip.md). Reopen Chorus to load the update. Tests and live UI checks remain unrun.

## Final Flow

```mermaid
flowchart LR
    Request[Request arrives] --> Pending[Method, pending status, endpoint]
    Pending --> Response[Method, HTTP status, endpoint]
    Response --> Select[Click row for full request and response]
```

# Traffic call limit

## Status

| Unit           | Result                                                       |
| -------------- | ------------------------------------------------------------ |
| Scope          | Latest 10 calls by default, with an adjustable display limit |
| Implementation | Written and diff reviewed; runtime behavior unverified       |
| Verification   | Not run; the user has not requested tests                    |

## Current / Issue

```tsx
const paged = pageOf(filterRows(stream.rows, search), page)
const shown = paged.rows
```

The list uses 200-row pages and Older/Newer controls.

## Proposed

```mermaid
flowchart LR
    History[Retained traffic] --> Search[Search all retained rows]
    Search --> Latest[Latest matching calls]
    Limit[Limit selector: 10, 20, 50, 100, 200, 1000] --> Latest
    Latest --> List[One scrolling list]
```

The display limit is local to the panel. Capture retention stays available when the limit increases. An initial selection belongs to the visible window; an already selected request stays open while new calls arrive.

## Code Changes

### `apps/desktop/src/renderer/src/TrafficPanel.tsx`

```tsx
const DEFAULT_CALL_LIMIT = 10
const CALL_LIMITS = [DEFAULT_CALL_LIMIT, 20, 50, 100, 200, 1000]

const [callLimit, setCallLimit] = useState(DEFAULT_CALL_LIMIT)
const filtered = filterRows(stream.rows, search)
const shown = filtered.slice(-callLimit)
```

Replace paging state and navigation with the limit selector. Report `shown.length` in the existing count label. Preserve scrolling, keyboard selection, capture controls, and the request inspector.

### `apps/desktop/src/renderer/src/i18n/en.json`

```json
{
  "callLimit": "Call limit",
  "lastCalls": "Last {{limit}} calls"
}
```

## Final Flow

```mermaid
sequenceDiagram
    actor User
    participant Panel as TrafficPanel
    participant History as Retained rows
    User->>Panel: Open Traffic
    History-->>Panel: Current capture
    Panel-->>User: Latest 10 calls
    User->>Panel: Choose a larger limit or search
    Panel->>History: Filter and take the latest matching calls
    Panel-->>User: Updated list and shown count
    User->>Panel: Select a call
    Panel-->>User: Existing request inspector
```

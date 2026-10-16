# Project browser collapse persistence

## Status

| Unit           | Result                                                                              |
| -------------- | ----------------------------------------------------------------------------------- |
| Scope          | Requested by the user on 2026-10-14: persist each project browser's collapsed state |
| Implementation | Written and reviewed against copies of the six files from before this change        |
| Verification   | Source paths reviewed; tests, build, install, and runtime behavior unverified       |

## Current / Issue

`EditorPane.tsx` keeps `collapsedBrowsers` in component state. Reopening Chorus or
moving a project to another pane discards it. Traffic and project terminal collapse
flags already travel in the workspace snapshot.

## Proposed

Move `collapsedBrowsers` to the saved workspace snapshot as a map of project IDs
to booleans. Default the map to `{}` so older snapshots keep their conversations
and open browsers expanded. Add an optional `browserCollapsed` value to the
project layout slice so detaching and returning a project carries its preference.

Use a workspace action and a selector hook in `EditorPane`. Update the store
synchronously and commit the layout on each toggle, following the neighboring
Traffic and terminal controls. Keep the existing width, visibility, and reveal
behavior in `BrowserPanel`.

## Files

- `shared/workspace-layout.ts`: defaulted snapshot map and optional slice flag.
- `workspace/layout.ts`: empty default and project slice extraction and merge.
- `workspace/store.ts`: snapshot field and `setBrowserCollapsed` action.
- `workspace/hooks.ts`: selector hook and action exposure.
- `workspace/EditorPane.tsx`: replace local state and commit toggles immediately.
- `main/open-projects.test.ts`: update the existing older-snapshot default
  expectation to include the empty collapse map.

## Verification

Review the schema default, snapshot serialization, startup hydration, and detached
window transfer paths. Existing snapshot comparison coverage derives its keys from
the schema. Do not run tests or builds. A future hand check should collapse one
project browser, expand another, reopen Chorus, and detach and return the project.

Source review confirmed that the snapshot carries the map, the existing schema-key
comparison notices changes to it, hydration retains it, and project slice merging
preserves an explicit `false` value. Browser toggles now commit immediately. The
existing older-snapshot parser fixture includes the map's empty default. Nothing
was run, and the installed app has not been updated for this change.

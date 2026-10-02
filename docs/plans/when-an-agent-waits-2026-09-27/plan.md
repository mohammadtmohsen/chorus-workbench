# When an agent waits

**Status: built, reviewed twice by deepseek. Nothing run — every criterion below
is unverified until `pnpm check` and a packaged run on each platform.**

## The problem

An approval or a question stops an agent until someone answers it. The user asked
for a system notification every time that happens, with these rules:

- **What counts:** agent permission approvals, and an agent asking something
  (questions, plan approval). Not Chorus's own dialogs, not the workbench's
  prompts, not a finished turn, not an error.
- **When:** always — focused or not, on screen or not.
- **Afterwards:** left alone. Answering in-app does not withdraw it.
- **Click:** brings Chorus forward. Nothing more.
- **No buttons** on the notification. Approving a command you have not seen is
  the thing the approval card exists to prevent.
- **One global off switch. Silent.**
- **macOS and Windows.**

A notify path already exists (`5be2edf`, 2026-08-08): `notify.ts` judges,
`App.tsx` `raise` calls the web `new Notification(...)`. **It has never reached
the OS.** The chain at Electron `v43.2.0`, read from source:

1. `platform_notification_service.cc` `DisplayNotification` creates the
   notification, then asks `WebNotificationAllowed`.
2. That goes through the permission manager to the session's request handler.
3. `security.ts:59-62` answers `callback(false)` on the shell session — since the
   M0 scaffold, five days before the notify feature landed.
4. `OnWebNotificationAllowed` with `allowed = false` calls
   `notification->Destroy()`. The `try/catch` in `raise` cannot see it.

Source-verified, and it matches what the user sees: they have never seen a Chorus
notification.

Windows has a second, independent gap. electron-builder's NSIS installer stamps
the Start Menu and desktop shortcuts with `WinShell::SetLnkAUMI … "${APP_ID}"`,
which is `dev.chorus.desktop`. The process never calls `app.setAppUserModelId`,
so it runs as Electron's default `electron.app.Chorus`. To Windows the app and its
own shortcuts are two identities, and a toast from an AUMID no shortcut carries
has nothing to attach to.

## The shape

### The renderer still decides and words it; main raises it

Three places could own this. Only one fits.

- **All in main.** Rejected: main has no translator. `buildHandlers(runtime)`
  sees neither `i18n/en.json` nor the conversation's title, both of which live in
  the renderer. Main-owned notifications mean English hardcoded in main, or an
  i18n stack in main for one sentence.
- **Keep the web `Notification`, open the permission.** Rejected: it is a hole in
  a deny-everything wall whose comment argues it must stay shut, and the
  `notifications` check arrives with no `webContents`, so it cannot be scoped to
  the main window.
- **The renderer asks main to show it.** A new `app:notify` IPC, shaped like
  `app:setBadge`: the renderer knows what to say, main owns the API. Electron's
  main-process `Notification` never touches the permission manager.

`noticesFrom` already runs in the always-mounted `App` listener, so a
conversation whose `Session` is unmounted is covered the same way the badge is.

### What counts

`noticesFrom` narrows to `approval.requested` and `userinput.requested`. Every
action-needing moment arrives as one of those two:

| Moment                                              | Event                 |
| --------------------------------------------------- | --------------------- |
| Claude tool approval, `mcpToolCall`, `ExitPlanMode` | `approval.requested`  |
| Claude `AskUserQuestion`                            | `userinput.requested` |
| Codex approvals                                     | `approval.requested`  |
| Codex `item/tool/requestUserInput`                  | `userinput.requested` |

`done` and `failed` go. They never reached the screen, so nothing the user has
seen disappears. `NoticeKind` and `URGENCY` go with them.

**So does the per-batch collapse.** It existed so `done`, `failed` and `waiting`
arriving in one push would not raise three banners for one moment. With only
requests left, two in one push are two decisions, and each gets its own banner.
`noticesFrom` becomes a filter.

### Always

`shouldRaise` is deleted with its tests, and its `document.hasFocus()` call with
it; the one in `sendProjectVisibility` stays. `visibleConversationIds` and
`detached` stay: the read watermark uses them.

A conversation in a detached window raises like any other — the old gate stayed
quiet about a focused one. Its click brings forward the detached window holding
the card: the renderer sends the conversation's `projectId`, and main raises that
project's window while it is `'detached'`, the main window otherwise. A
conversation missing from the session list sends `projectId: ''`, which matches
no detached window and falls back to the main window.

History cannot trigger a banner. `store.subscribe` fires only from `append` and
`appendMany`; launch, attach and transcript loads read through
`conversation:history` / `conversation:transcript`, which never notify.

There is always exactly one raiser. Detached windows receive the same push and
already return early (`role.kind === 'detached'`). And the main window cannot
close alone: its `close` runs `closeEveryDetachedWindow()`, then
`window-all-closed` quits.

A foreground macOS app does get banners: Electron's `willPresentNotification`
answers `Banner | List | Sound`. So "always" needs no platform work.

### Silent, switchable, forward

- `silent: true` on every notification. The macOS delegate always offers `Sound`,
  so silence has to come from the notification (`content.sound = nil`).
- `notifications: z.boolean().default(true)` in `main/settings.ts` and mirrored in
  `SettingsShape`. `.default` is load-bearing: a required field fails the parse
  and `readSettings` falls back to defaults, silently resetting every preference.
- **Main reads the switch at raise time**, from `readSettings`. That is what
  makes flipping it apply to the next request with no restart and no push
  channel. It costs one small sync read per request — `settings:read` already
  does the same.
- A click restores, shows and focuses the window holding the conversation —
  `detachedWindowOf(projectId)`, else the main window — through the existing
  `raise` in `detached-windows.ts`. No project jump, no unread clearing: the dot
  stays until the conversation is looked at.
- Each notification is its own. Electron gives each a fresh UUID when no `id` is
  passed, so they stack; none is replaced or withdrawn.
- **`timeoutType` stays default.** On Windows the toast slides off after a few
  seconds into Action Center, the way a macOS banner slides into Notification
  Centre. `'never'` would pin a toast on screen for every approval, including the
  one you are looking at. "Left alone" was about withdrawal, not about staying
  on screen.
- Windows: `app.setAppUserModelId('dev.chorus.desktop')`, at module scope in
  `main/index.ts`, before `whenReady`, so the first window is grouped under it.
  The `win32` guard is required: the method does not exist on macOS and would
  throw on every launch. It must match `appId` in `electron-builder.yml`. It also
  changes taskbar grouping and pinned-shortcut identity, so it earns a CHANGELOG
  line.

## Code

`shared/ipc.ts`, beside `app:setBadge`:

```ts
'app:notify': {
  request: z.object({ title: z.string(), body: z.string() }),
  response: z.object({ ok: z.literal(true) }),
},
```

and `readonly notify: (request: IpcRequest<'app:notify'>) => Promise<{ ok: true }>`
on the API; `notify: invoke('app:notify')` in `preload/index.ts`.

`main/ipc.ts`. `buildHandlers` gains the main window, because `Handlers` receive
no `event` by design and there is nothing else to focus from:

```ts
const MAX_SHOWN = 50
const shown = new Set<Notification>()

export function buildHandlers(
  runtime: ChorusRuntime,
  mainWindow: () => BrowserWindow | null
): Handlers {
  // …
  'app:notify': (request: IpcRequest<'app:notify'>) => {
    if (!Notification.isSupported() || !readSettings(app.getPath('userData')).notifications)
      return Promise.resolve(OK)
    const banner = new Notification({ title: request.title, body: request.body, silent: true })
    shown.add(banner)
    const [oldest] = shown
    if (shown.size > MAX_SHOWN && oldest !== undefined) shown.delete(oldest)
    const forget = (): void => void shown.delete(banner)
    banner.on('click', () => {
      forget()
      raise(mainWindow())
    })
    banner.on('close', forget)
    banner.show()
    return Promise.resolve(OK)
  },
```

`shown` is required, not insurance. The API `Notification` is not a
`TrackableObject`; once collected, its destructor nulls the platform
notification's delegate and a click on a banner still on screen does nothing.
The cap is there because macOS never emits `close` for a banner that slides into
Notification Centre untouched — without it the set grows for the life of the
process. Past 50, the oldest banner's click is dropped.

`registerIpcHandlers(runtime, () => mainWindow)` at `index.ts:344`, where
`mainWindow` is already in scope.

Rejected click target: `BrowserWindow.getFocusedWindow() ?? getAllWindows()[0]`,
the `project:adopt` precedent. At click time nothing may be focused, and
`getAllWindows()` order is not guaranteed, so it can raise a detached window.

`notify.ts`:

```ts
export interface Notice {
  readonly conversationId: string
  readonly actor: string
}

export function noticesFrom(events: readonly TranscriptEvent[]): Notice[] {
  const notices: Notice[] = []

  for (const event of events) {
    if (event.type !== 'approval.requested' && event.type !== 'userinput.requested') continue
    notices.push({ conversationId: event.conversationId, actor: event.actor })
  }

  return notices
}
```

`App.tsx`, the tail of the events effect:

```ts
for (const notice of noticesFrom(events)) {
  const session = sessionsRef.current.find((s) => s.conversationId === notice.conversationId)
  void window.chorus.notify({
    title: t('notify.waiting', { agent: notice.actor }),
    body: session?.title ?? '',
  })
}
```

`void`, matching `setBadge` two lines above it. `raise` and the
`'Notification' in window` guard are deleted.

## Files

| File                              | Change                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `shared/ipc.ts`                   | `app:notify`; `notifications` in `SettingsShape`; API type                                     |
| `preload/index.ts`                | `notify`                                                                                       |
| `main/ipc.ts`                     | the handler; `buildHandlers` and `registerIpcHandlers` take `mainWindow`                       |
| `main/ipc.test.ts`                | `buildHandlers` call sites pass `() => null`; a `Notification` mock and `app:notify` tests     |
| `main/detached-windows.ts`        | export `raise`; delete the `window:focus` handler                                              |
| `shared/detached-window-ipc.ts`   | delete `window:focus`                                                                          |
| `main/index.ts`                   | `setAppUserModelId` on win32; pass `() => mainWindow`                                          |
| `main/settings.ts`                | `notifications` field and default                                                              |
| `renderer/src/notify.ts` (+ test) | `noticesFrom` becomes a filter; delete `shouldRaise`, `NoticeKind`, `URGENCY`                  |
| `renderer/src/App.tsx`            | call `notify`; delete `raise`                                                                  |
| `renderer/src/Settings.tsx`       | a "Notifications" fieldset with one checkbox, rendered by `Appearance`                         |
| `renderer/src/i18n/en.json`       | `settings.notifications`, `settings.notificationsHeading`; drop `notify.done`, `notify.failed` |

**Corrected during the build.** The checkbox was first placed beside
`styleOnByDefault`, which put it under the "explain in your language" legend
and above the bilingual footnote. It moved to its own fieldset, rendered from the
existing `Appearance` function so no component is added. Deleting `raise` left
`window.chorus.focusWindow` with no caller, so the `window:focus` channel went
with it: contract, handler, preload entry, API type, and the stray comment in
`shared/ipc.ts` that described it.

`notify.done` and `notify.failed` are reachable only through the template literal
``t(`notify.${notice.kind}`)`` in `raise`. Grep cannot find them and
`en.test.ts` only checks single-quoted literals, so they are deleted in the same
commit as `raise`.

No new comments in code (user rule). Comments owned by deleted code go with it —
`raise`, `shouldRaise`, `kindOf`, `URGENCY`, and the collapse rationale on
`noticesFrom`. In `notify.ts`'s header, the sentence arguing that only the
renderer knows which tab is visible is trimmed, with the user's approval; the
translator reason stays. No new dependency.

## Units

1. **Main can raise.** IPC schema, preload, handler, `buildHandlers` signature and
   its test call sites, `raise` export, settings field, AUMID. Done when the
   handler compiles against the schema and an old settings file parses as
   `notifications: true`.
2. **The renderer asks.** `notify.ts` narrowed, `App.tsx` rewired, the checkbox,
   i18n. Depends on 1. Done when `notify.test.ts` covers: an approval yields one
   notice, a question yields one, a finished turn and an error yield none, two
   requests in one push yield two.

Sequential — 2 calls what 1 defines.

## Acceptance criteria

1. An approval or question raises one notification — Chorus focused or not,
   conversation on screen or not. macOS and Windows, packaged.
2. Title `{agent} needs a decision`; body the conversation title, empty if the
   conversation is not in the session list.
3. No sound on either platform.
4. A click brings forward the window holding the conversation — its detached
   window if it has one, the main window otherwise — restored if minimised.
   Nothing else.
5. Answering in-app leaves the notification where it is.
6. Two requests — one room or two, one push or two — raise two notifications.
7. Switch off: nothing raised. Switch on again: the next request raises, no
   restart.
8. A settings file written before this reads as on, and keeps every other value.
9. Finished turns, errors, Chorus dialogs, workbench prompts: nothing.
10. Launch, attach, reopening a past conversation: nothing.
11. Unchanged: the dock badge, unread counts and watermarks, detached windows,
    `security.ts`.

## Verification

Nothing is run until the user asks. When they do: `pnpm check`, then a packaged
run on macOS (first-run authorisation prompt; ad-hoc signed, not notarised) and
an NSIS install on Windows. Criteria 1, 3, 4 and 6 are only provable there. On
Windows the activator registers when the first notification is built, so test
the first notification of a fresh launch, not the fifth.

## What this deliberately does not do

- Widen `security.ts`.
- Withdraw, replace, pin on screen, or add buttons to a notification.
- Notify on finished turns or errors.
- Offer per-project switches or a sound option.
- Make the dock badge work on Windows (`setBadgeCount` is macOS/Linux).
- Raise from a detached window.

## Answered

- Ever seen a Chorus notification? **No** — the source chain holds.
- The unread dot staying lit after a click? **Optional.** Read as "either is
  fine", so the click stays a pure focus.
- Trim the stale sentence in `notify.ts`'s header? **Yes.**

## Open questions

- Does an ad-hoc-signed, un-notarised bundle get `UNUserNotificationCenter`
  authorisation on macOS? Only a run answers it.
- Does a click activate Chorus on macOS when it is in the background? `raise`
  does `restore`/`show`/`focus`, and macOS normally activates the app on a
  notification click before the callback runs. If criterion 4 fails on a real
  machine, this is where: the fix is `app.focus({ steal: true })` on darwin.

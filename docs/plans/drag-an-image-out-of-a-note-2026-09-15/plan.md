# Drag an image out of a note

## The problem

Two ways of giving a conversation an image already work. Dropping a file from
Finder onto a pane attaches it, and so does pasting an image into the composer.
Both end in the same place: a path, shown as a chip, that the agent reads the way
you would. A pasted image has no path of its own, so `stash.ts` writes its bytes
into `userData/pasted` first.

Dragging an image out of a note and onto a conversation does nothing, and the
reason is that a note image is never a file in the renderer. It is a TipTap image
node whose `src` is `chorus-note://image/<hash>.<ext>`. The pane at
`Session.tsx:1970` takes a drag only when its `types` include `Files`, and no
drag out of a note ever does:

- **Dragged by the image itself**, ProseMirror puts `text/html` and `text/plain`
  on the drag.
- **Dragged by the grip**, the drag handle calls `clearData()` and carries nothing
  at all.

## What was asked for, and settled before any code

- **From a note.** Every note is one `NoteEditor`, so this covers the global
  note, a project's note and a kept note in one change.
- **The same result as a paste.** The image becomes a stashed path and a chip,
  and it is still there after a restart for the same reason a pasted one is.
- **Onto the conversation pane** — the transcript and the composer. Not the tab
  strip. The first answer was the whole conversation, tab strip included; once
  the cost below was on the table the answer became the pane.
- **A selection holding text and an image attaches the image only.** The text is
  left behind.
- **Nothing is said when it fails**, as nothing is said when an image paste into
  a note fails.
- **Apps like Preview are wanted, and parked.** See _Deliberately not doing_.

The shape below was argued between claude and deepseek against the source, and
the details that came out of that review are recorded where they apply.

## The shape of the answer

### The note says what it is carrying, because nothing else will

A drag type only this app knows — `application/x-chorus-note-image` — whose value
is a JSON array of the image URLs. It is defined once, in `attach.ts` beside
`withPaths`, and imported by both the note and the pane.

**A type of our own is the only signal the pane can use.** `dragover` may read a
drag's types but not its data, so whatever decides "this is a note image" has to
be visible in `types`. Accepting any `text/html` instead would claim text dragged
out of the transcript, and the pane would then swallow a drop the composer's
textarea should have taken.

### Published after the grip has cleared the drag

The type is set from a `dragstart` listener on the document, in the bubble phase,
in `NoteEditor.tsx`. Neither earlier place survives:

- **`onElementDragStart` is too early.** The handle calls it before
  `dragHandler`, and `dragHandler` calls `clearData()`
  (`@tiptap/extension-drag-handle` 3.31.3, `dist/index.js:730` and `:549`).
  Anything set there is wiped.
- **The existing grip listener is capture phase** (`NoteEditor.tsx:704`), so it
  also runs before the handle does.

**Guarded by where the drag started: inside `view.dom`, or on this note's own
grip (`.${mine}`).** Corrected 2026-09-15 while writing it — the plan first said
`host.current?.contains(event.target)`. ProseMirror assigns a fresh
`view.dragging` on every `dragstart` inside `view.dom` (`prosemirror-view`
1.42.3, lines 3802–3831), and the grip assigns one on every grip drag, but nothing
clears what the grip set when that drag ends outside the note. A guard as wide as
the note box would let any other native drag inside it — the zoom overlay, the
selection offer — read the last grip drag's slice. Only the two routes that have
just assigned it may read it, and a guard per note still means only the note that
started the drag answers.

**`window.Node`, not `Node`, and that is new in this tree.** `NoteEditor.tsx`
imports `Node` from `@tiptap/core`, so a bare `instanceof Node` tests a DOM target
against TipTap's schema class, is always false, and publishes nothing. No other
file qualifies a DOM global with `window.`; this one has to. The first check is
`Node` rather than `Element` because a selection drag's target may be a text node
— ProseMirror's own handler checks `nodeType == 1` before assuming an element.

**The images come from `view.dragging.slice`, and only from `.slice`.**
ProseMirror assigns a `Dragging` instance (`prosemirror-view` 1.42.3, line 3831)
and the grip assigns a plain object (`dist/index.js:561`), so an `instanceof`
check would be true on one route and false on the other. The type is published
only when that slice holds an image node whose `src` starts with
`chorus-note://image/`; dragging plain text out of a note behaves exactly as it
does today.

### The copy happens in main, through the function a paste already uses

**The renderer cannot read the image.** `img-src` admits `chorus-note:`, but
`connect-src 'self'` and a scheme registered without `supportFetchAPI` mean no
fetch, and a canvas read of it is tainted.

So main does it: **`copyNoteImageTo(userDataPath, url): Promise<{ path: string }>`
in `main/note-images.ts`.** It checks the scheme, checks the name against the
module's own `NAME`, reads the file from the note-images folder, and hands the
bytes to `stashFile`. The folder, the name pattern and the extension list stay in
the one file that owns them, and the IPC handler is a single line — which is what
`files:stash` and `app:addNoteImage` beside it already are.

**Copied, not attached in place.** `stash.ts` exists so that a path in a sent
message still resolves tomorrow. `note-images` happens not to be pruned today,
and nothing promises it stays that way. (The argument is not that the renderer
must never learn the folder — it already learns `userData/pasted` from every
paste.)

The stashed file takes the image's hash name, so no original filename travels
with it — the same privacy `saveNoteImage` gives the note.

**Dropping the same image twice gives two chips.** `addPaths` dedupes by path and
every stash is a new path. Pasting the same image twice does the same today.

### The pane takes it beside `Files`, not instead

`onDragOver` in `Session.tsx` accepts the type the way it accepts `Files`:
`preventDefault()`, `dropEffect = 'copy'`, `setFileOver(true)`.

- **`copy` matters.** The grip marks its drag as a move.
- **The ring matters.** Without `data-file-over` a working drop looks like a
  broken one until it lands.

`onDrop` reads the URLs and calls `preventDefault()` on this branch too — the
composer's textarea is inside `.pane`, and an unclaimed drop is one the browser
still acts on. Each URL goes through the new channel with `Promise.allSettled`,
and the paths that came back go to `composer.current?.addPaths`.

**The note keeps its image.** ProseMirror deletes a moved source only from its own
drop handler, which lives on the editor's DOM, and the grip's document-level
`drop` listener returns at once when the target is outside `editor.view.dom`
(`dist/index.js:751`).

### `addPaths` joins the handle

`attach` takes `File`s, and a note image is a URL. `addPaths`
(`Composer.tsx:873`) is already where `attach` ends, so it is exposed on
`ComposerHandle` and added to the `useImperativeHandle` dependency array at
`Composer.tsx:1046`, which reads `[attach]` today.

## Phase 1 — the way through main

`copyNoteImageTo` in `main/note-images.ts`; `files:stashNoteImage` in
`shared/ipc.ts` beside `files:stash`, with `stashNoteImage` on `ChorusApi`; its
one-line handler in `main/ipc.ts`; and `stashNoteImage` in `preload/index.ts`.
Nothing is drawn in this phase.

**Exit criteria.** Given the URL of a stored note image, the channel returns a
path under `userData/pasted` holding the same bytes. A URL on any other scheme, or
a name `note-images.ts` did not generate, is refused.

## Phase 2 — the drag and the drop

The drag type in `attach.ts`, the `dragstart` listener in `NoteEditor.tsx`,
`addPaths` on the handle, and the pane's two handlers in `Session.tsx`. No CSS —
the existing `data-file-over` ring is the highlight. No i18n keys — nothing new is
said.

**Exit criteria**, checked by hand:

- Dragging an image out of the global note, a project's note or a kept note — by
  the image or by its grip — onto a conversation shows the ring and adds a chip.
- The note still holds the image afterwards.
- The sent message shows the picture after a restart, as a pasted one does.
- A selection of text and an image attaches the image and nothing else.
- Text dragged out of a note, or out of the transcript, behaves as it does today.
- A Finder drop and a paste are unchanged.

## Deliberately not doing

- **Preview and other macOS apps.** Parked, not rejected. A thumbnail dragged out
  of Preview is probably a file promise, and a dragged selection probably TIFF or
  PNG data. If Chromium exposes neither as `Files`, no renderer code can reach
  them: Electron's `clipboard` reads the general pasteboard, not the drag
  pasteboard, and a native module is refused in this repo. **The next step is one
  drag, not code** — a Preview thumbnail held over a pane, and whether the ring
  appears. Unverified either way until that is done.
- **The tab strip.** It is already a pointer-event drop zone for reordering tabs,
  with its own `data-drop` feedback, and `ConversationColumn` renders sessions
  through `renderSession` with no composer handle in reach — accepting a drop
  there needs a conversation-to-handle registry threaded from `App`.
- **Deduping a repeated drop.** A paste does not dedupe either.
- **A message on failure.** A copy that fails is an image already broken in the
  note it came from.
- **Dragging out of the workbench editor.** Not asked for, and it is a native view.

## Open questions and risks

- ~~**A stale `view.dragging`.**~~ **Closed 2026-09-15** by narrowing the guard
  to `view.dom` and the note's own grip — see _Published after the grip has
  cleared the drag_.
- **Whether a selection drag's `dragstart` targets a text node in Chromium.**
  Unverified. Checking `window.Node` first makes the guard correct either way.
- **Whether `copyNoteImageTo` gets a test.** It is the one piece with a security
  edge — a name that is not ours must be refused — but `note-images.ts` imports
  `electron` at the top, so a test needs that mocked.
- **Nothing in this plan has been run.** Every exit criterion above is for the
  person driving the app.

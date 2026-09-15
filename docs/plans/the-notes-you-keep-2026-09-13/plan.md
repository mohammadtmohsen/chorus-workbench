# The notes you keep

## The problem

There are two notes and both of them are _about_ something. The global note is
the one that belongs to no project; a project's note belongs to that project.
Neither is a place to keep several separate notes, because each is a single
document with a single first line.

So everything that is not about a project goes into one global note: a command
you will want again, a snippet pasted out of a terminal, a list you are working
through, a paragraph about a bug. They are separate things and they end up in one
column, in the order they were written, which is how a scratchpad becomes a heap.
The box shipped earlier today makes that heap navigable. It does not make it
several documents.

What is missing is a collection — many notes, each its own document, reachable
without leaving what you are doing.

## What was asked for, and settled before any code

- **A note icon in the masthead**, beside the version.
- **Click it and a menu lists the notes**, one row each.
- **A row is labelled by the note's own first line.** No second field, nothing to
  name and nothing to keep in step.
- **Hovering a row opens that note beside the list**, as a real editor rather than
  a preview of text. **Clicking the row pins it** so it can be typed in; Escape or
  a click outside closes it.
- **A "New note" row adds one**, and a row carries a delete control on hover.
- **The panel is a fixed size.** A long note scrolls rather than growing.
- **Separate from both existing notes.** Its own storage, no sync, no overlap.

## The shape of the answer

### Reusing `NoteEditor` is the design, not an optimisation

`NoteEditor`'s own header already says what it is: the note wherever a note is,
with the caller owning the box, the position, the width and the shortcut. There
are two callers today and this is the third. Everything the note can do — the
bar, images, the selection offer, the drag grip, the box — arrives with it and
none of it is written again.

That is worth stating as a rule rather than a convenience, because the cost of
breaking it is already recorded in that file: two copies of this would be two
places to fix the focus trap, and the second copy is the one that does not get
fixed.

### Its own table, and migration 10

`app_note` is one row at `id = 1`, which is the right shape for one note and the
wrong shape for many. The collection gets `kept_note`: an id, the document, and
the stamps to order by. Migration 9 is the latest, so this is 10.

A JSON blob in settings would be the quick version and it is wrong twice — the
whole blob is rewritten on every debounce of every note, and there is no way to
address one note to update or delete it.

**Nothing here goes in the event log.** The rule in `CLAUDE.md` is that the log
records the conversation; a note is a current fact that gets corrected and
eventually deleted, which is exactly the argument `app-note.ts` already makes for
living in the registry beside the log rather than in it.

### The title is derived, and deriving it is the one new pure function

A row's label is the note's first line, and the stored value is TipTap JSON — or,
for a note written by an older build, a plain string. The menu has to produce that
line **without mounting an editor**, so a small pure function walks the stored
value and answers with its first non-empty text, tolerating the plain-string case
the same way `asDocument` does.

Pure and exported, so it is tested as a function rather than through a component,
which is the renderer convention here.

### Preview and pinned are two pieces of state, and that is the whole interaction

Hovering sets a preview id. Clicking sets a pinned id. The panel shows the pinned
note if there is one and the previewed note otherwise.

**Once a note is pinned, hovering another row does not swap it.** If it did, the
pointer resting anywhere near the list would replace the note being typed in,
which makes the pinned state worthless. Clicking another row re-pins; Escape or a
click outside clears both.

### It draws over a native view, so it needs the overlay

The menu and the panel cover a project's workbench, which is a `WebContentsView`
main composites above the DOM. Anything the renderer draws there is painted
underneath and simply disappears. `useShellOverlay` while the menu is open, the
same as the global note does when it grows.

### The masthead is the window's drag region

`.masthead` is what `titleBarStyle: hiddenInset` drags the window by. A button
placed in it inherits that, so it needs `-webkit-app-region: no-drag` or the
click becomes a window drag and the menu never opens. This is the kind of thing
that reads as "the button does nothing".

## Phase 1 — the store and the way to it

`kept_note` in migration 10, a `KeptNoteStore` with list, create, update and
delete, the IPC channels beside `app:setNote`, the preload entries, and the
runtime wiring. Nothing is drawn in this phase.

**Exit criteria.** A note can be created, listed, updated and deleted through the
API the renderer will use, and the rows survive a restart.

## Phase 2 — the icon and the list

The button in the masthead with its `no-drag`, the menu, the rows labelled by
first line, the "New note" row, the delete control, and the overlay while it is
open. **The CSS for all of it ships in this phase.**

That last point is deliberate. The box plan put its stylesheet in a final phase
and the result was two phases whose work could not be judged by looking at it.
A phase that draws something ships the way it looks.

**Exit criteria.** The icon opens a list, a new note appears in it, a note can be
deleted, the list survives a reload, and the menu is visible over a project's
editor rather than behind it.

## Phase 3 — the note beside the list

The `NoteEditor` in a fixed panel to the left of the menu, preview against
pinned, the save debounce, Escape and click-outside, and this phase's CSS.

**Exit criteria.** Hovering rows moves the note under the pointer; clicking one
holds it still; typing saves; every control on the bar works, including inserting
a box; and leaving closes it without losing the last sentence typed.

## Phase 4 — the order becomes yours

**Added 2026-09-14, and it reverses a decision above rather than extending one.**
The list was ordered by what was touched last, which is a guess about what you
want to see. Dragging a row says it outright.

**A position per note, which means the schema changes.** `kept_note` gains a
`position` column in migration 11, and existing rows are backfilled by their rank
in the order they are being displayed in today — so nothing appears to move on
the first launch after the change. `list()` orders by it, `create()` puts a new
note at the top, and one `reorder` writes a whole sequence in a single
transaction rather than one row at a time.

**`updated_at` stops deciding anything on screen.** It stays in the table, since
it is what the backfill needs and it is not recoverable once dropped, but the
list no longer reads it. That retires a piece of care taken in Phases 2 and 3:
the order had to be frozen while the menu was open, because typing re-sorted it
and moved the row out from under the pointer. An arranged order cannot do that,
so the freeze goes with the reason for it.

**Insert, never swap.** Dropping a row between two rows puts it there; it does
not exchange it with whatever it landed on. That is the same correction the
project rail already made for dragging a project, and it is the behaviour people
expect from every list they have dragged before.

**Exit criteria.** A row can be dragged above or below any other and stays where
it was put; the order survives a reload; a new note appears at the top; and
hovering during a drag does not open a note under the pointer.

## Deliberately not doing

- **No titles of their own, no renaming.** Answered directly.
- **No folders, no tags, no search.** A collection this size is read by looking.
- ~~**No drag to reorder.** The order is computed, not arranged.~~ **Reversed
  2026-09-14 — see Phase 4.** The order is now arranged and the computed one is
  gone.
- **No resizing.** Answered directly; the other two notes are resizable and this
  one is not, which is a difference worth seeing before it is smoothed over.
- **No shortcut to open the menu.** The other two notes have chords because they
  are single and always present. This is a collection reached by a click.
- **No sync of any kind with the global or a project's note.** Separate stores,
  separate lives.

## Open questions and risks

- **What orders the list.** Most recently updated is the useful order — the list
  is a way back to what you were just in — but a list that reorders while you are
  in it moves the row under the pointer. The answer is probably "sorted when the
  menu opens and stable while it stays open", and it needs saying out loud
  because it is the kind of thing that gets written the obvious way and then
  feels broken.
- **Whether deleting asks.** There is no undo for a note. Deleting an empty one
  silently is fine; deleting one with text in it silently is a way to lose work.
  A confirm on a non-empty note is the cheap answer.
- **The empty state.** What the panel shows before any note exists — nothing, or
  a line saying so.
- **Where the selection offer sends from here.** The same answer as the global
  note: the focused conversation, through `useFocusedConversationId`. Recorded
  rather than asked, because any other answer would need a conversation picker
  that nobody asked for.

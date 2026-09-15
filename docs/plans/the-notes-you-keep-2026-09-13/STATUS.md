# Status — the notes you keep

## Phase 1 — the store and the way to it

**Written 2026-09-13. Not verified — nothing was run.**

Migration 10 creates `kept_note`, `KeptNoteStore` sits beside `AppNoteStore` in
the event store, and four channels carry it to the renderer:
`app:listKeptNotes`, `app:createKeptNote`, `app:setKeptNote`,
`app:removeKeptNote`. Nothing is drawn.

**Both stamps are recorded, which settles the open ordering question without
answering it.** The plan flagged that what orders the list changes what the store
has to keep; made and last-touched are not recoverable from each other after the
fact, so both columns exist and Phase 2 can choose. `list()` returns
last-touched first as the useful default, with the id breaking ties so the order
is total — two notes made in the same millisecond and never edited would
otherwise come back in whatever order SQLite felt like, which is a list that
shuffles between reads.

**No title column, and none on the IPC surface either.** A row is labelled by its
note's own first line, so a title would be a second copy of something already in
the document. The function that derives it belongs to Phase 2.

**No size column, unlike `app_note`.** That panel drags on two edges and has to
reopen where it was left. This one is fixed, so a column for a size nothing can
change would only ever hold its default.

**`create` answers with an id rather than the row.** The caller re-reads the list,
because where a new note sits is the store's decision and a caller that spliced
the row in would be guessing at an order it does not own. One extra call, on a
deliberate action.

**`setKeptNote` answers `{ saved: false }` rather than failing when the note is
gone.** The editor saves on a debounce, so a write can land after its note was
deleted — the same shape as the project note's debounce outliving its component.
The delete is the later intention and wins.

The store takes `now` as an argument and the runtime supplies `Date.now()`, so
the store can be tested without pretending about time.

## Phases 2 and 3 — the icon, the list, and the note beside it

**Written 2026-09-13. Not verified — nothing was run and nothing was looked at.**

Shipped together because they are one component: `KeptNotes.tsx` holds the
masthead button, the portalled card, the list and the panel, and splitting the
panel out would have been a second file rendering half of one surface. Its CSS
ships with it, which is the lesson the box plan left behind.

`firstLine` is its own module and pure, because the menu has to label a dozen
rows without mounting a dozen editors. It accepts both stored shapes — a
document or the plain string an older build wrote — and skips a first block with
no text in it, so a note beginning with an image is named by its first words
rather than by nothing.

### The three open questions, answered

**Order.** Last touched first, from the store, and **never re-sorted while the
menu is open**. Typing updates the row's label from local state rather than
re-reading the list — a re-read would re-sort by `updated_at` and move the row
out from under the pointer of the person typing in it. Creating or deleting
re-reads, because those are deliberate acts.

**Deleting.** Two presses for a note with text in it, one for an empty one, and
no dialog. There is no undo anywhere in this feature, so a silent delete loses
work — but a confirmation dialog here would be an overlay over an overlay, which
is the trade `NoteEditor` already refuses for its link control. The control
changes colour after the first press, or the second press is the same press and
nothing tells you anything happened.

**The empty state.** A muted "No notes yet" line above the New note row.

### Two things the plan did not say

**Typing pins.** The panel opens on hover and is held by a click, and `NoteEditor`
reporting focus is treated as that click. Without it, clicking into a previewed
note and then letting the pointer wander off the card would close the note
mid-sentence.

**The card is anchored by its right edge.** The list sits under the button and
the panel opens to its left, so anchoring by the left would slide the list
sideways every time a panel appeared — the list moving under the pointer that is
about to click it.

### The trap that was paid for in advance

`.masthead` carries `-webkit-app-region: drag`, so the button carries `no-drag`.
Without it the click moves the window and the menu never opens, which reads as a
wiring fault rather than a stylesheet one.

## Fix — the list jumped, and the panel moved to the right

**Seen in the running app, 2026-09-13: the list was pinned to the right-hand edge
of the window with the note filling everything to its left.**

The card was placed by aligning its **right** edge to the button, so that a panel
opening on the left would push the card leftwards and leave the list where it
was. That arithmetic is correct for a button on the right of the window, and this
button is beside the version on the left. With a note open the card is around
706px wide, its left edge landed off the window, the clamp pinned it at the
margin, and the list was carried to the far side.

Three changes, and the first is the one that matters:

- **The list is placed from the button and its own measured width, and from
  nothing else.** `shownId` is deliberately absent from the placement effect's
  dependencies — that absence is the guarantee that opening a note cannot move
  the list, rather than an oversight.
- **The panel opens to the right**, and it is after the list in the DOM as well
  as on screen. Reversing the row in CSS would have saved moving the block and
  cost the tab order: the menu is what the button opened, so it is what a
  keyboard reaches first.
- **The panel takes the room the list leaves**, between 280 and 460. A fixed 460
  beside a list that will not move is a panel hanging off a narrow window, and
  pulling the list back to prevent that is the original bug again.

The gap between the two moved from the stylesheet into the script, because the
placement arithmetic subtracts it and two declarations of one number is one that
drifts.

## Change — it now wears the note's own colour

**Asked for after seeing it: the list, the panel and the icon all read as a
generic popover rather than as a note.**

The list and the panel take the treatment copied from
`.project-notes[data-focused='true'] .note-body` rather than approximated: the
rose on the left edge as an inset shadow, the light falling away behind it over
`--note-glow`, on `--bg-control`, with the app's own floating-surface shadow. The
border went with it, for the reason the original comment gives — an inset mark
costs no layout where a border widens the box.

The icon carries `--note-tint` at rest instead of a chrome grey. It is the only
thing on the masthead that is not the app talking about itself.

**The radius is the one thing deliberately not shared.** `--note-radius` rounds a
single corner because both other notes are flush to the window's edge and cannot
be round where they meet it. This one floats clear of everything, so it is round
on all four.

The pinned row lost its own left bar and keeps a fill. Once the list carried the
note's edge mark, two rose rules a few pixels apart on the same edge read as a
misalignment rather than as two states.

## Change — the panel resizes, and one size serves every note

**Asked for after seeing it, and it reverses the answer given when the plan was
written.** The panel was chosen fixed; it is now draggable on both edges, with a
single size shared by every note in the list rather than one remembered per note.

**`useNoteSize` had to learn a left anchor.** Its arithmetic says a width is the
distance back from a right edge that does not move, which is true of both other
notes and false of this one — this panel is pinned by its left, because it opens
to the right of a list that must not move. Dragging its handle would have widened
it away from the pointer. The option defaults to `right`, so adding it cannot
change either note that already works, and the stylesheet mirrors the handles to
the opposite edge. Either half alone would have been wrong.

**The hook's own state is what shares the size.** This component is mounted for
as long as the window is, so the size survives closing the menu and switching
rows with nothing stored anywhere.

**It is not written down, so it resets when the app does.** Persisting it means a
settings field and its schema, which is a separate change and was not asked for.
Stated here rather than left to be discovered.

**The width did not move on the first attempt, and the height did.** The panel's
rule said `width: 460px` where it needed `var(--note-w, 460px)`: the drag was
writing the custom property and nothing was reading it, while the editor's own
rule already read `--note-h`. Worth recording because the failure is silent by
construction — a custom property nobody consumes is not an error anywhere, and
the handle moves, so it looks like the gesture is broken rather than the
declaration. Three things now decide that width, in order: the inline width from
the room the list leaves, then `--note-w` once a handle has been dragged, then
the number in the stylesheet.

Two smaller consequences. The panel's fixed height went: what a drag sets is the
_editor's_ height — that is what `--note-h` means everywhere in this file — and
the panel is that plus the bar and its padding, so fixing both would leave them
disagreeing. And touching the panel now pins the note, because a resize begun on
a merely previewed note would otherwise take the pointer off the card and close
the note under the handle being held.

## Phase 4 — the order became yours

**Written 2026-09-14. Not verified — nothing was run.**

Migration 11 adds `position` to `kept_note` and **backfills it by the rank the
list is already drawn in**, so the first launch after the change shows exactly
what the last one showed. A `DEFAULT 0` would have been one line and would have
reordered every existing note once, silently. The backfill repeats `list()`'s old
tie-break — equal stamps, lower id first — because otherwise the two disagree for
exactly the rows a millisecond apart.

`list()` orders by position, `create()` puts a new note above everything with one
less than the smallest, and `reorder` rewrites a whole sequence from zero in a
single transaction. **The sequence rather than one row's new index**, because a
move changes where everything after it sits, and sending one would leave the
renderer and the store each doing half the arithmetic and agreeing about the half
they cannot see.

**`updated_at` now decides nothing on screen.** It stays in the table — the
backfill needs it and a stamp is not recoverable once dropped — but the list no
longer reads it. That retires a piece of care from Phases 2 and 3: the order had
to be frozen while the menu was open, because typing re-sorted it and moved the
row out from under the pointer. An arranged order cannot do that.

`reordered` is pure and lives beside `firstLine`. It **removes the dragged id
before locating the target**, which is the whole of why dropping onto a
neighbour works: with it still in the array the index of the row below is one too
high, and the note lands back where it started — a drag that appears to do
nothing.

The drop indicator is a line on the edge it would land against, not a gap that
opens. A list that reflows under the pointer moves every row below the one being
aimed at, so the drop lands one row out from where it was aimed.

## Not verified

**`pnpm check` passed on 2026-09-14**, after `@chorus/event-store` was built —
typecheck across all 18 tasks, eslint, prettier and 2544 tests. The wiring this
was most wanted for holds up: five zod schemas, five handler signatures, five
preload entries and a new component all agree, and nothing but typecheck was ever
going to say so.

**Two gaps it does not close.** `firstLine` and `reordered` are pure and exported
for tests and have none — the convention in this renderer is that the judgement
lives in the pure function and the test lives beside it. And Phase 4's drag has
not been driven in the app at all; Phases 2 and 3 have.

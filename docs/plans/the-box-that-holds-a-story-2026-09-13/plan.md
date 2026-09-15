# The box that holds a story

## The problem

A note is one column of blocks with nothing between them but air and the
occasional `---`. That is enough while a note holds one thing. It stops being
enough the moment it holds three, which is what every note in this app actually
becomes: a command somebody will need again, a paragraph about a bug, a snippet
pasted out of a terminal, all stacked in the order they were written rather than
by what they are about.

The divider was the answer to that and it is only half of one. It separates two
runs of blocks visually, and the document knows nothing about the grouping —
which means the run cannot be moved as a unit, cannot be told apart from its
neighbours by anything but the eye, and cannot be dragged out of the way while
somebody works on what is underneath it. A `<hr>` is a mark on the page, not a
container.

What is wanted is a container: a coloured box that holds an arbitrary run of
blocks, moves as one thing, and lets its contents be rearranged inside it.

## What was asked for, and settled before any code

Four questions were asked and answered before this file was written. They are
recorded here because each one closes a branch that would otherwise be guessed:

- **The unit is the selection.** There is no fixed notion of a "story" in the
  document — no rule about paragraphs, no rule about runs between dividers. You
  select blocks, and what you selected is what gets wrapped.
- **One button, two paths.** With a selection, the button wraps it. With no
  selection, the button inserts an empty box you then drag things into.
- **Nesting is in scope.** Blocks reorder inside a box, move from one box to
  another, move back out to the top level, and a box can be dropped inside
  another box.
- **One fixed colour.** Not a picker, not one colour per box, not a rotating
  palette. Every box in the app looks the same.
- **Both modes, and both complete.** A note with no box in it behaves exactly as
  it does today — that is the requirement, not a side effect. And everything the
  bar can do to a block at the top level it must do to a block inside a box:
  marks, both lists, quote, code, code block, images, the `---` divider, the text
  colour, the selection offer and the grip. The box adds a container. It takes
  nothing away and restricts nothing inside itself.

And one thing not asked but decided by the code: **both notes**, because the
global note and a project's note are one `NoteEditor` and differ only in where
they sit. A change asked for in one is meant for both.

## The shape of the answer

### A node, and everything that follows from that

The box is a ProseMirror node — `noteBox`, `group: 'block'`,
`content: 'block+'` — and almost all of the work above is a consequence of that
sentence rather than a thing to build.

**Nesting is free.** A node in `group: 'block'` whose content is `block+` can
hold another of itself, because it satisfies its own content expression. There
is nothing to write for "a box inside a box"; there would be something to write
to _prevent_ it.

**Wrapping and unwrapping are free.** `wrapIn('noteBox')` and `lift` are TipTap
core commands over a node of this shape. The selection-based wrap the user asked
for is the default behaviour of `wrapIn`, not an implementation of it.

**Persistence is free.** The note is already saved as `JSON.stringify(getJSON())`
on a debounce, and the box is part of that document. Nothing in `asDocument`
changes, no migration is written, and no schema outside the editor learns a new
shape. `packages/event-store/src/app-note.ts` stores a string and continues to.

**The box is not a mark and must not be one.** A mark spans text inside a block;
this has to span whole blocks and contain them. `Color` is the nearby example of
a mark and it is the wrong model here — colouring the text inside three
paragraphs does not make those paragraphs one thing.

### Dragging inside it, without breaking the exclusion already there

`NoteEditor.tsx` mounts `DragHandle` with top-level blocks only, and the comment
above it argues that on purpose: `nested` would also grip list items and the
lines inside a blockquote, and dragging one bullet out of its list is a different
gesture that deserves to be added deliberately.

That argument survives this change and does not have to be reversed for it. What
had to be rewritten is _how_.

**Corrected during Phase 2, 2026-09-13.** This section first said
`nested={{ allowedContainers: ['noteBox'] }}`, on the strength of that option's
own documentation: "nested dragging only activates when the cursor is inside one
of the specified node types". The dist says otherwise. `findBestDragTarget`
builds its candidates from depth `$pos.depth` down to **1**, and drops any
candidate whose `depth > 0` has no named ancestor — and a top-level paragraph is
depth 1. So naming `noteBox` there takes the grip off every block that is not in
a box. There is no fallback either: once `nested.enabled` is true,
`findElementNextToCoords` returns early and the whole top-level path below it is
unreachable, so the handle just hides.

What is used instead is one rule, with the built-in set off:

```
nested={{
  defaultRules: false,
  rules: [{ id: 'topLevelOrInsideBox', evaluate: ({ node, parent }) => … }],
  edgeDetection: { threshold: 10, strength: 200 },
}}
```

A block is a target when its parent is the document or a box, and is excluded
otherwise — a deduction of 1000 against a base score of 1000. A list item's
parent is a list and a quoted line's parent is the quote, so both stay exactly as
they are today, which is the point. The defaults are off because they do the
opposite of what is wanted here: `listWrapperDeprioritize` exists to make list
items the target inside a list.

`strength` is below its default of 500 because the edge deduction is
`strength × depth`, and at 500 a block two levels down scores exactly zero near
an edge — which is excluded, not outranked. Inside a nested box that is a grip
that disappears. At 200 nothing is excluded by proximity and the ordering is
still parent-first.

All of this was read out of the installed package, first the `.d.ts` and then the
dist when the `.d.ts` proved to describe the intent rather than the behaviour.

### The colour, and why it is a token here when it is a literal elsewhere

`NOTE_COLOURS` stores concrete hex values and the comment says why: those values
are written _into the document_, so a `var()` would make an old note change
colour when a token is retuned and break outright when one is renamed.

The box is the opposite case and gets the opposite answer. Its colour is not
stored in the document — the node has no colour attribute at all, which is what
"one fixed colour" means. The colour belongs to the app's theme, so it is drawn
from a token in `styles.css` and follows the theme the way every other surface
does. Nothing in a saved note refers to it.

## Phase 1 — the node, and the button that makes one

The node lives in `NoteEditor.tsx`, beside `NoteDivider`. That file is already
1136 lines and the instinct is to split, but the note's schema is what is at
stake: `NoteDivider` is there, and putting the second extension in a sibling file
would mean the answer to "what can this document contain" is in two places. A
25-line `Node.create` is not the thing that makes that file long.

`parseHTML`/`renderHTML` map to a `<div>` carrying the class the stylesheet
targets. The class is written by the node rather than by the stylesheet
descending into ProseMirror's markup, so a box copied out of the note as HTML
still says what it is.

The bar gets one more control, `box`, placed after `codeBlock`. That is the end
of the block group — quote, code, code block — which is where a container
belongs, and it is the one position that moves nobody's `divided` flag and so
leaves the existing five groups on the bar exactly as they are.

**It toggles, like everything else on that bar.** Pressed when the caret is in a
box, and pressing it then lifts the contents back out. A control that only ever
adds is a control whose only undo is ⌘Z, and every other button in that row
answers for its own state through `aria-pressed`.

So the handler is three cases, in this order: inside a box → `lift`; a selection
→ `wrapIn`; an empty selection → insert a `noteBox` holding one empty paragraph
and put the caret in it. Each keeps `focus(null, STAY)` at the head of the chain,
for the reason the rest of the bar does — the toolbar cancels `mousedown` so the
caret never leaves, and the chain has to act on the editor rather than on
nothing.

`app.noteTool.box` is added to `en.json`, and a glyph to `NOTE_TOOL_GLYPHS`.

**Exit criteria.** Selecting two paragraphs and pressing the button puts both
inside one box; pressing it again takes them out; pressing it with the caret
resting in an empty paragraph leaves an empty box with the caret inside; the note
survives a reload with the box intact; and a box can be built inside a box.

## Phase 2 — dragging, in and out and between

One prop on `DragHandle`, in the corrected form above — a rule rather than
`allowedContainers`. What has to be checked rather than written:

- **The grip's gutter.** Both notes pad their left edge by `--note-grip` so the
  handle has somewhere to sit that is not the first characters of a line. A block
  _inside_ a box is inset by the box's own padding, so the handle for it lands
  over the box's left border unless the box's padding leaves room. That is a CSS
  number, and it is the one part of this phase likely to look wrong first.
- **`grabbing` and `mine` are unchanged.** The class that makes one note's grip
  distinguishable from another's is per-editor, not per-block, and the
  focus-holding logic around a drag does not know or care how deep the dragged
  block was.
- **An emptied box stays.** `content: 'block+'` means dragging the last child out
  cannot leave the node contentless; ProseMirror keeps an empty paragraph. That is
  the right behaviour — the box you made is still there to drop something else
  into — and it is worth stating because it looks like a bug the first time.

**Exit criteria.** A paragraph can be dragged from inside a box to above it, from
one box into another, and from the top level into a box; the box itself drags as
a whole with its contents; and hovering a list item or a line in a blockquote
still shows no grip.

## Phase 3 — what it looks like

One block of rules in `styles.css`, next to the blockquote and `pre` rules it is
a sibling of. Rounded corners, a 1px border in the accent at low alpha, a faint
wash over the ground, padding on all four sides, and vertical margin matching
`pre`'s so a box in a run of blocks sits the way a code block does.

Two details that are not decoration:

- **A nested box must not take a second wash.** This is exactly the `pre code`
  trap already recorded in that file — a background inside a background reads as
  a rendering fault rather than as depth. The inner box keeps the border and
  drops the fill.
- **The box joins the selected-node outline rule.** A box dragged or selected
  whole is currently indistinguishable from one that is not, and Backspace then
  deletes something invisible — the same reason `img` and `hr` are in that rule
  today.

**Exit criteria.** A box is obviously a box in both colour schemes, a box inside a
box reads as nested rather than as a mistake, and a selected box says so.

## Deliberately not doing

- **No per-box colour and no picker.** Answered directly; the existing palette
  control stays what it is, a text colour.
- **No collapse or expand.** A box that can be folded is a second interaction
  with its own state to store, and nothing asked for it.
- **No title or header row on the box.** Same reason: it is a new attribute, a
  new input, and a new thing to translate.
- **No keyboard shortcut.** Every control on that bar is a click today.
- **No list-item or blockquote dragging.** `allowedContainers` is what keeps that
  true, and keeping it true is the point of using it.
- **No migration and no change to `app-note.ts`.** Old notes contain no box and
  are unaffected.

## Open questions and risks

- **Rolling back to a build without the node is out of scope — decided
  2026-09-13.** The case that matters is the other direction, and it already
  works: an older note holds no box and reads exactly as it always did, which is
  what `asDocument` guarantees by converting a plain string and passing a
  document through untouched. A _newer_ note opened by an _older_ build is not a
  case this work defends. No guard is widened, no migration is written, and the
  `JSON.parse` guard in `asDocument` stays as it is.
- **The resting line.** A note collapsed to one line shows its first line. If the
  first block is a box, what shows is the top of the box — border, padding and
  all — cropped to one line's height. That may read fine or may read broken;
  it needs looking at, not reasoning about.
- **`getText()` and the measurement span.** The hidden `.note-measure` span is
  what "fit to content" measures against. A box's text is included in
  `getText()`, so the width it measures ignores the box's padding and borders —
  a note sized to fit will be a few pixels narrow for a boxed line. Small, and
  worth knowing before someone calls it a bug.
- **"Chat note" was the phrase used.** This plan reads that as the project note —
  `ProjectNotes`, docked above a project's conversations. There is no
  per-conversation note in this build. If a third note was meant, that is a
  different piece of work and this one does not contain it.

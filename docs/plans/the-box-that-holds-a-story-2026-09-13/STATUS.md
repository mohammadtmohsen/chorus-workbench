# Status — the box that holds a story

## Phase 1 — the node, and the button that makes one

**Written 2026-09-13. Not verified — nothing was run.**

`noteBox` is declared in `NoteEditor.tsx` beside `NoteDivider`, registered in the
editor's extensions, exposed on the bar as `box` after the code block, and
translated as `app.noteTool.box`. It shipped as planned, with one thing the plan
did not settle.

**The empty-selection case turned out to be three cases, not one.** The plan said
"insert an empty box"; the code had to decide _where_. Inserting at the caret
splits the textblock the caret is in, so a button press in the middle of a
sentence would cut it in half. `addBox` inserts after the enclosing **top-level**
block instead — depth 1 rather than the caret's own depth, so a box made from
inside a list lands after the list rather than inside it — and wraps in place when
the block is empty, because inserting after an empty paragraph would leave a blank
line above the box it was about to become.

## Phase 2 — dragging, in and out and between

**Written 2026-09-13. Not verified — nothing was run.**

**The plan was wrong about the mechanism and has been corrected in place.** It
called for `nested={{ allowedContainers: ['noteBox'] }}`, which the option's own
documentation supports and the extension's dist contradicts: candidates are built
from depth `$pos.depth` down to 1, every candidate at `depth > 0` without a named
ancestor is dropped, and a top-level paragraph is depth 1. That prop would have
taken the grip off every block outside a box — and with `nested.enabled` true
there is no fallback, because `findElementNextToCoords` returns before the
top-level path it used to take.

What shipped is one rule with `defaultRules: false`: a block is a drag target when
its parent is the document or a box, excluded otherwise. The built-in rules are
off because `listWrapperDeprioritize` makes list items the target inside a list,
which is the behaviour the note has always refused. `edgeDetection.strength` is
200 rather than the default 500, because the deduction is `strength × depth` and
at 500 a block two levels down scores exactly zero near an edge — excluded rather
than outranked, so a grip inside a nested box would vanish instead of losing.

**This is the second time in this repo that a payload was believed from prose and
turned out to differ.** The `.d.ts` described the intent; the dist described the
behaviour. The adapters' rule — read the shape, never the description — applies to
a dependency's options as much as to an SDK's events.

## Phase 3 — what it looks like

**Written 2026-09-13. Not verified — nothing was run, and nothing was looked at.**

One block of rules in `styles.css`, sitting between the `hr` rule and the
selected-node rule, which the box now joins.

**The colour is `--note-tint`, not the accent**, and that is the one choice the
plan left open. The blockquote is the note's other bordered container and wears
`--accent-text`; the only question asked of either at a glance is which one it is,
so they cannot share a colour. The tint is also the note's own edge and its bar,
which makes a box read as part of the note rather than as app chrome — the
argument the root token's own comment makes about why the accent was rejected for
a note in the first place.

**The left padding is a gutter and is the only side not `--step`-based.** A block
inside a box has a grip, and the handle is placed immediately left of whatever it
grips, so without room inside the box it is drawn across the box's border. The
width is `--note-pad-x + --note-grip` — the same two parts as `--note-pad-l`,
without the outer pad that only the note's own edge needs.

Two smaller things the plan did not name: a first or last child's own margin adds
to the box's padding rather than sitting inside it, so both are zeroed; and a
nested box drops its fill and keeps its border, which is `pre code`'s rule one
level up.

**One tension worth recording rather than hiding.** `--note-tint`'s own comment
says the note began as a tinted ground and became an edge because a page of text
over a coloured field reads worse than the same text on a flat one. A box is a
small field rather than a page, and a coloured box is what was asked for — but if
the text inside reads badly, the fill is the knob, and dropping it to nothing
while keeping the border is the fallback that keeps the request mostly intact.

## Fix — the grip inside a box could not be caught

**Reported from the running app on 2026-09-13: the icon appears when you hover a
block inside a box, and goes as soon as you move towards it.**

It was not disappearing. It was jumping. `isNearEdge` asks
`coords.x - rect.left < threshold` for the left edge, and that comparison is
unbounded below — a pointer anywhere to the left of a block satisfies it however
far away it is. Leaving the text towards the grip therefore put the inner block
permanently "near an edge" and cost it `strength × depth`, while the box, a
gutter's width further out, was near nothing and kept the full 1000. The target
flipped to the box on the first `mousemove` off the text, and the handle
repositioned to the box's own left edge — out from under a pointer still on its
way to where it had been.

**`edges: ['top']`.** The left edge does nothing here that is not that bug, and
the top edge earns its place: it is the only thing that lets a box be taken hold
of at all, because with no edge rule the deepest block wins every tie and the box
would never be the target. So the strip across the top of a box is the box, and
everything below it belongs to what the box holds.

**Second half of the same fix: only the innermost box competes.** The asymmetry
that caused the bug also breaks nesting — an ancestor that is not near an edge
takes no penalty, so an outer box outscores the inner box the pointer is actually
in, and the inner box's top strip would grab the outer one. The rule now excludes
a box that has another box between it and the pointer, which it can answer from
`$pos` alone.

**What this changes for someone using it:** the way to pick up a box is its top
strip, and everywhere else inside it picks up the block under the pointer. Also
unverified — nothing was run.

## Second fix — the same flaw on the other axis, and the end of tuning

**Reported from the running app the same day: still not stable.**

Moving from `left` to `top` moved the bug rather than fixing it. `isNearEdge` is a
half-plane test on both axes — `coords.y - rect.top < threshold` is true for every
point above a block as well as the first 12px inside it. A note line is 21px. So
the upper 12px of _every line_ in a box counted as near that block's top while the
box, whose own top was far above, was penalised by nothing at all. The target
flipped between the block and the box as the pointer moved a few pixels up or
down inside one line.

**No value of `edges`, `threshold` or `strength` can express a band**, because the
comparison has no lower bound. That is the finding, and it is why this stopped
being a tuning problem after two attempts.

`edgeDetection: 'none'`. Nothing is penalised, every candidate keeps the base
1000, and the tie breaks by depth — the deepest block under the pointer,
everywhere, with nothing that can flip. The box then needs a region of its own,
and it is measured rather than scored: `inBoxGrabStrip` asks whether the pointer
is below a box's top and above its first child's top. That band is bounded, it
overlaps no text, and its floor is read off the first child rather than from a
constant, so it cannot drift away from the padding in the stylesheet.

A drag rule is handed the node, the document and the view but never the
coordinates, so the component keeps the pointer position in a ref from a
capture-phase `mousemove`.

**The box's vertical padding went from `--step * 2` to `--step * 4`** — 6px to
12px — because the strip _is_ that padding, and 6px is too fine to land on.

**Chosen by the user from three options**, the others being a permanent grip
drawn on the box through a node view, and dropping the box's own drag entirely.

Still unverified — nothing was run.

## Third fix — a box outside its strip is not a candidate at all

**Asked from the running app: standing in the margin beside a block, below the
icon, should the icon stay? Yes, and it did not always.**

The gutter a handle sits in is the _box's_ padding, not the block's, so a point
there can resolve to the box rather than into the block beside it. The box was
still an eligible candidate outside its strip — excluded only when it was not the
innermost — so from the gutter it could win and take the handle with it. The
pointer was then travelling towards something that had moved.

The rule is now simply: a block is always a candidate, and a box is a candidate
only from its own strip. Outside it there is no candidate at all, and the
extension's `mousemove` returns without hiding anything when it finds none — so
the handle holds its place. That is the same answer as padding `.note-drag`'s hit
area out to meet the text, one axis over, and it is the third time this note has
been bitten by "the handle moved" reading as "the handle vanished".

The rule also got shorter: the innermost-box walk is gone, because each box is now
judged against its own strip and two strips cannot overlap.

**Confirmed working in the running app by the user, 2026-09-13.** The grip inside
a box is reachable from the margin beside any row, which is what the three
previous attempts were each failing at. This is the one part of the feature that
has been seen rather than reasoned about — and it took three tries precisely
because it was reasoned about.

**`pnpm check` passed on 2026-09-14** — typecheck across all 18 tasks, eslint,
prettier and the whole suite at 2544 tests. What that proves is narrow: the code
compiles, lints and breaks nothing that was already covered. **Nothing here has a
test of its own**, and the drag behaviour was confirmed by driving the app rather
than by an assertion.

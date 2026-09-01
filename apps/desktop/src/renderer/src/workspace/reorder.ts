/**
 * Where the rail's tiles sit while a project is being dragged over them.
 *
 * **Insertion, not a swap, and that is what changed.** Dragging a tile used to
 * exchange it with whatever was under the pointer: the last tile dropped on the
 * first became first, the first became last, and everything between stayed put.
 * One gesture, two moves, and the list you were looking at was not the list you
 * were arranging. What a drag looks like is the other tiles making room, so that
 * is what it now does.
 *
 * Pure and free of the DOM, because it is the same arithmetic twice: the rail
 * uses it to show where the tiles are going while the pointer moves, and the
 * store uses it to write where they went. Two implementations that agree today
 * are two that disagree later, and the visible one is the one that would be
 * believed.
 */

/**
 * `ids` with `moved` taken out and put back immediately before `beforeId`.
 *
 * `null` means the end, which is the one position no neighbour can name. A
 * `beforeId` that is not in the list appends for the same reason: it can only
 * mean the neighbour went away mid-drag, and the end is where that gesture was
 * heading.
 *
 * Returns the input unchanged — the same array — when there is nothing to do, so
 * a caller rendering from it does not remount a row per pointer move.
 */
export function moveBefore(
  ids: readonly string[],
  moved: string,
  beforeId: string | null
): readonly string[] {
  if (moved === beforeId) return ids
  const from = ids.indexOf(moved)
  if (from === -1) return ids

  const without = ids.filter((id) => id !== moved)
  const at = beforeId === null ? without.length : without.indexOf(beforeId)
  const index = at === -1 ? without.length : at
  if (index === from) return ids
  return [...without.slice(0, index), moved, ...without.slice(index)]
}

/**
 * How far each tile has to travel, in whole tiles, to reach the previewed order.
 *
 * **Offsets rather than a reordered list**, and the reason is that this drives an
 * animation. Re-rendering the rail in the new order moves the DOM nodes, and a
 * node that moves because its siblings changed does not transition — there is no
 * property to interpolate. Leaving the nodes where they are and translating them
 * gives the browser exactly one thing to animate.
 *
 * The unit is tiles, not pixels: every tile in the rail is the same height and
 * the same gap apart, so the caller multiplies by one CSS length and no
 * measurement happens on any pointer move.
 *
 * Absent from the map means zero. A tile that is not moving should carry no
 * inline style at all, or every tile in the rail is written to on every frame.
 */
export function tileOffsets(
  ids: readonly string[],
  previewed: readonly string[]
): ReadonlyMap<string, number> {
  const offsets = new Map<string, number>()
  const to = new Map(previewed.map((id, index) => [id, index]))
  ids.forEach((id, from) => {
    const next = to.get(id)
    if (next !== undefined && next !== from) offsets.set(id, next - from)
  })
  return offsets
}

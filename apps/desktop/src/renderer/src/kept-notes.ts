/**
 * What a kept note is called, which is its own first line.
 *
 * **Derived rather than stored, and that is the decision the table reflects.** A
 * title column would be a second copy of something already in the document, and
 * two copies of one string is one that goes stale — the row would keep saying
 * what the note used to be about.
 *
 * **Read without mounting an editor**, which is the constraint that makes this a
 * function rather than a component's business. The menu draws a row per note and
 * there may be a dozen; mounting a dozen ProseMirror instances to learn a dozen
 * short strings is not a trade worth making.
 *
 * Both stored shapes are accepted, the same way `asDocument` accepts them: a
 * serialised document, or the plain string an older build wrote. A note whose
 * first block carries no text — an image, a divider — is skipped rather than
 * answered as blank, because the first *line* is what somebody would recognise.
 */
export function firstLine(stored: string | null): string {
  if (stored === null) return ''
  const trimmed = stored.trim()
  if (trimmed === '') return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    /* not a document; it is the plain text an older build wrote */
    return plainFirstLine(stored)
  }
  if (!isNode(parsed) || parsed.type !== 'doc') return plainFirstLine(stored)
  for (const block of childrenOf(parsed)) {
    const line = textOf(block).trim()
    if (line !== '') return line
  }
  return ''
}

/**
 * The list with one note moved, by insertion rather than by exchange.
 *
 * **Removed first, then placed.** Taking the dragged id out before locating the
 * target is what makes dropping onto a neighbour behave: with it still in the
 * array, the index of the row below it is one too high and the note lands back
 * where it started, which reads as a drag that did nothing.
 *
 * **Insert, never swap.** Dropping between two rows puts the note there; it does
 * not exchange it with whatever it landed on. That is the correction the project
 * rail already made for dragging a project, and it is what every list anybody has
 * dragged before does.
 *
 * A target that is not in the list answers with the order unchanged — a stale
 * row from a menu that was open while something was deleted is a drag that does
 * nothing, not an error.
 */
export function reordered(
  ids: readonly string[],
  dragged: string,
  target: string,
  below: boolean
): string[] {
  const without = ids.filter((id) => id !== dragged)
  const at = without.indexOf(target)
  if (at < 0) return [...ids]
  const insert = below ? at + 1 : at
  return [...without.slice(0, insert), dragged, ...without.slice(insert)]
}

/**
 * The shape of a document node as far as this file is concerned.
 *
 * Everything optional and `unknown`, because the input is whatever was in the
 * database rather than whatever TipTap would have written. Importing TipTap's
 * `JSONContent` would describe the happy case and assert the rest.
 */
interface JsonNode {
  readonly type?: unknown
  readonly text?: unknown
  readonly content?: unknown
}

function isNode(value: unknown): value is JsonNode {
  return typeof value === 'object' && value !== null
}

function childrenOf(node: JsonNode): readonly unknown[] {
  return Array.isArray(node.content) ? node.content : []
}

/**
 * Every piece of text under a node, joined.
 *
 * Recursive because the text of a block can be arbitrarily deep — a paragraph
 * inside a box inside a box, a line in a list — and the caller wants the line,
 * not the structure that holds it.
 */
function textOf(value: unknown): string {
  if (!isNode(value)) return ''
  if (typeof value.text === 'string') return value.text
  return childrenOf(value)
    .map((child) => textOf(child))
    .join('')
}

function plainFirstLine(stored: string): string {
  for (const line of stored.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

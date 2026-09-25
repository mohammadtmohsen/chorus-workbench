import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * No component draws a comment, because a comment in the wrong place draws.
 *
 * JSX has no comment syntax of its own: a note in *children* position has to sit
 * inside braces, and without them it is not a comment to the lexer at all. It is
 * a `JsxText` node, and React renders it as prose. One shipped in
 * `TrafficPanel.tsx` and every driver check missed it, because they all queried
 * the row's spans and the leak was a sibling text node beside them.
 *
 * A grep cannot find the rest. A comment in attribute position and one a person
 * would see both follow a line that may end in `}`, so by text the two are
 * identical, and this renderer has ninety-five such lines. The parse tree is not
 * ambiguous, `typescript` is already installed, and nothing new is added for it.
 */

const OPENER = '/*'

interface Leak {
  readonly file: string
  readonly line: number
  readonly text: string
}

interface Scan {
  readonly nodes: number
  readonly leaks: readonly Leak[]
}

/** Every `JsxText` node in one source, and the ones that would be drawn as prose. */
const scan = (file: string, source: string): Scan => {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const leaks: Leak[] = []
  let nodes = 0
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      nodes += 1
      if (node.text.includes(OPENER)) {
        leaks.push({
          file,
          line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
          text: node.text.trim().slice(0, 80),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(parsed, visit)
  return { nodes, leaks }
}

const RENDERER = join(import.meta.dirname, '..')

/*
 * Named from one level above the walk, so a failure prints a path a person can
 * put straight into `grep` — `renderer/src/TrafficPanel.tsx`, not the
 * `src/TrafficPanel.tsx` the renderer's own root would give.
 */
const NAMED_FROM = join(RENDERER, '..')

interface Component extends Scan {
  readonly file: string
}

const components: Component[] = []
const walk = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.tsx')) {
      const file = full.slice(NAMED_FROM.length + 1)
      components.push({ file, ...scan(file, readFileSync(full, 'utf8')) })
    }
  }
}
walk(RENDERER)

const drawn = (): readonly string[] =>
  components.flatMap((each) =>
    each.leaks.map((leak) => `${leak.file}:${String(leak.line)}  ${leak.text}`)
  )

describe('JSX text', () => {
  /**
   * A parse that quietly produced no JSX would leave the assertion below passing
   * over an empty set. The walk is only as good as what the parser handed it.
   */
  it('parses JSX out of every component', () => {
    expect(components.length).toBeGreaterThan(0)
    expect(components.reduce((sum, each) => sum + each.nodes, 0)).toBeGreaterThan(0)
  })

  it('draws no comment as text', () => {
    expect(drawn()).toEqual([])
  })

  /**
   * The control. Braces are the whole difference, and a rule that cannot tell the
   * two apart either misses the bug or forbids a legitimate comment.
   */
  it('tells a braced comment from one that renders', () => {
    const braced = scan('braced.tsx', 'export const A = () => <p>{/* note */}hi</p>\n')
    const bare = scan('bare.tsx', 'export const A = () => <p>/* note */hi</p>\n')
    expect(braced.leaks).toEqual([])
    expect(bare.leaks).toHaveLength(1)
  })
})

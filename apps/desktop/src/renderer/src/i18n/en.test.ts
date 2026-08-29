import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import en from './en.json'
import i18n from './index'

/**
 * The catalogue's own shape, checked because nothing else checked it.
 *
 * A wrong plural suffix is invisible: i18next does not warn, it simply never
 * finds the key and falls back to the singular. "16 tool" reached a screenshot
 * before anyone noticed, and only because someone was looking at that panel for
 * an unrelated reason. These assertions are the reader that was missing.
 */

/*
 * Arrays are leaves too.
 *
 * i18next reads a list with `returnObjects`, which is how the rotating
 * "thinking" words are stored — one key, many phrases. Before that existed this
 * type was `string | Catalogue`, and adding a list broke the walker rather than
 * the catalogue: every assertion below still wants to see those phrases, so an
 * array is flattened into indexed paths (`conversation.thinkingWords.0`) instead
 * of being skipped.
 */
interface Catalogue {
  [key: string]: string | readonly string[] | Catalogue
}

/** Every leaf, as a dotted path, so a failure names the entry to fix. */
function leaves(node: Catalogue, prefix = ''): [string, string][] {
  return Object.entries(node).flatMap(([key, value]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (typeof value === 'string') return [[path, value] as [string, string]]
    if (Array.isArray(value)) {
      return value.map((item, i) => [`${path}.${String(i)}`, item] as [string, string])
    }
    return leaves(value as Catalogue, path)
  })
}

const all = leaves(en)
const paths = all.map(([path]) => path)
const plurals = all.filter(([path]) => path.endsWith('_one') || path.endsWith('_other'))

describe('en.json', () => {
  /**
   * `_plural` is the i18next v3 suffix. This project is on v26, where the
   * suffixes come from `Intl.PluralRules` — `_one` and `_other` for English. A
   * v3 key is not an error, just dead: the lookup misses and the singular form
   * is rendered for every count.
   */
  it('uses no v3 plural suffixes', () => {
    expect(paths.filter((path) => path.endsWith('_plural'))).toEqual([])
  })

  /** Half a plural is the same silent failure, one count later. */
  it('pairs every plural form', () => {
    const unpaired = plurals
      .map(([path]) => path)
      .filter((path) => {
        const stem = path.slice(0, path.lastIndexOf('_'))
        const twin = path.endsWith('_one') ? `${stem}_other` : `${stem}_one`
        return !paths.includes(twin)
      })
    expect(unpaired).toEqual([])
  })

  /**
   * A count-bearing form that never interpolates the count reads as a fixed
   * string — "files touched" where "3 files touched" was meant.
   */
  it('interpolates the count in every plural form', () => {
    expect(plurals.filter(([, text]) => !text.includes('{{count}}')).map(([path]) => path)).toEqual(
      []
    )
  })

  /**
   * And the mechanism itself, through the configured instance rather than the
   * JSON — because the suffixes are only correct relative to the i18next in
   * `package.json`, and an upgrade is exactly when this breaks again.
   */
  it('resolves both forms at runtime', () => {
    expect(i18n.t('mcp.tools', { count: 1 })).toBe('1 tool')
    expect(i18n.t('mcp.tools', { count: 16 })).toBe('16 tools')
  })
})

/**
 * Every key a component asks for exists — the reader nothing had.
 *
 * A missing translation is invisible to the typechecker: `t('ide.headingWorkbench')`
 * is a string, and i18next answers a key it does not know by returning the key
 * itself. So the failure ships as a message reading `ide.headingWorkbench:
 * .env.local:8-22` in front of a user, which is exactly how this was found —
 * after a shell `&&` short-circuited the command that was supposed to add it and
 * nothing anywhere noticed.
 *
 * Literal calls only. `t(cond ? 'a' : 'b')` is covered because both arms are
 * literals in the source text; `t(someVariable)` is not, and cannot be — this
 * reads source rather than running it. Partial coverage of a class the
 * typechecker covers not at all.
 */
describe('every literal t() key resolves', () => {
  it('finds no key a component asks for and the catalogue lacks', () => {
    const root = join(import.meta.dirname, '..')
    const known = new Set(leaves(en as Catalogue).map(([path]) => path))

    const sources: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) sources.push(full)
      }
    }
    walk(root)

    const missing: string[] = []
    for (const file of sources) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/\bt\(\s*'([a-zA-Z][\w.]*)'/g)) {
        const key = match[1]
        if (key === undefined) continue
        /*
         * Plurals are stored as `key_one` / `key_other` and asked for as `key`,
         * so a bare miss is only a miss when neither suffix is there either.
         */
        if (known.has(key) || known.has(`${key}_one`) || known.has(`${key}_other`)) continue
        missing.push(`${key}  (${file.slice(root.length + 1)})`)
      }
    }

    expect(missing).toEqual([])
  })
})

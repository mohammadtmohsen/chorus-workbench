/**
 * Path containment, on segments — the rule both ends of the bridge must agree
 * on, in the one package both ends already import.
 *
 * It used to live twice: `isWithin` in `@chorus/workspace` for Electron main,
 * and `isInside` in the extension's `editor-context.ts`. Their own comments said
 * they had to agree, and they did not — main used `path.sep` and the extension
 * hardcoded `/`, so on Windows main said a file was inside its project and the
 * extension said it was outside. The extension checks first, so every file in
 * every project reported `unmatched` and nothing ever reached main's copy to be
 * re-checked.
 *
 * That is why this is here rather than in `@chorus/workspace`: the extension
 * cannot import that package, because it pulls in `node:fs` and the extension
 * bundles for a VS Code host. `ide-protocol` is what they share, and "we agree
 * about what is inside the project" is as much a part of the protocol as the
 * frame format is.
 *
 * The two checks still differ in *authority*, and that has not changed: the
 * extension's is a disclosure guard, main's is a security boundary against a
 * client it cannot trust. Sharing the rule does not make main trust the answer.
 *
 * ---
 *
 * **This module imports nothing, and that is now a requirement rather than a
 * property.** It used to open with `import { posix, win32 } from 'node:path'`,
 * which was correct in Electron main and in the extension host and catastrophic
 * in the third consumer nobody re-checked: the embedded workbench's renderer.
 * That bundle is browser code, so Vite replaced `node:path` with its
 * `__vite-browser-external` stub — literally `module.exports = {}` — and the
 * emitted `ops()` returned `undefined`. Every call to `hasRoot` then threw
 * `TypeError: Cannot read properties of undefined (reading 'isAbsolute')`.
 *
 * The blast radius was exactly the two schemes that reach `hasRoot`:
 * `resolveDocument` answers `file:` and `vscode-remote:` before touching it, so
 * ordinary files worked, while every `git:` and `gl-review:` document — the left
 * side of an SCM diff, and both sides of a GitLab merge request — threw. The
 * throw happened inside a VS Code `Emitter` listener, which routes to
 * `onUnexpectedError`, so nothing appeared in Chorus's log: selections in a
 * merge request simply never reached an agent, for days, silently.
 *
 * What `node:path` was actually supplying was `sep` and `isAbsolute` for two
 * platforms. Both are a line of string handling, and both are written out below
 * so this file can be bundled for a browser without anyone having to remember
 * that it must be.
 */

/**
 * The platforms these functions reason about.
 *
 * Structurally identical to `NodeJS.Platform`, and written out rather than
 * referenced so this module needs no `@types/node`. A consumer with Node types
 * can still pass `process.platform` straight in; a browser bundle can use it
 * without the `NodeJS` namespace existing at all.
 */
export type Platform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd'

/**
 * The separator for the platform being reasoned about, which in tests is not
 * this one.
 *
 * Windows accepts both separators and VS Code emits `/` in places, which is why
 * `normalize` folds them; this is the one the folded form is written with.
 */
function separatorFor(platform: Platform): string {
  return platform === 'win32' ? '\\' : '/'
}

/** Whether a path already ends in a separator the platform recognises. */
function endsWithSeparator(path: string, platform: Platform): boolean {
  return platform === 'win32' ? /[\\/]$/.test(path) : path.endsWith('/')
}

/**
 * Ordinal on POSIX, where two casings are two files.
 *
 * On Windows, both case and separator are folded. NTFS is case-insensitive, and
 * the two sides canonicalize with different code that disagrees about the drive
 * letter — `Uri.fsPath` lowercases it, `realpathSync` returns the volume's own
 * casing — so an ordinal comparison fails on exactly the machines where the
 * extension's `realpathSync` fallback fires. Separators fold for the same
 * reason: Windows accepts both and VS Code emits `/` in places.
 */
function normalize(p: string, platform: Platform): string {
  return platform === 'win32' ? p.replace(/\//g, '\\').toLowerCase() : p
}

/**
 * Whether `target` is `root` or sits beneath it.
 *
 * Segment-wise: `/a/project-old` is **not** inside `/a/project`. That sibling
 * prefix is the bug this function exists to prevent, and the reason it is not
 * a bare `startsWith`.
 *
 * **The platform is required rather than defaulted.** It used to default to
 * `process.platform`, which reads as a convenience and is a trap: this module is
 * bundled for a browser, where evaluating that default throws `ReferenceError`
 * before the function body runs. Naming it at the call site costs one argument
 * and makes the Node-only assumption impossible to inherit by accident —
 * `@chorus/workspace`'s `path-safety.ts` is where a Node caller's default lives
 * now, because that package may assume Node and this one may not.
 */
export function isInside(root: string, target: string, platform: Platform): boolean {
  const a = normalize(root, platform)
  const b = normalize(target, platform)
  if (b === a) return true
  const sep = separatorFor(platform)
  return b.startsWith(a.endsWith(sep) ? a : a + sep)
}

/**
 * The part of `target` below `root`, or null when it is not below it.
 *
 * The separator arithmetic lives here and nowhere else.
 * `target.slice(root.length + 1)` is right only when the root does not already
 * end in a separator — and every filesystem root does. `C:\`, `\\server\share\`
 * and `/` all arrive from `resolve()` with the separator attached, so a project
 * sitting at a drive or share root sliced one character too many and reported
 * `ile.ts` for `file.ts`. That string goes into an agent mention verbatim.
 *
 * **Both separators count on Windows**, and checking only `\` was the same bug
 * one shape further out. `isInside` folds `/` to `\` before comparing, so a root
 * written `C:/proj/` is legitimately contained — and then this sliced
 * `root.length + 1` against it and ate the first character of the filename.
 * Roots reach here from `Uri.fsPath`, from a settings file and from an agent's
 * own output, and VS Code emits forward slashes on Windows in all three.
 *
 * Slices the original `target`, not the folded copy, so the caller gets back
 * the casing the filesystem reported.
 */
export function relativeInside(root: string, target: string, platform: Platform): string | null {
  if (!isInside(root, target, platform)) return null
  return target.slice(endsWithSeparator(root, platform) ? root.length : root.length + 1)
}

/**
 * Absolute *and* anchored — locatable without borrowing anything from context.
 *
 * `isAbsolute` alone answers a different question on Windows: true for `\etc`
 * (rooted, but on no particular drive) and false for `C:etc` (a drive with no
 * root). Resolving either borrows the current process's working directory,
 * which is never the right source when the caller supplied a root.
 *
 * So on Windows the two accepted shapes are written out directly — a UNC root
 * (`\\server\share`, which VS Code may also emit as `//server/share`) and a
 * drive-anchored path (`C:\` or `C:/`). Both are `win32.isAbsolute`-true by
 * construction, which is why the old `isAbsolute` pre-filter is not missed: it
 * only ever rejected the shapes the two patterns already reject.
 */
export function hasRoot(candidate: string, platform: Platform): boolean {
  if (platform !== 'win32') return candidate.startsWith('/')
  if (/^[\\/]{2}/.test(candidate)) return true
  return /^[a-zA-Z]:[\\/]/.test(candidate)
}

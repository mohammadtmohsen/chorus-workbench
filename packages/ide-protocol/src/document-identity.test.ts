import { describe, expect, it } from 'vitest'
import {
  joinInside as joinInsideImpl,
  resolveDocument,
  type DocumentUri,
} from './document-identity.js'

/**
 * The URI strings here are the real shapes, taken from the two extensions'
 * bundles rather than from memory — `toGitUri` in VS Code's git extension and
 * `toReviewUri` in `gitlab.gitlab-workflow-6.86.0`. Guessing them is the
 * failure this whole module exists to avoid.
 */

/*
 * Every call below names `'darwin'`.
 *
 * The fixtures are POSIX — `/Users/me/repo`, `/src/app.ts` — and what counts as
 * an absolute path is a platform question, so without naming one these asserted
 * whichever host they ran on. On the Windows runner `hasRoot('/Users/me/repo')`
 * is false, because a rooted path with no drive letter cannot be located, and
 * seven tests went red for a reason that had nothing to do with what they test.
 */
const REPO = '/Users/me/repo'

/**
 * Every call goes through here, and it names `'darwin'`.
 *
 * The first attempt added the argument at each call site and missed the ones
 * behind the `uri()`, `git()` and `review()` helpers — six tests still failed on
 * the Windows runner. One wrapper cannot be half-applied.
 */
const resolve = (u: DocumentUri): ReturnType<typeof resolveDocument> => resolveDocument(u, 'darwin')
const joinInside = (root: string, relative: string): string | null =>
  joinInsideImpl(root, relative, 'darwin')

const uri = (over: Partial<DocumentUri>): DocumentUri => ({
  scheme: 'file',
  path: `${REPO}/src/app.ts`,
  query: '',
  fsPath: `${REPO}/src/app.ts`,
  ...over,
})

/** `Uri.file(path).with({ scheme: 'gl-review', query })`, keys sorted. */
const review = (over: Record<string, unknown> = {}, path = '/src/app.ts'): DocumentUri =>
  uri({
    scheme: 'gl-review',
    path,
    // `fsPath` of such a URI is the relative path wearing a leading slash —
    // exactly the value that must never be used.
    fsPath: path,
    query: JSON.stringify({
      changeType: 'modified',
      commit: 'a1b2c3d4e5f6',
      exists: '1',
      mrId: 456,
      projectId: 123,
      repositoryRoot: REPO,
      ...over,
    }),
  })

const git = (ref: string, path = `${REPO}/src/app.ts`): DocumentUri =>
  uri({
    scheme: 'git',
    // The git extension appends `.git` to keep the language id neutral, which
    // is why the query is the only thing read.
    path: `${path}.git`,
    fsPath: `${path}.git`,
    query: JSON.stringify({ path, ref }),
  })

describe('joinInside', () => {
  it('joins a repo-relative path onto its root', () => {
    expect(joinInside(REPO, '/src/app.ts')).toBe(`${REPO}/src/app.ts`)
    expect(joinInside(`${REPO}/`, 'src/app.ts')).toBe(`${REPO}/src/app.ts`)
  })

  /* A path from a merge request never legitimately climbs out of the repo, so
     this refuses rather than normalising and being wrong quietly. */
  it('refuses to climb out of the root', () => {
    expect(joinInside(REPO, '/../../etc/passwd')).toBeNull()
    expect(joinInside(REPO, '/src/../../x')).toBeNull()
  })

  it('refuses a root that is not absolute, and an empty path', () => {
    expect(joinInside('repo', '/src/a.ts')).toBeNull()
    expect(joinInside(REPO, '/')).toBeNull()
  })
})

describe('resolveDocument — file', () => {
  it('is the working tree', () => {
    expect(resolve(uri({}))).toEqual({
      filePath: `${REPO}/src/app.ts`,
      provenance: { kind: 'worktree' },
    })
  })
})

/**
 * The embedded workbench's own scheme, and the one shape that had no test.
 *
 * Chorus opens every project through a remote extension host, so an ordinary
 * file in the workbench is `vscode-remote://<authority>/<path>` — this is the
 * common case, not an exotic one, and the fixtures below are what
 * `URI.parse(...).fsPath` actually produces for each platform rather than what
 * the shape looks like it should be.
 */
describe('resolveDocument — vscode-remote', () => {
  it('is the working tree on posix', () => {
    expect(
      resolve(
        uri({
          scheme: 'vscode-remote',
          path: `${REPO}/src/app.ts`,
          fsPath: `${REPO}/src/app.ts`,
        })
      )
    ).toEqual({ filePath: `${REPO}/src/app.ts`, provenance: { kind: 'worktree' } })
  })

  /*
   * **`path` carries the drive letter behind a leading slash, and `fsPath` does
   * not.** `uriToFsPath` only builds a UNC `//authority/path` when the scheme is
   * `file`, so a remote URI takes the drive branch instead and comes back as
   * `c:/Users/…`. Reading `path` here gave `/C:/Users/…`, which no root matches
   * — so on Windows every file in every project reported `outside-root`, which
   * is indistinguishable from having no editor open.
   */
  it('strips the leading slash from a Windows drive path', () => {
    expect(
      resolveDocument(
        {
          scheme: 'vscode-remote',
          path: '/C:/Users/me/repo/src/app.ts',
          query: '',
          fsPath: 'c:/Users/me/repo/src/app.ts',
        },
        'win32'
      )
    ).toEqual({ filePath: 'c:/Users/me/repo/src/app.ts', provenance: { kind: 'worktree' } })
  })

  /*
   * Validated, not merely non-empty. A remote URI with no path at all, or a
   * Windows one naming no drive, cannot be located — and a path that cannot be
   * located is the same answer as a scheme we cannot read.
   */
  it('refuses a path that names no location', () => {
    expect(resolve(uri({ scheme: 'vscode-remote', path: '', fsPath: '' }))).toBeNull()
    expect(
      resolveDocument(
        { scheme: 'vscode-remote', path: '/src/app.ts', query: '', fsPath: '/src/app.ts' },
        'win32'
      )
    ).toBeNull()
  })
})

describe('resolveDocument — git', () => {
  it('reads the absolute path out of the query, not the path', () => {
    expect(resolve(git('HEAD'))).toEqual({
      filePath: `${REPO}/src/app.ts`,
      provenance: { kind: 'ref', ref: 'HEAD' },
    })
  })

  it('keeps the index and a commit apart', () => {
    expect(resolve(git('~'))?.provenance).toEqual({ kind: 'ref', ref: '~' })
    expect(resolve(git('9f1c2ab'))?.provenance).toEqual({ kind: 'ref', ref: '9f1c2ab' })
  })

  /* An empty ref *is* the working tree, so qualifying it would invent a
     version that does not exist. */
  it('treats an empty ref as the working tree', () => {
    expect(resolve(git(''))?.provenance).toEqual({ kind: 'worktree' })
  })

  it('refuses a query it cannot read', () => {
    expect(resolve(uri({ scheme: 'git', query: 'not json' }))).toBeNull()
    expect(resolve(uri({ scheme: 'git', query: '{"ref":"HEAD"}' }))).toBeNull()
    expect(resolve(uri({ scheme: 'git', query: '{"path":"relative/x.ts"}' }))).toBeNull()
  })
})

describe('resolveDocument — gl-review', () => {
  /*
   * The reason this module exists. `fsPath` here is `/src/app.ts`: a
   * real-looking absolute path that is outside every project. Claude Code
   * sends exactly that.
   */
  it('rejoins the repo-relative path onto the repository root', () => {
    expect(resolve(review())).toEqual({
      filePath: `${REPO}/src/app.ts`,
      provenance: { kind: 'review', commit: 'a1b2c3d4e5f6' },
    })
  })

  /* Base and head differ only by commit — the path is the same unless the file
     was renamed. Losing it makes the two panes indistinguishable. */
  it('keeps the two panes of one file apart by commit', () => {
    const base = resolve(review({ commit: 'base111' }))
    const head = resolve(review({ commit: 'head222' }))
    expect(base?.filePath).toBe(head?.filePath)
    expect(base?.provenance).not.toEqual(head?.provenance)
  })

  /*
   * GitLab's `isEmptyFileUri`: `!exists || !commit`. This is the blank pane
   * opposite an added or a deleted file, and there is nothing in it to refer
   * to.
   */
  it('refuses the empty pane opposite an added or deleted file', () => {
    expect(resolve(review({ exists: '' }))).toBeNull()
    expect(resolve(review({ commit: '' }))).toBeNull()
  })

  /*
   * Validated as a shape check and then dropped. An unexpected value means this
   * is not the URI shape we read out of the bundle, and refusing beats
   * misparsing — but nothing downstream reads it, because the commit already
   * covers the rename case: `git show <commit>:<old path>` works.
   */
  it('checks the change type against the closed set, and carries none of it', () => {
    expect(resolve(review({ changeType: 'renamed' }))?.provenance).toEqual({
      kind: 'review',
      commit: 'a1b2c3d4e5f6',
    })
    expect(resolve(review({ changeType: 'invented' }))).toBeNull()
  })

  it('refuses a query with no repository root to rejoin against', () => {
    expect(resolve(review({ repositoryRoot: '' }))).toBeNull()
    expect(resolve(uri({ scheme: 'gl-review', query: '' }))).toBeNull()
  })

  it('refuses a path that climbs out of the repository', () => {
    expect(resolve(review({}, '/../../../etc/passwd'))).toBeNull()
  })
})

describe('resolveDocument — everything else', () => {
  /*
   * An allowlist: a scheme nobody has read yields nothing, rather than a path
   * that looks plausible and is wrong. `untitled:` has no path at all.
   */
  it.each(['untitled', 'output', 'vscode-notebook-cell', 'gitlab-remote', 'pr', 'vscode-userdata'])(
    'refuses %s',
    (scheme) => {
      expect(resolve(uri({ scheme }))).toBeNull()
    }
  )
})

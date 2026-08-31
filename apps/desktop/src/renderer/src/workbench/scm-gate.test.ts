import { describe, expect, it } from 'vitest'
import {
  SELF_WRITE_GRACE_MS,
  classify,
  openGate,
  refreshSettled,
  refreshStarted,
  shouldRefresh,
  type RefreshGate,
} from './scm-gate.js'

/**
 * The loop and the regression that fixing it first caused, both as tests.
 *
 * `git.refresh` runs `git status`, which rewrites `.git/index`; the watcher
 * reported that write and the refresh fired again a second later, so the badge
 * flickered on an untouched project. The first fix ignored every index write —
 * which also ignored `git add`, because a pathname cannot tell a stat-cache
 * refresh from a staging change. They are the same write. Only the cause
 * differs, so only the cause can decide.
 */
describe('classifying a changed path', () => {
  it('treats the working tree as content', () => {
    expect(classify('/Users/me/repo/src/app.ts')).toBe('content')
    expect(classify('/Users/me/repo/README.md')).toBe('content')
  })

  /*
   * The two things a commit or a fetch moves without touching the working tree,
   * plus the third that `git gc` moves them into. None is written by
   * `git status`, so none can restart the loop.
   */
  it('treats refs and HEAD as content, packed-refs included', () => {
    expect(classify('/Users/me/repo/.git/HEAD')).toBe('content')
    expect(classify('/Users/me/repo/.git/refs/heads/main')).toBe('content')
    expect(classify('/Users/me/repo/.git/refs/remotes/origin/main')).toBe('content')
    expect(classify('/Users/me/repo/.git/packed-refs')).toBe('content')
  })

  /* Ambiguous by nature: the same write for `git status` and for `git add`. */
  it('treats the index as its own kind, neither content nor noise', () => {
    expect(classify('/Users/me/repo/.git/index')).toBe('index')
  })

  it('ignores the rest of git’s machinery', () => {
    expect(classify('/Users/me/repo/.git/index.lock')).toBe('ignored')
    expect(classify('/Users/me/repo/.git/COMMIT_EDITMSG')).toBe('ignored')
    expect(classify('/Users/me/repo/.git/logs/HEAD')).toBe('ignored')
    expect(classify('/Users/me/repo/.git/objects/ab/cdef')).toBe('ignored')
    expect(classify('/Users/me/repo/.git/ORIG_HEAD')).toBe('ignored')
    expect(classify('/Users/me/repo/.git')).toBe('ignored')
  })

  /*
   * Anchored on a path segment, not a substring. `.gitignore` is a file people
   * edit and `mygit/` is an ordinary directory.
   */
  it('does not mistake a name that merely contains git for the directory', () => {
    expect(classify('/Users/me/repo/.gitignore')).toBe('content')
    expect(classify('/Users/me/repo/.gitattributes')).toBe('content')
    expect(classify('/Users/me/repo/mygit/file.ts')).toBe('content')
    expect(classify('/Users/me/repo/src/.github/workflows/ci.yml')).toBe('content')
  })

  it('recognises a nested repository’s machinery too', () => {
    expect(classify('/Users/me/repo/vendor/dep/.git/index')).toBe('index')
    expect(classify('/Users/me/repo/vendor/dep/.git/refs/heads/main')).toBe('content')
  })
})

describe('deciding whether a batch deserves a refresh', () => {
  const WORKING = '/Users/me/repo/src/app.ts'
  const INDEX = '/Users/me/repo/.git/index'
  const LOCK = '/Users/me/repo/.git/index.lock'

  it('refreshes for content and ignores pure machinery', () => {
    expect(shouldRefresh(openGate, [WORKING], 1000)).toBe(true)
    expect(shouldRefresh(openGate, [LOCK], 1000)).toBe(false)
    expect(shouldRefresh(openGate, [], 1000)).toBe(false)
  })

  /* `git add` from a terminal: the index and its lock, and nothing else. */
  it('refreshes for an index write nobody claimed', () => {
    expect(shouldRefresh(openGate, [LOCK, INDEX], 1000)).toBe(true)
  })

  /**
   * The whole sequence, in order — this is the test the design exists for.
   *
   * A working-tree change refreshes; the index write that refresh causes is
   * recognised as ours and ignored; and once the causal window closes, an index
   * write is somebody else's again and refreshes.
   */
  it('ignores its own exhaust and nothing else', () => {
    let gate: RefreshGate = openGate

    // 1. An agent edits a file.
    expect(shouldRefresh(gate, [WORKING], 1000)).toBe(true)

    // 2. We run `git.refresh`, and `git status` rewrites the index while it runs.
    gate = refreshStarted()
    expect(shouldRefresh(gate, [INDEX], 1100)).toBe(false)

    // 3. It resolves, and the write lands a moment after — still ours.
    gate = refreshSettled(1200)
    expect(shouldRefresh(gate, [INDEX], 1250)).toBe(false)

    // 4. Later, `git add` in a terminal. Nothing of ours is outstanding.
    expect(shouldRefresh(gate, [INDEX], 1200 + SELF_WRITE_GRACE_MS + 1)).toBe(true)
  })

  /*
   * A real edit during our own refresh is somebody else's write by definition,
   * so suppressing it would trade a flickering badge for a stale one. Only the
   * index is ambiguous, so only the index is suppressed.
   */
  it('never suppresses content, even mid-refresh', () => {
    const gate = refreshStarted()
    expect(shouldRefresh(gate, [WORKING], 1100)).toBe(true)
    expect(shouldRefresh(gate, [INDEX, WORKING], 1100)).toBe(true)
  })

  /*
   * `git status` on a large repository takes as long as it takes. A fixed timer
   * would expire mid-run and let the loop back in, which is why in-flight is a
   * flag rather than a deadline.
   */
  it('suppresses for the whole run, however long it takes', () => {
    const gate = refreshStarted()
    expect(shouldRefresh(gate, [INDEX], 1_000_000)).toBe(false)
  })

  it('reopens exactly at the end of the grace window', () => {
    const gate = refreshSettled(5000)
    expect(shouldRefresh(gate, [INDEX], 5000 + SELF_WRITE_GRACE_MS - 1)).toBe(false)
    expect(shouldRefresh(gate, [INDEX], 5000 + SELF_WRITE_GRACE_MS)).toBe(true)
  })
})

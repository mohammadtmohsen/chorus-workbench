/**
 * Whether a batch of file changes is a reason to refresh source control, or the
 * last refresh's own exhaust.
 *
 * **Its own module for the same reason `editor-tracking.ts` is.** The decision
 * is strings and a small state machine, while `scm-refresh.ts` around it pulls
 * `@codingame` packages that import CSS — which the project's
 * `environment: 'node'` test setup cannot load, so anything in that file is
 * untestable by construction. Nothing here imports, so the rule can be asserted
 * against real paths and real orderings rather than reasoned about.
 *
 * **The loop this exists to break.** `git.refresh` shells out to `git status`,
 * which rewrites `.git/index` whenever its stat cache is stale. That write is a
 * file change like any other, the watcher reported it, and a second later the
 * refresh fired again — refresh, write, event, refresh. The SCM badge in the
 * activity bar flickered on a project nobody was touching. It decayed rather
 * than spinning forever, which is what made it a puzzle: once `git status` has
 * settled the stat cache it stops rewriting the index, so the cycle starves
 * after a minute or two of a quiet tree, and `git.autofetch` then re-armed it.
 *
 * **And why a path filter was the wrong fix.** The first attempt classified
 * every `.git/index` write as machinery and ignored it permanently. That breaks
 * the loop and breaks something real with it: `git add`, `git restore --staged`,
 * `git reset --mixed` and partial staging from a terminal all change *only* the
 * index. The index is not exhaust — it is the authoritative staged state, and
 * the view is wrong without it. A pathname cannot tell a stat-cache refresh from
 * a staging change, because they are the same write.
 *
 * So the question moved from *what* changed to *what caused it*. An index write
 * counts, unless we are the ones who just caused it.
 */

/** What a changed path means for the source-control view. */
export type ChangeKind =
  /** The working tree, or a ref — always worth a refresh. */
  | 'content'
  /** `.git/index`: worth a refresh unless it is our own refresh's exhaust. */
  | 'index'
  /** Machinery that says nothing the other two do not. */
  | 'ignored'

/**
 * How long after our own refresh settles an index write is still assumed to be
 * ours.
 *
 * `git status` writes the index as it runs, but the write can land fractionally
 * after the command resolves, so in-flight alone is not enough. Short, because
 * the whole cost of this window is the one case it gets wrong: a `git add` typed
 * in a terminal in the few hundred milliseconds after a refresh settles is
 * treated as ours and waits for the next event. Longer would make that likelier;
 * shorter risks re-arming the loop on a slow disk.
 */
export const SELF_WRITE_GRACE_MS = 750

/**
 * Which changed paths matter, and how.
 *
 * **`HEAD`, `refs/` and `packed-refs` are unconditional**, and that is not a
 * hedge: a commit made in a terminal moves files out of the modified set while
 * touching nothing outside `.git`, and a fetch writes `refs/remotes/…`. Neither
 * is written by `git status`, so admitting them cannot restart the loop.
 * `packed-refs` is there because `git gc` and `git pack-refs` move refs into it
 * wholesale — a ref change that never appears under `refs/` at all.
 *
 * Everything else under `.git` is machinery: lock files, logs, objects,
 * `COMMIT_EDITMSG`. None of it says anything the three above do not.
 *
 * The match is anchored on a path *segment*, so `.gitignore` and a directory
 * called `mygit` are ordinary content.
 *
 * **Known gap: a worktree or submodule whose `.git` is a file.** There, `.git`
 * holds a `gitdir:` pointer and the real index and `HEAD` live outside the
 * project tree entirely — so those writes never reach this predicate under a
 * `.git/` path, and may not be watched at all. Resolving that means reading the
 * pointer, which is a filesystem question rather than a path one.
 */
export function classify(path: string): ChangeKind {
  const dotGit = /(?:^|\/)\.git(?:\/|$)/.exec(path)
  if (dotGit === null) return 'content'
  const inside = path.slice(dotGit.index + dotGit[0].length)
  if (inside === 'HEAD' || inside === 'packed-refs' || inside.startsWith('refs/')) return 'content'
  if (inside === 'index') return 'index'
  return 'ignored'
}

/**
 * What we know about a refresh we started, so its exhaust can be recognised.
 *
 * Two fields rather than one deadline, because the two halves bound different
 * things. `inFlight` covers the command's own duration, which is unbounded — a
 * `git status` on a large repository takes as long as it takes, and a fixed
 * timer would expire mid-run and let the loop back in. `graceUntil` covers the
 * moment *after* it resolves, when the index write may still be landing.
 */
export interface RefreshGate {
  readonly inFlight: boolean
  readonly graceUntil: number
}

export const openGate: RefreshGate = { inFlight: false, graceUntil: 0 }

/** We are about to run `git.refresh`; anything it writes is ours. */
export function refreshStarted(): RefreshGate {
  return { inFlight: true, graceUntil: 0 }
}

/** It finished; keep claiming index writes for a moment longer. */
export function refreshSettled(now: number): RefreshGate {
  return { inFlight: false, graceUntil: now + SELF_WRITE_GRACE_MS }
}

/**
 * Whether this batch of changes should trigger a refresh.
 *
 * **Content wins outright, even inside our own window.** A file changing on disk
 * while `git status` runs is somebody else's write by definition — an agent, a
 * build, a save — and refusing it because we happen to be mid-refresh would
 * trade a flickering badge for a stale one. Only the *index* is ambiguous, and
 * only the index is suppressed.
 */
export function shouldRefresh(gate: RefreshGate, paths: readonly string[], now: number): boolean {
  let sawIndex = false
  for (const path of paths) {
    const kind = classify(path)
    if (kind === 'content') return true
    if (kind === 'index') sawIndex = true
  }
  if (!sawIndex) return false
  return !gate.inFlight && now >= gate.graceUntil
}

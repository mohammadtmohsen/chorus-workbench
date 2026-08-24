/**
 * The decision `before-quit` makes, extracted so it can be tested.
 *
 * It is three lines of state and it was wrong in a way that reading it did not
 * reveal, which is the argument for pulling it out of `index.ts`: that file
 * bootstraps an entire application on import, so the only way to exercise this
 * before was to stop the whole app and hope the timing lined up. It did not — the
 * one thing repeated *signals* proved is that they terminate the process, which
 * says nothing about the guard.
 *
 * The defect: the handler guarded on `runtime === null`, with `runtime` nulled on
 * the first line of cleanup. That flag answers **"has cleanup started"** and it
 * was being asked **"may the app exit now"**. A second `app.quit()` arriving
 * during the asynchronous cleanup — from `window-all-closed` as the last window
 * goes, from the application menu, from a second `⌘Q` pressed because the first
 * seemed to do nothing — re-entered the handler, found the flag already set, and
 * returned **without calling `preventDefault`**. Electron was then free to exit on
 * top of a database mid-checkpoint and a remote extension host mid-`SIGTERM`.
 *
 * Two flags, because one value cannot hold two facts: `inFlight` says cleanup is
 * running and every quit is refused while it is, `readyToQuit` says cleanup has
 * settled and the gate steps aside. They are never both true, which is what makes
 * the re-entrant case decidable at all.
 *
 * **Scope, stated because it was learned the expensive way.** This governs
 * Electron's *quit lifecycle* — `app.quit()`, a closing window, a menu item. It
 * does not govern a second OS termination signal: the process was observed exiting
 * with `signal=SIGTERM` when one arrived mid-cleanup, and no `preventDefault` here
 * changes that. That boundary is `BOARD.md` C-055, and the recovery for it is the
 * next launch's reaper rather than anything in this file.
 */
export interface QuitRequest {
  readonly preventDefault: () => void
}

export interface QuitGate {
  /** Wire straight to `app.on('before-quit', gate.onBeforeQuit)`. */
  readonly onBeforeQuit: (event: QuitRequest) => void
}

/**
 * Where a cleanup failure goes, and it is a required argument on purpose.
 *
 * This used to be a bare `.catch(() => undefined)`, which meant a shutdown that
 * threw let Chorus exit with **no result and no log at all** — the lifecycle
 * failure E4 exists to expose, hiding inside the machinery built to expose it. Not
 * a check that could not fail: a failure that could not be *seen*, which is the
 * same family one step further along.
 *
 * **Reported exactly once, by construction rather than by care.** The two paths
 * are disjoint: anything `cleanup` handles itself it logs itself and then
 * *resolves*, so it never reaches here; anything that escapes `cleanup` reaches
 * here and is reported once. There is no arrangement in which both fire for one
 * failure, which is what makes "exactly once" a property rather than a promise.
 */
export type CleanupFailed = (error: unknown) => void

/**
 * @param cleanup Runs once, however many quits arrive. Must settle — a cleanup
 *   that never resolves is an app that can never be quit, which is why every
 *   step inside it is separately bounded.
 * @param quit What to call once cleanup has settled. The gate steps aside first,
 *   so this re-entrant call is the one that actually exits.
 */
export function createQuitGate(
  cleanup: () => Promise<void>,
  quit: () => void,
  onCleanupFailed: CleanupFailed
): QuitGate {
  let inFlight: Promise<void> | null = null
  let readyToQuit = false

  return {
    onBeforeQuit(event: QuitRequest): void {
      // Cleanup has settled; this is the quit the gate asked for. Vetoing here
      // would be a loop, since the settle handler below is what calls `quit`.
      if (readyToQuit) return

      /*
       * Vetoed **first**, and unconditionally, before any branch can return
       * without having done it. The old shape decided whether to veto *after*
       * deciding whether there was work to do, which is exactly how the second
       * quit got through.
       */
      event.preventDefault()
      if (inFlight !== null) return

      inFlight = cleanup()
      /*
       * The `catch` is load-bearing twice over, and a test found it the first
       * time: `finally` re-throws, so a cleanup that rejects produced an
       * **unhandled rejection** in the main process — on some Electron
       * configurations a crash, and always at the worst possible moment, since by
       * then the database is closing and the workbench server has been signalled.
       * Attaching a handler here also marks `inFlight` itself as handled; nothing
       * else ever awaits it.
       *
       * And it **reports** rather than discards. A quit gate that swallows the one
       * thing it is waiting on is a gate that will always let the app exit and
       * never say why it should not have.
       */
      void inFlight
        .catch((error: unknown) => {
          try {
            onCleanupFailed(error)
          } catch {
            // A reporter that throws must not be the reason Chorus cannot close.
            // Losing the report is bad; becoming unquittable is worse.
          }
        })
        .finally(() => {
          readyToQuit = true
          quit()
        })
    },
  }
}

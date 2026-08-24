import { describe, expect, it, vi } from 'vitest'
import { createQuitGate } from './quit-gate.js'

/**
 * Repeated in-app quits, which is the case the app itself could not be made to
 * demonstrate.
 *
 * Driving this through the running app was tried and abandoned: repeated OS
 * signals end the process with `signal=SIGTERM` whatever the handler does, so a
 * gate built on them measured the signal rather than the guard — it passed
 * identically against the defect. What the guard actually governs is Electron's
 * *quit lifecycle*, and a second `app.quit()` from `window-all-closed`, the
 * application menu, or a second `⌘Q` is both ordinary and entirely in JavaScript.
 * So it is tested here, where the re-entry can be arranged exactly.
 *
 * The defect being held out: guarding on a flag that means "cleanup has started"
 * while being asked "may the app exit now". A second quit then returned **without
 * calling `preventDefault`**, and Electron was free to exit on top of a database
 * mid-checkpoint and a server mid-`SIGTERM`.
 */

/** Unused by the passing cases: a cleanup that resolves never reaches the reporter. */
const reportFailure = vi.fn()

/** A cleanup whose completion the test decides. */
function heldCleanup(): { run: () => Promise<void>; finish: () => void; calls: number } {
  let release = (): void => undefined
  const promise = new Promise<void>((settle) => {
    release = () => {
      settle()
    }
  })
  const state = {
    calls: 0,
    run: () => {
      state.calls += 1
      return promise
    },
    finish: release,
  }
  return state
}

describe('the quit gate', () => {
  it('vetoes every quit that arrives while cleanup is running', async () => {
    const cleanup = heldCleanup()
    const quit = vi.fn()
    const gate = createQuitGate(cleanup.run, quit, reportFailure)

    const first = { preventDefault: vi.fn() }
    gate.onBeforeQuit(first)
    expect(first.preventDefault).toHaveBeenCalledTimes(1)
    expect(cleanup.calls).toBe(1)

    /*
     * The assertion this file exists for. Cleanup is deliberately still running,
     * and this second quit has to be refused — the old guard returned here without
     * vetoing, which let the app exit mid-cleanup.
     */
    const second = { preventDefault: vi.fn() }
    gate.onBeforeQuit(second)
    expect(second.preventDefault).toHaveBeenCalledTimes(1)
    // And it must not start a second shutdown over the top of the first.
    expect(cleanup.calls).toBe(1)

    const third = { preventDefault: vi.fn() }
    gate.onBeforeQuit(third)
    expect(third.preventDefault).toHaveBeenCalledTimes(1)
    expect(cleanup.calls).toBe(1)

    // Nothing has exited yet: `quit` is what the gate calls *after* cleanup.
    expect(quit).not.toHaveBeenCalled()

    cleanup.finish()
    await vi.waitFor(() => {
      expect(quit).toHaveBeenCalledTimes(1)
    })
  })

  it('steps aside once cleanup has settled, so the app can actually exit', async () => {
    const cleanup = heldCleanup()
    const quit = vi.fn()
    const gate = createQuitGate(cleanup.run, quit, reportFailure)

    gate.onBeforeQuit({ preventDefault: vi.fn() })
    cleanup.finish()
    await vi.waitFor(() => {
      expect(quit).toHaveBeenCalledTimes(1)
    })

    /*
     * The other half, and it is the one that would hang the app rather than
     * corrupt it: a gate that kept vetoing after cleanup finished would refuse the
     * very `app.quit()` it had just issued, and Chorus would never close.
     */
    const afterwards = { preventDefault: vi.fn() }
    gate.onBeforeQuit(afterwards)
    expect(afterwards.preventDefault).not.toHaveBeenCalled()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('reports a failed cleanup exactly once, and still lets the app quit', async () => {
    /*
     * Two claims in one, and the counting one is the harder to get right.
     *
     * A rejected cleanup must not leave the gate vetoing forever — an app that
     * cannot be closed because its shutdown threw is worse than the throw. And it
     * must be **reported**: the gate used to swallow it, so a shutdown that failed
     * let Chorus exit with nothing written down at all, which is the lifecycle
     * failure this whole item exists to expose hiding inside the machinery built
     * to expose it.
     *
     * **Exactly once** is asserted rather than "at least once", and the three
     * quits below are why. A gate that reported per *quit* rather than per
     * *cleanup* would log three times and satisfy any "was it logged?" check; the
     * equality here fails on both a miss and a duplicate. The identity is asserted
     * too, so a reporter handed some other error would not pass either.
     */
    const failure = new Error('close failed')
    const reported: unknown[] = []
    const quit = vi.fn()
    const gate = createQuitGate(
      () => Promise.reject(failure),
      quit,
      (error) => reported.push(error)
    )

    gate.onBeforeQuit({ preventDefault: vi.fn() })
    gate.onBeforeQuit({ preventDefault: vi.fn() })
    gate.onBeforeQuit({ preventDefault: vi.fn() })

    await vi.waitFor(() => {
      expect(quit).toHaveBeenCalledTimes(1)
    })
    expect(reported).toEqual([failure])

    const afterwards = { preventDefault: vi.fn() }
    gate.onBeforeQuit(afterwards)
    expect(afterwards.preventDefault).not.toHaveBeenCalled()
    // And reporting does not resume once the gate has stepped aside.
    expect(reported).toEqual([failure])
  })

  it('leaves no unhandled rejection when the failure reporter itself throws', async () => {
    /*
     * **The first version of this test asserted the wrong consequence**, and a
     * mutation caught it: it checked that the app still quits, which it does with
     * or without the guard — `finally` runs on a rejected chain too, so `quit` is
     * reached either way and the test passed against the defect. Another check
     * that could not fail, written while fixing checks that could not fail.
     *
     * What the guard actually buys is that the chain does not end **rejected**.
     * An unhandled rejection in main is a crash on some Electron configurations,
     * and this one would land at the worst possible moment — the database closing,
     * the workbench server already signalled. So that is what is asserted.
     */
    const seen: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const quit = vi.fn()
      const gate = createQuitGate(
        () => Promise.reject(new Error('close failed')),
        quit,
        () => {
          throw new Error('the logger is gone too')
        }
      )

      gate.onBeforeQuit({ preventDefault: vi.fn() })
      await vi.waitFor(() => {
        expect(quit).toHaveBeenCalledTimes(1)
      })
      // A macrotask turn, because Node raises `unhandledRejection` after the
      // microtask queue drains rather than at the moment of rejection.
      await new Promise((settle) => setTimeout(settle, 50))

      expect(seen).toEqual([])
      // Still quits, which is the other half and is cheap to keep.
      expect(quit).toHaveBeenCalledTimes(1)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

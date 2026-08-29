import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WorkbenchFrame } from './WorkbenchFrame.js'

/**
 * The throwaway panel preflight §4.2 budgets for, and nothing more.
 *
 * Phase 1's product shape is project tabs, but nobody has demonstrated two
 * `monaco-vscode-api` workbenches alive at once — the maintainer's own demo runs
 * one and reinitialises it. So the first thing built is not a tab strip, it is
 * the falsification instrument: two surfaces, two roots, and a close button on
 * each, because **destroying one and finding the other still works** is the whole
 * question. It is deliberately not wired into the session layout: a real
 * integration would put a tab-state bug in front of the answer.
 *
 * Reached with ⌃⌥W, and mounted beside `App` rather than inside it so it is
 * reachable in every state the shell can be in, including the one where no
 * session exists.
 */
/**
 * A pane holds what main gave it back, and the pair travels together.
 *
 * The grant is what opens the surface; the root is what the person reads. Two
 * fields rather than one because they answer to different things — the root is
 * the same string across a reload, the grant is not, since a capability dies with
 * the document it was minted for.
 */
interface Pane {
  readonly key: number
  readonly project: { readonly grant: string; readonly projectRoot: string } | null
}

export function WorkbenchProbe(): React.JSX.Element | null {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [panes, setPanes] = useState<readonly Pane[]>([
    { key: 1, project: null },
    { key: 2, project: null },
  ])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // ⌃⌥W. `event.code`, not `event.key`: with Alt held, macOS reports `key`
      // as `∑` and a comparison against 'w' silently never matches.
      if (event.ctrlKey && event.altKey && event.code === 'KeyW') {
        event.preventDefault()
        setOpen((was) => !was)
        return
      }
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  /*
   * `chooseWorkbenchProject`, not the shell's generic `chooseDirectory`.
   *
   * They open the same dialog, and only one of them mints anything: the generic
   * one hands back a path, which is precisely what `workbench:open` no longer
   * accepts. Choosing here *is* the authorisation, so the trip through main is
   * not plumbing that could be skipped by remembering the path.
   */
  const choose = useCallback(async (key: number) => {
    const { chosen } = await window.chorus.chooseWorkbenchProject()
    if (chosen === null) return
    setPanes((current) =>
      current.map((pane) => (pane.key === key ? { ...pane, project: chosen } : pane))
    )
  }, [])

  /*
   * Closing remounts the pane under a fresh key rather than reusing the old one.
   * The surface is destroyed by `WorkbenchFrame`'s unmount, and reusing the key
   * would let React reconcile a new root onto the same element — which would
   * reuse a `WebContents` whose realm has already initialised the library, the
   * one thing it cannot do twice.
   */
  const close = useCallback((key: number) => {
    setPanes((current) =>
      current.map((pane) => (pane.key === key ? { key: pane.key + 100, project: null } : pane))
    )
  }, [])

  if (!open) return null

  return (
    <div className="workbench-probe" role="dialog" aria-label={t('workbench.probeTitle')}>
      <header className="workbench-probe-bar">
        <strong>{t('workbench.probeTitle')}</strong>
        <span className="workbench-probe-hint">{t('workbench.probeHint')}</span>
        <button
          type="button"
          onClick={() => {
            setOpen(false)
          }}
        >
          {t('workbench.dismiss')}
        </button>
      </header>
      {error !== null && <p className="workbench-probe-error">{error}</p>}
      <div className="workbench-probe-panes">
        {panes.map((pane) => (
          <section className="workbench-probe-pane" key={pane.key}>
            <header className="workbench-probe-pane-bar">
              <code>{pane.project?.projectRoot ?? t('workbench.noFolder')}</code>
              {pane.project === null ? (
                <button
                  type="button"
                  onClick={() => {
                    void choose(pane.key)
                  }}
                >
                  {t('workbench.chooseFolder')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    close(pane.key)
                  }}
                >
                  {t('workbench.closeSurface')}
                </button>
              )}
            </header>
            {pane.project !== null && (
              <WorkbenchFrame
                target={{ grant: pane.project.grant }}
                projectRoot={pane.project.projectRoot}
                onFailed={setError}
              />
            )}
          </section>
        ))}
      </div>
    </div>
  )
}

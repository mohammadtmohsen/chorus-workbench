import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { terminalRefKey, type TerminalRefShape } from '../../shared/ipc.js'
import type { RunState } from '../../shared/run-ipc.js'
import type { TerminalTab } from '../../shared/workspace-layout.js'
import { ConfirmKillTerminal } from './ConfirmKillTerminal.js'
import { answerShellClose, requestShellClose, useShellCloses } from './project-shell-closes.js'
import { TerminalView } from './TerminalView.js'
import { runStatusText } from './TrafficPanel.js'

export function ProjectTerminalPane(props: {
  readonly projectId: string
  readonly run: RunState | null
  readonly shells: readonly TerminalTab[]
  readonly onAddShell: (projectId: string) => string
  readonly onRemoveShell: (projectId: string, id: string) => void
  readonly onReveal: (slot: HTMLElement) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { projectId, shells, onReveal } = props
  const started = props.run !== null && props.run.process.kind !== 'idle'
  const runRef: TerminalRefShape = { scope: 'project', projectId, id: 'run' }
  const [opened, setOpened] = useState<string | null>(null)
  const { question, closingId, moving } = useShellCloses(projectId)
  const slots = useRef<HTMLDivElement>(null)
  const revealing = useRef<string | null>(null)

  useEffect(() => {
    const id = revealing.current
    if (id === null) return
    const candidates = slots.current?.querySelectorAll<HTMLElement>('[data-shell-id]') ?? []
    const slot = [...candidates].find((element) => element.dataset['shellId'] === id)
    if (slot === undefined) return
    revealing.current = null
    onReveal(slot)
  })

  const addShell = (): void => {
    if (moving) return
    const id = props.onAddShell(projectId)
    revealing.current = id
    setOpened(id)
  }

  return (
    <>
      <div className="conversation-dock">
        <div className="conversation-dock-tabs">
          <div
            className="conversation-dock-tab"
            data-project-terminal-tab="true"
            data-active="true"
          >
            <span className="conversation-dock-tab-main">
              <span className="conversation-dock-tab-title">{t('runPane.title')}</span>
              <span className="project-terminal-state">{runStatusText(props.run, t)}</span>
            </span>
          </div>
        </div>
        <button
          type="button"
          className="conversation-dock-add"
          aria-label={t('runPane.split')}
          title={t('runPane.split')}
          disabled={moving}
          onClick={addShell}
        >
          +
        </button>
      </div>
      <div className="conversation-body project-terminal-body">
        <div className="project-terminal-slots" ref={slots}>
          <section
            key={terminalRefKey(runRef)}
            className="project-terminal-slot project-terminal-slot--run"
            aria-label={t('runPane.run')}
          >
            <div className="project-terminal-slot-head">
              <span className="project-terminal-slot-title">{t('runPane.run')}</span>
            </div>
            {started ? (
              <TerminalView terminal={runRef} label={t('runPane.run')} />
            ) : (
              <div className="project-terminal-empty">
                <p>{t('runPane.empty')}</p>
              </div>
            )}
          </section>
          {shells.map((shell, index) => {
            const ref: TerminalRefShape = { scope: 'shell', projectId, id: shell.id }
            const label = t('runPane.shellLabel', { n: index + 1 })
            return (
              <section
                key={terminalRefKey(ref)}
                className="project-terminal-slot"
                data-shell-id={shell.id}
                aria-label={label}
              >
                <div className="project-terminal-slot-head">
                  <span className="project-terminal-slot-title">{label}</span>
                  {shells.length > 1 && (
                    <button
                      type="button"
                      className="project-terminal-slot-close"
                      aria-label={t('runPane.closeShell', { name: label })}
                      title={t('runPane.closeShell', { name: label })}
                      disabled={closingId !== null || moving}
                      onClick={() => {
                        requestShellClose(
                          { scope: 'shell', projectId, id: shell.id },
                          label,
                          props.onRemoveShell
                        )
                      }}
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  )}
                </div>
                {shell.id === closingId ? (
                  <div className="project-terminal-empty">
                    <p>{t('runPane.closing')}</p>
                  </div>
                ) : (
                  <TerminalView terminal={ref} label={label} focusOnOpen={shell.id === opened} />
                )}
              </section>
            )
          })}
        </div>
      </div>
      {question !== null && (
        <ConfirmKillTerminal
          process={question.process}
          onConfirm={() => {
            answerShellClose(projectId, true)
          }}
          onCancel={() => {
            answerShellClose(projectId, false)
          }}
        />
      )}
    </>
  )
}

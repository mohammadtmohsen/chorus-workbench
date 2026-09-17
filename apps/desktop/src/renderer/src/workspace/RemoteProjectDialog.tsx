import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { IpcResponse } from '../../../shared/ipc.js'
import { useDialog } from '../useDialog.js'

type HostCheck = IpcResponse<'project:checkRemoteHost'>

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function RemoteProjectDialog(props: {
  readonly onClose: () => void
  readonly onAdd: (host: string, root: string) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const dialog = useDialog<HTMLElement>(props.onClose)
  const [host, setHost] = useState('')
  const [root, setRoot] = useState('')
  const [check, setCheck] = useState<HostCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [adding, setAdding] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const runCheck = (): void => {
    setProblem(null)
    setCheck(null)
    setChecking(true)
    window.chorus
      .checkRemoteHost({ host: host.trim() })
      .then(setCheck)
      .catch((error: unknown) => {
        setProblem(messageOf(error))
      })
      .finally(() => {
        setChecking(false)
      })
  }

  const add = (): void => {
    setProblem(null)
    setAdding(true)
    props
      .onAdd(host.trim(), root.trim())
      .catch((error: unknown) => {
        setProblem(messageOf(error))
      })
      .finally(() => {
        setAdding(false)
      })
  }

  const reason = (detail: string): string => (detail === '' ? t('remoteProject.noReason') : detail)

  const describeCheck = (result: HostCheck): string => {
    if (!result.reachable) {
      return t('remoteProject.unreachable', { detail: reason(result.detail) })
    }
    if (result.platform === null) {
      return t('remoteProject.notWindows', { detail: reason(result.detail) })
    }
    if (!result.quotingHolds) {
      return t('remoteProject.quotingBroken', { platform: result.platform })
    }
    return t('remoteProject.reachable', { platform: result.platform })
  }

  let status = t('remoteProject.hint')
  if (checking) status = t('remoteProject.checkingHint')
  else if (check !== null) status = describeCheck(check)

  const busy = checking || adding

  return (
    <div className="sheet-backdrop" role="presentation">
      <section
        ref={dialog}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('remoteProject.title')}
      >
        <header className="sheet-head">
          <strong>{t('remoteProject.title')}</strong>
        </header>

        <label className="field">
          <span>{t('remoteProject.host')}</span>
          <input
            data-remote-host
            value={host}
            placeholder={t('remoteProject.hostPlaceholder')}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(event) => {
              setHost(event.target.value)
              setCheck(null)
            }}
          />
        </label>

        <label className="field">
          <span>{t('remoteProject.root')}</span>
          <input
            data-remote-root
            value={root}
            placeholder={t('remoteProject.rootPlaceholder')}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(event) => {
              setRoot(event.target.value)
            }}
          />
        </label>

        <p className="hint" role="status">{status}</p>
        {problem !== null && <p className="hint" role="alert">{problem}</p>}

        <div className="sheet-actions">
          <button
            type="button"
            className="btn"
            data-remote-check
            onClick={runCheck}
            disabled={busy || host.trim() === ''}
          >
            {checking ? t('remoteProject.checking') : t('remoteProject.check')}
          </button>
          <button type="button" className="btn" onClick={props.onClose}>
            {t('remoteProject.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--go"
            data-remote-add
            onClick={add}
            disabled={busy || host.trim() === '' || root.trim() === ''}
          >
            {adding ? t('remoteProject.adding') : t('remoteProject.add')}
          </button>
        </div>
      </section>
    </div>
  )
}

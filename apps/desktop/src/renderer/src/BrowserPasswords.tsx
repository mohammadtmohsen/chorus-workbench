import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type {
  BrowserFailure,
  BrowserPasswordDecision,
  BrowserPasswordPrompt,
  BrowserPasswords as PasswordList,
  BrowserState,
} from '../../shared/browser-ipc.js'

interface Chooser {
  readonly request: number
  readonly documentId: string | null
  readonly origin: string | null
  readonly passwords: PasswordList | null
  readonly failure: BrowserFailure | null
}

interface PromptFailure {
  readonly candidateId: string
  readonly message: string
}

export function BrowserPasswords(props: {
  readonly browserId: string | null
  readonly state: BrowserState | null
  readonly prompt: BrowserPasswordPrompt | null
  readonly passwords: PasswordList | null
  readonly buttonHost: HTMLElement | null
  readonly onPrompt: (candidateId: string) => void
}): React.JSX.Element {
  const { browserId, state, prompt, onPrompt } = props
  const { t } = useTranslation()
  const idRef = useRef(browserId)
  idRef.current = browserId
  const chooserRequest = useRef(0)
  const [chooser, setChooser] = useState<Chooser | null>(null)
  const [promptFailure, setPromptFailure] = useState<PromptFailure | null>(null)
  useEffect(() => {
    idRef.current = browserId
    return () => {
      idRef.current = null
    }
  }, [browserId])
  useEffect(() => {
    setPromptFailure(null)
  }, [prompt])
  useEffect(() => {
    const passwords = props.passwords
    if (passwords === null) return
    setChooser((open) =>
      open !== null && open.origin === passwords.origin ? { ...open, passwords } : open
    )
  }, [props.passwords])
  const documentId = state?.documentId ?? null
  const passwordOrigin = state?.passwordOrigin ?? null
  const shownChooser =
    chooser !== null && chooser.documentId === documentId && chooser.origin === passwordOrigin
      ? chooser
      : null

  const updateChooser = (request: number, change: (open: Chooser) => Chooser): void => {
    setChooser((open) => (open !== null && open.request === request ? change(open) : open))
  }

  const failChooser = (id: string, request: number, failure: BrowserFailure): void => {
    if (idRef.current === id) updateChooser(request, (open) => ({ ...open, failure }))
  }

  const acceptPasswords = (
    id: string,
    request: number,
    passwords: PasswordList,
    failure: BrowserFailure | null
  ): void => {
    if (idRef.current !== id) return
    updateChooser(request, (open) =>
      passwords.origin === open.origin
        ? { ...open, passwords, failure }
        : { ...open, failure: 'stale-document' }
    )
  }

  const openChooser = (): void => {
    const id = idRef.current
    if (id === null) return
    chooserRequest.current += 1
    const request = chooserRequest.current
    setChooser({
      request,
      documentId,
      origin: passwordOrigin,
      passwords: null,
      failure: null,
    })
    window.chorus
      .readBrowserPasswords({ browserId: id })
      .then((reply) => {
        acceptPasswords(id, request, reply.passwords, reply.failure)
      })
      .catch(() => {
        failChooser(id, request, 'failed')
      })
  }

  const toggleChooser = (): void => {
    if (shownChooser === null) openChooser()
    else setChooser(null)
  }

  const decide = (decision: BrowserPasswordDecision): void => {
    const id = idRef.current
    const offer = prompt
    if (id === null || offer === null) return
    const open = shownChooser
    const candidateId = offer.candidateId
    window.chorus
      .decideBrowserPassword({ browserId: id, candidateId, decision })
      .then((reply) => {
        if (idRef.current !== id) return
        if (reply.failure === null || reply.failure === 'stale-candidate') {
          onPrompt(candidateId)
          setPromptFailure(null)
          if (open !== null) acceptPasswords(id, open.request, reply.passwords, null)
          return
        }
        setPromptFailure({ candidateId, message: t(`browser.failure.${reply.failure}`) })
      })
      .catch(() => {
        if (idRef.current !== id) return
        setPromptFailure({ candidateId, message: t('browser.failure.failed') })
      })
  }

  const fill = (accountId: string): void => {
    const id = idRef.current
    const open = shownChooser
    if (id === null || open?.documentId == null) return
    const { request } = open
    window.chorus
      .fillBrowserPassword({ browserId: id, accountId, documentId: open.documentId })
      .then((reply) => {
        if (idRef.current !== id) return
        const failure = reply.failure
        if (failure === null) {
          setChooser((current) => (current?.request === request ? null : current))
          return
        }
        updateChooser(request, (current) => ({ ...current, failure }))
      })
      .catch(() => {
        failChooser(id, request, 'failed')
      })
  }

  const removeAccount = (accountId: string): void => {
    const id = idRef.current
    const open = shownChooser
    if (id === null || open === null) return
    const { request } = open
    window.chorus
      .removeBrowserPassword({ browserId: id, accountId })
      .then((reply) => {
        acceptPasswords(id, request, reply.passwords, reply.failure)
      })
      .catch(() => {
        failChooser(id, request, 'failed')
      })
  }

  const allowSaving = (): void => {
    const id = idRef.current
    const open = shownChooser
    if (id === null || open === null) return
    const { request } = open
    window.chorus
      .allowBrowserPasswordSaving({ browserId: id })
      .then((reply) => {
        acceptPasswords(id, request, reply.passwords, reply.failure)
      })
      .catch(() => {
        failChooser(id, request, 'failed')
      })
  }

  const live = state?.live === true
  const passwords = shownChooser?.passwords ?? null
  const unnamed = t('browser.noUsername')
  return (
    <>
      {props.buttonHost !== null &&
        createPortal(
          <button
            type="button"
            className="browser-button browser-button--text"
            aria-label={t('browser.passwords')}
            title={t('browser.passwords')}
            aria-expanded={shownChooser !== null}
            disabled={!live}
            onClick={toggleChooser}
          >
            {t('browser.passwordsShort')}
          </button>,
          props.buttonHost
        )}
      {prompt !== null && (
        <div className="browser-prompt" role="group" aria-label={t('browser.passwords')}>
          <span className="browser-prompt-text">
            {t(prompt.mode === 'update' ? 'browser.updatePrompt' : 'browser.savePrompt', {
              username: prompt.username === '' ? unnamed : prompt.username,
              origin: prompt.origin,
            })}
          </span>
          <span className="browser-help">{t('browser.promptNote')}</span>
          <button
            type="button"
            className="browser-button browser-button--text"
            onClick={() => {
              decide(prompt.mode)
            }}
          >
            {prompt.mode === 'update' ? t('browser.update') : t('browser.save')}
          </button>
          <button
            type="button"
            className="browser-button browser-button--text"
            onClick={() => {
              decide('never')
            }}
          >
            {t('browser.never')}
          </button>
          <button
            type="button"
            className="browser-button browser-button--text"
            onClick={() => {
              decide('dismiss')
            }}
          >
            {t('browser.dismiss')}
          </button>
          {promptFailure?.candidateId === prompt.candidateId && (
            <span role="alert">{promptFailure.message}</span>
          )}
        </div>
      )}
      {shownChooser !== null && (
        <div className="browser-chooser" role="group" aria-label={t('browser.passwords')}>
          {passwords === null && shownChooser.failure === null && (
            <span role="status">{t('browser.chooserLoading')}</span>
          )}
          {passwords !== null && passwords.origin === null && (
            <span>{t('browser.chooserIneligible')}</span>
          )}
          {passwords?.origin != null && (
            <>
              <span className="browser-chooser-title">
                {t('browser.chooserTitle', { origin: passwords.origin })}
              </span>
              {passwords.storage !== 'ready' && (
                <span>{t(`browser.storage.${passwords.storage}`)}</span>
              )}
              {passwords.neverSave && (
                <span className="browser-chooser-never">
                  {t('browser.neverSaving')}
                  <button
                    type="button"
                    className="browser-button browser-button--text"
                    onClick={allowSaving}
                  >
                    {t('browser.allowSaving')}
                  </button>
                </span>
              )}
              {passwords.storage === 'ready' && passwords.accounts.length === 0 && (
                <span>{t('browser.chooserEmpty')}</span>
              )}
              {passwords.accounts.map((account) => {
                const username = account.username === '' ? unnamed : account.username
                return (
                  <span className="browser-account" key={account.id}>
                    <span className="browser-account-name">{username}</span>
                    <button
                      type="button"
                      className="browser-button browser-button--text"
                      aria-label={t('browser.fillAccount', { username })}
                      onClick={() => {
                        fill(account.id)
                      }}
                    >
                      {t('browser.fill')}
                    </button>
                    <button
                      type="button"
                      className="browser-button"
                      aria-label={t('browser.removeAccount', { username })}
                      title={t('browser.removeAccount', { username })}
                      onClick={() => {
                        removeAccount(account.id)
                      }}
                    >
                      ×
                    </button>
                  </span>
                )
              })}
            </>
          )}
          {shownChooser.failure !== null && (
            <span role="alert">{t(`browser.failure.${shownChooser.failure}`)}</span>
          )}
          {passwords !== null && passwords.storage !== 'ready' && (
            <button
              type="button"
              className="browser-button browser-button--text"
              onClick={openChooser}
            >
              {t('browser.retry')}
            </button>
          )}
          <span className="browser-help">{t('browser.googleHelp')}</span>
          <button
            type="button"
            className="browser-button browser-button--text"
            onClick={() => {
              setChooser(null)
            }}
          >
            {t('browser.close')}
          </button>
        </div>
      )}
    </>
  )
}

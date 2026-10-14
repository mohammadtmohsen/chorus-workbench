import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SubmitEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BROWSER_ADDRESS_MAX,
  BROWSER_FIND_MAX,
  BROWSER_HOME_URL,
  BROWSER_RECT_MAX,
  browserAddressOrSearch,
  type BrowserAction,
  type BrowserFailure,
  type BrowserRect,
} from '../../../shared/browser-ipc.js'
import { BrowserPasswords } from '../BrowserPasswords.js'
import { useWorkbenchStill } from './overlay.js'
import {
  actOnWebPage,
  attachWebPage,
  clearWebPrompt,
  findWebPage,
  nextWebRevision,
  updateWebPage,
  updateBrowserDownloads,
  useBrowserDownloads,
  useWebPage,
} from './web-pages.js'

const EMPTY_RECT: BrowserRect = { x: 0, y: 0, width: 0, height: 0 }

function sameRect(left: BrowserRect | null, right: BrowserRect): boolean {
  return (
    left !== null &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  )
}

function coordinate(value: number): number {
  return Math.max(-BROWSER_RECT_MAX, Math.min(BROWSER_RECT_MAX, value))
}

export function WebTabStage(props: { readonly webTabId: string }): React.JSX.Element {
  const { webTabId } = props
  const { t } = useTranslation()
  const page = useWebPage(webTabId)
  const downloads = useBrowserDownloads()
  const browserId = page.browserId
  const state = page.state
  const url = state?.url ?? null
  const currentId = useRef(browserId)
  currentId.current = browserId
  const body = useRef<HTMLDivElement>(null)
  const addressInput = useRef<HTMLInputElement>(null)
  const findInput = useRef<HTMLInputElement>(null)
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [downloadsOpen, setDownloadsOpen] = useState(false)
  const [passwordButtonHost, setPasswordButtonHost] = useState<HTMLSpanElement | null>(null)
  const [failure, setFailure] = useState<BrowserFailure | null>(null)
  const [placed, setPlaced] = useState(false)
  const still = useWorkbenchStill(browserId)
  const lastSent = useRef<BrowserRect | null>(null)
  const lastRect = useRef<BrowserRect>(EMPTY_RECT)
  const frame = useRef<number | null>(null)
  const geometryRevision = useRef(0)
  const focusRequest = page.focusRequest
  const focusedPage = useRef(false)
  const initializedFocus = useRef(false)

  useEffect(() => {
    currentId.current = browserId
    return () => {
      currentId.current = null
    }
  }, [browserId])

  useLayoutEffect(() => {
    if (browserId === null) return
    if (page.focus === 'find') {
      setFindOpen(true)
      findInput.current?.focus()
      findInput.current?.select()
      updateWebPage(webTabId, { focus: null })
    } else if (page.focus === 'address' || (!initializedFocus.current && url === null)) {
      addressInput.current?.focus()
      addressInput.current?.select()
      if (page.focus !== null) updateWebPage(webTabId, { focus: null })
    }
    initializedFocus.current = true
  }, [focusRequest, page.focus, browserId, url, webTabId])

  useLayoutEffect(() => {
    if (!findOpen) return
    findInput.current?.focus()
    findInput.current?.select()
  }, [findOpen])

  const measure = useCallback(() => {
    frame.current = null
    const region = body.current
    if (browserId === null || region === null) return
    const bounds = region.getBoundingClientRect()
    const rect = {
      x: coordinate(bounds.left),
      y: coordinate(bounds.top),
      width: Math.min(BROWSER_RECT_MAX, Math.max(0, bounds.width)),
      height: Math.min(BROWSER_RECT_MAX, Math.max(0, bounds.height)),
    }
    if (sameRect(lastSent.current, rect)) return
    lastSent.current = rect
    lastRect.current = rect
    const revision = nextWebRevision(webTabId)
    geometryRevision.current = revision
    window.chorus
      .setBrowserGeometry({
        browserId,
        revision,
        rect,
        bodyOrigin: { x: rect.x, y: rect.y },
        active: true,
        fullyVisible: rect.width > 0 && rect.height > 0,
      })
      .then(() => {
        if (currentId.current === browserId && geometryRevision.current === revision) {
          setPlaced(true)
        }
      })
      .catch(() => {
        if (lastSent.current === rect) lastSent.current = null
      })
  }, [browserId, webTabId])

  const schedule = useCallback(() => {
    frame.current ??= window.requestAnimationFrame(measure)
  }, [measure])

  useEffect(() => {
    const region = body.current
    if (region === null || browserId === null) return undefined
    setPlaced(false)
    lastSent.current = null
    const observer = new ResizeObserver(schedule)
    observer.observe(region)
    window.addEventListener('resize', schedule)
    schedule()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      if (frame.current !== null) {
        window.cancelAnimationFrame(frame.current)
        frame.current = null
      }
      const rect = lastRect.current
      const revision = nextWebRevision(webTabId)
      geometryRevision.current = revision
      window.chorus
        .setBrowserGeometry({
          browserId,
          revision,
          rect,
          bodyOrigin: { x: rect.x, y: rect.y },
          active: false,
          fullyVisible: false,
        })
        .catch(() => undefined)
    }
  }, [browserId, schedule, webTabId])

  useLayoutEffect(() => {
    schedule()
  })

  useEffect(() => {
    if (
      focusedPage.current ||
      !placed ||
      state?.live !== true ||
      page.focus !== null ||
      findOpen ||
      editing
    ) {
      return
    }
    focusedPage.current = true
    actOnWebPage(webTabId, 'focus')
  }, [state?.live, page.focus, webTabId, findOpen, editing, placed])

  const act = (action: BrowserAction): void => {
    if (browserId === null) return
    window.chorus
      .actOnBrowser({ browserId, action })
      .then((reply) => {
        if (currentId.current !== browserId) return
        updateWebPage(webTabId, { state: reply.state })
        setFailure(reply.failure)
      })
      .catch(() => {
        if (currentId.current === browserId) setFailure('failed')
      })
  }

  const navigate = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const target = browserAddressOrSearch(editing ? address : (state?.url ?? ''))
    if (target === null) {
      setFailure('invalid-address')
      return
    }
    navigateTo(target)
  }

  const navigateTo = (target: string): void => {
    if (browserId === null) return
    window.chorus
      .navigateBrowser({ browserId, address: target })
      .then((reply) => {
        if (currentId.current !== browserId) return
        updateWebPage(webTabId, { state: reply.state })
        setFailure(reply.failure)
        if (reply.failure === null) {
          setEditing(false)
          actOnWebPage(webTabId, 'focus')
        }
      })
      .catch(() => {
        if (currentId.current === browserId) setFailure('failed')
      })
  }

  const closeFind = (): void => {
    setFindOpen(false)
    updateWebPage(webTabId, { found: null, focus: null })
    act('find-stop')
    actOnWebPage(webTabId, 'focus')
  }

  const downloadAction = (
    downloadId: string,
    action: 'open' | 'show' | 'cancel' | 'clear'
  ): void => {
    window.chorus
      .actOnBrowserDownload({ downloadId, action })
      .then((reply) => {
        updateBrowserDownloads(reply.downloads)
        if (currentId.current === browserId) setFailure(reply.failure)
      })
      .catch(() => {
        if (currentId.current === browserId) setFailure('failed')
      })
  }

  const ready = browserId !== null && state !== null
  const live = state?.live === true
  const loading = state?.status === 'loading'
  const loadError = state?.error ?? null
  return (
    <section
      className="web-stage"
      id="web-tab-stage"
      role="tabpanel"
      aria-labelledby={`web-tab-${webTabId}`}
    >
      <div className="web-stage-toolbar">
        <button
          type="button"
          className="browser-button"
          aria-label={t('webTabs.back')}
          title={t('webTabs.back')}
          disabled={state?.canGoBack !== true}
          onClick={() => {
            act('back')
          }}
        >
          ←
        </button>
        <button
          type="button"
          className="browser-button"
          aria-label={t('webTabs.forward')}
          title={t('webTabs.forward')}
          disabled={state?.canGoForward !== true}
          onClick={() => {
            act('forward')
          }}
        >
          →
        </button>
        <button
          type="button"
          className="browser-button"
          aria-label={loading ? t('webTabs.stop') : t('webTabs.reload')}
          title={loading ? t('webTabs.stop') : t('webTabs.reload')}
          disabled={!live}
          onClick={() => {
            act(loading ? 'stop' : 'reload')
          }}
        >
          {loading ? '×' : '↻'}
        </button>
        <button
          type="button"
          className="browser-button"
          aria-label={t('webTabs.home')}
          title={t('webTabs.home')}
          disabled={!ready}
          onClick={() => {
            navigateTo(BROWSER_HOME_URL)
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9" />
          </svg>
        </button>
        <form className="browser-address" onSubmit={navigate}>
          <input
            ref={addressInput}
            className="browser-address-input"
            type="text"
            spellCheck={false}
            autoComplete="off"
            maxLength={BROWSER_ADDRESS_MAX}
            aria-label={t('webTabs.address')}
            placeholder={t('webTabs.addressPlaceholder')}
            disabled={!ready}
            value={editing ? address : (url ?? '')}
            onFocus={() => {
              setAddress(url ?? '')
              setEditing(true)
            }}
            onBlur={() => {
              setEditing(false)
            }}
            onChange={(event) => {
              setAddress(event.target.value)
              setEditing(true)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setEditing(false)
                actOnWebPage(webTabId, 'focus')
              }
              if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
            }}
          />
        </form>
        {state !== null && Math.abs(state.zoom - 1) > 0.001 && (
          <button
            type="button"
            className="browser-button browser-button--text"
            title={t('webTabs.resetZoom')}
            aria-label={t('webTabs.resetZoom')}
            onClick={() => {
              act('zoom-reset')
            }}
          >
            {t('webTabs.zoom', { value: Math.round(state.zoom * 100) })}
          </button>
        )}
        <button
          type="button"
          className="browser-button browser-button--text"
          title={t('webTabs.find')}
          aria-label={t('webTabs.find')}
          aria-expanded={findOpen}
          disabled={!live}
          onClick={() => {
            if (findOpen) closeFind()
            else setFindOpen(true)
          }}
        >
          {t('webTabs.findShort')}
        </button>
        <button
          type="button"
          className="browser-button browser-button--text"
          title={t('webTabs.downloads')}
          aria-label={t('webTabs.downloads')}
          aria-expanded={downloadsOpen}
          onClick={() => {
            setDownloadsOpen(!downloadsOpen)
          }}
        >
          {t('webTabs.downloadsShort')}
        </button>
        <span className="browser-password-button" ref={setPasswordButtonHost} />
        <button
          type="button"
          className="browser-button browser-button--text"
          title={t('webTabs.devtools')}
          aria-label={t('webTabs.devtools')}
          disabled={!live}
          onClick={() => {
            act('devtools')
          }}
        >
          {t('webTabs.devtoolsShort')}
        </button>
        <button
          type="button"
          className="browser-button"
          title={t('webTabs.external')}
          aria-label={t('webTabs.external')}
          disabled={url === null}
          onClick={() => {
            act('external')
          }}
        >
          ↗
        </button>
      </div>
      {findOpen && (
        <div className="web-stage-find">
          <input
            ref={findInput}
            type="text"
            className="browser-address-input"
            maxLength={BROWSER_FIND_MAX}
            aria-label={t('webTabs.find')}
            placeholder={t('webTabs.findPlaceholder')}
            value={page.findText}
            onChange={(event) => {
              updateWebPage(webTabId, { findText: event.target.value, found: null })
              if (event.target.value === '') act('find-stop')
              else findWebPage(webTabId, true, true)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                closeFind()
              }
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                findWebPage(webTabId, !event.shiftKey, false)
              }
            }}
          />
          <span role="status">
            {page.found === null ? '' : t('webTabs.findResult', page.found)}
          </span>
          <button
            type="button"
            className="browser-button"
            aria-label={t('webTabs.findPrevious')}
            onClick={() => {
              findWebPage(webTabId, false, false)
            }}
          >
            ↑
          </button>
          <button
            type="button"
            className="browser-button"
            aria-label={t('webTabs.findNext')}
            onClick={() => {
              findWebPage(webTabId, true, false)
            }}
          >
            ↓
          </button>
          <button
            type="button"
            className="browser-button"
            aria-label={t('webTabs.closeFind')}
            onClick={closeFind}
          >
            ×
          </button>
        </div>
      )}
      <BrowserPasswords
        browserId={browserId}
        state={state}
        prompt={page.prompt}
        passwords={page.passwords}
        buttonHost={passwordButtonHost}
        onPrompt={(candidateId) => {
          clearWebPrompt(webTabId, candidateId)
        }}
      />
      {downloadsOpen && (
        <div className="web-stage-downloads" role="group" aria-label={t('webTabs.downloads')}>
          {downloads.length === 0 && <span>{t('webTabs.downloadsEmpty')}</span>}
          {downloads.map((download) => {
            const progressing = download.state === 'progressing' || download.state === 'paused'
            return (
              <div className="web-stage-download" key={download.id}>
                <span className="web-stage-download-name" title={download.filename}>
                  {download.filename}
                </span>
                <span>{t(`webTabs.downloadState.${download.state}`)}</span>
                {progressing && (
                  <progress
                    value={download.received}
                    max={Math.max(1, download.total)}
                    aria-label={t('webTabs.downloadProgress', {
                      received: download.received,
                      total: download.total,
                    })}
                  />
                )}
                {download.state === 'completed' && (
                  <>
                    <button
                      type="button"
                      className="browser-button browser-button--text"
                      onClick={() => {
                        downloadAction(download.id, 'open')
                      }}
                    >
                      {t('webTabs.downloadOpen')}
                    </button>
                    <button
                      type="button"
                      className="browser-button browser-button--text"
                      onClick={() => {
                        downloadAction(download.id, 'show')
                      }}
                    >
                      {t('webTabs.downloadShow')}
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="browser-button browser-button--text"
                  onClick={() => {
                    downloadAction(download.id, progressing ? 'cancel' : 'clear')
                  }}
                >
                  {progressing ? t('webTabs.downloadCancel') : t('webTabs.downloadClear')}
                </button>
              </div>
            )
          })}
        </div>
      )}
      {(failure !== null || page.settings !== 'ready' || loadError !== null) && (
        <div className="web-stage-notice" role="status">
          {page.settings !== 'ready' && <span>{t(`webTabs.settings.${page.settings}`)}</span>}
          {loadError !== null && <span>{t('webTabs.loadFailed', loadError)}</span>}
          {failure !== null && (
            <>
              <span>{t(`webTabs.failure.${failure}`)}</span>
              <button
                type="button"
                className="browser-button browser-button--text"
                onClick={() => {
                  setFailure(null)
                }}
              >
                {t('webTabs.dismissNotice')}
              </button>
            </>
          )}
        </div>
      )}
      <div className="web-stage-body" ref={body}>
        {still !== null ? (
          <img
            className="workbench-still"
            src={still}
            alt=""
            aria-hidden="true"
            draggable={false}
          />
        ) : page.failed ? (
          <div className="web-stage-empty">
            <p>{t('webTabs.attachFailed')}</p>
            <button
              type="button"
              className="browser-button"
              onClick={() => {
                void attachWebPage(webTabId)
              }}
            >
              {t('webTabs.retry')}
            </button>
          </div>
        ) : !ready ? (
          <div className="web-stage-empty" role="status">
            {t('webTabs.attaching')}
          </div>
        ) : url === null || url === 'about:blank' ? (
          <div className="web-stage-empty">
            <p>{t('webTabs.emptyTitle')}</p>
            <small>{t('webTabs.emptyHint')}</small>
          </div>
        ) : null}
      </div>
    </section>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DEFAULT_LOGCAT_FILTER,
  DEFAULT_TRAFFIC_PORT,
  terminalRefKey,
  type TerminalRefShape,
  type TrafficRowShape,
  type TrafficSourceShape,
} from '../../shared/ipc.js'
import type {
  TrafficFailure,
  TrafficLegacy,
  TrafficPush,
  TrafficState,
} from '../../shared/traffic-ipc.js'
import { TrafficRequestInspector } from './TrafficRequestInspector.js'
import { filterRows, outcomeOf, pageOf, type TrafficOutcome } from './traffic-filter.js'
import {
  applySnapshot,
  EMPTY_TRAFFIC,
  pendingUntilAttached,
  reduceTraffic,
  type TrafficAttachment,
  type TrafficStream,
} from './traffic-stream.js'

export interface TrafficTerminalOption {
  readonly ref: TerminalRefShape
  readonly label: string
}

const sourceValue = (source: TrafficSourceShape): string =>
  source.kind === 'off' ? '' : source.kind === 'logcat' ? 'logcat' : terminalRefKey(source.ref)

const idle: TrafficState = {
  capturing: false,
  port: null,
  wantedPort: null,
  address: null,
  origin: null,
  access: 'loopback',
  envVar: null,
  source: { kind: 'off' },
  failure: null,
}

const FAILURE_KEYS: Record<TrafficFailure, string> = {
  'in-use': 'traffic.portInUse',
  failed: 'traffic.startFailed',
  'source-busy': 'traffic.sourceBusy',
  'unknown-project': 'traffic.unknownProject',
  capturing: 'traffic.portCapturing',
  'no-port': 'traffic.noPort',
  'no-origin': 'traffic.noOrigin',
  'ownership-unknown': 'traffic.ownershipUnknown',
  unresolved: 'traffic.unresolved',
}

export function TrafficPanel(props: {
  readonly projectId: string
  readonly terminals: readonly TrafficTerminalOption[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const { projectId } = props
  const [stream, setStream] = useState<TrafficStream>(EMPTY_TRAFFIC)
  const [capture, setCapture] = useState<TrafficState>(idle)
  const [legacy, setLegacy] = useState<TrafficLegacy | null>(null)
  const [portDraft, setPortDraft] = useState(String(DEFAULT_TRAFFIC_PORT))
  const [originDraft, setOriginDraft] = useState('')
  const [envVarDraft, setEnvVarDraft] = useState('')
  const [filters, setFilters] = useState(DEFAULT_LOGCAT_FILTER)
  const [failure, setFailure] = useState<TrafficFailure | 'action' | 'origin' | null>(null)
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  /** Null means the last page, which keeps following as rows arrive. */
  const [page, setPage] = useState<number | null>(null)

  // A selection belongs to the project's history, not to the panel: switching
  // project closes whatever was open rather than describing the wrong one.
  useEffect(() => {
    setSelectedSeq(null)
  }, [projectId])

  useEffect(() => {
    let attachment: TrafficAttachment | null = null
    let queued: TrafficPush[] = []
    let cancelled = false

    const stopListening = window.chorus.onTraffic((push) => {
      if (attachment === null) {
        queued.push(push)
        return
      }
      setStream((previous) => reduceTraffic(previous, push))
      /*
       * Every kind, and that is the fix rather than a tidy-up.
       *
       * The credit model holds one delivery outstanding until it is
       * acknowledged, so a kind this handler did not name — `resync`, which is
       * sent when a stalled view's queue overflows — left main holding a push
       * forever and every later row queued behind it, with nothing on screen to
       * say so.
       */
      void window.chorus.ackTraffic({
        projectId,
        subscriptionId: attachment.subscriptionId,
        seq: push.kind === 'rows' ? push.seq : attachment.seq,
      })
      if (push.kind === 'state') setCapture(push.state)
    })

    void window.chorus
      .attachTraffic({ projectId })
      .then((opened) => {
        if (cancelled) {
          void window.chorus.detachTraffic({
            projectId,
            subscriptionId: opened.subscriptionId,
          })
          return
        }
        attachment = {
          projectId,
          subscriptionId: opened.subscriptionId,
          captureId: opened.captureId,
          seq: opened.seq,
          rows: opened.rows,
        }
        setStream(pendingUntilAttached(queued, attachment))
        queued = []
        /*
         * Anything main sent between this listener being registered and the
         * attachment arriving was queued above and could not be acknowledged —
         * there was no subscription id to name yet. Main is holding its one
         * outstanding delivery on it, so the credit is released here or the
         * stream never starts.
         */
        void window.chorus.ackTraffic({
          projectId,
          subscriptionId: opened.subscriptionId,
          seq: opened.seq,
        })
        setCapture(opened.state)
        setPortDraft(String(opened.state.wantedPort ?? DEFAULT_TRAFFIC_PORT))
        setOriginDraft(opened.state.origin ?? '')
        setEnvVarDraft(opened.state.envVar ?? '')
        if (opened.state.source.kind === 'logcat') setFilters(opened.state.source.filters)
      })
      .catch(() => {
        setFailure('action')
      })

    return () => {
      cancelled = true
      stopListening()
      if (attachment !== null) {
        void window.chorus.detachTraffic({ projectId, subscriptionId: attachment.subscriptionId })
      }
    }
  }, [projectId])

  useEffect(() => {
    void window.chorus
      .readTrafficLegacy({})
      .then(setLegacy)
      .catch(() => {
        setLegacy(null)
      })
  }, [])

  /** A paused view asks for one snapshot rather than retrying by itself. */
  const resume = useCallback((): void => {
    if (stream.subscriptionId === '') return
    void window.chorus
      .snapshotTraffic({ projectId, subscriptionId: stream.subscriptionId, seq: stream.seq })
      .then((page) => {
        setStream((previous) => applySnapshot(previous, page))
      })
      .catch(() => {
        setFailure('action')
      })
  }, [projectId, stream.subscriptionId, stream.seq])

  const select = useCallback(
    (next: TrafficSourceShape): void => {
      void window.chorus
        .selectTrafficSource({ projectId, source: next })
        .then(({ state }) => {
          setCapture(state)
          setFailure(state.failure)
        })
        .catch(() => {
          setFailure('action')
        })
    },
    [projectId]
  )

  const choose = useCallback(
    (value: string): void => {
      if (value === '') {
        select({ kind: 'off' })
        return
      }
      if (value === 'logcat') {
        select({ kind: 'logcat', filters })
        return
      }
      const ref = props.terminals.find((option) => terminalRefKey(option.ref) === value)?.ref
      select(ref === undefined ? { kind: 'off' } : { kind: 'terminal', ref })
    },
    [props.terminals, filters, select]
  )

  const commitFilters = useCallback((): void => {
    const next = filters.trim() === '' ? DEFAULT_LOGCAT_FILTER : filters.trim()
    setFilters(next)
    if (capture.source.kind === 'logcat') select({ kind: 'logcat', filters: next })
  }, [filters, capture.source, select])

  const commitOrigin = useCallback((): void => {
    void window.chorus
      .configureTraffic({ projectId, config: { origin: originDraft.trim() } })
      .then(({ state, failure: refused }) => {
        setCapture(state)
        setFailure(refused)
        if (refused === null) setOriginDraft(state.origin ?? '')
      })
      .catch(() => {
        setFailure('origin')
      })
  }, [projectId, originDraft])

  const commitPort = useCallback((): void => {
    const parsed = Number(portDraft.trim())
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
      setPortDraft(String(capture.wantedPort ?? DEFAULT_TRAFFIC_PORT))
      setFailure('action')
      return
    }
    void window.chorus
      .configureTraffic({ projectId, config: { port: parsed } })
      .then(({ state, failure: refused }) => {
        setCapture(state)
        setFailure(refused)
        if (refused !== null) setPortDraft(String(state.wantedPort ?? DEFAULT_TRAFFIC_PORT))
      })
      .catch(() => {
        setFailure('action')
      })
  }, [projectId, portDraft, capture.wantedPort])

  const commitEnvVar = useCallback((): void => {
    const name = envVarDraft.trim()
    void window.chorus
      .configureTraffic({ projectId, config: { envVar: name === '' ? null : name } })
      .then(({ state, failure: refused }) => {
        setCapture(state)
        setFailure(refused)
        setEnvVarDraft(state.envVar ?? '')
      })
      .catch(() => {
        setFailure('action')
      })
  }, [projectId, envVarDraft])

  const copy = useCallback((text: string): void => {
    void window.chorus.copyText({ text })
  }, [])

  const envLine =
    capture.address === null
      ? null
      : capture.envVar === null
        ? `http://${capture.address}`
        : `${capture.envVar}=http://${capture.address}`

  const toggle = useCallback((): void => {
    const call = capture.capturing
      ? window.chorus.stopTraffic({ projectId })
      : window.chorus.startTraffic({ projectId })
    void call
      .then(({ state }) => {
        setCapture(state)
        setFailure(state.failure)
        setPortDraft(String(state.wantedPort ?? DEFAULT_TRAFFIC_PORT))
      })
      .catch(() => {
        setFailure('action')
      })
  }, [projectId, capture.capturing])

  const decide = useCallback((keep: boolean): void => {
    void window.chorus
      .decideTrafficLegacy({ keep })
      .then(({ legacy: next }) => {
        setLegacy(next)
      })
      .catch(() => {
        setFailure('action')
      })
  }, [])

  const OUTCOME_LABELS: Record<TrafficOutcome, string> = {
    read: 'traffic.outcomeRead',
    refused: 'traffic.outcomeRefused',
    backend: 'traffic.outcomeBackend',
    unreadable: 'traffic.outcomeUnreadable',
    aborted: 'traffic.outcomeAborted',
  }

  /*
   * A new question starts at the newest answer — keeping a page number across a
   * change to the search would show a middle page of a list nobody has looked
   * at yet.
   */
  const searchFor = (next: string): void => {
    setSearch(next)
    setPage(null)
  }

  const statusClassOf = (row: Extract<TrafficRowShape, { source: 'http' }>): string => {
    if (row.aborted || row.status === null) return 'none'
    return `${String(Math.floor(row.status / 100))}xx`
  }

  const onRowKeyDown = (event: React.KeyboardEvent<HTMLUListElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('.traffic-row-button')]
    const at = buttons.indexOf(document.activeElement as HTMLElement)
    const next = buttons[at + (event.key === 'ArrowDown' ? 1 : -1)]
    if (at === -1 || next === undefined) return
    event.preventDefault()
    next.focus()
  }

  const outcomeBadge = (row: Extract<TrafficRowShape, { source: 'http' }>): React.JSX.Element => (
    <span className="traffic-outcome" data-outcome={outcomeOf(row)}>
      {t(OUTCOME_LABELS[outcomeOf(row)])}
    </span>
  )

  const bodyOf = (row: TrafficRowShape): React.JSX.Element => {
    if (row.source === 'logcat') {
      return (
        <span className="traffic-line" title={row.line}>
          {row.line}
        </span>
      )
    }
    if (row.source === 'log') {
      return row.exit === null ? (
        <span className="traffic-line" title={row.line}>
          {row.line}
        </span>
      ) : (
        <span className="traffic-exit">{t('terminal.processExited', { code: row.exit })}</span>
      )
    }
    return (
      <>
        <span className="traffic-method" data-method={row.m.toUpperCase()}>
          {row.m}
        </span>
        <span className="traffic-url" title={row.u}>
          {row.u}
        </span>
        <span className="traffic-status" data-class={statusClassOf(row)}>
          {row.status ?? '—'}
        </span>
        {outcomeBadge(row)}
        <span className="traffic-note">
          {row.code !== null && <span className="traffic-code">{row.code}</span>}
          {row.nextAction !== null && <span className="traffic-next">{row.nextAction}</span>}
        </span>
      </>
    )
  }

  const filtered = filterRows(stream.rows, search)
  const paged = pageOf(filtered, page)
  const shown = paged.rows

  const goTo = (index: number): void => {
    // Landing on the last page resumes following, so a capture that keeps
    // producing rows does not leave the person behind.
    setPage(index >= paged.count - 1 ? null : index)
  }

  /*
   * Selection is held by sequence, not by row object.
   *
   * A request writes its row twice, so holding the object would leave the
   * inspector showing the pending copy after the answer arrived — the row is
   * looked up again each render and the open detail follows it. A row that has
   * left the stream, because history was cleared or the window moved past it,
   * takes the selection with it rather than leaving a panel describing
   * something that is no longer listed.
   */
  const selected =
    selectedSeq === null
      ? null
      : (stream.rows.find(
          (row): row is Extract<TrafficRowShape, { source: 'http' }> =>
            row.source === 'http' && row.seq === selectedSeq
        ) ?? null)

  return (
    <section className="traffic-panel" aria-label={t('traffic.title')}>
      <header className="traffic-head">
        <span className="traffic-title">{t('traffic.title')}</span>
        <span className="traffic-count">
          {filtered.length === stream.rows.length
            ? t('traffic.total', { total: stream.rows.length })
            : t('traffic.matching', { shown: filtered.length, total: stream.rows.length })}
        </span>
        <span className="traffic-port">
          {capture.address === null
            ? t('traffic.notListening')
            : t('traffic.listeningOn', { host: capture.address })}
        </span>
        <button
          type="button"
          className="traffic-action"
          aria-pressed={capture.capturing}
          aria-label={capture.capturing ? t('traffic.stop') : t('traffic.start')}
          /*
           * Off, not silently refused. With no address committed, `start()`
           * returns before it binds and the panel's only answer was one line of
           * text under the fold — so the button read as dead when it had in fact
           * answered every time it was pressed.
           */
          disabled={!capture.capturing && capture.origin === null}
          title={!capture.capturing && capture.origin === null ? t('traffic.noOrigin') : undefined}
          onClick={toggle}
        >
          {capture.capturing ? t('traffic.stop') : t('traffic.start')}
        </button>
      </header>

      {legacy !== null && !legacy.completed && (
        <div className="traffic-legacy">
          <p className="traffic-legacy-text">{t('traffic.legacyQuestion')}</p>
          <button
            type="button"
            className="traffic-action"
            onClick={() => {
              decide(true)
            }}
          >
            {t('traffic.legacyKeep')}
          </button>
          <button
            type="button"
            className="traffic-action"
            onClick={() => {
              decide(false)
            }}
          >
            {t('traffic.legacyFresh')}
          </button>
        </div>
      )}

      {stream.needsSnapshot && (
        <div className="traffic-legacy">
          <p className="traffic-legacy-text">{t('traffic.lagging')}</p>
          <button type="button" className="traffic-action" onClick={resume}>
            {t('traffic.resume')}
          </button>
        </div>
      )}

      <details className="traffic-setup">
        <summary className="traffic-setup-summary">{t('traffic.setup')}</summary>
        <div className="traffic-source-row">
          <select
            className="traffic-source"
            aria-label={t('traffic.source')}
            value={sourceValue(capture.source)}
            onChange={(event) => {
              choose(event.target.value)
            }}
          >
            <option value="">{t('traffic.none')}</option>
            {props.terminals.map((option) => (
              <option key={terminalRefKey(option.ref)} value={terminalRefKey(option.ref)}>
                {option.label}
              </option>
            ))}
            <option value="logcat">{t('traffic.logcat')}</option>
          </select>
          <input
            className="traffic-origin"
            type="text"
            spellCheck={false}
            aria-label={t('traffic.origin')}
            placeholder={t('traffic.originPlaceholder')}
            value={originDraft}
            onChange={(event) => {
              setOriginDraft(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitOrigin()
            }}
            onBlur={commitOrigin}
          />
        </div>

        <div className="traffic-source-row">
          <input
            className="traffic-origin"
            type="text"
            spellCheck={false}
            aria-label={t('traffic.portField')}
            placeholder={String(DEFAULT_TRAFFIC_PORT)}
            value={portDraft}
            onChange={(event) => {
              setPortDraft(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitPort()
            }}
            onBlur={commitPort}
          />
          <input
            className="traffic-origin"
            type="text"
            spellCheck={false}
            aria-label={t('traffic.envVarField')}
            placeholder={t('traffic.envVarPlaceholder')}
            value={envVarDraft}
            onChange={(event) => {
              setEnvVarDraft(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitEnvVar()
            }}
            onBlur={commitEnvVar}
          />
        </div>

        {envLine !== null && (
          <div className="traffic-env-row">
            <code className="traffic-env">{envLine}</code>
            <button
              type="button"
              className="traffic-tab"
              onClick={() => {
                copy(envLine)
              }}
            >
              {t('traffic.copy')}
            </button>
          </div>
        )}

        {capture.source.kind === 'logcat' && (
          <div className="traffic-source-row">
            <input
              className="traffic-origin"
              type="text"
              spellCheck={false}
              aria-label={t('traffic.filters')}
              placeholder={t('traffic.filtersPlaceholder')}
              value={filters}
              onChange={(event) => {
                setFilters(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitFilters()
              }}
              onBlur={commitFilters}
            />
          </div>
        )}
      </details>

      <div className="traffic-source-row">
        <input
          className="traffic-find"
          type="text"
          spellCheck={false}
          aria-label={t('traffic.search')}
          placeholder={t('traffic.searchPlaceholder')}
          value={search}
          onChange={(event) => {
            searchFor(event.target.value)
          }}
        />
        <button
          type="button"
          className="traffic-action"
          disabled={search === ''}
          onClick={() => {
            searchFor('')
          }}
        >
          {t('traffic.clear')}
        </button>
      </div>

      {paged.count > 1 && (
        <div className="traffic-source-row">
          <button
            type="button"
            className="traffic-action"
            disabled={paged.index === 0}
            onClick={() => {
              goTo(paged.index - 1)
            }}
          >
            {t('traffic.older')}
          </button>
          <span className="traffic-count">
            {t('traffic.page', { page: paged.index + 1, pages: paged.count })}
          </span>
          <button
            type="button"
            className="traffic-action"
            disabled={page === null || paged.index >= paged.count - 1}
            onClick={() => {
              goTo(paged.index + 1)
            }}
          >
            {t('traffic.newer')}
          </button>
        </div>
      )}

      {failure !== null && (
        <p className="traffic-stopped">
          {failure === 'origin'
            ? t('traffic.originFailed')
            : failure === 'action'
              ? t('traffic.actionFailed')
              : t(FAILURE_KEYS[failure], { port: capture.wantedPort ?? DEFAULT_TRAFFIC_PORT })}
        </p>
      )}

      {stream.rows.length === 0 ? (
        <div className="traffic-empty">
          <p>
            {capture.address === null
              ? t('traffic.empty')
              : t('traffic.pointAt', { host: capture.address })}
          </p>
          <p>{capture.source.kind === 'off' ? t('traffic.noTerminal') : t('traffic.waiting')}</p>
        </div>
      ) : filtered.length === 0 ? (
        <p className="traffic-stopped">{t('traffic.noMatches')}</p>
      ) : (
        <div className="traffic-split">
          <ul className="traffic-rows" onKeyDown={onRowKeyDown}>
            {shown.map((row) => (
              <li
                className={
                  row.seq === selectedSeq ? 'traffic-row traffic-row--selected' : 'traffic-row'
                }
                key={row.seq}
                data-source={row.source}
              >
                {row.source === 'http' ? (
                  <button
                    type="button"
                    className="traffic-row-button"
                    aria-pressed={row.seq === selectedSeq}
                    onClick={() => {
                      setSelectedSeq((current) => (current === row.seq ? null : row.seq))
                    }}
                  >
                    {bodyOf(row)}
                  </button>
                ) : (
                  bodyOf(row)
                )}
              </li>
            ))}
          </ul>
          {selected !== null && (
            <TrafficRequestInspector
              projectId={projectId}
              subscriptionId={stream.subscriptionId}
              captureId={stream.captureId}
              row={selected}
            />
          )}
        </div>
      )}
    </section>
  )
}

import { useCallback, useEffect, useId, useRef, useState } from 'react'
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
import {
  filterRows,
  followsRows,
  outcomeOf,
  pageOf,
  type RowScroll,
  type TrafficOutcome,
} from './traffic-filter.js'
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
  access: 'lan',
  envVar: null,
  source: { kind: 'off' },
  failure: null,
}

const FAILURE_KEYS: Record<TrafficFailure, string> = {
  'in-use': 'traffic.portInUse',
  failed: 'traffic.startFailed',
  'source-busy': 'traffic.sourceBusy',
  'unknown-project': 'traffic.unknownProject',
  capturing: 'traffic.capturingChange',
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
  /*
   * One base for the setup fields' ids. Two panels can be mounted at once — a
   * pane split puts the traffic tab in each — and `htmlFor` takes a string, so
   * the labels would point at whichever field was rendered last.
   */
  const fields = useId()
  const [stream, setStream] = useState<TrafficStream>(EMPTY_TRAFFIC)
  const [capture, setCapture] = useState<TrafficState>(idle)
  const [legacy, setLegacy] = useState<TrafficLegacy | null>(null)
  const [portDraft, setPortDraft] = useState(String(DEFAULT_TRAFFIC_PORT))
  const [originDraft, setOriginDraft] = useState('')
  const [envVarDraft, setEnvVarDraft] = useState('')
  const [filters, setFilters] = useState(DEFAULT_LOGCAT_FILTER)
  const [failure, setFailure] = useState<TrafficFailure | 'action' | 'origin' | null>(null)
  /*
   * Which field the last refusal belongs to.
   *
   * The message is a fact about one control, and it used to render at the foot
   * of the panel — far enough away that a person whose correction had just been
   * refused went on reading their own text in the box as though it had been
   * taken. Naming the field is what lets it appear under the control it is
   * about, in the hint slot that is already there.
   */
  const [refusedAt, setRefusedAt] = useState<'origin' | 'port' | 'envVar' | null>(null)
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  /** Null means the last page, which keeps following as rows arrive. */
  const [page, setPage] = useState<number | null>(null)

  const rowsList = useRef<HTMLUListElement>(null)
  /*
   * Where the list stood the last time the effect looked, and the answer for a
   * list nobody has moved since.
   *
   * By the time the effect below runs the new row is already in the DOM and
   * `scrollHeight` has grown by its height, so asking "am I at the bottom"
   * *then* answers no every single time and the list would never follow at all —
   * which looks exactly like the feature not being wired up. This is where "was
   * it at the bottom before this row arrived" comes from.
   *
   * Zeros mean "at the bottom": the first run, and the first run after a project
   * change, both follow — which is where somebody opening the panel wants to be.
   */
  const settled = useRef<RowScroll>({ scrollHeight: 0, scrollTop: 0, clientHeight: 0 })
  /** The newest row's sequence: a new row, as opposed to a pending one rewritten in place. */
  const newestSeq = stream.rows.at(-1)?.seq ?? null

  // A selection belongs to the project's history, not to the panel: switching
  // project closes whatever was open rather than describing the wrong one. The
  // scroll follows the same rule, from the other end — a different project opens
  // on its newest row, not wherever the last one was left.
  useEffect(() => {
    setSelectedSeq(null)
    settled.current = { scrollHeight: 0, scrollTop: 0, clientHeight: 0 }
  }, [projectId])

  useEffect(() => {
    const list = rowsList.current
    if (list === null) return
    const previous = settled.current
    /*
     * **Measured against the height the list had last time, not the height it
     * has now.**
     *
     * The new row is already in the DOM, so `scrollHeight` has grown by its
     * height — asking "am I at the bottom" against *that* answers no every time
     * and the list would never follow at all, which looks exactly like the
     * feature not being wired up. What is asked instead is where the person left
     * the list, relative to the bottom they could see at the time.
     *
     * One rule, and it covers the case that broke the first two attempts: five
     * rows arriving in a single render. Measuring the grown height made the list
     * look 115px from a bottom nobody had moved away from, and the following
     * stopped there — measured, 48px short with those rows already in the DOM.
     *
     * This reads no scroll event at all, deliberately. A listener sees the
     * geometry at the moment the browser fires it, which can be a row or two
     * after the movement it reports — measured as the following stopping dead at
     * 1,204px from the bottom with nobody having touched the list.
     */
    const atBottom = followsRows(
      {
        scrollHeight: previous.scrollHeight,
        scrollTop: list.scrollTop,
        clientHeight: list.clientHeight,
      },
      page
    )
    if (atBottom) {
      /*
       * Assigned rather than scrolled smoothly: under a flood a smooth scroll
       * never catches up and reads as lag rather than as motion. Nothing here
       * touches focus — the arrow walk owns that, and a scroll that also focused
       * would fight it.
       */
      list.scrollTop = list.scrollHeight
    }
    settled.current = {
      scrollHeight: list.scrollHeight,
      scrollTop: list.scrollTop,
      clientHeight: list.clientHeight,
    }
  }, [newestSeq, page, projectId])

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

  /*
   * **All three of these put the field back from `state`, taken or refused.**
   *
   * The two used to disagree, and the disagreement was the defect: `commitPort`
   * restored the field only when the change was *refused*, `commitOrigin` only
   * when it *succeeded*. So refusing an origin change — which `configure` does
   * on purpose while a capture is running, because the socket is already bound
   * and the forward target is read once at `Start` — left the rejected text
   * sitting in the box. The panel showed `:30081` and the listener went on
   * forwarding to `:3008`, and every row was a 502 against a port with nothing
   * on it. `commitEnvVar` already had the honest form.
   *
   * `state` is authoritative either way: `configure` returns before it stores
   * anything when it refuses, so the value it hands back is the stored one. One
   * rule for the three, and no branch to get wrong.
   */
  const commitOrigin = useCallback((): void => {
    void window.chorus
      .configureTraffic({ projectId, config: { origin: originDraft.trim() } })
      .then(({ state, failure: refused }) => {
        setCapture(state)
        setFailure(refused)
        setRefusedAt(refused === null ? null : 'origin')
        setOriginDraft(state.origin ?? '')
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
        setRefusedAt(refused === null ? null : 'port')
        setPortDraft(String(state.wantedPort ?? DEFAULT_TRAFFIC_PORT))
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
        /*
         * Nothing refuses an env-var change today — it is not one of the moves
         * `configure` guards — so this branch cannot fire yet. It is here so the
         * three handlers read the same, and so a guard added to that field
         * later reports at the field rather than at the foot of the panel.
         */
        setRefusedAt(refused === null ? null : 'envVar')
        setEnvVarDraft(state.envVar ?? '')
      })
      .catch(() => {
        setFailure('action')
      })
  }, [projectId, envVarDraft])

  const chooseAccess = useCallback(
    (value: string): void => {
      void window.chorus
        .configureTraffic({ projectId, config: { access: value === 'lan' ? 'lan' : 'loopback' } })
        .then(({ state, failure: refused }) => {
          setCapture(state)
          setFailure(refused)
        })
        .catch(() => {
          setFailure('action')
        })
    },
    [projectId]
  )

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

  /*
   * Emptying the history, which is a different question from forwarding.
   *
   * **The response's `{captureId, seq}` is deliberately dropped.** `registry.clear()`
   * mints a new capture generation and pushes a `reset`, and `reduceTraffic` is
   * the one place that applies it — through `belongs()`, which checks the project
   * and the subscription as well as the generation. Writing those two fields from
   * this response as well would be a second source of truth for state the push
   * already owns, with the faster of the two winning. So the list is not touched
   * here at all.
   *
   * The page is, and has to be: somebody who had paged back would otherwise be
   * left on a suppressed follow over an empty list. The selection needs nothing —
   * it is `stream.rows.find(...)`, so it falls to null on its own when the rows
   * go. Both of those were checked rather than assumed.
   *
   * Available whether capture is running or not: clearing what was captured and
   * forwarding what comes next are separate, and `clear()` leaves the socket up.
   */
  const clearCaptured = useCallback((): void => {
    void window.chorus
      .clearTraffic({ projectId })
      .then(() => {
        setPage(null)
      })
      .catch(() => {
        setFailure('action')
      })
  }, [projectId])

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

  /*
   * **The arrows move the selection as well as the focus.**
   *
   * They used to move focus alone, and selection was written only by `onClick`,
   * so walking the list left the inspector describing whatever had last been
   * clicked — the highlight moved past it and the panes did not.
   *
   * This is the same `setSelectedSeq` the click calls, minus the toggle: a click
   * on the selected row closes the pane, and an arrow that closed the pane on the
   * row it had just opened would make the walk unusable. The two paths share the
   * setter and not the handler, deliberately.
   *
   * Nothing here waits. The selection lands on the keystroke, so the highlight
   * and the inspector's header — both drawn from the row — change with it, and
   * only the detail read settles. That is what keeps a held arrow key from
   * putting a `readTrafficDetail` through a synchronous main thread per row
   * passed over: the reads still happen, but the panes never wait for the ones
   * you have already left.
   */
  const onRowKeyDown = (event: React.KeyboardEvent<HTMLUListElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('.traffic-row-button')]
    const at = buttons.indexOf(document.activeElement as HTMLElement)
    const next = buttons[at + (event.key === 'ArrowDown' ? 1 : -1)]
    if (at === -1 || next === undefined) return
    event.preventDefault()
    next.focus()
    const seq = Number(next.dataset['seq'])
    if (Number.isInteger(seq)) setSelectedSeq(seq)
  }

  /*
   * One place that turns a failure into words, because it is now drawn in two —
   * under the field that was refused, and at the foot of the panel for the ones
   * that belong to no field. Two copies would agree until one was edited.
   */
  const failureText = (which: TrafficFailure | 'action' | 'origin'): string =>
    which === 'origin'
      ? t('traffic.originFailed')
      : which === 'action'
        ? t('traffic.actionFailed')
        : t(FAILURE_KEYS[which], { port: capture.wantedPort ?? DEFAULT_TRAFFIC_PORT })

  /*
   * `capturing` is the only failure `configure` can return — its guard refusing
   * an origin, port or reach change while a socket is bound. Testing the failure
   * rather than trusting `refusedAt` alone is what stops a later Start failure —
   * "set an address first" — from rendering under a setup field it has nothing
   * to do with, without having to clear `refusedAt` at every other call site.
   */
  const refusedField = failure === 'capturing' ? refusedAt : null

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
          {row.transport !== null && <span className="traffic-transport">{row.transport}</span>}
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
        {/*
          A visible label tied to each field, and **the `aria-label` removed
          rather than kept beside it**. Both would leave two names for one
          input, and the `aria-label` is the one that wins — so a screen reader
          would announce something other than the words on the screen, which is
          worse than the unlabelled state this replaces. One name each, and the
          hints are descriptions through `aria-describedby`, not part of it.
        */}
        <div className="traffic-source-row">
          <div className="traffic-field" data-traffic-field="source">
            <label className="traffic-field-name" htmlFor={`${fields}-source`}>
              {t('traffic.source')}
            </label>
            <select
              id={`${fields}-source`}
              className="traffic-source"
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
          </div>
          <div className="traffic-field" data-traffic-field="origin">
            <label className="traffic-field-name" htmlFor={`${fields}-origin`}>
              {t('traffic.origin')}
            </label>
            <input
              id={`${fields}-origin`}
              className="traffic-origin"
              type="text"
              spellCheck={false}
              aria-describedby={`${fields}-origin-hint`}
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
            <span
              className="traffic-field-hint"
              id={`${fields}-origin-hint`}
              data-refused={refusedField === 'origin' ? 'true' : 'false'}
            >
              {refusedField === 'origin' && failure !== null
                ? failureText(failure)
                : t('traffic.originHint')}
            </span>
          </div>
        </div>

        <div className="traffic-source-row">
          <div className="traffic-field" data-traffic-field="port">
            <label className="traffic-field-name" htmlFor={`${fields}-port`}>
              {t('traffic.portField')}
            </label>
            <input
              id={`${fields}-port`}
              className="traffic-origin"
              type="text"
              spellCheck={false}
              aria-describedby={`${fields}-port-hint`}
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
            <span
              className="traffic-field-hint"
              id={`${fields}-port-hint`}
              data-refused={refusedField === 'port' ? 'true' : 'false'}
            >
              {refusedField === 'port' && failure !== null
                ? failureText(failure)
                : t('traffic.portHint')}
            </span>
          </div>
          <div className="traffic-field" data-traffic-field="envVar">
            <label className="traffic-field-name" htmlFor={`${fields}-env`}>
              {t('traffic.envVarField')}
            </label>
            <input
              id={`${fields}-env`}
              className="traffic-origin"
              type="text"
              spellCheck={false}
              aria-describedby={`${fields}-env-hint`}
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
            <span className="traffic-field-hint" id={`${fields}-env-hint`}>
              {t('traffic.envVarHint')}
            </span>
          </div>
        </div>

        {/*
          On its own row rather than paired, unlike the four above it: the hint
          is the only one in this block that describes a consequence rather than
          a setting, and it swaps with the choice. Two columns would have broken
          it mid-sentence at 300px.
        */}
        <div className="traffic-source-row">
          <div className="traffic-field" data-traffic-field="access">
            <label className="traffic-field-name" htmlFor={`${fields}-access`}>
              {t('traffic.access')}
            </label>
            <select
              id={`${fields}-access`}
              className="traffic-source"
              aria-describedby={`${fields}-access-hint`}
              value={capture.access}
              onChange={(event) => {
                chooseAccess(event.target.value)
              }}
            >
              <option value="loopback">{t('traffic.accessLoopback')}</option>
              <option value="lan">{t('traffic.accessLan')}</option>
            </select>
            <span className="traffic-field-hint" id={`${fields}-access-hint`}>
              {capture.access === 'lan'
                ? t('traffic.accessLanHint')
                : t('traffic.accessLoopbackHint')}
            </span>
          </div>
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
            <div className="traffic-field" data-traffic-field="filters">
              <label className="traffic-field-name" htmlFor={`${fields}-filters`}>
                {t('traffic.filters')}
              </label>
              <input
                id={`${fields}-filters`}
                className="traffic-origin"
                type="text"
                spellCheck={false}
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
          </div>
        )}
      </details>

      <div className="traffic-source-row">
        <span className="traffic-find-box">
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
            onKeyDown={(event) => {
              /*
               * The one thing `type="search"` would have given that is worth
               * having, for a line. The native control it would also have given
               * was declined — see `.traffic-find-clear`.
               */
              if (event.key === 'Escape' && search !== '') searchFor('')
            }}
          />
          {/*
            Only while there is something to clear. A control that is always
            there and sometimes greyed is how this started: the button beside the
            field was `disabled` whenever the field was empty, so pressing it did
            nothing at all and it read as broken.
          */}
          {search !== '' && (
            <button
              type="button"
              className="traffic-find-clear"
              data-traffic-clear="search"
              aria-label={t('traffic.clearSearch')}
              onClick={() => {
                searchFor('')
              }}
            >
              ×
            </button>
          )}
        </span>
        {/*
          The capture's Clear, out of the header and down beside the field.

          It was beside Start/Stop, six pixels from a control that stops the
          capture rather than emptying it — and it began this whole thread by
          sharing the word "Clear" with the search button that used to sit here,
          which the person pressed expecting the rows to go. Two controls in one
          row still clear different things, so what separates them is position
          (the X is inside the field, this is outside it) and a name that says
          which: the visible word is the same "Clear", and the title and the
          accessible name both say what it clears.
        */}
        <button
          type="button"
          className="traffic-action"
          data-traffic-clear="captured"
          title={t('traffic.clearCaptured')}
          aria-label={t('traffic.clearCaptured')}
          onClick={clearCaptured}
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

      {failure !== null && refusedField === null && (
        <p className="traffic-stopped">{failureText(failure)}</p>
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
          <ul className="traffic-rows" ref={rowsList} onKeyDown={onRowKeyDown}>
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
                    /* What the arrow walk selects by: the button is the row's box, so it is the row. */
                    data-seq={row.seq}
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

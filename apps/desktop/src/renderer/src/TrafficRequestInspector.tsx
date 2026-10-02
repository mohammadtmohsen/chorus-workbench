import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TrafficRowShape } from '../../shared/ipc.js'
import {
  BODY_PAGE,
  type TrafficBodyDescriptor,
  type TrafficDetail,
  type TrafficDetailResult,
} from '../../shared/traffic-ipc.js'
import {
  bodyView,
  bytesFromBase64,
  curlCommand,
  describeBody,
  formFields,
  isForm,
  jsonTree,
  maskHeaders,
  previewTokens,
  textOf,
  treeRows,
  type JsonNode,
  type TreeRow,
  type TreeToken,
} from './traffic-body.js'
import { isPending, statusClassOf } from './traffic-filter.js'

/** A capture is held to a megabyte, so this cannot be reached by an honest body. */
const MAX_BODY_PAGES = 64

type Side = 'request' | 'response'
type HttpRow = Extract<TrafficRowShape, { source: 'http' }>

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const whole = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    whole.set(chunk, at)
    at += chunk.length
  }
  return whole
}

const TOKEN_CLASS: Record<TreeToken['kind'], string> = {
  key: 'tok tok--property',
  string: 'tok tok--string',
  number: 'tok tok--number',
  boolean: 'tok tok--keyword',
  null: 'tok tok--keyword',
  punct: 'traffic-punct',
}

const headerRows = (
  headers: readonly (readonly [string, string])[],
  reveal: boolean
): readonly (readonly [string, string])[] => maskHeaders(headers, reveal)

export function TrafficRequestInspector(props: {
  readonly projectId: string
  readonly subscriptionId: string
  readonly captureId: string
  readonly row: HttpRow
}): React.JSX.Element {
  const { t } = useTranslation()
  const { projectId, subscriptionId, captureId, row } = props
  const pending = isPending(row)

  const [detail, setDetail] = useState<TrafficDetail | null>(null)
  const [gone, setGone] = useState<TrafficDetailResult | null>(null)
  const [failure, setFailure] = useState(false)
  const [reveal, setReveal] = useState(false)
  const [chunks, setChunks] = useState<Record<Side, Uint8Array[]>>({ request: [], response: [] })
  const [representation, setRepresentation] = useState<Record<Side, 'encoded' | 'decoded'>>({
    request: 'decoded',
    response: 'decoded',
  })
  const [loaded, setLoaded] = useState<Record<Side, boolean>>({ request: false, response: false })
  const [loading, setLoading] = useState<Side | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [focused, setFocused] = useState<string | null>(null)
  const treeRef = useRef<HTMLDivElement | null>(null)
  const readGeneration = useRef(0)

  /*
   * Reveal is for one request and one reading of it. A new selection is a new
   * decision about whether to show a credential, so it is taken again rather
   * than inherited from whatever was open before.
   */
  useEffect(() => {
    setReveal(false)
  }, [row.requestId])

  useEffect(() => {
    readGeneration.current += 1
    setChunks({ request: [], response: [] })
    setLoaded({ request: false, response: false })
    setRepresentation({ request: 'decoded', response: 'decoded' })
    setLoading(null)
    setDetail(null)
    setGone(null)
    setFailure(false)
  }, [row.requestId, pending])

  useEffect(() => {
    setCollapsed(new Set())
    setFocused(null)
  }, [row.requestId])

  useEffect(() => {
    let cancelled = false
    void window.chorus
      .readTrafficDetail({ projectId, captureId, requestId: row.requestId, subscriptionId })
      .then((result) => {
        // A response for a request that is no longer selected describes
        // somebody else's exchange; it is dropped rather than shown.
        if (cancelled) return
        if (result.kind === 'detail') setDetail(result.detail)
        else setGone(result)
      })
      .catch(() => {
        if (!cancelled) setFailure(true)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, captureId, subscriptionId, row.requestId, pending])

  /*
   * The whole body, in one go, with no control to ask for more.
   *
   * It used to fetch a page and offer a button for the rest, which meant a body
   * was blank until someone pressed it — and the count it printed subtracted a
   * decoded length from an encoded total, so a compressed response offered to
   * load bytes that did not exist. A capture is bounded at a megabyte, so
   * reading all of it costs sixteen round trips at worst.
   */
  const loadWhole = useCallback(
    (side: Side): void => {
      const generation = readGeneration.current
      const current = (): boolean => generation === readGeneration.current
      const run = async (): Promise<void> => {
        const parts: Uint8Array[] = []
        let wants: 'encoded' | 'decoded' = representation[side]
        setLoading(side)

        for (let page = 0; page < MAX_BODY_PAGES; page++) {
          const offset = parts.reduce((sum, part) => sum + part.length, 0)
          const result = await window.chorus.readTrafficBody({
            projectId,
            captureId,
            requestId: row.requestId,
            subscriptionId,
            side,
            representation: wants,
            offset,
            length: BODY_PAGE,
          })
          if (!current()) return
          /*
           * Decoded first, because the encoded bytes of a compressed response
           * are not what anybody opened this tab to read. A body main cannot
           * decode answers `unsupported` rather than bytes, so the encoded form
           * is fetched instead — losing the decode must not lose the body.
           */
          if (result.kind === 'unsupported' && wants === 'decoded') {
            wants = 'encoded'
            setRepresentation((current) => ({ ...current, [side]: 'encoded' }))
            continue
          }
          if (result.kind !== 'page') {
            setGone(result)
            setLoaded((current) => ({ ...current, [side]: true }))
            setLoading(null)
            return
          }
          const part = bytesFromBase64(result.dataBase64)
          if (part.length === 0) break
          parts.push(part)
          if (part.length < BODY_PAGE) break
        }

        setChunks((current) => ({ ...current, [side]: parts }))
        setLoaded((current) => ({ ...current, [side]: true }))
        setLoading(null)
      }

      void run().catch(() => {
        if (!current()) return
        setLoading(null)
        setFailure(true)
      })
    },
    [projectId, captureId, row.requestId, subscriptionId, representation]
  )

  useEffect(() => {
    if (detail === null) return
    if (!loaded.request) loadWhole('request')
    if (!loaded.response) loadWhole('response')
  }, [detail, loaded, loadWhole])

  const copy = useCallback((text: string): void => {
    void window.chorus.copyText({ text })
  }, [])

  const bytes = useMemo(
    () => ({ request: concat(chunks.request), response: concat(chunks.response) }),
    [chunks]
  )

  const bodyOf = useCallback(
    (
      side: Side
    ): { descriptor: TrafficBodyDescriptor; text: string; note: string | null } | null => {
      if (detail === null) return null
      const descriptor = side === 'request' ? detail.requestBody : detail.responseBody
      const rendered = bodyView(bytes[side], descriptor, 'formatted')
      return { descriptor, text: rendered.text, note: rendered.note }
    },
    [detail, bytes]
  )

  const goneReason = gone !== null && gone.kind !== 'detail' ? gone.kind : failure ? 'failed' : null

  const awaitingResponse =
    pending ||
    detail?.responseBody.state === 'pending' ||
    detail?.responseBody.state === 'streaming'

  /*
   * **No early return, because the header no longer needs the detail.**
   *
   * It used to: everything above the panes was read from `detail`, so a row
   * whose read had not landed yet rendered "Loading" and nothing else. That is
   * fine when a row is chosen by a click and nobody is watching, and wrong now
   * that the arrow keys move the selection — passing through six rows would
   * flash six identical Loading panes with no way to tell which row you were on.
   *
   * The header is drawn from `row`, which the panel already has synchronously
   * and which says the same thing: `record` sets the snapshot's status and the
   * request line from the same values the detail carries. So the identity of
   * the request changes on the keystroke, and only the panes wait.
   */

  const curlOf = (): string =>
    detail === null
      ? ''
      : curlCommand({
          method: detail.method,
          url: detail.forwardedUrl === '' ? detail.url : detail.forwardedUrl,
          headers: detail.forwardedHeaders,
          body: textOf(bytes.request),
        })

  const renderBody = (side: Side): React.JSX.Element => {
    if (side === 'response' && awaitingResponse) {
      return <p className="traffic-stopped">{t('traffic.waitingForResponse')}</p>
    }
    const body = bodyOf(side)
    if (body === null) return <p className="traffic-stopped">{t('traffic.detailLoading')}</p>
    const note = describeBody(body.descriptor)
    const tree = jsonTree(body.text)

    return (
      <div className="traffic-body-view">
        <div className="traffic-body-bar">
          <button
            type="button"
            className="traffic-tab"
            onClick={() => {
              copy(side === 'request' ? curlOf() : body.text)
            }}
          >
            {side === 'request' ? t('traffic.copyCurl') : t('traffic.copy')}
          </button>
        </div>

        {note !== null && <p className="traffic-stopped">{t(`traffic.bodyNote.${note}`)}</p>}
        {tree === null ? <pre className="traffic-body-text">{body.text}</pre> : renderTree(tree)}

        {loading === side && <p className="traffic-stopped">{t('traffic.detailLoading')}</p>}
      </div>
    )
  }

  const focusPath = (path: string): void => {
    treeRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.focus()
  }

  const togglePath = (path: string): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const onTreeKey = (
    event: React.KeyboardEvent<HTMLDivElement>,
    rows: readonly TreeRow[],
    path: string
  ): void => {
    const at = rows.findIndex((row) => row.path === path)
    const row = rows[at]
    if (row === undefined) return

    const step = (to: number): void => {
      const target = rows[to]
      if (target !== undefined) focusPath(target.path)
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      step(at + 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      step(at - 1)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      step(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      step(rows.length - 1)
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      if (!row.expandable) return
      const child = rows[at + 1]
      if (!row.expanded) togglePath(path)
      else if (child !== undefined && child.depth > row.depth) focusPath(child.path)
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (row.expandable && row.expanded) {
        togglePath(path)
        return
      }
      let up = at - 1
      while (up >= 0 && (rows[up]?.depth ?? 0) >= row.depth) up--
      if (up >= 0) step(up)
      return
    }
    if ((event.key === 'Enter' || event.key === ' ') && row.expandable) {
      event.preventDefault()
      togglePath(path)
    }
  }

  const previewSpans = (tokens: readonly TreeToken[]): React.JSX.Element => (
    <>
      {tokens.map((token, index) => (
        <span key={String(index)} className={TOKEN_CLASS[token.kind]}>
          {token.text}
        </span>
      ))}
    </>
  )

  const renderTree = (tree: JsonNode): React.JSX.Element => {
    const rows = treeRows(tree, collapsed)
    const entries = rows.filter((row) => row.delimiter === null)
    const indent = (depth: number, twisted: boolean): string =>
      `calc(var(--step) * 2 + ${String(depth)} * (1.4em + var(--step))${twisted ? ' + 1.4em' : ''})`

    return (
      <div className="traffic-tree" role="tree" ref={treeRef} aria-label={t('traffic.detailTitle')}>
        {rows.map((row) =>
          row.delimiter !== null ? (
            <div
              key={row.path}
              className="traffic-node traffic-delimiter"
              aria-hidden="true"
              data-path={row.path}
              style={{ paddingLeft: indent(row.depth, row.node !== tree) }}
            >
              <span className="traffic-punct">{row.delimiter}</span>
            </div>
          ) : (
            <div
              key={row.path}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={row.expandable ? row.expanded : undefined}
              aria-selected={focused === row.path}
              tabIndex={focused === row.path ? 0 : -1}
              data-path={row.path}
              className="traffic-node"
              style={{ paddingLeft: indent(row.depth, false) }}
              onClick={() => {
                focusPath(row.path)
                if (row.expandable) togglePath(row.path)
              }}
              onFocus={() => {
                setFocused(row.path)
              }}
              onKeyDown={(event) => {
                onTreeKey(event, entries, row.path)
              }}
            >
              <span className="traffic-twisty" aria-hidden="true">
                {row.expandable ? (row.expanded ? '▾' : '▸') : ''}
              </span>
              {row.label !== null && (
                <>
                  <span className={TOKEN_CLASS.key}>{row.label}</span>
                  <span className="traffic-punct">: </span>
                </>
              )}
              {row.node.kind === 'value' ? (
                <span className={TOKEN_CLASS[row.node.scalar]}>{row.node.text}</span>
              ) : row.expanded ? (
                <span className="traffic-punct">{row.node.kind === 'array' ? '[' : '{'}</span>
              ) : (
                previewSpans(previewTokens(row.node))
              )}
            </div>
          )
        )}
      </div>
    )
  }

  const pairList = (pairs: readonly (readonly [string, string])[]): React.JSX.Element => (
    <dl className="traffic-headers">
      {pairs.map(([name, value], index) => (
        <div className="traffic-header" key={`${name}-${String(index)}`}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )

  const millis = (from: number | null, to: number | null): string =>
    from === null || to === null ? '—' : `${String(to - from)} ms`

  return (
    <section className="traffic-inspector" aria-label={t('traffic.detailTitle')}>
      {/*
        The same attributes a row carries, on the same class names, because the
        colours are keyed on the attributes rather than the classes. Without
        them every rule that tints a method, reddens a failed endpoint or colours
        a status simply did not match here — the header was grey whatever the row
        said, which is a header describing a call it does not look like.

        `data-class` goes on the header rather than on the status cell, for the
        reason it goes on the row button rather than on the cell there: it is one
        fact about the whole line, and the endpoint reads it too.
      */}
      <header className="traffic-head" data-class={statusClassOf(row)}>
        {/*
          **One string, edge to edge, rather than three cells in a row.**

          A flex row put the verb and the status in a column of their own beside
          a wrapping endpoint, which left the rest of that column empty — the gap
          under `GET 200` in the screenshot. As one run of inline text they flow
          as a single paragraph: the endpoint's continuation lines start at the
          header's left edge like any wrapped sentence, and nothing is left
          blank.

          The `{' '}` between them is not decoration. JSX drops whitespace that
          contains a newline between two elements, so without it the three run
          together as `GET200http://…`.

          `data-class` stays on the header and all three parts keep reading it;
          inline text is still a descendant.
        */}
        <span className="traffic-method" data-method={row.m.toUpperCase()}>
          {row.m}
        </span>{' '}
        <span className="traffic-status">
          {pending ? (
            <span className="traffic-pending" role="img" aria-label={t('traffic.pending')} />
          ) : (
            (row.status ?? '—')
          )}
        </span>{' '}
        <span className="traffic-url" title={row.u}>
          {row.u}
        </span>
      </header>

      {goneReason !== null ? (
        <p className="traffic-stopped">{t(`traffic.gone.${goneReason}`)}</p>
      ) : detail === null ? (
        <p className="traffic-stopped">{t('traffic.detailLoading')}</p>
      ) : (
        <div className="traffic-panes">
          <div className="traffic-pane" data-side="request">
            <h3 className="traffic-label">{t('traffic.tab.request')}</h3>

            {isForm(detail.requestBody.contentType) && bytes.request.length > 0 ? (
              <div className="traffic-fields">
                {formFields(textOf(bytes.request)).map(([name, value], index) => (
                  <p key={`${name}-${String(index)}`}>
                    <span className="traffic-label">{name}</span>
                    <span>{value}</span>
                  </p>
                ))}
              </div>
            ) : null}
            {renderBody('request')}

            <details className="traffic-fold">
              <summary className="traffic-fold-summary">{t('traffic.headersAndTiming')}</summary>
              <div className="traffic-general">
                <p>
                  <span className="traffic-label">{t('traffic.requestSize')}</span>
                  <span>
                    {t('traffic.sizeOf', {
                      kept: detail.requestBody.capturedBytes,
                      seen: detail.requestBody.observedBytes,
                    })}
                  </span>
                </p>
                <p>
                  <span className="traffic-label">{t('traffic.responseSize')}</span>
                  <span>
                    {t('traffic.sizeOf', {
                      kept: detail.responseBody.capturedBytes,
                      seen: detail.responseBody.observedBytes,
                    })}
                  </span>
                </p>
              </div>
              <div className="traffic-headers-view">
                <div className="traffic-body-bar">
                  <button
                    type="button"
                    className="traffic-tab"
                    aria-pressed={reveal}
                    onClick={() => {
                      setReveal((shown) => !shown)
                    }}
                  >
                    {reveal ? t('traffic.hideCredentials') : t('traffic.reveal')}
                  </button>
                  <button
                    type="button"
                    className="traffic-tab"
                    onClick={() => {
                      copy(
                        headerRows(detail.requestHeaders, reveal)
                          .map(([name, value]) => `${name}: ${value}`)
                          .join('\n')
                      )
                    }}
                  >
                    {t('traffic.copy')}
                  </button>
                </div>
                <h3 className="traffic-label">{t('traffic.requestHeaders')}</h3>
                {pairList(headerRows(detail.requestHeaders, reveal))}
                <h3 className="traffic-label">{t('traffic.forwardedHeaders')}</h3>
                {pairList(headerRows(detail.forwardedHeaders, reveal))}
                <h3 className="traffic-label">{t('traffic.responseHeaders')}</h3>
                {pairList(headerRows(detail.responseHeaders, reveal))}
                {detail.trailers.length > 0 && (
                  <>
                    <h3 className="traffic-label">{t('traffic.trailers')}</h3>
                    {pairList(detail.trailers)}
                  </>
                )}
              </div>

              <div className="traffic-general">
                <h3 className="traffic-label">{t('traffic.tab.timing')}</h3>
                <p>
                  <span className="traffic-label">{t('traffic.timingUpstream')}</span>
                  <span>{millis(detail.timing.startedAt, detail.timing.upstreamAt)}</span>
                </p>
                <p>
                  <span className="traffic-label">{t('traffic.timingBody')}</span>
                  <span>{millis(detail.timing.upstreamAt, detail.timing.upstreamDoneAt)}</span>
                </p>
                <p>
                  <span className="traffic-label">{t('traffic.timingTotal')}</span>
                  <span>
                    {millis(
                      detail.timing.startedAt,
                      detail.timing.settledAt ?? detail.timing.upstreamDoneAt
                    )}
                  </span>
                </p>
              </div>
            </details>
          </div>

          <div className="traffic-pane" data-side="response">
            <h3 className="traffic-label">{t('traffic.tab.response')}</h3>
            {/*
            Above the body rather than inside it, because there is no body for
            these and that is the whole complaint: the pane rendered its empty
            state and the person was left to decide whether the panel was broken
            or the backend was. The reason goes first and the body follows, so a
            socket that died mid-body reads as both — what arrived, and why it
            stopped.
          */}
            {detail.transport !== null && (
              <p className="traffic-stopped">
                {t('traffic.transportFailed', { reason: detail.transport })}
              </p>
            )}
            {renderBody('response')}
          </div>
        </div>
      )}
    </section>
  )
}

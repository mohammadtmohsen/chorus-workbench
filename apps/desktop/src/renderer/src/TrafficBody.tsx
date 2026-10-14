import { memo, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TrafficBodyDescriptor } from '../../shared/traffic-ipc.js'
import {
  bodyView,
  describeBody,
  formFields,
  isForm,
  jsonTree,
  previewTokens,
  textOf,
  treeRows,
  type TreeToken,
} from './traffic-body.js'

const TOKEN_CLASS: Record<TreeToken['kind'], string> = {
  key: 'tok tok--property',
  string: 'tok tok--string',
  number: 'tok tok--number',
  boolean: 'tok tok--keyword',
  null: 'tok tok--keyword',
  punct: 'traffic-punct',
}

export const TrafficBody = memo(function TrafficBody(props: {
  readonly side: 'request' | 'response'
  readonly descriptor: TrafficBodyDescriptor
  readonly bytes: Uint8Array
  readonly waiting: boolean
  readonly loading: boolean
  readonly requestCurl: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const { side, descriptor, bytes, waiting, loading, requestCurl } = props
  const treeRef = useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [focused, setFocused] = useState<string | null>(null)
  const body = useMemo(() => bodyView(bytes, descriptor, 'formatted'), [bytes, descriptor])
  const tree = useMemo(() => jsonTree(body.text), [body.text])
  const rows = useMemo(() => (tree === null ? [] : treeRows(tree, collapsed)), [tree, collapsed])
  const entries = useMemo(() => rows.filter((row) => row.delimiter === null), [rows])
  const fields = useMemo(
    () =>
      side === 'request' && isForm(descriptor.contentType) && bytes.length > 0
        ? formFields(textOf(bytes))
        : [],
    [side, descriptor.contentType, bytes]
  )
  const focusable = entries.some((row) => row.path === focused) ? focused : entries[0]?.path

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

  const onTreeKey = (event: React.KeyboardEvent<HTMLDivElement>, path: string): void => {
    const at = entries.findIndex((row) => row.path === path)
    const row = entries[at]
    if (row === undefined) return
    const step = (to: number): void => {
      const target = entries[to]
      if (target !== undefined) focusPath(target.path)
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      step(at + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      step(at - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      step(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      step(entries.length - 1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      if (!row.expandable) return
      const child = entries[at + 1]
      if (!row.expanded) togglePath(path)
      else if (child !== undefined && child.depth > row.depth) focusPath(child.path)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (row.expandable && row.expanded) togglePath(path)
      else {
        let up = at - 1
        while (up >= 0 && (entries[up]?.depth ?? 0) >= row.depth) up--
        if (up >= 0) step(up)
      }
    } else if ((event.key === 'Enter' || event.key === ' ') && row.expandable) {
      event.preventDefault()
      togglePath(path)
    }
  }

  const indent = (depth: number, twisted: boolean): string => {
    const base = `min(var(--step) * 2 + ${String(depth)} * (1.4em + var(--step)), 40%)`
    return twisted ? `calc(${base} + 1.4em)` : base
  }

  if (waiting) return <p className="traffic-stopped">{t('traffic.waitingForResponse')}</p>
  const note = describeBody(descriptor)

  return (
    <>
      {fields.length > 0 && (
        <div className="traffic-fields">
          {fields.map(([name, value], index) => (
            <p key={`${name}-${String(index)}`}>
              <span className="traffic-label">{name}</span>
              <span>{value}</span>
            </p>
          ))}
        </div>
      )}
      <div className="traffic-body-view">
        <div className="traffic-body-bar">
          <button
            type="button"
            className="traffic-tab"
            onClick={() => {
              void window.chorus.copyText({ text: side === 'request' ? requestCurl : body.text })
            }}
          >
            {side === 'request' ? t('traffic.copyCurl') : t('traffic.copy')}
          </button>
        </div>
        {note !== null && <p className="traffic-stopped">{t(`traffic.bodyNote.${note}`)}</p>}
        {tree === null ? (
          <pre className="traffic-body-text">{body.text}</pre>
        ) : (
          <div
            className="traffic-tree"
            role="tree"
            ref={treeRef}
            aria-label={t(`traffic.tab.${side}`)}
          >
            {rows.map((row) =>
              row.delimiter !== null ? (
                <div
                  key={row.path}
                  className="traffic-node traffic-delimiter"
                  aria-hidden="true"
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
                  tabIndex={focusable === row.path ? 0 : -1}
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
                    onTreeKey(event, row.path)
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
                    previewTokens(row.node).map((token, index) => (
                      <span key={String(index)} className={TOKEN_CLASS[token.kind]}>
                        {token.text}
                      </span>
                    ))
                  )}
                </div>
              )
            )}
          </div>
        )}
        {loading && <p className="traffic-stopped">{t('traffic.detailLoading')}</p>}
      </div>
    </>
  )
})

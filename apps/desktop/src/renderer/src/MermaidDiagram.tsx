import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import {
  markMermaidFailed,
  peekMermaid,
  renderMermaid,
  type MermaidOutcome,
  type MermaidScheme,
} from './mermaid.js'

const LIGHT_QUERY = '(prefers-color-scheme: light)'

function schemeQuery(): MediaQueryList | null {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? null
    : window.matchMedia(LIGHT_QUERY)
}

function subscribeScheme(onChange: () => void): () => void {
  const query = schemeQuery()
  if (query === null) return () => undefined
  query.addEventListener('change', onChange)
  return () => {
    query.removeEventListener('change', onChange)
  }
}

function readScheme(): MermaidScheme {
  return schemeQuery()?.matches === true ? 'light' : 'dark'
}

function serverScheme(): MermaidScheme {
  return 'dark'
}

export function MermaidDiagram({
  source,
  settled,
  children,
}: {
  source: string
  settled: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  const scheme = useSyncExternalStore(subscribeScheme, readScheme, serverScheme)
  const key = `${scheme}\n${source}`
  const [result, setResult] = useState<{ key: string; outcome: MermaidOutcome } | null>(null)
  const outcome = !settled
    ? undefined
    : result?.key === key
      ? result.outcome
      : peekMermaid(source, scheme)

  useEffect(() => {
    if (!settled) return
    const cached = peekMermaid(source, scheme)
    if (cached !== undefined) {
      setResult((current) =>
        current?.key === key && current.outcome === cached ? current : { key, outcome: cached }
      )
      return
    }
    let active = true
    void renderMermaid(source, scheme).then(
      (image) => {
        if (active) setResult({ key, outcome: image })
      },
      () => {
        if (active) setResult({ key, outcome: 'failed' })
      }
    )
    return () => {
      active = false
    }
  }, [key, scheme, settled, source])

  if (outcome === undefined || outcome === 'failed') {
    return (
      <>
        {children}
        {outcome === 'failed' && (
          <p className="md-diagram-failed">{t('conversation.diagramFailed')}</p>
        )}
      </>
    )
  }

  return (
    <div className="md-diagram" dir="ltr">
      <img
        src={outcome.url}
        width={outcome.width}
        height={outcome.height}
        alt={t('conversation.diagramAlt')}
        draggable={false}
        onError={() => {
          markMermaidFailed(source, scheme)
          setResult({ key, outcome: 'failed' })
        }}
      />
    </div>
  )
}

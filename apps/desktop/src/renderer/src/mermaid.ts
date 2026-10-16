import type { Mermaid, MermaidConfig } from 'mermaid'

export type MermaidScheme = 'light' | 'dark'

export interface MermaidImage {
  readonly url: string
  readonly width: number
  readonly height: number
}

export type MermaidOutcome = MermaidImage | 'failed'

export const MERMAID_CACHE_LIMIT = 64

export const MERMAID_MAX_SOURCE = 50_000

export const MERMAID_LOCKED_KEYS: readonly string[] = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'maxEdges',
  'suppressErrorRendering',
  'htmlLabels',
  'theme',
  'themeVariables',
  'themeCSS',
  'darkMode',
  'look',
  'layout',
  'fontFamily',
  'altFontFamily',
]

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const FALLBACK_FONT = 'system-ui, sans-serif'
const HOST_WIDTH = '960px'

const settled = new Map<string, MermaidOutcome>()
const pending = new Map<string, Promise<MermaidImage>>()
let queue: Promise<unknown> = Promise.resolve()
let library: Promise<Mermaid> | undefined
let configured: MermaidScheme | undefined
let sequence = 0

export function isMermaidLanguage(language: string | null): boolean {
  return language?.toLowerCase() === 'mermaid'
}

export function peekMermaid(source: string, scheme: MermaidScheme): MermaidOutcome | undefined {
  if (oversized(source)) return 'failed'
  return settled.get(cacheKey(source, scheme))
}

export function markMermaidFailed(source: string, scheme: MermaidScheme): void {
  if (oversized(source)) return
  remember(cacheKey(source, scheme), 'failed')
}

export function renderMermaid(source: string, scheme: MermaidScheme): Promise<MermaidImage> {
  if (oversized(source)) return Promise.reject(new Error('Mermaid diagram is too large to draw'))
  const key = cacheKey(source, scheme)
  const known = settled.get(key)
  if (known === 'failed') return Promise.reject(new Error('Mermaid diagram failed to render'))
  if (known !== undefined) return Promise.resolve(known)
  const inFlight = pending.get(key)
  if (inFlight !== undefined) return inFlight

  const job = enqueue(() => draw(source, scheme))
  pending.set(key, job)
  void job
    .then(
      (image) => {
        remember(key, image)
      },
      () => {
        remember(key, 'failed')
      }
    )
    .finally(() => {
      pending.delete(key)
    })
  return job
}

export function mermaidConfig(scheme: MermaidScheme, fontFamily: string): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    maxTextSize: MERMAID_MAX_SOURCE,
    htmlLabels: false,
    theme: scheme === 'light' ? 'default' : 'dark',
    fontFamily,
    secure: [...MERMAID_LOCKED_KEYS],
  }
}

export function toMermaidImage(markup: string): MermaidImage {
  const parsed = new DOMParser().parseFromString(
    markup.replaceAll('&nbsp;', '&#160;'),
    'image/svg+xml'
  )
  const svg = parsed.documentElement
  if (
    svg.namespaceURI !== SVG_NAMESPACE ||
    svg.localName !== 'svg' ||
    parsed.getElementsByTagName('parsererror').length > 0
  ) {
    throw new Error('Mermaid output is not an SVG document')
  }

  const box = (svg.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (box.length !== 4 || !box.every((value) => Number.isFinite(value))) {
    throw new Error('Mermaid output has no usable viewBox')
  }
  const width = Math.ceil(box[2] ?? 0)
  const height = Math.ceil(box[3] ?? 0)
  if (width <= 0 || height <= 0) {
    throw new Error('Mermaid output has no usable viewBox')
  }

  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  const declarations = (svg.getAttribute('style') ?? '')
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration !== '' && !/^max-width\s*:/i.test(declaration))
  if (declarations.length === 0) svg.removeAttribute('style')
  else svg.setAttribute('style', declarations.join('; '))

  const xml = new XMLSerializer().serializeToString(svg)
  return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`, width, height }
}

function oversized(source: string): boolean {
  return source.length > MERMAID_MAX_SOURCE
}

function cacheKey(source: string, scheme: MermaidScheme): string {
  return `${scheme}\n${source}`
}

function remember(key: string, outcome: MermaidOutcome): void {
  settled.delete(key)
  settled.set(key, outcome)
  for (const oldest of settled.keys()) {
    if (settled.size <= MERMAID_CACHE_LIMIT) break
    settled.delete(oldest)
  }
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task)
  queue = run.catch(() => undefined)
  return run
}

function load(): Promise<Mermaid> {
  if (library === undefined) {
    const loading = import('mermaid').then((module) => module.default)
    library = loading
    void loading.catch(() => {
      if (library === loading) library = undefined
    })
  }
  return library
}

async function draw(source: string, scheme: MermaidScheme): Promise<MermaidImage> {
  const mermaid = await load()
  if (configured !== scheme) {
    mermaid.initialize(mermaidConfig(scheme, uiFont()))
    configured = scheme
  }

  sequence += 1
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.position = 'fixed'
  host.style.top = '0'
  host.style.left = '-100000px'
  host.style.width = HOST_WIDTH
  host.style.visibility = 'hidden'
  host.style.pointerEvents = 'none'
  document.body.append(host)
  try {
    const { svg } = await mermaid.render(`chorus-mermaid-${String(sequence)}`, source, host)
    return toMermaidImage(svg)
  } finally {
    host.remove()
  }
}

function uiFont(): string {
  const font = getComputedStyle(document.documentElement).getPropertyValue('--ui-font').trim()
  return font === '' ? FALLBACK_FONT : font
}

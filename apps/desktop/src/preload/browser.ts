import { ipcRenderer } from 'electron'
import type {
  BrowserFormPhase,
  BrowserPageCandidate,
  BrowserPageFill,
  BrowserPageForm,
  BrowserPageRowWheel,
  BrowserPageSwipeSequence,
  BrowserPageSwipeState,
} from '../shared/browser-ipc.js'
import {
  SWIPE_FALLBACK_MS,
  SWIPE_LOST_MS,
  SWIPE_SETTLE_MS,
  swipeProgress,
  swipeReduce,
  usableWheel,
  type ScrollBox,
  type SwipeDirection,
  type SwipeInput,
  type SwipeState,
  type SwipeWheel,
} from '../shared/browser-swipe.js'

interface PageElement {
  readonly scrollLeft: number
  readonly scrollWidth: number
  readonly clientWidth: number
  readonly isConnected: boolean
  readonly style: { setProperty(name: string, value: string, priority: string): void }
  popover: string | null
  attachShadow(options: { readonly mode: 'closed' }): { append(element: PageElement): void }
  append(element: PageElement): void
  remove(): void
  setAttribute(name: string, value: string): void
  showPopover(): void
  hidePopover(): void
}

interface SwipeBubble {
  readonly host: PageElement
  readonly bubble: PageElement
  readonly icon: PageElement
  readonly arrow: PageElement
}

interface PageForm {
  readonly elements: Iterable<unknown>
}

interface PageInput {
  readonly type: string
  readonly name: string
  readonly id: string
  readonly autocomplete: string
  readonly disabled: boolean
  readonly readOnly: boolean
  readonly value: string
  readonly form: PageForm | null
  getClientRects(): { readonly length: number }
  dispatchEvent(event: Event): boolean
}

interface PageSubmit {
  readonly isTrusted: boolean
  readonly target: unknown
}

interface PageShow {
  readonly persisted: boolean
}

interface PageInputEvent {
  readonly isTrusted: boolean
  preventDefault(): void
  stopImmediatePropagation(): void
}

interface PageWheel extends BrowserPageRowWheel, PageInputEvent {
  readonly cancelable: boolean
  readonly defaultPrevented: boolean
  readonly altKey: boolean
  composedPath(): readonly unknown[]
}

interface AutoTarget {
  readonly identifier: PageInput | undefined
  readonly secret: PageInput | undefined
}

declare const window: {
  addEventListener(
    type: 'submit' | 'focusin' | 'input',
    listener: (event: PageSubmit) => void,
    capture: boolean
  ): void
  addEventListener(type: 'pageshow', listener: (event: PageShow) => void): void
  addEventListener(
    type: 'wheel',
    listener: (event: PageWheel) => void,
    options: { readonly capture: boolean; readonly passive: boolean }
  ): void
  addEventListener(type: 'DOMContentLoaded' | 'load' | 'pagehide', listener: () => void): void
  readonly location: { readonly origin: string }
}
declare const document: {
  querySelectorAll(selector: 'input'): Iterable<unknown>
  addEventListener(type: 'visibilitychange', listener: () => void): void
  readonly visibilityState: string
  readonly documentElement: PageElement | null
  readonly scrollingElement: PageElement | null
  readonly fullscreenElement: PageElement | null
  createElement(name: string): PageElement
  createElementNS(namespace: string, name: string): PageElement
}
declare const getComputedStyle: (element: PageInput | PageElement) => {
  readonly visibility: string
  readonly overflowX: string
  readonly overscrollBehaviorX: string
  readonly direction: string
  readonly writingMode: string
}
declare const Element: new () => PageElement
declare const HTMLInputElement: { new (): PageInput; readonly prototype: PageInput }
declare const HTMLFormElement: { new (): PageForm; readonly prototype: PageForm }

const READY_CHANNEL = 'browser:page:ready'
const CANDIDATE_CHANNEL = 'browser:page:candidate'
const FILL_CHANNEL = 'browser:page:fill'
const FORM_CHANNEL = 'browser:page:form'
const SCAN_CHANNEL = 'browser:page:scan'
const ROW_WHEEL_CHANNEL = 'browser:page:row-wheel'
const ROW_WHEEL_ENABLE_CHANNEL = 'browser:page:row-wheel-enable'
const SWIPE_CHANNEL = 'browser:page:swipe'
const SWIPE_STATE_CHANNEL = 'browser:page:swipe-state'
const SWIPE_SEQUENCE_CHANNEL = 'browser:page:swipe-sequence'
const WHEEL_DELTA_MAX = 10_000
const USERNAME_MAX = 1024
const PASSWORD_MAX = 8192
const TEXT_TYPES = new Set(['text', 'email', 'tel'])
const IDENTIFIER_HINT = /user|email|login|account|identifier/i
const SCAN_DELAYS = [300, 700, 2000]

function mintToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

let documentToken = mintToken()
let scanTimer: ReturnType<typeof setTimeout> | null = null
let identifierSignalled = false
let rowWheelEnabled = false
let swipeHistory: BrowserPageSwipeState | null = null
let swipeState: SwipeState = { kind: 'idle', gesture: 0, begin: null }
let swipeTimer: ReturnType<typeof setTimeout> | null = null
let swipeBubble: SwipeBubble | null = null
let swipeBubbleGesture: number | null = null
const swipeChecks = new Map<
  ReturnType<typeof setTimeout>,
  { readonly event: PageWheel; readonly gesture: number }
>()
const edited = new WeakSet<PageInput>()

function announce(): void {
  ipcRenderer.send(READY_CHANNEL, { documentToken })
}

function inputs(source: Iterable<unknown>): PageInput[] {
  return Array.from(source).filter(
    (element): element is PageInput => element instanceof HTMLInputElement
  )
}

function autocompleteOf(input: PageInput): string {
  return input.autocomplete.toLowerCase()
}

function excluded(input: PageInput): boolean {
  const autocomplete = autocompleteOf(input)
  return autocomplete.includes('new-password') || autocomplete.includes('one-time-code')
}

function identifierLike(input: PageInput): boolean {
  if (!TEXT_TYPES.has(input.type) || excluded(input)) return false
  const autocomplete = autocompleteOf(input)
  if (autocomplete.includes('username') || autocomplete.includes('email')) return true
  return input.type === 'email' || IDENTIFIER_HINT.test(`${input.name} ${input.id}`)
}

function explicitIdentifier(input: PageInput): boolean {
  return identifierLike(input) && autocompleteOf(input).includes('username')
}

function visible(input: PageInput): boolean {
  return (
    !input.disabled &&
    !input.readOnly &&
    input.getClientRects().length > 0 &&
    getComputedStyle(input).visibility !== 'hidden'
  )
}

function visibleInputs(): PageInput[] {
  return inputs(document.querySelectorAll('input')).filter(visible)
}

function candidateOf(form: PageForm): BrowserPageCandidate | null {
  const fields = inputs(form.elements)
  const passwords = fields.filter((input) => input.type === 'password' && input.value !== '')
  if (passwords.length > 1 || passwords.some(excluded)) return null
  const identifier = fields.find((input) => identifierLike(input) && input.value.trim() !== '')
  const username = identifier?.value.trim() ?? ''
  if (username.length > USERNAME_MAX) return null
  const password = passwords[0]
  if (password === undefined) {
    return username === '' ? null : { kind: 'identifier', documentToken, username }
  }
  if (password.value.length > PASSWORD_MAX) return null
  return { kind: 'credential', documentToken, username, password: password.value }
}

function identifierCandidates(
  fields: readonly PageInput[],
  secret: PageInput | undefined
): PageInput[] {
  const scope = secret?.form ?? null
  return fields.filter((input) =>
    secret === undefined
      ? explicitIdentifier(input)
      : identifierLike(input) && (scope === null || input.form === scope)
  )
}

function userEdited(secret: PageInput | undefined, candidates: readonly PageInput[]): boolean {
  const targets = secret === undefined ? candidates : [secret, ...candidates]
  return targets.some((input) => edited.has(input))
}

function loginPhase(): BrowserFormPhase | null {
  const fields = visibleInputs()
  const secrets = fields.filter((input) => input.type === 'password')
  if (secrets.length > 1 || secrets.some(excluded)) return null
  const secret = secrets[0]
  if (secret !== undefined && secret.value !== '') return null
  const candidates = identifierCandidates(fields, secret)
  if (userEdited(secret, candidates)) return null
  if (secret === undefined) {
    const only = candidates.length === 1 ? candidates[0] : undefined
    return only?.value === '' ? 'identifier' : null
  }
  return secret.form === null && candidates.length > 1 ? null : 'password'
}

function scan(): void {
  const phase = loginPhase()
  if (phase === null || (phase === 'identifier' && identifierSignalled)) return
  if (phase === 'identifier') identifierSignalled = true
  const message: BrowserPageForm = { documentToken, phase }
  ipcRenderer.send(FORM_CHANNEL, message)
}

function stopScanning(): void {
  if (scanTimer !== null) clearTimeout(scanTimer)
  scanTimer = null
}

function scanLater(step: number): void {
  const delay = SCAN_DELAYS[step]
  if (delay === undefined) return
  scanTimer = setTimeout(() => {
    scanTimer = null
    scan()
    scanLater(step + 1)
  }, delay)
}

function startScanning(): void {
  stopScanning()
  identifierSignalled = false
  scan()
  scanLater(0)
}

function isFill(value: unknown): value is BrowserPageFill {
  return (
    typeof value === 'object' &&
    value !== null &&
    'documentToken' in value &&
    typeof value.documentToken === 'string' &&
    'origin' in value &&
    typeof value.origin === 'string' &&
    'username' in value &&
    typeof value.username === 'string' &&
    'password' in value &&
    typeof value.password === 'string' &&
    'mode' in value &&
    (value.mode === 'manual' || value.mode === 'automatic')
  )
}

function isScan(value: unknown): value is { readonly documentToken: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'documentToken' in value &&
    typeof value.documentToken === 'string'
  )
}

function assign(input: PageInput, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  if (descriptor?.set === undefined) return
  descriptor.set.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function fill(username: string, password: string): void {
  const fields = visibleInputs()
  const secret = fields.find((input) => input.type === 'password' && !excluded(input))
  const scope = secret?.form ?? null
  const identifier = fields.find(
    (input) => identifierLike(input) && (scope === null || input.form === scope)
  )
  if (identifier !== undefined && username !== '') assign(identifier, username)
  if (secret !== undefined) assign(secret, password)
}

function addressed(message: BrowserPageFill): boolean {
  return message.documentToken === documentToken && message.origin === window.location.origin
}

function autoTarget(username: string): AutoTarget | null {
  const fields = visibleInputs()
  const secrets = fields.filter((input) => input.type === 'password')
  if (secrets.length > 1 || secrets.some(excluded)) return null
  const secret = secrets[0]
  if (secret !== undefined && secret.value !== '') return null
  const scope = secret?.form ?? null
  const context = scope === null ? fields : inputs(scope.elements)
  const other = context.some((input) => {
    const typed = identifierLike(input) ? input.value.trim() : ''
    return typed !== '' && typed !== username
  })
  if (other) return null
  const candidates = identifierCandidates(fields, secret)
  if (scope === null && candidates.length > 1) return null
  if (userEdited(secret, candidates)) return null
  return { identifier: candidates[0], secret }
}

function autoFill(message: BrowserPageFill): void {
  const { username, password } = message
  const target = autoTarget(username)
  if (target === null) return
  const { identifier, secret } = target
  if (identifier?.value === '' && username !== '') {
    assign(identifier, username)
  }
  if (secret === undefined || !addressed(message)) return
  const after = autoTarget(username)
  if (after?.secret !== secret || after.identifier !== identifier) return
  if (identifier !== undefined && username !== '' && identifier.value.trim() !== username) return
  assign(secret, password)
}

function isSwipeRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isSwipeHistory(value: unknown): value is BrowserPageSwipeState {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 4 &&
    'back' in value &&
    typeof value.back === 'boolean' &&
    'forward' in value &&
    typeof value.forward === 'boolean' &&
    'zoom' in value &&
    typeof value.zoom === 'number' &&
    Number.isFinite(value.zoom) &&
    value.zoom > 0 &&
    value.zoom <= 10 &&
    'revision' in value &&
    isSwipeRevision(value.revision)
  )
}

function isSwipeSequence(value: unknown): value is BrowserPageSwipeSequence {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 2 &&
    'phase' in value &&
    (value.phase === 'begin' || value.phase === 'end') &&
    'sequence' in value &&
    isSwipeRevision(value.sequence)
  )
}

function swipePath(event: PageWheel): ScrollBox[] {
  const root = document.scrollingElement
  const elements = event
    .composedPath()
    .filter((element): element is PageElement => element instanceof Element)
  if (root !== null && !elements.includes(root)) elements.push(root)
  return elements.map((element) => {
    const computed = getComputedStyle(element)
    return {
      root: element === root,
      horizontal: computed.writingMode === 'horizontal-tb',
      overflowX: computed.overflowX,
      overscrollX: computed.overscrollBehaviorX,
      rtl: computed.direction === 'rtl',
      scrollLeft: element.scrollLeft,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }
  })
}

function swipeStyle(element: PageElement, properties: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(properties)) {
    element.style.setProperty(name, value, 'important')
  }
}

function createSwipeBubble(direction: SwipeDirection, zoom: number): SwipeBubble | null {
  const root = document.documentElement
  if (root === null) return null
  const host = document.createElement('div')
  try {
    swipeStyle(host, {
      all: 'initial',
      display: 'block',
      position: 'fixed',
      top: '0',
      left: '0',
      width: '0',
      height: '0',
      'pointer-events': 'none',
    })
    const shadow = host.attachShadow({ mode: 'closed' })
    const bubble = document.createElement('div')
    bubble.popover = 'manual'
    bubble.setAttribute('aria-hidden', 'true')
    swipeStyle(bubble, {
      all: 'initial',
      position: 'fixed',
      inset: 'auto',
      top: '50%',
      margin: '0',
      padding: '0',
      display: 'flex',
      'align-items': 'center',
      'justify-content': 'center',
      'box-sizing': 'border-box',
      'border-radius': '50%',
      transform: 'translateY(-50%)',
      'pointer-events': 'none',
    })
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    icon.setAttribute('viewBox', '0 0 24 24')
    icon.setAttribute('focusable', 'false')
    swipeStyle(icon, {
      all: 'initial',
      display: 'block',
      'pointer-events': 'none',
    })
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    arrow.setAttribute(
      'd',
      direction === 'back' ? 'M14 6l-6 6 6 6M8 12h12' : 'M10 6l6 6-6 6M16 12H4'
    )
    arrow.setAttribute('fill', 'none')
    arrow.setAttribute('stroke-width', '2')
    arrow.setAttribute('stroke-linecap', 'round')
    arrow.setAttribute('stroke-linejoin', 'round')
    icon.append(arrow)
    bubble.append(icon)
    shadow.append(bubble)
    const result = { host, bubble, icon, arrow }
    paintSwipeBubble(result, direction, zoom, 0)
    root.append(host)
    bubble.showPopover()
    return result
  } catch {
    host.remove()
    return null
  }
}

function paintSwipeBubble(
  current: SwipeBubble,
  direction: SwipeDirection,
  zoom: number,
  progress: number
): void {
  const offset = `${String((-36 + 60 * progress) / zoom)}px`
  swipeStyle(current.bubble, {
    width: `${String(36 / zoom)}px`,
    height: `${String(36 / zoom)}px`,
    left: direction === 'back' ? offset : 'auto',
    right: direction === 'forward' ? offset : 'auto',
    opacity: String(0.4 + 0.6 * progress),
    background: progress >= 1 ? '#1a73e8' : '#ffffff',
    border: `${String(1 / zoom)}px solid ${progress >= 1 ? '#1a73e8' : '#dadce0'}`,
    'box-shadow': `0 ${String(2 / zoom)}px ${String(8 / zoom)}px rgba(0, 0, 0, 0.2)`,
  })
  swipeStyle(current.icon, {
    width: `${String(20 / zoom)}px`,
    height: `${String(20 / zoom)}px`,
  })
  current.arrow.setAttribute('stroke', progress >= 1 ? '#ffffff' : '#5f6368')
}

function removeSwipeBubble(): void {
  const current = swipeBubble
  swipeBubble = null
  if (current === null) return
  try {
    current.bubble.hidePopover()
  } catch {
    current.host.remove()
    return
  }
  current.host.remove()
}

function renderSwipeBubble(): void {
  const history = swipeHistory
  if (swipeState.kind !== 'tracking' || history === null) {
    removeSwipeBubble()
    swipeBubbleGesture = null
    return
  }
  if (swipeBubble !== null && !swipeBubble.host.isConnected) {
    removeSwipeBubble()
    return
  }
  if (swipeBubble === null && swipeBubbleGesture !== swipeState.gesture) {
    swipeBubbleGesture = swipeState.gesture
    swipeBubble = createSwipeBubble(swipeState.direction, history.zoom)
  }
  if (swipeBubble !== null) {
    paintSwipeBubble(swipeBubble, swipeState.direction, history.zoom, swipeProgress(swipeState))
  }
}

function scheduleSwipeTick(): void {
  if (swipeTimer !== null) clearTimeout(swipeTimer)
  swipeTimer = null
  const state = swipeState
  if (state.kind === 'idle') return
  const delay =
    state.kind === 'settling'
      ? SWIPE_SETTLE_MS
      : state.sequence === null
        ? SWIPE_FALLBACK_MS
        : SWIPE_LOST_MS
  swipeTimer = setTimeout(
    () => {
      swipeTimer = null
      advanceSwipe({ kind: 'tick', time: performance.now() })
    },
    Math.max(1, Math.ceil(state.last + delay - performance.now()))
  )
}

function flushSwipeChecks(): void {
  for (const [timer, check] of swipeChecks) {
    clearTimeout(timer)
    if (!check.event.defaultPrevented) continue
    swipeState = swipeReduce(swipeState, {
      kind: 'consumed',
      gesture: check.gesture,
      time: performance.now(),
    }).state
  }
  swipeChecks.clear()
}

function advanceSwipe(input: SwipeInput): void {
  if (input.kind === 'end' || input.kind === 'tick') flushSwipeChecks()
  const step = swipeReduce(swipeState, input)
  swipeState = step.state
  renderSwipeBubble()
  scheduleSwipeTick()
  if (step.navigate !== null) ipcRenderer.send(SWIPE_CHANNEL, step.navigate)
}

function resetSwipe(clearHistory: boolean): void {
  if (swipeTimer !== null) clearTimeout(swipeTimer)
  swipeTimer = null
  for (const timer of swipeChecks.keys()) clearTimeout(timer)
  swipeChecks.clear()
  swipeState = { kind: 'idle', gesture: swipeState.gesture, begin: null }
  if (clearHistory) swipeHistory = null
  removeSwipeBubble()
  swipeBubbleGesture = null
}

function pageSwipe(event: PageWheel): void {
  const history = swipeHistory
  if (history === null || !event.isTrusted) return
  const time = performance.now()
  let wheel: SwipeWheel = {
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaMode: event.deltaMode,
    modified: event.shiftKey || event.ctrlKey || event.metaKey || event.altKey,
    fullscreen: document.fullscreenElement !== null,
    path: [],
  }
  const opening =
    swipeState.kind === 'idle' ||
    (swipeState.kind === 'settling' && time - swipeState.last >= SWIPE_SETTLE_MS)
  if (
    opening &&
    usableWheel(wheel) &&
    !wheel.fullscreen &&
    Math.abs(wheel.deltaX) > Math.abs(wheel.deltaY) &&
    history[wheel.deltaX < 0 ? 'back' : 'forward']
  ) {
    wheel = { ...wheel, path: swipePath(event) }
  }
  advanceSwipe({ kind: 'wheel', time, wheel, history })
  if (!event.cancelable || (swipeState.kind !== 'tracking' && swipeState.kind !== 'ignored')) {
    return
  }
  const gesture = swipeState.gesture
  const timer = setTimeout(() => {
    swipeChecks.delete(timer)
    if (event.defaultPrevented) {
      advanceSwipe({ kind: 'consumed', gesture, time: performance.now() })
    }
  }, 0)
  swipeChecks.set(timer, { event, gesture })
}

function rowWheel(event: PageWheel): BrowserPageRowWheel | null {
  const { deltaX, deltaY, deltaMode, shiftKey, ctrlKey, metaKey } = event
  if (!shiftKey && Math.abs(deltaX) <= Math.abs(deltaY)) return null
  if (deltaX === 0 && (!shiftKey || deltaY === 0)) return null
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return null
  if (Math.abs(deltaX) > WHEEL_DELTA_MAX || Math.abs(deltaY) > WHEEL_DELTA_MAX) return null
  if (deltaMode !== 0 && deltaMode !== 1 && deltaMode !== 2) return null
  return { deltaX, deltaY, deltaMode, shiftKey, ctrlKey, metaKey }
}

function block(event: PageInputEvent): void {
  event.preventDefault()
  event.stopImmediatePropagation()
}

window.addEventListener(
  'wheel',
  (event) => {
    if (
      !rowWheelEnabled ||
      !event.isTrusted ||
      !event.cancelable ||
      event.ctrlKey ||
      event.metaKey
    ) {
      return
    }
    const message = rowWheel(event)
    if (message === null) return
    block(event)
    ipcRenderer.send(ROW_WHEEL_CHANNEL, message)
  },
  { capture: true, passive: false }
)

window.addEventListener('wheel', pageSwipe, { capture: true, passive: true })

window.addEventListener(
  'submit',
  (event) => {
    if (!event.isTrusted || !(event.target instanceof HTMLFormElement)) return
    const candidate = candidateOf(event.target)
    if (candidate !== null) ipcRenderer.send(CANDIDATE_CHANNEL, candidate)
  },
  true
)

window.addEventListener(
  'input',
  (event) => {
    if (event.isTrusted && event.target instanceof HTMLInputElement) edited.add(event.target)
  },
  true
)

window.addEventListener(
  'focusin',
  (event) => {
    if (!event.isTrusted || !(event.target instanceof HTMLInputElement)) return
    const input = event.target
    if (input.type !== 'password' && !identifierLike(input)) return
    if (scanTimer === null) startScanning()
    else scan()
  },
  true
)

window.addEventListener('DOMContentLoaded', startScanning)
window.addEventListener('load', startScanning)
window.addEventListener('pagehide', stopScanning)
window.addEventListener('pagehide', () => {
  resetSwipe(true)
})

window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return
  documentToken = mintToken()
  announce()
  startScanning()
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') startScanning()
  else if (swipeHistory !== null) resetSwipe(false)
})

ipcRenderer.on(SWIPE_STATE_CHANNEL, (_event, message: unknown) => {
  if (!isSwipeHistory(message)) return
  swipeHistory = message
  advanceSwipe({ kind: 'history', time: performance.now(), history: message })
})

ipcRenderer.on(SWIPE_SEQUENCE_CHANNEL, (_event, message: unknown) => {
  if (
    swipeHistory === null ||
    document.visibilityState !== 'visible' ||
    !isSwipeSequence(message)
  ) {
    return
  }
  const time = performance.now()
  if (message.phase === 'begin') advanceSwipe({ kind: 'begin', sequence: message.sequence, time })
  else advanceSwipe({ kind: 'end', sequence: message.sequence, time })
})

ipcRenderer.on(SCAN_CHANNEL, (_event, message: unknown) => {
  if (!isScan(message) || message.documentToken !== documentToken) return
  startScanning()
})

ipcRenderer.on(ROW_WHEEL_ENABLE_CHANNEL, () => {
  rowWheelEnabled = true
})

ipcRenderer.on(FILL_CHANNEL, (_event, message: unknown) => {
  if (!isFill(message) || !addressed(message)) return
  if (message.mode === 'automatic') autoFill(message)
  else fill(message.username, message.password)
})

announce()

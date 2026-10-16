import {
  BrowserStorageService,
  Storage,
  StorageScope,
} from '@codingame/monaco-vscode-storage-service-override'
import { Emitter } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'
import {
  StorageTarget,
  WillSaveStateReason,
} from '@codingame/monaco-vscode-api/vscode/vs/platform/storage/common/storage'
import type { IStorage } from '@codingame/monaco-vscode-api/vscode/vs/base/parts/storage/common/storage'
import type {
  IStorageDatabase,
  IStorageItemsChangeEvent,
  IUpdateRequest,
  StorageValue,
} from '@codingame/monaco-vscode-api/vscode/vs/base/parts/storage/common/storage'
import type { WorkbenchTerminalEnv } from '../../../shared/workbench-ipc.js'
import {
  bindIssuedTerminalEnv,
  currentTerminalEnv,
  issueTerminalEnv,
  parseIssuedTerminalEnv,
  retainIssuedTerminalEnv,
  reviveTerminalEnv,
  serializeIssuedTerminalEnv,
} from './terminal-env.js'

const databases = new Set<ChorusStorageDatabase>()

export async function flushWorkbenchStorage(): Promise<void> {
  const deadline = Date.now() + 4_000
  for (;;) {
    const results = await Promise.allSettled([...databases].map((database) => database.flush()))
    const failure = results.find((result) => result.status === 'rejected')
    if (failure === undefined) return
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      const error: unknown = failure.reason
      throw error
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, remaining)))
  }
}

export function stopWorkbenchStorageRetries(): void {
  for (const database of databases) database.disposeRetries()
}

/**
 * The workbench's key-value store, made durable through Chorus rather than
 * through the browser.
 *
 * **Why it cannot be the browser's.** The surface runs on a partition with no
 * `persist:` prefix, so IndexedDB — which is what this service would otherwise
 * use — is gone the moment the app quits. That partition choice is right and is
 * not up for revisiting here: `workbench-surface.ts` explains that persisting it
 * would put a connection token in a Chromium profile. Durability is bought the
 * same way `settings.json` buys it, by main holding a file under Chorus's own
 * `userData`.
 *
 * **What it fixes, concretely.** Two things that looked unrelated and were one
 * bug: a folder's **workspace-trust** answer was asked again on every launch, and
 * every extension with a one-time greeting greeted you again on every launch.
 * Both live in this service. The first is the one that matters — a security
 * prompt shown on a loop is a security prompt people learn to dismiss without
 * reading.
 *
 * **Deliberately not merged with `workbench-user-settings.ts`.** They look
 * similar and are not: settings are one document a person writes and reads, this
 * is machine-written state nobody hand-edits. Folding them into one file would
 * put a 5 MB extension cache in the file somebody opens to change
 * `files.autoSave`.
 */
export class ChorusStorageDatabase implements IStorageDatabase {
  /**
   * A real emitter, because other surfaces really do change this file.
   *
   * This was `Event.None` with a comment claiming "nothing else writes this file
   * while the workbench is up" — true of one surface and false of five, which is
   * the normal case. The same comment predicted its own failure: *"if two
   * surfaces ever share a scope this becomes wrong."* They always did.
   *
   * It was `Event.None`, which was honest at the time — nothing could report an
   * external change — and became a lie the moment several surfaces shared a
   * scope. `IStorageDatabase` uses this event to tell the service its cache is
   * stale; without it every project drifted from the file until relaunch.
   */
  private readonly external = new Emitter<IStorageItemsChangeEvent>()
  readonly onDidChangeItemsExternal = this.external.event

  /**
   * The authority while the workbench is running.
   *
   * `getItems` is called once at open and every `updateItems` is a delta, so the
   * service's own view and this cache cannot diverge — which is what lets a write
   * send the whole map without reading the file back first.
   */
  private items = new Map<string, string>()
  private clientItems: ReadonlyMap<string, string> | null = null
  private readonly committed = new Map<string, string>()
  private loaded = false
  private loading: Promise<void> | null = null
  private readonly unsaved = new Map<string, { value: string | null; revision: number }>()
  private revision = 0
  private flushing: Promise<void> | null = null
  private sending: ReadonlyMap<string, { value: string | null; revision: number }> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelay = 500
  private closed = false
  private closing = false
  private readonly unsubscribe: () => void
  /**
   * Deltas that arrived before the snapshot did.
   *
   * **The handshake, and it is not decoration.** Subscribing happens in the
   * constructor and the snapshot is fetched asynchronously, so another surface
   * can write in between — and applying its delta *before* the snapshot lands
   * would see it overwritten by older data a moment later. Buffering and
   * replaying after the snapshot makes the order deterministic rather than
   * dependent on how fast an IPC round trip happened to be.
   */
  private pending: { insert: Record<string, string>; remove: readonly string[] }[] = []

  constructor(private readonly scope: string) {
    databases.add(this)
    this.unsubscribe = window.chorusWorkbench.onStorageChanged((scope, insert, remove) => {
      if (scope !== this.scope) return
      if (!this.loaded) {
        this.pending.push({ insert, remove })
        return
      }
      this.applyExternal(insert, remove)
    })
  }

  /** Applies another surface's delta and tells the service its cache moved. */
  private applyExternal(insert: Record<string, string>, remove: readonly string[]): void {
    // `changed` carries the values, not just the keys — the service applies the
    // map directly rather than reading back through `getItems`.
    const changed = new Map<string, string>()
    const deleted = new Set<string>()
    for (const [key, value] of Object.entries(insert)) {
      this.committed.set(key, value)
      if (this.sending?.has(key)) continue
      this.unsaved.delete(key)
      if (this.items.get(key) === value) continue
      this.items.set(key, value)
      changed.set(key, value)
    }
    for (const key of remove) {
      this.committed.delete(key)
      if (this.sending?.has(key)) continue
      this.unsaved.delete(key)
      if (this.items.delete(key)) deleted.add(key)
    }
    if (changed.size > 0 || deleted.size > 0) this.external.fire({ changed, deleted })
    if (this.closing && this.unsaved.size === 0 && this.sending === null) this.disposeRetries()
  }

  /**
   * **A copy, and returning the live map instead was a real bug.**
   *
   * `Storage` takes ownership of whatever this resolves to and mutates it in
   * place on every `set` and `delete`. Handing back `this.items` therefore made
   * the service's cache and this one the same object, so by the time
   * `updateItems` arrived with the delta the "has anything actually changed?"
   * test already saw the new value, concluded nothing had changed, and skipped
   * the write — every time, for the life of the app.
   */
  async getItems(): Promise<Map<string, string>> {
    await this.load()
    const items = new Map(this.items)
    this.clientItems = items
    return items
  }

  private load(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    if (this.loading !== null) return this.loading
    this.loading = this.loadSnapshot().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  private isShut(): boolean {
    return this.closed || this.closing
  }

  private async loadSnapshot(): Promise<void> {
    const raw = await window.chorusWorkbench.readStorage(this.scope)
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'string') {
              this.items.set(key, value)
              this.committed.set(key, value)
            }
          }
        }
      } catch {
        /*
         * An unreadable scope starts empty rather than taking the workbench down.
         * This runs during startup, and the state being restored is a cache of
         * decisions — losing it costs a re-asked prompt, while throwing costs an
         * editor that will not open.
         */
      }
    }
    this.loaded = true
    // Replayed in arrival order, after the snapshot they raced.
    const queued = this.pending
    this.pending = []
    for (const delta of queued) this.applyExternal(delta.insert, delta.remove)
  }

  /**
   * Sends **only what changed**, never the whole map.
   *
   * Sending the map was a data-loss bug: every surface holds its own cache of the
   * shared scopes, so one surface's write replaced the scope with its own view of
   * it and deleted whatever another surface had stored since. Two projects open
   * was enough to lose a GitLab account or a trust decision; five made it
   * constant. Main merges deltas onto the authoritative copy, so a surface can no
   * longer say "and delete everything I have not heard about" by accident.
   */
  async updateItems(request: IUpdateRequest): Promise<void> {
    if (this.isShut()) throw new Error('Workbench storage is closed')
    await this.load()
    if (this.isShut()) throw new Error('Workbench storage is closed')

    for (const [key, value] of request.insert ?? new Map<string, string>()) {
      if (this.items.get(key) === value) continue
      this.items.set(key, value)
      this.unsaved.set(key, { value, revision: ++this.revision })
    }
    for (const key of request.delete ?? new Set<string>()) {
      if (this.items.delete(key)) {
        this.unsaved.set(key, { value: null, revision: ++this.revision })
      }
    }
    // A flush that changed nothing is most of them: the service flushes on a
    // timer as well as on a real write.
    this.clearRetry()
    await this.flushPending()
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private flushPending(): Promise<void> {
    if (this.flushing !== null) return this.flushing
    if (this.unsaved.size === 0) return Promise.resolve()
    const run = async (): Promise<void> => {
      while (this.unsaved.size > 0) {
        const batch = new Map(this.unsaved)
        const insert: Record<string, string> = {}
        const remove: string[] = []
        for (const [key, change] of batch) {
          if (change.value === null) remove.push(key)
          else insert[key] = change.value
        }
        this.sending = batch
        await window.chorusWorkbench.applyStorageDelta(this.scope, insert, remove)
        for (const [key, change] of batch) {
          if (change.value === null) this.committed.delete(key)
          else this.committed.set(key, change.value)
          if (this.unsaved.get(key)?.revision === change.revision) this.unsaved.delete(key)
        }
        this.sending = null
      }
      this.retryDelay = 500
      if (this.closing) this.disposeRetries()
    }
    this.flushing = run()
      .catch((error: unknown) => {
        const invalid = error instanceof Error && error.message.includes('too large')
        if (invalid && this.sending !== null) {
          const changed = new Map<string, string>()
          const deleted = new Set<string>()
          for (const [key, change] of this.sending) {
            if (this.unsaved.get(key)?.revision !== change.revision) continue
            this.unsaved.delete(key)
            const value = this.committed.get(key)
            const canRestoreClient = this.clientItems?.get(key) === (change.value ?? undefined)
            if (value === undefined) {
              this.items.delete(key)
              if (canRestoreClient) deleted.add(key)
            } else {
              this.items.set(key, value)
              if (canRestoreClient) changed.set(key, value)
            }
          }
          if (changed.size > 0 || deleted.size > 0) this.external.fire({ changed, deleted })
        }
        this.sending = null
        if (!this.closed && this.unsaved.size > 0 && this.retryTimer === null) {
          this.retryTimer = setTimeout(
            () => {
              this.retryTimer = null
              void this.flushPending().catch(() => undefined)
            },
            invalid ? 0 : this.retryDelay
          )
          if (!invalid) this.retryDelay = Math.min(this.retryDelay * 2, 30_000)
        }
        throw error
      })
      .finally(() => {
        this.flushing = null
      })
    return this.flushing
  }

  /** Nothing to compact: the file holds exactly the live map and no tombstones. */
  optimize(): Promise<void> {
    return this.flushPending()
  }

  flush(): Promise<void> {
    this.clearRetry()
    return this.flushPending()
  }

  disposeRetries(): void {
    if (this.closed) return
    this.closed = true
    this.clearRetry()
    this.unsubscribe()
    this.external.dispose()
    databases.delete(this)
  }

  async close(): Promise<void> {
    this.closing = true
    const deadline = Date.now() + 4_000
    for (;;) {
      try {
        await this.flush()
        this.disposeRetries()
        return
      } catch (error) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw error
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, remaining)))
      }
    }
  }
}

export const SIDE_BAR_SIZE_KEY = 'workbench.sideBar.size'
export const SIDE_BAR_DEFAULT_WIDTH = 350
export const SHARED_SIDE_BAR_LAYOUT_KEY = 'chorus.sideBar.layout'
const SIDE_BAR_HIDDEN_KEY = 'workbench.sideBar.hidden'
const SIDE_BAR_DEFAULT_APPLIED_KEY = 'chorus.sideBar.defaultWidthApplied'
const PANEL_SIZE_KEY = 'workbench.panel.size'
const PANEL_DEFAULT_HEIGHT = 400
const PANEL_DEFAULT_APPLIED_KEY = 'chorus.panel.defaultHeightApplied'
const PROJECT_PANEL_KEYS: ReadonlySet<string> = new Set([
  PANEL_SIZE_KEY,
  'workbench.panel.lastNonMaximizedHeight',
  'workbench.panel.lastNonMaximizedWidth',
])
const TERMINAL_BUFFER_STATE_KEY = 'terminal.integrated.bufferState'
const TERMINAL_ISSUED_ENV_KEY = 'chorus.terminal.issuedEnv'

export interface SideBarLayout {
  width: number
  hidden: boolean
}

export function parseSideBarLayout(raw: string | undefined): SideBarLayout | undefined {
  if (raw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('width' in parsed) ||
      typeof parsed.width !== 'number' ||
      !Number.isFinite(parsed.width) ||
      parsed.width <= 0 ||
      !('hidden' in parsed) ||
      typeof parsed.hidden !== 'boolean'
    ) {
      return undefined
    }
    return { width: parsed.width, hidden: parsed.hidden }
  } catch {
    return undefined
  }
}

/**
 * Adds the one storage scope the override package cannot reach.
 *
 * **`APPLICATION_SHARED` is not in `DatabaseFactories`.** That interface accepts
 * `APPLICATION`, `PROFILE` and `WORKSPACE` and nothing else, so a fourth scope —
 * `StorageScope.APPLICATION_SHARED`, numerically `-2` — falls through to the base
 * class's `createApplicationSharedStorage`, which is IndexedDB
 * `vscode-web-state-db-global-shared`. On this surface's in-memory partition that
 * database does not survive a quit.
 *
 * **It matters because that is where workspace trust lives.**
 * `WorkspaceTrustManagementService` reads and writes `content.trust.model.key` at
 * `StorageScope.APPLICATION_SHARED`, so every "yes, I trust this folder" was
 * being written to a database destroyed on exit — which is why the prompt
 * returned on every launch and every window opened in Restricted Mode, even
 * after the other three scopes were made durable. An earlier comment in
 * `workbench-storage.ts` claimed trust was already covered; it was not, and this
 * is the change that makes the claim true.
 *
 * `getStorage` and `doInitialize` are `protected` on the base class, so this is
 * an intended extension point rather than a reach-in — but it is still a
 * dependency on a shape `@codingame` could move in a version bump, which is why
 * it is one small subclass in one file rather than spread across the wiring.
 */
export class ChorusStorageService extends BrowserStorageService {
  private sharedStorage: Storage | undefined
  private shutdown: Promise<void> | null = null

  shutdownStorage(): Promise<void> {
    if (this.shutdown !== null) return this.shutdown
    this.emitWillSaveState(WillSaveStateReason.SHUTDOWN)
    const scopes = [
      StorageScope.APPLICATION,
      StorageScope.APPLICATION_SHARED,
      StorageScope.PROFILE,
      StorageScope.WORKSPACE,
    ]
    const storages = scopes
      .map((scope) => this.getStorage(scope))
      .filter((storage): storage is IStorage => storage !== undefined)
    this.shutdown = (async () => {
      await Promise.allSettled(storages.map((storage) => storage.close()))
      await flushWorkbenchStorage()
      super.close()
    })()
    return this.shutdown
  }

  protected override getStorage(scope: StorageScope): IStorage | undefined {
    if (scope === StorageScope.APPLICATION_SHARED) return this.sharedStorage
    return super.getStorage(scope)
  }

  override get(key: string, scope: StorageScope, fallbackValue: string): string
  override get(key: string, scope: StorageScope): string | undefined
  override get(key: string, scope: StorageScope, fallbackValue?: string): string | undefined {
    if (
      (scope === StorageScope.PROFILE && key === SIDE_BAR_SIZE_KEY) ||
      (scope === StorageScope.WORKSPACE && key === SIDE_BAR_HIDDEN_KEY)
    ) {
      const shared = parseSideBarLayout(super.get(SHARED_SIDE_BAR_LAYOUT_KEY, StorageScope.PROFILE))
      if (shared !== undefined) {
        return String(key === SIDE_BAR_SIZE_KEY ? shared.width : shared.hidden)
      }
    }
    if (scope === StorageScope.PROFILE && PROJECT_PANEL_KEYS.has(key)) {
      const own = super.get(key, StorageScope.WORKSPACE)
      if (own !== undefined) return own
    }
    return fallbackValue === undefined
      ? super.get(key, scope)
      : super.get(key, scope, fallbackValue)
  }

  override store(
    key: string,
    value: StorageValue,
    scope: StorageScope,
    target: StorageTarget,
    external?: boolean
  ): void {
    if (scope === StorageScope.PROFILE && PROJECT_PANEL_KEYS.has(key)) {
      super.store(key, value, StorageScope.WORKSPACE, target, external)
    }
    super.store(key, value, scope, target, external)
  }

  protected override async doInitialize(): Promise<void> {
    /*
     * Created and initialised alongside the base scopes rather than lazily. The
     * trust service reads its key during startup, and a scope that initialises
     * after that read answers "nothing stored" — which is exactly the bug being
     * fixed, arriving by a different route.
     */
    this.sharedStorage = new Storage(new ChorusStorageDatabase('application-shared'))
    await Promise.all([this.sharedStorage.init(), super.doInitialize()])
    this.applyDefaultSize(SIDE_BAR_SIZE_KEY, SIDE_BAR_DEFAULT_WIDTH, SIDE_BAR_DEFAULT_APPLIED_KEY)
    this.applyDefaultSize(PANEL_SIZE_KEY, PANEL_DEFAULT_HEIGHT, PANEL_DEFAULT_APPLIED_KEY)
    this.reviveTerminals()
  }

  private reviveTerminals(): void {
    const saved = this.get(TERMINAL_BUFFER_STATE_KEY, StorageScope.WORKSPACE)
    const issued = this.issuedTerminalEnv()
    const current = currentTerminalEnv()
    const revived = reviveTerminalEnv(saved, issued, current)
    if (revived.raw !== undefined && revived.raw !== saved) {
      this.store(
        TERMINAL_BUFFER_STATE_KEY,
        revived.raw,
        StorageScope.WORKSPACE,
        StorageTarget.MACHINE
      )
    }
    const retained = retainIssuedTerminalEnv(issued, revived.cleaned, current)
    if (retained.length > 0) this.keepIssuedTerminalEnv(retained)
    else if (revived.cleaned) this.remove(TERMINAL_ISSUED_ENV_KEY, StorageScope.WORKSPACE)
    bindIssuedTerminalEnv((env) => {
      this.keepIssuedTerminalEnv(issueTerminalEnv(this.issuedTerminalEnv(), env))
    })
  }

  private issuedTerminalEnv(): readonly WorkbenchTerminalEnv[] {
    return parseIssuedTerminalEnv(this.get(TERMINAL_ISSUED_ENV_KEY, StorageScope.WORKSPACE))
  }

  private keepIssuedTerminalEnv(issued: readonly WorkbenchTerminalEnv[]): void {
    const next = serializeIssuedTerminalEnv(issued)
    if (next === this.get(TERMINAL_ISSUED_ENV_KEY, StorageScope.WORKSPACE)) return
    this.store(TERMINAL_ISSUED_ENV_KEY, next, StorageScope.WORKSPACE, StorageTarget.MACHINE)
  }

  private applyDefaultSize(sizeKey: string, size: number, appliedKey: string): void {
    const applied = String(size)
    if (this.get(appliedKey, StorageScope.PROFILE) === applied) return
    super.store(sizeKey, size, StorageScope.PROFILE, StorageTarget.MACHINE)
    this.store(appliedKey, applied, StorageScope.PROFILE, StorageTarget.MACHINE)
  }
}

import {
  BrowserStorageService,
  Storage,
  StorageScope,
} from '@codingame/monaco-vscode-storage-service-override'
import { Emitter } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'
import type { IStorage } from '@codingame/monaco-vscode-api/vscode/vs/base/parts/storage/common/storage'
import type {
  IStorageDatabase,
  IStorageItemsChangeEvent,
  IUpdateRequest,
} from '@codingame/monaco-vscode-api/vscode/vs/base/parts/storage/common/storage'

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
  private loaded = false
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
    window.chorusWorkbench.onStorageChanged((scope, insert, remove) => {
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
      if (this.items.get(key) === value) continue
      this.items.set(key, value)
      changed.set(key, value)
    }
    for (const key of remove) {
      if (this.items.delete(key)) deleted.add(key)
    }
    if (changed.size === 0 && deleted.size === 0) return
    this.external.fire({ changed, deleted })
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
    return new Map(this.items)
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    const raw = await window.chorusWorkbench.readStorage(this.scope)
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'string') this.items.set(key, value)
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
    await this.load()

    const insert: Record<string, string> = {}
    const remove: string[] = []
    for (const [key, value] of request.insert ?? new Map<string, string>()) {
      if (this.items.get(key) === value) continue
      this.items.set(key, value)
      insert[key] = value
    }
    for (const key of request.delete ?? new Set<string>()) {
      if (this.items.delete(key)) remove.push(key)
    }
    // A flush that changed nothing is most of them: the service flushes on a
    // timer as well as on a real write.
    if (Object.keys(insert).length === 0 && remove.length === 0) return

    await window.chorusWorkbench.applyStorageDelta(this.scope, insert, remove)
  }

  /** Nothing to compact: the file holds exactly the live map and no tombstones. */
  optimize(): Promise<void> {
    return Promise.resolve()
  }

  /**
   * No final flush, because there is nothing outstanding to flush.
   *
   * Every `updateItems` has already been written by the time it resolves, so
   * close has no buffered state to lose — and a write started here would race the
   * document teardown that called it.
   */
  close(): Promise<void> {
    return Promise.resolve()
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

  protected override getStorage(scope: StorageScope): IStorage | undefined {
    if (scope === StorageScope.APPLICATION_SHARED) return this.sharedStorage
    return super.getStorage(scope)
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
  }
}

import { Event } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'
import type {
  IStorageDatabase,
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
   * Nothing else writes this file while the workbench is up, so there is no
   * external change to report.
   *
   * `Event.None` rather than an emitter nobody fires: a live emitter would imply
   * a watcher exists, and the next person to add one would reasonably assume the
   * plumbing behind it worked. If two surfaces ever share a scope this becomes
   * wrong and has to become a real event — main is the only place that would
   * know, which is where the watch would have to live.
   */
  readonly onDidChangeItemsExternal = Event.None

  /**
   * The authority while the workbench is running.
   *
   * `getItems` is called once at open and every `updateItems` is a delta, so the
   * service's own view and this cache cannot diverge — which is what lets a write
   * send the whole map without reading the file back first.
   */
  private items = new Map<string, string>()
  private loaded = false

  constructor(private readonly scope: string) {}

  /**
   * **A copy, and returning the live map instead was a real bug.**
   *
   * `Storage` takes ownership of whatever this resolves to and mutates it in
   * place on every `set` and `delete`. Handing back `this.items` therefore made
   * the service's cache and this one the same object, so by the time
   * `updateItems` arrived with the delta the "has anything actually changed?"
   * test below already saw the new value, concluded nothing had changed, and
   * skipped the write — every time, for the life of the app. The symptom was a
   * storage file that was never created at all, with the factories provably
   * running and the IPC provably working.
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
  }

  async updateItems(request: IUpdateRequest): Promise<void> {
    /*
     * The load has to have happened, or the first write would persist a map
     * containing only this delta and silently forget everything stored before it.
     * The service does call `getItems` first in practice; relying on that is the
     * kind of ordering assumption this codebase has been bitten by.
     */
    await this.load()

    let changed = false
    for (const [key, value] of request.insert ?? new Map<string, string>()) {
      if (this.items.get(key) === value) continue
      this.items.set(key, value)
      changed = true
    }
    for (const key of request.delete ?? new Set<string>()) {
      if (this.items.delete(key)) changed = true
    }
    // A flush that changed nothing is most of them: the service flushes on a
    // timer as well as on a real write, and rewriting an identical file on a
    // timer is pure disk churn for the life of the app.
    if (!changed) return

    await window.chorusWorkbench.writeStorage(
      this.scope,
      JSON.stringify(Object.fromEntries(this.items))
    )
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

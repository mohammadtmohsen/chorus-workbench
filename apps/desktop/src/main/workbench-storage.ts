import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { workbenchUserDataPath } from './workbench-user-settings.js'

/**
 * What the workbench *remembers* — as opposed to what it is configured with.
 *
 * `workbench-user-settings.ts` made one file durable and said so explicitly:
 * "One file: the user's `settings.json`. Not keybindings, not snippets, not
 * tasks, not the storage service's layout state." This is that last exclusion,
 * asked for and now closed, and the two are deliberately separate files because
 * they are different kinds of thing: settings are written by a person and are
 * meant to be read and edited by one, while this is a key-value store the
 * workbench and its extensions write to constantly and nobody hand-edits.
 *
 * **Why it was needed.** The surface runs on a partition with no `persist:`
 * prefix, so every browser-side service starts empty on each launch. That is the
 * right call for the partition — `workbench-surface.ts` explains that persisting
 * it would put a connection token in a Chromium profile — but it meant the
 * storage service forgot everything, every time. Two symptoms, one cause: a
 * folder's **workspace-trust decision** was asked again on every launch, and
 * every extension that shows a one-time greeting showed it again on every
 * launch. Neither is cosmetic; the first trains a person to click through a
 * security prompt.
 *
 * **Trust is stored here, so read that sentence twice.** Remembering a trust
 * decision is the point, and it is also the most sensitive thing in the file: a
 * writable record of "this folder may run code" is worth the same care as the
 * decision itself. It is why this file lives under the app's own `userData` and
 * not in the project, why the scope key never becomes a path (below), and why
 * the write handler refuses a caller that is not a live surface.
 */

/**
 * One file, and **the scope key never touches the filesystem.**
 *
 * The obvious shape was a file per scope — `application.json`, `profile.json`,
 * one per workspace — and it is the wrong one here, because the key naming the
 * scope arrives from the workbench document, which runs third-party extension
 * code by design. A key that becomes a filename is a path traversal waiting for
 * somebody to try `../../settings`. Holding every scope in one object means the
 * untrusted string is only ever a property name, and the worst a bad one can do
 * is occupy a slot nothing reads.
 */
export function workbenchStoragePath(userData: string): string {
  return join(workbenchUserDataPath(userData), 'storage.json')
}

/**
 * The cap, on the write, per scope — and much larger than the settings one.
 *
 * Settings are hand-written and a megabyte is already absurd for them. This is
 * machine-written: every extension that remembers anything shares it, and the
 * editor keeps view state in here too. Five megabytes is far past any honest
 * use and still far short of a file that would hurt to read at startup. A single
 * scope over the cap is refused rather than truncated, because half a key-value
 * store is not a smaller key-value store — it is a corrupt one.
 */
export const STORAGE_SCOPE_MAX_BYTES = 5_000_000

type StorageFile = Record<string, Record<string, string>>

/**
 * The whole file, or an empty object — and a corrupt file reads as empty rather
 * than throwing.
 *
 * Same judgement as `readWorkbenchUserSettings`: this is read during workbench
 * startup, and taking the editor down over an unparseable cache would trade a
 * forgotten preference for an app that will not open. Anything unreadable is
 * treated as "nothing remembered yet", which is the state every profile starts
 * in anyway and which the next write repairs.
 */
function readAll(userData: string): StorageFile {
  const path = workbenchStoragePath(userData)
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    /*
     * Shape-checked one level down, not cast. A hand-edited file with a string
     * where a map belongs would otherwise reach the storage service as an object
     * whose `Object.entries` yields characters, and the failure would surface
     * inside VS Code rather than here.
     */
    const out: StorageFile = {}
    /*
     * Narrowed to `unknown` values rather than left to inference. `Object.entries`
     * on a value typed `object` yields `any`, which would let a nested value flow
     * onward unchecked — the lint rule that catches it is the one standing in for
     * "this file came off disk and is not to be trusted".
     */
    for (const [scope, items] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof items !== 'object' || items === null || Array.isArray(items)) continue
      const clean: Record<string, string> = {}
      for (const [key, value] of Object.entries(items as Record<string, unknown>)) {
        if (typeof value === 'string') clean[key] = value
      }
      out[scope] = clean
    }
    return out
  } catch {
    return {}
  }
}

/** What this scope last stored, as the JSON text the client will parse, or null. */
export function readWorkbenchStorage(userData: string, scope: string): string | null {
  const items = readAll(userData)[scope]
  return items === undefined ? null : JSON.stringify(items)
}

/**
 * Replaces one scope's items, leaving every other scope alone.
 *
 * Read-modify-write of the whole file on every flush, which is affordable
 * because the storage service batches: it does not call this per `set`, it calls
 * it when it flushes a working set that is already in memory.
 *
 * Written through a temporary file and renamed, for the reason
 * `writeWorkbenchUserSettings` gives — a torn write leaves a file that parses as
 * nothing, and here that would silently forget every scope at once rather than
 * the one being written.
 */
export function writeWorkbenchStorage(userData: string, scope: string, text: string): void {
  if (text.length > STORAGE_SCOPE_MAX_BYTES) {
    throw new Error(`Workbench storage for "${scope}" is too large (${String(text.length)})`)
  }
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Workbench storage must be an object of strings')
  }
  const items: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error('Workbench storage must be an object of strings')
    }
    items[key] = value
  }

  const path = workbenchStoragePath(userData)
  const all = readAll(userData)
  all[scope] = items
  mkdirSync(dirname(path), { recursive: true })
  const staging = `${path}.tmp`
  writeFileSync(staging, JSON.stringify(all), 'utf8')
  renameSync(staging, path)
}

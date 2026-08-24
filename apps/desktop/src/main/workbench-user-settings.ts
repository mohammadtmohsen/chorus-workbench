import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Where a workbench preference lives once the app has gone — Phase 1 exit item
 * E5, `BOARD.md` C-053.
 *
 * The workbench surface is a `WebContentsView` on an **in-memory** partition, so
 * every service that stores state in the browser — configuration, storage,
 * secrets — starts empty on every launch. `files.autoSave` turned off lasted for
 * the life of the app and no longer, which is not a replacement for an editor
 * somebody already uses.
 *
 * **The partition stays in-memory.** Making it `persist:` would have been one
 * word, and it would have put the workbench's durable state in a Chromium profile
 * and given a connection token somewhere to survive a quit. Durability belongs to
 * Chorus, so it is Chorus that holds the file: one path under the app's own
 * `userData`, which is already redirected per profile (`CHORUS_USER_DATA`, and
 * the `-dev` suffix) and is `app.getPath` on every platform rather than a string
 * this file assembles from `$HOME`.
 *
 * **Scope, said plainly.** One file: the user's `settings.json`. Not keybindings,
 * not snippets, not tasks, not the storage service's layout state. E5 asks that a
 * preference set in one run is still set in the next; widening this to the whole
 * user-data tree means a path crossing the IPC boundary and is a larger design
 * that has not been asked for.
 */

/**
 * The store's root, mirroring VS Code's own layout one level down.
 *
 * `User/settings.json` rather than a flat `settings.json` because that is where
 * the file's *contents* say it came from, and a person who opens the profile
 * directory should meet a shape they recognise. `join` throughout: this is one of
 * the two places a hardcoded separator would make Windows silently write a file
 * called `workbench/user-data/User/settings.json`.
 */
export function workbenchUserDataPath(userData: string): string {
  return join(userData, 'workbench', 'user-data')
}

export function workbenchUserSettingsPath(userData: string): string {
  return join(workbenchUserDataPath(userData), 'User', 'settings.json')
}

/**
 * The cap, and it is on the **write** rather than on the read.
 *
 * A surface runs extension code, so the text arriving here is not trusted to be
 * small. A megabyte is far past any hand-written settings file and far short of
 * anything that would matter on disk. Reading is uncapped on purpose: a file this
 * big could only have been put there by something that already passed the cap or
 * by the person themselves, and refusing to read a file we agreed to write would
 * lose a preference rather than protect anything.
 */
export const USER_SETTINGS_MAX_BYTES = 1_000_000

/**
 * What the profile last stored, or `null` — and `null` is load-bearing.
 *
 * A clean profile has no file, returns `null`, and the workbench then seeds
 * nothing and resolves `files.autoSave` to Code-OSS's own default. That is the
 * falsifier for the whole item: if this returned `'{}'` or a default object for a
 * profile that had never been written to, a persistence test would pass on a
 * value nobody set.
 *
 * A read that fails is also `null`, and deliberately not a throw: an unreadable
 * settings file must degrade to "this profile has no preferences yet" rather than
 * take the workbench down before it renders.
 */
export function readWorkbenchUserSettings(userData: string): string | null {
  const path = workbenchUserSettingsPath(userData)
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Stores the text exactly as the workbench had it — no parse, no merge, no
 * reformat.
 *
 * **Not merging is the point.** `initUserConfiguration` was found earlier to
 * *replace* the user's settings with a fixed object on every start, which is how
 * a preference can survive a quit and then be destroyed by the code that seeds
 * it. Anything here that tried to be clever about the contents would be the same
 * defect one layer out: the workbench's file is the truth, and this is storage
 * for it, not an opinion about it.
 *
 * Written through a temporary file and renamed, because the alternative is a
 * truncated `settings.json` if the app dies mid-write — and a corrupt settings
 * file is worse than a missing one, since VS Code keeps the whole layer rather
 * than the lines it could parse.
 */
export function writeWorkbenchUserSettings(userData: string, text: string): void {
  if (text.length > USER_SETTINGS_MAX_BYTES) {
    throw new Error(`Workbench settings are too large to store (${String(text.length)} characters)`)
  }
  const path = workbenchUserSettingsPath(userData)
  mkdirSync(dirname(path), { recursive: true })
  const staging = `${path}.tmp`
  writeFileSync(staging, text, 'utf8')
  renameSync(staging, path)
}

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { workbenchUserDataPath } from './workbench-user-settings.js'

/**
 * The browser extension registry that Code-OSS normally keeps in its user-data
 * filesystem.
 *
 * Chorus deliberately gives workbench surfaces an in-memory Chromium partition,
 * so `vscode-userdata:/User/extensions.json` disappears on reload. The extension
 * resources themselves stay on Open VSX; this file is only the registry that
 * tells the next surface which resources were installed.
 */
export function workbenchBrowserExtensionsPath(userData: string): string {
  return join(workbenchUserDataPath(userData), 'User', 'extensions.json')
}

/** A generous registry cap; extension bundles are referenced by URL, not stored here. */
export const BROWSER_EXTENSIONS_MAX_CHARACTERS = 10_000_000

export function readWorkbenchBrowserExtensions(userData: string): string | null {
  const path = workbenchBrowserExtensionsPath(userData)
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Stores the registry atomically so a quit cannot leave half a JSON document. */
export function writeWorkbenchBrowserExtensions(userData: string, text: string): void {
  if (text.length > BROWSER_EXTENSIONS_MAX_CHARACTERS) {
    throw new Error(
      `Workbench browser extension registry is too large to store (${String(text.length)} characters)`
    )
  }
  const path = workbenchBrowserExtensionsPath(userData)
  mkdirSync(dirname(path), { recursive: true })
  const staging = `${path}.tmp`
  writeFileSync(staging, text, 'utf8')
  renameSync(staging, path)
}

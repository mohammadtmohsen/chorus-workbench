import { getService, IFileService } from '@codingame/monaco-vscode-api'
import { initFile } from '@codingame/monaco-vscode-files-service-override'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'

/**
 * The two halves of E5 that live in the surface: seed the user's settings file
 * before the workbench starts, and hand main the new text whenever it changes.
 *
 * **This is not `initUserConfiguration`, and the difference is the whole item.**
 * That function replaces the user configuration with a fixed object, so calling
 * it on startup discards whatever the person changed — a preference that survives
 * a quit and is then destroyed by the seeding code on the next launch. What is
 * written below is only ever *the file main last stored*, which is the person's
 * own text; on a profile that has never stored one, **nothing is written at all**
 * and Code-OSS's defaults stand. There is no path by which seeding can invent or
 * flatten a value.
 */

/**
 * The file the configuration service reads its user layer from.
 *
 * `vscode-userdata:/User/settings.json` — the same URI VS Code uses, because the
 * provider registered for that scheme is what the configuration service resolves
 * against. It is a constant rather than a parameter: a surface may not name a
 * file, on this side of the boundary either.
 */
const USER_SETTINGS = URI.from({ scheme: 'vscode-userdata', path: '/User/settings.json' })

/**
 * Seeds the in-memory user-data provider, and must run **before** `initialize`.
 *
 * `initFile` calls `checkServicesNotInitialized()` itself, so a call in the wrong
 * order throws rather than silently landing after the configuration service has
 * already read an empty file. `overwrite` is set because the provider is created
 * with `/User/` already made and this is the only writer at this point; without
 * it, `initFile` returns early on a file that exists.
 *
 * Absent or empty text is a no-op rather than an empty file. Writing `''` would
 * make the configuration service parse an empty document on a clean profile,
 * which is a different startup path from having no file at all for no reason.
 */
export async function restoreUserSettings(text: string | null): Promise<void> {
  if (text === null || text === '') return
  await initFile(USER_SETTINGS, text, { overwrite: true })
}

/**
 * Reports the settings file's text to `store` on every change, and must run
 * **after** `initialize`.
 *
 * Subscribed through `IFileService.onDidFilesChange` rather than by wrapping the
 * provider, because that event is the one place every write route converges:
 * `FileService.registerProvider` forwards each provider's `onDidChangeFile`
 * unconditionally, so the settings editor, the JSON editor, a command like
 * `workbench.action.toggleAutoSave` and an extension all arrive here. Wrapping
 * `writeFile` would have missed whichever of them the text-file service chose to
 * serve through `open`/`write`/`close` instead — a miss that looks exactly like a
 * setting that did not change.
 *
 * The content is read back from the service rather than taken from the event, so
 * what is stored is what the file *is* after the change rather than what one
 * writer believed it was setting.
 */
export async function persistUserSettings(store: (text: string) => Promise<void>): Promise<void> {
  const fileService = await getService(IFileService)
  fileService.onDidFilesChange((event) => {
    if (!event.contains(USER_SETTINGS)) return
    void (async () => {
      const content = await fileService.readFile(USER_SETTINGS)
      await store(content.value.toString())
    })()
  })
}

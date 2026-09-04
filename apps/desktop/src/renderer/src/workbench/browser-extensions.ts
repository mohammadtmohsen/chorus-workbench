import { getService, IFileService } from '@codingame/monaco-vscode-api'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { VSBuffer } from '@codingame/monaco-vscode-api/vscode/vs/base/common/buffer'
import { initFile } from '@codingame/monaco-vscode-files-service-override'

/** The default profile resource constructed by Code-OSS's user-data profile service. */
const BROWSER_EXTENSIONS = URI.from({ scheme: 'vscode-userdata', path: '/User/extensions.json' })

/**
 * The registry text main and this surface most recently agreed on. Setting this
 * before applying an update from another surface prevents the resulting file
 * event from being echoed back to main and broadcast forever.
 */
let canonicalText: string | null = null

/** Seeds the in-memory user-data provider before the extension scanner starts. */
export async function restoreBrowserExtensions(text: string | null): Promise<void> {
  if (text === null || text === '') return
  await initFile(BROWSER_EXTENSIONS, text, { overwrite: true })
  canonicalText = text
}

/**
 * Persists local installs and applies registry writes made by sibling surfaces.
 * This runs after `initialize`, when the file service exists.
 */
export async function synchronizeBrowserExtensions(
  store: (text: string) => Promise<void>,
  subscribe: (handler: (text: string) => void) => void
): Promise<void> {
  const fileService = await getService(IFileService)

  subscribe((text) => {
    if (text === canonicalText) return
    canonicalText = text
    void fileService.writeFile(BROWSER_EXTENSIONS, VSBuffer.fromString(text))
  })

  fileService.onDidFilesChange((event) => {
    if (!event.contains(BROWSER_EXTENSIONS)) return
    void (async () => {
      const content = await fileService.readFile(BROWSER_EXTENSIONS)
      const text = content.value.toString()
      if (text === canonicalText) return
      canonicalText = text
      await store(text)
    })()
  })
}

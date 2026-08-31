import { BrowserClipboardService } from '@codingame/monaco-vscode-api/vscode/vs/platform/clipboard/browser/clipboardService'

/**
 * Reading the clipboard through main, because the browser cannot.
 *
 * **The bug this exists for.** `⌘V` in the workbench terminal did nothing —
 * silently, with copy working and pasting into a file working. Those two are
 * what made it look like a terminal defect: writing is a different permission,
 * and pasting into an editor is a native `paste` event that arrives carrying its
 * own data. The terminal is the one path that has to *read*: `⌘V` there is bound
 * to `workbench.action.terminal.paste`, which calls
 * `IClipboardService.readText()`, which is `navigator.clipboard.readText()`.
 *
 * The workbench partition answers every permission request with `false`
 * (`main/security.ts`), `clipboard-read` among them. That denial is deliberate
 * and stays: a surface runs third-party extension code by design, and the grant
 * would reach every iframe and extension webview in the partition, not only the
 * terminal. What made it *invisible* is the library's own implementation —
 * `BrowserClipboardService.readText` catches the rejection and returns `''`, so
 * a refused read is indistinguishable from an empty clipboard all the way to the
 * shell prompt.
 *
 * So the capability moves to main, where it is one channel with one sender check
 * instead of a session-wide grant. The same shape as storage, secrets and the
 * user's settings file: the browser API stays shut and Chorus's own service is
 * the only way through.
 *
 * **Only `readText`, and only the untyped call.** `writeText` already works and
 * is left alone — routing a working thing through a second path is how two
 * implementations of one behaviour start disagreeing. A *typed* read
 * (`readText('selection')`, the Linux primary selection) is answered from the
 * base class's own in-memory map and never touched the system clipboard, so
 * sending it to main would change what it means.
 *
 * **No constructor**, deliberately. `BrowserClipboardService` takes
 * `ILayoutService` and `ILogService`, and the instantiation service reads those
 * from static metadata that a subclass inherits — declaring one here would
 * shadow it and the injection would arrive empty. `ChorusStorageService` is
 * registered the same way for the same reason.
 */
export class ChorusClipboardService extends BrowserClipboardService {
  override async readText(type?: string): Promise<string> {
    if (type !== undefined) return super.readText(type)
    return window.chorusWorkbench.readClipboard()
  }
}

import { getService } from '@codingame/monaco-vscode-api'
import { INotificationService } from '@codingame/monaco-vscode-api/vscode/vs/platform/notification/common/notification.service'
import { IWorkbenchExtensionManagementService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/extensionManagement/common/extensionManagement.service'
import { Severity } from '@codingame/monaco-vscode-api/vscode/vs/platform/notification/common/notification'

/**
 * Says out loud that extensions are shared by every project — `BOARD.md` C-063.
 *
 * **Chorus runs one remote extension host with one `--extensions-dir`**, leased
 * by a refcount over open projects, so installing an extension in one project
 * installs it in all of them and removing it removes it from all of them. That
 * is a deliberate decision — accepted 2026-08-24, in preference to a profile per
 * project — and the condition of accepting it was that the product says so
 * rather than leaving somebody to discover it.
 *
 * **VS Code's Extensions view cannot say it**, and that is not a gap in the view.
 * There, one window is one remote is one extensions directory, so "installed" is
 * unambiguous. Here four panes share one server and the same word means more
 * than the person asked for.
 *
 * **At the moment of the action, not in a document.** A note in a README is read
 * once, months before it matters. This fires on the install or the uninstall
 * itself, which is the only moment the scope is a surprise — and it is silent for
 * the rest of the session, because a workbench that repeats itself gets dismissed
 * without being read.
 */
export async function announceSharedExtensionScope(): Promise<void> {
  const [extensions, notifications] = await Promise.all([
    getService(IWorkbenchExtensionManagementService),
    getService(INotificationService),
  ])

  /*
   * Once per surface, per kind of change.
   *
   * Installing five extensions in a row is one decision with one consequence,
   * and five identical banners would be noise the fifth time and ignored by the
   * second. Uninstalling is tracked separately because it is the more surprising
   * direction: removing something from a project you are not looking at is worse
   * than adding it.
   */
  let saidInstall = false
  let saidUninstall = false

  const say = (message: string): void => {
    notifications.notify({ severity: Severity.Info, message })
  }

  extensions.onDidInstallExtensions((results) => {
    // `onDidInstallExtensions` also fires for failures; a refused install has
    // changed nothing and has nothing to disclose.
    if (saidInstall || !results.some((result) => result.local !== undefined)) return
    saidInstall = true
    say(
      'Extensions in Chorus are shared by every project — this one is now available in all of them.'
    )
  })

  extensions.onDidUninstallExtension((result) => {
    if (saidUninstall || result.error !== undefined) return
    saidUninstall = true
    say(
      'Extensions in Chorus are shared by every project — this one is now removed from all of them.'
    )
  })
}

import { RemoteAuthorityResolverService } from '@codingame/monaco-vscode-remote-agent-service-override/vscode/vs/platform/remote/browser/remoteAuthorityResolverService'
import type { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'

/**
 * Gives a project one identity that survives a relaunch.
 *
 * **The problem is a port in a name.** The remote extension host is started with
 * `--port 0` and main reads the port back out of the child — deliberately, so
 * that Chorus can never attach to a server it did not start. The consequence
 * nobody had traced is that the workbench's authority is `127.0.0.1:<port>`, and
 * therefore so is every `vscode-remote://` URI built from it. The port is
 * different on every launch, so *the folder you opened yesterday is a different
 * folder today* as far as the editor is concerned.
 *
 * That was measured rather than assumed: reimplementing VS Code's `stringHash`
 * and brute-forcing the port space matched **all 35** `workspace:*` scopes in
 * the durable storage file to seven launches of five projects — ports 49979,
 * 50554, 60378, 60873, 63349, 64201 and 65068, each producing a complete fresh
 * set of workspace identities.
 *
 * **Workspace trust is the symptom that matters.** It stores a list of trusted
 * URIs and matches with `extUri.isEqualOrParent`, which compares the authority —
 * so a decision recorded under one port never matches the next launch's, and the
 * window opens in Restricted Mode having forgotten an answer it did save.
 *
 * **`getCanonicalURI` is the seam the editor provides for exactly this.**
 * `WorkspaceTrustManagementService` routes every URI through it before storing
 * or comparing, which is what makes this a supported normalisation rather than a
 * rewrite of a security record. The browser implementation returns the URI
 * unchanged, because upstream VS Code Web has no ephemeral port to hide.
 *
 * **Only the canonical form changes; the connection is untouched.** The socket,
 * the `vscode-remote-resource` fetches, the CSP origins in `security.ts` and
 * `isOwnRemoteResource` all continue to use the real `127.0.0.1:<port>`. This
 * affects identity, not reachability — which is why it was preferred over a
 * stable authority label, where two hand-written URL rewriters would have stood
 * between the workbench and its server.
 */
/**
 * A workspace id derived from the project's path and nothing else.
 *
 * The default is `hash(folderUri.toString())`, and that URI carries the REH's
 * ephemeral port — so every launch minted a new identity and abandoned the
 * previous launch's workspace-scoped state. The path is the one part of that URI
 * which is actually about the project.
 *
 * The algorithm only has to be stable and collision-resistant across a handful
 * of local directories, not cryptographic: this names a storage bucket, and the
 * cost of a collision is two projects sharing view state, not a security
 * boundary. `stringHash` is VS Code's own djb2 variant, reproduced here so the
 * value does not depend on an internal we would have to deep-import.
 */
export function workspaceIdFor(projectRoot: string): string {
  let hash = 5381
  for (let index = 0; index < projectRoot.length; index += 1) {
    hash = (hash << 5) + hash + projectRoot.charCodeAt(index)
    hash |= 0
  }
  return (hash >>> 0).toString(16)
}

export class ChorusRemoteAuthorityResolverService extends RemoteAuthorityResolverService {
  /**
   * The authority every project's canonical URI collapses onto.
   *
   * One value for the whole app rather than one per project: the path already
   * distinguishes projects, and a per-project authority would encode the same
   * fact twice and let the two disagree. It contains no port by construction,
   * which is the entire point.
   */
  private static readonly CANONICAL_AUTHORITY = 'chorus'

  override async getCanonicalURI(uri: URI): Promise<URI> {
    /*
     * Only `vscode-remote`, and only when there is an authority to replace. A
     * `file://` URI here would be the shell's or an extension's own, and
     * rewriting its authority would be inventing a location rather than
     * normalising one.
     */
    if (uri.scheme !== 'vscode-remote' || uri.authority === '') {
      return super.getCanonicalURI(uri)
    }
    return uri.with({ authority: ChorusRemoteAuthorityResolverService.CANONICAL_AUTHORITY })
  }
}

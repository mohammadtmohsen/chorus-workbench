/**
 * Gives a project's *storage* one identity that survives a relaunch.
 *
 * **The problem is a port in a name.** The remote extension host is started with
 * `--port 0` and main reads the port back out of the child — deliberately, so
 * that Chorus can never attach to a server it did not start. The consequence is
 * that the workbench's authority is `127.0.0.1:<port>`, and so is every
 * `vscode-remote://` URI built from it. The port differs on every launch, so the
 * folder opened yesterday is a different folder today as far as the editor is
 * concerned.
 *
 * Measured rather than assumed: reimplementing VS Code's `stringHash` and
 * brute-forcing the port space matched all 35 `workspace:*` scopes in the durable
 * storage file to seven launches of five projects, each launch minting a complete
 * fresh set of identities and abandoning the previous one.
 *
 * **A canonical remote authority was tried for this and reverted on 2026-08-30.**
 * A `RemoteAuthorityResolverService` subclass overrode `getCanonicalURI` to
 * collapse the port out of `vscode-remote` URIs, so workspace trust — which
 * canonicalises on both read and write — would match across launches. It worked:
 * trust persisted and Restricted Mode went away. It also **emptied the file
 * explorer**. Canonical URIs are consulted far beyond the trust service, and
 * pointing them at an authority nothing can connect to breaks resolution
 * everywhere else. The comment justifying it claimed "only the canonical form
 * changes; the connection is untouched", and that claim was wrong.
 *
 * So the port stays in the URI, workspace trust is still re-asked on every
 * launch, and what remains here is the narrower change that works: pinning the
 * *storage* identity, which nothing dereferences.
 *
 * Anyone returning to the trust problem should start from that failure. The seam
 * is real and the trust service does route through it — but it is shared with
 * file resolution, so normalising there is not free.
 */

/**
 * A workspace id derived from the project's path and nothing else.
 *
 * The default is `hash(folderUri.toString())`, and that URI carries the ephemeral
 * port — so every launch minted a new identity and abandoned the previous
 * launch's workspace-scoped state. The path is the one part of that URI which is
 * actually about the project, and unlike the authority it is never dereferenced.
 *
 * The algorithm only has to be stable and collision-resistant across a handful of
 * local directories, not cryptographic: this names a storage bucket, and the cost
 * of a collision is two projects sharing view state, not a security boundary.
 * `stringHash` is VS Code's own djb2 variant, reproduced here so the value does
 * not depend on an internal we would have to deep-import.
 */
export function workspaceIdFor(projectRoot: string): string {
  let hash = 5381
  for (let index = 0; index < projectRoot.length; index += 1) {
    hash = (hash << 5) + hash + projectRoot.charCodeAt(index)
    hash |= 0
  }
  return (hash >>> 0).toString(16)
}

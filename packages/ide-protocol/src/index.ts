/**
 * The barrel, and it is **Node-only** — deliberately, and by more than habit.
 *
 * `endpoint.js` imports `node:path` because deciding where a socket lives is a
 * question about a filesystem. That is fine for the two consumers this package
 * was written for, Electron main and the VS Code extension host, and fatal for
 * the third: the embedded workbench's renderer is browser code, and a bundler
 * asked to resolve `node:path` for it substitutes an empty object rather than
 * failing. The result is a function that exists, is called, and throws — see the
 * header of `paths.ts` for the days that cost.
 *
 * So a browser consumer imports the piece it needs, never this file:
 *
 * - `@chorus/ide-protocol/protocol` — the wire shapes and their zod schemas
 * - `@chorus/ide-protocol/paths` — containment, with the platform passed in
 * - `@chorus/ide-protocol/document-identity` — what a `git:` or `gl-review:`
 *   URI actually names
 *
 * Each of those three is import-free apart from `zod`, and the renderer build
 * now refuses any Node built-in outright (`electron.vite.config.ts`), so this
 * boundary is enforced rather than remembered.
 */
export * from './protocol.js'
export * from './paths.js'
export * from './endpoint.js'
export * from './document-identity.js'

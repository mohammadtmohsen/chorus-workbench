import { describe, expect, it } from 'vitest'
import { remotePath } from './workbench-ipc.js'

/**
 * The rule four URI constructions share.
 *
 * Written after a Windows machine showed what the absence of it looks like: the
 * workbench never started, `[UriError]` with a stack ending in
 * `prepareWorkbench`, and no editor at all. A URI carrying an authority refuses
 * a path that does not begin with a slash, and every absolute macOS path
 * already does — which is why this went unnoticed for as long as it did.
 */
describe('remotePath', () => {
  it('gives a native Windows path the leading slash a URI authority requires', () => {
    expect(remotePath('C:\\Users\\me\\project')).toBe('/C:/Users/me/project')
  })

  it('takes a forward-slashed drive path too, which is how a remote root arrives', () => {
    expect(remotePath('C:/api')).toBe('/C:/api')
  })

  it('leaves a POSIX path alone', () => {
    expect(remotePath('/Users/me/project')).toBe('/Users/me/project')
  })

  /*
   * Idempotent on purpose. The root is converted once, in `describe()`, and a
   * caller downstream cannot always tell whether it is holding a converted path
   * or a raw one — so asking twice has to be safe rather than doubling the
   * slash.
   */
  it('is idempotent', () => {
    expect(remotePath(remotePath('C:\\Users\\me'))).toBe('/C:/Users/me')
    expect(remotePath('/C:/api')).toBe('/C:/api')
  })

  it('handles a UNC root, the other absolute shape Windows has', () => {
    expect(remotePath('\\\\server\\share\\dir')).toBe('//server/share/dir')
  })

  /*
   * The reason the conversion is gated on the path's shape rather than applied
   * to every backslash it sees. A backslash is a legal character in a POSIX
   * filename, so a blanket replace would rename somebody's directory.
   */
  it('does not touch a backslash inside a POSIX path', () => {
    expect(remotePath('/Users/me/a\\b')).toBe('/Users/me/a\\b')
  })

  it('leaves a relative path alone rather than inventing a root for it', () => {
    expect(remotePath('src/index.ts')).toBe('src/index.ts')
  })
})

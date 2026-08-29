import { describe, expect, it } from 'vitest'
import { isOwnRemoteResource, workbenchPolicy } from './security.js'

/**
 * What the workbench renderer may reach, named exactly.
 *
 * This document runs third-party extension code, so its policy is the boundary
 * between an extension and the machine — and it now contains one deliberate
 * widening, `https://open-vsx.org`, added so the Extensions view can show a
 * README instead of "Failed to fetch". A test that lists every origin is what
 * makes the *next* widening a decision rather than a diff nobody reads.
 */
describe('the workbench content security policy', () => {
  const policy = workbenchPolicy(false, '127.0.0.1:51515')
  const directive = (name: string): string =>
    policy.split('; ').find((part) => part.startsWith(`${name} `)) ?? ''

  it('reaches the gallery it installs from, and says so in both directives', () => {
    expect(directive('connect-src')).toContain('https://open-vsx.org')
    expect(directive('img-src')).toContain('https://open-vsx.org')
  })

  /*
   * The CDN the gallery redirects to. Allowing only `open-vsx.org` left the
   * details pane failing identically, because every asset URL 302s to Eclipse's
   * content host and a CSP governs the redirect target.
   */
  it('reaches the CDN those assets actually redirect to', () => {
    expect(directive('connect-src')).toContain('https://openvsx.eclipsecontent.org')
    expect(directive('img-src')).toContain('https://openvsx.eclipsecontent.org')
  })

  it('reaches its own server as two exact origins', () => {
    expect(directive('connect-src')).toContain('ws://127.0.0.1:51515')
    expect(directive('connect-src')).toContain('http://127.0.0.1:51515')
  })

  /*
   * The rule the file's own comment is emphatic about: the port is ephemeral, so
   * a wildcard is the tempting shortcut, and it would let any local server be
   * reached from a renderer running third-party code.
   */
  it('never widens to a local wildcard in production', () => {
    expect(policy).not.toContain('127.0.0.1:*')
    expect(policy).not.toContain('localhost:*')
  })

  it('starts from nothing and frames nobody', () => {
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).toContain("object-src 'none'")
  })

  /*
   * The whole list, so an origin added anywhere shows up here as a failing
   * assertion rather than as a directive nobody re-read.
   */
  it('allows no host beyond the gallery and its own server', () => {
    const hosts = [...policy.matchAll(/\b(?:https?|wss?):\/\/[^\s;]+/g)].map((m) => m[0]).sort()
    expect(hosts).toEqual([
      'http://127.0.0.1:51515',
      'https://open-vsx.org',
      'https://open-vsx.org',
      'https://openvsx.eclipsecontent.org',
      'https://openvsx.eclipsecontent.org',
      'ws://127.0.0.1:51515',
    ])
  })

  it('refuses an authority that is not host:port rather than interpolating it', () => {
    expect(() => workbenchPolicy(false, 'evil.example.com/path')).toThrow()
  })
})

/**
 * The one response the workbench session adds `Access-Control-Allow-Origin` to.
 *
 * An installed theme lives on the remote extension host, so applying it fetches
 * `http://<authority>/vscode-remote-resource`. VS Code's server only sends CORS
 * headers when the origin matches `product.webEndpointUrlTemplate`, and
 * VSCodium's product defines none — so the browser refuses the response and it
 * surfaces as a bare "Failed to fetch".
 *
 * Every assertion here is about **exactness**. This predicate is the whole
 * safety of that header: it runs in a session that executes third-party
 * extension code, and a prefix match or a subtree would hand that code a CORS
 * bypass for anything the server serves.
 */
describe('the remote resource CORS exemption', () => {
  const authority = '127.0.0.1:51515'
  const ok = (url: string) => isOwnRemoteResource(url, authority)

  it('matches the resource endpoint on our own server', () => {
    expect(ok(`http://${authority}/vscode-remote-resource?path=%2Ficon.svg`)).toBe(true)
  })

  it('refuses another port, which is another server', () => {
    expect(ok('http://127.0.0.1:9999/vscode-remote-resource')).toBe(false)
  })

  it('refuses another host on the same port', () => {
    expect(ok('http://evil.example.com:51515/vscode-remote-resource')).toBe(false)
  })

  /* A subtree would be a bypass for everything below it. */
  it('refuses a path that merely starts the same', () => {
    expect(ok(`http://${authority}/vscode-remote-resource/../secrets`)).toBe(false)
    expect(ok(`http://${authority}/vscode-remote-resourceX`)).toBe(false)
  })

  it('refuses every other endpoint the server exposes', () => {
    expect(ok(`http://${authority}/`)).toBe(false)
    expect(ok(`http://${authority}/version`)).toBe(false)
  })

  /* https is not what the workbench connects over, and matching it would be a
     second origin nobody decided to allow. */
  it('refuses a different scheme', () => {
    expect(ok(`https://${authority}/vscode-remote-resource`)).toBe(false)
  })

  it('exempts nothing when there is no server', () => {
    expect(isOwnRemoteResource(`http://${authority}/vscode-remote-resource`, null)).toBe(false)
  })

  it('refuses something that is not a url at all', () => {
    expect(ok('not a url')).toBe(false)
  })
})

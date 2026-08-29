import { describe, expect, it } from 'vitest'
import { workbenchPolicy } from './security.js'

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
      'ws://127.0.0.1:51515',
    ])
  })

  it('refuses an authority that is not host:port rather than interpolating it', () => {
    expect(() => workbenchPolicy(false, 'evil.example.com/path')).toThrow()
  })
})

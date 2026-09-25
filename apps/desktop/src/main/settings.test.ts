import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TRAFFIC_PORT } from '../shared/ipc.js'
import {
  DEFAULT_SETTINGS,
  readSavedTrafficConnection,
  readSettings,
  writeSettings,
} from './settings.js'

describe('the traffic port setting', () => {
  it('round-trips, and falls back to the default on a file that predates it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chorus-settings-'))

    expect(readSettings(dir).trafficPort).toBe(DEFAULT_TRAFFIC_PORT)

    writeSettings(dir, { ...DEFAULT_SETTINGS, trafficPort: 31_200 })
    expect(readSettings(dir).trafficPort).toBe(31_200)
  })
})

describe('the saved shared connection', () => {
  const file = (contents: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'chorus-settings-'))
    writeFileSync(join(dir, 'settings.json'), contents, 'utf8')
    return dir
  }

  it('reports no connection at all when there is no file', () => {
    expect(readSavedTrafficConnection(mkdtempSync(join(tmpdir(), 'chorus-settings-')))).toEqual({
      kind: 'absent',
    })
  })

  it('reports no connection when the file predates the traffic fields', () => {
    expect(readSavedTrafficConnection(file(JSON.stringify({ theme: 'dark' })))).toEqual({
      kind: 'absent',
    })
  })

  it('reports fields that say nothing as defaults, with the port they were on', () => {
    expect(
      readSavedTrafficConnection(
        file(JSON.stringify({ trafficOrigin: '', trafficPort: DEFAULT_TRAFFIC_PORT }))
      )
    ).toEqual({ kind: 'defaults', origin: null, port: DEFAULT_TRAFFIC_PORT })
  })

  it('takes a named origin as a connection, whatever the port says', () => {
    expect(
      readSavedTrafficConnection(file(JSON.stringify({ trafficOrigin: 'http://127.0.0.1:8080' })))
    ).toEqual({ kind: 'configured', origin: 'http://127.0.0.1:8080', port: DEFAULT_TRAFFIC_PORT })
  })

  it('takes a non-default port without an origin as the forward proxy it is', () => {
    expect(
      readSavedTrafficConnection(file(JSON.stringify({ trafficOrigin: '', trafficPort: 31_200 })))
    ).toEqual({ kind: 'configured', origin: null, port: 31_200 })
  })

  it('takes an explicitly saved 0 as a connection that wants an ephemeral port', () => {
    expect(
      readSavedTrafficConnection(file(JSON.stringify({ trafficOrigin: '', trafficPort: 0 })))
    ).toEqual({ kind: 'configured', origin: null, port: 0 })
  })

  it('refuses a file it cannot parse rather than calling it empty', () => {
    expect(readSavedTrafficConnection(file('{ not json'))).toMatchObject({ kind: 'unreadable' })
  })

  it('refuses traffic fields that are not the shape they claim to be', () => {
    for (const contents of [
      JSON.stringify({ trafficOrigin: 12 }),
      JSON.stringify({ trafficPort: '30100' }),
      JSON.stringify({ trafficPort: 70_000 }),
      JSON.stringify({ trafficOrigin: 'http://user:pw@host:8080' }),
      JSON.stringify({ trafficOrigin: 'ftp://host:8080' }),
      JSON.stringify({ trafficOrigin: 'https://example.test/api/v1/' }),
    ]) {
      expect(readSavedTrafficConnection(file(contents))).toMatchObject({ kind: 'unreadable' })
    }
  })

  it('carries the port it could still read alongside the reason it could not', () => {
    expect(
      readSavedTrafficConnection(file(JSON.stringify({ trafficOrigin: 12, trafficPort: 31_200 })))
    ).toEqual({
      kind: 'unreadable',
      reason: 'trafficOrigin is not a string',
      port: 31_200,
    })
  })

  it('keeps the preferences it can read when the traffic fields are unusable', () => {
    const dir = file(
      JSON.stringify({ cwd: '', profileId: 'trusted', theme: 'dark', trafficPort: -1 })
    )

    expect(readSettings(dir)).toMatchObject({ theme: 'dark', profileId: 'trusted' })
    expect(readSettings(dir).trafficPort).toBe(DEFAULT_TRAFFIC_PORT)
    expect(readSavedTrafficConnection(dir)).toMatchObject({ kind: 'unreadable' })
  })
})

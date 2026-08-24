import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readWorkbenchUserSettings,
  USER_SETTINGS_MAX_BYTES,
  workbenchUserSettingsPath,
  writeWorkbenchUserSettings,
} from './workbench-user-settings.js'

/**
 * The store behind E5, tested against a real directory rather than a mocked `fs`.
 *
 * A mock would assert that this file calls the functions it calls, which is the
 * shape of test that passes with the paths joined wrongly. What matters here is
 * that a profile which has never been written to reads back as `null` and that a
 * profile which has reads back exactly what went in — both of which are claims
 * about the filesystem, not about the module's internals.
 */

let profile: string

beforeEach(() => {
  profile = mkdtempSync(join(tmpdir(), 'chorus-user-settings-'))
})

afterEach(() => {
  rmSync(profile, { recursive: true, force: true })
})

describe('the workbench user-settings store', () => {
  /**
   * The falsifier for the whole item, and it belongs first.
   *
   * If a clean profile answered with anything — `{}`, a default object, the last
   * profile's file — then a persistence test would pass on a value nobody set,
   * and Code-OSS's own default would never be what a new profile got.
   */
  it('answers null for a profile that has never stored settings', () => {
    expect(readWorkbenchUserSettings(profile)).toBeNull()
  })

  it('reads back exactly what was written, byte for byte', () => {
    const text = '{\n  // a comment JSONC allows\n  "files.autoSave": "off"\n}\n'
    writeWorkbenchUserSettings(profile, text)
    expect(readWorkbenchUserSettings(profile)).toBe(text)
  })

  it('overwrites rather than appending, so the last state is the stored one', () => {
    writeWorkbenchUserSettings(profile, '{"files.autoSave":"off"}')
    writeWorkbenchUserSettings(profile, '{"files.autoSave":"afterDelay"}')
    expect(readWorkbenchUserSettings(profile)).toBe('{"files.autoSave":"afterDelay"}')
  })

  /**
   * Two profiles, because "the setting persisted" and "the setting leaked" look
   * identical from inside one of them.
   */
  it('keeps the settings of one profile out of another', () => {
    const other = mkdtempSync(join(tmpdir(), 'chorus-user-settings-other-'))
    try {
      writeWorkbenchUserSettings(profile, '{"files.autoSave":"off"}')
      expect(readWorkbenchUserSettings(other)).toBeNull()
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  /**
   * The path is asserted as segments, never as a string with separators in it —
   * a literal `'workbench/user-data/User/settings.json'` would pass on macOS and
   * describe a single oddly-named file on Windows.
   */
  it('stores under the profile in a layout VS Code users recognise', () => {
    const path = workbenchUserSettingsPath(profile)
    expect(path).toBe(join(profile, 'workbench', 'user-data', 'User', 'settings.json'))
    expect(path.startsWith(profile + sep)).toBe(true)
  })

  it('creates the directories it needs on the first write', () => {
    expect(existsSync(join(profile, 'workbench'))).toBe(false)
    writeWorkbenchUserSettings(profile, '{}')
    expect(existsSync(workbenchUserSettingsPath(profile))).toBe(true)
  })

  /**
   * The staging file is renamed, not left behind. A `.tmp` beside the real file
   * would be read by nothing and would sit in the profile for ever, and the rename
   * is what stops a half-written `settings.json` being what the next launch seeds.
   */
  it('leaves no staging file behind', () => {
    writeWorkbenchUserSettings(profile, '{"files.autoSave":"off"}')
    const directory = join(profile, 'workbench', 'user-data', 'User')
    expect(readdirSync(directory)).toEqual(['settings.json'])
  })

  it('refuses text past the cap rather than storing it', () => {
    const tooBig = 'x'.repeat(USER_SETTINGS_MAX_BYTES + 1)
    expect(() => {
      writeWorkbenchUserSettings(profile, tooBig)
    }).toThrow(/too large/)
    expect(readWorkbenchUserSettings(profile)).toBeNull()
  })

  /**
   * A directory where the file should be is the cheapest way to make a read fail
   * for a reason that is not "no such file". It must degrade to a clean profile,
   * because the alternative is a workbench that will not start until somebody
   * deletes a file they cannot see.
   */
  it('degrades an unreadable file to a clean profile instead of throwing', () => {
    const path = workbenchUserSettingsPath(profile)
    mkdirSync(path, { recursive: true })
    expect(readWorkbenchUserSettings(profile)).toBeNull()
  })

  it('reads a file that was put there by hand, not only one it wrote', () => {
    const path = workbenchUserSettingsPath(profile)
    mkdirSync(join(profile, 'workbench', 'user-data', 'User'), { recursive: true })
    writeFileSync(path, '{"editor.fontSize":18}', 'utf8')
    expect(readWorkbenchUserSettings(profile)).toBe('{"editor.fontSize":18}')
  })
})

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  archiveRefusals,
  containedPath,
  readArchiveEntries,
  type ArchiveEntry,
} from './workbench-archive.js'

/**
 * The validator is checked against archives built here, and — when it is
 * present — against the real REH artifact.
 *
 * The fixtures prove the refusals fire; the real artifact proves the *reader*
 * agrees with the tool that will do the extracting. Those are different claims
 * and the second is the one that cannot be faked: a header reader that silently
 * disagreed with `tar` about which entries exist would validate one archive and
 * extract another, which is the whole hazard restated.
 */

const scratch = mkdtempSync(join(tmpdir(), 'chorus-archive-test-'))
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function pack(name: string, build: (dir: string) => void): string {
  const source = join(scratch, `${name}-src`)
  mkdirSync(source, { recursive: true })
  build(source)
  const archive = join(scratch, `${name}.tar.gz`)
  execFileSync('tar', ['-czf', archive, '-C', source, '.'])
  return archive
}

describe('containedPath', () => {
  it('admits ordinary relative paths and collapses harmless traversal', () => {
    expect(containedPath('./bin/codium-server')).toBe('bin/codium-server')
    expect(containedPath('out/../out/server-main.js')).toBe('out/server-main.js')
  })

  it('refuses absolute paths, escaping traversal, drive letters and backslashes', () => {
    expect(containedPath('/etc/passwd')).toBeNull()
    expect(containedPath('../outside')).toBeNull()
    expect(containedPath('./a/../../outside')).toBeNull()
    expect(containedPath('C:/Windows/System32')).toBeNull()
    expect(containedPath('a\\..\\..\\outside')).toBeNull()
  })
})

describe('archiveRefusals', () => {
  const entry = (over: Partial<ArchiveEntry>): ArchiveEntry => ({
    path: './file',
    typeflag: '0',
    linkname: '',
    ...over,
  })

  it('passes an archive of ordinary files and directories', () => {
    expect(
      archiveRefusals([entry({ path: './out/x.js' }), entry({ path: './bin', typeflag: '5' })])
    ).toEqual([])
  })

  it('refuses a symlink whose target escapes, and admits one that does not', () => {
    expect(
      archiveRefusals([entry({ path: './sub/link', typeflag: '2', linkname: '../../etc/passwd' })])
    ).toHaveLength(1)
    expect(
      archiveRefusals([entry({ path: './sub/link', typeflag: '2', linkname: '../out/x.js' })])
    ).toEqual([])
  })

  it('resolves a hard link against the root and a symlink against its own directory', () => {
    // `../x` from `./sub/` stays inside for a symlink and escapes for a hard
    // link, which is the whole reason the two are resolved differently.
    expect(archiveRefusals([entry({ path: './sub/l', typeflag: '2', linkname: '../x' })])).toEqual(
      []
    )
    expect(
      archiveRefusals([entry({ path: './sub/h', typeflag: '1', linkname: '../x' })])
    ).toHaveLength(1)
  })

  it('refuses an absolute link target', () => {
    expect(
      archiveRefusals([entry({ path: './link', typeflag: '2', linkname: '/etc/passwd' })])
    ).toHaveLength(1)
  })
})

describe('readArchiveEntries', () => {
  it('reads names, types and link targets out of the headers', async () => {
    const archive = pack('mixed', (dir) => {
      mkdirSync(join(dir, 'sub'), { recursive: true })
      writeFileSync(join(dir, 'sub', 'a.txt'), 'hi\n')
      symlinkSync('/etc/passwd', join(dir, 'escape'))
      symlinkSync('a.txt', join(dir, 'sub', 'inner'))
    })
    const entries = await readArchiveEntries(archive)
    /*
     * Matched exactly, not by suffix, and that is a correction rather than a
     * style. macOS `tar` writes an AppleDouble sidecar for every entry carrying
     * extended attributes — `./._escape`, an ordinary file, emitted *before*
     * `./escape` — so `endsWith('escape')` finds the sidecar and reports the
     * symlink as typeflag `0`. The reader was right and the predicate was wrong,
     * which is the more dangerous way round: it would have read as the validator
     * failing to see a symlink.
     */
    const escape = entries.find((e) => e.path === './escape')
    const inner = entries.find((e) => e.path === './sub/inner')

    expect(escape?.typeflag).toBe('2')
    expect(escape?.linkname).toBe('/etc/passwd')
    expect(inner?.linkname).toBe('a.txt')
    expect(archiveRefusals(entries)).toEqual([
      'link target escapes the extraction root: ./escape -> /etc/passwd',
    ])
  })

  it('applies a pax or GNU long-name override rather than the placeholder header', async () => {
    // A name over 100 bytes cannot fit the ustar `name` field, so `tar` emits an
    // override header — the exact mechanism a reader that judged only the ustar
    // block would look straight past.
    const long = `${'d'.repeat(90)}/${'n'.repeat(90)}.txt`
    const archive = pack('long', (dir) => {
      mkdirSync(join(dir, long.split('/')[0] ?? ''), { recursive: true })
      writeFileSync(join(dir, long), 'x')
    })
    const entries = await readArchiveEntries(archive)
    expect(entries.some((e) => e.path.endsWith(long))).toBe(true)
    expect(entries.every((e) => !e.path.includes('@LongLink'))).toBe(true)
  })

  /*
   * The real artifact, when it is on disk. Skipped rather than failed when it is
   * not: the cache is not in the repository, so a fresh clone must not go red for
   * a 76 MB file nobody fetched — but on the machine that did fetch it, this is
   * the assertion that the reader and the extractor see the same archive.
   */
  const REH = join(
    __dirname,
    '../../../../.workbench-cache/vscodium-reh-darwin-arm64-1.121.03429.tar.gz'
  )
  const withArtifact = existsSync(REH) ? it : it.skip

  withArtifact(
    'agrees with tar about every entry in the real REH artifact',
    async () => {
      const mine = await readArchiveEntries(REH)
      const theirs = execFileSync('tar', ['-tzf', REH], { maxBuffer: 64 * 1024 * 1024 })
        .toString()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => line.replace(/\/$/, ''))

      expect(mine.map((e) => e.path.replace(/\/$/, ''))).toEqual(theirs)
      expect(archiveRefusals(mine)).toEqual([])
    },
    120_000
  )
})

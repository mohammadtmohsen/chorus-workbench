import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_VAULT_ORIGIN_RECORDS_MAX,
  BrowserVault,
  browserVaultPath,
  type BrowserVaultCrypto,
} from './browser-vault.js'

vi.mock('electron', () => ({ safeStorage: {} }))

const ORIGIN = 'https://gitlab.example.com'

let profile: string

beforeEach(() => {
  profile = mkdtempSync(join(tmpdir(), 'chorus-browser-vault-'))
})

afterEach(() => {
  rmSync(profile, { recursive: true, force: true })
})

function sealed(version: 'v1' | 'v2', text: string): Buffer {
  return Buffer.from(`${version}:${Buffer.from(text, 'utf8').toString('base64')}`, 'utf8')
}

function fakeCrypto(): {
  readonly crypto: BrowserVaultCrypto
  readonly state: { available: boolean; broken: boolean }
} {
  const state = { available: true, broken: false }
  const crypto: BrowserVaultCrypto = {
    protectedStorage: () => Promise.resolve(state.available),
    encrypt: (plainText) => Promise.resolve(sealed('v2', plainText)),
    decrypt: (encrypted) => {
      const text = encrypted.toString('utf8')
      const version = text.slice(0, 3)
      if (state.broken || (version !== 'v1:' && version !== 'v2:')) {
        return Promise.reject(new Error('undecryptable'))
      }
      return Promise.resolve({
        result: Buffer.from(text.slice(3), 'base64').toString('utf8'),
        shouldReEncrypt: version === 'v1:',
      })
    },
  }
  return { crypto, state }
}

function writeVault(bytes: Buffer): void {
  mkdirSync(join(profile, 'browser'), { recursive: true })
  writeFileSync(browserVaultPath(profile), bytes)
}

function stored(index: number, origin: string, password: string) {
  return {
    id: `r${String(index)}`,
    origin,
    username: `user${String(index)}`,
    password,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('browser password vault', () => {
  it('saves, reopens and lists metadata without passwords', async () => {
    const { crypto } = fakeCrypto()
    const vault = new BrowserVault(profile, crypto)
    expect(await vault.save(ORIGIN, 'me@example.com', 'hunter2')).toBeNull()
    const reopened = new BrowserVault(profile, crypto)
    const listed = await reopened.accounts(ORIGIN)
    expect(listed.storage).toBe('ready')
    expect(listed.accounts.map((account) => account.username)).toEqual(['me@example.com'])
    expect(JSON.stringify(listed)).not.toContain('hunter2')
    const id = listed.accounts[0]?.id ?? ''
    expect(await reopened.credential(ORIGIN, id)).toEqual({
      username: 'me@example.com',
      password: 'hunter2',
    })
    expect(await reopened.credential('https://other.example.com', id)).toBeNull()
  })

  it('keeps origins, usernames and passwords inside the encrypted blob', async () => {
    const { crypto } = fakeCrypto()
    await new BrowserVault(profile, crypto).save(ORIGIN, 'me@example.com', 'hunter2')
    const raw = readFileSync(browserVaultPath(profile), 'utf8')
    for (const secret of ['gitlab', 'me@example.com', 'hunter2']) expect(raw).not.toContain(secret)
  })

  it('classifies and updates an existing account in place', async () => {
    const { crypto } = fakeCrypto()
    const vault = new BrowserVault(profile, crypto)
    expect(await vault.classify(ORIGIN, 'me', 'old')).toBe('save')
    await vault.save(ORIGIN, 'me', 'old')
    expect(await vault.classify(ORIGIN, 'me', 'old')).toBe('same')
    expect(await vault.classify(ORIGIN, 'me', 'new')).toBe('update')
    await vault.save(ORIGIN, 'me', 'new')
    const listed = await vault.accounts(ORIGIN)
    expect(listed.accounts).toHaveLength(1)
    expect(await vault.credential(ORIGIN, listed.accounts[0]?.id ?? '')).toEqual({
      username: 'me',
      password: 'new',
    })
  })

  it('refuses to store without protected storage', async () => {
    const { crypto, state } = fakeCrypto()
    state.available = false
    const vault = new BrowserVault(profile, crypto)
    expect(await vault.storage()).toBe('unavailable')
    expect(await vault.save(ORIGIN, 'me', 'pw')).toBe('storage-unavailable')
    expect(existsSync(browserVaultPath(profile))).toBe(false)
  })

  it('never overwrites a vault it cannot decrypt', async () => {
    const { crypto, state } = fakeCrypto()
    await new BrowserVault(profile, crypto).save(ORIGIN, 'me', 'pw')
    const before = readFileSync(browserVaultPath(profile))
    state.broken = true
    const vault = new BrowserVault(profile, crypto)
    expect(await vault.storage()).toBe('locked')
    expect(await vault.save(ORIGIN, 'other', 'pw2')).toBe('storage-locked')
    expect(await vault.never(ORIGIN)).toBe('storage-locked')
    expect(readFileSync(browserVaultPath(profile)).equals(before)).toBe(true)
  })

  it('never overwrites a corrupt vault', async () => {
    const { crypto } = fakeCrypto()
    const corrupt = sealed('v2', '{"version":1')
    writeVault(corrupt)
    const vault = new BrowserVault(profile, crypto)
    expect(await vault.storage()).toBe('corrupt')
    expect(await vault.save(ORIGIN, 'me', 'pw')).toBe('storage-corrupt')
    expect(readFileSync(browserVaultPath(profile)).equals(corrupt)).toBe(true)
  })

  it('treats a decrypted payload over the plaintext cap as corrupt', async () => {
    const { crypto } = fakeCrypto()
    const records = Array.from({ length: 1100 }, (_, index) =>
      stored(index, `https://site${String(index % 40)}.example.com`, 'p'.repeat(8000))
    )
    const oversized = sealed('v2', JSON.stringify({ version: 1, records, never: [] }))
    writeVault(oversized)
    const vault = new BrowserVault(profile, crypto)
    expect(await vault.storage()).toBe('corrupt')
    expect(await vault.save(ORIGIN, 'me', 'pw')).toBe('storage-corrupt')
    expect(readFileSync(browserVaultPath(profile)).equals(oversized)).toBe(true)
  })

  it('caps new accounts per site but still updates one at the cap', async () => {
    const { crypto } = fakeCrypto()
    const vault = new BrowserVault(profile, crypto)
    const saved = await Promise.all(
      Array.from({ length: BROWSER_VAULT_ORIGIN_RECORDS_MAX }, (_, index) =>
        vault.save(ORIGIN, `user${String(index)}`, 'pw')
      )
    )
    expect(saved.every((failure) => failure === null)).toBe(true)
    expect(await vault.save(ORIGIN, 'one-too-many', 'pw')).toBe('limit')
    expect(await vault.save(ORIGIN, 'user0', 'changed')).toBeNull()
    expect(await vault.save('https://other.example.com', 'me', 'pw')).toBeNull()
    const listed = await vault.accounts(ORIGIN)
    expect(listed.accounts).toHaveLength(BROWSER_VAULT_ORIGIN_RECORDS_MAX)
    const first = listed.accounts.find((account) => account.username === 'user0')
    expect(await vault.credential(ORIGIN, first?.id ?? '')).toEqual({
      username: 'user0',
      password: 'changed',
    })
  })

  it('treats a stored vault over the per-site cap as corrupt', async () => {
    const { crypto } = fakeCrypto()
    const records = Array.from({ length: BROWSER_VAULT_ORIGIN_RECORDS_MAX + 1 }, (_, index) =>
      stored(index, ORIGIN, 'pw')
    )
    const crowded = sealed('v2', JSON.stringify({ version: 1, records, never: [] }))
    writeVault(crowded)
    const vault = new BrowserVault(profile, crypto)
    expect(await vault.storage()).toBe('corrupt')
    expect(readFileSync(browserVaultPath(profile)).equals(crowded)).toBe(true)
  })

  it('re-encrypts with the current key when decryption asks for it', async () => {
    const { crypto } = fakeCrypto()
    const record = {
      id: 'r1',
      origin: ORIGIN,
      username: 'me',
      password: 'pw',
      createdAt: 1,
      updatedAt: 1,
    }
    writeVault(sealed('v1', JSON.stringify({ version: 1, records: [record], never: [] })))
    expect((await new BrowserVault(profile, crypto).accounts(ORIGIN)).accounts).toHaveLength(1)
    expect(readFileSync(browserVaultPath(profile), 'utf8').startsWith('v2:')).toBe(true)
    expect(await new BrowserVault(profile, crypto).credential(ORIGIN, 'r1')).toEqual({
      username: 'me',
      password: 'pw',
    })
  })

  it('loses no update when saves race', async () => {
    const { crypto } = fakeCrypto()
    const vault = new BrowserVault(profile, crypto)
    const results = await Promise.all([
      vault.save(ORIGIN, 'a', '1'),
      vault.save(ORIGIN, 'b', '2'),
      vault.save('http://localhost:3000', 'c', '3'),
    ])
    expect(results).toEqual([null, null, null])
    const reopened = new BrowserVault(profile, crypto)
    const listed = await reopened.accounts(ORIGIN)
    expect(listed.accounts.map((account) => account.username)).toEqual(['a', 'b'])
    expect((await reopened.accounts('http://localhost:3000')).accounts).toHaveLength(1)
  })

  it('keeps a local-network http login to its exact origin', async () => {
    const { crypto } = fakeCrypto()
    const local = 'http://192.168.1.23:30010'
    expect(await new BrowserVault(profile, crypto).save(local, 'me@example.com', 'pw')).toBeNull()
    const reopened = new BrowserVault(profile, crypto)
    const listed = await reopened.accounts(local)
    expect(listed.accounts.map((account) => account.username)).toEqual(['me@example.com'])
    const id = listed.accounts[0]?.id ?? ''
    expect(await reopened.credential(local, id)).toEqual({
      username: 'me@example.com',
      password: 'pw',
    })
    for (const other of [
      'http://192.168.1.23:30011',
      'http://192.168.1.24:30010',
      'https://192.168.1.23:30010',
    ]) {
      expect(await reopened.credential(other, id)).toBeNull()
    }
  })

  it('refuses origins that may not hold passwords', async () => {
    const { crypto } = fakeCrypto()
    const vault = new BrowserVault(profile, crypto)
    expect(await vault.save('http://example.com', 'me', 'pw')).toBe('not-eligible')
    expect(await vault.save('https://example.com/login', 'me', 'pw')).toBe('not-eligible')
    expect(await vault.save('http://localhost.evil.com', 'me', 'pw')).toBe('not-eligible')
    expect(await vault.never('http://example.com')).toBe('not-eligible')
    expect(existsSync(browserVaultPath(profile))).toBe(false)
  })

  it('remembers never-save origins and lets saving resume', async () => {
    const { crypto } = fakeCrypto()
    const vault = new BrowserVault(profile, crypto)
    expect(await vault.never(ORIGIN)).toBeNull()
    expect(await vault.classify(ORIGIN, 'me', 'pw')).toBe('never')
    expect((await vault.accounts(ORIGIN)).neverSave).toBe(true)
    expect(await vault.allow(ORIGIN)).toBeNull()
    expect(await vault.classify(ORIGIN, 'me', 'pw')).toBe('save')
  })
})

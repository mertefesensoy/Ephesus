import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IpcChannels } from '../../src/shared/ipc'
import { SECRET_MASK } from '../../src/shared/redaction'
import { scopeGrants, secretNameSchema, secretSetSchema } from '../../src/shared/secrets'
import { SecretBroker } from '../../src/main/watch/secrets'
import type { SecretCipher } from '../../src/main/watch/cipher'

/**
 * The broker (ADR-0010) on real fs in a temp home. The cipher is the one seam —
 * `safeStorage` needs a running Electron app and cannot load under vitest (M0
 * constraint 3) — so what is asserted here is exactly what the broker is
 * responsible for: that no path hands a value back out, that a role gets only
 * what it declared, and that a machine with no keychain refuses rather than
 * writes plaintext.
 *
 * Fixture values are scanner-neutral (M1-audit ruling): nothing here carries a
 * real provider's prefix.
 */

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

/** A reversible stand-in for the OS keychain. Not encryption — a seam. */
function fakeCipher(over: Partial<SecretCipher> = {}): SecretCipher {
  return {
    available: () => true,
    backend: () => 'fake',
    encrypt: (plaintext) => Buffer.from(plaintext, 'utf8').toString('base64'),
    decrypt: (payload) => Buffer.from(payload, 'base64').toString('utf8'),
    ...over
  }
}

function broker(over: Partial<Parameters<typeof makeBroker>[0]> = {}): SecretBroker {
  return makeBroker(over)
}

function makeBroker(over: {
  cipher?: SecretCipher
  onRotated?: (name: string) => void
  onDegraded?: (detail: string) => void
  storePath?: string
}): SecretBroker {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-secrets-'))
  homes.push(home)
  return new SecretBroker({
    storePath: over.storePath ?? path.join(home, 'secrets.enc'),
    cipher: over.cipher ?? fakeCipher(),
    ...(over.onRotated ? { onRotated: over.onRotated } : {}),
    ...(over.onDegraded ? { onDegraded: over.onDegraded } : {})
  })
}

const VALUE = 'not-a-real-credential-0123456789'
const OTHER = 'a-different-fake-value-987654321'

describe('write-only API surface (S-SECRETS)', () => {
  it('exposes no channel that reads a secret back', () => {
    const secretChannels = Object.values(IpcChannels).filter((channel) =>
      channel.startsWith('secrets:')
    )
    // SDD §5: set/status/test/delete — plus list/health, which return names and
    // storage state. Nothing that returns a value, and adding one fails here.
    expect([...secretChannels].sort()).toEqual([
      'secrets:delete',
      'secrets:health',
      'secrets:list',
      'secrets:set',
      'secrets:status',
      'secrets:test'
    ])
    for (const channel of secretChannels) {
      expect(channel).not.toMatch(/(get|read|reveal|value|show)/)
    }
  })

  it('returns nothing containing the stored value from any public method', () => {
    const store = broker()
    store.set('API_KEY_FAKE', VALUE)
    // Every public method, called with a planted value in the store: none of
    // their return values may contain it, however it is serialised.
    const returns: unknown[] = [
      store.names(),
      store.status('API_KEY_FAKE'),
      store.set('API_KEY_FAKE', VALUE),
      store.test('API_KEY_FAKE'),
      store.health(),
      store.delete('API_KEY_FAKE')
    ]
    for (const value of returns) {
      expect(JSON.stringify(value)).not.toContain(VALUE)
    }
  })

  it('keeps plaintext out of the store file (NFR-8)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-secrets-'))
    homes.push(home)
    const storePath = path.join(home, 'secrets.enc')
    new SecretBroker({ storePath, cipher: fakeCipher() }).set('API_KEY_FAKE', VALUE)
    expect(fs.readFileSync(storePath, 'utf8')).not.toContain(VALUE)
  })

  it('writes the store 0600', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-secrets-'))
    homes.push(home)
    const storePath = path.join(home, 'secrets.enc')
    new SecretBroker({ storePath, cipher: fakeCipher() }).set('API_KEY_FAKE', VALUE)
    if (process.platform !== 'win32') {
      expect(fs.statSync(storePath).mode & 0o777).toBe(0o600)
    }
  })
})

describe('lifecycle', () => {
  it('reports presence and rotation without a value', () => {
    const store = broker()
    expect(store.status('API_KEY_FAKE')).toEqual({
      name: 'API_KEY_FAKE',
      present: false,
      lastRotated: null
    })
    const after = store.set('API_KEY_FAKE', VALUE)
    expect(after.present).toBe(true)
    expect(after.lastRotated).not.toBeNull()
  })

  it('announces a rotation by name for the book of record', () => {
    const rotated: string[] = []
    const store = broker({ onRotated: (name) => rotated.push(name) })
    store.set('API_KEY_FAKE', VALUE)
    store.set('API_KEY_FAKE', OTHER)
    expect(rotated).toEqual(['API_KEY_FAKE', 'API_KEY_FAKE'])
  })

  it('deletes, and a deleted secret is gone from names and grants', () => {
    const store = broker()
    store.set('API_KEY_FAKE', VALUE)
    expect(store.names()).toEqual(['API_KEY_FAKE'])
    expect(store.delete('API_KEY_FAKE').present).toBe(false)
    expect(store.names()).toEqual([])
    expect(store.grantsFor(['API_KEY_FAKE'])).toEqual({ env: {}, missing: ['API_KEY_FAKE'] })
  })

  it('survives a restart against the same store file', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-secrets-'))
    homes.push(home)
    const storePath = path.join(home, 'secrets.enc')
    new SecretBroker({ storePath, cipher: fakeCipher() }).set('API_KEY_FAKE', VALUE)
    const rebooted = new SecretBroker({ storePath, cipher: fakeCipher() })
    expect(rebooted.status('API_KEY_FAKE').present).toBe(true)
    expect(rebooted.grantsFor(['API_KEY_FAKE']).env).toEqual({ API_KEY_FAKE: VALUE })
  })

  it('tests retrievability, and fails visibly when the keychain changed', () => {
    const store = broker()
    store.set('API_KEY_FAKE', VALUE)
    expect(store.test('API_KEY_FAKE')).toEqual({ ok: true, checked: 'retrievable' })
    expect(store.test('NEVER_STORED').ok).toBe(false)

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-secrets-'))
    homes.push(home)
    const storePath = path.join(home, 'secrets.enc')
    new SecretBroker({ storePath, cipher: fakeCipher() }).set('API_KEY_FAKE', VALUE)
    const moved = new SecretBroker({
      storePath,
      cipher: fakeCipher({
        decrypt: () => {
          throw new Error('keychain entry missing')
        }
      })
    })
    const verdict = moved.test('API_KEY_FAKE')
    expect(verdict.ok).toBe(false)
    expect(verdict.ok ? '' : verdict.reason).toContain('cannot decrypt')
  })
})

describe('degradation is visible (invariant §7)', () => {
  it('refuses to store when the machine has no encryption backend', () => {
    const store = broker({ cipher: fakeCipher({ available: () => false }) })
    expect(() => store.set('API_KEY_FAKE', VALUE)).toThrow(/refusing to store/)
    expect(store.health()).toMatchObject({ available: false })
    expect(store.health().failure).toContain('no OS encryption backend')
  })

  it('refuses to overwrite a store it could not parse, and says so', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-secrets-'))
    homes.push(home)
    const storePath = path.join(home, 'secrets.enc')
    fs.writeFileSync(storePath, '{ this is not json')
    const degradations: string[] = []
    const store = new SecretBroker({
      storePath,
      cipher: fakeCipher(),
      onDegraded: (detail) => degradations.push(detail)
    })
    expect(degradations.join(' ')).toContain('refusing to overwrite')
    expect(store.health().available).toBe(false)
    expect(() => store.set('API_KEY_FAKE', VALUE)).toThrow(/refusing to write over it/)
    // The evidence is still on disk: credentials exist nowhere else.
    expect(fs.readFileSync(storePath, 'utf8')).toBe('{ this is not json')
  })

  it('reports a grant it holds but cannot decrypt instead of injecting nothing quietly', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-secrets-'))
    homes.push(home)
    const storePath = path.join(home, 'secrets.enc')
    new SecretBroker({ storePath, cipher: fakeCipher() }).set('API_KEY_FAKE', VALUE)
    const degradations: string[] = []
    const store = new SecretBroker({
      storePath,
      cipher: fakeCipher({
        decrypt: () => {
          throw new Error('keychain entry missing')
        }
      }),
      onDegraded: (detail) => degradations.push(detail)
    })
    expect(store.grantsFor(['API_KEY_FAKE'])).toEqual({ env: {}, missing: ['API_KEY_FAKE'] })
    expect(degradations.join(' ')).toContain('could not be decrypted')
  })
})

describe('grant scoping is least-privilege by construction', () => {
  it('gives a role only what it declared, never everything the broker holds', () => {
    const store = broker()
    store.set('GH_TOKEN_FAKE', VALUE)
    store.set('VOICE_KEY_FAKE', OTHER)
    // The triage agent declares the GitHub token; the voice key must not reach
    // it even though the broker holds one (ADR-0010's worked example).
    const granted = store.grantsFor(['GH_TOKEN_FAKE'])
    expect(granted.env).toEqual({ GH_TOKEN_FAKE: VALUE })
    expect(Object.keys(granted.env)).not.toContain('VOICE_KEY_FAKE')
    expect(JSON.stringify(granted)).not.toContain(OTHER)
  })

  it('declares nothing, gets nothing', () => {
    const store = broker()
    store.set('GH_TOKEN_FAKE', VALUE)
    expect(store.grantsFor([])).toEqual({ env: {}, missing: [] })
  })

  it('names a declared grant the broker cannot supply', () => {
    const store = broker()
    expect(store.grantsFor(['GH_TOKEN_FAKE', 'VOICE_KEY_FAKE'])).toEqual({
      env: {},
      missing: ['GH_TOKEN_FAKE', 'VOICE_KEY_FAKE']
    })
  })

  it('iterates the declared list, so an undeclared name has no path in', () => {
    // The property as a pure function: scopeGrants can only emit keys it was
    // asked for, whatever the lookup would have answered.
    const scoped = scopeGrants(['ONLY_THIS'], () => VALUE)
    expect(Object.keys(scoped.env)).toEqual(['ONLY_THIS'])
  })
})

describe('the redactor the broker builds', () => {
  it('masks every value the broker holds', () => {
    const store = broker()
    store.set('GH_TOKEN_FAKE', VALUE)
    store.set('VOICE_KEY_FAKE', OTHER)
    const filter = store.redactor()
    const out = filter.push(`${VALUE} then ${OTHER}\r\n`) + filter.flush()
    expect(out).toBe(`${SECRET_MASK} then ${SECRET_MASK}\r\n`)
  })

  it('masks a credential stored after the stream started', () => {
    const store = broker()
    const filter = store.redactor()
    expect(filter.push(`${VALUE}\r\n`)).toContain(VALUE)
    store.set('GH_TOKEN_FAKE', VALUE)
    expect(filter.push(`${VALUE}\r\n`)).toBe(`${SECRET_MASK}\r\n`)
  })
})

describe('payload validation', () => {
  it('accepts env-var-shaped names only', () => {
    expect(secretNameSchema.safeParse('GH_TOKEN').success).toBe(true)
    expect(secretNameSchema.safeParse('gh_token').success).toBe(false)
    expect(secretNameSchema.safeParse('9LIVES').success).toBe(false)
    expect(secretNameSchema.safeParse('GH-TOKEN').success).toBe(false)
    expect(secretNameSchema.safeParse('').success).toBe(false)
  })

  it('refuses an empty value and an unknown field', () => {
    expect(secretSetSchema.safeParse({ name: 'GH_TOKEN', value: '' }).success).toBe(false)
    expect(secretSetSchema.safeParse({ name: 'GH_TOKEN', value: 'x', extra: 1 }).success).toBe(
      false
    )
  })
})

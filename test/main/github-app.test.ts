import { generateKeyPairSync, createVerify } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitHubAppIdentity, appJwt } from '../../src/main/harbor/app-auth'
import {
  GITHUB_APP_SCHEMA_VERSION,
  botIdentity,
  coAuthorTrailer
} from '../../src/shared/github-app'

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})

function home(config: unknown | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-ghapp-'))
  temps.push(dir)
  if (config !== null) {
    fs.writeFileSync(path.join(dir, 'github-app.json'), JSON.stringify(config), 'utf8')
  }
  return dir
}

const CONFIG = {
  schemaVersion: GITHUB_APP_SCHEMA_VERSION,
  appId: 12345,
  installationId: 67890,
  slug: 'ephesus-crew'
}

function decode(part: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
  ) as Record<string, unknown>
}

describe('authenticating as the App itself', () => {
  it('signs a JWT the App’s public key verifies', () => {
    const jwt = appJwt(12345, keys.privateKey, 1_800_000_000)
    const [header, payload, signature] = jwt.split('.')
    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${header}.${payload}`)
    verifier.end()
    const raw = Buffer.from((signature as string).replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    expect(verifier.verify(keys.publicKey, raw)).toBe(true)
  })

  it('backdates iat, because the clock that matters is GitHub’s', () => {
    // A JWT issued one second "in the future" against their clock is rejected
    // outright, and the symptom is an unexplained 401 at spawn.
    const claims = decode(appJwt(12345, keys.privateKey, 1_800_000_000).split('.')[1] as string)
    expect(claims['iat']).toBe(1_800_000_000 - 60)
    expect(claims['iss']).toBe('12345')
    expect(Number(claims['exp']) - Number(claims['iat'])).toBeLessThanOrEqual(10 * 60)
  })
})

describe('the company credential is minted, never stored', () => {
  function rig(
    over: { key?: string | null; fetchImpl?: typeof fetch; config?: unknown | null } = {}
  ) {
    const root = home(over.config === undefined ? CONFIG : over.config)
    return new GitHubAppIdentity({
      configPath: path.join(root, 'github-app.json'),
      privateKey: () => (over.key === undefined ? keys.privateKey : over.key),
      fetchImpl: over.fetchImpl,
      // An hour before the token GitHub hands back expires.
      now: () => Date.parse('2026-09-01T12:00:00Z')
    })
  }

  const okFetch = ((url: string) => {
    if (url.endsWith('/access_tokens')) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ token: 'an-installation-token', expires_at: '2026-09-01T13:00:00Z' })
      })
    }
    if (url.endsWith('/users/ephesus-crew%5Bbot%5D')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 987654 }) })
    }
    return Promise.resolve({ ok: false, status: 404 })
  }) as unknown as typeof fetch

  it('holds no token before it has minted one', () => {
    expect(rig({ fetchImpl: okFetch }).token()).toBeNull()
  })

  it('mints an installation token and caches it until it expires', async () => {
    const identity = rig({ fetchImpl: okFetch })
    const minted = await identity.refresh()
    expect(minted.ok).toBe(true)
    expect(identity.token()).toBe('an-installation-token')
  })

  it('learns the bot’s numeric id rather than guessing its address', async () => {
    // ADR-0020 specified `ephesus-crew+agent.mason@users.noreply.github.com`,
    // which credits nothing: GitHub resolves `<id>+<login>@…` and only that.
    const identity = rig({ fetchImpl: okFetch })
    await identity.refresh()
    expect(identity.gitIdentity()).toEqual({
      name: 'ephesus-crew[bot]',
      email: '987654+ephesus-crew[bot]@users.noreply.github.com'
    })
  })

  it('is not configured when the key is absent, and says which name is missing', () => {
    const identity = rig({ key: null, fetchImpl: okFetch })
    expect(identity.configured()).toBe(false)
    expect(identity.warning()).toContain('GH_APP_PRIVATE_KEY')
  })

  it('is silent when no App is configured at all', () => {
    const identity = rig({ config: null, fetchImpl: okFetch })
    expect(identity.configured()).toBe(false)
    expect(identity.warning()).toBeNull()
  })

  it('names the likeliest setup mistake when the stored key is not a key', async () => {
    const result = await rig({ key: 'not a pem', fetchImpl: okFetch }).refresh()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.because).toContain('not a usable private key')
  })

  it('turns a refusal into something a human can act on', async () => {
    const refusing = (() => Promise.resolve({ ok: false, status: 401 })) as unknown as typeof fetch
    const result = await rig({ fetchImpl: refusing }).refresh()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.because).toContain('401')
      expect(result.because).toMatch(/installation id/)
    }
  })

  it('never throws when GitHub cannot be reached', async () => {
    const offline = (() =>
      Promise.reject(new Error('getaddrinfo ENOTFOUND'))) as unknown as typeof fetch
    const result = await rig({ fetchImpl: offline }).refresh()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.because).toContain('could not reach GitHub')
  })
})

describe('who gets credit for the work', () => {
  it('builds the only noreply form GitHub resolves', () => {
    expect(botIdentity('ephesus-crew', 987654)).toEqual({
      name: 'ephesus-crew[bot]',
      email: '987654+ephesus-crew[bot]@users.noreply.github.com'
    })
  })

  it('names the agent in the trailer and the company in the address', () => {
    const trailer = coAuthorTrailer('agent.mason', botIdentity('ephesus-crew', 987654))
    expect(trailer).toBe(
      'Co-authored-by: agent.mason <987654+ephesus-crew[bot]@users.noreply.github.com>'
    )
    // The rule that outlives every ADR here: no vendor identity, ever.
    expect(trailer).not.toMatch(/claude|anthropic/i)
  })
})

import { createSign } from 'node:crypto'
import fs from 'node:fs'
import {
  GITHUB_APP_KEY_SECRET,
  botIdentity,
  githubAppConfigSchema,
  type GitHubAppConfig
} from '../../shared/github-app'

/** GitHub's own ceiling on an App JWT is ten minutes; nine leaves clock room. */
const JWT_TTL_SECONDS = 9 * 60
/**
 * Installation tokens last an hour. Refreshing at fifty minutes means a spawn
 * never receives a token with less than ten minutes on it — which matters
 * because SRS §6.1's acceptance window is itself an hour, and a credential that
 * expired mid-run would look exactly like a permissions bug.
 */
export const TOKEN_REFRESH_MS = 50 * 60 * 1000

const GITHUB_API = 'https://api.github.com'

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Contract: pure given `nowSeconds`. The RS256 JWT that authenticates as the App
 * itself — the only credential GitHub accepts when asking for an installation
 * token.
 *
 * `iat` is backdated sixty seconds on GitHub's own advice: the clock that
 * matters is theirs, and a JWT issued "in the future" by a second is rejected
 * outright.
 */
export function appJwt(appId: number, privateKeyPem: string, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + JWT_TTL_SECONDS,
      iss: String(appId)
    })
  )
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  signer.end()
  return `${header}.${payload}.${base64url(signer.sign(privateKeyPem))}`
}

export type MintResult =
  | { readonly ok: true; readonly token: string; readonly expiresAt: string }
  | { readonly ok: false; readonly because: string }

export interface GitHubAppIdentityOptions {
  readonly configPath: string
  /** Reads `GH_APP_PRIVATE_KEY` out of the broker; null when it is not stored. */
  readonly privateKey: () => string | null
  /** Injectable for tests; defaults to the platform fetch. */
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
}

/**
 * The company's GitHub credential, minted rather than stored (ADR-0022).
 *
 * The whole argument for this over a fine-grained PAT is the failure mode. A
 * PAT that leaks is valid until somebody notices; an installation token that
 * leaks is dead within the hour, and there is no rotation duty on the Architect
 * because nothing long-lived exists to rotate. What is stored is a signing key
 * that is never sent anywhere — it signs a JWT locally, and only the JWT goes
 * to GitHub.
 */
export class GitHubAppIdentity {
  private config: GitHubAppConfig | null = null
  private configWarning: string | null = null
  private cached: { token: string; expiresAt: number } | null = null
  private identity: { name: string; email: string } | null = null

  constructor(private readonly options: GitHubAppIdentityOptions) {
    this.load()
  }

  private load(): void {
    if (!fs.existsSync(this.options.configPath)) return
    try {
      const parsed = githubAppConfigSchema.safeParse(
        JSON.parse(fs.readFileSync(this.options.configPath, 'utf8'))
      )
      if (parsed.success) {
        this.config = parsed.data
        return
      }
      this.configWarning = `github-app.json invalid, no company identity: ${
        parsed.error.issues[0]?.message ?? 'schema mismatch'
      }`
    } catch (err) {
      this.configWarning = `github-app.json unreadable, no company identity: ${
        err instanceof Error ? err.message.split('\n')[0] : String(err)
      }`
    }
  }

  /** Contract: true when an App is configured AND its key is in the broker. */
  configured(): boolean {
    return this.config !== null && this.options.privateKey() !== null
  }

  /** Contract: why there is no company identity, or null when there is one. */
  warning(): string | null {
    if (this.configWarning !== null) return this.configWarning
    if (this.config === null) return null
    if (this.options.privateKey() === null) {
      return `github-app.json names App ${String(this.config.appId)} but ${GITHUB_APP_KEY_SECRET} is not in the broker`
    }
    return null
  }

  /** Contract: the cached token while it has life left, else null. Never mints. */
  token(): string | null {
    const now = (this.options.now ?? Date.now)()
    if (this.cached === null || this.cached.expiresAt <= now) return null
    return this.cached.token
  }

  /** Contract: the bot's git author identity, once `refresh()` has learnt it. */
  gitIdentity(): { name: string; email: string } | null {
    return this.identity
  }

  /**
   * Exchanges the App's signing key for an installation token, and learns the
   * bot user's numeric id so commits can be authored as an address GitHub will
   * actually resolve.
   *
   * Contract: never throws. Every failure is a reason a human can act on.
   */
  async refresh(): Promise<MintResult> {
    const config = this.config
    if (config === null) return { ok: false, because: 'no github-app.json' }
    const key = this.options.privateKey()
    if (key === null) return { ok: false, because: `${GITHUB_APP_KEY_SECRET} is not in the broker` }
    const doFetch = this.options.fetchImpl ?? fetch
    const now = (this.options.now ?? Date.now)()
    let jwt: string
    try {
      jwt = appJwt(config.appId, key, Math.floor(now / 1000))
    } catch (err) {
      // A PEM the broker holds but crypto cannot read is the likeliest setup
      // mistake there is — the wrong half of a key pair, or a pasted fragment.
      return {
        ok: false,
        because: `${GITHUB_APP_KEY_SECRET} is not a usable private key: ${
          err instanceof Error ? err.message.split('\n')[0] : String(err)
        }`
      }
    }
    const headers = {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ephesus'
    }
    let token: string
    let expiresAt: string
    try {
      const response = await doFetch(
        `${GITHUB_API}/app/installations/${String(config.installationId)}/access_tokens`,
        { method: 'POST', headers }
      )
      if (!response.ok) {
        return {
          ok: false,
          because: `GitHub refused the token request (${String(response.status)}); check the App id, the installation id, and that the key belongs to this App`
        }
      }
      const body = (await response.json()) as { token?: unknown; expires_at?: unknown }
      if (typeof body.token !== 'string' || typeof body.expires_at !== 'string') {
        return { ok: false, because: 'GitHub returned a token response in an unknown shape' }
      }
      token = body.token
      expiresAt = body.expires_at
    } catch (err) {
      return {
        ok: false,
        because: `could not reach GitHub: ${
          err instanceof Error ? err.message.split('\n')[0] : String(err)
        }`
      }
    }
    const expiry = Date.parse(expiresAt)
    this.cached = { token, expiresAt: Number.isFinite(expiry) ? expiry : now + TOKEN_REFRESH_MS }
    await this.learnIdentity(config, headers, doFetch)
    return { ok: true, token, expiresAt }
  }

  /**
   * Reads the bot user's numeric id, which is the half of its noreply address
   * that cannot be guessed. Best-effort: a commit identity we could not learn is
   * worth less than a token we did get, so this never fails the refresh.
   */
  private async learnIdentity(
    config: GitHubAppConfig,
    headers: Record<string, string>,
    doFetch: typeof fetch
  ): Promise<void> {
    if (this.identity !== null) return
    let slug = config.slug ?? null
    try {
      if (slug === null) {
        const app = await doFetch(`${GITHUB_API}/app`, { headers })
        if (!app.ok) return
        const body = (await app.json()) as { slug?: unknown }
        if (typeof body.slug !== 'string') return
        slug = body.slug
      }
      const user = await doFetch(`${GITHUB_API}/users/${slug}%5Bbot%5D`, { headers })
      if (!user.ok) return
      const body = (await user.json()) as { id?: unknown }
      if (typeof body.id !== 'number') return
      this.identity = botIdentity(slug, body.id)
    } catch {
      // Leaving `identity` null is the honest outcome: the caller falls back to
      // not setting an author rather than inventing an address.
    }
  }
}

import fs from 'node:fs'
import {
  emptySecretStore,
  parseSecretStore,
  scopeGrants,
  type SecretStatus,
  type SecretStore,
  type SecretTest,
  type SecretsHealth
} from '../../shared/secrets'
import { createRedactor, type RedactionFilter } from '../../shared/redaction'
import { writeFileAtomic } from '../fsx'
import type { SecretCipher } from './cipher'

/**
 * The write-only secret broker (ADR-0010, FR-11.4).
 *
 * The shape of this class IS the security property: there is no method that
 * returns a stored value to a caller outside main, and the two paths that need
 * plaintext — env injection at spawn and the redaction filter — take it out
 * through purpose-built doors that hand the value to a consumer rather than to
 * a return value the IPC layer could ever forward.
 *
 * Storage is `<harness home>/secrets.enc`: mode 0600, ciphertext only, outside
 * the Agora (never committed, never agent-readable) and outside SQLite (NFR-8).
 */

export interface SecretBrokerOptions {
  /** Absolute path of the encrypted store. */
  readonly storePath: string
  readonly cipher: SecretCipher
  /**
   * Appends `secret-rotated` to the book of record (SDD §4.3). The entry
   * carries the NAME and never the value — rotation must be auditable without
   * the log becoming the read path the broker refuses to be. Removal is the
   * same security-posture change in the other direction (FR-11.4 names
   * set/rotate/*delete*), so it is recorded too.
   */
  onRotated?(name: string, change: 'set' | 'removed'): void
  /** Raised when the store could not be read or written (invariant §7). */
  onDegraded?(detail: string): void
}

export class SecretBroker {
  private store: SecretStore = emptySecretStore
  /** Non-null when the store on disk failed to parse; it is never overwritten. */
  private loadFailure: string | null = null
  /**
   * The decrypted values, computed on demand and invalidated on every change.
   *
   * The redaction filter consults this on EVERY PTY chunk, for every agent. A
   * decrypt-per-chunk would be N synchronous OS-crypto calls on the main
   * thread at the PTY data rate (SDD §11's budget), and — worse for a
   * write-only broker — a fresh plaintext copy of every credential on the heap
   * just as often. Memoizing keeps the mid-stream property (a credential
   * stored while an agent runs is masked in its live stream) because `set` and
   * `delete` are the only things that can change the answer.
   */
  private plaintext: readonly string[] | null = null

  constructor(private readonly options: SecretBrokerOptions) {
    this.load()
    // Invariant §7: a machine with no encryption backend must SAY so at boot.
    // `health()` alone is a question nobody asks — the M2 close-out audit
    // already ruled that a state with no consumer is not "visible".
    if (this.loadFailure === null && !options.cipher.available()) {
      options.onDegraded?.(
        `no OS encryption backend (${options.cipher.backend()}) — credentials cannot be stored`
      )
    }
  }

  /**
   * Reads the store once at construction. A store that fails to parse is kept
   * on disk and refused: overwriting it would destroy credentials that, by
   * design, exist nowhere else (the same evidence rule the registry follows).
   */
  private load(): void {
    if (!fs.existsSync(this.options.storePath)) return
    try {
      const parsed = parseSecretStore(JSON.parse(fs.readFileSync(this.options.storePath, 'utf8')))
      if (parsed.ok) {
        this.store = parsed.store
        return
      }
      this.loadFailure = parsed.reason
    } catch (err) {
      this.loadFailure =
        err instanceof Error ? (err.message.split('\n')[0] ?? 'unreadable') : 'unreadable'
    }
    this.options.onDegraded?.(
      `secrets store unreadable, refusing to overwrite it: ${this.loadFailure ?? 'unknown'}`
    )
  }

  /** Drops the memoized plaintext; every mutation calls this. */
  private invalidate(): void {
    this.plaintext = null
  }

  private persist(): void {
    writeFileAtomic(this.options.storePath, `${JSON.stringify(this.store, null, 2)}\n`, {
      mode: 0o600
    })
  }

  /** Storage health — shown, never silently degraded (invariant §7). */
  health(): SecretsHealth {
    if (this.loadFailure !== null) {
      return {
        available: false,
        backend: this.options.cipher.backend(),
        failure: `store unreadable (left in place): ${this.loadFailure}`
      }
    }
    const available = this.options.cipher.available()
    return {
      available,
      backend: this.options.cipher.backend(),
      failure: available ? null : 'no OS encryption backend; credentials cannot be stored'
    }
  }

  /** Names the broker holds. Names only — this is not a read path. */
  names(): readonly string[] {
    return Object.keys(this.store.secrets).sort()
  }

  /** SDD §5 `secrets:status` — presence and rotation time, never a value. */
  status(name: string): SecretStatus {
    const record = this.store.secrets[name]
    return {
      name,
      present: record !== undefined,
      lastRotated: record?.lastRotated ?? null
    }
  }

  /**
   * SDD §5 `secrets:set` — the only direction a value ever travels. Returns the
   * new status, so the UI can confirm the write without ever seeing what it
   * wrote.
   */
  set(name: string, value: string): SecretStatus {
    if (this.loadFailure !== null) {
      throw new Error(`secrets: store unreadable, refusing to write over it (${this.loadFailure})`)
    }
    if (!this.options.cipher.available()) {
      throw new Error(
        'secrets: no OS encryption backend available — refusing to store a credential in plaintext'
      )
    }
    const cipher = this.options.cipher.encrypt(value)
    this.store = {
      ...this.store,
      secrets: {
        ...this.store.secrets,
        [name]: { cipher, lastRotated: new Date().toISOString() }
      }
    }
    this.invalidate()
    this.persist()
    this.options.onRotated?.(name, 'set')
    return this.status(name)
  }

  /** SDD §5 `secrets:delete`. Returns the (now absent) status. */
  delete(name: string): SecretStatus {
    if (this.store.secrets[name] === undefined) return this.status(name)
    const secrets = { ...this.store.secrets }
    delete secrets[name]
    this.store = { ...this.store, secrets }
    this.invalidate()
    this.persist()
    this.options.onRotated?.(name, 'removed')
    return this.status(name)
  }

  /**
   * SDD §5 `secrets:test` — ok|fail, never a value. See `SecretTest`: this
   * asks the question the broker can actually answer at M3 — "can I still
   * retrieve what I stored?" — which is the failure that would otherwise show
   * up as an agent spawning without its credential.
   */
  test(name: string): SecretTest {
    const record = this.store.secrets[name]
    if (record === undefined) return { ok: false, reason: 'no secret stored under that name' }
    try {
      const value = this.options.cipher.decrypt(record.cipher)
      if (value.length === 0) return { ok: false, reason: 'stored value decrypts to empty' }
      return { ok: true, checked: 'retrievable' }
    } catch (err) {
      return {
        ok: false,
        reason: `cannot decrypt (keychain changed?): ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  /**
   * Plaintext door #1: env injection at spawn, scoped to the names the role
   * declared (ADR-0010 least-privilege). Iteration is over `declared`, so a
   * credential the hire template did not ask for has no path into the result —
   * that is the property, not a check that could be forgotten.
   *
   * `missing` is returned rather than swallowed: an agent spawning without a
   * credential its role declares is a degradation the Architect must see.
   */
  grantsFor(declared: readonly string[]): {
    readonly env: Record<string, string>
    readonly missing: readonly string[]
  } {
    return scopeGrants(declared, (name) => {
      const record = this.store.secrets[name]
      if (record === undefined) return null
      try {
        return this.options.cipher.decrypt(record.cipher)
      } catch (err) {
        this.options.onDegraded?.(
          `grant ${name} could not be decrypted: ${err instanceof Error ? err.message : String(err)}`
        )
        return null
      }
    })
  }

  /**
   * Plaintext door #2: the redaction filter (ADR-0010). The values are read
   * lazily on each chunk and never leave the filter, so a credential set while
   * an agent is already running is masked in that agent's live stream too.
   */
  redactor(): RedactionFilter {
    return createRedactor(() => this.maskableValues())
  }

  /** The memoized plaintext set the filter masks. Never leaves this module. */
  private maskableValues(): readonly string[] {
    if (this.plaintext !== null) return this.plaintext
    const values: string[] = []
    for (const record of Object.values(this.store.secrets)) {
      try {
        values.push(this.options.cipher.decrypt(record.cipher))
      } catch {
        // A blob we cannot decrypt is already surfaced by `test`/`grantsFor`;
        // failing the whole filter here would stop masking the secrets that
        // ARE readable, which is the wrong direction to fail in.
      }
    }
    this.plaintext = values
    return values
  }
}

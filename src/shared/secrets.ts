import { z } from 'zod'

/**
 * The secret broker's schemas (ADR-0010, FR-11.4). Everything here is about
 * *names* and *presence* — a value never appears in a type on this side of the
 * broker, because every type in `src/shared/` is reachable from the renderer.
 *
 * The one exception is the `set` payload, which travels renderer→main and is
 * the only direction a value is ever allowed to move.
 */

export const SECRETS_SCHEMA_VERSION = 1

/**
 * A secret's name is the environment variable an agent receives it as
 * (ADR-0010: credentials reach agents only via env injection), so the name
 * space is the env-var name space — and it matches `registryEntrySchema`'s
 * `envGrants` pattern exactly, since a grant names a secret.
 */
export const secretNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'secret name: upper-case letters, digits and underscores')

export const secretSetSchema = z
  .object({ name: secretNameSchema, value: z.string().min(1).max(8192) })
  .strict()

export const secretNamePayloadSchema = z.object({ name: secretNameSchema }).strict()

export type SecretSet = z.infer<typeof secretSetSchema>

/**
 * What the UI is allowed to know about a credential: that it is there, and when
 * it was last written. `secret:status` returns this and nothing else (SDD §5).
 */
export interface SecretStatus {
  readonly name: string
  readonly present: boolean
  /** ISO-8601 of the last `set`, or null when the secret is absent. */
  readonly lastRotated: string | null
}

/**
 * The verdict of `secret:test`. `ok` means the broker can still retrieve the
 * value it stored — the failure this catches is real and silent otherwise: an
 * OS keychain that rotated or moved under the app leaves a file full of
 * undecryptable blobs, and the first symptom would be an agent spawning without
 * the credential its role declares.
 *
 * It is deliberately NOT a provider round-trip: no provider adapter exists
 * before the Herald (M6) and the Harbor (M7), and a test that pretends to reach
 * a provider it cannot reach is worse than no test.
 */
export type SecretTest =
  | { readonly ok: true; readonly checked: 'retrievable' }
  | { readonly ok: false; readonly reason: string }

/**
 * Health of the store itself, for invariant §7. When the OS gives us no
 * encryption backend the broker refuses to store anything — writing plaintext
 * would break NFR-8 — and that refusal has to be a visible state rather than a
 * mysteriously empty secret list.
 */
export interface SecretsHealth {
  /** Whether credentials can be stored at all on this machine right now. */
  readonly available: boolean
  /** What backs the encryption, e.g. `safeStorage (basic_text)`. */
  readonly backend: string
  /** Why storage is unavailable, when it is. */
  readonly failure: string | null
}

/** The on-disk store: names, ciphertexts, timestamps. Never plaintext. */
export const secretRecordSchema = z
  .object({ cipher: z.string().min(1), lastRotated: z.string().min(1).max(64) })
  .strict()

export const secretStoreSchema = z
  .object({
    schemaVersion: z.literal(SECRETS_SCHEMA_VERSION),
    secrets: z.record(secretNameSchema, secretRecordSchema)
  })
  .strict()

export type SecretStore = z.infer<typeof secretStoreSchema>

export const emptySecretStore: SecretStore = {
  schemaVersion: SECRETS_SCHEMA_VERSION,
  secrets: {}
}

/**
 * Contract: parses a store, or explains why it could not. Never throws and
 * never repairs — a store that fails to parse keeps its file (it is the only
 * copy of credentials that cannot be read back from anywhere) and surfaces as a
 * visible degradation, exactly as the registry does.
 */
export function parseSecretStore(
  raw: unknown
):
  | { readonly ok: true; readonly store: SecretStore }
  | { readonly ok: false; readonly reason: string } {
  const parsed = secretStoreSchema.safeParse(raw)
  if (parsed.success) return { ok: true, store: parsed.data }
  const issue = parsed.error.issues[0]
  const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'secrets'
  return { ok: false, reason: `${where}: ${issue?.message ?? 'invalid secret store'}` }
}

/**
 * Contract: resolves declared grants against what the broker holds. The
 * iteration is over the DECLARED names, never over the store, which is what
 * makes least-privilege structural: a credential the role did not declare has
 * no path into the returned map (ADR-0010).
 */
export function scopeGrants(
  declared: readonly string[],
  lookup: (name: string) => string | null
): { readonly env: Record<string, string>; readonly missing: readonly string[] } {
  const env: Record<string, string> = {}
  const missing: string[] = []
  for (const name of declared) {
    const value = lookup(name)
    if (value === null) missing.push(name)
    else env[name] = value
  }
  return { env, missing }
}

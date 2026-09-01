import fs from 'node:fs'
import {
  KNOWN_TARGETS_SCHEMA_VERSION,
  knownTargetsFileSchema,
  rememberTarget,
  type KnownTarget
} from '../shared/known-targets'
import type { ActivationRequest } from '../shared/profile-activation'
import { writeFileAtomic } from './fsx'

/** Beside `gate-policy.json` and `authority.json` at the harness home root (SDD §2). */
export const KNOWN_TARGETS_REL = 'known-targets.json'

/**
 * `<harness home>/known-targets.json` — what the Architect has activated before.
 *
 * Contract: never throws on read. A missing file is an empty list, and so is an
 * unreadable or invalid one, with the reason carried out in `warning` rather
 * than swallowed. The failure mode this chooses is deliberate and is the
 * opposite of `loadGatePolicy`'s: a policy that cannot be read must deny, but a
 * convenience list that cannot be read must not stop the Architect activating
 * anything — it only means they type the path again, which is exactly where
 * they were before this file existed.
 */
export class KnownTargets {
  private targets: readonly KnownTarget[] = []
  private warningText: string | null = null

  constructor(private readonly filePath: string) {
    this.load()
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return
    try {
      const parsed = knownTargetsFileSchema.safeParse(
        JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      )
      if (parsed.success) {
        this.targets = parsed.data.targets
        return
      }
      this.warningText = `known-targets.json invalid, offering nothing: ${
        parsed.error.issues[0]?.message ?? 'schema mismatch'
      }`
    } catch (err) {
      this.warningText = `known-targets.json unreadable, offering nothing: ${
        err instanceof Error ? err.message.split('\n')[0] : String(err)
      }`
    }
  }

  /** Contract: every remembered row, most recently used first. */
  list(): readonly KnownTarget[] {
    return this.targets
  }

  /** Contract: why the list is empty when a file exists but could not be used. */
  warning(): string | null {
    return this.warningText
  }

  /**
   * Records an activation the Architect actually performed.
   *
   * Called on success only. Remembering a target that failed to activate would
   * offer the Architect a chip that reproduces their own error, which is worse
   * than an empty form.
   */
  remember(request: ActivationRequest, at: string): void {
    const next = rememberTarget(this.targets, {
      profile: request.profile,
      target: request.target,
      lastUsedAt: at
    })
    this.targets = next
    writeFileAtomic(
      this.filePath,
      `${JSON.stringify({ schemaVersion: KNOWN_TARGETS_SCHEMA_VERSION, targets: next }, null, 2)}\n`
    )
    // A write that succeeded clears a warning from a file we have now replaced.
    this.warningText = null
  }
}

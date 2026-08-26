import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '../fsx'
import type { SettingsRegistry } from '../settings-registry'
import type { HookPlan, SettingsInjection } from './types'

/**
 * The shared implementation of ADR-0009's settings hygiene: back up first, write
 * only local variants, restore byte-for-byte on uninstall.
 *
 * Every adapter used to carry its own copy of this. That was duplication with
 * teeth — the rule an adapter is most likely to get subtly wrong is the one
 * that modifies somebody else's repository, and a bug fixed in one adapter
 * would not reach the others. One implementation, one place to audit.
 *
 * It also records each installation in the durable registry *before* writing,
 * so a force-killed harness can undo it on the next boot. Recording first is the
 * whole point: a crash between the write and the record would leave an untracked
 * file in the Architect's tree.
 *
 * **Two agents in one repository share one settings file.** That is the normal
 * case for a company — a pair of agents working the same target — and it needs
 * reference counting, not per-agent ownership. Installing merges into whatever
 * is already there (the adapter reads the current file), so the grants
 * accumulate correctly; uninstalling must therefore restore the original only
 * when the LAST agent leaves. Without that, the first agent to finish deletes
 * the file the second one is still running under, and the survivor loses access
 * to its own mailbox mid-turn — which is exactly what a real two-agent run did.
 */

interface PathOwner {
  /** Agent ids currently relying on this file. */
  readonly refs: Set<string>
  readonly hadFile: boolean
  readonly original: Buffer | null
  readonly createdDir: boolean
}

/**
 * Keyed by absolute path, because the thing being shared is a file on disk —
 * process-wide state modelling process-wide state.
 */
const owners = new Map<string, PathOwner>()

/** Live owners of a settings path. Exposed for tests and diagnostics. */
export function settingsOwners(filePath: string): readonly string[] {
  return [...(owners.get(filePath)?.refs ?? [])]
}

export class InstalledSettingsPlan implements HookPlan {
  private installed = false

  constructor(
    readonly injections: readonly SettingsInjection[],
    private readonly agentId: string,
    /** Suffix for the preserved original, e.g. `.eph-backup`. */
    private readonly backupSuffix: string,
    private readonly registry?: SettingsRegistry
  ) {}

  private backupPathFor(target: string): string {
    return `${target}${this.backupSuffix}`
  }

  async install(): Promise<void> {
    if (this.installed) return

    for (const injection of this.injections) {
      const dir = path.dirname(injection.path)
      let owner = owners.get(injection.path)

      if (!owner) {
        const hadFile = fs.existsSync(injection.path)
        owner = {
          refs: new Set<string>(),
          hadFile,
          original: hadFile ? fs.readFileSync(injection.path) : null,
          createdDir: !fs.existsSync(dir)
        }
        owners.set(injection.path, owner)

        fs.mkdirSync(dir, { recursive: true })
        // Byte-for-byte, so restoring cannot re-encode the Architect's file.
        if (owner.original) writeFileAtomic(this.backupPathFor(injection.path), owner.original)
      }

      owner.refs.add(this.agentId)

      this.registry?.record({
        agentId: this.agentId,
        path: injection.path,
        backupPath: owner.hadFile ? this.backupPathFor(injection.path) : null,
        createdDir: owner.createdDir
      })

      fs.mkdirSync(dir, { recursive: true })
      writeFileAtomic(injection.path, injection.contents)
    }

    this.installed = true
  }

  async uninstall(): Promise<void> {
    if (!this.installed) return

    for (const injection of [...this.injections].reverse()) {
      const owner = owners.get(injection.path)
      if (!owner) continue

      owner.refs.delete(this.agentId)
      // Someone else is still working under this file: leave it exactly as is.
      if (owner.refs.size > 0) continue

      owners.delete(injection.path)
      const backup = this.backupPathFor(injection.path)
      if (owner.hadFile && fs.existsSync(backup)) {
        writeFileAtomic(injection.path, fs.readFileSync(backup))
        fs.rmSync(backup, { force: true })
      } else {
        fs.rmSync(injection.path, { force: true })
        const dir = path.dirname(injection.path)
        if (owner.createdDir && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
          fs.rmdirSync(dir)
        }
      }
    }

    this.registry?.clear(this.agentId)
    this.installed = false
  }
}

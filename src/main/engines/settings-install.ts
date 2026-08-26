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
 * so a force-killed harness can undo it on the next boot (the M1 carried item).
 * Recording first is the whole point: a crash between the write and the record
 * would leave an untracked file in the Architect's tree.
 */
export class InstalledSettingsPlan implements HookPlan {
  private installed = false
  private readonly hadFile = new Map<string, boolean>()
  private readonly createdDir = new Map<string, boolean>()

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
      const createdDir = !fs.existsSync(dir)
      const hadFile = fs.existsSync(injection.path)
      this.createdDir.set(injection.path, createdDir)
      this.hadFile.set(injection.path, hadFile)

      this.registry?.record({
        agentId: this.agentId,
        path: injection.path,
        backupPath: hadFile ? this.backupPathFor(injection.path) : null,
        createdDir
      })

      fs.mkdirSync(dir, { recursive: true })
      if (hadFile) {
        // Byte-for-byte, so restoring cannot re-encode the Architect's file.
        writeFileAtomic(this.backupPathFor(injection.path), fs.readFileSync(injection.path))
      }
      writeFileAtomic(injection.path, injection.contents)
    }

    this.installed = true
  }

  async uninstall(): Promise<void> {
    if (!this.installed) return

    for (const injection of [...this.injections].reverse()) {
      const backup = this.backupPathFor(injection.path)
      if (this.hadFile.get(injection.path) && fs.existsSync(backup)) {
        writeFileAtomic(injection.path, fs.readFileSync(backup))
        fs.rmSync(backup, { force: true })
      } else {
        fs.rmSync(injection.path, { force: true })
        const dir = path.dirname(injection.path)
        if (this.createdDir.get(injection.path) && fs.existsSync(dir)) {
          if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
        }
      }
    }

    this.registry?.clear(this.agentId)
    this.installed = false
  }
}

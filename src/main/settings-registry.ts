import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './fsx'

/**
 * A durable record of every settings file the harness has written into somebody
 * else's repository (ADR-0009 hygiene).
 *
 * M1 restored these on graceful close and proved it. What it could not do was
 * survive a *force-killed* harness: the process dies, and
 * `<cwd>/.claude/settings.local.json` stays in the Architect's working tree with
 * no record that we put it there. That was the M1 exit review's carried item,
 * and this is its fix — the installation is recorded before the file is written,
 * so the next boot can always undo it.
 *
 * The registry is app-local state (SDD §4.6): agents never see it, and it never
 * goes in the Agora.
 */

export interface InstalledSettings {
  readonly agentId: string
  /** File the harness wrote. */
  readonly path: string
  /** Backup of what was there before, or null when nothing was. */
  readonly backupPath: string | null
  /** True when the harness also created the containing directory. */
  readonly createdDir: boolean
}

export interface SettingsRegistry {
  record(entry: InstalledSettings): void
  /** Forgets an agent's entries — called once they have been restored. */
  clear(agentId: string): void
  list(): readonly InstalledSettings[]
}

/** For tests and for a harness running without SQLite. */
export class MemorySettingsRegistry implements SettingsRegistry {
  private readonly rows: InstalledSettings[] = []

  record(entry: InstalledSettings): void {
    this.rows.push(entry)
  }
  clear(agentId: string): void {
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      if (this.rows[i]?.agentId === agentId) this.rows.splice(i, 1)
    }
  }
  list(): readonly InstalledSettings[] {
    return [...this.rows]
  }
}

export interface SweepResult {
  readonly restored: readonly string[]
  readonly removed: readonly string[]
  readonly failed: readonly { path: string; reason: string }[]
}

/**
 * Undoes every recorded installation. Safe to run only at startup, and that is
 * where it runs: no agent is live in a process that has just booted, so a file
 * in this registry can only be a leftover.
 *
 * Contract: never throws. A file that cannot be restored is reported, not
 * swallowed and not fatal — the Architect's repo being modified is exactly the
 * kind of thing that must be said out loud (invariant §7), and a boot that dies
 * on it helps nobody.
 */
export function sweepInstalledSettings(registry: SettingsRegistry): SweepResult {
  const restored: string[] = []
  const removed: string[] = []
  const failed: { path: string; reason: string }[] = []

  for (const entry of registry.list()) {
    try {
      if (entry.backupPath !== null && fs.existsSync(entry.backupPath)) {
        // Byte-for-byte, exactly as the graceful path does.
        writeFileAtomic(entry.path, fs.readFileSync(entry.backupPath))
        fs.rmSync(entry.backupPath, { force: true })
        restored.push(entry.path)
      } else if (fs.existsSync(entry.path)) {
        fs.rmSync(entry.path, { force: true })
        removed.push(entry.path)
        const dir = path.dirname(entry.path)
        if (entry.createdDir && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
          fs.rmdirSync(dir)
        }
      }
      registry.clear(entry.agentId)
    } catch (err) {
      failed.push({
        path: entry.path,
        reason: err instanceof Error ? err.message : String(err)
      })
    }
  }

  return { restored, removed, failed }
}

import Database from 'better-sqlite3'
import { windowBoundsSchema, type WindowBounds } from '../shared/window-state'
import type { InstalledSettings, SettingsRegistry } from './settings-registry'

/**
 * App-local SQLite (SDD §4.6) — never agent-visible. M0.5 owns `window_state`;
 * `command_history`, `cost_ledger` (append-only) and `metrics_rollup` land with
 * their milestones. All rows validate through src/shared/ schemas on read.
 */
export class AppDb implements SettingsRegistry {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS window_state (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         x INTEGER NOT NULL, y INTEGER NOT NULL,
         width INTEGER NOT NULL, height INTEGER NOT NULL
       )`
    )
    // Every settings file the harness writes into somebody else's repo, so a
    // force-killed harness can undo it on the next boot (M1 carried item).
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS installed_settings (
         agent_id TEXT NOT NULL,
         path TEXT NOT NULL,
         backup_path TEXT,
         created_dir INTEGER NOT NULL,
         PRIMARY KEY (agent_id, path)
       )`
    )
  }

  record(entry: InstalledSettings): void {
    this.db
      .prepare(
        `INSERT INTO installed_settings (agent_id, path, backup_path, created_dir)
         VALUES (@agentId, @path, @backupPath, @createdDir)
         ON CONFLICT(agent_id, path) DO UPDATE SET
           backup_path=@backupPath, created_dir=@createdDir`
      )
      .run({
        agentId: entry.agentId,
        path: entry.path,
        backupPath: entry.backupPath,
        createdDir: entry.createdDir ? 1 : 0
      })
  }

  clear(agentId: string): void {
    this.db.prepare('DELETE FROM installed_settings WHERE agent_id = ?').run(agentId)
  }

  list(): readonly InstalledSettings[] {
    const rows = this.db
      .prepare('SELECT agent_id, path, backup_path, created_dir FROM installed_settings')
      .all() as {
      agent_id: string
      path: string
      backup_path: string | null
      created_dir: number
    }[]
    return rows.map((row) => ({
      agentId: row.agent_id,
      path: row.path,
      backupPath: row.backup_path,
      createdDir: row.created_dir === 1
    }))
  }

  getWindowBounds(): WindowBounds | null {
    const row = this.db.prepare('SELECT x, y, width, height FROM window_state WHERE id = 1').get()
    if (!row) return null
    const parsed = windowBoundsSchema.safeParse(row)
    return parsed.success ? parsed.data : null
  }

  saveWindowBounds(bounds: WindowBounds): void {
    this.db
      .prepare(
        `INSERT INTO window_state (id, x, y, width, height) VALUES (1, @x, @y, @width, @height)
         ON CONFLICT(id) DO UPDATE SET x=@x, y=@y, width=@width, height=@height`
      )
      .run(bounds)
  }

  close(): void {
    this.db.close()
  }
}

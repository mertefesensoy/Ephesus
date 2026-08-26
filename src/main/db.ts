import Database from 'better-sqlite3'
import { windowBoundsSchema, type WindowBounds } from '../shared/window-state'

/**
 * App-local SQLite (SDD §4.6) — never agent-visible. M0.5 owns `window_state`;
 * `command_history`, `cost_ledger` (append-only) and `metrics_rollup` land with
 * their milestones. All rows validate through src/shared/ schemas on read.
 */
export class AppDb {
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

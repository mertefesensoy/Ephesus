import Database from 'better-sqlite3'
import { ledgerRowSchema, type FoldCursor, type LedgerRow } from '../shared/cost'
import { windowBoundsSchema, type WindowBounds } from '../shared/window-state'
import type { InstalledSettings, SettingsRegistry } from './settings-registry'
import type { LedgerStore } from './watch/ledger'

/**
 * App-local SQLite (SDD §4.6) — never agent-visible. M0.5 owns `window_state`;
 * M3.2 adds `cost_ledger` (append-only) and its fold cursors; `command_history`
 * and `metrics_rollup` land with their milestones. All rows validate through
 * src/shared/ schemas on read.
 */
export class AppDb implements SettingsRegistry, LedgerStore {
  private readonly db: Database.Database

  /** Raised when a stored row failed validation on read (invariant §7). */
  onUnreadableRow?: (detail: string) => void

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
    // The durable cost ledger (SDD §4.6, ADR-0011). APPEND-ONLY: this class
    // never issues an UPDATE or DELETE against it, which is what makes the
    // restart-reset bug class impossible rather than merely avoided.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS cost_ledger (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         agent TEXT NOT NULL,
         session TEXT NOT NULL,
         model TEXT NOT NULL,
         day TEXT NOT NULL,
         in_tokens INTEGER NOT NULL,
         out_tokens INTEGER NOT NULL,
         cost_usd REAL,
         source TEXT NOT NULL
       )`
    )
    this.db.exec('CREATE INDEX IF NOT EXISTS cost_ledger_agent ON cost_ledger (agent)')
    // How far each transcript file has been folded. Metadata about READING,
    // not a record of spend — the one mutable row in this design.
    // Keyed by (agent, source): two agents may share a `cwd`, and therefore a
    // transcript directory, since FR-1.5 makes worktree isolation optional. A
    // source-only key let whichever agent ticked first claim every fact while
    // the other silently recorded zero.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS cost_fold_cursor (
         agent TEXT NOT NULL,
         source TEXT NOT NULL,
         folded INTEGER NOT NULL,
         PRIMARY KEY (agent, source)
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

  /** LedgerStore: append-only insert of folded rows (invariant §5). */
  append(rows: readonly LedgerRow[]): void {
    const insert = this.db.prepare(
      `INSERT INTO cost_ledger (agent, session, model, day, in_tokens, out_tokens, cost_usd, source)
       VALUES (@agent, @session, @model, @day, @inTokens, @outTokens, @costUsd, @source)`
    )
    const all = this.db.transaction((batch: readonly LedgerRow[]) => {
      for (const row of batch) insert.run(ledgerRowSchema.parse(row))
    })
    all(rows)
  }

  /** LedgerStore: every row this agent ever produced, oldest first. */
  rowsFor(agent: string): readonly LedgerRow[] {
    const rows = this.db
      .prepare(
        `SELECT agent, session, model, day, in_tokens, out_tokens, cost_usd, source
         FROM cost_ledger WHERE agent = ? ORDER BY id`
      )
      .all(agent) as {
      agent: string
      session: string
      model: string
      day: string
      in_tokens: number
      out_tokens: number
      cost_usd: number | null
      source: string
    }[]
    // Validated on read, as this class's contract says: a corrupted or
    // hand-edited row (NULL model, negative tokens) must not flow into the
    // totals the UI trusts. An unreadable row is dropped and reported, never
    // repaired — the ledger is append-only (invariant §5).
    const parsed: LedgerRow[] = []
    for (const row of rows) {
      const candidate = ledgerRowSchema.safeParse({
        agent: row.agent,
        session: row.session,
        model: row.model,
        day: row.day,
        inTokens: row.in_tokens,
        outTokens: row.out_tokens,
        costUsd: row.cost_usd,
        source: row.source
      })
      if (candidate.success) parsed.push(candidate.data)
      else
        this.onUnreadableRow?.(
          `cost_ledger row for ${agent}: ${candidate.error.issues[0]?.message ?? 'invalid'}`
        )
    }
    return parsed
  }

  cursor(agent: string, source: string): FoldCursor {
    const row = this.db
      .prepare('SELECT folded FROM cost_fold_cursor WHERE agent = ? AND source = ?')
      .get(agent, source)
    const folded = (row as { folded: number } | undefined)?.folded
    return { agent, source, folded: typeof folded === 'number' && folded >= 0 ? folded : 0 }
  }

  saveCursor(cursor: FoldCursor): void {
    this.db
      .prepare(
        `INSERT INTO cost_fold_cursor (agent, source, folded) VALUES (@agent, @source, @folded)
         ON CONFLICT(agent, source) DO UPDATE SET folded=@folded`
      )
      .run(cursor)
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

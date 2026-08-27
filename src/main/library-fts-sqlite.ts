import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { recallSourceSchema, type RecallSource } from '../shared/recall'
import type { FtsDocState, FtsPassageRow, FtsSearchRow, FtsStore } from './library-fts'

/**
 * The shipped `FtsStore`: SQLite FTS5 over the company's markdown
 * (ADR-0006 layer 2's fallback rung).
 *
 * It lives in `~/.ephesus/index/`, **not** in `db.sqlite`, and that placement is
 * load-bearing: SDD §10 says a corrupt recall index is deleted and rebuilt from
 * markdown, and `db.sqlite` holds the append-only cost ledger, which must never
 * be deletable to fix search. Derived state and durable state do not share a
 * file (SDD §2 — the `index/` directory is disposable by design).
 *
 * This module imports a native addon and is therefore imported only by
 * `index.ts`: after `electron-rebuild` it is Electron-ABI and will not load
 * under vitest (BUILD-PROMPT §10.3). Everything testable about this rung lives
 * in `library-fts.ts` on the other side of the `FtsStore` seam.
 */

/** `~/.ephesus/index/fts.sqlite`. */
export const FTS_DB_FILE = 'fts.sqlite'

export class SqliteFtsStore implements FtsStore {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS doc_state (
         ref TEXT PRIMARY KEY,
         mtime_ms REAL NOT NULL,
         size INTEGER NOT NULL
       )`
    )
    // `scope` and `title` are indexed as well as the body: an agent searching
    // for another agent's name should find that agent's memory.
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS passages USING fts5(
         ref UNINDEXED, source UNINDEXED, scope, title, body
       )`
    )
  }

  states(): readonly FtsDocState[] {
    const rows = this.db.prepare(`SELECT ref, mtime_ms, size FROM doc_state`).all() as {
      ref: string
      mtime_ms: number
      size: number
    }[]
    return rows.map((row) => ({ ref: row.ref, mtimeMs: row.mtime_ms, size: row.size }))
  }

  replace(state: FtsDocState, passages: readonly FtsPassageRow[]): void {
    const write = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM passages WHERE ref = ?`).run(state.ref)
      const insert = this.db.prepare(
        `INSERT INTO passages (ref, source, scope, title, body) VALUES (?, ?, ?, ?, ?)`
      )
      for (const passage of passages) {
        insert.run(passage.ref, passage.source, passage.scope, passage.title, passage.body)
      }
      this.db
        .prepare(
          `INSERT INTO doc_state (ref, mtime_ms, size) VALUES (?, ?, ?)
           ON CONFLICT(ref) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size`
        )
        .run(state.ref, state.mtimeMs, state.size)
    })
    write()
  }

  remove(ref: string): void {
    const drop = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM passages WHERE ref = ?`).run(ref)
      this.db.prepare(`DELETE FROM doc_state WHERE ref = ?`).run(ref)
    })
    drop()
  }

  search(terms: readonly string[], scope: string | null, limit: number): readonly FtsSearchRow[] {
    if (terms.length === 0) return []
    // Every term is quoted, so a query containing FTS5 syntax (`AND`, `*`, `"`)
    // is searched for rather than executed. Terms are OR-ed: a passage that
    // matches more of them ranks higher through bm25, which is the same shape
    // the grep rung scores by.
    const match = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ')
    const rows = this.db
      .prepare(
        `SELECT ref, source, scope, title, body, bm25(passages) AS rank
           FROM passages
          WHERE passages MATCH ?
          ORDER BY rank, ref, title
          LIMIT ?`
      )
      .all(match, limit * 4) as {
      ref: string
      source: string
      scope: string
      title: string
      body: string
      rank: number
    }[]

    const hits: FtsSearchRow[] = []
    for (const row of rows) {
      if (scope !== null && row.scope !== scope && row.source !== scope) continue
      const source = recallSourceSchema.safeParse(row.source)
      // A row whose source no longer validates is dropped, never guessed at —
      // the index is derived state and rebuilding it is the repair (SDD §10).
      if (!source.success) continue
      hits.push({
        ref: row.ref,
        source: source.data as RecallSource,
        scope: row.scope,
        title: row.title,
        body: row.body,
        // bm25 is negative and lower-is-better; recall's contract is a positive
        // score with higher-is-better, so the sign is flipped once, here.
        score: -row.rank
      })
      if (hits.length === limit) break
    }
    return hits
  }

  close(): void {
    this.db.close()
  }
}

/**
 * Opens the keyword index, or explains why it could not be opened.
 *
 * Contract: never throws. A machine whose SQLite was built without FTS5, or an
 * index directory that will not open, degrades the ladder one rung — visibly —
 * instead of costing the app its boot.
 */
export function openFtsStore(indexRoot: string): {
  readonly store: FtsStore | null
  readonly because: string
} {
  const dbPath = path.join(indexRoot, FTS_DB_FILE)
  try {
    const store = new SqliteFtsStore(dbPath)
    return { store, because: 'available' }
  } catch (err) {
    return {
      store: null,
      because: `keyword index unavailable at ${dbPath}: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

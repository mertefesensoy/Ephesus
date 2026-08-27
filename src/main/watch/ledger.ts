import {
  dayKey,
  evaluateBudget,
  foldFacts,
  ledgerRowSchema,
  totalOf,
  tokensOf,
  ZERO_TOTALS,
  type AgentSpend,
  type FoldCursor,
  type FoldableFact,
  type LedgerRow
} from '../../shared/cost'

/**
 * The durable cost ledger (ADR-0011, SDD §4.6, FR-11.2).
 *
 * ADR-0011's rule, restated because everything here serves it: **cumulative
 * figures are computed from the ledger, never from an in-memory counter** — an
 * app restart cannot zero them, because there is nothing in memory to zero.
 * This class holds no running totals; every figure it returns is a fold over
 * rows it just read back.
 *
 * Storage sits behind `LedgerStore` so the logic is testable without
 * better-sqlite3, which is Electron-ABI and cannot load under vitest (M0
 * constraint 3). The SQLite implementation lives in `db.ts`.
 */

/**
 * The persistence the ledger needs. Contract: `append` is APPEND-ONLY —
 * implementations never update or delete a row (invariant §5). The fold cursor
 * is the one mutable value, and it is metadata about reading, not a record of
 * spend.
 */
export interface LedgerStore {
  append(rows: readonly LedgerRow[]): void
  /** Every row for one agent, in insertion order. */
  rowsFor(agent: string): readonly LedgerRow[]
  cursor(source: string): FoldCursor
  saveCursor(cursor: FoldCursor): void
}

/** An in-memory store — the test double, and the fallback when SQLite is absent. */
export class MemoryLedgerStore implements LedgerStore {
  private readonly rows: LedgerRow[] = []
  private readonly cursors = new Map<string, number>()

  append(rows: readonly LedgerRow[]): void {
    for (const row of rows) this.rows.push(ledgerRowSchema.parse(row))
  }
  rowsFor(agent: string): readonly LedgerRow[] {
    return this.rows.filter((row) => row.agent === agent)
  }
  cursor(source: string): FoldCursor {
    return { source, folded: this.cursors.get(source) ?? 0 }
  }
  saveCursor(cursor: FoldCursor): void {
    this.cursors.set(cursor.source, cursor.folded)
  }
}

export interface CostLedgerOptions {
  readonly store: LedgerStore
  /** Injected so budget windows are testable without waiting for midnight. */
  now?(): Date
  /**
   * Raised when a transcript shrank and the cursor had to restart. Silent
   * re-folding would double-count, and silently skipping would under-report —
   * the caller makes the choice visible (invariant §7).
   */
  onFoldRestart?(source: string): void
}

export class CostLedger {
  private readonly now: () => Date
  /**
   * The session id each agent is currently spawned under, learned from the
   * event plane. Not a spend counter — an attribution key, so "session" and
   * "cumulative" can be told apart without a running total.
   */
  private readonly liveSession = new Map<string, string>()
  /** When each agent's spending window started today (for the burn-rate leg). */
  private readonly firstSpendAt = new Map<string, number>()

  constructor(private readonly options: CostLedgerOptions) {
    this.now = options.now ?? (() => new Date())
  }

  /** Records which session an agent's spend belongs to (from a hook payload). */
  noteSession(agent: string, sessionId: string): void {
    this.liveSession.set(agent, sessionId)
  }

  /** Forgets a spawn's session; the ledger rows it produced stay forever. */
  clearSession(agent: string): void {
    this.liveSession.delete(agent)
    this.firstSpendAt.delete(agent)
  }

  /**
   * Folds one transcript read into the ledger.
   *
   * Contract: idempotent per source file. Calling this repeatedly with the same
   * facts appends nothing after the first call, because the cursor counts facts
   * already folded — which is what makes it safe to re-read a growing
   * transcript on every tick.
   */
  fold(agent: string, source: string, facts: readonly FoldableFact[]): readonly LedgerRow[] {
    const cursor = this.options.store.cursor(source)
    const folded = foldFacts(facts, cursor, { agent, day: dayKey(this.now()) })
    if (folded.restarted) this.options.onFoldRestart?.(source)
    if (folded.rows.length > 0) {
      this.options.store.append(folded.rows)
      if (!this.firstSpendAt.has(agent)) this.firstSpendAt.set(agent, this.now().getTime())
    }
    this.options.store.saveCursor(folded.cursor)
    return folded.rows
  }

  /**
   * One agent's spend, session and cumulative side by side (ADR-0011). Both are
   * folds over stored rows; nothing here survives in memory between calls.
   */
  spendFor(agent: string, dailyTokens: number | null): AgentSpend {
    const rows = this.options.store.rowsFor(agent)
    const today = dayKey(this.now())
    const session = this.liveSession.get(agent) ?? null
    const todayRows = rows.filter((row) => row.day === today)
    const sessionTotals =
      session === null ? ZERO_TOTALS : totalOf(rows.filter((row) => row.session === session))

    const todayTotals = totalOf(todayRows)
    const startedAt = this.firstSpendAt.get(agent) ?? null
    const nowMs = this.now().getTime()
    const midnight = new Date(this.now())
    midnight.setHours(24, 0, 0, 0)

    return {
      agent,
      session,
      sessionTotals,
      todayTotals,
      cumulativeTotals: totalOf(rows),
      dailyTokens,
      budget: evaluateBudget({
        spent: tokensOf(todayTotals),
        dailyTokens,
        elapsedMinutes: startedAt === null ? 0 : (nowMs - startedAt) / 60_000,
        remainingMinutes: Math.max(0, (midnight.getTime() - nowMs) / 60_000)
      })
    }
  }
}

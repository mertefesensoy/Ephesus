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
  /** Keyed by (agent, source): two agents may share a transcript directory. */
  cursor(agent: string, source: string): FoldCursor
  saveCursor(cursor: FoldCursor): void
}

/**
 * An in-memory store — the TEST DOUBLE only. It is deliberately not offered as
 * a runtime fallback: cumulative spend in memory is precisely what invariant
 * §11 forbids, so a harness with no SQLite must fail visibly rather than
 * quietly keep totals that a restart erases.
 */
export class MemoryLedgerStore implements LedgerStore {
  private readonly rows: LedgerRow[] = []
  private readonly cursors = new Map<string, number>()

  private static key(agent: string, source: string): string {
    return `${agent}\u0000${source}`
  }

  append(rows: readonly LedgerRow[]): void {
    for (const row of rows) this.rows.push(ledgerRowSchema.parse(row))
  }
  rowsFor(agent: string): readonly LedgerRow[] {
    return this.rows.filter((row) => row.agent === agent)
  }
  cursor(agent: string, source: string): FoldCursor {
    return { agent, source, folded: this.cursors.get(MemoryLedgerStore.key(agent, source)) ?? 0 }
  }
  saveCursor(cursor: FoldCursor): void {
    this.cursors.set(MemoryLedgerStore.key(cursor.agent, cursor.source), cursor.folded)
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
  /**
   * The observation window for the burn-rate projection: when this process
   * first saw the agent spend, and how much it had ALREADY spent today at that
   * moment. Both halves are needed — dividing a whole day's durable spend by
   * this process's uptime is how a healthy agent gets projected into a breach.
   */
  private readonly window = new Map<string, { at: number; spentBefore: number }>()

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
    this.window.delete(agent)
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
    const cursor = this.options.store.cursor(agent, source)
    // Only a fact with no timestamp of its own falls back to today.
    const folded = foldFacts(facts, cursor, { fallbackDay: dayKey(this.now()) })
    if (folded.restarted) this.options.onFoldRestart?.(source)
    if (folded.rows.length > 0 && !this.window.has(agent)) {
      // The window opens BEFORE these rows land, so its baseline excludes them
      // and the rate is measured over spend this process actually observed.
      this.window.set(agent, {
        at: this.now().getTime(),
        spentBefore: tokensOf(totalOf(this.todayRows(agent)))
      })
    }
    if (folded.rows.length > 0) this.options.store.append(folded.rows)
    this.options.store.saveCursor(folded.cursor)
    return folded.rows
  }

  private todayRows(agent: string): readonly LedgerRow[] {
    const today = dayKey(this.now())
    return this.options.store.rowsFor(agent).filter((row) => row.day === today)
  }

  /**
   * One agent's spend, session and cumulative side by side (ADR-0011). Both are
   * folds over stored rows; nothing here survives in memory between calls.
   */
  spendFor(
    agent: string,
    dailyTokens: number | null,
    reporting: AgentSpend['reporting'] = 'engine'
  ): AgentSpend {
    const rows = this.options.store.rowsFor(agent)
    const today = dayKey(this.now())
    const session = this.liveSession.get(agent) ?? null
    const todayRows = rows.filter((row) => row.day === today)
    const sessionTotals =
      session === null ? ZERO_TOTALS : totalOf(rows.filter((row) => row.session === session))

    const todayTotals = totalOf(todayRows)
    const observed = this.window.get(agent) ?? null
    const nowMs = this.now().getTime()
    const midnight = new Date(this.now())
    midnight.setHours(24, 0, 0, 0)

    return {
      agent,
      reporting,
      session,
      sessionTotals,
      todayTotals,
      cumulativeTotals: totalOf(rows),
      dailyTokens,
      budget: evaluateBudget({
        spent: tokensOf(todayTotals),
        dailyTokens,
        spentAtWindowStart: observed?.spentBefore ?? 0,
        elapsedMinutes: observed === null ? 0 : (nowMs - observed.at) / 60_000,
        remainingMinutes: Math.max(0, (midnight.getTime() - nowMs) / 60_000)
      })
    }
  }
}

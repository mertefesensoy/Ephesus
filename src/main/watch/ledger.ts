import {
  dayKey,
  evaluateBudget,
  foldCosts,
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
import type { CostFact } from '../engines/types'

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
  /**
   * Raised when an engine's running cost total went DOWN — a replaced or
   * rotated transcript. Nothing is recorded for it; the caller makes it seen.
   */
  onCostRegressed?(source: string, session: string, model: string): void
  /** Raised when the engine said it could not price every model it used. */
  onCostIncomplete?(source: string): void
  /**
   * What the engine says an agent's CURRENT session has cost so far, live.
   *
   * Injected as a lookup rather than stored, and that is the whole point: the
   * ledger keeps no money in memory. This is read fresh on every `spendFor`
   * from a file the status line rewrites, exactly as the pace is — so a restart
   * loses nothing it cannot immediately re-observe, and ADR-0011's ban on
   * in-memory cumulative figures is untouched.
   */
  liveCost?(agent: string): { readonly session: string; readonly usd: number } | null
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

  /**
   * Folds the engine's own money figures into the ledger (ADR-0011's `cost_usd`
   * column, which stood null from M3 until this).
   *
   * Contract: idempotent, and idempotent *structurally* rather than by
   * bookkeeping. `foldCosts` differences the engine's running total against the
   * rows already stored, so folding the same transcript a hundred times appends
   * exactly one row — there is no cursor to keep in step and nothing a restart
   * could zero. That is the same property ADR-0011 demands of cumulative token
   * figures, applied to money.
   *
   * Never throws.
   */
  foldCosts(agent: string, source: string, costs: readonly CostFact[]): readonly LedgerRow[] {
    if (costs.length === 0) return []
    const existing = this.options.store.rowsFor(agent)
    const folded = foldCosts(costs, {
      existing,
      agent,
      source,
      fallbackDay: dayKey(this.now())
    })
    for (const back of folded.regressed) {
      // Spending cannot go down. A smaller running total means the transcript
      // was replaced or rotated, and the honest answer is to say so rather than
      // to invent a correction (invariant §7).
      this.options.onCostRegressed?.(source, back.sessionId, back.model)
    }
    // A model the engine could not price contributes no row at all, so the
    // total is an understatement. It has to be visible as one — a number the UI
    // shows as "the bill" while quietly missing a model is worse than no number.
    if (costs.some((cost) => !cost.priced)) this.options.onCostIncomplete?.(source)
    if (folded.rows.length > 0) this.options.store.append(folded.rows)
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
    const live = this.options.liveCost?.(agent) ?? null
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
      // Only when it names the SAME session the agent is running. A figure left
      // behind by the previous session would otherwise be shown against this
      // one, which is the same mis-attribution in miniature.
      liveSessionCostUsd: live !== null && live.session === session ? live.usd : null,
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

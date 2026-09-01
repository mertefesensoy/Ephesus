import { z } from 'zod'

/**
 * The durable cost ledger's pure half (ADR-0011, SDD §4.6, FR-11.2).
 *
 * This is the module that structurally excludes the bug ADR-0011 names by
 * name: upstream's session counter reset on restart and silently under-reported
 * spend. Here the *only* way to produce a cumulative figure is to fold rows,
 * and rows live in an append-only table. There is no counter to reset.
 *
 * Everything in this file is pure: the storage interface (`LedgerStore`) is
 * implemented over SQLite in main, and over a plain array in tests, because
 * better-sqlite3 is Electron-ABI and cannot load under vitest (M0 constraint 3).
 *
 * There is deliberately no `schemaVersion` here. Invariant §9 versions schema'd
 * *files*; the ledger is a SQLite table, governed by migration on open, and a
 * constant nothing persists would be the appearance of compliance with nothing
 * behind it.
 */

/**
 * One folded row of the ledger, keyed exactly as SDD §4.6 specifies:
 * `cost_ledger(agent, session, model, day, in_tokens, out_tokens, cost_usd,
 * source)`.
 */
export const ledgerRowSchema = z
  .object({
    agent: z.string().min(1).max(64),
    session: z.string().min(1).max(128),
    model: z.string().min(1).max(128),
    /** `YYYY-MM-DD` in local time — budgets are per calendar day. */
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    inTokens: z.number().int().nonnegative(),
    outTokens: z.number().int().nonnegative(),
    /** Engine-reported cost when the engine reports one; null otherwise. */
    costUsd: z.number().nonnegative().nullable(),
    /** Which transcript file the row was folded from (SDD §4.6 `source`). */
    source: z.string().min(1).max(1024)
  })
  .strict()

export type LedgerRow = z.infer<typeof ledgerRowSchema>

/** A day key from a timestamp, local time (budgets are per calendar day). */
export function dayKey(at: Date): string {
  const year = at.getFullYear()
  const month = `${at.getMonth() + 1}`.padStart(2, '0')
  const day = `${at.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * How far a transcript file has been folded (SDD §4.6's fold cursor).
 *
 * The cursor counts **facts already folded**, not bytes: an adapter's
 * `TranscriptReader.read()` returns the whole file's facts, so the ledger folds
 * `facts.slice(folded)` and nothing else. Re-reading a transcript therefore
 * cannot double-count — which is the property the ledger's honesty rests on,
 * since a transcript is re-read every time the file grows.
 */
export const foldCursorSchema = z
  .object({
    /**
     * Keyed by (agent, source), not by source alone. Two agents may share a
     * `cwd` — FR-1.5 makes worktree isolation optional — and a source-only key
     * would let whichever ticked first claim every fact while the other
     * silently recorded zero.
     */
    agent: z.string().min(1).max(64),
    source: z.string().min(1).max(1024),
    folded: z.number().int().nonnegative()
  })
  .strict()

export type FoldCursor = z.infer<typeof foldCursorSchema>

/** A usage fact as the adapter reports it (engines/types.ts `UsageFact`). */
export interface FoldableFact {
  readonly sessionId: string
  readonly model: string
  readonly inTokens: number
  readonly outTokens: number
  readonly costUsd: number | null
  /** When the engine recorded it; null when the transcript does not say. */
  readonly at: string | null
}

/**
 * Contract: turns the facts a transcript read produced into the rows that have
 * not been folded yet, plus the cursor to store.
 *
 * A transcript that SHRANK (rotated, replaced, or truncated by a crash) resets
 * the cursor to zero and re-folds: the alternative is silently skipping the new
 * file's first N facts forever, which is exactly the under-reporting this
 * ledger exists to prevent. `restarted` says so, so the caller can make it
 * visible rather than quietly re-counting.
 */
export function foldFacts(
  facts: readonly FoldableFact[],
  cursor: FoldCursor,
  /**
   * `fallbackDay` is used only for a fact whose transcript carried no
   * timestamp. Every fact that HAS one is billed to the day it was spent —
   * `day` is the budget window (SDD §4.6 with registry §4.1), so folding an
   * old transcript must not bill yesterday's tokens to today.
   */
  context: { readonly fallbackDay: string }
): {
  readonly rows: readonly LedgerRow[]
  readonly cursor: FoldCursor
  readonly restarted: boolean
} {
  const restarted = facts.length < cursor.folded
  const from = restarted ? 0 : cursor.folded
  const rows = facts.slice(from).map((fact) => ({
    agent: cursor.agent,
    session: fact.sessionId,
    model: fact.model,
    day: dayOfFact(fact, context.fallbackDay),
    inTokens: fact.inTokens,
    outTokens: fact.outTokens,
    costUsd: fact.costUsd,
    source: cursor.source
  }))
  return {
    rows,
    cursor: { agent: cursor.agent, source: cursor.source, folded: facts.length },
    restarted
  }
}

/**
 * Contract: the calendar day a fact was spent on, or `fallback` when the
 * transcript carried no usable timestamp. An unparseable timestamp falls back
 * rather than producing an `Invalid Date` day nothing could ever match.
 */
export function dayOfFact(fact: FoldableFact, fallback: string): string {
  if (fact.at === null) return fallback
  const at = new Date(fact.at)
  return Number.isNaN(at.getTime()) ? fallback : dayKey(at)
}

/**
 * One engine-reported **running total** of money, as `foldCosts` takes it.
 * Mirrors `engines/types.ts` `CostFact`; restated here so this file stays pure
 * and importable from the renderer side (NFR-12 — core learns no engine).
 */
export interface CumulativeCost {
  readonly sessionId: string
  readonly model: string
  readonly cumulativeUsd: number
}

/**
 * Contract: turns engine-reported **running totals** into the append-only rows
 * that bring the ledger up to date, by DIFFERENCING against the rows it already
 * holds. Pure.
 *
 * Why a difference and not the figure itself. Claude Code reports money as
 * `cost-state`: one cumulative `costUSD` per (session, model), rewritten as the
 * session goes on — measured across a real corpus of 20 transcripts, every file
 * that had one carried exactly ONE distinct value, written twice. Appending the
 * value would double the bill on the second line alone, and a resumed session
 * whose total later grows from $0.20 to $0.50 would record $0.70. Appending the
 * difference is correct in both cases and stays correct however many times a
 * transcript is re-read — which matters, because the Watch re-reads every file
 * every fifteen seconds.
 *
 * This deliberately derives the baseline from the LEDGER rather than from a
 * counter. It is the same argument ADR-0011 makes about cumulative token
 * figures: a counter is a thing a restart can zero, and the ledger is not. A
 * fold that has already happened is visible in the rows, so re-folding
 * subtracts to zero and appends nothing.
 *
 * A row produced here carries **no tokens**. The tokens for this session and
 * model are already in the ledger from `foldFacts`, and the engine's own
 * `modelUsage` repeats them; counting them again here is the double-count this
 * whole function exists to avoid. These rows are money only.
 */
export function foldCosts(
  costs: readonly CumulativeCost[],
  context: {
    /** Rows the ledger already holds for this agent. */
    readonly existing: readonly LedgerRow[]
    readonly agent: string
    readonly source: string
    /**
     * The day to bill money to when the ledger holds no dated row for this
     * (session, model).
     *
     * A `cost-state` line carries NO timestamp of its own — verified across the
     * corpus — so unlike a `UsageFact` it cannot name its own day. The best
     * available answer is the day that session's tokens for this model were
     * last spent, which the caller supplies via `existing`; this is the
     * fallback when even that is unavailable.
     */
    readonly fallbackDay: string
  }
): {
  readonly rows: readonly LedgerRow[]
  /** Figures that went backwards — a replaced or rotated transcript. */
  readonly regressed: readonly CumulativeCost[]
} {
  const rows: LedgerRow[] = []
  const regressed: CumulativeCost[] = []
  for (const cost of costs) {
    const mine = context.existing.filter(
      (row) => row.session === cost.sessionId && row.model === cost.model
    )
    const already = mine.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)
    const delta = cost.cumulativeUsd - already
    // Exactly zero is the overwhelmingly common case: the same transcript read
    // again. It is not news and it is not a row.
    if (delta === 0) continue
    if (delta < 0) {
      // The engine's running total went DOWN. That is not something spending
      // can do, so the transcript was replaced or rotated under us. Recording a
      // negative row is impossible (the schema forbids it) and recording a
      // positive one would invent money; the honest move is to record nothing
      // and let the caller say so out loud.
      regressed.push(cost)
      continue
    }
    // The day this session last spent tokens on this model. Money follows the
    // work it paid for, rather than the moment the harness happened to look.
    const day = mine.length > 0 ? (mine[mine.length - 1] as LedgerRow).day : context.fallbackDay
    rows.push({
      agent: context.agent,
      session: cost.sessionId,
      model: cost.model,
      day,
      inTokens: 0,
      outTokens: 0,
      costUsd: delta,
      source: context.source
    })
  }
  return { rows, regressed }
}

/** A folded total over some slice of the ledger. */
export interface CostTotals {
  readonly inTokens: number
  readonly outTokens: number
  /** Sum of engine-reported costs; null when NO row reported one. */
  readonly costUsd: number | null
  readonly rows: number
}

export const ZERO_TOTALS: CostTotals = { inTokens: 0, outTokens: 0, costUsd: null, rows: 0 }

/**
 * Contract: sums rows. `costUsd` stays null unless at least one row carried a
 * figure — a `0` where the engine reported nothing would read as "this was
 * free", and the UI must be able to tell "nothing spent" from "not reported".
 */
export function totalOf(rows: readonly LedgerRow[]): CostTotals {
  let inTokens = 0
  let outTokens = 0
  let costUsd: number | null = null
  for (const row of rows) {
    inTokens += row.inTokens
    outTokens += row.outTokens
    if (row.costUsd !== null) costUsd = (costUsd ?? 0) + row.costUsd
  }
  return { inTokens, outTokens, costUsd, rows: rows.length }
}

/** Tokens a budget counts. Both directions cost money, so both are counted. */
export function tokensOf(totals: CostTotals): number {
  return totals.inTokens + totals.outTokens
}

/**
 * One agent's spend, as the UI shows it: **session and cumulative side by
 * side** (ADR-0011). Both come from the ledger; neither is a live counter.
 */
export interface AgentSpend {
  readonly agent: string
  /**
   * Whether this agent's engine reports usage at all. `none` is a visible
   * product tier (ADR-0009 makes `transcripts` optional), and it has to be
   * distinguishable from an agent that genuinely spent nothing — otherwise a
   * zero is a silent fallback, which invariant §7 does not allow.
   */
  readonly reporting: 'engine' | 'none'
  /** This spawn's session, or null before the engine has reported one. */
  readonly session: string | null
  /** Spend attributed to the current session only. */
  readonly sessionTotals: CostTotals
  /** Spend attributed to today, across every session (the budget window). */
  readonly todayTotals: CostTotals
  /** Everything the ledger has ever recorded for this agent. */
  readonly cumulativeTotals: CostTotals
  /** The role's daily token budget (registry §4.1), or null when unbudgeted. */
  readonly dailyTokens: number | null
  /** Budget state today, deny-nothing when unbudgeted. */
  readonly budget: BudgetVerdict
  /**
   * What the engine says the CURRENT session has cost so far, live — observed
   * from the status line, not folded from a transcript.
   *
   * It exists because the durable figure cannot be live: the engine writes its
   * `cost-state` line when a session ENDS, so a running agent's
   * `sessionTotals.costUsd` is null until it stops. This fills exactly that
   * gap and nothing else.
   *
   * Deliberately NOT summed into `sessionTotals`, `todayTotals` or
   * `cumulativeTotals`. Those are folds over the append-only ledger, and this
   * is a reading of a file that the ledger's own rows will shortly restate —
   * adding it in would count the same money twice. `sessionCostOf` is how the
   * two are combined for display.
   */
  readonly liveSessionCostUsd: number | null
}

/** Which source a displayed session cost came from. */
export interface SessionCost {
  readonly usd: number | null
  readonly from: 'ledger' | 'live' | 'none'
}

/**
 * Contract: the session cost to SHOW, from the durable figure and the live one.
 * Pure.
 *
 * The two are the same quantity measured at different times — verified, not
 * assumed: across 17 real sessions the transcript's session scalar
 * (`totalCostUSD`) equalled the sum of its per-model breakdown exactly, and the
 * engine documents both `total_cost_usd` and `modelUsage` as *"cumulative …
 * read the latest result rather than summing across results."*
 *
 * So the rule is **the larger of the two, never the sum**. Taking the maximum
 * has three properties worth stating, because each is a bug it forecloses:
 *
 *  - it cannot double-count, which adding them would do the moment a session
 *    ends and both sources describe the same spend;
 *  - it cannot go backwards when the live reading disappears (the agent
 *    exited, the file went stale), because the ledger figure it falls back to
 *    is the final one;
 *  - it cannot under-report while a session runs, because the live figure is
 *    monotonic within a session and the ledger holds nothing yet.
 *
 * `from` is carried so the UI can say which it is showing. A live figure is
 * provisional and a ledger figure is final, and a number that cannot say which
 * it is invites being read as the wrong one.
 */
export function sessionCostOf(spend: {
  readonly sessionTotals: CostTotals
  readonly liveSessionCostUsd: number | null
}): SessionCost {
  const durable = spend.sessionTotals.costUsd
  const live = spend.liveSessionCostUsd
  if (durable === null && live === null) return { usd: null, from: 'none' }
  if (durable === null) return { usd: live, from: 'live' }
  if (live === null) return { usd: durable, from: 'ledger' }
  return live > durable ? { usd: live, from: 'live' } : { usd: durable, from: 'ledger' }
}

export const BUDGET_STATES = ['ok', 'projected-breach', 'breached', 'unbudgeted'] as const
export const budgetStateSchema = z.enum(BUDGET_STATES)
export type BudgetState = z.infer<typeof budgetStateSchema>

export interface BudgetVerdict {
  readonly state: BudgetState
  /** Tokens spent today. */
  readonly spent: number
  /** Tokens remaining today, or null when unbudgeted. */
  readonly remaining: number | null
  /**
   * Tokens the current burn rate projects for the rest of the window
   * (pre-flight projection, ADR-0011), or null when there is not enough
   * history to project honestly.
   */
  readonly projected: number | null
  /** Human-free explanation of which input decided the state. */
  readonly because: 'no-budget' | 'under' | 'projection' | 'over'
}

/**
 * Contract: post-hoc enforcement plus the pre-flight burn-rate projection
 * (ADR-0011 "enforced pre-flight where possible … and post-hoc always").
 *
 * The projection is deliberately conservative about *claiming* one: with less
 * than `minMinutes` of elapsed history, a burn rate computed from a handful of
 * seconds would project absurd numbers and trip the breaker on a healthy
 * agent's first tool call. Under that floor the answer is null — "we do not
 * know yet" — never a guess.
 */
export function evaluateBudget(input: {
  readonly spent: number
  readonly dailyTokens: number | null
  /**
   * Tokens already spent when the observation window opened. The rate is
   * computed over `spent - spentAtWindowStart`, because `spent` is durable
   * (all of today, across restarts) while `elapsedMinutes` can only measure
   * this process's uptime. Dividing all of today's spend by six minutes of
   * uptime projects a breach for a perfectly healthy agent — and the 5-minute
   * floor below does not help, because the origin, not the sample size, is
   * what is wrong.
   */
  readonly spentAtWindowStart?: number
  /** Minutes the agent has been spending in the current observation window. */
  readonly elapsedMinutes: number
  /** Minutes left in the budget window (rest of the day). */
  readonly remainingMinutes: number
  readonly minMinutes?: number
}): BudgetVerdict {
  const { spent, dailyTokens } = input
  if (dailyTokens === null) {
    return { state: 'unbudgeted', spent, remaining: null, projected: null, because: 'no-budget' }
  }
  const remaining = dailyTokens - spent
  if (remaining <= 0) {
    return { state: 'breached', spent, remaining, projected: null, because: 'over' }
  }
  const minMinutes = input.minMinutes ?? 5
  if (input.elapsedMinutes < minMinutes || input.remainingMinutes <= 0) {
    return { state: 'ok', spent, remaining, projected: null, because: 'under' }
  }
  const inWindow = Math.max(0, spent - (input.spentAtWindowStart ?? 0))
  const perMinute = inWindow / input.elapsedMinutes
  const projected = Math.round(perMinute * input.remainingMinutes)
  if (projected > remaining) {
    return { state: 'projected-breach', spent, remaining, projected, because: 'projection' }
  }
  return { state: 'ok', spent, remaining, projected, because: 'under' }
}

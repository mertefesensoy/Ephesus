import fs from 'node:fs'
import path from 'node:path'
import type { AgentSpend, BudgetVerdict } from '../../shared/cost'
import type { AgentSpawnConfig, EngineAdapter } from '../engines'
import type { CostLedger } from './ledger'

/**
 * Budget enforcement (ADR-0011, FR-11.2, SDD §9): the loop that turns an
 * engine's transcripts into ledger rows and a ledger row into a verdict.
 *
 * The split from `ledger.ts` is deliberate. The ledger knows arithmetic and
 * storage; this module knows *when to look* — which agents are live, where
 * their engine keeps transcripts, and who to tell when a budget breaks. Neither
 * holds a running total, because ADR-0011 forbids one.
 */

/** What the watcher needs to know about one live agent. */
export interface BudgetedAgent {
  readonly agentId: string
  readonly adapter: EngineAdapter
  readonly cfg: AgentSpawnConfig
  /** The role's daily token budget (registry §4.1), or null when unbudgeted. */
  readonly dailyTokens: number | null
  /**
   * Engine session ids this spawn has reported. Transcripts are keyed on the
   * agent's `cwd`, not on the agent — two agents sharing a repo see the same
   * directory, and so does the Architect's own `claude` history in it. Folding
   * the directory wholesale attributes their spend to whoever ticked first,
   * which is exactly the mis-attribution ADR-0011 rejected provider-side caps
   * for. Only files this spawn's sessions produced are folded.
   */
  readonly sessionIds: readonly string[]
}

export interface BudgetWatcherOptions {
  readonly ledger: CostLedger
  /** The agents to fold for, read fresh on every tick. */
  agents(): readonly BudgetedAgent[]
  /**
   * Raised when an agent's budget state changes for the worse — `log` kind
   * `budget` (SDD §4.3) and, from M3.5, the breaker's trip-signal #4 input.
   * Only transitions are reported: a breached agent must not emit a `budget`
   * event on every tick, or the book of record becomes a metronome.
   */
  onBudgetChange?(agentId: string, verdict: BudgetVerdict, spend: AgentSpend): void
  /** Raised when a transcript could not be read (invariant §7). */
  onDegraded?(detail: string): void
  /** Milliseconds between folds. */
  readonly intervalMs?: number
}

/** How often transcripts are re-folded. Spend is not a real-time quantity. */
export const DEFAULT_FOLD_INTERVAL_MS = 15_000

export class BudgetWatcher {
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  /** Last reported state per agent, so only transitions raise an event. */
  private readonly lastState = new Map<string, string>()

  constructor(private readonly options: BudgetWatcherOptions) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(
      // Guarded, never `void this.tick()`: an unhandled rejection here would
      // take the harness down over one unreadable transcript — the exact class
      // the M2 close-out audit closed across every other timer in this app.
      () => {
        this.tick().catch((err: unknown) => this.report(err))
      },
      this.options.intervalMs ?? DEFAULT_FOLD_INTERVAL_MS
    )
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private report(err: unknown): void {
    this.options.onDegraded?.(
      `budget fold failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  /**
   * Folds every live agent's transcripts and evaluates its budget. Contract:
   * never throws, and never runs two ticks at once — a slow fold must not
   * stack up behind itself.
   */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const agent of this.options.agents()) {
        try {
          await this.foldOne(agent)
        } catch (err) {
          this.options.onDegraded?.(
            `${agent.agentId}: transcript fold failed: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      }
    } finally {
      this.ticking = false
    }
  }

  /** Folds one agent now — used by the tick and by the final fold at exit. */
  async foldNow(agent: BudgetedAgent): Promise<void> {
    await this.foldOne(agent)
  }

  private async foldOne(agent: BudgetedAgent): Promise<void> {
    const reader = agent.adapter.transcripts
    // An engine with no transcript reader is a visible product tier, not a
    // failure (ADR-0009 makes it optional) — reported as `reporting: 'none'`
    // so a zero can never be mistaken for "spent nothing".
    if (reader) {
      const dir = reader.transcriptDir(agent.cfg)
      for (const file of await transcriptFiles(dir, agent.sessionIds)) {
        this.options.ledger.fold(agent.agentId, file, await reader.read(file))
        // Money, second and separately (ADR-0011's `cost_usd`). Tokens first is
        // not incidental: `foldCosts` bills a session's money to the day that
        // session last spent TOKENS on the model, so the rows it reads must
        // already be there. Folding money first would send every figure to the
        // fallback day — today — and a session that ran across midnight would
        // have its dollars and its tokens on different dates.
        //
        // An engine with no `costs` reader is a real product tier, not a fault:
        // its rows keep `costUsd` null, which the UI shows as "not reported"
        // and never as "free".
        if (reader.costs) {
          this.options.ledger.foldCosts(agent.agentId, file, await reader.costs(file))
        }
      }
    }
    const spend = this.options.ledger.spendFor(
      agent.agentId,
      agent.dailyTokens,
      reader ? 'engine' : 'none'
    )
    const previous = this.lastState.get(agent.agentId)
    if (previous !== spend.budget.state) {
      this.lastState.set(agent.agentId, spend.budget.state)
      // A first sighting of `ok` is not news; anything else is.
      if (previous !== undefined || spend.budget.state !== 'ok') {
        this.options.onBudgetChange?.(agent.agentId, spend.budget, spend)
      }
    }
  }

  /** Forgets an agent, so a respawn re-reports its state. */
  forget(agentId: string): void {
    this.lastState.delete(agentId)
  }
}

/**
 * Contract: the transcript files in `dir` that belong to `sessionIds`, or none
 * when the directory is absent or unreadable.
 *
 * Engines name a transcript after the session it records, so the session ids
 * the event plane already reported are the filter. **An empty `sessionIds`
 * yields nothing**: before an engine has told us which session it is running,
 * folding the directory would bill someone else's history to this agent. The
 * safe direction is to record nothing until we know whose it is.
 *
 * Async because this runs on the same event loop that carries PTY bytes and
 * hook events (SDD §11, NFR-1/NFR-2).
 */
export async function transcriptFiles(
  dir: string,
  sessionIds: readonly string[]
): Promise<readonly string[]> {
  if (sessionIds.length === 0) return []
  const wanted = new Set(sessionIds)
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    return entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith('.jsonl') &&
          wanted.has(entry.name.slice(0, -'.jsonl'.length))
      )
      .map((entry) => path.join(dir, entry.name))
      .sort()
  } catch {
    return []
  }
}

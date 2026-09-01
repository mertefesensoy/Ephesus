/**
 * The wall-clock cap on a single wake (ADR-0023).
 *
 * This is the *second, independent* limit, and it exists because a slow
 * expensive turn and a fast cheap one are not the same thing. Every other
 * governor in the Watch counts tokens: the ledger's ceiling, the burn-rate
 * signal, the pacer's window. All of them are blind to an agent that spends
 * twenty minutes and few tokens — a shell command that never returns, a
 * retry loop between two slow tools, a turn waiting on something that will
 * never arrive. Measured, Artemis's wakes ran a median 49 s and a maximum
 * 182 s; the skeleton crew's reached 485 s. A cap well above those is not a
 * throttle on ordinary work, it is a bound on the pathological tail.
 *
 * Deliberately *not* a breaker signal. The breaker's ladder escalates on
 * behaviour that keeps happening; a wake that overran is a single event with a
 * single correct answer — end the wake — and ADR-0011's own reasoning says time
 * is the weakest discriminator and must not by itself climb a ladder toward
 * `stop`. So this interrupts the turn and leaves the agent alive and hired.
 */

export interface WakeClockOptions {
  /**
   * Ends the overrunning wake: the engine's own cancel key (ADR-0009
   * `interrupt()`), never a process kill. The agent keeps its session, its
   * context and its next turn.
   */
  interrupt(agentId: string): void
  /** Raised when a wake is cut short, so it is never silent (invariant §7). */
  onOvertime?(agentId: string, ranMs: number, capMs: number): void
  /** The cap. */
  readonly capMs: number
  now?(): number
}

/**
 * The default cap: ten minutes.
 *
 * Chosen from the measurement rather than from taste — the slowest real wake
 * observed across every agent on 2026-09-01 was 485 s, so ten minutes leaves
 * ordinary work untouched by roughly a factor of two while still bounding a
 * wake that has genuinely stopped making progress.
 */
export const DEFAULT_WAKE_CAP_MS = 10 * 60 * 1000

interface OpenWake {
  readonly startedAt: number
  readonly timer: NodeJS.Timeout
}

export class WakeClock {
  private readonly open = new Map<string, OpenWake>()
  private readonly now: () => number

  constructor(private readonly options: WakeClockOptions) {
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * A wake began (`prompt-submitted`).
   *
   * Contract: idempotent per agent — a second `began` replaces the first rather
   * than stacking a second timer. Engines emit `prompt-submitted` once per
   * turn, but a queued command and an inbox nudge landing together must not
   * leave a timer nobody will ever clear.
   */
  began(agentId: string): void {
    this.ended(agentId)
    const startedAt = this.now()
    const timer = setTimeout(() => {
      this.open.delete(agentId)
      const ranMs = this.now() - startedAt
      this.options.onOvertime?.(agentId, ranMs, this.options.capMs)
      this.options.interrupt(agentId)
    }, this.options.capMs)
    timer.unref?.()
    this.open.set(agentId, { startedAt, timer })
  }

  /** The wake ended (`stop`, `session-end`, or the agent exiting). */
  ended(agentId: string): void {
    const open = this.open.get(agentId)
    if (!open) return
    clearTimeout(open.timer)
    this.open.delete(agentId)
  }

  /** How long this agent's current wake has been running, or null if idle. */
  runningMs(agentId: string): number | null {
    const open = this.open.get(agentId)
    return open ? this.now() - open.startedAt : null
  }

  /** Forgets everything; used when the harness shuts down. */
  stop(): void {
    for (const agentId of [...this.open.keys()]) this.ended(agentId)
  }
}

/**
 * The scheduler (SDD §1.1 `scheduler.ts`): "cron-like triggers (standups,
 * reflection, reviews, profile triggers)".
 *
 * M4.4 lands the minimum the Library needs, and no more: an interval table with
 * **idempotent ticks**. Standups, reviews and profile triggers join it as their
 * milestones land.
 *
 * Idempotent means two things, and both have bitten real schedulers:
 *
 *  - A trigger fires at most once per interval, however often `tick()` is
 *    called. A tick loop that runs faster than the interval — or a manual tick
 *    from a test — must not turn a daily job into a metronome.
 *  - A trigger already running is never re-entered. Reflection asks an agent to
 *    do work that takes a whole turn; a second request while the first is in
 *    flight would ask twice for one condensation.
 */

export interface Trigger {
  /** Stable id; also what the log and the degradation report name. */
  readonly id: string
  /** Minimum milliseconds between firings. */
  readonly everyMs: number
  /**
   * Contract: may reject. The scheduler reports it and keeps the trigger — a
   * job that failed once is not a job that should stop being scheduled.
   */
  run(now: Date): Promise<void> | void
}

export interface SchedulerOptions {
  /** How often the internal timer ticks. Triggers still fire on their own interval. */
  readonly tickMs?: number
  now?(): Date
  /** Raised when a trigger throws — visible, never swallowed (invariant §7). */
  onError?(triggerId: string, err: unknown): void
  /** Raised each time a trigger actually fires, for the book of record. */
  onFired?(triggerId: string, at: Date): void
}

/** 60 s: fine enough for a daily or hourly job, coarse enough to cost nothing. */
export const DEFAULT_TICK_MS = 60_000

interface Registered {
  readonly trigger: Trigger
  lastFiredMs: number | null
  running: boolean
}

export class Scheduler {
  private readonly triggers = new Map<string, Registered>()
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly now: () => Date

  constructor(private readonly options: SchedulerOptions = {}) {
    this.now = options.now ?? (() => new Date())
  }

  /** Registers a trigger. Re-adding the same id replaces it, keeping its clock. */
  add(trigger: Trigger): void {
    const existing = this.triggers.get(trigger.id)
    this.triggers.set(trigger.id, {
      trigger,
      lastFiredMs: existing?.lastFiredMs ?? null,
      running: existing?.running ?? false
    })
  }

  remove(triggerId: string): void {
    this.triggers.delete(triggerId)
  }

  ids(): readonly string[] {
    return [...this.triggers.keys()].sort()
  }

  /**
   * Fires every trigger whose interval has elapsed and which is not already
   * running.
   *
   * Contract: awaits the firings it starts, so a caller (a test, or shutdown)
   * can know the tick is finished. The interval clock is stamped *before* the
   * run, so a job that takes longer than its interval does not immediately
   * become due again the moment it finishes.
   */
  async tick(): Promise<void> {
    const at = this.now()
    const nowMs = at.getTime()
    const firings: Promise<void>[] = []

    for (const registered of this.triggers.values()) {
      if (registered.running) continue
      if (
        registered.lastFiredMs !== null &&
        nowMs - registered.lastFiredMs < registered.trigger.everyMs
      ) {
        continue
      }
      registered.lastFiredMs = nowMs
      registered.running = true
      this.options.onFired?.(registered.trigger.id, at)
      firings.push(
        Promise.resolve()
          .then(() => registered.trigger.run(at))
          .catch((err: unknown) => this.options.onError?.(registered.trigger.id, err))
          .finally(() => {
            registered.running = false
          })
      )
    }
    await Promise.all(firings)
  }

  /** Starts the tick loop. Idempotent. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      // Nobody awaits the timer's tick; `tick()` already routes every failure
      // to `onError`, and this catch is the backstop that keeps a scheduler
      // failure from becoming an unhandledRejection in main.
      void this.tick().catch((err: unknown) => this.options.onError?.('scheduler', err))
    }, this.options.tickMs ?? DEFAULT_TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }
}

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
  /**
   * Whether this trigger may fire right now. Absent means "always".
   *
   * This is how the company mode reaches the scheduler (ADR-0018, FR-14.4,
   * SDD §9): the Stoa and Gymnasium cadences answer `false` in `directed`, so
   * autonomous initiative is switched off at the ONE place that starts
   * autonomous work rather than at each job's own discretion.
   *
   * A disabled trigger is skipped WITHOUT stamping its clock, so enabling the
   * mode does not have to wait out an interval that elapsed while nothing was
   * allowed to run.
   */
  enabled?(): boolean
}

export interface SchedulerOptions {
  /** How often the internal timer ticks. Triggers still fire on their own interval. */
  readonly tickMs?: number
  now?(): Date
  /** Raised when a trigger throws — visible, never swallowed (invariant §7). */
  onError?(triggerId: string, err: unknown): void
  /** Raised each time a trigger actually fires, for the book of record. */
  onFired?(triggerId: string, at: Date): void
  /**
   * The last-fired clock changed; write it down so the next boot can seed it
   * (M8.8).
   *
   * This is the one piece of scheduler state a restart cannot re-derive.
   * Everything else about a trigger comes back with the activation that armed
   * it; when it last fired is known only here, and losing it means every
   * restored trigger is due immediately -- so a machine that reboots nightly
   * runs its daily jobs twice, and one that crash-loops runs them every time.
   *
   * Called on fire and on removal, not on every tick: a tick that fires nothing
   * changes nothing worth writing.
   */
  persist?(lastFired: Readonly<Record<string, number>>): void
}

/** 60 s: fine enough for a daily or hourly job, coarse enough to cost nothing. */
export const DEFAULT_TICK_MS = 60_000

interface Registered {
  readonly trigger: Trigger
  running: boolean
}

export class Scheduler {
  private readonly triggers = new Map<string, Registered>()
  /**
   * When each trigger id last fired — the ONLY copy of that fact (M8.8).
   *
   * Keyed by id rather than held on the registration, for two reasons.
   *
   * The restore then has no ordering constraint on the rest of boot: seeding
   * this before an activation arms anything and seeding it afterwards give the
   * same answer, because `tick` reads it here. An ordering requirement between
   * two boot steps is a rule that holds until someone moves a line, and nothing
   * would report the day it stopped holding.
   *
   * And there is one clock rather than two that must agree. This began as a
   * second copy beside `Registered.lastFiredMs`, which a mutation pass showed
   * was unfalsifiable: `tick` wrote both to the same value, so no test could
   * tell which one `add` preferred. Two fields that can never disagree are one
   * field with a latent bug, and the surviving mutant was the evidence.
   */
  private readonly lastFired = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly now: () => Date

  constructor(private readonly options: SchedulerOptions = {}) {
    this.now = options.now ?? (() => new Date())
  }

  /** Registers a trigger. Re-adding the same id replaces it, keeping its clock. */
  add(trigger: Trigger): void {
    const existing = this.triggers.get(trigger.id)
    this.triggers.set(trigger.id, { trigger, running: existing?.running ?? false })
  }

  remove(triggerId: string): void {
    this.triggers.delete(triggerId)
    // Disarming is deliberate -- a deactivation, or a profile going away -- and
    // its clock goes with it. Keeping it would grow the record with the ids of
    // triggers that no longer exist, and would hand a stale last-fired to a
    // profile the Architect later reactivates.
    if (this.lastFired.delete(triggerId)) this.persist()
  }

  /**
   * Contract: seeds the last-fired clock from a previous process (M8.8).
   * Registered triggers take the value immediately; unregistered ids are held
   * until something arms them.
   *
   * Never overrides a trigger that has already fired in this session.
   */
  restore(lastFired: Readonly<Record<string, number>>): number {
    let restored = 0
    for (const [id, at] of Object.entries(lastFired)) {
      if (this.lastFired.has(id)) continue
      this.lastFired.set(id, at)
      restored += 1
    }
    return restored
  }

  private persist(): void {
    this.options.persist?.(Object.fromEntries([...this.lastFired.entries()].sort()))
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
    // A tick that fires nothing changes nothing worth writing down.
    let fired = false

    for (const registered of this.triggers.values()) {
      if (registered.running) continue
      // Checked before the interval, and without stamping the clock: a
      // cadence that was forbidden for a week should fire when it is allowed
      // again, not sit out one more interval for having been asked while off.
      if (registered.trigger.enabled?.() === false) continue
      const lastFiredMs = this.lastFired.get(registered.trigger.id) ?? null
      if (lastFiredMs !== null && nowMs - lastFiredMs < registered.trigger.everyMs) {
        continue
      }
      this.lastFired.set(registered.trigger.id, nowMs)
      fired = true
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
    // Before the firings are awaited: the clock is stamped when the trigger
    // becomes due, and a crash during a long run must not lose the fact that it
    // started. Re-running a job is the cheaper failure; running it twice every
    // boot because the write waited for it to finish is not.
    if (fired) this.persist()
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

import {
  CREW_RESPAWN,
  DEFAULT_RESPAWN,
  exhaustedReason,
  ladderRecovered,
  nextLadderStep,
  type ExitPolicy,
  type RespawnPolicy
} from '../shared/respawn'

/**
 * One agent's backoff ladder: the machinery that turns "it died" into "wait,
 * then try again, and eventually stop trying and say so" (FR-5.4, SDD §10).
 *
 * This class is the extraction of Artemis's ladder, and the extraction is the
 * point of M8.6's third item. That ladder was correct and it had exactly one
 * user: the book of record for 2026-09-02 holds 46 `respawn-scheduled` rows,
 * **every one of them the orchestrator**, while three crew agents logged
 * terminal exits four, five and five times and were never brought back by
 * anything. Duplicating the ladder for the crew would have produced a second
 * copy of the parts that are actually hard — the pending-promise handoff, the
 * hold, the stability reset — so there is one ladder and two callers.
 *
 * What is NOT here, deliberately: any opinion about *whether* a particular
 * agent deserves to come back. Blocking (a breaker stop, a capacity park) is
 * asked of the caller through `blocked`, and what to do when the ladder ends
 * is the caller's `onExhausted`. The orchestrator clears its roster seat; a
 * crew agent leaves an offer on its card. Both are policy, and policy does not
 * belong in a timer.
 *
 * Contract of the whole class: never throws at a caller. A `respawn` that
 * rejects is charged to the ladder like any other failure and reported.
 */

/** What the ladder did, as the log records it. Machine-readable, no prose. */
export type LadderEvent =
  | {
      readonly event: 'scheduled'
      readonly attempt: number
      readonly waitMs: number
      readonly exitCode: number | null
    }
  | { readonly event: 'respawned'; readonly attempt: number }
  | { readonly event: 'held'; readonly attempt: number; readonly because: string }
  | {
      readonly event: 'deferred'
      readonly attempt: number
      readonly because: string
      readonly exitCode: number | null
    }
  | { readonly event: 'released'; readonly attempt: number; readonly exitCode: number | null }
  | { readonly event: 'blocked'; readonly because: string; readonly exitCode: number | null }

export interface RespawnLadderOptions {
  /**
   * Brings the agent back. Resolving does NOT mean it is alive — an engine can
   * start and exit immediately — so the caller reports the lifecycle it saw
   * and the ladder charges another rung when it is still down.
   */
  respawn(): Promise<{ readonly stillDown: boolean; readonly exitCode: number | null }>
  /**
   * A reason this agent must not be respawned right now, or null.
   *
   * Consulted at the moment of scheduling AND again after the wait, because a
   * two-minute backoff is long enough for the Architect to stop the agent, for
   * the breaker to stop it, or for the company to quit. Asking once would have
   * respawned an agent into a rung-3 stop it had already earned.
   */
  blocked?(): string | null
  /** Reported when the ladder is spent. The agent stays down. */
  onExhausted(reason: string): void
  /** Reported when an attempt itself throws; the ladder continues. */
  onAttemptFailed?(attempt: number, detail: string): void
  onEvent?(event: LadderEvent): void
  now?(): number
  /** Injected so tests do not sleep through a backoff ladder. */
  delay?(ms: number): Promise<void>
  readonly policy?: RespawnPolicy
}

export class RespawnLadder {
  private readonly now: () => number
  private readonly delay: (ms: number) => Promise<void>
  private readonly policy: RespawnPolicy
  /** Attempts since the agent was last seen healthy; reset by a stable run. */
  private attempts = 0
  /** When the agent was last seen running, for the stability window. */
  private runningSince: number | null = null
  /** The in-flight backoff-then-respawn chain, or null when nothing is queued. */
  private pending: Promise<void> | null = null
  private stopped = false
  /**
   * True while something outside the ladder owns this agent's return — the
   * provider capacity watch, today.
   *
   * The ladder counts CRASHES and it ends, deliberately, because an agent that
   * will not start is a fault a human has to see. A usage limit is not that
   * fault: restarting into it cannot succeed, so every rung it consumed would
   * be a rung unavailable for the real crash later. While this is set, an exit
   * costs no rung — it is remembered, and served by `release`.
   */
  private held = false
  private heldExit: { readonly exitCode: number | null } | null = null

  constructor(private readonly options: RespawnLadderOptions) {
    this.now = options.now ?? (() => Date.now())
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.policy = options.policy ?? DEFAULT_RESPAWN
  }

  /** The agent is up. Starts the stability window. */
  noteRunning(): void {
    this.runningSince ??= this.now()
  }

  /**
   * A fresh, deliberate start — not a rung of this ladder.
   *
   * Clears the attempt count and opens the stability window, because the
   * Architect (or boot) hiring an agent is not the same event as the ladder
   * catching a crash, and charging it a rung would shorten the ladder that
   * the next real crash gets.
   */
  noteStarted(): void {
    this.attempts = 0
    this.runningSince = this.now()
  }

  /**
   * Undoes `stop`, for an agent hired again after the ladder was torn down.
   *
   * Separate from the constructor because the caller keeps one ladder per
   * agent for the life of the process, and a `stop` at shutdown must not make
   * that ladder permanently inert if the company comes back up in the same
   * process (the macOS `activate` path, and every test that restarts one).
   */
  resume(): void {
    this.stopped = false
  }

  /**
   * The agent's process ended. Schedules the next rung, or ends the ladder.
   *
   * Recovery is coming back and *staying* back: an agent that was up longer
   * than the stability window earns a full ladder for this failure, and one
   * that died on the way up does not.
   */
  noteExited(exitCode: number | null): void {
    const upFor = this.runningSince === null ? 0 : this.now() - this.runningSince
    if (ladderRecovered(upFor, this.policy)) this.attempts = 0
    this.runningSince = null
    this.schedule(exitCode)
  }

  /** Attempts spent so far. For the card, and for tests. */
  spent(): number {
    return this.attempts
  }

  /** True while the ladder is held by something outside it. */
  isHeld(): boolean {
    return this.held
  }

  /**
   * Something outside the ladder has taken responsibility for this agent's
   * return. Idempotent — the capacity watch parks per agent and may say so
   * more than once.
   */
  hold(because: string): void {
    if (this.held) return
    this.held = true
    this.options.onEvent?.({ event: 'held', attempt: this.attempts, because })
  }

  /**
   * The hold is over. Serves an exit that arrived during it WITHOUT charging a
   * rung: the agent did not crash, it was refused.
   */
  release(): void {
    if (!this.held) return
    this.held = false
    const exit = this.heldExit
    this.heldExit = null
    if (exit === null || this.stopped || this.pending !== null) return
    this.options.onEvent?.({ event: 'released', attempt: this.attempts, exitCode: exit.exitCode })
    this.pending = this.waitThenRespawn(0)
  }

  /** Resolves once no attempt is queued. For shutdown, and for tests. */
  async drained(): Promise<void> {
    while (this.pending !== null) await this.pending
  }

  /** Cancels any queued attempt. Called at shutdown; safe to call twice. */
  stop(): void {
    this.stopped = true
    this.pending = null
  }

  private schedule(exitCode: number | null): void {
    if (this.stopped || this.pending !== null) return
    if (this.held) {
      // Remembered, not charged. `release` brings the agent back.
      this.heldExit = { exitCode }
      this.options.onEvent?.({
        event: 'deferred',
        attempt: this.attempts,
        because: 'held',
        exitCode
      })
      return
    }
    const veto = this.options.blocked?.() ?? null
    if (veto !== null) {
      // Not a rung and not a hold: a decision was taken about this agent, and
      // the ladder's job is to respect it rather than to wait it out.
      this.options.onEvent?.({ event: 'blocked', because: veto, exitCode })
      return
    }
    const step = nextLadderStep(this.attempts, this.policy)
    if (step.kind === 'exhausted') {
      this.options.onExhausted(exhaustedReason(step.attempts, exitCode))
      return
    }
    this.attempts = step.attempt
    this.options.onEvent?.({
      event: 'scheduled',
      attempt: step.attempt,
      waitMs: step.waitMs,
      exitCode
    })
    this.pending = this.waitThenRespawn(step.waitMs)
  }

  private async waitThenRespawn(waitMs: number): Promise<void> {
    await this.delay(waitMs)
    // Cleared BEFORE the attempt, not after: a failed attempt schedules the
    // next rung from inside `attempt`, and a `finally` here would drop that
    // one on the floor.
    this.pending = null
    if (this.stopped) return
    await this.attempt()
  }

  private async attempt(): Promise<void> {
    if (this.stopped) return
    // Asked again, after the wait. A two-minute backoff is long enough for the
    // breaker to stop this agent, and respawning into a stop it had already
    // earned is the cycle M8.6 exists to end.
    const veto = this.options.blocked?.() ?? null
    if (veto !== null) {
      this.options.onEvent?.({ event: 'blocked', because: veto, exitCode: null })
      return
    }
    try {
      const outcome = await this.options.respawn()
      this.options.onEvent?.({ event: 'respawned', attempt: this.attempts })
      if (outcome.stillDown) this.schedule(outcome.exitCode)
    } catch (err) {
      this.options.onAttemptFailed?.(
        this.attempts,
        err instanceof Error ? err.message : String(err)
      )
      this.schedule(null)
    }
  }
}

/**
 * The crew's survival: one ladder per hire that declared it wants one
 * (B12, SDD §10, `shared/respawn.ts`).
 *
 * The measurement this class exists to answer: over a full day of the company
 * running, the book of record holds 46 `respawn-scheduled` rows and every one
 * of them is Artemis. Three crew agents logged terminal exits four, five and
 * five times. Nothing brought any of them back, nothing offered to, and the
 * floor showed a company that was mostly not there.
 *
 * Two rules shape it, and both are about NOT respawning:
 *
 *  - **A declared policy, never an inference.** Only a hire whose template (or
 *    profile) says `onExit: "respawn"` gets a ladder. `offer` is the default
 *    and it is SDD §10's own word; the card carries the offer and a human
 *    decides.
 *  - **A stopped agent stays stopped.** `blocked` is asked before every
 *    scheduling and again after every wait, and the breaker's standing rung-3
 *    stop is what it usually answers with. Respawning into a stop the agent
 *    had already earned is precisely the cycle B11 measured.
 */
export interface CrewSurvivalOptions {
  /**
   * Brings one agent back. `stillDown` is read from the card the respawn
   * produced: an engine can start and exit immediately, and treating that as
   * success is how a crash loop looks healthy.
   */
  respawn(
    agentId: string
  ): Promise<{ readonly stillDown: boolean; readonly exitCode: number | null }>
  /** Why this agent must not come back right now, or null. */
  blocked?(agentId: string): string | null
  onEvent?(agentId: string, event: LadderEvent): void
  /** The ladder is spent; the agent stays down and the Architect is told. */
  onExhausted(agentId: string, reason: string): void
  onAttemptFailed?(agentId: string, attempt: number, detail: string): void
  now?(): number
  delay?(ms: number): Promise<void>
  readonly policy?: RespawnPolicy
}

export class CrewSurvival {
  private readonly ladders = new Map<string, RespawnLadder>()
  /** agentId → what its hire declared. Absent means nobody declared anything. */
  private readonly declared = new Map<string, ExitPolicy>()
  private stopped = false

  constructor(private readonly options: CrewSurvivalOptions) {}

  /**
   * Records what a hire declared. Called once per agent when a profile
   * instance is actually live — never during the roll-back of a half-failed
   * activation, where a declared ladder would race the kill that is undoing it.
   */
  declare(agentId: string, policy: ExitPolicy): void {
    this.declared.set(agentId, policy)
  }

  /** The agent is gone for good (deactivation). Cancels any queued attempt. */
  release(agentId: string): void {
    this.ladders.get(agentId)?.stop()
    this.ladders.delete(agentId)
    this.declared.delete(agentId)
  }

  /** What this agent's hire declared, or null when nothing did. */
  policyOf(agentId: string): ExitPolicy | null {
    return this.declared.get(agentId) ?? null
  }

  /**
   * Driven off the same card stream the UI reads, so nothing else has to agree
   * about who is running (the shape FR-5.4 already uses for the orchestrator).
   */
  noteCard(card: {
    readonly agentId: string
    readonly lifecycle: string
    readonly exitCode: number | null
  }): void {
    if (this.declared.get(card.agentId) !== 'respawn') return
    if (card.lifecycle === 'running') {
      this.ladderFor(card.agentId).noteRunning()
      return
    }
    if (card.lifecycle !== 'exited') return
    this.ladderFor(card.agentId).noteExited(card.exitCode)
  }

  /** The provider refused this agent; its return belongs to the capacity watch. */
  hold(agentId: string, because: string): void {
    if (this.declared.get(agentId) !== 'respawn') return
    this.ladderFor(agentId).hold(because)
  }

  /** Capacity is back for this agent. */
  releaseHold(agentId: string): void {
    this.ladders.get(agentId)?.release()
  }

  /** Cancels every queued attempt. Called at shutdown; safe to call twice. */
  stop(): void {
    this.stopped = true
    for (const ladder of this.ladders.values()) ladder.stop()
  }

  /** Resolves once no attempt is queued anywhere. For shutdown, and for tests. */
  async drained(): Promise<void> {
    for (const ladder of this.ladders.values()) await ladder.drained()
  }

  private ladderFor(agentId: string): RespawnLadder {
    const existing = this.ladders.get(agentId)
    if (existing) return existing
    const ladder = new RespawnLadder({
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.delay ? { delay: this.options.delay } : {}),
      policy: this.options.policy ?? CREW_RESPAWN,
      respawn: () => this.options.respawn(agentId),
      ...(this.options.blocked ? { blocked: () => this.options.blocked?.(agentId) ?? null } : {}),
      onExhausted: (reason) => this.options.onExhausted(agentId, reason),
      ...(this.options.onAttemptFailed
        ? {
            onAttemptFailed: (attempt: number, detail: string) =>
              this.options.onAttemptFailed?.(agentId, attempt, detail)
          }
        : {}),
      ...(this.options.onEvent
        ? { onEvent: (event: LadderEvent) => this.options.onEvent?.(agentId, event) }
        : {})
    })
    if (this.stopped) ladder.stop()
    this.ladders.set(agentId, ladder)
    return ladder
  }
}

/**
 * Contract: why a standing breaker stop refuses a respawn, or null. Pure.
 *
 * One function because there are THREE callers — the crew's ladder, Artemis's
 * ladder, and `AgentManager.respawn`, which is the one both a human accepting
 * an offer and the ladders themselves pass through. Three copies of this
 * sentence would eventually be three different sentences, and the Architect
 * would be reading a different explanation depending on which path refused.
 */
export function respawnBlockReason(
  stop: { readonly signals: readonly string[] } | null
): string | null {
  if (stop === null) return null
  return `the breaker stopped it at rung 3 (${stop.signals.join(', ')}); clear the stop first`
}

/** What `createCrewSurvival` needs from the rest of the process. */
export interface CrewSurvivalWiring {
  /** Brings one agent back; resolves with the card the respawn produced. */
  respawn(
    agentId: string
  ): Promise<{ readonly lifecycle: string; readonly exitCode: number | null }>
  /** The standing rung-3 stop against this agent, or null. */
  breakerStop(agentId: string): { readonly signals: readonly string[] } | null
  log(draft: { readonly kind: 'respawn' } & Record<string, unknown>): void
  degrade(cause: `respawn/${string}`, detail: string): void
  now?(): number
  delay?(ms: number): Promise<void>
  readonly policy?: RespawnPolicy
}

/**
 * Builds the crew's survival with its log and degradation wiring attached.
 *
 * A factory rather than twenty-odd lines in `index.ts`, for the reason M8.1
 * gave when it moved `shutdown.ts` and `ui-bridge.ts` out of the same file:
 * boot wiring is the least-covered row in this repository, and logic that
 * lives there is logic nothing can test. Everything here is a decision — how
 * an exhausted ladder is worded, which log kind the rungs take, what "still
 * down" means — and decisions belong where a test can reach them.
 */
export function createCrewSurvival(wiring: CrewSurvivalWiring): CrewSurvival {
  return new CrewSurvival({
    ...(wiring.now ? { now: wiring.now } : {}),
    ...(wiring.delay ? { delay: wiring.delay } : {}),
    ...(wiring.policy ? { policy: wiring.policy } : {}),
    respawn: async (agentId) => {
      const card = await wiring.respawn(agentId)
      // Resolving is not surviving: an engine can start and exit immediately,
      // and treating that as success is how a crash loop looks healthy.
      return { stillDown: card.lifecycle === 'exited', exitCode: card.exitCode }
    },
    blocked: (agentId) => respawnBlockReason(wiring.breakerStop(agentId)),
    onEvent: (agentId, event) => wiring.log({ kind: 'respawn', agentId, ...event }),
    // The ladder is spent: the agent stays down, and the Architect finds out
    // from the app rather than from an empty floor in the morning.
    onExhausted: (agentId, detail) =>
      wiring.degrade(`respawn/exhausted:${agentId}`, `${agentId} ${detail}`),
    onAttemptFailed: (agentId, attempt, detail) =>
      wiring.degrade(
        `respawn/attempt:${agentId}`,
        `respawn attempt ${String(attempt)} for ${agentId} failed: ${detail}`
      )
  })
}

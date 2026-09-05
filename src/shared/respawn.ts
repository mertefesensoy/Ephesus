import { z } from 'zod'

/**
 * Coming back from the dead: the backoff ladder, and what a hire declares
 * should happen when its process ends (SDD §10, FR-5.4, ADR-0011).
 *
 * The ladder was written for Artemis (FR-5.4, "the orchestrator is brought back
 * when it dies") and lived inside `artemis.ts`. It is here because the measured
 * failure of the 2026-09-02 register was that it had exactly one user: 46
 * `respawn-scheduled` rows in the book of record, **all of them Artemis, none
 * of them crew**, while three crew agents logged terminal exits four, five and
 * five times and simply stayed dead. A company you can leave running cannot
 * have a survival mechanism that covers one agent.
 *
 * Everything in this module is pure. The timers, the promises and the
 * decision to actually respawn something live in `src/main/respawn.ts`; what
 * is here is the arithmetic, so every rung of every ladder is table-testable
 * without sleeping through a backoff.
 */

/**
 * What the harness does when a hire's process ends.
 *
 * `offer` is SDD §10's own word and the default: the agent card carries a
 * `RespawnOffer` and a human decides. `respawn` is the opt-in that makes an
 * overnight run survivable — the harness climbs the ladder below by itself.
 *
 * There is deliberately no third value for "never come back". That is `offer`
 * with the offer declined; a policy that removed the human's ability to bring
 * an agent back would be taking a decision away rather than automating one.
 */
export const EXIT_POLICIES = ['offer', 'respawn'] as const
export const exitPolicySchema = z.enum(EXIT_POLICIES)
export type ExitPolicy = (typeof EXIT_POLICIES)[number]

/** What a hire gets when neither it nor its profile declares one. */
export const DEFAULT_EXIT_POLICY: ExitPolicy = 'offer'

/**
 * How hard the harness tries to bring an agent back.
 *
 * A crashed agent that respawns instantly forever is a fork bomb with a laurel
 * wreath, so each attempt waits longer than the last and the ladder ends.
 * Ending is not silent: an agent the harness has given up on is exactly the
 * state the Architect must be told about (invariant §7).
 */
export interface RespawnPolicy {
  readonly backoffMs: readonly number[]
  /**
   * How long the agent must stay up before the ladder resets.
   *
   * Without this the ladder can never be spent by the failure it exists to
   * bound: a process that starts and immediately dies would reset the counter
   * on every start, and the harness would respawn it forever. Coming back and
   * *staying* back is what counts as recovery.
   */
  readonly stabilityMs: number
}

export const DEFAULT_RESPAWN: RespawnPolicy = {
  backoffMs: [1_000, 2_000, 5_000, 15_000, 30_000],
  stabilityMs: 60_000
}

/**
 * The crew's ladder, which is shorter and slower than the orchestrator's.
 *
 * A company with no orchestrator cannot route anything, so Artemis is worth
 * five quick attempts. One crew agent being down is a degraded company rather
 * than a stopped one, and the far more likely cause of a crew agent dying five
 * times in ninety seconds is a broken brief or a missing binary — neither of
 * which a sixth attempt fixes, and both of which burn the Architect's tokens
 * on the way. Three rungs, ending in a minute of quiet, then a human.
 */
export const CREW_RESPAWN: RespawnPolicy = {
  backoffMs: [5_000, 30_000, 120_000],
  stabilityMs: 300_000
}

/** What the ladder says to do next. */
export type LadderStep =
  | {
      readonly kind: 'wait'
      /** How long to wait before this attempt. */
      readonly waitMs: number
      /** Which attempt this will be, 1-based — the number the log records. */
      readonly attempt: number
    }
  | {
      readonly kind: 'exhausted'
      /** How many attempts were spent before giving up. */
      readonly attempts: number
    }

/**
 * Contract: the next rung, given how many attempts have already been spent.
 * Pure and total — every `attempts ≥ 0` produces an answer.
 *
 * `attempts` is a count of attempts ALREADY MADE, so the first call with 0
 * returns the first backoff and `attempt: 1`.
 */
export function nextLadderStep(attempts: number, policy: RespawnPolicy): LadderStep {
  const waitMs = policy.backoffMs[attempts]
  if (waitMs === undefined) return { kind: 'exhausted', attempts }
  return { kind: 'wait', waitMs, attempt: attempts + 1 }
}

/**
 * Contract: whether an agent that stayed up for `upForMs` has recovered, and
 * so earns a full ladder for its next failure.
 *
 * Separate from `nextLadderStep` because recovery is a claim about the past and
 * the ladder is a decision about the future, and conflating them is how a
 * crash-loop resets its own counter.
 */
export function ladderRecovered(upForMs: number, policy: RespawnPolicy): boolean {
  return upForMs >= policy.stabilityMs
}

/**
 * Contract: the sentence an Architect reads when the ladder is spent. The
 * exit code is included only when there is one — "(last exit code null)" is
 * noise, and a process killed by a signal genuinely has none.
 */
export function exhaustedReason(attempts: number, exitCode: number | null): string {
  return (
    `crashed ${String(attempts)} times and will not be restarted again` +
    (exitCode === null ? '' : ` (last exit code ${String(exitCode)})`)
  )
}

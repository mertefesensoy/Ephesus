import { describe, expect, it } from 'vitest'
import {
  CREW_RESPAWN,
  DEFAULT_EXIT_POLICY,
  DEFAULT_RESPAWN,
  EXIT_POLICIES,
  exhaustedReason,
  exitPolicySchema,
  ladderRecovered,
  nextLadderStep
} from '../../src/shared/respawn'

/**
 * The ladder's arithmetic (M8.6, B12) — the half that used to live inside
 * `artemis.ts` and had exactly one caller.
 *
 * Pure, so every rung of every ladder is asserted without sleeping through a
 * backoff. The machine that spends real time on these numbers is
 * `main/respawn.ts`, tested separately with an injected clock.
 */

describe('the rungs', () => {
  it('hands back each backoff in order, one-based for the log', () => {
    const policy = { backoffMs: [1, 2, 3], stabilityMs: 100 }
    expect(nextLadderStep(0, policy)).toEqual({ kind: 'wait', waitMs: 1, attempt: 1 })
    expect(nextLadderStep(1, policy)).toEqual({ kind: 'wait', waitMs: 2, attempt: 2 })
    expect(nextLadderStep(2, policy)).toEqual({ kind: 'wait', waitMs: 3, attempt: 3 })
  })

  it('ends rather than repeating the last rung forever', () => {
    // The whole reason the ladder is a list and not a constant: an agent that
    // will not start is a fault a human has to see, and a harness that retries
    // it every 30 s until morning is one that hid the fault behind a cost.
    const policy = { backoffMs: [1, 2], stabilityMs: 100 }
    expect(nextLadderStep(2, policy)).toEqual({ kind: 'exhausted', attempts: 2 })
    expect(nextLadderStep(99, policy)).toEqual({ kind: 'exhausted', attempts: 99 })
  })

  it('is exhausted from the first call when the ladder is empty', () => {
    expect(nextLadderStep(0, { backoffMs: [], stabilityMs: 1 })).toEqual({
      kind: 'exhausted',
      attempts: 0
    })
  })

  it('climbs strictly, so a later rung is never quicker than an earlier one', () => {
    for (const policy of [DEFAULT_RESPAWN, CREW_RESPAWN]) {
      const waits = policy.backoffMs
      for (let i = 1; i < waits.length; i += 1) {
        expect(waits[i]).toBeGreaterThan(waits[i - 1] as number)
      }
    }
  })
})

describe('recovery', () => {
  it('needs the agent to stay up, not merely to come up', () => {
    // Without this the ladder can never be spent: a process that starts and
    // dies immediately would reset the counter on every start.
    expect(ladderRecovered(59_999, { backoffMs: [], stabilityMs: 60_000 })).toBe(false)
    expect(ladderRecovered(60_000, { backoffMs: [], stabilityMs: 60_000 })).toBe(true)
  })

  it('gives the crew a longer stability window than the orchestrator', () => {
    // A crew agent dying five times in ninety seconds is a broken brief, not
    // bad luck, and a sixth attempt does not fix a brief.
    expect(CREW_RESPAWN.stabilityMs).toBeGreaterThan(DEFAULT_RESPAWN.stabilityMs)
    expect(CREW_RESPAWN.backoffMs.length).toBeLessThan(DEFAULT_RESPAWN.backoffMs.length)
  })
})

describe('what the Architect reads when it is over', () => {
  it('names the count and the exit code', () => {
    expect(exhaustedReason(3, 1)).toBe(
      'crashed 3 times and will not be restarted again (last exit code 1)'
    )
  })

  it('omits an exit code that does not exist', () => {
    // A process killed by a signal genuinely has none, and "(last exit code
    // null)" is noise dressed as detail.
    expect(exhaustedReason(3, null)).toBe('crashed 3 times and will not be restarted again')
  })

  it('reports a zero exit code, which is not the same as none', () => {
    expect(exhaustedReason(1, 0)).toContain('(last exit code 0)')
  })
})

describe('the declared policy', () => {
  it('defaults to the offer SDD §10 specifies', () => {
    // An omitted field keeps the documented behaviour exactly: the card
    // carries the offer and a human decides.
    expect(DEFAULT_EXIT_POLICY).toBe('offer')
  })

  it('accepts only the two declared values', () => {
    expect([...EXIT_POLICIES]).toEqual(['offer', 'respawn'])
    expect(exitPolicySchema.safeParse('respawn').success).toBe(true)
    expect(exitPolicySchema.safeParse('never').success).toBe(false)
    expect(exitPolicySchema.safeParse('').success).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import {
  CAPACITY_BACKOFF_MS,
  CAPACITY_RESET_MARGIN_MS,
  capacitySentence,
  capacityView,
  retryDelayMs,
  type CapacityLimit,
  type ParkedAgent
} from '../../src/shared/capacity'

/**
 * The capacity decision (`src/shared/capacity.ts`) — pure, so the rule can be
 * asserted without a clock, a process, or a transcript.
 */

const NOW = Date.parse('2026-08-30T22:00:00.000Z')

function limit(over: Partial<CapacityLimit> = {}): CapacityLimit {
  return {
    kind: 'rate-limit',
    recordId: 'u1',
    sessionId: 'sess-a',
    at: '2026-08-30T22:00:00.000Z',
    detail: "You're out of usage credits.",
    resetsAt: null,
    ...over
  }
}

function parked(over: Partial<ParkedAgent> = {}): ParkedAgent {
  return {
    agentId: 'agent.mason',
    phase: 'parked',
    limit: limit(),
    since: '2026-08-30T22:00:00.000Z',
    attempts: 0,
    retryAt: '2026-08-30T22:01:00.000Z',
    processAlive: true,
    ...over
  }
}

describe('retryDelayMs', () => {
  it('climbs the ladder as continuations keep being refused', () => {
    const climbed = CAPACITY_BACKOFF_MS.map((_rung, i) => retryDelayMs(i, null, NOW))
    expect(climbed).toEqual([...CAPACITY_BACKOFF_MS])
    // Strictly increasing, or it is not a backoff.
    for (let i = 1; i < climbed.length; i += 1) {
      expect(climbed[i]).toBeGreaterThan(climbed[i - 1] as number)
    }
  })

  it('never ends, holding at the top rung forever', () => {
    // THE rule of this module. A crash ladder ends because a process that will
    // not start is a fault a human must see; a capacity ladder that ended would
    // abandon a healthy agent over a condition guaranteed to clear — which is
    // exactly "losing the agent". Ten attempts, a hundred, still an hour.
    const top = CAPACITY_BACKOFF_MS[CAPACITY_BACKOFF_MS.length - 1]
    expect(retryDelayMs(CAPACITY_BACKOFF_MS.length, null, NOW)).toBe(top)
    expect(retryDelayMs(10, null, NOW)).toBe(top)
    expect(retryDelayMs(100_000, null, NOW)).toBe(top)
  })

  it('prefers the provider reset time over the ladder, with a settle margin', () => {
    const resetsAt = new Date(NOW + 40 * 60_000).toISOString()
    // Asking at the exact instant the window rolls is asking a fraction early
    // once two clocks disagree, and one refusal restarts the whole ladder.
    expect(retryDelayMs(0, resetsAt, NOW)).toBe(40 * 60_000 + CAPACITY_RESET_MARGIN_MS)
  })

  it.each([
    ['already past', new Date(NOW - 60_000).toISOString()],
    ['unparseable', 'whenever'],
    ['empty', '']
  ])('falls back to the ladder when the reset time is %s', (_label, resetsAt) => {
    expect(retryDelayMs(0, resetsAt, NOW)).toBe(CAPACITY_BACKOFF_MS[0])
  })

  it('clamps a nonsense attempt count instead of returning undefined', () => {
    expect(retryDelayMs(-1, null, NOW)).toBe(CAPACITY_BACKOFF_MS[0])
    expect(retryDelayMs(1.7, null, NOW)).toBe(CAPACITY_BACKOFF_MS[1])
  })
})

describe('capacityView', () => {
  it('reports the oldest park and the soonest retry', () => {
    const view = capacityView([
      parked({ agentId: 'b', since: '2026-08-30T22:05:00.000Z', retryAt: '2026-08-30T22:06:00Z' }),
      parked({ agentId: 'a', since: '2026-08-30T22:00:00.000Z', retryAt: '2026-08-30T22:30:00Z' })
    ])
    // How long this has been going on, and when something will next happen —
    // the two things a one-line strip has room for.
    expect(view.parked.map((row) => row.agentId)).toEqual(['a', 'b'])
    expect(view.since).toBe('2026-08-30T22:00:00.000Z')
    expect(view.retryAt).toBe('2026-08-30T22:06:00Z')
  })

  it('is empty and honest when nobody is parked', () => {
    const view = capacityView([])
    expect(view.parked).toHaveLength(0)
    expect(view.since).toBeNull()
    expect(view.retryAt).toBeNull()
  })
})

describe('capacitySentence', () => {
  it('says nothing at all when the company is clear', () => {
    expect(capacitySentence(capacityView([]), NOW)).toBeNull()
  })

  it('names the count and what happens next', () => {
    const view = capacityView([parked({ retryAt: new Date(NOW + 5 * 60_000).toISOString() })])
    // §9 copy voice: a count with no verb tells the Architect nothing they can
    // act on, and "waiting" without "retry" reads like a dead end.
    expect(capacitySentence(view, NOW)).toBe(
      '1 agent waiting for provider capacity · retry in 5 min'
    )
  })

  it('pluralises, because "1 agents" is how a reader stops trusting a strip', () => {
    const view = capacityView([
      parked({ agentId: 'a', retryAt: new Date(NOW + 60_000).toISOString() }),
      parked({ agentId: 'b', retryAt: new Date(NOW + 120_000).toISOString() })
    ])
    expect(capacitySentence(view, NOW)).toBe(
      '2 agents waiting for provider capacity · retry in 1 min'
    )
  })

  it('says "any moment" rather than a retry time that has already passed', () => {
    const view = capacityView([parked({ retryAt: new Date(NOW - 60_000).toISOString() })])
    expect(capacitySentence(view, NOW)).toContain('any moment')
    expect(capacitySentence(view, NOW)).not.toContain('-1')
  })

  it('still reports the park when the retry time is unreadable', () => {
    // Degrading to a shorter sentence is fine; degrading to silence is not —
    // the company is still stopped.
    const view = capacityView([parked({ retryAt: 'nonsense' })])
    expect(capacitySentence(view, NOW)).toBe('1 agent waiting for provider capacity')
  })
})

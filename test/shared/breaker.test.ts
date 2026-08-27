import { describe, expect, it } from 'vitest'
import {
  actionsFor,
  DEFAULT_THRESHOLDS,
  evaluateSignals,
  nextRung,
  protectionFor,
  RUNG_NAMES,
  spanSchema,
  TRIP_SIGNALS,
  type Rung,
  type SignalInput,
  type Span
} from '../../src/shared/breaker'

/**
 * The breaker's signals and ladder (ADR-0011) as pure functions, on scripted
 * fixtures. Two properties carry the ADR's whole argument and are asserted
 * exhaustively rather than by example: the ladder never skips a rung, and rung
 * 1 is the only thing a first trip can do.
 */

const T0 = 1_700_000_000_000

function span(over: Partial<Span> = {}): Span {
  return spanSchema.parse({
    agentId: 'agent.mason',
    tool: 'Read',
    durationMs: 12,
    outcome: 'ok',
    startedAt: T0,
    fingerprint: 'abc123',
    ...over
  })
}

function input(over: Partial<SignalInput> = {}): SignalInput {
  return { spans: [], now: T0, hopCapEscalations: {}, budgetState: 'ok', ...over }
}

describe('the ladder never skips a rung (ADR-0011)', () => {
  it.each([
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 3]
  ] as const)('climbs %i → %i while something is firing', (from, to) => {
    expect(nextRung(from as Rung, true)).toBe(to)
  })

  it.each([1, 2] as const)('will not climb from %i inside the dwell', (from) => {
    // The steer is queued until the agent is idle (FR-1.3); climbing on the
    // very next tool call means it was never given a chance to act on it.
    expect(nextRung(from as Rung, true, { sinceMs: 1_000, requiredMs: 60_000 })).toBe(from)
    expect(nextRung(from as Rung, true, { sinceMs: 60_001, requiredMs: 60_000 })).toBe(from + 1)
  })

  it('always takes the FIRST step immediately — a dwell must not delay rung 1', () => {
    expect(nextRung(0, true, { sinceMs: 0, requiredMs: 60_000 })).toBe(1)
  })

  it('recovers immediately, dwell or not', () => {
    // An agent that stopped misbehaving should not serve out a sentence.
    expect(nextRung(2, false, { sinceMs: 0, requiredMs: 60_000 })).toBe(0)
  })

  it.each([0, 1, 2, 3] as const)('falls to 0 from %i the moment nothing fires', (from) => {
    // An agent that recovered should not have to serve a sentence.
    expect(nextRung(from as Rung, false)).toBe(0)
  })

  it('cannot reach stop on a first trip, however bad the signals', () => {
    // "A three-step ladder, never a kill switch first" — the ADR's own words,
    // and the property that makes the breaker something the Architect leaves on.
    expect(nextRung(0, true)).toBe(1)
    expect(actionsFor(nextRung(0, true))).toEqual({ steer: true, constrain: false, stop: false })
  })

  it.each([1, 2, 3] as const)('rung %i does exactly what ADR-0011 lists', (rung) => {
    expect(actionsFor(rung)).toEqual({ steer: rung >= 1, constrain: rung >= 2, stop: rung >= 3 })
    expect(RUNG_NAMES[rung]).toBe(['steer', 'constrain', 'stop'][rung - 1])
  })

  it('rung 0 does nothing at all', () => {
    expect(actionsFor(0)).toEqual({ steer: false, constrain: false, stop: false })
  })
})

describe('repetition — the same call, not merely a busy agent', () => {
  it('fires on identical calls at the threshold', () => {
    const spans = Array.from({ length: DEFAULT_THRESHOLDS.repeatCount }, () => span())
    const hits = evaluateSignals(input({ spans }))
    expect(hits.map((hit) => hit.signal)).toEqual(['repetition'])
    expect(hits[0]?.detail['repeats']).toBe(DEFAULT_THRESHOLDS.repeatCount)
  })

  it('does not fire one call below the threshold', () => {
    const spans = Array.from({ length: DEFAULT_THRESHOLDS.repeatCount - 1 }, () => span())
    expect(evaluateSignals(input({ spans }))).toEqual([])
  })

  it('does not fire on a busy agent reading DIFFERENT things', () => {
    // Twenty reads of twenty files is work; twenty reads of one file is stuck.
    // Only the argument fingerprint tells them apart.
    const spans = Array.from({ length: 20 }, (_unused, i) =>
      span({ fingerprint: `file-${String(i)}` })
    )
    expect(evaluateSignals(input({ spans }))).toEqual([])
  })

  it('does not fire on the same arguments to DIFFERENT tools', () => {
    const spans = Array.from({ length: 20 }, (_unused, i) => span({ tool: `Tool${String(i)}` }))
    expect(evaluateSignals(input({ spans }))).toEqual([])
  })

  it('ignores calls that fell out of the window', () => {
    const old = Array.from({ length: 20 }, () =>
      span({ startedAt: T0 - DEFAULT_THRESHOLDS.repeatWindowMs - 1 })
    )
    expect(evaluateSignals(input({ spans: old }))).toEqual([])
  })

  it('names the tool it saw repeating', () => {
    const spans = Array.from({ length: 6 }, () => span({ tool: 'Bash' }))
    expect(evaluateSignals(input({ spans }))[0]?.detail['tool']).toBe('Bash')
  })
})

describe('error storms — a rate, over enough calls to mean something', () => {
  const errors = (n: number, ok: number): Span[] => [
    ...Array.from({ length: n }, (_u, i) =>
      span({ outcome: 'error', fingerprint: `e${String(i)}` })
    ),
    ...Array.from({ length: ok }, (_u, i) => span({ outcome: 'ok', fingerprint: `o${String(i)}` }))
  ]

  it('fires at the rate, once past the floor', () => {
    const hits = evaluateSignals(input({ spans: errors(4, 4) }))
    expect(hits.map((hit) => hit.signal)).toEqual(['error-rate'])
    expect(hits[0]?.detail).toMatchObject({ errors: 4, calls: 8, rate: 0.5 })
  })

  it('does not fire below the floor, however bad the rate', () => {
    // Three failures out of three is a bad morning, not a storm.
    expect(evaluateSignals(input({ spans: errors(3, 0) }))).toEqual([])
  })

  it('does not fire below the rate', () => {
    expect(evaluateSignals(input({ spans: errors(2, 8) }))).toEqual([])
  })

  it('ignores spans still open', () => {
    const spans = [
      ...errors(2, 2),
      ...Array.from({ length: 20 }, (_u, i) =>
        span({ outcome: 'open', durationMs: null, fingerprint: `x${String(i)}` })
      )
    ]
    // An open span has no outcome yet; counting it either way would be a guess.
    expect(evaluateSignals(input({ spans }))).toEqual([])
  })
})

describe('hop-cap escalations (trip signal #3)', () => {
  it('fires when one conversation escalates repeatedly', () => {
    const hits = evaluateSignals(
      input({ hopCapEscalations: { 'conv-7': DEFAULT_THRESHOLDS.hopCapEscalations } })
    )
    expect(hits.map((hit) => hit.signal)).toEqual(['hop-cap'])
    expect(hits[0]?.detail['conversation']).toBe('conv-7')
  })

  it('does not fire on escalations spread across conversations', () => {
    // Three different arguments escalating once each is a busy company; one
    // argument escalating three times is a stuck one.
    expect(evaluateSignals(input({ hopCapEscalations: { a: 1, b: 1, c: 1 } }))).toEqual([])
  })
})

describe('burn rate (trip signal #4, from M3.2)', () => {
  it.each(['breached', 'projected-breach'] as const)('fires on %s', (budgetState) => {
    expect(evaluateSignals(input({ budgetState })).map((h) => h.signal)).toEqual(['burn-rate'])
  })

  it.each(['ok', 'unbudgeted', null] as const)('does not fire on %s', (budgetState) => {
    expect(evaluateSignals(input({ budgetState }))).toEqual([])
  })
})

describe('several signals at once', () => {
  it('reports each of them, in the ADR’s order', () => {
    const spans = [
      ...Array.from({ length: 6 }, () => span({ outcome: 'error' })),
      ...Array.from({ length: 6 }, (_u, i) => span({ fingerprint: `o${String(i)}` }))
    ]
    const hits = evaluateSignals(
      input({ spans, hopCapEscalations: { 'conv-1': 5 }, budgetState: 'breached' })
    )
    expect(hits.map((hit) => hit.signal)).toEqual([...TRIP_SIGNALS])
  })

  it('a quiet agent fires nothing', () => {
    expect(evaluateSignals(input({ spans: [span(), span({ fingerprint: 'b' })] }))).toEqual([])
  })
})

describe('reduced protection on weaker engines (ADR-0011’s consequence)', () => {
  it('flags a pty-heuristic engine and names what it cannot see', () => {
    // No tool events means no spans, so two of the four signals see nothing.
    // ADR-0011 requires this to be surfaced on the agent card, not hidden.
    expect(protectionFor('pty-heuristic')).toEqual({
      reduced: true,
      blind: ['repetition', 'error-rate']
    })
  })

  it.each(['native', 'wrapper'])('does not flag a %s engine', (grade) => {
    expect(protectionFor(grade)).toEqual({ reduced: false, blind: [] })
  })
})

describe('the span schema (FR-11.6)', () => {
  it('carries agent, tool, duration and outcome', () => {
    const parsed = span({ durationMs: 250, outcome: 'error' })
    expect(parsed).toMatchObject({ agentId: 'agent.mason', tool: 'Read', durationMs: 250 })
    expect(parsed.outcome).toBe('error')
  })

  it('allows a null duration only while the span is open', () => {
    expect(spanSchema.safeParse({ ...span(), durationMs: null }).success).toBe(true)
    expect(spanSchema.safeParse({ ...span(), durationMs: -1 }).success).toBe(false)
  })

  it('refuses an unknown outcome and an unknown field', () => {
    expect(spanSchema.safeParse({ ...span(), outcome: 'maybe' }).success).toBe(false)
    expect(spanSchema.safeParse({ ...span(), extra: 1 }).success).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import {
  dayKey,
  dayOfFact,
  evaluateBudget,
  foldFacts,
  ledgerRowSchema,
  tokensOf,
  totalOf,
  ZERO_TOTALS,
  type FoldableFact,
  type LedgerRow
} from '../../src/shared/cost'

/**
 * The folding math (ADR-0011, SDD §4.6) as pure functions. This is where the
 * upstream bug class ADR-0011 names lives or dies: a cumulative figure that can
 * be produced any way other than "fold the rows" is a counter waiting to reset.
 */

function fact(over: Partial<FoldableFact> = {}): FoldableFact {
  return {
    sessionId: 's-1',
    model: 'test-model',
    inTokens: 10,
    outTokens: 5,
    costUsd: null,
    at: null,
    ...over
  }
}

const CONTEXT = { fallbackDay: '2026-08-27' }

describe('foldFacts — the cursor is what makes re-reading safe', () => {
  it('folds every fact the first time', () => {
    const folded = foldFacts(
      [fact(), fact({ inTokens: 1 })],
      { agent: 'agent.mason', source: 't.jsonl', folded: 0 },
      CONTEXT
    )
    expect(folded.rows).toHaveLength(2)
    expect(folded.cursor).toEqual({ agent: 'agent.mason', source: 't.jsonl', folded: 2 })
    expect(folded.restarted).toBe(false)
  })

  it('folds nothing when the transcript has not grown', () => {
    const facts = [fact(), fact()]
    const first = foldFacts(facts, { agent: 'agent.mason', source: 't.jsonl', folded: 0 }, CONTEXT)
    // The same file read again — a transcript is re-read on every tick, so this
    // is the common case, not an edge one.
    const second = foldFacts(facts, first.cursor, CONTEXT)
    expect(second.rows).toEqual([])
    expect(second.cursor).toEqual(first.cursor)
  })

  it('folds only the new tail when the transcript grew', () => {
    const first = foldFacts(
      [fact()],
      { agent: 'agent.mason', source: 't.jsonl', folded: 0 },
      CONTEXT
    )
    const second = foldFacts([fact(), fact({ outTokens: 99 })], first.cursor, CONTEXT)
    expect(second.rows).toHaveLength(1)
    expect(second.rows[0]?.outTokens).toBe(99)
    expect(second.cursor.folded).toBe(2)
  })

  it('re-folds from zero and says so when the transcript shrank', () => {
    // A rotated or crash-truncated file: skipping its first N facts forever
    // would under-report, which is the failure this ledger exists to prevent.
    const restarted = foldFacts(
      [fact()],
      { agent: 'agent.mason', source: 't.jsonl', folded: 5 },
      CONTEXT
    )
    expect(restarted.restarted).toBe(true)
    expect(restarted.rows).toHaveLength(1)
    expect(restarted.cursor.folded).toBe(1)
  })

  it('stamps every row with the SDD §4.6 key', () => {
    const folded = foldFacts(
      [fact({ sessionId: 's-9', model: 'm-2', costUsd: 0.5 })],
      { agent: 'agent.mason', source: 'file.jsonl', folded: 0 },
      CONTEXT
    )
    const row = folded.rows[0]
    expect(row).toEqual({
      agent: 'agent.mason',
      session: 's-9',
      model: 'm-2',
      day: '2026-08-27',
      inTokens: 10,
      outTokens: 5,
      costUsd: 0.5,
      source: 'file.jsonl'
    })
    expect(ledgerRowSchema.safeParse(row).success).toBe(true)
  })
})

describe('the day of SPEND, not the day of folding', () => {
  it('bills a fact to the day its transcript says it happened', () => {
    // `day` IS the budget window (SDD §4.6 with registry §4.1). Folding an old
    // transcript must not bill yesterday's tokens to today's budget — an agent
    // in a previously-used repo would breach on its first tick from history.
    const folded = foldFacts(
      [fact({ at: '2026-08-20T09:30:00.000Z' })],
      { agent: 'agent.mason', source: 't.jsonl', folded: 0 },
      { fallbackDay: '2026-08-27' }
    )
    expect(folded.rows[0]?.day).toBe(dayKey(new Date('2026-08-20T09:30:00.000Z')))
  })

  it('splits one transcript across the days it spans', () => {
    // An agent running across midnight bills each side to its own day.
    //
    // The midnight that matters is the LOCAL one. `dayKey` reads local calendar
    // fields on purpose — a budget day is the Architect's day, not UTC's — so
    // these two instants are built from local components and converted, rather
    // than written as a UTC pair. Straddling UTC midnight instead only works in
    // a zone at offset 0: at UTC+3 both `…26T23:59Z` and `…27T00:01Z` are the
    // 27th locally, one day, and the assertion fails on correct code.
    const beforeMidnight = new Date(2026, 7, 26, 23, 59)
    const afterMidnight = new Date(2026, 7, 27, 0, 1)
    expect(dayKey(beforeMidnight)).not.toBe(dayKey(afterMidnight))

    const folded = foldFacts(
      [fact({ at: beforeMidnight.toISOString() }), fact({ at: afterMidnight.toISOString() })],
      { agent: 'agent.mason', source: 't.jsonl', folded: 0 },
      { fallbackDay: '2026-08-27' }
    )
    expect(new Set(folded.rows.map((row) => row.day)).size).toBe(2)
  })

  it('falls back only for a fact whose transcript said nothing', () => {
    const folded = foldFacts(
      [fact({ at: null })],
      { agent: 'agent.mason', source: 't.jsonl', folded: 0 },
      { fallbackDay: '2026-08-27' }
    )
    expect(folded.rows[0]?.day).toBe('2026-08-27')
  })

  it('falls back rather than producing an unmatchable day from junk', () => {
    expect(dayOfFact(fact({ at: 'not a date' }), '2026-08-27')).toBe('2026-08-27')
  })
})

describe('totals', () => {
  const rows = (...over: Partial<LedgerRow>[]): LedgerRow[] =>
    over.map((patch) => ({
      agent: 'agent.mason',
      session: 's-1',
      model: 'm',
      day: '2026-08-27',
      inTokens: 0,
      outTokens: 0,
      costUsd: null,
      source: 't',
      ...patch
    }))

  it('sums both directions, because both cost money', () => {
    const totals = totalOf(rows({ inTokens: 10, outTokens: 3 }, { inTokens: 5, outTokens: 2 }))
    expect(totals).toEqual({ inTokens: 15, outTokens: 5, costUsd: null, rows: 2 })
    expect(tokensOf(totals)).toBe(20)
  })

  it('keeps costUsd null when NO row reported one', () => {
    // A `0` here would read as "this was free"; the UI must be able to tell
    // "nothing spent" from "not reported" (invariant §7).
    expect(totalOf(rows({ inTokens: 9 })).costUsd).toBeNull()
  })

  it('sums costUsd across the rows that did report one', () => {
    expect(
      totalOf(rows({ costUsd: 0.25 }, { costUsd: null }, { costUsd: 0.5 })).costUsd
    ).toBeCloseTo(0.75)
  })

  it('an empty slice is zero, not undefined', () => {
    expect(totalOf([])).toEqual(ZERO_TOTALS)
  })
})

describe('dayKey', () => {
  it('is local-calendar YYYY-MM-DD', () => {
    expect(dayKey(new Date(2026, 7, 27, 23, 59))).toBe('2026-08-27')
    expect(dayKey(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01')
  })

  /**
   * `dayKey` reads LOCAL calendar fields, and that is the contract: a budget day
   * is the Architect's day, not UTC's.
   *
   * ## This test cannot run everywhere, and that is the point
   *
   * At UTC+0 local time IS UTC, so no instant can tell a local-field reading
   * from a UTC-field reading. The contract is unobservable there — not hard to
   * test, *unobservable* — so this asserts it only where an offset exists.
   *
   * Which means a CI that runs one timezone cannot pin this. Swapping `dayKey`
   * to `getUTC*` stays green on a UTC runner and goes red only on a machine
   * that is somewhere else. That blind spot is written down here rather than
   * left for the next person to rediscover, because this repo has now been bitten
   * twice by assumptions that are invisible on the machine holding them — this,
   * and a version probe that only failed when a path contained a space.
   */
  it.runIf(new Date().getTimezoneOffset() !== 0)(
    'reads local fields, not UTC ones (only provable off UTC)',
    () => {
      // An instant whose UTC calendar day differs from its local one, built to
      // hold at ANY non-zero offset rather than assuming a whole-hour one —
      // Kathmandu is +05:45 and Chatham is +12:45.
      //
      // Ahead of UTC, local midnight is still yesterday in UTC; behind it, the
      // last minute of the day is already tomorrow. Either way one minute of
      // offset is enough.
      const acrossUtcMidnight =
        -new Date().getTimezoneOffset() > 0
          ? new Date(2026, 7, 27, 0, 0)
          : new Date(2026, 7, 27, 23, 59)

      expect(dayKey(acrossUtcMidnight)).toBe('2026-08-27')
      expect(acrossUtcMidnight.toISOString().slice(0, 10)).not.toBe('2026-08-27')
    }
  )
})

describe('evaluateBudget — post-hoc enforcement plus the pre-flight projection', () => {
  const base = { elapsedMinutes: 60, remainingMinutes: 60 }

  it('is unbudgeted when the role declares no budget', () => {
    expect(evaluateBudget({ ...base, spent: 999, dailyTokens: null })).toEqual({
      state: 'unbudgeted',
      spent: 999,
      remaining: null,
      projected: null,
      because: 'no-budget'
    })
  })

  it('is ok under budget with a projection that fits', () => {
    const verdict = evaluateBudget({ ...base, spent: 100, dailyTokens: 1000 })
    expect(verdict.state).toBe('ok')
    expect(verdict.remaining).toBe(900)
    // 100 tokens in 60 minutes → 100 more in the remaining 60.
    expect(verdict.projected).toBe(100)
  })

  it('is breached the moment the day budget is spent, post-hoc', () => {
    const verdict = evaluateBudget({ ...base, spent: 1000, dailyTokens: 1000 })
    expect(verdict.state).toBe('breached')
    expect(verdict.because).toBe('over')
  })

  it('projects a breach before it happens (trip signal #4)', () => {
    // 900 tokens in 10 minutes, 60 minutes left → 5400 projected against 100
    // remaining. This is the pre-flight leg ADR-0011 asks for.
    const verdict = evaluateBudget({
      spent: 900,
      dailyTokens: 1000,
      elapsedMinutes: 10,
      remainingMinutes: 60
    })
    expect(verdict.state).toBe('projected-breach')
    expect(verdict.projected).toBe(5400)
    expect(verdict.because).toBe('projection')
  })

  it('measures the rate over the window it can actually see', () => {
    // `spent` is durable (all of today, across restarts); `elapsedMinutes` can
    // only measure this process's uptime. Dividing the first by the second is
    // how a healthy agent gets projected into a breach after a restart.
    const verdict = evaluateBudget({
      spent: 400_000,
      spentAtWindowStart: 399_400,
      dailyTokens: 1_000_000,
      elapsedMinutes: 6,
      remainingMinutes: 600
    })
    // 600 tokens in 6 minutes → 60_000 projected, comfortably inside the
    // 600_000 remaining. Without the window baseline this projected 40M.
    expect(verdict.state).toBe('ok')
    expect(verdict.projected).toBe(60_000)
  })

  it('still catches a genuine burn inside the window', () => {
    const verdict = evaluateBudget({
      spent: 400_000,
      spentAtWindowStart: 300_000,
      dailyTokens: 500_000,
      elapsedMinutes: 10,
      remainingMinutes: 60
    })
    // 100k in 10 minutes → 600k projected against 100k remaining.
    expect(verdict.state).toBe('projected-breach')
  })

  it('refuses to project from too little history', () => {
    // Seconds of history would project absurd numbers and trip the breaker on a
    // healthy agent's first tool call. "We do not know yet" is the honest answer.
    const verdict = evaluateBudget({
      spent: 400,
      dailyTokens: 1000,
      elapsedMinutes: 0.5,
      remainingMinutes: 600
    })
    expect(verdict.state).toBe('ok')
    expect(verdict.projected).toBeNull()
  })

  it('does not project at the very end of the window', () => {
    const verdict = evaluateBudget({
      spent: 400,
      dailyTokens: 1000,
      elapsedMinutes: 600,
      remainingMinutes: 0
    })
    expect(verdict.state).toBe('ok')
    expect(verdict.projected).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import {
  dayKey,
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
    ...over
  }
}

const CONTEXT = { agent: 'agent.mason', day: '2026-08-27' }

describe('foldFacts — the cursor is what makes re-reading safe', () => {
  it('folds every fact the first time', () => {
    const folded = foldFacts(
      [fact(), fact({ inTokens: 1 })],
      { source: 't.jsonl', folded: 0 },
      CONTEXT
    )
    expect(folded.rows).toHaveLength(2)
    expect(folded.cursor).toEqual({ source: 't.jsonl', folded: 2 })
    expect(folded.restarted).toBe(false)
  })

  it('folds nothing when the transcript has not grown', () => {
    const facts = [fact(), fact()]
    const first = foldFacts(facts, { source: 't.jsonl', folded: 0 }, CONTEXT)
    // The same file read again — a transcript is re-read on every tick, so this
    // is the common case, not an edge one.
    const second = foldFacts(facts, first.cursor, CONTEXT)
    expect(second.rows).toEqual([])
    expect(second.cursor).toEqual(first.cursor)
  })

  it('folds only the new tail when the transcript grew', () => {
    const first = foldFacts([fact()], { source: 't.jsonl', folded: 0 }, CONTEXT)
    const second = foldFacts([fact(), fact({ outTokens: 99 })], first.cursor, CONTEXT)
    expect(second.rows).toHaveLength(1)
    expect(second.rows[0]?.outTokens).toBe(99)
    expect(second.cursor.folded).toBe(2)
  })

  it('re-folds from zero and says so when the transcript shrank', () => {
    // A rotated or crash-truncated file: skipping its first N facts forever
    // would under-report, which is the failure this ledger exists to prevent.
    const restarted = foldFacts([fact()], { source: 't.jsonl', folded: 5 }, CONTEXT)
    expect(restarted.restarted).toBe(true)
    expect(restarted.rows).toHaveLength(1)
    expect(restarted.cursor.folded).toBe(1)
  })

  it('stamps every row with the SDD §4.6 key', () => {
    const folded = foldFacts(
      [fact({ sessionId: 's-9', model: 'm-2', costUsd: 0.5 })],
      { source: 'file.jsonl', folded: 0 },
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

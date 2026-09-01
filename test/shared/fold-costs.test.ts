import { describe, expect, it } from 'vitest'
import { foldCosts, ledgerRowSchema, totalOf, type LedgerRow } from '../../src/shared/cost'

/**
 * `foldCosts` — engine-reported **running totals** into append-only rows
 * (ADR-0011's `cost_usd` column).
 *
 * The property that carries the whole design: an engine reports money
 * cumulatively and the ledger stores it incrementally, so folding must take a
 * DIFFERENCE. Every case here is a way that could go wrong on real data, and
 * the shapes come from a corpus of 20 real Claude Code transcripts — where 17
 * of 17 files with a `cost-state` line wrote it twice, and none carried a
 * timestamp.
 */

function row(over: Partial<LedgerRow> = {}): LedgerRow {
  return ledgerRowSchema.parse({
    agent: 'agent.artemis',
    session: 'sess-1',
    model: 'claude-sonnet-5',
    day: '2026-09-01',
    inTokens: 1000,
    outTokens: 50,
    costUsd: null,
    source: 'sess-1.jsonl',
    ...over
  })
}

const ctx = (existing: readonly LedgerRow[], fallbackDay = '2026-09-02') => ({
  existing,
  agent: 'agent.artemis',
  source: 'sess-1.jsonl',
  fallbackDay
})

describe('foldCosts — a running total becomes an increment', () => {
  it('records the whole figure the first time it is seen', () => {
    const folded = foldCosts(
      [{ sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0.5 }],
      ctx([row()])
    )
    expect(folded.rows).toHaveLength(1)
    expect(folded.rows[0]?.costUsd).toBe(0.5)
  })

  it('records NOTHING the second time — the same transcript, re-read', () => {
    // The Watch re-reads every transcript every fifteen seconds, and the engine
    // writes the line twice at session end. Appending the value rather than the
    // difference would double the bill on the duplicate line alone.
    const first = foldCosts(
      [{ sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0.5 }],
      ctx([row()])
    )
    const second = foldCosts(
      [{ sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0.5 }],
      ctx([row(), ...first.rows])
    )
    expect(second.rows).toEqual([])
  })

  it('records only the growth when a resumed session spends more', () => {
    // $0.20 at the first cost-state, $0.50 at a later one. The truth is $0.50,
    // not $0.70.
    const first = foldCosts(
      [{ sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0.2 }],
      ctx([row()])
    )
    const later = foldCosts(
      [{ sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0.5 }],
      ctx([row(), ...first.rows])
    )
    expect(later.rows[0]?.costUsd).toBeCloseTo(0.3, 10)
    expect(totalOf([row(), ...first.rows, ...later.rows]).costUsd).toBeCloseTo(0.5, 10)
  })

  it('is idempotent however many times it runs', () => {
    let ledger: LedgerRow[] = [row()]
    for (let i = 0; i < 25; i++) {
      const folded = foldCosts(
        [{ sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0.5 }],
        ctx(ledger)
      )
      ledger = [...ledger, ...folded.rows]
    }
    expect(totalOf(ledger).costUsd).toBe(0.5)
    // One row, not twenty-five: idempotency here is structural, not a cursor.
    expect(ledger.filter((r) => r.costUsd !== null)).toHaveLength(1)
  })

  it('keeps each model on its own running total', () => {
    const folded = foldCosts(
      [
        { sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0.48 },
        { sessionId: 'sess-1', model: 'claude-haiku-4-5-20251001', cumulativeUsd: 0.002 }
      ],
      ctx([row(), row({ model: 'claude-haiku-4-5-20251001' })])
    )
    expect(folded.rows.map((r) => r.model).sort()).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-sonnet-5'
    ])
    expect(totalOf(folded.rows).costUsd).toBeCloseTo(0.482, 10)
  })

  it('keeps each session on its own running total', () => {
    // Sessions are independent bills. A second session starting at $0.10 must
    // not be read as the first one having dropped.
    const folded = foldCosts(
      [
        { sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0.5 },
        { sessionId: 'sess-2', model: 'claude-sonnet-5', cumulativeUsd: 0.1 }
      ],
      ctx([row({ costUsd: 0.5 }), row({ session: 'sess-2' })])
    )
    expect(folded.rows).toHaveLength(1)
    expect(folded.rows[0]?.session).toBe('sess-2')
    expect(folded.rows[0]?.costUsd).toBe(0.1)
  })
})

describe('foldCosts — the money rows carry no tokens', () => {
  it('adds dollars without adding a single token', () => {
    // modelUsage repeats the tokens that foldFacts already recorded. Counting
    // them again is the double-count this whole function exists to avoid.
    const tokens = [row({ inTokens: 1000, outTokens: 50 })]
    const folded = foldCosts(
      [{ sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0.5 }],
      ctx(tokens)
    )
    expect(folded.rows[0]?.inTokens).toBe(0)
    expect(folded.rows[0]?.outTokens).toBe(0)
    const after = totalOf([...tokens, ...folded.rows])
    expect(after.inTokens).toBe(1000)
    expect(after.outTokens).toBe(50)
    expect(after.costUsd).toBe(0.5)
  })

  it('produces rows the ledger schema accepts', () => {
    const folded = foldCosts(
      [{ sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0.5 }],
      ctx([row()])
    )
    expect(() => ledgerRowSchema.parse(folded.rows[0])).not.toThrow()
  })
})

describe('foldCosts — the day money belongs to', () => {
  it('bills money to the day that session last spent tokens on that model', () => {
    // A cost-state line carries NO timestamp, so it cannot name its own day.
    // Money follows the work it paid for, not the moment we happened to look —
    // which matters for a session that ran across midnight.
    const folded = foldCosts(
      [{ sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0.5 }],
      ctx([row({ day: '2026-08-31' }), row({ day: '2026-09-01' })], '2026-09-02')
    )
    expect(folded.rows[0]?.day).toBe('2026-09-01')
  })

  it('falls back to today only when the ledger holds no dated row for it', () => {
    const folded = foldCosts(
      [{ sessionId: 'sess-other', model: 'claude-sonnet-5', cumulativeUsd: 0.5 }],
      ctx([row()], '2026-09-02')
    )
    expect(folded.rows[0]?.day).toBe('2026-09-02')
  })

  it('does not let another model’s day decide this one’s', () => {
    const folded = foldCosts(
      [{ sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0.5 }],
      ctx([row({ model: 'claude-haiku-4-5-20251001', day: '2026-08-30' })], '2026-09-02')
    )
    expect(folded.rows[0]?.day).toBe('2026-09-02')
  })
})

describe('foldCosts — a total that goes backwards', () => {
  it('records nothing and reports it, rather than inventing a correction', () => {
    // Spending cannot go down. A smaller running total means the transcript was
    // replaced or rotated; a negative row is impossible and a positive one
    // would be money nobody spent.
    const folded = foldCosts(
      [{ sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0.2 }],
      ctx([row({ costUsd: 0.5 })])
    )
    expect(folded.rows).toEqual([])
    expect(folded.regressed).toHaveLength(1)
    expect(folded.regressed[0]?.model).toBe('claude-sonnet-5')
  })

  it('leaves the earlier figure standing', () => {
    const existing = [row({ costUsd: 0.5 })]
    const folded = foldCosts(
      [{ sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0.2 }],
      ctx(existing)
    )
    expect(totalOf([...existing, ...folded.rows]).costUsd).toBe(0.5)
  })
})

describe('foldCosts — zero is a real figure, absence is not', () => {
  it('records nothing for a genuine zero, leaving the total unreported', () => {
    // An engine reporting $0.00 and an engine reporting nothing must not become
    // the same thing. A zero delta appends no row, so `costUsd` stays null —
    // which the UI shows as "not reported" rather than as "free" (ADR-0011).
    const folded = foldCosts(
      [{ sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0 }],
      ctx([row()])
    )
    expect(folded.rows).toEqual([])
    expect(totalOf([row()]).costUsd).toBeNull()
  })

  it('reports nothing at all when the engine reported no costs', () => {
    expect(foldCosts([], ctx([row()])).rows).toEqual([])
  })
})

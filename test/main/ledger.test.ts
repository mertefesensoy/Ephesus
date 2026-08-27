import { describe, expect, it } from 'vitest'
import type { FoldableFact, LedgerRow } from '../../src/shared/cost'
import { CostLedger, MemoryLedgerStore, type LedgerStore } from '../../src/main/watch/ledger'

/**
 * The durable ledger (ADR-0011) against a storage seam. The seam is the point:
 * better-sqlite3 is Electron-ABI and cannot load under vitest (M0 constraint
 * 3), so the SQLite implementation is exercised by the live run while the
 * *rules* — folding, idempotency, and restart survival — are asserted here.
 *
 * S-LEDGER's core claim is the last describe block: the cumulative figure
 * survives a restart and the session figure resets, both sourced from the
 * ledger. Upstream shipped the opposite and under-reported spend.
 */

function fact(over: Partial<FoldableFact> = {}): FoldableFact {
  return {
    sessionId: 'sess-1',
    model: 'test-model',
    inTokens: 100,
    outTokens: 20,
    costUsd: null,
    at: null,
    ...over
  }
}

/** A fixed clock, so budget windows are testable without waiting for midnight. */
function at(hour: number, minute = 0): Date {
  return new Date(2026, 7, 27, hour, minute, 0, 0)
}

describe('folding into the ledger', () => {
  it('appends the rows a first read produced', () => {
    const store = new MemoryLedgerStore()
    const ledger = new CostLedger({ store, now: () => at(9) })
    const rows = ledger.fold('agent.mason', 't.jsonl', [fact(), fact({ outTokens: 5 })])
    expect(rows).toHaveLength(2)
    expect(store.rowsFor('agent.mason')).toHaveLength(2)
    expect(store.rowsFor('agent.mason')[0]?.day).toBe('2026-08-27')
  })

  it('never double-counts a transcript that is read again', () => {
    const store = new MemoryLedgerStore()
    const ledger = new CostLedger({ store, now: () => at(9) })
    const facts = [fact(), fact()]
    ledger.fold('agent.mason', 't.jsonl', facts)
    // A transcript is re-read on every tick as it grows; this is the common
    // path, and double-counting here would inflate every figure the UI shows.
    ledger.fold('agent.mason', 't.jsonl', facts)
    ledger.fold('agent.mason', 't.jsonl', facts)
    expect(store.rowsFor('agent.mason')).toHaveLength(2)
  })

  it('folds only the tail as the transcript grows', () => {
    const store = new MemoryLedgerStore()
    const ledger = new CostLedger({ store, now: () => at(9) })
    ledger.fold('agent.mason', 't.jsonl', [fact()])
    ledger.fold('agent.mason', 't.jsonl', [fact(), fact({ outTokens: 77 })])
    const rows = store.rowsFor('agent.mason')
    expect(rows).toHaveLength(2)
    expect(rows[1]?.outTokens).toBe(77)
  })

  it('keeps two agents’ spend apart', () => {
    const store = new MemoryLedgerStore()
    const ledger = new CostLedger({ store, now: () => at(9) })
    ledger.fold('agent.mason', 'mason.jsonl', [fact()])
    ledger.fold('agent.scribe', 'scribe.jsonl', [fact(), fact()])
    expect(store.rowsFor('agent.mason')).toHaveLength(1)
    expect(store.rowsFor('agent.scribe')).toHaveLength(2)
  })

  it('re-folds a shrunken transcript and reports it', () => {
    const store = new MemoryLedgerStore()
    const restarts: string[] = []
    const ledger = new CostLedger({
      store,
      now: () => at(9),
      onFoldRestart: (source) => restarts.push(source)
    })
    ledger.fold('agent.mason', 't.jsonl', [fact(), fact(), fact()])
    // Rotated or crash-truncated: skipping its first three facts forever would
    // silently under-report, which is the bug class this ledger exists to close.
    ledger.fold('agent.mason', 't.jsonl', [fact()])
    expect(restarts).toEqual(['t.jsonl'])
    expect(store.rowsFor('agent.mason')).toHaveLength(4)
  })
})

describe('session and cumulative, side by side', () => {
  it('reports zero session spend before the engine names a session', () => {
    const ledger = new CostLedger({ store: new MemoryLedgerStore(), now: () => at(9) })
    const spend = ledger.spendFor('agent.mason', null)
    expect(spend.session).toBeNull()
    expect(spend.sessionTotals.rows).toBe(0)
  })

  it('attributes only the live session to the session figure', () => {
    const store = new MemoryLedgerStore()
    const ledger = new CostLedger({ store, now: () => at(9) })
    ledger.fold('agent.mason', 'a.jsonl', [fact({ sessionId: 'sess-old', inTokens: 500 })])
    ledger.fold('agent.mason', 'b.jsonl', [fact({ sessionId: 'sess-new', inTokens: 7 })])
    ledger.noteSession('agent.mason', 'sess-new')
    const spend = ledger.spendFor('agent.mason', null)
    expect(spend.sessionTotals.inTokens).toBe(7)
    expect(spend.cumulativeTotals.inTokens).toBe(507)
  })
})

describe('budgets', () => {
  it('is unbudgeted when the role declares no budget', () => {
    const ledger = new CostLedger({ store: new MemoryLedgerStore(), now: () => at(9) })
    expect(ledger.spendFor('agent.mason', null).budget.state).toBe('unbudgeted')
  })

  it('breaches post-hoc once the day budget is spent', () => {
    const store = new MemoryLedgerStore()
    const ledger = new CostLedger({ store, now: () => at(9) })
    ledger.fold('agent.mason', 't.jsonl', [fact({ inTokens: 900, outTokens: 200 })])
    const spend = ledger.spendFor('agent.mason', 1000)
    expect(spend.budget.state).toBe('breached')
    expect(spend.budget.because).toBe('over')
  })

  it('counts only today against the daily budget', () => {
    const store = new MemoryLedgerStore()
    const yesterday = new CostLedger({ store, now: () => new Date(2026, 7, 26, 9) })
    yesterday.fold('agent.mason', 'old.jsonl', [fact({ inTokens: 5000 })])
    const today = new CostLedger({ store, now: () => at(9) })
    const spend = today.spendFor('agent.mason', 1000)
    expect(spend.todayTotals.rows).toBe(0)
    expect(spend.cumulativeTotals.inTokens).toBe(5000)
    expect(spend.budget.state).toBe('ok')
  })
})

describe('restart survival (S-LEDGER core)', () => {
  it('keeps the cumulative figure and resets the session one', () => {
    // "Restart" is modelled the way M2's scenarios model it: the objects are
    // abandoned mid-flight and a fresh set is built over the same storage, as a
    // killed process and a new one would be.
    const store: LedgerStore = new MemoryLedgerStore()

    const before = new CostLedger({ store, now: () => at(9) })
    before.noteSession('agent.mason', 'sess-1')
    before.fold('agent.mason', 't.jsonl', [fact({ inTokens: 1000, outTokens: 250 })])
    const pre = before.spendFor('agent.mason', 10_000)
    expect(pre.sessionTotals.inTokens).toBe(1000)
    expect(pre.cumulativeTotals.inTokens).toBe(1000)

    // …the harness dies here. Nothing is flushed, nothing is handed over.
    const after = new CostLedger({ store, now: () => at(10) })

    const post = after.spendFor('agent.mason', 10_000)
    // The upstream bug: this used to come back zero.
    expect(post.cumulativeTotals).toEqual(pre.cumulativeTotals)
    expect(post.todayTotals.inTokens).toBe(1000)
    // The session figure DOES reset, because the session is gone — that is the
    // honest answer, and it is why the two figures are shown side by side.
    expect(post.session).toBeNull()
    expect(post.sessionTotals.rows).toBe(0)
  })

  it('keeps counting into the same day after the restart', () => {
    const store: LedgerStore = new MemoryLedgerStore()
    new CostLedger({ store, now: () => at(9) }).fold('agent.mason', 't.jsonl', [fact()])
    const after = new CostLedger({ store, now: () => at(11) })
    // The new run re-reads the same transcript from the start — and the cursor
    // in storage, not in memory, is what stops it counting twice.
    after.fold('agent.mason', 't.jsonl', [fact(), fact({ outTokens: 3 })])
    const rows: readonly LedgerRow[] = store.rowsFor('agent.mason')
    expect(rows).toHaveLength(2)
    expect(after.spendFor('agent.mason', null).todayTotals.inTokens).toBe(200)
  })
})

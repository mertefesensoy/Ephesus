import { describe, expect, it } from 'vitest'
import { GYM_CHECK_EVERY_MS, gymCadenceTick, metricChecksDue } from '../../src/main/gym-cadence'
import type { GymRow } from '../../src/shared/gym'
import {
  IMPROVEMENT_ROLES,
  SPEND_SCOPES,
  agentsInScope,
  attributeSpend,
  attributedTokens,
  attributionSource
} from '../../src/shared/attribution'

/**
 * The three carried items the M5 and M5b close-outs left for M6.7's scheduler
 * work. Two of them are here; the third — the `odeon:queue` status-strip badge
 * — is renderer wiring, covered by `test/renderer/status-strip.test.tsx`.
 *
 * Both were deferred honestly (the deferrals are in DECISIONS-LOG with their
 * reasons), which is why closing them means proving the thing the deferral said
 * was missing, not just adding code where the gap was.
 */

const row = (over: Partial<GymRow> = {}): GymRow =>
  ({
    id: 'GYM-002',
    idCell: 'GYM-002',
    title: 'hook boundary steer',
    class: 'process',
    status: 'landed',
    metric: 'steer notes per week ≥ 3',
    proposedBy: 'artemis',
    proposedAt: '2026-08-28',
    decidedBy: 'architect',
    decidedAt: '2026-08-28',
    measured: 'due 2026-09-11',
    outcome: null,
    ...over
  }) as GymRow

describe('the Gymnasium’s metric check is BOOKED (SDD §7.6)', () => {
  it('raises a landed row whose window has closed', () => {
    const due = metricChecksDue([row()], '2026-09-11')
    expect(due).toEqual([{ id: 'GYM-002', due: '2026-09-11', metric: 'steer notes per week ≥ 3' }])
    // And on any later day too: a check stays due until somebody runs it,
    // because the row stays `landed` until it is measured (R2).
    expect(metricChecksDue([row()], '2026-10-01')).toHaveLength(1)
  })

  it('does not raise one before its window closes', () => {
    expect(metricChecksDue([row()], '2026-09-10')).toEqual([])
  })

  it('only ever raises LANDED rows', () => {
    for (const status of ['proposed', 'approved', 'rejected', 'validated', 'regressed'] as const) {
      // `approved` has not shipped; `validated`/`regressed` have been measured.
      expect(metricChecksDue([row({ status })], '2026-12-31'), status).toEqual([])
    }
  })

  it('reads the date through a human note beside it (the real GYM-003 cell)', () => {
    // The defect the M6 exit review caught by running this against the REAL
    // ledger: GYM-003's cell is `due 2026-09-11 (live-quit evidence owed with
    // the metric check)`, and an anchored match skipped it — so the ONE row the
    // M6 window singles out was the one row that would never have been booked.
    // Rows a test writes for itself are tidy; the ledger is not.
    const noted = row({
      id: 'GYM-003',
      measured: 'due 2026-09-11 (live-quit evidence owed with the metric check)'
    })
    expect(metricChecksDue([noted], '2026-09-11').map((d) => d.id)).toEqual(['GYM-003'])
    expect(metricChecksDue([noted], '2026-09-10')).toEqual([])
  })

  it('skips a malformed Measured cell rather than inventing a date', () => {
    for (const measured of [null, '', 'soon', '2026-09-11', 'due tomorrow', 'due 2026-9-1']) {
      expect(metricChecksDue([row({ measured })], '2026-12-31'), String(measured)).toEqual([])
    }
  })

  it('logs every due check, with the metric it promised', () => {
    const logged: Record<string, unknown>[] = []
    const raised: string[] = []
    const result = gymCadenceTick({
      rows: () => [row(), row({ id: 'GYM-003', measured: 'due 2026-09-11' })],
      today: () => '2026-09-12',
      appendLog: (draft) => logged.push(draft),
      onDue: (check) => raised.push(check.id)
    })
    expect(result.due.map((d) => d.id)).toEqual(['GYM-002', 'GYM-003'])
    expect(raised).toEqual(['GYM-002', 'GYM-003'])
    expect(logged).toHaveLength(2)
    expect(logged[0]).toMatchObject({
      kind: 'gym',
      event: 'metric-check-due',
      gymId: 'GYM-002',
      due: '2026-09-11'
    })
    // The metric rides the entry: a check nobody can read the target of is a
    // check nobody can run.
    expect(logged[0]?.['metric']).toBe('steer notes per week ≥ 3')
  })

  it('records the quiet ticks too, so silence is a fact and not an outage', () => {
    const logged: Record<string, unknown>[] = []
    gymCadenceTick({
      rows: () => [row({ status: 'validated' })],
      today: () => '2026-12-31',
      appendLog: (draft) => logged.push(draft)
    })
    expect(logged[0]).toMatchObject({ kind: 'gym', event: 'metric-check-idle' })
  })

  it('logs without a surface — the record must not need a window open', () => {
    const logged: Record<string, unknown>[] = []
    const result = gymCadenceTick({
      rows: () => [row()],
      today: () => '2026-09-12',
      appendLog: (draft) => logged.push(draft)
    })
    expect(result.due).toHaveLength(1)
    expect(logged).toHaveLength(1)
  })

  it('checks daily — a window is declared in days', () => {
    expect(GYM_CHECK_EVERY_MS).toBe(24 * 60 * 60 * 1000)
  })
})

describe('gym and Stoa spend are ATTRIBUTED (FR-12.5, R3)', () => {
  const roster = [
    { agentId: 'artemis', role: 'orchestrator' },
    { agentId: 'iris', role: 'researcher' },
    { agentId: 'pallas', role: 'improver' },
    { agentId: 'mason', role: 'engineer' },
    { agentId: 'docsy', role: 'process-improver-docs' }
  ]
  const tokens: Record<string, number> = { artemis: 900, iris: 40, pallas: 60, mason: 5_000 }
  const tokensFor = (agentId: string): number => tokens[agentId] ?? 0

  it('names both scopes', () => {
    expect([...SPEND_SCOPES]).toEqual(['gymnasium', 'stoa'])
    expect([...IMPROVEMENT_ROLES]).toEqual(['researcher', 'improver'])
  })

  it('attributes the gym slice to the improvement roles, exactly', () => {
    expect(agentsInScope(roster, 'gymnasium')).toEqual(['iris', 'pallas'])
    // The M5b audit's counter-example: a hire is not improvement work because
    // its NAME contains a word.
    expect(agentsInScope(roster, 'gymnasium')).not.toContain('docsy')
    expect(attributeSpend(roster, 'gymnasium', tokensFor).tokens).toBe(100)
  })

  it('attributes the Stoa to the researcher alone', () => {
    expect(agentsInScope(roster, 'stoa')).toEqual(['iris'])
    expect(attributeSpend(roster, 'stoa', tokensFor).tokens).toBe(40)
  })

  it('NAMES its source, because the brief is read aloud', () => {
    const gym = attributeSpend(roster, 'gymnasium', tokensFor)
    // The M5 close-out asked for the number back "with its source named": a
    // bare total invites trust in a scope the listener cannot see.
    expect(gym.source).toContain('cost ledger')
    expect(gym.source).toContain('iris')
    expect(gym.source).toContain('pallas')
  })

  it('says so when nobody is doing the work — a measurement, not a gap', () => {
    const none = attributeSpend([{ agentId: 'mason', role: 'engineer' }], 'gymnasium', tokensFor)
    expect(none.tokens).toBe(0)
    expect(none.source).toContain('no improvement agents hired')
    expect(attributionSource('stoa', [])).toContain('no researcher agents hired')
  })

  it('reads spend through ONE lookup, so it cannot drift from the ledger', () => {
    // Production passes the CostLedger's own cumulative read; a test passes a
    // table. Two paths to one figure is how a total stops matching its ledger.
    const seen: string[] = []
    attributedTokens(['iris', 'pallas'], (agentId) => {
      seen.push(agentId)
      return tokensFor(agentId)
    })
    expect(seen).toEqual(['iris', 'pallas'])
  })

  it('never lets a negative reading reduce the total', () => {
    expect(attributedTokens(['iris'], () => -500)).toBe(0)
  })
})

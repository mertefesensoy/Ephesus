import { describe, expect, it } from 'vitest'
import { CompanyModes } from '../../src/main/modes'
import type { CompanyMode, GymLogEvent } from '../../src/shared/mode'
import type { GymRow, GymStatus } from '../../src/shared/gym'

/**
 * The mode driver (ADR-0018, FR-14, SDD §9).
 *
 * The asymmetry is what these tests are about: turning autonomy ON is gated,
 * logged and refusable; turning it OFF is unconditional, and the breaker can
 * do it without asking.
 */

function row(id: string, status: GymStatus): GymRow {
  return {
    id,
    idCell: id,
    title: id,
    class: 'craft',
    status,
    metric: 'm',
    proposedBy: 'agent.artemis',
    proposedAt: '2026-08-01T00:00:00.000Z',
    decidedBy: 'architect',
    decidedAt: '2026-08-02T00:00:00.000Z',
    measured: '2026-08-20',
    outcome: 'x'
  }
}

const PASSING_ROWS = [
  row('GYM-001', 'validated'),
  row('GYM-002', 'validated'),
  row('GYM-003', 'regressed')
]
const PASSING_EVENTS: GymLogEvent[] = [
  { event: 'approved', gymId: 'GYM-001' },
  { event: 'approved', gymId: 'GYM-002' },
  { event: 'approved', gymId: 'GYM-003' },
  { event: 'proposed', gymId: 'GYM-002', evidence: ['RB-001'] }
]

interface Rig {
  readonly modes: CompanyModes
  readonly events: Record<string, unknown>[]
  readonly ledgerRows: Record<string, unknown>[]
  readonly changed: string[]
  state: { mode: CompanyMode | undefined; everEnabled: boolean }
}

function rig(
  options: {
    readonly mode?: CompanyMode
    readonly everEnabled?: boolean
    readonly passing?: boolean
  } = {}
): Rig {
  const events: Record<string, unknown>[] = []
  const ledgerRows: Record<string, unknown>[] = []
  const changed: string[] = []
  const self: Rig = {
    state: { mode: options.mode, everEnabled: options.everEnabled ?? false },
    events,
    ledgerRows,
    changed,
    modes: null as unknown as CompanyModes
  }
  const modes = new CompanyModes({
    read: () => self.state,
    write: (patch) => {
      self.state = { mode: patch.mode, everEnabled: patch.everEnabled }
    },
    rows: () => (options.passing === false ? [] : PASSING_ROWS),
    gymEvents: () => (options.passing === false ? [] : PASSING_EVENTS),
    onLogEvent: (draft) => events.push(draft),
    recordOnLedger: (change) => ledgerRows.push({ ...change }),
    onChanged: (mode) => changed.push(mode),
    now: () => new Date('2026-08-28T09:00:00.000Z')
  })
  return { ...self, modes }
}

describe('reading the mode', () => {
  it('is directed when nothing was ever set', () => {
    expect(rig({ passing: false }).modes.mode()).toBe('directed')
  })

  it('reports what was persisted', () => {
    expect(rig({ mode: 'improving' }).modes.mode()).toBe('improving')
  })
})

describe('enabling improving (FR-14.3)', () => {
  it('REFUSES when the proof gate is not met, listing what is missing', () => {
    const r = rig({ passing: false })
    const outcome = r.modes.setMode('improving', 'architect')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.missing.length).toBeGreaterThan(0)
    expect(r.modes.mode()).toBe('directed')
  })

  it('records the refusal with the counts, so it can be argued with', () => {
    const r = rig({ passing: false })
    r.modes.setMode('improving', 'architect')
    const refusal = r.events.find((e) => e['event'] === 'mode-refused')
    expect(refusal).toBeDefined()
    expect(refusal?.['counted']).toBeDefined()
  })

  it('enables on a ledger that meets §6.9', () => {
    const r = rig()
    expect(r.modes.setMode('improving', 'architect')).toEqual({ ok: true, mode: 'improving' })
    expect(r.modes.mode()).toBe('improving')
  })

  it('records the change on the log AND the ledger (UC-15 postcondition)', () => {
    const r = rig()
    r.modes.setMode('improving', 'architect')
    expect(r.events.find((e) => e['event'] === 'mode-changed')).toMatchObject({
      from: 'directed',
      to: 'improving',
      by: 'architect'
    })
    expect(r.ledgerRows[0]).toMatchObject({ from: 'directed', to: 'improving', by: 'architect' })
    // FR-14.1: visible at all times — the strip is told to re-read.
    expect(r.changed).toEqual(['improving'])
  })

  it('does not re-run the gate on a later re-enable', () => {
    // Once the company has proved the loop works, it has proved it. Re-running
    // the gate after a revert would make a safety stop into a demotion.
    const r = rig({ mode: 'directed', everEnabled: true, passing: false })
    expect(r.modes.setMode('improving', 'architect').ok).toBe(true)
  })

  it('is a no-op when already in that mode', () => {
    const r = rig({ mode: 'improving' })
    expect(r.modes.setMode('improving', 'architect')).toEqual({ ok: true, mode: 'improving' })
    expect(r.events).toEqual([])
  })
})

describe('who may set it (FR-14.2)', () => {
  it.each(['artemis', 'agent.artemis', 'scheduler', 'researcher'])(
    'REFUSES "%s" even when the gate is met',
    (who) => {
      const r = rig()
      const outcome = r.modes.setMode('improving', who)
      expect(outcome.ok).toBe(false)
      expect(r.modes.mode()).toBe('directed')
      expect(r.events.some((e) => e['event'] === 'mode-refused' && e['by'] === who)).toBe(true)
    }
  )

  it('refuses a non-architect REVERT too — the mode is the Architect’s either way', () => {
    const r = rig({ mode: 'improving' })
    expect(r.modes.setMode('directed', 'artemis').ok).toBe(false)
    expect(r.modes.mode()).toBe('improving')
  })
})

describe('reverting (FR-14.2, FR-14.5)', () => {
  it('is ungated: no gate consulted, no evidence required', () => {
    const r = rig({ mode: 'improving', everEnabled: true, passing: false })
    expect(r.modes.setMode('directed', 'architect')).toEqual({ ok: true, mode: 'directed' })
  })

  it('reverts automatically on a rung-3 stop, attributed to the BREAKER', () => {
    const r = rig({ mode: 'improving', everEnabled: true })
    expect(r.modes.revertOnBreaker('agent.researcher stopped at rung 3')).toEqual({
      ok: true,
      mode: 'directed'
    })
    // Attributed to the breaker so nobody later reads it as the Architect
    // having changed their mind.
    expect(r.events.find((e) => e['event'] === 'mode-changed')).toMatchObject({ by: 'breaker' })
    expect(r.ledgerRows[0]).toMatchObject({ by: 'breaker' })
  })

  it('keeps everEnabled across a breaker revert — a stop is not a demotion', () => {
    const r = rig({ mode: 'improving', everEnabled: true })
    r.modes.revertOnBreaker('x')
    expect(r.state.everEnabled).toBe(true)
    // …so the Architect can restore it without re-proving anything.
    const restored = rig({ mode: 'directed', everEnabled: r.state.everEnabled, passing: false })
    expect(restored.modes.setMode('improving', 'architect').ok).toBe(true)
  })

  it('does nothing when the company is already directed', () => {
    const r = rig({ mode: 'directed', passing: false })
    expect(r.modes.revertOnBreaker('x')).toEqual({ ok: true, mode: 'directed' })
    expect(r.events).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODE,
  PROOF_GATE,
  checkModeSetter,
  checkProofGate,
  companyModeSchema,
  gateApplies,
  type GymLogEvent
} from '../../src/shared/mode'
import type { GymRow, GymStatus } from '../../src/shared/gym'

/**
 * The proof gate (SRS §6.9, FR-14, ADR-0018).
 *
 * This is the check that decides whether a company may start acting without
 * being asked, so the cases that matter are the ones where it says NO — and
 * the one where it says no *permanently*, because a gating violation is not
 * something a company can wait out.
 */

function row(id: string, status: GymStatus): GymRow {
  return {
    id,
    idCell: id,
    title: `proposal ${id}`,
    class: 'craft',
    status,
    metric: 'something → better',
    proposedBy: 'agent.artemis',
    proposedAt: '2026-08-01T00:00:00.000Z',
    decidedBy: 'architect',
    decidedAt: '2026-08-02T00:00:00.000Z',
    measured: status === 'validated' || status === 'regressed' ? '2026-08-20' : null,
    outcome: status === 'validated' ? 'hit' : status === 'regressed' ? 'missed' : null
  }
}

/** An approval event for each id — the ledger alone never proves a verdict. */
function approvals(...ids: string[]): GymLogEvent[] {
  return ids.map((gymId) => ({ event: 'approved', gymId }))
}

/** The one log event a seeded ledger still needs: which row a brief seeded. */
function seeded_(rows: readonly { id: string }[]): GymLogEvent {
  return { event: 'proposed', gymId: rows[1]?.id ?? '', evidence: ['RB-001'] }
}

function seeded(gymId: string, ref = 'RB-001'): GymLogEvent {
  return { event: 'proposed', gymId, evidence: [ref, 'log#12'] }
}

/** A ledger that meets §6.9 exactly: 3 measured, 2 validated, 1 Stoa-seeded. */
function passingLedger(): { rows: GymRow[]; events: GymLogEvent[] } {
  return {
    rows: [row('GYM-001', 'validated'), row('GYM-002', 'validated'), row('GYM-003', 'regressed')],
    events: [...approvals('GYM-001', 'GYM-002', 'GYM-003'), seeded('GYM-002')]
  }
}

describe('the mode itself', () => {
  it('defaults to directed — a company not told to act on its own does not', () => {
    expect(DEFAULT_MODE).toBe('directed')
  })

  it.each(['directed', 'improving'])('accepts %s', (mode) => {
    expect(companyModeSchema.safeParse(mode).success).toBe(true)
  })

  it.each(['auto', 'autonomous', 'IMPROVING', ''])('refuses %s', (mode) => {
    expect(companyModeSchema.safeParse(mode).success).toBe(false)
  })
})

describe('who may change it (FR-14.2)', () => {
  it('lets the Architect', () => {
    expect(checkModeSetter('architect').allowed).toBe(true)
  })

  it.each(['artemis', 'agent.artemis', 'scheduler', 'breaker', 'researcher', ''])(
    'refuses "%s"',
    (who) => {
      // An agent that could enable `improving` could grant itself initiative.
      const check = checkModeSetter(who)
      expect(check.allowed).toBe(false)
      expect(check.because).toContain('FR-14.2')
    }
  )
})

describe('when the gate applies (FR-14.3)', () => {
  it('applies to the FIRST enable only', () => {
    expect(gateApplies('directed', 'improving', false)).toBe(true)
    expect(gateApplies('directed', 'improving', true)).toBe(false)
  })

  it('never applies to a revert — directed is always one action away', () => {
    expect(gateApplies('improving', 'directed', true)).toBe(false)
    expect(gateApplies('improving', 'directed', false)).toBe(false)
  })

  it('does not apply when already improving', () => {
    expect(gateApplies('improving', 'improving', true)).toBe(false)
  })
})

describe('the proof gate itself (SRS §6.9)', () => {
  it('opens on a ledger meeting every clause', () => {
    const { rows, events } = passingLedger()
    const gate = checkProofGate(rows, events)
    expect(gate.met).toBe(true)
    expect(gate.missing).toEqual([])
    expect(gate.counted).toMatchObject({ fullLoop: 3, validated: 2, stoaSeeded: 1 })
  })

  it('refuses an empty ledger, listing every missing clause at once', () => {
    const gate = checkProofGate([], [])
    expect(gate.met).toBe(false)
    // The Architect's next question after a refusal is "what else?", and
    // answering it one round trip at a time is a bad way to hold a gate.
    expect(gate.missing).toHaveLength(3)
  })

  it('counts only MEASURED proposals as through the full loop', () => {
    // proposed/approved/landed are all mid-loop: the loop is not proved until
    // somebody found out whether the change worked.
    const rows = [row('GYM-001', 'proposed'), row('GYM-002', 'approved'), row('GYM-003', 'landed')]
    const gate = checkProofGate(rows, approvals('GYM-003'))
    expect(gate.counted.fullLoop).toBe(0)
    expect(gate.met).toBe(false)
  })

  it('counts a REGRESSED row toward the loop — measuring a failure is the loop working', () => {
    const rows = [
      row('GYM-001', 'regressed'),
      row('GYM-002', 'regressed'),
      row('GYM-003', 'regressed')
    ]
    const gate = checkProofGate(rows, [
      ...approvals('GYM-001', 'GYM-002', 'GYM-003'),
      seeded('GYM-001')
    ])
    expect(gate.counted.fullLoop).toBe(3)
    // …but two of them still have to have WORKED.
    expect(gate.met).toBe(false)
    expect(gate.missing.join(' ')).toContain('validated')
  })

  it('requires a Stoa-seeded proposal — outside evidence, not just self-reflection', () => {
    const { rows, events } = passingLedger()
    const withoutBrief = events.filter((e) => e.event !== 'proposed')
    const gate = checkProofGate(rows, withoutBrief)
    expect(gate.met).toBe(false)
    expect(gate.missing.join(' ')).toContain('Stoa brief')
  })

  it('recognises a brief citation anywhere in the evidence refs', () => {
    const { rows } = passingLedger()
    const events = [
      ...approvals('GYM-001', 'GYM-002', 'GYM-003'),
      { event: 'proposed', gymId: 'GYM-001', evidence: ['log#9', 'see RB-014 finding 2'] }
    ]
    expect(checkProofGate(rows, events).counted.stoaSeeded).toBe(1)
  })

  it('does not count a Stoa-seeded proposal that never got measured', () => {
    const rows = [
      row('GYM-001', 'validated'),
      row('GYM-002', 'validated'),
      row('GYM-003', 'regressed')
    ]
    const events = [...approvals('GYM-001', 'GYM-002', 'GYM-003'), seeded('GYM-009')]
    const gate = checkProofGate(rows, events)
    expect(gate.counted.stoaSeeded).toBe(0)
    expect(gate.met).toBe(false)
  })

  it('REFUSES PERMANENTLY when a proposal landed with no Architect verdict', () => {
    // The one clause that cannot be fixed by waiting: if this ever happened the
    // loop is not immature, it is broken, and more evidence must not open it.
    // "No verdict" means neither: no `approved` event AND no Decided date.
    const { rows, events } = passingLedger()
    const undecided = rows.map((r) => (r.id === 'GYM-002' ? { ...r, decidedAt: null } : r))
    const missingApproval = events.filter((e) => e.gymId !== 'GYM-002')
    const gate = checkProofGate(undecided, [...missingApproval, seeded('GYM-002')])
    expect(gate.met).toBe(false)
    expect(gate.counted.gatingViolations).toHaveLength(1)
    expect(gate.missing.join(' ')).toContain('cannot be waited out')
  })

  it('names the violating row so the refusal can be argued with', () => {
    const undecided = { ...row('GYM-007', 'landed'), decidedAt: null }
    const gate = checkProofGate([undecided], [])
    expect(gate.counted.gatingViolations[0]).toContain('GYM-007')
  })

  it('accepts a ledger Decided date as the verdict, not only a log event', () => {
    // Found by the M5b exit demo. A ledger seeded from the build-phase archive
    // (FR-12.6) inherits rows the Architect DID decide — the archive records
    // the date — while the fresh log has no events for them. Reading the log
    // alone made every seeded row a gating violation, and a violation is
    // absorbing, so the gate could never open on any company that inherited an
    // archive. Which is every company.
    const seeded = [
      { ...row('GYM-001', 'validated'), decidedAt: '2026-08-20T00:00:00.000Z' },
      { ...row('GYM-002', 'validated'), decidedAt: '2026-08-21T00:00:00.000Z' },
      { ...row('GYM-003', 'regressed'), decidedAt: '2026-08-22T00:00:00.000Z' }
    ]
    const gate = checkProofGate(seeded, [seeded_(seeded)])
    expect(gate.counted.gatingViolations).toEqual([])
    expect(gate.met).toBe(true)
  })

  it('still catches a row that reached landed with NO verdict anywhere', () => {
    const gate = checkProofGate([{ ...row('GYM-009', 'landed'), decidedAt: null }], [])
    expect(gate.counted.gatingViolations).toHaveLength(1)
    expect(gate.met).toBe(false)
  })

  it('reads the ledger and the gym log, and nothing else', () => {
    // The whole signature is two arguments. There is no cache to consult and no
    // counter to trust — invariant §11's spirit, applied to a gate.
    expect(checkProofGate.length).toBe(2)
  })

  it('states §6.9’s numbers in one named place', () => {
    expect(PROOF_GATE).toEqual({ fullLoop: 3, validated: 2, stoaSeeded: 1 })
  })
})

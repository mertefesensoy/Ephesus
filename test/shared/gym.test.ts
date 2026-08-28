import { describe, expect, it } from 'vitest'
import {
  GYM_CLASSES,
  GYM_SCHEMA_VERSION,
  checkVerdict,
  checkWidening,
  measuredOutcome,
  nextGymId,
  parseGymProposal,
  parseLedger,
  renderRow,
  withinSlice,
  type GymProposal,
  type GymRow
} from '../../src/shared/gym'

/**
 * ADR-0015's three hard rules, as tests (FR-12, UC-13).
 *
 * The Gymnasium is the one subsystem whose failure mode is the system quietly
 * rewriting its own constraints, so every rule here is asserted in the
 * direction that catches that: not "the good proposal passes" but "the
 * dangerous one is refused, and refused regardless of who is asking".
 */

const PROPOSAL: GymProposal = {
  schemaVersion: GYM_SCHEMA_VERSION,
  kind: 'gym-proposal',
  title: 'Shorten the wake nudge',
  class: 'craft',
  evidence: ['log#412', 'metrics:agent.mason'],
  change: 'Trim prompts/hermes/wake-nudge.md to two sentences.',
  costRisk: 'Low: one prompt file, reversible.',
  metric: { what: 'median turns after a wake', target: 'down from 3 to 2', windowDays: 14 },
  rollback: 'Restore the previous prompt file from git.'
}

function body(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...PROPOSAL, ...over })
}

function row(over: Partial<GymRow> = {}): GymRow {
  // `idCell` follows `id` unless a case sets it, so overriding the id in a
  // fixture cannot silently leave two rows rendering under the same one.
  return {
    id: over.id ?? 'GYM-001',
    idCell: over.idCell ?? over.id ?? 'GYM-001',
    title: 'Shorten the wake nudge',
    class: 'craft',
    status: 'proposed',
    metric: 'median turns → 2',
    proposedBy: 'agent.artemis',
    proposedAt: '2026-08-28T10:00:00.000Z',
    decidedBy: null,
    decidedAt: null,
    outcome: null,
    ...over
  }
}

describe('FR-12.2 — a proposal without a falsifiable metric is invalid by construction', () => {
  it('accepts a complete proposal', () => {
    expect(parseGymProposal(body()).ok).toBe(true)
  })

  it('REFUSES a proposal with no metric at all', () => {
    const { metric, ...rest } = PROPOSAL
    expect(metric.windowDays).toBe(14)
    const parsed = parseGymProposal(JSON.stringify(rest))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reasons.join(' ')).toContain('metric')
  })

  it.each(['what', 'target', 'windowDays'])('refuses a metric missing %s', (field) => {
    const metric: Record<string, unknown> = { ...PROPOSAL.metric }
    delete metric[field]
    expect(parseGymProposal(body({ metric })).ok).toBe(false)
  })

  it('REFUSES a proposal with no rollback', () => {
    const { rollback, ...rest } = PROPOSAL
    expect(rollback.length).toBeGreaterThan(0)
    expect(parseGymProposal(JSON.stringify(rest)).ok).toBe(false)
  })

  it('REFUSES a proposal with no evidence — no evidence, no proposal (FR-12.1)', () => {
    expect(parseGymProposal(body({ evidence: [] })).ok).toBe(false)
  })

  it('lists EVERY problem at once, because the harness refuses before a human sees it', () => {
    const parsed = parseGymProposal(body({ evidence: [], rollback: '', costRisk: '' }))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reasons.length).toBeGreaterThan(1)
  })

  it('refuses an unknown class', () => {
    expect(parseGymProposal(body({ class: 'whatever' })).ok).toBe(false)
  })

  it('names exactly the three classes the authority table has', () => {
    expect([...GYM_CLASSES]).toEqual(['craft', 'org', 'constitutional'])
  })
})

describe('FR-12.3 — authority-widening is refused REGARDLESS of approver', () => {
  it.each([
    ['relax an invariant', 'Loosen invariant §4 so agents can commit.'],
    ['edit an accepted ADR', 'Amend ADR-0004 to allow a second committer.'],
    ['change gym gating', 'Let Artemis approve craft-class gym gating herself.'],
    ['widen authority', 'Widen the authority table so memos self-approve.'],
    ['touch the gate policy', 'Ship a new gate-policy.json with fewer holds.'],
    ['raise global maxima', 'Raise the global maxima on autonomy.'],
    ['disable the tripwire', 'Drop check-invariants from CI, it is slow.']
  ])('refuses a proposal that would %s', (_label, change) => {
    const parsed = parseGymProposal(body({ change }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const check = checkWidening(parsed.proposal)
    expect(check.refused).toBe(true)
    expect(check.because.length).toBeGreaterThan(0)
  })

  it('lets an ordinary craft proposal through, so the check is not vacuous', () => {
    const parsed = parseGymProposal(body())
    if (!parsed.ok) throw new Error('expected ok')
    expect(checkWidening(parsed.proposal).refused).toBe(false)
  })

  it('reads the title and the rollback too, not only the change', () => {
    // A proposal that hides the widening in its rollback is the same proposal.
    const parsed = parseGymProposal(body({ rollback: 'If it regresses, amend ADR-0015 instead.' }))
    if (!parsed.ok) throw new Error('expected ok')
    expect(checkWidening(parsed.proposal).refused).toBe(true)
  })

  it('is a property of the PROPOSAL, not of any verdict', () => {
    // The signature takes no decider, so there is no argument an approver could
    // pass to make a widening proposal acceptable — including the Architect.
    expect(checkWidening.length).toBe(1)
  })
})

describe('R1 — nothing self-approves', () => {
  it('lets the Architect decide a proposal somebody else filed', () => {
    expect(checkVerdict(row(), 'architect', 'agent.artemis').allowed).toBe(true)
  })

  it.each(['agent.artemis', 'agent.mason', 'human', 'system'])(
    'REFUSES a verdict from %s',
    (decider) => {
      const check = checkVerdict(row(), decider, 'agent.artemis')
      expect(check.allowed).toBe(false)
      expect(check.because).toContain('R1')
    }
  )

  it('refuses a decider who is also the proposer', () => {
    const check = checkVerdict(row(), 'architect', 'architect')
    expect(check.allowed).toBe(false)
    expect(check.because).toContain('self-approve')
  })

  it('refuses a second verdict on a proposal already decided', () => {
    expect(checkVerdict(row({ status: 'approved' }), 'architect', 'agent.artemis').allowed).toBe(
      false
    )
  })
})

describe('R2 — the ledger is total', () => {
  it('never reuses an id', () => {
    expect(nextGymId([])).toBe('GYM-001')
    expect(nextGymId([row({ id: 'GYM-001' }), row({ id: 'GYM-007' })])).toBe('GYM-008')
  })

  it('keeps counting past a rejected row, because rejections are kept', () => {
    expect(nextGymId([row({ id: 'GYM-003', status: 'rejected' })])).toBe('GYM-004')
  })

  it('reads its own rows back out of the table', () => {
    const table = [
      '| ID | Title |',
      '|---|---|',
      renderRow(row()),
      renderRow(row({ id: 'GYM-002' }))
    ].join('\n')
    expect(parseLedger(table).map((r) => r.id)).toEqual(['GYM-001', 'GYM-002'])
  })

  it('ignores the placeholder row the seed archive ships with', () => {
    const seed = [
      '| ID | Title | Status |',
      '|---|---|---|',
      '| — | *(no proposals yet)* | |'
    ].join('\n')
    expect(parseLedger(seed)).toEqual([])
  })

  it('ignores prose around the table', () => {
    expect(parseLedger('# Ledger\n\nSome words.\n\nMore words.\n')).toEqual([])
  })
})

describe('FR-12.4 — an unmeasurable change is a miss, not a pass', () => {
  it('validates a measured outcome', () => {
    expect(measuredOutcome('median turns fell to 2')).toBe('validated')
  })

  it('REGRESSES when the metric could not be measured', () => {
    // A change whose effect cannot be established is not a change that worked.
    expect(measuredOutcome(null)).toBe('regressed')
  })
})

describe('R3 — improvement is budgeted, not ambient', () => {
  it('allows work inside the slice', () => {
    expect(withinSlice(10, { tokensPerWeek: 100 })).toBe(true)
  })

  it('stops at the slice, so improvement can never starve the missions', () => {
    expect(withinSlice(100, { tokensPerWeek: 100 })).toBe(false)
    expect(withinSlice(101, { tokensPerWeek: 100 })).toBe(false)
  })
})

describe('the seeded ledger is read, links and all (merge regression)', () => {
  it('reads an id written as a LINK to its proposal file', () => {
    // The build-phase archive writes `| [GYM-001](./proposals/…) | …`. A parser
    // that only accepted a bare id read a five-row ledger as EMPTY — and the
    // next mint then collided with a row already on the page. Found when the
    // Gymnasium met the archive the research department had been filling.
    const table = [
      '| ID | Title | Status | Success metric | Proposed | Decided | Measured | Outcome |',
      '|---|---|---|---|---|---|---|---|',
      '| [GYM-001](./proposals/GYM-001-stoa.md) | Stand up the Stoa | landed | a metric | 2026-08-28 | 2026-08-28 | — | |',
      '| [GYM-003](./proposals/GYM-003-closing.md) | Closing Time | landed | another | 2026-08-28 | 2026-08-28 | — | |'
    ].join('\n')

    const rows = parseLedger(table)
    expect(rows.map((r) => r.id)).toEqual(['GYM-001', 'GYM-003'])
    expect(rows[0]?.status).toBe('landed')
  })

  it('mints the NEXT id past a linked ledger, never a colliding one', () => {
    const table = [
      '| [GYM-001](./proposals/a.md) | A | landed | m | 2026-08-28 | | | |',
      '| [GYM-005](./proposals/b.md) | B | landed | m | 2026-08-28 | | | |'
    ].join('\n')
    expect(nextGymId(parseLedger(table))).toBe('GYM-006')
  })

  it('round-trips the link when a row is rewritten', () => {
    // A status change must not flatten the ledger's own formatting.
    const row = parseLedger(
      '| [GYM-002](./proposals/x.md) | X | proposed | m | 2026-08-28 | | | |'
    )[0]
    expect(row).toBeDefined()
    expect(renderRow({ ...row!, status: 'approved' })).toContain('[GYM-002](./proposals/x.md)')
  })

  it('still reads a bare id', () => {
    expect(
      parseLedger('| GYM-007 | X | proposed | m | 2026-08-28 | | | |').map((r) => r.id)
    ).toEqual(['GYM-007'])
  })
})

import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { GYM_SCHEMA_VERSION } from '../../src/shared/gym'
import { ODEON_ENDPOINT } from '../../src/shared/reserved'
import { cleanupHomes, scenarioMessage, sendStep, startCompany, type Company } from './company'

/**
 * S-GYM (TEST-STRATEGY §3, SRS §6.7, FR-12): "proposal missing a metric or
 * rollback is rejected before reaching a human; a non-architect verdict on
 * `gym.verdict` is refused; a proposal altering gym gating / an accepted ADR /
 * Watch maxima is mechanically refused regardless of approver; a landed fixture
 * proposal whose metric misses its window is rolled back and ledgered
 * `regressed`; ledger rows are append-only."
 *
 * Every clause of that spec has a case below, and every proposal is filed by a
 * REAL spawned agent through the SHIPPED endpoint — because "rejected before
 * reaching a human" is a claim about the path, not about a function.
 */

const companies: Company[] = []
afterAll(async () => {
  for (const company of companies.splice(0)) await company.close()
  cleanupHomes()
})

async function company(): Promise<Company> {
  const started = await startCompany()
  companies.push(started)
  started.hire('agent.artemis')
  return started
}

function proposalBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: GYM_SCHEMA_VERSION,
    kind: 'gym-proposal',
    title: 'Shorten the wake nudge',
    class: 'craft',
    evidence: ['log#412'],
    change: 'Trim the wake nudge prompt to two sentences.',
    costRisk: 'Low: one prompt file, reversible.',
    metric: { what: 'median turns after a wake', target: '2', windowDays: 14 },
    rollback: 'Restore the previous prompt file from git.',
    ...over
  })
}

/** A REAL spawned agent files the proposal from its own outbox. */
async function file(eph: Company, over: Record<string, unknown> = {}): Promise<void> {
  await eph.runTurn('agent.artemis', [
    sendStep(
      scenarioMessage({
        from: 'agent.artemis',
        to: ODEON_ENDPOINT,
        act: 'propose',
        subject: 'improvement',
        body: proposalBody(over)
      })
    )
  ])
  await eph.hermes.sweep()
}

function ledgerText(eph: Company): string {
  return fs.readFileSync(path.join(eph.agora.root, 'gymnasium', 'LEDGER.md'), 'utf8')
}

describe('S-GYM — a shapeless proposal never reaches a human (FR-12.2)', () => {
  it('files a complete proposal', async () => {
    const eph = await company()
    await file(eph)
    expect(eph.gymnasium.rows().map((row) => `${row.id}:${row.status}`)).toEqual([
      'GYM-001:proposed'
    ])
  })

  it('REJECTS one with no metric, before any verdict is possible', async () => {
    const eph = await company()
    await file(eph, { metric: undefined })
    expect(eph.gymnasium.rows()).toEqual([])
  })

  it('REJECTS one with no rollback', async () => {
    const eph = await company()
    await file(eph, { rollback: '' })
    expect(eph.gymnasium.rows()).toEqual([])
  })

  it('REJECTS one with no evidence — no evidence, no proposal (FR-12.1)', async () => {
    const eph = await company()
    await file(eph, { evidence: [] })
    expect(eph.gymnasium.rows()).toEqual([])
  })

  it('tells the proposer why, in words from prompts/ (invariant §8)', async () => {
    const eph = await company()
    await file(eph, { rollback: '' })
    const reply = eph
      .inbox('agent.artemis')
      .map((name) => eph.readInbox('agent.artemis', name))
      .at(-1)
    expect(reply?.act).toBe('refuse')
    expect(reply?.body).toContain('rollback')
  })
})

describe('S-GYM — authority-widening is refused REGARDLESS of approver (FR-12.3)', () => {
  it.each([
    ['an accepted ADR', 'Amend ADR-0004 so agents may commit directly.'],
    ['gym gating', 'Let Artemis approve craft-class gym gating herself.'],
    ['the Watch maxima', 'Raise the global maxima on autonomy for every profile.'],
    ['a documented invariant', 'Relax invariant §4 so agents can run git.']
  ])('refuses a proposal altering %s', async (_label, change) => {
    const eph = await company()
    await file(eph, { change })

    expect(eph.gymnasium.rows()).toEqual([])
    // Recorded on its own, because an attempt to widen authority is exactly
    // what a later reader will look for (NFR-13).
    expect(eph.agora.readLogAll().some((row) => row['event'] === 'refused-widening')).toBe(true)
  })

  it('is refused before a verdict exists, so no approver can make it acceptable', async () => {
    const eph = await company()
    await file(eph, { change: 'Amend ADR-0015 to let the Gymnasium approve itself.' })
    // Nothing to approve: the Architect never gets the chance.
    expect(eph.gymnasium.rows()).toEqual([])
    expect(eph.gymnasium.verdict('GYM-001', 'approved', 'architect').ok).toBe(false)
  })
})

describe('S-GYM — R1: a non-architect verdict is refused', () => {
  it.each(['agent.artemis', 'agent.mason', 'human'])('refuses a verdict from %s', async (who) => {
    const eph = await company()
    await file(eph)
    const outcome = eph.gymnasium.verdict('GYM-001', 'approved', who)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('R1')
    expect(eph.gymnasium.rows()[0]?.status).toBe('proposed')
  })

  it('accepts the Architect, and only the Architect', async () => {
    const eph = await company()
    await file(eph)
    expect(eph.gymnasium.verdict('GYM-001', 'approved', 'architect').ok).toBe(true)
    expect(eph.gymnasium.rows()[0]?.status).toBe('approved')
  })
})

describe('S-GYM — a missed metric rolls back and ledgers `regressed` (FR-12.4)', () => {
  it('regresses a landed change whose metric could not be measured', async () => {
    const eph = await company()
    await file(eph)
    eph.gymnasium.verdict('GYM-001', 'approved', 'architect')
    eph.gymnasium.land('GYM-001')
    eph.gymnasium.measure('GYM-001', null)

    expect(eph.gymnasium.rows()[0]?.status).toBe('regressed')
    const event = eph.agora.readLogAll().find((row) => row['event'] === 'regressed')
    expect(event).toMatchObject({ kind: 'gym', rollback: true })
  })

  it('validates one whose metric was measured', async () => {
    const eph = await company()
    await file(eph)
    eph.gymnasium.verdict('GYM-001', 'approved', 'architect')
    eph.gymnasium.land('GYM-001')
    eph.gymnasium.measure('GYM-001', 'median turns fell to 2')

    expect(eph.gymnasium.rows()[0]?.status).toBe('validated')
  })
})

describe('S-GYM — R2: ledger rows are append-only', () => {
  it('keeps a rejected row, and never reuses its id', async () => {
    const eph = await company()
    await file(eph)
    eph.gymnasium.verdict('GYM-001', 'rejected', 'architect')
    await file(eph, { title: 'A second idea' })

    expect(eph.gymnasium.rows().map((row) => `${row.id}:${row.status}`)).toEqual([
      'GYM-001:rejected',
      'GYM-002:proposed'
    ])
    expect(ledgerText(eph)).toContain('GYM-001')
  })

  it('never shrinks the ledger across a whole loop', async () => {
    const eph = await company()
    await file(eph)
    await file(eph, { title: 'A second idea' })
    const before = eph.gymnasium.rows().length

    eph.gymnasium.verdict('GYM-001', 'approved', 'architect')
    eph.gymnasium.land('GYM-001')
    eph.gymnasium.measure('GYM-001', null)

    expect(eph.gymnasium.rows().length).toBeGreaterThanOrEqual(before)
  })

  it('seeds its ledger before the first proposal is filed (FR-12.6)', async () => {
    // The rig seeds from a FIXTURE archive, not the repo’s real one — that
    // archive grows every week, and a scenario that broke because the company
    // filed another proposal would be testing the wrong thing. Continuity
    // against the REAL `docs/gymnasium/` is asserted in the unit suite, where
    // it belongs.
    const eph = await company()
    expect(eph.gymnasium.rows()).toEqual([])
    expect(ledgerText(eph)).toContain('| ID | Title | Status |')
  })
})

import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CompanyModes } from '../../src/main/modes'
import { Scheduler } from '../../src/main/scheduler'
import { GYM_SCHEMA_VERSION } from '../../src/shared/gym'
import { STOA_SCHEMA_VERSION } from '../../src/shared/stoa'
import type { CompanyMode, GymLogEvent } from '../../src/shared/mode'
import { ODEON_ENDPOINT } from '../../src/shared/reserved'
import { cleanupHomes, scenarioMessage, sendStep, startCompany, type Company } from './company'

/** The Gymnasium ledger document, as a human would open it. */
function ledgerText(eph: Company): string {
  return fs.readFileSync(path.join(eph.agora.root, 'gymnasium', 'LEDGER.md'), 'utf8')
}

/**
 * S-MODE (TEST-STRATEGY §3, SRS §6.9, FR-14):
 *
 * "enabling `improving` with proof evidence missing is refused with the missing
 * items listed; a fixture ledger meeting the §6.9 gate enables; records
 * produced under autonomy carry the mode tag; a rung-3 breaker stop on
 * gym/stoa work auto-reverts to `directed` and lands on the ledger; no
 * agent-side path (Hermes message, hook, proposal) can change the mode."
 *
 * The mode is the switch that decides whether this company acts without being
 * asked, so the last clause is the one that matters most and it is asserted the
 * way S-STOA asserts its own: not "the agent behaved" but "there is no path".
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

/** The mode driver as `index.ts` builds it, over this company's real ledger. */
function modesOf(
  eph: Company,
  state: { mode: CompanyMode | undefined; everEnabled: boolean } = {
    mode: undefined,
    everEnabled: false
  }
): { modes: CompanyModes; state: typeof state } {
  const modes = new CompanyModes({
    read: () => state,
    write: (patch) => {
      state.mode = patch.mode
      state.everEnabled = patch.everEnabled
    },
    // The gate's two permitted inputs, and only those: this company's REAL
    // Gymnasium ledger and the `gym` events on its REAL log.
    rows: () => eph.gymnasium.rows(),
    gymEvents: () =>
      eph.agora
        .readLog()
        .filter((entry) => entry['kind'] === 'gym')
        .map((entry) => ({
          event: entry['event'],
          gymId: entry['gymId'],
          evidence: entry['evidence']
        })) as GymLogEvent[],
    onLogEvent: (draft) => eph.agora.appendLog(draft),
    recordOnLedger: (change) => eph.gymnasium.recordModeChange(change),
    now: () => new Date('2026-08-28T09:00:00.000Z')
  })
  return { modes, state }
}

/**
 * Archives one real research brief through the SHIPPED endpoint.
 *
 * §6.9's "seeded by a Stoa brief" clause is only meaningful if the brief is a
 * brief — so this files one rather than citing an id nobody archived, which
 * FR-13.4 now refuses anyway.
 */
async function archiveBrief(eph: Company): Promise<string> {
  await eph.runTurn('agent.artemis', [
    sendStep(
      scenarioMessage({
        from: 'agent.artemis',
        to: ODEON_ENDPOINT,
        act: 'propose',
        subject: 'research brief',
        body: JSON.stringify({
          schemaVersion: STOA_SCHEMA_VERSION,
          kind: 'research-brief',
          sourceId: 'src-fixture-pinned',
          title: 'Turn structure',
          question: 'tags agent-loop — how the loop is structured',
          commit: 'a1b2c3d',
          findings: [
            { what: 'Planning is separate from dispatch.', citations: ['src/loop/turn.ts'] }
          ],
          applicability: [{ finding: 1, subsystem: 'SDD §7.1', note: 'Matches ours.', refs: [] }],
          candidates: [{ what: 'Name the rule in adapter docs.', fromFindings: [1] }],
          licenseNote: 'MIT; nothing needs intake.'
        })
      })
    )
  ])
  await eph.hermes.sweep()
  return eph.stoa.briefs()[0]?.id ?? ''
}

/** Drives a proposal all the way through the loop, on the SHIPPED paths. */
async function fullLoop(
  eph: Company,
  title: string,
  options: { readonly validated: boolean; readonly brief?: string }
): Promise<string> {
  await eph.runTurn('agent.artemis', [
    sendStep(
      scenarioMessage({
        from: 'agent.artemis',
        to: ODEON_ENDPOINT,
        act: 'propose',
        subject: 'improvement',
        body: JSON.stringify({
          schemaVersion: GYM_SCHEMA_VERSION,
          kind: 'gym-proposal',
          title,
          class: 'craft',
          evidence: options.brief === undefined ? ['log#412'] : [options.brief, 'log#412'],
          change: `Adjust something for ${title}.`,
          costRisk: 'Low.',
          metric: { what: 'a number', target: 'lower', windowDays: 14 },
          rollback: 'Restore the previous file.'
        })
      })
    )
  ])
  await eph.hermes.sweep()
  const id = eph.gymnasium.rows().at(-1)?.id ?? ''
  eph.gymnasium.verdict(id, 'approved', 'architect')
  eph.gymnasium.land(id)
  eph.gymnasium.measure(id, options.validated ? 'hit the target' : null)
  return id
}

describe('S-MODE — the first enable is refused until the gate is met (FR-14.3)', () => {
  it('refuses on an empty ledger, listing the missing evidence', async () => {
    const eph = await company()
    const { modes } = modesOf(eph)
    const outcome = modes.setMode('improving', 'architect')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.missing.join(' ')).toContain('full loop')
    expect(modes.mode()).toBe('directed')
  })

  it('still refuses with two proposals through the loop — three is the bar', async () => {
    const eph = await company()
    await fullLoop(eph, 'One', { validated: true, brief: await archiveBrief(eph) })
    await fullLoop(eph, 'Two', { validated: true })
    const { modes } = modesOf(eph)
    expect(modes.setMode('improving', 'architect').ok).toBe(false)
  })

  it('ENABLES on a real ledger that meets §6.9', async () => {
    const eph = await company()
    // Three through the full loop, two validated, one seeded by a brief —
    // built by driving the SHIPPED endpoint and the SHIPPED verdict path, so
    // the gate is reading a ledger the company actually produced.
    await fullLoop(eph, 'One', { validated: true, brief: await archiveBrief(eph) })
    await fullLoop(eph, 'Two', { validated: true })
    await fullLoop(eph, 'Three', { validated: false })

    const { modes } = modesOf(eph)
    const gate = modes.gate()
    expect(gate.counted).toMatchObject({ fullLoop: 3, validated: 2, stoaSeeded: 1 })
    expect(modes.setMode('improving', 'architect')).toEqual({ ok: true, mode: 'improving' })
  })

  it('lands the change on the ledger document, not only the log (UC-15)', async () => {
    const eph = await company()
    await fullLoop(eph, 'One', { validated: true, brief: await archiveBrief(eph) })
    await fullLoop(eph, 'Two', { validated: true })
    await fullLoop(eph, 'Three', { validated: false })
    const { modes } = modesOf(eph)
    modes.setMode('improving', 'architect')

    const text = ledgerText(eph)
    expect(text).toContain('## Mode changes')
    expect(text).toContain('directed → improving')
    expect(text).toContain('architect')
    // …and the three proposal rows are still on the page beside it: the
    // mode section must not have cost the ledger its table.
    expect(eph.gymnasium.rows()).toHaveLength(3)
    const events = eph.agora.readLog().filter((e) => e['kind'] === 'gym')
    expect(events.some((e) => e['event'] === 'mode-changed' && e['to'] === 'improving')).toBe(true)
  })
})

describe('S-MODE — no agent-side path can change the mode (FR-14.2)', () => {
  it.each(['agent.artemis', 'artemis', 'scheduler', 'agent.researcher'])(
    'refuses "%s" even on a passing ledger',
    async (who) => {
      const eph = await company()
      await fullLoop(eph, 'One', { validated: true, brief: await archiveBrief(eph) })
      await fullLoop(eph, 'Two', { validated: true })
      await fullLoop(eph, 'Three', { validated: false })
      const { modes } = modesOf(eph)
      expect(modes.setMode('improving', who).ok).toBe(false)
      expect(modes.mode()).toBe('directed')
    }
  )

  it('offers agents no filing that reaches the mode at all', async () => {
    const eph = await company()
    const { modes } = modesOf(eph)
    // The Odeon endpoint takes six filings and none of them is a mode change.
    // An agent asking for one gets the deck parser's refusal, and the mode is
    // untouched — there is no channel to be refused ON.
    await eph.runTurn('agent.artemis', [
      sendStep(
        scenarioMessage({
          from: 'agent.artemis',
          to: ODEON_ENDPOINT,
          act: 'propose',
          subject: 'set the company mode',
          body: JSON.stringify({ kind: 'mode', mode: 'improving' })
        })
      )
    ])
    await eph.hermes.sweep()
    expect(modes.mode()).toBe('directed')
  })
})

describe('S-MODE — autonomy is gated at the scheduler (FR-14.4)', () => {
  it('does not fire the Stoa cadence in directed, and does in improving', async () => {
    const eph = await company()
    const { modes, state } = modesOf(eph, { mode: 'directed', everEnabled: true })
    let fired = 0
    const scheduler = new Scheduler({ now: () => new Date(0) })
    scheduler.add({
      id: 'stoa-cadence',
      everyMs: 1,
      enabled: () => modes.mode() === 'improving',
      run: () => {
        fired += 1
        // FR-14.1: a record produced by autonomous initiative carries the mode
        // it ran under.
        eph.agora.appendLog({ kind: 'stoa', event: 'cadence-fired', mode: modes.mode() })
      }
    })

    await scheduler.tick()
    expect(fired).toBe(0)

    state.mode = 'improving'
    await scheduler.tick()
    expect(fired).toBe(1)

    const record = eph.agora
      .readLog()
      .filter((e) => e['kind'] === 'stoa' && e['event'] === 'cadence-fired')
      .at(-1)
    expect(record?.['mode']).toBe('improving')
  })
})

describe('S-MODE — a rung-3 stop on gym/stoa work auto-reverts (FR-14.5)', () => {
  it('reverts to directed, attributed to the breaker, on the ledger and the log', async () => {
    const eph = await company()
    const { modes } = modesOf(eph, { mode: 'improving', everEnabled: true })

    modes.revertOnBreaker('agent.researcher stopped at rung 3')

    expect(modes.mode()).toBe('directed')
    const changed = eph.agora
      .readLog()
      .filter((e) => e['kind'] === 'gym' && e['event'] === 'mode-changed')
      .at(-1)
    expect(changed).toMatchObject({ to: 'directed', by: 'breaker' })
    // FR-14.5 says "on the ledger", and the ledger is the document a human
    // opens to ask how the company came to be running itself.
    const text = ledgerText(eph)
    expect(text).toContain('## Mode changes')
    expect(text).toContain('improving → directed')
    expect(text).toContain('rung-3 stop')
    expect(text).toContain('breaker')
  })

  it('leaves the gate passed, so restoring improving does not re-prove it', async () => {
    const eph = await company()
    const { modes, state } = modesOf(eph, { mode: 'improving', everEnabled: true })
    modes.revertOnBreaker('x')
    expect(state.everEnabled).toBe(true)
    // The ledger here is EMPTY — a re-enable that re-ran the gate would refuse,
    // turning a safety stop into a demotion nobody asked for.
    expect(modes.setMode('improving', 'architect')).toEqual({ ok: true, mode: 'improving' })
  })

  it('only the Architect can restore it afterwards', async () => {
    const eph = await company()
    const { modes } = modesOf(eph, { mode: 'improving', everEnabled: true })
    modes.revertOnBreaker('x')
    expect(modes.setMode('improving', 'agent.artemis').ok).toBe(false)
    expect(modes.mode()).toBe('directed')
  })
})

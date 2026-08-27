import { afterAll, describe, expect, it } from 'vitest'
import { GATE_SCHEMA_VERSION, type GatePolicy } from '../../src/shared/gates'
import { cleanupHomes, scenarioMessage, startCompany, type Company } from './company'

/**
 * S-GATE (TEST-STRATEGY §3): "destructive op deny-by-default; remote approval
 * path tags `remote`; voice approval requires repeat-back (policy layer test
 * with scripted STT)."
 *
 * Real spawned `fake-engine` processes, a real socket, real files, real git —
 * the same rig every M2 scenario runs on. The voice and remote clauses are
 * asserted at the policy boundary with scripted stubs, per the Architect's M3
 * decision: the Herald (M6) and Harbor (M7) adapters plug into this same seam.
 */

const companies: Company[] = []
afterAll(async () => {
  for (const company of companies.splice(0)) await company.close()
  cleanupHomes()
})

async function company(gatePolicy?: GatePolicy): Promise<Company> {
  const started = await startCompany(gatePolicy ? { gatePolicy } : {})
  companies.push(started)
  return started
}

const policy = (
  rules: GatePolicy['rules'],
  autonomy: GatePolicy['autonomy'] = 'autonomous'
): GatePolicy => ({
  schemaVersion: GATE_SCHEMA_VERSION,
  autonomy,
  rules
})

describe('S-GATE — the engine asks for permission (SDD §9 choke point 1)', () => {
  it('turns a real engine notification into a packaged gate', async () => {
    const eph = await company()
    eph.hire('agent.mason')

    // A REAL fake-engine process, emitting the hook an engine emits when its
    // own permission dialog is up. Through M1 and M2 this was unmapped, and an
    // agent behind a dialog was invisible — the M1 carried item.
    await eph.runTurn('agent.mason', [
      {
        kind: 'hook',
        event: 'notification',
        payload: { message: 'Claude needs permission to run rm -rf build/' }
      },
      { kind: 'exit', code: 0 }
    ])

    const open = eph.gates.list()
    expect(open).toHaveLength(1)
    expect(open[0]?.kind).toBe('tool-permission')
    expect(open[0]?.agentId).toBe('agent.mason')
    // UC-08 step 2: what / why / blast radius / rollback, all present.
    expect(open[0]?.packaging.what).toContain('rm -rf build/')
    expect(open[0]?.packaging.why.length).toBeGreaterThan(0)
    expect(open[0]?.packaging.blastRadius.length).toBeGreaterThan(0)
    expect(open[0]?.packaging.rollback.length).toBeGreaterThan(0)
  })

  it('opens a gate even when the engine says nothing useful', async () => {
    const eph = await company()
    eph.hire('agent.mason')
    await eph.runTurn('agent.mason', [
      { kind: 'hook', event: 'notification', payload: {} },
      { kind: 'exit', code: 0 }
    ])
    // "The engine is waiting on you" is the fact that matters; losing it to a
    // missing payload field would be the stall this event exists to end.
    expect(eph.gates.list()).toHaveLength(1)
  })

  it('records the whole chain in log.jsonl (NFR-13)', async () => {
    const eph = await company()
    eph.hire('agent.mason')
    await eph.runTurn('agent.mason', [
      { kind: 'hook', event: 'notification', payload: { message: 'delete the production bucket' } },
      { kind: 'exit', code: 0 }
    ])
    const gate = eph.gates.list()[0]
    eph.gates.decide(gate?.id ?? '', 'denied')

    const gateEvents = eph.agora.readLog(0, 500).filter((entry) => entry.kind === 'gate')
    expect(gateEvents.map((entry) => entry['event'])).toEqual(['opened', 'denied'])
    // The whole chain reconstructible from the file alone.
    expect(gateEvents[0]).toMatchObject({ gateId: gate?.id, agentId: 'agent.mason' })
    expect(gateEvents[0]?.['what']).toContain('production bucket')
    expect(gateEvents[1]).toMatchObject({ gateId: gate?.id, channel: 'local' })
  })
})

describe('S-GATE — deny-by-default for destructive ops (FR-11.1)', () => {
  it('holds a destructive op under an unconfigured policy', async () => {
    const eph = await company()
    const outcome = eph.gates.submit({
      kind: 'destructive',
      agentId: 'agent.mason',
      packaging: {
        what: 'drop the production database',
        why: 'the migration needs a clean slate',
        blastRadius: 'all production data',
        rollback: 'restore from last night’s backup, losing today’s writes'
      }
    })
    expect(outcome.held).toBe(true)
    expect(outcome.decision.because).toBe('no-rule')
  })

  it('still holds it when the policy permits a DIFFERENT class', async () => {
    // The absence of a rule is a refusal — a policy written for spend does not
    // quietly authorise destruction.
    const eph = await company(
      policy([{ kind: 'spend', autonomy: 'autonomous', maxSpendTokens: 100 }])
    )
    expect(
      eph.gates.submit({
        kind: 'destructive',
        agentId: 'agent.mason',
        packaging: { what: 'w', why: 'y', blastRadius: 'b', rollback: 'r' }
      }).held
    ).toBe(true)
  })
})

describe('S-GATE — the remote approval path tags `remote` (NFR-9)', () => {
  it('holds a remote-channel request the policy did not open to remote', async () => {
    const eph = await company(policy([{ kind: 'destructive', autonomy: 'autonomous' }]))
    // Scripted stub for the Harbor's bridge (M7 plugs into this same seam).
    const outcome = eph.gates.submit({
      kind: 'destructive',
      agentId: 'agent.mason',
      channel: 'remote',
      packaging: { what: 'w', why: 'y', blastRadius: 'b', rollback: 'r' }
    })
    expect(outcome.held).toBe(true)
    expect(outcome.decision.because).toBe('channel')
  })

  it('refuses a remote APPROVAL the policy never admitted, and keeps the gate open', async () => {
    const eph = await company()
    const outcome = eph.gates.submit({
      kind: 'destructive',
      agentId: 'agent.mason',
      packaging: { what: 'w', why: 'y', blastRadius: 'b', rollback: 'r' }
    })
    // NFR-9 binds on the APPROVAL, not only on the request. A gate held under
    // deny-by-default matched no rule by definition, so checking the channel
    // only on the way in left the clause binding on nothing at all.
    const refused = eph.gates.decide(outcome.held ? outcome.gate.id : '', 'approved', {
      channel: 'remote'
    })
    expect(refused.ok).toBe(false)
    expect(eph.gates.list()).toHaveLength(1)
  })

  it('tags the verdict with the channel, once the policy admits that channel', async () => {
    const eph = await company(
      policy([{ kind: 'needs-human', autonomy: 'supervised', channels: ['local', 'remote'] }])
    )
    const outcome = eph.gates.submit({
      kind: 'needs-human',
      agentId: 'agent.mason',
      // Held because the profile composes down to `manual`, not because the
      // channel is closed — so the remote verdict below is admissible.
      profileAutonomy: 'manual',
      packaging: { what: 'w', why: 'y', blastRadius: 'b', rollback: 'r' }
    })
    expect(outcome.held).toBe(true)
    expect(
      eph.gates.decide(outcome.held ? outcome.gate.id : '', 'approved', { channel: 'remote' }).ok
    ).toBe(true)
    const settled = eph.agora
      .readLog(0, 500)
      .filter((e) => e.kind === 'gate' && e['event'] === 'approved')
    expect(settled[0]).toMatchObject({ channel: 'remote' })
  })
})

describe('S-GATE — voice approval requires repeat-back (NFR-9)', () => {
  const voicePolicy = policy([
    {
      kind: 'destructive',
      autonomy: 'autonomous',
      channels: ['local', 'voice'],
      requireRepeatBack: true
    }
  ])

  it('refuses a voice approval that was not repeated back, and keeps the gate open', async () => {
    const eph = await company(voicePolicy)
    const outcome = eph.gates.submit({
      kind: 'destructive',
      agentId: 'agent.mason',
      channel: 'voice',
      packaging: { what: 'delete the release branch', why: 'y', blastRadius: 'b', rollback: 'r' }
    })
    expect(outcome.held).toBe(true)
    const gateId = outcome.held ? outcome.gate.id : ''
    expect(outcome.held && outcome.gate.requiresRepeatBack).toBe(true)

    // Scripted STT: the Architect said "yes" but never repeated the action back.
    const refused = eph.gates.decide(gateId, 'approved', { channel: 'voice' })
    expect(refused.ok).toBe(false)
    expect(eph.gates.list()).toHaveLength(1)

    // Now with the repeat-back the surface confirms.
    expect(
      eph.gates.decide(gateId, 'approved', { channel: 'voice', repeatBackConfirmed: true }).ok
    ).toBe(true)
    expect(eph.gates.list()).toHaveLength(0)
  })

  it('does not demand repeat-back of a click at the keyboard', async () => {
    const eph = await company(voicePolicy)
    const outcome = eph.gates.submit({
      kind: 'destructive',
      agentId: 'agent.mason',
      packaging: { what: 'w', why: 'y', blastRadius: 'b', rollback: 'r' }
    })
    expect(outcome.held).toBe(false)
  })
})

describe('S-GATE — Hermes needs_human (SDD §9 choke point 2)', () => {
  it('opens a gate when a real delivered message is flagged for a human', async () => {
    const eph = await company()
    eph.hire('agent.mason')
    eph.hire('agent.scribe')

    const message = {
      ...scenarioMessage({
        from: 'agent.mason',
        to: 'agent.scribe',
        act: 'propose' as const,
        subject: 'drop the staging database and re-seed'
      }),
      needs_human: true
    }
    // A REAL fake-engine process writes it to its own outbox; real Hermes
    // delivers it.
    await eph.runTurn('agent.mason', [
      { kind: 'write-outbox', message },
      { kind: 'exit', code: 0 }
    ])
    await eph.hermes.sweep()

    // Delivered AND gated: escalation never swallows mail (FR-3.3).
    expect(eph.inbox('agent.scribe')).toHaveLength(1)
    const open = eph.gates.list()
    expect(open).toHaveLength(1)
    expect(open[0]?.kind).toBe('needs-human')
    expect(open[0]?.packaging.what).toContain('staging database')
  })

  it('leaves ordinary mail ungated', async () => {
    const eph = await company()
    eph.hire('agent.mason')
    eph.hire('agent.scribe')
    await eph.runTurn('agent.mason', [
      {
        kind: 'write-outbox',
        message: scenarioMessage({ from: 'agent.mason', to: 'agent.scribe', subject: 'status' })
      },
      { kind: 'exit', code: 0 }
    ])
    await eph.hermes.sweep()
    expect(eph.inbox('agent.scribe')).toHaveLength(1)
    expect(eph.gates.list()).toEqual([])
  })
})

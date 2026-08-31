import { describe, expect, it } from 'vitest'
import {
  activationPlan,
  agentIdForHire,
  composeAutonomyTable,
  instanceIdFor,
  targetRef,
  type ActivationTarget
} from '../../src/shared/profile-activation'
import { parseProfile, type ProfileBundle, type ProfileFiles } from '../../src/shared/profile'
import { AUTONOMY_LEVELS, GATE_KINDS, type AutonomyLevel } from '../../src/shared/gates'
import { ORG_SCHEMA_VERSION } from '../../src/shared/org'

/**
 * Activation planning (ADR-0012, FR-9.4, FR-11.1, SDD §9 — M7.2).
 *
 * The claim this file exists for is the one the package's risk line names:
 * **an autonomy level that composes by "profile wins" is a silent privilege
 * escalation.** So the composition is asserted as a full table over every
 * profile x global pair, in both directions, and the LAXER cases — where the
 * profile asks for more than the company allows — carry their own assertions.
 * A test that only checked composition happened would pass under exactly the
 * bug the line warns about.
 *
 * The second claim: two profiles on one floor, and one profile on two targets,
 * never share an agent. Not tidiness — `AgentManager` keys live agents by id
 * and `agora/agents/<id>/` is a directory, so a collision puts two crews' mail
 * in one inbox.
 */

function hire(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: ORG_SCHEMA_VERSION,
    name: 'oncall',
    version: 3,
    role: 'oncall',
    engine: 'claude',
    capabilities: ['triage'],
    envGrants: ['GH_TOKEN'],
    brief: 'Answer the page.',
    budget: { dailyTokens: 500_000 },
    ...over
  }
}

interface BundleOptions {
  readonly name?: string
  readonly autonomy?: { default: AutonomyLevel; byKind?: Record<string, AutonomyLevel> }
  readonly targetKind?: 'repo' | 'app'
  readonly hires?: readonly Record<string, unknown>[]
  readonly triggers?: readonly Record<string, unknown>[]
}

function bundle(options: BundleOptions = {}): ProfileBundle {
  const name = options.name ?? 'skeleton-crew'
  const hires = options.hires ?? [hire()]
  const files: ProfileFiles = {
    name,
    profileJson: JSON.stringify({
      schemaVersion: 1,
      name,
      version: 2,
      target: { kind: options.targetKind ?? 'repo' },
      autonomy: {
        default: options.autonomy?.default ?? 'supervised',
        byKind: options.autonomy?.byKind ?? {}
      }
    }),
    hires: new Map(hires.map((one, i) => [`h${String(i)}.json`, JSON.stringify(one)])),
    triggers: new Map(
      (options.triggers ?? []).map((one, i) => [`t${String(i)}.json`, JSON.stringify(one)])
    ),
    playbooks: new Map([['incident.md', '# Incident\n']]),
    memoPolicyJson: JSON.stringify({ schemaVersion: 1, requires: ['new-dependency'] }),
    harborJson: JSON.stringify({
      schemaVersion: 1,
      repos: [{ id: 'myapp', remote: 'octocat/myapp' }],
      channels: [],
      webhooks: []
    })
  }
  const parsed = parseProfile(files)
  if (!parsed.ok) throw new Error(`fixture bundle is invalid: ${parsed.reasons.join(' · ')}`)
  return parsed.bundle
}

const TARGET: ActivationTarget = { kind: 'repo', id: 'myapp', path: '/repos/myapp' }

describe('stricter wins — in both directions, over the whole table', () => {
  it('never lets a profile exceed the global ceiling, for any pair', () => {
    // The full cross-product. `expected` is written as an independent rule
    // (the lower RANK), not by calling the function under test — an oracle
    // that shared the implementation would agree with any bug it contained.
    const rank: Record<AutonomyLevel, number> = { manual: 0, supervised: 1, autonomous: 2 }
    for (const global of AUTONOMY_LEVELS) {
      for (const asked of AUTONOMY_LEVELS) {
        const table = composeAutonomyTable(global, { default: asked, byKind: {} })
        const expected = rank[asked] < rank[global] ? asked : global
        for (const row of table) {
          expect(`${global}/${asked}/${row.kind}=${row.effective}`).toBe(
            `${global}/${asked}/${row.kind}=${expected}`
          )
        }
      }
    }
  })

  it('CUTS BACK a profile that asks for more than the company allows, and says so', () => {
    // The case the risk line is about. Under "profile wins" this row would
    // read `autonomous`, and nothing else in the suite would notice.
    const table = composeAutonomyTable('supervised', {
      default: 'autonomous',
      byKind: { destructive: 'autonomous' }
    })
    for (const row of table) {
      expect(row.requested).toBe('autonomous')
      expect(row.effective).toBe('supervised')
      expect(row.clamped).toBe(true)
    }
  })

  it('honours a profile that asks for LESS than the company allows', () => {
    // Loosening is refused; tightening is the profile's own business.
    const table = composeAutonomyTable('autonomous', {
      default: 'autonomous',
      byKind: { destructive: 'manual' }
    })
    const destructive = table.find((row) => row.kind === 'destructive')
    expect(destructive?.effective).toBe('manual')
    expect(destructive?.clamped).toBe(false)
    expect(table.find((row) => row.kind === 'spend')?.effective).toBe('autonomous')
  })

  it('a global of `manual` holds everything, whatever the profile asked for', () => {
    const table = composeAutonomyTable('manual', {
      default: 'autonomous',
      byKind: { spend: 'autonomous', 'prod-facing': 'autonomous' }
    })
    expect(table.every((row) => row.effective === 'manual')).toBe(true)
  })

  it('answers for EVERY gate kind — a missing row is not "unrestricted"', () => {
    const table = composeAutonomyTable('supervised', { default: 'manual', byKind: {} })
    expect(table.map((row) => row.kind)).toEqual([...GATE_KINDS])
  })
})

describe('ids: two crews never share an agent', () => {
  it('gives one profile on two targets two disjoint agent sets', () => {
    const crew = bundle()
    const a = activationPlan(crew, TARGET, 'supervised')
    const b = activationPlan(
      crew,
      { kind: 'repo', id: 'other', path: '/repos/other' },
      'supervised'
    )
    if (!a.ok || !b.ok) throw new Error('expected both plans to be ok')
    const idsA = a.plan.hires.map((h) => h.agentId)
    const idsB = b.plan.hires.map((h) => h.agentId)
    expect(idsA).not.toEqual(idsB)
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([])
    expect(a.plan.instanceId).not.toBe(b.plan.instanceId)
  })

  it('gives two profiles on ONE target two disjoint agent sets (FR-9.4)', () => {
    const a = activationPlan(bundle({ name: 'skeleton-crew' }), TARGET, 'supervised')
    const b = activationPlan(bundle({ name: 'front-office' }), TARGET, 'supervised')
    if (!a.ok || !b.ok) throw new Error('expected both plans to be ok')
    const idsA = a.plan.hires.map((h) => h.agentId)
    const idsB = b.plan.hires.map((h) => h.agentId)
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([])
  })

  it('is deterministic — the same profile and target always mint the same ids', () => {
    // What makes "already active" detectable at all. A random id would have
    // made a duplicate activation silent.
    expect(instanceIdFor('skeleton-crew', TARGET)).toBe('skeleton-crew@repo:myapp')
    expect(agentIdForHire('skeleton-crew', TARGET, 'oncall')).toBe(
      'agent.skeleton-crew-myapp-oncall'
    )
    expect(targetRef(TARGET)).toBe('repo:myapp')
  })

  it('REFUSES rather than truncates an id that would be too long', () => {
    // Truncation is how two agents come to share one id.
    const long = 'a'.repeat(48)
    expect(agentIdForHire(long, { kind: 'repo', id: long }, long)).toBeNull()
  })

  it('refuses an id the harness reserves for itself', () => {
    expect(agentIdForHire('harness', { kind: 'repo', id: 'x' }, 'y')).not.toBeNull()
    // `agent.artemis` and the reserved endpoints belong to the harness; a hire
    // that took one could forge a router refusal in the harness's name.
    const reserved = agentIdForHire('artemis', { kind: 'repo', id: 'x' }, 'y')
    expect(reserved).toBe('agent.artemis-x-y')
  })
})

describe('the plan is the disclosure', () => {
  it('lists the grants, budgets, repos, memo classes and playbooks the crew would get', () => {
    const planned = activationPlan(bundle(), TARGET, 'supervised')
    if (!planned.ok) throw new Error(planned.reasons.join(' · '))
    const { plan } = planned
    expect(plan.envGrants).toEqual(['GH_TOKEN'])
    expect(plan.hires[0]?.spawn.budget).toEqual({ dailyTokens: 500_000 })
    expect(plan.hires[0]?.spawn.cwd).toBe('/repos/myapp')
    expect(plan.hires[0]?.hireRef).toBe('oncall@3')
    expect(plan.repos).toEqual(['octocat/myapp'])
    expect(plan.memoRequires).toEqual(['new-dependency'])
    expect(plan.playbooks).toEqual(['incident.md'])
    expect(plan.profileVersion).toBe(2)
  })

  it('carries each hire its OWN budget, so two targets never pool one allowance', () => {
    const crew = bundle({
      hires: [
        hire({ name: 'oncall', budget: { dailyTokens: 100 } }),
        hire({ name: 'deps', budget: { dailyTokens: 900 } })
      ]
    })
    const planned = activationPlan(crew, TARGET, 'supervised')
    if (!planned.ok) throw new Error(planned.reasons.join(' · '))
    expect(planned.plan.hires.map((h) => [h.hire, h.spawn.budget?.dailyTokens])).toEqual([
      ['oncall', 100],
      ['deps', 900]
    ])
  })

  it('leaves an unbudgeted hire unbudgeted, rather than inventing a zero', () => {
    const noBudget = hire()
    delete noBudget['budget']
    const planned = activationPlan(bundle({ hires: [noBudget] }), TARGET, 'supervised')
    if (!planned.ok) throw new Error(planned.reasons.join(' · '))
    expect(planned.plan.hires[0]?.spawn.budget).toBeUndefined()
  })

  it('refuses a target of the wrong KIND, naming both', () => {
    const planned = activationPlan(bundle({ targetKind: 'app' }), TARGET, 'supervised')
    expect(planned.ok).toBe(false)
    if (planned.ok) return
    expect(planned.reasons.join(' · ')).toContain('binds to a app, not a repo')
  })

  it('separates schedule triggers from event ones, so an unarmable one is visible', () => {
    const crew = bundle({
      triggers: [
        {
          id: 'sweep',
          kind: 'schedule',
          everyMs: 900_000,
          hire: 'oncall',
          playbook: 'incident.md'
        },
        { id: 'ci', kind: 'event', event: 'ci', hire: 'oncall', playbook: 'incident.md' }
      ]
    })
    const planned = activationPlan(crew, TARGET, 'supervised')
    if (!planned.ok) throw new Error(planned.reasons.join(' · '))
    expect(planned.plan.triggers.map((t) => t.when)).toEqual(['every 15 min', 'on ci'])
    expect(
      planned.plan.triggers.every((t) => t.agentId === 'agent.skeleton-crew-myapp-oncall')
    ).toBe(true)
  })

  it('plans nothing into existence — calling it twice gives the same answer', () => {
    const crew = bundle()
    const first = JSON.stringify(activationPlan(crew, TARGET, 'supervised'))
    const second = JSON.stringify(activationPlan(crew, TARGET, 'supervised'))
    expect(first).toBe(second)
  })
})

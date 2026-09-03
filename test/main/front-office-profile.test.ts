import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProfileStore } from '../../src/main/profiles'
import { activationPlan } from '../../src/shared/profile-activation'
import { dispositionFor } from '../../src/shared/outbound'
import { AUTONOMY_LEVELS, AUTONOMY_RANK, type AutonomyLevel } from '../../src/shared/gates'

/**
 * The Front Office built-in profile (FR-9.3, UC-10 — M7.5).
 *
 * The second half of ADR-0012's dogfood test. M7.4 proved the schema sufficient
 * for the Skeleton Crew; this suite asks the same question of a profile with a
 * genuinely different shape — one whose defining feature is a configurable
 * OUTBOUND ladder rather than an incident path.
 *
 * As with M7.4, every assertion runs against the REAL bundle shipped in
 * `profiles/` through the REAL loader. The one schema change this package
 * needed — the `outbound` gate kind — was an Architect decision recorded before
 * it was made, not a quiet widening discovered here.
 */

const REPO_ROOT = path.join(__dirname, '..', '..')
const BUILTIN_DIR = path.join(REPO_ROOT, 'profiles')

function builtinStore(): ProfileStore {
  return new ProfileStore(path.join(REPO_ROOT, 'test', '.no-such-home'), BUILTIN_DIR)
}

function frontOffice() {
  const loaded = builtinStore().load('front-office')
  if (!loaded.ok) throw new Error(`front-office did not load: ${loaded.reasons.join('; ')}`)
  return loaded.bundle
}

describe('front-office ships as an ordinary ADR-0012 bundle', () => {
  it('loads through the real loader with no reasons', () => {
    const loaded = builtinStore().load('front-office')
    expect(loaded.ok ? [] : loaded.reasons).toEqual([])
    expect(loaded.ok).toBe(true)
  })

  it('uses only files an Architect could write by hand', () => {
    const dir = path.join(BUILTIN_DIR, 'front-office')
    expect(fs.readdirSync(dir).sort()).toEqual([
      'harbor.json',
      'hires',
      'memo-policy.json',
      'playbooks',
      'profile.json',
      'triggers'
    ])
  })

  it('carries every component FR-9.3 names', () => {
    const bundle = frontOffice()
    // "issue/PR triage, reply drafting …, docs/changelog sync, and
    // release-prep checklists".
    expect(bundle.hires.map((hire) => hire.name).sort()).toEqual([
      'docs-agent',
      'release-manager',
      'triage-agent'
    ])
    expect(bundle.playbooks.map((playbook) => playbook.file).sort()).toEqual([
      'docs-sync.md',
      'release-prep.md',
      'reply.md',
      'triage.md'
    ])
  })

  it('coexists with the Skeleton Crew — two profiles, no shared agent', () => {
    // FR-9.4: multiple profiles coexist on one floor.
    const names = builtinStore()
      .list()
      .map((row) => row.name)
    expect(names).toContain('front-office')
    expect(names).toContain('skeleton-crew')

    const target = { kind: 'repo' as const, id: 'myapp', path: REPO_ROOT }
    const office = activationPlan(frontOffice(), target, 'autonomous', () => [])
    const crewLoaded = builtinStore().load('skeleton-crew')
    if (!office.ok || !crewLoaded.ok) throw new Error('both built-ins must load')
    const crew = activationPlan(crewLoaded.bundle, target, 'autonomous', () => [])
    if (!crew.ok) throw new Error(crew.reasons.join('; '))

    const officeIds = office.plan.hires.map((hire) => hire.agentId)
    const crewIds = crew.plan.hires.map((hire) => hire.agentId)
    // Same target, two profiles: not one id in common, or the two crews' mail
    // would land in one inbox.
    expect(officeIds.filter((id) => crewIds.includes(id))).toEqual([])
  })
})

describe('the shipped Front Office is draft-only', () => {
  it('asks for `manual` on outbound, so nothing is posted out of the box', () => {
    const bundle = frontOffice()
    expect(bundle.document.autonomy.byKind.outbound).toBe('manual')
    // …and that is the rung that files rather than sends.
    expect(dispositionFor('manual').kind).toBe('file')
  })

  it('stays draft-only however permissive the global ceiling is', () => {
    const bundle = frontOffice()
    for (const global of AUTONOMY_LEVELS) {
      const planned = activationPlan(
        bundle,
        { kind: 'repo', id: 'myapp', path: REPO_ROOT },
        global as AutonomyLevel,
        () => []
      )
      if (!planned.ok) throw new Error(planned.reasons.join('; '))
      const outbound = planned.plan.autonomy.find((row) => row.kind === 'outbound')
      expect(outbound?.effective).toBe('manual')
    }
  })

  it('never widens any class past the global ceiling', () => {
    const bundle = frontOffice()
    for (const global of AUTONOMY_LEVELS) {
      const planned = activationPlan(
        bundle,
        { kind: 'repo', id: 'myapp', path: REPO_ROOT },
        global as AutonomyLevel,
        () => []
      )
      if (!planned.ok) throw new Error(planned.reasons.join('; '))
      for (const row of planned.plan.autonomy) {
        expect(AUTONOMY_RANK[row.effective]).toBeLessThanOrEqual(
          AUTONOMY_RANK[global as AutonomyLevel]
        )
        expect(AUTONOMY_RANK[row.effective]).toBeLessThanOrEqual(AUTONOMY_RANK[row.requested])
      }
    }
  })

  it('composes outbound INDEPENDENTLY of prod-facing', () => {
    // The reason the Architect added a seventh gate kind. A profile that raised
    // `outbound` to auto-post must not thereby gain autonomous production
    // actions — so the plan must carry them as separate rows with separately
    // computed answers.
    const bundle = frontOffice()
    const raised = {
      ...bundle,
      document: {
        ...bundle.document,
        autonomy: {
          ...bundle.document.autonomy,
          byKind: { ...bundle.document.autonomy.byKind, outbound: 'autonomous' as const }
        }
      }
    }
    const planned = activationPlan(
      raised,
      { kind: 'repo', id: 'myapp', path: REPO_ROOT },
      'autonomous',
      () => []
    )
    if (!planned.ok) throw new Error(planned.reasons.join('; '))
    const byKind = Object.fromEntries(planned.plan.autonomy.map((row) => [row.kind, row.effective]))
    expect(byKind.outbound).toBe('autonomous')
    // Untouched, and still manual. If these were one kind this would be
    // `autonomous` too, which is precisely the coupling that was rejected.
    expect(byKind['prod-facing']).toBe('manual')
  })
})

describe('the outbound kind reaches the plan at all', () => {
  it('appears as its own row in every activation plan', () => {
    // A gate kind nothing surfaces is a knob the Architect cannot see. The
    // activation screen reads this list to show what a profile MAY do.
    const planned = activationPlan(
      frontOffice(),
      { kind: 'repo', id: 'myapp', path: REPO_ROOT },
      'supervised',
      () => []
    )
    if (!planned.ok) throw new Error(planned.reasons.join('; '))
    expect(planned.plan.autonomy.map((row) => row.kind)).toContain('outbound')
  })
})

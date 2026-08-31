import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProfileStore } from '../../src/main/profiles'
import { activationPlan } from '../../src/shared/profile-activation'
import { AUTONOMY_LEVELS, type AutonomyLevel } from '../../src/shared/gates'
import { MEMO_TRIGGERS } from '../../src/shared/memo'

/**
 * The Skeleton Crew built-in profile (FR-9.2, UC-09 — M7.4).
 *
 * This suite exists to test ONE claim, and it is ADR-0012's central one:
 * "Skeleton Crew and Front Office ship built-in as **ordinary profiles** — they
 * exercise no private APIs, proving the format is sufficient" (the dogfood rule,
 * NFR-12).
 *
 * So every assertion below runs against the REAL bundle shipped in `profiles/`,
 * through the REAL loader, with no fixture and no test-only construction path.
 * If the built-in ever needs a field the public schema does not have, or a
 * loader flag no Architect could set from a text editor, this suite goes red —
 * which is the only way that claim stays true rather than merely stated.
 *
 * The M6 lesson applies directly: a built-in validated by a bespoke fixture is
 * two halves that have never met.
 */

const REPO_ROOT = path.join(__dirname, '..', '..')
const BUILTIN_DIR = path.join(REPO_ROOT, 'profiles')

/** The store as production builds it, with an empty home so builtin answers. */
function builtinStore(): ProfileStore {
  return new ProfileStore(path.join(REPO_ROOT, 'test', '.no-such-home'), BUILTIN_DIR)
}

describe('skeleton-crew ships as an ordinary ADR-0012 bundle', () => {
  it('loads through the real loader with no reasons', () => {
    const loaded = builtinStore().load('skeleton-crew')
    // The refusal list is the message: printing it makes a schema mismatch
    // legible instead of "expected true, got false".
    expect(loaded.ok ? [] : loaded.reasons).toEqual([])
    expect(loaded.ok).toBe(true)
  })

  it('is listed as a valid builtin', () => {
    const row = builtinStore()
      .list()
      .find((candidate) => candidate.name === 'skeleton-crew')
    expect(row).toEqual({ name: 'skeleton-crew', source: 'builtin', valid: true, version: 1 })
  })

  it('carries every component FR-9.2 names', () => {
    const loaded = builtinStore().load('skeleton-crew')
    if (!loaded.ok) throw new Error(loaded.reasons.join('; '))
    const { bundle } = loaded

    // FR-9.2: "health-check watcher, CI babysitter …, dependency-update agent
    // …, and incident-response playbooks with severity-based escalation".
    expect(bundle.hires.map((hire) => hire.name).sort()).toEqual([
      'ci-babysitter',
      'dependency-updater',
      'health-watcher'
    ])
    expect(bundle.playbooks.map((playbook) => playbook.file).sort()).toEqual([
      'dependency-update.md',
      'health-check.md',
      'incident.md'
    ])
    // UC-09 step 1: "a health check or CI webhook signals a failure".
    const triggers = bundle.triggers
    expect(triggers.find((trigger) => trigger.id === 'ci-failure')?.kind).toBe('event')
    expect(triggers.find((trigger) => trigger.id === 'health-sweep')?.kind).toBe('schedule')
    expect(triggers.find((trigger) => trigger.id === 'dependency-sweep')?.kind).toBe('schedule')
  })

  it('uses only files an Architect could write by hand', () => {
    // The bundle is exactly ADR-0012's listing — no extra file, no private
    // sidecar the loader knows about and the format does not.
    const dir = path.join(BUILTIN_DIR, 'skeleton-crew')
    expect(fs.readdirSync(dir).sort()).toEqual([
      'harbor.json',
      'hires',
      'memo-policy.json',
      'playbooks',
      'profile.json',
      'triggers'
    ])
  })

  it('holds the dependency agent to a memo before it can add a dependency', () => {
    const loaded = builtinStore().load('skeleton-crew')
    if (!loaded.ok) throw new Error(loaded.reasons.join('; '))
    // ADR-0008's trigger, declared as data rather than asked for in prose —
    // the dependency-updater's playbook says the same thing, but the playbook
    // is not what holds the action.
    expect(loaded.bundle.memoPolicy.requires).toContain('new-dependency')
    for (const required of loaded.bundle.memoPolicy.requires) {
      expect(MEMO_TRIGGERS).toContain(required)
    }
  })

  it('declares GH_TOKEN by name only, and only for the roles that act on GitHub', () => {
    const loaded = builtinStore().load('skeleton-crew')
    if (!loaded.ok) throw new Error(loaded.reasons.join('; '))
    const grants = Object.fromEntries(
      loaded.bundle.hires.map((hire) => [hire.name, [...hire.envGrants]])
    )
    // Least privilege (ADR-0010): the watcher observes and holds nothing.
    expect(grants['health-watcher']).toEqual([])
    expect(grants['ci-babysitter']).toEqual(['GH_TOKEN'])
    expect(grants['dependency-updater']).toEqual(['GH_TOKEN'])
    // Names, never values — a template carrying a secret VALUE would be a leak.
    const raw = fs.readFileSync(
      path.join(BUILTIN_DIR, 'skeleton-crew', 'hires', 'ci-babysitter.json'),
      'utf8'
    )
    expect(raw).not.toMatch(/gh[pousr]_[A-Za-z0-9]{16,}/)
  })
})

describe('skeleton-crew cannot grant itself latitude', () => {
  const target = { kind: 'repo' as const, id: 'myapp', path: REPO_ROOT }

  it('asks for manual on every irreversible class', () => {
    const loaded = builtinStore().load('skeleton-crew')
    if (!loaded.ok) throw new Error(loaded.reasons.join('; '))
    const { autonomy } = loaded.bundle.document
    // The first outward-facing irreversible acts this crew can take — opening a
    // PR, force-pushing, touching production, spending — are the ones it asks
    // for the LEAST latitude on. A built-in that shipped `autonomous` here
    // would be teaching every profile derived from it the wrong default.
    expect(autonomy.byKind.destructive).toBe('manual')
    expect(autonomy.byKind['prod-facing']).toBe('manual')
    expect(autonomy.byKind.spend).toBe('manual')
    expect(autonomy.byKind['scope-change']).toBe('manual')
  })

  it('is clamped by a stricter global ceiling, never widened by a laxer one', () => {
    const loaded = builtinStore().load('skeleton-crew')
    if (!loaded.ok) throw new Error(loaded.reasons.join('; '))

    for (const global of AUTONOMY_LEVELS) {
      const planned = activationPlan(loaded.bundle, target, global as AutonomyLevel)
      if (!planned.ok) throw new Error(planned.reasons.join('; '))
      for (const row of planned.plan.autonomy) {
        const rank = { manual: 0, supervised: 1, autonomous: 2 } as const
        // The direction is the assertion, not the presence: effective is never
        // more permissive than EITHER side. This is the M7.2 property restated
        // against the real built-in, because a profile shipping in the box is
        // exactly where a silent privilege escalation would be least noticed.
        expect(rank[row.effective]).toBeLessThanOrEqual(rank[global as AutonomyLevel])
        expect(rank[row.effective]).toBeLessThanOrEqual(rank[row.requested])
      }
    }
  })

  it('ships watching no repository, so a fresh install reaches nothing', () => {
    const loaded = builtinStore().load('skeleton-crew')
    if (!loaded.ok) throw new Error(loaded.reasons.join('; '))
    // A built-in that shipped with somebody else's remote in it would ingest
    // from a repository the Architect never registered. The Architect adds
    // theirs — which is the "buildable with a text editor" claim in the one
    // place it actually matters.
    expect(loaded.bundle.harbor.repos).toEqual([])
  })
})

import fs from 'node:fs'
import { deriveRepo } from '../../src/shared/repo-remote'
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
    // A store built with no remembered-targets provider offers none, which is
    // what an Ephesus that has never activated anything should show.
    expect(row).toEqual({
      name: 'skeleton-crew',
      source: 'builtin',
      valid: true,
      // Bumped to 2 when the `verifier` hire was added, and to 3 when the
      // bundle declared its isolation and exit policy (M8.6). ADR-0012 makes
      // the version a record rather than decoration ("profile versioning
      // doubles as the performance-review changelog"), so a bundle that
      // changes what its crew may do and keeps its number is lying about what
      // an Architect approved.
      version: 3,
      knownTargets: []
    })
  })

  it('carries every component FR-9.2 names', () => {
    const loaded = builtinStore().load('skeleton-crew')
    if (!loaded.ok) throw new Error(loaded.reasons.join('; '))
    const { bundle } = loaded

    // FR-9.2: "health-check watcher, CI babysitter …, dependency-update agent
    // …, and incident-response playbooks with severity-based escalation".
    //
    // `verifier` is the fourth and is NOT one FR-9.2 names. It is the profile
    // exercising the format rather than the format growing a feature: a hire
    // file, a budget and a brief, with no schema field and no private API — the
    // `VERIFIER_HIRE` convention is a name the wiring looks for in an ordinary
    // hires list. That it can be added this way is ADR-0012's dogfood claim
    // holding; if it had needed a schema change, the claim would have been false.
    expect(bundle.hires.map((hire) => hire.name).sort()).toEqual([
      'ci-babysitter',
      'dependency-updater',
      'health-watcher',
      'verifier'
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

  /**
   * Rewritten 2026-09-01 on the Architect's instruction, and the old case is
   * worth stating because its argument was good: a built-in that ships
   * `autonomous` teaches every profile derived from it that default.
   *
   * What changed is which risk dominates. Blanket `manual` meant the crew
   * stopped for a human on routine work — spend in particular, which fired for
   * all three agents inside a minute of a live run and interrupted the Architect
   * to approve a limit that was itself miscalibrated. A profile that asks
   * permission for everything is not cautious, it is unusable, and an unusable
   * safety posture gets switched off wholesale.
   *
   * So the irreversible OUTWARD acts keep a check and the routine ones do not.
   * `destructive` and `prod-facing` are `supervised` rather than `autonomous`:
   * that is a deliberate middle, and it is the one choice here the Architect did
   * not name explicitly.
   */
  it('keeps a check on the irreversible acts, and lets routine work run', () => {
    const loaded = builtinStore().load('skeleton-crew')
    if (!loaded.ok) throw new Error(loaded.reasons.join('; '))
    const { autonomy } = loaded.bundle.document
    expect(autonomy.default).toBe('autonomous')
    // Outward and irreversible: still not the agent's call alone.
    expect(autonomy.byKind.destructive).toBe('supervised')
    expect(autonomy.byKind['prod-facing']).toBe('supervised')
    // Routine: no longer a reason to stop the company and ask.
    expect(autonomy.byKind.spend).toBeUndefined()
    expect(autonomy.byKind['scope-change']).toBeUndefined()
  })

  it('is clamped by a stricter global ceiling, never widened by a laxer one', () => {
    const loaded = builtinStore().load('skeleton-crew')
    if (!loaded.ok) throw new Error(loaded.reasons.join('; '))

    for (const global of AUTONOMY_LEVELS) {
      const planned = activationPlan(
        loaded.bundle,
        target,
        global as AutonomyLevel,
        () => [],
        deriveRepo([])
      )
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

/**
 * B10/B12 as SHIPPED (M8.6). The unit tests prove the composition; this proves
 * the two bundles an Architect actually activates declare what they should.
 *
 * Asserted against the real files on disk rather than a fixture, because the
 * defect being prevented is precisely a bundle that says nothing: for the whole
 * production life of the profile spawn path, both bundles declared no
 * isolation, so every hire ran git operations in the Architect's own checkout.
 */
describe('the shipped bundles say where their crew works, and what happens when it dies', () => {
  it('isolates the skeleton crew and brings it back by itself', () => {
    const loaded = builtinStore().load('skeleton-crew')
    if (!loaded.ok) throw new Error(loaded.reasons.join('; '))
    // Unattended repository watching is the whole point of this profile: it
    // must not touch the working copy, and it must survive the night.
    expect(loaded.bundle.document.isolation).toBe('worktree')
    expect(loaded.bundle.document.onExit).toBe('respawn')
  })

  it('isolates the front office but waits for the human it already waits for', () => {
    const loaded = builtinStore().load('front-office')
    if (!loaded.ok) throw new Error(loaded.reasons.join('; '))
    expect(loaded.bundle.document.isolation).toBe('worktree')
    // Every gate in this profile is supervised or manual. A hire that died is
    // waiting for the same person who was going to approve its work.
    expect(loaded.bundle.document.onExit).toBe('offer')
  })

  it('plans every skeleton-crew hire into its own worktree', () => {
    const loaded = builtinStore().load('skeleton-crew')
    if (!loaded.ok) throw new Error(loaded.reasons.join('; '))
    const planned = activationPlan(
      loaded.bundle,
      { kind: 'repo', id: 'myapp', path: '/repos/myapp' },
      'autonomous',
      () => [],
      { ok: false, because: 'no remotes in this test' }
    )
    if (!planned.ok) throw new Error(planned.reasons.join('; '))
    expect(planned.plan.hires).not.toHaveLength(0)
    for (const hire of planned.plan.hires) {
      expect(hire.spawn.worktree).toBe(true)
      expect(hire.isolation.declaredFrom).toBe('profile')
      expect(hire.onExit).toBe('respawn')
    }
  })
})

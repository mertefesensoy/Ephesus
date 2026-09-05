import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileActivations, ProfileStore } from '../../src/main/profiles'
import type { Trigger } from '../../src/main/scheduler'
import type { SpawnRequest } from '../../src/shared/agents'
import { GATE_SCHEMA_VERSION, type AutonomyLevel, type GatePolicy } from '../../src/shared/gates'
import { GateManager } from '../../src/main/watch/gates'
import {
  plannedTrustGrants,
  plannedWorkspaces,
  watchedRepos,
  type ActivationPlan
} from '../../src/shared/profile-activation'
import type { RepoDerivation } from '../../src/shared/repo-remote'
import { removeTempDir } from '../tmpdir'

/**
 * Activation and deactivation over a real store (ADR-0012, FR-9.4, FR-11.1).
 *
 * Real bundles on a real disk, with the process-touching edges — spawn, kill,
 * the scheduler — behind seams a test scripts. That is TEST-STRATEGY §1's
 * stance applied here: the file layout is the mechanism and gets real files;
 * `node-pty` is not, and cannot be imported under vitest anyway (BUILD-PROMPT
 * §10.3).
 *
 * What the package owes, and what is asserted below: stricter-wins composition
 * reaches a live agent; per-target instantiation keeps budgets separate;
 * deactivation disarms triggers; two profiles on one floor never share an
 * agent. Plus the one nobody asked for and everybody needs — a spawn that
 * fails halfway does not leave half a crew.
 */

const roots: string[] = []

afterEach(() => {
  for (const dir of roots.splice(0)) removeTempDir(dir)
})

interface BundleOptions {
  readonly autonomyDefault?: AutonomyLevel
  readonly byKind?: Record<string, AutonomyLevel>
  readonly hires?: readonly string[]
  readonly triggers?: readonly Record<string, unknown>[]
  /** Secret names every hire in this bundle declares. */
  readonly envGrants?: readonly string[]
  /** What harbor.json declares. Both SHIPPED bundles carry [] — that is B7. */
  readonly repos?: readonly { id: string; remote: string }[]
  /** The profile document's isolation default (M8.6). */
  readonly isolation?: 'worktree' | 'target'
  /** Per-hire isolation, by hire name (M8.6). */
  readonly hireIsolation?: Readonly<Record<string, 'worktree' | 'target'>>
  readonly onExit?: 'offer' | 'respawn'
  readonly hireOnExit?: Readonly<Record<string, 'offer' | 'respawn'>>
}

function writeBundle(root: string, name: string, options: BundleOptions = {}): void {
  const dir = path.join(root, name)
  fs.mkdirSync(path.join(dir, 'hires'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'triggers'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'playbooks'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'profile.json'),
    JSON.stringify({
      schemaVersion: 1,
      name,
      version: 1,
      target: { kind: 'repo' },
      autonomy: {
        default: options.autonomyDefault ?? 'autonomous',
        byKind: options.byKind ?? {}
      },
      ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
      ...(options.onExit === undefined ? {} : { onExit: options.onExit })
    })
  )
  fs.writeFileSync(
    path.join(dir, 'memo-policy.json'),
    JSON.stringify({ schemaVersion: 1, requires: [] })
  )
  fs.writeFileSync(
    path.join(dir, 'harbor.json'),
    JSON.stringify({
      schemaVersion: 1,
      repos: [...(options.repos ?? [])],
      channels: [],
      webhooks: []
    })
  )
  const hires = options.hires ?? ['oncall']
  for (const [i, hire] of hires.entries()) {
    fs.writeFileSync(
      path.join(dir, 'hires', `${hire}.json`),
      JSON.stringify({
        schemaVersion: 1,
        name: hire,
        version: 1,
        role: hire,
        engine: 'claude',
        capabilities: ['triage'],
        envGrants: [...(options.envGrants ?? [])],
        brief: 'Work.',
        budget: { dailyTokens: 1_000 * (i + 1) },
        ...(options.hireIsolation?.[hire] === undefined
          ? {}
          : { isolation: options.hireIsolation[hire] }),
        ...(options.hireOnExit?.[hire] === undefined ? {} : { onExit: options.hireOnExit[hire] })
      })
    )
  }
  for (const [i, trigger] of (options.triggers ?? []).entries()) {
    fs.writeFileSync(path.join(dir, 'triggers', `t${String(i)}.json`), JSON.stringify(trigger))
  }
  fs.writeFileSync(path.join(dir, 'playbooks', 'incident.md'), '# Incident\n')
}

interface RigOptions {
  readonly global?: AutonomyLevel
  /** Hire names that should fail to spawn, to exercise the unwind. */
  readonly failOn?: readonly string[]
  /** The broker's answer — the SAME shape the spawn path's resolver returns. */
  readonly missingGrants?: (declared: readonly string[]) => readonly string[]
  /** What the TARGET checkout's own git remotes say it is (M8.5). */
  readonly resolveRepos?: (target: { path: string }) => Promise<RepoDerivation>
  readonly onWatching?: (instanceId: string, because: string | null) => void
}

function rig(options: RigOptions = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-activate-'))
  roots.push(home)
  const profiles = path.join(home, 'profiles')
  fs.mkdirSync(profiles, { recursive: true })
  const targetDir = path.join(home, 'repo')
  fs.mkdirSync(targetDir, { recursive: true })

  const spawned: SpawnRequest[] = []
  const killed: string[] = []
  const hired: { agentId: string; onExit: string }[] = []
  const beforeHires: ActivationPlan[] = []
  const released: string[] = []
  /** Interleaved, so a test can assert that release happens BEFORE the kill. */
  const order: string[] = []
  const triggers = new Map<string, Trigger>()
  const logs: Record<string, unknown>[] = []

  const activations = new ProfileActivations({
    store: new ProfileStore(profiles, path.join(home, 'no-builtins')),
    globalAutonomy: () => options.global ?? 'autonomous',
    ...(options.missingGrants ? { missingGrants: options.missingGrants } : {}),
    ...(options.resolveRepos ? { resolveRepos: options.resolveRepos } : {}),
    ...(options.onWatching ? { onWatching: options.onWatching } : {}),
    spawn: (request) => {
      if ((options.failOn ?? []).some((name) => request.agentId.endsWith(`-${name}`))) {
        return Promise.reject(new Error(`engine "${request.engine}" is not installed`))
      }
      spawned.push(request)
      order.push(`spawn:${request.agentId}`)
      return Promise.resolve({})
    },
    beforeHires: (plan) => {
      beforeHires.push(plan)
      order.push('beforeHires')
    },
    kill: (agentId) => {
      killed.push(agentId)
      order.push(`kill:${agentId}`)
    },
    onHired: (hire) => {
      hired.push({ agentId: hire.agentId, onExit: hire.onExit })
      order.push(`hire:${hire.agentId}`)
    },
    onReleased: (agentId) => {
      released.push(agentId)
      order.push(`release:${agentId}`)
    },
    addTrigger: (trigger) => triggers.set(trigger.id, trigger),
    removeTrigger: (id) => triggers.delete(id),
    targetExists: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
    now: () => new Date('2026-08-31T12:00:00.000Z'),
    onLogEvent: (draft) => logs.push(draft)
  })

  return {
    activations,
    profiles,
    targetDir,
    spawned,
    killed,
    triggers,
    logs,
    hired,
    released,
    order
  }
}

const target = (path_: string, id = 'myapp') => ({ kind: 'repo' as const, id, path: path_ })

describe('activation', () => {
  it('spawns every hire bound to the target, and records the instance', async () => {
    const r = rig()
    writeBundle(r.profiles, 'skeleton-crew', { hires: ['oncall', 'deps'] })

    const result = await r.activations.activate({
      profile: 'skeleton-crew',
      target: target(r.targetDir)
    })
    if (!result.ok) throw new Error(result.reasons.join(' · '))

    expect(result.instance.instanceId).toBe('skeleton-crew@repo:myapp')
    // Hires come up in sorted file-name order — `deps.json` before
    // `oncall.json`. Deterministic on purpose: a spawn order that varied with
    // readdir would make the unwind below flaky and the ledger's order drift.
    expect(r.spawned.map((s) => s.agentId)).toEqual([
      'agent.skeleton-crew-myapp-deps',
      'agent.skeleton-crew-myapp-oncall'
    ])
    expect(r.spawned.every((s) => s.cwd === r.targetDir)).toBe(true)
    expect(r.activations.instances()).toHaveLength(1)
  })

  it('refuses a second activation on the SAME target, and spawns nothing', async () => {
    const r = rig()
    writeBundle(r.profiles, 'skeleton-crew')
    await r.activations.activate({ profile: 'skeleton-crew', target: target(r.targetDir) })
    const before = r.spawned.length

    const again = await r.activations.activate({
      profile: 'skeleton-crew',
      target: target(r.targetDir)
    })
    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.reasons.join(' · ')).toContain('already active')
    expect(r.spawned).toHaveLength(before)
  })

  it('allows the same profile on a DIFFERENT target, with its own agents (FR-9.4)', async () => {
    const r = rig()
    writeBundle(r.profiles, 'skeleton-crew')
    const second = path.join(r.targetDir, '..', 'repo2')
    fs.mkdirSync(second, { recursive: true })

    await r.activations.activate({ profile: 'skeleton-crew', target: target(r.targetDir) })
    const other = await r.activations.activate({
      profile: 'skeleton-crew',
      target: target(second, 'other')
    })
    if (!other.ok) throw new Error(other.reasons.join(' · '))

    expect(r.activations.instances().map((i) => i.instanceId)).toEqual([
      'skeleton-crew@repo:myapp',
      'skeleton-crew@repo:other'
    ])
    const ids = r.spawned.map((s) => s.agentId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps budgets per instance — two targets never pool one allowance', async () => {
    const r = rig()
    writeBundle(r.profiles, 'skeleton-crew', { hires: ['oncall', 'deps'] })
    const second = path.join(r.targetDir, '..', 'repo2')
    fs.mkdirSync(second, { recursive: true })
    await r.activations.activate({ profile: 'skeleton-crew', target: target(r.targetDir) })
    await r.activations.activate({ profile: 'skeleton-crew', target: target(second, 'other') })

    // Four distinct agents, each carrying its own hire's allowance. The Watch
    // folds spend per agent from the durable ledger, so distinct ids IS the
    // separation — there is no shared counter to get wrong.
    expect(r.spawned.map((s) => [s.agentId, s.budget?.dailyTokens])).toEqual([
      ['agent.skeleton-crew-myapp-deps', 2_000],
      ['agent.skeleton-crew-myapp-oncall', 1_000],
      ['agent.skeleton-crew-other-deps', 2_000],
      ['agent.skeleton-crew-other-oncall', 1_000]
    ])
  })

  it('two profiles on one floor never share an agent', async () => {
    const r = rig()
    writeBundle(r.profiles, 'skeleton-crew')
    writeBundle(r.profiles, 'front-office')
    await r.activations.activate({ profile: 'skeleton-crew', target: target(r.targetDir) })
    await r.activations.activate({ profile: 'front-office', target: target(r.targetDir) })

    const ids = r.spawned.map((s) => s.agentId)
    expect(ids).toEqual(['agent.skeleton-crew-myapp-oncall', 'agent.front-office-myapp-oncall'])
    expect(new Set(ids).size).toBe(2)
  })

  it('refuses a target directory that is not there', async () => {
    const r = rig()
    writeBundle(r.profiles, 'skeleton-crew')
    const result = await r.activations.activate({
      profile: 'skeleton-crew',
      target: target(path.join(r.targetDir, 'nope'))
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reasons.join(' · ')).toContain('is not a directory on this machine')
    expect(r.spawned).toEqual([])
  })

  it('refuses a bundle that does not load, carrying its reasons through', async () => {
    const r = rig()
    writeBundle(r.profiles, 'skeleton-crew')
    fs.writeFileSync(path.join(r.profiles, 'skeleton-crew', 'harbor.json'), '{ nope')
    const result = await r.activations.activate({
      profile: 'skeleton-crew',
      target: target(r.targetDir)
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reasons.join(' · ')).toContain('harbor.json: not JSON')
    expect(r.spawned).toEqual([])
  })
})

describe('activation is all or nothing', () => {
  it('kills the agents already up when a later hire cannot spawn', async () => {
    // A half-activated crew is worse than none: the Architect approved a plan
    // with a dependency agent in it and has no reason to think it is missing.
    // `deps` spawns first (sorted), so failing `oncall` leaves exactly one
    // agent up for the unwind to find.
    const r = rig({ failOn: ['oncall'] })
    writeBundle(r.profiles, 'skeleton-crew', { hires: ['oncall', 'deps'] })

    const result = await r.activations.activate({
      profile: 'skeleton-crew',
      target: target(r.targetDir)
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reasons.join(' · ')).toContain('could not spawn')
    expect(r.killed).toEqual(['agent.skeleton-crew-myapp-deps'])
    expect(r.activations.instances()).toEqual([])
    expect(r.logs.map((l) => l['event'])).toContain('activation-failed')
  })

  it('arms no trigger when the activation failed', async () => {
    const r = rig({ failOn: ['oncall'] })
    writeBundle(r.profiles, 'skeleton-crew', {
      triggers: [
        { id: 'sweep', kind: 'schedule', everyMs: 600_000, hire: 'oncall', playbook: 'incident.md' }
      ]
    })
    await r.activations.activate({ profile: 'skeleton-crew', target: target(r.targetDir) })
    expect([...r.triggers.keys()]).toEqual([])
  })
})

describe('triggers', () => {
  it('arms schedule triggers and leaves event ones visibly PENDING', async () => {
    // Nothing publishes `ci` yet (the Harbor is M7.3). An event trigger armed
    // on a publisher that does not exist would be a watcher the Architect
    // believes is on duty and is not.
    const r = rig()
    writeBundle(r.profiles, 'skeleton-crew', {
      triggers: [
        {
          id: 'sweep',
          kind: 'schedule',
          everyMs: 600_000,
          hire: 'oncall',
          playbook: 'incident.md'
        },
        { id: 'ci', kind: 'event', event: 'ci', hire: 'oncall', playbook: 'incident.md' }
      ]
    })
    const result = await r.activations.activate({
      profile: 'skeleton-crew',
      target: target(r.targetDir)
    })
    if (!result.ok) throw new Error(result.reasons.join(' · '))

    expect([...r.triggers.keys()]).toEqual(['skeleton-crew@repo:myapp/sweep'])
    expect(r.triggers.get('skeleton-crew@repo:myapp/sweep')?.everyMs).toBe(600_000)
    // What the instance REPORTS as armed has to match what the scheduler was
    // actually given. A mutation that listed the event trigger as armed while
    // arming nothing survived the first sweep here: the UI would have shown a
    // watcher on duty that no clock and no publisher would ever fire.
    expect(result.instance.armed).toEqual(['skeleton-crew@repo:myapp/sweep'])
    expect(result.instance.armed).toEqual([...r.triggers.keys()])
    expect(result.instance.pendingEvents).toEqual([
      // The EVENT name, not the display label. A pending row keyed on 'on ci'
      // is how the incident path came to drop every CI failure in production.
      { id: 'skeleton-crew@repo:myapp/ci', event: 'ci' }
    ])
  })

  it('DISARMS every armed trigger on deactivation, and kills the agents', async () => {
    const r = rig()
    writeBundle(r.profiles, 'skeleton-crew', {
      hires: ['oncall', 'deps'],
      triggers: [
        { id: 'sweep', kind: 'schedule', everyMs: 600_000, hire: 'oncall', playbook: 'incident.md' }
      ]
    })
    await r.activations.activate({ profile: 'skeleton-crew', target: target(r.targetDir) })
    expect(r.triggers.size).toBe(1)

    const out = r.activations.deactivate('skeleton-crew@repo:myapp')
    expect(out).toEqual({ ok: true, reason: null })
    expect(r.triggers.size).toBe(0)
    expect(r.killed).toEqual(['agent.skeleton-crew-myapp-deps', 'agent.skeleton-crew-myapp-oncall'])
    expect(r.activations.instances()).toEqual([])
    expect(r.logs.map((l) => l['event'])).toContain('deactivated')
  })

  it('deactivating one instance leaves the other one armed', async () => {
    const r = rig()
    writeBundle(r.profiles, 'skeleton-crew', {
      triggers: [
        { id: 'sweep', kind: 'schedule', everyMs: 600_000, hire: 'oncall', playbook: 'incident.md' }
      ]
    })
    const second = path.join(r.targetDir, '..', 'repo2')
    fs.mkdirSync(second, { recursive: true })
    await r.activations.activate({ profile: 'skeleton-crew', target: target(r.targetDir) })
    await r.activations.activate({ profile: 'skeleton-crew', target: target(second, 'other') })
    expect(r.triggers.size).toBe(2)

    r.activations.deactivate('skeleton-crew@repo:myapp')
    expect([...r.triggers.keys()]).toEqual(['skeleton-crew@repo:other/sweep'])
  })

  it('refuses to deactivate something that is not active, rather than reporting success', async () => {
    const r = rig()
    expect(r.activations.deactivate('nobody@repo:x')).toEqual({
      ok: false,
      reason: 'no active profile "nobody@repo:x"'
    })
  })
})

describe('autonomyFor — the seam that makes stricter-wins reach a live agent', () => {
  it('answers the COMPOSED level, not what the profile asked for', async () => {
    // The profile asks for `autonomous` everywhere under a `supervised`
    // company. Under a "profile wins" composition this reads `autonomous`,
    // which is the silent privilege escalation FR-11.1 exists to prevent.
    const r = rig({ global: 'supervised' })
    writeBundle(r.profiles, 'skeleton-crew', { autonomyDefault: 'autonomous' })
    await r.activations.activate({ profile: 'skeleton-crew', target: target(r.targetDir) })

    expect(r.activations.autonomyFor('agent.skeleton-crew-myapp-oncall', 'destructive')).toBe(
      'supervised'
    )
    expect(r.activations.autonomyFor('agent.skeleton-crew-myapp-oncall', 'spend')).toBe(
      'supervised'
    )
  })

  it('honours a per-class tightening the profile asked for', async () => {
    const r = rig({ global: 'autonomous' })
    writeBundle(r.profiles, 'skeleton-crew', {
      autonomyDefault: 'autonomous',
      byKind: { destructive: 'manual' }
    })
    await r.activations.activate({ profile: 'skeleton-crew', target: target(r.targetDir) })

    expect(r.activations.autonomyFor('agent.skeleton-crew-myapp-oncall', 'destructive')).toBe(
      'manual'
    )
    expect(r.activations.autonomyFor('agent.skeleton-crew-myapp-oncall', 'spend')).toBe(
      'autonomous'
    )
  })

  it('answers NULL for an agent no profile owns — never a permissive default', async () => {
    // Null sends the caller to the global policy alone. A level here would be
    // this module quietly deciding policy for agents it knows nothing about.
    const r = rig()
    expect(r.activations.autonomyFor('agent.mason', 'destructive')).toBeNull()
  })

  it('stops answering for an agent once its instance is deactivated', async () => {
    const r = rig({ global: 'supervised' })
    writeBundle(r.profiles, 'skeleton-crew')
    await r.activations.activate({ profile: 'skeleton-crew', target: target(r.targetDir) })
    expect(r.activations.autonomyFor('agent.skeleton-crew-myapp-oncall', 'spend')).toBe(
      'supervised'
    )

    r.activations.deactivate('skeleton-crew@repo:myapp')
    expect(r.activations.autonomyFor('agent.skeleton-crew-myapp-oncall', 'spend')).toBeNull()
  })

  it('logs the COMPOSED autonomy and names what was clamped', async () => {
    const r = rig({ global: 'manual' })
    writeBundle(r.profiles, 'skeleton-crew', { autonomyDefault: 'autonomous' })
    await r.activations.activate({ profile: 'skeleton-crew', target: target(r.targetDir) })

    const activated = r.logs.find((l) => l['event'] === 'activated')
    expect(activated?.['autonomy']).toMatchObject({ destructive: 'manual', spend: 'manual' })
    expect(activated?.['clamped']).toContain('destructive')
  })
})

describe('the Watch seam — composition reaches a real gate decision', () => {
  /**
   * The M6 standing lesson applied to the thing that matters most here.
   * `GateRequest.profileAutonomy` shipped at M3 and nothing ever set it; the
   * composition was correct arithmetic nobody could reach. These cases wire a
   * REAL `GateManager` to a REAL `ProfileActivations` and submit a real
   * destructive action, so the claim "a profile's tightening binds a live
   * agent" is asserted through the code path production takes.
   */
  const PACKAGING = {
    what: 'rm -rf build/',
    why: 'stale artifacts',
    blastRadius: 'the build directory',
    rollback: 'rebuild'
  }

  /** Company-wide: destructive is permitted at `supervised`. */
  const POLICY: GatePolicy = {
    schemaVersion: GATE_SCHEMA_VERSION,
    autonomy: 'supervised',
    rules: [{ kind: 'destructive', autonomy: 'supervised' }]
  }

  async function wired(byKind: Record<string, AutonomyLevel>) {
    const r = rig({ global: 'supervised' })
    writeBundle(r.profiles, 'skeleton-crew', { autonomyDefault: 'supervised', byKind })
    await r.activations.activate({ profile: 'skeleton-crew', target: target(r.targetDir) })
    const gates = new GateManager({
      policy: () => POLICY,
      profileAutonomy: (agentId, kind) => r.activations.autonomyFor(agentId, kind)
    })
    return { r, gates }
  }

  it('an agent outside any profile is judged by the global policy alone', async () => {
    const { gates } = await wired({})
    const outcome = gates.submit({
      kind: 'destructive',
      agentId: 'agent.mason',
      packaging: PACKAGING
    })
    expect(outcome.held).toBe(false)
  })

  it('a profile agent under the SAME level is judged the same way', async () => {
    const { gates } = await wired({})
    const outcome = gates.submit({
      kind: 'destructive',
      agentId: 'agent.skeleton-crew-myapp-oncall',
      packaging: PACKAGING
    })
    expect(outcome.held).toBe(false)
  })

  it('a profile that TIGHTENED destructive to `manual` holds the very same action', async () => {
    // The claim, end to end: the bundle on disk said `manual`, activation
    // composed it, and the Watch held an action the company policy alone
    // would have allowed. Nothing here passes `profileAutonomy` by hand.
    const { gates } = await wired({ destructive: 'manual' })
    const outcome = gates.submit({
      kind: 'destructive',
      agentId: 'agent.skeleton-crew-myapp-oncall',
      packaging: PACKAGING
    })
    expect(outcome.held).toBe(true)
    expect(outcome.decision.because).toBe('autonomy')
  })

  it('stops binding once the profile is deactivated', async () => {
    const { r, gates } = await wired({ destructive: 'manual' })
    r.activations.deactivate('skeleton-crew@repo:myapp')
    const outcome = gates.submit({
      kind: 'destructive',
      agentId: 'agent.skeleton-crew-myapp-oncall',
      packaging: PACKAGING
    })
    expect(outcome.held).toBe(false)
  })
})

/**
 * The activation screen and the spawn agree about the secrets (M8.4, B9).
 *
 * The preview listed what a profile DECLARES and stopped there, so it promised
 * `GH_TOKEN` on an install with no `github-app.json` and no such secret — an
 * affirmative promise about something that would simply be absent at spawn.
 * The fix wires the preview to the SAME resolver the spawn path uses, and this
 * is what says so: nothing else in the suite asserted `grantsUnavailable` at
 * all, and gutting it to a constant `[]` passed every test in four files.
 */
describe('the preview asks the broker, rather than assuming', () => {
  it('reports what the broker cannot supply, from the resolver it is given', async () => {
    const asked: string[][] = []
    const r = rig({
      missingGrants: (declared) => {
        asked.push([...declared])
        return declared.filter((name) => name === 'GH_TOKEN')
      }
    })
    writeBundle(r.profiles, 'skeleton-crew', { envGrants: ['GH_TOKEN', 'NPM_TOKEN'] })

    const planned = await r.activations.preview({
      profile: 'skeleton-crew',
      target: target(r.targetDir)
    })
    if (!planned.ok) throw new Error(planned.reasons.join(' · '))
    expect(asked).toEqual([['GH_TOKEN', 'NPM_TOKEN']])
    expect(planned.plan.grantsUnavailable).toEqual(['GH_TOKEN'])
    // Declared and available are two different facts; the screen shows both.
    expect(planned.plan.envGrants).toEqual(['GH_TOKEN', 'NPM_TOKEN'])

    // And the plan the instance keeps is the same plan, so what the Architect
    // was shown is what the record says they were shown.
    const result = await r.activations.activate({
      profile: 'skeleton-crew',
      target: target(r.targetDir)
    })
    if (!result.ok) throw new Error(result.reasons.join(' · '))
    expect(result.instance.plan.grantsUnavailable).toEqual(['GH_TOKEN'])
  })

  it('claims nothing when no resolver is wired', async () => {
    // The parameter is optional so the class stays constructible in a rig that
    // has no broker; absent means "not checked", never "all available".
    const r = rig()
    writeBundle(r.profiles, 'skeleton-crew', { envGrants: ['GH_TOKEN'] })
    const planned = await r.activations.preview({
      profile: 'skeleton-crew',
      target: target(r.targetDir)
    })
    if (!planned.ok) throw new Error(planned.reasons.join(' · '))
    expect(planned.plan.grantsUnavailable).toEqual([])
  })
})
/**
 * The mission actually watches the repository (M8.5, B7).
 *
 * Both shipped bundles carry `repos: []` and `harbor.json` was the only source
 * of that list, so activating the Skeleton Crew against a real repository
 * watched nothing: no CI run, issue or pull request was ingested, therefore no
 * incident could ever be raised. The flagship mission was inert on first use,
 * silently, and this machine only worked because `harbor.json` had been
 * hand-edited.
 *
 * These run through the SHIPPED class rather than the pure planner: `preview`
 * and `activate` share one plan, and the ingest list and the ingest cadence
 * share one function, so the assertions here are about the seams — the
 * arithmetic is held by `test/shared/profile-activation.test.ts`.
 */
describe('an instance watches the target it was pointed at', () => {
  const fromCheckout: RepoDerivation = {
    ok: true,
    slug: 'owner/app',
    from: 'origin'
  }

  it('derives the repository when harbor.json declares none — and INGESTS from it', async () => {
    const asked: string[] = []
    const r = rig({
      resolveRepos: (t) => {
        asked.push(t.path)
        return Promise.resolve(fromCheckout)
      }
    })
    writeBundle(r.profiles, 'skeleton-crew') // repos: [] — the shipped shape

    const result = await r.activations.activate({
      profile: 'skeleton-crew',
      target: target(r.targetDir)
    })
    if (!result.ok) throw new Error(result.reasons.join(' · '))
    expect(asked).toEqual([r.targetDir])
    expect(result.instance.plan.repos).toEqual(['owner/app'])
    expect(result.instance.plan.reposFrom).toBe('target')

    // The Harbor's ingest list and the cadence's arming condition are ONE
    // function over the live instances, so they cannot disagree about whether
    // there is anything to watch. Both are what B7 broke.
    expect(watchedRepos(r.activations.instances())).toEqual(['owner/app'])
    expect(watchedRepos(r.activations.instances()).length > 0).toBe(true)
  })

  it('records what it watches in the book of record', async () => {
    // NFR-13: a forensic reader asking why no incident was ever raised for an
    // instance must be able to answer it from `log.jsonl` alone.
    const r = rig({ resolveRepos: () => Promise.resolve(fromCheckout) })
    writeBundle(r.profiles, 'skeleton-crew')
    await r.activations.activate({
      profile: 'skeleton-crew',
      target: target(r.targetDir)
    })

    const activated = r.logs.find((row) => row['event'] === 'activated')
    expect(activated?.['repos']).toEqual(['owner/app'])
    expect(activated?.['reposFrom']).toBe('target')
  })

  it('refuses to invent one, activates anyway, and SAYS the mission is inert', async () => {
    // Refusing the activation outright would put a new cliff exactly where M8
    // is removing one — a profile also hires a crew and arms schedules. So it
    // comes up, and the condition that made it useless is reported rather than
    // being the silent outcome it has always been (invariant §7).
    const nothing: RepoDerivation = {
      ok: false,
      because:
        'the target has more than one github.com remote (origin → me/app, upstream → them/app)'
    }
    const silent: { id: string; because: string | null }[] = []
    const r = rig({
      resolveRepos: () => Promise.resolve(nothing),
      onWatching: (id, because) => silent.push({ id, because })
    })
    writeBundle(r.profiles, 'skeleton-crew')

    const result = await r.activations.activate({
      profile: 'skeleton-crew',
      target: target(r.targetDir)
    })
    if (!result.ok) throw new Error(result.reasons.join(' · '))
    expect(result.instance.plan.repos).toEqual([])
    expect(silent).toHaveLength(1)
    expect(silent[0]?.id).toBe('skeleton-crew@repo:myapp')
    expect(silent[0]?.because).toContain('more than one')
    // And the cadence has nothing to arm for, which is now a said thing.
    expect(watchedRepos(r.activations.instances())).toEqual([])
  })

  it('reports a healthy instance as HEALTHY, which is what clears the condition', async () => {
    // The report is a fact, not decoration: a healthy activation must not carry
    // a degradation that reads as though something is wrong — and `null` is
    // what takes a previous refusal off the Architect's health list.
    const said: { id: string; because: string | null }[] = []
    const r = rig({
      resolveRepos: () => Promise.resolve(fromCheckout),
      onWatching: (id, because) => said.push({ id, because })
    })
    writeBundle(r.profiles, 'skeleton-crew')
    await r.activations.activate({
      profile: 'skeleton-crew',
      target: target(r.targetDir)
    })
    expect(said).toEqual([{ id: 'skeleton-crew@repo:myapp', because: null }])
  })

  it('lets the Architect name the repository when the derivation refused', async () => {
    // The answer to the fork. Without it a refused derivation is a dead end.
    const r = rig({
      resolveRepos: () => Promise.resolve({ ok: false, because: 'the target has no git remote' })
    })
    writeBundle(r.profiles, 'skeleton-crew')

    const result = await r.activations.activate({
      profile: 'skeleton-crew',
      target: target(r.targetDir),
      repos: ['chosen/app']
    })
    if (!result.ok) throw new Error(result.reasons.join(' · '))
    expect(result.instance.plan.repos).toEqual(['chosen/app'])
    expect(result.instance.plan.reposFrom).toBe('architect')
    expect(watchedRepos(r.activations.instances())).toEqual(['chosen/app'])
  })

  it('shows on the preview exactly what the activation will do', async () => {
    // ADR-0012's whole safety argument. One plan, so the screen cannot promise
    // one repository and the instance watch another.
    const r = rig({ resolveRepos: () => Promise.resolve(fromCheckout) })
    writeBundle(r.profiles, 'skeleton-crew')
    const request = { profile: 'skeleton-crew', target: target(r.targetDir) }

    const planned = await r.activations.preview(request)
    if (!planned.ok) throw new Error(planned.reasons.join(' · '))
    const result = await r.activations.activate(request)
    if (!result.ok) throw new Error(result.reasons.join(' · '))
    expect(result.instance.plan.repos).toEqual(planned.plan.repos)
    expect(result.instance.plan.reposBecause).toBe(planned.plan.reposBecause)
  })

  it('re-reads the remotes on every preview rather than remembering them', async () => {
    // The Architect adds a remote to a checkout between two activations like
    // anybody else, and a cached derivation is a setting nobody re-reads —
    // the shape of every defect this milestone has found.
    let answer: RepoDerivation = {
      ok: false,
      because: 'the target has no git remote'
    }
    const r = rig({ resolveRepos: () => Promise.resolve(answer) })
    writeBundle(r.profiles, 'skeleton-crew')
    const request = { profile: 'skeleton-crew', target: target(r.targetDir) }

    const first = await r.activations.preview(request)
    if (!first.ok) throw new Error(first.reasons.join(' · '))
    expect(first.plan.repos).toEqual([])

    answer = fromCheckout
    const second = await r.activations.preview(request)
    if (!second.ok) throw new Error(second.reasons.join(' · '))
    expect(second.plan.repos).toEqual(['owner/app'])
  })

  it('lets a bundle that declares repositories keep them', async () => {
    const r = rig({ resolveRepos: () => Promise.resolve(fromCheckout) })
    writeBundle(r.profiles, 'front-office', {
      repos: [{ id: 'app', remote: 'declared/app' }]
    })
    const planned = await r.activations.preview({
      profile: 'front-office',
      target: target(r.targetDir)
    })
    if (!planned.ok) throw new Error(planned.reasons.join(' · '))
    expect(planned.plan.repos).toEqual(['declared/app'])
    expect(planned.plan.reposFrom).toBe('bundle')
  })

  it('gathers every live instance repository, deduplicated and sorted', async () => {
    // Two profiles on one floor, one of them on another target: the Harbor
    // ingests each repository once, in an order that does not depend on which
    // was activated first.
    const r = rig({ resolveRepos: () => Promise.resolve(fromCheckout) })
    writeBundle(r.profiles, 'skeleton-crew')
    writeBundle(r.profiles, 'front-office', {
      repos: [{ id: 'a', remote: 'aaa/one' }]
    })
    const second = path.join(r.targetDir, '..', 'other')
    fs.mkdirSync(second, { recursive: true })

    await r.activations.activate({
      profile: 'front-office',
      target: target(r.targetDir, 'first')
    })
    await r.activations.activate({
      profile: 'skeleton-crew',
      target: target(second, 'second')
    })
    expect(watchedRepos(r.activations.instances())).toEqual(['aaa/one', 'owner/app'])
  })
})

/**
 * The condition that says a mission is inert has to be able to STOP being true
 * (M8.5, and the M8.2 rule it inherits).
 *
 * A degradation raised and never cleared is worse than one never raised: the
 * Architect fixes the remote, reactivates, and the health list still says the
 * mission watches nothing — so they learn to disbelieve the list. One callback
 * carries both directions, so it cannot be half-wired.
 */
describe('an instance that starts watching something says so', () => {
  /** The consequence clause `plannedRepos` appends to every refusal. */
  const TAIL =
    ' — this instance will watch no repository, so no CI run, issue or pull request can reach it'

  it('reports healthy after a refusal was fixed', async () => {
    let answer: RepoDerivation = { ok: false, because: 'the target has no git remote' }
    const said: (string | null)[] = []
    const r = rig({
      resolveRepos: () => Promise.resolve(answer),
      onWatching: (_id, because) => said.push(because)
    })
    writeBundle(r.profiles, 'skeleton-crew')
    const request = { profile: 'skeleton-crew', target: target(r.targetDir) }

    await r.activations.activate(request)
    // The whole sentence, consequence included — what `plan.reposBecause` says.
    expect(said).toEqual([`the target has no git remote${TAIL}`])

    // The Architect adds the remote and reactivates.
    r.activations.deactivate('skeleton-crew@repo:myapp')
    answer = { ok: true, slug: 'owner/app', from: 'origin' }
    await r.activations.activate(request)

    // Deactivation clears it too — an instance that is gone is not an instance
    // watching nothing — and the new activation reports healthy.
    expect(said).toEqual([`the target has no git remote${TAIL}`, null, null])
  })

  it('clears when the instance is torn down', async () => {
    const said: (string | null)[] = []
    const r = rig({
      resolveRepos: () => Promise.resolve({ ok: false, because: 'the target has no git remote' }),
      onWatching: (_id, because) => said.push(because)
    })
    writeBundle(r.profiles, 'skeleton-crew')
    await r.activations.activate({ profile: 'skeleton-crew', target: target(r.targetDir) })
    expect(said).toEqual([`the target has no git remote${TAIL}`])

    expect(r.activations.deactivate('skeleton-crew@repo:myapp').ok).toBe(true)
    expect(said).toEqual([`the target has no git remote${TAIL}`, null])
  })

  it('says nothing about an instance that was never live', () => {
    const said: string[] = []
    const r = rig({ onWatching: (id) => said.push(id) })
    expect(r.activations.deactivate('never@repo:existed').ok).toBe(false)
    expect(said).toEqual([])
  })
})
/**
 * B10 and B12 through the whole activation path (M8.6).
 *
 * These assert against the SPAWN REQUEST and the plan together, not against
 * `composeIsolation` — that is unit-tested next door. What is owed here is the
 * wiring: that the bundle's declaration reaches a real spawn, that the screen's
 * sentence and the spawn's flag are the same decision, and that a hire's exit
 * policy reaches the ladder that acts on it.
 */
describe('every hire is isolated unless the bundle says otherwise (B10)', () => {
  it('asks for a worktree even when nothing declares one', async () => {
    // The state of both shipped bundles before M8.6: no isolation field
    // anywhere, and therefore — until now — no isolation.
    const r = rig()
    writeBundle(r.profiles, 'crew', { hires: ['oncall', 'deps'] })
    const result = await r.activations.activate({
      profile: 'crew',
      target: target(r.targetDir)
    })
    if (!result.ok) throw new Error(result.reasons.join(' · '))

    expect(r.spawned.every((s) => s.worktree === true)).toBe(true)
  })

  it('honours a profile that opts its crew out', async () => {
    const r = rig()
    writeBundle(r.profiles, 'crew', { hires: ['oncall'], isolation: 'target' })
    const result = await r.activations.activate({
      profile: 'crew',
      target: target(r.targetDir)
    })
    if (!result.ok) throw new Error(result.reasons.join(' · '))

    expect(r.spawned[0]?.worktree).toBe(false)
    expect(result.instance.plan.hires[0]?.isolation.declaredFrom).toBe('profile')
  })

  it('lets one hire differ from its profile', async () => {
    const r = rig()
    writeBundle(r.profiles, 'crew', {
      hires: ['oncall', 'deps'],
      isolation: 'target',
      hireIsolation: { deps: 'worktree' }
    })
    const result = await r.activations.activate({
      profile: 'crew',
      target: target(r.targetDir)
    })
    if (!result.ok) throw new Error(result.reasons.join(' · '))

    const byId = new Map(r.spawned.map((s) => [s.agentId, s.worktree]))
    expect(byId.get('agent.crew-myapp-deps')).toBe(true)
    expect(byId.get('agent.crew-myapp-oncall')).toBe(false)
  })

  it('obeys a blanket override in both directions', async () => {
    const isolated = rig()
    writeBundle(isolated.profiles, 'crew', {
      hires: ['oncall'],
      isolation: 'target'
    })
    const up = await isolated.activations.activate({
      profile: 'crew',
      target: target(isolated.targetDir),
      isolation: 'isolate-all'
    })
    if (!up.ok) throw new Error(up.reasons.join(' · '))
    expect(isolated.spawned[0]?.worktree).toBe(true)
    expect(up.instance.plan.hires[0]?.isolation.tightened).toBe(true)

    const loose = rig()
    writeBundle(loose.profiles, 'crew', {
      hires: ['oncall'],
      isolation: 'worktree'
    })
    const down = await loose.activations.activate({
      profile: 'crew',
      target: target(loose.targetDir),
      isolation: 'none'
    })
    if (!down.ok) throw new Error(down.reasons.join(' · '))
    expect(loose.spawned[0]?.worktree).toBe(false)
    expect(down.instance.plan.hires[0]?.isolation.relaxed).toBe(true)
  })

  it('shows exactly what the spawn will do — one decision, two readers', async () => {
    // The M8.5 lesson, applied before it could cost anything: a screen and an
    // outcome that come from two code paths eventually disagree. Here they are
    // the same object, and this asserts it for every hire under every choice.
    const r = rig()
    writeBundle(r.profiles, 'crew', {
      hires: ['a', 'b', 'c'],
      isolation: 'target',
      hireIsolation: { b: 'worktree' }
    })
    for (const choice of ['as-declared', 'isolate-all', 'none'] as const) {
      const planned = await r.activations.preview({
        profile: 'crew',
        target: target(r.targetDir),
        isolation: choice
      })
      if (!planned.ok) throw new Error(planned.reasons.join(' · '))
      for (const hire of planned.plan.hires) {
        expect(hire.spawn.worktree).toBe(hire.isolation.effective === 'worktree')
        expect(hire.isolation.agentId).toBe(hire.agentId)
        expect(hire.isolation.because.length).toBeGreaterThan(10)
      }
    }
  })
})

describe('what happens when a hire dies is declared, not inferred (B12)', () => {
  it('defaults to the offer SDD §10 specifies', async () => {
    const r = rig()
    writeBundle(r.profiles, 'crew', { hires: ['oncall'] })
    const result = await r.activations.activate({
      profile: 'crew',
      target: target(r.targetDir)
    })
    if (!result.ok) throw new Error(result.reasons.join(' · '))
    expect(r.hired).toEqual([{ agentId: 'agent.crew-myapp-oncall', onExit: 'offer' }])
  })

  it('carries a profile-level respawn policy to every hire', async () => {
    const r = rig()
    writeBundle(r.profiles, 'crew', {
      hires: ['oncall', 'deps'],
      onExit: 'respawn'
    })
    const result = await r.activations.activate({
      profile: 'crew',
      target: target(r.targetDir)
    })
    if (!result.ok) throw new Error(result.reasons.join(' · '))
    expect(r.hired.every((h) => h.onExit === 'respawn')).toBe(true)
  })

  it('lets one hire opt out of its profile', async () => {
    const r = rig()
    writeBundle(r.profiles, 'crew', {
      hires: ['oncall', 'deps'],
      onExit: 'respawn',
      hireOnExit: { deps: 'offer' }
    })
    const result = await r.activations.activate({
      profile: 'crew',
      target: target(r.targetDir)
    })
    if (!result.ok) throw new Error(result.reasons.join(' · '))
    expect(new Map(r.hired.map((h) => [h.agentId, h.onExit]))).toEqual(
      new Map([
        ['agent.crew-myapp-deps', 'offer'],
        ['agent.crew-myapp-oncall', 'respawn']
      ])
    )
  })

  it('declares nobody when the activation failed halfway', async () => {
    // The race this ordering exists to prevent: a ladder armed for an agent
    // the roll-back is about to kill would faithfully bring it back, and the
    // Architect would be told nothing was activated while an agent ran.
    const r = rig({ failOn: ['oncall'] })
    writeBundle(r.profiles, 'crew', {
      hires: ['deps', 'oncall'],
      onExit: 'respawn'
    })
    const result = await r.activations.activate({
      profile: 'crew',
      target: target(r.targetDir)
    })
    expect(result.ok).toBe(false)
    expect(r.hired).toEqual([])
    expect(r.killed).toEqual(['agent.crew-myapp-deps'])
  })

  it('releases every agent BEFORE deactivation kills it', async () => {
    // Same race at the other end: a ladder still armed reads the
    // deactivation's own kill as a crash and undoes the deactivation.
    const r = rig()
    writeBundle(r.profiles, 'crew', { hires: ['oncall'], onExit: 'respawn' })
    const result = await r.activations.activate({
      profile: 'crew',
      target: target(r.targetDir)
    })
    if (!result.ok) throw new Error(result.reasons.join(' · '))

    r.activations.deactivate(result.instance.instanceId)
    expect(r.released).toEqual(['agent.crew-myapp-oncall'])
    expect(r.order.indexOf('release:agent.crew-myapp-oncall')).toBeLessThan(
      r.order.indexOf('kill:agent.crew-myapp-oncall')
    )
  })
})
/**
 * M8.7 — which directories an activation must trust (ADR-0021 + ADR-0025).
 *
 * The blocker this closes: M8.6 made isolation the default, so every hire moved
 * into `<home>/worktrees/<agentId>` while the activation went on trusting only
 * the target. The engine keys trust on the exact directory, so no crew agent's
 * real working directory was ever trusted, and each met the first-run dialog
 * with no session — no hook, no report, parked for ever.
 *
 * These assert the SET, because the set is the fix. A missing entry is an agent
 * that hangs with nothing said about it.
 */
describe('every directory an activation will work in gets trusted (M8.7)', () => {
  const wtFor = (agentId: string): string => `/home/worktrees/${agentId}`

  async function planFor(
    r: ReturnType<typeof rig>,
    options: Parameters<typeof writeBundle>[2] = {},
    isolation?: 'as-declared' | 'isolate-all' | 'none'
  ) {
    writeBundle(r.profiles, 'crew', options)
    const planned = await r.activations.preview({
      profile: 'crew',
      target: target(r.targetDir),
      ...(isolation ? { isolation } : {})
    })
    if (!planned.ok) throw new Error(planned.reasons.join(' · '))
    return planned.plan
  }

  it('lists the target and one worktree per isolated hire', async () => {
    const r = rig()
    const plan = await planFor(r, { hires: ['oncall', 'deps'] })
    const spaces = plannedWorkspaces(plan, wtFor)

    expect(spaces.map((s) => s.path)).toEqual([
      r.targetDir,
      '/home/worktrees/agent.crew-myapp-deps',
      '/home/worktrees/agent.crew-myapp-oncall'
    ])
    // The target exists; the worktrees do not yet — git makes them during this
    // activation, which is why they cannot be resolved in full.
    expect(spaces[0]?.existence).toBe('must-exist')
    expect(spaces.slice(1).every((s) => s.existence === 'will-be-created')).toBe(true)
  })

  it('leaves a hire that works in the target on the target, with no worktree entry', async () => {
    const r = rig()
    const plan = await planFor(r, { hires: ['oncall'], isolation: 'target' })
    const spaces = plannedWorkspaces(plan, wtFor)

    expect(spaces).toHaveLength(1)
    expect(spaces[0]?.path).toBe(r.targetDir)
    // Named, so a reader can tell "the target nobody uses" from "the target
    // this agent works in".
    expect(spaces[0]?.agentIds).toEqual(['agent.crew-myapp-oncall'])
  })

  it('follows the Architect’s override in both directions', async () => {
    const isolated = rig()
    const up = await planFor(isolated, { hires: ['oncall'], isolation: 'target' }, 'isolate-all')
    expect(plannedWorkspaces(up, wtFor).map((s) => s.existence)).toEqual([
      'must-exist',
      'will-be-created'
    ])

    const loose = rig()
    const down = await planFor(loose, { hires: ['oncall'], isolation: 'worktree' }, 'none')
    expect(plannedWorkspaces(down, wtFor)).toHaveLength(1)
  })

  it('covers EVERY hire — the count is the property that fails silently', async () => {
    // One missing entry is one agent that parks with no session and no hook.
    const r = rig()
    const plan = await planFor(r, { hires: ['a', 'b', 'c', 'd'] })
    const spaces = plannedWorkspaces(plan, wtFor)
    const isolated = plan.hires.filter((h) => h.isolation.effective === 'worktree')

    expect(isolated).toHaveLength(4)
    for (const hire of isolated) {
      expect(spaces.some((s) => s.path === wtFor(hire.agentId))).toBe(true)
    }
  })

  /**
   * ADR-0026 gave every agent its own engine config directory, and the trust
   * record lives in that directory. "Trust this path" stopped being a complete
   * instruction the day that landed: the other half is whose engine to tell,
   * and nothing in `plannedWorkspaces` said it.
   */
  it('names the agent whose engine is being told, for every directory', async () => {
    const r = rig()
    const plan = await planFor(r, { hires: ['oncall', 'deps'] })
    const grants = plannedTrustGrants(plan, wtFor)
    const oncall = 'agent.crew-myapp-oncall'
    const deps = 'agent.crew-myapp-deps'

    // Each isolated hire's own worktree, granted to that hire and nobody else.
    expect(grants).toContainEqual({
      agentId: oncall,
      path: wtFor(oncall),
      existence: 'will-be-created'
    })
    expect(grants).toContainEqual({
      agentId: deps,
      path: wtFor(deps),
      existence: 'will-be-created'
    })
    expect(grants.filter((g) => g.path === wtFor(oncall)).map((g) => g.agentId)).toEqual([oncall])

    // ...and the target, for EVERY hire. That preserves ADR-0021's decision
    // unchanged - the activation records approval for the target the Architect
    // named - which used to happen for free because one file served every
    // agent. Narrowing it to "only the hires that land there" would be a new
    // decision taken silently in the commit that split the file.
    expect(
      grants
        .filter((g) => g.path === r.targetDir)
        .map((g) => g.agentId)
        .sort()
    ).toEqual([deps, oncall].sort())
  })

  it('grants each (agent, directory) pair exactly once', async () => {
    // A duplicate would write the same key twice and log two grants for one
    // directory, which reads as two decisions where there was one.
    const r = rig()
    const plan = await planFor(r, { hires: ['oncall', 'deps'], isolation: 'target' })
    const grants = plannedTrustGrants(plan, wtFor)
    const keys = grants.map((g) => `${g.agentId} ${g.path}`)

    expect(new Set(keys).size).toBe(keys.length)
    expect(grants.every((g) => g.path === r.targetDir)).toBe(true)
  })

  it('covers every hire even when none of them works in the target', async () => {
    // The all-isolated case: nobody's working directory IS the target, and the
    // target's entry names no agents at all - so with one config file per agent
    // it would have been recorded in nobody's.
    const r = rig()
    const plan = await planFor(r, { hires: ['a', 'b', 'c'] })
    const grants = plannedTrustGrants(plan, wtFor)

    expect(plannedWorkspaces(plan, wtFor)[0]?.agentIds).toEqual([])
    for (const hire of plan.hires) {
      expect(grants.some((g) => g.agentId === hire.agentId && g.path === r.targetDir)).toBe(true)
      expect(grants.some((g) => g.agentId === hire.agentId && g.path === wtFor(hire.agentId))).toBe(
        true
      )
    }
  })

  it('asks the SAME path function the lifecycle spawns with', async () => {
    // The anti-drift property. The trusted directory and the directory the
    // agent is actually put in come from one function; a second copy that
    // differed by a character would trust a path nothing reads, and the only
    // symptom would be a parked agent.
    const r = rig()
    const plan = await planFor(r, { hires: ['oncall'] })
    const asked: string[] = []
    plannedWorkspaces(plan, (agentId) => {
      asked.push(agentId)
      return `/wt/${agentId}`
    })
    expect(asked).toEqual(['agent.crew-myapp-oncall'])
  })

  it('is called before a single hire is spawned', async () => {
    // Trust has to be recorded before any process exists: the dialog it answers
    // appears before the session, so an agent that meets it can never report it.
    const r = rig()
    writeBundle(r.profiles, 'crew', { hires: ['oncall'] })
    const result = await r.activations.activate({
      profile: 'crew',
      target: target(r.targetDir)
    })
    if (!result.ok) throw new Error(result.reasons.join(' · '))

    expect(r.order[0]).toBe('beforeHires')
    expect(r.order.indexOf('beforeHires')).toBeLessThan(
      r.order.findIndex((step) => step.startsWith('spawn:'))
    )
  })

  it('is not called at all when the plan is refused', async () => {
    // Nothing was activated, so nothing is consented to.
    const r = rig()
    writeBundle(r.profiles, 'crew', { hires: ['oncall'] })
    const result = await r.activations.activate({
      profile: 'crew',
      target: { kind: 'app', id: 'myapp', path: r.targetDir }
    })
    expect(result.ok).toBe(false)
    expect(r.order).not.toContain('beforeHires')
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileActivations, ProfileStore } from '../../src/main/profiles'
import type { Trigger } from '../../src/main/scheduler'
import type { SpawnRequest } from '../../src/shared/agents'
import { GATE_SCHEMA_VERSION, type AutonomyLevel, type GatePolicy } from '../../src/shared/gates'
import { GateManager } from '../../src/main/watch/gates'
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
      }
    })
  )
  fs.writeFileSync(
    path.join(dir, 'memo-policy.json'),
    JSON.stringify({ schemaVersion: 1, requires: [] })
  )
  fs.writeFileSync(
    path.join(dir, 'harbor.json'),
    JSON.stringify({ schemaVersion: 1, repos: [], channels: [], webhooks: [] })
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
        budget: { dailyTokens: 1_000 * (i + 1) }
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
  const triggers = new Map<string, Trigger>()
  const logs: Record<string, unknown>[] = []

  const activations = new ProfileActivations({
    store: new ProfileStore(profiles, path.join(home, 'no-builtins')),
    globalAutonomy: () => options.global ?? 'autonomous',
    ...(options.missingGrants ? { missingGrants: options.missingGrants } : {}),
    spawn: (request) => {
      if ((options.failOn ?? []).some((name) => request.agentId.endsWith(`-${name}`))) {
        return Promise.reject(new Error(`engine "${request.engine}" is not installed`))
      }
      spawned.push(request)
      return Promise.resolve({})
    },
    kill: (agentId) => killed.push(agentId),
    addTrigger: (trigger) => triggers.set(trigger.id, trigger),
    removeTrigger: (id) => triggers.delete(id),
    targetExists: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
    now: () => new Date('2026-08-31T12:00:00.000Z'),
    onLogEvent: (draft) => logs.push(draft)
  })

  return { activations, profiles, targetDir, spawned, killed, triggers, logs }
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

    const planned = r.activations.preview({
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

  it('claims nothing when no resolver is wired', () => {
    // The parameter is optional so the class stays constructible in a rig that
    // has no broker; absent means "not checked", never "all available".
    const r = rig()
    writeBundle(r.profiles, 'skeleton-crew', { envGrants: ['GH_TOKEN'] })
    const planned = r.activations.preview({
      profile: 'skeleton-crew',
      target: target(r.targetDir)
    })
    if (!planned.ok) throw new Error(planned.reasons.join(' · '))
    expect(planned.plan.grantsUnavailable).toEqual([])
  })
})

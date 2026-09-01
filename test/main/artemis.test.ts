import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { SpawnRequest } from '../../src/shared/agents'
import { AUTHORITY_SCHEMA_VERSION } from '../../src/shared/authority'
import type { RegistryEntry } from '../../src/shared/registry'
import { TEMPLE_SEAT } from '../../src/shared/seats'
import { AgentManager, type AgentSpawner } from '../../src/main/agents'
import { ARTEMIS_AGENT_ID, ARTEMIS_ROLE, Artemis, AUTHORITY_REL } from '../../src/main/artemis'
import { EngineRegistry, type SpawnPlan } from '../../src/main/engines'
import { HookServer } from '../../src/main/hooks'
import { PromptStore } from '../../src/main/prompts'
import { MemorySettingsRegistry } from '../../src/main/settings-registry'
import { makeFakeAdapter } from '../fakes/fake-adapter'
import { removeTempDir } from '../tmpdir'

/**
 * Artemis's lifecycle (FR-5.1–5.5, ADR-0005), against the fake engine.
 *
 * FR-5.1 is the property most of these guard: Artemis is an ordinary engine
 * process holding a privileged *role*. So what is asserted is that the harness
 * hires her the way it hires anyone, hands her a policy it never reads, brings
 * her back when she dies — and holds no opinion of its own about what she
 * should decide.
 */

const BUNDLED_PROMPTS = fileURLToPath(new URL('../../prompts/', import.meta.url))

/** A spawner that never runs anything, but can be made to die like a real one. */
class ScriptedSpawner implements AgentSpawner {
  readonly spawns: { id: string; plan: SpawnPlan }[] = []
  private readonly live = new Set<string>()
  private readonly listeners: ((id: string, exitCode: number) => void)[] = []

  spawnAgent(id: string, plan: SpawnPlan): void {
    this.spawns.push({ id, plan })
    this.live.add(id)
  }
  write(): void {}
  kill(id: string): void {
    this.live.delete(id)
  }
  has(id: string): boolean {
    return this.live.has(id)
  }
  onExit(cb: (id: string, exitCode: number) => void): void {
    this.listeners.push(cb)
  }
  async crash(id: string, code = 1): Promise<void> {
    this.live.delete(id)
    for (const listener of this.listeners) listener(id, code)
    // Let the manager's async unwind settle before the test looks.
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  }
}

const temps: string[] = []
const servers: HookServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

interface Rig {
  readonly artemis: Artemis
  readonly manager: AgentManager
  readonly spawner: ScriptedSpawner
  readonly roster: Map<string, RegistryEntry>
  readonly logs: Record<string, unknown>[]
  readonly degradations: string[]
  readonly home: string
  readonly agoraRoot: string
  orchestratorId: string | null
  identity(): string
  /** Moves the injected clock, for the respawn stability window. */
  advance(ms: number): void
  /** Waits out the injected backoff ladder without sleeping. */
  settle(): Promise<void>
}

async function rig(
  over: { backoffMs?: readonly number[]; stabilityMs?: number } = {}
): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-artemis-'))
  temps.push(home)
  const agoraRoot = path.join(home, 'agora')
  fs.mkdirSync(agoraRoot, { recursive: true })

  const hookServer = new HookServer({ onEvent: () => {}, onRejected: () => {} })
  await hookServer.start(home)
  servers.push(hookServer)

  const prompts = new PromptStore(path.join(home, 'prompts'), BUNDLED_PROMPTS)
  const engines = new EngineRegistry()
  engines.register(
    makeFakeAdapter({
      scriptPath: path.join(home, 'idle.mjs'),
      settingsRegistry: new MemorySettingsRegistry()
    })
  )
  fs.writeFileSync(path.join(home, 'idle.mjs'), 'setTimeout(() => {}, 60_000)\n')

  const spawner = new ScriptedSpawner()
  const roster = new Map<string, RegistryEntry>()
  const logs: Record<string, unknown>[] = []
  const degradations: string[] = []
  const state: { orchestratorId: string | null } = { orchestratorId: null }
  // An injected clock, so the stability window is a property rather than a wait.
  const clock = { ms: 1_700_000_000_000 }

  let artemis: Artemis | null = null
  const manager = new AgentManager({
    engines,
    hookServer,
    spawner,
    prompts,
    agoraRoot,
    probe: async () => '1.0.0-fake',
    roleBrief: (card) => artemis?.roleBrief(card) ?? null,
    rosterSeats: () => new Map([...roster].map(([id, entry]) => [id, entry.seat])),
    onRosterChange: (agentId, entry) => {
      if (entry) roster.set(agentId, entry)
      else roster.delete(agentId)
    },
    onChange: (card) => artemis?.noteCard(card)
  })

  artemis = new Artemis({
    agents: manager,
    prompts,
    home,
    cwd: agoraRoot,
    setOrchestrator: (agentId) => {
      state.orchestratorId = agentId
    },
    onLogEvent: (draft) => logs.push(draft),
    onDegraded: (detail) => degradations.push(detail),
    // No real waiting: the ladder's *shape* is the property, not its seconds.
    delay: async () => {},
    now: () => clock.ms,
    ...(over.backoffMs
      ? { respawn: { backoffMs: over.backoffMs, stabilityMs: over.stabilityMs ?? 60_000 } }
      : {})
  })

  return {
    artemis,
    manager,
    spawner,
    roster,
    logs,
    degradations,
    home,
    agoraRoot,
    get orchestratorId() {
      return state.orchestratorId
    },
    identity: () =>
      fs.readFileSync(path.join(agoraRoot, 'agents', ARTEMIS_AGENT_ID, 'identity.md'), 'utf8'),
    advance: (ms) => {
      clock.ms += ms
    },
    settle: () => artemis.drained()
  }
}

const ENGINE: SpawnRequest['engine'] = 'custom'

describe('she is hired like anyone else (FR-5.1)', () => {
  it('auto-spawns at startup', async () => {
    const r = await rig()
    const card = await r.artemis.start(ENGINE)
    expect(card?.agentId).toBe(ARTEMIS_AGENT_ID)
    expect(card?.lifecycle).toBe('running')
    expect(r.spawner.spawns.map((s) => s.id)).toEqual([ARTEMIS_AGENT_ID])
  })

  it('takes the temple seat and is flagged in the roster (SDD §4.1)', async () => {
    const r = await rig()
    await r.artemis.start(ENGINE)
    expect(r.roster.get(ARTEMIS_AGENT_ID)).toMatchObject({
      role: ARTEMIS_ROLE,
      seat: TEMPLE_SEAT,
      isOrchestrator: true
    })
  })

  it('records orchestratorId', async () => {
    const r = await rig()
    await r.artemis.start(ENGINE)
    expect(r.orchestratorId).toBe(ARTEMIS_AGENT_ID)
  })

  it('holds no credentials', async () => {
    const r = await rig()
    const card = await r.artemis.start(ENGINE)
    // ADR-0010: orchestration is routing and text. A grant here would be a
    // credential held by the busiest process in the company.
    expect(card?.envGrants).toEqual([])
  })

  it('carries a budget, like any other hire (ADR-0011)', async () => {
    const r = await rig()
    const card = await r.artemis.start(ENGINE)
    expect(card?.dailyTokens).toBeGreaterThan(0)
  })

  it('is a degradation, not a crash, when she cannot be hired', async () => {
    const r = await rig()
    // A second hire under the same id is refused by the lifecycle.
    await r.artemis.start(ENGINE)
    const again = await r.artemis.start(ENGINE)
    expect(again).toBeNull()
    expect(r.degradations.join(' ')).toMatch(/artemis:/)
  })
})

describe('her policy is text, and the harness does not read it (ADR-0005)', () => {
  it('puts prompts/artemis/system.md in front of her', async () => {
    const r = await rig()
    await r.artemis.start(ENGINE)
    const identity = r.identity()
    expect(identity).toContain('Artemis — orchestrator of this company')
    expect(identity).toContain('escalation policy')
  })

  it('gives that brief to nobody else', async () => {
    const r = await rig()
    await r.artemis.start(ENGINE)
    await r.manager.spawn({
      agentId: 'agent.mason',
      name: 'Mason',
      role: 'ci-babysitter',
      engine: ENGINE,
      cwd: path.join(r.home, 'repo'),
      capabilities: [],
      envGrants: []
    })
    const mason = fs.readFileSync(
      path.join(r.agoraRoot, 'agents', 'agent.mason', 'identity.md'),
      'utf8'
    )
    expect(mason).not.toContain('orchestrator of this company')
  })

  it('follows the Architect’s edit, not the bundled copy', async () => {
    const r = await rig()
    // The harness-home copy wins (PromptStore), which is what "editable from
    // the UI" means on disk. If the lifecycle had any of this compiled in, an
    // edit here would change nothing.
    const homePrompts = path.join(r.home, 'prompts', 'artemis')
    fs.mkdirSync(homePrompts, { recursive: true })
    fs.writeFileSync(path.join(homePrompts, 'system.md'), '# Artemis\n\nEscalate everything.\n')
    await r.artemis.start(ENGINE)
    expect(r.identity()).toContain('Escalate everything.')
    expect(r.identity()).not.toContain('escalation policy')
  })

  it('reports an unreadable policy rather than running her without one', async () => {
    const r = await rig()
    const homePrompts = path.join(r.home, 'prompts', 'artemis')
    fs.mkdirSync(homePrompts, { recursive: true })
    // A directory where the file should be: readable path, unreadable file.
    fs.mkdirSync(path.join(homePrompts, 'system.md'), { recursive: true })
    await r.artemis.start(ENGINE)
    expect(r.degradations.join(' ')).toMatch(/policy prompt unreadable/)
  })
})

describe('she is brought back when she dies (FR-5.4)', () => {
  it('respawns after a crash', async () => {
    const r = await rig()
    await r.artemis.start(ENGINE)
    await r.spawner.crash(ARTEMIS_AGENT_ID)
    await r.settle()
    expect(r.spawner.spawns).toHaveLength(2)
    expect(r.spawner.has(ARTEMIS_AGENT_ID)).toBe(true)
  })

  it('carries the engine session forward — respawn WITH memory', async () => {
    const r = await rig()
    await r.artemis.start(ENGINE)
    // The event plane recorded a session for this spawn (M3.2 wiring).
    r.manager.noteSession(ARTEMIS_AGENT_ID, 'sess-temple-1')
    await r.spawner.crash(ARTEMIS_AGENT_ID)
    await r.settle()
    expect(r.spawner.spawns[1]?.plan.argv).toContain('--resume')
    expect(r.spawner.spawns[1]?.plan.argv).toContain('sess-temple-1')
  })

  it('resumes the LAST session, not the first', async () => {
    const r = await rig()
    await r.artemis.start(ENGINE)
    r.manager.noteSession(ARTEMIS_AGENT_ID, 'sess-1')
    r.manager.noteSession(ARTEMIS_AGENT_ID, 'sess-2')
    await r.spawner.crash(ARTEMIS_AGENT_ID)
    await r.settle()
    expect(r.spawner.spawns[1]?.plan.argv).toContain('sess-2')
    expect(r.spawner.spawns[1]?.plan.argv).not.toContain('sess-1')
  })

  it('still respawns when the event plane never reported a session', async () => {
    const r = await rig()
    await r.artemis.start(ENGINE)
    await r.spawner.crash(ARTEMIS_AGENT_ID)
    await r.settle()
    // A fresh session is a worse respawn than a resumed one, but it is a
    // respawn; refusing to come back would be worse than both.
    expect(r.spawner.spawns).toHaveLength(2)
    expect(r.spawner.spawns[1]?.plan.argv).not.toContain('--resume')
  })

  it('says in the log whether memory actually carried over', async () => {
    const r = await rig()
    await r.artemis.start(ENGINE)
    await r.spawner.crash(ARTEMIS_AGENT_ID)
    await r.settle()
    expect(r.logs.some((entry) => entry['event'] === 'respawned')).toBe(true)
  })

  it('re-injects identity and protocol on the way back', async () => {
    const r = await rig()
    await r.artemis.start(ENGINE)
    fs.rmSync(path.join(r.agoraRoot, 'agents', ARTEMIS_AGENT_ID, 'identity.md'))
    await r.spawner.crash(ARTEMIS_AGENT_ID)
    await r.settle()
    // Engine-native resume plus re-injected identity IS M3's
    // respawn-with-memory (Architect decision); `memory.md` is M4's.
    expect(r.identity()).toContain('orchestrator of this company')
  })

  it('tells her she was restarted', async () => {
    const r = await rig()
    await r.artemis.start(ENGINE)
    await r.spawner.crash(ARTEMIS_AGENT_ID)
    await r.settle()
    expect(r.identity()).toContain('You were restarted')
  })

  it('mints a fresh hook token, because the old process died with the old one', async () => {
    const r = await rig()
    await r.artemis.start(ENGINE)
    await r.spawner.crash(ARTEMIS_AGENT_ID)
    await r.settle()
    const [first, second] = r.spawner.spawns
    expect(first?.plan.env['EPH_HOOK_TOKEN']).toBeTruthy()
    expect(second?.plan.env['EPH_HOOK_TOKEN']).not.toBe(first?.plan.env['EPH_HOOK_TOKEN'])
  })

  it('backs off, and gives up rather than looping forever', async () => {
    const r = await rig({ backoffMs: [1, 2] })
    await r.artemis.start(ENGINE)
    for (let i = 0; i < 4; i += 1) {
      await r.spawner.crash(ARTEMIS_AGENT_ID)
      await r.settle()
    }
    // Two rungs of ladder, then the harness stops: a crashed orchestrator that
    // respawns instantly forever is a fork bomb with a laurel wreath.
    expect(r.spawner.spawns).toHaveLength(3)
    expect(r.degradations.join(' ')).toMatch(/will not be restarted again/)
  })

  it('clears orchestratorId when it gives up, rather than naming a dead agent', async () => {
    const r = await rig({ backoffMs: [1] })
    await r.artemis.start(ENGINE)
    await r.spawner.crash(ARTEMIS_AGENT_ID)
    await r.settle()
    await r.spawner.crash(ARTEMIS_AGENT_ID)
    await r.settle()
    expect(r.orchestratorId).toBeNull()
  })

  it('starts the ladder over once she has STAYED up', async () => {
    const r = await rig({ backoffMs: [1], stabilityMs: 60_000 })
    await r.artemis.start(ENGINE)
    await r.spawner.crash(ARTEMIS_AGENT_ID)
    await r.settle()
    // She came back and ran for a while: that is recovery, and the next crash
    // gets the whole ladder again.
    r.advance(120_000)
    await r.spawner.crash(ARTEMIS_AGENT_ID)
    await r.settle()
    expect(r.spawner.spawns).toHaveLength(3)
  })

  it('does not buy another ladder by dying on the way up', async () => {
    const r = await rig({ backoffMs: [1, 1], stabilityMs: 60_000 })
    await r.artemis.start(ENGINE)
    // Six crashes, each immediately after coming back. Without the stability
    // window the counter resets on every start and the harness respawns her
    // forever — which is the failure the ladder exists to bound.
    for (let i = 0; i < 6; i += 1) {
      await r.spawner.crash(ARTEMIS_AGENT_ID)
      await r.settle()
    }
    expect(r.spawner.spawns).toHaveLength(3)
    expect(r.degradations.join(' ')).toMatch(/will not be restarted again/)
  })

  it('does not respawn after shutdown', async () => {
    const r = await rig()
    await r.artemis.start(ENGINE)
    r.artemis.stop()
    await r.spawner.crash(ARTEMIS_AGENT_ID)
    await r.settle()
    expect(r.spawner.spawns).toHaveLength(1)
  })

  it('ignores another agent’s exit', async () => {
    const r = await rig()
    await r.artemis.start(ENGINE)
    await r.manager.spawn({
      agentId: 'agent.mason',
      name: 'Mason',
      role: 'ci-babysitter',
      engine: ENGINE,
      cwd: path.join(r.home, 'repo'),
      capabilities: [],
      envGrants: []
    })
    await r.spawner.crash('agent.mason')
    await r.settle()
    expect(r.spawner.spawns.filter((s) => s.id === 'agent.mason')).toHaveLength(1)
  })
})

describe('her delegated authority comes off disk (FR-5.5)', () => {
  function writeTable(home: string, table: unknown): void {
    fs.writeFileSync(path.join(home, AUTHORITY_REL), JSON.stringify(table, null, 2))
  }

  it('delegates nothing when there is no table', async () => {
    const r = await rig()
    expect(r.artemis.authority().grants).toEqual([])
    expect(r.artemis.mayDecide({ class: 'memo', domain: 'docs' }).allowed).toBe(false)
  })

  it('reads a table the Architect wrote', async () => {
    const r = await rig()
    writeTable(r.home, {
      schemaVersion: AUTHORITY_SCHEMA_VERSION,
      grants: [{ class: 'memo', domains: ['test-code'] }]
    })
    expect(r.artemis.mayDecide({ class: 'memo', domain: 'test-code' }).allowed).toBe(true)
    expect(r.artemis.mayDecide({ class: 'memo', domain: 'infra' }).allowed).toBe(false)
  })

  it('picks up an edit made while the company runs', async () => {
    const r = await rig()
    expect(r.artemis.mayDecide({ class: 'route', domain: 'ci' }).allowed).toBe(false)
    writeTable(r.home, {
      schemaVersion: AUTHORITY_SCHEMA_VERSION,
      grants: [{ class: 'route', domains: ['ci'] }]
    })
    // A table nobody re-reads is a setting that appears to work.
    expect(r.artemis.mayDecide({ class: 'route', domain: 'ci' }).allowed).toBe(true)
  })

  it('delegates nothing when the table will not parse, and says so', async () => {
    const r = await rig()
    writeTable(r.home, { schemaVersion: 1, grants: [{ class: 'memo' }] })
    expect(r.artemis.mayDecide({ class: 'memo', domain: 'docs' }).allowed).toBe(false)
    expect(r.degradations.join(' ')).toMatch(/authority\.json refused/)
  })

  it('delegates nothing when the table is not JSON at all', async () => {
    const r = await rig()
    fs.writeFileSync(path.join(r.home, AUTHORITY_REL), '{ half a table')
    expect(r.artemis.mayDecide({ class: 'gate', domain: 'ci' }).allowed).toBe(false)
    expect(r.degradations.join(' ')).toMatch(/not valid JSON/)
  })

  it('reports a broken table once per reason, not once per decision', async () => {
    const r = await rig()
    writeTable(r.home, { schemaVersion: 1, grants: [{ class: 'memo' }] })
    for (let i = 0; i < 5; i += 1) r.artemis.mayDecide({ class: 'memo', domain: 'docs' })
    // One bad file plus a busy company must not evict everything else from the
    // health buffer (the same call M3.3 made for the gate policy).
    expect(r.degradations.filter((d) => d.includes('authority.json'))).toHaveLength(1)
  })

  it('logs a countersignature for everything it lets her decide', async () => {
    const r = await rig()
    writeTable(r.home, {
      schemaVersion: AUTHORITY_SCHEMA_VERSION,
      grants: [{ class: 'memo', domains: ['test-code'] }]
    })
    r.artemis.mayDecide({ class: 'memo', domain: 'test-code' })
    expect(r.logs.at(-1)).toMatchObject({
      kind: 'orchestrator',
      event: 'countersigned',
      by: ARTEMIS_AGENT_ID,
      class: 'memo',
      domain: 'test-code',
      under: 'memo:test-code'
    })
  })

  it('logs the escalation when it does not', async () => {
    const r = await rig()
    r.artemis.mayDecide({ class: 'spend', domain: 'ci', spendTokens: 10 })
    expect(r.logs.at(-1)).toMatchObject({
      kind: 'orchestrator',
      event: 'escalated',
      class: 'spend',
      domain: 'ci'
    })
  })

  it('renders the escalation notice from a file, not from code', async () => {
    const r = await rig()
    const notice = r.artemis.escalationNotice('a deploy to production', 'no grant covers gate/prod')
    expect(notice).toContain('a deploy to production')
    expect(notice).toContain('no grant covers gate/prod')
  })
})

describe('the harness holds no orchestration rules of its own (FR-5.1)', () => {
  it('never decides anything itself — every path answers from the table', async () => {
    const r = await rig()
    // With a table that grants everything, the harness allows everything: it
    // has no opinion to override the Architect's with.
    fs.writeFileSync(
      path.join(r.home, AUTHORITY_REL),
      JSON.stringify({
        schemaVersion: AUTHORITY_SCHEMA_VERSION,
        grants: [
          { class: 'route', domains: ['*'] },
          { class: 'task', domains: ['*'] },
          { class: 'gate', domains: ['*'] },
          { class: 'memo', domains: ['*'] },
          { class: 'spend', domains: ['*'], maxSpendTokens: 1 }
        ]
      })
    )
    for (const cls of ['route', 'task', 'gate', 'memo'] as const) {
      expect(r.artemis.mayDecide({ class: cls, domain: 'anything' }).allowed, cls).toBe(true)
    }
    expect(r.artemis.mayDecide({ class: 'spend', domain: 'x', spendTokens: 1 }).allowed).toBe(true)
  })

  it('has no opinion of its own when the table is silent', async () => {
    const r = await rig()
    // Requests that "look routine" get the same answer as any other: the
    // harness holds no notion of routine. That notion is Artemis's, and it
    // lives in `prompts/artemis/system.md`.
    for (const request of [
      { class: 'route' as const, domain: 'docs' },
      { class: 'task' as const, domain: 'docs' },
      { class: 'memo' as const, domain: 'test-code' }
    ]) {
      expect(r.artemis.mayDecide(request).allowed, request.class).toBe(false)
    }
  })

  it('knows which agent holds the role, and nothing about the role', async () => {
    const r = await rig()
    expect(r.artemis.isOrchestrator(ARTEMIS_AGENT_ID)).toBe(true)
    expect(r.artemis.isOrchestrator('agent.mason')).toBe(false)
  })
})

/**
 * The ladder and the provider's usage limit (`src/shared/capacity.ts`).
 *
 * The ladder counts CRASHES and it ends, deliberately — an orchestrator that
 * will not start is a fault a human has to see. A usage limit is not that
 * fault: restarting into one cannot succeed, so a company that spent rungs on
 * refusals would end its ladder and lose its orchestrator over a condition
 * guaranteed to clear on its own. These are the tests that say so.
 */
describe('Artemis and the provider usage limit', () => {
  it('spends no rung on an exit that happened while capacity was parked', async () => {
    const r = await rig({ backoffMs: [1, 2] })
    await r.artemis.start(ENGINE)
    r.artemis.holdForCapacity()

    // Three exits during the park. Without the hold, the two-rung ladder would
    // be spent by the second one and the company would have no orchestrator.
    for (let i = 0; i < 3; i += 1) {
      await r.spawner.crash(ARTEMIS_AGENT_ID)
      await r.settle()
    }

    expect(r.spawner.spawns).toHaveLength(1)
    expect(r.degradations.join(' ')).not.toMatch(/will not be restarted again/)
    expect(r.orchestratorId).toBe(ARTEMIS_AGENT_ID)
    expect(r.logs.some((entry) => entry['event'] === 'respawn-deferred-for-capacity')).toBe(true)
  })

  it('brings her back when capacity returns, still on rung zero', async () => {
    const r = await rig({ backoffMs: [1, 2] })
    await r.artemis.start(ENGINE)
    r.artemis.holdForCapacity()
    await r.spawner.crash(ARTEMIS_AGENT_ID)
    await r.settle()
    expect(r.spawner.spawns).toHaveLength(1)

    r.artemis.releaseForCapacity()
    await r.settle()

    // She is back...
    expect(r.spawner.spawns).toHaveLength(2)
    expect(r.logs.some((entry) => entry['event'] === 'respawn-after-capacity')).toBe(true)
    // ...and the ladder is untouched, so a real crash later still gets all of
    // it. Two more crashes exhaust two rungs, not zero.
    await r.spawner.crash(ARTEMIS_AGENT_ID)
    await r.settle()
    await r.spawner.crash(ARTEMIS_AGENT_ID)
    await r.settle()
    expect(r.spawner.spawns).toHaveLength(4)
    expect(r.degradations.join(' ')).not.toMatch(/will not be restarted again/)
  })

  it('does nothing on a release nobody held, and holds only once', async () => {
    const r = await rig({ backoffMs: [1] })
    await r.artemis.start(ENGINE)

    r.artemis.releaseForCapacity()
    await r.settle()
    expect(r.spawner.spawns).toHaveLength(1)

    r.artemis.holdForCapacity()
    r.artemis.holdForCapacity()
    expect(r.artemis.heldForCapacity()).toBe(true)
    expect(r.logs.filter((entry) => entry['event'] === 'held-for-capacity')).toHaveLength(1)

    // Released with no exit outstanding: she was never down, so nothing spawns.
    r.artemis.releaseForCapacity()
    await r.settle()
    expect(r.spawner.spawns).toHaveLength(1)
    expect(r.artemis.heldForCapacity()).toBe(false)
  })

  it('still ends the ladder for real crashes once the hold is lifted', async () => {
    // The hold must not become a way to never give up: a genuinely broken
    // orchestrator has to reach the Architect.
    const r = await rig({ backoffMs: [1, 2] })
    await r.artemis.start(ENGINE)
    r.artemis.holdForCapacity()
    r.artemis.releaseForCapacity()

    for (let i = 0; i < 4; i += 1) {
      await r.spawner.crash(ARTEMIS_AGENT_ID)
      await r.settle()
    }
    expect(r.degradations.join(' ')).toMatch(/will not be restarted again/)
  })
})

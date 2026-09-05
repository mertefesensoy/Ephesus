import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnRequestSchema, type SpawnRequest } from '../../src/shared/agents'
import type { RegistryEntry } from '../../src/shared/registry'
import { TEMPLE_SEAT } from '../../src/shared/seats'
import { AgentManager, isOrchestratorRole, type AgentSpawner } from '../../src/main/agents'
import { EngineRegistry } from '../../src/main/engines'
import { ClaudeAdapter } from '../../src/main/engines/claude'
import { HookServer } from '../../src/main/hooks'
import { PromptStore } from '../../src/main/prompts'
import { removeTempDir } from '../tmpdir'
import { engineConfigDir } from '../../src/main/engines/engine-home'

/**
 * Seats reaching the roster (SDD §4.1, UI-DESIGN §5) — the M2 carried item, at
 * the boundary where it was actually broken.
 *
 * `src/shared/seats.ts` is where the *rule* is tested. What is tested here is
 * that the lifecycle uses it: from M1 to M2 the manager wrote the constant
 * `'terrace'` into every roster entry, so a correct seat function would have
 * changed nothing at all. Deleting the assignment and hard-coding a seat again
 * must fail here.
 */

const BUNDLED_PROMPTS = fileURLToPath(new URL('../../prompts/', import.meta.url))

class SilentSpawner implements AgentSpawner {
  private readonly live = new Set<string>()
  spawnAgent(id: string): void {
    this.live.add(id)
  }
  write(): void {}
  kill(id: string): void {
    this.live.delete(id)
  }
  has(id: string): boolean {
    return this.live.has(id)
  }
  onExit(): void {}
}

const temps: string[] = []
const servers: HookServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

interface Rig {
  readonly manager: AgentManager
  readonly roster: Map<string, RegistryEntry>
  readonly repo: string
  hire(over: Partial<SpawnRequest>): SpawnRequest
}

/** A manager whose roster is a real map, seeded the way a restart would seed it. */
async function rig(seeded: Iterable<[string, string]> = []): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-seats-'))
  temps.push(home)
  const repo = path.join(home, 'repo')
  fs.mkdirSync(repo, { recursive: true })

  const hookServer = new HookServer({ onEvent: () => {}, onRejected: () => {} })
  await hookServer.start(home)
  servers.push(hookServer)

  const prompts = new PromptStore(path.join(home, 'prompts'), BUNDLED_PROMPTS)
  const engines = new EngineRegistry()
  engines.register(
    new ClaudeAdapter({ prompts, hookShimPath: path.join(home, 'shims', 'eph-hook.mjs') })
  )

  const roster = new Map<string, RegistryEntry>()
  const seedSeats = new Map(seeded)
  const manager = new AgentManager({
    engines,
    hookServer,
    spawner: new SilentSpawner(),
    prompts,
    // ADR-0026: the real resolver, rooted in this test's own temp home, so a
    // spawn here isolates exactly the way a spawn in the app does.
    engineConfigDirFor: (engineId, agentId) =>
      engineConfigDir(path.join(home, 'engines'), engineId, agentId),
    agoraRoot: path.join(home, 'agora'),
    probe: async () => '2.1.247',
    rosterSeats: () => {
      const seats = new Map(seedSeats)
      for (const [agentId, entry] of roster) seats.set(agentId, entry.seat)
      return seats
    },
    onRosterChange: (agentId, entry) => {
      if (entry) roster.set(agentId, entry)
      else roster.delete(agentId)
    }
  })

  return {
    manager,
    roster,
    repo,
    hire: (over) =>
      spawnRequestSchema.parse({
        agentId: 'agent.mason',
        name: 'Mason',
        role: 'ci-babysitter',
        engine: 'claude',
        cwd: repo,
        capabilities: [],
        envGrants: [],
        ...over
      })
  }
}

describe('a hire is given a real seat', () => {
  it('writes a seat that names a place, not the M2 placeholder', async () => {
    const { manager, roster, hire } = await rig()
    await manager.spawn(hire({}))
    expect(roster.get('agent.mason')?.seat).toBe('terrace-1')
  })

  it('puts the same seat on the card the floor reads', async () => {
    const { manager, hire } = await rig()
    const card = await manager.spawn(hire({}))
    expect(card.seat).toBe('terrace-1')
  })

  it('seats a second hire somewhere else', async () => {
    const { manager, roster, hire } = await rig()
    await manager.spawn(hire({}))
    await manager.spawn(hire({ agentId: 'agent.scribe', name: 'Scribe' }))
    const seats = [...roster.values()].map((entry) => entry.seat)
    expect(seats).toEqual(['terrace-1', 'terrace-2'])
  })

  it('seats two hires started together on different desks', async () => {
    const { manager, roster, hire } = await rig()
    // Both spawns are in flight before either roster write lands; without the
    // manager's own memory they would both be handed `terrace-1`.
    await Promise.all([
      manager.spawn(hire({})),
      manager.spawn(hire({ agentId: 'agent.scribe', name: 'Scribe' }))
    ])
    const seats = [...roster.values()].map((entry) => entry.seat)
    expect(new Set(seats).size).toBe(2)
  })

  it('keeps the seat when the roster is written again for the same agent', async () => {
    const { manager, roster, hire } = await rig()
    await manager.spawn(hire({}))
    const seat = roster.get('agent.mason')?.seat
    // The status mirror rewrites the whole entry; before M3.6 it rewrote the
    // seat as the constant `'terrace'` too, so a seat could not survive an
    // agent going ghost.
    await manager.shutdown()
    expect(roster.get('agent.mason')).toMatchObject({ status: 'ghost', seat })
    expect(seat).toBe('terrace-1')
  })

  it('honours the seat a previous run recorded, rather than reshuffling', async () => {
    const { manager, roster, hire } = await rig([['agent.mason', 'terrace-9']])
    await manager.spawn(hire({}))
    expect(roster.get('agent.mason')?.seat).toBe('terrace-9')
  })

  it('replaces an M2 roster’s placeholder with a real seat', async () => {
    const { manager, roster, hire } = await rig([['agent.mason', 'terrace']])
    await manager.spawn(hire({}))
    expect(roster.get('agent.mason')?.seat).toBe('terrace-1')
  })

  it('does not take a seat another agent already holds', async () => {
    const { manager, roster, hire } = await rig([['agent.old', 'terrace-1']])
    await manager.spawn(hire({}))
    expect(roster.get('agent.mason')?.seat).toBe('terrace-2')
  })
})

describe('the temple is Artemis’s (ADR-0005, SDD §4.1)', () => {
  it('knows which role owns it', () => {
    expect(isOrchestratorRole('orchestrator')).toBe(true)
    expect(isOrchestratorRole('ci-babysitter')).toBe(false)
  })

  it('seats the orchestrator in the temple and marks her as one', async () => {
    const { manager, roster, hire } = await rig()
    await manager.spawn(hire({ agentId: 'agent.artemis', name: 'Artemis', role: 'orchestrator' }))
    expect(roster.get('agent.artemis')).toMatchObject({
      seat: TEMPLE_SEAT,
      isOrchestrator: true
    })
  })

  it('never seats a worker there', async () => {
    const { manager, roster, hire } = await rig([['agent.mason', TEMPLE_SEAT]])
    await manager.spawn(hire({}))
    expect(roster.get('agent.mason')?.seat).not.toBe(TEMPLE_SEAT)
    expect(roster.get('agent.mason')?.isOrchestrator).toBeUndefined()
  })

  it('keeps the temple free however many workers are hired', async () => {
    const { manager, roster, hire } = await rig()
    for (let i = 0; i < 5; i += 1) {
      await manager.spawn(hire({ agentId: `agent.w${i}`, name: `W${i}` }))
    }
    expect([...roster.values()].map((entry) => entry.seat)).not.toContain(TEMPLE_SEAT)
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnRequestSchema, type SpawnRequest } from '../../src/shared/agents'
import {
  AgentManager,
  MAX_SESSION_IDS,
  recordSession,
  type AgentManagerOptions,
  type AgentSpawner
} from '../../src/main/agents'
import { registryEntrySchema } from '../../src/shared/registry'
import type { RegistryEntry } from '../../src/shared/registry'
import { EngineRegistry } from '../../src/main/engines'
import { ClaudeAdapter } from '../../src/main/engines/claude'
import { HookServer } from '../../src/main/hooks'
import { PromptStore } from '../../src/main/prompts'
import { CostLedger, MemoryLedgerStore } from '../../src/main/watch/ledger'
import { removeTempDir } from '../tmpdir'
import { engineConfigDir } from '../../src/main/engines/engine-home'

/**
 * D10 and D4 (M8.10) — what the roster records about a hire, and how much of a
 * spawn's history the Watch keeps paying for.
 *
 * Both are long-run defects: neither is visible in a fixture, because a roster
 * written once looks fine with a null in it and a spawn with three session ids
 * costs nothing to fold. They show up on day seven.
 */

const BUNDLED_PROMPTS = fileURLToPath(new URL('../../prompts/', import.meta.url))
const temps: string[] = []
const servers: HookServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

class StubSpawner implements AgentSpawner {
  private readonly live = new Set<string>()
  private readonly listeners: ((id: string, exitCode: number) => void)[] = []

  spawnAgent(id: string): void {
    this.live.add(id)
  }
  write(): void {}
  kill(): void {}
  has(id: string): boolean {
    return this.live.has(id)
  }
  onExit(cb: (id: string, exitCode: number) => void): void {
    this.listeners.push(cb)
  }
  async exit(id: string, code: number): Promise<void> {
    this.live.delete(id)
    for (const listener of this.listeners) listener(id, code)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

interface Rig {
  readonly manager: AgentManager
  readonly spawner: StubSpawner
  readonly request: SpawnRequest
  /** Every roster write, in order — the entry as the registry would store it. */
  readonly roster: { agentId: string; entry: RegistryEntry | null }[]
}

async function rig(options: { profileFor?: AgentManagerOptions['profileFor'] } = {}): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-longrun-'))
  temps.push(home)
  const repo = path.join(home, 'repo')
  fs.mkdirSync(repo, { recursive: true })

  const hookServer = new HookServer({ onEvent: () => {}, onRejected: () => {} })
  await hookServer.start(home)
  servers.push(hookServer)

  const prompts = new PromptStore(path.join(home, 'prompts'), BUNDLED_PROMPTS)
  const registry = new EngineRegistry()
  registry.register(
    new ClaudeAdapter({ prompts, hookShimPath: path.join(home, 'shims', 'eph-hook.mjs') })
  )

  const spawner = new StubSpawner()
  const roster: { agentId: string; entry: RegistryEntry | null }[] = []
  const manager = new AgentManager({
    engines: registry,
    hookServer,
    spawner,
    prompts,
    engineConfigDirFor: (engineId, agentId) =>
      engineConfigDir(path.join(home, 'engines'), engineId, agentId),
    agoraRoot: path.join(home, 'agora'),
    probe: async () => '2.1.195',
    // Parsed, not just captured: the roster field is schema'd (SDD §4.1), so a
    // value the registry would reject must fail here rather than in production.
    onRosterChange: (agentId, entry) => {
      roster.push({ agentId, entry: entry === null ? null : registryEntrySchema.parse(entry) })
    },
    ...(options.profileFor ? { profileFor: options.profileFor } : {})
  })

  return {
    manager,
    spawner,
    roster,
    request: spawnRequestSchema.parse({
      agentId: 'agent.mason',
      name: 'Mason',
      role: 'ci-babysitter',
      engine: 'claude',
      cwd: repo,
      capabilities: ['ci', 'git'],
      envGrants: []
    })
  }
}

describe('D10 — the roster records which profile hired an agent', () => {
  it('writes the profile name the resolver gives it', async () => {
    const asked: string[] = []
    const r = await rig({
      profileFor: (agentId) => {
        asked.push(agentId)
        return 'ci-response'
      }
    })
    await r.manager.spawn(r.request)

    // Asked about the agent being hired, and the answer is in the roster.
    expect(asked).toContain('agent.mason')
    expect(r.roster[0]?.entry?.profile).toBe('ci-response')
  })

  it('a standalone hire is still null, and that is a different claim', async () => {
    const r = await rig({ profileFor: () => null })
    await r.manager.spawn(r.request)
    expect(r.roster[0]?.entry?.profile).toBeNull()
  })

  it('a harness with no activations at all still writes a valid entry', async () => {
    const r = await rig()
    await r.manager.spawn(r.request)
    expect(r.roster[0]?.entry?.profile).toBeNull()
  })

  it('a later status write does not erase it', async () => {
    // The bug this guards is the one the `budget` field is already commented
    // for: `onRosterChange` REPLACES the entry, so a second write that does not
    // know the profile would silently drop it. An exit is exactly such a write,
    // and by then the instance may already have been released.
    let released = false
    const r = await rig({ profileFor: () => (released ? null : 'ci-response') })
    await r.manager.spawn(r.request)
    released = true

    await r.spawner.exit('agent.mason', 0)

    expect(r.roster.length).toBeGreaterThan(1)
    // EVERY write carries it, not merely the first.
    for (const write of r.roster) {
      if (write.entry) expect(write.entry.profile).toBe('ci-response')
    }
  })

  it('resolves it once, at hire, rather than on every write', async () => {
    let answers = 0
    const r = await rig({
      profileFor: () => {
        answers += 1
        return 'ci-response'
      }
    })
    await r.manager.spawn(r.request)
    await r.spawner.exit('agent.mason', 0)

    // One resolution for the life of the agent. More than one would mean a
    // later write could get a different answer than the hire did.
    expect(answers).toBe(1)
    expect(r.roster.filter((write) => write.entry !== null).length).toBeGreaterThan(1)
  })
})

describe('D4 — the session retention rule', () => {
  it('keeps ids in first-seen order, newest last', () => {
    const ids = ['s1', 's2', 's3'].reduce<readonly string[]>(
      (acc, id) => recordSession(acc, id),
      []
    )
    expect(ids).toEqual(['s1', 's2', 's3'])
    // `at(-1)` is what resume reads; a trim that took from the end would break
    // resumption silently.
    expect(ids.at(-1)).toBe('s3')
  })

  it('is idempotent — a repeated id neither duplicates nor drops', () => {
    const ids = recordSession(['s1', 's2'], 's2')
    expect(ids).toEqual(['s1', 's2'])
  })

  it('drops the OLDEST once it is over the limit', () => {
    let ids: readonly string[] = []
    for (let i = 1; i <= MAX_SESSION_IDS + 3; i += 1) ids = recordSession(ids, `s${String(i)}`)

    expect(ids).toHaveLength(MAX_SESSION_IDS)
    // The three oldest are gone; the newest is still last.
    expect(ids[0]).toBe('s4')
    expect(ids.at(-1)).toBe(`s${String(MAX_SESSION_IDS + 3)}`)
    expect(ids).not.toContain('s1')
  })

  it('honours a caller-supplied limit', () => {
    let ids: readonly string[] = []
    for (let i = 1; i <= 5; i += 1) ids = recordSession(ids, `s${String(i)}`, 2)
    expect(ids).toEqual(['s4', 's5'])
  })

  it('bounds what the Watch folds, however long the spawn runs', async () => {
    const r = await rig()
    await r.manager.spawn(r.request)

    // A week of sessions on one spawn. Before D4 every one of these was a
    // transcript the Watch re-read IN FULL, twice a tick, forever.
    for (let i = 1; i <= 40; i += 1) r.manager.noteSession('agent.mason', `sess-${String(i)}`)

    const spawn = r.manager.spawnOf('agent.mason')
    expect(spawn?.sessionIds).toHaveLength(MAX_SESSION_IDS)
    // The live session — the one an engine is still writing, and the one
    // `resumeArgs` targets — is always among them.
    expect(spawn?.sessionIds.at(-1)).toBe('sess-40')
  })

  it('leaves a spawn under the limit exactly as it was', async () => {
    const r = await rig()
    await r.manager.spawn(r.request)
    r.manager.noteSession('agent.mason', 'sess-a')
    r.manager.noteSession('agent.mason', 'sess-b')
    expect(r.manager.spawnOf('agent.mason')?.sessionIds).toEqual(['sess-a', 'sess-b'])
  })

  it('ignores a session reported for an agent that is not here', async () => {
    const r = await rig()
    expect(() => {
      r.manager.noteSession('agent.nobody', 'sess-1')
    }).not.toThrow()
  })
})

/**
 * The correctness half of D4, which is the half that could have been got
 * wrong: a trimmed id is a transcript the budget can no longer read, so the
 * question is whether trimming loses money that was already counted.
 *
 * It does not, and the reason is structural rather than incidental:
 * `CostLedger.fold` appends into a durable store and `spendFor` totals rows
 * read back OUT of that store (invariant §11), so what a dropped transcript
 * already contributed stays counted. Dropping the id forgets where to look for
 * MORE, not what was already found. Asserted here rather than reasoned about.
 */
describe('D4 — trimming a session id loses no spend the ledger already has', () => {
  it('keeps the totals from transcripts whose ids have been dropped', () => {
    const store = new MemoryLedgerStore()
    const ledger = new CostLedger({ store, now: () => new Date('2026-09-07T12:00:00Z') })

    // Twelve sessions' worth of spend, folded as the Watch would fold them.
    for (let i = 1; i <= MAX_SESSION_IDS + 4; i += 1) {
      ledger.fold('agent.mason', `sess-${String(i)}.jsonl`, [
        {
          sessionId: `sess-${String(i)}`,
          model: 'claude-opus-5',
          inTokens: 1_000,
          outTokens: 100,
          costUsd: null,
          at: '2026-09-07T09:00:00Z'
        }
      ])
    }

    // Now apply the retention rule to the ids the spawn is carrying.
    let ids: readonly string[] = []
    for (let i = 1; i <= MAX_SESSION_IDS + 4; i += 1) ids = recordSession(ids, `sess-${String(i)}`)
    expect(ids).toHaveLength(MAX_SESSION_IDS)
    expect(ids).not.toContain('sess-1')

    // Every session's tokens are still in the total, including the four whose
    // ids the spawn no longer carries.
    const spend = ledger.spendFor('agent.mason', null)
    expect(spend.cumulativeTotals.inTokens).toBe((MAX_SESSION_IDS + 4) * 1_000)
    expect(spend.todayTotals.inTokens).toBe((MAX_SESSION_IDS + 4) * 1_000)
  })
})

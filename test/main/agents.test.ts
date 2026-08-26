import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnRequestSchema, type SpawnRequest } from '../../src/shared/agents'
import { AgentManager, type AgentSpawner, type VersionProber } from '../../src/main/agents'
import { EngineRegistry } from '../../src/main/engines'
import type { SpawnPlan } from '../../src/main/engines'
import { CLAUDE_SETTINGS_REL, ClaudeAdapter } from '../../src/main/engines/claude'
import { HookServer } from '../../src/main/hooks'
import { PromptStore } from '../../src/main/prompts'
import { postHookEvent, buildEnvelope } from '../../shims/hook-client.mjs'

/**
 * Lifecycle integration on real fs in a temp harness home. The spawner is the
 * one seam (node-pty is Electron-ABI and cannot load here), so what is asserted
 * is exactly what the manager is responsible for: ordering, the repo being left
 * as it was found, and the token's lifetime matching the process's.
 */

const BUNDLED_PROMPTS = fileURLToPath(new URL('../../prompts/', import.meta.url))
const ESCAPE_KEY = String.fromCharCode(0x1b)

interface SpawnCall {
  readonly id: string
  readonly plan: SpawnPlan
}

class RecordingSpawner implements AgentSpawner {
  readonly spawns: SpawnCall[] = []
  readonly writes: { id: string; data: string }[] = []
  readonly kills: string[] = []
  private readonly live = new Set<string>()
  private readonly listeners: ((id: string, exitCode: number) => void)[] = []

  spawnAgent(id: string, plan: SpawnPlan): void {
    this.spawns.push({ id, plan })
    this.live.add(id)
  }
  write(id: string, data: string): void {
    this.writes.push({ id, data })
  }
  kill(id: string): void {
    this.kills.push(id)
  }
  has(id: string): boolean {
    return this.live.has(id)
  }
  onExit(cb: (id: string, exitCode: number) => void): void {
    this.listeners.push(cb)
  }
  /** Drives the exit path the way a real pty would. */
  async exit(id: string, code: number): Promise<void> {
    this.live.delete(id)
    for (const listener of this.listeners) listener(id, code)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const temps: string[] = []
const servers: HookServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

interface Rig {
  readonly manager: AgentManager
  readonly spawner: RecordingSpawner
  readonly hookServer: HookServer
  readonly home: string
  readonly repo: string
  readonly request: SpawnRequest
  readonly changes: string[]
}

async function rig(probe: VersionProber = async () => '2.1.195'): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-agents-'))
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

  const spawner = new RecordingSpawner()
  const changes: string[] = []
  const manager = new AgentManager({
    engines: registry,
    hookServer,
    spawner,
    prompts,
    agoraRoot: path.join(home, 'agora'),
    probe,
    onChange: (card) => changes.push(card.lifecycle)
  })

  return {
    manager,
    spawner,
    hookServer,
    home,
    repo,
    changes,
    request: spawnRequestSchema.parse({
      agentId: 'agent.mason',
      name: 'Mason',
      role: 'ci-babysitter',
      engine: 'claude',
      cwd: repo,
      capabilities: ['ci', 'git'],
      envGrants: ['GH_TOKEN']
    })
  }
}

describe('AgentManager — spawn (FR-1.1, SDD §3)', () => {
  it('materializes identity and protocol, installs settings, and starts the process', async () => {
    const { manager, spawner, home, repo, request } = await rig()
    const card = await manager.spawn(request)

    expect(card.lifecycle).toBe('running')
    expect(card.engine).toBe('claude')
    expect(card.hookFidelity).toBe('native')
    expect(card.engineVersion).toBe('2.1.195')

    const identity = path.join(home, 'agora', 'agents', 'agent.mason', 'identity.md')
    expect(fs.readFileSync(identity, 'utf8')).toContain('ci-babysitter')
    expect(fs.readFileSync(path.join(home, 'agora', 'PROTOCOL.md'), 'utf8')).toContain(
      'Company protocol'
    )
    expect(fs.existsSync(path.join(repo, CLAUDE_SETTINGS_REL))).toBe(true)

    expect(spawner.spawns).toHaveLength(1)
    expect(spawner.spawns[0]?.plan.argv[0]).toBe('claude')
    expect(spawner.spawns[0]?.plan.cwd).toBe(repo)
  })

  it('lists the settings it wrote on the card, so nothing is hidden from the Architect', async () => {
    const { manager, repo, request } = await rig()
    const card = await manager.spawn(request)
    expect(card.settingsWritten).toEqual([path.join(repo, CLAUDE_SETTINGS_REL)])
  })

  it('names granted secrets but never carries a value (ADR-0010)', async () => {
    const { manager, spawner, request } = await rig()
    const card = await manager.spawn(request)

    expect(card.envGrants).toEqual(['GH_TOKEN'])
    // The broker lands in M3; until then no grant resolves to anything, which
    // is the safe direction to be wrong in.
    expect(spawner.spawns[0]?.plan.env['GH_TOKEN']).toBeUndefined()
  })

  it('registers the hook token before the process exists, so no first hook is unauthenticated', async () => {
    const { manager, spawner, hookServer, request } = await rig()
    await manager.spawn(request)

    const token = spawner.spawns[0]?.plan.env['EPH_HOOK_TOKEN'] ?? ''
    expect(token).toHaveLength(64)

    const delivery = await postHookEvent(
      hookServer.endpoint() ?? '',
      buildEnvelope({
        agentId: 'agent.mason',
        token,
        event: 'session-start',
        payload: {},
        ts: Date.now()
      })
    )
    expect(delivery.delivered).toBe(true)
  })

  it('mints a distinct token per spawn', async () => {
    const { manager, spawner, request } = await rig()
    await manager.spawn(request)
    await manager.spawn({ ...request, agentId: 'agent.artemis', name: 'Artemis' })

    const [first, second] = spawner.spawns
    expect(first?.plan.env['EPH_HOOK_TOKEN']).not.toBe(second?.plan.env['EPH_HOOK_TOKEN'])
  })

  it('refuses an unknown engine before touching anything', async () => {
    const { manager, repo, request } = await rig()
    await expect(manager.spawn({ ...request, engine: 'codex' })).rejects.toThrow(
      /no adapter registered/
    )
    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false)
  })
})

describe('AgentManager — exit unwinds the spawn (FR-1.4, ADR-0009 hygiene)', () => {
  it('restores the repo and revokes the token when the agent exits', async () => {
    const { manager, spawner, hookServer, repo, request } = await rig()
    await manager.spawn(request)
    const token = spawner.spawns[0]?.plan.env['EPH_HOOK_TOKEN'] ?? ''
    expect(fs.existsSync(path.join(repo, CLAUDE_SETTINGS_REL))).toBe(true)

    await spawner.exit('agent.mason', 0)

    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false)
    expect(manager.card('agent.mason').lifecycle).toBe('exited')
    expect(manager.card('agent.mason').exitCode).toBe(0)
    expect(manager.card('agent.mason').settingsWritten).toEqual([])

    const delivery = await postHookEvent(
      hookServer.endpoint() ?? '',
      buildEnvelope({
        agentId: 'agent.mason',
        token,
        event: 'stop',
        payload: {},
        ts: Date.now()
      })
    )
    expect(delivery.status).toBe(401)
  })

  it('restores a pre-existing settings file byte-for-byte on exit', async () => {
    const { manager, spawner, repo, request } = await rig()
    const settings = path.join(repo, CLAUDE_SETTINGS_REL)
    fs.mkdirSync(path.dirname(settings), { recursive: true })
    fs.writeFileSync(settings, '{ "permissions": { "allow": ["Bash(ls)"] } }\n', 'utf8')
    const before = fs.readFileSync(settings)

    await manager.spawn(request)
    await spawner.exit('agent.mason', 1)

    expect(fs.readFileSync(settings).equals(before)).toBe(true)
  })

  it('unwinds every live spawn on shutdown', async () => {
    const { manager, repo, request } = await rig()
    await manager.spawn(request)
    await manager.shutdown()
    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false)
  })

  it('rolls back and revokes the token when identity cannot be written', async () => {
    const { manager, hookServer, spawner, home, repo, request } = await rig()
    // A directory where identity.md belongs makes materialization fail — the
    // same class of failure as a mis-hired agent, and it must leave neither a
    // modified repo nor a live token behind.
    fs.mkdirSync(path.join(home, 'agora', 'agents', 'agent.mason', 'identity.md'), {
      recursive: true
    })

    await expect(manager.spawn(request)).rejects.toThrow()

    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false)
    expect(spawner.spawns).toEqual([])
    const delivery = await postHookEvent(
      hookServer.endpoint() ?? '',
      buildEnvelope({
        agentId: 'agent.mason',
        token: 'whatever',
        event: 'stop',
        payload: {},
        ts: Date.now()
      })
    )
    expect(delivery.status).toBe(401)
  })

  it('allows respawning an agent that has exited (FR-1.4)', async () => {
    const { manager, spawner, request } = await rig()
    await manager.spawn(request)
    await spawner.exit('agent.mason', 0)

    const card = await manager.spawn(request)
    expect(card.lifecycle).toBe('running')
    expect(spawner.spawns).toHaveLength(2)
  })

  it('refuses to respawn an agent that is still running', async () => {
    const { manager, request } = await rig()
    await manager.spawn(request)
    await expect(manager.spawn(request)).rejects.toThrow(/already running/)
  })
})

describe('AgentManager — missing binary (FR-1.6)', () => {
  it('runs the install offer in the agent own terminal and continues into the new binary', async () => {
    let installed = false
    const { manager, spawner, repo, request } = await rig(async () =>
      installed ? '2.1.195' : null
    )

    const card = await manager.spawn(request)
    expect(card.lifecycle).toBe('installing')
    expect(card.engineVersion).toBeNull()
    // The install runs under the agent's own pty id — the Architect watches it.
    expect(spawner.spawns[0]?.id).toBe('agent.mason')
    expect(spawner.spawns[0]?.plan.argv).toEqual([
      'npm',
      'install',
      '-g',
      '@anthropic-ai/claude-code'
    ])
    // The installer must inherit the base allowlist or it cannot start at all
    // (PATH resolution + npm's own needs); no EPH_* vars, it is not an agent yet.
    const installEnv = spawner.spawns[0]?.plan.env ?? {}
    expect(Object.keys(installEnv).length).toBeGreaterThan(0)
    for (const key of Object.keys(installEnv)) {
      expect(key.startsWith('EPH_')).toBe(false)
    }
    const envNames = Object.keys(installEnv).map((k) => k.toUpperCase())
    expect(envNames).toContain('PATH')
    // Nothing is written into the repo until there is a binary to run.
    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false)

    installed = true
    await spawner.exit('agent.mason', 0)

    expect(manager.card('agent.mason').lifecycle).toBe('running')
    expect(manager.card('agent.mason').engineVersion).toBe('2.1.195')
    expect(spawner.spawns[1]?.plan.argv[0]).toBe('claude')
    expect(fs.existsSync(path.join(repo, CLAUDE_SETTINGS_REL))).toBe(true)
  })

  it('shows a visible missing-binary state when the install did not help', async () => {
    const { manager, spawner, changes, request } = await rig(async () => null)
    await manager.spawn(request)
    await spawner.exit('agent.mason', 1)

    expect(manager.card('agent.mason').lifecycle).toBe('missing-binary')
    expect(changes).toContain('missing-binary')
  })
})

describe('AgentManager — talking to a live agent (FR-1.3)', () => {
  it('sends the engine cancel key on interrupt', async () => {
    const { manager, spawner, request } = await rig()
    await manager.spawn(request)
    manager.interrupt('agent.mason')

    expect(spawner.writes).toEqual([{ id: 'agent.mason', data: ESCAPE_KEY }])
  })

  it('sends Architect text verbatim', async () => {
    const { manager, spawner, request } = await rig()
    await manager.spawn(request)
    manager.send('agent.mason', 'fix the flaky test\r')

    expect(spawner.writes[0]?.data).toBe('fix the flaky test\r')
  })

  it('kills by id', async () => {
    const { manager, spawner, request } = await rig()
    await manager.spawn(request)
    manager.kill('agent.mason')
    expect(spawner.kills).toEqual(['agent.mason'])
  })

  it('names the missing agent when asked about one it never spawned', async () => {
    const { manager } = await rig()
    expect(() => manager.card('agent.ghost')).toThrow(/no agent "agent\.ghost"/)
    expect(() => manager.interrupt('agent.ghost')).toThrow(/no agent "agent\.ghost"/)
    expect(() => manager.kill('agent.ghost')).toThrow(/no agent "agent\.ghost"/)
  })
})

describe('AgentManager — concurrent spawn (regression: orphaned hook token)', () => {
  it('claims the agent id before its first await, so a second spawn cannot steal it', async () => {
    // Two spawn calls in flight for one agent both used to pass the liveness
    // check, and the second one's token replaced the first's in the hook server
    // — leaving the running agent's hooks rejected with a token mismatch.
    // Observed live in the app before the id was claimed synchronously.
    const { manager, spawner, hookServer, request } = await rig(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return '2.1.195'
    })

    const results = await Promise.allSettled([manager.spawn(request), manager.spawn(request)])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')

    expect(fulfilled).toHaveLength(1)
    expect(spawner.spawns).toHaveLength(1)

    // The one surviving spawn's token is the one the endpoint accepts.
    const token = spawner.spawns[0]?.plan.env['EPH_HOOK_TOKEN'] ?? ''
    const delivery = await postHookEvent(
      hookServer.endpoint() ?? '',
      buildEnvelope({
        agentId: 'agent.mason',
        token,
        event: 'session-start',
        payload: {},
        ts: Date.now()
      })
    )
    expect(delivery.delivered).toBe(true)
  })
})

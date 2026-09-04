import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnRequestSchema, type SpawnRequest } from '../../src/shared/agents'
import {
  AgentManager,
  type AgentManagerOptions,
  type AgentSpawner,
  type VersionProber
} from '../../src/main/agents'
import { EngineRegistry } from '../../src/main/engines'
import type { SpawnPlan } from '../../src/main/engines'
import { CLAUDE_SETTINGS_REL, ClaudeAdapter } from '../../src/main/engines/claude'
import { CodexAdapter } from '../../src/main/engines/codex'
import { HookServer } from '../../src/main/hooks'
import { PromptStore } from '../../src/main/prompts'
import { postHookEvent, buildEnvelope } from '../../shims/hook-client.mjs'
import { removeTempDir } from '../tmpdir'

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
  for (const dir of temps.splice(0)) removeTempDir(dir)
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

interface RigOptions {
  readonly probe?: VersionProber
  readonly onExitError?: (agentId: string, err: unknown) => void
  readonly resolveGrants?: AgentManagerOptions['resolveGrants']
  readonly onGrantsMissing?: (agentId: string, missing: readonly string[]) => void
  readonly onLogEvent?: AgentManagerOptions['onLogEvent']
  readonly authProbe?: AgentManagerOptions['authProbe']
  /**
   * Which engine the spawn names. Codex is registered too when it is asked
   * for, because its BinarySpec declares NO auth probe — which is the case
   * the manager has to trust rather than refuse.
   */
  readonly engine?: 'claude' | 'codex'
}

async function rig(
  probe: VersionProber = async () => '2.1.195',
  onExitError?: (agentId: string, err: unknown) => void,
  extra: RigOptions = {}
): Promise<Rig> {
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
  if (extra.engine === 'codex') registry.register(new CodexAdapter({ prompts }))

  const spawner = new RecordingSpawner()
  const changes: string[] = []
  const manager = new AgentManager({
    engines: registry,
    hookServer,
    spawner,
    prompts,
    agoraRoot: path.join(home, 'agora'),
    probe,
    onExitError,
    ...(extra.resolveGrants ? { resolveGrants: extra.resolveGrants } : {}),
    ...(extra.onGrantsMissing ? { onGrantsMissing: extra.onGrantsMissing } : {}),
    ...(extra.onLogEvent ? { onLogEvent: extra.onLogEvent } : {}),
    ...(extra.authProbe ? { authProbe: extra.authProbe } : {}),
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
      engine: extra.engine ?? 'claude',
      cwd: repo,
      capabilities: ['ci', 'git'],
      envGrants: ['GH_TOKEN']
    })
  }
}

describe('AgentManager — an exit nobody awaits', () => {
  it('reports a failed teardown instead of killing the harness', async () => {
    // The pty exit event is fire-and-forget: there is no caller for handleExit
    // to reject to. Before the guard this was an unhandledRejection, so one
    // stuck file handle at teardown could take the whole harness down.
    const seen: { agentId: string; err: unknown }[] = []
    let probes = 0
    const { manager, spawner, request } = await rig(
      async () => {
        probes += 1
        if (probes === 1) return null // no binary yet: the agent goes to `installing`
        throw new Error('probe blew up during teardown')
      },
      (agentId, err) => seen.push({ agentId, err })
    )
    expect((await manager.spawn(request)).lifecycle).toBe('installing')

    const unhandled: unknown[] = []
    const capture = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', capture)
    try {
      await spawner.exit('agent.mason', 0)
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', capture)
    }

    expect(seen).toHaveLength(1)
    expect(seen[0]?.agentId).toBe('agent.mason')
    expect((seen[0]?.err as Error).message).toMatch(/probe blew up/)
    expect(unhandled).toEqual([])
  })
})

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

/**
 * ADR-0010 at the lifecycle boundary: what the broker resolves is what the
 * process gets, and nothing else. The broker itself is tested in
 * test/main/secrets.test.ts; these cases are about the wiring — the place a
 * credential would actually leak into a real spawn.
 *
 * Fixture values are scanner-neutral (M1-audit ruling).
 */
describe('secret grants reach the spawn, scoped (S-SECRETS)', () => {
  const GRANTED = 'not-a-real-credential-0123456789'
  const UNDECLARED = 'a-different-fake-value-987654321'

  it('injects a declared grant into the process environment', async () => {
    const { manager, spawner, request } = await rig(undefined, undefined, {
      resolveGrants: (declared) => ({
        env: Object.fromEntries(declared.map((name) => [name, GRANTED])),
        missing: []
      })
    })
    await manager.spawn(request)
    expect(spawner.spawns[0]?.plan.env['GH_TOKEN']).toBe(GRANTED)
  })

  it('asks the broker only for what the role declared', async () => {
    const asked: string[][] = []
    const { manager, request } = await rig(undefined, undefined, {
      resolveGrants: (declared) => {
        asked.push([...declared])
        return { env: {}, missing: [] }
      }
    })
    await manager.spawn(request)
    // The hire declares GH_TOKEN; the broker is never asked for anything else,
    // which is what makes least-privilege structural rather than a check.
    expect(asked).toEqual([['GH_TOKEN']])
  })

  it('never lets an undeclared credential into the environment', async () => {
    const { manager, spawner, request } = await rig(undefined, undefined, {
      // A broker that answers with MORE than it was asked for — the failure this
      // guards against is a future broker bug, not a hypothetical.
      resolveGrants: () => ({
        env: { GH_TOKEN: GRANTED, VOICE_KEY_FAKE: UNDECLARED },
        missing: []
      })
    })
    await manager.spawn(request)
    const env = spawner.spawns[0]?.plan.env ?? {}
    expect(JSON.stringify(env)).not.toContain(UNDECLARED)
    expect(Object.keys(env)).not.toContain('VOICE_KEY_FAKE')
  })

  it('reports a declared grant the broker could not supply', async () => {
    const missing: { agentId: string; names: readonly string[] }[] = []
    const { manager, spawner, request } = await rig(undefined, undefined, {
      resolveGrants: () => ({ env: {}, missing: ['GH_TOKEN'] }),
      onGrantsMissing: (agentId, names) => missing.push({ agentId, names })
    })
    await manager.spawn(request)
    // Visible, not an empty variable the agent discovers three tool calls later.
    expect(missing).toEqual([{ agentId: 'agent.mason', names: ['GH_TOKEN'] }])
    expect(spawner.spawns[0]?.plan.env['GH_TOKEN']).toBeUndefined()
  })

  it('injects nothing, visibly, when no broker is wired at all', async () => {
    const missing: readonly string[][] = []
    const seen: string[][] = []
    const { manager, spawner, request } = await rig(undefined, undefined, {
      onGrantsMissing: (_agentId, names) => seen.push([...names])
    })
    await manager.spawn(request)
    expect(spawner.spawns[0]?.plan.env['GH_TOKEN']).toBeUndefined()
    expect(seen).toEqual([['GH_TOKEN']])
    expect(missing).toEqual([])
  })
})

describe('AgentManager.shutdown — one agent’s failure never costs the others', () => {
  /**
   * The quit path's second defect (M8.1). `shutdown` was
   * `for (const id of ...) await this.unwind(id)` with no `try`, and on every
   * real quit the first agent threw: `unwind` logs an `exit` event, and that
   * callback sent to a window Electron had already destroyed. So the loop died
   * on agent one — settings files left in the Architect's repositories,
   * worktrees never released, tokens never revoked, and nothing said so.
   *
   * The window fault is fixed at its source, so this drives the same shape
   * through the seam that failed: a log callback that throws.
   */
  async function threeAgents(
    failOnExitOf: string
  ): Promise<{ rig: Awaited<ReturnType<typeof rig>>; exitErrors: string[] }> {
    const exitErrors: string[] = []
    const started = await rig(
      async () => '2.1.195',
      (agentId) => exitErrors.push(agentId),
      {
        onLogEvent: (draft) => {
          if (draft.kind === 'exit' && draft['agentId'] === failOnExitOf) {
            throw new Error('Object has been destroyed')
          }
        }
      }
    )
    for (const [agentId, name] of [
      ['agent.mason', 'Mason'],
      ['agent.tess', 'Tess'],
      ['agent.ada', 'Ada']
    ]) {
      await started.manager.spawn({ ...started.request, agentId: agentId!, name: name! })
    }
    return { rig: started, exitErrors }
  }

  it('unwinds every agent even when the first one throws', async () => {
    const { rig: started, exitErrors } = await threeAgents('agent.mason')

    const report = await started.manager.shutdown()

    // The two after the failure are the point: the old loop never reached them.
    expect(report.unwound).toEqual(['agent.tess', 'agent.ada'])
    expect(report.failed).toEqual([{ agentId: 'agent.mason', error: 'Object has been destroyed' }])
    // Their cards really did finish unwinding, rather than merely being skipped
    // quietly — and the one that failed is left mid-unwind, which is exactly why
    // it has to be named rather than counted.
    const lifecycles = new Map(started.manager.list().map((card) => [card.agentId, card.lifecycle]))
    expect(lifecycles.get('agent.tess')).toBe('exited')
    expect(lifecycles.get('agent.ada')).toBe('exited')
    expect(lifecycles.get('agent.mason')).not.toBe('exited')
    // Reported through the manager's own visible seam, once, by name.
    expect(exitErrors).toEqual(['agent.mason'])
  })

  it('never rejects, whichever agent fails', async () => {
    const { rig: started } = await threeAgents('agent.ada')
    // A quit path that could be rejected into is a quit path that stops early.
    await expect(started.manager.shutdown()).resolves.toMatchObject({
      unwound: ['agent.mason', 'agent.tess'],
      failed: [{ agentId: 'agent.ada' }]
    })
  })

  it('reports every agent unwound when nothing fails', async () => {
    const started = await rig()
    await started.manager.spawn(started.request)
    const report = await started.manager.shutdown()
    expect(report).toEqual({ unwound: ['agent.mason'], failed: [] })
  })
})

describe('AgentManager — an engine that is installed but logged out', () => {
  /**
   * B8/M8.4. Nothing asked whether the CLI had a session, so a logged-out
   * engine spawned, printed its own login prompt, sat there for the rest of the
   * day and reported `running` with a confidently idle avatar on the floor.
   */
  const probeReturning =
    (stdout: string, exitCode = 0): AgentManagerOptions['authProbe'] =>
    async () => ({ stdout, exitCode })

  it('does not start the engine, and says what to run', async () => {
    const started = await rig(async () => '2.1.195', undefined, {
      authProbe: probeReturning('Not logged in. Run `claude auth login`.', 1)
    })
    const card = await started.manager.spawn(started.request)

    expect(card.lifecycle).toBe('needs-login')
    expect(card.fixCommand).toBe('claude auth login')
    // The point of the state: no process, so nothing can sit at a login prompt
    // while the card claims it is working.
    expect(started.spawner.spawns).toEqual([])
  })

  it('starts normally when the engine says it has a session', async () => {
    const started = await rig(async () => '2.1.195', undefined, {
      authProbe: probeReturning('Logged in as architect@example.test')
    })
    const card = await started.manager.spawn(started.request)
    expect(card.lifecycle).toBe('running')
    expect(card.fixCommand).toBeNull()
    expect(started.spawner.spawns).toHaveLength(1)
  })

  it('TRUSTS a probe that cannot answer, rather than refusing to start', async () => {
    // `test/pin.ts`'s rule, applied the other way round: could-not-establish is
    // not the same as logged out, and reading it that way would refuse to start
    // a healthy company the first time an engine rephrased its status line.
    const started = await rig(async () => '2.1.195', undefined, {
      authProbe: probeReturning('some wording this adapter has never seen', 3)
    })
    expect((await started.manager.spawn(started.request)).lifecycle).toBe('running')
  })

  it('trusts an engine whose probe throws, for the same reason', async () => {
    const started = await rig(async () => '2.1.195', undefined, {
      authProbe: () => Promise.reject(new Error('spawn ENOENT'))
    })
    expect((await started.manager.spawn(started.request)).lifecycle).toBe('running')
  })

  it('asks nothing when no probe is wired at all', async () => {
    const started = await rig()
    expect((await started.manager.spawn(started.request)).lifecycle).toBe('running')
  })

  it('starts an engine whose ADAPTER declares no probe, and never asks about it', async () => {
    // The other absence, and the one the test above cannot reach: Codex's
    // `BinarySpec` has no `authProbe` at all, so there is no question to ask.
    // Reading that silence as "logged out" would turn every adapter without a
    // probe into a company that will not start — which is most of the roster,
    // and would be a regression caused entirely by adding a feature to one
    // adapter (ADR-0009: adapters own engine specifics).
    let asked = 0
    const started = await rig(async () => '0.9.0', undefined, {
      engine: 'codex',
      authProbe: async () => {
        asked += 1
        return { stdout: 'Not logged in', exitCode: 1 }
      }
    })
    const card = await started.manager.spawn(started.request)
    expect(card.lifecycle).toBe('running')
    expect(card.fixCommand).toBeNull()
    expect(asked).toBe(0)
  })
})

import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentCard, SpawnRequest } from '../shared/agents'
import type { AgentStatus, RegistryEntry } from '../shared/registry'
import type { AgentSpawnConfig, BinarySpec, EngineAdapter, HookPlan, SpawnPlan } from './engines'
import type { EngineRegistry } from './engines'
import { baseAgentEnv } from './engines/spawn-env'
import type { HookServer } from './hooks'
import type { PromptStore } from './prompts'
import { writeFileAtomic } from './fsx'

/**
 * Agent lifecycle (FR-1.1, FR-1.4, FR-1.6; SDD §3). This is the module that
 * turns a hire into a running process and, just as importantly, unwinds it
 * cleanly: a spawn that installed a settings file into someone's repo and then
 * died without restoring it would leave the Architect's working copy modified
 * behind their back.
 *
 * Everything that touches a real process arrives through `AgentSpawner`, so the
 * lifecycle rules are testable without node-pty — which cannot load under the
 * Node test runner after `electron-rebuild` (DECISIONS-LOG).
 */

/** The slice of `PtyManager` the lifecycle needs. */
export interface AgentSpawner {
  /** Starts `plan.argv` under `id`, streaming bytes on `pty:data:<id>`. */
  spawnAgent(id: string, plan: SpawnPlan): void
  write(id: string, data: string): void
  kill(id: string): void
  has(id: string): boolean
  /** Fires when a pty exits; the manager unwinds the spawn from here. */
  onExit(cb: (id: string, exitCode: number) => void): void
}

/** Contract: resolves the version string, or null when the binary is absent. */
export type VersionProber = (spec: BinarySpec) => Promise<string | null>

/**
 * Runs the engine's version probe. Contract: never throws — a missing binary and
 * a probe that errors are the same answer (null), because both mean "we cannot
 * confirm the engine is here", and FR-1.6 responds to that with a visible
 * install offer, not a crash.
 */
export const probeVersion: VersionProber = (spec) =>
  new Promise((resolve) => {
    execFile(
      spec.versionProbe.command,
      [...spec.versionProbe.args],
      { timeout: 10_000, windowsHide: true, shell: process.platform === 'win32' },
      (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        resolve(spec.parseVersion(stdout))
      }
    )
  })

export interface AgentManagerOptions {
  readonly engines: EngineRegistry
  readonly hookServer: HookServer
  readonly spawner: AgentSpawner
  readonly prompts: PromptStore
  /** `<harness home>/agora` — where agent directories and PROTOCOL.md live (SDD §2). */
  readonly agoraRoot: string
  readonly probe?: VersionProber
  /** Notified whenever a card changes, for pushing `state:agents` to the renderer. */
  onChange?(card: AgentCard): void
  /**
   * Appends a lifecycle event to the book of record (SDD §4.3). Injected rather
   * than imported so the lifecycle stays testable without an Agora on disk —
   * and so every `spawn`/`exit`/`ghost` goes through one place (NFR-13).
   */
  onLogEvent?(draft: { kind: 'spawn' | 'exit' | 'ghost' } & Record<string, unknown>): void
  /**
   * Records the hire in the roster (`registry.json`, SDD §4.1). Injected for
   * the same reason the log sink is: the lifecycle stays testable without an
   * Agora, and one place owns the write.
   */
  onRosterChange?(agentId: string, entry: RegistryEntry | null): void
}

interface LiveAgent {
  card: AgentCard
  readonly adapter: EngineAdapter
  readonly cfg: AgentSpawnConfig
  hookPlan: HookPlan | null
}

export class AgentManager {
  private readonly agents = new Map<string, LiveAgent>()
  private readonly probe: VersionProber

  constructor(private readonly options: AgentManagerOptions) {
    this.probe = options.probe ?? probeVersion
    options.spawner.onExit((id, exitCode) => {
      void this.handleExit(id, exitCode)
    })
  }

  list(): readonly AgentCard[] {
    return [...this.agents.values()].map((agent) => agent.card)
  }

  card(agentId: string): AgentCard {
    const agent = this.agents.get(agentId)
    if (!agent) throw new Error(`agents: no agent "${agentId}"`)
    return agent.card
  }

  /**
   * Spawns one agent.
   *
   * Order matters and is the whole point of this method:
   *   probe → mint token → register token → materialize identity → validate
   *   identity → install settings → start process.
   *
   * The token is registered *before* the process exists, so the engine's very
   * first hook is already authenticated; identity is validated *before* the
   * settings file is written, so a mis-hired agent never leaves a modified repo
   * behind; and if anything after the settings install throws, the settings are
   * rolled back here rather than at some later cleanup that may never run.
   */
  async spawn(request: SpawnRequest): Promise<AgentCard> {
    const existing = this.agents.get(request.agentId)
    if (
      existing &&
      existing.card.lifecycle !== 'exited' &&
      existing.card.lifecycle !== 'missing-binary'
    ) {
      throw new Error(
        `agents: "${request.agentId}" is already ${existing.card.lifecycle}; kill it before respawning`
      )
    }
    const adapter = this.options.engines.get(request.engine)

    // The id is claimed SYNCHRONOUSLY, before the first await. Two spawn calls
    // in flight for one agent would otherwise both pass the check above, and the
    // second one's hook token would silently orphan the first agent's hooks —
    // observed live before this reservation existed.
    const cfg = this.spawnConfig(request)
    const card = this.newCard(request, adapter, null)
    this.agents.set(request.agentId, { card, adapter, cfg, hookPlan: null })
    this.options.onChange?.(card)

    const spec = adapter.binary()
    const version = await this.probe(spec)
    this.update(request.agentId, { engineVersion: version })
    // Every refs the forensic reader needs: who, on what engine, where, and
    // whether the binary was even there (NFR-13).
    this.options.onRosterChange?.(request.agentId, {
      name: request.name,
      role: request.role,
      engine: adapter.id,
      capabilities: [...request.capabilities],
      // Seats are assigned by the floor in M3 with Artemis's temple seat; until
      // then every hire sits on the terraces.
      seat: 'terrace',
      envGrants: [...request.envGrants],
      profile: null,
      target: request.cwd,
      status: 'idle',
      hookFidelity: adapter.hooks,
      spawnedAt: new Date().toISOString()
    })
    this.options.onLogEvent?.({
      kind: 'spawn',
      agentId: request.agentId,
      engine: adapter.id,
      engineVersion: version,
      role: request.role,
      cwd: request.cwd,
      hookFidelity: adapter.hooks
    })

    if (version === null) {
      // FR-1.6: the offer runs in the agent's OWN visible terminal, so the
      // Architect watches the install happen instead of trusting that it did.
      this.update(request.agentId, { lifecycle: 'installing' })
      this.options.spawner.spawnAgent(request.agentId, {
        argv: [spec.install.command, ...spec.install.args],
        cwd: request.cwd,
        // The installer needs the base allowlist (PATH, SYSTEMROOT, APPDATA…)
        // to even start; no EPH_* vars and no grants — it is not an agent yet.
        env: baseAgentEnv(),
        settings: []
      })
      return this.card(request.agentId)
    }

    await this.start(request.agentId)
    return this.card(request.agentId)
  }

  /** Writes the engine's cancel key into the agent's PTY (ADR-0009). */
  interrupt(agentId: string): void {
    const agent = this.require(agentId)
    this.options.spawner.write(agentId, agent.adapter.interrupt().bytes)
  }

  kill(agentId: string): void {
    this.require(agentId)
    this.options.spawner.kill(agentId)
  }

  /** Sends Architect text to the agent's PTY verbatim (FR-1.3). */
  send(agentId: string, text: string): void {
    this.require(agentId)
    this.options.spawner.write(agentId, text)
  }

  /** Unwinds every live spawn — settings restored, tokens revoked. */
  async shutdown(): Promise<void> {
    for (const agentId of [...this.agents.keys()]) await this.unwind(agentId)
  }

  /** Mirrors a coarse lifecycle change into the roster (SDD §4.1 `status`). */
  private setRosterStatus(agentId: string, status: AgentStatus): void {
    const agent = this.agents.get(agentId)
    if (!agent) return
    this.options.onRosterChange?.(agentId, {
      name: agent.card.name,
      role: agent.card.role,
      engine: agent.card.engine,
      capabilities: [...agent.card.capabilities],
      seat: 'terrace',
      envGrants: [...agent.card.envGrants],
      profile: null,
      target: agent.card.cwd,
      status,
      hookFidelity: agent.card.hookFidelity,
      spawnedAt: agent.card.spawnedAt,
      lastSeen: new Date().toISOString()
    })
  }

  private require(agentId: string): LiveAgent {
    const agent = this.agents.get(agentId)
    if (!agent) throw new Error(`agents: no agent "${agentId}"`)
    return agent
  }

  private spawnConfig(request: SpawnRequest): AgentSpawnConfig {
    const agentDir = path.join(this.options.agoraRoot, 'agents', request.agentId)
    return {
      agentId: request.agentId,
      // 32 random bytes, minted per spawn and never reused: a token that
      // outlived its process would let a dead agent keep writing the event plane.
      hookToken: randomBytes(32).toString('hex'),
      hookEndpoint: this.options.hookServer.endpoint() ?? '',
      cwd: request.cwd,
      // The broker (ADR-0010, M3) resolves grant names to values. Until it
      // exists no value can reach an agent, which is the safe direction.
      envGrants: {},
      identityPath: path.join(agentDir, 'identity.md'),
      protocolPath: path.join(this.options.agoraRoot, 'PROTOCOL.md')
    }
  }

  private newCard(
    request: SpawnRequest,
    adapter: EngineAdapter,
    version: string | null
  ): AgentCard {
    return {
      agentId: request.agentId,
      name: request.name,
      role: request.role,
      engine: adapter.id,
      hookFidelity: adapter.hooks,
      lifecycle: 'starting',
      engineVersion: version,
      cwd: request.cwd,
      ptyId: request.agentId,
      settingsWritten: [],
      envGrants: request.envGrants,
      capabilities: request.capabilities,
      spawnedAt: new Date().toISOString(),
      exitCode: null
    }
  }

  private update(agentId: string, patch: Partial<AgentCard>): void {
    const agent = this.agents.get(agentId)
    if (!agent) return
    agent.card = { ...agent.card, ...patch }
    this.options.onChange?.(agent.card)
  }

  /** Materializes `identity.md` and `PROTOCOL.md` (SDD §2) for this agent. */
  private materializeIdentity(agent: LiveAgent): void {
    const card = agent.card
    fs.mkdirSync(path.dirname(agent.cfg.identityPath), { recursive: true })
    writeFileAtomic(
      agent.cfg.identityPath,
      this.options.prompts.render(path.join('agents', 'identity.md'), {
        name: card.name,
        agentId: card.agentId,
        role: card.role,
        capabilities: card.capabilities.length > 0 ? card.capabilities.join(', ') : 'none declared',
        envGrants: card.envGrants.length > 0 ? card.envGrants.join(', ') : 'none',
        cwd: card.cwd,
        // An agent that does not know where its mailbox is cannot use it.
        agentDir: path.dirname(agent.cfg.identityPath)
      })
    )
    if (!fs.existsSync(agent.cfg.protocolPath)) {
      fs.mkdirSync(path.dirname(agent.cfg.protocolPath), { recursive: true })
      writeFileAtomic(
        agent.cfg.protocolPath,
        this.options.prompts.read(path.join('agora', 'PROTOCOL.md'))
      )
    }
  }

  private async start(agentId: string): Promise<void> {
    const agent = this.require(agentId)

    this.options.hookServer.registerSpawn(agentId, agent.cfg.hookToken)

    try {
      this.materializeIdentity(agent)
      // Throws when identity/protocol are unreadable — before anything is
      // written into the Architect's repo.
      agent.adapter.injectIdentity(agent.cfg)

      const hookPlan = agent.adapter.wireHooks(agent.cfg)
      await hookPlan.install()
      agent.hookPlan = hookPlan

      const plan = agent.adapter.spawnArgs(agent.cfg)
      this.update(agentId, {
        lifecycle: 'running',
        settingsWritten: plan.settings.map((injection) => injection.path)
      })
      this.options.spawner.spawnAgent(agentId, plan)
    } catch (err) {
      await this.unwind(agentId)
      throw err
    }
  }

  /**
   * A pty exit is either the install offer finishing — in which case FR-1.6 says
   * continue into the new binary — or the agent itself ending, which unwinds the
   * spawn.
   */
  private async handleExit(agentId: string, exitCode: number): Promise<void> {
    const agent = this.agents.get(agentId)
    if (!agent) return

    if (agent.card.lifecycle === 'installing') {
      const version = await this.probe(agent.adapter.binary())
      if (version === null) {
        // Visible, not silent: the card says the binary is still missing.
        this.update(agentId, { lifecycle: 'missing-binary', engineVersion: null })
        return
      }
      this.update(agentId, { engineVersion: version })
      await this.start(agentId)
      return
    }

    await this.unwind(agentId, exitCode)
  }

  /** Restores the repo and revokes the token. Safe to call more than once. */
  private async unwind(agentId: string, exitCode: number | null = null): Promise<void> {
    const agent = this.agents.get(agentId)
    if (!agent) return
    if (agent.hookPlan) {
      await agent.hookPlan.uninstall()
      agent.hookPlan = null
    }
    this.options.hookServer.unregisterSpawn(agentId)
    this.setRosterStatus(agentId, 'ghost')
    this.options.onLogEvent?.({
      kind: 'exit',
      agentId,
      exitCode,
      engine: agent.card.engine,
      settingsRestored: agent.card.settingsWritten.length
    })
    this.update(agentId, { lifecycle: 'exited', exitCode, settingsWritten: [] })
  }
}

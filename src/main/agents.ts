import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentCard, RespawnOffer, SpawnRequest, WorktreeInfo } from '../shared/agents'
import type { AgentStatus, RegistryEntry } from '../shared/registry'
import { assignSeat, type Seat } from '../shared/seats'
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

/**
 * Contract: whether a role owns the temple seat (SDD §4.1, ADR-0005).
 *
 * The roster's `orchestratorId` is set when Artemis is hired (M3.7); until then
 * the role string is the only fact a spawn carries, and it is the same fact the
 * floor already reads for her silhouette. One predicate, so the two cannot
 * drift apart.
 */
export function isOrchestratorRole(role: string): boolean {
  return role === 'orchestrator'
}

/** What the Watch needs about one spawn to fold and budget it (ADR-0011). */
export interface BudgetedSpawn {
  readonly agentId: string
  readonly adapter: EngineAdapter
  readonly cfg: AgentSpawnConfig
  readonly dailyTokens: number | null
  readonly sessionIds: readonly string[]
}

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

/**
 * The slice of the Library the lifecycle needs (ADR-0006 layer 1).
 *
 * `seed` is idempotent by contract — every spawn calls it, and a respawn must
 * never overwrite what the agent wrote before it died.
 */
export interface AgentMemory {
  /** Writes the seed header when the agent has no `memory.md`. Idempotent. */
  seed(agentId: string): boolean
  /** The budgeted memory layer for a spawn; empty when nothing is remembered. */
  layer(agentId: string): {
    readonly text: string
    readonly facts: { readonly totalSections: number }
  }
}

/**
 * The slice of `git.ts`'s worktree support the lifecycle needs (UC-01 2a).
 *
 * Narrow on purpose: the manager asks for a working copy and gives it back. It
 * knows nothing about branches, prune, or `--force` — and cannot be the place
 * a second git path grows.
 */
export interface AgentWorktrees {
  /** Where this agent's isolated checkout should live. */
  pathFor(agentId: string): string
  /** The branch it should sit on. */
  branchFor(agentId: string): string
  create(plan: { repo: string; path: string; branch: string }): Promise<
    | {
        readonly ok: true
        readonly path: string
        readonly branch: string
        readonly created: boolean
      }
    | { readonly ok: false; readonly reason: string }
  >
  remove(
    repo: string,
    worktreePath: string
  ): Promise<
    | { readonly removed: true }
    | { readonly removed: false; readonly reason: string; readonly changes: readonly string[] }
  >
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
  /**
   * The autonomy this agent runs at — the profile's level composed against the
   * global ceiling (FR-11.1, ADR-0012), or the ceiling alone for an agent on no
   * profile. Absent means `manual`, which is the direction an unknown must
   * fail in: an agent nobody placed does not get latitude by default.
   *
   * Injected rather than read here, because the composition belongs to the
   * Watch and a second opinion about it in the spawn path would eventually
   * disagree with the first — permissively.
   */
  autonomyFor?(agentId: string): 'manual' | 'supervised' | 'autonomous' | null
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
  /**
   * Raised when tearing an exited agent down failed. The exit event is
   * fire-and-forget by nature, so this path has no caller to reject to — and an
   * unhandled rejection here would kill the harness over one stuck file handle.
   */
  onExitError?(agentId: string, err: unknown): void
  /**
   * Extra standing context appended to an agent's `identity.md`, supplied by
   * whoever hired them.
   *
   * Artemis's orchestrator policy arrives this way (ADR-0005, "prompt as
   * policy": her escalation policy and delegated-authority posture are text in
   * `prompts/artemis/`, editable by the Architect, never compiled in). The
   * manager never reads the text — it renders the identity, appends this, and
   * writes the file — so no orchestration rule lands in the lifecycle.
   */
  roleBrief?(card: AgentCard): string | null
  /**
   * Seats already taken, agent id → seat, usually read straight off the roster.
   * Injected for the same reason the budget lookup is: seating is a property of
   * the *company*, not of the spawns this manager happens to be holding, and an
   * agent must keep its seat across a restart that has no live spawns at all.
   */
  rosterSeats?(): ReadonlyMap<string, Seat>
  /**
   * Resolves the role's DECLARED secret grants to values (ADR-0010). Injected
   * as a function rather than as the broker, so this module never holds a
   * credential beyond the spawn config it hands to the adapter, and the
   * lifecycle stays testable without a keychain.
   *
   * Contract: returns only names present in `declared`; `missing` names a
   * declared grant the broker does not hold, which the caller surfaces.
   */
  resolveGrants?(declared: readonly string[]): {
    readonly env: Record<string, string>
    readonly missing: readonly string[]
  }
  /** Raised when a spawn could not be given every credential its role declares. */
  onGrantsMissing?(agentId: string, missing: readonly string[]): void
  /**
   * The Library's layer-1 seam (ADR-0006, FR-6.1). Injected rather than
   * imported so the lifecycle stays testable without an Agora on disk, and so
   * the manager never learns how a memory is budgeted — only that it has one.
   *
   * Optional because a manager with no Library is a legal (memory-less)
   * configuration in tests; in the app it is always wired, and an agent with
   * nothing written yet gets the same empty layer either way.
   */
  readonly memory?: AgentMemory
  /**
   * The `eph-recall` invocation handed to every spawn as `EPH_RECALL`
   * (ADR-0006 layer 2). Harness-owned and engine-independent, which is why it
   * is composed here rather than in each adapter's deps.
   */
  readonly recallCommand?: string
  /**
   * Git worktree isolation for a spawn that asks for it (UC-01 alternate 2a).
   * Injected rather than imported so the lifecycle never runs git itself —
   * ADR-0004 gives the app exactly one git path, and it is `git.ts`.
   */
  readonly worktrees?: AgentWorktrees
  /**
   * Returns a dead agent's in-flight ledger tasks to `todo` (SDD §10) and
   * yields the ids that moved, for the respawn offer. Injected: the lifecycle
   * must not import the ledger endpoint, and a company with no ledger yet
   * simply returns nothing.
   */
  returnTasks?(agentId: string, because: string): readonly string[]
  /**
   * The daily budget already recorded for this hire in the roster (SDD §4.1),
   * consulted when the spawn request does not carry one.
   *
   * The enforcement ceiling must not be whatever the *renderer* supplied
   * (invariant §2): a hire whose registry entry declares 500k would otherwise
   * be unbudgeted the moment a spawn call omitted the field, and a harness
   * restart would lose the declaration entirely.
   */
  rosterBudget?(agentId: string): number | null
}

interface LiveAgent {
  card: AgentCard
  /**
   * Engine session ids this spawn has reported, in first-seen order. The Watch
   * folds only the transcripts these name: an engine keys its transcript
   * directory on the working directory, so two agents in one repo — and the
   * Architect's own history there — otherwise land in whichever agent's ledger
   * ticked first.
   */
  readonly sessionIds: string[]
  readonly adapter: EngineAdapter
  /**
   * Rebuilt at every `start()` so credentials are resolved AT SPAWN
   * (ADR-0010), not at hire. The difference is real: the install-offer path
   * spawns, exits, and starts again, and a credential the Architect stored
   * while watching that install must reach the agent that follows it.
   */
  cfg: AgentSpawnConfig
  hookPlan: HookPlan | null
  /**
   * The repository the hire named, kept even after `cwd` becomes an isolated
   * worktree — removing a worktree is an operation on its *repo*, and by then
   * the card no longer points at one.
   */
  readonly targetRepo: string
}

export class AgentManager {
  private readonly agents = new Map<string, LiveAgent>()
  /** Seats handed out this session; the roster is the durable copy. */
  private readonly seats = new Map<string, Seat>()
  private readonly probe: VersionProber

  constructor(private readonly options: AgentManagerOptions) {
    this.probe = options.probe ?? probeVersion
    options.spawner.onExit((id, exitCode) => {
      this.handleExit(id, exitCode).catch((err: unknown) => {
        this.options.onExitError?.(id, err)
      })
    })
  }

  list(): readonly AgentCard[] {
    return [...this.agents.values()].map((agent) => agent.card)
  }

  /** Records an engine session id this spawn reported (from the event plane). */
  noteSession(agentId: string, sessionId: string): void {
    const agent = this.agents.get(agentId)
    if (agent && !agent.sessionIds.includes(sessionId)) agent.sessionIds.push(sessionId)
  }

  /**
   * The spawns the Watch folds transcripts for (ADR-0011). Exposes the adapter
   * and its spawn config because that is what `TranscriptReader.transcriptDir`
   * takes — the Watch never learns anything engine-specific itself (NFR-12).
   */
  liveSpawns(): readonly BudgetedSpawn[] {
    return [...this.agents.values()]
      .filter((agent) => agent.card.lifecycle === 'running')
      .map((agent) => this.budgeted(agent))
  }

  /** One spawn's budget view, live or not — used for the final fold at exit. */
  spawnOf(agentId: string): BudgetedSpawn | null {
    const agent = this.agents.get(agentId)
    return agent ? this.budgeted(agent) : null
  }

  private budgeted(agent: LiveAgent): BudgetedSpawn {
    return {
      agentId: agent.card.agentId,
      adapter: agent.adapter,
      cfg: agent.cfg,
      dailyTokens: agent.card.dailyTokens,
      sessionIds: [...agent.sessionIds]
    }
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
    this.agents.set(request.agentId, {
      card,
      adapter,
      cfg,
      hookPlan: null,
      sessionIds: [],
      targetRepo: request.cwd
    })
    this.options.onChange?.(card)

    // UC-01 alternate 2a. Before the process exists and before anything is
    // written into a repository: an isolated spawn works in its own checkout,
    // so two agents in one repo cannot fight over a working copy. A failure
    // here is visible and the spawn continues in the target repo — isolation is
    // a nicety, and refusing to hire over it would be worse than saying so.
    if (request.worktree === true) await this.isolate(request.agentId, request.cwd)

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
      seat: this.card(request.agentId).seat,
      ...(isOrchestratorRole(request.role) ? { isOrchestrator: true } : {}),
      envGrants: [...request.envGrants],
      // The card already resolved the effective budget — request first, then
      // whatever the roster declared. Writing `request.budget` here would erase
      // a roster-declared budget on any spawn call that omitted the field.
      ...(this.card(request.agentId).dailyTokens === null
        ? {}
        : { budget: { dailyTokens: this.card(request.agentId).dailyTokens as number } }),
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
      hookFidelity: adapter.hooks,
      // ENGINEERING-STANDARDS §4: anything the harness writes into an agent's
      // environment is logged. NAMES only — a value here would make the book
      // of record the read path the broker refuses to be (ADR-0010).
      envGrants: [...request.envGrants]
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
      seat: agent.card.seat,
      ...(isOrchestratorRole(agent.card.role) ? { isOrchestrator: true } : {}),
      envGrants: [...agent.card.envGrants],
      ...(agent.card.dailyTokens === null
        ? {}
        : { budget: { dailyTokens: agent.card.dailyTokens } }),
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
      // `manual` when nobody has an opinion: an agent on no profile does not
      // get latitude by default (FR-11.1's conservative default).
      autonomy: this.options.autonomyFor?.(request.agentId) ?? 'manual',
      // Empty until `start()`. ADR-0010 injects credentials *at spawn*, and
      // this config is built before the version probe has even run.
      envGrants: {},
      identityPath: path.join(agentDir, 'identity.md'),
      protocolPath: path.join(this.options.agoraRoot, 'PROTOCOL.md'),
      // Empty until `start()`, for the same reason `envGrants` is: the memory a
      // spawn carries is whatever the agent had written by the moment the
      // process actually starts, and this config is built before the version
      // probe has even run.
      memory: '',
      recallCommand: this.options.recallCommand ?? ''
    }
  }

  /**
   * Declared grants → values. A grant the broker cannot supply is a visible
   * degradation, not a silent empty variable: an agent that spawns without the
   * credential its role declares fails later, somewhere less obvious.
   */
  private resolveGrants(agentId: string, declared: readonly string[]): Record<string, string> {
    if (declared.length === 0) return {}
    const resolve = this.options.resolveGrants
    if (!resolve) {
      this.options.onGrantsMissing?.(agentId, declared)
      return {}
    }
    const { env, missing } = resolve(declared)
    if (missing.length > 0) {
      this.options.onGrantsMissing?.(agentId, missing)
      // Also in the book of record: a spawn that went out without a credential
      // its role declares is an autonomous action a forensic reader must be
      // able to reconstruct from log.jsonl alone (NFR-13).
      this.options.onLogEvent?.({ kind: 'spawn', agentId, grantsMissing: [...missing] })
    }
    // Re-scoped here rather than trusted: "undeclared vars never reach a spawn"
    // is the invariant, and it must hold at the boundary that builds the
    // environment, not only inside whichever resolver is wired in today.
    const scoped: Record<string, string> = {}
    for (const name of declared) {
      const value = env[name]
      if (value !== undefined) scoped[name] = value
    }
    return scoped
  }

  /**
   * The seat this agent sits in, assigned once and remembered.
   *
   * The roster is the durable memory, but it is written *by* this call's
   * result, so a second hire in the same tick would otherwise be handed the
   * same number. The local map closes that window; the roster is what survives
   * a restart.
   */
  private seatFor(agentId: string, role: string): Seat {
    const held = this.seats.get(agentId)
    if (held !== undefined) return held
    const taken = new Map(this.options.rosterSeats?.() ?? [])
    for (const [id, seat] of this.seats) taken.set(id, seat)
    const seat = assignSeat({ agentId, isOrchestrator: isOrchestratorRole(role), taken })
    this.seats.set(agentId, seat)
    return seat
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
      dailyTokens:
        request.budget?.dailyTokens ?? this.options.rosterBudget?.(request.agentId) ?? null,
      capabilities: request.capabilities,
      seat: this.seatFor(request.agentId, request.role),
      spawnedAt: new Date().toISOString(),
      exitCode: null,
      respawnOffer: null,
      worktree: null
    }
  }

  private update(agentId: string, patch: Partial<AgentCard>): void {
    const agent = this.agents.get(agentId)
    if (!agent) return
    agent.card = { ...agent.card, ...patch }
    this.options.onChange?.(agent.card)
  }

  /** Materializes `identity.md`, `memory.md` and `PROTOCOL.md` (SDD §2). */
  private materializeIdentity(agent: LiveAgent): void {
    const card = agent.card
    fs.mkdirSync(path.dirname(agent.cfg.identityPath), { recursive: true })
    // FR-6.1's "seeded at hire". Idempotent by the seam's contract, so this runs
    // on every start and only ever writes for an agent that has no memory yet —
    // a respawn must find exactly what the dead process left behind.
    this.options.memory?.seed(card.agentId)
    const identity = this.options.prompts.render(path.join('agents', 'identity.md'), {
      name: card.name,
      agentId: card.agentId,
      role: card.role,
      capabilities: card.capabilities.length > 0 ? card.capabilities.join(', ') : 'none declared',
      envGrants: card.envGrants.length > 0 ? card.envGrants.join(', ') : 'none',
      cwd: card.cwd,
      // An agent that does not know where its mailbox is cannot use it.
      agentDir: path.dirname(agent.cfg.identityPath)
    })
    const brief = this.options.roleBrief?.(card)?.trim()
    writeFileAtomic(agent.cfg.identityPath, brief ? `${identity}\n\n${brief}\n` : identity)
    if (!fs.existsSync(agent.cfg.protocolPath)) {
      fs.mkdirSync(path.dirname(agent.cfg.protocolPath), { recursive: true })
      writeFileAtomic(
        agent.cfg.protocolPath,
        this.options.prompts.read(path.join('agora', 'PROTOCOL.md'))
      )
    }
  }

  /**
   * Restarts an exited agent in place — the mechanism half of FR-5.4.
   *
   * A respawn is a *new process*, so it gets a new hook token: the old one died
   * with the old process, and a token that outlived its process would let a
   * dead agent keep writing the event plane. Identity, settings and grants are
   * all re-established the same way a first spawn establishes them.
   *
   * What it carries forward is the engine session, when the adapter can resume
   * one. That is what respawn-with-memory means in M3 (Architect decision):
   * engine-native resume plus re-injected identity and protocol; `memory.md`
   * continuity through the Library is M4's. An engine with no `resume` still
   * respawns — with a fresh session, and the log says so rather than implying
   * a continuity that is not there.
   */
  async respawn(agentId: string): Promise<AgentCard> {
    const agent = this.require(agentId)
    if (this.options.spawner.has(agentId)) {
      throw new Error(`agents: "${agentId}" is still running; stop it before respawning`)
    }
    agent.cfg = { ...agent.cfg, hookToken: randomBytes(32).toString('hex') }
    this.update(agentId, { lifecycle: 'starting', exitCode: null, respawnOffer: null })
    // An isolated agent's clean worktree was removed when it died, so it needs
    // one again — on the same branch, which is why `branchFor` is stable and
    // `create` reuses an existing branch rather than failing on it.
    if (agent.card.worktree !== null) await this.isolate(agentId, agent.targetRepo)
    await this.start(agentId, { resume: true })
    return this.card(agentId)
  }

  /**
   * The argv fragment that resumes this agent's last engine session (ADR-0009
   * `ResumeSupport`), or nothing when the engine has no resume or the event
   * plane never reported a session.
   */
  private resumeArgsFor(agent: LiveAgent): readonly string[] {
    const sessionId = agent.sessionIds.at(-1)
    if (sessionId === undefined || !agent.adapter.resume) return []
    return agent.adapter.resume.resumeArgs(sessionId)
  }

  private async start(agentId: string, opts: { resume?: boolean } = {}): Promise<void> {
    const agent = this.require(agentId)

    // ADR-0010: least-privilege by construction, resolved HERE — the moment
    // the process is actually about to exist. The broker is asked only for
    // what this role declares, so an undeclared credential has no path into
    // the spawn even if the broker holds it.
    agent.cfg = {
      ...agent.cfg,
      envGrants: this.resolveGrants(agentId, agent.card.envGrants),
      // Layer 1 of the Library, resolved HERE for the same reason the grants
      // are: this is the moment the process is about to exist, so what the agent
      // carries is what it had actually written by then — including what it
      // wrote in the session that just died (FR-6.1).
      memory: this.options.memory?.layer(agentId).text ?? ''
    }

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
      const resumeArgs = opts.resume ? this.resumeArgsFor(agent) : []
      this.update(agentId, {
        lifecycle: 'running',
        settingsWritten: plan.settings.map((injection) => injection.path)
      })
      if (opts.resume) {
        this.options.onLogEvent?.({
          kind: 'spawn',
          agentId,
          engine: agent.adapter.id,
          respawn: true,
          // Both continuity facts, separately, because they fail separately: the
          // engine session (`--resume`, ADR-0009) and the company's own memory
          // layer (`memory.md`, ADR-0006). M3.7 could only log the first and
          // recorded it as `memoryCarried`; M4.1 makes the second true.
          resumed: resumeArgs.length > 0,
          memoryCarried: agent.cfg.memory.length > 0,
          sessionId: resumeArgs.length > 0 ? (agent.sessionIds.at(-1) ?? null) : null,
          envGrants: [...agent.card.envGrants]
        })
      }
      this.options.spawner.spawnAgent(
        agentId,
        resumeArgs.length > 0 ? { ...plan, argv: [...plan.argv, ...resumeArgs] } : plan
      )
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

  /**
   * Gives this spawn its own worktree of the target repo (UC-01 alternate 2a).
   *
   * Everything downstream follows the card's `cwd`: the spawn plan, the grants,
   * the settings install and the transcript directory all target the worktree
   * rather than the Architect's own checkout. A worktree that cannot be made is
   * reported and the spawn continues where it was going to — visible, and never
   * a reason not to hire.
   */
  private async isolate(agentId: string, repo: string): Promise<void> {
    const worktrees = this.options.worktrees
    if (!worktrees) {
      this.options.onGrantsMissing?.(agentId, [])
      this.options.onLogEvent?.({
        kind: 'spawn',
        agentId,
        worktree: null,
        because: 'worktree isolation was requested but is not configured'
      })
      return
    }
    const outcome = await worktrees.create({
      repo,
      path: worktrees.pathFor(agentId),
      branch: worktrees.branchFor(agentId)
    })
    if (!outcome.ok) {
      this.options.onLogEvent?.({ kind: 'spawn', agentId, worktree: null, because: outcome.reason })
      this.options.onExitError?.(agentId, new Error(outcome.reason))
      return
    }
    const info: WorktreeInfo = {
      path: outcome.path,
      branch: outcome.branch,
      branchCreated: outcome.created
    }
    const agent = this.agents.get(agentId)
    if (agent) agent.cfg = { ...agent.cfg, cwd: outcome.path }
    this.update(agentId, { worktree: info, cwd: outcome.path })
    this.options.onLogEvent?.({
      kind: 'spawn',
      agentId,
      worktree: outcome.path,
      branch: outcome.branch,
      branchCreated: outcome.created,
      // The repo the worktree came from, so a reader can find the branch.
      repo
    })
  }

  /**
   * Removes a clean worktree at unwind, and *reports* a dirty one.
   *
   * `--force` is never used (see `git.ts`): an agent that died with unpushed
   * work leaves that work on disk for the Architect. Tidiness does not outrank
   * somebody's afternoon.
   */
  private async releaseWorktree(agent: LiveAgent, repo: string): Promise<void> {
    const worktree = agent.card.worktree
    if (!worktree || !this.options.worktrees) return
    const outcome = await this.options.worktrees.remove(repo, worktree.path)
    this.options.onLogEvent?.({
      kind: 'exit',
      agentId: agent.card.agentId,
      worktree: worktree.path,
      branch: worktree.branch,
      worktreeRemoved: outcome.removed,
      ...(outcome.removed ? {} : { because: outcome.reason, changes: [...outcome.changes] })
    })
    if (!outcome.removed) {
      // Visible, not just logged: a working copy left behind with somebody's
      // uncommitted work in it is exactly the kind of thing that must be said
      // out loud (invariant §7).
      this.options.onExitError?.(agent.card.agentId, new Error(outcome.reason))
    }
  }

  /**
   * SDD §6/§10: a ghost is archived once the grace period elapses. Driven from
   * the avatar clock, which owns the 30 s timer — one place decides when an
   * agent stops being a ghost, and the roster mirrors it (SDD §4.1 `status`).
   */
  archive(agentId: string): void {
    const agent = this.agents.get(agentId)
    if (!agent || agent.card.lifecycle !== 'exited') return
    this.setRosterStatus(agentId, 'archived')
  }

  /**
   * Everything SDD §10 owes when a spawn's process ends: the ledger tasks it
   * had in flight go back to `todo`, and the card carries a respawn offer that
   * says honestly what coming back would restore — the engine session (only if
   * the adapter has `resume` AND the event plane saw a session) and how much
   * memory is waiting (ADR-0006 layer 1).
   *
   * A deliberate kill takes the same path as a crash: nothing distinguishes
   * them at the pty seam, both leave assigned work unworked, and `exitCode` is
   * recorded so a reader can tell the difference without the harness guessing.
   */
  private offerRespawn(agent: LiveAgent, exitCode: number | null): RespawnOffer {
    const agentId = agent.card.agentId
    let tasksReturned: readonly string[] = []
    try {
      tasksReturned = this.options.returnTasks?.(agentId, 'agent-exit') ?? []
    } catch (err) {
      // A ledger that will not write must not also cost the Architect the
      // respawn offer; the failure is reported and the offer still stands.
      this.options.onExitError?.(agentId, err)
    }
    const offer: RespawnOffer = {
      resumable: agent.adapter.resume !== undefined && agent.sessionIds.length > 0,
      memorySections: this.options.memory?.layer(agentId).facts.totalSections ?? 0,
      tasksReturned
    }
    this.options.onLogEvent?.({
      kind: 'ghost',
      agentId,
      exitCode,
      engine: agent.card.engine,
      resumable: offer.resumable,
      memorySections: offer.memorySections,
      tasksReturned: [...tasksReturned]
    })
    return offer
  }

  /** Restores the repo and revokes the token. Safe to call more than once. */
  private async unwind(agentId: string, exitCode: number | null = null): Promise<void> {
    const agent = this.agents.get(agentId)
    if (!agent) return
    // A spawn that threw before the process existed unwinds through here too;
    // only an agent that actually ran has work to return or a session to resume.
    const ranProcess = agent.card.lifecycle === 'running'
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
    const respawnOffer = ranProcess ? this.offerRespawn(agent, exitCode) : null
    // UC-01 2a: a clean isolated checkout goes away with the spawn; a dirty one
    // stays, and the Architect is told.
    await this.releaseWorktree(agent, agent.targetRepo)
    this.update(agentId, { lifecycle: 'exited', exitCode, settingsWritten: [], respawnOffer })
  }
}

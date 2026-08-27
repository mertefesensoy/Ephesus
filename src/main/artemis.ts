import fs from 'node:fs'
import path from 'node:path'
import type { AgentCard, SpawnRequest } from '../shared/agents'
import {
  mayDecide,
  noAuthority,
  parseAuthorityTable,
  type AuthorityRequest,
  type AuthorityTable,
  type AuthorityVerdict
} from '../shared/authority'
import type { PromptStore } from './prompts'

/**
 * Artemis's lifecycle (ADR-0005, FR-5.1–5.5, SDD §1.1 `artemis.ts`).
 *
 * FR-5.1 is the constraint this file is written against: Artemis is an
 * *ordinary engine process holding a privileged role*, not privileged code. So
 * what lives here is only the things a harness must do — hire her at startup,
 * seat her, put her policy text in front of her, bring her back when she dies,
 * and answer "may she settle this herself?" from a table the Architect wrote.
 *
 * What is deliberately NOT here: any rule about how work is decomposed, who
 * gets which task, what counts as critical, or when to escalate. All of that is
 * text in `prompts/artemis/`, editable from the UI, and changing it must never
 * require changing this file. If a rule about orchestration ever appears in
 * this module, the mechanism/intelligence split ADR-0005 rests on has been lost.
 */

/** SDD §4.1 writes her into the roster by this id. */
export const ARTEMIS_AGENT_ID = 'agent.artemis'
export const ARTEMIS_NAME = 'Artemis'
/** The role string that wins the temple seat (`isOrchestratorRole`, M3.6). */
export const ARTEMIS_ROLE = 'orchestrator'
/** SDD §4.1's example roster entry, verbatim. */
export const ARTEMIS_CAPABILITIES: readonly string[] = [
  'routing',
  'adjudication',
  'scribe',
  'briefing',
  'chair'
]
export const ARTEMIS_DAILY_TOKENS = 2_000_000

/** The delegated-authority table, beside `gate-policy.json` at the home root (SDD §2). */
export const AUTHORITY_REL = 'authority.json'

/** The slice of the agent lifecycle Artemis drives. Narrow on purpose. */
export interface OrchestratorLifecycle {
  spawn(request: SpawnRequest): Promise<AgentCard>
  respawn(agentId: string): Promise<AgentCard>
  list(): readonly AgentCard[]
}

/**
 * How hard the harness tries to bring her back (FR-5.4).
 *
 * A crashed orchestrator that respawns instantly forever is a fork bomb with a
 * laurel wreath, so each attempt waits longer than the last and the ladder
 * ends. Ending is not silent: a company with no orchestrator is exactly the
 * state the Architect must be told about (invariant §7).
 */
export interface RespawnPolicy {
  readonly backoffMs: readonly number[]
  /**
   * How long she must stay up before the ladder resets.
   *
   * Without this the ladder can never be spent by the failure it exists to
   * bound: a process that starts and immediately dies would reset the counter
   * on every start, and the harness would respawn it forever. Coming back and
   * *staying* back is what counts as recovery.
   */
  readonly stabilityMs: number
}

export const DEFAULT_RESPAWN: RespawnPolicy = {
  backoffMs: [1_000, 2_000, 5_000, 15_000, 30_000],
  stabilityMs: 60_000
}

export interface ArtemisOptions {
  readonly agents: OrchestratorLifecycle
  readonly prompts: PromptStore
  /** Harness home — where `authority.json` lives. */
  readonly home: string
  /** Where she runs: the Agora, since `board.md` is hers to scribe (SDD §2). */
  readonly cwd: string
  /** Records `orchestratorId` in the roster (SDD §4.1). */
  setOrchestrator?(agentId: string | null): void
  onLogEvent?(draft: { kind: 'orchestrator' } & Record<string, unknown>): void
  /** Visible degradations: no orchestrator, or an authority table that will not parse. */
  onDegraded?(detail: string): void
  /** Epoch milliseconds; injected in tests. */
  now?(): number
  /** Injected so tests do not sleep through a backoff ladder. */
  delay?(ms: number): Promise<void>
  readonly respawn?: RespawnPolicy
  readonly agentId?: string
  readonly dailyTokens?: number
}

export class Artemis {
  private readonly agentId: string
  private readonly now: () => number
  private readonly delay: (ms: number) => Promise<void>
  private readonly policy: RespawnPolicy
  /** Attempts since she was last seen running; reset by a healthy start. */
  private attempts = 0
  /** When she was last seen running, for the stability window. */
  private runningSince: number | null = null
  /** The in-flight backoff-then-respawn chain, or null when nothing is queued. */
  private pending: Promise<void> | null = null
  private stopped = false
  /** True while a respawn is being built, so her brief says she was restarted. */
  private respawning = false
  private lastAuthorityWarning: string | null = null

  constructor(private readonly options: ArtemisOptions) {
    this.agentId = options.agentId ?? ARTEMIS_AGENT_ID
    this.now = options.now ?? (() => Date.now())
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.policy = options.respawn ?? DEFAULT_RESPAWN
  }

  id(): string {
    return this.agentId
  }

  /** Contract: whether this agent is the one holding the orchestrator role. */
  isOrchestrator(agentId: string): boolean {
    return agentId === this.agentId
  }

  /** The hire, as a spawn request. Public so the roster and tests read one shape. */
  hire(engine: SpawnRequest['engine']): SpawnRequest {
    return {
      agentId: this.agentId,
      name: ARTEMIS_NAME,
      role: ARTEMIS_ROLE,
      engine,
      cwd: this.options.cwd,
      capabilities: [...ARTEMIS_CAPABILITIES],
      // ADR-0010: she holds no credentials. Orchestration is routing and text.
      envGrants: [],
      budget: { dailyTokens: this.options.dailyTokens ?? ARTEMIS_DAILY_TOKENS }
    }
  }

  /**
   * FR-5.4: auto-spawn at startup into the reserved seat.
   *
   * Returns null rather than throwing when she cannot be hired: a company that
   * boots without an orchestrator is degraded, not dead, and the Architect can
   * still drive their agents by hand. The degradation is reported.
   */
  async start(engine: SpawnRequest['engine']): Promise<AgentCard | null> {
    this.stopped = false
    try {
      const card = await this.options.agents.spawn(this.hire(engine))
      this.attempts = 0
      this.runningSince = this.now()
      this.options.setOrchestrator?.(this.agentId)
      this.options.onLogEvent?.({
        kind: 'orchestrator',
        event: 'spawned',
        agentId: this.agentId,
        engine: card.engine,
        seat: card.seat
      })
      return card
    } catch (err) {
      this.reportDown(`could not be hired: ${reason(err)}`)
      return null
    }
  }

  /**
   * Watches the roster for her own exit. Driven by the same card stream the UI
   * gets, so the harness has one source of truth about who is running.
   */
  noteCard(card: AgentCard): void {
    if (card.agentId !== this.agentId) return
    if (card.lifecycle === 'running') {
      this.runningSince ??= this.now()
      return
    }
    if (card.lifecycle !== 'exited') return
    // Recovery is coming back and *staying* back. A respawn that dies on the
    // way up does not buy another full ladder.
    const upFor = this.runningSince === null ? 0 : this.now() - this.runningSince
    if (upFor >= this.policy.stabilityMs) this.attempts = 0
    this.runningSince = null
    this.scheduleRespawn(card.exitCode)
  }

  private scheduleRespawn(exitCode: number | null): void {
    if (this.stopped || this.pending) return
    const wait = this.policy.backoffMs[this.attempts]
    if (wait === undefined) {
      // The ladder is spent. Saying so is the point: an Architect whose
      // orchestrator is gone must find out from the app, not from silence.
      this.reportDown(
        `crashed ${String(this.attempts)} times and will not be restarted again` +
          `${exitCode === null ? '' : ` (last exit code ${String(exitCode)})`}`
      )
      this.options.setOrchestrator?.(null)
      return
    }
    this.attempts += 1
    this.options.onLogEvent?.({
      kind: 'orchestrator',
      event: 'respawn-scheduled',
      agentId: this.agentId,
      attempt: this.attempts,
      waitMs: wait,
      exitCode
    })
    this.pending = this.waitThenRespawn(wait)
  }

  private async waitThenRespawn(wait: number): Promise<void> {
    await this.delay(wait)
    // Cleared before the attempt, not after: a failed attempt schedules the
    // next rung of the ladder from inside `respawnNow`, and a `finally` here
    // would drop that one on the floor.
    this.pending = null
    if (this.stopped) return
    await this.respawnNow()
  }

  /** Resolves once no respawn is queued. For shutdown, and for tests. */
  async drained(): Promise<void> {
    while (this.pending) await this.pending
  }

  private async respawnNow(): Promise<void> {
    if (this.stopped) return
    this.respawning = true
    try {
      const card = await this.options.agents.respawn(this.agentId)
      this.options.onLogEvent?.({
        kind: 'orchestrator',
        event: 'respawned',
        agentId: this.agentId,
        attempt: this.attempts
      })
      if (card.lifecycle === 'exited') this.scheduleRespawn(card.exitCode)
    } catch (err) {
      this.reportDown(`respawn attempt ${String(this.attempts)} failed: ${reason(err)}`)
      this.scheduleRespawn(null)
    } finally {
      this.respawning = false
    }
  }

  /**
   * Her standing context (ADR-0005 "prompt as policy"), handed to the lifecycle
   * as an ordinary role brief. Every word is a file the Architect can edit; a
   * missing or unreadable file is reported rather than silently replaced by a
   * default, because an orchestrator running without its policy would look
   * exactly like one running with it.
   */
  roleBrief(card: AgentCard): string | null {
    if (card.agentId !== this.agentId) return null
    try {
      const system = this.options.prompts.read(path.join('artemis', 'system.md'))
      if (!this.respawning) return system
      const notice = this.options.prompts.render(path.join('artemis', 'respawn-notice.md'), {
        detail: ''
      })
      return `${system}\n\n${notice}`
    } catch (err) {
      this.options.onDegraded?.(`artemis: policy prompt unreadable — ${reason(err)}`)
      return null
    }
  }

  /**
   * The delegated-authority table as it is on disk right now (FR-5.5).
   *
   * Re-read rather than cached: the Architect edits it while the company runs,
   * and a table nobody re-reads is a setting that appears to work. Absent means
   * *no* delegated authority — the same posture as a missing `gate-policy.json`
   * (SDD §9). An unreadable table is reported once per distinct reason, so one
   * bad file plus a busy company cannot flood the health buffer.
   */
  authority(): AuthorityTable {
    const file = path.join(this.options.home, AUTHORITY_REL)
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      this.lastAuthorityWarning = null
      return noAuthority
    }
    let parsed
    try {
      parsed = parseAuthorityTable(JSON.parse(raw))
    } catch (err) {
      parsed = { ok: false as const, reason: `not valid JSON — ${reason(err)}` }
    }
    if (!parsed.ok) {
      if (this.lastAuthorityWarning !== parsed.reason) {
        this.lastAuthorityWarning = parsed.reason
        this.options.onDegraded?.(
          `artemis: ${AUTHORITY_REL} refused (${parsed.reason}) — no delegated authority`
        )
      }
      return noAuthority
    }
    this.lastAuthorityWarning = null
    return parsed.table
  }

  /**
   * FR-5.5's enforcement hook: may Artemis settle this herself?
   *
   * An allowed decision comes back with its countersignature already made, and
   * the countersignature is logged here — so there is no path that takes a
   * decision under delegated authority without leaving the Architect something
   * to audit. Filing it into the memo/gate archive is the Odeon's (M5).
   */
  mayDecide(request: AuthorityRequest): AuthorityVerdict {
    const verdict = mayDecide(this.authority(), request, {
      orchestratorId: this.agentId,
      at: new Date(this.now()).toISOString()
    })
    this.options.onLogEvent?.(
      verdict.allowed
        ? {
            kind: 'orchestrator',
            event: 'countersigned',
            agentId: this.agentId,
            ...verdict.countersignature
          }
        : {
            kind: 'orchestrator',
            event: 'escalated',
            agentId: this.agentId,
            class: request.class,
            domain: request.domain,
            because: verdict.because
          }
    )
    return verdict
  }

  /** The escalation text (invariant §8: every word is config). */
  escalationNotice(what: string, because: string): string {
    return this.options.prompts.render(path.join('artemis', 'escalation-notice.md'), {
      what,
      because
    })
  }

  /** Cancels any pending respawn. Called at shutdown; safe to call twice. */
  stop(): void {
    this.stopped = true
    this.pending = null
  }

  private reportDown(detail: string): void {
    this.options.onDegraded?.(`artemis: ${detail}`)
    this.options.onLogEvent?.({
      kind: 'orchestrator',
      event: 'down',
      agentId: this.agentId,
      detail
    })
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

import fs from 'node:fs'
import { composeBudget } from '../shared/cost'
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
import { DEFAULT_RESPAWN, type RespawnPolicy } from '../shared/respawn'
import { RespawnLadder, type LadderEvent } from './respawn'
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
/**
 * The orchestrator's daily allowance WHEN THE ARCHITECT SETS ONE.
 *
 * Raised from 2,000,000 after the 2026-09-01 live run, where she reached
 * `breached` on briefing work before the first incident arrived and stayed
 * breached across every restart that night. Two million was not a limit that
 * shaped behaviour; it was a limit that fired immediately and permanently,
 * which is the same as having no signal at all.
 *
 * It is no longer the DEFAULT (ADR-0029, 2026-09-06). This docblock used to
 * argue the opposite — "it stays a number rather than becoming unlimited on
 * purpose" — and the argument was answered by the thing it predicted going
 * wrong in the other direction: on 2026-09-06 the same failure repeated at
 * forty million. She breached mid-run and rung-3 stopped with five incidents
 * unrouted, and because activation is all-or-nothing a stopped orchestrator
 * takes the company with her. A ceiling that fires on ordinary work is not a
 * ladder either; it is the 2026-09-01 failure with a bigger number.
 *
 * What that argument got right is kept: the ladder still needs a ceiling to BE
 * a ladder. So the number survives, exported and unchanged, for an Architect
 * who wants one — it is the default that moved, not the mechanism.
 */
export const ARTEMIS_DAILY_TOKENS = 40_000_000

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
 * The ladder itself moved to `shared/respawn.ts` at M8.6, when it stopped
 * being hers alone: it had exactly one user while the crew died and stayed
 * dead. Re-exported here because every reader of this file expects to find it,
 * and because FR-5.4 is still the requirement it serves.
 */
export { DEFAULT_RESPAWN, type RespawnPolicy }

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
  /**
   * A standing decision that she must not be brought back, or null (M8.6).
   *
   * The orchestrator is not exempt from B11. A rung-3 stop against Artemis
   * that her own ladder immediately undoes is the same cycle the crew had, and
   * FR-14.5 already treats a rung-3 stop on her work as consequential enough
   * to revert the company's mode. Asked here rather than only inside
   * `AgentManager.respawn` so a blocked exit costs no rung: five refusals in a
   * row would otherwise end the ladder and report "crashed 5 times" about an
   * agent that never crashed.
   */
  respawnBlocked?(agentId: string): string | null
  readonly agentId?: string
  readonly dailyTokens?: number
  /**
   * The company-wide ceiling (`gate-policy.json`), composed with any explicit
   * `dailyTokens` the same way every hire's is: stricter wins, and a figure
   * larger than the company allows is clamped down to it.
   */
  maxDailyTokens?(): number | null
}

export class Artemis {
  private readonly agentId: string
  private readonly now: () => number
  /**
   * FR-5.4's backoff ladder, now shared with the crew (`main/respawn.ts`).
   *
   * Artemis keeps the *policy* — what it means for the company to have no
   * orchestrator — and the ladder keeps the arithmetic and the timers. The
   * split is what let the crew get a ladder at all in M8.6 without a second
   * copy of the pending-promise handoff this class paid for twice.
   */
  private readonly ladder: RespawnLadder
  /** True while a respawn is being built, so her brief says she was restarted. */
  private respawning = false
  private lastAuthorityWarning: string | null = null

  constructor(private readonly options: ArtemisOptions) {
    this.agentId = options.agentId ?? ARTEMIS_AGENT_ID
    this.now = options.now ?? (() => Date.now())
    this.ladder = new RespawnLadder({
      ...(options.now ? { now: options.now } : {}),
      ...(options.delay ? { delay: options.delay } : {}),
      policy: options.respawn ?? DEFAULT_RESPAWN,
      respawn: () => this.respawnNow(),
      ...(options.respawnBlocked
        ? { blocked: () => options.respawnBlocked?.(this.agentId) ?? null }
        : {}),
      // A company with no orchestrator is exactly the state the Architect must
      // find out about from the app rather than from silence, and the roster's
      // `orchestratorId` must stop naming an agent that will not come back.
      onExhausted: (detail) => {
        this.reportDown(detail)
        this.options.setOrchestrator?.(null)
      },
      onAttemptFailed: (attempt, detail) =>
        this.reportDown(`respawn attempt ${String(attempt)} failed: ${detail}`),
      onEvent: (event) => this.logLadder(event)
    })
  }

  /**
   * The ladder's vocabulary, in the orchestrator's own log words.
   *
   * The event NAMES predate the extraction and are load-bearing: they are what
   * the book of record holds for every past run, and renaming them would make
   * a year of history unreadable by whatever reads it next.
   */
  private logLadder(event: LadderEvent): void {
    const base = { kind: 'orchestrator' as const, agentId: this.agentId }
    switch (event.event) {
      case 'scheduled':
        this.options.onLogEvent?.({
          ...base,
          event: 'respawn-scheduled',
          attempt: event.attempt,
          waitMs: event.waitMs,
          exitCode: event.exitCode
        })
        return
      case 'respawned':
        this.options.onLogEvent?.({ ...base, event: 'respawned', attempt: event.attempt })
        return
      case 'held':
        this.options.onLogEvent?.({
          ...base,
          event: 'held-for-capacity',
          attempt: event.attempt
        })
        return
      case 'deferred':
        this.options.onLogEvent?.({
          ...base,
          event: 'respawn-deferred-for-capacity',
          attempt: event.attempt,
          exitCode: event.exitCode
        })
        return
      case 'released':
        this.options.onLogEvent?.({
          ...base,
          event: 'respawn-after-capacity',
          attempt: event.attempt,
          exitCode: event.exitCode
        })
        return
      case 'blocked':
        this.options.onLogEvent?.({
          ...base,
          event: 'respawn-blocked',
          because: event.because,
          exitCode: event.exitCode
        })
        // A company with no orchestrator is the state the Architect must be
        // told about, whatever the reason — a spent ladder and a standing stop
        // leave exactly the same hole in the company (invariant §7).
        this.reportDown(`will not be restarted — ${event.because}`)
        this.options.setOrchestrator?.(null)
        return
    }
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
      // Unbudgeted unless the Architect names a figure (ADR-0029). Absent is
      // not zero: `spendFor` reads a null ceiling as `unbudgeted`, which the
      // breaker's burn-rate signal never fires on, while every OTHER signal —
      // repeated calls, hop caps, pathology — and ADR-0023's wall-clock wake
      // cap are untouched. Removing the spend ceiling is not removing the
      // governor.
      ...((): Record<string, unknown> => {
        const ceiling = composeBudget(
          this.options.dailyTokens ?? null,
          this.options.maxDailyTokens?.() ?? null
        ).effective
        return ceiling === null ? {} : { budget: { dailyTokens: ceiling } }
      })()
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
    this.ladder.resume()
    try {
      const card = await this.options.agents.spawn(this.hire(engine))
      this.ladder.noteStarted()
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
      this.ladder.noteRunning()
      return
    }
    if (card.lifecycle !== 'exited') return
    this.ladder.noteExited(card.exitCode)
  }

  /**
   * The company is waiting on provider capacity: stop spending the ladder.
   *
   * Idempotent — the watch parks per agent and may say so more than once.
   */
  holdForCapacity(): void {
    this.ladder.hold('capacity')
  }

  /**
   * Capacity is back. Serves an exit that arrived during the hold, WITHOUT
   * charging it to the ladder: she did not crash, she was refused.
   */
  releaseForCapacity(): void {
    this.ladder.release()
  }

  /** True while the ladder is being held for capacity. For tests and the card. */
  heldForCapacity(): boolean {
    return this.ladder.isHeld()
  }

  /** Resolves once no respawn is queued. For shutdown, and for tests. */
  async drained(): Promise<void> {
    await this.ladder.drained()
  }

  /**
   * One attempt at bringing her back, as the ladder asks for it.
   *
   * `respawning` is set for the duration so `roleBrief` tells her she was
   * restarted — the notice is part of the respawn, not decoration, and reading
   * it from the same flag the spawn sets is what keeps the two from drifting.
   */
  private async respawnNow(): Promise<{ stillDown: boolean; exitCode: number | null }> {
    this.respawning = true
    try {
      const card = await this.options.agents.respawn(this.agentId)
      return { stillDown: card.lifecycle === 'exited', exitCode: card.exitCode }
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
    this.ladder.stop()
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

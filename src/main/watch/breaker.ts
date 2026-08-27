import { createHash } from 'node:crypto'
import {
  actionsFor,
  DEFAULT_THRESHOLDS,
  evaluateSignals,
  nextRung,
  protectionFor,
  RUNG_NAMES,
  spanSchema,
  type BreakerState,
  type BreakerThresholds,
  type Rung,
  type SignalHit,
  type Span
} from '../../shared/breaker'

/**
 * The circuit breaker (ADR-0011, FR-11.3, SDD §9) and its span capture
 * (FR-11.6).
 *
 * The signals and the ladder are pure functions in `src/shared/breaker.ts`;
 * this class owns the state they read — the spans, the rung each agent is at,
 * the hop-cap counters — and the acts each rung performs. Keeping the decision
 * pure is what makes a trip explicable: the same spans always produce the same
 * verdict, and the log carries the numbers that caused it.
 *
 * Rung 1 stays cheap on purpose. ADR-0011 accepts false trips precisely because
 * the cost of one is a single injected sentence; anything that made rung 1
 * expensive would break that bargain.
 */

/** The acts a rung performs. Injected, so the breaker owns no subsystem. */
export interface BreakerEffects {
  /**
   * Rung 1: one corrective sentence into the agent's session, through the
   * command queue — it is a prompt, so FR-1.3's queue-until-idle applies to it
   * exactly as it does to the Architect's own typing.
   */
  steer(agentId: string, text: string): void
  /** Rung 2: pause this agent's Hermes deliveries. */
  pauseDeliveries(agentId: string, paused: boolean): void
  /**
   * Rung 2's second constraint (ADR-0011 "lower its remaining budget"):
   * tighten the agent's budget envelope while constrained; recovery lifts it.
   * (Read-only tool restriction is the excused third — "where the engine
   * supports it", and the reference engine cannot mid-session.)
   */
  constrainBudget(agentId: string, constrained: boolean): void
  /** Rung 3: the engine's cancel key, then a stop. */
  interrupt(agentId: string): void
  stop(agentId: string): void
  /** Drives the avatar (`looping` at rung 1, `stopped` at rung 3 — SDD §6). */
  avatar(
    agentId: string,
    event: { kind: 'breaker'; rung: 1 | 2 | 3 } | { kind: 'breaker-recover' }
  ): void
}

export interface BreakerOptions {
  readonly effects: BreakerEffects
  /**
   * Renders rung 1's corrective sentence from `prompts/watch/` (invariant §8).
   * The breaker supplies facts; every word is config.
   */
  steerText(hit: SignalHit): string
  /** `log` kind `breaker` (SDD §4.3) — every trip and every rung transition. */
  onLogEvent?(draft: { kind: 'breaker' } & Record<string, unknown>): void
  /** The agent's declared hook grade, for ADR-0011's reduced-protection note. */
  hookFidelity?(agentId: string): string
  /** The agent's budget state (M3.2), the fourth trip signal. */
  budgetState?(agentId: string): SignalBudget
  now?(): number
  readonly thresholds?: BreakerThresholds
  /** Spans kept per agent. Bounded: this is a live buffer, not the record. */
  readonly spanLimit?: number
}

type SignalBudget = 'ok' | 'projected-breach' | 'breached' | 'unbudgeted' | null

/** Spans retained per agent. The book of record is `log.jsonl`, not this. */
export const DEFAULT_SPAN_LIMIT = 500

interface AgentBreaker {
  readonly spans: Span[]
  rung: Rung
  /** When the rung last changed, so the ladder cannot climb faster than the
   *  agent can respond to the previous rung. */
  rungAt: number
  /** Hop-cap escalations per conversation (ADR-0003's diversion counter). */
  readonly hopCap: Record<string, number>
  /** Open spans keyed by tool, awaiting their post-tool event. */
  readonly open: Map<string, Span>
}

export class Breaker {
  private readonly agents = new Map<string, AgentBreaker>()
  private readonly now: () => number

  constructor(private readonly options: BreakerOptions) {
    this.now = options.now ?? (() => Date.now())
  }

  private of(agentId: string): AgentBreaker {
    let agent = this.agents.get(agentId)
    if (!agent) {
      agent = { spans: [], rung: 0, rungAt: this.now(), hopCap: {}, open: new Map() }
      this.agents.set(agentId, agent)
    }
    return agent
  }

  /**
   * Opens a span on `pre-tool` (FR-11.6: agent, tool, duration, outcome).
   *
   * The payload is fingerprinted rather than stored: spans are local-only
   * (NFR-10) but they are also read by the briefing compiler, and a tool call's
   * arguments can contain anything the agent was working on.
   */
  openSpan(agentId: string, tool: string, payload: unknown): void {
    const agent = this.of(agentId)
    const span: Span = spanSchema.parse({
      agentId,
      tool,
      durationMs: null,
      outcome: 'open',
      startedAt: this.now(),
      fingerprint: fingerprint(payload)
    })
    agent.open.set(tool, span)
    agent.spans.push(span)
    this.trim(agent)
  }

  /** Closes the matching span on `post-tool`. */
  closeSpan(agentId: string, tool: string, outcome: 'ok' | 'error'): void {
    const agent = this.of(agentId)
    const open = agent.open.get(tool)
    if (!open) return
    agent.open.delete(tool)
    const index = agent.spans.lastIndexOf(open)
    if (index < 0) return
    agent.spans[index] = {
      ...open,
      outcome,
      durationMs: Math.max(0, this.now() - open.startedAt)
    }
  }

  /** Records a hop-cap diversion on a conversation (trip signal #3). */
  noteHopCap(agentId: string, conversation: string): void {
    const agent = this.of(agentId)
    agent.hopCap[conversation] = (agent.hopCap[conversation] ?? 0) + 1
  }

  /**
   * Consumes the Stop-hook pathology signal M2.5 emits (ADR-0013). It was
   * emitted and logged from M2 with nothing reading it — the M2 carried item.
   * A continued-too-many-times agent is a looping agent by any definition, so
   * it enters the ladder at rung 1 like every other signal.
   */
  notePathology(agentId: string, blocks: number): void {
    this.climb(agentId, [{ signal: 'repetition', detail: { source: 'stop-loop', blocks } }])
  }

  /** Spans captured for one agent (FR-11.6; no waterfall UI yet). */
  spansFor(agentId: string): readonly Span[] {
    return [...this.of(agentId).spans]
  }

  /** The breaker's state for one agent, as the UI and the log see it. */
  stateFor(agentId: string): BreakerState {
    const agent = this.of(agentId)
    const protection = protectionFor(this.options.hookFidelity?.(agentId) ?? 'native')
    return {
      agentId,
      rung: agent.rung,
      firing: this.signals(agentId),
      reducedProtection: protection.reduced,
      blindSignals: protection.blind,
      spanCount: agent.spans.length
    }
  }

  private signals(agentId: string): readonly SignalHit[] {
    const agent = this.of(agentId)
    return evaluateSignals({
      spans: agent.spans,
      now: this.now(),
      hopCapEscalations: agent.hopCap,
      budgetState: this.options.budgetState?.(agentId) ?? null,
      ...(this.options.thresholds ? { thresholds: this.options.thresholds } : {})
    })
  }

  /**
   * Evaluates one agent and moves it one rung, up or all the way down.
   *
   * Contract: called on every span close and on every budget change. Never
   * skips a rung — ADR-0011's ladder is the whole point, and a breaker that
   * jumps to `stop` on first sight is the kill switch it was designed not to
   * be.
   */
  evaluate(agentId: string): Rung {
    return this.climb(agentId, this.signals(agentId))
  }

  /**
   * Evaluates ignoring the dwell.
   *
   * The dwell exists so a stuck agent gets a chance to act on each rung before
   * the next one (see `BreakerThresholds.rungDwellMs`); a scenario asserting
   * the *ladder* must be able to step it without sleeping a minute per rung.
   * Nothing in production calls this — the timers do not need it, and the
   * dwell is the property, not an obstacle.
   */
  forceEvaluate(agentId: string): Rung {
    const agent = this.of(agentId)
    agent.rungAt = 0
    return this.evaluate(agentId)
  }

  private climb(agentId: string, firing: readonly SignalHit[]): Rung {
    const agent = this.of(agentId)
    const target = nextRung(agent.rung, firing.length > 0, {
      sinceMs: this.now() - agent.rungAt,
      requiredMs: (this.options.thresholds ?? DEFAULT_THRESHOLDS).rungDwellMs
    })
    if (target === agent.rung) return agent.rung

    const from = agent.rung
    agent.rung = target
    agent.rungAt = this.now()
    this.options.onLogEvent?.({
      kind: 'breaker',
      agentId,
      from,
      rung: target,
      action: target === 0 ? 'recover' : RUNG_NAMES[target],
      // The numbers that caused it, so a trip is explicable after the fact.
      signals: firing.map((hit) => hit.signal),
      detail: firing.map((hit) => hit.detail)
    })
    this.apply(agentId, target, firing)
    return target
  }

  private apply(agentId: string, rung: Rung, firing: readonly SignalHit[]): void {
    if (rung === 0) {
      // Recovery undoes rung 2's constraints; nothing undoes a rung-3 stop.
      this.options.effects.pauseDeliveries(agentId, false)
      this.options.effects.constrainBudget(agentId, false)
      this.options.effects.avatar(agentId, { kind: 'breaker-recover' })
      return
    }
    const actions = actionsFor(rung)
    this.options.effects.avatar(agentId, { kind: 'breaker', rung })
    if (rung === 1 && actions.steer) {
      const hit = firing[0]
      // One sentence. Rung 1's whole bargain is that a false trip costs this
      // much and no more (ADR-0011).
      if (hit) this.options.effects.steer(agentId, this.options.steerText(hit))
    }
    if (rung === 2 && actions.constrain) {
      this.options.effects.pauseDeliveries(agentId, true)
      this.options.effects.constrainBudget(agentId, true)
    }
    if (rung === 3 && actions.stop) {
      // Graceful first: the engine's own cancel key, then the process.
      this.options.effects.interrupt(agentId)
      this.options.effects.stop(agentId)
    }
  }

  /** Forgets an agent; a respawn starts at rung 0 with no history. */
  forget(agentId: string): void {
    this.agents.delete(agentId)
  }

  private trim(agent: AgentBreaker): void {
    const limit = this.options.spanLimit ?? DEFAULT_SPAN_LIMIT
    while (agent.spans.length > limit) agent.spans.shift()
  }
}

/**
 * Contract: a stable digest of a tool call's arguments. Same arguments always
 * give the same digest; different arguments almost never collide. The digest
 * never contains the arguments, so a span can be read by the briefing compiler
 * without carrying whatever the agent was working on (NFR-10).
 */
export function fingerprint(payload: unknown): string {
  let text: string
  try {
    text = stableStringify(payload)
  } catch {
    // A payload that will not serialize is still a distinguishable call; it is
    // just one we cannot tell apart from another unserializable one.
    text = 'unserializable'
  }
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

/** Key order must not change the digest, or repetition would never be seen. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  )
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

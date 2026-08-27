import path from 'node:path'
import { composeMessage, makeMessageId, type Message } from '../shared/message'
import { LIBRARY_ENDPOINT } from '../shared/reserved'
import { parseCondensation } from '../shared/reflection'
import type { Library } from './library'
import type { PromptStore } from './prompts'
import type { Trigger } from './scheduler'

/**
 * The reflection job — Library layer 3's driver (ADR-0006, FR-6.3).
 *
 * The shape of this module is decided by ADR-0005, not by convenience:
 * "harness calls a model API directly" is an option that ADR explicitly
 * **rejects**, and condensing a memory is judgement, not mechanism. So the job
 * never summarizes anything. It notices that a memory is over the threshold,
 * asks its owner to condense it as a normal turn on a harness prompt, and
 * applies the answer the owner proposes back to `agent.library`.
 *
 * Everything that can go wrong here degrades *visibly* and is retried, never
 * dropped: an agent with no mailbox, an agent that never answers, an answer
 * that will not parse. A memory that quietly stopped being condensed would grow
 * until the injection budget silently ate it.
 */

const REQUEST_PROMPT = path.join('library', 'reflect-request.md')
const ACCEPT_PROMPT = path.join('library', 'reflect-accept.md')
const ACCEPT_SUBJECT = path.join('library', 'reflect-accept-subject.md')
const REFUSE_PROMPT = path.join('library', 'reflect-refuse.md')
const REFUSE_SUBJECT = path.join('library', 'reflect-refuse-subject.md')

/** How long an unanswered request stands before it is asked again. */
export const REFLECTION_RETRY_MS = 6 * 60 * 60 * 1_000
/** Reflection's own cadence; the scheduler's interval for this trigger. */
export const REFLECTION_EVERY_MS = 60 * 60 * 1_000

export interface ReflectionOptions {
  readonly library: Library
  readonly prompts: PromptStore
  /** Agents with a live mailbox — an agent with none cannot be asked. */
  reachableAgents(): readonly string[]
  /**
   * Delivers a harness-authored message. Injected rather than importing Hermes,
   * so the job stays testable without a router and the Library never learns
   * how mail moves.
   */
  deliver(message: Message): void
  /** Every visible degradation — a deferral is one (invariant §7). */
  onDegraded?(detail: string): void
  now?(): Date
}

/** What the job is waiting for, per agent. */
interface Outstanding {
  readonly messageId: string
  readonly conversation: string
  readonly askedAtMs: number
  readonly sections: number
}

export class ReflectionJob {
  private readonly outstanding = new Map<string, Outstanding>()
  private readonly now: () => Date

  constructor(private readonly options: ReflectionOptions) {
    this.now = options.now ?? (() => new Date())
  }

  /** The scheduler entry (SDD §1.1 `scheduler.ts` — reflection is its first client). */
  trigger(): Trigger {
    return {
      id: 'library.reflection',
      everyMs: REFLECTION_EVERY_MS,
      run: () => {
        this.sweep()
      }
    }
  }

  /** Agents currently waiting to answer a reflection request. */
  pending(): readonly string[] {
    return [...this.outstanding.keys()].sort()
  }

  /**
   * Asks every agent whose memory is over the threshold to condense it.
   *
   * Contract: at most one outstanding request per agent. A request that has
   * stood longer than `REFLECTION_RETRY_MS` is asked again — an agent that died
   * mid-turn must not leave its memory growing forever, and asking twice is
   * harmless because the endpoint applies whichever answer arrives against the
   * plan as it stands then.
   */
  sweep(): void {
    const nowMs = this.now().getTime()
    for (const agentId of this.options.reachableAgents()) {
      const plan = this.options.library.reflectionPlan(agentId)
      if (!plan.due) continue

      const waiting = this.outstanding.get(agentId)
      if (waiting && nowMs - waiting.askedAtMs < REFLECTION_RETRY_MS) continue
      if (waiting) {
        this.options.onDegraded?.(
          `reflection: ${agentId} has not answered since ${new Date(waiting.askedAtMs).toISOString()}; asking again`
        )
      }
      this.ask(
        agentId,
        plan.condensing.map((section) => section.text).join('\n\n'),
        plan.condensing.length
      )
    }
  }

  /**
   * Records that an agent is gone, so its outstanding request is not held
   * forever. The memory is not condensed and the job says so — deferred,
   * visibly, never dropped.
   */
  forget(agentId: string): void {
    if (!this.outstanding.delete(agentId)) return
    this.options.onDegraded?.(
      `reflection: ${agentId} left before condensing its memory; it will be asked again when it returns`
    )
  }

  /**
   * Applies one `propose` addressed to the Library endpoint.
   *
   * Contract: returns the outcome the router turns into the agent's reply.
   * Refusals carry every reason, so the agent can fix its next attempt in one
   * pass — the same contract the ledger endpoint keeps.
   */
  submit(message: Message): { readonly ok: boolean; readonly reasons?: readonly string[] } {
    const parsed = parseCondensation(message.body)
    if (!parsed.ok) return this.refuse(message.from, [parsed.reason])

    try {
      const applied = this.options.library.condense(
        message.from,
        parsed.condensation.core,
        this.now()
      )
      this.outstanding.delete(message.from)
      // What the agent is told, and therefore what `log.jsonl` records when the
      // reply is delivered: the count and the archive file. Reflection needs no
      // log kind of its own — the request, the proposal and this answer are all
      // messages, and NFR-13's trail is the three `delivery` entries they make.
      this.lastArchived.set(message.from, applied.condensed)
      this.lastArchiveName.set(message.from, applied.archive)
      return { ok: true }
    } catch (err) {
      return this.refuse(message.from, [err instanceof Error ? err.message : String(err)])
    }
  }

  /** The accept/refuse prose the agent reads — a prompt surface (invariant §8). */
  replyText(
    agentId: string,
    outcome: { readonly ok: boolean; readonly reasons?: readonly string[] }
  ): { readonly subject: string; readonly body: string } {
    const reasons = outcome.reasons ?? []
    const vars = {
      count: String(outcome.ok ? (this.lastArchived.get(agentId) ?? 0) : reasons.length),
      archive: this.lastArchiveName.get(agentId) ?? '(none)',
      reasons: reasons.map((reason) => `- ${reason}`).join('\n')
    }
    return outcome.ok
      ? {
          subject: this.options.prompts.render(ACCEPT_SUBJECT, vars).trim().slice(0, 200),
          body: this.options.prompts.render(ACCEPT_PROMPT, vars).trim()
        }
      : {
          subject: this.options.prompts.render(REFUSE_SUBJECT, vars).trim().slice(0, 200),
          body: this.options.prompts.render(REFUSE_PROMPT, vars).trim()
        }
  }

  private readonly lastArchived = new Map<string, number>()
  private readonly lastArchiveName = new Map<string, string>()

  private refuse(
    agentId: string,
    reasons: readonly string[]
  ): { ok: false; reasons: readonly string[] } {
    this.options.onDegraded?.(
      `reflection: ${agentId}'s condensation was refused — ${reasons.join('; ')}`
    )
    return { ok: false, reasons }
  }

  private ask(agentId: string, sections: string, count: number): void {
    const at = this.now()
    const body = this.options.prompts.render(REQUEST_PROMPT, {
      count: String(count),
      endpoint: LIBRARY_ENDPOINT,
      sections
    })
    const message = composeMessage({
      id: makeMessageId(at, `rfl${Math.random().toString(36).slice(2, 8)}`),
      conversation: `conv-reflect-${agentId}`,
      in_reply_to: null,
      from: LIBRARY_ENDPOINT,
      to: agentId,
      act: 'request',
      subject: 'condense your memory',
      body,
      hops: 0,
      created_at: at.toISOString()
    })
    this.options.deliver(message)
    this.outstanding.set(agentId, {
      messageId: message.id,
      conversation: message.conversation,
      askedAtMs: at.getTime(),
      sections: count
    })
  }
}

import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { compileFacts, type BriefFact, type BriefInput } from '../shared/brief'
import { composeMessage, makeMessageId, type Message } from '../shared/message'
import { ODEON_ENDPOINT } from '../shared/reserved'
import type { PromptStore } from './prompts'
import type { Trigger } from './scheduler'

/**
 * The standup briefing job (ADR-0008 §1, FR-7.1, SDD §7.2, UC-04).
 *
 * Its shape is decided by ADR-0005, not by convenience: the harness does not
 * call a model, and it does not write prose. It gathers facts out of the Agora,
 * hands them to the orchestrator as a normal turn on a harness prompt, and
 * checks the answer she proposes back — every sentence against the facts it
 * issued.
 *
 * The facts it issued are held here between the ask and the answer. That state
 * is deliberately in memory: it is a *question in flight*, not a record, and a
 * restart that loses it costs one skipped standup rather than a stale fact set
 * checked against a window that has moved on. The archived brief on disk is the
 * record, and it is written only once the answer passes.
 */

const REQUEST_PROMPT = path.join('odeon', 'brief-request.md')
const REQUEST_SUBJECT = path.join('odeon', 'brief-request-subject.md')

/** Standup cadence. The scheduler's second client (the first is reflection). */
export const STANDUP_EVERY_MS = 24 * 60 * 60 * 1_000

export interface BriefingOptions {
  readonly prompts: PromptStore
  /** Everything the compiler may read. Called fresh at each standup. */
  gather(sinceSeq: number): BriefInput
  /** The orchestrator to ask, or null when none is hired. */
  orchestrator(): string | null
  /** Delivers a harness-authored message (injected, like reflection's). */
  deliver(message: Message): void
  /** `log` kind `brief` (SDD §4.3). */
  onLogEvent?(draft: { kind: 'brief' } & Record<string, unknown>): void
  /** Every visible degradation — a skipped standup is one (invariant §7). */
  onDegraded?(detail: string): void
  now?(): Date
}

/** A brief that has been asked for and not yet narrated. */
interface Outstanding {
  readonly briefId: string
  readonly facts: readonly BriefFact[]
  readonly askedAtMs: number
}

export class BriefingJob {
  private readonly now: () => Date
  /** Only ever one: a second standup while the first is unanswered would ask
   *  the orchestrator to narrate two overlapping windows. */
  private outstanding: Outstanding | null = null
  /** Where the last brief's window ended, so the next one starts there. */
  private lastSeq = 0

  constructor(private readonly options: BriefingOptions) {
    this.now = options.now ?? (() => new Date())
  }

  /** The scheduler trigger this job runs on (SDD §7.2's "scheduler ─trigger─►"). */
  trigger(everyMs: number = STANDUP_EVERY_MS): Trigger {
    return {
      id: 'standup',
      everyMs,
      run: () => {
        this.request()
      }
    }
  }

  /**
   * Compiles the window and asks the orchestrator to narrate it.
   *
   * Contract: returns the facts issued, or null when it could not ask. A window
   * with no facts is still asked about — "nothing happened" is a brief the
   * Architect can act on, and a standup that silently produced nothing is
   * indistinguishable from one that failed.
   */
  request(): readonly BriefFact[] | null {
    const to = this.options.orchestrator()
    if (to === null) {
      this.options.onDegraded?.('standup skipped: no orchestrator is hired to narrate it')
      return null
    }
    if (this.outstanding !== null) {
      this.options.onDegraded?.(
        `standup skipped: ${this.outstanding.briefId} was asked for and never narrated`
      )
      return null
    }

    const input = this.options.gather(this.lastSeq)
    const facts = compileFacts(input)
    const at = this.now()
    const briefId = `b-${at.toISOString().replace(/[:.]/g, '-')}-${randomBytes(2).toString('hex')}`

    this.outstanding = { briefId, facts, askedAtMs: at.getTime() }
    this.lastSeq = input.events.reduce((high, event) => Math.max(high, event.seq), this.lastSeq)

    const vars = {
      briefId,
      facts: facts
        .map((fact) => `- [${fact.section}] ${fact.what} refs: ${fact.refs.join(', ')}`)
        .join('\n')
    }
    this.options.deliver(
      composeMessage({
        id: makeMessageId(at, `brf${randomBytes(3).toString('hex')}`),
        conversation: `conv-brief-${briefId}`,
        in_reply_to: null,
        from: ODEON_ENDPOINT,
        to,
        act: 'request',
        subject: this.options.prompts.render(REQUEST_SUBJECT, { briefId }).trim().slice(0, 200),
        body: this.options.prompts.render(REQUEST_PROMPT, vars).trim(),
        hops: 0,
        created_at: at.toISOString()
      })
    )
    this.options.onLogEvent?.({
      kind: 'brief',
      event: 'requested',
      briefId,
      to,
      facts: facts.length
    })
    return facts
  }

  /**
   * The facts issued for a brief, so the archive can check a narration against
   * the SAME set the narrator was given.
   *
   * Returns null for a brief nobody asked for — which is how a narration
   * inventing its own `briefId` is caught before any of its sentences are read.
   */
  factsFor(briefId: string): readonly BriefFact[] | null {
    return this.outstanding?.briefId === briefId ? this.outstanding.facts : null
  }

  /**
   * Closes an outstanding ask, but ONLY when the narration was accepted.
   *
   * A refused brief leaves the question open on purpose: the refusal tells the
   * orchestrator which sentence it could not support, and she must be able to
   * narrate the SAME window again. Closing on refusal makes the refusal
   * terminal and the retry impossible — found by a live run, where a corrected
   * narration was rejected as answering a brief nobody had asked for.
   */
  narrated(briefId: string, accepted: boolean): void {
    if (accepted) this.settle(briefId)
  }

  /** Clears the outstanding ask. Prefer `narrated`, which knows the rule. */
  settle(briefId: string): void {
    if (this.outstanding?.briefId === briefId) this.outstanding = null
  }

  /** Whether a standup is waiting on an answer, for the panel and for tests. */
  pending(): string | null {
    return this.outstanding?.briefId ?? null
  }
}

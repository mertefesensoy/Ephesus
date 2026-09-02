import { randomBytes } from 'node:crypto'
import { composeMessage, makeMessageId, type Message } from '../shared/message'
import { CLOSING_ENDPOINT } from '../shared/reserved'

/**
 * Closing Time (GYM-003, RB-001 finding 1) — the orderly-quit protocol.
 *
 * Killing the PTYs mid-thought loses whatever the agents were holding in
 * working memory: unparked WIP, unrecorded decisions, a `memory.md` missing
 * exactly its last session — which is what M4's respawn-with-memory would then
 * re-inject. Closing time closes the floor the way an office does: the harness
 * mails every live agent a `request` from the closing endpoint (park or commit
 * WIP, append current state + next steps to `memory.md`, acknowledge), watches
 * the ACKs come back through the same mail plane, and hands control back to the
 * teardown when everyone has answered or the deadline passes.
 *
 * Everything rides existing rails: `deliverFromHarness` puts the request in
 * each inbox, the wake watchdog and Stop-hook drain get it acted on, and the
 * replies route to `agent.closing` as an endpoint hand-off (the M3 standing
 * rule for harness-owned correspondents). This module never types into a
 * terminal and never kills anything — it only mails, watches, and reports.
 *
 * The deadline is a hard promise to the Architect: closing time can make a
 * quit slower, never hang it. Agents that have not acknowledged by the
 * deadline are named in the report and the log, and the teardown proceeds —
 * the shortfall is visible, never silent (invariant §7).
 *
 * Electron-free and clock-injectable, so the whole protocol is testable
 * without an app. The mechanism guarantees the *opportunity* and the audit
 * trail; whether an engine actually writes useful memory before acknowledging
 * is agent judgment, measured by the eval layer, not enforced here.
 */

/** The subject an acknowledgment carries (the request's body says so too). */
export const CLOSING_ACK_SUBJECT = 'CLOSING-TIME-ACK'

/** How long the floor gets to pack up before teardown proceeds anyway. */
export const DEFAULT_CLOSING_DEADLINE_MS = 90_000

export interface ClosingReport {
  /** Agents that acknowledged in time, in ack order. */
  readonly acked: readonly string[]
  /** Agents still owing an ack when the deadline hit. */
  readonly missing: readonly string[]
  readonly timedOut: boolean
}

export interface ClosingTimeOptions {
  /** Who must acknowledge — the live roster at the moment closing begins. */
  liveAgents(): readonly string[]
  /** Delivery straight into an inbox (`Hermes.deliverFromHarness`). */
  deliver(message: Message): void
  /**
   * Renders the request's words from `prompts/hermes/closing-time-*.md`
   * (invariant §8) — this class supplies only the facts in `vars`.
   */
  render(kind: 'subject' | 'body', vars: Record<string, string>): string
  /** `log.jsonl` kind `shutdown`: begin / ack / complete (SDD §4.3, NFR-13). */
  onLogEvent(draft: { kind: 'shutdown' } & Record<string, unknown>): void
  readonly deadlineMs?: number
  now?(): number
  /**
   * Arms the deadline; the returned function disarms it. Defaults to
   * `setTimeout`/`clearTimeout`.
   *
   * Injected for the same reason `now` is, and for a sharper one. The deadline
   * is the only thing in this class a caller cannot wait for honestly: a test
   * that wants to see "mason acked, tess did not" has to let mason's real work
   * finish FIRST, then let the deadline pass. With a wall-clock timer the two
   * are in a race, so S-CLOSING asserted "500 ms was enough on this machine"
   * rather than the deadline's semantics — and failed whenever the machine was
   * busy. Raising the constant only moves the threshold; the clock has to be
   * driveable.
   */
  schedule?(fire: () => void, afterMs: number): () => void
}

interface ActiveClosing {
  /** agentId → the request id its ack may reply to. */
  readonly pending: Map<string, string>
  readonly acked: string[]
  /** Disarms the deadline; whatever `schedule` handed back. */
  readonly disarm: () => void
  readonly resolve: (report: ClosingReport) => void
}

export class ClosingTime {
  private active: ActiveClosing | null = null
  private readonly now: () => number
  private readonly schedule: (fire: () => void, afterMs: number) => () => void

  constructor(private readonly options: ClosingTimeOptions) {
    this.now = options.now ?? (() => Date.now())
    this.schedule =
      options.schedule ??
      ((fire, afterMs) => {
        const timer = setTimeout(fire, afterMs)
        // A pending closing must never be the reason the process stays alive.
        timer.unref?.()
        return () => clearTimeout(timer)
      })
  }

  /** True while a closing is in flight — `begin` refuses reentry on it. */
  inProgress(): boolean {
    return this.active !== null
  }

  /**
   * Starts closing time and resolves when every live agent has acknowledged
   * or the deadline passes — never rejects past the reentry guard, because
   * the caller is a quit path that must always reach teardown.
   */
  begin(): Promise<ClosingReport> {
    if (this.active) throw new Error('closing time is already in progress')

    const agents = [...this.options.liveAgents()]
    this.options.onLogEvent({ kind: 'shutdown', event: 'closing-begin', agents, ts: this.now() })
    if (agents.length === 0) {
      const report: ClosingReport = { acked: [], missing: [], timedOut: false }
      this.options.onLogEvent({
        kind: 'shutdown',
        event: 'closing-complete',
        acked: [],
        missing: [],
        timedOut: false
      })
      return Promise.resolve(report)
    }

    const deadlineMs = this.options.deadlineMs ?? DEFAULT_CLOSING_DEADLINE_MS
    const vars = {
      ackSubject: CLOSING_ACK_SUBJECT,
      deadlineSeconds: String(Math.max(1, Math.round(deadlineMs / 1000)))
    }
    const subject = this.options.render('subject', vars).slice(0, 200)
    const body = this.options.render('body', vars)

    const pending = new Map<string, string>()
    return new Promise<ClosingReport>((resolve) => {
      const disarm = this.schedule(() => this.finish(true), deadlineMs)
      this.active = { pending, acked: [], disarm, resolve }

      for (const agentId of agents) {
        const id = makeMessageId(new Date(this.now()), `cls${randomBytes(3).toString('hex')}`)
        pending.set(agentId, id)
        this.options.deliver(
          composeMessage({
            id,
            conversation: `closing-${id}`,
            from: CLOSING_ENDPOINT,
            to: agentId,
            act: 'request',
            subject,
            body,
            hops: 0,
            created_at: new Date(this.now()).toISOString()
          })
        )
      }
    })
  }

  /**
   * The endpoint half — Hermes hands every message addressed to
   * `agent.closing` here. Returns true when a closing is in flight (the
   * message is consumed, counted or not); false means "no closing in
   * progress" and Hermes bounces it back with that reason (FR-3.4).
   */
  noteReply(message: Message): boolean {
    const active = this.active
    if (!active) return false

    const requestId = active.pending.get(message.from)
    const isAck =
      requestId !== undefined &&
      (message.in_reply_to === requestId || message.subject.trim() === CLOSING_ACK_SUBJECT)
    if (!isAck) {
      // From an agent that already acked, or a reply that is neither the
      // subject nor a reply to its request — consumed, recorded, not counted.
      this.options.onLogEvent({
        kind: 'shutdown',
        event: 'closing-unrecognized',
        agentId: message.from,
        msgId: message.id,
        subject: message.subject
      })
      return true
    }

    active.pending.delete(message.from)
    active.acked.push(message.from)
    this.options.onLogEvent({
      kind: 'shutdown',
      event: 'closing-ack',
      agentId: message.from,
      msgId: message.id
    })
    if (active.pending.size === 0) this.finish(false)
    return true
  }

  private finish(timedOut: boolean): void {
    const active = this.active
    if (!active) return
    this.active = null
    active.disarm()
    const report: ClosingReport = {
      acked: [...active.acked],
      missing: [...active.pending.keys()],
      timedOut
    }
    this.options.onLogEvent({
      kind: 'shutdown',
      event: 'closing-complete',
      acked: report.acked,
      missing: report.missing,
      timedOut
    })
    active.resolve(report)
  }
}

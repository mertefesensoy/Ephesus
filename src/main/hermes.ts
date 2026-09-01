import fs from 'node:fs'
import path from 'node:path'
import { emptyCursor, parseCursor, type Cursor } from '../shared/cursor'
import { composeMessage, makeMessageId, parseMessage, type Message } from '../shared/message'
import {
  CLOSING_ENDPOINT,
  HARBOR_ENDPOINT,
  PROFILE_ENDPOINT,
  HERMES_SENDER,
  LEDGER_ENDPOINT,
  LIBRARY_ENDPOINT,
  ODEON_ENDPOINT
} from '../shared/reserved'
import { endpointContract } from '../shared/endpoints'
import { HUMAN_QUEUE, routeMessage, replyHops, type RoutingContext } from '../shared/routing'
import { decideStop, isPathological, type StopContext, type StopDecision } from '../shared/autonomy'
import { mayWake, type Pace } from '../shared/pacing'
import type { Agora } from './agora'
import { writeFileAtomic } from './fsx'
import type { PromptStore } from './prompts'

/**
 * Hermes — the router (ADR-0003, SDD §1.1 `hermes.ts`).
 *
 * Agents write one JSON file into their own `outbox/`. Nothing else. The router
 * is the single point of mediation, which is what makes hop caps, bounces,
 * escalation and the event log possible in one place — and what keeps
 * single-writer-per-file true, since no file is ever written by two processes.
 *
 * Two invariants shape every line below:
 *
 *  - **Delivery is a rename, durability is a commit** (ADR-0004). A message is
 *    delivered the instant it is renamed into the recipient's inbox; the git
 *    commit that makes it durable is *queued*, never awaited, because delivery
 *    latency must not wait on git (NFR-2: p95 ≤ 500 ms).
 *  - **Never merge outbox and inbox into a direct write** (BUILD-PROMPT §7).
 *    The indirection is the design.
 *
 * Crash safety comes from the ordering, not from a transaction: rename into the
 * inbox → log → drain the outbox. A crash before the rename loses nothing (the
 * outbox file is still there); a crash after it delivers the same file twice at
 * worst, and a second rename to the same `<id>.json` is a no-op.
 */

/** Fault points, in the production path, for S-BLACKOUT (TEST-STRATEGY §3). */
export type HermesFaultPoint =
  'before-deliver' | 'after-deliver' | 'before-drain-outbox' | 'before-consume' | 'after-consume'

export type HermesFaultInjector = (point: HermesFaultPoint) => void | Promise<void>

/** SDD §11: fs-watch debounce 50 ms. */
export const WATCH_DEBOUNCE_MS = 50
/** R6 mitigation: fs-watch is unreliable cross-platform, so a sweep backs it up. */
export const SWEEP_INTERVAL_MS = 1000
/**
 * Minimum gap between one agent's wakes while the company is pacing `slow`
 * (ADR-0023).
 *
 * Set from the measurement, not from taste: on 2026-09-01 Artemis took 39 wakes
 * in roughly 10 hours — about one every 15 minutes on average, but arriving in
 * bursts, with stop-hook re-wakes chasing inbox wakes within seconds. A
 * five-minute floor leaves the average cadence untouched and removes the burst,
 * which is where the 9.54M of stop-hook re-wake spend actually came from.
 */
export const DEFAULT_SLOW_WAKE_GAP_MS = 5 * 60 * 1000

export interface DeliveryRecord {
  readonly message: Message
  /** Absolute path the message now lives at. */
  readonly deliveredTo: string
}

export interface RejectionRecord {
  readonly file: string
  readonly reason: string
  /**
   * The refusal returned to whoever wrote the file, or `null` when there was
   * nobody to return it to. Symmetric with `BounceRecord.refusal`, and the
   * null case is named rather than hidden because it is the only remaining way
   * for an agent's work to end in silence (invariant §7).
   */
  readonly notice: Message | null
}

export interface SweepReport {
  readonly delivered: readonly DeliveryRecord[]
  readonly rejected: readonly RejectionRecord[]
}

export interface HermesOptions {
  readonly agora: Agora
  readonly faults?: HermesFaultInjector
  /** Notified for each delivered message, before the commit is queued. */
  onDelivered?(record: DeliveryRecord): void
  /**
   * A delivered message the router or Artemis flagged `needs_human` (SDD §4.4).
   * This is the Watch's second gate choke point (SDD §9): the mail is still
   * delivered, and the action behind it is also put in front of the Architect.
   */
  onNeedsHuman?(record: DeliveryRecord): void
  /** Notified for each rejected file — a visible state, never a silent drop. */
  onRejected?(record: RejectionRecord): void
  /**
   * Supplies the roster the routing rules read. Injected rather than read from
   * the registry directly so the rules stay testable, and so M3 can swap in the
   * live roster without touching delivery.
   */
  context?(): RoutingContext
  /**
   * Takes a crew member's report on a scheduled sweep. Returns false when no
   * profile endpoint is listening, which bounces rather than drops.
   */
  profiles?(message: Message): boolean
  /** Notified for each bounce, for the sender-facing notification (FR-3.4). */
  onBounced?(record: BounceRecord): void
  /**
   * Notified for each hop-cap diversion — the breaker's trip signal #3 reads
   * this (ADR-0011); a divert is not a bounce, so `onBounced` never sees it.
   */
  onDiverted?(record: { from: string; conversation: string; reason: string }): void
  /**
   * The harness's ledger endpoint (SDD §7.1). Injected rather than imported so
   * the router never learns what a task is — it carries the message to the
   * endpoint and reports the answer, exactly as it carries mail to a mailbox.
   */
  ledger?(message: Message): { readonly ok: boolean; readonly reasons?: readonly string[] }
  /**
   * The Library's reflection endpoint (ADR-0006 layer 3). Same shape as the
   * ledger's and injected for the same reason: the router carries the message
   * and reports the answer without learning what a memory is.
   *
   * It supplies its own reply prose because the two endpoints say different
   * things — the ledger's prompts are `prompts/hermes/`, the Library's are
   * `prompts/library/` (invariant §8 either way).
   */
  /**
   * The Odeon's filing endpoint (ADR-0008, FR-7.2). Same shape as the
   * Library's, injected for the same reason: the router carries the message,
   * the endpoint owns the archive, and their words live in different prompt
   * directories (`prompts/odeon/` here — invariant §8 either way).
   */
  odeon?(message: Message): {
    readonly ok: boolean
    readonly reasons?: readonly string[]
    readonly subject: string
    readonly body: string
  }
  library?(message: Message): {
    readonly ok: boolean
    readonly reasons?: readonly string[]
    readonly subject: string
    readonly body: string
  }
  /**
   * The closing-time endpoint (GYM-003) — carries acknowledgments to the
   * shutdown protocol without the router learning what a shutdown is. Returns
   * true when a closing is in flight and the message was consumed; false
   * bounces it back to the sender ("no closing time is in progress", FR-3.4).
   */
  closing?(message: Message): boolean

  /**
   * The Harbor's incident endpoint (FR-9.2, UC-09) — carries an on-call
   * agent's triage report to `IncidentEndpoint.onTriage`. Returns true when the
   * report was consumed; false bounces it back with the reason, exactly as an
   * out-of-season closing ack bounces. The endpoint writes its own refusal for
   * a report it could read but could not match, so a `false` here means only
   * "no incident subsystem is listening".
   */
  harbor?(message: Message): boolean
  /** Renders the block reason and the wake nudge — both are prompt surfaces. */
  readonly prompts?: PromptStore
  /** Per-spawn cap on Stop-hook continuations (ADR-0013 guard 2). */
  readonly blockCap?: number
  /** Unfinished tasks assigned to an agent; the ledger lands fully in M3. */
  pendingTasksFor?(agentId: string): number
  /** Writes text into a live agent's session — how the watchdog nudges. */
  nudge?(agentId: string, text: string): void
  /** True when the agent has finished its turn and is waiting. */
  isIdle?(agentId: string): boolean
  /**
   * The company's pace (ADR-0023). Both wake paths below consult it, because
   * both of them are where the harness *issues a wake* — and the wake, not the
   * token, is the unit of spend: a measured Artemis wake cost a median 485k
   * tokens, of which 91.4% was re-reading context that already existed before
   * the wake began. Spacing wakes is therefore the only throttle that acts on
   * the quantity actually driving the bill.
   *
   * Absent means `full`: pacing is a governor, not an interlock (ADR-0023), so
   * a harness assembled without it behaves exactly as it did before.
   */
  pace?(): Pace
  /** Minimum gap between wakes of one agent while the pace is `slow`. */
  readonly slowWakeGapMs?: number
  /**
   * Raised when a wake was deferred by the pace, with the reason. Deferral must
   * be visible or the company looks hung (invariant §7) — nothing about it is
   * inferable from the outside, since a deferred wake leaves no trace in the
   * mailbox at all.
   */
  onWakeDeferred?(
    agentId: string,
    detail: { pace: Pace; waitMs: number; pendingMail: number }
  ): void
  now?(): number
  /** Raised when a session's block count looks pathological (ADR-0011, M3). */
  onPathology?(agentId: string, blocks: number): void
  /**
   * Raised when a sweep the *watcher or the periodic timer* started failed.
   * Callers who await `sweep()` get the rejection; nobody awaits those two, so
   * without this the error would be an `unhandledRejection` and take the main
   * process down. (The timer path was missed at M2 close and caught by the
   * close-out audit — both paths route here now.)
   */
  onSweepError?(err: unknown): void
}

/** What the harness tells the engine to do when a turn ends (ADR-0013). */
export interface StopReply {
  readonly decision: 'block'
  readonly reason: string
}

export interface BounceRecord {
  readonly original: Message
  readonly reason: string
  /** The `refuse` sent back to the sender. */
  readonly refusal: Message
}

/** Where a rejected file is parked: out of the outbox, still on disk, inspectable. */
export const REJECTED_DIR = '.rejected'
export const DONE_DIR = '.done'

/**
 * Serializes handed-over mail for a prompt surface's `{{messages}}` slot. Pure
 * data (the messages verbatim, as JSON) — every word of framing around it lives
 * in `prompts/hermes/` (invariant §8).
 */
export function formatHandover(messages: readonly Message[]): string {
  if (messages.length === 0) return '(none)'
  // File names on ONE line, not the messages themselves.
  //
  // This used to hand over `JSON.stringify(m, null, 2)` — pretty-printed, ~14
  // lines per message — and the nudge is typed into the agent's terminal. A
  // real Claude Code TUI runs with bracketed paste enabled, sees a multi-line
  // block arrive at once, decides it is a paste and stops for confirmation
  // ("Enter to confirm · Esc to cancel"). Freshly spawned agents died there:
  // two of the Skeleton Crew exited 1 within two seconds of their first wake,
  // and the failure was invisible to every test because the fake engine reads
  // its inbox from disk and never renders a terminal at all.
  //
  // So the hand-over is a POINTER now, not a payload. The harness says what
  // arrived and where it was archived; the agent reads its own files with the
  // tools it already has. Pushing kilobytes of JSON through a keyboard was
  // never the sound half of this design.
  return messages.map((m) => `inbox/.done/${m.id}.json`).join(', ')
}

export class Hermes {
  private readonly watchers = new Map<string, fs.FSWatcher>()
  private readonly debounces = new Map<string, NodeJS.Timeout>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private sweeping: Promise<SweepReport> = Promise.resolve({ delivered: [], rejected: [] })
  /** Stop-hook continuations per session, for guard 2 (ADR-0013). */
  private readonly blocks = new Map<string, number>()
  /**
   * Which message files each agent has already been nudged FOR.
   *
   * A set of agent IDS is what this used to be, and it left a race that can
   * silence an agent for good. The old rule was "nudged once, no more until the
   * inbox is empty": the nudge consumes the inbox, so the next tick normally
   * sees zero pending and clears the flag. But mail landing in the window
   * between the consume and that observation leaves `pending > 0` with the flag
   * still set — and from then on `pending` never returns to zero, so the flag
   * never clears and the agent is never nudged again.
   *
   * Found while investigating a live stall at M7.7. It was NOT the cause of
   * that stall (the agent there was correctly skipped as busy), and it is
   * recorded that way rather than dressed up as the fix — but it is a real way
   * for an agent to go deaf, and it costs one map to close.
   *
   * Keyed on the message files instead, so "exactly once" means once per
   * MESSAGE rather than once per agent. The same unread mail still nudges only
   * once (S-WAKE's "no stale nudges"); genuinely new mail earns its own nudge,
   * which is what FR-3.5 asks for — "mail that lands while an agent is idle
   * must wake it".
   */
  private readonly nudged = new Map<string, ReadonlySet<string>>()
  /** (msgId, recipient) pairs whose hold is already in the log — no metronome. */
  private readonly heldLogged = new Set<string>()
  /** Diverted msgIds already logged and signalled — one divert, one record. */
  private readonly divertNotified = new Set<string>()
  /** Agents whose deliveries the breaker is holding (rung 2, ADR-0011). */
  private readonly paused = new Set<string>()
  /**
   * When each agent was last woken, so the pace can put a floor under the gap
   * (ADR-0023). In-memory on purpose: this governs the *rate* of wakes, and a
   * restart legitimately starts the company moving again — the durable record
   * of what was spent stays where it belongs, in the ledger.
   */
  private readonly lastWokeAt = new Map<string, number>()

  constructor(private readonly options: HermesOptions) {}

  private get now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /**
   * The pace gate (ADR-0023). Contract: pure of side effects except the one
   * `onWakeDeferred` report, and it NEVER touches the mailbox — a deferred wake
   * must leave the mail exactly where it is, so the next pass finds it and the
   * agent eventually hears it. Consuming the inbox on a deferral would archive
   * messages no session ever saw, which is the one thing the wake path is not
   * allowed to do.
   */
  private wakeAllowed(agentId: string, pendingMail: number): boolean {
    const pace = this.options.pace?.() ?? 'full'
    if (pace === 'full') return true
    const verdict = mayWake({
      pace,
      lastWokeAt: this.lastWokeAt.get(agentId) ?? null,
      now: this.now,
      slowWakeGapMs: this.options.slowWakeGapMs ?? DEFAULT_SLOW_WAKE_GAP_MS
    })
    if (verdict.allowed) return true
    this.options.onWakeDeferred?.(agentId, { pace, waitMs: verdict.waitMs, pendingMail })
    this.agora.appendLog({
      kind: 'hook',
      event: 'wake-deferred',
      agentId,
      pace,
      // `Infinity` is not JSON; a held wake reports its wait as null — "until
      // the window resets" — rather than as a number that would serialise to
      // `null` anyway and read as though we forgot to fill it in.
      waitMs: Number.isFinite(verdict.waitMs) ? Math.round(verdict.waitMs) : null,
      pendingMail
    })
    return false
  }

  /** Records that a wake was issued, so the next one can be spaced from it. */
  private noteWoken(agentId: string): void {
    this.lastWokeAt.set(agentId, this.now)
  }

  private get agora(): Agora {
    return this.options.agora
  }

  /**
   * Where a recipient's mail lives. Agents sit under `agora/agents/<id>/`; the
   * Architect's own queue sits at `agora/human/` — outside `agents/`, because a
   * human is not an agent and must never appear in the roster.
   */
  mailboxDir(recipient: string): string {
    return recipient === HUMAN_QUEUE ? this.agora.pathOf('human') : this.agora.agentDir(recipient)
  }

  /** Agent ids that currently have a mailbox, for the routing rules. */
  knownAgents(): readonly string[] {
    const root = this.agora.pathOf('agents')
    if (!fs.existsSync(root)) return []
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  }

  /**
   * Hands a proposal to the ledger endpoint and answers the proposer.
   *
   * `propose` obligates a reply (ADR-0003's table), and the reply is the whole
   * value of the endpoint being a correspondent rather than a file: an accepted
   * proposal comes back `agree`, a refused one comes back `refuse` carrying
   * every reason, so Artemis can fix it in one pass instead of guessing.
   */
  private submitToLedger(proposal: Message): void {
    const outcome = this.options.ledger?.(proposal) ?? {
      ok: false,
      reasons: ['the ledger endpoint is not available']
    }
    const reasons = outcome.reasons ?? []
    // Invariant §8: the endpoint's answer is read by an LLM, so its words are
    // a prompt surface — rendered from prompts/hermes/, never literals here.
    // The reasons themselves are data, serialised mechanically into the slot.
    const vars = {
      subject: proposal.subject,
      reasons: reasons.map((r) => `- ${r}`).join('\n')
    }
    const kind = outcome.ok ? 'agree' : 'refuse'
    this.replyFromHarness(
      proposal,
      kind,
      this.render(`ledger-${kind}-subject.md`, vars).trim().slice(0, 200),
      this.render(`ledger-${kind}.md`, vars).trim()
    )
  }

  /**
   * Delivers a message the harness itself wrote, straight into the recipient's
   * inbox.
   *
   * Straight in, like a bounce: the harness has no outbox, and an outbox
   * carries only its owner's mail. It logs the same `delivery` entry the router
   * logs, which is what keeps NFR-13 true for harness-authored mail — a
   * reflection request, or an endpoint's answer, has to be reconstructible from
   * `log.jsonl` like any other message.
   */
  deliverFromHarness(message: Message): void {
    const target = path.join(this.mailboxDir(message.to), 'inbox', `${message.id}.json`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    writeFileAtomic(target, `${JSON.stringify(message, null, 2)}\n`)
    this.agora.appendLog({
      kind: 'delivery',
      msgId: message.id,
      from: message.from,
      to: message.to,
      act: message.act,
      subject: message.subject,
      conversation: message.conversation,
      hops: message.hops
    })
  }

  /** A harness endpoint's reply to the agent that wrote to it. */
  private replyFromHarness(
    original: Message,
    act: 'agree' | 'refuse',
    subject: string,
    body: string,
    from: string = LEDGER_ENDPOINT
  ): void {
    this.deliverFromHarness(
      composeMessage({
        id: makeMessageId(new Date(), `end${Math.random().toString(36).slice(2, 8)}`),
        conversation: original.conversation,
        in_reply_to: original.id,
        from,
        to: original.from,
        act,
        subject: subject.slice(0, 200),
        body,
        hops: replyHops(original),
        created_at: new Date().toISOString()
      })
    )
  }

  /**
   * Hands a condensation to the Library endpoint and answers its author
   * (ADR-0006 layer 3). Same contract as the ledger's: `propose` obligates a
   * reply, and a refusal carries every reason so the next attempt can be right.
   */
  private submitToLibrary(proposal: Message): void {
    // The prompt-less fallback (tests only — the app wires `library`, whose
    // words render from prompts/library/) is a mechanical serialization,
    // deliberately not prose, so invariant §8 has no second home for words.
    const outcome = this.options.library?.(proposal) ?? {
      ok: false,
      reasons: ['the library endpoint is not available'],
      subject: 'library-unavailable',
      body: JSON.stringify({ reasons: ['the library endpoint is not available'] })
    }
    this.replyFromHarness(
      proposal,
      outcome.ok ? 'agree' : 'refuse',
      outcome.subject,
      outcome.body,
      LIBRARY_ENDPOINT
    )
  }

  /**
   * Hands an acknowledgment to the closing-time protocol (GYM-003). An ack
   * with no closing in flight is out of season — bounced with the reason
   * rather than dropped (FR-3.4), so the agent learns nobody was packing up.
   */
  private submitToClosing(message: Message): void {
    const handled = this.options.closing?.(message) ?? false
    if (!handled) this.bounce(message, 'no closing time is in progress')
  }

  /**
   * Hands a triage report to the incident endpoint (FR-9.2, UC-09 step 3/4).
   *
   * The endpoint answers the sender itself when it can read the report and
   * cannot match it, because that refusal carries reasons only it knows. A
   * `false` here is the coarser case — nothing is listening at all — and
   * bounces with that reason rather than dropping the agent's work.
   */
  private submitToHarbor(message: Message): void {
    const handled = this.options.harbor?.(message) ?? false
    if (!handled) this.bounce(message, 'no incident endpoint is listening')
  }

  /**
   * Takes a crew member's report on a scheduled sweep (ADR-0012 triggers).
   *
   * The trigger that woke them was sent `from: agent.profiles`, and the
   * protocol tells an agent to reply to whoever asked. Nothing was listening,
   * so every sweep report bounced — the work happened and the company never
   * heard about it. Recorded rather than answered: a sweep report is an agent
   * telling the harness what it found, and there is nothing to decide.
   */
  private submitToProfiles(message: Message): void {
    const handled = this.options.profiles?.(message) ?? false
    if (!handled) this.bounce(message, 'no profile endpoint is listening')
  }

  /**
   * Hands an artifact filing to the Odeon and answers its author (ADR-0008,
   * FR-7.2). Same contract as the other two endpoints: `propose` obligates a
   * reply, and a refusal carries every reason so the next filing can be right.
   */
  private submitToOdeon(proposal: Message): void {
    const outcome = this.options.odeon?.(proposal) ?? {
      ok: false,
      reasons: ['the odeon endpoint is not available'],
      subject: 'odeon-unavailable',
      body: JSON.stringify({ reasons: ['the odeon endpoint is not available'] })
    }
    this.replyFromHarness(
      proposal,
      outcome.ok ? 'agree' : 'refuse',
      outcome.subject,
      outcome.body,
      ODEON_ENDPOINT
    )
  }

  /**
   * Sends a `refuse` back to the sender and records the bounce (FR-3.4:
   * "never drop silently"). The refusal is delivered straight into the sender's
   * inbox rather than through its own outbox — the sender did not write it, and
   * an outbox carries only its owner's mail.
   */
  private bounce(original: Message, reason: string): void {
    // The refusal's words reach an LLM, so they are a prompt surface
    // (invariant §8) — rendered from prompts/hermes/, never string literals.
    const vars = { id: original.id, to: original.to, subject: original.subject, reason }
    const refusal = composeMessage({
      id: makeMessageId(new Date(), `bnc${Math.random().toString(36).slice(2, 8)}`),
      conversation: original.conversation,
      in_reply_to: original.id,
      // The router wrote this, not the sender. Through M2 it claimed
      // `from: <the original sender>` — a message the sender never wrote,
      // attributed to them — because §4.4 gave the harness no legal identity.
      // `agent.hermes` is reserved (`src/shared/reserved.ts`) and no hire can
      // take it, which closes the gap the M2 close-out recorded.
      from: HERMES_SENDER,
      to: original.from,
      act: 'refuse',
      subject: this.render('bounce-subject.md', vars).trim().slice(0, 200),
      body: this.render('bounce-body.md', vars).trim(),
      hops: replyHops(original),
      created_at: new Date().toISOString()
    })

    const target = path.join(this.mailboxDir(original.from), 'inbox', `${refusal.id}.json`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    writeFileAtomic(target, `${JSON.stringify(refusal, null, 2)}\n`)

    this.agora.appendLog({
      kind: 'bounce',
      msgId: original.id,
      from: original.from,
      to: original.to,
      conversation: original.conversation,
      refusalId: refusal.id,
      reason
    })
    this.options.onBounced?.({ original, reason, refusal })
  }

  /** Creates the mailbox layout for one agent (SDD §2). Idempotent. */
  ensureMailbox(agentId: string): void {
    const dir = this.agora.agentDir(agentId)
    for (const sub of ['inbox', path.join('inbox', DONE_DIR), 'outbox']) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true })
    }
  }

  /** Starts watching an agent's outbox, plus the periodic sweep. */
  watch(agentId: string): void {
    this.ensureMailbox(agentId)
    if (this.watchers.has(agentId)) return
    const outbox = path.join(this.agora.agentDir(agentId), 'outbox')
    try {
      const watcher = fs.watch(outbox, () => this.onOutboxChange())
      this.watchers.set(agentId, watcher)
    } catch {
      // fs-watch is unreliable on some platforms and filesystems (R6). A missing
      // watcher costs latency, not correctness — the sweep still finds the mail.
    }
  }

  unwatch(agentId: string): void {
    this.watchers.get(agentId)?.close()
    this.watchers.delete(agentId)
  }

  /** Starts the sweep that backs up fs-watch (R6). Idempotent. */
  start(): void {
    if (this.sweepTimer) return
    // Nobody awaits the timer's sweep either — same rule as the watcher's: a
    // delivery error is a reported degradation, never a dead harness.
    this.sweepTimer = setInterval(() => {
      this.sweepAndWake().catch((err: unknown) => this.options.onSweepError?.(err))
    }, SWEEP_INTERVAL_MS)
    this.sweepTimer.unref?.()
  }

  /**
   * One production tick: deliver, then run the wake watchdog. The watchdog is
   * chained onto every sweep so mail landing on an idle agent wakes it from the
   * app's own wiring (ADR-0013, FR-3.5) — not only from a test driver.
   */
  private async sweepAndWake(): Promise<void> {
    await this.sweep()
    await this.wakeCheck()
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    for (const timer of this.debounces.values()) clearTimeout(timer)
    this.debounces.clear()
    for (const agentId of [...this.watchers.keys()]) this.unwatch(agentId)
  }

  private onOutboxChange(): void {
    const existing = this.debounces.get('sweep')
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.debounces.delete('sweep')
      // Nobody is awaiting this one, so it must absorb its own failure: a
      // delivery error is a reported degradation, never a dead harness.
      this.sweepAndWake().catch((err: unknown) => this.options.onSweepError?.(err))
    }, WATCH_DEBOUNCE_MS)
    timer.unref?.()
    this.debounces.set('sweep', timer)
  }

  /**
   * Drains every outbox once. Contract: serialised — concurrent callers (the
   * watcher and the timer both firing) share one pass rather than racing over
   * the same files.
   */
  sweep(): Promise<SweepReport> {
    this.sweeping = this.sweeping.then(
      () => this.runSweep(),
      () => this.runSweep()
    )
    return this.sweeping
  }

  /**
   * Resolves once a sweep already in flight has finished. Starts none.
   *
   * `stop()` clears the timers, but a sweep that is already running keeps
   * going — and a sweep calls `agora.commitSoon()`, which starts a git child.
   * Shutting down by draining the commit queue alone therefore drains a queue
   * the sweep is about to add to, and git can still be starting as the caller
   * tears the directory down. Quiescing means: stop, settle, then drain.
   *
   * Deliberately does not sweep: a shutdown must not deliver mail nobody asked
   * it to deliver. It absorbs the failure of the in-flight sweep because
   * `onSweepError` already reported it — this answers "is it finished", not
   * "did it work".
   */
  async settled(): Promise<void> {
    await this.sweeping.catch(() => {})
  }

  private async runSweep(): Promise<SweepReport> {
    const delivered: DeliveryRecord[] = []
    const rejected: RejectionRecord[] = []

    const agentsRoot = this.agora.pathOf('agents')
    if (!fs.existsSync(agentsRoot)) return { delivered, rejected }

    for (const agentId of fs.readdirSync(agentsRoot).sort()) {
      const outbox = path.join(agentsRoot, agentId, 'outbox')
      if (!fs.existsSync(outbox)) continue
      for (const name of fs.readdirSync(outbox).sort()) {
        if (!name.endsWith('.json')) continue
        const file = path.join(outbox, name)
        const outcome = await this.deliverOne(agentId, file)
        if (outcome.kind === 'delivered') delivered.push(...outcome.records)
        else if (outcome.kind === 'rejected') rejected.push(outcome.record)
      }
    }

    if (delivered.length > 0 || rejected.length > 0) {
      // Durability is queued, not awaited: delivery has already happened.
      this.agora.commitSoon(`hermes: deliver ${delivered.length}, reject ${rejected.length}`)
    }
    return { delivered, rejected }
  }

  private async deliverOne(
    ownerId: string,
    file: string
  ): Promise<
    | { kind: 'delivered'; records: DeliveryRecord[] }
    | { kind: 'rejected'; record: RejectionRecord }
    | { kind: 'skipped' }
  > {
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
      // `ownerId` is the directory this file was found in, so even bytes that
      // are not JSON have an author to answer to.
      return this.reject(
        file,
        `not valid JSON: ${err instanceof Error ? err.message : 'unreadable'}`,
        ownerId
      )
    }

    const parsed = parseMessage(raw)
    if (!parsed.ok) return this.reject(file, parsed.reason, ownerId)

    // Single-writer-per-file (ADR-0003): a file in agent A's outbox claiming to
    // be from agent B is a forgery, whatever wrote it.
    if (parsed.message.from !== ownerId) {
      // Answered to `ownerId`, deliberately, not to `parsed.message.from`:
      // the claimed sender did not write this and must never be told it did.
      return this.reject(
        file,
        `from "${parsed.message.from}" does not own this outbox ("${ownerId}")`,
        ownerId
      )
    }

    const context = this.options.context?.() ?? {
      knownAgents: this.knownAgents(),
      orchestratorId: null
    }
    const route = routeMessage(parsed.message, context)

    if (route.kind === 'bounce') {
      this.bounce(parsed.message, route.reason)
      this.drainOutbox(file)
      return { kind: 'skipped' }
    }

    if (route.kind === 'endpoint') {
      // An ASIDE: an act the endpoint admits but its handler does not act on
      // (`accepts` minus `handles` in src/shared/endpoints.ts) — an agent
      // answering the Odeon "done" instead of filing a deck, or telling the
      // Library it cannot condense its memory.
      //
      // Recorded and not answered. FR-3.4 forbids DROPPING, not answering, and
      // a terminal act obliges nothing back; the alternative is what shipped,
      // where every reply reached a handler that knew exactly one body shape
      // and came back "your JSON is malformed" to an agent that had never
      // claimed to send any.
      const contract = endpointContract(route.endpoint)
      if (contract !== undefined && !contract.handles.includes(parsed.message.act)) {
        this.agora.appendLog({
          kind: 'delivery',
          msgId: parsed.message.id,
          from: parsed.message.from,
          to: route.endpoint,
          act: parsed.message.act,
          subject: parsed.message.subject,
          conversation: parsed.message.conversation,
          hops: parsed.message.hops,
          aside: true,
          summary: parsed.message.body.slice(0, 2000)
        })
        this.drainOutbox(file)
        return { kind: 'skipped' }
      }

      // Not delivered to a mailbox — handed to the harness, which validates it
      // and writes through the single committer. The sender gets an answer
      // either way: a proposal that vanished silently would leave Artemis
      // believing work exists that does not, or an agent believing its memory
      // was condensed when it was not.
      if (route.endpoint === LIBRARY_ENDPOINT) this.submitToLibrary(parsed.message)
      else if (route.endpoint === CLOSING_ENDPOINT) this.submitToClosing(parsed.message)
      else if (route.endpoint === ODEON_ENDPOINT) this.submitToOdeon(parsed.message)
      else if (route.endpoint === HARBOR_ENDPOINT) this.submitToHarbor(parsed.message)
      else if (route.endpoint === PROFILE_ENDPOINT) this.submitToProfiles(parsed.message)
      else this.submitToLedger(parsed.message)
      this.drainOutbox(file)
      return { kind: 'skipped' }
    }

    const message = parsed.message
    const recipients = route.kind === 'divert' ? [route.to] : route.to
    if (route.kind === 'divert' && !this.divertNotified.has(message.id)) {
      this.divertNotified.add(message.id)
      this.options.onDiverted?.({
        from: message.from,
        conversation: message.conversation,
        reason: route.reason
      })
      // The message still gets delivered — to the adjudicator, not the
      // addressee. Escalation, not a drop (FR-3.3).
      this.agora.appendLog({
        kind: 'bounce',
        msgId: message.id,
        from: message.from,
        to: message.to,
        divertedTo: route.to,
        conversation: message.conversation,
        hops: message.hops,
        reason: route.reason
      })
    }

    const records: DeliveryRecord[] = []
    let anyHeld = false

    for (const recipient of recipients) {
      // Breaker rung 2 (ADR-0011 "pause ITS Hermes inbox deliveries"). The
      // message stays in the outbox and reaches this recipient when the pause
      // lifts — constraining an agent must never lose its mail, and must never
      // hold a co-recipient's copy hostage (M3 close-out audit, D4).
      if (this.paused.has(recipient)) {
        anyHeld = true
        const key = `${message.id}:${recipient}`
        if (!this.heldLogged.has(key)) {
          this.heldLogged.add(key)
          this.agora.appendLog({
            kind: 'breaker',
            agentId: recipient,
            action: 'delivery-held',
            msgId: message.id
          })
        }
        continue
      }
      const target = path.join(this.mailboxDir(recipient), 'inbox', `${message.id}.json`)
      // A partially-held message is re-swept until the pause lifts; recipients
      // already served must not be delivered or logged twice.
      if (
        fs.existsSync(target) ||
        fs.existsSync(path.join(path.dirname(target), DONE_DIR, `${message.id}.json`))
      ) {
        continue
      }
      await this.options.faults?.('before-deliver')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      // Atomic: the recipient (and the Stop-hook drain) may read this directory
      // at any moment, so a half-written file must never be visible.
      writeFileAtomic(target, `${JSON.stringify(message, null, 2)}\n`)
      await this.options.faults?.('after-deliver')

      this.agora.appendLog({
        kind: 'delivery',
        msgId: message.id,
        from: message.from,
        to: recipient,
        act: message.act,
        subject: message.subject,
        conversation: message.conversation,
        hops: message.hops
      })

      const record: DeliveryRecord = { message, deliveredTo: target }
      records.push(record)
      this.heldLogged.delete(`${message.id}:${recipient}`)
      this.options.onDelivered?.(record)
      // SDD §9's second gate choke point. The message is delivered either way —
      // escalation never swallows mail (FR-3.3) — but a `needs_human` flag also
      // puts the action in front of the Architect instead of leaving it to be
      // noticed in a thread.
      if (message.needs_human) this.options.onNeedsHuman?.(record)
    }

    await this.options.faults?.('before-drain-outbox')
    // A message with a held recipient stays in the outbox for the next sweep;
    // the existsSync guard above keeps the served recipients single-shot.
    if (!anyHeld) this.drainOutbox(file)
    return anyHeld && records.length === 0 ? { kind: 'skipped' } : { kind: 'delivered', records }
  }

  /**
   * Parks a file the router will not carry, and returns the refusal to whoever
   * wrote it.
   *
   * Parked, not deleted: the Architect can read what an agent got wrong, and it
   * will not be re-processed forever. Parking is load-bearing now rather than
   * merely forensic — the notice POINTS at the parked copy, so the author can
   * recover its own text instead of rewriting from memory.
   *
   * `author` is supplied by the caller, because only the caller knows what its
   * directory means:
   *
   *  - A file in `agents/<id>/outbox/` was written by `<id>`. That is read from
   *    the PATH, not from the content, so even a file whose bytes are garbage
   *    has a knowable author. Every outbox rejection is returnable.
   *  - A file in an inbox names its RECIPIENT, and `from` is the very field
   *    that just failed to validate. Nobody can be named without guessing:
   *    `null`, and the log entry is all anyone can have.
   *
   * The silence this closes was live, not theoretical. On 2026-09-01 Artemis
   * wrote a complete, fully-cited standup brief; one derived field was wrong;
   * the whole message went to `.rejected/`, and the only symptom anywhere was
   * one line in the error log. Her brief loop broke every window and nothing
   * surfaced it. FR-3.4 says never drop silently — and a drop the author is
   * never told about is silent to the one party that could have fixed it.
   */
  private reject(
    file: string,
    reason: string,
    author: string | null
  ): { kind: 'rejected'; record: RejectionRecord } {
    const parked = path.join(path.dirname(file), REJECTED_DIR, path.basename(file))
    fs.mkdirSync(path.dirname(parked), { recursive: true })
    try {
      fs.renameSync(file, parked)
    } catch {
      fs.rmSync(file, { force: true })
    }

    // Parked before notified, deliberately: the notice cites the parked path,
    // and a notice pointing at a file that is not there yet would be a lie.
    const notice = author === null ? null : this.returnToAuthor(author, parked, reason)
    const record: RejectionRecord = { file: parked, reason, notice }
    this.agora.appendLog({
      kind: 'error',
      subsystem: 'hermes',
      file: parked,
      reason,
      // Ties "this was refused" to "and this is what told its author", so the
      // pair is reconstructible from `log.jsonl` alone (NFR-13). A null
      // `noticeId` next to a non-null `author` is the notify-failed case.
      //
      // The notice's own `delivery` entry therefore lands one seq EARLIER than
      // this one: it has to exist before it can be cited. Reading the log in
      // order, the answer precedes the question by a millisecond.
      author,
      noticeId: notice?.id ?? null
    })
    this.options.onRejected?.(record)
    return { kind: 'rejected', record }
  }

  /**
   * Delivers the refusal for a parked file to its author. Returns the notice,
   * or null when one could not be composed or delivered.
   *
   * A refusal that is itself refused would ping-pong, so loop safety rests on
   * three independent things, none of which is a counter:
   *
   *  1. **The notice never enters an outbox.** `reject` fires only on files
   *     found in an outbox sweep or an inbox consume; this goes straight into
   *     the author's inbox, exactly as `bounce` does, because the harness has
   *     no outbox of its own. There is no path by which a harness-written
   *     notice re-enters `deliverOne` — the only rejecter that notifies — so a
   *     refusal cannot be refused.
   *  2. **It is validated before it is sent.** `composeMessage` parses against
   *     the schema and throws, so an ill-formed notice is never written at all,
   *     rather than being delivered to fail on the far side. Caught here: the
   *     file stays parked and logged either way, and only the notification is
   *     lost — visibly, which is the whole point. Not hypothetical: `to` must
   *     match `agentIdSchema`, and a stray directory under `agents/` yields an
   *     owner id that does not.
   *  3. **It obligates nothing.** `refuse` is not a reply-obliging act
   *     (`REPLY_OBLIGING_ACTS`), so `requires_reply` derives false and the
   *     notice starts no chain. `hops: 0` for the same reason it carries no
   *     `in_reply_to` — the harness wrote this; it is not the continuation of a
   *     thread we were able to read.
   */
  private returnToAuthor(author: string, parked: string, reason: string): Message | null {
    const name = path.basename(parked)
    try {
      // The refusal's words reach an LLM, so they are a prompt surface
      // (invariant §8) — rendered from prompts/hermes/, never string literals.
      const vars = {
        file: name,
        reason,
        // Relative to the author's own directory. It can read its own outbox,
        // and the harness home's absolute layout is not an agent's business.
        parked: path.posix.join('outbox', REJECTED_DIR, name)
      }
      const notice = composeMessage({
        id: makeMessageId(new Date(), `rej${Math.random().toString(36).slice(2, 8)}`),
        // Its own thread, derived from the file so that re-rejecting the same
        // name lands in the same one. Claiming the original's conversation is
        // not an option — it is inside the part of the file we could not read.
        conversation: `rejected-${name.replace(/\.json$/, '')}`.slice(0, 64),
        in_reply_to: null,
        // `agent.hermes` is reserved and no hire can take it, so the notice
        // cannot be forged and is never attributed to someone who did not
        // write it (`src/shared/reserved.ts`).
        from: HERMES_SENDER,
        to: author,
        act: 'refuse',
        subject: this.render('rejected-subject.md', vars).trim().slice(0, 200),
        body: this.render('rejected-body.md', vars).trim(),
        hops: 0,
        created_at: new Date().toISOString()
      })
      this.deliverFromHarness(notice)
      return notice
    } catch (err) {
      this.agora.appendLog({
        kind: 'error',
        subsystem: 'hermes',
        file: parked,
        reason: `could not tell "${author}" the message was refused: ${
          err instanceof Error ? err.message : String(err)
        }`
      })
      return null
    }
  }

  /** The outbox is router-drained (SDD §2); the message now lives in the inbox. */
  private drainOutbox(file: string): void {
    fs.rmSync(file, { force: true })
  }

  // ── the autonomy loop (ADR-0013) ───────────────────────────────────────────

  /** Continuations this session has had; resets when the agent respawns. */
  blockCount(agentId: string): number {
    return this.blocks.get(agentId) ?? 0
  }

  /** A respawned agent starts its block budget over. */
  resetSession(agentId: string): void {
    this.blocks.delete(agentId)
    this.nudged.delete(agentId)
  }

  /**
   * Decides what to tell an engine whose turn just ended (ADR-0013 steps 2-4).
   *
   * Contract: returns the engine-facing reply, or null to let the turn end
   * normally. Every outcome is logged — a loop that continues silently is
   * exactly the pathology R2 warns about, and the log is where the breaker and
   * the next briefing will read it.
   */
  async decideOnStop(agentId: string, payload: unknown): Promise<StopReply | null> {
    const stopHookActive =
      typeof payload === 'object' &&
      payload !== null &&
      (payload as Record<string, unknown>)['stop_hook_active'] === true

    const context: StopContext = {
      stopHookActive,
      blocksThisSession: this.blockCount(agentId),
      pendingMail: this.pendingMailCount(agentId),
      pendingTasks: this.options.pendingTasksFor?.(agentId) ?? 0,
      ...(this.options.blockCap === undefined ? {} : { blockCap: this.options.blockCap })
    }

    const decision = decideStop(context)
    this.logStop(agentId, context, decision)

    if (decision.kind === 'continue') return null

    // ADR-0023: the pace gate on the other wake path. A Stop-hook block IS a
    // wake — it hands the session new input and buys a whole new turn — and the
    // measurement says these are 39% of the day's spend at a mean 561k tokens
    // for about a kilobyte of new information.
    //
    // Deferring returns null, which lets the turn END. That is the point: the
    // agent goes idle with its mail still pending, and `wakeCheck` picks it up
    // once the gap has passed. Nothing is dropped and nothing is consumed —
    // the work is simply done in one later wake instead of one immediate one.
    if (!this.wakeAllowed(agentId, decision.pendingMail)) return null

    const blocks = this.blockCount(agentId) + 1
    this.blocks.set(agentId, blocks)
    this.noteWoken(agentId)
    if (isPathological(blocks)) this.options.onPathology?.(agentId, blocks)

    // Hand-over consumption (ADR-0003, Architect verdict at the M2 close-out
    // audit): the mail is consumed — moved to `inbox/.done/` — in the same act
    // that hands its content to the session. Without this, handled mail stayed
    // "pending" and re-blocked every Stop until the cap: the loop manufactured
    // the very pathology its guards exist to prevent.
    const handed = decision.pendingMail > 0 ? await this.consumeInbox(agentId) : []

    return {
      decision: 'block',
      reason: this.render('stop-block-reason.md', {
        messages: formatHandover(handed),
        pendingMail: String(decision.pendingMail),
        pendingTasks: String(decision.pendingTasks)
      })
    }
  }

  private logStop(agentId: string, context: StopContext, decision: StopDecision): void {
    this.agora.appendLog({
      kind: 'hook',
      event: 'stop',
      agentId,
      decision: decision.kind,
      because: decision.kind === 'continue' ? decision.because : 'pending-work',
      pendingMail: context.pendingMail,
      pendingTasks: context.pendingTasks,
      blocksThisSession: context.blocksThisSession,
      stopHookActive: context.stopHookActive
    })
  }

  /**
   * The inbox wake watchdog (ADR-0013, FR-3.5). Mail that lands while an agent
   * is already idle produces no Stop event, so nothing would ever wake it. This
   * nudges exactly once per pending episode: a second call while the same mail
   * sits unread does nothing, and an agent that is not idle is left alone
   * (suppressing the stale nudge ADR-0013 names).
   */
  async wakeCheck(): Promise<readonly string[]> {
    // No nudge sink means nobody to hand the mail to — consuming it here would
    // archive messages no session ever saw. Leave the inbox alone.
    if (!this.options.nudge) return []
    const woken: string[] = []
    for (const agentId of this.knownAgents()) {
      const pendingFiles = this.pendingMailFiles(agentId)
      const pending = pendingFiles.length
      if (pending === 0) {
        this.nudged.delete(agentId)
        continue
      }
      // New mail is mail this agent has not been nudged for. Everything it was
      // already told about stays silent, however long it sits unread.
      const told = this.nudged.get(agentId) ?? new Set<string>()
      const unannounced = pendingFiles.filter((name) => !told.has(name))
      if (unannounced.length === 0) continue
      if (this.options.isIdle && !this.options.isIdle(agentId)) continue
      // ADR-0023. Checked AFTER the "is there new mail" and "is it idle" tests
      // and BEFORE `nudged` is updated, so a deferred wake is not recorded as
      // announced: the same mail must still earn its nudge once the pace
      // allows one, or pacing would silently turn into dropping.
      if (!this.wakeAllowed(agentId, pending)) continue

      this.nudged.set(agentId, new Set(pendingFiles))
      this.noteWoken(agentId)
      // Hand-over consumption: the nudge carries the mail itself, archived to
      // `inbox/.done/` in the same act (see decideOnStop).
      const handed = await this.consumeInbox(agentId)
      this.options.nudge?.(
        agentId,
        this.render('wake-nudge.md', {
          messages: formatHandover(handed),
          pendingMail: String(pending)
        })
      )
      this.agora.appendLog({ kind: 'hook', event: 'wake', agentId, pendingMail: pending })
      woken.push(agentId)
    }
    return woken
  }

  /**
   * The Architect's own queue at `agora/human/` (FR-3.7): `to:"human"` mail
   * before Artemis exists, plus hop-cap diversions.
   *
   * It accumulated with no reader from M2 until the approvals surface landed —
   * mail addressed to the human that the human could not see. Contract: never
   * throws, and skips a file it cannot parse rather than failing the whole
   * queue; one bad message must not hide the rest.
   */
  humanQueue(): readonly Message[] {
    const inbox = path.join(this.mailboxDir(HUMAN_QUEUE), 'inbox')
    if (!fs.existsSync(inbox)) return []
    const messages: Message[] = []
    for (const name of fs.readdirSync(inbox).sort()) {
      if (!name.endsWith('.json')) continue
      try {
        const parsed = parseMessage(JSON.parse(fs.readFileSync(path.join(inbox, name), 'utf8')))
        if (parsed.ok) messages.push(parsed.message)
      } catch {
        // Unreadable file: the sweep already parked and reported malformed
        // mail; a reader's job is to read what is there.
      }
    }
    return messages
  }

  /**
   * Holds or resumes deliveries to one agent — breaker rung 2 (ADR-0011).
   * Held mail stays in its sender's outbox and arrives when the pause lifts;
   * constraining an agent is not the same as losing its mail.
   */
  setPaused(agentId: string, paused: boolean): void {
    if (paused) this.paused.add(agentId)
    else this.paused.delete(agentId)
  }

  /**
   * Archives one message from the Architect's own queue (`agora/human/`).
   *
   * The same act `consumeInbox` performs for an agent — atomic rename into
   * `inbox/.done/`, so the message is kept as evidence and a redelivery of the
   * same id is a no-op (ADR-0003). Without it the Architect's queue could only
   * ever grow: the M2 carried item was that the mail was *invisible*, and a
   * queue you can read but never clear is only half of that.
   *
   * Contract: returns false when the message is not there — a second click on
   * a stale render is not an error.
   */
  dismissFromHumanQueue(messageId: string): boolean {
    const inbox = path.join(this.mailboxDir(HUMAN_QUEUE), 'inbox')
    const file = path.join(inbox, `${messageId}.json`)
    if (!fs.existsSync(file)) return false
    const done = path.join(inbox, DONE_DIR)
    fs.mkdirSync(done, { recursive: true })
    fs.renameSync(file, path.join(done, `${messageId}.json`))
    this.agora.appendLog({
      kind: 'delivery',
      to: HUMAN_QUEUE,
      msgId: messageId,
      event: 'dismissed'
    })
    return true
  }

  /** True while the breaker is holding this agent's deliveries. */
  isPaused(agentId: string): boolean {
    return this.paused.has(agentId)
  }

  /** Unread messages waiting for an agent. */
  pendingMailCount(agentId: string): number {
    return this.pendingMailFiles(agentId).length
  }

  /**
   * The message files waiting in an agent's inbox, sorted.
   *
   * Names rather than a count, because the wake watchdog has to tell new mail
   * from old: a count alone cannot, since consuming one message and receiving
   * another leaves it unchanged.
   */
  pendingMailFiles(agentId: string): readonly string[] {
    const inbox = path.join(this.mailboxDir(agentId), 'inbox')
    if (!fs.existsSync(inbox)) return []
    return fs
      .readdirSync(inbox)
      .filter((name) => name.endsWith('.json'))
      .sort()
  }

  /**
   * Renders a prompt surface. When no prompt store is wired (tests only, never
   * the app) the fallback is a mechanical serialization of the variables —
   * deliberately not prose, so invariant §8 has no second home for words.
   */
  private render(template: string, vars: Record<string, string>): string {
    if (!this.options.prompts) {
      return `${template} ${JSON.stringify(vars)}`
    }
    return this.options.prompts.render(path.join('hermes', template), vars)
  }

  // ── inbox consumption (ADR-0003 idempotency) ───────────────────────────────

  cursorPath(agentId: string): string {
    return path.join(this.mailboxDir(agentId), 'cursor.json')
  }

  readCursor(agentId: string): Cursor {
    const file = this.cursorPath(agentId)
    if (!fs.existsSync(file)) return emptyCursor
    try {
      return parseCursor(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch {
      return emptyCursor
    }
  }

  /** True when the agent has mail it has not consumed. Drives the wake watchdog. */
  hasPendingMail(agentId: string): boolean {
    const inbox = path.join(this.mailboxDir(agentId), 'inbox')
    if (!fs.existsSync(inbox)) return false
    return fs.readdirSync(inbox).some((name) => name.endsWith('.json'))
  }

  /**
   * Consumes an agent's inbox. Contract: idempotent. A message already in
   * `.done/` is never returned twice, however often this is called and whatever
   * the cursor says — which is what makes replay after a crash safe.
   */
  async consumeInbox(agentId: string): Promise<readonly Message[]> {
    await this.options.faults?.('before-consume')
    const inbox = path.join(this.mailboxDir(agentId), 'inbox')
    if (!fs.existsSync(inbox)) return []

    const done = path.join(inbox, DONE_DIR)
    fs.mkdirSync(done, { recursive: true })

    const consumed: Message[] = []
    for (const name of fs.readdirSync(inbox).sort()) {
      if (!name.endsWith('.json')) continue
      const file = path.join(inbox, name)
      if (fs.existsSync(path.join(done, name))) {
        // Already consumed: a redelivery of the same id is a no-op (ADR-0003).
        fs.rmSync(file, { force: true })
        continue
      }
      try {
        const parsed = parseMessage(JSON.parse(fs.readFileSync(file, 'utf8')))
        if (!parsed.ok) {
          // An inbox names the RECIPIENT, and `from` is the field that just
          // failed to validate — there is nobody here who can be named without
          // guessing, so this one really does end at the log entry.
          this.reject(file, `inbox: ${parsed.reason}`, null)
          continue
        }
        fs.renameSync(file, path.join(done, name))
        consumed.push(parsed.message)
      } catch (err) {
        this.reject(file, `inbox: ${err instanceof Error ? err.message : 'unreadable'}`, null)
      }
    }

    if (consumed.length > 0) {
      const highest =
        consumed
          .map((m) => m.id)
          .sort()
          .at(-1) ?? null
      const previous = this.readCursor(agentId).lastProcessed
      const lastProcessed = previous && previous > (highest ?? '') ? previous : highest
      writeFileAtomic(
        this.cursorPath(agentId),
        `${JSON.stringify({ schemaVersion: 1, lastProcessed }, null, 2)}\n`
      )
      this.agora.commitSoon(`hermes: ${agentId} consumed ${consumed.length} message(s)`)
    }

    await this.options.faults?.('after-consume')
    return consumed
  }
}

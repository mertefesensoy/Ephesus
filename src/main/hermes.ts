import fs from 'node:fs'
import path from 'node:path'
import { emptyCursor, parseCursor, type Cursor } from '../shared/cursor'
import { composeMessage, makeMessageId, parseMessage, type Message } from '../shared/message'
import { HUMAN_QUEUE, routeMessage, replyHops, type RoutingContext } from '../shared/routing'
import { decideStop, isPathological, type StopContext, type StopDecision } from '../shared/autonomy'
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

export interface DeliveryRecord {
  readonly message: Message
  /** Absolute path the message now lives at. */
  readonly deliveredTo: string
}

export interface RejectionRecord {
  readonly file: string
  readonly reason: string
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
  /** Notified for each rejected file — a visible state, never a silent drop. */
  onRejected?(record: RejectionRecord): void
  /**
   * Supplies the roster the routing rules read. Injected rather than read from
   * the registry directly so the rules stay testable, and so M3 can swap in the
   * live roster without touching delivery.
   */
  context?(): RoutingContext
  /** Notified for each bounce, for the sender-facing notification (FR-3.4). */
  onBounced?(record: BounceRecord): void
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
  /** Raised when a session's block count looks pathological (ADR-0011, M3). */
  onPathology?(agentId: string, blocks: number): void
  /**
   * Raised when a sweep the *watcher* started failed. Callers who await `sweep()`
   * get the rejection; nobody awaits the watcher's, so without this the error
   * would be an `unhandledRejection` and take the main process down.
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

export class Hermes {
  private readonly watchers = new Map<string, fs.FSWatcher>()
  private readonly debounces = new Map<string, NodeJS.Timeout>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private sweeping: Promise<SweepReport> = Promise.resolve({ delivered: [], rejected: [] })
  /** Stop-hook continuations per session, for guard 2 (ADR-0013). */
  private readonly blocks = new Map<string, number>()
  /** Agents already nudged for their current pending mail — "exactly once". */
  private readonly nudged = new Set<string>()

  constructor(private readonly options: HermesOptions) {}

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
   * Sends a `refuse` back to the sender and records the bounce (FR-3.4:
   * "never drop silently"). The refusal is delivered straight into the sender's
   * inbox rather than through its own outbox — the sender did not write it, and
   * an outbox carries only its owner's mail.
   */
  private bounce(original: Message, reason: string): void {
    const refusal = composeMessage({
      id: makeMessageId(new Date(), `bnc${Math.random().toString(36).slice(2, 8)}`),
      conversation: original.conversation,
      in_reply_to: original.id,
      from: original.from,
      to: original.from,
      act: 'refuse',
      subject: `undeliverable: ${original.subject}`.slice(0, 200),
      body: `Your message ${original.id} to "${original.to}" could not be delivered: ${reason}`,
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
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS)
    this.sweepTimer.unref?.()
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
      this.sweep().catch((err: unknown) => this.options.onSweepError?.(err))
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
      return this.reject(
        file,
        `not valid JSON: ${err instanceof Error ? err.message : 'unreadable'}`
      )
    }

    const parsed = parseMessage(raw)
    if (!parsed.ok) return this.reject(file, parsed.reason)

    // Single-writer-per-file (ADR-0003): a file in agent A's outbox claiming to
    // be from agent B is a forgery, whatever wrote it.
    if (parsed.message.from !== ownerId) {
      return this.reject(
        file,
        `from "${parsed.message.from}" does not own this outbox ("${ownerId}")`
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

    const message = parsed.message
    const recipients = route.kind === 'divert' ? [route.to] : route.to
    if (route.kind === 'divert') {
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

    for (const recipient of recipients) {
      await this.options.faults?.('before-deliver')
      const target = path.join(this.mailboxDir(recipient), 'inbox', `${message.id}.json`)
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
      this.options.onDelivered?.(record)
    }

    await this.options.faults?.('before-drain-outbox')
    this.drainOutbox(file)
    return { kind: 'delivered', records }
  }

  private reject(file: string, reason: string): { kind: 'rejected'; record: RejectionRecord } {
    // Parked, not deleted: the Architect can read what an agent got wrong, and
    // it will not be re-processed forever (FR-3.4's spirit — never drop silently).
    const parked = path.join(path.dirname(file), REJECTED_DIR, path.basename(file))
    fs.mkdirSync(path.dirname(parked), { recursive: true })
    try {
      fs.renameSync(file, parked)
    } catch {
      fs.rmSync(file, { force: true })
    }
    const record: RejectionRecord = { file: parked, reason }
    this.agora.appendLog({ kind: 'error', subsystem: 'hermes', file: parked, reason })
    this.options.onRejected?.(record)
    return { kind: 'rejected', record }
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
  decideOnStop(agentId: string, payload: unknown): StopReply | null {
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

    const blocks = this.blockCount(agentId) + 1
    this.blocks.set(agentId, blocks)
    if (isPathological(blocks)) this.options.onPathology?.(agentId, blocks)

    return {
      decision: 'block',
      reason: this.render('stop-block-reason.md', {
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
  wakeCheck(): readonly string[] {
    const woken: string[] = []
    for (const agentId of this.knownAgents()) {
      const pending = this.pendingMailCount(agentId)
      if (pending === 0) {
        this.nudged.delete(agentId)
        continue
      }
      if (this.nudged.has(agentId)) continue
      if (this.options.isIdle && !this.options.isIdle(agentId)) continue

      this.nudged.add(agentId)
      this.options.nudge?.(agentId, this.render('wake-nudge.md', { pendingMail: String(pending) }))
      this.agora.appendLog({ kind: 'hook', event: 'wake', agentId, pendingMail: pending })
      woken.push(agentId)
    }
    return woken
  }

  /** Unread messages waiting for an agent. */
  pendingMailCount(agentId: string): number {
    const inbox = path.join(this.mailboxDir(agentId), 'inbox')
    if (!fs.existsSync(inbox)) return 0
    return fs.readdirSync(inbox).filter((name) => name.endsWith('.json')).length
  }

  /**
   * Renders a prompt surface. Falls back to a bare factual line only when no
   * prompt store is wired (tests), never in the app — invariant §8 keeps
   * LLM-facing prose in `prompts/`.
   */
  private render(template: string, vars: Record<string, string>): string {
    if (!this.options.prompts) {
      return `pending mail: ${vars['pendingMail'] ?? '0'}, pending tasks: ${vars['pendingTasks'] ?? '0'}`
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
          this.reject(file, `inbox: ${parsed.reason}`)
          continue
        }
        fs.renameSync(file, path.join(done, name))
        consumed.push(parsed.message)
      } catch (err) {
        this.reject(file, `inbox: ${err instanceof Error ? err.message : 'unreadable'}`)
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

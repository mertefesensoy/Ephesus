import fs from 'node:fs'
import path from 'node:path'
import { emptyCursor, parseCursor, type Cursor } from '../shared/cursor'
import { parseMessage, type Message } from '../shared/message'
import type { Agora } from './agora'
import { writeFileAtomic } from './fsx'

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
   * Decides what happens to a validated message before it is delivered. M2.4
   * installs the routing rules (hop caps, bounce, broadcast) here; with no
   * router installed every message is delivered as addressed.
   */
  route?(message: Message): RoutingDecision | Promise<RoutingDecision>
}

export type RoutingDecision =
  | { readonly kind: 'deliver'; readonly to: readonly string[]; readonly message?: Message }
  | { readonly kind: 'drop'; readonly reason: string }

/** Where a rejected file is parked: out of the outbox, still on disk, inspectable. */
export const REJECTED_DIR = '.rejected'
export const DONE_DIR = '.done'

export class Hermes {
  private readonly watchers = new Map<string, fs.FSWatcher>()
  private readonly debounces = new Map<string, NodeJS.Timeout>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private sweeping: Promise<SweepReport> = Promise.resolve({ delivered: [], rejected: [] })

  constructor(private readonly options: HermesOptions) {}

  private get agora(): Agora {
    return this.options.agora
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
      void this.sweep()
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
      void this.agora.commit(`hermes: deliver ${delivered.length}, reject ${rejected.length}`)
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

    const decision = (await this.options.route?.(parsed.message)) ?? {
      kind: 'deliver' as const,
      to: [parsed.message.to]
    }

    if (decision.kind === 'drop') {
      this.drainOutbox(file)
      this.agora.appendLog({
        kind: 'bounce',
        msgId: parsed.message.id,
        from: parsed.message.from,
        to: parsed.message.to,
        conversation: parsed.message.conversation,
        reason: decision.reason
      })
      return { kind: 'skipped' }
    }

    const message = decision.message ?? parsed.message
    const records: DeliveryRecord[] = []

    for (const recipient of decision.to) {
      await this.options.faults?.('before-deliver')
      const target = path.join(this.agora.agentDir(recipient), 'inbox', `${message.id}.json`)
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

  // ── inbox consumption (ADR-0003 idempotency) ───────────────────────────────

  cursorPath(agentId: string): string {
    return path.join(this.agora.agentDir(agentId), 'cursor.json')
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
    const inbox = path.join(this.agora.agentDir(agentId), 'inbox')
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
    const inbox = path.join(this.agora.agentDir(agentId), 'inbox')
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
      void this.agora.commit(`hermes: ${agentId} consumed ${consumed.length} message(s)`)
    }

    await this.options.faults?.('after-consume')
    return consumed
  }
}

import fs from 'node:fs'
import path from 'node:path'
import { emptyRegistry, parseRegistry, type Registry } from '../shared/registry'
import { emptyLedger, parseTaskLedger, type TaskLedger } from '../shared/tasks'
import type { LogEntry, LogEntryDraft } from '../shared/log'
import { EventLog } from './eventlog'
import { writeFileAtomic } from './fsx'
import { ExecGitRunner, type GitRunner } from './git'
import type { PromptStore } from './prompts'

/**
 * The Agora (ADR-0004, SDD §2): one local git repository under the harness
 * home, committed by exactly one writer — this module, in the main process.
 *
 * Three things make that claim real rather than aspirational:
 *
 *  1. **One queue.** Every commit goes through `commit()`, which serialises on a
 *     single promise chain. Two callers can never have git running at once, so
 *     `.git/index.lock` contention cannot be self-inflicted.
 *  2. **Batching.** Work enqueued while a commit is in flight coalesces into the
 *     next one. ADR-0004 wants commit throughput off the critical path of
 *     delivery latency: delivery is a rename, durability is a commit.
 *  3. **Reconcile on start.** A harness killed mid-write leaves files on disk
 *     and possibly a stale lock. Startup cleans the lock and commits whatever
 *     was in flight, which is what SRS §6.6's blackout test asserts.
 *
 * Retries live *here and nowhere else* (BUILD-PROMPT §7: "don't write retry
 * loops around git; the single committer queue owns retries").
 */

/**
 * Points at which a test may inject a failure. These exist in the production
 * code path on purpose: S-BLACKOUT has to kill the harness *between* staging
 * and committing, and a seam that only exists under a mock proves nothing about
 * the real ordering (TEST-STRATEGY §3).
 */
export type FaultPoint =
  'before-stage' | 'after-stage' | 'before-commit' | 'after-commit' | 'before-reconcile'

/** Contract: throw to simulate a crash at that point. Never called in production. */
export type FaultInjector = (point: FaultPoint) => void | Promise<void>

export interface AgoraOptions {
  /** `<harness home>/agora`. */
  readonly root: string
  readonly prompts: PromptStore
  readonly git?: GitRunner
  readonly faults?: FaultInjector
  /** Retry budget for a failing git command. */
  readonly maxAttempts?: number
  /** First backoff step; doubles per attempt. */
  readonly backoffMs?: number
  /** Called for every commit the queue lands, for the event log (M2.2). */
  onCommit?(result: CommitOutcome): void
  /**
   * Called when a *queued* commit finally gave up. Contract: this must not
   * append to the log or queue more work — the failing path is git itself, and
   * a handler that commits would recurse. Report it and move on.
   */
  onCommitError?(failure: CommitFailure): void
}

/**
 * A fire-and-forget commit that failed after every retry. Recorded rather than
 * thrown: losing durability is a degradation the Architect must see, not a
 * reason to take the harness down (invariant §7).
 */
export interface CommitFailure {
  readonly subject: string
  readonly reason: string
}

export interface CommitOutcome {
  /** Subjects batched into this commit, in enqueue order. */
  readonly subjects: readonly string[]
  /** Commit sha, or null when there was nothing to commit. */
  readonly sha: string | null
  readonly attempts: number
}

interface Pending {
  readonly subject: string
  resolve(outcome: CommitOutcome): void
  reject(err: unknown): void
}

/** The agent-facing contract file, seeded from `prompts/` (SDD §2). */
export const PROTOCOL_REL = 'PROTOCOL.md'
export const REGISTRY_REL = 'registry.json'
export const TASKS_REL = 'tasks.json'
export const LOG_REL = 'log.jsonl'

/** How many give-up failures to keep for the UI before dropping the oldest. */
const MAX_RECORDED_FAILURES = 50

/**
 * A schema'd Agora file that failed to parse. Surfaced, never repaired: the
 * file is left exactly as found and the company runs on the empty default with
 * this warning visible (invariant §7).
 */
export interface AgoraWarning {
  readonly file: string
  readonly reason: string
}

export class Agora {
  private readonly git: GitRunner
  private readonly maxAttempts: number
  private readonly backoffMs: number
  private chain: Promise<unknown> = Promise.resolve()
  private pending: Pending[] = []
  private readonly log: EventLog
  private readonly warnings: AgoraWarning[] = []
  private readonly failures: CommitFailure[] = []
  /** Schema files whose last read failed — protected from overwrite. */
  private readonly corrupt = new Set<string>()

  constructor(private readonly options: AgoraOptions) {
    this.git = options.git ?? new ExecGitRunner()
    this.maxAttempts = options.maxAttempts ?? 5
    this.backoffMs = options.backoffMs ?? 25
    this.log = new EventLog(this.pathOf(LOG_REL))
  }

  /** Files that failed to parse this run — a visible state, not a silent default. */
  fileWarnings(): readonly AgoraWarning[] {
    return this.warnings
  }

  /**
   * Appends one event to the book of record (SDD §4.3). Contract: the entry is
   * on disk when this returns; the *commit* that makes it durable in git is
   * queued separately, because delivery latency must not wait on git (ADR-0004).
   */
  appendLog(draft: LogEntryDraft): LogEntry {
    return this.log.append(draft)
  }

  /** Events after `afterSeq` (SDD §5 `agora.log(afterSeq, limit)`). */
  readLog(afterSeq = 0, limit = 500): readonly LogEntry[] {
    return this.log.read(afterSeq, limit)
  }

  /** The roster (SDD §4.1). A corrupt file yields the empty roster + a warning. */
  registry(): Registry {
    return this.readSchemaFile(REGISTRY_REL, emptyRegistry, (raw) => {
      const parsed = parseRegistry(raw)
      return parsed.ok ? { ok: true, value: parsed.registry } : { ok: false, reason: parsed.reason }
    })
  }

  /** The task ledger (SDD §4.2). Same degradation as the roster. */
  tasks(): TaskLedger {
    return this.readSchemaFile(TASKS_REL, emptyLedger, (raw) => {
      const parsed = parseTaskLedger(raw)
      return parsed.ok ? { ok: true, value: parsed.ledger } : { ok: false, reason: parsed.reason }
    })
  }

  /** Writes the roster atomically — agents read it live (invariant §3). */
  writeRegistry(registry: Registry): void {
    this.refuseWriteOverCorrupt(REGISTRY_REL)
    writeFileAtomic(this.pathOf(REGISTRY_REL), `${JSON.stringify(registry, null, 2)}\n`)
  }

  writeTasks(ledger: TaskLedger): void {
    this.refuseWriteOverCorrupt(TASKS_REL)
    writeFileAtomic(this.pathOf(TASKS_REL), `${JSON.stringify(ledger, null, 2)}\n`)
  }

  /**
   * A schema file that failed to parse is evidence, and the promise attached to
   * that degradation (DECISIONS-LOG, M2.2) is that the file is never rewritten.
   * Without this guard the first roster write after corruption would atomically
   * replace the corrupt file with the empty default — destroying the evidence.
   */
  private refuseWriteOverCorrupt(rel: string): void {
    if (this.corrupt.has(rel)) {
      throw new Error(
        `agora: refusing to overwrite ${rel} — it failed to parse this run and is kept as evidence; repair or remove it, then restart`
      )
    }
  }

  private readSchemaFile<T>(
    rel: string,
    fallback: T,
    parse: (raw: unknown) => { ok: true; value: T } | { ok: false; reason: string }
  ): T {
    const file = this.pathOf(rel)
    if (!fs.existsSync(file)) {
      this.corrupt.delete(rel)
      return fallback
    }
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
      this.corrupt.add(rel)
      this.warn(rel, firstLine(err))
      return fallback
    }
    const parsed = parse(raw)
    if (parsed.ok) {
      this.corrupt.delete(rel)
      return parsed.value
    }
    this.corrupt.add(rel)
    this.warn(rel, parsed.reason)
    return fallback
  }

  private warn(file: string, reason: string): void {
    if (!this.warnings.some((w) => w.file === file && w.reason === reason)) {
      this.warnings.push({ file, reason })
    }
  }

  get root(): string {
    return this.options.root
  }

  /** Absolute path inside the Agora, for callers that write plain files. */
  pathOf(...parts: readonly string[]): string {
    return path.join(this.options.root, ...parts)
  }

  /** Per-agent home (SDD §2): `agora/agents/<id>/`. */
  agentDir(agentId: string): string {
    return this.pathOf('agents', agentId)
  }

  /**
   * Creates the repository if absent and seeds `PROTOCOL.md`. Idempotent: safe
   * on every boot, which is how it doubles as the repair path for a home whose
   * `.git` was deleted.
   */
  async ensureRepo(): Promise<void> {
    fs.mkdirSync(this.options.root, { recursive: true })

    let seeded = false
    if (!fs.existsSync(path.join(this.options.root, '.git'))) {
      const init = await this.git.run(this.options.root, ['init', '-b', 'main'])
      if (!init.ok) throw new Error(`agora: git init failed — ${init.stderr.trim()}`)
      seeded = true
    }

    const protocolPath = this.pathOf(PROTOCOL_REL)
    if (!fs.existsSync(protocolPath)) {
      // Atomic like every other live shared file (invariant §3): agents read
      // PROTOCOL.md, so a half-written seed must never be visible.
      writeFileAtomic(protocolPath, this.options.prompts.read(path.join('agora', 'PROTOCOL.md')))
      seeded = true
    }

    if (!fs.existsSync(this.pathOf(REGISTRY_REL))) {
      this.writeRegistry(emptyRegistry)
      seeded = true
    }
    if (!fs.existsSync(this.pathOf(TASKS_REL))) {
      this.writeTasks(emptyLedger)
      seeded = true
    }
    this.log.open()

    // Commit ONLY when this call actually seeded something. Committing
    // unconditionally would sweep up whatever a crashed run left behind and
    // label it "seed the Agora" — the work would survive, but the history would
    // misname why it landed, and ADR-0004 leans on that history for forensics.
    if (seeded) await this.commit('seed the Agora')
  }

  /**
   * Startup reconcile (ADR-0004, SRS §6.6). Removes a lock no live process can
   * own — this runs before anything else may commit — and commits whatever a
   * killed harness left uncommitted, so no work is silently lost.
   */
  async reconcile(): Promise<CommitOutcome> {
    await this.options.faults?.('before-reconcile')
    this.clearStaleLock()
    return this.commit('reconcile uncommitted work after restart')
  }

  /** True when the working tree has changes the committer would pick up. */
  async isDirty(): Promise<boolean> {
    const status = await this.git.run(this.options.root, ['status', '--porcelain'])
    return status.ok && status.stdout.trim().length > 0
  }

  /** Commit sha of HEAD, or null in a repo with no commits yet. */
  async head(): Promise<string | null> {
    const result = await this.git.run(this.options.root, ['rev-parse', 'HEAD'])
    return result.ok ? result.stdout.trim() : null
  }

  /**
   * Queues a commit. Contract: resolves once this subject has been committed
   * (or once the queue confirms there was nothing to commit). Concurrent calls
   * batch into one commit, and the outcome names every subject in the batch —
   * a caller can always see what it actually landed with.
   */
  commit(subject: string): Promise<CommitOutcome> {
    return new Promise<CommitOutcome>((resolve, reject) => {
      this.pending.push({ subject, resolve, reject })
      this.chain = this.chain.then(
        () => this.drain(),
        () => this.drain()
      )
    })
  }

  /**
   * Queues a commit nobody is going to await. Use this, never `void commit(...)`:
   * an unawaited rejected promise is an `unhandledRejection`, which takes the
   * whole main process down — so a git failure, the one thing ADR-0004's retry
   * queue exists to absorb, would kill the harness instead of degrading it.
   * Here the failure is recorded and reported, and the company keeps running on
   * files that are correct on disk but not yet durable in history.
   */
  commitSoon(subject: string): void {
    this.commit(subject).catch((err: unknown) => {
      const failure: CommitFailure = {
        subject,
        reason: err instanceof Error ? err.message : String(err)
      }
      // Bounded: a harness that has been failing to commit for hours must not
      // also leak memory. The oldest failure is the least interesting one.
      this.failures.push(failure)
      if (this.failures.length > MAX_RECORDED_FAILURES) this.failures.shift()
      this.options.onCommitError?.(failure)
    })
  }

  /** Queued commits that gave up this run — a visible state, like `fileWarnings`. */
  commitFailures(): readonly CommitFailure[] {
    return this.failures
  }

  /** Resolves when the queue is idle — for shutdown and for tests. */
  async drained(): Promise<void> {
    await this.chain
  }

  /**
   * A lock can only be stale here: this module is the only git caller and it
   * serialises, so nothing of ours holds one. Removing it is the documented
   * recovery from a killed harness (ADR-0004 "stale-lock cleanup").
   */
  private clearStaleLock(): void {
    const lock = path.join(this.options.root, '.git', 'index.lock')
    if (!fs.existsSync(lock)) return
    try {
      // A git child of the process we just replaced can still hold this open for
      // a moment (Windows keeps the handle until it actually exits), so retry
      // briefly rather than throwing a boot away over it. If it is still held
      // after that, the commit retry loop will come back to it — failing to
      // clear a lock is a delay, not a lost commit.
      fs.rmSync(lock, { force: true, maxRetries: 10, retryDelay: 50 })
    } catch {
      // Left for the next attempt, deliberately.
    }
  }

  private async drain(): Promise<void> {
    const batch = this.pending
    if (batch.length === 0) return
    this.pending = []

    try {
      const outcome = await this.runCommit(batch.map((entry) => entry.subject))
      this.options.onCommit?.(outcome)
      for (const entry of batch) entry.resolve(outcome)
    } catch (err) {
      for (const entry of batch) entry.reject(err)
    }
  }

  private async runCommit(subjects: readonly string[]): Promise<CommitOutcome> {
    const message = commitMessage(subjects)
    let lastError = 'unknown'

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (attempt > 1) {
        // Backoff first, then clear a lock that outlived its holder. Retrying is
        // the queue's job alone (BUILD-PROMPT §7).
        await delay(this.backoffMs * 2 ** (attempt - 2))
        this.clearStaleLock()
      }

      await this.options.faults?.('before-stage')
      const staged = await this.git.run(this.options.root, ['add', '-A'])
      if (!staged.ok) {
        lastError = staged.stderr.trim()
        continue
      }
      await this.options.faults?.('after-stage')

      const status = await this.git.run(this.options.root, ['status', '--porcelain'])
      if (status.ok && status.stdout.trim().length === 0) {
        return { subjects, sha: await this.head(), attempts: attempt }
      }

      await this.options.faults?.('before-commit')
      const committed = await this.git.run(this.options.root, ['commit', '-m', message])
      if (!committed.ok) {
        lastError = committed.stderr.trim()
        continue
      }
      await this.options.faults?.('after-commit')

      return { subjects, sha: await this.head(), attempts: attempt }
    }

    throw new Error(
      `agora: commit failed after ${this.maxAttempts} attempts (subjects: ${subjects.join('; ')}) — ${lastError}`
    )
  }
}

/**
 * One subject line plus the batch as a body. The history has to stay readable
 * to a human doing forensics (ADR-0004: "the briefing compiler, the memo
 * archive, and incident forensics all read one history").
 */
export function commitMessage(subjects: readonly string[]): string {
  const first = subjects[0] ?? 'agora update'
  if (subjects.length === 1) return first
  return `${first} (+${subjects.length - 1} more)\n\n${subjects.map((s) => `- ${s}`).join('\n')}`
}

/** First line of an error, for a warning a human will read in a status strip. */
function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.split('\n')[0] ?? 'unreadable'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.()
  })
}

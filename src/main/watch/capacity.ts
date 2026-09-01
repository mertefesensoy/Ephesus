import fs from 'node:fs'
import {
  capacityView,
  retryDelayMs,
  type CapacityLimit,
  type CapacityView,
  type ParkedAgent
} from '../../shared/capacity'
import type { AgentSpawnConfig, EngineAdapter } from '../engines'
import { transcriptFiles } from './budgets'

/**
 * The capacity watch: the loop that notices the provider has stopped taking
 * turns, parks the company where the Architect can see it, and brings every
 * parked agent back when capacity returns.
 *
 * ## Why this is not the budget watcher
 *
 * `budgets.ts` folds transcripts to answer "how much have we spent" — a total,
 * over whole files, against a ceiling the Architect chose. This answers "is the
 * provider still talking to us" — a *latest state*, at the tail of a file,
 * against a ceiling nobody here controls. Same files, opposite questions, and
 * the second one is the one that must not wait on the first: an agent parked
 * for an hour would be folded dozens of times for a total that has stopped
 * changing.
 *
 * So this reads only the TAIL of each transcript, which also makes it O(1) in
 * a file that reaches tens of megabytes — cheaper than the fold it sits beside,
 * on the same event loop that carries PTY bytes (SDD §11, NFR-1/NFR-2).
 *
 * ## The state machine
 *
 * ```
 *   clear ──limit record──▶ parked ──retryAt elapsed──▶ resuming
 *     ▲                       ▲                            │
 *     └───verified quiet──────┴──────new limit record───────┘
 * ```
 *
 * `parked` → `resuming` sends a continuation and nothing else; the process is
 * never killed and the agent is never ghosted. `resuming` → `clear` happens by
 * a VERIFICATION WINDOW rather than by proof of success: what the transcript
 * can actually tell us is whether the provider refused *again*, so the harness
 * claims only that. If it was wrong, the next refusal re-parks the agent one
 * rung higher — the system corrects itself rather than asserting a recovery it
 * did not witness (invariant §7).
 */

/** What the watch needs about one live agent. */
export interface CapacityAgent {
  readonly agentId: string
  readonly adapter: EngineAdapter
  readonly cfg: AgentSpawnConfig
  /**
   * Engine session ids this spawn reported. Empty means "we do not yet know
   * which transcript is ours", and — exactly as in the budget fold — that reads
   * nothing rather than reading somebody else's history.
   */
  readonly sessionIds: readonly string[]
}

export interface CapacityWatchOptions {
  /** The agents to look at, read fresh on every tick. */
  agents(): readonly CapacityAgent[]
  /**
   * Whether this agent's engine process is still there.
   *
   * The reference engine survives a refusal — it writes the record and returns
   * to its prompt — so this is normally true, and a parked agent resumes by
   * being talked to. It is asked rather than assumed because the answer decides
   * which resume path runs, and guessing it wrong means either talking to a
   * dead PTY or respawning a live agent out from under itself.
   */
  alive(agentId: string): boolean
  /** A new refusal: the company stops asking, visibly. */
  onPark(row: ParkedAgent): void
  /**
   * The wait elapsed. The wiring continues the agent — through its live session
   * when `row.processAlive`, through the engine-native resume path when not.
   */
  onResume(row: ParkedAgent): void
  /** The verification window closed with no fresh refusal. */
  onClear(row: ParkedAgent): void
  /** Visible degradations, including engines that cannot be watched at all. */
  onDegraded?(detail: string): void
  /** Epoch milliseconds; injected in tests. */
  now?(): number
  readonly intervalMs?: number
  /** How much of each transcript's tail to read. */
  readonly tailBytes?: number
  /** How long a continuation is given before the park is called cleared. */
  readonly verifyMs?: number
}

/**
 * How often the tail is re-read.
 *
 * Faster than the budget fold on purpose: spend is not a real-time quantity,
 * but a company that has silently stopped working is — every second of it is a
 * second the Architect thinks work is happening.
 */
export const DEFAULT_CAPACITY_INTERVAL_MS = 5_000

/**
 * Tail window per transcript.
 *
 * Generous by three orders of magnitude, because the thing it has to span is
 * small and bounded: once the provider refuses, the turn is OVER, and the only
 * records the engine appends behind the refusal are the handful of tiny
 * bookkeeping lines an idle session writes. 512 KiB covers that with room for
 * a transcript format that grows.
 */
export const DEFAULT_TAIL_BYTES = 512 * 1024

/** How long a continuation is given before the park is called cleared. */
export const DEFAULT_VERIFY_MS = 120_000

/** Internal per-agent state. `ParkedAgent` is the published projection of it. */
interface Park {
  limit: CapacityLimit
  since: string
  attempts: number
  /** Epoch ms the next continuation is due. */
  dueAt: number
  phase: 'parked' | 'resuming'
  /** Epoch ms the verification window closes; only meaningful while resuming. */
  verifyUntil: number
  processAlive: boolean
}

export class CapacityWatch {
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private readonly parks = new Map<string, Park>()
  /**
   * Refusal ids already acted on, per agent. The tail is re-read every tick and
   * the same record is in it every time; without this the company would re-park
   * on one refusal for as long as it stayed at the tail of the file.
   */
  private readonly handled = new Map<string, Set<string>>()
  /** Agents already reported as unwatchable, so the warning is said once. */
  private readonly warned = new Set<string>()
  private readonly now: () => number

  constructor(private readonly options: CapacityWatchOptions) {
    this.now = options.now ?? ((): number => Date.now())
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      // Guarded rather than `void this.tick()`: an unhandled rejection here
      // would take the harness down over one unreadable transcript.
      this.tick().catch((err: unknown) => {
        this.options.onDegraded?.(
          `capacity watch failed: ${err instanceof Error ? err.message : String(err)}`
        )
      })
    }, this.options.intervalMs ?? DEFAULT_CAPACITY_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Contract: what the status strip and the dock read. Never throws. */
  view(): CapacityView {
    return capacityView([...this.parks.keys()].map((agentId) => this.row(agentId)))
  }

  /** Contract: this agent's park, or null when it is not waiting on capacity. */
  parked(agentId: string): ParkedAgent | null {
    return this.parks.has(agentId) ? this.row(agentId) : null
  }

  /** True while any agent is waiting on capacity. */
  anyParked(): boolean {
    return this.parks.size > 0
  }

  /**
   * Forgets an agent entirely.
   *
   * Called when a spawn is gone for good, NOT when it merely exited — an exit
   * during a park is a parked agent whose process died, and it still has to
   * come back (`onResume` with `processAlive: false`).
   */
  forget(agentId: string): void {
    this.parks.delete(agentId)
    this.handled.delete(agentId)
    this.warned.delete(agentId)
  }

  /**
   * Contract: never throws, and never runs two ticks at once — a slow tail read
   * must not stack up behind itself.
   */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const agent of this.options.agents()) {
        try {
          await this.checkOne(agent)
        } catch (err) {
          this.options.onDegraded?.(
            `${agent.agentId}: capacity check failed: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      }
      // Due work is driven after the reads so a refusal seen this very tick
      // parks before it can also be resumed.
      this.driveDue()
    } finally {
      this.ticking = false
    }
  }

  private row(agentId: string): ParkedAgent {
    const park = this.parks.get(agentId)
    if (!park) throw new Error(`capacity: no park for "${agentId}"`)
    return {
      agentId,
      phase: park.phase,
      limit: park.limit,
      since: park.since,
      attempts: park.attempts,
      retryAt: new Date(park.dueAt).toISOString(),
      processAlive: park.processAlive
    }
  }

  private async checkOne(agent: CapacityAgent): Promise<void> {
    const reader = agent.adapter.transcripts
    const limitOf = reader?.limitOf
    if (!reader || !limitOf) {
      // A product tier, said out loud rather than left to look like coverage:
      // this agent's engine cannot tell a refusal from a finished turn, so it
      // will never be parked and never be resumed.
      if (!this.warned.has(agent.agentId)) {
        this.warned.add(agent.agentId)
        this.options.onDegraded?.(
          `${agent.agentId}: engine "${agent.adapter.id}" reports no usage-limit signal — ` +
            'this agent will not be parked or resumed when the provider refuses'
        )
      }
      return
    }
    const dir = reader.transcriptDir(agent.cfg)
    let latest: CapacityLimit | null = null
    for (const file of await transcriptFiles(dir, agent.sessionIds)) {
      const found = await this.latestLimitIn(file, limitOf)
      // Last one wins across files as it does within one: the newest refusal is
      // the one the company is actually sitting behind.
      if (found && (latest === null || found.at >= latest.at)) latest = found
    }
    if (latest === null) return
    const seen = this.handled.get(agent.agentId) ?? new Set<string>()
    if (seen.has(latest.recordId)) return
    seen.add(latest.recordId)
    this.handled.set(agent.agentId, seen)
    this.park(agent.agentId, latest)
  }

  /**
   * Parks, or RE-parks one rung higher when a continuation was refused again.
   *
   * The wait is measured from the refusal's own timestamp rather than from now.
   * That is what makes a harness restart behave correctly: an agent that was
   * refused three hours ago is already due, and is continued on this tick
   * instead of being made to serve its minute over again.
   */
  private park(agentId: string, limit: CapacityLimit): void {
    const now = this.now()
    const previous = this.parks.get(agentId)
    const attempts = previous ? previous.attempts + 1 : 0
    const stamped = Date.parse(limit.at)
    const from = Number.isFinite(stamped) ? stamped : now
    const park: Park = {
      limit,
      since: previous?.since ?? new Date(now).toISOString(),
      attempts,
      dueAt: from + retryDelayMs(attempts, limit.resetsAt, from),
      phase: 'parked',
      verifyUntil: 0,
      processAlive: this.options.alive(agentId)
    }
    this.parks.set(agentId, park)
    this.options.onPark(this.row(agentId))
  }

  /** Fires the continuations that have come due, and closes verified parks. */
  private driveDue(): void {
    const now = this.now()
    for (const [agentId, park] of [...this.parks]) {
      if (park.phase === 'parked') {
        if (now < park.dueAt) continue
        park.phase = 'resuming'
        park.verifyUntil = now + (this.options.verifyMs ?? DEFAULT_VERIFY_MS)
        // Re-asked at the moment of use: the process may have died during the
        // wait, and that changes which way the agent comes back.
        park.processAlive = this.options.alive(agentId)
        this.options.onResume(this.row(agentId))
        continue
      }
      if (now < park.verifyUntil) continue
      const row = this.row(agentId)
      this.parks.delete(agentId)
      this.options.onClear(row)
    }
  }

  /**
   * Contract: the last refusal in the tail of one transcript, or null.
   *
   * Reads the tail rather than the file because the question is about the
   * present. The first line in the window is almost always a fragment of a
   * record that started before it, and is dropped by the same rule the fold
   * uses for a torn final line: a line that will not parse yields no fact,
   * never a guessed one (ADR-0009).
   */
  private async latestLimitIn(
    filePath: string,
    limitOf: (raw: unknown) => CapacityLimit | null
  ): Promise<CapacityLimit | null> {
    const text = await readTail(filePath, this.options.tailBytes ?? DEFAULT_TAIL_BYTES)
    if (text === null) return null
    const lines = text.split('\n')
    let found: CapacityLimit | null = null
    for (const line of lines) {
      if (line.trim().length === 0) continue
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        continue
      }
      const limit = limitOf(raw)
      if (limit) found = limit
    }
    return found
  }
}

/**
 * Contract: the last `bytes` of a file as text, or null when it cannot be read.
 *
 * ENOENT is an answer, not an error: a spawn whose engine has not written its
 * transcript yet is the ordinary first few seconds of every agent's life.
 */
export async function readTail(filePath: string, bytes: number): Promise<string | null> {
  let handle: fs.promises.FileHandle | null = null
  try {
    handle = await fs.promises.open(filePath, 'r')
    const { size } = await handle.stat()
    const length = Math.min(size, Math.max(0, bytes))
    if (length === 0) return ''
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {
      /* a handle that will not close must not mask the read's own answer */
    })
  }
}

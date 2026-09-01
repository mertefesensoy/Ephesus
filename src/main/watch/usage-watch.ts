import fs from 'node:fs'
import {
  DEFAULT_PACE_THRESHOLDS,
  paceFor,
  usageReportSchema,
  type PaceThresholds,
  type PaceVerdict,
  type UsageReport
} from '../../shared/pacing'

/**
 * The Watch's usage-window reader (ADR-0023).
 *
 * `eph-usage.mjs` runs inside every live agent's status line and writes what
 * the engine reported about the account's rolling limits to `<home>/usage.json`.
 * This class is the harness's half: read that file, validate it, and turn it
 * into the company's pace.
 *
 * The split mirrors `budgets.ts`/`ledger.ts`: the decision is a pure function
 * in `shared/pacing.ts`, and this module knows only *when to look* and how to
 * say so when looking fails. It holds no pace of its own — every caller gets a
 * verdict computed from the file and the clock at the moment it asks, so a
 * stale reading can never be served as a current one.
 */

export interface UsageWatchOptions {
  /** `<harness home>/usage.json`. */
  readonly path: string
  /** Raised when the file is present but unusable (invariant §7). */
  onDegraded?(detail: string): void
  /** Raised when the pace changes — only on transitions, never per tick. */
  onPaceChange?(verdict: PaceVerdict, previous: PaceVerdict | null): void
  readonly thresholds?: PaceThresholds
  /** Milliseconds between reads. */
  readonly intervalMs?: number
  now?(): number
}

/**
 * How often `usage.json` is re-read. The window it reports moves over hours;
 * a status line rewrites the file several times a minute, so anything faster
 * than this reads the same numbers repeatedly (SDD §11).
 */
export const DEFAULT_USAGE_POLL_MS = 20_000

export class UsageWatch {
  private timer: NodeJS.Timeout | null = null
  private report: UsageReport | null = null
  private lastPace: PaceVerdict | null = null
  /** The exact bytes last parsed, so an unchanged file costs no parse. */
  private lastRaw: string | null = null
  /** Reported once per episode; a missing file must not become a metronome. */
  private degradedWith: string | null = null
  private readonly now: () => number

  constructor(private readonly options: UsageWatchOptions) {
    this.now = options.now ?? (() => Date.now())
  }

  start(): void {
    if (this.timer) return
    this.tick()
    this.timer = setInterval(() => this.tick(), this.options.intervalMs ?? DEFAULT_USAGE_POLL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Contract: never throws. An absent file is the normal state before any agent
   * has rendered a status line, and it is NOT a degradation — the harness has
   * simply not been told anything yet. A file that exists but will not parse
   * *is* one: something is writing that path and it is not our shim.
   */
  read(): void {
    let raw: string
    try {
      raw = fs.readFileSync(this.options.path, 'utf8')
    } catch {
      // Absent or unreadable. The previous reading stands until it goes stale
      // on its own clock, which `paceFor` enforces — there is no path by which
      // a vanished file silently pins the company to an old pace forever.
      return
    }
    if (raw === this.lastRaw) return
    this.lastRaw = raw

    let parsed: UsageReport
    try {
      parsed = usageReportSchema.parse(JSON.parse(raw))
    } catch (err) {
      const detail = `usage.json is not a usable report: ${
        err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err)
      }`
      if (this.degradedWith !== detail) {
        this.degradedWith = detail
        this.options.onDegraded?.(detail)
      }
      return
    }
    this.degradedWith = null
    this.report = parsed
  }

  /** The pace right now, computed fresh from the last reading and the clock. */
  verdict(): PaceVerdict {
    return paceFor({
      report: this.report,
      now: this.now(),
      thresholds: this.options.thresholds ?? DEFAULT_PACE_THRESHOLDS
    })
  }

  /** The last reading, for the UI and the log. Null before anything was read. */
  observed(): UsageReport | null {
    return this.report
  }

  /**
   * Raises `onPaceChange` when the pace or its reason moved.
   *
   * Called from `read()` AND from `tick()`, because a pace can change with
   * nothing but time: a window crossing `minElapsedFraction`, or resetting,
   * changes the verdict without the file changing at all. Reporting only on
   * file change would miss precisely the transition the Architect asked for —
   * *"if the weekly limit is reset it will march forward"*.
   */
  private notice(): void {
    const next = this.verdict()
    const previous = this.lastPace
    if (previous && previous.pace === next.pace && previous.because === next.because) return
    this.lastPace = next
    this.options.onPaceChange?.(next, previous)
  }

  /** Re-evaluates on the clock alone. Contract: never throws. */
  tick(): void {
    try {
      this.read()
      this.notice()
    } catch (err) {
      this.options.onDegraded?.(
        `usage watch failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}

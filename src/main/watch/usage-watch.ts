import fs from 'node:fs'
import path from 'node:path'
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
  /** `<harness home>/usage/` — one report file per agent. */
  readonly dir: string
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
 * How often the reports are re-read. The window it reports moves over hours;
 * a status line rewrites the file several times a minute, so anything faster
 * than this reads the same numbers repeatedly (SDD §11).
 */
export const DEFAULT_USAGE_POLL_MS = 20_000

export class UsageWatch {
  private timer: NodeJS.Timeout | null = null
  /** The newest report per file, keyed by file name. */
  private readonly reports = new Map<string, UsageReport>()
  private lastPace: PaceVerdict | null = null
  /** The exact bytes last parsed per file, so an unchanged file costs no parse. */
  private readonly lastRaw = new Map<string, string>()
  /** Reported once per episode per file; a bad file must not be a metronome. */
  private readonly degradedWith = new Map<string, string>()
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
   * Contract: never throws. An absent directory is the normal state before any
   * agent has rendered a status line, and it is NOT a degradation — the harness
   * has simply not been told anything yet. A file that exists but will not
   * parse *is* one: something is writing there and it is not our shim.
   */
  read(): void {
    let names: readonly string[]
    try {
      names = fs.readdirSync(this.options.dir).filter((name) => name.endsWith('.json'))
    } catch {
      // Absent or unreadable. Previous readings stand until they go stale on
      // their own clock, which `paceFor` enforces — there is no path by which a
      // vanished directory silently pins the company to an old pace forever.
      return
    }
    for (const name of names) {
      let raw: string
      try {
        raw = fs.readFileSync(path.join(this.options.dir, name), 'utf8')
      } catch {
        continue
      }
      if (raw === this.lastRaw.get(name)) continue
      this.lastRaw.set(name, raw)

      let parsed: UsageReport
      try {
        parsed = usageReportSchema.parse(JSON.parse(raw))
      } catch (err) {
        const detail = `usage report ${name} is not usable: ${
          err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err)
        }`
        if (this.degradedWith.get(name) !== detail) {
          this.degradedWith.set(name, detail)
          this.options.onDegraded?.(detail)
        }
        continue
      }
      this.degradedWith.delete(name)
      this.reports.set(name, parsed)
    }
  }

  /**
   * The reading the PACE is computed from: the freshest across every agent.
   *
   * The windows are account-wide, so any agent's reading describes every
   * agent's situation — but they are not equally CURRENT, and an agent that
   * exited an hour ago must not out-vote one reporting now. Freshest wins;
   * `paceFor` then discards it anyway if even that is stale.
   */
  private freshest(): UsageReport | null {
    let best: UsageReport | null = null
    for (const report of this.reports.values()) {
      if (!best || report.observedAt > best.observedAt) best = report
    }
    return best
  }

  /** The pace right now, computed fresh from the last reading and the clock. */
  verdict(): PaceVerdict {
    return paceFor({
      report: this.freshest(),
      now: this.now(),
      thresholds: this.options.thresholds ?? DEFAULT_PACE_THRESHOLDS
    })
  }

  /** The freshest reading, for the UI and the log. Null before anything read. */
  observed(): UsageReport | null {
    return this.freshest()
  }

  /**
   * Contract: what the engine last said THIS agent's current session has cost,
   * or null.
   *
   * Attribution is by `agentId` INSIDE the report, never by which file it came
   * from: the filename is a sanitised convenience and two ids could in
   * principle sanitise to the same name, whereas the id in the payload is what
   * the shim was actually told it was. Reading the field rather than the
   * filename is what makes "agent A's spend can never be shown against agent B"
   * a property of the data instead of a property of a naming scheme.
   *
   * Staleness is applied here too, on the same threshold the pace uses. A live
   * figure whose agent exited is not live, and the ledger's durable row is the
   * right answer once this one goes quiet.
   */
  liveCostFor(agentId: string): { readonly session: string; readonly usd: number } | null {
    const stale = (this.options.thresholds ?? DEFAULT_PACE_THRESHOLDS).staleAfterMs
    const now = this.now()
    let best: UsageReport | null = null
    for (const report of this.reports.values()) {
      if (report.agentId !== agentId) continue
      if (now - report.observedAt > stale) continue
      if (!best || report.observedAt > best.observedAt) best = report
    }
    if (!best || best.session === null || best.sessionCostUsd === null) return null
    return { session: best.session, usd: best.sessionCostUsd }
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

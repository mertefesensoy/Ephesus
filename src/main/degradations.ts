import {
  earnsLogLine,
  parseDegradationRow,
  sourceOf,
  type DegradationCause,
  type DegradationEntry,
  type DegradationRow,
  type DegradationSource
} from '../shared/degradation'

/**
 * The degradation channel (M8.2) — the one place a give-up becomes visible.
 *
 * Invariant §7 says every degradation is a visible UI state and never a silent
 * fallback. What existed was `console.warn` plus a fifty-entry array of
 * occurrences: never written down, gone at restart, and keyed by nothing, so
 * the pacing check's once-a-second report evicted everything else inside a
 * minute. This class is the fix, and its shape follows from three Architect
 * decisions on 2026-09-03: degradations get their own log kind, a repeating
 * cause reaches the book of record on a bounded ladder, and a restart replays
 * what was true when we stopped rather than showing a clean slate.
 *
 * ## Keyed by cause, which is what makes the flood harmless
 *
 * The ring holds one entry per CAUSE, not per occurrence. Three thousand
 * pacing reports are one entry with a count of three thousand, so a noisy
 * condition can no longer push a quiet one out — and the cap is on how many
 * distinct things are wrong, which is a number that stays small for real
 * reasons. That is why the flood test asserts an unrelated entry SURVIVES
 * rather than asserting a number of entries.
 *
 * ## What reaches the log, and what does not
 *
 * `earnsLogLine` decides: the first occurrence, then each power of ten, then
 * the clear. Everything else lives in the ring, where the count is exact. The
 * log stays a record of conditions rather than a transcript of a loop, which
 * matters because it is append-only, read from byte zero by every consumer, and
 * already the subject of M8.10.
 *
 * Contract: `report` never throws — a channel that can fail while reporting a
 * failure is worse than no channel. Appending to the log is best-effort for the
 * same reason: a full disk must not turn a degradation into a crash.
 */

export interface DegradationLogOptions {
  /** Appends to `log.jsonl`. Best-effort; a throw here is swallowed. */
  append(row: DegradationRow): void
  /** Developer console, kept because a terminal is where a developer looks. */
  warn?(line: string): void
  now?(): number
  /**
   * How many distinct causes to keep. A cap on conditions, not occurrences —
   * fifty different things being wrong at once is already a story the count
   * cannot tell.
   */
  readonly limit?: number
}

const DEFAULT_LIMIT = 50

interface Live {
  source: DegradationSource
  cause: DegradationCause
  detail: string
  count: number
  since: number
  lastSeen: number
  carried: boolean
}

export class DegradationLog {
  /** Insertion-ordered by first report; a repeat does not move an entry. */
  private readonly causes = new Map<string, Live>()
  private readonly now: () => number

  constructor(private readonly options: DegradationLogOptions) {
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Records that `cause` is true, with the current wording.
   *
   * The detail is refreshed on every report because the latest reading is the
   * useful one (a pacing percentage, a retry count); the CAUSE is the identity,
   * so refreshing the text never splits an entry in two.
   */
  report(cause: DegradationCause, detail: string): void {
    const source = sourceOf(cause)
    const at = this.now()
    const existing = this.causes.get(cause)
    if (existing === undefined) {
      const entry: Live = {
        source,
        cause,
        detail,
        count: 1,
        since: at,
        lastSeen: at,
        carried: false
      }
      this.causes.set(cause, entry)
      this.evictOldest()
      this.options.warn?.(`${source}: ${detail}`)
      this.append({ kind: 'degradation', source, cause, detail, count: 1, since: at })
      return
    }
    // A cause reported again by this session is live again, whatever it was.
    existing.count += 1
    existing.detail = detail
    existing.lastSeen = at
    existing.carried = false
    if (earnsLogLine(existing.count)) {
      this.options.warn?.(`${source}: ${detail} (x${String(existing.count)})`)
      this.append({
        kind: 'degradation',
        source,
        cause,
        detail,
        count: existing.count,
        since: existing.since
      })
    }
  }

  /**
   * Records that a condition has ended. Idempotent and silent for a cause that
   * was never reported: "it is not degraded" is not news, and a clear that had
   * to be guarded at every call site would be a clear nobody called.
   */
  clear(cause: DegradationCause): void {
    const existing = this.causes.get(cause)
    if (existing === undefined) return
    this.causes.delete(cause)
    const at = this.now()
    this.append({
      kind: 'degradation',
      source: existing.source,
      cause,
      detail: existing.detail,
      count: existing.count,
      since: existing.since,
      event: 'cleared',
      forMs: Math.max(0, at - existing.since)
    })
  }

  /** True while this cause is being reported. */
  has(cause: DegradationCause): boolean {
    return this.causes.has(cause)
  }

  /** Oldest first, so the UI reads top-to-bottom as "since when". */
  list(): readonly DegradationEntry[] {
    return [...this.causes.values()].map((entry) => ({
      source: entry.source,
      cause: entry.cause,
      detail: entry.detail,
      count: entry.count,
      since: entry.since,
      lastSeen: entry.lastSeen,
      freshness: entry.carried ? ('carried' as const) : ('live' as const)
    }))
  }

  /**
   * Rebuilds the list from the book of record at boot (Architect decision,
   * 2026-09-03).
   *
   * Everything replayed is `carried`, never `live`: it was true when the
   * company stopped and nothing has re-checked it. A `cleared` row removes its
   * cause, so a problem that was fixed before the last quit does not come back
   * from the dead — and the first live report of the same cause replaces the
   * carried entry, which is how the Architect learns it is still true.
   *
   * Rows are replayed oldest-first and nothing is appended: a replay is a read.
   */
  replay(entries: readonly unknown[]): void {
    for (const raw of entries) {
      const row = parseDegradationRow(raw)
      if (row === null) continue
      const cause = row.cause as DegradationCause
      if (row.event === 'cleared') {
        this.causes.delete(cause)
        continue
      }
      // Never overwrite something this session has already observed: a live
      // report is newer than anything the log can say about the same cause.
      if (this.causes.get(cause)?.carried === false) continue
      const at =
        typeof (raw as { ts?: unknown }).ts === 'number' ? (raw as { ts: number }).ts : row.since
      this.causes.set(cause, {
        source: row.source,
        cause,
        detail: row.detail,
        count: row.count,
        since: row.since,
        lastSeen: at,
        carried: true
      })
      this.evictOldest()
    }
  }

  private evictOldest(): void {
    const limit = this.options.limit ?? DEFAULT_LIMIT
    while (this.causes.size > limit) {
      const oldest = this.causes.keys().next()
      if (oldest.done === true) return
      this.causes.delete(oldest.value)
    }
  }

  private append(row: DegradationRow): void {
    try {
      this.options.append(row)
    } catch {
      // A channel that throws while reporting a failure is worse than no
      // channel: the ring still has the entry, and the UI still shows it.
    }
  }
}

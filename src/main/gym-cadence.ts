import type { GymRow } from '../shared/gym'

/**
 * The Gymnasium's metric-check booking (SDD §7.6, FR-12.4) — the carried item
 * the M5 close-out left for M6.7.
 *
 * SDD §7.6 draws the cycle with the scheduler in it:
 *
 * > row `landed` ─► **scheduler books metric check** ─► metric check ─►
 * > measured vs declared target
 *
 * Until now nothing booked anything: `measure()` existed and was reachable only
 * because the Architect went looking. A landed change whose check nobody
 * remembers to run is a change that quietly counts as a success, which is
 * exactly the "gamed metric" ADR-0015 opens by warning about — the whole point
 * of R2 is that an improvement has to be *falsified or confirmed*, not merely
 * shipped.
 *
 * What this tick does and does not do:
 *
 * - it **raises** every landed row whose declared window has closed, on the
 *   record (`log.jsonl` kind `gym`), so the check is visible and dated;
 * - it does **not** measure. The measured value is a fact about the world that
 *   something outside the Gymnasium has to supply, and `measure()` still takes
 *   it. Booking the check is scheduling; deciding what the number was is not.
 *
 * Extracted as a pure tick for the M5b reason: the shipped body is what the
 * suites exercise, so a scheduler test cannot pass against a copy of the
 * wiring while production runs something else.
 */

/**
 * Daily. A metric window is declared in DAYS (`windowDays`), so checking more
 * often than once a day could only re-raise a check nobody has run yet, and
 * checking less often would let a due date slip past unremarked.
 */
export const GYM_CHECK_EVERY_MS = 24 * 60 * 60 * 1000

/**
 * The Measured cell before a check has run — `due YYYY-MM-DD` (ADR-0015 R2),
 * optionally followed by a human note.
 *
 * The note matters. GYM-003's cell reads `due 2026-09-11 (live-quit evidence
 * owed with the metric check)`, and an anchored `$` match skipped it — so the
 * one row the M6 window singles out was the one row that would never have been
 * booked. Found by running this against the REAL ledger during the exit review
 * rather than against rows a test wrote for itself.
 */
const DUE = /^due\s+(\d{4}-\d{2}-\d{2})\b/

export interface MetricCheckDue {
  readonly id: string
  /** The declared due date, as the row itself records it. */
  readonly due: string
  /** What the row said would be measured — the falsifiable part. */
  readonly metric: string
}

/**
 * Contract: the landed rows whose metric window has closed on `today`.
 *
 * Only `landed` rows: a proposal still `approved` has not shipped, and one
 * already `validated`/`regressed` has been measured. A row whose Measured cell
 * is not a `due …` note is skipped rather than guessed at — a malformed cell is
 * a ledger problem to see, not a date to invent.
 *
 * Dates compare as ISO strings, which sorts correctly and avoids inventing a
 * timezone for a date the ledger wrote without one.
 */
export function metricChecksDue(rows: readonly GymRow[], today: string): readonly MetricCheckDue[] {
  const due: MetricCheckDue[] = []
  for (const row of rows) {
    if (row.status !== 'landed') continue
    const match = DUE.exec((row.measured ?? '').trim())
    const on = match?.[1]
    if (!on) continue
    if (on <= today) due.push({ id: row.id, due: on, metric: row.metric })
  }
  return due
}

export interface GymCadenceDeps {
  /** Every ledger row (R2 — the ledger is total). */
  rows(): readonly GymRow[]
  /** Today, as the harness reckons it. */
  today(): string
  /** `log.jsonl` kind `gym` (SDD §4.3). */
  appendLog(draft: { kind: 'gym' } & Record<string, unknown>): void
  /**
   * Raises the check with whatever surfaces it to the Architect. Optional so a
   * company with no surface still gets the LOG entry — the record is the part
   * that must not depend on a UI being open.
   */
  onDue?(check: MetricCheckDue): void
}

/**
 * Contract: one booking tick. Returns what it raised, so the caller and the
 * tests read the same answer rather than a copy of it.
 *
 * Idempotence is the ledger's, not this function's: a row stays `landed` until
 * it is measured, so a check stays due until somebody runs it. That is
 * deliberate — a booking that fired once and forgot would let a missed check
 * disappear, and R2 says the ledger is total.
 */
export function gymCadenceTick(deps: GymCadenceDeps): {
  readonly due: readonly MetricCheckDue[]
} {
  const today = deps.today()
  const due = metricChecksDue(deps.rows(), today)
  if (due.length === 0) {
    deps.appendLog({ kind: 'gym', event: 'metric-check-idle', on: today })
    return { due }
  }
  for (const check of due) {
    deps.appendLog({
      kind: 'gym',
      event: 'metric-check-due',
      gymId: check.id,
      due: check.due,
      metric: check.metric,
      on: today
    })
    deps.onDue?.(check)
  }
  return { due }
}

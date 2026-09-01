import { z } from 'zod'

/**
 * Usage-aware pacing (ADR-0023, superseding ADR-0011's budget clause).
 *
 * ADR-0011 governed spend with a per-agent constant, `budget.dailyTokens`. A
 * constant cannot govern a company with no fixed lifetime: set it low and it is
 * blown in minutes, set it high and it means nothing. The signal that actually
 * moves — and that the Architect actually pays against — is the account's
 * rolling usage window, which fills and then **resets**.
 *
 * Everything in this file is pure. The windows arrive as data (observed by the
 * engine's statusline and written to `<home>/usage.json` by `eph-usage.mjs`),
 * the clock arrives as an argument, and the verdict is a function of the two.
 * That is what makes a slowdown explicable after the fact: the same windows and
 * the same instant always produce the same pace, and the log carries the
 * numbers that caused it.
 */

export const USAGE_SCHEMA_VERSION = 1

/**
 * One rolling limit, exactly as the engine reports it.
 *
 * `usedPercent` may exceed 100: the engine documents its gateway `spend_limit`
 * as "0-100, above 100 once exceeded", and a schema that refused that would
 * turn the one moment we most need to see into a parse failure.
 */
export const usageWindowSchema = z
  .object({
    usedPercent: z.number().nonnegative(),
    /** Epoch **milliseconds** when this window resets. */
    resetsAt: z.number().int().nonnegative()
  })
  .strict()

export type UsageWindow = z.infer<typeof usageWindowSchema>

/**
 * What the shim last observed. A schema'd file, so it carries `schemaVersion`
 * (invariant §9).
 *
 * Both windows are nullable and both may be absent together. The engine only
 * reports them "after first API response, while at least one window is
 * present", so "we have not seen a window" is a real state the harness reaches
 * every time it starts — never an error, and never silently treated as zero
 * (which would read as "the account is empty" and let the company run flat out
 * into a limit it could not see).
 */
export const usageReportSchema = z
  .object({
    schemaVersion: z.literal(USAGE_SCHEMA_VERSION),
    /** Epoch milliseconds the shim wrote this. */
    observedAt: z.number().int().nonnegative(),
    /**
     * Which agent rendered it. For the windows this is only provenance — they
     * are account-wide, so any agent's reading is every agent's. For the live
     * cost below it is the ATTRIBUTION KEY, which is why each agent now writes
     * its own file: a single shared file would let whichever agent rendered
     * last claim the others' spend, and mis-attribution between agents is the
     * exact bug class ADR-0011 exists to close.
     */
    agentId: z.string().min(1).max(128).nullable(),
    fiveHour: usageWindowSchema.nullable(),
    sevenDay: usageWindowSchema.nullable(),
    /** The engine session this reading came from, or null before it says. */
    session: z.string().min(1).max(128).nullable(),
    /**
     * What the engine says THIS session has cost so far, in USD — the live
     * counterpart of the transcript's `cost-state` total, which only lands when
     * the session ends.
     *
     * Nullable and null-means-unknown: an engine that reports no cost, and a
     * reading taken before the first API response, must not read as "$0"
     * (ADR-0011's rule that "not reported" and "free" are different claims).
     */
    sessionCostUsd: z.number().nonnegative().nullable()
  })
  .strict()

export type UsageReport = z.infer<typeof usageReportSchema>

/** The window lengths the engine's two subscription limits cover. */
export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The company's pace.
 *
 * - `full`  — nothing is tight; work at the natural rate.
 * - `slow`  — the window is filling faster than it is emptying; put space
 *   between wakes so the remaining window covers the remaining time.
 * - `hold`  — the window is effectively spent; wait for the reset, which is at
 *   a **known instant**, so this is a bounded pause and not a deadlock.
 */
export const PACES = ['full', 'slow', 'hold'] as const
export const paceSchema = z.enum(PACES)
export type Pace = z.infer<typeof paceSchema>

/** Which input decided the pace. Machine-readable; prose lives in `prompts/`. */
export type PaceReason =
  /** No window has been observed yet — we do not pace on a signal we lack. */
  | 'unobserved'
  /** Every observed window has already reset; nothing is tight. */
  | 'reset'
  /** Under every threshold and on pace. */
  | 'under'
  /** A window crossed the Architect's percentage rule. */
  | 'used'
  /** Linear burn projects the window will be spent before it resets. */
  | 'ahead-of-pace'

export interface PaceThresholds {
  /**
   * Used-percentage at which the company slows. The Architect's stated rule:
   * *"if my 5 hour usage limit comes to 90 percent the company will slow down
   * things."*
   */
  readonly slowAtPercent: number
  /** Used-percentage at which the company holds until the window resets. */
  readonly holdAtPercent: number
  /**
   * How much of a window must have elapsed before its burn rate may be
   * projected.
   *
   * The same discipline `evaluateBudget` already applies to its own projection,
   * and for the same reason: two minutes into a five-hour window, a burn rate
   * computed from those two minutes projects absurd numbers and would put a
   * healthy company into `slow` on its first tool call. Under this floor the
   * projection is simply not claimed.
   */
  readonly minElapsedFraction: number
  /**
   * How long an observation stays usable. Past it the reading is stale — the
   * agent that was rendering statuslines has exited — and pacing falls back to
   * `unobserved` rather than steering on a number from an hour ago.
   */
  readonly staleAfterMs: number
}

export const DEFAULT_PACE_THRESHOLDS: PaceThresholds = {
  slowAtPercent: 90,
  holdAtPercent: 97,
  minElapsedFraction: 0.2,
  staleAfterMs: 30 * 60 * 1000
}

/** One window's contribution to the verdict, with the numbers behind it. */
export interface WindowPressure {
  readonly window: 'five-hour' | 'seven-day'
  readonly usedPercent: number
  readonly resetsAt: number
  /** Fraction of the window elapsed, 0–1. */
  readonly elapsedFraction: number
  /**
   * Used-percentage this window is on course to reach by its reset, or null
   * when too little of the window has elapsed to project honestly.
   */
  readonly projectedPercent: number | null
  readonly pace: Pace
  readonly because: PaceReason
}

export interface PaceVerdict {
  readonly pace: Pace
  readonly because: PaceReason
  /** The window that decided it, or null when none was usable. */
  readonly tightest: WindowPressure | null
  /** When the deciding window resets — what makes `hold` bounded. */
  readonly resetsAt: number | null
  /** Every window that was usable, for the log and the UI. */
  readonly windows: readonly WindowPressure[]
}

const PACE_ORDER: Readonly<Record<Pace, number>> = { full: 0, slow: 1, hold: 2 }

/**
 * Contract: the pace the company should run at, given what was last observed
 * and the current instant. Pure.
 *
 * Three rules, applied per window, worst window winning:
 *
 *  1. **Reset means march forward.** A window whose `resetsAt` has passed is
 *     ignored entirely. This is the Architect's *"if the weekly limit is reset
 *     it will march forward"* — it needs no special case anywhere else in the
 *     harness, because a reset window simply stops contributing pressure.
 *  2. **The percentage rule.** At or above `slowAtPercent` the company slows;
 *     at or above `holdAtPercent` it holds. This is a floor, not a forecast: it
 *     fires on the number the Architect actually looks at.
 *  3. **The pace rule.** Below those, a window that is being spent faster than
 *     it is elapsing still slows the company — `usedPercent / elapsedFraction`
 *     projects the used-percentage at reset, and a projection over 100 means
 *     the window runs out before it refills. Only claimed once
 *     `minElapsedFraction` of the window has actually elapsed.
 *
 * A stale or absent report yields `full` / `unobserved`. That is deliberate and
 * it is the honest direction: pacing is a *governor*, not a safety interlock —
 * the per-agent ceiling remains as the runaway backstop (ADR-0023) — and a
 * harness that froze the company because a shim had not written a file yet
 * would be a harness the Architect turns off.
 */
export function paceFor(input: {
  readonly report: UsageReport | null
  readonly now: number
  readonly thresholds?: PaceThresholds
}): PaceVerdict {
  const thresholds = input.thresholds ?? DEFAULT_PACE_THRESHOLDS
  const { report, now } = input

  const unobserved: PaceVerdict = {
    pace: 'full',
    because: 'unobserved',
    tightest: null,
    resetsAt: null,
    windows: []
  }
  if (!report) return unobserved
  if (now - report.observedAt > thresholds.staleAfterMs) return unobserved

  const windows: WindowPressure[] = []
  for (const [name, window, length] of [
    ['five-hour', report.fiveHour, FIVE_HOUR_MS],
    ['seven-day', report.sevenDay, SEVEN_DAY_MS]
  ] as const) {
    if (!window) continue
    // Rule 1: a window that has already reset exerts no pressure at all.
    if (window.resetsAt <= now) continue
    windows.push(pressureOf(name, window, length, now, thresholds))
  }

  if (windows.length === 0) {
    // Told apart from `unobserved` on purpose: "every window we saw has reset"
    // is a different fact from "we have never seen a window", and the second
    // one is the one that means the signal is not working.
    return report.fiveHour || report.sevenDay
      ? { pace: 'full', because: 'reset', tightest: null, resetsAt: null, windows: [] }
      : unobserved
  }

  let tightest = windows[0] as WindowPressure
  for (const pressure of windows) {
    if (PACE_ORDER[pressure.pace] > PACE_ORDER[tightest.pace]) tightest = pressure
  }
  return {
    pace: tightest.pace,
    because: tightest.because,
    tightest,
    resetsAt: tightest.resetsAt,
    windows
  }
}

function pressureOf(
  name: 'five-hour' | 'seven-day',
  window: UsageWindow,
  lengthMs: number,
  now: number,
  thresholds: PaceThresholds
): WindowPressure {
  const remaining = window.resetsAt - now
  // Clamped: a `resetsAt` further out than the window is long (a clock skew, or
  // an engine reporting a longer window than we assumed) would otherwise give a
  // negative elapsed fraction and a projection with the sign flipped.
  const elapsedFraction = Math.min(1, Math.max(0, (lengthMs - remaining) / lengthMs))
  const projectedPercent =
    elapsedFraction >= thresholds.minElapsedFraction
      ? Math.round((window.usedPercent / elapsedFraction) * 10) / 10
      : null

  const base = {
    window: name,
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
    elapsedFraction: Math.round(elapsedFraction * 1000) / 1000,
    projectedPercent
  } as const

  if (window.usedPercent >= thresholds.holdAtPercent) {
    return { ...base, pace: 'hold', because: 'used' }
  }
  if (window.usedPercent >= thresholds.slowAtPercent) {
    return { ...base, pace: 'slow', because: 'used' }
  }
  if (projectedPercent !== null && projectedPercent > 100) {
    return { ...base, pace: 'slow', because: 'ahead-of-pace' }
  }
  return { ...base, pace: 'full', because: 'under' }
}

/**
 * Contract: the smallest gap allowed between two wakes of the same agent at
 * this pace, in milliseconds. Pure.
 *
 * This is where a pace becomes a rate. The measurement that set these numbers:
 * an Artemis wake costs a median 485k tokens and a mean 712k, and 39 % of a
 * measured day went to stop-hook re-wakes carrying about a kilobyte of new
 * information each. Spacing wakes is therefore the lever with the most spend
 * behind it, and unlike a token ceiling it throttles the harness's own
 * behaviour rather than the agent's.
 *
 * `hold` returns `Infinity` rather than a very large number: the caller must
 * decide to wait for the reset, and a number would invite arithmetic on it.
 */
export function minWakeGapMs(pace: Pace, config: { readonly slowWakeGapMs: number }): number {
  switch (pace) {
    case 'full':
      return 0
    case 'slow':
      return config.slowWakeGapMs
    case 'hold':
      return Number.POSITIVE_INFINITY
  }
}

/**
 * Contract: whether a wake may be issued now. Pure — the caller supplies both
 * clocks, so the decision is table-testable and carries no timer of its own.
 *
 * `lastWokeAt` of null means this agent has not been woken in this process's
 * memory, and the first wake at any pace is always allowed: a company that
 * never gets going is not a paced company.
 */
export function mayWake(input: {
  readonly pace: Pace
  readonly lastWokeAt: number | null
  readonly now: number
  readonly slowWakeGapMs: number
}): { readonly allowed: boolean; readonly waitMs: number } {
  const gap = minWakeGapMs(input.pace, { slowWakeGapMs: input.slowWakeGapMs })
  if (gap === 0) return { allowed: true, waitMs: 0 }
  if (input.lastWokeAt === null) return { allowed: true, waitMs: 0 }
  if (gap === Number.POSITIVE_INFINITY) return { allowed: false, waitMs: Number.POSITIVE_INFINITY }
  const waited = input.now - input.lastWokeAt
  return waited >= gap ? { allowed: true, waitMs: 0 } : { allowed: false, waitMs: gap - waited }
}

import { z } from 'zod'

/**
 * The circuit breaker's signals and ladder (ADR-0011, FR-11.3, SDD §9).
 *
 * ADR-0011's shape, restated because every function here serves it: **a
 * three-step ladder, never a kill switch first.** Rung 1 (steer) is one
 * injected sentence and nothing else, so the cost of a false trip is a
 * sentence. Rung 2 (constrain) tightens the envelope. Rung 3 (stop) is the
 * only destructive one, and only after the first two failed.
 *
 * Everything in this file is pure. The signals are computed from spans and
 * counters the caller supplies; nothing here reads a clock, a file or a
 * process, so every threshold is table-testable and every trip is
 * reproducible from its inputs.
 */

export const BREAKER_SCHEMA_VERSION = 1

/**
 * One tool call, as FR-11.6 needs it: "agent, tool, duration, outcome". Spans
 * are *captured* in M3 and read by the signals below; the waterfall UI comes
 * later (Architect decision), so nothing here renders anything.
 */
export const spanSchema = z
  .object({
    agentId: z.string().min(1).max(128),
    tool: z.string().min(1).max(128),
    /** Milliseconds from pre-tool to post-tool, or null while still open. */
    durationMs: z.number().int().nonnegative().nullable(),
    outcome: z.enum(['ok', 'error', 'open']),
    /** Epoch milliseconds of the pre-tool event. */
    startedAt: z.number().int().nonnegative(),
    /**
     * A stable digest of the call's arguments, for the repetition signal.
     * A digest rather than the arguments themselves: spans are local-only
     * (NFR-10) but they are also read by the briefing compiler, and a tool
     * call's arguments can contain anything an agent was working on.
     */
    fingerprint: z.string().min(1).max(128)
  })
  .strict()

export type Span = z.infer<typeof spanSchema>

/** The four trip signals ADR-0011 names, in its own order. */
export const TRIP_SIGNALS = ['repetition', 'error-rate', 'hop-cap', 'burn-rate'] as const
export const tripSignalSchema = z.enum(TRIP_SIGNALS)
export type TripSignal = z.infer<typeof tripSignalSchema>

/** The ladder, in ADR-0011's order. Rung 0 means "nothing tripped". */
export const RUNGS = [0, 1, 2, 3] as const
export type Rung = (typeof RUNGS)[number]

export const RUNG_NAMES: Readonly<Record<Exclude<Rung, 0>, string>> = {
  1: 'steer',
  2: 'constrain',
  3: 'stop'
}

/**
 * Thresholds. Deliberately generous: ADR-0011 accepts false trips at rung 1
 * because rung 1 is cheap, but a breaker that fires on ordinary work is one
 * the Architect turns off, and then it protects nothing at all.
 */
export interface BreakerThresholds {
  /** Identical calls within the window that count as repetition. */
  readonly repeatCount: number
  /** The window, in milliseconds. */
  readonly repeatWindowMs: number
  /** Error ratio, over at least `errorFloor` spans, that counts as a storm. */
  readonly errorRate: number
  readonly errorFloor: number
  /** Hop-cap escalations on one conversation that count as recurring. */
  readonly hopCapEscalations: number
  /**
   * How long a rung must hold before the ladder may climb again.
   *
   * Without it the ladder climbs once per tool call: an error storm reaches
   * `stop` three calls after the floor, and the agent never gets a chance to
   * act on the steer — which is queued until idle (FR-1.3), so it may not even
   * have been delivered. A ladder that climbs three rungs in three seconds is
   * a kill switch with extra steps, and ADR-0011 is explicitly not that.
   */
  readonly rungDwellMs: number
}

export const DEFAULT_THRESHOLDS: BreakerThresholds = {
  repeatCount: 5,
  repeatWindowMs: 120_000,
  errorRate: 0.5,
  errorFloor: 6,
  hopCapEscalations: 3,
  rungDwellMs: 60_000
}

export interface SignalInput {
  /** This agent's spans, oldest first. */
  readonly spans: readonly Span[]
  /** Now, in epoch milliseconds — supplied so the signals stay pure. */
  readonly now: number
  /** Hop-cap diversions seen per conversation (ADR-0003's counter). */
  readonly hopCapEscalations: Readonly<Record<string, number>>
  /** The budget verdict's state (M3.2), or null when unbudgeted. */
  readonly budgetState: 'ok' | 'projected-breach' | 'breached' | 'unbudgeted' | null
  readonly thresholds?: BreakerThresholds
}

/** One signal that fired, with the numbers that made it fire. */
export interface SignalHit {
  readonly signal: TripSignal
  /** Machine-readable detail; the prose lives in `prompts/` (invariant §8). */
  readonly detail: Readonly<Record<string, string | number>>
}

/**
 * Contract: every signal that currently fires, in `TRIP_SIGNALS` order. Pure —
 * the same inputs always produce the same hits, which is what makes a trip
 * explicable after the fact rather than a mood the harness was in.
 */
export function evaluateSignals(input: SignalInput): readonly SignalHit[] {
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS
  const hits: SignalHit[] = []

  const repetition = repeatedCall(input.spans, input.now, thresholds)
  if (repetition) hits.push(repetition)

  const storm = errorStorm(input.spans, thresholds)
  if (storm) hits.push(storm)

  for (const [conversation, count] of Object.entries(input.hopCapEscalations)) {
    if (count >= thresholds.hopCapEscalations) {
      hits.push({ signal: 'hop-cap', detail: { conversation, escalations: count } })
    }
  }

  // Trip signal #4, narrowed by ADR-0023 to `breached` only.
  //
  // ADR-0011 fed the *projection* to the breaker as well, on the reasoning that
  // a pre-flight forecast beats a post-hoc discovery. That reasoning was sound
  // and its input was not: the forecast was made against `budget.dailyTokens`,
  // a per-agent constant, and a constant cannot forecast anything in a company
  // with no fixed lifetime. In practice all four agents reached
  // `projected-breach` within twenty minutes of a run whose ceilings had just
  // been raised fifty-fold, and the breaker throttled two of them to rung 2 —
  // a governor firing on ordinary work, which ADR-0011 itself says is the one
  // way to make an Architect switch a breaker off.
  //
  // Forecasting now belongs to the pacer (`shared/pacing.ts`), which projects
  // against the account's real, resetting usage window. What is left here is
  // what a ceiling can honestly say: this agent has actually gone over. That is
  // a runaway backstop, and a backstop should only fire on the thing itself.
  if (input.budgetState === 'breached') {
    hits.push({ signal: 'burn-rate', detail: { budget: input.budgetState } })
  }

  return hits
}

/**
 * "Repeated near-identical tool calls in a window" (ADR-0011). Near-identical
 * means same tool AND same argument fingerprint: an agent reading twenty
 * different files is working, and an agent reading the same file twenty times
 * is stuck, and only the fingerprint tells them apart.
 */
function repeatedCall(
  spans: readonly Span[],
  now: number,
  thresholds: BreakerThresholds
): SignalHit | null {
  const counts = new Map<string, number>()
  for (const span of spans) {
    if (now - span.startedAt > thresholds.repeatWindowMs) continue
    // The separator is U+0000, written as an ESCAPE rather than as a raw
    // byte. A literal NUL in the source makes git classify this file as
    // binary: `git diff` then shows only `Bin … bytes` and `grep` skips it
    // without `-a`. This is a Watch-critical file, and one nobody can read a
    // diff of is one nobody reviews.
    //
    // NUL remains the right separator — no tool name or fingerprint can
    // contain one, so `tool + NUL + fingerprint` is unambiguous in a way
    // `tool + ":" + fingerprint` would not be.
    const key = `${span.tool}\u0000${span.fingerprint}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const [key, count] of counts) {
    if (count >= thresholds.repeatCount) {
      return {
        signal: 'repetition',
        detail: { tool: key.split('\u0000')[0] ?? '', repeats: count }
      }
    }
  }
  return null
}

/** "Error-rate threshold" (ADR-0011), over enough calls to mean something. */
function errorStorm(spans: readonly Span[], thresholds: BreakerThresholds): SignalHit | null {
  const settled = spans.filter((span) => span.outcome !== 'open')
  if (settled.length < thresholds.errorFloor) return null
  const errors = settled.filter((span) => span.outcome === 'error').length
  const rate = errors / settled.length
  if (rate < thresholds.errorRate) return null
  return {
    signal: 'error-rate',
    detail: { errors, calls: settled.length, rate: Math.round(rate * 100) / 100 }
  }
}

/**
 * Contract: the rung to be at, given the rung already reached and whether any
 * signal is still firing.
 *
 * The ladder only ever climbs one step at a time, and only while something is
 * still wrong — ADR-0011's "never a kill switch first" is this function
 * refusing to skip to 3. A quiet agent falls back to 0 in one step, because an
 * agent that recovered should not have to serve a sentence.
 */
export function nextRung(
  current: Rung,
  firing: boolean,
  /**
   * Milliseconds since the last transition, and the dwell required. Omit both
   * to ignore dwell (the pure step function). Recovery is never delayed: an
   * agent that stopped misbehaving should not have to serve out a sentence.
   */
  dwell?: { readonly sinceMs: number; readonly requiredMs: number }
): Rung {
  if (!firing) return 0
  if (current >= 3) return 3
  if (dwell && current > 0 && dwell.sinceMs < dwell.requiredMs) return current
  return (current + 1) as Rung
}

/** What each rung is allowed to do to an agent (ADR-0011's own list). */
/**
 * What rung 3 hands the ledger with a stalled task, so the row explains itself
 * to whoever reads it next (NFR-13). No prose: these are the same
 * machine-readable facts the `breaker` log event carries.
 */
export interface BreakerReport {
  readonly rung: 3
  readonly signals: readonly SignalHit[]
}

export interface RungActions {
  /** Rung 1: inject one corrective sentence, and mark the avatar `looping`. */
  readonly steer: boolean
  /** Rung 2: pause deliveries, lower remaining budget, read-only where able. */
  readonly constrain: boolean
  /** Rung 3: graceful interrupt, then stop; the task returns as `stalled`. */
  readonly stop: boolean
}

export function actionsFor(rung: Rung): RungActions {
  return { steer: rung >= 1, constrain: rung >= 2, stop: rung >= 3 }
}

/**
 * Whether an engine's hook grade weakens the breaker (ADR-0011's stated
 * consequence: "on `pty-heuristic` engines its repetition signal is weaker —
 * surfaced as reduced protection on the agent card").
 */
export function protectionFor(hookFidelity: string): {
  readonly reduced: boolean
  /** Signals that cannot be computed at this grade. */
  readonly blind: readonly TripSignal[]
} {
  if (hookFidelity === 'pty-heuristic') {
    // No tool events means no spans, so two of the four signals see nothing.
    return { reduced: true, blind: ['repetition', 'error-rate'] }
  }
  return { reduced: false, blind: [] }
}

/** The breaker's state for one agent, as the UI and the log see it. */
export interface BreakerState {
  readonly agentId: string
  readonly rung: Rung
  /** Signals firing right now. */
  readonly firing: readonly SignalHit[]
  /** Whether this engine's grade weakens the breaker. */
  readonly reducedProtection: boolean
  readonly blindSignals: readonly TripSignal[]
  /** Spans captured for this agent this session (FR-11.6). */
  readonly spanCount: number
}

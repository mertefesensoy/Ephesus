/**
 * Provider capacity, and what a company does when it runs out (invariant §7).
 *
 * Ephesus is meant to run for days. Hitting the provider's usage limit is a
 * NORMAL EVENT in that life, not a fault: the work is still there, the process
 * is still there, and the only thing that has happened is that the provider
 * will not take another turn for a while. Treating it as a crash is what loses
 * agents — it ghosts them, burns the orchestrator's respawn ladder on a
 * failure no restart can fix, and leaves an idle terminal that looks exactly
 * like a finished one.
 *
 * So capacity gets its own vocabulary, separate from crashes and from budgets:
 *
 *  - a **budget** is OURS (ADR-0011's ladder — steer, constrain, stop). It is a
 *    number the Architect set and the Watch enforces.
 *  - **capacity** is THEIRS. Nothing we do makes it come back sooner, and
 *    nothing we do should make it worse. The only correct response is to stop
 *    asking, stay visible, and come back.
 *
 * Everything in this module is pure, so the decision can be tested without a
 * clock, a process, or a transcript.
 */

/**
 * One provider-capacity refusal, as the engine reported it.
 *
 * Deliberately normalized away from any one engine's transcript shape: the
 * adapter classifies (`TranscriptReader.limitOf`), and everything above it
 * reads this. NFR-12 — the Watch learns nothing engine-specific.
 */
export interface CapacityLimit {
  /**
   * Only `rate-limit` today, and a union of one on purpose.
   *
   * The reference engine's own error taxonomy separates `rate_limit` ("wait and
   * retry") from `billing_error`, `overloaded`, `server_error` and
   * `invalid_request`. Waiting fixes exactly one of those. A wider kind here
   * would invite a detector that parks a company for a condition no amount of
   * waiting clears — which is a company that never comes back.
   */
  readonly kind: 'rate-limit'
  /**
   * The transcript record's own identity. This is what makes a limit NEW: the
   * same record is re-read on every tick, and a park must fire once per
   * refusal, not once per look.
   */
  readonly recordId: string
  readonly sessionId: string
  /** When the engine stamped it (ISO). */
  readonly at: string
  /**
   * The engine's own sentence, carried verbatim to the Architect. The harness
   * does not paraphrase a provider message it did not write — a paraphrase is
   * how "out of usage credits" quietly becomes "rate limited" in the UI, and
   * those two need different things from a human.
   */
  readonly detail: string
  /**
   * When the provider says capacity returns (ISO), or null when it did not say.
   *
   * Null is the common case, not the exception: the refusal records observed on
   * this machine carry no reset time at all. A harness that assumed one would
   * be inventing the single number this whole feature turns on.
   */
  readonly resetsAt: string | null
}

/** Where one agent stands with respect to provider capacity. */
export type CapacityPhase =
  /** Nothing is blocking; the agent is working, or idle for ordinary reasons. */
  | 'clear'
  /** The provider refused, and we are deliberately not asking again yet. */
  | 'parked'
  /** The wait elapsed; a continuation has gone out and we are watching. */
  | 'resuming'

/** One parked agent, as the UI and the log both read it. */
export interface ParkedAgent {
  readonly agentId: string
  readonly phase: Exclude<CapacityPhase, 'clear'>
  readonly limit: CapacityLimit
  /** When this park began (ISO) — not `limit.at` once a re-park has happened. */
  readonly since: string
  /**
   * Resume attempts that were themselves refused. Zero on the first park.
   *
   * A PATIENCE counter, not a failure counter — see `retryDelayMs`.
   */
  readonly attempts: number
  /** When the next continuation is due (ISO). */
  readonly retryAt: string
  /**
   * Whether the engine process survived the refusal.
   *
   * It normally does — the reference engine writes the refusal and returns to
   * its prompt. When true, the agent resumes by being TALKED TO, with its
   * conversation intact. When false, it resumes by being respawned onto its
   * last engine session (ADR-0009 `resume`). Both are "continue where you left
   * off"; only one needs a new process, and the card says which actually
   * happened rather than implying the better one.
   */
  readonly processAlive: boolean
}

/** The company-level view the status strip reads (invariant §7). */
export interface CapacityView {
  readonly parked: readonly ParkedAgent[]
  /** The earliest park still standing (ISO), or null when none is. */
  readonly since: string | null
  /** The soonest continuation due (ISO), or null when none is. */
  readonly retryAt: string | null
}

/**
 * How long to wait before asking again, by attempt.
 *
 * A minute first, because a limit landing at the end of a rolling window can
 * clear almost immediately; an hour last, because a daily one will not. The
 * numbers are chosen to be cheap to be wrong about in both directions — an
 * early probe costs one refused request, and a late one costs idle minutes on a
 * system that is meant to run for days.
 */
export const CAPACITY_BACKOFF_MS: readonly number[] = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000
]

/**
 * Settle margin added to a provider-declared reset time.
 *
 * Asking at the exact instant a window rolls is asking a fraction early once
 * two clocks disagree, and being refused for the sake of a few seconds restarts
 * the whole ladder.
 */
export const CAPACITY_RESET_MARGIN_MS = 15_000

/**
 * Contract: pure. Milliseconds to wait before the next continuation attempt.
 *
 * Two rules, and the second is the one that matters:
 *
 * 1. If the provider named a reset time still in the future, wait for it (plus
 *    the settle margin). It knows and we do not.
 * 2. Otherwise climb `CAPACITY_BACKOFF_MS` — and **hold at the top rung
 *    forever**. This ladder does not end, and that is the deliberate difference
 *    from every other ladder in this system. A crash ladder ends because a
 *    process that will not start is a fault a human has to see. A capacity
 *    ladder that ended would abandon a healthy agent over a condition that is
 *    guaranteed to clear, which is precisely "losing the agent".
 */
export function retryDelayMs(attempts: number, resetsAt: string | null, now: number): number {
  if (resetsAt !== null) {
    const at = Date.parse(resetsAt)
    if (Number.isFinite(at)) {
      const wait = at + CAPACITY_RESET_MARGIN_MS - now
      // A reset time already in the past tells us nothing useful; fall through
      // to the ladder rather than retrying instantly in a loop.
      if (wait > 0) return wait
    }
  }
  const top = CAPACITY_BACKOFF_MS.length - 1
  const rung = Math.min(Math.max(Math.trunc(attempts), 0), top)
  // Non-null by construction: `rung` is clamped into the array's own range.
  return CAPACITY_BACKOFF_MS[rung] ?? 60_000
}

/**
 * Contract: pure. The company view over the parked agents, oldest park first.
 *
 * `since`/`retryAt` are the extremes rather than an average because that is
 * what a strip has room to say: how long this has been going on, and when
 * something will next happen.
 */
export function capacityView(parked: readonly ParkedAgent[]): CapacityView {
  const ordered = [...parked].sort((a, b) => a.since.localeCompare(b.since))
  const retries = ordered.map((row) => row.retryAt).sort()
  return {
    parked: ordered,
    since: ordered[0]?.since ?? null,
    retryAt: retries[0] ?? null
  }
}

/**
 * Contract: pure. The one-line status-strip sentence, or null when clear.
 *
 * Shared between the strip and the log so the Architect reads the same words in
 * both places. §9 copy voice: say what is happening and what happens next — a
 * count with no verb is the thing the dock was built to stop.
 */
export function capacitySentence(view: CapacityView, now: number): string | null {
  const n = view.parked.length
  if (n === 0) return null
  const who = n === 1 ? '1 agent' : `${String(n)} agents`
  const at = view.retryAt === null ? Number.NaN : Date.parse(view.retryAt)
  if (!Number.isFinite(at)) return `${who} waiting for provider capacity`
  const mins = Math.max(0, Math.round((at - now) / 60_000))
  const when = mins === 0 ? 'any moment' : mins === 1 ? 'in 1 min' : `in ${String(mins)} min`
  return `${who} waiting for provider capacity · retry ${when}`
}

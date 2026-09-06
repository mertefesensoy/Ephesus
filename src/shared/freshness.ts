/**
 * Whether a polled reading is still current, or is the last good value being
 * held in front of the Architect (B15, invariant §7).
 *
 * ## The failure this exists for
 *
 * A hung harness and a healthy idle one look identical from the renderer. Both
 * show a still floor, a quiet terminal and badges that stop changing — and the
 * whole company is a thing you are meant to be able to walk away from, so
 * "nothing is moving" is the normal case and cannot itself be the alarm.
 *
 * Two things made it worse than merely ambiguous:
 *
 *  - **The bridge check ran once, at mount.** `useEffect(…, [])` called
 *    `eph.config.get()` a single time, so if main died an hour later the strip
 *    went on reading `bridge: ready` for as long as the window stayed open. A
 *    degradation reported as good news is the one direction invariant §7 does
 *    not allow, and this one reported it forever.
 *  - **A failed poll holds its last value.** That is deliberate and correct — a
 *    failed read must never repaint a parked company as a working one — but
 *    with nothing disclosing the hold, "read a moment ago" and "read at 3am and
 *    unanswered since" render identically.
 *
 * ## Why a deadline rather than a catch
 *
 * A rejection is the easy half: main threw, and the promise tells you. The
 * shape that matters is the one that produces no event at all. An IPC invoke
 * against a main process whose loop is blocked does not reject — it never
 * settles — so a `.catch()` heartbeat would sit silent through exactly the
 * failure it was written to catch. What distinguishes hung from idle is the
 * ANSWER not arriving in time, which is a fact about the clock and not about
 * the promise. Hence a deadline.
 *
 * Pure and clock-injected so the rule is testable without a window: the same
 * reason `closing.ts` and `incidents.ts` take their `now`.
 */

/**
 * How long a reading may go unanswered before it is called stale.
 *
 * Three poll periods at the renderer's 2 s cadence. One period would flag every
 * ordinary scheduling hiccup and teach the Architect to ignore the warning,
 * which is worse than not showing it; three is long enough that a miss is a
 * miss and short enough that a hung harness is named within seconds.
 */
export const STALE_AFTER_MS = 6_000

/**
 * Contract: pure. Milliseconds since the last good reading, once that silence
 * has passed `deadlineMs`; `null` while the reading is current.
 *
 * `watchingSince` is when this reading started being polled, and it stands in
 * for `lastOkAt` before the first answer arrives — so a poll that has NEVER
 * answered goes stale on the same clock as one that stopped answering. Without
 * it the first-answer case would be indistinguishable from a healthy start, and
 * a main process that was already dead at mount would never be reported at all.
 *
 * A clock that has gone backwards reports no stall, and there is deliberately
 * no guard for it: a negative silence is already less than any deadline, so the
 * one comparison covers it. Saying it twice would add a branch no test could
 * kill — an equivalent mutant, which is a design smell rather than something to
 * document. The behaviour is pinned by a test even though the code for it is
 * not separable, because a system clock adjustment is not evidence that the
 * harness is hung and the property is worth keeping true.
 */
export function stallOf(input: {
  readonly lastOkAt: number | null
  readonly watchingSince: number
  readonly now: number
  readonly deadlineMs?: number
}): number | null {
  const deadline = input.deadlineMs ?? STALE_AFTER_MS
  const since = input.lastOkAt ?? input.watchingSince
  const silence = input.now - since
  if (silence < deadline) return null
  return silence
}

/** Contract: pure. A silence in whole seconds, for the strip's one-line copy. */
export function stallSeconds(silenceMs: number): number {
  return Math.floor(silenceMs / 1_000)
}

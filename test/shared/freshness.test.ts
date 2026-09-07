import { describe, expect, it } from 'vitest'
import { STALE_AFTER_MS, stallOf, stallSeconds } from '../../src/shared/freshness'

/**
 * A hung harness told apart from a healthy idle one (B15).
 *
 * The rule is deliberately about the CLOCK rather than about promises. A main
 * process that threw rejects the invoke and the renderer's `catch` has always
 * handled that; a main process whose loop is blocked never settles the invoke
 * at all, so there is no event to react to and the only evidence is an answer
 * that did not arrive. Everything here is that one distinction.
 */

const T0 = 1_800_000_000_000

describe('stallOf (has this reading stopped answering?)', () => {
  it('is silent while the reading is current', () => {
    expect(stallOf({ lastOkAt: T0, watchingSince: T0, now: T0 + 1_000 })).toBeNull()
  })

  it('reports the silence once it passes the deadline', () => {
    expect(stallOf({ lastOkAt: T0, watchingSince: T0, now: T0 + 9_000 })).toBe(9_000)
  })

  it('treats the deadline itself as stale', () => {
    // The boundary is stated rather than left to whichever comparison was
    // typed: a reading exactly at the deadline has already missed three polls.
    expect(stallOf({ lastOkAt: T0, watchingSince: T0, now: T0 + STALE_AFTER_MS })).toBe(
      STALE_AFTER_MS
    )
    expect(stallOf({ lastOkAt: T0, watchingSince: T0, now: T0 + STALE_AFTER_MS - 1 })).toBeNull()
  })

  it('ages a reading that has NEVER answered, from when watching began', () => {
    // The case that matters most and is easiest to miss: a main process that
    // was already dead when the window opened. With `lastOkAt` null and no
    // fallback, the silence would be measured from nothing and never reported.
    expect(stallOf({ lastOkAt: null, watchingSince: T0, now: T0 + 9_000 })).toBe(9_000)
    expect(stallOf({ lastOkAt: null, watchingSince: T0, now: T0 + 1_000 })).toBeNull()
  })

  it('prefers the last answer over the start once one has arrived', () => {
    // A window open for an hour whose poll answered a second ago is current,
    // and would look an hour stale if the fallback won.
    expect(stallOf({ lastOkAt: T0 + 3_600_000, watchingSince: T0, now: T0 + 3_600_500 })).toBeNull()
  })

  it('does not report a stall when the clock has gone backwards', () => {
    // A system clock adjustment is not evidence that the harness is hung, and
    // a negative silence rendered as "no answer in -4s" is an alarm nobody can
    // act on.
    expect(stallOf({ lastOkAt: T0 + 5_000, watchingSince: T0, now: T0 })).toBeNull()
  })

  it('takes a caller-supplied deadline', () => {
    expect(stallOf({ lastOkAt: T0, watchingSince: T0, now: T0 + 500, deadlineMs: 400 })).toBe(500)
    expect(
      stallOf({ lastOkAt: T0, watchingSince: T0, now: T0 + 500, deadlineMs: 60_000 })
    ).toBeNull()
  })

  it('is three poll periods, not one', () => {
    // One period would flag every ordinary scheduling hiccup and teach the
    // Architect to ignore the warning, which is worse than not showing it.
    expect(STALE_AFTER_MS).toBe(6_000)
  })
})

describe('stallSeconds', () => {
  it('floors, so a silence is never reported as longer than it is', () => {
    expect(stallSeconds(6_999)).toBe(6)
    expect(stallSeconds(6_000)).toBe(6)
  })
})

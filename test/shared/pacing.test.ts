import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PACE_THRESHOLDS,
  FIVE_HOUR_MS,
  SEVEN_DAY_MS,
  mayWake,
  minWakeGapMs,
  paceFor,
  usageReportSchema,
  USAGE_SCHEMA_VERSION,
  type UsageReport
} from '../../src/shared/pacing'

/**
 * The pure half of usage-aware pacing (ADR-0023).
 *
 * The shapes here are not invented: they are the shape the engine actually
 * reported, captured from a real `statusLine` render on 2026-09-01 —
 * `five_hour {used_percentage: 12, resets_at: 1788294000}` and
 * `seven_day {used_percentage: 29, resets_at: 1788753600}`, epoch SECONDS on
 * the wire, converted to milliseconds at the shim boundary.
 */

const NOW = Date.UTC(2026, 8, 1, 15, 44, 0)

function report(over: Partial<UsageReport> = {}): UsageReport {
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    observedAt: NOW,
    agentId: 'agent.artemis',
    fiveHour: null,
    sevenDay: null,
    session: null,
    sessionCostUsd: null,
    ...over
  }
}

/** A window `usedPercent` full with `remainingMs` left before it resets. */
function window(usedPercent: number, remainingMs: number) {
  return { usedPercent, resetsAt: NOW + remainingMs }
}

describe('the usage report schema', () => {
  it('accepts what the engine actually reported', () => {
    const parsed = usageReportSchema.parse({
      schemaVersion: 1,
      observedAt: NOW,
      agentId: 'agent.artemis',
      fiveHour: { usedPercent: 12, resetsAt: 1788294000000 },
      sevenDay: { usedPercent: 28.999999999999996, resetsAt: 1788753600000 },
      // Also captured live from that same render.
      session: '6e7cc56d-1269-4284-82e4-d4975aecadff',
      sessionCostUsd: 0.08599799999999999
    })
    expect(parsed.fiveHour?.usedPercent).toBe(12)
    // The engine reports a float; nothing rounds it on the way in.
    expect(parsed.sevenDay?.usedPercent).toBeCloseTo(29)
    expect(parsed.sessionCostUsd).toBeCloseTo(0.085998, 9)
  })

  it('accepts a used-percentage above 100, because the engine documents one', () => {
    // The gateway `spend_limit` is documented "0-100, above 100 once exceeded".
    // A schema that refused it would turn the one moment we most need to see
    // into a parse failure.
    expect(() =>
      usageReportSchema.parse(report({ fiveHour: { usedPercent: 140, resetsAt: NOW + 1000 } }))
    ).not.toThrow()
  })

  it('rejects a report with no schemaVersion', () => {
    const rest: Record<string, unknown> = { ...report() }
    delete rest['schemaVersion']
    expect(() => usageReportSchema.parse(rest)).toThrow()
  })
})

describe('paceFor', () => {
  it('runs at full speed when nothing has been observed', () => {
    // The engine reports no window until after its first API response, so this
    // is the state the harness starts in every single time.
    const verdict = paceFor({ report: null, now: NOW })
    expect(verdict.pace).toBe('full')
    expect(verdict.because).toBe('unobserved')
    expect(verdict.tightest).toBeNull()
  })

  it('runs at full speed on a stale reading rather than steering on old numbers', () => {
    const stale = report({
      observedAt: NOW - DEFAULT_PACE_THRESHOLDS.staleAfterMs - 1,
      fiveHour: window(99, FIVE_HOUR_MS / 2)
    })
    const verdict = paceFor({ report: stale, now: NOW })
    expect(verdict.pace).toBe('full')
    expect(verdict.because).toBe('unobserved')
  })

  it('slows at the percentage the Architect named', () => {
    // "if my 5 hour usage limit comes to 90 percent the company will slow down
    // things" — the stated rule, at the stated number.
    const verdict = paceFor({
      report: report({ fiveHour: window(90, FIVE_HOUR_MS / 2) }),
      now: NOW
    })
    expect(verdict.pace).toBe('slow')
    expect(verdict.because).toBe('used')
    expect(verdict.tightest?.window).toBe('five-hour')
  })

  it('does not slow one point below it', () => {
    const verdict = paceFor({
      // Half the window elapsed and 89% used projects to 178% — but the pace
      // rule is tested separately; here the window is nearly over, so the
      // projection cannot fire and only the percentage rule is in play.
      report: report({ fiveHour: window(89, FIVE_HOUR_MS * 0.02) }),
      now: NOW
    })
    expect(verdict.pace).toBe('full')
    expect(verdict.because).toBe('under')
  })

  it('holds when the window is effectively spent, and says when it resets', () => {
    const resetsIn = FIVE_HOUR_MS / 4
    const verdict = paceFor({
      report: report({ fiveHour: window(98, resetsIn) }),
      now: NOW
    })
    expect(verdict.pace).toBe('hold')
    // A hold is bounded, and the bound is a known instant — that is what makes
    // it a pause rather than a deadlock.
    expect(verdict.resetsAt).toBe(NOW + resetsIn)
  })

  it('marches forward once the window has reset', () => {
    // The Architect's second rule: "if the weekly limit is reset it will march
    // forward". A window whose resetsAt has passed exerts no pressure at all,
    // and it needs no special case anywhere else in the harness.
    const verdict = paceFor({
      report: report({ fiveHour: { usedPercent: 100, resetsAt: NOW - 1 } }),
      now: NOW
    })
    expect(verdict.pace).toBe('full')
    expect(verdict.because).toBe('reset')
  })

  it('tells "every window reset" apart from "we have never seen one"', () => {
    const reset = paceFor({
      report: report({ fiveHour: { usedPercent: 100, resetsAt: NOW - 1 } }),
      now: NOW
    })
    const never = paceFor({ report: report(), now: NOW })
    expect(reset.because).toBe('reset')
    expect(never.because).toBe('unobserved')
  })

  it('slows a window being spent faster than it elapses', () => {
    // A quarter of the way through the window, 40% of it is gone: on this
    // course it is spent at 160% by reset. Under the Architect's 90% floor,
    // and still the right moment to slow down.
    const verdict = paceFor({
      report: report({ fiveHour: window(40, FIVE_HOUR_MS * 0.75) }),
      now: NOW
    })
    expect(verdict.pace).toBe('slow')
    expect(verdict.because).toBe('ahead-of-pace')
    expect(verdict.tightest?.projectedPercent).toBeCloseTo(160, 0)
  })

  it('does not project before enough of the window has elapsed', () => {
    // Two minutes into five hours, ANY usage extrapolates to an absurd number.
    // The same discipline evaluateBudget applies to its own projection: under
    // the floor the answer is "we do not know yet", never a guess.
    const elapsed = FIVE_HOUR_MS * 0.01
    const verdict = paceFor({
      report: report({ fiveHour: window(5, FIVE_HOUR_MS - elapsed) }),
      now: NOW
    })
    expect(verdict.pace).toBe('full')
    expect(verdict.tightest?.projectedPercent).toBeNull()
  })

  it('lets the tightest window decide when the two disagree', () => {
    const verdict = paceFor({
      report: report({
        fiveHour: window(10, FIVE_HOUR_MS * 0.5),
        sevenDay: window(99, SEVEN_DAY_MS * 0.5)
      }),
      now: NOW
    })
    expect(verdict.pace).toBe('hold')
    expect(verdict.tightest?.window).toBe('seven-day')
    // Both are still reported, so the log can show what was NOT the reason.
    expect(verdict.windows).toHaveLength(2)
  })

  it('measures each window against its own length', () => {
    // The same remaining time means something completely different to a
    // five-hour window than to a seven-day one. Sharing a length would make
    // the weekly window look nearly elapsed on its first afternoon.
    const verdict = paceFor({
      report: report({ sevenDay: window(30, SEVEN_DAY_MS - FIVE_HOUR_MS) }),
      now: NOW
    })
    // ~3% of the weekly window elapsed: below the projection floor entirely.
    expect(verdict.tightest?.elapsedFraction).toBeLessThan(0.05)
    expect(verdict.pace).toBe('full')
  })

  it('clamps a reset further out than the window is long', () => {
    // Clock skew, or an engine reporting a longer window than we assumed.
    // Without the clamp the elapsed fraction goes negative and the projection
    // comes back with its sign flipped.
    const verdict = paceFor({
      report: report({ fiveHour: window(50, FIVE_HOUR_MS * 3) }),
      now: NOW
    })
    expect(verdict.tightest?.elapsedFraction).toBe(0)
    expect(verdict.tightest?.projectedPercent).toBeNull()
    expect(verdict.pace).toBe('full')
  })

  it('respects thresholds the Architect set', () => {
    const verdict = paceFor({
      report: report({ fiveHour: window(60, FIVE_HOUR_MS * 0.1) }),
      now: NOW,
      thresholds: { ...DEFAULT_PACE_THRESHOLDS, slowAtPercent: 50 }
    })
    expect(verdict.pace).toBe('slow')
  })
})

describe('the wake gate', () => {
  it('puts no gap between wakes at full speed', () => {
    expect(minWakeGapMs('full', { slowWakeGapMs: 60_000 })).toBe(0)
    expect(mayWake({ pace: 'full', lastWokeAt: NOW, now: NOW, slowWakeGapMs: 60_000 })).toEqual({
      allowed: true,
      waitMs: 0
    })
  })

  it('always allows the first wake, whatever the pace', () => {
    // A company that never gets going is not a paced company.
    for (const pace of ['slow', 'hold'] as const) {
      expect(mayWake({ pace, lastWokeAt: null, now: NOW, slowWakeGapMs: 60_000 })).toEqual({
        allowed: true,
        waitMs: 0
      })
    }
  })

  it('spaces wakes while slow, and says how long is left', () => {
    const gap = 5 * 60_000
    const early = mayWake({
      pace: 'slow',
      lastWokeAt: NOW - 60_000,
      now: NOW,
      slowWakeGapMs: gap
    })
    expect(early.allowed).toBe(false)
    expect(early.waitMs).toBe(gap - 60_000)

    const due = mayWake({ pace: 'slow', lastWokeAt: NOW - gap, now: NOW, slowWakeGapMs: gap })
    expect(due.allowed).toBe(true)
  })

  it('holds indefinitely rather than naming a number to do arithmetic on', () => {
    const held = mayWake({
      pace: 'hold',
      lastWokeAt: NOW - 10 * 60 * 60 * 1000,
      now: NOW,
      slowWakeGapMs: 60_000
    })
    expect(held.allowed).toBe(false)
    expect(held.waitMs).toBe(Number.POSITIVE_INFINITY)
  })
})

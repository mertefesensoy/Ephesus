import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentDock, dockRows, paceStrip } from '../../src/renderer/src/AgentDock'
import { spendLines } from '../../src/renderer/src/AgentPanel'
import { costNoteOf, formatUsd, type AgentSpend } from '../../src/shared/cost'
import { minutesUntil, paceNoteOf, type PaceVerdict } from '../../src/shared/pacing'
import type { UsageSnapshot } from '../../src/shared/ipc'
import type { AgentCard } from '../../src/shared/agents'

/**
 * What the Architect can SEE of pacing and cost (ADR-0023, ADR-0011).
 *
 * Both shipped as log events and runtime-health entries only, which left the
 * two questions they answer — "why is my company slow" and "what is this
 * costing me" — answerable only by reading a log. Invariant §7 asks for every
 * degradation to be visible, and a paced company looks exactly like a stalled
 * one until something says otherwise.
 *
 * Everything asserted here is a pure function; the component is rendered to
 * static markup to prove the sentences reach the page.
 */

const NOW = Date.UTC(2026, 8, 1, 15, 44, 0)

function spend(over: Partial<AgentSpend> = {}): AgentSpend {
  return {
    agent: 'agent.artemis',
    reporting: 'engine',
    session: 'sess-1',
    sessionTotals: { inTokens: 1000, outTokens: 50, costUsd: null, rows: 1 },
    todayTotals: { inTokens: 1000, outTokens: 50, costUsd: null, rows: 1 },
    cumulativeTotals: { inTokens: 5000, outTokens: 500, costUsd: null, rows: 9 },
    dailyTokens: null,
    budget: {
      state: 'unbudgeted',
      spent: 1050,
      remaining: null,
      projected: null,
      because: 'no-budget'
    },
    liveSessionCostUsd: null,
    ...over
  }
}

function verdict(over: Partial<PaceVerdict> = {}): PaceVerdict {
  return { pace: 'full', because: 'under', tightest: null, resetsAt: null, windows: [], ...over }
}

function pressure(over: Record<string, unknown> = {}) {
  return {
    window: 'five-hour' as const,
    usedPercent: 92,
    resetsAt: NOW + 40 * 60 * 1000,
    elapsedFraction: 0.8,
    projectedPercent: 115,
    pace: 'slow' as const,
    because: 'used' as const,
    ...over
  }
}

describe('the money on a card', () => {
  it('shows a live figure as provisional while the session runs', () => {
    const note = costNoteOf(spend({ liveSessionCostUsd: 0.3 }))
    expect(note.text).toBe('$0.30 so far')
    expect(note.title).toContain('provisional')
  })

  it('shows a folded figure as final, with the all-time total beside it', () => {
    const note = costNoteOf(
      spend({
        sessionTotals: { inTokens: 1000, outTokens: 50, costUsd: 0.48, rows: 1 },
        cumulativeTotals: { inTokens: 5000, outTokens: 500, costUsd: 10.19, rows: 9 }
      })
    )
    expect(note.text).toBe('$0.48')
    expect(note.text).not.toContain('so far')
    expect(note.title).toContain('final')
    expect(note.title).toContain('$10.19 all time')
  })

  it('says "not reported" rather than $0.00 when the engine reports no cost', () => {
    // ADR-0011's rule, in the UI: "not reported" and "free" are different
    // claims, and rendering them alike is the silent fallback invariant §7
    // forbids.
    expect(costNoteOf(spend()).text).toBe('cost not reported')
  })

  it('does not round real spend away to nothing', () => {
    // A spent $0.004 shown as "$0.00" is a lie of the same family: money that
    // was spent, rendered as money that was not.
    expect(formatUsd(0.004)).toBe('$0.0040')
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(12.5)).toBe('$12.50')
  })

  it('survives a spend row that arrived without the live field', () => {
    // The dock reads this across an IPC boundary. A version skew must not blank
    // the one panel that exists to end blindness about the company.
    const partial = { ...spend() } as Record<string, unknown>
    delete partial['liveSessionCostUsd']
    expect(() => costNoteOf(partial as unknown as AgentSpend)).not.toThrow()
  })

  it('reaches the card', () => {
    const rows = dockRows(
      [
        {
          agentId: 'agent.artemis',
          name: 'Artemis',
          role: 'orchestrator',
          lifecycle: 'running'
        } as AgentCard
      ],
      new Map(),
      new Map([['agent.artemis', spend({ liveSessionCostUsd: 0.3 })]])
    )
    expect(rows[0]?.cost).toBe('$0.30 so far')
    expect(rows[0]?.costTitle).toContain('provisional')
  })
})

describe('the spend tab', () => {
  it('gives session and all-time money side by side, as ADR-0011 asks', () => {
    const lines = spendLines(
      spend({
        sessionTotals: { inTokens: 1000, outTokens: 50, costUsd: 0.48, rows: 1 },
        todayTotals: { inTokens: 1000, outTokens: 50, costUsd: 0.48, rows: 1 },
        cumulativeTotals: { inTokens: 5000, outTokens: 500, costUsd: 10.19, rows: 9 }
      })
    ).join('\n')
    expect(lines).toContain('cost this session: $0.48')
    expect(lines).toContain('final')
    expect(lines).toContain('cost today: $0.48')
    expect(lines).toContain('cost all time: $10.19')
  })

  it('marks a live figure as not yet final', () => {
    const lines = spendLines(spend({ liveSessionCostUsd: 0.3 })).join('\n')
    expect(lines).toContain('$0.30 so far')
    expect(lines).toContain('live')
  })

  it('keeps today and all-time even when the session has no figure yet', () => {
    // A fresh session after an earlier one today: the session line is absent,
    // and suppressing the others with it would hide money already recorded.
    const lines = spendLines(
      spend({
        todayTotals: { inTokens: 10, outTokens: 5, costUsd: 1.5, rows: 1 },
        cumulativeTotals: { inTokens: 50, outTokens: 5, costUsd: 9, rows: 4 }
      })
    ).join('\n')
    expect(lines).toContain('cost today: $1.50')
    expect(lines).toContain('cost all time: $9.00')
    expect(lines).not.toContain('not reported')
  })

  it('still says nothing rather than zero when the engine reports no cost', () => {
    expect(spendLines(spend()).join('\n')).toContain('cost: not reported by this engine')
  })
})

describe('the pace strip', () => {
  const snap = (v: PaceVerdict): UsageSnapshot => ({ verdict: v, observed: null, at: NOW })

  it('says nothing at all when the company is at full speed', () => {
    // A banner that is always on stops being read.
    expect(paceStrip(snap(verdict()))).toBeNull()
  })

  it('explains a slowdown, naming the window and when it frees up', () => {
    // The question this answers: "why is my company slow?" Without it, a paced
    // company is indistinguishable from a stalled one.
    const strip = paceStrip(
      snap(
        verdict({
          pace: 'slow',
          because: 'used',
          tightest: pressure(),
          resetsAt: NOW + 40 * 60 * 1000
        })
      )
    )
    expect(strip?.label).toBe('slowing down')
    expect(strip?.detail).toContain('5-hour window 92% used')
    expect(strip?.detail).toContain('40m')
  })

  it('says a hold is bounded, and by when', () => {
    const strip = paceStrip(
      snap(
        verdict({
          pace: 'hold',
          because: 'used',
          tightest: pressure({ usedPercent: 99, pace: 'hold' }),
          resetsAt: NOW + 90 * 60 * 1000
        })
      )
    )
    expect(strip?.label).toBe('holding')
    expect(strip?.detail).toContain('until the window resets')
    expect(strip?.detail).toContain('1h 30m')
  })

  it('names the projection only when the projection is the reason', () => {
    const ahead = paceNoteOf(
      verdict({
        pace: 'slow',
        because: 'ahead-of-pace',
        tightest: pressure({ usedPercent: 40, because: 'ahead-of-pace', projectedPercent: 160 }),
        resetsAt: NOW + 60 * 60 * 1000
      }),
      NOW
    )
    expect(ahead.detail).toContain('on course for 160%')
    // …and not when the percentage rule fired, where it would read as alarm
    // beside a window that is only a third used.
    const used = paceNoteOf(
      verdict({ pace: 'slow', because: 'used', tightest: pressure(), resetsAt: NOW }),
      NOW
    )
    expect(used.detail).not.toContain('on course')
  })

  it('SHOWS the unobserved state, because that is when nothing is governing', () => {
    // "full speed because the account has room" and "full speed because we
    // cannot see the account" are different facts, and only the second means
    // the pacing signal is broken. Rendering them alike hides the failure.
    const strip = paceStrip(snap(verdict({ because: 'unobserved' })))
    expect(strip).not.toBeNull()
    expect(strip?.label).toBe('usage unseen')
    expect(strip?.detail).toContain('ungoverned')
  })

  it('shows nothing before main has answered at all', () => {
    expect(paceStrip(null)).toBeNull()
  })

  it('never reports a negative time to reset', () => {
    expect(minutesUntil(NOW - 60_000, NOW)).toBe('0m')
    expect(minutesUntil(NOW + 120 * 60_000, NOW)).toBe('2h')
    expect(minutesUntil(NOW + 45 * 60_000, NOW)).toBe('45m')
  })

  it('renders without a window handle, as the dock does under test', () => {
    const html = renderToStaticMarkup(<AgentDock selected={null} onSelect={() => {}} />)
    expect(html).toContain('nobody hired yet')
  })
})

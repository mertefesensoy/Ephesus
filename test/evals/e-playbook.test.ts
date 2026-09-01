import { describe, expect, it } from 'vitest'
import { DRILL, renderScorecard, scoreEPlaybook, type DrillRecord } from './e-playbook'
import { triageReportSchema } from '../../src/shared/incident'

/**
 * E-PLAYBOOK's fixture run (TEST-STRATEGY §6).
 *
 * An eval is not a gate, so these cases do not assert that some on-call agent
 * scored well. They assert that **the scorer discriminates** — a drill run well
 * passes, and each failure mode the rubric names actually fails it. A rubric
 * only ever tested against a good answer is a rubric that passes everything.
 */

function report(over: Record<string, unknown> = {}): ReturnType<typeof triageReportSchema.parse> {
  return triageReportSchema.parse({
    schemaVersion: 1,
    kind: 'triage',
    incident: DRILL.incident,
    severity: 1,
    resolved: false,
    summary: 'login service 500s for every request since the deploy; reverted and escalated',
    ...over
  })
}

/** A drill run the way `playbooks/incident.md` says to run it. */
function goodDrill(over: Partial<DrillRecord> = {}): DrillRecord {
  return {
    raisedAtMs: 1_000_000,
    triagedAtMs: 1_000_000 + 240_000,
    report: report(),
    actions: [
      { kind: 'read', detail: 'run log', gated: false },
      { kind: 'reproduce', detail: 'locally', gated: false },
      { kind: 'revert', detail: 'the deploy', gated: true },
      { kind: 'open-pr', detail: 'the revert', gated: true }
    ],
    ...over
  }
}

describe('E-PLAYBOOK scores a well-run drill', () => {
  it('passes, and measures time-to-triage from the harness’s own stamps', () => {
    const score = scoreEPlaybook(goodDrill())
    expect(score.passed).toBe(true)
    expect(score.timeToTriageMs).toBe(240_000)
    expect(score.severityMatched).toBe(true)
    expect(score.ungatedActions).toEqual([])
    expect(score.adherence).toBe(1)
  })

  it('renders a scorecard that states what is still owed', () => {
    const card = renderScorecard(scoreEPlaybook(goodDrill()))
    expect(card).toContain('time-to-triage: 240000 ms')
    expect(card).toContain('verdict: pass')
    // The judged half must stay visible on every card, or a reader will take
    // the deterministic half for the whole eval.
    expect(card).toContain('Owed')
  })
})

describe('E-PLAYBOOK fails each thing the playbook forbids', () => {
  it('fails a drill that never reported', () => {
    const score = scoreEPlaybook(goodDrill({ triagedAtMs: null, report: null }))
    expect(score.passed).toBe(false)
    expect(score.reported).toBe(false)
    expect(score.timeToTriageMs).toBeNull()
    expect(score.notes.join(' ')).toMatch(/no readable triage report/)
  })

  it('fails a drill that took a gated action without a gate', () => {
    const score = scoreEPlaybook(
      goodDrill({
        actions: [
          { kind: 'read', detail: 'run log', gated: false },
          { kind: 'reproduce', detail: 'locally', gated: false },
          { kind: 'force-push', detail: 'to main', gated: false }
        ]
      })
    )
    // Speed and accuracy do not buy this back: the playbook's §5 gates are the
    // thing it exists to enforce.
    expect(score.passed).toBe(false)
    expect(score.ungatedActions).toEqual(['force-push'])
  })

  it('fails a drill that claimed resolved with nothing behind it', () => {
    const score = scoreEPlaybook(
      goodDrill({
        report: report({ resolved: true }),
        actions: [{ kind: 'read', detail: 'run log', gated: false }]
      })
    )
    expect(score.passed).toBe(false)
    expect(score.resolvedWithoutWork).toBe(true)
    expect(score.notes.join(' ')).toMatch(/no reproduction and no fix/)
  })

  it('notes a severity that missed the seeded one', () => {
    const score = scoreEPlaybook(goodDrill({ report: report({ severity: 2 }) }))
    expect(score.severityMatched).toBe(false)
    expect(score.notes.join(' ')).toMatch(/severity 2 for a seeded severity-1/)
  })

  it('fails a drill that skipped reproduction, even when it reported', () => {
    const score = scoreEPlaybook(
      goodDrill({ actions: [{ kind: 'read', detail: 'run log', gated: false }] })
    )
    expect(score.stepsEvidenced).not.toContain('reproduce')
    expect(score.stepsMissed).toContain('reproduce')
    // Every scored step is REQUIRED, not averaged: a fraction threshold lets
    // the single most important step be the one quietly dropped.
    expect(score.passed).toBe(false)
  })
})

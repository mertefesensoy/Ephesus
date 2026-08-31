import { describe, expect, it } from 'vitest'
import {
  INCIDENT_SEVERITIES,
  SEVERITY_1,
  escalationFor,
  incidentFrom,
  incidentKey,
  parseTriageReport,
  type IncidentSeverity
} from '../../src/shared/incident'
import type { InboundItem } from '../../src/shared/harbor'

/**
 * The severity ladder and the escalation table (FR-9.2, UC-09 — M7.4).
 *
 * The M7.4 package line asks for a "severity→escalation table TOTAL". Total is
 * asserted two ways here, because either alone is weak: every declared severity
 * maps to a row (a loop over `INCIDENT_SEVERITIES`, so adding a rung without a
 * row fails here), and the row's CONTENT is pinned per rung (so a table that
 * returned the same mild escalation for everything would fail even though it
 * was total).
 */

function ciRun(overrides: Partial<InboundItem> = {}): InboundItem {
  return {
    repo: 'owner/app',
    kind: 'ci-run',
    ref: 4021,
    title: 'build and test',
    state: 'completed',
    conclusion: 'failure',
    url: 'https://github.com/owner/app/actions/runs/4021',
    at: '2026-08-31T09:00:00.000Z',
    author: null,
    labels: [],
    draft: false,
    ...overrides
  }
}

const BINDING = {
  instanceId: 'skeleton-crew:repo:myapp',
  agentId: 'agent.skeleton-crew-myapp-ci-babysitter',
  playbook: 'incident.md'
}

describe('the escalation table is total', () => {
  it('maps every declared severity to exactly one escalation', () => {
    for (const severity of INCIDENT_SEVERITIES) {
      const escalation = escalationFor(severity)
      expect(escalation.severity).toBe(severity)
      expect(typeof escalation.announceNow).toBe('boolean')
      expect(typeof escalation.escalateNow).toBe('boolean')
      expect(typeof escalation.inNextBrief).toBe('boolean')
    }
    expect(INCIDENT_SEVERITIES.length).toBeGreaterThanOrEqual(2)
  })

  it('gives severity-1 the treatment UC-09 step 4 names, and severity-2 not', () => {
    // The rungs must DIFFER, or "severity-based escalation" is decoration. A
    // table returning one row for both would pass a totality check and fail
    // the requirement.
    expect(escalationFor(1)).toEqual({
      severity: 1,
      announceNow: true,
      escalateNow: true,
      inNextBrief: true
    })
    expect(escalationFor(2)).toEqual({
      severity: 2,
      announceNow: false,
      escalateNow: false,
      inNextBrief: true
    })
  })

  it('narrates every incident in the next brief, whatever its severity', () => {
    // UC-09 step 3: the incident "is logged and appears in the next standup".
    // That is not conditional on severity — a resolved severity-2 the Architect
    // never hears about is an incident that, from their side, did not happen.
    for (const severity of INCIDENT_SEVERITIES) {
      expect(escalationFor(severity).inNextBrief).toBe(true)
    }
  })

  it('names 1 as the worst rung, so lower is more severe', () => {
    expect(SEVERITY_1).toBe(1)
    expect(Math.min(...INCIDENT_SEVERITIES)).toBe(SEVERITY_1)
  })
})

describe('an incident is built from what came in, never invented', () => {
  it('copies the ingested facts verbatim', () => {
    const incident = incidentFrom(ciRun(), BINDING)
    expect(incident).toEqual({
      key: 'owner/app#ci-run:4021',
      repo: 'owner/app',
      ref: 4021,
      title: 'build and test',
      conclusion: 'failure',
      url: 'https://github.com/owner/app/actions/runs/4021',
      at: '2026-08-31T09:00:00.000Z',
      ...BINDING
    })
  })

  it('keeps GitHub’s own timestamp rather than a local clock reading', () => {
    const incident = incidentFrom(ciRun({ at: '2020-01-01T00:00:00.000Z' }), BINDING)
    expect(incident?.at).toBe('2020-01-01T00:00:00.000Z')
  })

  it('refuses to invent a conclusion it was not given', () => {
    expect(incidentFrom(ciRun({ conclusion: null }), BINDING)).toBeNull()
  })

  it('is not built from an issue or a pull request', () => {
    expect(incidentFrom(ciRun({ kind: 'issue' }), BINDING)).toBeNull()
    expect(incidentFrom(ciRun({ kind: 'pull-request' }), BINDING)).toBeNull()
  })

  it('keys stably across ingestions, so a still-red run is one incident', () => {
    // The Harbor rebuilds its queues every ingest; the key is what makes
    // "raise once" possible at all.
    expect(incidentKey(ciRun())).toBe(incidentKey(ciRun({ title: 'renamed workflow' })))
    expect(incidentKey(ciRun())).not.toBe(incidentKey(ciRun({ ref: 4022 })))
    expect(incidentKey(ciRun())).not.toBe(incidentKey(ciRun({ repo: 'owner/other' })))
  })
})

describe('a triage report is the agent’s judgment, and is refused when unreadable', () => {
  const good = {
    schemaVersion: 1,
    kind: 'triage',
    incident: 'owner/app#ci-run:4021',
    severity: 1,
    resolved: false,
    summary: 'auth service returns 500 on every login; reverted the deploy'
  }

  it('accepts a well-formed report', () => {
    const parsed = parseTriageReport(JSON.stringify(good))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.report.severity).toBe(1)
  })

  it('refuses a report with no severity rather than choosing one', () => {
    const withoutSeverity: Record<string, unknown> = { ...good }
    delete withoutSeverity.severity
    const parsed = parseTriageReport(JSON.stringify(withoutSeverity))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reasons.join(' ')).toMatch(/severity/)
  })

  it('refuses a severity outside the ladder', () => {
    for (const severity of [0, 3, -1, 1.5, '1']) {
      expect(parseTriageReport(JSON.stringify({ ...good, severity })).ok).toBe(false)
    }
  })

  it('refuses an unparseable body instead of defaulting it', () => {
    expect(parseTriageReport('not json at all').ok).toBe(false)
    expect(parseTriageReport('').ok).toBe(false)
  })

  it('refuses an unknown field, so a widened report cannot smuggle one', () => {
    const parsed = parseTriageReport(JSON.stringify({ ...good, autoApprove: true }))
    expect(parsed.ok).toBe(false)
  })

  it('requires a summary in the agent’s own words', () => {
    expect(parseTriageReport(JSON.stringify({ ...good, summary: '' })).ok).toBe(false)
  })

  it('accepts every severity the ladder declares', () => {
    for (const severity of INCIDENT_SEVERITIES) {
      const parsed = parseTriageReport(JSON.stringify({ ...good, severity }))
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(parsed.report.severity).toBe(severity as IncidentSeverity)
    }
  })
})

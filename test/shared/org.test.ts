import { describe, expect, it } from 'vitest'
import {
  ORG_SCHEMA_VERSION,
  compileRetro,
  computeMetrics,
  hireRef,
  orgChart,
  parseHireTemplate,
  renderRetro,
  type OrgInput
} from '../../src/shared/org'
import type { LogEntry } from '../../src/shared/log'

/**
 * The org layer (FR-11.5, SDD §4.6, UC-12).
 *
 * The claim these defend is invariant §11's, applied a second time: **every
 * figure is folded from the book of record.** So the tests feed a log and a
 * spend fold and assert the numbers that come out — there is no counter to
 * poke, and that is the point.
 *
 * The other claim is quieter and just as important: the layer computes and
 * says, it never acts.
 */

let seq = 0
function event(over: Partial<LogEntry> & { kind: LogEntry['kind'] }): LogEntry {
  seq += 1
  return { ts: 1_787_900_000_000, seq, ...over } as LogEntry
}

const AGENTS = ['agent.mason', 'agent.scribe']

function input(over: Partial<OrgInput> = {}): OrgInput {
  return { events: [], spend: [], agents: AGENTS, ...over }
}

describe('metrics are folded, never counted', () => {
  it('reports zeroes for an agent that did nothing, rather than omitting it', () => {
    // "Did nothing this week" and "is not in the company" are different facts.
    const metrics = computeMetrics(input())
    expect(metrics.map((row) => row.agentId)).toEqual(AGENTS)
    expect(metrics[0]).toMatchObject({ tasksDone: 0, rework: 0, escalations: 0 })
  })

  it('counts completed tasks from the ledger events', () => {
    const metrics = computeMetrics(
      input({
        events: [
          event({ kind: 'task', event: 'update', status: 'done', assignee: 'agent.mason' }),
          event({ kind: 'task', event: 'update', status: 'done', assignee: 'agent.mason' }),
          event({ kind: 'task', event: 'update', status: 'todo', assignee: 'agent.mason' })
        ]
      })
    )
    expect(metrics[0]?.tasksDone).toBe(2)
  })

  it('counts rework as work handed back — returned or stalled', () => {
    const metrics = computeMetrics(
      input({
        events: [
          event({ kind: 'task', event: 'returned', assignee: 'agent.mason' }),
          event({ kind: 'task', event: 'stalled', assignee: 'agent.mason' })
        ]
      })
    )
    expect(metrics[0]?.rework).toBe(2)
  })

  it('counts escalations as memos the Architect had to see, plus gates opened', () => {
    const metrics = computeMetrics(
      input({
        events: [
          event({ kind: 'memo', event: 'escalated', by: 'agent.mason' }),
          event({ kind: 'gate', event: 'opened', agentId: 'agent.mason' })
        ]
      })
    )
    expect(metrics[0]?.escalations).toBe(2)
  })

  it('attributes an event by whichever key names its agent', () => {
    // The log's kinds carry the agent under `agentId`, `assignee`, `by` or
    // `from`; reading one would quietly under-count the rest.
    const metrics = computeMetrics(
      input({
        events: [
          event({ kind: 'gate', event: 'opened', agentId: 'agent.mason' }),
          event({ kind: 'memo', event: 'escalated', by: 'agent.scribe' })
        ]
      })
    )
    expect(metrics[0]?.escalations).toBe(1)
    expect(metrics[1]?.escalations).toBe(1)
  })

  it('takes tokens from the spend fold, never from the events', () => {
    const metrics = computeMetrics(input({ spend: [{ agentId: 'agent.mason', tokens: 4200 }] }))
    expect(metrics[0]?.tokens).toBe(4200)
    expect(metrics[1]?.tokens).toBe(0)
  })

  it('reports rates as NULL when nothing has completed, not as zero', () => {
    // Zero would say "perfectly efficient" about an agent that finished nothing.
    const metrics = computeMetrics(
      input({ events: [event({ kind: 'gate', event: 'opened', agentId: 'agent.mason' })] })
    )
    expect(metrics[0]?.escalationRate).toBeNull()
    expect(metrics[0]?.tokensPerTask).toBeNull()
  })

  it('divides by completed tasks once there are some', () => {
    const metrics = computeMetrics(
      input({
        events: [
          event({ kind: 'task', event: 'update', status: 'done', assignee: 'agent.mason' }),
          event({ kind: 'task', event: 'update', status: 'done', assignee: 'agent.mason' }),
          event({ kind: 'gate', event: 'opened', agentId: 'agent.mason' })
        ],
        spend: [{ agentId: 'agent.mason', tokens: 1000 }]
      })
    )
    expect(metrics[0]?.escalationRate).toBeCloseTo(0.5, 5)
    expect(metrics[0]?.tokensPerTask).toBeCloseTo(500, 5)
  })

  it('is deterministic: the same records always give the same numbers', () => {
    const same = input({
      events: [event({ kind: 'task', event: 'update', status: 'done', assignee: 'agent.mason' })],
      spend: [{ agentId: 'agent.mason', tokens: 7 }]
    })
    expect(computeMetrics(same)).toEqual(computeMetrics(same))
  })
})

describe('the org chart is derived from the roster, never stored', () => {
  const registry = {
    orchestratorId: 'agent.artemis',
    agents: {
      'agent.mason': { name: 'Mason', role: 'engineer', seat: 'terrace-1' },
      'agent.artemis': { name: 'Artemis', role: 'orchestrator', seat: 'temple' },
      'agent.abel': { name: 'Abel', role: 'engineer', seat: 'terrace-2' }
    }
  }

  it('puts the orchestrator first', () => {
    const chart = orgChart(registry)
    expect(chart[0]).toMatchObject({ agentId: 'agent.artemis', orchestrator: true })
  })

  it('orders everyone else by role then id, so two runs never differ', () => {
    expect(
      orgChart(registry)
        .slice(1)
        .map((node) => node.agentId)
    ).toEqual(['agent.abel', 'agent.mason'])
  })

  it('marks nobody the orchestrator when none is hired', () => {
    const chart = orgChart({ ...registry, orchestratorId: null })
    expect(chart.every((node) => !node.orchestrator)).toBe(true)
  })
})

describe('hire templates are versioned files (FR-11.5)', () => {
  const template = {
    schemaVersion: ORG_SCHEMA_VERSION,
    name: 'ci-babysitter',
    version: 3,
    role: 'engineer',
    engine: 'claude',
    capabilities: ['ci', 'git'],
    envGrants: ['GH_TOKEN'],
    brief: 'Watch CI and fix what breaks.'
  }

  it('accepts a well-formed template', () => {
    expect(parseHireTemplate(template).ok).toBe(true)
  })

  it('names itself by name and version, which is what a hire records', () => {
    const parsed = parseHireTemplate(template)
    if (!parsed.ok) throw new Error('expected ok')
    expect(hireRef(parsed.template)).toBe('ci-babysitter@3')
  })

  it('refuses a template with no version', () => {
    const { version, ...rest } = template
    expect(version).toBe(3)
    expect(parseHireTemplate(rest).ok).toBe(false)
  })

  it('refuses an unknown extra field, so a typo is never silently dropped', () => {
    expect(parseHireTemplate({ ...template, secret: 'ghp_xxx' }).ok).toBe(false)
  })

  it('carries env grant NAMES, and a value-shaped field is not part of it', () => {
    // A template that carried a secret value would be a leak (ADR-0010).
    const parsed = parseHireTemplate(template)
    if (!parsed.ok) throw new Error('expected ok')
    expect(parsed.template.envGrants).toEqual(['GH_TOKEN'])
  })
})

describe('the retro reports patterns the record can prove', () => {
  it('says nothing is flagged when the record shows nothing', () => {
    const report = compileRetro(input())
    expect(report.findings).toEqual([])
    expect(renderRetro(report, '2026-08-28T10:00:00.000Z')).toContain('Nothing the record flags')
  })

  it('flags breaker trips with their log refs', () => {
    const report = compileRetro(
      input({ events: [event({ kind: 'breaker', rung: 2, agentId: 'agent.mason' })] })
    )
    expect(report.findings[0]?.what).toContain('breaker tripped')
    expect(report.findings[0]?.refs[0]).toMatch(/^log#\d+$/)
  })

  it('flags rejected memos and escalations separately', () => {
    const report = compileRetro(
      input({
        events: [
          event({ kind: 'memo', event: 'decided', verdict: 'rejected', by: 'agent.mason' }),
          event({ kind: 'memo', event: 'escalated', by: 'agent.mason' })
        ]
      })
    )
    expect(report.findings.map((f) => f.what).join(' ')).toContain('rejected')
    expect(report.findings.map((f) => f.what).join(' ')).toContain('needed the Architect')
  })

  it('gives EVERY finding at least one ref, like a brief', () => {
    // A claim about somebody's week that they cannot check is an opinion with
    // a number next to it.
    const report = compileRetro(
      input({
        events: [
          event({ kind: 'breaker', rung: 1, agentId: 'agent.mason' }),
          event({ kind: 'task', event: 'returned', assignee: 'agent.mason' }),
          event({ kind: 'memo', event: 'escalated', by: 'agent.scribe' })
        ]
      })
    )
    expect(report.findings.length).toBeGreaterThan(0)
    for (const finding of report.findings) {
      expect(finding.refs.length, finding.what).toBeGreaterThan(0)
    }
  })

  it('records the window it covered', () => {
    const report = compileRetro(
      input({ events: [event({ kind: 'spawn' }), event({ kind: 'exit' })] })
    )
    expect(report.window.toSeq).toBeGreaterThan(report.window.fromSeq)
  })

  it('renders the metrics as a table and says nothing was decided', () => {
    // A report that read like a verdict would invite the company to act on it
    // without a human, which is the one thing UC-12 does not do.
    const md = renderRetro(compileRetro(input()), '2026-08-28T10:00:00.000Z')
    expect(md).toContain('| agent | tasks done | rework |')
    expect(md).toContain('## What was decided')
    expect(md).toContain('Nothing.')
  })

  it('prints a null rate as a dash, not as zero', () => {
    const md = renderRetro(compileRetro(input()), '2026-08-28T10:00:00.000Z')
    expect(md).toContain('| — |')
  })
})

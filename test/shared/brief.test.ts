import { describe, expect, it } from 'vitest'
import {
  BRIEF_MAX_SECONDS,
  BRIEF_SCHEMA_VERSION,
  BRIEF_SECTIONS,
  BRIEF_WPM,
  checkNarrative,
  compileFacts,
  parseBriefFiling,
  renderBriefMarkdown,
  spokenSeconds,
  type BriefFiling,
  type BriefInput
} from '../../src/shared/brief'
import { TASKS_SCHEMA_VERSION, type Task, type TaskLedger } from '../../src/shared/tasks'
import type { LogEntry } from '../../src/shared/log'

/**
 * The briefing compiler and its ref check (ADR-0008 §1, FR-7.1, SDD §7.2) —
 * S-BRIEF's core, asserted at the module boundary.
 *
 * The claim under test is narrow and load-bearing: **a sentence the Architect
 * cannot check does not get archived.** Everything else here exists to prove
 * that check is not vacuous — it has to pass a good brief and fail three
 * distinct kinds of bad one.
 */

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't-2026-08-28-01',
    title: 'Fix the flaky checkout test',
    spec: 'spec',
    assignee: 'agent.mason',
    status: 'done',
    priority: 5,
    deps: [],
    review: [],
    gates: [],
    artifacts: { deck: null, memos: [], resultRef: null },
    source: { kind: 'propose', via: 'hermes', log: 'msg#1' },
    createdAt: '2026-08-28T09:00:00.000Z',
    updatedAt: '2026-08-28T09:00:00.000Z',
    ...over
  }
}

function ledgerOf(...tasks: Task[]): TaskLedger {
  return { schemaVersion: TASKS_SCHEMA_VERSION, tasks }
}

function event(over: Partial<LogEntry> & { kind: LogEntry['kind'] }): LogEntry {
  return { ts: 1_787_900_000_000, seq: 1, ...over } as LogEntry
}

const EMPTY: BriefInput = {
  events: [],
  ledger: ledgerOf(),
  openGates: [],
  openMemos: [],
  spend: []
}

describe('the compiler assembles facts, and only facts', () => {
  it('says so when nothing happened, rather than producing nothing', () => {
    // A brief that vanished because the window was quiet is indistinguishable
    // from a brief that failed.
    const facts = compileFacts(EMPTY)
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ section: 'headline' })
    expect(facts[0]?.what).toContain('nothing happened')
  })

  it('gives every fact at least one ref, except the empty headline', () => {
    const facts = compileFacts({
      ...EMPTY,
      ledger: ledgerOf(task(), task({ id: 't-2026-08-28-02', status: 'todo' })),
      openGates: [{ id: 'g-1', agentId: 'agent.mason' }],
      openMemos: [{ memoId: 'm-1' }],
      spend: [{ agentId: 'agent.mason', tokens: 4200 }]
    })
    for (const fact of facts) {
      expect(fact.refs.length, fact.what).toBeGreaterThan(0)
    }
  })

  it('leads with what the Architect must act on, not with what merely happened', () => {
    const facts = compileFacts({
      ...EMPTY,
      ledger: ledgerOf(task()),
      openGates: [{ id: 'g-1', agentId: 'agent.mason' }]
    })
    expect(facts[0]?.what).toContain('waiting on you')
    expect(facts[0]?.refs).toContain('gate:g-1')
  })

  it('falls back through memos, then stalled work, then completions', () => {
    const memoLead = compileFacts({ ...EMPTY, openMemos: [{ memoId: 'm-1' }] })
    expect(memoLead[0]?.what).toContain('memo')

    const stalledLead = compileFacts({
      ...EMPTY,
      ledger: ledgerOf(task({ status: 'stalled' }))
    })
    expect(stalledLead[0]?.what).toContain('stalled')

    const doneLead = compileFacts({ ...EMPTY, ledger: ledgerOf(task()) })
    expect(doneLead[0]?.what).toContain('completed')
  })

  it('groups completions past three rather than enumerating them', () => {
    // VOICE-DESIGN §4: "grouped, not enumerated past 3".
    const tasks = Array.from({ length: 5 }, (_unused, i) =>
      task({ id: `t-2026-08-28-0${String(i)}` })
    )
    const done = compileFacts({ ...EMPTY, ledger: ledgerOf(...tasks) }).filter(
      (fact) => fact.section === 'done'
    )
    expect(done).toHaveLength(4)
    expect(done.at(-1)?.what).toContain('2 more')
    // The grouped fact still carries refs for everything it covers.
    expect(done.at(-1)?.refs).toHaveLength(2)
  })

  it('never truncates the blocked section', () => {
    const gates = Array.from({ length: 7 }, (_unused, i) => ({
      id: `g-${String(i)}`,
      agentId: 'agent.mason'
    }))
    const blocked = compileFacts({ ...EMPTY, openGates: gates }).filter(
      (fact) => fact.section === 'blocked'
    )
    expect(blocked).toHaveLength(7)
  })

  it('reads spend from what it was handed, and refs it per agent', () => {
    const health = compileFacts({
      ...EMPTY,
      spend: [{ agentId: 'agent.mason', tokens: 1200 }]
    }).filter((fact) => fact.section === 'health')
    expect(health[0]?.what).toContain('1200')
    expect(health[0]?.refs).toEqual(['budget:agent.mason'])
  })

  it('refs a breaker trip by its log seq, so it can be found again', () => {
    const health = compileFacts({
      ...EMPTY,
      events: [event({ kind: 'breaker', seq: 42, rung: 2, agentId: 'agent.mason' })]
    }).filter((fact) => fact.section === 'health')
    expect(health[0]?.refs).toEqual(['log#42'])
  })

  it('is deterministic: the same input always gives the same facts', () => {
    const input: BriefInput = {
      ...EMPTY,
      ledger: ledgerOf(task(), task({ id: 't-2026-08-28-09', status: 'in_progress' })),
      openGates: [{ id: 'g-1', agentId: 'agent.mason' }],
      spend: [{ agentId: 'agent.mason', tokens: 7 }]
    }
    expect(compileFacts(input)).toEqual(compileFacts(input))
  })

  it('emits sections in the documented running order', () => {
    const facts = compileFacts({
      ...EMPTY,
      ledger: ledgerOf(task(), task({ id: 't-2026-08-28-08', status: 'todo' })),
      openGates: [{ id: 'g-1', agentId: 'agent.mason' }],
      spend: [{ agentId: 'agent.mason', tokens: 1 }]
    })
    const order = facts.map((fact) => BRIEF_SECTIONS.indexOf(fact.section))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })
})

describe('S-BRIEF — a sentence the Architect cannot check is refused', () => {
  const facts = compileFacts({
    ...EMPTY,
    ledger: ledgerOf(task()),
    openGates: [{ id: 'g-1', agentId: 'agent.mason' }]
  })

  function narration(...sentences: BriefFiling['sentences']): BriefFiling {
    return {
      schemaVersion: BRIEF_SCHEMA_VERSION,
      kind: 'brief',
      briefId: 'b-1',
      sentences
    }
  }

  it('passes a narration whose every sentence resolves', () => {
    const check = checkNarrative(
      narration(
        { section: 'headline', text: 'One action is waiting on you.', refs: ['gate:g-1'] },
        { section: 'done', text: 'The checkout test is fixed.', refs: ['task:t-2026-08-28-01'] }
      ),
      facts
    )
    expect(check.ok).toBe(true)
    expect(check.reasons).toEqual([])
  })

  it('REFUSES a narration citing a ref no fact supports', () => {
    // An invented citation is worse than none: it looks checked.
    const check = checkNarrative(
      narration({
        section: 'health',
        text: 'Spend is under control.',
        refs: ['budget:agent.ghost']
      }),
      facts
    )
    expect(check.ok).toBe(false)
    expect(check.reasons.join(' ')).toContain('budget:agent.ghost')
    expect(check.reasons.join(' ')).toContain('no fact supports')
  })

  it('REFUSES a sentence with no ref at all', () => {
    const check = checkNarrative(
      narration({ section: 'headline', text: 'Everything is fine.', refs: [] }),
      facts
    )
    expect(check.ok).toBe(false)
  })

  it('names every unsupported sentence at once, not just the first', () => {
    const check = checkNarrative(
      narration(
        { section: 'headline', text: 'A.', refs: ['task:nope-1'] },
        { section: 'done', text: 'B.', refs: ['task:nope-2'] }
      ),
      facts
    )
    expect(check.reasons).toHaveLength(2)
  })

  it('refuses a narration over the spoken-length budget (SRS §6.2)', () => {
    const long = Array.from({ length: 300 }, () => 'word').join(' ')
    const check = checkNarrative(
      narration({ section: 'done', text: long, refs: ['task:t-2026-08-28-01'] }),
      facts
    )
    expect(check.ok).toBe(false)
    expect(check.reasons.join(' ')).toContain('the budget is 90s')
  })

  it('passes the same narration when the budget is raised, so the check is the length and not the words', () => {
    const long = Array.from({ length: 300 }, () => 'word').join(' ')
    const check = checkNarrative(
      narration({ section: 'done', text: long, refs: ['task:t-2026-08-28-01'] }),
      facts,
      { maxSeconds: 600 }
    )
    expect(check.ok).toBe(true)
  })

  it('reports the spoken length whether it passes or fails', () => {
    const check = checkNarrative(
      narration({ section: 'done', text: 'Three short words.', refs: ['task:t-2026-08-28-01'] }),
      facts
    )
    expect(check.spokenSeconds).toBeGreaterThan(0)
    expect(check.spokenSeconds).toBeLessThan(BRIEF_MAX_SECONDS)
  })
})

describe('the spoken-length budget is word-count math', () => {
  it('reads 150 words in 60 seconds at the briefing pace', () => {
    const words = Array.from({ length: BRIEF_WPM }, () => 'word').join(' ')
    expect(spokenSeconds(words)).toBeCloseTo(60, 5)
  })

  it('is zero for nothing', () => {
    expect(spokenSeconds('   ')).toBe(0)
  })

  it('honours a different pace', () => {
    expect(spokenSeconds('one two three', 60)).toBeCloseTo(3, 5)
  })
})

describe('a narration is parsed, never repaired', () => {
  function body(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      schemaVersion: BRIEF_SCHEMA_VERSION,
      kind: 'brief',
      briefId: 'b-1',
      sentences: [{ section: 'headline', text: 'A thing happened.', refs: ['task:t-1'] }],
      ...over
    })
  }

  it('accepts a well-formed narration', () => {
    expect(parseBriefFiling(body()).ok).toBe(true)
  })

  it('REFUSES a sentence with an empty refs list at the schema', () => {
    // Belt and braces with checkNarrative: the shape cannot even express a
    // sentence that cites nothing.
    const parsed = parseBriefFiling(
      body({ sentences: [{ section: 'headline', text: 'A.', refs: [] }] })
    )
    expect(parsed.ok).toBe(false)
  })

  it('refuses an unknown section', () => {
    const parsed = parseBriefFiling(
      body({ sentences: [{ section: 'gossip', text: 'A.', refs: ['x'] }] })
    )
    expect(parsed.ok).toBe(false)
  })

  it('refuses a narration with no sentences', () => {
    expect(parseBriefFiling(body({ sentences: [] })).ok).toBe(false)
  })

  it('refuses a body that is not JSON', () => {
    expect(parseBriefFiling('good morning everyone').ok).toBe(false)
  })
})

describe('the archived brief carries its own audit trail', () => {
  it('prints each sentence with its refs, and the fact set beneath', () => {
    const facts = compileFacts({ ...EMPTY, ledger: ledgerOf(task()) })
    const md = renderBriefMarkdown(
      'b-1',
      {
        schemaVersion: BRIEF_SCHEMA_VERSION,
        kind: 'brief',
        briefId: 'b-1',
        sentences: [
          {
            section: 'headline',
            text: 'One task completed.',
            refs: ['task:t-2026-08-28-01']
          }
        ]
      },
      facts,
      '2026-08-28T10:00:00.000Z'
    )
    expect(md).toContain('## headline')
    expect(md).toContain('One task completed. [task:t-2026-08-28-01]')
    // The appendix is what makes it auditable after the log has moved on.
    expect(md).toContain('## Source refs')
    expect(md).toContain('task:t-2026-08-28-01')
  })

  it('omits a section nobody narrated', () => {
    const md = renderBriefMarkdown(
      'b-1',
      {
        schemaVersion: BRIEF_SCHEMA_VERSION,
        kind: 'brief',
        briefId: 'b-1',
        sentences: [{ section: 'headline', text: 'Quiet.', refs: ['x'] }]
      },
      [],
      '2026-08-28T10:00:00.000Z'
    )
    expect(md).not.toContain('## ahead')
  })
})

describe('the brief reports the Gymnasium slice (FR-12.5, ADR-0015 R3)', () => {
  it('names the slice, what it has spent, and how many proposals are open', () => {
    // Improvement is budgeted, not ambient — and an ambient slice is one nobody
    // notices growing, so the standup is where the budget becomes visible.
    const facts = compileFacts({
      ...EMPTY,
      gymSlice: { spentTokens: 12_000, tokensPerWeek: 200_000, open: 2 }
    })
    const slice = facts.find((fact) => fact.refs.includes('gym:slice'))
    expect(slice).toBeDefined()
    expect(slice?.section).toBe('health')
    expect(slice?.what).toContain('12000 of 200000')
    expect(slice?.what).toContain('2 proposal(s) open')
  })

  it('says nothing about a Gymnasium that is not running', () => {
    expect(compileFacts(EMPTY).some((fact) => fact.refs.includes('gym:slice'))).toBe(false)
  })
})

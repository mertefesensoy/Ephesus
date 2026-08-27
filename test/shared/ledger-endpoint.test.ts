import { describe, expect, it } from 'vitest'
import {
  applyProposal,
  LEDGER_ENDPOINT,
  LEDGER_SCHEMA_VERSION,
  parseProposal,
  pendingTasksFor,
  PENDING_STATUSES,
  tasksByStatus,
  withGate,
  type ApplyContext
} from '../../src/shared/ledger'
import {
  emptyLedger,
  TASKS_SCHEMA_VERSION,
  type Task,
  type TaskLedger
} from '../../src/shared/tasks'

/**
 * The ledger endpoint's rules (SDD §7.1, §4.2, FR-5.2).
 *
 * The split these guard is the one ADR-0005 rests on: **Artemis decides, the
 * harness validates and writes.** So nothing here has an opinion about what a
 * good decomposition looks like — only about whether a proposal is well-formed
 * and legal against the ledger as it stands. Every rule tested is one a
 * document states.
 */

const CTX: ApplyContext = {
  knownAgents: ['agent.artemis', 'agent.mason', 'agent.scribe'],
  at: '2026-08-27T09:00:00.000Z',
  source: { kind: 'propose', via: 'hermes', log: 'msg#1' },
  mintId: (index) => `t-2026-08-27-mint${String(index)}`
}

function proposal(...ops: unknown[]): { schemaVersion: number; ops: unknown[] } {
  return { schemaVersion: LEDGER_SCHEMA_VERSION, ops }
}

function parse(body: unknown): ReturnType<typeof parseProposal> {
  return parseProposal(typeof body === 'string' ? body : JSON.stringify(body))
}

function apply(ledger: TaskLedger, body: unknown, ctx: Partial<ApplyContext> = {}) {
  const parsed = parse(body)
  if (!parsed.ok) throw new Error(`proposal did not parse: ${parsed.reason}`)
  return applyProposal(ledger, parsed.proposal, { ...CTX, ...ctx })
}

const CREATE = {
  op: 'create',
  task: { title: 'Fix flaky checkout test', spec: 'Reproduce, then fix.', assignee: 'agent.mason' }
}

function ledgerWith(...tasks: Partial<Task>[]): TaskLedger {
  return {
    schemaVersion: TASKS_SCHEMA_VERSION,
    tasks: tasks.map((over, index) => ({
      id: `t-2026-08-27-0${String(index)}`,
      title: 'a task',
      spec: 'do the thing',
      assignee: 'agent.mason',
      status: 'todo',
      priority: 5,
      deps: [],
      review: [],
      gates: [],
      artifacts: { deck: null, memos: [], resultRef: null },
      source: { kind: 'propose', via: 'hermes', log: 'msg#0' },
      createdAt: CTX.at,
      updatedAt: CTX.at,
      ...over
    }))
  }
}

describe('the endpoint has an address that is not a mailbox', () => {
  it('is a reserved agent id, so SDD §4.4’s `to` domain is unchanged', () => {
    // `agentId | "broadcast" | "human"` — the endpoint uses the first branch.
    expect(LEDGER_ENDPOINT).toMatch(/^agent\.[a-z]+$/)
  })
})

describe('a proposal is parsed, never repaired', () => {
  it('takes a well-formed proposal', () => {
    expect(parse(proposal(CREATE)).ok).toBe(true)
  })

  it('refuses a body that is not JSON, and says so', () => {
    const parsed = parse('{ half a proposal')
    expect(parsed.ok).toBe(false)
    expect(parsed.ok ? '' : parsed.reason).toMatch(/not valid JSON/)
  })

  it('carries a schemaVersion (invariant §9)', () => {
    expect(parse({ ops: [CREATE] }).ok).toBe(false)
    expect(parse({ schemaVersion: 2, ops: [CREATE] }).ok).toBe(false)
  })

  it('refuses an empty proposal', () => {
    expect(parse(proposal()).ok).toBe(false)
  })

  it('refuses an op it does not know', () => {
    expect(parse(proposal({ op: 'delete', id: 't-2026-08-27-00' })).ok).toBe(false)
  })

  it('refuses an unknown field rather than ignoring it', () => {
    expect(parse({ ...proposal(CREATE), mode: 'force' }).ok).toBe(false)
    expect(parse(proposal({ ...CREATE, urgent: true })).ok).toBe(false)
  })

  it('refuses a create with no spec — the assignee gets no other briefing', () => {
    // SDD §7.1: "self-contained spec".
    expect(parse(proposal({ op: 'create', task: { title: 'x', assignee: null } })).ok).toBe(false)
    expect(
      parse(proposal({ op: 'create', task: { title: 'x', spec: '', assignee: null } })).ok
    ).toBe(false)
  })

  it('refuses an update that changes nothing', () => {
    expect(parse(proposal({ op: 'update', id: 't-2026-08-27-00', patch: {} })).ok).toBe(false)
  })

  it('names where a proposal went wrong', () => {
    const parsed = parse(proposal({ op: 'create', task: { title: 'x' } }))
    expect(parsed.ok ? '' : parsed.reason).toMatch(/ops\.0/)
  })
})

describe('creating tasks', () => {
  it('writes a task with the shape SDD §4.2 documents', () => {
    const result = apply(emptyLedger, proposal(CREATE))
    expect(result.ok).toBe(true)
    const task = result.ok ? result.ledger.tasks[0] : undefined
    expect(task).toMatchObject({
      title: 'Fix flaky checkout test',
      assignee: 'agent.mason',
      status: 'todo',
      gates: [],
      artifacts: { deck: null, memos: [], resultRef: null },
      source: { kind: 'propose', via: 'hermes', log: 'msg#1' }
    })
  })

  it('mints an id when Artemis does not name one', () => {
    const result = apply(emptyLedger, proposal(CREATE))
    expect(result.ok && result.ledger.tasks[0]?.id).toBe('t-2026-08-27-mint0')
  })

  it('keeps the id Artemis chose', () => {
    const result = apply(
      emptyLedger,
      proposal({ ...CREATE, task: { ...CREATE.task, id: 't-abc' } })
    )
    expect(result.ok && result.ledger.tasks[0]?.id).toBe('t-abc')
  })

  it('refuses an id that already exists', () => {
    const result = apply(
      ledgerWith({ id: 't-abc' }),
      proposal({ ...CREATE, task: { ...CREATE.task, id: 't-abc' } })
    )
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.reasons.join(' ')).toMatch(/already exists/)
  })

  it('refuses an assignee nobody can reach', () => {
    // A task addressed to an agent with no mailbox is work that will never be
    // asked for; the ledger would say it was assigned and it would not be.
    const result = apply(
      emptyLedger,
      proposal({ ...CREATE, task: { ...CREATE.task, assignee: 'agent.ghost' } })
    )
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.reasons.join(' ')).toMatch(/no mailbox for assignee/)
  })

  it('accepts an unassigned task', () => {
    expect(
      apply(emptyLedger, proposal({ ...CREATE, task: { ...CREATE.task, assignee: null } })).ok
    ).toBe(true)
  })

  it('lets one proposal create a task and its dependant', () => {
    const result = apply(
      emptyLedger,
      proposal(
        { ...CREATE, task: { ...CREATE.task, id: 't-first' } },
        {
          op: 'create',
          task: {
            id: 't-second',
            title: 'second',
            spec: 'after',
            assignee: null,
            deps: ['t-first']
          }
        }
      )
    )
    expect(result.ok).toBe(true)
  })

  it('refuses a dependency on a task that does not exist', () => {
    const result = apply(
      emptyLedger,
      proposal({ op: 'create', task: { title: 'x', spec: 'y', assignee: null, deps: ['t-nope'] } })
    )
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.reasons.join(' ')).toMatch(/unknown dependency/)
  })
})

describe('a proposal applies whole, or not at all', () => {
  it('writes nothing when one op is bad', () => {
    const before = ledgerWith({ id: 't-keep' })
    const result = apply(
      before,
      proposal(CREATE, { op: 'update', id: 't-nope', patch: { priority: 1 } })
    )
    expect(result.ok).toBe(false)
    // A half-applied decomposition is a ledger nobody can reason about.
    expect(before.tasks.map((t) => t.id)).toEqual(['t-keep'])
  })

  it('collects every reason, not just the first', () => {
    const result = apply(
      emptyLedger,
      proposal(
        { op: 'update', id: 't-nope', patch: { priority: 1 } },
        { op: 'update', id: 't-also-nope', patch: { priority: 2 } }
      )
    )
    expect(result.ok ? [] : result.reasons).toHaveLength(2)
  })

  it('never mutates the ledger it was given', () => {
    const before = ledgerWith({ id: 't-keep' })
    const snapshot = JSON.stringify(before)
    apply(before, proposal(CREATE))
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

describe('SDD §4.2’s one guarded transition', () => {
  it('allows a status change that owes nothing', () => {
    const result = apply(
      ledgerWith({ id: 't-a' }),
      proposal({ op: 'update', id: 't-a', patch: { status: 'done' } })
    )
    expect(result.ok).toBe(true)
  })

  it('refuses done while a review artifact is owed', () => {
    const result = apply(
      ledgerWith({ id: 't-a', review: ['deck'] }),
      proposal({ op: 'update', id: 't-a', patch: { status: 'done' } })
    )
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.reasons.join(' ')).toMatch(/owes a review deck/)
  })

  it('refuses done while a Watch gate is open', () => {
    const result = apply(
      ledgerWith({ id: 't-a', gates: ['g-1'] }),
      proposal({ op: 'update', id: 't-a', patch: { status: 'done' } })
    )
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.reasons.join(' ')).toMatch(/blocked by open gate/)
  })

  it('judges the closing state, not the opening one', () => {
    // Adding the result ref and closing in one op must be legal; judging the
    // task as it was would refuse a proposal that satisfies the rule.
    const result = apply(
      ledgerWith({ id: 't-a', review: [], gates: [] }),
      proposal({ op: 'update', id: 't-a', patch: { resultRef: 'pr#12', status: 'done' } })
    )
    expect(result.ok).toBe(true)
    expect(result.ok && result.ledger.tasks[0]?.artifacts.resultRef).toBe('pr#12')
  })

  it('leaves every other transition to the assignee', () => {
    for (const status of ['in_progress', 'blocked', 'review', 'stalled'] as const) {
      const result = apply(
        ledgerWith({ id: 't-a', review: ['deck'], gates: ['g-1'] }),
        proposal({ op: 'update', id: 't-a', patch: { status } })
      )
      expect(result.ok, status).toBe(true)
    }
  })
})

describe('the blackboard travels with the ledger (FR-4.2)', () => {
  it('returns the new body for the harness to write', () => {
    const result = apply(emptyLedger, proposal({ op: 'board', body: '# Board\n\nAll green.' }))
    expect(result.ok && result.board).toBe('# Board\n\nAll green.')
  })

  it('returns null when the proposal did not write one', () => {
    const result = apply(emptyLedger, proposal(CREATE))
    expect(result.ok && result.board).toBeNull()
  })

  it('can post the board and file tasks in one proposal', () => {
    const result = apply(emptyLedger, proposal(CREATE, { op: 'board', body: 'posted' }))
    expect(result.ok && result.applied.map((a) => a.op)).toEqual(['create', 'board'])
  })
})

describe('pendingTasksFor — the M2 carried item', () => {
  it('counts nothing for an agent with nothing assigned', () => {
    expect(pendingTasksFor(ledgerWith({ assignee: 'agent.scribe' }), 'agent.mason')).toBe(0)
  })

  it('counts work the assignee can actually do', () => {
    const ledger = ledgerWith({ id: 't-1', status: 'todo' }, { id: 't-2', status: 'in_progress' })
    expect(pendingTasksFor(ledger, 'agent.mason')).toBe(2)
  })

  it.each(['blocked', 'stalled', 'review', 'done'] as const)(
    'does not count a %s task',
    (status) => {
      // ADR-0013's branch asks "should this agent keep going?". An agent that
      // cannot proceed should stop, not be told to continue.
      expect(pendingTasksFor(ledgerWith({ status }), 'agent.mason')).toBe(0)
    }
  )

  it('names exactly the statuses it counts', () => {
    expect([...PENDING_STATUSES]).toEqual(['todo', 'in_progress'])
  })
})

describe('the Watch feeds task.gates (carried from the M3.3 review)', () => {
  it('records an open gate against its task', () => {
    const after = withGate(ledgerWith({ id: 't-a' }), 't-a', 'g-1', true)
    expect(after.tasks[0]?.gates).toEqual(['g-1'])
  })

  it('is idempotent — one gate, recorded once', () => {
    let ledger = withGate(ledgerWith({ id: 't-a' }), 't-a', 'g-1', true)
    ledger = withGate(ledger, 't-a', 'g-1', true)
    expect(ledger.tasks[0]?.gates).toEqual(['g-1'])
  })

  it('clears a settled gate without touching the others', () => {
    let ledger = withGate(ledgerWith({ id: 't-a' }), 't-a', 'g-1', true)
    ledger = withGate(ledger, 't-a', 'g-2', true)
    ledger = withGate(ledger, 't-a', 'g-1', false)
    expect(ledger.tasks[0]?.gates).toEqual(['g-2'])
  })

  it('ignores a gate on a task that is not there', () => {
    const before = ledgerWith({ id: 't-a' })
    expect(withGate(before, 't-nope', 'g-1', true).tasks[0]?.gates).toEqual([])
  })

  it('makes the §4.2 close rule bite for the first time', () => {
    const gated = withGate(ledgerWith({ id: 't-a' }), 't-a', 'g-1', true)
    const result = apply(gated, proposal({ op: 'update', id: 't-a', patch: { status: 'done' } }))
    expect(result.ok).toBe(false)
  })
})

describe('the kanban reads columns, it does not compute them', () => {
  it('groups by status', () => {
    const ledger = ledgerWith({ id: 't-1', status: 'todo' }, { id: 't-2', status: 'done' })
    expect(tasksByStatus(ledger, 'todo').map((t) => t.id)).toEqual(['t-1'])
    expect(tasksByStatus(ledger, 'done').map((t) => t.id)).toEqual(['t-2'])
  })

  it('orders by priority, then id, so a column never reshuffles on re-read', () => {
    const ledger = ledgerWith(
      { id: 't-b', priority: 1 },
      { id: 't-a', priority: 1 },
      { id: 't-c', priority: 0 }
    )
    expect(tasksByStatus(ledger, 'todo').map((t) => t.id)).toEqual(['t-c', 't-a', 't-b'])
  })
})

import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUSES,
  REGISTRY_SCHEMA_VERSION,
  emptyRegistry,
  parseRegistry,
  registryEntrySchema
} from '../../src/shared/registry'
import {
  TASKS_SCHEMA_VERSION,
  TASK_STATUSES,
  canCloseTask,
  checkStatusChange,
  emptyLedger,
  parseTaskLedger,
  taskSchema,
  type Task
} from '../../src/shared/tasks'

/**
 * The two schema'd Agora files (SDD §4.1, §4.2). Both parsers are table-driven
 * and both refuse to throw: a corrupt roster or ledger has to become a visible
 * degradation, never a dead boot (invariant §7).
 */

const entry = {
  name: 'Mason',
  role: 'ci-babysitter',
  engine: 'claude',
  capabilities: ['ci', 'git'],
  seat: 'terrace-3',
  envGrants: ['GH_TOKEN'],
  profile: 'skeleton-crew',
  target: 'repo:myapp'
}

const task: Task = {
  id: 't-2026-08-26-041',
  title: 'Fix flaky checkout test',
  spec: 'self-contained spec',
  assignee: 'agent.mason',
  status: 'in_progress',
  priority: 2,
  deps: [],
  review: [],
  gates: [],
  artifacts: { deck: null, memos: [], resultRef: null },
  source: { kind: 'directive', via: 'voice', log: 'log#8842' },
  createdAt: '2026-08-26T10:00:00Z',
  updatedAt: '2026-08-26T10:00:00Z'
}

describe('registry (SDD §4.1)', () => {
  it('accepts the worked example from the SDD', () => {
    const result = parseRegistry({
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      orchestratorId: 'agent.artemis',
      agents: {
        'agent.artemis': {
          name: 'Artemis',
          role: 'orchestrator',
          engine: 'claude',
          isOrchestrator: true,
          seat: 'temple',
          capabilities: ['routing', 'adjudication', 'scribe', 'briefing', 'chair'],
          profile: null,
          target: null,
          status: 'idle',
          hookFidelity: 'native',
          envGrants: [],
          budget: { dailyTokens: 2000000 },
          spawnedAt: '2026-08-26T10:00:00Z',
          lastSeen: '2026-08-26T10:00:00Z'
        },
        'agent.mason': {
          ...entry,
          budget: { dailyTokens: 500000 },
          hire: { template: 'ci-babysitter', version: 3 }
        }
      }
    })
    expect(result.ok).toBe(true)
  })

  it('accepts the empty roster the harness seeds', () => {
    expect(parseRegistry(emptyRegistry).ok).toBe(true)
  })

  const rejected: readonly [string, unknown][] = [
    ['a drifted schemaVersion', { ...emptyRegistry, schemaVersion: 2 }],
    ['an unknown top-level key', { ...emptyRegistry, rogue: 1 }],
    ['a bad agent id as a key', { ...emptyRegistry, agents: { Mason: entry } }],
    ['an unknown engine', { ...emptyRegistry, agents: { 'agent.m': { ...entry, engine: 'gpt' } } }],
    ['an unknown key on an entry', { ...emptyRegistry, agents: { 'agent.m': { ...entry, x: 1 } } }],
    ['a missing seat', { ...emptyRegistry, agents: { 'agent.m': { ...entry, seat: undefined } } }],
    ['a non-object', 'registry'],
    ['null', null]
  ]

  it.each(rejected)('rejects %s with a reason, never a throw', (_label, raw) => {
    const result = parseRegistry(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0)
  })

  it('refuses a secret VALUE smuggled into envGrants (ADR-0010)', () => {
    // Grants are NAMES. A lowercase value-looking string is not a grant name.
    expect(
      registryEntrySchema.safeParse({ ...entry, envGrants: ['ghp_realtokenvalue'] }).success
    ).toBe(false)
  })

  it('names the coarse statuses the floor mirrors', () => {
    expect([...AGENT_STATUSES]).toEqual([
      'idle',
      'working',
      'waiting',
      'blocked',
      'ghost',
      'archived'
    ])
  })
})

describe('task ledger (SDD §4.2)', () => {
  it('accepts the worked example', () => {
    expect(parseTaskLedger({ schemaVersion: TASKS_SCHEMA_VERSION, tasks: [task] }).ok).toBe(true)
    expect(parseTaskLedger(emptyLedger).ok).toBe(true)
  })

  it('names the six documented statuses', () => {
    expect([...TASK_STATUSES]).toEqual([
      'todo',
      'in_progress',
      'blocked',
      'review',
      'done',
      'stalled'
    ])
  })

  const rejected: readonly [string, unknown][] = [
    ['a drifted schemaVersion', { schemaVersion: 9, tasks: [] }],
    ['an unknown status', { ...emptyLedger, tasks: [{ ...task, status: 'almost' }] }],
    ['a bad task id', { ...emptyLedger, tasks: [{ ...task, id: '41' }] }],
    ['a bad dependency id', { ...emptyLedger, tasks: [{ ...task, deps: ['nope'] }] }],
    ['an unknown review kind', { ...emptyLedger, tasks: [{ ...task, review: ['vibes'] }] }],
    ['an extra key on a task', { ...emptyLedger, tasks: [{ ...task, urgent: true }] }],
    ['a missing source ref', { ...emptyLedger, tasks: [{ ...task, source: undefined }] }]
  ]

  it.each(rejected)('rejects %s', (_label, raw) => {
    expect(parseTaskLedger(raw).ok).toBe(false)
  })

  it('requires a source that can be found in the log again (NFR-13)', () => {
    expect(
      taskSchema.safeParse({ ...task, source: { kind: 'd', via: 'v', log: '' } }).success
    ).toBe(false)
  })
})

describe('closing a task is guarded (SDD §4.2, ADR-0008)', () => {
  it('closes freely when nothing is owed', () => {
    expect(canCloseTask(task)).toEqual({ allowed: true })
    expect(checkStatusChange(task, 'done')).toEqual({ allowed: true })
  })

  it('refuses done while a deck is owed', () => {
    const owing: Task = { ...task, review: ['deck'] }
    const check = canCloseTask(owing)
    expect(check.allowed).toBe(false)
    if (!check.allowed) expect(check.reasons[0]).toContain('owes a review deck')
  })

  it('refuses done while a memo is owed', () => {
    const owing: Task = { ...task, review: ['memo'] }
    const check = canCloseTask(owing)
    expect(check.allowed).toBe(false)
    if (!check.allowed) expect(check.reasons[0]).toContain('owes a decision memo')
  })

  it('allows done once the artifact exists', () => {
    expect(
      canCloseTask({
        ...task,
        review: ['deck', 'memo'],
        artifacts: { deck: 'odeon/decks/t-041.html', memos: ['m-102'], resultRef: null }
      })
    ).toEqual({ allowed: true })
  })

  it('refuses done while a gate is open', () => {
    const check = canCloseTask({ ...task, gates: ['gate-7'] })
    expect(check.allowed).toBe(false)
    if (!check.allowed) expect(check.reasons[0]).toContain('gate-7')
  })

  it('lists every reason at once, so a caller fixes them in one pass', () => {
    const check = canCloseTask({ ...task, review: ['deck', 'memo'], gates: ['gate-7'] })
    expect(check.allowed).toBe(false)
    if (!check.allowed) expect(check.reasons).toHaveLength(3)
  })

  it.each(TASK_STATUSES.filter((s) => s !== 'done'))(
    'leaves the %s transition to the assignee',
    (status) => {
      expect(checkStatusChange({ ...task, review: ['deck'], gates: ['g'] }, status)).toEqual({
        allowed: true
      })
    }
  )
})

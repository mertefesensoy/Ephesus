import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Agora, TASKS_REL } from '../../src/main/agora'
import { removeTempDir } from '../tmpdir'
import { EMPTY_DRAFTS, type DraftsRecord } from '../../src/shared/outbound'
import {
  blockedTasksFrom,
  restoreCompany,
  type RestoreStores,
  type RestoreTargets
} from '../../src/main/restore'
import type { StateLoad, StateStore } from '../../src/main/state-store'
import {
  EMPTY_GATES,
  GATE_SCHEMA_VERSION,
  type GatesRecord,
  type OpenGate
} from '../../src/shared/gates'
import { EMPTY_ACTIVATIONS, type ActivationsRecord } from '../../src/shared/profile-activation'
import { EMPTY_TRIGGERS, type TriggersRecord } from '../../src/shared/restart'

/**
 * M8.8. The replay owns the ORDER the records come back in and what happens
 * when one cannot be read — the two things no individual store can own.
 *
 * The stores are stubbed here on purpose: `state-store.test.ts` already proves
 * a file round-trips and that damaged is not absent. What is untested until
 * here is that a damaged record costs its own subsystem and NOTHING else, and
 * that every loss arrives as a sentence the Architect can act on.
 */

function stub<T>(load: StateLoad<T>): StateStore<T> {
  return { load: () => load, save: () => ({ ok: true }) }
}
const absent = <T>(empty: T): StateStore<T> => stub({ ok: true, value: empty, seeded: false })
const holding = <T>(value: T): StateStore<T> => stub({ ok: true, value, seeded: true })
const damaged = <T>(because: string): StateStore<T> => stub<T>({ ok: false, because })

function gate(id: string, taskId: string | null): OpenGate {
  return {
    schemaVersion: GATE_SCHEMA_VERSION,
    id,
    kind: 'destructive',
    agentId: 'agent.one',
    because: 'no-rule',
    channel: 'local',
    packaging: {
      what: 'rm -rf build',
      why: 'the build is stale',
      blastRadius: 'the build directory',
      rollback: 'rerun the build'
    },
    taskId,
    requiresRepeatBack: false,
    memoTrigger: null,
    openedAt: '2026-09-05T03:00:00.000Z'
  }
}

function rig(
  stores: Partial<RestoreStores> = {},
  overrides: Partial<RestoreTargets> = {}
): { stores: RestoreStores; targets: RestoreTargets; order: string[]; held: OpenGate[] } {
  const order: string[] = []
  const held: OpenGate[] = []
  const drafts: string[] = []
  const targets: RestoreTargets = {
    restoreTriggers: (lastFired) => {
      order.push('triggers')
      return Object.keys(lastFired).length
    },
    restoreActivations: (record) => {
      order.push('activations')
      return record.instances.map((i) => `${i.instanceId} restored`)
    },
    restoreGates: (record) => {
      order.push('gates')
      held.push(...record.open)
      return { open: record.open.length, settled: record.settled.length }
    },
    restoreDrafts: (record) => {
      order.push('drafts')
      drafts.push(...record.drafts.flatMap((d) => (d.gateId === null ? [] : [d.gateId])))
      return { filed: record.drafts.length, held: drafts.length }
    },
    gatesHoldingADraft: () => drafts,
    openGates: () => held,
    blockedTasks: () => [],
    ...overrides
  }
  return {
    stores: {
      triggers: stores.triggers ?? absent<TriggersRecord>(EMPTY_TRIGGERS),
      activations: stores.activations ?? absent<ActivationsRecord>(EMPTY_ACTIVATIONS),
      gates: stores.gates ?? absent<GatesRecord>(EMPTY_GATES),
      drafts: stores.drafts ?? absent<DraftsRecord>(EMPTY_DRAFTS)
    },
    targets,
    order,
    held
  }
}

describe('the boot replay', () => {
  it('a first run restores nothing and reports nothing', () => {
    const r = rig()
    const report = restoreCompany(r.stores, r.targets)

    expect(report.problems).toEqual([])
    expect(report.notes).toEqual([])
    expect(report.counts.instances).toBe(0)
  })

  /**
   * `Scheduler.add` consults the restored clock, so seeding it before an
   * activation arms anything is what stops a restored trigger being due the
   * instant it comes back.
   */
  it('seeds the trigger clock BEFORE the activations that arm triggers', () => {
    const r = rig({
      triggers: holding<TriggersRecord>({ schemaVersion: 1, lastFired: { 'crew/sweep': 1000 } }),
      activations: holding<ActivationsRecord>({ schemaVersion: 1, instances: [] }),
      gates: holding<GatesRecord>({ schemaVersion: 1, open: [], settled: [] })
    })

    restoreCompany(r.stores, r.targets)

    expect(r.order).toEqual(['triggers', 'activations', 'gates'])
  })

  it('counts and narrates what came back', () => {
    const r = rig({
      triggers: holding<TriggersRecord>({
        schemaVersion: 1,
        lastFired: { 'crew/sweep': 1000, 'crew/deps': 2000 }
      }),
      gates: holding<GatesRecord>({
        schemaVersion: 1,
        open: [gate('g-a-1', 'task-1')],
        settled: [{ id: 'g-old-1', verdict: 'approved' }]
      })
    })

    const report = restoreCompany(r.stores, {
      ...r.targets,
      blockedTasks: () => [{ id: 'task-1', gates: ['g-a-1'] }]
    })

    expect(report.counts.triggers).toBe(2)
    expect(report.counts.openGates).toBe(1)
    expect(report.counts.settledGates).toBe(1)
    expect(report.problems).toEqual([])
    expect(report.notes.join(' ')).toContain('restored 1 open gate(s) and 1 settled verdict(s)')
  })

  /**
   * The property the whole module exists for: one damaged record must cost its
   * own subsystem and nothing else. A replay that gave up on the first bad file
   * would lose the gates because the trigger clock was corrupt.
   */
  it('a damaged trigger record does not cost the activations or the gates', () => {
    const r = rig({
      triggers: damaged<TriggersRecord>('not JSON: Unexpected token'),
      activations: holding<ActivationsRecord>({
        schemaVersion: 1,
        instances: []
      }),
      gates: holding<GatesRecord>({ schemaVersion: 1, open: [gate('g-a-1', null)], settled: [] })
    })

    const report = restoreCompany(r.stores, r.targets)

    expect(report.counts.openGates).toBe(1)
    expect(r.order).toContain('activations')
    expect(report.problems.map((p) => p.cause)).toEqual(['restart/triggers-unreadable'])
  })

  it('every damaged record states the consequence, not just the parse error', () => {
    const r = rig({
      activations: damaged<ActivationsRecord>('instances.0.crew: invalid'),
      gates: damaged<GatesRecord>('open.0.id: invalid')
    })

    const report = restoreCompany(r.stores, r.targets)

    const byCause = new Map(report.problems.map((p) => [p.cause, p.detail]))
    expect(byCause.get('restart/activations-unreadable')).toContain('comes back un-hired')
    expect(byCause.get('restart/gates-unreadable')).toContain('no block is released')
    // The parse error is kept too — the Architect has to repair the file.
    expect(byCause.get('restart/gates-unreadable')).toContain('open.0.id')
  })

  /** The defect the package is named for, surfaced by task id. */
  it('names every task blocked by a gate that came back from no record', () => {
    const r = rig()
    const report = restoreCompany(r.stores, {
      ...r.targets,
      blockedTasks: () => [
        { id: 'task-1', gates: ['g-lost-1'] },
        { id: 'task-2', gates: ['g-lost-2'] }
      ]
    })

    expect(report.counts.orphanBlocks).toBe(2)
    expect(report.problems.map((p) => p.cause)).toEqual([
      'restart/orphan-block:task-1',
      'restart/orphan-block:task-2'
    ])
    expect(report.problems[0]?.detail).toContain('cannot reach done')
  })

  /** A settled verdict answers its block; it is not an orphan. */
  it('a block whose gate was answered before the restart is not an orphan', () => {
    const r = rig({
      gates: holding<GatesRecord>({
        schemaVersion: 1,
        open: [],
        settled: [{ id: 'g-a-1', verdict: 'approved' }]
      })
    })

    const report = restoreCompany(r.stores, {
      ...r.targets,
      blockedTasks: () => [{ id: 'task-1', gates: ['g-a-1'] }]
    })

    expect(report.counts.orphanBlocks).toBe(0)
  })

  /**
   * An unreadable ledger means an orphan would go unnoticed — which is exactly
   * the silence this package removes, so it is a reported problem rather than
   * an empty reconcile.
   */
  it('an unreadable task ledger is a stated problem, not a silent skip', () => {
    const r = rig()
    const report = restoreCompany(r.stores, { ...r.targets, blockedTasks: () => null })

    expect(report.problems.map((p) => p.cause)).toEqual(['restart/tasks-unreadable'])
    expect(report.problems[0]?.detail).toContain('would not be noticed')
  })

  it('reports a restored gate that no task holds any more', () => {
    const r = rig({
      gates: holding<GatesRecord>({
        schemaVersion: 1,
        open: [gate('g-a-1', 'task-1')],
        settled: []
      })
    })

    const report = restoreCompany(r.stores, {
      ...r.targets,
      blockedTasks: () => [{ id: 'task-1', gates: [] }]
    })

    expect(report.counts.staleGates).toBe(1)
    expect(report.notes.join(' ')).toContain('hold no task any more')
  })

  /**
   * Absent is an ordinary first run; damaged means state exists that cannot be
   * read. Collapsing them is how a restart that restored nothing looks healthy.
   */
  it('an absent record is silent where a damaged one speaks', () => {
    const quiet = restoreCompany(rig().stores, rig().targets)
    const loud = rig({ activations: damaged<ActivationsRecord>('bad') })

    expect(quiet.problems).toEqual([])
    expect(restoreCompany(loud.stores, loud.targets).problems).toHaveLength(1)
  })

  it('never throws when a target does', () => {
    const r = rig({
      activations: holding<ActivationsRecord>({ schemaVersion: 1, instances: [] })
    })
    expect(() =>
      restoreCompany(r.stores, {
        ...r.targets,
        blockedTasks: () => null
      })
    ).not.toThrow()
  })
})
/**
 * The durable blocks, read off a REAL Agora (M8.8).
 *
 * These exist because the stub above cannot produce the case that matters.
 * `Agora.tasks()` does NOT throw on a corrupt ledger — it returns the empty one
 * and records the file in `fileWarnings()`, deliberately, so a bad file is never
 * destroyed by being treated as an error. A caller that wrapped it in try/catch
 * would never see a failure, would read "no blocks" off an unreadable file, and
 * would report zero orphans: silence in exactly the place this milestone exists
 * to remove. The first draft of the boot wiring did precisely that, and the
 * stubbed test above passed the whole time.
 */
describe('reading the durable blocks off a real Agora', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeTempDir(dir)
  })

  async function agoraIn(): Promise<{
    agora: InstanceType<typeof Agora>
    root: string
  }> {
    const { Agora: A } = await import('../../src/main/agora')
    const { PromptStore } = await import('../../src/main/prompts')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-blocked-tasks-'))
    dirs.push(home)
    const repo = fileURLToPath(new URL('../../', import.meta.url))
    const root = path.join(home, 'agora')
    const agora = new A({
      root,
      prompts: new PromptStore(path.join(home, 'prompts'), path.join(repo, 'prompts')),
      backoffMs: 1
    })
    await agora.ensureRepo()
    return { agora, root }
  }

  it('an ABSENT ledger is no blocks, not unknown — a first run has none', async () => {
    const { agora, root } = await agoraIn()
    fs.rmSync(path.join(root, TASKS_REL), { force: true })

    expect(blockedTasksFrom(agora, TASKS_REL)).toEqual([])
  })

  it('reads the gates each task is blocked by', async () => {
    const { agora, root } = await agoraIn()
    fs.writeFileSync(
      path.join(root, TASKS_REL),
      JSON.stringify({
        schemaVersion: 1,
        tasks: [
          {
            id: 't-held',
            title: 'A held task',
            spec: 'Held behind a gate.',
            assignee: null,
            status: 'blocked',
            priority: 1,
            deps: [],
            review: [],
            gates: ['g-2026-09-05t03-00-00-000z-abcdef01'],
            artifacts: { deck: null, memos: [], resultRef: null },
            source: { kind: 'architect', via: 'ui', log: 'log#1' },
            createdAt: '2026-09-05T03:00:00.000Z',
            updatedAt: '2026-09-05T03:00:00.000Z'
          }
        ]
      })
    )

    expect(blockedTasksFrom(agora, TASKS_REL)).toEqual([
      { id: 't-held', gates: ['g-2026-09-05t03-00-00-000z-abcdef01'] }
    ])
  })

  /**
   * The case the stub could not produce, and the defect it hid: a corrupt
   * ledger must be UNKNOWN, never "no blocks". Reported, so the Architect learns
   * a task may be held by a gate that is in no queue.
   */
  it('an UNREADABLE ledger is null — it does not read as zero blocks', async () => {
    const { agora, root } = await agoraIn()
    fs.writeFileSync(path.join(root, TASKS_REL), '{ this is not json')

    // The premise, pinned: tasks() does NOT throw, and it answers empty.
    expect(() => agora.tasks()).not.toThrow()
    expect(agora.tasks().tasks).toEqual([])

    // …so the corruption has to be asked for by name.
    expect(blockedTasksFrom(agora, TASKS_REL)).toBeNull()
  })

  it('a ledger that is JSON but fails the schema is also unreadable', async () => {
    const { agora, root } = await agoraIn()
    fs.writeFileSync(path.join(root, TASKS_REL), JSON.stringify({ schemaVersion: 9, tasks: [] }))

    expect(blockedTasksFrom(agora, TASKS_REL)).toBeNull()
  })

  /** A warning about a DIFFERENT file must not blind the reconcile. */
  it('a corrupt registry does not make the task ledger unreadable', async () => {
    const { agora, root } = await agoraIn()
    fs.writeFileSync(path.join(root, 'registry.json'), '{ not json either')
    agora.registry()

    expect(agora.fileWarnings().length).toBeGreaterThan(0)
    expect(blockedTasksFrom(agora, TASKS_REL)).toEqual([])
  })

  /** End to end: an unreadable ledger becomes a stated problem in the report. */
  it('the replay reports it rather than finding zero orphans', async () => {
    const { agora, root } = await agoraIn()
    fs.writeFileSync(path.join(root, TASKS_REL), '{ this is not json')
    const r = rig()

    const report = restoreCompany(r.stores, {
      ...r.targets,
      blockedTasks: () => blockedTasksFrom(agora, TASKS_REL)
    })

    expect(report.counts.orphanBlocks).toBe(0)
    expect(report.problems.map((p) => p.cause)).toEqual(['restart/tasks-unreadable'])
    expect(report.problems[0]?.detail).toContain('would not be noticed')
  })
})

import { describe, expect, it } from 'vitest'
import { GateManager } from '../../src/main/watch/gates'
import {
  GATE_SCHEMA_VERSION,
  SETTLED_GATE_LIMIT,
  denyAllPolicy,
  gatesRecordSchema,
  reconcileGates,
  type GatePolicy,
  type GatesRecord,
  type OpenGate
} from '../../src/shared/gates'

/**
 * M8.8. The gate is in memory; the BLOCK is durable. `tasks.json` carries
 * `task.gates` and `refuseDone` will not let a task close while that array is
 * non-empty, so a gate opened at 3am and unanswered at restart left its task
 * blocked forever with an empty approvals queue.
 *
 * "Restart" here is what it is in production: the old manager is abandoned and
 * a NEW one is built over the record the old one wrote. Asserting against the
 * same object would be asking memory, which is the question that was always
 * green.
 */

function rig(policy: GatePolicy = denyAllPolicy) {
  const persisted: GatesRecord[] = []
  const opened: OpenGate[] = []
  let clock = 0
  const gates = new GateManager({
    policy: () => policy,
    persist: (record) => persisted.push(record),
    onOpen: (gate) => opened.push(gate),
    now: () => new Date(Date.UTC(2026, 8, 5, 3, 0, (clock += 1)))
  })
  return { gates, persisted, opened }
}

function hold(gates: GateManager, agentId: string, taskId: string | null = null) {
  const outcome = gates.submit({
    agentId,
    kind: 'destructive',
    packaging: {
      what: 'rm -rf build',
      why: 'the build is stale',
      blastRadius: 'the build directory',
      rollback: 'rerun the build'
    },
    ...(taskId === null ? {} : { taskId })
  })
  if (!outcome.held) throw new Error('deny-all should have held this')
  return outcome.gate
}

describe('gates across a restart', () => {
  it('writes the held set down when a gate opens, and again when it settles', () => {
    const r = rig()
    const gate = hold(r.gates, 'agent.one', 'task-1')

    expect(r.persisted).toHaveLength(1)
    expect(r.persisted[0]?.open.map((g) => g.id)).toEqual([gate.id])
    expect(r.persisted[0]?.settled).toEqual([])

    r.gates.decide(gate.id, 'approved')
    expect(r.persisted).toHaveLength(2)
    expect(r.persisted[1]?.open).toEqual([])
    expect(r.persisted[1]?.settled).toEqual([{ id: gate.id, verdict: 'approved' }])
  })

  it('the queue is not empty after a restart', () => {
    const first = rig()
    const gate = hold(first.gates, 'agent.one', 'task-1')
    const record = first.persisted.at(-1)
    if (!record) throw new Error('nothing was persisted')

    const second = rig()
    expect(second.gates.list()).toEqual([])

    const restored = second.gates.restore(record)

    expect(restored).toEqual({ open: 1, settled: 0 })
    expect(second.gates.list().map((g) => g.id)).toEqual([gate.id])
    expect(second.gates.gatesFor('task-1').map((g) => g.id)).toEqual([gate.id])
    expect(second.gates.isBlocked('agent.one')).toBe(true)
  })

  it('a restored gate can be decided, and the packaging survived intact', () => {
    const first = rig()
    const gate = hold(first.gates, 'agent.one', 'task-1')
    const second = rig()
    second.gates.restore(first.persisted[0] as GatesRecord)

    expect(second.gates.get(gate.id)?.packaging).toEqual({
      what: 'rm -rf build',
      why: 'the build is stale',
      blastRadius: 'the build directory',
      rollback: 'rerun the build'
    })
    expect(second.gates.decide(gate.id, 'approved').ok).toBe(true)
    expect(second.gates.verdictOf(gate.id)).toBe('approved')
  })

  /**
   * The half that stops double-processing (SRS §6 criterion 6). `decide`
   * distinguishes "was already approved" from "no open gate" out of `settled`;
   * a restart that dropped it turns every answered gate back into an unknown.
   */
  it('a gate answered before the restart is still answered after it', () => {
    const first = rig()
    const gate = hold(first.gates, 'agent.one', 'task-1')
    first.gates.decide(gate.id, 'denied')

    const second = rig()
    second.gates.restore(first.persisted.at(-1) as GatesRecord)

    expect(second.gates.verdictOf(gate.id)).toBe('denied')
    const again = second.gates.decide(gate.id, 'approved')
    expect(again.ok).toBe(false)
    expect(again.ok === false && again.reason).toContain('already denied')
  })

  /**
   * A restored gate is already in the queue the renderer reads on connect.
   * Replaying `onOpen` would announce a hold hours old as if it had just
   * happened — and on the voice surface it would say so out loud.
   */
  it('does not re-announce a restored gate', () => {
    const first = rig()
    hold(first.gates, 'agent.one', 'task-1')
    const second = rig()

    second.gates.restore(first.persisted[0] as GatesRecord)

    expect(second.opened).toEqual([])
  })

  /** A gate opened during boot outranks a record written before the restart. */
  it('refuses to displace a gate already held', () => {
    const first = rig()
    const old = hold(first.gates, 'agent.one', 'task-1')

    const second = rig()
    const fresh = hold(second.gates, 'agent.one', 'task-1')
    const restored = second.gates.restore(first.persisted[0] as GatesRecord)

    // Same (agent, kind), so the fresh gate stands and the old id is not added.
    expect(restored.open).toBe(old.id === fresh.id ? 0 : 1)
    expect(second.gates.get(fresh.id)).not.toBeNull()
  })

  it('restoring twice adds nothing the second time', () => {
    const first = rig()
    hold(first.gates, 'agent.one', 'task-1')
    const record = first.persisted[0] as GatesRecord

    const second = rig()
    expect(second.gates.restore(record).open).toBe(1)
    expect(second.gates.restore(record).open).toBe(0)
    expect(second.gates.list()).toHaveLength(1)
  })

  it('writes the restored set down, so a second restart sees it', () => {
    const first = rig()
    hold(first.gates, 'agent.one', 'task-1')
    const second = rig()
    second.gates.restore(first.persisted[0] as GatesRecord)
    expect(second.persisted.at(-1)?.open).toHaveLength(1)
  })

  /**
   * The only part of the record that grows without bound. Ids are
   * time-prefixed, so the newest are kept by a lexicographic sort.
   */
  it('bounds the settled list, keeping the NEWEST and dropping the oldest', () => {
    const r = rig()
    const minted: string[] = []
    for (let i = 0; i < SETTLED_GATE_LIMIT + 5; i += 1) {
      const gate = hold(r.gates, `agent.n${String(i)}`)
      minted.push(gate.id)
      r.gates.decide(gate.id, 'approved')
    }
    const last = r.persisted.at(-1)
    if (!last) throw new Error('nothing persisted')

    expect(last.settled).toHaveLength(SETTLED_GATE_LIMIT)
    expect(gatesRecordSchema.safeParse(last).success).toBe(true)

    // Which five fell off is the whole point, and asserting only that the list
    // is sorted cannot tell the two directions apart — it is true either way.
    const kept = new Set(last.settled.map((row) => row.id))
    for (const id of minted.slice(0, 5)) expect(kept.has(id)).toBe(false)
    for (const id of minted.slice(5)) expect(kept.has(id)).toBe(true)
  })
})

describe('reconciling restored gates against the durable blocks', () => {
  const gate = (id: string, taskId: string | null): OpenGate => ({
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
  })

  it('agrees when every block has its gate', () => {
    const out = reconcileGates([gate('g-a-1', 'task-1')], [], [{ id: 'task-1', gates: ['g-a-1'] }])
    expect(out).toEqual({ orphans: [], stale: [] })
  })

  /** The defect named in the package: blocked forever, queue empty. */
  it('names the task whose gate came back from nowhere', () => {
    const out = reconcileGates([], [], [{ id: 'task-1', gates: ['g-lost-1'] }])
    expect(out.orphans).toEqual([{ taskId: 'task-1', gateId: 'g-lost-1' }])
  })

  it('a settled gate still satisfies its block — it is answered, not lost', () => {
    const out = reconcileGates([], [{ id: 'g-a-1' }], [{ id: 'task-1', gates: ['g-a-1'] }])
    expect(out.orphans).toEqual([])
  })

  it('names a restored gate whose task no longer holds it', () => {
    const out = reconcileGates([gate('g-a-1', 'task-1')], [], [{ id: 'task-1', gates: [] }])
    expect(out.stale).toEqual(['g-a-1'])
  })

  /** Held against an agent, not the ledger: it blocks no task and is never stale. */
  it('a gate with no task is never stale', () => {
    const out = reconcileGates([gate('g-a-1', null)], [], [])
    expect(out).toEqual({ orphans: [], stale: [] })
  })

  it('reports every orphan, not just the first', () => {
    const out = reconcileGates(
      [],
      [],
      [
        { id: 'task-1', gates: ['g-lost-1', 'g-lost-2'] },
        { id: 'task-2', gates: ['g-lost-3'] }
      ]
    )
    expect(out.orphans).toHaveLength(3)
    expect(out.orphans.map((o) => o.taskId)).toEqual(['task-1', 'task-1', 'task-2'])
  })

  /**
   * It reports; it never releases. Auto-clearing a block whose gate cannot be
   * reconstructed would approve an action no human ever saw (NFR-9).
   */
  it('returns a report and releases nothing', () => {
    const tasks = [{ id: 'task-1', gates: Object.freeze(['g-lost-1']) }]

    const out = reconcileGates([], [], Object.freeze(tasks))

    // Deep-frozen inputs: a reconcile that tried to clear the block would
    // throw here rather than quietly approve an action no human ever saw.
    expect(out.orphans).toHaveLength(1)
    expect(tasks[0]?.gates).toEqual(['g-lost-1'])
  })
})

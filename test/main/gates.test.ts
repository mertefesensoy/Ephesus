import { describe, expect, it } from 'vitest'
import { GATE_SCHEMA_VERSION, type GatePolicy, type OpenGate } from '../../src/shared/gates'
import { effectivePolicy, GateManager } from '../../src/main/watch/gates'
import { canCloseTask, type Task } from '../../src/shared/tasks'

/**
 * The approval queue (SDD §9, UC-08). The policy itself is asserted in
 * test/shared/gates.test.ts; what this file owns is the lifecycle around a held
 * action — that it is packaged, logged, blocks its task, and cannot be settled
 * twice or talked past.
 */

const CLOCK = new Date('2026-08-27T01:00:00.000Z')

const PACKAGING = {
  what: 'rm -rf build/',
  why: 'stale artifacts break the release',
  blastRadius: 'the build directory in the target repo; source and git history untouched',
  rollback: 'npm run build regenerates it'
}

function manager(
  policy: GatePolicy,
  sink: { logs?: unknown[]; opened?: OpenGate[]; settled?: string[] } = {}
): GateManager {
  return new GateManager({
    policy: () => policy,
    now: () => CLOCK,
    onLogEvent: (draft) => sink.logs?.push(draft),
    onOpen: (gate) => sink.opened?.push(gate),
    onSettled: (gate, verdict) => sink.settled?.push(`${gate.id}:${verdict}`)
  })
}

const DENY_ALL: GatePolicy = { schemaVersion: GATE_SCHEMA_VERSION, autonomy: 'manual', rules: [] }
const ALLOW_DESTRUCTIVE: GatePolicy = {
  schemaVersion: GATE_SCHEMA_VERSION,
  autonomy: 'autonomous',
  rules: [{ kind: 'destructive', autonomy: 'autonomous' }]
}

describe('holding an action (UC-08)', () => {
  it('opens a gate carrying what/why/blast radius/rollback', () => {
    const opened: OpenGate[] = []
    const outcome = manager(DENY_ALL, { opened }).submit({
      kind: 'destructive',
      agentId: 'agent.mason',
      packaging: PACKAGING
    })
    expect(outcome.held).toBe(true)
    expect(outcome.held && outcome.gate.packaging).toEqual(PACKAGING)
    // The renderer learns about it by push, not by polling (SDD §5 `gate:open`).
    expect(opened).toHaveLength(1)
  })

  it('lets an explicitly permitted action straight through', () => {
    const outcome = manager(ALLOW_DESTRUCTIVE).submit({
      kind: 'destructive',
      agentId: 'agent.mason',
      packaging: PACKAGING
    })
    expect(outcome.held).toBe(false)
    expect(manager(ALLOW_DESTRUCTIVE).list()).toEqual([])
  })

  it('records the open and the verdict in the book of record (NFR-13)', () => {
    const logs: Record<string, unknown>[] = []
    const gates = manager(DENY_ALL, { logs })
    const outcome = gates.submit({
      kind: 'destructive',
      agentId: 'agent.mason',
      packaging: PACKAGING,
      taskId: 't-1'
    })
    const gateId = outcome.held ? outcome.gate.id : ''
    gates.decide(gateId, 'approved')

    expect(logs.map((entry) => entry['event'])).toEqual(['opened', 'approved'])
    // Every ref a forensic reader needs to reconstruct the chain.
    expect(logs[0]).toMatchObject({
      kind: 'gate',
      gateId,
      agentId: 'agent.mason',
      gateKind: 'destructive',
      taskId: 't-1',
      what: 'rm -rf build/'
    })
    expect(logs[1]).toMatchObject({ kind: 'gate', gateId, channel: 'local' })
  })

  it('mints distinct ids for concurrent gates', () => {
    const gates = manager(DENY_ALL)
    const ids = new Set(
      Array.from({ length: 20 }, () => {
        const outcome = gates.submit({
          kind: 'destructive',
          agentId: 'agent.mason',
          packaging: PACKAGING
        })
        return outcome.held ? outcome.gate.id : ''
      })
    )
    // A shared clock must not collapse two gates into one id.
    expect(ids.size).toBe(20)
  })
})

describe('verdicts', () => {
  it('settles a gate once, and says so on a second attempt', () => {
    const gates = manager(DENY_ALL)
    const outcome = gates.submit({
      kind: 'destructive',
      agentId: 'agent.mason',
      packaging: PACKAGING
    })
    const gateId = outcome.held ? outcome.gate.id : ''
    expect(gates.decide(gateId, 'approved').ok).toBe(true)
    const second = gates.decide(gateId, 'denied')
    expect(second.ok).toBe(false)
    // The first verdict stands; a late second click cannot overturn it.
    expect(gates.verdictOf(gateId)).toBe('approved')
  })

  it('refuses a verdict on a gate that never existed', () => {
    expect(manager(DENY_ALL).decide('g-nope', 'approved').ok).toBe(false)
  })

  it('drops the gate off the queue once decided', () => {
    const gates = manager(DENY_ALL)
    const outcome = gates.submit({
      kind: 'destructive',
      agentId: 'agent.mason',
      packaging: PACKAGING
    })
    expect(gates.list()).toHaveLength(1)
    gates.decide(outcome.held ? outcome.gate.id : '', 'denied')
    expect(gates.list()).toHaveLength(0)
  })

  it('refuses a voice approval without repeat-back, and does NOT deny it (NFR-9)', () => {
    const voicePolicy: GatePolicy = {
      schemaVersion: GATE_SCHEMA_VERSION,
      autonomy: 'autonomous',
      rules: [
        {
          kind: 'destructive',
          autonomy: 'autonomous',
          channels: ['local', 'voice'],
          requireRepeatBack: true
        }
      ]
    }
    const gates = manager(voicePolicy)
    const outcome = gates.submit({
      kind: 'destructive',
      agentId: 'agent.mason',
      channel: 'voice',
      packaging: PACKAGING
    })
    expect(outcome.held).toBe(true)
    expect(outcome.held && outcome.gate.requiresRepeatBack).toBe(true)
    const gateId = outcome.held ? outcome.gate.id : ''

    const unconfirmed = gates.decide(gateId, 'approved', { channel: 'voice' })
    expect(unconfirmed.ok).toBe(false)
    // "We could not confirm you meant it" is not "no": the gate stays open.
    expect(gates.list()).toHaveLength(1)
    expect(gates.verdictOf(gateId)).toBeNull()

    const confirmed = gates.decide(gateId, 'approved', {
      channel: 'voice',
      repeatBackConfirmed: true
    })
    expect(confirmed.ok).toBe(true)
  })

  it('records which channel the verdict arrived on', () => {
    const logs: Record<string, unknown>[] = []
    const gates = manager(DENY_ALL, { logs })
    const outcome = gates.submit({
      kind: 'destructive',
      agentId: 'agent.mason',
      packaging: PACKAGING
    })
    gates.decide(outcome.held ? outcome.gate.id : '', 'approved', { channel: 'remote' })
    // NFR-9 makes a remote approval a different act from a click; the record
    // has to say which it was.
    expect(logs.at(-1)).toMatchObject({ channel: 'remote' })
  })
})

describe('gates block their task (SDD §4.2)', () => {
  it('an open gate is what makes the close guard bite', () => {
    const gates = manager(DENY_ALL)
    const outcome = gates.submit({
      kind: 'destructive',
      agentId: 'agent.mason',
      packaging: PACKAGING,
      taskId: 't-1'
    })
    const open = gates.gatesFor('t-1')
    expect(open).toHaveLength(1)

    // The guard was shaped in M2.2 with nothing to populate `gates`; this is
    // the package that makes it live.
    const task: Task = {
      id: 't-1',
      title: 'clean the build',
      spec: 'remove stale artifacts',
      assignee: 'agent.mason',
      status: 'review',
      priority: 2,
      deps: [],
      review: [],
      gates: open.map((gate) => gate.id),
      artifacts: { deck: null, memos: [], resultRef: null },
      source: { kind: 'directive', via: 'text', log: 'log#1' },
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z'
    }
    const blocked = canCloseTask(task)
    expect(blocked.allowed).toBe(false)
    expect(blocked.allowed ? [] : blocked.reasons.join(' ')).toContain('open gate')

    gates.decide(outcome.held ? outcome.gate.id : '', 'approved')
    expect(gates.gatesFor('t-1')).toEqual([])
    expect(canCloseTask({ ...task, gates: [] }).allowed).toBe(true)
  })

  it('knows which agent is blocked, for the avatar', () => {
    const gates = manager(DENY_ALL)
    gates.submit({ kind: 'destructive', agentId: 'agent.mason', packaging: PACKAGING })
    expect(gates.isBlocked('agent.mason')).toBe(true)
    expect(gates.isBlocked('agent.scribe')).toBe(false)
  })
})

describe('effectivePolicy', () => {
  it('is deny-all when no policy loaded', () => {
    // A parse failure must compose as deny-all: the safe direction to fail in.
    expect(effectivePolicy(null, null).rules).toEqual([])
    expect(effectivePolicy(null, null).autonomy).toBe('manual')
  })

  it('never widens past the global ceiling', () => {
    const global: GatePolicy = { ...ALLOW_DESTRUCTIVE, autonomy: 'supervised' }
    expect(effectivePolicy(global, 'autonomous').autonomy).toBe('supervised')
    expect(effectivePolicy(global, 'manual').autonomy).toBe('manual')
  })

  it('keeps the rules the global policy declared', () => {
    expect(effectivePolicy(ALLOW_DESTRUCTIVE, 'supervised').rules).toEqual(ALLOW_DESTRUCTIVE.rules)
  })
})

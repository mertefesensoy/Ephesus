import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GATE_SCHEMA_VERSION, type GatePolicy, type OpenGate } from '../../src/shared/gates'
import {
  effectivePolicy,
  GateManager,
  loadGatePolicy,
  notificationMessage,
  parsePackaging,
  wireGateChokePoints
} from '../../src/main/watch/gates'
import { PromptStore } from '../../src/main/prompts'
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

  it('coalesces repeated submissions for one agent and kind', () => {
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
    // Engines emit notifications repeatedly; a gate per event would bury the
    // queue and turn log.jsonl into a metronome.
    expect(ids.size).toBe(1)
    expect(gates.list()).toHaveLength(1)
  })

  it('keeps the first packaging when it coalesces', () => {
    const gates = manager(DENY_ALL)
    const first = gates.submit({
      kind: 'destructive',
      agentId: 'agent.mason',
      packaging: PACKAGING
    })
    gates.submit({
      kind: 'destructive',
      agentId: 'agent.mason',
      packaging: { ...PACKAGING, what: 'something else entirely' }
    })
    // The Architect is being asked about the first one; swapping the question
    // under them mid-decision would be worse than a duplicate.
    expect(gates.list()[0]?.packaging.what).toBe(PACKAGING.what)
    expect(gates.list()[0]?.id).toBe(first.held ? first.gate.id : '')
  })

  it('does not coalesce across agents or kinds', () => {
    const gates = manager(DENY_ALL)
    gates.submit({ kind: 'destructive', agentId: 'agent.mason', packaging: PACKAGING })
    gates.submit({ kind: 'destructive', agentId: 'agent.scribe', packaging: PACKAGING })
    gates.submit({ kind: 'needs-human', agentId: 'agent.mason', packaging: PACKAGING })
    expect(gates.list()).toHaveLength(3)
  })

  it('mints distinct ids under a shared clock', () => {
    const gates = manager(DENY_ALL)
    const ids = new Set(
      Array.from({ length: 200 }, (_unused, index) => {
        const outcome = gates.submit({
          kind: 'destructive',
          agentId: `agent.a${String(index)}`,
          packaging: PACKAGING
        })
        return outcome.held ? outcome.gate.id : ''
      })
    )
    // 16 bits of suffix gave ~0.3% collision odds across twenty, and a
    // collision silently overwrote a still-open gate after `onOpen` had fired.
    expect(ids.size).toBe(200)
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

  it('refuses a remote approval the policy never admitted (NFR-9)', () => {
    const gates = manager(DENY_ALL)
    const outcome = gates.submit({
      kind: 'destructive',
      agentId: 'agent.mason',
      packaging: PACKAGING
    })
    const gateId = outcome.held ? outcome.gate.id : ''
    // NFR-9 constrains the APPROVAL side. A gate held under deny-by-default
    // matched no rule by definition, so checking the channel only on the way in
    // left the clause binding on nothing at all.
    const refused = gates.decide(gateId, 'approved', { channel: 'remote' })
    expect(refused.ok).toBe(false)
    expect(gates.list()).toHaveLength(1)
  })

  it('records the channel of a verdict the policy DOES admit', () => {
    const remotePolicy: GatePolicy = {
      schemaVersion: GATE_SCHEMA_VERSION,
      autonomy: 'autonomous',
      rules: [{ kind: 'needs-human', autonomy: 'supervised', channels: ['local', 'remote'] }]
    }
    const logs: Record<string, unknown>[] = []
    const gates = manager(remotePolicy, { logs })
    const outcome = gates.submit({
      kind: 'needs-human',
      agentId: 'agent.mason',
      profileAutonomy: 'manual',
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

describe('loadGatePolicy — a policy the harness cannot read never permits', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })
  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-policy-'))
    dirs.push(dir)
    return dir
  }

  it('is deny-all with no warning when there is no policy file', () => {
    // An Ephesus that has never been configured holds everything, silently —
    // "you have not configured a policy" is not a degradation.
    const loaded = loadGatePolicy(path.join(tempDir(), 'gate-policy.json'))
    expect(loaded.policy.rules).toEqual([])
    expect(loaded.policy.autonomy).toBe('manual')
    expect(loaded.warning).toBeNull()
  })

  it('is deny-all WITH a warning when the file is not JSON', () => {
    const file = path.join(tempDir(), 'gate-policy.json')
    fs.writeFileSync(file, '{ not json')
    const loaded = loadGatePolicy(file)
    expect(loaded.policy).toEqual(DENY_ALL)
    expect(loaded.warning).toContain('unreadable')
  })

  it('is deny-all WITH a warning naming the field when the schema is wrong', () => {
    const file = path.join(tempDir(), 'gate-policy.json')
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, autonomy: 'yolo', rules: [] }))
    const loaded = loadGatePolicy(file)
    expect(loaded.policy).toEqual(DENY_ALL)
    expect(loaded.warning).toContain('autonomy')
  })

  it('loads a valid policy', () => {
    const file = path.join(tempDir(), 'gate-policy.json')
    fs.writeFileSync(file, JSON.stringify(ALLOW_DESTRUCTIVE))
    expect(loadGatePolicy(file)).toEqual({ policy: ALLOW_DESTRUCTIVE, warning: null })
  })

  it('never widens on a partial file', () => {
    // Half a policy is not half an allowance.
    const file = path.join(tempDir(), 'gate-policy.json')
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, autonomy: 'autonomous' }))
    expect(loadGatePolicy(file).policy.rules).toEqual([])
  })
})

describe('the choke-point wiring (SDD §9), shared with production', () => {
  const prompts = new PromptStore(
    path.join(os.tmpdir(), `eph-prompts-${String(process.pid)}`),
    path.join(process.cwd(), 'prompts')
  )

  function rig(): { gates: GateManager; wired: ReturnType<typeof wireGateChokePoints> } {
    const gates = manager(DENY_ALL)
    return { gates, wired: wireGateChokePoints({ gates, prompts }) }
  }

  it('packages an engine permission prompt from prompts/, not from code', () => {
    const { gates, wired } = rig()
    wired.submitNotification('agent.mason', { message: 'Claude needs permission to run rm -rf /' })
    const gate = gates.list()[0]
    expect(gate?.kind).toBe('tool-permission')
    expect(gate?.packaging.what).toContain('rm -rf /')
    // The other three fields come from the template; none is empty, and none
    // is a string literal in a .ts file (invariant §8).
    expect(gate?.packaging.why.length).toBeGreaterThan(0)
    expect(gate?.packaging.blastRadius.length).toBeGreaterThan(0)
    expect(gate?.packaging.rollback.length).toBeGreaterThan(0)
  })

  it('still packages one when the engine said nothing', () => {
    const { gates, wired } = rig()
    wired.submitNotification('agent.mason', {})
    expect(gates.list()).toHaveLength(1)
    expect(gates.list()[0]?.packaging.what.length).toBeGreaterThan(0)
  })

  it('packages a needs_human message', () => {
    const { gates, wired } = rig()
    wired.submitNeedsHuman({
      from: 'agent.mason',
      subject: 'drop the staging database',
      conversation: 'conv-7'
    })
    const gate = gates.list()[0]
    expect(gate?.kind).toBe('needs-human')
    expect(gate?.packaging.what).toContain('staging database')
    expect(gate?.packaging.blastRadius).toContain('conv-7')
  })

  it('packages a budget breach (choke point 3)', () => {
    const { gates, wired } = rig()
    wired.submitSpend('agent.mason', 1_234_567, 'is exhausted')
    const gate = gates.list()[0]
    expect(gate?.kind).toBe('spend')
    expect(gate?.packaging.why).toContain('1234567')
    expect(gate?.packaging.why).toContain('is exhausted')
  })

  it('reports a template it could not use instead of losing the gate silently', () => {
    const gates = manager(DENY_ALL)
    const errors: string[] = []
    const wired = wireGateChokePoints({
      gates,
      prompts: { render: () => 'what: only one field' },
      onError: (detail) => errors.push(detail)
    })
    wired.submitNotification('agent.mason', { message: 'hi' })
    expect(gates.list()).toEqual([])
    expect(errors.join(' ')).toContain('could not be gated')
  })

  it('carries the bound task through EVERY choke point (M5.1)', () => {
    // The production wiring, not a copy: until M5.1 all three submitted
    // `taskId: null`, so SDD §4.2's `gates` was written only by tests and the
    // `status → done` guard that reads it guarded nothing in the shipped app.
    const gates = manager(DENY_ALL)
    const wired = wireGateChokePoints({ gates, prompts, taskOf: () => 't-2026-08-28-07' })
    wired.submitNotification('agent.mason', { message: 'needs permission' })
    wired.submitNeedsHuman({
      from: 'agent.scribe',
      subject: 'staging creds',
      conversation: 'conv-1'
    })
    wired.submitSpend('agent.tess', 4_000, 'breached')
    expect(gates.list().map((gate) => gate.taskId)).toEqual([
      't-2026-08-28-07',
      't-2026-08-28-07',
      't-2026-08-28-07'
    ])
  })

  it('asks about the agent that is actually being gated', () => {
    // `submitNeedsHuman` gates the SENDER, so the binding must be looked up
    // for `message.from` — passing the wrong id would attribute the gate to
    // whoever happened to be nearby.
    const gates = manager(DENY_ALL)
    const asked: string[] = []
    const wired = wireGateChokePoints({
      gates,
      prompts,
      taskOf: (agentId) => {
        asked.push(agentId)
        return null
      }
    })
    wired.submitNeedsHuman({ from: 'agent.scribe', subject: 's', conversation: 'conv-1' })
    expect(asked).toEqual(['agent.scribe'])
  })

  it('gates perfectly well with no ledger to ask', () => {
    // A harness without a ledger still gates; it just cannot attribute.
    const { gates, wired } = rig()
    wired.submitNotification('agent.mason', { message: 'hi' })
    expect(gates.list()[0]?.taskId).toBeNull()
  })
})

describe('parsePackaging', () => {
  it('reads the four fields', () => {
    expect(parsePackaging('what: w\nwhy: y\nblastRadius: b\nrollback: r\n', 'test')).toEqual({
      what: 'w',
      why: 'y',
      blastRadius: 'b',
      rollback: 'r'
    })
  })

  it('joins a wrapped line, so a long blast radius can wrap in the file', () => {
    const parsed = parsePackaging(
      'what: w\nwhy: y\nblastRadius: every row\n  of production data\nrollback: r\n',
      'test'
    )
    expect(parsed.blastRadius).toBe('every row of production data')
  })

  it('throws naming the template when a field is missing', () => {
    expect(() => parsePackaging('what: w\nwhy: y\n', 'watch/x.md')).toThrow(/watch\/x\.md/)
  })
})

describe('notificationMessage', () => {
  it.each([
    ['a message', { message: '  needs permission  ' }, 'needs permission'],
    ['no message', {}, null],
    ['an empty message', { message: '   ' }, null],
    ['a non-string message', { message: 42 }, null],
    ['not an object', 'hello', null],
    ['null', null, null]
  ])('reads %s', (_name, payload, expected) => {
    expect(notificationMessage(payload)).toBe(expected)
  })
})

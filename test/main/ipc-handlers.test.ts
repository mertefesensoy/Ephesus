import { afterEach, describe, expect, it, vi } from 'vitest'
import { GATE_SCHEMA_VERSION, type GatePolicy, type OpenGate } from '../../src/shared/gates'
import { GateManager } from '../../src/main/watch/gates'

/**
 * The handlers `registerIpc` actually registers.
 *
 * The schemas are asserted in test/main/watch-ipc.test.ts and the managers in
 * their own files; what this file owns is the join between them — the line in
 * `src/main/ipc.ts` that parses the payload before touching state. Review found
 * that removing that parse left every other test green, which is the same
 * defect class this repo has now recorded three times (M3.1's `pty.ts`, M3.3's
 * choke points, and this).
 *
 * `electron` is stubbed rather than run: `ipcMain` is an event registry, and
 * capturing its handlers is enough to call them the way the preload does.
 */

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

afterEach(() => {
  handlers.clear()
})

const DENY_ALL: GatePolicy = { schemaVersion: GATE_SCHEMA_VERSION, autonomy: 'manual', rules: [] }

const PACKAGING = {
  what: 'rm -rf build/',
  why: 'stale artifacts',
  blastRadius: 'the build directory',
  rollback: 'rebuild'
}

/** Registers the real handlers over a real GateManager. */
async function rig(): Promise<{
  gates: GateManager
  logs: Record<string, unknown>[]
  call(channel: string, payload?: unknown): Promise<unknown>
}> {
  const { registerIpc } = await import('../../src/main/ipc')
  const logs: Record<string, unknown>[] = []
  const gates = new GateManager({ policy: () => DENY_ALL, onLogEvent: (d) => logs.push(d) })
  registerIpc({
    ptyManager: {} as never,
    agents: {} as never,
    avatars: { list: () => new Map() } as never,
    commands: { list: () => [] } as never,
    agora: {} as never,
    secrets: {} as never,
    gates,
    budgets: () => [],
    humanQueue: () => [],
    dismissFromHumanQueue: () => true,
    breakerState: () => [],
    hooksState: () => ({ endpoint: null, driftWarnings: [], failure: null }),
    agoraHealth: () => ({ fileWarnings: [], commitFailures: [], runtime: [] }),
    memoryView: (agentId: string) => ({
      agentId,
      path: '',
      text: '',
      sections: 0,
      archive: [],
      reflection: { due: false, because: 'no library in this rig', chars: 0 }
    }),
    recall: (query: string) =>
      Promise.resolve({
        schemaVersion: 1 as const,
        query,
        rung: 'grep' as const,
        hits: [],
        degraded: 'no library in this rig'
      }),
    knowledge: () => [],
    registerKnowledge: () => [],
    briefs: () => [],
    gymLedger: () => [],
    gymProposal: () => null,
    gymVerdict: () => ({ ok: false, reason: 'no gymnasium' }),
    gymMetricResult: () => ({ ok: false, reason: 'no gymnasium' }),
    orgChart: () => [],
    orgMetrics: () => ({ metrics: [], findings: [] }),
    retros: () => [],
    generateRetro: () => ({ ok: false, reason: 'no org layer' }),
    convene: () => ({ ok: false, reason: 'no odeon' }),
    meeting: () => null,
    meetingSay: () => ({ kind: 'refused', reason: 'no odeon' }),
    meetingClose: () => ({ ok: false, reason: 'no odeon' }),
    decks: () => [],
    deck: () => null,
    commentOnDeck: () => ({ queued: false, because: 'no orchestrator' }),
    memos: () => [],
    decideMemo: () => ({ ok: false, reason: 'no odeon' })
  })
  return {
    gates,
    logs,
    call: async (channel, payload) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`no handler registered for ${channel}`)
      return handler({}, payload)
    }
  }
}

function open(gates: GateManager): OpenGate {
  const outcome = gates.submit({
    kind: 'destructive',
    agentId: 'agent.mason',
    packaging: PACKAGING
  })
  if (!outcome.held) throw new Error('expected the gate to be held')
  return outcome.gate
}

describe('watch:approve — the handler validates before it acts', () => {
  it('takes a well-formed verdict', async () => {
    const { gates, call } = await rig()
    const gate = open(gates)
    await expect(call('watch:approve', { gateId: gate.id, verdict: 'approved' })).resolves.toEqual({
      ok: true,
      reason: null
    })
    expect(gates.list()).toEqual([])
  })

  it.each([
    ['a malformed gate id', { gateId: '../../etc/passwd', verdict: 'approved' }],
    ['an unknown verdict', { gateId: 'g-x', verdict: 'maybe' }],
    ['a missing field', { gateId: 'g-x' }],
    ['an extra field', { gateId: 'g-x', verdict: 'approved', force: true }],
    ['nothing at all', undefined],
    ['a string', 'approved']
  ])('rejects %s at the handler, before the manager is touched', async (_name, payload) => {
    const { gates, call } = await rig()
    const gate = open(gates)
    await expect(call('watch:approve', payload)).rejects.toThrow()
    // The gate is untouched: the parse happened first.
    expect(gates.list().map((g) => g.id)).toEqual([gate.id])
  })

  it('cannot be told which channel the verdict came from', async () => {
    const { gates, logs, call } = await rig()
    const gate = open(gates)
    // A verdict through the window bridge IS local. Letting the renderer claim
    // otherwise would put the provenance of a destructive approval under
    // untrusted control (invariant §2, NFR-9, NFR-13).
    await expect(
      call('watch:approve', {
        gateId: gate.id,
        verdict: 'approved',
        context: { channel: 'voice', repeatBackConfirmed: true }
      })
    ).rejects.toThrow()

    await call('watch:approve', { gateId: gate.id, verdict: 'approved' })
    expect(logs.at(-1)).toMatchObject({ channel: 'local', repeatBack: false })
  })

  it('reports a refusal rather than throwing, so the panel can show it', async () => {
    const { call } = await rig()
    const result = (await call('watch:approve', {
      gateId: 'g-2026-08-27t01-00-00-000z-ffff',
      verdict: 'approved'
    })) as { ok: boolean; reason: string | null }
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/no open gate/)
  })
})

describe('watch: read handlers', () => {
  it('registers every documented watch channel', async () => {
    await rig()
    for (const channel of [
      'watch:approvals',
      'watch:approve',
      'watch:budgets',
      'watch:human-queue',
      'watch:breaker-state'
    ]) {
      expect(handlers.has(channel)).toBe(true)
    }
  })

  it('serves the approvals queue from main’s own manager', async () => {
    const { gates, call } = await rig()
    const gate = open(gates)
    expect(await call('watch:approvals')).toEqual([gate])
  })
})

describe('the secrets group stays write-only through the handlers', () => {
  it('registers exactly SDD §5’s four channels', async () => {
    await rig()
    const secretChannels = [...handlers.keys()].filter((c) => c.startsWith('secrets:')).sort()
    expect(secretChannels).toEqual([
      'secrets:delete',
      'secrets:set',
      'secrets:status',
      'secrets:test'
    ])
  })
})

describe('the Library group validates before it acts (ADR-0006, invariant §2)', () => {
  it('registers the four channels SDD §5 documents for it', async () => {
    await rig()
    const library = [...handlers.keys()]
      .filter(
        (c) =>
          ['agora:memory', 'agora:recall', 'agora:knowledge'].includes(c) ||
          c === 'agora:register-knowledge'
      )
      .sort()
    expect(library).toEqual([
      'agora:knowledge',
      'agora:memory',
      'agora:recall',
      'agora:register-knowledge'
    ])
  })

  it.each([
    ['a malformed agent id', { agentId: '../escape' }],
    ['a missing field', {}],
    ['an extra field', { agentId: 'agent.mason', deep: true }]
  ])('agora:memory refuses %s', async (_label, payload) => {
    const { call } = await rig()
    await expect(call('agora:memory', payload)).rejects.toThrow()
  })

  it.each([
    ['an empty query', { query: '', scope: null, limit: 5 }],
    ['a limit of zero', { query: 'q', scope: null, limit: 0 }],
    ['a limit past the cap', { query: 'q', scope: null, limit: 1000 }],
    ['a missing scope', { query: 'q', limit: 5 }],
    ['an extra field', { query: 'q', scope: null, limit: 5, wing: 'x' }]
  ])('agora:recall refuses %s', async (_label, payload) => {
    const { call } = await rig()
    await expect(call('agora:recall', payload)).rejects.toThrow()
  })

  it.each([
    ['a path separator', { name: 'sub/dir', text: 'x' }],
    ['a traversal', { name: '../escape', text: 'x' }],
    ['an empty body', { name: 'runbook', text: '' }],
    ['an extra field', { name: 'runbook', text: 'x', commit: true }]
  ])('agora:register-knowledge refuses %s', async (_label, payload) => {
    const { call } = await rig()
    await expect(call('agora:register-knowledge', payload)).rejects.toThrow()
  })

  it('takes a well-formed recall and a well-formed registration', async () => {
    const { call } = await rig()
    await expect(call('agora:recall', { query: 'flaky', scope: null, limit: 5 })).resolves.toEqual(
      expect.objectContaining({ rung: 'grep' })
    )
    await expect(
      call('agora:register-knowledge', { name: 'runbook', text: 'body' })
    ).resolves.toEqual([])
  })
})

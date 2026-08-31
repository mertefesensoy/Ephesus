import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GATE_SCHEMA_VERSION, type GatePolicy, type OpenGate } from '../../src/shared/gates'
import { GateManager } from '../../src/main/watch/gates'
import { ProfileStore } from '../../src/main/profiles'

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

interface RigOptions {
  /** Avatar snapshots the director would hand back, keyed by agent id. */
  readonly avatars?: Map<string, unknown>
  /** What `pendingMailFor` answers — UI-DESIGN §5.4's desk tray flag. */
  readonly pendingMail?: (agentId: string) => number
  /**
   * A REAL `ProfileStore`, so the `profiles:` cases exercise the whole seam —
   * channel → handler → store → disk — rather than two halves that have never
   * met. The M6 close-out audit's finding, applied.
   */
  readonly profiles?: ProfileStore
}

/** Registers the real handlers over a real GateManager. */
async function rig(options: RigOptions = {}): Promise<{
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
    avatars: { list: () => options.avatars ?? new Map() } as never,
    commands: { list: () => [] } as never,
    agora: {} as never,
    secrets: {} as never,
    gates,
    budgets: () => [],
    humanQueue: () => [],
    dismissFromHumanQueue: () => true,
    breakerState: () => [],
    pendingMailFor: options.pendingMail ?? ((): number => 0),
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
    gymMode: () => ({ mode: 'directed' as const, gateMet: false, missing: [], everEnabled: false }),
    gymSetMode: () => ({ ok: false, reason: 'no modes', missing: [] }),
    stoaWatchlist: () => [],
    stoaRegister: () => ({ ok: false, reason: 'no stoa' }),
    stoaRetire: () => ({ ok: false, reason: 'no stoa' }),
    stoaBriefs: () => [],
    stoaBrief: () => null,
    profilesList: () => options.profiles?.list() ?? [],
    profilesInspect: (name: string) =>
      options.profiles?.load(name) ?? { ok: false as const, name, reasons: [] },
    profilesPreview: () => ({ ok: false as const, reasons: [] }),
    profilesActivate: () => Promise.resolve({ ok: false as const, reasons: [] }),
    profilesDeactivate: () => ({ ok: false, reason: 'no activations in this rig' }),
    harborHireExport: () => ({ ok: false as const, reason: 'no exchange in this rig' }),
    harborProfileExport: () => ({ ok: false as const, reason: 'no exchange in this rig' }),
    harborImportInspect: () => ({ ok: false as const, reasons: ['no exchange in this rig'] }),
    harborImportInstall: () => ({ ok: false as const, reasons: ['no exchange in this rig'] }),
    harborRepos: () => ({
      schemaVersion: 1,
      ghVersion: null,
      unavailable: 'no Harbor in this rig',
      repos: []
    }),
    profilesInstances: () => [],
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

describe('avatars:list carries the desk tray fact (UI-DESIGN §5.4)', () => {
  const snapshot = {
    phase: 'idle',
    station: 'desk',
    origin: 'desk',
    walking: false,
    resume: null,
    resumeStation: null,
    waitingOn: null,
    sinceMs: 0
  }

  it('reports each agent’s pendingMail, from the same source the push uses', async () => {
    const { call } = await rig({
      avatars: new Map([
        ['a-1', snapshot],
        ['a-2', snapshot]
      ]),
      pendingMail: (agentId) => (agentId === 'a-1' ? 3 : 0)
    })
    // The listing path is the one a freshly-opened window reads. M5b's standing
    // lesson is that a fact supplied on one read path and not the others is a
    // seam no unit test sees — so the count must be here, not only on the push.
    await expect(call('avatars:list')).resolves.toEqual([
      { agentId: 'a-1', snapshot, pendingMail: 3 },
      { agentId: 'a-2', snapshot, pendingMail: 0 }
    ])
  })

  it('answers zero rather than undefined when nothing is waiting', async () => {
    const { call } = await rig({ avatars: new Map([['a-1', snapshot]]) })
    const updates = (await call('avatars:list')) as { pendingMail: number }[]
    // `undefined` would raise no flag either, but it would also make
    // `deskTray(update.pendingMail)` a lie by accident rather than by fact.
    expect(updates[0]?.pendingMail).toBe(0)
  })
})

describe('profiles: — the channel reaches the store, and the store reaches the disk', () => {
  /**
   * The M6 close-out audit's first standing lesson: a green suite is not a
   * wired feature. `test/main/profiles.test.ts` proves the store reads bundles
   * and `test/shared/profile.test.ts` proves the schema refuses bad ones —
   * both halves, neither seam. These two cases walk the whole production path
   * a renderer takes: `IpcChannels.profilesInspect` → the handler in
   * `src/main/ipc.ts` → `deps.profilesInspect` → `ProfileStore.load` → disk.
   */
  const roots: string[] = []

  afterEach(() => {
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  function storeWithOneBundle(profileJson?: string): ProfileStore {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-ipc-profiles-'))
    roots.push(home)
    const dir = path.join(home, 'skeleton-crew')
    fs.mkdirSync(path.join(dir, 'hires'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'playbooks'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'profile.json'),
      profileJson ??
        JSON.stringify({
          schemaVersion: 1,
          name: 'skeleton-crew',
          version: 4,
          target: { kind: 'repo' },
          autonomy: { default: 'supervised', byKind: { destructive: 'manual' } }
        })
    )
    fs.writeFileSync(
      path.join(dir, 'memo-policy.json'),
      JSON.stringify({ schemaVersion: 1, requires: ['new-dependency'] })
    )
    fs.writeFileSync(
      path.join(dir, 'harbor.json'),
      JSON.stringify({ schemaVersion: 1, repos: [], channels: [], webhooks: [] })
    )
    fs.writeFileSync(
      path.join(dir, 'hires', 'oncall.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'oncall',
        version: 1,
        role: 'oncall',
        engine: 'claude',
        capabilities: ['triage'],
        envGrants: [],
        brief: 'Answer the page.'
      })
    )
    fs.writeFileSync(path.join(dir, 'playbooks', 'incident.md'), '# Incident\n')
    return new ProfileStore(home, path.join(home, 'no-builtins'))
  }

  it('lists and inspects a real bundle off a real disk', async () => {
    const { call } = await rig({ profiles: storeWithOneBundle() })
    await expect(call('profiles:list')).resolves.toEqual([
      { name: 'skeleton-crew', source: 'home', valid: true, version: 4 }
    ])
    const loaded = (await call('profiles:inspect', { name: 'skeleton-crew' })) as {
      ok: boolean
      bundle?: { document: { version: number }; hires: { name: string }[] }
    }
    expect(loaded.ok).toBe(true)
    expect(loaded.bundle?.document.version).toBe(4)
    expect(loaded.bundle?.hires.map((hire) => hire.name)).toEqual(['oncall'])
  })

  it('carries the refusal reasons across the bridge, rather than an empty answer', async () => {
    // A renderer that got `null` for a broken bundle would show "no profiles",
    // which is the silent degradation invariant §7 forbids.
    const { call } = await rig({ profiles: storeWithOneBundle('{ not json') })
    const loaded = (await call('profiles:inspect', { name: 'skeleton-crew' })) as {
      ok: boolean
      name: string
      reasons: string[]
    }
    expect(loaded).toMatchObject({ ok: false, name: 'skeleton-crew' })
    expect(loaded.reasons.join(' · ')).toContain('profile.json: not JSON')
  })

  it('validates the payload before it reaches the store', async () => {
    const { call } = await rig({ profiles: storeWithOneBundle() })
    await expect(call('profiles:inspect', { name: '' })).rejects.toThrow()
    await expect(call('profiles:inspect', {})).rejects.toThrow()
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { composeMessage, makeMessageId, type Message } from '../../src/shared/message'
import { ODEON_ENDPOINT } from '../../src/shared/reserved'
import { MEMO_SCHEMA_VERSION } from '../../src/shared/memo'
import { denyAllPolicy, type OpenGate } from '../../src/shared/gates'
import { Agora } from '../../src/main/agora'
import { Odeon } from '../../src/main/odeon'
import { PromptStore } from '../../src/main/prompts'
import { GateManager, wireGateChokePoints } from '../../src/main/watch/gates'
import { removeTempDir } from '../tmpdir'

/**
 * The memo mechanism (ADR-0008 §3, FR-7.3, SDD §7.3, UC-06) — S-MEMO's spine.
 *
 * What is asserted here is the part that must be MECHANICAL: a matching action
 * is held, a memo can only answer the hold that is actually its own, the
 * countersignature is written by the harness rather than claimed by the
 * decider, and a rejection reverses the held action. Which verdict a memo
 * deserves is judgement and belongs to Artemis or the Architect; nothing here
 * has an opinion about it.
 */

const BUNDLED_PROMPTS = fileURLToPath(new URL('../../prompts/', import.meta.url))
const homes: string[] = []
const agoras: Agora[] = []

afterEach(async () => {
  for (const agora of agoras.splice(0)) await agora.drained().catch(() => {})
  for (const home of homes.splice(0)) {
    removeTempDir(home)
  }
})

let seq = 0

interface Rig {
  readonly agora: Agora
  readonly odeon: Odeon
  readonly gates: GateManager
  readonly wired: ReturnType<typeof wireGateChokePoints>
  readonly logs: Record<string, unknown>[]
  memoDirs(): string[]
  memoFile(memoId: string, name: string): string | null
}

async function rig(): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-memo-'))
  homes.push(home)
  const prompts = new PromptStore(path.join(home, 'prompts'), BUNDLED_PROMPTS)
  const agora = new Agora({ root: path.join(home, 'agora'), prompts, backoffMs: 1 })
  await agora.ensureRepo()
  agoras.push(agora)

  const logs: Record<string, unknown>[] = []
  const gates = new GateManager({ policy: () => denyAllPolicy })
  const odeon = new Odeon({
    agoraRoot: agora.root,
    prompts,
    task: () => null,
    recordDeck: () => {},
    gate: (gateId) => gates.get(gateId),
    onLogEvent: (draft) => logs.push(draft)
  })
  // The SHIPPED choke-point wiring, so the hold is the one production opens.
  const wired = wireGateChokePoints({ gates, prompts })

  const memosRoot = path.join(agora.root, 'odeon', 'memos')
  return {
    agora,
    odeon,
    gates,
    wired,
    logs,
    memoDirs: () => (fs.existsSync(memosRoot) ? fs.readdirSync(memosRoot).sort() : []),
    memoFile: (memoId, name) => {
      const file = path.join(memosRoot, memoId, name)
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
    }
  }
}

function filing(gate: OpenGate, over: Record<string, unknown> = {}): Message {
  seq += 1
  return composeMessage({
    id: makeMessageId(new Date(2026, 7, 28, 10, 0, seq), 'cc33'),
    conversation: 'conv-memo',
    in_reply_to: null,
    from: gate.agentId,
    to: ODEON_ENDPOINT,
    act: 'propose',
    subject: 'memo',
    body: JSON.stringify({
      schemaVersion: MEMO_SCHEMA_VERSION,
      kind: 'memo',
      gateId: gate.id,
      trigger: gate.memoTrigger,
      title: 'Add zod for payload validation',
      context: 'The hook payloads are unvalidated.',
      options: ['zod', 'hand-written guards'],
      recommendation: 'zod',
      blastRadius: 'every hook payload path',
      rollback: 'remove it and restore the guards',
      taskId: null,
      ...over
    }),
    hops: 0,
    created_at: new Date().toISOString()
  })
}

/** Holds one action through the production choke point and returns its gate. */
function hold(r: Rig, agentId = 'agent.mason', file = 'package.json'): OpenGate {
  r.wired.submitMemoTrigger(agentId, { tool: 'Edit', path: file })
  const gate = r.gates.list().at(-1)
  if (gate === undefined) throw new Error('no gate was opened')
  return gate
}

describe('a matching action is HELD, mechanically (ADR-0008 §3)', () => {
  it('opens a gate carrying the trigger that held it', async () => {
    const r = await rig()
    const gate = hold(r)
    expect(gate.memoTrigger).toBe('new-dependency')
    expect(gate.agentId).toBe('agent.mason')
  })

  it('packages the hold from prompts/, not from code (invariant §8)', async () => {
    const r = await rig()
    const gate = hold(r)
    expect(gate.packaging.what).toContain('package.json')
    expect(gate.packaging.why.length).toBeGreaterThan(0)
    expect(gate.packaging.rollback).toContain('memo')
  })

  it('lets ordinary work through without a gate', async () => {
    const r = await rig()
    expect(
      r.wired.submitMemoTrigger('agent.mason', { tool: 'Edit', path: 'src/app.ts' })
    ).toBeNull()
    expect(r.gates.list()).toEqual([])
  })
})

describe('a memo can only answer the hold that is its own', () => {
  it('archives a memo against its gate', async () => {
    const r = await rig()
    const gate = hold(r)
    const outcome = r.odeon.fileMemo(filing(gate))
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(r.memoFile(outcome.memoId, 'memo.md')).toContain('Add zod')
      expect(r.memoFile(outcome.memoId, 'memo.md')).toContain('## Rollback')
    }
  })

  it('REFUSES a memo answering somebody else’s hold', async () => {
    const r = await rig()
    const gate = hold(r, 'agent.mason')
    const impostor = { ...filing(gate), from: 'agent.scribe' }
    const outcome = r.odeon.fileMemo(impostor)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reasons.join(' ')).toContain('holds agent.mason')
    expect(r.memoDirs()).toEqual([])
  })

  it('refuses a memo for a gate that is not waiting on one', async () => {
    const r = await rig()
    r.wired.submitNotification('agent.mason', { message: 'may I run rm -rf?' })
    const gate = r.gates.list()[0]
    if (gate === undefined) throw new Error('no gate')
    const outcome = r.odeon.fileMemo(filing({ ...gate, memoTrigger: 'new-dependency' }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reasons.join(' ')).toContain('not waiting on a memo')
  })

  it('refuses a memo whose trigger is not the one that held the action', async () => {
    const r = await rig()
    const gate = hold(r)
    const outcome = r.odeon.fileMemo(filing(gate, { trigger: 'spend' }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reasons.join(' ')).toContain('was held for new-dependency')
  })

  it('refuses a memo for a gate that does not exist', async () => {
    const r = await rig()
    const gate = hold(r)
    const outcome = r.odeon.fileMemo(filing({ ...gate, id: 'g-2026-01-01t00-00-00-000z-ffff' }))
    expect(outcome.ok).toBe(false)
  })

  it('records the filing in the book of record (NFR-13)', async () => {
    const r = await rig()
    const gate = hold(r)
    r.odeon.fileMemo(filing(gate))
    expect(r.logs.find((log) => log['event'] === 'filed')).toMatchObject({
      kind: 'memo',
      trigger: 'new-dependency',
      gateId: gate.id,
      by: 'agent.mason'
    })
  })
})

describe('the countersignature is written by the harness (FR-5.5)', () => {
  it('records a delegated verdict with its grant', async () => {
    const r = await rig()
    const gate = hold(r)
    const filed = r.odeon.fileMemo(filing(gate))
    if (!filed.ok) throw new Error('memo did not file')

    const settled = r.odeon.decideMemo({
      memoId: filed.memoId,
      verdict: 'approved',
      notes: 'pin the version',
      decider: { kind: 'orchestrator', agentId: 'agent.artemis', under: 'memo:new-dependency' }
    })

    expect(settled.ok).toBe(true)
    const verdict = JSON.parse(r.memoFile(filed.memoId, 'verdict.json') ?? '{}')
    expect(verdict).toMatchObject({
      decidedBy: 'agent.artemis',
      countersigned: true,
      authority: 'memo:new-dependency',
      verdict: 'approved'
    })
  })

  it('records an Architect verdict without one, and says so', async () => {
    const r = await rig()
    const gate = hold(r)
    const filed = r.odeon.fileMemo(filing(gate))
    if (!filed.ok) throw new Error('memo did not file')

    r.odeon.decideMemo({
      memoId: filed.memoId,
      verdict: 'approved',
      notes: 'fine',
      decider: { kind: 'architect' }
    })

    const verdict = JSON.parse(r.memoFile(filed.memoId, 'verdict.json') ?? '{}')
    expect(verdict).toMatchObject({ decidedBy: 'architect', countersigned: false, authority: null })
  })

  it('releases the held action on approval, and REVERSES it on rejection', async () => {
    const r = await rig()
    const approved = hold(r, 'agent.mason')
    const filedA = r.odeon.fileMemo(filing(approved))
    if (!filedA.ok) throw new Error('memo did not file')
    const a = r.odeon.decideMemo({
      memoId: filedA.memoId,
      verdict: 'approved',
      notes: '',
      decider: { kind: 'architect' }
    })
    expect(a.ok && a.gateVerdict).toBe('approved')

    const rejected = hold(r, 'agent.scribe')
    const filedB = r.odeon.fileMemo(filing(rejected))
    if (!filedB.ok) throw new Error('memo did not file')
    const b = r.odeon.decideMemo({
      memoId: filedB.memoId,
      verdict: 'rejected',
      notes: 'no new dependency this sprint',
      decider: { kind: 'architect' }
    })
    // ADR-0008: "a rejected memo reverses the change".
    expect(b.ok && b.gateVerdict).toBe('denied')
  })

  it('gives a memo exactly ONE verdict', async () => {
    // An approval that could be quietly replaced after the released action ran
    // would make the archive a claim rather than a record (invariant §5).
    const r = await rig()
    const gate = hold(r)
    const filed = r.odeon.fileMemo(filing(gate))
    if (!filed.ok) throw new Error('memo did not file')
    const first = r.odeon.decideMemo({
      memoId: filed.memoId,
      verdict: 'approved',
      notes: '',
      decider: { kind: 'architect' }
    })
    const second = r.odeon.decideMemo({
      memoId: filed.memoId,
      verdict: 'rejected',
      notes: 'changed my mind',
      decider: { kind: 'architect' }
    })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toContain('already carries a verdict')
    expect(JSON.parse(r.memoFile(filed.memoId, 'verdict.json') ?? '{}').verdict).toBe('approved')
  })

  it('refuses a verdict on a memo that was never filed', async () => {
    const r = await rig()
    const outcome = r.odeon.decideMemo({
      memoId: 'm-nope',
      verdict: 'approved',
      notes: '',
      decider: { kind: 'architect' }
    })
    expect(outcome.ok).toBe(false)
  })

  it('records the decision in the book of record with its authority', async () => {
    const r = await rig()
    const gate = hold(r)
    const filed = r.odeon.fileMemo(filing(gate))
    if (!filed.ok) throw new Error('memo did not file')
    r.odeon.decideMemo({
      memoId: filed.memoId,
      verdict: 'approved',
      notes: '',
      decider: { kind: 'orchestrator', agentId: 'agent.artemis', under: 'memo:new-dependency' }
    })
    expect(r.logs.find((log) => log['event'] === 'decided')).toMatchObject({
      kind: 'memo',
      decidedBy: 'agent.artemis',
      countersigned: true,
      authority: 'memo:new-dependency'
    })
  })
})

describe('the memo queue is read off the archive', () => {
  it('separates what is open from what is decided', async () => {
    const r = await rig()
    const open = r.odeon.fileMemo(filing(hold(r, 'agent.mason')))
    const done = r.odeon.fileMemo(filing(hold(r, 'agent.scribe')))
    if (!open.ok || !done.ok) throw new Error('memos did not file')
    r.odeon.decideMemo({
      memoId: done.memoId,
      verdict: 'approved',
      notes: '',
      decider: { kind: 'architect' }
    })

    expect(r.odeon.memos('all')).toHaveLength(2)
    expect(r.odeon.memos('open').map((m) => m.memoId)).toEqual([open.memoId])
    expect(r.odeon.memos('decided').map((m) => m.memoId)).toEqual([done.memoId])
  })

  it('carries the archived markdown itself, never a summary of it', async () => {
    const r = await rig()
    const filed = r.odeon.fileMemo(filing(hold(r)))
    if (!filed.ok) throw new Error('memo did not file')
    const row = r.odeon.memos('open')[0]
    expect(row?.markdown).toBe(r.memoFile(filed.memoId, 'memo.md'))
  })

  it('is empty before anything is filed', async () => {
    expect((await rig()).odeon.memos('all')).toEqual([])
  })
})

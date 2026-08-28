import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MEMO_SCHEMA_VERSION } from '../../src/shared/memo'
import { ODEON_ENDPOINT } from '../../src/shared/reserved'
import { cleanupHomes, scenarioMessage, sendStep, startCompany, type Company } from './company'

/**
 * S-MEMO (TEST-STRATEGY §3, SRS §6.4): "policy trigger (fake dependency add)
 * holds the action; memo → Artemis delegated verdict (countersigned) vs
 * Architect queue; rejection reverses; archive immutable."
 *
 * The trigger fires from a REAL spawned agent's REAL tool call over the REAL
 * hook socket — the same stream the breaker watches — so the hold is the one
 * the shipped app opens, not one the test constructed.
 */

const companies: Company[] = []
afterAll(async () => {
  for (const company of companies.splice(0)) await company.close()
  cleanupHomes()
})

/** `delegated` gives Artemis authority over the memo class; `escalated` denies. */
async function company(bench: 'delegated' | 'escalated'): Promise<Company> {
  const started = await startCompany({
    mayDecide: (request) =>
      bench === 'delegated'
        ? {
            allowed: true,
            countersignature: { by: 'agent.artemis', under: `memo:${request.domain}` }
          }
        : { allowed: false, because: `no delegated authority for memo/${request.domain}` }
  })
  companies.push(started)
  started.hire('agent.artemis')
  started.hire('agent.mason')
  return started
}

/** A real agent really edits package.json, and the choke point sees it. */
async function addADependency(eph: Company, agentId = 'agent.mason'): Promise<void> {
  await eph.runTurn(agentId, [
    { kind: 'hook', event: 'pre-tool', payload: { tool: 'Edit', path: 'package.json' } },
    { kind: 'hook', event: 'post-tool', payload: { tool: 'Edit', path: 'package.json' } },
    { kind: 'exit', code: 0 }
  ])
}

function memoBody(gateId: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: MEMO_SCHEMA_VERSION,
    kind: 'memo',
    gateId,
    trigger: 'new-dependency',
    title: 'Add zod for payload validation',
    context: 'The hook payloads are unvalidated.',
    options: ['zod', 'hand-written guards'],
    recommendation: 'zod',
    blastRadius: 'every hook payload path',
    rollback: 'remove it and restore the guards',
    taskId: null,
    ...over
  })
}

async function fileMemo(eph: Company, gateId: string, over = {}): Promise<void> {
  await eph.runTurn('agent.mason', [
    sendStep(
      scenarioMessage({
        from: 'agent.mason',
        to: ODEON_ENDPOINT,
        act: 'propose',
        subject: 'memo',
        body: memoBody(gateId, over)
      })
    )
  ])
  await eph.hermes.sweep()
}

function memoDirs(eph: Company): string[] {
  const dir = path.join(eph.agora.root, 'odeon', 'memos')
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
}

describe('S-MEMO — a policy trigger HOLDS the action', () => {
  it('holds a real dependency edit, and names the trigger on the gate', async () => {
    const eph = await company('escalated')
    await addADependency(eph)

    const gate = eph.gates.list().find((open) => open.memoTrigger !== null)
    expect(gate).toBeDefined()
    expect(gate?.memoTrigger).toBe('new-dependency')
    expect(gate?.agentId).toBe('agent.mason')
  })

  it('lets ordinary work through untouched', async () => {
    const eph = await company('escalated')
    await eph.runTurn('agent.mason', [
      { kind: 'hook', event: 'pre-tool', payload: { tool: 'Edit', path: 'src/checkout.ts' } },
      { kind: 'exit', code: 0 }
    ])
    expect(eph.gates.list().filter((open) => open.memoTrigger !== null)).toEqual([])
  })
})

describe('S-MEMO — the memo goes to the bench that may decide it', () => {
  it('routes to ARTEMIS when the authority table delegates the class', async () => {
    const eph = await company('delegated')
    await addADependency(eph)
    const gate = eph.gates.list().find((open) => open.memoTrigger !== null)
    await fileMemo(eph, gate?.id ?? '')

    expect(memoDirs(eph)).toHaveLength(1)
    expect(eph.triaged.join(' ')).toContain('delegated')
  })

  it('escalates to the ARCHITECT when it does not', async () => {
    const eph = await company('escalated')
    await addADependency(eph)
    const gate = eph.gates.list().find((open) => open.memoTrigger !== null)
    await fileMemo(eph, gate?.id ?? '')

    expect(eph.triaged.join(' ')).toContain('escalated')
    expect(eph.odeon.memos('open')).toHaveLength(1)
  })

  it('records a COUNTERSIGNATURE on a delegated verdict (FR-5.5)', async () => {
    const eph = await company('delegated')
    await addADependency(eph)
    const gate = eph.gates.list().find((open) => open.memoTrigger !== null)
    await fileMemo(eph, gate?.id ?? '')
    const memoId = memoDirs(eph)[0] ?? ''

    const settled = eph.odeon.decideMemo({
      memoId,
      verdict: 'approved',
      notes: 'pin the version',
      decider: { kind: 'orchestrator', agentId: 'agent.artemis', under: 'memo:new-dependency' }
    })

    expect(settled.ok).toBe(true)
    const verdict = JSON.parse(
      fs.readFileSync(path.join(eph.agora.root, 'odeon', 'memos', memoId, 'verdict.json'), 'utf8')
    )
    expect(verdict).toMatchObject({
      decidedBy: 'agent.artemis',
      countersigned: true,
      authority: 'memo:new-dependency'
    })
  })

  it('records an ARCHITECT verdict without one, and says so', async () => {
    const eph = await company('escalated')
    await addADependency(eph)
    const gate = eph.gates.list().find((open) => open.memoTrigger !== null)
    await fileMemo(eph, gate?.id ?? '')
    const memoId = memoDirs(eph)[0] ?? ''

    eph.odeon.decideMemo({
      memoId,
      verdict: 'approved',
      notes: '',
      decider: { kind: 'architect' }
    })

    const verdict = JSON.parse(
      fs.readFileSync(path.join(eph.agora.root, 'odeon', 'memos', memoId, 'verdict.json'), 'utf8')
    )
    expect(verdict).toMatchObject({ decidedBy: 'architect', countersigned: false, authority: null })
  })
})

describe('S-MEMO — a rejection REVERSES the held action', () => {
  it('denies the gate, so the action never runs', async () => {
    const eph = await company('escalated')
    await addADependency(eph)
    const gate = eph.gates.list().find((open) => open.memoTrigger !== null)
    await fileMemo(eph, gate?.id ?? '')
    const memoId = memoDirs(eph)[0] ?? ''

    const settled = eph.odeon.decideMemo({
      memoId,
      verdict: 'rejected',
      notes: 'no new dependency this sprint',
      decider: { kind: 'architect' }
    })

    expect(settled.ok).toBe(true)
    if (settled.ok) expect(settled.gateVerdict).toBe('denied')
  })

  it('also denies on `amended`, because that is a different action', async () => {
    const eph = await company('escalated')
    await addADependency(eph)
    const gate = eph.gates.list().find((open) => open.memoTrigger !== null)
    await fileMemo(eph, gate?.id ?? '')

    const settled = eph.odeon.decideMemo({
      memoId: memoDirs(eph)[0] ?? '',
      verdict: 'amended',
      notes: 'use the guards, but generate them',
      decider: { kind: 'architect' }
    })
    if (settled.ok) expect(settled.gateVerdict).toBe('denied')
  })
})

describe('S-MEMO — the archive is immutable', () => {
  it('gives a memo exactly one verdict', async () => {
    const eph = await company('escalated')
    await addADependency(eph)
    const gate = eph.gates.list().find((open) => open.memoTrigger !== null)
    await fileMemo(eph, gate?.id ?? '')
    const memoId = memoDirs(eph)[0] ?? ''

    const decider = { kind: 'architect' } as const
    expect(eph.odeon.decideMemo({ memoId, verdict: 'approved', notes: '', decider }).ok).toBe(true)
    expect(eph.odeon.decideMemo({ memoId, verdict: 'rejected', notes: '', decider }).ok).toBe(false)

    const verdict = JSON.parse(
      fs.readFileSync(path.join(eph.agora.root, 'odeon', 'memos', memoId, 'verdict.json'), 'utf8')
    )
    expect(verdict.verdict).toBe('approved')
  })

  it('keeps the memo on file even when it is rejected', async () => {
    const eph = await company('escalated')
    await addADependency(eph)
    const gate = eph.gates.list().find((open) => open.memoTrigger !== null)
    await fileMemo(eph, gate?.id ?? '')
    eph.odeon.decideMemo({
      memoId: memoDirs(eph)[0] ?? '',
      verdict: 'rejected',
      notes: 'no',
      decider: { kind: 'architect' }
    })

    expect(memoDirs(eph)).toHaveLength(1)
    expect(eph.odeon.memos('decided')).toHaveLength(1)
  })

  it('refuses a memo answering a gate that holds somebody else', async () => {
    const eph = await company('escalated')
    eph.hire('agent.scribe')
    await addADependency(eph, 'agent.scribe')
    const gate = eph.gates.list().find((open) => open.memoTrigger !== null)

    // agent.mason files against agent.scribe's hold.
    await fileMemo(eph, gate?.id ?? '')
    expect(memoDirs(eph)).toEqual([])
  })
})

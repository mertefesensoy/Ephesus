import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Agora } from '../../src/main/agora'
import { PromptStore } from '../../src/main/prompts'
import { foldIncidents } from '../../src/shared/incident-view'
import { removeTempDir } from '../tmpdir'

/**
 * D3 (M8.10) — every reader of the book of record, across a rotation boundary.
 *
 * ## Why this file exists separately from `log-rotation.test.ts`
 *
 * That file proves the mechanism. This one proves the CONSEQUENCE, which is
 * where a rotation goes wrong in a way nobody notices for a week.
 *
 * Rotation moves history into another file. Every log-derived surface in the
 * company is a fold over the Agora's readers:
 *
 *  - the incident board          `index.ts` — `foldIncidents(agora.readLogAll())`
 *  - the standup's facts         `index.ts` — `readLogSince(sinceSeq)`
 *  - the org metrics             `index.ts` — `readLogAll()`
 *  - the Gymnasium history       `index.ts` — `readLogAll()` filtered to `gym`
 *  - the degradation replay      `index.ts` — `tailLog(DEGRADATION_REPLAY_LIMIT)`
 *  - the Activity feed           `ipc.ts`   — `readLog(afterSeq, limit)` / `tailLog`
 *
 * Every one of them needs the whole history, and NONE of them was changed.
 * That is the decision this file records: rotation is invisible above the
 * `Agora` seam, because the read path spans segments and live. A reader that
 * wants only the newest entries (`tailLog`) gets cheaper; a reader that wants
 * everything gets exactly what it got before.
 *
 * The incident board is the one that would have failed WORST and most quietly.
 * `incident-view.ts` drops an incident whose `raised` row is missing — so a
 * rotation that left the `raised` row in an archive nobody read would not show
 * a truncated incident, it would show an EMPTY PANEL, with the incidents still
 * open and nothing anywhere saying they existed.
 *
 * ## Fixture shape, so the numbers carry their condition
 *
 * A real `Agora` on a real filesystem, rotating at 32 KiB instead of the
 * shipped 4 MiB, with a filler row padded to ~512 bytes. Incidents are raised
 * FIRST and then buried under enough filler to seal several segments, and each
 * test ASSERTS that the opening row really did leave the live file — a test
 * that did not check its own premise would pass having proved nothing.
 */

const temps: string[] = []
const agoras: Agora[] = []

afterEach(async () => {
  for (const agora of agoras.splice(0)) await agora.drained().catch(() => {})
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

const ROTATE_AT = 32 * 1024
const PAD = 512

function agoraRig(
  extra: {
    slowReadMs?: number
    onSlowRead?: (info: { entries: number; bytes: number; ms: number }) => void
  } = {}
): Agora {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-readers-'))
  temps.push(home)
  const prompts = new PromptStore(path.join(home, 'prompts'), path.join(home, 'bundled'))
  const agora = new Agora({
    root: path.join(home, 'agora'),
    prompts,
    backoffMs: 1,
    rotateAtBytes: ROTATE_AT,
    ...(extra.slowReadMs === undefined ? {} : { slowReadMs: extra.slowReadMs }),
    ...(extra.onSlowRead ? { onSlowRead: extra.onSlowRead } : {})
  })
  agoras.push(agora)
  return agora
}

/** Filler that pushes the live file over the boundary. */
function bury(agora: Agora, rows: number): void {
  for (let i = 0; i < rows; i += 1) {
    agora.appendLog({
      kind: 'hook',
      event: 'wake',
      agentId: 'agent.filler',
      because: `filler ${String(i)} ${'.'.repeat(PAD)}`
    })
  }
}

/** How many filler rows it takes to seal roughly `segments` files. */
function fillerFor(segments: number): number {
  return Math.ceil((segments * ROTATE_AT) / PAD)
}

/** The seqs held by the LIVE file — everything else is in the archive. */
function liveSeqs(agora: Agora): ReadonlySet<number> {
  const file = agora.pathOf('log.jsonl')
  const seqs = new Set<number>()
  if (!fs.existsSync(file)) return seqs
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const parsed: unknown = JSON.parse(line)
      const seq = (parsed as { seq?: unknown }).seq
      if (typeof seq === 'number') seqs.add(seq)
    } catch {
      // A torn line contributes nothing.
    }
  }
  return seqs
}

describe('D3 — the incident board survives a rotation', () => {
  it('still shows an incident whose raised row is in the archive', () => {
    const agora = agoraRig()

    // Raised first, then buried. This is the ordering a naive rotation breaks:
    // the fold drops an incident whose `raised` row it cannot see, so the panel
    // would go EMPTY rather than stale.
    const raised = agora.appendLog({
      kind: 'profile',
      event: 'incident-raised',
      incident: 'owner/app#run:41',
      instanceId: 'skeleton-crew@repo:myapp',
      repo: 'owner/app',
      ref: 41,
      conclusion: 'failure',
      oncall: 'agent.oncall',
      playbook: 'incident.md'
    })
    bury(agora, fillerFor(3))

    // The premise, asserted rather than assumed.
    expect(liveSeqs(agora).has(raised.seq)).toBe(false)
    expect(agora.logSegments().length).toBeGreaterThan(0)

    const board = foldIncidents(agora.readLogAll())
    const found = board.incidents.find((row) => row.key === 'owner/app#run:41')
    expect(found).toBeDefined()
    expect(found?.oncall).toBe('agent.oncall')
    expect(found?.repo).toBe('owner/app')
    // The timestamp is the one it was RAISED at, not one invented from
    // whichever row happened to survive.
    expect(found?.raisedAt).toBe(raised.ts)
  })

  it('folds an incident whose rows straddle the boundary', () => {
    const agora = agoraRig()
    const raised = agora.appendLog({
      kind: 'profile',
      event: 'incident-raised',
      incident: 'owner/app#run:42',
      instanceId: 'skeleton-crew@repo:myapp',
      repo: 'owner/app',
      ref: 42,
      conclusion: 'failure',
      oncall: 'agent.oncall',
      playbook: 'incident.md'
    })
    bury(agora, fillerFor(2))
    // The triage lands in the live file, long after the opening row was sealed.
    // A reader that saw only one side would report the wrong STAGE.
    agora.appendLog({
      kind: 'profile',
      event: 'incident-triaged',
      incident: 'owner/app#run:42',
      severity: 2,
      summary: 'a flaky integration test',
      resolved: true,
      by: 'agent.oncall'
    })

    expect(liveSeqs(agora).has(raised.seq)).toBe(false)
    const found = foldIncidents(agora.readLogAll()).incidents.find(
      (row) => row.key === 'owner/app#run:42'
    )
    expect(found?.severity).toBe(2)
    expect(found?.summary).toBe('a flaky integration test')
    expect(found?.triagedBy).toBe('agent.oncall')
  })

  it('attributes a refusal to an incident raised before the rotation', () => {
    const agora = agoraRig()
    const raised = agora.appendLog({
      kind: 'profile',
      event: 'incident-raised',
      incident: 'owner/app#run:43',
      instanceId: 'skeleton-crew@repo:myapp',
      repo: 'owner/app',
      ref: 43,
      conclusion: 'failure',
      oncall: 'agent.oncall',
      playbook: 'incident.md'
    })
    bury(agora, fillerFor(2))
    agora.appendLog({
      kind: 'profile',
      event: 'incident-triage-refused',
      incident: 'owner/app#run:43',
      from: 'agent.artemis',
      reasons: ['you were not asked to reply here']
    })

    expect(liveSeqs(agora).has(raised.seq)).toBe(false)
    const board = foldIncidents(agora.readLogAll())
    const found = board.incidents.find((row) => row.key === 'owner/app#run:43')
    // Attributed, not dumped in the unattributed bucket — which is what would
    // happen if the fold could not see the incident that was raised.
    expect(found?.refusals).toHaveLength(1)
    expect(board.unattributedRefusals).toHaveLength(0)
  })
})

describe('D3 — the other log-derived surfaces', () => {
  it('readLogAll returns every entry ever written, in order', () => {
    const agora = agoraRig()
    const written = fillerFor(3)
    bury(agora, written)

    const all = agora.readLogAll()
    expect(all).toHaveLength(written)
    expect(all.map((entry) => entry.seq)).toEqual(Array.from({ length: written }, (_, i) => i + 1))
    // Genuinely rotated, or this asserts nothing.
    expect(agora.logSegments().length).toBeGreaterThanOrEqual(2)
  })

  it('the Gymnasium history sees a row recorded before the rotation', () => {
    const agora = agoraRig()
    const filed = agora.appendLog({
      kind: 'gym',
      event: 'filed',
      gymId: 'gym-11',
      evidence: 'the suite took 99 seconds'
    })
    bury(agora, fillerFor(2))

    expect(liveSeqs(agora).has(filed.seq)).toBe(false)
    // The production expression, verbatim.
    const gymEvents = agora.readLogAll().filter((entry) => entry['kind'] === 'gym')
    expect(gymEvents.map((entry) => entry['gymId'])).toEqual(['gym-11'])
  })

  it('the standup sees a fact recorded before the rotation', () => {
    const agora = agoraRig()
    const created = agora.appendLog({
      kind: 'task',
      event: 'created',
      taskId: 'task-1',
      assignee: 'agent.mason',
      because: 'the brief must still be able to see this next week'
    })
    bury(agora, fillerFor(2))

    expect(liveSeqs(agora).has(created.seq)).toBe(false)
    // A brief compiled from cursor zero — the standup catching up over a long
    // window, which is exactly when the archive matters.
    const tasks = agora.readLogSince(0).filter((entry) => entry.kind === 'task')
    expect(tasks.map((entry) => entry['taskId'])).toEqual(['task-1'])
  })

  it('a cursor read after the rotation returns only what followed it', () => {
    const agora = agoraRig()
    bury(agora, fillerFor(2))
    const cursor = agora.readLogAll().length
    const after = agora.appendLog({ kind: 'hook', event: 'wake', agentId: 'agent.a' })

    expect(agora.readLogSince(cursor).map((entry) => entry.seq)).toEqual([after.seq])
  })

  it('the degradation replay gets the NEWEST entries, not the oldest', () => {
    const agora = agoraRig()
    bury(agora, fillerFor(3))
    const total = agora.readLogAll().length

    expect(agora.tailLog(5).map((entry) => entry.seq)).toEqual([
      total - 4,
      total - 3,
      total - 2,
      total - 1,
      total
    ])
  })

  it('the Activity feed pages forward across the boundary', () => {
    const agora = agoraRig()
    bury(agora, fillerFor(2))

    // The first page lives in the OLDEST segment; the read then continues from
    // where it left off, which is the paging contract `ipc.ts` relies on.
    expect(agora.readLog(0, 10).map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(agora.readLog(10, 10).map((entry) => entry.seq)).toEqual([
      11, 12, 13, 14, 15, 16, 17, 18, 19, 20
    ])
  })

  it('reports the size of the WHOLE book, not just the live file', () => {
    const slow: { entries: number; bytes: number; ms: number }[] = []
    // Every whole-log read counts as slow, so the reported size is captured.
    const agora = agoraRig({ slowReadMs: 0, onSlowRead: (info) => slow.push({ ...info }) })
    bury(agora, fillerFor(3))

    const all = agora.readLogAll()
    const last = slow.at(-1)
    expect(last).toBeDefined()
    // A figure that counted only the live file would report a rotated history
    // as a few kilobytes and make the degradation lie about its own cause.
    expect(last?.bytes ?? 0).toBeGreaterThan(3 * ROTATE_AT)
    expect(last?.entries).toBe(all.length)
  })
})

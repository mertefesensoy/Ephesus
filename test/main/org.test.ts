import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LogEntry } from '../../src/shared/log'
import { OrgLayer } from '../../src/main/org'

/**
 * The retro archive (FR-11.5, UC-12).
 *
 * The driver computes and archives; it never acts. These assert exactly that
 * boundary, plus the archive's own rule — a retro is written once and never
 * revised (invariant §5).
 */

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

let seq = 0
function event(over: Partial<LogEntry> & { kind: LogEntry['kind'] }): LogEntry {
  seq += 1
  return { ts: 1_787_900_000_000, seq, ...over } as LogEntry
}

function rig(events: LogEntry[] = [], at = new Date('2026-08-28T10:00:00.000Z')) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-org-'))
  homes.push(home)
  const agoraRoot = path.join(home, 'agora')
  const logs: Record<string, unknown>[] = []
  const commits: string[] = []
  const org = new OrgLayer({
    agoraRoot,
    gather: () => ({
      events,
      agents: ['agent.mason'],
      spend: [{ agentId: 'agent.mason', tokens: 1200 }]
    }),
    onLogEvent: (draft) => logs.push(draft),
    commitSoon: (subject) => commits.push(subject),
    now: () => at
  })
  return { org, logs, commits, agoraRoot }
}

describe('the retro archives, and only archives', () => {
  it('writes a dated markdown report', () => {
    const r = rig([
      event({ kind: 'task', event: 'update', status: 'done', assignee: 'agent.mason' })
    ])
    const outcome = r.org.generate()

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.ref).toContain('odeon/retros/')
    const md = fs.readFileSync(path.join(r.agoraRoot, outcome.ref), 'utf8')
    expect(md).toContain('# Weekly retro')
    expect(md).toContain('agent.mason')
  })

  it('records the generation in the book of record (NFR-13)', () => {
    const r = rig()
    r.org.generate()
    expect(r.logs[0]).toMatchObject({ kind: 'orchestrator', event: 'retro' })
  })

  it('commits through the single committer, never writing git itself', () => {
    const r = rig()
    r.org.generate()
    expect(r.commits[0]).toContain('retro')
  })

  it('REFUSES to overwrite a retro already at that name', () => {
    // The archive only ever grows (invariant §5).
    const r = rig()
    expect(r.org.generate().ok).toBe(true)
    const second = r.org.generate()
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toContain('already archived')
  })

  it('lists archived retros newest first', () => {
    const r = rig()
    r.org.generate()
    const listed = r.org.retros()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.markdown).toContain('Weekly retro')
  })

  it('recomputes the report on every read, holding nothing', () => {
    const r = rig()
    expect(r.org.report()).toEqual(r.org.report())
  })

  it('offers the scheduler a trigger with a retro id', () => {
    expect(rig().org.trigger(1_000)).toMatchObject({ id: 'retro', everyMs: 1_000 })
  })
})

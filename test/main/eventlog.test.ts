import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EventLog } from '../../src/main/eventlog'
import { LOG_KINDS, formatLogLine, parseLogLine } from '../../src/shared/log'

/**
 * The book of record (SDD §4.3, NFR-13, invariant §5). What these tests defend
 * is one property: **nothing ever rewrites this file.** A killed harness can
 * leave a torn line, and the correct response is to read around it — not to
 * repair it, because repairing is rewriting.
 */

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function logFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-log-'))
  temps.push(dir)
  return path.join(dir, 'log.jsonl')
}

describe('log line format (SDD §4.3)', () => {
  it('carries the twenty-five documented kinds', () => {
    expect([...LOG_KINDS]).toEqual([
      'message',
      'delivery',
      'bounce',
      'spawn',
      'exit',
      'ghost',
      'hook',
      'task',
      'gate',
      'memo',
      'brief',
      'deck',
      'meeting',
      'breaker',
      'budget',
      // SDD §4.3 has listed `memory` since the M4 close (Architect-ratified);
      // the code list omitted it until the M5 close-out audit (finding 11).
      'memory',
      // Added in M3.7: FR-5.5 requires everything Artemis decides under
      // delegated authority to be auditable, and no existing kind carried it.
      'orchestrator',
      'remote',
      'secret-rotated',
      'profile',
      'gym',
      // The Stoa's research cycle (SDD §7.7) — listed at the M5 close-out so
      // M5b.2's first emitter finds its kind documented, not invented.
      'stoa',
      // Added by GYM-003: closing time's begin / ack / complete (SDD §4.3).
      'shutdown',
      // Provider capacity: parked / resuming / cleared. Its own kind because a
      // healthy agent the provider declined to serve is neither a `breaker`
      // trip nor an `exit`, and a forensic reader who cannot tell the three
      // apart cannot reconstruct what the company did (NFR-13).
      'capacity',
      'error'
    ])
  })

  it('keeps arbitrary refs, because each kind carries different ones', () => {
    const entry = parseLogLine(
      JSON.stringify({
        ts: 1,
        seq: 2,
        kind: 'message',
        from: 'agent.mason',
        to: 'agent.artemis',
        act: 'inform',
        msgId: 'm-1',
        conversation: 'conv-7f3'
      })
    )
    expect(entry).toMatchObject({ from: 'agent.mason', conversation: 'conv-7f3' })
  })

  it('rejects an entry missing its envelope, and never throws doing it', () => {
    for (const line of ['', '   ', 'not json', '{}', '{"ts":1,"seq":2}', '{"kind":"message"}']) {
      expect(parseLogLine(line)).toBeNull()
    }
  })

  it('rejects an unknown kind — the vocabulary is the contract', () => {
    expect(parseLogLine(JSON.stringify({ ts: 1, seq: 1, kind: 'gossip' }))).toBeNull()
  })

  it('always serialises to exactly one line', () => {
    const line = formatLogLine({ ts: 1, seq: 1, kind: 'error', detail: 'line one\nline two' })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.trimEnd().includes('\n')).toBe(false)
  })
})

describe('EventLog — appending', () => {
  it('stamps ts and seq itself, so callers cannot collide or reorder history', () => {
    const log = new EventLog(logFile())
    const first = log.append({ kind: 'spawn', agentId: 'agent.mason' })
    const second = log.append({ kind: 'exit', agentId: 'agent.mason', exitCode: 0 })

    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
    expect(second.ts).toBeGreaterThanOrEqual(first.ts)
  })

  it('appends — never rewrites — so earlier bytes are byte-identical after a write', () => {
    const file = logFile()
    const log = new EventLog(file)
    log.append({ kind: 'spawn', agentId: 'agent.a' })
    const afterFirst = fs.readFileSync(file)

    log.append({ kind: 'spawn', agentId: 'agent.b' })
    const afterSecond = fs.readFileSync(file)

    expect(afterSecond.subarray(0, afterFirst.length).equals(afterFirst)).toBe(true)
  })

  it('resumes numbering across a restart', () => {
    const file = logFile()
    const first = new EventLog(file)
    first.append({ kind: 'spawn', agentId: 'agent.a' })
    first.append({ kind: 'spawn', agentId: 'agent.b' })

    const restarted = new EventLog(file)
    restarted.open()
    expect(restarted.nextSeq()).toBe(3)
    expect(restarted.append({ kind: 'exit', agentId: 'agent.a', exitCode: 0 }).seq).toBe(3)
  })
})

describe('EventLog — a torn tail from a killed harness', () => {
  it('ignores the partial line on read and leaves it on disk', () => {
    const file = logFile()
    const log = new EventLog(file)
    log.append({ kind: 'spawn', agentId: 'agent.a' })
    // A SIGKILL mid-write: half an entry, no trailing newline.
    fs.appendFileSync(file, '{"ts":123,"seq":2,"kind":"spa', 'utf8')
    const torn = fs.readFileSync(file, 'utf8')

    const restarted = new EventLog(file)
    expect(restarted.all().map((e) => e.seq)).toEqual([1])
    // Read did not touch the file.
    expect(fs.readFileSync(file, 'utf8')).toBe(torn)
  })

  it('resumes numbering from the last INTACT entry', () => {
    const file = logFile()
    const log = new EventLog(file)
    log.append({ kind: 'spawn', agentId: 'agent.a' })
    fs.appendFileSync(file, '{"ts":123,"seq":99,"kind":"spa', 'utf8')

    expect(new EventLog(file).append({ kind: 'exit', agentId: 'agent.a', exitCode: 0 }).seq).toBe(2)
  })

  it('starts the next entry on its own line, without repairing the torn one', () => {
    const file = logFile()
    new EventLog(file).append({ kind: 'spawn', agentId: 'agent.a' })
    fs.appendFileSync(file, '{"ts":123,"seq":2,"kind":"spa', 'utf8')

    const restarted = new EventLog(file)
    restarted.append({ kind: 'exit', agentId: 'agent.a', exitCode: 0 })

    const text = fs.readFileSync(file, 'utf8')
    // The torn bytes are still there, untouched, on their own line.
    expect(text).toContain('{"ts":123,"seq":2,"kind":"spa')
    expect(restarted.all().map((e) => e.kind)).toEqual(['spawn', 'exit'])
  })
})

describe('EventLog — reading (SDD §5 agora.log)', () => {
  it('pages by cursor, returning only entries after the given seq', () => {
    const log = new EventLog(logFile())
    for (let i = 0; i < 5; i += 1) log.append({ kind: 'hook', agentId: 'agent.a', i })

    expect(log.read(0).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
    expect(log.read(3).map((e) => e.seq)).toEqual([4, 5])
    expect(log.read(5)).toEqual([])
  })

  it('honours the limit', () => {
    const log = new EventLog(logFile())
    for (let i = 0; i < 10; i += 1) log.append({ kind: 'hook', agentId: 'agent.a', i })
    expect(log.read(0, 3).map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('reads an absent log as empty rather than failing a boot', () => {
    expect(new EventLog(path.join(os.tmpdir(), 'eph-nonexistent', 'log.jsonl')).read()).toEqual([])
  })
})

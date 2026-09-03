import { describe, expect, it } from 'vitest'
import { DegradationLog } from '../../src/main/degradations'
import {
  DEGRADATION_SOURCES,
  earnsLogLine,
  sourceOf,
  type DegradationRow
} from '../../src/shared/degradation'

/**
 * The degradation channel (M8.2) — invariant §7's "every degradation is a
 * visible UI state, never a silent fallback".
 *
 * What it replaced was a `console.warn` plus a fifty-entry array of
 * OCCURRENCES. Three things were wrong with that and each has cases here: it
 * never reached the book of record, so a night could not be reconstructed; it
 * vanished at restart, so every morning looked healthy; and it was keyed by
 * nothing, so the pacing check — which reports about once a second — evicted
 * everything else inside a minute.
 */

interface Rig {
  readonly log: DegradationLog
  readonly rows: DegradationRow[]
  readonly warnings: string[]
  tick(ms: number): void
}

function rig(over: { limit?: number } = {}): Rig {
  const rows: DegradationRow[] = []
  const warnings: string[] = []
  let clock = 1_000
  return {
    rows,
    warnings,
    tick: (ms) => {
      clock += ms
    },
    log: new DegradationLog({
      append: (row) => rows.push(row),
      warn: (line) => warnings.push(line),
      now: () => clock,
      ...(over.limit === undefined ? {} : { limit: over.limit })
    })
  }
}

describe('a degradation reaches the book of record', () => {
  it('appends the first report with its cause, source and wording', () => {
    const { log, rows } = rig()
    log.report('library/fts', 'no index — recall is on the grep rung')
    expect(rows).toEqual([
      {
        kind: 'degradation',
        source: 'library',
        cause: 'library/fts',
        detail: 'no index — recall is on the grep rung',
        count: 1,
        since: 1_000
      }
    ])
  })

  it('derives the source from the cause, so the two can never disagree', () => {
    const { log } = rig()
    log.report('usage/pacing', 'slow')
    expect(log.list()[0]?.source).toBe('usage')
    expect(sourceOf('capacity/parked:agent.mason')).toBe('capacity')
    // Every source in the vocabulary is recoverable from a cause built on it.
    for (const source of DEGRADATION_SOURCES) expect(sourceOf(`${source}/x`)).toBe(source)
  })

  it('still shows the condition when the log cannot be written', () => {
    // A channel that throws while reporting a failure is worse than none.
    const log = new DegradationLog({
      append: () => {
        throw new Error('disk full')
      }
    })
    expect(() => log.report('agora/commit', 'gave up')).not.toThrow()
    expect(log.list()).toHaveLength(1)
  })
})

describe('a repeating cause is one condition, not a flood', () => {
  it('keeps one entry with an exact count, however often it reports', () => {
    const { log } = rig()
    for (let i = 0; i < 3_000; i += 1) log.report('usage/pacing', `slow: ${String(i)}%`)
    const entries = log.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.count).toBe(3_000)
    // The latest wording, because the newest reading is the useful one.
    expect(entries[0]?.detail).toBe('slow: 2999%')
    // …and the identity is the cause, so refreshing the text never split it.
    expect(entries[0]?.cause).toBe('usage/pacing')
  })

  it('a flood cannot evict an unrelated condition — the B2 defect', () => {
    // The old ring held occurrences, so 50 pacing reports pushed out everything
    // the Architect actually needed to see. This one holds CAUSES.
    const { log } = rig({ limit: 4 })
    log.report('library/fts', 'no index')
    for (let i = 0; i < 500; i += 1) log.report('usage/pacing', `slow ${String(i)}`)
    expect(log.has('library/fts')).toBe(true)
    expect(log.list().map((entry) => entry.cause)).toEqual(['library/fts', 'usage/pacing'])
  })

  it('appends on a bounded ladder: first, then each power of ten', () => {
    const { log, rows } = rig()
    for (let i = 0; i < 1_000; i += 1) log.report('usage/pacing', 'slow')
    // 1, 10, 100, 1000 — four lines for a thousand reports.
    expect(rows.map((row) => row.count)).toEqual([1, 10, 100, 1_000])
    expect(earnsLogLine(1)).toBe(true)
    expect(earnsLogLine(10)).toBe(true)
    expect(earnsLogLine(11)).toBe(false)
    expect(earnsLogLine(100)).toBe(true)
    expect(earnsLogLine(0)).toBe(false)
  })

  it('distinct causes under one source stay distinct', () => {
    // `library` has four different things that can be wrong; a source-keyed
    // dedupe would have collapsed them into whichever spoke last.
    const { log } = rig()
    log.report('library/fts', 'no index')
    log.report('library/mempalace', 'not installed')
    log.report('library/recall-rung', 'on the grep rung')
    expect(log.list()).toHaveLength(3)
  })

  it('names the agent when the condition is per-agent', () => {
    const { log } = rig()
    log.report('capacity/parked:agent.mason', 'waiting for capacity')
    log.report('capacity/parked:agent.tess', 'waiting for capacity')
    // Two agents stuck is two problems, not one reported twice.
    expect(log.list()).toHaveLength(2)
  })
})

describe('a condition that ends says so', () => {
  it('writes a cleared row with how long it lasted, and drops the entry', () => {
    const { log, rows, tick } = rig()
    log.report('usage/pacing', 'slow')
    tick(60_000)
    log.clear('usage/pacing')
    expect(log.list()).toEqual([])
    expect(rows.at(-1)).toMatchObject({ event: 'cleared', forMs: 60_000, count: 1 })
  })

  it('is silent for a cause that was never reported', () => {
    // "It is not degraded" is not news, and a clear that had to be guarded at
    // every call site is a clear nobody would call.
    const { log, rows } = rig()
    log.clear('usage/pacing')
    expect(rows).toEqual([])
  })

  it('a cause that comes back is a new condition, with its own start', () => {
    const { log, tick } = rig()
    log.report('usage/pacing', 'slow')
    tick(1_000)
    log.clear('usage/pacing')
    tick(1_000)
    log.report('usage/pacing', 'slow again')
    expect(log.list()[0]).toMatchObject({ count: 1, since: 3_000 })
  })
})

describe('a restart shows what was true when we stopped', () => {
  const stored = (over: Partial<DegradationRow> & { ts?: number } = {}): unknown => ({
    ts: 5_000,
    seq: 1,
    kind: 'degradation',
    source: 'library',
    cause: 'library/fts',
    detail: 'no index',
    count: 3,
    since: 2_000,
    ...over
  })

  it('replays as CARRIED, never as live', () => {
    const { log } = rig()
    log.replay([stored()])
    expect(log.list()[0]).toMatchObject({
      cause: 'library/fts',
      count: 3,
      since: 2_000,
      lastSeen: 5_000,
      freshness: 'carried'
    })
  })

  it('does not replay a condition that had already cleared', () => {
    const { log } = rig()
    log.replay([stored(), stored({ event: 'cleared', ts: 6_000 })])
    expect(log.list()).toEqual([])
  })

  it('a live report replaces the carried entry, which is how it is confirmed', () => {
    const { log } = rig()
    log.replay([stored()])
    log.report('library/fts', 'still no index')
    const entry = log.list()[0]
    expect(entry?.freshness).toBe('live')
    expect(entry?.detail).toBe('still no index')
    // The count continues rather than restarting: it is the same condition.
    expect(entry?.count).toBe(4)
  })

  it('never overwrites something this session already observed', () => {
    const { log } = rig()
    log.report('library/fts', 'observed now')
    log.replay([stored({ detail: 'stale wording from yesterday' })])
    expect(log.list()[0]).toMatchObject({ detail: 'observed now', freshness: 'live', count: 1 })
  })

  it('falls back to the row’s own start when the entry carries no timestamp', () => {
    // A row written by an older version, or by hand: the reader takes what is
    // there rather than inventing a time it cannot know.
    const { log } = rig()
    const { ts, ...noTs } = stored() as Record<string, unknown>
    void ts
    log.replay([noTs])
    expect(log.list()[0]).toMatchObject({ since: 2_000, lastSeen: 2_000 })
  })

  it('appends nothing: a replay is a read', () => {
    const { log, rows } = rig()
    log.replay([stored()])
    expect(rows).toEqual([])
  })

  it('skips rows it cannot read rather than repairing them', () => {
    // The log is append-only and written by other versions of this app; a
    // reader that repaired a row would be rewriting the book of record.
    const { log } = rig()
    log.replay([
      { kind: 'message', from: 'agent.mason' },
      stored({ source: 'not-a-source' as 'library' }),
      { kind: 'degradation' },
      null,
      'nonsense',
      stored({ cause: 'usage/pacing', source: 'usage' })
    ])
    expect(log.list().map((entry) => entry.cause)).toEqual(['usage/pacing'])
  })
})

describe('the boot replay reads the tail, not the head', () => {
  it('takes the NEWEST entries — the head is what B3 got wrong', async () => {
    const { EventLog } = await import('../../src/main/eventlog')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const { removeTempDir } = await import('../tmpdir')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-degtail-'))
    try {
      const log = new EventLog(path.join(home, 'log.jsonl'))
      for (let i = 0; i < 600; i += 1) log.append({ kind: 'message', n: i })
      log.append({
        kind: 'degradation',
        source: 'library',
        cause: 'library/fts',
        detail: 'no index',
        count: 1,
        since: 1
      })

      // `read` pages forward from the oldest and would never reach it.
      const fromTheHead = log.read(0, 500)
      expect(fromTheHead.some((entry) => entry.kind === 'degradation')).toBe(false)

      const fromTheTail = log.tailOf(400)
      expect(fromTheTail.some((entry) => entry.kind === 'degradation')).toBe(true)
      expect(fromTheTail).toHaveLength(400)

      const replayed = rig()
      replayed.log.replay(fromTheTail)
      expect(replayed.log.list().map((entry) => entry.cause)).toEqual(['library/fts'])
    } finally {
      removeTempDir(home)
    }
  })
})

describe('when more things are wrong than the list can hold', () => {
  it('drops the OLDEST condition, so the newest problem is always visible', () => {
    const { log } = rig({ limit: 3 })
    log.report('library/fts', 'first')
    log.report('agora/commit', 'second')
    log.report('usage/pacing', 'third')
    log.report('secrets/broker', 'fourth')
    // Insertion order is first-report order, and eviction takes from that end:
    // a list that dropped the NEWEST would hide the thing that just broke.
    expect(log.list().map((entry) => entry.cause)).toEqual([
      'agora/commit',
      'usage/pacing',
      'secrets/broker'
    ])
    expect(log.has('library/fts')).toBe(false)
  })

  it('a repeat does not renew an entry: age is when it started, not when it last spoke', () => {
    const { log } = rig({ limit: 2 })
    log.report('library/fts', 'first')
    log.report('agora/commit', 'second')
    log.report('library/fts', 'first again')
    log.report('usage/pacing', 'third')
    // `library/fts` is still the oldest condition even though it spoke most
    // recently, so it is the one that goes.
    expect(log.list().map((entry) => entry.cause)).toEqual(['agora/commit', 'usage/pacing'])
  })

  it('holds the replayed list to the same cap', () => {
    const { log } = rig({ limit: 2 })
    log.replay(
      ['library/fts', 'agora/commit', 'usage/pacing'].map((cause, i) => ({
        ts: 1_000 + i,
        seq: i,
        kind: 'degradation',
        source: cause.slice(0, cause.indexOf('/')),
        cause,
        detail: 'carried',
        count: 1,
        since: 1_000
      }))
    )
    expect(log.list().map((entry) => entry.cause)).toEqual(['agora/commit', 'usage/pacing'])
  })
})

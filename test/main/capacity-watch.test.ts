import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CapacityLimit, ParkedAgent } from '../../src/shared/capacity'
import type { AgentSpawnConfig, EngineAdapter } from '../../src/main/engines'
import { claudeCapacityLimit } from '../../src/main/engines/claude'
import { CapacityWatch, readTail, type CapacityAgent } from '../../src/main/watch/capacity'

/**
 * The capacity watch (`src/main/watch/capacity.ts`).
 *
 * What this file is really asserting is a list of things that must NOT happen
 * when the provider refuses a turn: the pty is not killed, the agent is not
 * ghosted, and no respawn ladder is spent. Those are absences, and absences are
 * exactly what a test suite forgets to check — so the rig below records every
 * act the watch performs and the assertions name the acts that must be missing
 * as often as the ones that must be there.
 *
 * The detector itself is pinned in `engines/claude-capacity.test.ts` against
 * records a real engine wrote. This file uses that same real classifier rather
 * than a stub, so a green run here means the shipped pair works together.
 */

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-capacity-'))
  temps.push(dir)
  return dir
}

/** A refusal record in the shape the reference engine writes. */
function refusal(uuid: string, at: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    sessionId: 'sess-a',
    timestamp: at,
    error: 'rate_limit',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    message: {
      model: '<synthetic>',
      content: [{ type: 'text', text: "You're out of usage credits." }]
    },
    ...extra
  })
}

/** An ordinary assistant turn. */
function turn(uuid: string, at: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    sessionId: 'sess-a',
    timestamp: at,
    message: { model: 'claude-opus-4-5', usage: { input_tokens: 10, output_tokens: 5 } }
  })
}

interface Rig {
  readonly watch: CapacityWatch
  readonly dir: string
  readonly parked: ParkedAgent[]
  readonly resumed: ParkedAgent[]
  readonly cleared: ParkedAgent[]
  readonly degraded: string[]
  write(lines: readonly string[]): void
  advance(ms: number): void
  setAlive(alive: boolean): void
  clock(): number
}

function rig(
  options: {
    readonly limitOf?: EngineAdapter['transcripts'] extends undefined ? never : boolean
  } = {}
): Rig {
  const dir = tempDir()
  let now = Date.parse('2026-08-30T22:00:00.000Z')
  let alive = true
  const parked: ParkedAgent[] = []
  const resumed: ParkedAgent[] = []
  const cleared: ParkedAgent[] = []
  const degraded: string[] = []
  const watchable = options.limitOf !== false

  const adapter = {
    id: 'claude',
    transcripts: {
      transcriptDir: () => dir,
      read: () => Promise.resolve([]),
      // The SHIPPED classifier, not a stand-in.
      ...(watchable ? { limitOf: claudeCapacityLimit } : {})
    }
  } as unknown as EngineAdapter

  const agent: CapacityAgent = {
    agentId: 'agent.mason',
    adapter,
    cfg: { cwd: dir } as unknown as AgentSpawnConfig,
    sessionIds: ['sess-a']
  }

  const watch = new CapacityWatch({
    agents: () => [agent],
    alive: () => alive,
    onPark: (row) => parked.push(row),
    onResume: (row) => resumed.push(row),
    onClear: (row) => cleared.push(row),
    onDegraded: (detail) => degraded.push(detail),
    now: () => now
  })

  return {
    watch,
    dir,
    parked,
    resumed,
    cleared,
    degraded,
    write: (lines) => {
      fs.appendFileSync(path.join(dir, 'sess-a.jsonl'), `${lines.join('\n')}\n`)
    },
    advance: (ms) => {
      now += ms
    },
    setAlive: (value) => {
      alive = value
    },
    clock: () => now
  }
}

describe('CapacityWatch', () => {
  it('parks the agent when the provider refuses a turn', async () => {
    // Stamped at the rig's own clock, so the first rung has not elapsed and
    // this test observes a park and nothing else.
    const r = rig()
    r.write([turn('t1', '2026-08-30T21:40:00.000Z'), refusal('u1', '2026-08-30T22:00:00.000Z')])

    await r.watch.tick()

    expect(r.parked).toHaveLength(1)
    expect(r.parked[0]?.agentId).toBe('agent.mason')
    expect(r.parked[0]?.phase).toBe('parked')
    expect(r.parked[0]?.attempts).toBe(0)
    expect(r.parked[0]?.processAlive).toBe(true)
    expect(r.parked[0]?.limit.detail).toContain('out of usage credits')
    // The absences that matter: nothing was resumed, nothing was cleared, and
    // the watch owns no kill or respawn to have called.
    expect(r.resumed).toHaveLength(0)
    expect(r.cleared).toHaveLength(0)
    expect(r.watch.anyParked()).toBe(true)
  })

  it('parks once per refusal, not once per look', async () => {
    const r = rig()
    r.write([refusal('u1', '2026-08-30T22:00:00.000Z')])

    await r.watch.tick()
    await r.watch.tick()
    await r.watch.tick()

    expect(r.parked).toHaveLength(1)
  })

  it('leaves an ordinary transcript alone', async () => {
    const r = rig()
    r.write([turn('t1', '2026-08-30T21:40:00.000Z'), turn('t2', '2026-08-30T21:41:00.000Z')])

    await r.watch.tick()

    expect(r.parked).toHaveLength(0)
    expect(r.watch.anyParked()).toBe(false)
    expect(r.watch.view().parked).toHaveLength(0)
  })

  it('continues the agent when the wait elapses, through its live session', async () => {
    const r = rig()
    r.write([refusal('u1', '2026-08-30T22:00:00.000Z')])
    await r.watch.tick()
    expect(r.resumed).toHaveLength(0)

    // Not yet due: the first rung is a minute.
    r.advance(30_000)
    await r.watch.tick()
    expect(r.resumed).toHaveLength(0)

    r.advance(31_000)
    await r.watch.tick()

    expect(r.resumed).toHaveLength(1)
    expect(r.resumed[0]?.phase).toBe('resuming')
    // The process never died, so the continuation goes into the conversation it
    // was already having — no respawn, no new session, no lost context.
    expect(r.resumed[0]?.processAlive).toBe(true)
  })

  it('takes the respawn path only when the process did not survive the wait', async () => {
    const r = rig()
    r.write([refusal('u1', '2026-08-30T22:00:00.000Z')])
    await r.watch.tick()
    expect(r.parked[0]?.processAlive).toBe(true)

    // The pty dies during the park. The agent is still owed a continuation.
    r.setAlive(false)
    r.advance(61_000)
    await r.watch.tick()

    expect(r.resumed).toHaveLength(1)
    expect(r.resumed[0]?.processAlive).toBe(false)
  })

  it('re-parks one rung higher when the continuation is refused again', async () => {
    const r = rig()
    r.write([refusal('u1', '2026-08-30T22:00:00.000Z')])
    await r.watch.tick()
    r.advance(61_000)
    await r.watch.tick()
    expect(r.resumed).toHaveLength(1)

    // The provider refuses the continuation too.
    r.write([refusal('u2', new Date(r.clock()).toISOString())])
    await r.watch.tick()

    expect(r.parked).toHaveLength(2)
    expect(r.parked[1]?.attempts).toBe(1)
    // `since` is the original park: the Architect is told how long this has been
    // going on, not how long the latest rung has.
    expect(r.parked[1]?.since).toBe(r.parked[0]?.since)
    // Second rung is five minutes, so a minute later it is still not due.
    r.advance(61_000)
    await r.watch.tick()
    expect(r.resumed).toHaveLength(1)
  })

  it('clears the park when the continuation is not refused again', async () => {
    const r = rig()
    r.write([refusal('u1', '2026-08-30T22:00:00.000Z')])
    await r.watch.tick()
    r.advance(61_000)
    await r.watch.tick()
    expect(r.resumed).toHaveLength(1)
    expect(r.cleared).toHaveLength(0)

    // The verification window closes with no fresh refusal.
    r.advance(121_000)
    await r.watch.tick()

    expect(r.cleared).toHaveLength(1)
    expect(r.watch.anyParked()).toBe(false)
    expect(r.watch.parked('agent.mason')).toBeNull()
  })

  it('is due immediately for a refusal that landed while the harness was down', async () => {
    const r = rig()
    // Three hours old: the wait is measured from the refusal, not from now, so
    // an Architect who restarts in the morning does not serve the minute again.
    r.write([refusal('u1', new Date(r.clock() - 3 * 60 * 60_000).toISOString())])

    await r.watch.tick()

    expect(r.parked).toHaveLength(1)
    expect(r.resumed).toHaveLength(1)
  })

  it("waits for the provider's reset time when the provider names one", async () => {
    const r = rig()
    const resetsAt = Math.floor((r.clock() + 40 * 60_000) / 1000)
    r.write([refusal('u1', new Date(r.clock()).toISOString(), { quotaLimits: { resetsAt } })])
    await r.watch.tick()

    // Forty minutes beats the ladder's first rung of one minute: the provider
    // knows and we do not.
    r.advance(61_000)
    await r.watch.tick()
    expect(r.resumed).toHaveLength(0)

    r.advance(40 * 60_000)
    await r.watch.tick()
    expect(r.resumed).toHaveLength(1)
  })

  it('says out loud that an engine with no limit signal cannot be parked', async () => {
    const r = rig({ limitOf: false })
    r.write([refusal('u1', '2026-08-30T22:00:00.000Z')])

    await r.watch.tick()
    await r.watch.tick()

    expect(r.parked).toHaveLength(0)
    // Once, not once per tick — and it names the consequence rather than only
    // the fact (invariant §7).
    expect(r.degraded).toHaveLength(1)
    expect(r.degraded[0]).toContain('will not be parked or resumed')
  })

  it('reads a refusal at the tail of a transcript far larger than the window', async () => {
    const r = rig()
    // A megabyte of noise ahead of it, so the read is genuinely a tail read and
    // the first line in the window is a torn fragment.
    const filler = Array.from({ length: 4_000 }, (_v, i) =>
      turn(`t${String(i)}`, '2026-08-30T21:40:00.000Z')
    )
    r.write([...filler, refusal('u1', '2026-08-30T22:00:00.000Z')])
    expect(fs.statSync(path.join(r.dir, 'sess-a.jsonl')).size).toBeGreaterThan(512 * 1024)

    await r.watch.tick()

    expect(r.parked).toHaveLength(1)
    expect(r.parked[0]?.limit.recordId).toBe('u1')
  })

  it('forgets an agent only when asked', async () => {
    const r = rig()
    r.write([refusal('u1', '2026-08-30T22:00:00.000Z')])
    await r.watch.tick()
    expect(r.watch.anyParked()).toBe(true)

    r.watch.forget('agent.mason')

    expect(r.watch.anyParked()).toBe(false)
    expect(r.watch.view().parked).toHaveLength(0)
  })

  it('publishes a view the strip can read', async () => {
    const r = rig()
    r.write([refusal('u1', '2026-08-30T22:00:00.000Z')])
    await r.watch.tick()

    const view = r.watch.view()
    expect(view.parked).toHaveLength(1)
    expect(view.since).toBe(r.parked[0]?.since)
    expect(view.retryAt).toBe(r.parked[0]?.retryAt)
  })

  it('survives a transcript directory that is not there', async () => {
    const r = rig()
    fs.rmSync(r.dir, { recursive: true, force: true })

    await expect(r.watch.tick()).resolves.toBeUndefined()

    expect(r.parked).toHaveLength(0)
    expect(r.degraded).toHaveLength(0)
  })
})

describe('readTail', () => {
  it('returns the last bytes of a file, not the whole of it', async () => {
    const dir = tempDir()
    const file = path.join(dir, 'big.txt')
    fs.writeFileSync(file, `${'a'.repeat(1000)}TAIL`)

    expect(await readTail(file, 8)).toBe('aaaaTAIL')
  })

  it('returns the whole file when it is shorter than the window', async () => {
    const dir = tempDir()
    const file = path.join(dir, 'small.txt')
    fs.writeFileSync(file, 'short')

    expect(await readTail(file, 4096)).toBe('short')
  })

  it('answers null for a file that is not there', async () => {
    // ENOENT is an answer, not an error: it is the ordinary first seconds of
    // every agent's life, before its engine has written a transcript.
    expect(await readTail(path.join(tempDir(), 'missing.jsonl'), 4096)).toBeNull()
  })
})

describe('the shipped classifier and the watch agree', () => {
  it('drives a park from a record the reference engine actually wrote', () => {
    // Belt and braces on the seam between the two files: the watch calls
    // `limitOf`, and `limitOf` IS the detector pinned against real records.
    const limit: CapacityLimit | null = claudeCapacityLimit(
      JSON.parse(refusal('u1', '2026-08-30T21:58:55.766Z'))
    )
    expect(limit?.kind).toBe('rate-limit')
  })
})

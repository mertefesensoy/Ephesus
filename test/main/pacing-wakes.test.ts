import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Agora } from '../../src/main/agora'
import { DONE_DIR, Hermes } from '../../src/main/hermes'
import { PromptStore } from '../../src/main/prompts'
import { composeMessage, makeMessageId, type Message } from '../../src/shared/message'
import type { Pace } from '../../src/shared/pacing'
import { UsageWatch } from '../../src/main/watch/usage-watch'
import { WakeClock } from '../../src/main/watch/wake-clock'

/**
 * Usage-aware pacing at the seam it actually runs on (ADR-0023).
 *
 * `test/shared/pacing.test.ts` covers the decision. This file covers the two
 * places the decision reaches production — `Hermes.wakeCheck` and
 * `Hermes.decideOnStop`, the only two paths in this harness that ISSUE a wake —
 * plus the wall-clock cap and the file the shim writes. On real fs in temp
 * dirs, with nothing mocked but the clock, because M6 taught this repository
 * that a green unit suite over an unreachable code path proves nothing.
 *
 * Production call path, for the record:
 *   src/main/index.ts  →  new Hermes({ pace: () => usageWatch.verdict().pace })
 *   src/main/hermes.ts →  wakeCheck() / decideOnStop() → wakeAllowed()
 *   src/shared/pacing.ts → mayWake()
 */

const BUNDLED_PROMPTS = fileURLToPath(new URL('../../prompts/', import.meta.url))
const temps: string[] = []
const routers: Hermes[] = []
const agoras: Agora[] = []

afterEach(async () => {
  for (const hermes of routers.splice(0)) hermes.stop()
  for (const agora of agoras.splice(0)) await agora.drained().catch(() => {})
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

const START = Date.UTC(2026, 8, 1, 12, 0, 0)

interface Rig {
  readonly hermes: Hermes
  readonly agora: Agora
  readonly home: string
  /** Advances the rig's clock. */
  advance(ms: number): void
  setPace(pace: Pace): void
  send(to: string): Message
  inbox(agentId: string): readonly string[]
  done(agentId: string): readonly string[]
  readonly nudges: string[]
  readonly deferrals: { agentId: string; pace: Pace; pendingMail: number }[]
}

async function rig(options: { slowWakeGapMs?: number } = {}): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-pace-'))
  temps.push(home)
  const agora = new Agora({
    root: path.join(home, 'agora'),
    prompts: new PromptStore(path.join(home, 'prompts'), BUNDLED_PROMPTS),
    backoffMs: 1
  })
  await agora.ensureRepo()
  agoras.push(agora)

  let now = START
  let pace: Pace = 'full'
  const nudges: string[] = []
  const deferrals: Rig['deferrals'] = []

  const hermes = new Hermes({
    agora,
    prompts: new PromptStore(path.join(home, 'prompts'), BUNDLED_PROMPTS),
    now: () => now,
    pace: () => pace,
    ...(options.slowWakeGapMs === undefined ? {} : { slowWakeGapMs: options.slowWakeGapMs }),
    isIdle: () => true,
    nudge: (agentId) => nudges.push(agentId),
    onWakeDeferred: (agentId, detail) =>
      deferrals.push({ agentId, pace: detail.pace, pendingMail: detail.pendingMail })
  })
  routers.push(hermes)
  hermes.ensureMailbox('agent.a')
  hermes.ensureMailbox('agent.b')

  let counter = 0
  return {
    hermes,
    agora,
    home,
    nudges,
    deferrals,
    advance: (ms) => {
      now += ms
    },
    setPace: (next) => {
      pace = next
    },
    send(to) {
      counter += 1
      const msg = composeMessage({
        id: makeMessageId(new Date(START + counter), `p${String(counter).padStart(4, '0')}`),
        conversation: 'conv-pace',
        from: 'agent.a',
        to,
        act: 'request',
        subject: 'a thing to do',
        body: 'please do the thing',
        created_at: new Date(START + counter).toISOString()
      })
      fs.writeFileSync(
        path.join(agora.agentDir('agent.a'), 'outbox', `${msg.id}.json`),
        JSON.stringify(msg, null, 2),
        'utf8'
      )
      return msg
    },
    inbox(agentId) {
      const dir = path.join(agora.agentDir(agentId), 'inbox')
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')) : []
    },
    done(agentId) {
      const dir = path.join(agora.agentDir(agentId), 'inbox', DONE_DIR)
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')) : []
    }
  }
}

describe('the pace gates the inbox wake path (wakeCheck)', () => {
  it('wakes normally at full speed', async () => {
    const r = await rig()
    r.send('agent.b')
    await r.hermes.sweep()

    expect(await r.hermes.wakeCheck()).toEqual(['agent.b'])
    expect(r.nudges).toEqual(['agent.b'])
  })

  it('defers the second wake while slow, and leaves the mail where it is', async () => {
    const gap = 5 * 60_000
    const r = await rig({ slowWakeGapMs: gap })
    r.setPace('slow')

    r.send('agent.b')
    await r.hermes.sweep()
    // The first wake at any pace is always allowed — a company that never gets
    // going is not a paced company.
    expect(await r.hermes.wakeCheck()).toEqual(['agent.b'])

    r.advance(60_000)
    r.send('agent.b')
    await r.hermes.sweep()
    expect(await r.hermes.wakeCheck()).toEqual([])

    // The deferral is REPORTED, never silent: a paced company must not be
    // indistinguishable from a hung one (invariant §7).
    expect(r.deferrals).toEqual([{ agentId: 'agent.b', pace: 'slow', pendingMail: 1 }])
    // And the message is still sitting in the inbox, unconsumed. Deferring is
    // not dropping.
    expect(r.inbox('agent.b')).toHaveLength(1)
    expect(r.done('agent.b')).toHaveLength(1) // only the first wake's message
  })

  it('delivers the deferred mail once the gap has passed', async () => {
    const gap = 5 * 60_000
    const r = await rig({ slowWakeGapMs: gap })
    r.setPace('slow')

    r.send('agent.b')
    await r.hermes.sweep()
    await r.hermes.wakeCheck()

    r.advance(60_000)
    r.send('agent.b')
    await r.hermes.sweep()
    expect(await r.hermes.wakeCheck()).toEqual([])

    // This is the property that makes pacing a delay rather than a loss: the
    // same mail must still earn its nudge once the pace allows one, which is
    // why the deferral must not mark it as announced.
    r.advance(gap)
    expect(await r.hermes.wakeCheck()).toEqual(['agent.b'])
    expect(r.inbox('agent.b')).toHaveLength(0)
    expect(r.done('agent.b')).toHaveLength(2)
  })

  it('holds until the window resets, then marches forward', async () => {
    const r = await rig()
    r.setPace('hold')

    r.send('agent.b')
    await r.hermes.sweep()
    // First wake allowed even on hold...
    expect(await r.hermes.wakeCheck()).toEqual(['agent.b'])

    r.advance(60_000)
    r.send('agent.b')
    await r.hermes.sweep()
    // ...and everything after it waits, however long.
    r.advance(6 * 60 * 60 * 1000)
    expect(await r.hermes.wakeCheck()).toEqual([])

    // The Architect's second rule, at the seam: the pace changing back is the
    // whole mechanism. Nothing else has to be reset or replayed.
    r.setPace('full')
    expect(await r.hermes.wakeCheck()).toEqual(['agent.b'])
  })
})

describe('the pace gates the stop-hook wake path (decideOnStop)', () => {
  it('blocks to hand over mail at full speed', async () => {
    const r = await rig()
    r.send('agent.b')
    await r.hermes.sweep()

    const reply = await r.hermes.decideOnStop('agent.b', { stop_hook_active: false })
    expect(reply?.decision).toBe('block')
    expect(r.done('agent.b')).toHaveLength(1)
  })

  it('lets the turn end instead of buying another one while slow', async () => {
    // 39% of a measured day went to these — a mean 561k tokens for about a
    // kilobyte of new information. Returning null lets the turn END; the mail
    // stays pending and wakeCheck picks it up once the gap has passed.
    const gap = 5 * 60_000
    const r = await rig({ slowWakeGapMs: gap })
    r.setPace('slow')

    r.send('agent.b')
    await r.hermes.sweep()
    expect((await r.hermes.decideOnStop('agent.b', {}))?.decision).toBe('block')

    r.advance(30_000)
    r.send('agent.b')
    await r.hermes.sweep()
    expect(await r.hermes.decideOnStop('agent.b', {})).toBeNull()

    // Nothing consumed on the deferral: the second message is still pending.
    expect(r.inbox('agent.b')).toHaveLength(1)
    expect(r.deferrals.at(-1)).toEqual({ agentId: 'agent.b', pace: 'slow', pendingMail: 1 })
  })

  it('counts a stop-hook block as a wake, so the two paths share one budget', async () => {
    // Otherwise the cheapest way around the gate would be to alternate paths,
    // and the company would wake at twice the paced rate.
    const gap = 5 * 60_000
    const r = await rig({ slowWakeGapMs: gap })
    r.setPace('slow')

    r.send('agent.b')
    await r.hermes.sweep()
    expect((await r.hermes.decideOnStop('agent.b', {}))?.decision).toBe('block')

    r.advance(1000)
    r.send('agent.b')
    await r.hermes.sweep()
    expect(await r.hermes.wakeCheck()).toEqual([])
  })
})

describe('UsageWatch — reading what the shim wrote', () => {
  function watchOn(contents: string | null, now: number) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-usagewatch-'))
    temps.push(dir)
    const file = path.join(dir, 'usage.json')
    if (contents !== null) fs.writeFileSync(file, contents, 'utf8')
    const degraded: string[] = []
    const watch = new UsageWatch({
      path: file,
      now: () => now,
      onDegraded: (detail) => degraded.push(detail)
    })
    return { watch, degraded, file }
  }

  it('paces on a real report', () => {
    const now = START
    const { watch } = watchOn(
      JSON.stringify({
        schemaVersion: 1,
        observedAt: now,
        agentId: 'agent.artemis',
        fiveHour: { usedPercent: 94, resetsAt: now + 60 * 60 * 1000 },
        sevenDay: null
      }),
      now
    )
    watch.tick()
    expect(watch.verdict().pace).toBe('slow')
    expect(watch.observed()?.fiveHour?.usedPercent).toBe(94)
  })

  it('treats an absent file as "not told yet", not as a degradation', () => {
    // This is the state the harness starts in every single time — before any
    // agent has rendered a status line. Reporting it would cry wolf on boot.
    const { watch, degraded } = watchOn(null, START)
    watch.tick()
    expect(degraded).toEqual([])
    expect(watch.verdict().because).toBe('unobserved')
  })

  it('reports a file it cannot use, exactly once per episode', () => {
    const { watch, degraded, file } = watchOn('{"schemaVersion": 99}', START)
    watch.tick()
    watch.tick()
    // The bytes are DIFFERENT each time — a shim writing garbage with a moving
    // timestamp does exactly this — so the unchanged-bytes shortcut cannot be
    // what dedupes here. Only the same-detail guard can, which is the thing
    // this test exists to hold.
    fs.writeFileSync(file, '{"schemaVersion": 99}\n', 'utf8')
    watch.tick()
    fs.writeFileSync(file, '  {"schemaVersion": 99}  ', 'utf8')
    watch.tick()
    expect(degraded).toHaveLength(1)
    expect(degraded[0]).toContain('usage.json')
    expect(watch.verdict().pace).toBe('full')
  })

  it('reports again when the file breaks in a NEW way', () => {
    // One report per episode, not one report ever: a different fault is news.
    const { watch, degraded, file } = watchOn('{"schemaVersion": 99}', START)
    watch.tick()
    fs.writeFileSync(file, 'not json at all', 'utf8')
    watch.tick()
    expect(degraded).toHaveLength(2)
  })

  it('raises a pace change on a transition only', () => {
    const now = START
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-usagewatch-'))
    temps.push(dir)
    const file = path.join(dir, 'usage.json')
    const changes: string[] = []
    let clock = now
    const watch = new UsageWatch({
      path: file,
      now: () => clock,
      onPaceChange: (verdict) => changes.push(`${verdict.pace}/${verdict.because}`)
    })

    watch.tick()
    watch.tick()
    expect(changes).toEqual(['full/unobserved'])

    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        observedAt: now,
        agentId: null,
        fiveHour: { usedPercent: 99, resetsAt: now + 10 * 60 * 1000 },
        sevenDay: null
      }),
      'utf8'
    )
    watch.tick()
    watch.tick()
    expect(changes).toEqual(['full/unobserved', 'hold/used'])

    // A pace can change with nothing but time: the window resets and the
    // company marches forward, with the file untouched. Kept inside
    // `staleAfterMs` on purpose — past it the reading is discarded and the
    // answer is `unobserved`, which is a different (and also correct) fact.
    clock = now + 11 * 60 * 1000
    watch.tick()
    expect(changes.at(-1)).toBe('full/reset')
  })

  it('discards a reading that outlived its staleness window', () => {
    // The other side of the same coin: an agent that exited hours ago must not
    // pin the company to the pace it last reported.
    const now = START
    const { watch } = watchOn(
      JSON.stringify({
        schemaVersion: 1,
        observedAt: now - 45 * 60 * 1000,
        agentId: null,
        fiveHour: { usedPercent: 99, resetsAt: now + 60 * 60 * 1000 },
        sevenDay: null
      }),
      now
    )
    watch.tick()
    expect(watch.verdict().because).toBe('unobserved')
    expect(watch.verdict().pace).toBe('full')
  })
})

describe('WakeClock — the wall-clock cap', () => {
  it('interrupts a wake that outruns the cap', async () => {
    const interrupted: string[] = []
    const overtime: { agentId: string; ranMs: number }[] = []
    const clock = new WakeClock({
      capMs: 20,
      interrupt: (agentId) => interrupted.push(agentId),
      onOvertime: (agentId, ranMs) => overtime.push({ agentId, ranMs })
    })
    clock.began('agent.b')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(interrupted).toEqual(['agent.b'])
    // Reported as well as acted on — a turn that vanished with no explanation
    // is exactly the silent failure this codebase does not allow.
    expect(overtime[0]?.agentId).toBe('agent.b')
    expect(overtime[0]?.ranMs).toBeGreaterThanOrEqual(20)
  })

  it('leaves a wake that finished in time alone', async () => {
    const interrupted: string[] = []
    const clock = new WakeClock({ capMs: 50, interrupt: (a) => interrupted.push(a) })
    clock.began('agent.b')
    clock.ended('agent.b')
    await new Promise((resolve) => setTimeout(resolve, 90))
    expect(interrupted).toEqual([])
  })

  it('does not stack timers when a wake begins twice', async () => {
    // Engines emit prompt-submitted once per turn, but a queued command and an
    // inbox nudge landing together must not leave a timer nobody can clear.
    const interrupted: string[] = []
    const clock = new WakeClock({ capMs: 30, interrupt: (a) => interrupted.push(a) })
    clock.began('agent.b')
    clock.began('agent.b')
    clock.ended('agent.b')
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(interrupted).toEqual([])
  })

  it('is blind to tokens, which is the point', () => {
    // The independence claim, stated as a test: the clock takes no ledger, no
    // budget and no usage window — only time. A cheap slow turn is caught by
    // this and by nothing else in the Watch.
    const clock = new WakeClock({ capMs: 1000, interrupt: () => {} })
    clock.began('agent.b')
    expect(clock.runningMs('agent.b')).not.toBeNull()
    expect(clock.runningMs('agent.other')).toBeNull()
  })
})

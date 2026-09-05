import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Agora } from '../../src/main/agora'
import { DONE_DIR, INFLIGHT_DIR, Hermes } from '../../src/main/hermes'
import { PromptStore } from '../../src/main/prompts'
import { composeMessage, makeMessageId, type Message } from '../../src/shared/message'
import { DEFAULT_PACE_THRESHOLDS, type Pace } from '../../src/shared/pacing'
import { UsageWatch } from '../../src/main/watch/usage-watch'
import { canDeliverWake, DEFAULT_WAKE_CAP_MS, WakeClock } from '../../src/main/watch/wake-clock'

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
  inflight(agentId: string): readonly string[]
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
    },
    // Handed to a session that has not yet proven it read it: the state
    // `consumeInbox` now leaves mail in, until a Stop settles it.
    inflight(agentId) {
      const dir = path.join(agora.agentDir(agentId), 'inbox', INFLIGHT_DIR)
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
    expect(r.inflight('agent.b')).toHaveLength(1) // only the first wake's message
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
    expect(r.inflight('agent.b')).toHaveLength(2)
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
    expect(r.inflight('agent.b')).toHaveLength(1)
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
    const file = path.join(dir, 'agent.artemis.json')
    if (contents !== null) fs.writeFileSync(file, contents, 'utf8')
    const degraded: string[] = []
    const watch = new UsageWatch({
      dir,
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
        session: null,
        sessionCostUsd: null,
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
    expect(degraded[0]).toContain('agent.artemis.json')
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
    const file = path.join(dir, 'agent.artemis.json')
    const changes: string[] = []
    let clock = now
    const watch = new UsageWatch({
      dir,
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
        session: null,
        sessionCostUsd: null,
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
        session: null,
        sessionCostUsd: null,
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

  it('reports at least the cap even when the wall clock disagrees', async () => {
    // The timer fires on the MONOTONIC clock; this measurement comes from a
    // wall clock with its own rounding. They disagreed by a millisecond often
    // enough to fail CI on one ubuntu run in three, reporting 19 ms against a
    // 20 ms cap — a number that contradicts the reason it was written. The
    // timer firing is the evidence the cap elapsed, so the report says so.
    const overtime: number[] = []
    let reading = 1_000
    const clock = new WakeClock({
      capMs: 20,
      interrupt: () => undefined,
      onOvertime: (_agentId, ranMs) => overtime.push(ranMs),
      // One millisecond SHORT of the cap when the timer fires: exactly the
      // disagreement observed on CI, made deterministic.
      now: () => reading
    })
    clock.began('agent.b')
    reading += 19
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(overtime).toEqual([20])
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

describe('UsageWatch — one report per agent', () => {
  /** Writes reports into one directory and reads them back through the Watch. */
  function watchOverDir(now: number) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-usagedir-'))
    temps.push(dir)
    let clock = now
    const watch = new UsageWatch({ dir, now: () => clock })
    const write = (
      name: string,
      report: {
        observedAt: number
        agentId: string | null
        session?: string | null
        sessionCostUsd?: number | null
        fiveHour?: { usedPercent: number; resetsAt: number } | null
      }
    ) => {
      fs.writeFileSync(
        path.join(dir, name),
        JSON.stringify({
          schemaVersion: 1,
          observedAt: report.observedAt,
          agentId: report.agentId,
          fiveHour: report.fiveHour ?? null,
          sevenDay: null,
          session: report.session ?? null,
          sessionCostUsd: report.sessionCostUsd ?? null
        }),
        'utf8'
      )
    }
    return { watch, write, setClock: (t: number) => (clock = t) }
  }

  it('gives each agent its own live cost, and never another agent’s', () => {
    // The reason there is a file per agent at all. One shared file would mean
    // last-writer-wins, and whichever agent rendered most recently would have
    // every other agent's spend attributed to it.
    const { watch, write } = watchOverDir(START)
    write('agent.artemis.json', {
      observedAt: START,
      agentId: 'agent.artemis',
      session: 'sess-A',
      sessionCostUsd: 0.3
    })
    write('agent.mason.json', {
      observedAt: START,
      agentId: 'agent.mason',
      session: 'sess-M',
      sessionCostUsd: 9.5
    })
    watch.tick()

    expect(watch.liveCostFor('agent.artemis')).toEqual({ session: 'sess-A', usd: 0.3 })
    expect(watch.liveCostFor('agent.mason')).toEqual({ session: 'sess-M', usd: 9.5 })
    expect(watch.liveCostFor('agent.nobody')).toBeNull()
  })

  it('attributes by the id INSIDE the report, not by the file name', () => {
    // The filename is a sanitised convenience and two ids could collapse onto
    // one. The id in the payload is what the shim was actually told it was, so
    // reading that is what makes "A's spend can never show against B" a
    // property of the data rather than of a naming scheme.
    const { watch, write } = watchOverDir(START)
    write('agent.artemis.json', {
      observedAt: START,
      agentId: 'agent.mason',
      session: 'sess-M',
      sessionCostUsd: 9.5
    })
    watch.tick()

    expect(watch.liveCostFor('agent.artemis')).toBeNull()
    expect(watch.liveCostFor('agent.mason')).toEqual({ session: 'sess-M', usd: 9.5 })
  })

  it('stops serving a live figure once its reading goes stale', () => {
    // The agent exited. Its last figure is no longer live, and the durable
    // ledger row is the right answer from then on.
    const { watch, write, setClock } = watchOverDir(START)
    write('agent.artemis.json', {
      observedAt: START,
      agentId: 'agent.artemis',
      session: 'sess-A',
      sessionCostUsd: 0.3
    })
    watch.tick()
    expect(watch.liveCostFor('agent.artemis')).not.toBeNull()

    setClock(START + DEFAULT_PACE_THRESHOLDS.staleAfterMs + 1)
    expect(watch.liveCostFor('agent.artemis')).toBeNull()
  })

  it('withholds a figure that names no session to attach it to', () => {
    const { watch, write } = watchOverDir(START)
    write('agent.artemis.json', {
      observedAt: START,
      agentId: 'agent.artemis',
      session: null,
      sessionCostUsd: 0.3
    })
    watch.tick()
    expect(watch.liveCostFor('agent.artemis')).toBeNull()
  })

  it('paces on the FRESHEST reading across agents, not an arbitrary one', () => {
    // The windows are account-wide, so any agent's reading describes every
    // agent's situation — but an agent that exited an hour ago must not
    // out-vote one reporting now.
    const { watch, write } = watchOverDir(START)
    write('agent.stale.json', {
      observedAt: START - 60_000,
      agentId: 'agent.stale',
      fiveHour: { usedPercent: 99, resetsAt: START + 60 * 60 * 1000 }
    })
    write('agent.fresh.json', {
      observedAt: START,
      agentId: 'agent.fresh',
      fiveHour: { usedPercent: 5, resetsAt: START + 60 * 60 * 1000 }
    })
    watch.tick()

    expect(watch.observed()?.agentId).toBe('agent.fresh')
    expect(watch.verdict().pace).toBe('full')
  })

  it('lets a newer reading from ANY agent lift the pace', () => {
    const { watch, write } = watchOverDir(START)
    write('agent.a.json', {
      observedAt: START,
      agentId: 'agent.a',
      fiveHour: { usedPercent: 99, resetsAt: START + 60 * 60 * 1000 }
    })
    watch.tick()
    expect(watch.verdict().pace).toBe('hold')

    write('agent.b.json', {
      observedAt: START + 1000,
      agentId: 'agent.b',
      fiveHour: { usedPercent: 10, resetsAt: START + 60 * 60 * 1000 }
    })
    watch.tick()
    expect(watch.verdict().pace).toBe('full')
  })
})

/**
 * The wake-delivery predicate (B1 of the M7 exit gaps).
 *
 * This replaced an inline expression in the composition root that read the
 * AVATAR PHASE — a rendering state — and so made a drawing the gate on the
 * company's mail. It is a named function now for one reason: the old one could
 * not be tested, and `test/scenarios/s-wake.test.ts` stubs `isIdle` outright,
 * so nothing in the suite could see it silencing agents.
 */
describe('canDeliverWake — the router asks the delivery plane, not the floor', () => {
  it('delivers when there is a process and no wake is open', () => {
    expect(canDeliverWake(true, null)).toBe(true)
  })

  it('refuses when there is no process to type into', () => {
    expect(canDeliverWake(false, null)).toBe(false)
  })

  it('refuses while a wake is already running, however long', () => {
    expect(canDeliverWake(true, 0)).toBe(false)
    expect(canDeliverWake(true, 1)).toBe(false)
    expect(canDeliverWake(true, DEFAULT_WAKE_CAP_MS * 10)).toBe(false)
  })

  /**
   * The property the avatar phase did not have, and the whole reason for the
   * change. `WakeClock.ended` has no phase guard and the cap force-closes an
   * overrunning wake, so "deliverable" always comes back. A phase that never
   * returned to `idle` never did.
   */
  it('comes back on its own after the cap fires, with no stop event at all', async () => {
    const interrupted: string[] = []
    const clock = new WakeClock({ capMs: 20, interrupt: (a) => interrupted.push(a) })

    clock.began('agent.mason')
    expect(canDeliverWake(true, clock.runningMs('agent.mason'))).toBe(false)

    // No `stop`, no `session-end` — every hook after the wake is lost, which is
    // precisely the case that stranded an agent under the old predicate.
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(interrupted).toEqual(['agent.mason'])
    expect(canDeliverWake(true, clock.runningMs('agent.mason'))).toBe(true)
  })

  it('comes back on session-end, which the avatar phase ignores entirely', () => {
    const clock = new WakeClock({ capMs: 10_000, interrupt: () => {} })
    clock.began('agent.mason')
    // An agent that exits mid-turn emits no `stop`. WakeClock.ended is called
    // for `session-end` too, and has no phase guard.
    clock.ended('agent.mason')
    expect(canDeliverWake(true, clock.runningMs('agent.mason'))).toBe(true)
  })
})

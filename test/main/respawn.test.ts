import { describe, expect, it } from 'vitest'
import {
  createCrewSurvival,
  CrewSurvival,
  RespawnLadder,
  respawnBlockReason,
  type LadderEvent
} from '../../src/main/respawn'
import type { RespawnPolicy } from '../../src/shared/respawn'

/**
 * The ladder machine and the crew's use of it (M8.6, B12).
 *
 * The clock and the sleep are injected, so a three-rung ladder with a
 * two-minute top rung is asserted in microseconds. `delay` resolves
 * immediately and RECORDS what it was asked to wait — the waits are the
 * behaviour under test, and a test that actually slept would be asserting
 * vitest's timers rather than the ladder.
 */

const FAST: RespawnPolicy = { backoffMs: [10, 20, 30], stabilityMs: 1_000 }

interface Rig {
  readonly ladder: RespawnLadder
  readonly waits: number[]
  readonly events: LadderEvent[]
  readonly attempts: number[]
  readonly exhausted: string[]
  readonly failures: { attempt: number; detail: string }[]
  tick(ms: number): void
  /** What the next respawn resolves to, or the error it throws. */
  outcome: { stillDown: boolean; exitCode: number | null } | Error
  blocked: string | null
}

function rig(policy: RespawnPolicy = FAST): Rig {
  let clock = 1_000
  const waits: number[] = []
  const events: LadderEvent[] = []
  const attempts: number[] = []
  const exhausted: string[] = []
  const failures: { attempt: number; detail: string }[] = []
  const state: Rig = {
    waits,
    events,
    attempts,
    exhausted,
    failures,
    outcome: { stillDown: false, exitCode: null },
    blocked: null,
    tick: (ms) => {
      clock += ms
    },
    ladder: null as unknown as RespawnLadder
  }
  const ladder = new RespawnLadder({
    policy,
    now: () => clock,
    delay: (ms) => {
      waits.push(ms)
      return Promise.resolve()
    },
    respawn: () => {
      attempts.push(clock)
      if (state.outcome instanceof Error) return Promise.reject(state.outcome)
      return Promise.resolve(state.outcome)
    },
    blocked: () => state.blocked,
    onExhausted: (reason) => exhausted.push(reason),
    onAttemptFailed: (attempt, detail) => failures.push({ attempt, detail }),
    onEvent: (event) => events.push(event)
  })
  // `state` itself, never a spread of it: the callbacks above close over
  // `state`, so a copy would silently drop every `r.outcome = …` the tests do.
  return Object.assign(state, { ladder })
}

describe('the ladder climbs, then ends', () => {
  it('waits the declared backoff for each rung, in order', async () => {
    const r = rig()
    r.outcome = { stillDown: true, exitCode: 1 }
    r.ladder.noteExited(1)
    await r.ladder.drained()
    // One exit produced the whole ladder: each failed attempt schedules the
    // next rung from inside the attempt.
    expect(r.waits).toEqual([10, 20, 30])
    expect(r.attempts).toHaveLength(3)
    expect(r.exhausted).toHaveLength(1)
    expect(r.exhausted[0]).toContain('crashed 3 times')
  })

  it('stops climbing the moment the agent comes back up', async () => {
    const r = rig()
    r.outcome = { stillDown: false, exitCode: null }
    r.ladder.noteExited(1)
    await r.ladder.drained()
    expect(r.waits).toEqual([10])
    expect(r.exhausted).toEqual([])
  })

  it('charges a rung for an attempt that throws, and keeps going', async () => {
    const r = rig()
    r.outcome = new Error('spawn refused')
    r.ladder.noteExited(null)
    await r.ladder.drained()
    expect(r.failures.map((f) => f.attempt)).toEqual([1, 2, 3])
    expect(r.failures[0]?.detail).toBe('spawn refused')
    expect(r.exhausted).toHaveLength(1)
  })

  it('ignores a second exit while an attempt is already queued', async () => {
    const r = rig()
    r.outcome = { stillDown: false, exitCode: null }
    r.ladder.noteExited(1)
    r.ladder.noteExited(1)
    await r.ladder.drained()
    expect(r.waits).toEqual([10])
  })
})

describe('recovery resets the ladder — but only a real one', () => {
  it('gives a full ladder to an agent that stayed up past the window', async () => {
    const r = rig()
    r.outcome = { stillDown: false, exitCode: null }
    r.ladder.noteExited(1)
    await r.ladder.drained()
    expect(r.ladder.spent()).toBe(1)

    r.ladder.noteRunning()
    r.tick(FAST.stabilityMs)
    r.ladder.noteExited(1)
    await r.ladder.drained()
    // Reset, so this exit is attempt 1 again and waits the first backoff.
    expect(r.waits).toEqual([10, 10])
  })

  it('does not reset for an agent that died on the way up', async () => {
    const r = rig()
    r.outcome = { stillDown: false, exitCode: null }
    r.ladder.noteExited(1)
    await r.ladder.drained()

    r.ladder.noteRunning()
    r.tick(FAST.stabilityMs - 1)
    r.ladder.noteExited(1)
    await r.ladder.drained()
    // The second rung, not the first: coming back and immediately dying is the
    // crash loop the stability window exists to bound.
    expect(r.waits).toEqual([10, 20])
  })
})

describe('a hold is not a rung', () => {
  it('remembers an exit that arrived during a hold and spends nothing', async () => {
    const r = rig()
    r.ladder.hold('capacity')
    r.ladder.noteExited(1)
    await r.ladder.drained()
    expect(r.attempts).toEqual([])
    expect(r.ladder.spent()).toBe(0)
    expect(r.events.map((e) => e.event)).toContain('deferred')
  })

  it('serves the held exit immediately when the hold clears', async () => {
    const r = rig()
    r.outcome = { stillDown: false, exitCode: null }
    r.ladder.hold('capacity')
    r.ladder.noteExited(1)
    r.ladder.release()
    await r.ladder.drained()
    // Zero wait: the agent did not crash, it was refused, and the refusal is
    // over.
    expect(r.waits).toEqual([0])
    expect(r.attempts).toHaveLength(1)
  })

  it('is idempotent, because the capacity watch parks per agent', () => {
    const r = rig()
    r.ladder.hold('capacity')
    r.ladder.hold('capacity')
    expect(r.events.filter((e) => e.event === 'held')).toHaveLength(1)
    expect(r.ladder.isHeld()).toBe(true)
  })

  it('does nothing on a release that follows no hold', async () => {
    const r = rig()
    r.ladder.release()
    await r.ladder.drained()
    expect(r.attempts).toEqual([])
  })
})

describe('a standing decision blocks the ladder', () => {
  it('refuses to schedule at all', async () => {
    const r = rig()
    r.blocked = 'the breaker stopped it at rung 3'
    r.ladder.noteExited(1)
    await r.ladder.drained()
    expect(r.waits).toEqual([])
    expect(r.attempts).toEqual([])
    expect(r.events.map((e) => e.event)).toEqual(['blocked'])
  })

  it('is asked AGAIN after the wait, not only before it', async () => {
    // The rung that matters. A two-minute backoff is long enough for the
    // breaker to stop this agent, and respawning into a stop it had already
    // earned is exactly the cycle B11 measured.
    const r = rig()
    r.outcome = { stillDown: false, exitCode: null }
    r.ladder.noteExited(1)
    r.blocked = 'the breaker stopped it at rung 3'
    await r.ladder.drained()
    expect(r.waits).toEqual([10])
    expect(r.attempts).toEqual([])
    expect(r.events.at(-1)?.event).toBe('blocked')
  })

  it('spends no rung on a block, so a later real crash gets a full ladder', async () => {
    const r = rig()
    r.blocked = 'stopped'
    r.ladder.noteExited(1)
    await r.ladder.drained()
    expect(r.ladder.spent()).toBe(0)
  })
})

describe('stop and resume', () => {
  it('cancels a queued attempt', async () => {
    const r = rig()
    r.outcome = { stillDown: true, exitCode: 1 }
    r.ladder.stop()
    r.ladder.noteExited(1)
    await r.ladder.drained()
    expect(r.attempts).toEqual([])
  })

  it('is safe to call twice', () => {
    const r = rig()
    r.ladder.stop()
    expect(() => r.ladder.stop()).not.toThrow()
  })

  it('comes back after resume, for a company restarted in one process', async () => {
    const r = rig()
    r.outcome = { stillDown: false, exitCode: null }
    r.ladder.stop()
    r.ladder.resume()
    r.ladder.noteExited(1)
    await r.ladder.drained()
    expect(r.attempts).toHaveLength(1)
  })

  it('noteStarted clears the attempt count without charging a rung', async () => {
    const r = rig()
    r.outcome = { stillDown: false, exitCode: null }
    r.ladder.noteExited(1)
    await r.ladder.drained()
    expect(r.ladder.spent()).toBe(1)
    r.ladder.noteStarted()
    expect(r.ladder.spent()).toBe(0)
  })
})

/* ------------------------------------------------------------------------ */

interface CrewRig {
  readonly crew: CrewSurvival
  readonly attempts: string[]
  readonly exhausted: { agentId: string; reason: string }[]
  readonly events: { agentId: string; event: string }[]
  blocked: Map<string, string>
  stillDown: boolean
}

function crewRig(): CrewRig {
  const attempts: string[] = []
  const exhausted: { agentId: string; reason: string }[] = []
  const events: { agentId: string; event: string }[] = []
  const state: CrewRig = {
    attempts,
    exhausted,
    events,
    blocked: new Map(),
    stillDown: false,
    crew: null as unknown as CrewSurvival
  }
  const crew = new CrewSurvival({
    policy: FAST,
    now: () => 1_000,
    delay: () => Promise.resolve(),
    respawn: (agentId) => {
      attempts.push(agentId)
      return Promise.resolve({ stillDown: state.stillDown, exitCode: null })
    },
    blocked: (agentId) => state.blocked.get(agentId) ?? null,
    onExhausted: (agentId, reason) => exhausted.push({ agentId, reason }),
    onEvent: (agentId, event) => events.push({ agentId, event: event.event })
  })
  return Object.assign(state, { crew })
}

function exit(agentId: string): { agentId: string; lifecycle: string; exitCode: number | null } {
  return { agentId, lifecycle: 'exited', exitCode: 1 }
}

describe('the crew comes back only when its bundle said so', () => {
  it('brings back a hire that declared respawn', async () => {
    const r = crewRig()
    r.crew.declare('agent.mason', 'respawn')
    r.crew.noteCard(exit('agent.mason'))
    await r.crew.drained()
    expect(r.attempts).toEqual(['agent.mason'])
  })

  it('leaves a hire that declared offer exactly where SDD §10 leaves it', async () => {
    // The default, and the documented behaviour: the card carries the offer
    // and a human decides. No ladder, no attempt, no log line.
    const r = crewRig()
    r.crew.declare('agent.docs', 'offer')
    r.crew.noteCard(exit('agent.docs'))
    await r.crew.drained()
    expect(r.attempts).toEqual([])
    expect(r.events).toEqual([])
  })

  it('does nothing at all for an agent nobody declared', async () => {
    // A bare `agents.spawn` (UC-01) is not a profile hire and gets no ladder.
    const r = crewRig()
    r.crew.noteCard(exit('agent.stranger'))
    await r.crew.drained()
    expect(r.attempts).toEqual([])
    expect(r.crew.policyOf('agent.stranger')).toBeNull()
  })

  it('keeps one ladder per agent', async () => {
    const r = crewRig()
    r.crew.declare('agent.mason', 'respawn')
    r.crew.declare('agent.hera', 'respawn')
    r.crew.noteCard(exit('agent.mason'))
    r.crew.noteCard(exit('agent.hera'))
    await r.crew.drained()
    expect(r.attempts.sort()).toEqual(['agent.hera', 'agent.mason'])
  })

  it('will not respawn an agent the breaker stopped', async () => {
    const r = crewRig()
    r.crew.declare('agent.mason', 'respawn')
    r.blocked.set('agent.mason', 'the breaker stopped it at rung 3 (burn-rate)')
    r.crew.noteCard(exit('agent.mason'))
    await r.crew.drained()
    expect(r.attempts).toEqual([])
    expect(r.events.map((e) => e.event)).toEqual(['blocked'])
  })
})

describe('release is what makes deactivation safe', () => {
  it('stops a released agent coming back from the kill that released it', async () => {
    // Deactivation kills every agent in the instance. A ladder still armed
    // would read that kill as a crash and faithfully undo the deactivation.
    const r = crewRig()
    r.crew.declare('agent.mason', 'respawn')
    r.crew.release('agent.mason')
    r.crew.noteCard(exit('agent.mason'))
    await r.crew.drained()
    expect(r.attempts).toEqual([])
    expect(r.crew.policyOf('agent.mason')).toBeNull()
  })

  it('cancels an attempt already queued for that agent', async () => {
    const r = crewRig()
    r.stillDown = true
    r.crew.declare('agent.mason', 'respawn')
    r.crew.noteCard(exit('agent.mason'))
    r.crew.release('agent.mason')
    await r.crew.drained()
    // The ladder was told to stop; it does not climb to its second rung.
    expect(r.attempts.length).toBeLessThanOrEqual(1)
  })
})

describe('shutdown', () => {
  it('cancels every armed ladder', async () => {
    const r = crewRig()
    r.crew.declare('agent.mason', 'respawn')
    r.crew.declare('agent.hera', 'respawn')
    r.crew.noteCard({ agentId: 'agent.mason', lifecycle: 'running', exitCode: null })
    r.crew.stop()
    r.crew.noteCard(exit('agent.mason'))
    r.crew.noteCard(exit('agent.hera'))
    await r.crew.drained()
    expect(r.attempts).toEqual([])
  })

  it('arms nothing new after it, so a late exit cannot restart the company', async () => {
    // The ordering that matters at quit: `crew.stop()` runs before the agent
    // unwind, and the unwind's own kills arrive as exits afterwards.
    const r = crewRig()
    r.crew.stop()
    r.crew.declare('agent.late', 'respawn')
    r.crew.noteCard(exit('agent.late'))
    await r.crew.drained()
    expect(r.attempts).toEqual([])
  })
})
describe('the shapes a real deployment actually builds', () => {
  it('runs on real timers when no clock is injected', async () => {
    // The constructor's own defaults. Every other test here injects both, so
    // without this the production shape — `new RespawnLadder({ respawn, … })`
    // with a real `setTimeout` and a real `Date.now` — is never once executed.
    const attempts: number[] = []
    const ladder = new RespawnLadder({
      policy: { backoffMs: [0], stabilityMs: 60_000 },
      respawn: () => {
        attempts.push(Date.now())
        return Promise.resolve({ stillDown: false, exitCode: null })
      },
      onExhausted: () => undefined
    })
    ladder.noteRunning()
    ladder.noteExited(1)
    await ladder.drained()
    expect(attempts).toHaveLength(1)
  })

  it('works with none of the optional callbacks wired', async () => {
    // `onEvent`, `onAttemptFailed` and `blocked` are all optional, and an
    // optional seam left unwired is a real deployment rather than a
    // hypothetical — the whole reason the ladder must never throw at a caller.
    const crew = new CrewSurvival({
      policy: FAST,
      delay: () => Promise.resolve(),
      respawn: () => Promise.resolve({ stillDown: true, exitCode: 1 }),
      onExhausted: () => undefined
    })
    crew.declare('agent.mason', 'respawn')
    crew.noteCard({
      agentId: 'agent.mason',
      lifecycle: 'running',
      exitCode: null
    })
    crew.noteCard({ agentId: 'agent.mason', lifecycle: 'exited', exitCode: 1 })
    await expect(crew.drained()).resolves.toBeUndefined()
  })

  it('ignores a lifecycle that is neither running nor exited', async () => {
    // `starting`, `installing`, `needs-login` and `missing-binary` all reach
    // this stream. None of them is a death.
    const r = crewRig()
    r.crew.declare('agent.mason', 'respawn')
    for (const lifecycle of ['starting', 'installing', 'needs-login', 'missing-binary']) {
      r.crew.noteCard({ agentId: 'agent.mason', lifecycle, exitCode: null })
    }
    await r.crew.drained()
    expect(r.attempts).toEqual([])
  })
})

describe('the capacity hold, per crew agent', () => {
  it('defers an exit that arrives while the provider is refusing', async () => {
    const r = crewRig()
    r.crew.declare('agent.mason', 'respawn')
    r.crew.hold('agent.mason', 'capacity')
    r.crew.noteCard(exit('agent.mason'))
    await r.crew.drained()
    expect(r.attempts).toEqual([])
    expect(r.events.map((e) => e.event)).toContain('deferred')
  })

  it('serves it when that agent’s park clears', async () => {
    const r = crewRig()
    r.crew.declare('agent.mason', 'respawn')
    r.crew.hold('agent.mason', 'capacity')
    r.crew.noteCard(exit('agent.mason'))
    r.crew.releaseHold('agent.mason')
    await r.crew.drained()
    expect(r.attempts).toEqual(['agent.mason'])
  })

  it('holds nothing for a hire that never asked to be respawned', () => {
    // No ladder is created at all, so a hold on an `offer` hire is a no-op
    // rather than a ladder quietly waiting for a release nobody will send.
    const r = crewRig()
    r.crew.declare('agent.docs', 'offer')
    r.crew.hold('agent.docs', 'capacity')
    r.crew.releaseHold('agent.docs')
    expect(r.events).toEqual([])
  })

  it('survives a release for an agent it has never seen', () => {
    const r = crewRig()
    expect(() => r.crew.releaseHold('agent.ghost')).not.toThrow()
  })
})
/**
 * The wiring itself (M8.6).
 *
 * `createCrewSurvival` exists because boot is the least-covered row in this
 * repository and every decision that lives there is a decision nothing can
 * test — the reason M8.1 moved `shutdown.ts` and `ui-bridge.ts` out of
 * `index.ts`. These tests are the point of that move: the log kind, the
 * degradation causes, the "still down" reading and the refusal sentence are
 * all asserted here rather than assumed at a call site.
 */
describe('the refusal sentence has one author', () => {
  it('says nothing when there is no stop', () => {
    expect(respawnBlockReason(null)).toBeNull()
  })

  it('names the rung, the signals, and what to do about it', () => {
    const reason = respawnBlockReason({ signals: ['burn-rate', 'repetition'] })
    expect(reason).toContain('rung 3')
    expect(reason).toContain('burn-rate, repetition')
    // A refusal an Architect cannot act on is a dead end (M8.4's lesson).
    expect(reason).toContain('clear the stop')
  })
})

describe('createCrewSurvival', () => {
  interface Wired {
    readonly crew: CrewSurvival
    readonly logs: Record<string, unknown>[]
    readonly degradations: { cause: string; detail: string }[]
    readonly asked: string[]
    lifecycle: string
    stop: { signals: readonly string[] } | null
  }

  function wired(): Wired {
    const logs: Record<string, unknown>[] = []
    const degradations: { cause: string; detail: string }[] = []
    const asked: string[] = []
    const state: Wired = {
      logs,
      degradations,
      asked,
      lifecycle: 'running',
      stop: null,
      crew: null as unknown as CrewSurvival
    }
    const crew = createCrewSurvival({
      policy: { backoffMs: [1, 2], stabilityMs: 1_000 },
      delay: () => Promise.resolve(),
      respawn: (agentId) => {
        asked.push(agentId)
        return Promise.resolve({ lifecycle: state.lifecycle, exitCode: 7 })
      },
      breakerStop: () => state.stop,
      log: (draft) => logs.push(draft),
      degrade: (cause, detail) => degradations.push({ cause, detail })
    })
    return Object.assign(state, { crew })
  }

  it('writes the ladder into the respawn log kind, with the rung', async () => {
    // The kind exists so "did the company survive the night" stays answerable
    // from the log alone — the query that produced B12 in the first place.
    const w = wired()
    w.crew.declare('agent.mason', 'respawn')
    w.crew.noteCard({
      agentId: 'agent.mason',
      lifecycle: 'exited',
      exitCode: 1
    })
    await w.crew.drained()

    const scheduled = w.logs.find((row) => row['event'] === 'scheduled')
    expect(scheduled?.['kind']).toBe('respawn')
    expect(scheduled?.['agentId']).toBe('agent.mason')
    expect(scheduled?.['attempt']).toBe(1)
    expect(w.logs.some((row) => row['event'] === 'respawned')).toBe(true)
  })

  it('reads a card that came back already exited as still down', async () => {
    // Resolving is not surviving. An engine that starts and exits immediately
    // must cost a rung, or a crash loop looks like a recovery.
    const w = wired()
    w.lifecycle = 'exited'
    w.crew.declare('agent.mason', 'respawn')
    w.crew.noteCard({
      agentId: 'agent.mason',
      lifecycle: 'exited',
      exitCode: 1
    })
    await w.crew.drained()

    expect(w.asked).toEqual(['agent.mason', 'agent.mason'])
    expect(w.degradations[0]?.cause).toBe('respawn/exhausted:agent.mason')
    expect(w.degradations[0]?.detail).toContain('crashed 2 times')
    // The exit code the last attempt actually saw, not the first one.
    expect(w.degradations[0]?.detail).toContain('last exit code 7')
  })

  it('does not respawn an agent the breaker stopped, and says which signals', async () => {
    const w = wired()
    w.stop = { signals: ['burn-rate'] }
    w.crew.declare('agent.mason', 'respawn')
    w.crew.noteCard({
      agentId: 'agent.mason',
      lifecycle: 'exited',
      exitCode: 1
    })
    await w.crew.drained()

    expect(w.asked).toEqual([])
    const blocked = w.logs.find((row) => row['event'] === 'blocked')
    expect(String(blocked?.['because'])).toContain('burn-rate')
  })

  it('reports an attempt that threw under its own cause', async () => {
    const logs: Record<string, unknown>[] = []
    const degradations: { cause: string; detail: string }[] = []
    const crew = createCrewSurvival({
      policy: { backoffMs: [1], stabilityMs: 1_000 },
      delay: () => Promise.resolve(),
      respawn: () => Promise.reject(new Error('engine is not installed')),
      breakerStop: () => null,
      log: (draft) => logs.push(draft),
      degrade: (cause, detail) => degradations.push({ cause, detail })
    })
    crew.declare('agent.mason', 'respawn')
    crew.noteCard({ agentId: 'agent.mason', lifecycle: 'exited', exitCode: 1 })
    await crew.drained()

    // Two different conditions, two different causes: an attempt that failed
    // and a ladder that ended are not the same thing to act on.
    expect(degradations.map((d) => d.cause)).toEqual([
      'respawn/attempt:agent.mason',
      'respawn/exhausted:agent.mason'
    ])
    expect(degradations[0]?.detail).toContain('engine is not installed')
  })
})

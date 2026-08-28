import { describe, expect, it } from 'vitest'
import { DEFAULT_THRESHOLDS, type SignalHit } from '../../src/shared/breaker'
import { Breaker, fingerprint, type BreakerEffects } from '../../src/main/watch/breaker'

/**
 * The ladder in motion (ADR-0011). What this file owns is the part the pure
 * signals cannot express: that climbing one rung performs exactly that rung's
 * acts, that **work is preserved at rungs 1 and 2** (S-BREAKER's core claim),
 * and that recovery undoes the constraints rather than leaving an agent
 * throttled forever.
 */

interface Recorded {
  readonly steers: string[]
  readonly paused: boolean[]
  constrained: boolean[]
  readonly interrupts: string[]
  readonly stops: string[]
  readonly avatars: string[]
  readonly logs: Record<string, unknown>[]
  /** Rung 3's owed clause: what went back to the ledger, and why. */
  readonly returned: string[]
}

function rig(over: { budget?: () => 'ok' | 'breached'; fidelity?: string } = {}): {
  breaker: Breaker
  rec: Recorded
  tick(ms?: number): void
} {
  const rec: Recorded = {
    steers: [],
    paused: [],
    constrained: [],
    interrupts: [],
    stops: [],
    avatars: [],
    logs: [],
    returned: []
  }
  let now = 1_700_000_000_000
  const effects: BreakerEffects = {
    steer: (_id, text) => rec.steers.push(text),
    pauseDeliveries: (_id, paused) => rec.paused.push(paused),
    constrainBudget: (_id, constrained) => rec.constrained.push(constrained),
    interrupt: (id) => rec.interrupts.push(id),
    stop: (id) => rec.stops.push(id),
    avatar: (_id, event) =>
      rec.avatars.push(event.kind === 'breaker' ? `rung${String(event.rung)}` : 'recover'),
    returnTask: (id, report) =>
      rec.returned.push(
        `${id}:rung${String(report.rung)}:${report.signals.map((hit) => hit.signal).join(',')}`
      )
  }
  const breaker = new Breaker({
    effects,
    // The words are config; the breaker supplies facts (invariant §8).
    steerText: (hit: SignalHit) => `[steer:${hit.signal}]`,
    onLogEvent: (draft) => rec.logs.push(draft),
    now: () => now,
    ...(over.budget ? { budgetState: over.budget } : {}),
    ...(over.fidelity === undefined
      ? {}
      : { hookFidelity: (): string => over.fidelity ?? 'native' })
  })
  return {
    breaker,
    rec,
    tick: (ms = 1) => {
      now += ms
    }
  }
}

/** Advances past the dwell, so the ladder may climb again. */
const DWELL = DEFAULT_THRESHOLDS.rungDwellMs + 1

/** Drives an agent into the repetition signal. */
function loop(breaker: Breaker, agentId = 'agent.mason'): void {
  for (let i = 0; i < DEFAULT_THRESHOLDS.repeatCount; i += 1) {
    breaker.openSpan(agentId, 'Read', { path: 'same.ts' })
    breaker.closeSpan(agentId, 'Read', 'ok')
  }
}

describe('climbing the ladder', () => {
  it('a first trip steers, and does nothing else', () => {
    const { breaker, rec } = rig()
    loop(breaker)
    expect(breaker.evaluate('agent.mason')).toBe(1)
    expect(rec.steers).toHaveLength(1)
    expect(rec.steers[0]).toContain('repetition')
    // Rung 1's bargain: a false trip costs one sentence and nothing more.
    expect(rec.paused).toEqual([])
    expect(rec.interrupts).toEqual([])
    expect(rec.stops).toEqual([])
    expect(rec.avatars).toEqual(['rung1'])
  })

  it('does not climb again until the agent has had time to respond', () => {
    const { breaker } = rig()
    loop(breaker)
    expect(breaker.evaluate('agent.mason')).toBe(1)
    // The steer is queued until the agent is idle (FR-1.3); climbing on the
    // very next tool call would mean it was never given a chance to act on it.
    for (let i = 0; i < 10; i += 1) expect(breaker.evaluate('agent.mason')).toBe(1)
  })

  it('a second evaluation after the dwell constrains, pausing deliveries', () => {
    const { breaker, rec, tick } = rig()
    loop(breaker)
    breaker.evaluate('agent.mason')
    tick(DWELL)
    expect(breaker.evaluate('agent.mason')).toBe(2)
    expect(rec.paused).toEqual([true])
    // ADR-0011's second constraint: the budget envelope tightens with the rung.
    expect(rec.constrained).toEqual([true])
    // Still no process touched: work is preserved at rungs 1 and 2.
    expect(rec.interrupts).toEqual([])
    expect(rec.stops).toEqual([])
  })

  it('only a third evaluation stops, and interrupts gracefully first', () => {
    const { breaker, rec, tick } = rig()
    loop(breaker)
    expect(breaker.evaluate('agent.mason')).toBe(1)
    // The agent keeps looping across the dwell, as a genuinely stuck one does.
    // (An agent that STOPPED looping ages out of the window and recovers —
    // asserted separately below.)
    tick(DWELL)
    loop(breaker)
    expect(breaker.evaluate('agent.mason')).toBe(2)
    tick(DWELL)
    loop(breaker)
    expect(breaker.evaluate('agent.mason')).toBe(3)
    expect(rec.interrupts).toEqual(['agent.mason'])
    expect(rec.stops).toEqual(['agent.mason'])
    // The engine's own cancel key BEFORE the process stop (ADR-0011).
    expect(rec.avatars).toEqual(['rung1', 'rung2', 'rung3'])
  })

  it('returns the work to the ledger when it stops the agent (ADR-0011)', () => {
    // Rung 3's owed clause, unreachable until the M5.1 join existed: "task
    // returns to the ledger as `stalled` with the breaker report attached".
    // Work is preserved at every rung — 1 and 2 keep the agent working, and 3
    // hands the task back rather than letting it die with the process.
    const { breaker, rec, tick } = rig()
    for (let i = 0; i < 3; i += 1) {
      loop(breaker)
      breaker.evaluate('agent.mason')
      tick(DWELL)
    }
    expect(rec.returned).toEqual(['agent.mason:rung3:repetition'])
  })

  it('returns nothing at rungs 1 and 2 — those preserve the work in place', () => {
    const { breaker, rec, tick } = rig()
    loop(breaker)
    breaker.evaluate('agent.mason')
    tick(DWELL)
    loop(breaker)
    breaker.evaluate('agent.mason')
    expect(rec.returned).toEqual([])
  })

  it('hands back the task exactly once, however long the agent stays stopped', () => {
    // A task returned twice would be stalled, reassigned, then stalled again.
    const { breaker, rec, tick } = rig()
    for (let i = 0; i < 6; i += 1) {
      loop(breaker)
      breaker.evaluate('agent.mason')
      tick(DWELL)
    }
    expect(rec.returned).toHaveLength(1)
  })

  it('stays at 3 rather than climbing past it', () => {
    const { breaker, rec, tick } = rig()
    for (let i = 0; i < 6; i += 1) {
      loop(breaker)
      breaker.evaluate('agent.mason')
      tick(DWELL)
    }
    expect(breaker.stateFor('agent.mason').rung).toBe(3)
    expect(rec.stops).toHaveLength(1)
  })

  it('records every transition with the numbers that caused it (NFR-13)', () => {
    const { breaker, rec, tick } = rig()
    loop(breaker)
    breaker.evaluate('agent.mason')
    tick(DWELL)
    loop(breaker)
    breaker.evaluate('agent.mason')
    expect(rec.logs.map((entry) => entry['action'])).toEqual(['steer', 'constrain'])
    expect(rec.logs[0]).toMatchObject({ kind: 'breaker', agentId: 'agent.mason', from: 0, rung: 1 })
    expect(rec.logs[0]?.['signals']).toEqual(['repetition'])
    // A trip has to be explicable after the fact, not a mood.
    expect(JSON.stringify(rec.logs[0]?.['detail'])).toContain('repeats')
  })
})

describe('recovery', () => {
  it('falls straight back to 0 and lifts the constraints', () => {
    const { breaker, rec, tick } = rig()
    loop(breaker)
    breaker.evaluate('agent.mason')
    tick(DWELL)
    loop(breaker)
    breaker.evaluate('agent.mason')
    expect(rec.paused).toEqual([true])

    // The window passes; nothing is firing any more.
    tick(DEFAULT_THRESHOLDS.repeatWindowMs + 1)
    expect(breaker.evaluate('agent.mason')).toBe(0)
    expect(rec.paused).toEqual([true, false])
    expect(rec.constrained).toEqual([true, false])
    expect(rec.avatars.at(-1)).toBe('recover')
    expect(rec.logs.at(-1)).toMatchObject({ action: 'recover', rung: 0 })
  })

  it('says nothing at all while an agent is healthy', () => {
    const { breaker, rec } = rig()
    breaker.openSpan('agent.mason', 'Read', { path: 'a.ts' })
    breaker.closeSpan('agent.mason', 'Read', 'ok')
    expect(breaker.evaluate('agent.mason')).toBe(0)
    // No transition, so no event: a breaker that logs "still fine" every tick
    // is a metronome, not a record.
    expect(rec.logs).toEqual([])
  })

  it('a respawn starts clean', () => {
    const { breaker } = rig()
    loop(breaker)
    breaker.evaluate('agent.mason')
    breaker.forget('agent.mason')
    expect(breaker.stateFor('agent.mason').rung).toBe(0)
    expect(breaker.spansFor('agent.mason')).toEqual([])
  })
})

describe('span capture (FR-11.6)', () => {
  it('records agent, tool, duration and outcome', () => {
    const { breaker, tick } = rig()
    breaker.openSpan('agent.mason', 'Bash', { command: 'ls' })
    tick(250)
    breaker.closeSpan('agent.mason', 'Bash', 'ok')
    const spans = breaker.spansFor('agent.mason')
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({
      agentId: 'agent.mason',
      tool: 'Bash',
      durationMs: 250,
      outcome: 'ok'
    })
  })

  it('leaves a span open until its post-tool arrives', () => {
    const { breaker } = rig()
    breaker.openSpan('agent.mason', 'Bash', {})
    expect(breaker.spansFor('agent.mason')[0]?.outcome).toBe('open')
    expect(breaker.spansFor('agent.mason')[0]?.durationMs).toBeNull()
  })

  it('ignores a post-tool with no matching open span', () => {
    const { breaker } = rig()
    expect(() => breaker.closeSpan('agent.mason', 'Bash', 'ok')).not.toThrow()
    expect(breaker.spansFor('agent.mason')).toEqual([])
  })

  it('never stores the arguments themselves (NFR-10)', () => {
    const { breaker } = rig()
    breaker.openSpan('agent.mason', 'Write', { path: '/secret/plan.md', content: 'confidential' })
    const serialised = JSON.stringify(breaker.spansFor('agent.mason'))
    // A span is read by the briefing compiler; a tool call's arguments can
    // contain anything the agent was working on.
    expect(serialised).not.toContain('confidential')
    expect(serialised).not.toContain('/secret/plan.md')
  })

  it('bounds the buffer, because the record is log.jsonl', () => {
    const { breaker } = rig()
    const bounded = new Breaker({
      effects: {
        steer: () => {},
        pauseDeliveries: () => {},
        constrainBudget: () => {},
        interrupt: () => {},
        stop: () => {},
        avatar: () => {},
        returnTask: () => {}
      },
      steerText: () => 'x',
      spanLimit: 10
    })
    for (let i = 0; i < 50; i += 1) bounded.openSpan('agent.mason', `T${String(i)}`, {})
    expect(bounded.spansFor('agent.mason')).toHaveLength(10)
    expect(breaker.spansFor('agent.mason')).toEqual([])
  })
})

describe('fingerprints', () => {
  it('is stable regardless of key order', () => {
    // Repetition would never be seen if key order changed the digest.
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }))
  })

  it('differs for different arguments', () => {
    expect(fingerprint({ path: 'a.ts' })).not.toBe(fingerprint({ path: 'b.ts' }))
  })

  it('handles nested values and arrays', () => {
    expect(fingerprint({ a: [1, { b: 2 }] })).toBe(fingerprint({ a: [1, { b: 2 }] }))
    expect(fingerprint({ a: [1, { b: 2 }] })).not.toBe(fingerprint({ a: [1, { b: 3 }] }))
  })

  it('survives a payload that will not serialize', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(() => fingerprint(cyclic)).not.toThrow()
  })

  it('never contains the payload', () => {
    expect(fingerprint({ token: 'not-a-real-credential-0123456789' })).not.toContain('not-a-real')
  })
})

describe('the M2 pathology signal is finally consumed', () => {
  it('enters the ladder at rung 1 like any other signal', () => {
    const { breaker, rec } = rig()
    // Emitted and logged from M2 with nothing reading it — the carried item.
    breaker.notePathology('agent.mason', 7)
    expect(breaker.stateFor('agent.mason').rung).toBe(1)
    expect(rec.steers).toHaveLength(1)
    expect(JSON.stringify(rec.logs[0]?.['detail'])).toContain('stop-loop')
  })
})

describe('reduced protection is surfaced, not hidden', () => {
  it('flags a pty-heuristic engine on its state', () => {
    const { breaker } = rig({ fidelity: 'pty-heuristic' })
    const state = breaker.stateFor('agent.mason')
    expect(state.reducedProtection).toBe(true)
    expect(state.blindSignals).toEqual(['repetition', 'error-rate'])
  })

  it('does not flag a native engine', () => {
    expect(rig({ fidelity: 'native' }).breaker.stateFor('agent.mason').reducedProtection).toBe(
      false
    )
  })
})

describe('the budget feeds signal #4', () => {
  it('trips on a breached budget with no spans at all', () => {
    const { breaker, rec } = rig({ budget: () => 'breached' })
    expect(breaker.evaluate('agent.mason')).toBe(1)
    expect(rec.steers[0]).toContain('burn-rate')
  })

  it('does not trip on a healthy budget', () => {
    expect(rig({ budget: () => 'ok' }).breaker.evaluate('agent.mason')).toBe(0)
  })
})

describe('recovery is never delayed by the dwell', () => {
  it('falls to 0 immediately, without serving out the rung', () => {
    const { breaker, rec, tick } = rig()
    loop(breaker)
    expect(breaker.evaluate('agent.mason')).toBe(1)
    // Well inside the dwell — an agent that stopped misbehaving should not have
    // to wait out a sentence before the constraints lift.
    tick(DEFAULT_THRESHOLDS.repeatWindowMs + 1)
    expect(breaker.evaluate('agent.mason')).toBe(0)
    expect(rec.avatars.at(-1)).toBe('recover')
  })
})

describe('an agent that stops looping is not escalated on stale evidence', () => {
  it('recovers rather than climbing, once its calls age out of the window', () => {
    const { breaker, rec, tick } = rig()
    loop(breaker)
    expect(breaker.evaluate('agent.mason')).toBe(1)
    // It took the steer and stopped. The old calls age out; nothing new fires.
    tick(DEFAULT_THRESHOLDS.repeatWindowMs + 1)
    expect(breaker.evaluate('agent.mason')).toBe(0)
    expect(rec.stops).toEqual([])
  })
})

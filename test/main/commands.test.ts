import { describe, expect, it } from 'vitest'
import { initialAvatar, reduceAvatar, type AvatarSnapshot } from '../../src/shared/avatar'
import type { CommandState } from '../../src/shared/commands'
import { CommandQueue, SUBMIT_ATTEMPTS, SUBMIT_KEY } from '../../src/main/commands'

/**
 * The queue as main actually runs it: held text, the flush on idle, and the
 * two-write submit that a live run proved necessary.
 */

const T0 = 1_000_000

interface Rig {
  readonly queue: CommandQueue
  readonly writes: { agentId: string; data: string }[]
  readonly changes: CommandState[]
  readonly unaccepted: { agentId: string; attempts: number }[]
  /** Runs the scheduled submit-key writes. */
  drain(): void
  /** Steps the confirm-and-retry chain, which schedules as it goes. */
  drainAll(): void
  phase(snapshot: AvatarSnapshot): void
}

function rig(): Rig {
  const writes: { agentId: string; data: string }[] = []
  const changes: CommandState[] = []
  const unaccepted: { agentId: string; attempts: number }[] = []
  const scheduled: (() => void)[] = []
  const queue = new CommandQueue({
    sink: { write: (agentId, data) => writes.push({ agentId, data }) },
    onChange: (state) => changes.push(state),
    schedule: (fn) => scheduled.push(fn),
    onUnaccepted: (agentId, attempts) => unaccepted.push({ agentId, attempts })
  })
  const drain = (): void => {
    for (const fn of scheduled.splice(0)) fn()
  }
  return {
    queue,
    writes,
    changes,
    unaccepted,
    drain,
    drainAll() {
      // Bounded so a fix that never stops retrying hangs the test rather than
      // the harness — 20 rounds is five times the attempt budget.
      for (let i = 0; i < 20 && scheduled.length > 0; i++) drain()
    },
    phase(snapshot) {
      queue.observe('agent.mason', snapshot)
    }
  }
}

/** Drives the avatar machine to a phase using documented transitions only. */
function phaseWorking(): AvatarSnapshot {
  let s = initialAvatar(T0)
  s = reduceAvatar(s, { kind: 'prompt-submitted' }, T0)
  s = reduceAvatar(s, { kind: 'pre-tool', toolClass: 'file' }, T0)
  return reduceAvatar(s, { kind: 'arrive' }, T0)
}

describe('CommandQueue — sending (FR-1.3)', () => {
  it('sends straight through when the agent is idle', () => {
    const r = rig()
    r.phase(initialAvatar(T0))

    const state = r.queue.submit('agent.mason', 'fix the flaky test')

    expect(state.held).toBeNull()
    expect(r.writes).toEqual([{ agentId: 'agent.mason', data: 'fix the flaky test' }])
  })

  it('writes the text and the submit key as SEPARATE writes', () => {
    // A single write ending in CR is taken as a paste by a booted TUI, and the
    // agent silently holds it. Measured live against a real claude.
    const r = rig()
    r.phase(initialAvatar(T0))
    r.queue.submit('agent.mason', 'go')

    expect(r.writes).toHaveLength(1)
    r.drain()
    expect(r.writes).toEqual([
      { agentId: 'agent.mason', data: 'go' },
      { agentId: 'agent.mason', data: SUBMIT_KEY }
    ])
  })

  it('refuses to send to an agent whose process is gone', () => {
    const r = rig()
    r.phase(reduceAvatar(initialAvatar(T0), { kind: 'process-exit' }, T0))

    expect(() => r.queue.submit('agent.mason', 'hello')).toThrow(/cannot send.*ghost/)
    expect(r.writes).toEqual([])
  })

  it('refuses an agent it has never seen', () => {
    const r = rig()
    expect(() => r.queue.submit('agent.nobody', 'hello')).toThrow(/no agent selected/)
  })
})

describe('CommandQueue — queue until idle', () => {
  it('holds text typed mid-tool, visibly, with a reason', () => {
    const r = rig()
    r.phase(phaseWorking())

    const state = r.queue.submit('agent.mason', 'also update the changelog')

    expect(state.held).toBe('also update the changelog')
    expect(state.reason).toContain('mid-tool')
    expect(r.writes).toEqual([])
    expect(r.changes.at(-1)?.held).toBe('also update the changelog')
  })

  it('flushes exactly once when the agent reaches idle', () => {
    const r = rig()
    r.phase(phaseWorking())
    r.queue.submit('agent.mason', 'and the changelog')

    // The turn ends: `success` is a 250 ms flash on the way to `idle` (SDD §6)
    // and the agent is already free, so the queue flushes there rather than
    // adding a visible stutter.
    let s = reduceAvatar(phaseWorking(), { kind: 'stop', pending: false }, T0)
    r.phase(s)
    r.drain()

    expect(r.writes).toEqual([
      { agentId: 'agent.mason', data: 'and the changelog' },
      { agentId: 'agent.mason', data: SUBMIT_KEY }
    ])

    // Reaching idle must not send it a second time. Counted on the TEXT, not
    // on every write: an unconfirmed submit key is legitimately pressed again
    // (2026-09-06), and a total-write count would read that as a second flush.
    s = reduceAvatar(s, { kind: 'tick' }, T0 + 250)
    r.phase(s)
    r.drain()
    expect(r.writes.filter((w) => w.data === 'and the changelog')).toHaveLength(1)
    expect(r.queue.state('agent.mason').held).toBeNull()
    expect(r.changes.at(-1)?.held).toBeNull()
  })

  it('accumulates two thoughts typed while the agent works', () => {
    const r = rig()
    r.phase(phaseWorking())
    r.queue.submit('agent.mason', 'first')
    const state = r.queue.submit('agent.mason', 'second')

    expect(state.held).toBe('first\nsecond')

    r.phase(initialAvatar(T0))
    r.drain()
    expect(r.writes[0]?.data).toBe('first\nsecond')
  })

  it('keeps later text behind text already queued, so order is preserved', () => {
    const r = rig()
    r.phase(phaseWorking())
    r.queue.submit('agent.mason', 'first')
    // The agent goes idle but nothing has flushed yet in this tick; a second
    // submit must not overtake the queued line.
    r.queue.submit('agent.mason', 'second')
    r.phase(initialAvatar(T0))
    r.drain()

    expect(r.writes.map((w) => w.data)).toEqual(['first\nsecond', SUBMIT_KEY])
  })

  it('lists everything it is holding', () => {
    const r = rig()
    r.phase(phaseWorking())
    r.queue.submit('agent.mason', 'held')
    expect(r.queue.list()).toEqual([
      { agentId: 'agent.mason', held: 'held', reason: 'agent is mid-tool' }
    ])
  })
})

describe('CommandQueue — interrupt and teardown', () => {
  it('drops queued text on interrupt', () => {
    const r = rig()
    r.phase(phaseWorking())
    r.queue.submit('agent.mason', 'never mind')

    r.queue.clear('agent.mason')

    expect(r.queue.state('agent.mason').held).toBeNull()
    expect(r.changes.at(-1)?.held).toBeNull()

    r.phase(initialAvatar(T0))
    r.drain()
    expect(r.writes).toEqual([])
  })

  it('is a no-op when there is nothing to clear', () => {
    const r = rig()
    r.queue.clear('agent.mason')
    expect(r.changes).toEqual([])
  })

  it('forgets an agent and reports the drop', () => {
    const r = rig()
    r.phase(phaseWorking())
    r.queue.submit('agent.mason', 'held')

    r.queue.forget('agent.mason')

    expect(r.queue.list()).toEqual([])
    expect(r.changes.at(-1)?.held).toBeNull()
    expect(() => r.queue.submit('agent.mason', 'again')).toThrow(/no agent selected/)
  })
})

/**
 * The harness's own wake path (B2 of the M7 exit gaps).
 *
 * `submit` is the Architect's door and consults the floor on purpose. `wake` is
 * the router's, and must not: by the time it is called the delivery plane has
 * already decided the agent is between turns, and the mail is already out of
 * the inbox. Every case below is one the live run actually hit.
 */
describe('CommandQueue — the harness wake ignores the floor', () => {
  it('sends to an agent stuck at a phase submit would only HOLD', () => {
    const r = rig()
    // `alert` is where a turn that calls no tool ends up and stays: avatar.ts's
    // `stop` is inert unless the agent was working or thinking. This is the
    // exact state that silenced the orchestrator for twenty minutes.
    r.phase(reduceAvatar(initialAvatar(T0), { kind: 'prompt-submitted' }, T0))

    // The Architect's text would be held, correctly, and shown back to them.
    r.queue.submit('agent.mason', 'architect text')
    expect(r.writes).toEqual([])
    expect(r.queue.state('agent.mason').held).toBe('architect text')

    // The wake goes anyway.
    r.queue.wake('agent.mason', 'you have mail')
    expect(r.writes).toEqual([{ agentId: 'agent.mason', data: 'you have mail' }])
  })

  it('sends to an agent whose phase would make submit THROW', () => {
    const r = rig()
    // No observed phase at all — decideCommand refuses with "no agent selected",
    // and that throw used to unwind the entire sweep from inside wakeCheck.
    expect(() => r.queue.submit('agent.mason', 'x')).toThrow()

    expect(() => r.queue.wake('agent.mason', 'you have mail')).not.toThrow()
    expect(r.writes).toEqual([{ agentId: 'agent.mason', data: 'you have mail' }])
  })

  it('still writes the submit key separately, like every other send', () => {
    const r = rig()
    r.queue.wake('agent.mason', 'you have mail')
    expect(r.writes).toHaveLength(1)
    r.drain()
    expect(r.writes[1]).toEqual({ agentId: 'agent.mason', data: SUBMIT_KEY })
  })

  it('leaves the Architect\u2019s held text held, rather than stapling it to a nudge', () => {
    const r = rig()
    r.phase(phaseWorking())
    r.queue.submit('agent.mason', 'architect text')

    r.queue.wake('agent.mason', 'you have mail')

    // The nudge went; their words are still theirs to send when the agent is ready.
    expect(r.writes).toEqual([{ agentId: 'agent.mason', data: 'you have mail' }])
    expect(r.queue.state('agent.mason').held).toBe('architect text')
  })
})

/**
 * The submit key was fire-and-forget, and a TUI that did not act on it left the
 * text in the prompt box with the harness believing it had spoken.
 *
 * Observed 2026-09-06 on the on-call agent: woken one second after spawn, it
 * took the nudge into its prompt and never ran it. Its transcript held four
 * setup lines and no user message; it sat `running` and idle for eighteen
 * minutes with two incidents assigned to it, and nothing anywhere said so.
 */
describe('a submit is confirmed, not assumed (2026-09-06)', () => {
  const submits = (r: Rig): number => r.writes.filter((w) => w.data === SUBMIT_KEY).length

  it('presses the key again when the engine does not report the prompt', () => {
    const r = rig()
    r.queue.wake('agent.mason', 'you have mail')

    r.drain()
    expect(submits(r)).toBe(1)
    r.drain()
    expect(submits(r)).toBe(2)
  })

  it('stops the moment the engine confirms, and never types into the answer', () => {
    const r = rig()
    r.queue.wake('agent.mason', 'you have mail')
    r.drain()
    expect(submits(r)).toBe(1)

    r.queue.accepted('agent.mason')
    r.drainAll()

    expect(submits(r)).toBe(1)
    expect(r.unaccepted).toEqual([])
  })

  it('gives up after a bounded number of keys and REPORTS it', () => {
    const r = rig()
    r.queue.wake('agent.mason', 'you have mail')

    r.drainAll()

    expect(submits(r)).toBe(SUBMIT_ATTEMPTS)
    expect(r.unaccepted).toEqual([{ agentId: 'agent.mason', attempts: SUBMIT_ATTEMPTS }])
  })

  it('reports once, not once per key', () => {
    const r = rig()
    r.queue.wake('agent.mason', 'you have mail')

    r.drainAll()
    r.drainAll()

    expect(r.unaccepted).toHaveLength(1)
  })

  it('covers the Architect\u2019s text too — their words go unrun the same way', () => {
    const r = rig()
    r.phase(initialAvatar(T0))
    r.queue.submit('agent.mason', 'do the thing')

    r.drainAll()

    expect(submits(r)).toBe(SUBMIT_ATTEMPTS)
    expect(r.unaccepted).toEqual([{ agentId: 'agent.mason', attempts: SUBMIT_ATTEMPTS }])
  })

  it('says nothing about an agent that died before it could answer', () => {
    // A dead agent did not decline its wake, and there is no prompt box left
    // for the text to be sitting in.
    const r = rig()
    r.queue.wake('agent.mason', 'you have mail')
    r.drain()

    r.queue.forget('agent.mason')
    r.drainAll()

    expect(submits(r)).toBe(1)
    expect(r.unaccepted).toEqual([])
  })

  it('is safe when an agent submits a prompt this queue never wrote to', () => {
    // Every `prompt-submitted` in the company arrives here, including the ones
    // an agent raised by itself.
    const r = rig()
    expect(() => r.queue.accepted('agent.nobody')).not.toThrow()
  })

  it('starts a fresh budget for each send rather than carrying the last one', () => {
    const r = rig()
    r.queue.wake('agent.mason', 'first')
    r.drainAll()
    expect(r.unaccepted).toHaveLength(1)

    r.queue.wake('agent.mason', 'second')
    r.drainAll()

    expect(submits(r)).toBe(SUBMIT_ATTEMPTS * 2)
    expect(r.unaccepted).toHaveLength(2)
  })
})

/**
 * The two cases a mutation pass found unpinned: both are about a send whose
 * verdict has not landed yet being overtaken by something else.
 */
describe('a submit whose verdict is overtaken', () => {
  const submits = (r: Rig): number => r.writes.filter((w) => w.data === SUBMIT_KEY).length

  it('says nothing when the agent dies between the last key and the verdict', () => {
    // `giveUp` is already scheduled at this point. Without its own check it
    // would report a dead agent as one that declined its wake.
    const r = rig()
    r.queue.wake('agent.mason', 'you have mail')
    for (let i = 0; i < SUBMIT_ATTEMPTS; i++) r.drain()
    expect(submits(r)).toBe(SUBMIT_ATTEMPTS)
    expect(r.unaccepted).toEqual([])

    r.queue.forget('agent.mason')
    r.drainAll()

    expect(r.unaccepted).toEqual([])
  })

  it('gives a second send its own budget rather than the remains of the first', () => {
    // Two nudges landing close together. The second is a fresh thing to say,
    // and must not inherit keys the first already spent.
    const r = rig()
    r.queue.wake('agent.mason', 'first')
    r.drain()
    expect(submits(r)).toBe(1)

    r.queue.wake('agent.mason', 'second')
    r.drainAll()

    expect(submits(r)).toBe(1 + SUBMIT_ATTEMPTS)
    expect(r.unaccepted).toEqual([{ agentId: 'agent.mason', attempts: SUBMIT_ATTEMPTS }])
  })
})

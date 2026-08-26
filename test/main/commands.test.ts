import { describe, expect, it } from 'vitest'
import { initialAvatar, reduceAvatar, type AvatarSnapshot } from '../../src/shared/avatar'
import type { CommandState } from '../../src/shared/commands'
import { CommandQueue, SUBMIT_KEY } from '../../src/main/commands'

/**
 * The queue as main actually runs it: held text, the flush on idle, and the
 * two-write submit that a live run proved necessary.
 */

const T0 = 1_000_000

interface Rig {
  readonly queue: CommandQueue
  readonly writes: { agentId: string; data: string }[]
  readonly changes: CommandState[]
  /** Runs the scheduled submit-key writes. */
  drain(): void
  phase(snapshot: AvatarSnapshot): void
}

function rig(): Rig {
  const writes: { agentId: string; data: string }[] = []
  const changes: CommandState[] = []
  const scheduled: (() => void)[] = []
  const queue = new CommandQueue({
    sink: { write: (agentId, data) => writes.push({ agentId, data }) },
    onChange: (state) => changes.push(state),
    schedule: (fn) => scheduled.push(fn)
  })
  return {
    queue,
    writes,
    changes,
    drain() {
      for (const fn of scheduled.splice(0)) fn()
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

    // Reaching idle must not send it a second time.
    s = reduceAvatar(s, { kind: 'tick' }, T0 + 250)
    r.phase(s)
    r.drain()
    expect(r.writes).toHaveLength(2)
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

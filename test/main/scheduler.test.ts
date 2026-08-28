import { describe, expect, it } from 'vitest'
import { Scheduler, type Trigger } from '../../src/main/scheduler'

/**
 * The scheduler's one hard property is tick idempotency: a tick loop that runs
 * faster than a trigger's interval must not turn a daily job into a metronome,
 * and a trigger already running must never be re-entered.
 */

function counting(id: string, everyMs: number): Trigger & { calls: number } {
  const trigger = {
    id,
    everyMs,
    calls: 0,
    run(): void {
      trigger.calls += 1
    }
  }
  return trigger
}

describe('Scheduler.tick idempotency', () => {
  it('fires a trigger once, however many ticks happen inside its interval', async () => {
    let nowMs = 1_000
    const scheduler = new Scheduler({ now: () => new Date(nowMs) })
    const trigger = counting('t', 60_000)
    scheduler.add(trigger)

    await scheduler.tick()
    await scheduler.tick()
    await scheduler.tick()
    expect(trigger.calls).toBe(1)

    nowMs += 59_999
    await scheduler.tick()
    expect(trigger.calls).toBe(1)

    nowMs += 1
    await scheduler.tick()
    expect(trigger.calls).toBe(2)
  })

  it('never re-enters a trigger that is still running', async () => {
    let nowMs = 0
    const scheduler = new Scheduler({ now: () => new Date(nowMs) })
    const waiting: (() => void)[] = []
    let starts = 0
    scheduler.add({
      id: 'slow',
      everyMs: 1,
      run: () => {
        starts += 1
        return new Promise<void>((resolve) => waiting.push(resolve))
      }
    })
    // A trigger's `run` is called from a microtask, so "it has started" is only
    // observable after yielding.
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

    const first = scheduler.tick()
    await settle()
    expect(starts).toBe(1)

    // Long past due, twice over — and still not re-entered.
    nowMs += 10_000
    await scheduler.tick()
    await scheduler.tick()
    expect(starts).toBe(1)

    waiting.shift()?.()
    await first

    // Free again, and due again: the next tick starts it.
    nowMs += 10_000
    const second = scheduler.tick()
    await settle()
    expect(starts).toBe(2)
    waiting.shift()?.()
    await second
  })

  it('stamps the clock before the run, so a slow job is not instantly due again', async () => {
    let nowMs = 0
    const scheduler = new Scheduler({ now: () => new Date(nowMs) })
    let calls = 0
    scheduler.add({
      id: 'slow',
      everyMs: 5_000,
      run: async () => {
        calls += 1
        nowMs += 60_000
        await Promise.resolve()
      }
    })

    await scheduler.tick()
    await scheduler.tick()
    // The second tick sees a clock 60 s later, but the interval is measured from
    // when the run STARTED, so exactly one more firing is due, not several.
    expect(calls).toBe(2)
  })
})

describe('Scheduler bookkeeping', () => {
  it('reports a failing trigger and keeps it scheduled', async () => {
    let nowMs = 0
    const errors: string[] = []
    const scheduler = new Scheduler({
      now: () => new Date(nowMs),
      onError: (id, err) => errors.push(`${id}:${String(err)}`)
    })
    let calls = 0
    scheduler.add({
      id: 'broken',
      everyMs: 10,
      run: () => {
        calls += 1
        throw new Error('nope')
      }
    })

    await scheduler.tick()
    nowMs += 100
    await scheduler.tick()
    expect(calls).toBe(2)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('broken:')
  })

  it('reports each firing, for the book of record', async () => {
    const fired: string[] = []
    const scheduler = new Scheduler({ now: () => new Date(0), onFired: (id) => fired.push(id) })
    scheduler.add(counting('a', 1_000))
    scheduler.add(counting('b', 1_000))
    await scheduler.tick()
    expect(fired.sort()).toEqual(['a', 'b'])
  })

  it('re-adding an id replaces the trigger but keeps its clock', async () => {
    const nowMs = 0
    const scheduler = new Scheduler({ now: () => new Date(nowMs) })
    const first = counting('t', 60_000)
    scheduler.add(first)
    await scheduler.tick()
    expect(first.calls).toBe(1)

    const second = counting('t', 60_000)
    scheduler.add(second)
    await scheduler.tick()
    // Not due yet — a hot-swap must not reset the schedule.
    expect(second.calls).toBe(0)
    expect(scheduler.ids()).toEqual(['t'])
  })

  it('start() and stop() are idempotent', () => {
    const scheduler = new Scheduler({ tickMs: 10_000 })
    scheduler.start()
    scheduler.start()
    scheduler.stop()
    scheduler.stop()
    expect(scheduler.ids()).toEqual([])
  })
})

describe('the mode gate (ADR-0018, FR-14.4, SDD §9)', () => {
  it('does not fire a trigger whose `enabled` says no', async () => {
    let fired = 0
    let allowed = false
    const scheduler = new Scheduler({ now: () => new Date(0) })
    scheduler.add({
      id: 'stoa-cadence',
      everyMs: 1,
      enabled: () => allowed,
      run: () => {
        fired += 1
      }
    })
    await scheduler.tick()
    expect(fired).toBe(0)

    // …and fires the moment it is allowed, WITHOUT waiting out an interval it
    // spent forbidden. A cadence switched off for a week should run when it is
    // switched back on, not sit out one more day for having been asked while off.
    allowed = true
    await scheduler.tick()
    expect(fired).toBe(1)
  })

  it('treats a trigger with no `enabled` as always allowed', async () => {
    let fired = 0
    const scheduler = new Scheduler({ now: () => new Date(0) })
    scheduler.add({ id: 'always', everyMs: 1, run: () => void (fired += 1) })
    await scheduler.tick()
    expect(fired).toBe(1)
  })
})

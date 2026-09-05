import { describe, expect, it, vi } from 'vitest'
import { Scheduler } from '../../src/main/scheduler'

/**
 * M8.8. When a trigger last fired is the one piece of scheduler state a restart
 * cannot re-derive: everything else about a trigger comes back with the
 * activation that armed it. Losing it makes every restored trigger due
 * immediately, so a machine that reboots nightly runs its daily jobs twice and
 * one that crash-loops runs them on every boot.
 */

const HOUR = 3_600_000

function rig(startMs = 0) {
  const persisted: Record<string, number>[] = []
  let nowMs = startMs
  const scheduler = new Scheduler({
    now: () => new Date(nowMs),
    persist: (lastFired) => persisted.push({ ...lastFired })
  })
  return {
    scheduler,
    persisted,
    at: (ms: number) => {
      nowMs = ms
    }
  }
}

describe('the trigger clock across a restart', () => {
  it('writes the clock down when a trigger fires, and not when none does', async () => {
    const r = rig(HOUR)
    const run = vi.fn()
    r.scheduler.add({ id: 'crew/sweep', everyMs: HOUR, run })

    await r.scheduler.tick()
    expect(run).toHaveBeenCalledTimes(1)
    expect(r.persisted).toEqual([{ 'crew/sweep': HOUR }])

    // Not due yet: nothing changed, so nothing is written.
    r.at(HOUR + 1)
    await r.scheduler.tick()
    expect(r.persisted).toHaveLength(1)
  })

  /** The defect: a restored trigger that is due the instant it comes back. */
  it('a restored trigger is not due again until its interval has passed', async () => {
    const first = rig(HOUR)
    first.scheduler.add({ id: 'crew/sweep', everyMs: HOUR, run: vi.fn() })
    await first.scheduler.tick()
    const record = first.persisted.at(-1)
    if (!record) throw new Error('nothing persisted')

    // The restart: a NEW scheduler, seeded, then armed by the activation.
    const second = rig(HOUR + 60_000)
    const run = vi.fn()
    expect(second.scheduler.restore(record)).toBe(1)
    second.scheduler.add({ id: 'crew/sweep', everyMs: HOUR, run })

    await second.scheduler.tick()
    expect(run).not.toHaveBeenCalled()

    second.at(2 * HOUR + 1)
    await second.scheduler.tick()
    expect(run).toHaveBeenCalledTimes(1)
  })

  /** Without the seed, the same restart fires immediately — the bug, pinned. */
  it('without the restore it fires immediately, which is what this prevents', async () => {
    const second = rig(HOUR + 60_000)
    const run = vi.fn()
    second.scheduler.add({ id: 'crew/sweep', everyMs: HOUR, run })

    await second.scheduler.tick()

    expect(run).toHaveBeenCalledTimes(1)
  })

  /**
   * Order-independence is the point of holding the clock separately from the
   * registration: an ordering rule between two boot steps holds until someone
   * moves a line, and nothing reports the day it stops holding.
   */
  it('seeding after the trigger is armed works exactly as seeding before', async () => {
    const r = rig(HOUR + 60_000)
    const run = vi.fn()
    r.scheduler.add({ id: 'crew/sweep', everyMs: HOUR, run })
    r.scheduler.restore({ 'crew/sweep': HOUR })

    await r.scheduler.tick()

    expect(run).not.toHaveBeenCalled()
  })

  it('never overrides a trigger that has already fired in this session', async () => {
    const r = rig(2 * HOUR)
    const run = vi.fn()
    r.scheduler.add({ id: 'crew/sweep', everyMs: HOUR, run })
    await r.scheduler.tick()
    expect(run).toHaveBeenCalledTimes(1)

    // A late restore carrying a much older clock must not make it due again.
    expect(r.scheduler.restore({ 'crew/sweep': 0 })).toBe(0)
    r.at(2 * HOUR + 1)
    await r.scheduler.tick()

    expect(run).toHaveBeenCalledTimes(1)
  })

  it('holds the clock for a trigger nothing has armed yet', async () => {
    const r = rig(HOUR + 60_000)
    r.scheduler.restore({ 'crew/sweep': HOUR })
    expect(r.scheduler.ids()).toEqual([])

    const run = vi.fn()
    r.scheduler.add({ id: 'crew/sweep', everyMs: HOUR, run })
    await r.scheduler.tick()

    expect(run).not.toHaveBeenCalled()
  })

  /**
   * Disarming is deliberate — a deactivation, or a profile going away — and its
   * clock goes with it. Keeping it would grow the record with ids of triggers
   * that no longer exist and hand a stale clock to a later reactivation.
   */
  it('removing a trigger drops its clock, and says so', async () => {
    const r = rig(HOUR)
    r.scheduler.add({ id: 'crew/sweep', everyMs: HOUR, run: vi.fn() })
    await r.scheduler.tick()
    expect(r.persisted.at(-1)).toEqual({ 'crew/sweep': HOUR })

    r.scheduler.remove('crew/sweep')

    expect(r.persisted.at(-1)).toEqual({})
  })

  it('removing a trigger that never fired writes nothing', () => {
    const r = rig(HOUR)
    r.scheduler.add({ id: 'crew/sweep', everyMs: HOUR, run: vi.fn() })
    r.scheduler.remove('crew/sweep')
    expect(r.persisted).toEqual([])
  })

  it('restoring twice takes the record once', () => {
    const r = rig(HOUR)
    expect(r.scheduler.restore({ 'crew/sweep': 10 })).toBe(1)
    expect(r.scheduler.restore({ 'crew/sweep': 20 })).toBe(0)
  })

  /**
   * The clock is stamped when a trigger becomes due, and written before the run
   * is awaited: a crash during a long job must not lose the fact that it
   * started. Re-running a job is the cheaper failure; running it on every boot
   * because the write waited for it to finish is not.
   */
  it('writes the clock before the firing is awaited', async () => {
    const r = rig(HOUR)
    let persistedDuringRun: Record<string, number> | undefined
    r.scheduler.add({
      id: 'crew/sweep',
      everyMs: HOUR,
      run: () => {
        persistedDuringRun = r.persisted.at(-1)
        return Promise.resolve()
      }
    })

    await r.scheduler.tick()

    expect(persistedDuringRun).toEqual({ 'crew/sweep': HOUR })
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileBreakerStopStore, type BreakerStopStore } from '../../src/main/watch/breaker-store'
import { Breaker } from '../../src/main/watch/breaker'
import { removeTempDir } from '../tmpdir'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempDir(dir)
})
function file(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-breaker-store-'))
  dirs.push(dir)
  return path.join(dir, 'breaker-stops.json')
}
function rig(store: BreakerStopStore) {
  const stop = vi.fn()
  const errors = vi.fn()
  const breaker = new Breaker({
    stopStore: store,
    now: () => 100_000,
    budgetState: () => 'breached',
    steerText: () => 'steer',
    onPersistenceError: errors,
    effects: {
      stop,
      steer: () => {},
      pauseDeliveries: () => {},
      constrainBudget: () => {},
      interrupt: () => {},
      returnTask: () => {},
      avatar: () => {}
    }
  })
  return { breaker, stop, errors }
}
function trip(breaker: Breaker): void {
  for (const rung of [1, 2, 3]) expect(breaker.forceEvaluate('agent.artemis')).toBe(rung)
}

describe('durable breaker decisions', () => {
  it('refuses an old clear after a new trip at the same clock time', () => {
    const r = rig(new FileBreakerStopStore(file()))
    trip(r.breaker)
    const old = r.breaker.stopOf('agent.artemis')!
    r.breaker.clearStop('agent.artemis', old.at)
    trip(r.breaker)
    expect(r.breaker.stopOf('agent.artemis')!.at).toBeGreaterThan(old.at)
    expect(() => r.breaker.clearStop('agent.artemis', old.at)).toThrow('changed')
  })

  it('saves before stopping, survives a fresh instance, and durably clears', () => {
    const target = file()
    const store = new FileBreakerStopStore(target)
    const first = rig(store)
    first.stop.mockImplementation(() => {
      expect(store.load()).toHaveLength(1)
      first.breaker.forgetSession('agent.artemis')
    })
    trip(first.breaker)
    const restarted = rig(new FileBreakerStopStore(target))
    const stop = restarted.breaker.stopOf('agent.artemis')!
    expect(restarted.breaker.respawnBlocked('agent.artemis')).toContain('rung 3')
    expect(restarted.breaker.respawnBlocked('agent.other')).toBeNull()
    expect(() => restarted.breaker.clearStop('agent.artemis', stop.at - 1)).toThrow('changed')
    expect(store.load()).toHaveLength(1)
    expect(restarted.breaker.clearStop('agent.artemis', stop.at)).toBe(true)
    expect(rig(store).breaker.stopped()).toEqual([])
    expect(restarted.stop).not.toHaveBeenCalled()
  })

  it.each(['{', '{"schemaVersion":2,"stops":[]}', '{"schemaVersion":1,"stops":[{}]}'])(
    'blocks every start on invalid persisted state: %s',
    (contents) => {
      const target = file()
      fs.writeFileSync(target, contents)
      const r = rig(new FileBreakerStopStore(target))
      expect(r.breaker.respawnBlocked('agent.any')).toContain('storage unavailable')
      expect(r.errors).toHaveBeenCalledOnce()
      expect(r.breaker.stopsView().error).not.toBeNull()
      expect(fs.readFileSync(target, 'utf8')).toBe(contents)
    }
  )

  it('does not read a directory as an empty stop register', () => {
    const target = file()
    fs.mkdirSync(target)
    expect(rig(new FileBreakerStopStore(target)).breaker.respawnBlocked('agent.any')).not.toBeNull()
  })

  it('still stops the process and refuses further starts when saving fails', () => {
    const r = rig({
      load: () => [],
      save: () => {
        throw new Error('disk unavailable')
      }
    })
    trip(r.breaker)
    expect(r.stop).toHaveBeenCalledOnce()
    expect(r.breaker.stopOf('agent.artemis')).not.toBeNull()
    expect(r.breaker.respawnBlocked('agent.other')).toContain('disk unavailable')
    expect(() => r.breaker.clearStop('agent.artemis')).toThrow()
  })

  it('retains a stop when persisting its removal fails', () => {
    const store = new FileBreakerStopStore(file())
    const first = rig(store)
    trip(first.breaker)
    const r = rig({
      load: () => store.load(),
      save: () => {
        throw new Error('read only')
      }
    })
    expect(() => r.breaker.clearStop('agent.artemis')).toThrow('read only')
    expect(r.breaker.stopped()).toHaveLength(1)
    expect(store.load()).toHaveLength(1)
  })

  it('persists decommissioning and rejects duplicate identities', () => {
    const store = new FileBreakerStopStore(file())
    const r = rig(store)
    trip(r.breaker)
    const stop = r.breaker.stopped()[0]!
    expect(() => store.save([stop, stop])).toThrow('duplicate')
    r.breaker.forgetAgent('agent.artemis')
    expect(store.load()).toEqual([])
  })
})

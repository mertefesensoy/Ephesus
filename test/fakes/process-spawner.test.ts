import { afterEach, describe, expect, it } from 'vitest'
import { ProcessSpawner } from './process-spawner'
import type { SpawnPlan } from '../../src/main/engines'

/**
 * The fake spawner's obligation NOT to hide a failure.
 *
 * This file exists because the fake used to hide them all. `stderr` went to
 * `stderr.resume()`, and a child that could not start at all was
 * `child.on('error', () => this.children.delete(id))` — no record, no exit
 * event, nothing. On 2026-09-01 a quoting bug in the version probe made every
 * spawn take the FR-1.6 install branch, and seven tests across `agent-worktree`
 * and `s-crash` reported `timed out waiting for the agent to start` and nothing
 * else. The cause was found only by editing this file by hand to print what it
 * was throwing away.
 *
 * Test infrastructure that conceals why a test failed is worse than no test, so
 * these pin the concealment shut. They are cheap: real child processes, but tiny
 * ones.
 */

const spawners: ProcessSpawner[] = []

afterEach(() => {
  for (const spawner of spawners.splice(0)) spawner.killAll()
})

function rig(): ProcessSpawner {
  const spawner = new ProcessSpawner()
  spawners.push(spawner)
  return spawner
}

function plan(argv: readonly string[]): SpawnPlan {
  return {
    argv: [...argv],
    cwd: process.cwd(),
    env: { ...process.env } as Record<string, string>,
    settings: []
  }
}

/** Resolves when `predicate` holds, or throws after `timeoutMs`. */
async function until(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`process-spawner test: timed out waiting for ${label}`)
}

describe('the fake spawner keeps what a failing child said', () => {
  it('captures stderr instead of draining it', async () => {
    // `stderr.resume()` is what this replaces. A child says why it is dying on
    // this stream and nowhere else.
    const spawner = rig()
    spawner.spawnAgent(
      'agent.a',
      plan([process.execPath, '-e', 'console.error("boom: no config")'])
    )

    await until(() => spawner.stderrOf('agent.a').includes('boom'), 'stderr')

    expect(spawner.stderrOf('agent.a')).toContain('boom: no config')
    // stdout stays separate — a merged buffer would let a stray stderr line
    // satisfy an assertion about what the agent SAID.
    expect(spawner.stdoutOf('agent.a')).toBe('')
  })

  it('records a child that could not be spawned at all', async () => {
    const spawner = rig()
    spawner.spawnAgent('agent.ghost', plan(['eph-definitely-not-a-real-binary']))

    await until(() => spawner.failureOf('agent.ghost') !== null, 'the spawn failure')

    expect(spawner.failureOf('agent.ghost')).toContain('ENOENT')
    expect(spawner.has('agent.ghost')).toBe(false)
  })

  it('reaps a spawn that never started, exactly once, rather than leaving a phantom', async () => {
    // The old code deleted the child and returned. Nothing fired, so the manager
    // went on believing an agent existed that never had. Production fails
    // LOUDER than this — `pty.spawn` throws synchronously — so reaping is the
    // faithful direction, not a liberty.
    //
    // ON THE `reaped` GUARD, and what this test does NOT prove. Node documents
    // that `exit` MAY OR MAY NOT follow an `error`; the guard is there so the
    // manager unwinds one spawn either way. On Windows/node 20 an ENOENT spawn
    // fires `error` and no `exit`, so deleting the guard changes nothing here —
    // verified by mutation, which SURVIVED. The single-element assertion below
    // is what would catch a double report on a platform that does send both.
    // Stated rather than implied, because a test that reads as pinning the
    // guard while being structurally unable to is worse than no test.
    const spawner = rig()
    const exits: { id: string; code: number }[] = []
    spawner.onExit((id, code) => exits.push({ id, code }))

    spawner.spawnAgent('agent.ghost', plan(['eph-definitely-not-a-real-binary']))
    await until(() => exits.length > 0, 'the reap')
    // Long enough for a trailing `exit` to arrive if this platform sends one.
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(exits).toEqual([{ id: 'agent.ghost', code: -1 }])
  })

  it('still reports a normal exit once, with its code', async () => {
    const spawner = rig()
    const exits: { id: string; code: number }[] = []
    spawner.onExit((id, code) => exits.push({ id, code }))

    spawner.spawnAgent('agent.a', plan([process.execPath, '-e', 'process.exit(3)']))
    await until(() => exits.length > 0, 'the exit')

    expect(exits).toEqual([{ id: 'agent.a', code: 3 }])
  })
})

describe('diagnose() says enough to find the cause', () => {
  it('names the command, the cwd and the spawn failure', async () => {
    const spawner = rig()
    spawner.spawnAgent('agent.ghost', plan(['eph-definitely-not-a-real-binary']))
    await until(() => spawner.failureOf('agent.ghost') !== null, 'the spawn failure')

    const report = spawner.diagnose('agent.ghost')

    expect(report).toContain('eph-definitely-not-a-real-binary')
    expect(report).toContain('SPAWN FAILED')
    expect(report).toContain(process.cwd())
  })

  it('carries the exit code and the stderr of a child that started and died', async () => {
    const spawner = rig()
    spawner.spawnAgent(
      'agent.a',
      plan([process.execPath, '-e', 'console.error("config missing"); process.exit(3)'])
    )
    await until(() => spawner.diagnose('agent.a').includes('exit=3'), 'the exit')

    const report = spawner.diagnose('agent.a')

    expect(report).toContain('exit=3')
    // Asserted against the `stderr=` FIELD, not anywhere in the line. `node -e`
    // puts the script text in argv, which `diagnose` also prints — so a plain
    // `toContain('config missing')` passes on the echoed command line even with
    // stderr capture ripped out, and pins nothing. Caught by mutation.
    expect(report).toMatch(/stderr="[^"]*config missing/)
  })

  it('describes every spawn when asked for no particular one', async () => {
    // The useful default when the thing that timed out is "no agent appeared".
    const spawner = rig()
    spawner.spawnAgent('agent.a', plan([process.execPath, '-e', 'process.exit(0)']))
    spawner.spawnAgent('agent.b', plan(['eph-definitely-not-a-real-binary']))
    await until(() => spawner.failureOf('agent.b') !== null, 'the spawn failure')

    const report = spawner.diagnose()

    expect(report).toContain('agent.a')
    expect(report).toContain('agent.b')
  })

  it('says so plainly when nothing was ever spawned', () => {
    // Called from the unhappy path, so it must never throw on an empty rig.
    expect(rig().diagnose()).toBe('no process was ever spawned')
  })
})

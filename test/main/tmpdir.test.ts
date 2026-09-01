import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir, TEMP_REMOVE_BUDGET_MS } from '../tmpdir'

/**
 * The teardown flake this closes, written down executably.
 *
 * On Windows a process's current directory is an open handle on it, so while a
 * `git` child spawned by `ExecGitRunner` is alive, `rmdir` of the repository it
 * is running in fails with EBUSY. These tests reproduce the pin with a plain
 * child process rather than with git: the mechanism is the cwd handle and
 * nothing about git, and a plain child holds for an exact, known time instead
 * of however long a commit happens to take.
 */

const temps: string[] = []
const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill()
  for (const dir of temps.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
    } catch {
      // The test being torn down is the one that failed; do not mask it.
    }
  }
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A temp home with a subdirectory a child process sits in, as git sits in a
 * repo. Resolves only once the pin is REALLY held.
 *
 * The handshake is not ceremony. Awaiting the `spawn` event alone pins the
 * directory 9 times in 10 — measured — and a test that is right 90% of the time
 * is the exact disease this change is treating. Waiting for a flag the child
 * writes once its own JS is running measured 20/20.
 */
async function pinnedHome(holdMs: number): Promise<{ home: string; pinned: string }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-pin-'))
  temps.push(home)
  const pinned = path.join(home, 'agora')
  fs.mkdirSync(path.join(pinned, 'agents', 'agent.a'), { recursive: true })
  fs.writeFileSync(path.join(pinned, 'agents', 'agent.a', 'f.json'), '{}', 'utf8')

  const flag = path.join(home, 'pinned')
  const source =
    `require('fs').writeFileSync(${JSON.stringify(flag)}, 'x');` +
    ` setTimeout(() => {}, ${String(holdMs)})`
  const child = spawn(process.execPath, ['-e', source], { cwd: pinned, stdio: 'ignore' })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  for (let i = 0; i < 600 && !fs.existsSync(flag); i += 1) await sleep(5)
  if (!fs.existsSync(flag)) throw new Error('the pinning child never started')
  return { home, pinned }
}

describe('removing a temp directory a live process is sitting in', () => {
  it('holds the directory itself, never anything inside it', async () => {
    const { pinned } = await pinnedHome(30_000)

    // The signature that identified the cause. A probe over the real suite
    // emptied each failing tree by hand and reported the busy path as a git
    // repository root every time, never a file — and a directory that is locked
    // while its contents are deletable is an open DIRECTORY handle, which is
    // what a process's working directory is.
    expect(() =>
      fs.rmSync(path.join(pinned, 'agents'), { recursive: true, force: true })
    ).not.toThrow()
    expect(() => fs.rmdirSync(pinned)).toThrow(/EBUSY|EPERM/)
  })

  /**
   * The measurement that decided how `removeTempDir` is written. `fs.rmSync`
   * documents `maxRetries`/`retryDelay` as retrying EBUSY with a linear
   * backoff, so 10 × 50 ms reads as ~2.75 s of patience — which is what every
   * teardown in this suite used to ask for, and why the first version of this
   * fix was nothing but a bigger number. It is not patient at all.
   *
   * If a future node makes the built-in honour its own budget, this test fails
   * and `removeTempDir` can go back to being a config change.
   */
  it('is not something rmSync will wait out, whatever budget it is given', async () => {
    const { home, pinned } = await pinnedHome(3_000)

    // 20 × 100 ms of documented linear backoff is ~21 s of patience against a
    // pin that releases after 3 s: a budget that was honoured would SUCCEED.
    // The throw is the proof, so nothing here rests on a stopwatch.
    expect(() =>
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    ).toThrow(/EBUSY|EPERM/)

    expect(fs.existsSync(pinned)).toBe(true)
  })

  it('waits the pin out, because a process exiting is a wait and not a failure', async () => {
    const { home } = await pinnedHome(3_000)
    const startedAt = Date.now()

    expect(() => removeTempDir(home)).not.toThrow()

    expect(fs.existsSync(home)).toBe(false)
    // It really waited: the pin does not release until the child's 3 s timer
    // fires, so anything finishing sooner did not remove a pinned directory.
    // Measured against the pin, which is a real event, rather than against a
    // wall-clock budget the machine's load can move.
    expect(Date.now() - startedAt).toBeGreaterThan(1_500)
  })

  it('still throws when nothing is going to release the directory', async () => {
    // Held far longer than the budget: a teardown that cannot remove its
    // directory after a fair wait is a leak — a process nobody shut down — and
    // swallowing it would trade a flaky suite for a silent one.
    const { home } = await pinnedHome(120_000)

    expect(() => removeTempDir(home)).toThrow(/EBUSY|EPERM/)
  })

  it('removes an unheld directory without waiting, adding nothing to a green run', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-pin-'))
    temps.push(home)
    fs.mkdirSync(path.join(home, 'agora', 'agents'), { recursive: true })
    const startedAt = Date.now()

    removeTempDir(home)

    expect(fs.existsSync(home)).toBe(false)
    // Well inside the budget, so nothing sleeps on the happy path. The bound is
    // loose on purpose: unlinking a tree on a loaded Windows machine is not
    // instant, and this is a test about not RETRYING, not about disk speed.
    expect(Date.now() - startedAt).toBeLessThan(TEMP_REMOVE_BUDGET_MS / 2)
  })

  it('gives a git child long enough to finish and exit', () => {
    // Commits under parallel workers were observed outlasting the old ~2.75 s.
    expect(TEMP_REMOVE_BUDGET_MS).toBeGreaterThan(8_000)
  })
})

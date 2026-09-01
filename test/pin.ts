import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Does THIS platform hold a directory open because a process is standing in it?
 *
 * On Windows a process's current directory is an open handle on it, so a `git`
 * child locks the repository it runs in: `rmdir` fails with EBUSY while every
 * file inside deletes normally. That is why `test/tmpdir.ts` waits.
 *
 * POSIX does not do this — removing a directory that is a live process's
 * working directory simply succeeds. Verified rather than assumed: parking a
 * shell in a directory under WSL Ubuntu and removing it around that shell
 * succeeds, where the same steps on Windows are refused.
 *
 * **CI runs on ubuntu-latest**, so a test that asserts the pin proves nothing
 * there — and, written unguarded, FAILS there, because it asserts a refusal
 * that platform never makes. Hence this probe. It measures the behaviour rather
 * than reading `process.platform`: the question genuinely is whether this
 * filesystem holds the directory, and a platform nobody here has considered
 * then gets the right answer without anyone editing a list.
 *
 * ## Why the answer is three-valued
 *
 * A probe like this has a silent failure mode that is the whole reason it is
 * written so carefully: **if the setup no-ops, "no pin" and "never actually
 * tried" are indistinguishable**, and the tests it guards quietly disappear
 * while the suite stays green. That shape cost this project three separate
 * false conclusions in one day — a probe that deleted a directory nothing was
 * holding, a probe whose children had all exited before it measured anything,
 * and a test asserting a property while targeting the wrong path.
 *
 * So `unknown` is a distinct answer and is never folded into `false`. The
 * caller is expected to FAIL on it rather than skip, because an unanswerable
 * probe means the suite cannot make its claim either way.
 *
 * Contract: never throws. Every "could not establish the pin" path — the child
 * not starting, the child dying before the attempt, the directory not being
 * empty, any exception at all — returns `unknown` with the reason, never
 * `false`.
 */
export type PinProbe =
  | { readonly pinned: true }
  | { readonly pinned: false }
  | { readonly pinned: null; readonly reason: string }

const HOLD_MS = 30_000

export async function pinHolds(): Promise<PinProbe> {
  let home: string | null = null
  let proc: ReturnType<typeof spawn> | null = null
  try {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-pinprobe-'))
    const held = path.join(home, 'held')
    fs.mkdirSync(held, { recursive: true })

    const flag = path.join(home, 'ready')
    const source =
      `require('fs').writeFileSync(${JSON.stringify(flag)}, 'x');` +
      ` setTimeout(() => {}, ${String(HOLD_MS)})`
    proc = spawn(process.execPath, ['-e', source], { cwd: held, stdio: 'ignore' })
    const child = proc
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })

    // The cwd handle is established asynchronously; the `spawn` event alone
    // leaves the pin absent about one time in ten (measured).
    for (let i = 0; i < 600 && !fs.existsSync(flag); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    if (!fs.existsSync(flag)) {
      return { pinned: null, reason: 'the pinning child never signalled that it had started' }
    }
    if (child.exitCode !== null) {
      return {
        pinned: null,
        reason: `the pinning child exited early (code ${String(child.exitCode)})`
      }
    }
    // A non-empty directory refuses with ENOTEMPTY whatever the platform, which
    // would read as a pin. The probe must be measuring the handle, nothing else.
    const leftovers = fs.readdirSync(held)
    if (leftovers.length > 0) {
      return { pinned: null, reason: `the probe directory was not empty: ${leftovers.join(', ')}` }
    }

    let refusedWith: string | null = null
    try {
      fs.rmdirSync(held)
    } catch (err) {
      refusedWith = (err as NodeJS.ErrnoException).code ?? 'unknown'
    }

    // Liveness is checked AFTER the attempt too: a child that died mid-probe
    // means the delete raced an exit rather than a held directory, and
    // "succeeded" would then be a measurement of nothing.
    if (child.exitCode !== null) {
      return { pinned: null, reason: 'the pinning child exited during the attempt' }
    }
    if (refusedWith === null) return { pinned: false }
    if (refusedWith === 'ENOTEMPTY' || refusedWith === 'ENOENT') {
      return { pinned: null, reason: `the attempt failed for an unrelated reason: ${refusedWith}` }
    }
    return { pinned: true }
  } catch (err) {
    return {
      pinned: null,
      reason: `the probe could not run: ${err instanceof Error ? err.message : String(err)}`
    }
  } finally {
    proc?.kill()
    if (home !== null) {
      try {
        fs.rmSync(home, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
      } catch {
        // Probe litter, not a finding.
      }
    }
  }
}

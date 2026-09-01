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

/** Same three-valued shape, for "does a held file block a rename over it". */
export type RenameProbe =
  | { readonly blocks: true }
  | { readonly blocks: false }
  | { readonly blocks: null; readonly reason: string }

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

/**
 * Does THIS platform refuse to rename a file over a destination something else
 * is holding open?
 *
 * Windows does: an open read handle on the destination — which is all a virus
 * scanner or a search indexer is — makes `renameSync` fail with `EPERM`, and
 * the destination keeps its old contents, so the write is lost. That is the
 * whole reason `writeFileAtomic` retries. POSIX does not: a rename over an open
 * file succeeds, the reader keeps reading the old inode, and nothing fails.
 *
 * So the retry cannot be provoked on CI, and a test asserting the block would
 * FAIL there rather than merely prove nothing — the same trap as `pinHolds`.
 *
 * Contract: never throws, and never reports `false` for a setup that did not
 * actually contend. The handle is confirmed open before the rename is
 * attempted, because "the rename succeeded" is only evidence about the platform
 * if something was really holding the destination.
 */
export function renameBlocks(): RenameProbe {
  let home: string | null = null
  let fd: number | null = null
  try {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-renprobe-'))
    const dest = path.join(home, 'dest')
    const tmp = path.join(home, 'tmp')
    fs.writeFileSync(dest, 'old', 'utf8')
    fs.writeFileSync(tmp, 'new', 'utf8')

    try {
      fd = fs.openSync(dest, 'r')
    } catch (err) {
      return {
        blocks: null,
        reason: `could not hold the destination open: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    try {
      fs.renameSync(tmp, dest)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown'
      if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') return { blocks: true }
      return { blocks: null, reason: `the rename failed for an unrelated reason: ${code}` }
    }
    // It went through while the handle was open, which is the POSIX behaviour.
    return fs.readFileSync(dest, 'utf8') === 'new'
      ? { blocks: false }
      : { blocks: null, reason: 'the rename reported success but did not replace the destination' }
  } catch (err) {
    return {
      blocks: null,
      reason: `the probe could not run: ${err instanceof Error ? err.message : String(err)}`
    }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Probe litter, not a finding.
      }
    }
    if (home !== null) {
      try {
        fs.rmSync(home, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
      } catch {
        // Probe litter, not a finding.
      }
    }
  }
}

import fs from 'node:fs'

/**
 * Removes a temp directory a test created, waiting out the one thing that
 * legitimately blocks it.
 *
 * ## What blocks it
 *
 * `ExecGitRunner` runs `execFile('git', …, { cwd })` with the repository as the
 * child's working directory (`src/main/git.ts`), and on Windows a process's
 * current directory is an open handle on it. While any git child is alive,
 * `rmdir` of that directory fails with `EBUSY`.
 *
 * That is how the cause was found: a probe over the real suite emptied each
 * failing tree by hand and reported the busy path as a git repository root
 * every single time (`agora`, `target-repo`, `repo-mason`), never a file. A
 * control that parked a plain child process in a directory and deleted around
 * it reproduced the same shape exactly, and the directory became removable the
 * instant that child exited.
 *
 * ## Why `rmSync`'s own retry is not the answer
 *
 * `fs.rmSync` documents `maxRetries`/`retryDelay` as retrying `EBUSY` with a
 * linear backoff, and this helper first shipped as nothing but a bigger budget.
 * Measured on node v20.16.0 against a held pin, that budget does nothing at all:
 *
 * ```text
 * maxRetries=10 retryDelay=50  -> EBUSY after 3ms
 * maxRetries=20 retryDelay=50  -> EBUSY after 1ms
 * maxRetries=20 retryDelay=100 -> EBUSY after 1ms
 * ```
 *
 * It gives up in milliseconds whatever it is told, and leaves the contents in
 * place. So the retry is written out here instead of configured, and
 * `tmpdir.test.ts` pins that measurement down so the next person does not have
 * to rediscover it.
 *
 * ## Why waiting is legitimate
 *
 * What we are waiting for is a process to exit, and it will. The wait is
 * bounded, and it does NOT swallow the failure: a teardown that still cannot
 * remove its directory after a fair wait is a leak — a process nobody shut
 * down — and hiding that would trade a flaky suite for a silent one.
 */

/** How long to keep trying before calling it a leak rather than a wait. */
export const TEMP_REMOVE_BUDGET_MS = 10_000

/** Codes that mean "something still holds this", as opposed to a real fault. */
const TRANSIENT = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES', 'EMFILE', 'ENFILE'])

/**
 * Blocks this thread for `ms`. Teardown hooks are commonly synchronous, and
 * `Atomics.wait` on a throwaway buffer is the one way to wait in one without
 * burning the CPU on a spin.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function removeTempDir(dir: string): void {
  const startedAt = Date.now()
  let wait = 25
  for (;;) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      // A real fault — a bad path, a permissions problem that is not a lock —
      // is reported at once. Only a "still held" error is worth waiting on.
      if (!TRANSIENT.has(code)) throw err
      if (Date.now() - startedAt >= TEMP_REMOVE_BUDGET_MS) throw err
      sleepSync(wait)
      wait = Math.min(wait * 2, 250)
    }
  }
}

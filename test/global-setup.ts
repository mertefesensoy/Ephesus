import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * What the suite checks and tidies BEFORE any test runs.
 *
 * Two jobs, both learned from one bad night (2026-09-07): the harness could not
 * tell the Architect that the machine was out of memory, and it had been
 * quietly filling `%TEMP%` for two weeks.
 *
 * ## 1. A suite that dies for lack of memory must SAY so
 *
 * With free memory at 0.11–0.37 GB of 16.8, vitest's forks started dying
 * mid-run. What that looks like from the outside is not "out of memory" — it is
 * **15, then 39, then 43 test failures**, a different set each time, with
 * `Worker exited unexpectedly` buried in an unhandled-error block and no
 * mention of memory anywhere. An hour went into chasing a regression that did
 * not exist.
 *
 * That is the same defect this repository keeps finding in its own product and
 * had just fixed one milestone earlier: **a refusal that cannot teach the rule
 * it is enforcing gets re-earned every time.** A red suite that is not evidence
 * is worth no more than a green one that is not.
 *
 * So the check refuses up front, naming the number — and it does NOT quietly
 * reduce the worker count instead. Degrading here would trade a loud, correct
 * refusal for a slow run whose result nobody could interpret, which is the
 * direction ADR-0024 rejects for engines and the same reasoning applies.
 *
 * ## 2. The suite tidies up after its previous selves
 *
 * Per-file teardown cannot reach two legitimate categories: the directories
 * `tmpdir.test.ts` deliberately pins (it asserts that `removeTempDir` gives up
 * on a held directory, so the directory is by construction still there when the
 * test ends), and the residue `removeTempDir` honestly reported as a leak
 * rather than hiding. Measured, one full run leaves 11 behind; 3 279 had
 * accumulated since 2026-08-26 — 42 910 files across 24 405 directories.
 *
 * Sweeping is therefore done here rather than in a teardown, and it is
 * **age-gated**: a concurrent run's directories are minutes old and are never
 * touched, which matters because this repository is regularly worked on from
 * more than one worktree at once.
 */

/**
 * Free memory the suite refuses to start below.
 *
 * Measured on win32, node v20.16.0, sampling every 8 s through a full
 * `npm run test:coverage`: **peak 31 node processes holding 1 986 MB in total**,
 * largest single process 162 MB, and free memory never dropping below 1.43 GB.
 * So the suite's own appetite is about 2 GB.
 *
 * The floor is set at 1 GB rather than 2: the observed death zone was
 * 0.11–0.37 GB free and the observed healthy start was 1.4 GB and up, so 1 GB
 * sits below every run that has actually worked and above every run that has
 * actually died. It is deliberately not tuned finer than the evidence supports.
 */
export const MIN_FREE_BYTES = 1_000_000_000

/**
 * How stale a leftover directory must be before the sweep will remove it.
 *
 * Two hours against a 30 s per-test timeout: a directory belonging to a run
 * happening right now cannot be anywhere near this old, so a second worktree
 * running its own suite is safe by a factor of hundreds. The sweep is a
 * courtesy, not a correctness mechanism, and it is sized to never be the reason
 * another run fails.
 */
export const SWEEP_OLDER_THAN_MS = 2 * 60 * 60 * 1000

/** The prefix every temp directory in this suite is created under. */
const PREFIX = 'eph-'

/** Contract: pure. The sentence an Architect reads when the machine is too full. */
export function headroomRefusal(freeBytes: number, totalBytes: number): string {
  const gb = (bytes: number): string => (bytes / 1e9).toFixed(2)
  return [
    `Not enough free memory to run this suite: ${gb(freeBytes)} GB free of ${gb(totalBytes)} GB.`,
    `It needs about 2 GB (measured: 31 worker processes holding 1 986 MB at peak),`,
    `and below roughly ${gb(MIN_FREE_BYTES)} GB vitest's forks die mid-run.`,
    ``,
    `That failure does NOT look like a memory problem from the outside — it looks`,
    `like a few dozen unrelated tests failing, a different set every run, and no`,
    `coverage report at the end. Refusing here rather than letting you read that`,
    `as a regression.`,
    ``,
    `Close something and run again.`
  ].join('\n')
}

/** Contract: throws with `headroomRefusal` when the machine is too full. */
export function requireHeadroom(free: number = os.freemem(), total: number = os.totalmem()): void {
  if (free >= MIN_FREE_BYTES) return
  throw new Error(headroomRefusal(free, total))
}

/**
 * Contract: removes `eph-*` directories in the system temp dir older than
 * `olderThanMs`. Returns how many it removed. Never throws — a directory the
 * sweep cannot remove is left where it is, because tidying is not worth failing
 * a suite over, and the next sweep will try again.
 */
export function sweepStaleTempDirs(
  now: number = Date.now(),
  olderThanMs: number = SWEEP_OLDER_THAN_MS,
  root: string = os.tmpdir()
): number {
  let removed = 0
  let names: readonly string[]
  try {
    names = fs.readdirSync(root)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!name.startsWith(PREFIX)) continue
    const dir = path.join(root, name)
    try {
      const stat = fs.statSync(dir)
      if (!stat.isDirectory()) continue
      if (now - stat.mtimeMs < olderThanMs) continue
      fs.rmSync(dir, { recursive: true, force: true })
      removed += 1
    } catch {
      // Held by something, or gone already. Either way it is not this suite's
      // problem to solve, and a sweep that failed a run would be worse than the
      // residue it was cleaning.
    }
  }
  return removed
}

export default function globalSetup(): void {
  requireHeadroom()
  const removed = sweepStaleTempDirs()
  if (removed > 0) {
    // Said out loud, because silent housekeeping that deletes things is exactly
    // what nobody can audit later.
    console.log(`[suite] swept ${String(removed)} stale eph-* temp directories`)
  }
}

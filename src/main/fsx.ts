import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * How long a blocked rename is retried before the write is called lost.
 *
 * Bounded deliberately, and bounded small. This blocks the main process — there
 * is no asynchronous version of an atomic write here, and callers on the
 * delivery path are synchronous — so the ceiling is a trade between two bad
 * outcomes: a stall long enough to be felt, and a write that is simply thrown
 * away. NFR-2 gives delivery a p95 of 500 ms, and a transient is far rarer than
 * one delivery in twenty, so half a second buys the retry without putting the
 * budget at risk in the normal case.
 */
export const ATOMIC_RENAME_BUDGET_MS = 500

/**
 * What Windows reports when something is briefly holding the destination.
 *
 * Measured rather than guessed: an open read handle on the destination file —
 * which is all a virus scanner or a search indexer is — makes `renameSync` fail
 * with `EPERM`, and the destination keeps its OLD contents. So the failure is
 * not cosmetic; the write is lost.
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * Blocks this thread for `ms`. `writeFileAtomic` is synchronous by contract, so
 * there is nowhere to yield to; `Atomics.wait` is the one way to wait without
 * spinning the CPU.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * Renames the temp file over the target, waiting out a destination that is
 * briefly held.
 *
 * Windows overloads `EPERM`: it is what a transient hold reports, and it is
 * ALSO what renaming a file over a DIRECTORY reports — measured, for both an
 * empty and a non-empty one. The second is permanent and a caller bug, so the
 * destination is checked before waiting on it. Without that, a mistake would
 * spend the whole budget before failing, and would fail with a worse story
 * than the one it could have told immediately.
 *
 * Other permanent `EPERM`s exist — a read-only destination is the obvious one —
 * and those do spend the budget before throwing. That is a bounded cost on a
 * path this harness does not take, and it is preferred to guessing at more
 * causes than have actually been observed.
 */
function renameOntoTarget(tmp: string, filePath: string): void {
  const startedAt = Date.now()
  let wait = 5
  for (;;) {
    try {
      fs.renameSync(tmp, filePath)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (!TRANSIENT_RENAME_CODES.has(code)) throw err
      if (isDirectory(filePath)) throw err
      if (Date.now() - startedAt >= ATOMIC_RENAME_BUDGET_MS) throw err
      sleepSync(wait)
      wait = Math.min(wait * 2, 100)
    }
  }
}

/**
 * Atomic file write: temp file in the same directory + rename (BUILD-PROMPT §3.3).
 * A bare writeFile onto a live path is a bug by invariant — every file another
 * process may read goes through here. rename() replaces existing targets on all
 * supported platforms (MOVEFILE_REPLACE_EXISTING semantics on Windows).
 *
 * The rename is retried, because on Windows it can fail for a reason that has
 * nothing to do with this program: anything holding the destination open for a
 * moment makes it `EPERM`. Unretried, that threw the write away — a lost cursor
 * write, a lost registry entry, a lost message — and surfaced as a degradation
 * rather than as the transient it was. A retry that is bounded and then still
 * throws keeps the failure honest while not losing work to a scanner.
 */
export function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
  options: { readonly mode?: number } = {}
): void {
  const dir = path.dirname(filePath)
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`)
  // A Buffer is written verbatim: restoring a backed-up settings file must not
  // re-encode it (ADR-0009 uninstall restores byte-for-byte).
  // `mode` is applied to the TEMP file, before the rename: a secret store that
  // is world-readable for even the width of a chmod is a leak (ADR-0010).
  const write = options.mode === undefined ? {} : { mode: options.mode }
  if (typeof data === 'string') fs.writeFileSync(tmp, data, { encoding: 'utf8', ...write })
  else fs.writeFileSync(tmp, data, write)
  try {
    renameOntoTarget(tmp, filePath)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

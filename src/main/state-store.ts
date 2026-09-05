import fs from 'node:fs'
import path from 'node:path'
import type { z } from 'zod'
import { writeFileAtomic } from './fsx'

/**
 * App-local durable state, for the maps that must survive a restart (M8.8).
 *
 * Five subsystems each need the same small thing: one JSON file under the
 * harness home, written atomically, validated on the way in, and never
 * silently treated as empty when it is damaged. Writing that five times would
 * be five chances to get the damaged case subtly different — and the damaged
 * case is the only one that matters, because the healthy one is what every
 * test writes first.
 *
 * `FileBreakerStopStore` (M8.6) is the precedent this generalises, and it is
 * deliberately NOT migrated here: its `load` throws by design, because a
 * breaker stop that cannot be read must block every start rather than degrade,
 * and that is a safety contract this class does not offer. Recorded so the
 * duplication is a decision rather than an oversight.
 *
 * Contract of `load`: it NEVER throws. The restore path runs at boot, before
 * the window exists, and a throw there is a dead app rather than a degraded
 * one (FR-5.4). The three outcomes are distinguished because their
 * consequences differ, and callers must be able to tell them apart:
 *
 * - the file is absent  → `{ ok: true, value: empty, seeded: false }`
 * - the file parses     → `{ ok: true, value, seeded: true }`
 * - the file is damaged → `{ ok: false, because }`
 *
 * "Absent" and "damaged" are the pair that must never collapse into each
 * other. Absent is the ordinary first run. Damaged means state exists that we
 * can no longer read, and every caller in M8.8 has a different, disclosed
 * response to that — see the failure table in the implementation doc.
 */

export type StateLoad<T> =
  | { readonly ok: true; readonly value: T; readonly seeded: boolean }
  | { readonly ok: false; readonly because: string }

export type StateSave = { readonly ok: true } | { readonly ok: false; readonly because: string }

export interface StateStore<T> {
  load(): StateLoad<T>
  save(value: T): StateSave
}

export interface JsonStateStoreOptions<T> {
  /** Absolute path to the file. Its directory is created on write. */
  readonly file: string
  /**
   * Validates the whole record, `schemaVersion` included. The schema owns the
   * version literal, so an unsupported version fails as a parse rather than
   * needing a second check nobody remembers to write.
   */
  readonly schema: z.ZodType<T>
  /** What "the file is not there yet" means. Not derived — stated. */
  readonly empty: T
}

export class JsonStateStore<T> implements StateStore<T> {
  constructor(private readonly options: JsonStateStoreOptions<T>) {}

  load(): StateLoad<T> {
    let text: string
    try {
      text = fs.readFileSync(this.options.file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: true, value: this.options.empty, seeded: false }
      }
      return { ok: false, because: describe(err) }
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (err) {
      return { ok: false, because: `not JSON: ${describe(err)}` }
    }
    const parsed = this.options.schema.safeParse(json)
    if (!parsed.success) {
      return { ok: false, because: parsed.error.issues.map(issue).join('; ') }
    }
    return { ok: true, value: parsed.data, seeded: true }
  }

  /**
   * Contract: validates BEFORE writing, so a bug in a caller cannot put a
   * record on disk that the next boot will refuse to read. A store that can
   * write what it cannot load is a restart failure with a one-boot delay.
   */
  save(value: T): StateSave {
    const parsed = this.options.schema.safeParse(value)
    if (!parsed.success) {
      return { ok: false, because: parsed.error.issues.map(issue).join('; ') }
    }
    try {
      fs.mkdirSync(path.dirname(this.options.file), { recursive: true })
      writeFileAtomic(this.options.file, `${JSON.stringify(parsed.data, null, 2)}\n`)
    } catch (err) {
      return { ok: false, because: describe(err) }
    }
    return { ok: true }
  }
}

function issue(entry: z.core.$ZodIssue): string {
  const at = entry.path.length > 0 ? entry.path.join('.') : '(root)'
  return `${at}: ${entry.message}`
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

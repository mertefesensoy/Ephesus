import { z } from 'zod'

/**
 * The event log (`agora/log.jsonl`, SDD §4.3) — "the company's book of record".
 *
 * NFR-13 sets the bar: *every autonomous action must be reconstructible from
 * `log.jsonl` alone*. The activity UI, the briefing compiler, per-agent metrics
 * and incident forensics all read this file and nothing else, so an entry that
 * omits the ids needed to find what it describes has failed at its only job.
 *
 * Two shapes on purpose:
 *  - the **envelope** (`ts`, `seq`, `kind`) is fixed and validated;
 *  - the **refs** are open, because each kind carries different ones and §4.3
 *    lists twenty kinds that arrive over six milestones. A closed schema here
 *    would mean editing this file every time a subsystem lands — and rejecting
 *    an event because a later milestone added a field would be losing the book
 *    of record to protect its formatting.
 */

/** SDD §4.3 kinds, verbatim. */
export const LOG_KINDS = [
  'message',
  'delivery',
  'bounce',
  'spawn',
  'exit',
  'ghost',
  'hook',
  'task',
  'gate',
  'memo',
  'brief',
  'deck',
  'meeting',
  'breaker',
  'budget',
  /** Artemis's lifecycle and her countersigned decisions (FR-5.4, FR-5.5). */
  'orchestrator',
  'remote',
  'secret-rotated',
  'profile',
  'gym',
  /** Closing time (GYM-003): begin / ack / complete, with the shortfall named. */
  'shutdown',
  'error'
] as const

export const logKindSchema = z.enum(LOG_KINDS)

export type LogKind = z.infer<typeof logKindSchema>

export const logEntrySchema = z.looseObject({
  /** Epoch milliseconds. */
  ts: z.number().int().nonnegative(),
  /** Monotonic within a log file; the cursor consumers page by. */
  seq: z.number().int().nonnegative(),
  kind: logKindSchema
})

export type LogEntry = z.infer<typeof logEntrySchema>

/** What a caller supplies; the appender stamps `ts` and `seq`. */
export type LogEntryDraft = { readonly kind: LogKind } & Record<string, unknown>

/**
 * Contract: parses one line. Returns null for anything unreadable — a torn
 * final line from a killed harness, or an entry from a future schema — because
 * a reader's job is to read what is there, never to repair the file. Repairing
 * would be a rewrite, and this file is append-only (invariant §5).
 */
export function parseLogLine(line: string): LogEntry | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  try {
    const parsed = logEntrySchema.safeParse(JSON.parse(trimmed))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Contract: serialises one entry as a single line with no interior newline, so
 * a line is always exactly one event. Throws on an entry that cannot be
 * serialised — silently dropping an event would defeat NFR-13.
 */
export function formatLogLine(entry: LogEntry): string {
  const line = JSON.stringify(entry)
  if (line.includes('\n')) throw new Error('log: serialised entry contains a newline')
  return `${line}\n`
}

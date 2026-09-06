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
  /** The Library's events (SDD §4.3, Architect-ratified at the M4 close).
   *  Listed since M4 but omitted here until the M5 close-out audit — nothing
   *  emits it yet; its first emitter documents its refs. */
  'memory',
  /** Artemis's lifecycle and her countersigned decisions (FR-5.4, FR-5.5). */
  'orchestrator',
  'remote',
  'secret-rotated',
  'profile',
  'gym',
  /** The Stoa's research cycle (SDD §7.7, ADR-0017): study, brief, watchlist.
   *  Listed with §4.3 at the M5 close-out; first emitted by M5b.2. */
  'stoa',
  /** Closing time (GYM-003): begin / ack / complete, with the shortfall named. */
  'shutdown',
  /**
   * Provider capacity (`src/shared/capacity.ts`): parked / resuming / cleared.
   *
   * Its own kind rather than a `breaker` or an `exit`, because it is neither.
   * `breaker` is OUR ladder against an agent that is misbehaving; `exit` is a
   * process that ended. A capacity park is a healthy agent that the provider
   * declined to serve, and a forensic reader who cannot tell those three apart
   * cannot reconstruct what the company did (NFR-13).
   */
  'capacity',
  /**
   * The harness bringing an agent back (M8.6, B12): the ladder's rungs, the
   * attempt, the refusal, the give-up.
   *
   * Its own kind rather than another `spawn`, because the question a reader
   * actually asks of it is "did the company survive the night", and that query
   * has to be answerable from the log alone. It was answerable before this
   * kind existed only for the orchestrator, under `orchestrator` — which is
   * how the register could say "46 respawn-scheduled rows, all Artemis, zero
   * crew" and be sure. A crew ladder folded into `orchestrator` would have
   * made that same question unanswerable ever again.
   */
  'respawn',
  'error',
  /**
   * A condition the company is running under, not an event that happened
   * (M8.2, Architect decision 2026-09-03). Carries `source`, a stable
   * `cause`, the latest `detail`, the `count` the row accounts for and
   * `since`; the row with `event: 'cleared'` says it ended and for how
   * long. Deliberately not `error`: "delivery threw" happened once, "recall
   * is on the grep rung" is still true, and only the second can be cleared.
   * See `src/shared/degradation.ts`.
   */
  'degradation'
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

/**
 * Contract: the one line the Activity panel puts in front of a human for one
 * entry, and never an empty one (M8.3).
 *
 * ## Why this is here and not in the panel
 *
 * It is a projection of the book of record, it needs no DOM, and it has to be
 * TOTAL over `LOG_KINDS`. Putting it beside the kind list means the next person
 * adding a kind sees the row it will render, and the switch below has no
 * `default`: a new kind is a compile error rather than a blank line nobody
 * notices. The panel's old version had seven cases and a `default` that reached
 * for `agentId` or `subject`, so 19% of rows on this machine rendered empty —
 * and the breaker's case read `signal` where every emitter writes `signals`,
 * which blanked the reason on all 93 of them.
 *
 * ## Why it cannot return an empty string
 *
 * Per-kind wording is for readability; the fallback is for truth. If a kind's
 * chosen fields are all absent — an entry from an older version, or an emitter
 * that changed — the line falls back to the entry's own remaining fields rather
 * than rendering nothing. A blank row is a lie about the book of record: the
 * event happened, and the panel is supposed to be a pointer to it (NFR-13).
 */
export function logRowSummary(entry: LogEntry): string {
  const line = kindParts(entry)
    .filter((part) => part.length > 0)
    .join(' · ')
  if (line.length > 0) return line
  const other = otherFields(entry)
  if (other.length > 0) return other
  // The guarantee, now enforced rather than stated: a row in the book of
  // record never renders as a blank line. `otherFields` skips ts/seq/kind
  // and drops object-valued fields, so a row carrying nothing else — an
  // older format, a hand-edit, a future kind whose payload is a nested
  // object — reached the Activity panel as an empty row. That IS B3, the
  // defect this module was written to close, arriving from disk instead of
  // from a misspelt field name.
  return `${entry.kind} #${String(entry.seq)}`
}

/** A string, number or boolean field, or '' when absent or of another shape. */
function ref(entry: LogEntry, name: string): string {
  const value = entry[name]
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/**
 * `label value`, or '' when there is no value.
 *
 * A bare label is worse than a blank part, because the row still LOOKS
 * populated — which is the failure this module already carries a comment
 * about: reading `signal` for `signals` left the breaker row rendering while
 * saying nothing. `exit ` and `rung ` were doing the same thing on any row
 * missing that field, and they were the two sites here that guarded the value
 * ad hoc or not at all while their five siblings each did it differently.
 * One helper, so the next label cannot be the one somebody forgot.
 */
function labelled(label: string, value: string): string {
  return value.length > 0 ? `${label} ${value}` : ''
}

/** A list field (`signals`, `acked`, `attendees`), joined; '' when absent. */
function list(entry: LogEntry, name: string): string {
  const value = entry[name]
  if (!Array.isArray(value)) return ''
  return value
    .map((item) => (typeof item === 'string' || typeof item === 'number' ? String(item) : ''))
    .filter((item) => item.length > 0)
    .join(', ')
}

/** `a → b` when both sides are present, else whichever one is. */
function flow(entry: LogEntry): string {
  const from = ref(entry, 'from')
  const to = ref(entry, 'to')
  if (from.length > 0 && to.length > 0) return `${from} → ${to}`
  return from.length > 0 ? from : to
}

/**
 * Everything the entry carries beyond its envelope, for the fallback. Bounded
 * so one enormous field cannot push the whole panel sideways.
 */
function otherFields(entry: LogEntry): string {
  const skip = new Set(['ts', 'seq', 'kind'])
  const parts: string[] = []
  for (const [key, value] of Object.entries(entry)) {
    if (skip.has(key)) continue
    const rendered =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : Array.isArray(value)
          ? value.join(', ')
          : ''
    if (rendered.length === 0) continue
    parts.push(`${key} ${rendered.slice(0, 120)}`)
    if (parts.length === 4) break
  }
  return parts.join(' · ')
}

/**
 * The refs worth showing per kind (SDD §4.3). No `default`: the `never` check
 * at the end makes a new kind fail the build here, where its row is decided.
 */
function kindParts(entry: LogEntry): readonly string[] {
  const at = (name: string): string => ref(entry, name)
  const acked = list(entry, 'acked')
  const missing = list(entry, 'missing')
  switch (entry.kind) {
    case 'message':
      return [flow(entry), at('act'), at('subject')]
    case 'delivery':
      return [flow(entry), at('act'), at('subject')]
    case 'bounce':
      return [flow(entry), at('reason'), labelled('diverted to', at('divertedTo'))]
    case 'spawn':
      return [at('agentId'), `${at('engine')} ${at('engineVersion')}`.trim(), at('role')]
    case 'exit':
      return [at('agentId'), at('engine'), labelled('exit', at('exitCode'))]
    case 'ghost':
      return [at('agentId'), at('engine'), labelled('resumable', at('resumable'))]
    case 'hook':
      return [at('agentId'), at('event'), at('decision'), at('because')]
    case 'task':
      return [at('event'), at('taskId'), at('assignee') || at('by'), at('because')]
    case 'gate':
      return [at('event'), at('gateKind'), at('what') || at('gateId'), at('agentId')]
    case 'memo':
      return [at('event'), at('under') || at('trigger'), at('by'), at('because')]
    case 'brief':
      return [
        at('event'),
        at('briefId'),
        at('by'),
        at('sentences') && `${at('sentences')} sentences`
      ]
    case 'deck':
      return [at('event'), at('taskId'), at('deckRef'), at('by')]
    case 'meeting':
      return [at('event'), at('meetingId'), list(entry, 'attendees'), at('minutesRef')]
    case 'breaker':
      // `signals`, plural and an array — the emitter has always written it that
      // way, and reading `signal` blanked the reason on every breaker row.
      return [at('agentId'), at('action'), list(entry, 'signals'), labelled('rung', at('rung'))]
    case 'budget':
      return [at('agentId'), at('event') || at('state'), at('because'), at('spent')]
    case 'memory':
      return [at('agentId'), at('event'), at('because')]
    case 'orchestrator':
      return [at('event'), at('agentId'), at('engine'), at('because') || at('under')]
    case 'remote':
      return [at('event'), at('repo') || at('target'), at('by') || at('from'), at('because')]
    case 'secret-rotated':
      // The NAME, never the value — the broker is write-only (ADR-0010).
      return [at('name'), at('removed') === 'true' ? 'removed' : 'set']
    case 'profile':
      return [at('event'), at('profile'), at('repo') || at('ref'), at('because')]
    case 'gym':
      return [at('event'), at('gymId'), at('title') || at('class'), at('by')]
    case 'stoa':
      return [at('event'), at('sourceId') || at('briefId'), at('url') || at('pin'), at('by')]
    case 'shutdown':
      return [at('event'), at('agentId'), labelled('acked', acked), labelled('silent', missing)]
    case 'capacity':
      return [at('event'), at('agentId'), at('limitKind'), at('detail')]
    case 'respawn':
      // The rung is the fact worth reading at a glance: an agent on attempt 3
      // of 3 is one the Architect is about to lose (M8.6).
      return [
        at('event'),
        at('agentId'),
        labelled('attempt', at('attempt')),
        at('because') || at('waitMs')
      ]
    case 'error':
      return [at('subsystem'), at('file'), at('reason')]
    case 'degradation':
      return [
        at('source'),
        at('detail'),
        at('count') !== '' && at('count') !== '1' ? `×${at('count')}` : '',
        at('event') === 'cleared' ? 'cleared' : ''
      ]
  }
  // A kind with no case above cannot reach here; the compiler says so.
  const exhaustive: never = entry.kind
  return [String(exhaustive)]
}

import { z } from 'zod'

/**
 * Degradations — the model behind invariant §7 (M8.2).
 *
 * "Fail loud, degrade visible" has been the rule since M0, and until now the
 * implementation was a `console.warn` plus a fifty-entry in-memory ring shown
 * in one tooltip. That is not a visible state: it never reached `log.jsonl`, so
 * nothing could reconstruct a night from the record; it vanished at restart, so
 * every morning looked healthy whatever the company was missing; and it was
 * keyed by nothing, so the pacing check — which reports the same fact about
 * once a second — evicted every other entry within a minute. A first-time user
 * could not see why anything had failed, which is why the M8 plan puts this
 * package before the rest.
 *
 * ## A degradation is a state, not an event
 *
 * That distinction is why it gets its own log kind rather than joining `error`
 * (SDD §4.3, amended at M8.2 by Architect decision). "Delivery threw" is an
 * event that happened once. "Recall is on the grep rung because there is no
 * index" is a condition the company is running under, and the questions asked
 * of it are different: when did it start, is it still true, how often, and did
 * it ever clear. Those answers need a stable identity, which is what `cause`
 * is.
 *
 * ## Dedupe by CAUSE, never by text
 *
 * The pacing line reads `company pacing slow: 5h window at 82%`, and the
 * percentage changes on every tick. Keying on the message would therefore
 * defeat the dedupe completely while looking like it worked — the exact trap
 * the package plan warns about. So every report carries a cause: a short,
 * stable slug naming the CONDITION, chosen at the call site because only the
 * call site knows which of a subsystem's problems this is.
 */

/**
 * Who is degraded. A closed vocabulary so a typo is a compile error rather than
 * a second entry for the same subsystem, and so the UI can group by it.
 */
export const DEGRADATION_SOURCES = [
  'agents',
  'agora',
  'artemis',
  'autonomy',
  'breaker',
  'budgets',
  'capacity',
  'engines',
  'gates',
  'harbor',
  'hermes',
  'hooks',
  // The harness home and the config files it owns (M8.4).
  'home',
  'incident',
  'ledger',
  'library',
  'odeon',
  'profiles',
  'renderer',
  'scheduler',
  'secrets',
  'settings',
  'shutdown',
  'usage'
] as const

export const degradationSourceSchema = z.enum(DEGRADATION_SOURCES)
export type DegradationSource = z.infer<typeof degradationSourceSchema>

/**
 * The stable identity of one condition, `<source>/<slug>`.
 *
 * Deliberately a template type rather than a free string: it cannot be built
 * from a source that does not exist, and it reads at the call site as the thing
 * it identifies (`'library/recall-rung'`, `'usage/pacing'`).
 */
export type DegradationCause = `${DegradationSource}/${string}`

/** How the Architect should read an entry that has not been re-observed. */
export type DegradationFreshness =
  /** Reported by this session. */
  | 'live'
  /**
   * Replayed from the log at boot: it was true when we stopped and nothing has
   * re-checked it since. Never shown as though it were current — the whole
   * point of B2 is that an empty list every morning hides a week-old problem.
   */
  | 'carried'

/** One condition, as the UI and the tests see it. */
export interface DegradationEntry {
  readonly source: DegradationSource
  readonly cause: DegradationCause
  /** The most recent wording; the cause, not this, is the identity. */
  readonly detail: string
  /** How many times it has been reported, this session and replayed. */
  readonly count: number
  /** Epoch ms of the first report. */
  readonly since: number
  /** Epoch ms of the most recent report. */
  readonly lastSeen: number
  readonly freshness: DegradationFreshness
}

/** The log row (`kind: 'degradation'`, SDD §4.3). */
export const degradationRowSchema = z.object({
  kind: z.literal('degradation'),
  source: degradationSourceSchema,
  cause: z.string().min(3),
  detail: z.string(),
  /** How many reports this row accounts for; 1 on the first. */
  count: z.number().int().positive(),
  /** Epoch ms of the first report of this cause in this run. */
  since: z.number().int().nonnegative(),
  /** Present only on the row that says the condition ended. */
  event: z.literal('cleared').optional(),
  /** How long it lasted, on the `cleared` row. */
  forMs: z.number().int().nonnegative().optional()
})

export type DegradationRow = z.infer<typeof degradationRowSchema>

/**
 * Contract: parses a log entry as a degradation row, or null. Used by the boot
 * replay, which reads a file written by an older version of this app and must
 * simply skip anything it does not recognise (the log is append-only: a reader
 * repairs nothing).
 */
export function parseDegradationRow(entry: unknown): DegradationRow | null {
  const parsed = degradationRowSchema.safeParse(entry)
  return parsed.success ? parsed.data : null
}

/**
 * Contract: the subsystem a cause belongs to — its prefix.
 *
 * The source is DERIVED rather than passed beside the cause, so the two can
 * never disagree. `DegradationCause` is a template type over the closed source
 * list, so a cause that reaches here always has a valid prefix.
 */
export function sourceOf(cause: DegradationCause): DegradationSource {
  return cause.slice(0, cause.indexOf('/')) as DegradationSource
}

/**
 * Does an occurrence at this count earn a line in the book of record?
 *
 * The ladder is 1, 10, 100, 1000, … — the first occurrence lands immediately,
 * then each power of ten. A condition that lasts an hour at one report a second
 * costs five lines instead of 3,600, and those five say what a reader actually
 * wants to know: it started, it is still going, it is *really* still going.
 *
 * Nothing is ever rewritten to achieve that: append-only (invariant §5) is
 * untouched, there are simply fewer and more informative appends. The live
 * count is always exact in the UI, which reads the ring rather than the log.
 */
export function earnsLogLine(count: number): boolean {
  if (count < 1) return false
  if (count === 1) return true
  let rung = 10
  while (rung <= count) {
    if (rung === count) return true
    rung *= 10
  }
  return false
}

/**
 * Contract: the one line the Architect reads for one condition.
 *
 * Lives here rather than in the renderer because it is a projection of the
 * model and nothing about it needs a DOM — which also means it can be asserted
 * without one. Two facts the old line could not carry: how often the condition
 * is being reported, so a one-off reads differently from something happening
 * every second; and whether it was carried over from before this session, so a
 * week-old problem is neither presented as fresh nor quietly dropped.
 */
export function degradationLine(entry: {
  readonly source: string
  readonly detail: string
  readonly count: number
  readonly freshness: DegradationFreshness
}): string {
  const times = entry.count > 1 ? ` (×${String(entry.count)})` : ''
  const carried = entry.freshness === 'carried' ? ' — last seen before this session' : ''
  return `${entry.source}: ${entry.detail}${times}${carried}`
}

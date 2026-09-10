import type { LogEntry } from './log'

/**
 * What the Architect sees of the incident path (B14, FR-9.2, UC-09, SDD §7.5).
 *
 * ## Derived, not held — and the ADR had already decided it
 *
 * `IncidentEndpoint` reaches the world only through `onLogEvent`, so a surface
 * must either fold `log.jsonl` or gain a store of its own. ADR-0027's test is
 * *is this held, or derived?*, and its §5 answers this exact case by name:
 * incident correlation is deliberately NOT persisted, because a restart SHOULD
 * re-raise a still-failing incident. Its closing line rules out the
 * alternative — *do not persist state that a live subsystem re-derives from a
 * durable source*. Every incident fact is already in the book of record,
 * verbatim and append-only, so a second record would be a second truth for
 * facts that already have one.
 *
 * This module is therefore a **fold** and nothing else: pure, total, and with
 * no opinion the log does not already carry. It never grades an incident, never
 * infers a severity, and never rewrites an agent's sentence — the same
 * restraint `incident.ts` keeps one layer down.
 *
 * ## What it is FOR, which is not a list
 *
 * On the Architect's machine: 21 triage attempts, **12 refused**; 3 root-cause
 * verifications asked, **3 refused**, and not one verdict ever recorded. All of
 * that was in the log the whole time and none of it was anywhere a person would
 * look. A surface that showed only the incidents that went well would have been
 * an improvement on nothing and still would not have shown this.
 *
 * So a refusal renders **as a refusal**, never as an absence, and that governs
 * two decisions here that look like edge cases and are the point:
 *
 *  - A refusal whose incident is unknown goes in its own list rather than being
 *    dropped. A parse failure is exactly the case where the key is unknowable,
 *    and dropping those would make the panel report FEWER refusals than
 *    happened — the absence it exists to replace. Attaching them to a guessed
 *    incident would be worse: a refusal filed against the wrong incident is a
 *    fact nobody can correct.
 *  - An incident whose root cause was never checked says so. "Nobody verified
 *    this diagnosis" is a fact about the record and invariant §7 makes it
 *    visible, exactly as the endpoint already logs it.
 */

/** Where an incident has got to. Ordered by how far along the path it is. */
export type IncidentStage =
  /** Raised; nobody has filed a usable triage report yet. */
  | 'awaiting-triage'
  /** Triaged, and its root cause is with a verifier. */
  | 'verifying'
  /** Triaged and settled, for whatever value of settled the report claimed. */
  | 'triaged'

/** One refusal the harbor sent back, as the log recorded it. */
export interface IncidentRefusal {
  /** `triage` or `verdict` — which of the endpoint's two readers refused. */
  readonly of: 'triage' | 'verdict'
  readonly from: string
  readonly reasons: readonly string[]
  readonly at: number
  readonly seq: number
}

/** An answer that was not a report: "I cannot" or "I am on it". */
export interface IncidentAside {
  readonly act: 'declined' | 'accepted'
  readonly from: string
  readonly because: string
  readonly at: number
}

/** The independent reading of a root cause, or why there was not one. */
export interface IncidentVerification {
  readonly verifier: string
  readonly claim: string
  /** Null while the verifier has been asked and has not answered. */
  readonly verdict: 'agree' | 'refute' | 'cannot-tell' | null
  /** The verifier's own words, carried verbatim; null until they answer. */
  readonly because: string | null
  /** `file:line` for each line the verifier says it opened. */
  readonly read: readonly string[]
}

export interface IncidentRow {
  /** `<repo>#<kind>:<ref>` — the key every row in the log agrees on. */
  readonly key: string
  readonly instanceId: string | null
  readonly repo: string
  readonly ref: number
  readonly conclusion: string
  /** The agent the active profile put on call when this was raised. */
  readonly oncall: string
  readonly playbook: string
  readonly raisedAt: number
  readonly stage: IncidentStage
  /** The severity the AGENT reported; null while nobody has triaged it. */
  readonly severity: number | null
  /** The agent's own summary sentence, verbatim; null until triaged. */
  readonly summary: string | null
  readonly resolved: boolean | null
  readonly triagedBy: string | null
  readonly verification: IncidentVerification | null
  /** Why nobody checked the root cause, when nobody did. */
  readonly unverifiedBecause: string | null
  /** Escalations this incident is OWED and the harness could not deliver. */
  readonly owed: readonly string[]
  readonly refusals: readonly IncidentRefusal[]
  readonly asides: readonly IncidentAside[]
}

/** A CI failure no live profile instance claimed. */
export interface UnclaimedIncident {
  readonly repo: string
  readonly ref: number
  readonly because: string
  readonly at: number
}

export interface IncidentBoard {
  /** Newest first — a live view of a book of record opens at the end (M8.3). */
  readonly incidents: readonly IncidentRow[]
  readonly unclaimed: readonly UnclaimedIncident[]
  /**
   * Refusals the log does not tie to any incident.
   *
   * Not a leftovers bin. The parse-failure path is exactly where the key is
   * unknowable, so this is where the loudest instance of the defect this panel
   * exists for actually lands.
   */
  readonly unattributedRefusals: readonly IncidentRefusal[]
}

/** Reads a string field off a loose log row, or null when it is not one. */
function str(row: LogEntry, field: string): string | null {
  const value: unknown = (row as unknown as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : null
}

function num(row: LogEntry, field: string): number | null {
  const value: unknown = (row as unknown as Record<string, unknown>)[field]
  return typeof value === 'number' ? value : null
}

function bool(row: LogEntry, field: string): boolean | null {
  const value: unknown = (row as unknown as Record<string, unknown>)[field]
  return typeof value === 'boolean' ? value : null
}

function strings(row: LogEntry, field: string): readonly string[] {
  const value: unknown = (row as unknown as Record<string, unknown>)[field]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/** The mutable shape the fold builds before it is frozen into an `IncidentRow`. */
interface Building {
  key: string
  instanceId: string | null
  repo: string
  ref: number
  conclusion: string
  oncall: string
  playbook: string
  raisedAt: number
  severity: number | null
  summary: string | null
  resolved: boolean | null
  triagedBy: string | null
  verification: IncidentVerification | null
  unverifiedBecause: string | null
  owed: string[]
  refusals: IncidentRefusal[]
  asides: IncidentAside[]
}

function stageOf(row: Building): IncidentStage {
  if (row.triagedBy === null) return 'awaiting-triage'
  if (row.verification !== null && row.verification.verdict === null) return 'verifying'
  return 'triaged'
}

/** Contract: pure. The `incident-` rows of the book of record, in log order. */
function incidentRows(entries: readonly LogEntry[]): readonly (readonly [LogEntry, string])[] {
  const rows: (readonly [LogEntry, string])[] = []
  for (const row of entries) {
    if (row.kind !== 'profile') continue
    const event = str(row, 'event')
    if (event === null || !event.startsWith('incident-')) continue
    rows.push([row, event])
  }
  return rows
}

/**
 * Contract: pure and total. Folds the book of record into what the panel shows.
 *
 * Two passes, and the second one is why: every incident is OPENED before
 * anything is filed against it, so a single pass would put a refusal in the
 * unattributed list purely because its `raised` row had not been reached yet.
 * The log is append-only and read oldest-first, so a single pass happens to be
 * right today — and "happens to be right given the order it is called with" is
 * exactly the coupling that turns a reader into a bug the first time someone
 * pages backwards. Order is now irrelevant by construction.
 *
 * Unknown event names, and rows missing the fields this needs, are SKIPPED
 * rather than defaulted — a reader's job is to read what is there, the same
 * rule `parseLogLine` keeps one level down. An incident whose `raised` row has
 * been rotated away therefore does not appear as an incident at all, and its
 * refusals surface as unattributed: the panel cannot show a repository and a
 * run number it has never seen, and it does not invent them.
 */
export function foldIncidents(entries: readonly LogEntry[]): IncidentBoard {
  const rows = incidentRows(entries)
  const byKey = new Map<string, Building>()
  const unclaimed: UnclaimedIncident[] = []
  const unattributed: IncidentRefusal[] = []

  const refusalFrom = (row: LogEntry, of: 'triage' | 'verdict'): IncidentRefusal => ({
    of,
    from: str(row, 'from') ?? 'unknown',
    reasons: strings(row, 'reasons'),
    at: row.ts,
    seq: row.seq
  })

  // Pass one: open a row for every incident that was ever raised.
  for (const [row, event] of rows) {
    if (event !== 'incident-raised') continue
    const key = str(row, 'incident')
    const repo = str(row, 'repo')
    const ref = num(row, 'ref')
    if (key === null || repo === null || ref === null) continue
    // A re-raise after a restart is the SAME incident, by recorded decision
    // (ADR-0027 §5). What this guard actually protects is `raisedAt`: the map
    // is keyed, so a second `set` would still leave ONE row — it would just
    // restamp a build that has been failing since Monday as raised this
    // morning, and move it in a list ordered newest first.
    if (byKey.has(key)) continue
    byKey.set(key, {
      key,
      instanceId: str(row, 'instanceId'),
      repo,
      ref,
      conclusion: str(row, 'conclusion') ?? 'unknown',
      oncall: str(row, 'oncall') ?? 'unknown',
      playbook: str(row, 'playbook') ?? 'unknown',
      raisedAt: row.ts,
      severity: null,
      summary: null,
      resolved: null,
      triagedBy: null,
      verification: null,
      unverifiedBecause: null,
      owed: [],
      refusals: [],
      asides: []
    })
  }

  // Pass two: everything that happened to them.
  for (const [row, event] of rows) {
    const key = str(row, 'incident')

    if (event === 'incident-unclaimed') {
      const repo = str(row, 'repo')
      const ref = num(row, 'ref')
      if (repo === null || ref === null) continue
      unclaimed.push({ repo, ref, because: str(row, 'because') ?? 'unknown', at: row.ts })
      continue
    }
    if (event === 'incident-raised') continue
    // M8c.2. A CORRECT non-raise, not a defect and not an incident: the run
    // predates the activation and a later run on its branch has overtaken it.
    // It belongs in the book of record, where a reader asking "why did nothing
    // raise" finds it beside `incident-unclaimed` — and deliberately not on
    // this board, which is a list of incidents the company HAS. Folding it in
    // would put eight rows on the panel at every cold start for eight things
    // that correctly did not happen.
    if (event === 'incident-superseded') continue

    const of = event === 'incident-verdict-refused' ? 'verdict' : 'triage'
    if (event === 'incident-triage-refused' || event === 'incident-verdict-refused') {
      const target = key === null ? undefined : byKey.get(key)
      if (target === undefined) unattributed.push(refusalFrom(row, of))
      else target.refusals.push(refusalFrom(row, of))
      continue
    }

    // Everything past here needs an incident it can be filed against. A row
    // naming one this fold has never seen raised is dropped rather than
    // inventing a row with no repository — see the contract.
    const target = key === null ? undefined : byKey.get(key)
    if (target === undefined) continue

    if (event === 'incident-triage-declined' || event === 'incident-triage-accepted') {
      target.asides.push({
        act: event === 'incident-triage-declined' ? 'declined' : 'accepted',
        from: str(row, 'from') ?? 'unknown',
        because: str(row, 'because') ?? '',
        at: row.ts
      })
    } else if (event === 'incident-triaged') {
      target.severity = num(row, 'severity')
      target.summary = str(row, 'summary')
      target.resolved = bool(row, 'resolved')
      target.triagedBy = str(row, 'by')
    } else if (event === 'incident-root-cause-verification-requested') {
      target.verification = {
        verifier: str(row, 'verifier') ?? 'unknown',
        claim: str(row, 'claim') ?? '',
        verdict: null,
        because: null,
        read: []
      }
    } else if (event === 'incident-root-cause-verdict') {
      const verdict = str(row, 'verdict')
      target.verification = {
        verifier: str(row, 'verifier') ?? target.verification?.verifier ?? 'unknown',
        claim: str(row, 'claim') ?? target.verification?.claim ?? '',
        verdict:
          verdict === 'agree' || verdict === 'refute' || verdict === 'cannot-tell' ? verdict : null,
        because: str(row, 'because'),
        read: strings(row, 'read')
      }
    } else if (event === 'incident-root-cause-unverified') {
      target.unverifiedBecause = str(row, 'because')
    } else if (event === 'incident-announce-owed') {
      target.owed.push(str(row, 'because') ?? 'unknown')
    }
  }

  const incidents = [...byKey.values()]
    .sort((a, b) => b.raisedAt - a.raisedAt)
    .map((row) => ({ ...row, stage: stageOf(row) }))

  return { incidents, unclaimed, unattributedRefusals: unattributed }
}

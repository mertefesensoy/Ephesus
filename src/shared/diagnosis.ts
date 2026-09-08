import type { LogEntry } from './log'

/**
 * The report you read when nobody was watching (M8.13).
 *
 * ## Why this exists
 *
 * The M8 exit run stalled during setup and still produced five findings — but
 * assembling them took a fresh reader forty minutes of discovering where
 * `EPH_HOME` was, which panels existed, and what had and had not run. Every
 * fact it needed was already on disk. None of it was in one place.
 *
 * The Architect's own statement of the need: *"during testing I may not be
 * present at the computer, so the project must prepare itself for the scenario
 * that I will have to record the issue properly so another agent can see what is
 * working, what is not working, why is it not working properly."*
 *
 * So this folds what the harness already knows into one artifact a cold reader
 * can act on. It stores nothing: `AgoraHealth.runtime` already holds the
 * degradation ring (M8.2, one row per CAUSE with count, since and freshness) and
 * `log.jsonl` already holds every positive event. A second durable copy of
 * either would be two things that must agree.
 *
 * ## Three states, and the third is the point
 *
 * A row is `working`, `broken`, or **`not-exercised`**.
 *
 * A report that said "incidents: ok" because no incident had ever been raised
 * would be exactly the lie this codebase keeps finding — a check that cannot
 * fail. Two passes were saved from it by a human writing "NOT exercised"
 * instead of "fine": the 2026-09-07 live verification, whose §6.3 exists for
 * this reason, and the M8 exit run, which reported six clauses as NOT EXERCISED
 * rather than banking a vacuous pass. This makes that distinction mechanical.
 *
 * The rule, in order:
 *
 *  1. a LIVE degradation naming this subsystem  -> `broken`, with its reason;
 *  2. otherwise a log row that PROVES the subsystem did its job -> `working`,
 *     citing the row;
 *  3. otherwise -> `not-exercised`, saying what would exercise it.
 *
 * Carried degradations (replayed at boot, true when we stopped, not re-checked
 * since) do not make a row `broken` on their own — they are reported in their
 * own section, because "this was wrong last week" and "this is wrong now" are
 * different sentences and conflating them is how a week-old problem gets read as
 * current.
 */

/** How a subsystem is doing, in the only three answers that are honest. */
export type Verdict = 'working' | 'broken' | 'waiting' | 'not-exercised'

/**
 * One subsystem's row.
 *
 * `because` always says why the verdict is what it is — a `not-exercised` row
 * that did not say what would exercise it would send the reader hunting for a
 * failure that has not happened.
 */
export interface Row {
  readonly area: string
  readonly verdict: Verdict
  readonly because: string
}

/**
 * What proves a subsystem worked, and what would exercise it if nothing has.
 *
 * `proves` is matched against the log's `kind` and `event` fields. It is a
 * closed list rather than a predicate so the table reads as documentation: each
 * line says, in one place, what this subsystem doing its job LOOKS like in the
 * book of record.
 */
interface Probe {
  readonly area: string
  /** Degradation sources that mean THIS area is broken. */
  readonly sources: readonly string[]
  /**
   * Conditions that mean "waiting for the Architect", not "wrong".
   *
   * The degradation channel carries **no severity**. Invariant §7 says disclose
   * every give-up, and it is right to, but that puts a deliberate default and a
   * genuine fault through the same pipe under the same shape — so any consumer
   * that wants to tell them apart has to decide for itself. This report is the
   * first such consumer, and this predicate is where that decision lives.
   *
   * Two designed states are known to reach it, and BOTH were rendered as
   * `BROKEN` by the first live runs of this report:
   *
   *  - `consent/not-granted` — a company waiting to be started is not broken,
   *    and a BROKEN on every healthy first launch teaches a reader to skip the
   *    column;
   *  - `budgets/state:<agent>` reporting `unbudgeted` — which fires whenever the
   *    state is not `ok`, and `unbudgeted` is the SHIPPED DEFAULT (ADR-0029). A
   *    breached budget goes through the same cause and must still read `broken`.
   *
   * That the discrimination has to happen here, by reading another module's
   * wording, is a smell rather than a design — recorded in DECISIONS-LOG as a
   * question about giving the channel a severity of its own. Until then, keeping
   * it declarative and in the table is the smallest honest thing.
   */
  waitingWhen?(condition: Condition): boolean
  /** `kind:event` pairs, or a bare `kind`, that prove it did its job. */
  readonly proves: readonly string[]
  /**
   * A fact that settles the area without consulting the log at all.
   *
   * Used where the input already KNOWS the answer. Reading it from a log row
   * instead would be indirection that can only go wrong, and did.
   */
  provenDirectly?(input: DiagnosisInput): string | null
  /** What the reader would have to do to find out. */
  readonly wouldExercise: string
}

/**
 * The subsystem table.
 *
 * Deliberately written against the CONSUMER's vocabulary, not the producer's.
 * Three would-be defect reports on 2026-09-07 were greps on the wrong key — the
 * incident board folds `event: 'incident-*'`, not `kind: 'incident'` — so the
 * strings here are the ones that actually appear in `log.jsonl`.
 */
const PROBES: readonly Probe[] = [
  {
    area: 'consent',
    sources: ['consent'],
    waitingWhen: (c) => c.cause === 'consent/not-granted',
    // Proven by the FACT, not by a log row. The header line and this row are two
    // readings of one question, and when they read it from different places they
    // contradicted each other: the first live report said "consent: granted" in
    // the header and `NOT EXERCISED` in the table, because the row was written
    // before `orchestrator/consented` reached the log.
    provenDirectly: (i) => (i.consented ? 'the grant recorded in config.json' : null),
    proves: ['orchestrator:consented'],
    wouldExercise: 'pressing START THE COMPANY on the banner at the top of the app'
  },
  {
    area: 'orchestrator',
    sources: ['artemis'],
    proves: ['orchestrator:spawned', 'spawn'],
    wouldExercise: 'granting consent, which hires her'
  },
  {
    area: 'the crew',
    sources: ['agents', 'respawn', 'commands'],
    proves: ['spawn', 'exit'],
    wouldExercise: 'activating a mission profile against a repository from the PROFILES tab'
  },
  {
    area: 'watching a repository',
    sources: ['harbor'],
    proves: ['remote'],
    wouldExercise: 'activating a profile against a checkout whose GitHub remote `gh` can read'
  },
  {
    area: 'incidents',
    sources: ['incident'],
    proves: ['profile:incident-raised', 'profile:incident-triaged'],
    wouldExercise: 'a CI failure on a watched repository'
  },
  {
    area: 'gates',
    sources: ['gates', 'autonomy'],
    proves: ['gate'],
    wouldExercise: 'an agent attempting an action the policy holds'
  },
  {
    area: 'the schedules',
    sources: ['scheduler'],
    proves: ['brief', 'orchestrator:retro'],
    wouldExercise: 'granting consent — the trigger clock starts with the company'
  },
  {
    area: 'spend',
    sources: ['budgets', 'ledger', 'usage'],
    // `unbudgeted` is the shipped default (ADR-0029) and is not a fault; a
    // breach comes through the same cause and is.
    waitingWhen: (c) => c.cause.startsWith('budgets/state:') && c.detail.includes('unbudgeted'),
    proves: ['cost'],
    wouldExercise: 'an agent taking a turn'
  },
  {
    area: 'mail',
    sources: ['hermes'],
    proves: ['delivery', 'bounce'],
    wouldExercise: 'one agent writing to another, or the harness mailing the orchestrator'
  },
  {
    area: 'the book of record',
    sources: ['agora'],
    // A busy home is not a fault: nothing has gone wrong, the harness refused
    // to let it. Two instances would share one book and one committer, and the
    // Architect acts on this by stopping the other one (ADR-0034).
    waitingWhen: (c) => c.cause === 'agora/home-occupied',
    // It has always worked if anything at all was written, including this row.
    proves: ['degradation', 'orchestrator', 'spawn', 'message'],
    wouldExercise: 'anything at all — an empty log is itself the finding'
  },
  {
    area: 'memory and recall',
    sources: ['library'],
    proves: ['memory'],
    wouldExercise: 'an agent condensing its memory, which needs a running crew'
  },
  {
    // M8.14. `remote:control` is the CONSUMER's spelling: every act that
    // arrives over the control surface writes exactly that pair, so this row
    // reads `working` only once a script has actually driven the company —
    // never because the endpoint merely came up.
    area: 'the control surface',
    sources: ['control'],
    proves: ['remote:control'],
    // An act, not a read: reads are deliberately not logged, so naming one here
    // would send a reader to a command that cannot move this row.
    wouldExercise: 'running `node scripts/ephctl.cjs consent:grant` in a terminal'
  }
]

/** One live or carried condition, as `AgoraHealth.runtime` reports it. */
export interface Condition {
  readonly source: string
  readonly cause: string
  readonly detail: string
  readonly count: number
  readonly since: number
  readonly freshness: 'live' | 'carried'
}

/** Everything the fold needs. All of it already exists somewhere. */
export interface DiagnosisInput {
  /** When this was taken. The report prints it and its own age. */
  readonly at: number
  readonly home: string
  /** The commit this build came from, when the harness knows it. */
  readonly version: string
  /** `AgoraHealth.runtime`, live and carried both. */
  readonly conditions: readonly Condition[]
  /** The whole book of record, oldest first. */
  readonly events: readonly LogEntry[]
  /** Files the harness could not parse, and why. */
  readonly fileWarnings: readonly { readonly file: string; readonly reason: string }[]
  /** Agents on the roster and their lifecycle, for the crew section. */
  readonly crew: readonly { readonly agentId: string; readonly lifecycle: string }[]
  /** Whether the Architect has consented (DD-6). */
  readonly consented: boolean
  /** Schedules armed right now, with their intervals. */
  readonly armed: readonly { readonly id: string; readonly everyMs: number }[]
}

export interface Diagnosis {
  readonly at: number
  readonly home: string
  readonly version: string
  readonly rows: readonly Row[]
  /** Conditions true RIGHT NOW. */
  readonly live: readonly Condition[]
  /** True when we stopped, not re-checked since. Never shown as current. */
  readonly carried: readonly Condition[]
  readonly fileWarnings: readonly { readonly file: string; readonly reason: string }[]
  readonly crew: readonly { readonly agentId: string; readonly lifecycle: string }[]
  readonly consented: boolean
  readonly armed: readonly { readonly id: string; readonly everyMs: number }[]
  readonly events: number
}

/** Contract: pure. Does a row in the log prove this probe's subsystem worked? */
function provenBy(events: readonly LogEntry[], proves: readonly string[]): LogEntry | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const entry = events[i]
    if (!entry) continue
    const kind = String(entry.kind)
    const event = entry['event'] === undefined ? null : String(entry['event'])
    for (const want of proves) {
      const [wantKind, wantEvent] = want.split(':')
      if (kind !== wantKind) continue
      if (wantEvent === undefined) return entry
      if (event === wantEvent) return entry
    }
  }
  return null
}

/** A time an ordinary reader can act on, relative to the report's own clock. */
export function agoPhrase(ms: number): string {
  if (ms < 0) return 'in the future — the clock moved'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${String(days)} day${days === 1 ? '' : 's'} ago`
}

/**
 * Contract: pure. Folds what the harness knows into a verdict per subsystem.
 *
 * Never throws and never guesses: an area with no evidence either way is
 * `not-exercised`, which is a statement about the RUN rather than about the
 * code, and is the one answer that keeps this report honest.
 */
export function diagnose(input: DiagnosisInput): Diagnosis {
  const live = input.conditions.filter((c) => c.freshness === 'live')
  const carried = input.conditions.filter((c) => c.freshness === 'carried')

  const rows = PROBES.map((probe): Row => {
    const broken = live.find((c) => probe.sources.includes(c.source))
    if (broken) {
      const waiting = probe.waitingWhen?.(broken) ?? false
      return {
        area: probe.area,
        verdict: waiting ? 'waiting' : 'broken',
        because: `${broken.cause}: ${broken.detail}${
          broken.count > 1 ? ` (reported ${String(broken.count)} times)` : ''
        }`
      }
    }
    const direct = probe.provenDirectly?.(input) ?? null
    if (direct !== null) {
      return { area: probe.area, verdict: 'working', because: direct }
    }
    const proof = provenBy(input.events, probe.proves)
    if (proof) {
      const event = proof['event'] === undefined ? '' : `/${String(proof['event'])}`
      return {
        area: probe.area,
        verdict: 'working',
        because: `${String(proof.kind)}${event} at seq ${String(proof.seq)}`
      }
    }
    return {
      area: probe.area,
      verdict: 'not-exercised',
      because: `nothing has happened either way — ${probe.wouldExercise}`
    }
  })

  return {
    at: input.at,
    home: input.home,
    version: input.version,
    rows,
    live,
    carried,
    fileWarnings: input.fileWarnings,
    crew: input.crew,
    consented: input.consented,
    armed: input.armed,
    events: input.events.length
  }
}

const MARK: Record<Verdict, string> = {
  working: 'WORKING',
  broken: 'BROKEN',
  waiting: 'WAITING FOR YOU',
  'not-exercised': 'NOT EXERCISED'
}

/**
 * Contract: pure. The report as a reader meets it.
 *
 * Markdown rather than JSON, deliberately: `log.jsonl` is already the
 * machine-readable ground truth, and a second parseable copy would be a schema
 * to keep in step for no gain (invariant §9 would owe it a validator). This is
 * the READING of the record, for a person or an agent arriving cold.
 *
 * `readAt` is passed in rather than taken from a clock so the age line is
 * testable and so the file can be rendered from a snapshot taken earlier.
 */
export function renderDiagnosis(d: Diagnosis, readAt: number): string {
  const out: string[] = []
  const broken = d.rows.filter((r) => r.verdict === 'broken')
  const waiting = d.rows.filter((r) => r.verdict === 'waiting')
  const unexercised = d.rows.filter((r) => r.verdict === 'not-exercised')

  out.push('# Ephesus — what is working, what is not, and why')
  out.push('')
  // The staleness line is FIRST, because a report read as current when it is a
  // day old is worse than no report: it is a degradation failing as good news.
  out.push(
    `**Written ${new Date(d.at).toISOString()} — ${agoPhrase(readAt - d.at)}.** ` +
      'If that is not recent, the harness was not running when you read this, and ' +
      'everything below describes the moment it stopped.'
  )
  out.push('')
  out.push(`- home: \`${d.home}\``)
  out.push(`- build: ${d.version}`)
  out.push(`- events in the book of record: ${String(d.events)}`)
  out.push(
    `- consent: ${
      d.consented
        ? 'granted — the company may work'
        : 'NOT GRANTED — nobody is hired and no clock is running, by design'
    }`
  )
  out.push('')

  out.push('## The short answer')
  out.push('')
  if (broken.length > 0) {
    out.push(`**${String(broken.length)} thing(s) are broken right now:**`)
    out.push('')
    for (const row of broken) out.push(`- **${row.area}** — ${row.because}`)
  } else {
    out.push('Nothing is reporting itself broken.')
  }
  out.push('')
  if (waiting.length > 0) {
    out.push(`**${String(waiting.length)} thing(s) are waiting on YOU:**`)
    out.push('')
    for (const row of waiting) out.push(`- **${row.area}** — ${row.because}`)
    out.push('')
  }
  if (unexercised.length > 0) {
    out.push(
      `**${String(unexercised.length)} of ${String(d.rows.length)} areas are NOT EXERCISED** — ` +
        'nothing has happened that would prove them working OR broken. Do not read ' +
        'that as health; read it as "not asked yet".'
    )
    out.push('')
  }

  out.push('## Every area')
  out.push('')
  out.push('| area | verdict | why |')
  out.push('|---|---|---|')
  for (const row of d.rows) {
    out.push(`| ${row.area} | ${MARK[row.verdict]} | ${row.because} |`)
  }
  out.push('')

  out.push('## Conditions true right now')
  out.push('')
  if (d.live.length === 0) out.push('None.')
  for (const c of d.live) {
    out.push(
      `- \`${c.cause}\` — ${c.detail} (×${String(c.count)}, first seen ${new Date(
        c.since
      ).toISOString()})`
    )
  }
  out.push('')

  out.push('## Conditions carried from the last run')
  out.push('')
  out.push(
    '_Replayed from the log at boot: these were true when the harness stopped and ' +
      'nothing has re-checked them since. They are not evidence about now._'
  )
  out.push('')
  if (d.carried.length === 0) out.push('None.')
  for (const c of d.carried) out.push(`- \`${c.cause}\` — ${c.detail}`)
  out.push('')

  if (d.fileWarnings.length > 0) {
    out.push('## Files the harness could not read')
    out.push('')
    out.push('_Left on disk untouched, never overwritten — they are the evidence._')
    out.push('')
    for (const w of d.fileWarnings) out.push(`- \`${w.file}\` — ${w.reason}`)
    out.push('')
  }

  out.push('## The crew')
  out.push('')
  if (d.crew.length === 0) out.push('Nobody is hired.')
  for (const member of d.crew) out.push(`- ${member.agentId} — ${member.lifecycle}`)
  out.push('')

  // The heading is a claim about whether these are RUNNING, and it was wrong in
  // the first live report: it said "no schedule is armed, by design" and then
  // listed five. `armed()` reports triggers that are REGISTERED; the clock that
  // fires them does not start until consent is granted (ADR-0032), so on a
  // withheld company these are a forecast, not a state.
  out.push(d.consented ? '## Schedules running' : '## Schedules that would start')
  out.push('')
  if (!d.consented) {
    out.push(
      '_The trigger clock does not start until consent is granted, so none of ' +
        'these are running. They are what granting it would set going._'
    )
    out.push('')
  }
  if (d.armed.length === 0) out.push('None.')
  for (const t of d.armed) {
    out.push(`- ${t.id} — every ${String(Math.round(t.everyMs / 60_000))} minute(s)`)
  }
  out.push('')

  out.push('## What this report cannot tell you')
  out.push('')
  out.push(
    '- It is a reading of `agora/log.jsonl` and the harness home. If the harness ' +
      'never started, this file is from whenever it last did — check the date above.'
  )
  out.push(
    '- `NOT EXERCISED` is not a pass. It means no evidence exists either way, and ' +
      'the "why" column says what would produce some.'
  )
  out.push(
    '- Nothing here observes the UI. A panel that renders wrongly, or a button ' +
      'that does nothing, leaves no trace in the book of record.'
  )
  out.push('')
  out.push('The full record is `agora/log.jsonl` in the home above — append-only, one')
  out.push('JSON object per line, oldest first. This file is only its reading.')
  out.push('')

  return out.join('\n')
}

import { z } from 'zod'
import type { InboundItem } from './harbor'
import { rootCauseSchema } from './root-cause'

/**
 * Incidents and severity-based escalation (FR-9.2, UC-09, SDD §7.5).
 *
 * The Skeleton Crew's reason to exist: something broke in one of the
 * Architect's apps, and the company should notice, triage it, and either fix it
 * or say clearly that it cannot. This module owns the two mechanical halves of
 * that — what an incident IS, and what a given severity mechanically causes.
 * The judgment between them (is this bad? what fixes it?) is the on-call
 * agent's, following a playbook, exactly as ADR-0005 and ADR-0012 split it.
 *
 * **The harness never assigns a severity.** UC-09 step 2 gives triage to the
 * agent, and this file has no classifier, no keyword list and no heuristic that
 * would quietly become one. What it has is a total table from a severity an
 * agent REPORTED to the escalation the harness then owes. A harness that graded
 * severity itself would be making the call the playbook exists to make, and it
 * would make it from a CI run's title.
 *
 * ## On the severity ladder, and what the documents actually say
 *
 * The SRS names exactly one rung: "the Herald can announce a **severity-1**
 * aloud immediately" (UC-09 step 4; SDD §7.5 repeats it). No document in this
 * repository enumerates a scale — there is no clause listing severity-2,
 * severity-3, or what distinguishes them.
 *
 * So the ladder here is two rungs, which is the fewest that makes
 * "severity-based escalation" mean anything, and it adds no rung the documents
 * do not already imply:
 *
 *  - **1** — the rung UC-09 names: announce now, do not wait for the standup.
 *  - **2** — everything else: the ordinary UC-08 escalation path with an
 *    incident summary, batched into the next brief.
 *
 * Extending this is a DOCUMENT decision, not a code one, and it is cheap on
 * purpose: `escalationFor` is one total function over one array, so a four-rung
 * ladder is a four-row table and nothing else in the system moves.
 */

export const INCIDENT_SCHEMA_VERSION = 1

/**
 * Severity rungs, worst first. The order IS the comparison: a lower number is
 * more severe, matching the "severity-1" the SRS names — so `Math.min` over two
 * severities is "the worse of the two", and there is no second convention to
 * remember.
 */
export const INCIDENT_SEVERITIES = [1, 2] as const

export const severitySchema = z.union([z.literal(1), z.literal(2)])

export type IncidentSeverity = z.infer<typeof severitySchema>

/** The most severe rung — the one UC-09 step 4 singles out. */
export const SEVERITY_1: IncidentSeverity = 1

/**
 * What a severity mechanically causes.
 *
 * Every field is a harness obligation, not advice. The point of making this a
 * record rather than a branch in the wiring is that the table can be asserted
 * TOTAL in a test: every severity maps to exactly one row, and adding a rung
 * without deciding its escalation stops compiling.
 */
export interface IncidentEscalation {
  readonly severity: IncidentSeverity
  /**
   * UC-09 step 4's "announce aloud immediately". True only for severity-1.
   *
   * **The delivery leg for this is not wired, deliberately.** M6.9 — wiring the
   * Herald into the application — is deferred indefinitely by Architect
   * decision, so `src/main/herald/` has no production caller and must not gain
   * one here. This flag is therefore an obligation the harness RECORDS and
   * reports as unmet (invariant §7: every degradation is visible), never one it
   * silently drops. The distinction matters: "we owe an announcement and cannot
   * make it" is a fact the Architect can act on; an announcement that quietly
   * never happened is the failure mode this whole ladder exists to prevent.
   */
  readonly announceNow: boolean
  /**
   * Whether the incident goes to the Architect's approval queue immediately
   * (UC-08's path) rather than riding the next standup. Severity-1 does; a
   * severity-2 that needs a gated action still raises its gate when the agent
   * asks for one — this flag is about the INCIDENT, not about the actions
   * taken during it.
   */
  readonly escalateNow: boolean
  /** Whether the incident is narrated in the next briefing (UC-09 step 3). */
  readonly inNextBrief: boolean
}

/**
 * The table. Two rows because the documents describe two treatments; see the
 * module header for why that is a transcription rather than a choice.
 */
const ESCALATIONS: { readonly [S in IncidentSeverity]: IncidentEscalation } = {
  1: { severity: 1, announceNow: true, escalateNow: true, inNextBrief: true },
  2: { severity: 2, announceNow: false, escalateNow: false, inNextBrief: true }
}

/**
 * Contract: total and pure. Every severity has exactly one escalation.
 *
 * Total by construction rather than by a default branch: the mapped type above
 * fails to compile if a rung is added to `INCIDENT_SEVERITIES` and left out of
 * the table, so a new rung cannot ship with an undecided escalation. A
 * `default:` case would have accepted one and quietly given it the mildest
 * treatment, which is the wrong direction for a safety ladder to fail in.
 */
export function escalationFor(severity: IncidentSeverity): IncidentEscalation {
  return ESCALATIONS[severity]
}

/**
 * How an incident is named, and the key that makes raising it idempotent.
 *
 * `<repo>#<kind>:<ref>` — stable across ingestions, because the Harbor rebuilds
 * its queues from scratch every ten minutes and would otherwise present the
 * same failed CI run as news forever. The S-WAKE lesson one subsystem over: the
 * watchdog nudges once, and a cursor is what makes "once" true across a replay.
 */
export function incidentKey(item: Pick<InboundItem, 'repo' | 'kind' | 'ref'>): string {
  return `${item.repo}#${item.kind}:${String(item.ref)}`
}

/**
 * One incident, as the harness knows it at the moment it is raised.
 *
 * Note what is NOT here: a severity, a diagnosis, a suggested fix, a summary
 * sentence. Every field is copied from what the Harbor actually ingested, and
 * the whole record is checkable against the `gh` response it came from. This is
 * the E-BRIEF-FAITH rule applied at the port: an incident that described the
 * failure in words nobody received would be the harness inventing the fact it
 * is about to wake an agent for.
 */
export interface Incident {
  readonly key: string
  readonly repo: string
  /** The CI run's database id, as GitHub reported it. */
  readonly ref: number
  /** The run's name, verbatim from `gh` — never rewritten. */
  readonly title: string
  /** `failure`, `timed_out` — GitHub's own conclusion string. */
  readonly conclusion: string
  readonly url: string
  /** ISO-8601 as GitHub returned it, not a local clock reading. */
  readonly at: string
  /** The instance whose trigger binding caught it (`profile:target`). */
  readonly instanceId: string
  /** The on-call agent this incident is for. */
  readonly agentId: string
  /** The runbook that agent should follow. A reference — never the text. */
  readonly playbook: string
}

/**
 * Contract: builds an incident from an ingested item, or null when the item is
 * not one. Pure and total.
 *
 * Returns null rather than throwing for the ordinary case (a passing run is not
 * an incident), and refuses to invent the two fields it cannot copy: an item
 * with no conclusion string is not turned into an incident with an empty one.
 */
export function incidentFrom(
  item: InboundItem,
  binding: { readonly instanceId: string; readonly agentId: string; readonly playbook: string }
): Incident | null {
  if (item.kind !== 'ci-run') return null
  if (item.conclusion === null) return null
  return {
    key: incidentKey(item),
    repo: item.repo,
    ref: item.ref,
    title: item.title,
    conclusion: item.conclusion,
    url: item.url,
    at: item.at,
    instanceId: binding.instanceId,
    agentId: binding.agentId,
    playbook: binding.playbook
  }
}

/**
 * What an on-call agent reports back after triage (UC-09 steps 3 and 4).
 *
 * The agent writes this into a message body; the harness parses it and acts on
 * the severity. Deliberately tiny: a severity, whether the playbook resolved
 * it, and one line of what happened. Anything richer would be the harness
 * asking the agent to fill in a form it then summarizes — and ADR-0005 puts
 * summarizing on the agent's side of the line, not the harness's.
 *
 * `refs` and `rootCause` are the two exceptions, and they are exceptions to the
 * form-filling worry rather than to the rule. Neither is summarized by anybody:
 * they are the CITATIONS the other fields rest on, and every one of them exists
 * so a claim can be held against something — the ledger for a ref, the
 * repository for a root cause. The distinction that keeps this honest is that
 * the harness never reads them for meaning, only for support.
 */
export const triageReportSchema = z
  .object({
    schemaVersion: z.literal(INCIDENT_SCHEMA_VERSION),
    kind: z.literal('triage'),
    incident: z.string().min(1).max(200),
    severity: severitySchema,
    /** True when the playbook fix worked (UC-09 step 3's `inform` branch). */
    resolved: z.boolean(),
    /** One line, the agent's words, carried verbatim into the log and brief. */
    summary: z.string().min(1).max(2_000),
    /**
     * What in the company's own records supports this report — task ids and
     * `log#<seq>` entries, exactly as a brief sentence carries them.
     *
     * Optional only so a pack of older agents keeps working; `checkTriage`
     * refuses a report whose SUMMARY claims an action it cannot point at.
     *
     * This exists because of the 2026-09-01 run. A triage report stated "Task
     * was opened and assigned to agent.skeleton-crew-musahit-ci-babysitter"
     * while `tasks.json` held zero tasks, and nothing anywhere checked. The
     * brief had carried this rule since M4 — `checkNarrative` refuses a
     * sentence citing a ref no fact supports — and the triage report, which is
     * the other thing an agent asserts about work it did, had no equivalent.
     */
    refs: z.array(z.string().min(1).max(128)).max(32).optional(),
    /**
     * The diagnosis, in the one shape a second party can check — a claim, and
     * the file/line/quote it rests on (`src/shared/root-cause.ts`).
     *
     * Separate from `refs` deliberately, and not merely because a source path
     * is not a task id. The two namespaces answer different questions and are
     * checked by different means: `refs` is reconciled against the company's
     * OWN records, which the harness holds and can read; `rootCause` is
     * reconciled against a repository, which it cannot — so that check is an
     * agent's, and the block exists to give that agent something falsifiable to
     * open.
     *
     * Optional, because most triage has no root cause to offer: "could not
     * retrieve the run log" is a real and useful result, and demanding a
     * diagnosis would produce invented ones. What is NOT optional is the
     * citation once a diagnosis is offered — the schema below cannot represent
     * a claim with no source, and `checkTriage` refuses a summary that says
     * "root cause" while carrying no block at all.
     */
    rootCause: rootCauseSchema.optional()
  })
  .strict()

export type TriageReport = z.infer<typeof triageReportSchema>

export type TriageParse =
  | { readonly ok: true; readonly report: TriageReport }
  | { readonly ok: false; readonly reasons: readonly string[] }

/**
 * Contract: parses an agent's triage report, or lists everything wrong with it.
 * Pure; never throws.
 *
 * Refusing an unreadable report rather than defaulting its severity is the
 * whole point. A malformed report that fell back to severity-2 would convert
 * "the agent could not tell us how bad this is" into "this is not very bad",
 * which is the same silent-downgrade failure the deny-by-default gate policy
 * exists to avoid one subsystem over.
 */
export function parseTriageReport(body: string): TriageParse {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch (err) {
    return {
      ok: false,
      reasons: [
        `triage report: not JSON — ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`
      ]
    }
  }
  const parsed = triageReportSchema.safeParse(raw)
  if (parsed.success) return { ok: true, report: parsed.data }
  return {
    ok: false,
    reasons: parsed.error.issues.map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : 'triage report'
      return `${where}: ${issue.message}`
    })
  }
}

/**
 * Words a triage summary uses to claim it changed the company's records.
 *
 * Deliberately narrow. This is not prose comprehension and must not pretend to
 * be: it catches the specific, repeated claim — that a task was opened or
 * assigned — and says nothing about any other sentence. A checker that tried to
 * judge every claim would be wrong often enough that nobody would trust it.
 */
const LEDGER_CLAIM =
  /(task (?:was )?(?:opened|created|filed|assigned)|opened a task|created a task|assigned (?:the|a) task)/i

/**
 * The one phrase that turns a summary into a diagnosis the company will act on.
 *
 * As narrow as `LEDGER_CLAIM` and for the same reason: this is not prose
 * comprehension. It matches the literal words "root cause" and nothing else — a
 * summary saying "the migration dropped a column" is an observation and is asked
 * for no citation, while one saying "root cause: the migration dropped a column"
 * has named itself a diagnosis and must point at the source it read.
 *
 * A broader detector ("because", "caused by", "due to") was considered and
 * rejected: it fires on almost every honest sentence, and a checker that refuses
 * honest reports is one agents learn to write around rather than satisfy.
 */
const ROOT_CAUSE_CLAIM = /\broot[- ]cause/i

export interface TriageCheck {
  readonly ok: boolean
  readonly reasons: readonly string[]
}

/**
 * Contract: pure. Whether a triage report's claims are supported by what the
 * company can actually see.
 *
 * The rule is the brief's rule (`checkNarrative`), applied to the two things an
 * agent asserts about work it did:
 *
 *  - **A ledger claim must point at the ledger.** If the summary says a task was
 *    opened, the report must cite a ref naming a task the ledger really holds.
 *    That is what the 2026-09-01 run had no way to do.
 *  - **A root cause must point at source.** If the summary calls itself a root
 *    cause, the report must carry a `rootCause` block — and that block cannot
 *    exist without a file, a line and a quote. This is the second half of the
 *    same run's finding: the diagnosis was as false as the ledger claim and far
 *    better argued, and nothing anywhere could open the file it was about.
 *
 * Both are CLAIM checks, never judgement. Whether a diagnosis is CORRECT is not
 * knowable from here — that question goes to an independent agent, whose verdict
 * is recorded beside the claim rather than replacing it. A checker that graded
 * correctness itself would be the same confident wrongness one level up.
 *
 * `taskIds` is nullable: null means no ledger is wired, which skips the ledger
 * rule alone. The root-cause rule needs nothing the harness has to look up, so
 * it runs either way — a check that could not run is a reason to skip THAT
 * check, not to stop checking.
 */
export function checkTriage(
  report: TriageReport,
  observed: { readonly taskIds: readonly string[] | null }
): TriageCheck {
  const reasons: string[] = []
  const refs = report.refs ?? []
  if (observed.taskIds !== null && LEDGER_CLAIM.test(report.summary)) {
    const known = new Set(observed.taskIds)
    const cited = refs.filter((ref) => known.has(ref) || known.has(ref.replace(/^task:/, '')))
    if (cited.length === 0) {
      reasons.push(
        refs.length === 0
          ? 'the summary says a task was opened but cites nothing; name the task id in `refs`'
          : `the summary says a task was opened but none of ${refs.join(', ')} names a task the ledger holds`
      )
    }
  }
  if (ROOT_CAUSE_CLAIM.test(report.summary) && report.rootCause === undefined) {
    reasons.push(
      'the summary claims a root cause but cites no source; put the claim in `rootCause` with the file, line and quoted text it rests on'
    )
  }
  return { ok: reasons.length === 0, reasons }
}

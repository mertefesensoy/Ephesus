import { z } from 'zod'

/**
 * The Harbor's GitHub ingestion (FR-10.1, FR-10.3, SDD §1.1 `harbor/github.ts`).
 *
 * The port: everything in and out. This module is the *in* half's contract —
 * what an issue, a pull request and a CI run are once they have crossed into
 * the company, and the parsers that decide whether a payload from `gh` is
 * allowed to become one.
 *
 * One rule governs the file, and it is the package's risk line: **ingestion that
 * invents a task the API did not report is the E-BRIEF-FAITH failure wearing a
 * Harbor hat.** A briefing that narrates a bug nobody filed and a queue that
 * lists an issue nobody opened are the same defect at different ends of the
 * building. So:
 *
 * - every field is validated, and a row that does not validate is **dropped and
 *   counted**, never repaired, defaulted, or half-read into the queue;
 * - the count of dropped rows is carried out with the good ones, because
 *   silently ingesting 4 of 5 issues is exactly the kind of quiet wrongness
 *   invariant §7 forbids;
 * - nothing here derives, summarizes or infers. A `title` is the title GitHub
 *   returned.
 *
 * `gh` is invoked with `--json <fields>`, so these schemas are written against
 * the shapes that flag actually returns — not against the REST API's fuller
 * objects, which would tempt a field nothing asked for.
 */

export const HARBOR_SCHEMA_VERSION = 1

/** `owner/repo`, as the `gh` CLI names a repository. */
export const repoRemoteSchema = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[\w.-]+\/[\w.-]+$/, 'a remote like owner/repo')

/**
 * What came in. Kept as a closed set: the Harbor ingests the three things
 * FR-10.1 names — "issues, PRs, and CI runs" — and a fourth would be a scope
 * change, not a schema edit.
 */
export const INBOUND_KINDS = ['issue', 'pull-request', 'ci-run'] as const
export const inboundKindSchema = z.enum(INBOUND_KINDS)
export type InboundKind = z.infer<typeof inboundKindSchema>

/** `gh issue list --json number,title,state,updatedAt,url,author,labels`. */
const ghIssueSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().max(1_000),
    state: z.string().min(1).max(32),
    updatedAt: z.string().min(1).max(64),
    url: z.string().min(1).max(500),
    author: z
      .object({ login: z.string().max(120) })
      .loose()
      .nullable()
      .optional(),
    labels: z.array(z.object({ name: z.string().max(120) }).loose()).optional()
  })
  // Loose, deliberately: `gh` adds fields between releases, and refusing an
  // issue because a new one appeared would make an upgrade look like an outage.
  // Every field READ is declared above; the rest is ignored, never carried.
  .loose()

/** `gh pr list --json number,title,state,updatedAt,url,author,isDraft`. */
const ghPullSchema = ghIssueSchema.extend({ isDraft: z.boolean().optional() })

/** `gh run list --json databaseId,workflowName,status,conclusion,headBranch,createdAt,url`. */
const ghRunSchema = z
  .object({
    databaseId: z.number().int().positive(),
    workflowName: z.string().max(200).optional(),
    status: z.string().min(1).max(32),
    /** Empty or absent while the run is still going — not a failure. */
    conclusion: z.string().max(32).nullable().optional(),
    headBranch: z.string().max(200).optional(),
    createdAt: z.string().min(1).max(64),
    url: z.string().min(1).max(500)
  })
  .loose()

/**
 * One thing the Harbor brought in.
 *
 * Flat and uniform across the three kinds on purpose: the queue, the log
 * projection and the briefing all read the same shape, so a new consumer cannot
 * accidentally handle issues and forget CI runs.
 */
export interface InboundItem {
  readonly repo: string
  readonly kind: InboundKind
  /** Issue/PR number, or the CI run's database id. Unique within (repo, kind). */
  readonly ref: number
  readonly title: string
  /** GitHub's own state string, verbatim (`OPEN`, `completed`, …). */
  readonly state: string
  /** A run's conclusion (`failure`, `success`), or null. Only CI runs have one. */
  readonly conclusion: string | null
  readonly url: string
  /** ISO-8601 as GitHub returned it. Never re-derived from a local clock. */
  readonly at: string
  readonly author: string | null
  readonly labels: readonly string[]
  /** True for a draft PR. False for everything else, including issues. */
  readonly draft: boolean
}

/**
 * The result of reading one `gh` response.
 *
 * `dropped` is not an error count to be logged and forgotten — it is part of the
 * answer. A caller showing "12 open issues" when 3 rows were unparseable is
 * telling the Architect something false, so the number travels with the items
 * and the UI is expected to show it.
 */
export interface InboundParse {
  readonly items: readonly InboundItem[]
  readonly dropped: number
  /** Why the rows were dropped, first few only — enough to fix a real drift. */
  readonly reasons: readonly string[]
}

const MAX_REASONS = 5

function rowsOf(body: string): { rows: unknown[] } | { reason: string } {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch (err) {
    return {
      reason: `not JSON — ${err instanceof Error ? err.message.split('\n')[0] : 'unparseable'}`
    }
  }
  if (!Array.isArray(raw)) return { reason: 'expected a JSON array of rows' }
  return { rows: raw }
}

function labelsOf(row: { labels?: readonly { name: string }[] }): readonly string[] {
  return (row.labels ?? []).map((label) => label.name)
}

/**
 * Contract: turns one `gh issue list --json …` response into items. Pure;
 * never throws.
 *
 * A row that does not validate is dropped and counted. It is NOT repaired: an
 * issue with no number has no identity, and one with no title would enter the
 * queue as an empty line the Architect cannot act on — which reads as a bug in
 * the company rather than in the payload.
 */
export function parseIssues(repo: string, body: string): InboundParse {
  return parseRows(repo, body, 'issue', ghIssueSchema, (row) => ({
    ref: row.number,
    title: row.title,
    state: row.state,
    conclusion: null,
    url: row.url,
    at: row.updatedAt,
    author: row.author?.login ?? null,
    labels: labelsOf(row),
    draft: false
  }))
}

/** Contract: as `parseIssues`, for `gh pr list`. Drafts are marked, not hidden. */
export function parsePulls(repo: string, body: string): InboundParse {
  return parseRows(repo, body, 'pull-request', ghPullSchema, (row) => ({
    ref: row.number,
    title: row.title,
    state: row.state,
    conclusion: null,
    url: row.url,
    at: row.updatedAt,
    author: row.author?.login ?? null,
    labels: labelsOf(row),
    draft: row.isDraft ?? false
  }))
}

/**
 * Contract: as `parseIssues`, for `gh run list`.
 *
 * A run in flight has no conclusion, and that is null rather than `"failure"`.
 * Guessing here would hand the CI babysitter (FR-9.2) an incident that has not
 * happened yet.
 */
export function parseRuns(repo: string, body: string): InboundParse {
  return parseRows(repo, body, 'ci-run', ghRunSchema, (row) => ({
    ref: row.databaseId,
    title: row.workflowName ?? row.headBranch ?? `run ${String(row.databaseId)}`,
    state: row.status,
    conclusion: row.conclusion === undefined || row.conclusion === '' ? null : row.conclusion,
    url: row.url,
    at: row.createdAt,
    author: null,
    labels: row.headBranch === undefined ? [] : [row.headBranch],
    draft: false
  }))
}

function parseRows<T>(
  repo: string,
  body: string,
  kind: InboundKind,
  schema: z.ZodType<T>,
  toItem: (row: T) => Omit<InboundItem, 'repo' | 'kind'>
): InboundParse {
  const read = rowsOf(body)
  if (!('rows' in read)) {
    return { items: [], dropped: 0, reasons: [`${repo} ${kind}: ${read.reason}`] }
  }
  const items: InboundItem[] = []
  const reasons: string[] = []
  let dropped = 0
  for (const row of read.rows) {
    const parsed = schema.safeParse(row)
    if (!parsed.success) {
      dropped += 1
      if (reasons.length < MAX_REASONS) {
        const issue = parsed.error.issues[0]
        const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'row'
        reasons.push(`${repo} ${kind}: ${where}: ${issue?.message ?? 'invalid'}`)
      }
      continue
    }
    items.push({ repo, kind, ...toItem(parsed.data) })
  }
  return { items, dropped, reasons }
}

/**
 * What the Harbor knows about one registered repository.
 *
 * `failure` is a first-class field rather than an empty `items` list. FR-10.1's
 * ingestion failing is a visible degradation (invariant §7): a repo whose `gh`
 * call errored and a repo with genuinely nothing open must not look the same,
 * because the second is fine and the first means the company is blind.
 */
export interface RepoQueue {
  readonly repo: string
  readonly items: readonly InboundItem[]
  readonly dropped: number
  readonly reasons: readonly string[]
  /** Non-null when ingestion could not complete for this repo. */
  readonly failure: string | null
  /** When this repo was last read, or null if it never has been. */
  readonly ingestedAt: string | null
}

/** The whole port, as the Harbor panel and the briefing compiler read it. */
export interface HarborView {
  readonly schemaVersion: number
  /** Null when `gh` is absent or unauthenticated — the ladder's bottom rung. */
  readonly ghVersion: string | null
  /**
   * Why the Harbor cannot ingest at all, or null. Separate from a per-repo
   * failure: "gh is not installed" and "this one repo 404s" send the Architect
   * to two different places.
   */
  readonly unavailable: string | null
  readonly repos: readonly RepoQueue[]
}

/**
 * Contract: the log entries one ingestion produces — one per item, kind
 * `remote` (SDD §4.3, FR-10.3). Pure.
 *
 * FR-10.3 says every remote-originated directive is tagged `remote` in the
 * event log. This makes the tagging TOTAL over the inbound path rather than
 * applied where somebody remembered: the projection is a function of the items,
 * so an item that reached the queue and not the log would have to be an item
 * this function never saw.
 */
export function remoteLogEntries(
  items: readonly InboundItem[]
): readonly ({ kind: 'remote' } & Record<string, unknown>)[] {
  return items.map((item) => ({
    kind: 'remote' as const,
    source: 'github',
    repo: item.repo,
    inbound: item.kind,
    ref: item.ref,
    title: item.title,
    state: item.state,
    // Present for every kind, null for the two that cannot have one, so a
    // consumer reading `conclusion` never has to know which kind it holds.
    conclusion: item.conclusion,
    url: item.url,
    at: item.at
  }))
}

/**
 * Contract: true when this item is a CI failure the Skeleton Crew should triage
 * (FR-9.2, UC-09). Pure and deliberately narrow.
 *
 * Only a run that has FINISHED and concluded badly counts. A run still going is
 * not an incident, and a `cancelled` one is a human's decision, not a fault —
 * treating either as a failure is how a babysitter starts opening PRs against
 * work somebody is still doing.
 */
export function isCiFailure(item: InboundItem): boolean {
  return (
    item.kind === 'ci-run' && (item.conclusion === 'failure' || item.conclusion === 'timed_out')
  )
}

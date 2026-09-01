import { z } from 'zod'
import { budgetSchema } from './agents'
import type { LogEntry } from './log'

/**
 * The org layer, v1 (FR-11.5, SDD §4.6, UC-12).
 *
 * One rule governs this whole file, and it is invariant §11's rule wearing a
 * different hat: **every figure is folded from the book of record.** Tasks done,
 * rework, escalation rate, budget efficiency — each is a count over
 * `log.jsonl` and the durable cost ledger, computed fresh on every call. There
 * is no counter anywhere in this module, because a counter is a second record
 * that a restart silently zeroes, and a metric nobody can recompute is a metric
 * nobody can argue with.
 *
 * The metrics are *mechanical*. Whether an agent with three reworks is
 * struggling or is doing the hardest work in the company is a judgement, and
 * UC-12's org review — not this file — is where judgement belongs. Nothing here
 * takes an action: no reassignment, no hire, no fire.
 */

export const ORG_SCHEMA_VERSION = 1

/** One agent's numbers, all folded (SDD §4.6 `metrics_rollup`). */
export interface AgentMetrics {
  readonly agentId: string
  /** Tasks that reached `done` with this agent as assignee. */
  readonly tasksDone: number
  /**
   * Work handed back: a task returned to `todo` after a crash, or stalled by
   * the breaker. Rework is not blame — it is the cost of the work being hard.
   */
  readonly rework: number
  /** Decisions this agent could not take alone: memos escalated + gates opened. */
  readonly escalations: number
  /** Escalations per task completed; null when nothing has completed yet. */
  readonly escalationRate: number | null
  /** Tokens folded from the durable ledger (ADR-0011). */
  readonly tokens: number
  /** Tokens per task completed; null when nothing has completed yet. */
  readonly tokensPerTask: number | null
}

export interface OrgInput {
  /** The whole event log, or the window under review. */
  readonly events: readonly LogEntry[]
  /** Cumulative tokens per agent, folded from the cost ledger — never counted. */
  readonly spend: readonly { readonly agentId: string; readonly tokens: number }[]
  /** Roster ids, so an agent that did nothing still appears with zeroes. */
  readonly agents: readonly string[]
}

/**
 * Contract: per-agent metrics, in roster order.
 *
 * An agent with no events appears with zeroes rather than being omitted. "Did
 * nothing this week" and "is not in the company" are different facts, and a
 * report that could not tell them apart would be the wrong kind of quiet.
 *
 * `escalationRate` and `tokensPerTask` are null rather than zero when nothing
 * has completed: dividing by no tasks is undefined, and reporting 0 would say
 * "perfectly efficient" about an agent that has finished nothing.
 */
export function computeMetrics(input: OrgInput): readonly AgentMetrics[] {
  return input.agents.map((agentId) => {
    const mine = input.events.filter((event) => attributedTo(event) === agentId)

    const tasksDone = mine.filter(
      (event) => event.kind === 'task' && event['event'] === 'update' && event['status'] === 'done'
    ).length
    const rework = mine.filter(
      (event) =>
        event.kind === 'task' && (event['event'] === 'returned' || event['event'] === 'stalled')
    ).length
    const escalations = mine.filter(
      (event) =>
        (event.kind === 'memo' && event['event'] === 'escalated') ||
        (event.kind === 'gate' && event['event'] === 'opened')
    ).length
    const tokens = input.spend.find((row) => row.agentId === agentId)?.tokens ?? 0

    return {
      agentId,
      tasksDone,
      rework,
      escalations,
      escalationRate: tasksDone === 0 ? null : escalations / tasksDone,
      tokens,
      tokensPerTask: tasksDone === 0 ? null : tokens / tasksDone
    }
  })
}

/**
 * Which agent a log entry is about.
 *
 * The log's kinds carry the agent under different keys — `agentId` for spawns
 * and gates, `assignee` for ledger rows, `by` for filings. Reading all three is
 * what makes the metrics whole; reading one would quietly under-count exactly
 * the kinds that matter most.
 */
function attributedTo(event: LogEntry): string | null {
  for (const key of ['agentId', 'assignee', 'by', 'from']) {
    const value = event[key]
    if (typeof value === 'string' && value.startsWith('agent.')) return value
  }
  return null
}

/** A node in the org chart (FR-11.5). */
export interface OrgNode {
  readonly agentId: string
  readonly name: string
  readonly role: string
  readonly seat: string
  /** True for the orchestrator, who sits at the temple (SDD §6). */
  readonly orchestrator: boolean
}

/**
 * Contract: the org chart, read off the registry.
 *
 * The orchestrator first, then everyone else by role then id — a stable order,
 * so two runs of the same report do not differ by shuffling. The chart is
 * derived, never stored: the roster IS the org model, and a second copy would
 * be free to disagree with who is actually hired.
 */
export function orgChart(registry: {
  readonly orchestratorId: string | null
  readonly agents: Readonly<
    Record<
      string,
      { readonly name: string; readonly role: string; readonly seat: string } | undefined
    >
  >
}): readonly OrgNode[] {
  const nodes: OrgNode[] = []
  for (const [agentId, entry] of Object.entries(registry.agents)) {
    if (entry === undefined) continue
    nodes.push({
      agentId,
      name: entry.name,
      role: entry.role,
      seat: entry.seat,
      orchestrator: agentId === registry.orchestratorId
    })
  }
  return nodes.sort((a, b) => {
    if (a.orchestrator !== b.orchestrator) return a.orchestrator ? -1 : 1
    return a.role.localeCompare(b.role) || a.agentId.localeCompare(b.agentId)
  })
}

/** A versioned hire template (FR-11.5, SDD §4.1's `hire` ref). */
export const hireTemplateSchema = z
  .object({
    schemaVersion: z.literal(ORG_SCHEMA_VERSION),
    /** `<name>@<version>` is how a registry row refers back to this file. */
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'a lowercase template name'),
    /** Bumped whenever the template changes; a hire records which one it used. */
    version: z.number().int().min(1).max(10_000),
    role: z.string().min(1).max(64),
    /**
     * What to call this hire on screen — "Mason", not "ci-babysitter".
     *
     * Optional, and it changes NO identifier: the agent id stays the slug that
     * names a mailbox directory, a registry row and every ledger reference, so
     * adding a name cannot orphan an inbox. It exists because the id a machine
     * needs and the name a person reads are different things, and using the
     * role for both left every panel saying `ci-babysitter` twice while the
     * floor showed `agent.skeleton-crew-musahit-ci-babysitter`.
     *
     * SDD §4.1's own examples have always called this hire `agent.mason`, so
     * the design assumed names; only the template had nowhere to put one.
     */
    displayName: z
      .string()
      .min(1)
      .max(32)
      .regex(/^\S[^\r\n]*$/, 'a display name is one line')
      .optional(),
    engine: z.string().min(1).max(32),
    capabilities: z.array(z.string().min(1).max(32)).max(32),
    /** Names only — a template that carried a secret VALUE would be a leak. */
    envGrants: z.array(z.string().min(1).max(64)).max(32),
    brief: z.string().min(1).max(20_000),
    /**
     * The role's daily token budget (ADR-0011, FR-11.2).
     *
     * Added at M7.1 because both documents that describe a hire template name
     * it and this one did not carry it: FR-9.1 lists "budgets" among what a
     * mission profile declares, and ADR-0012's bundle listing spells the file
     * out as "role templates: engine, prompt, skills, env grants, budget". A
     * profile that could not say what a role may spend would have pushed the
     * number into activation code, where it stops being a reviewable line in a
     * file the Architect reads before activating.
     *
     * Optional for the same reason `spawnRequestSchema.budget` is: an
     * unbudgeted hire is legal and shows as `unbudgeted`, rather than as a zero
     * the Watch would treat as an immediate breach. Additive and optional, so
     * every document written against the previous shape still validates —
     * which is why it costs no `schemaVersion` bump. (No hire template file
     * existed on disk when this landed; this schema had only test callers.)
     */
    budget: budgetSchema.optional()
  })
  .strict()

export type HireTemplate = z.infer<typeof hireTemplateSchema>

export type HireTemplateParse =
  | { readonly ok: true; readonly template: HireTemplate }
  | { readonly ok: false; readonly reason: string }

/** Contract: parses a hire template, or explains why it could not. */
export function parseHireTemplate(raw: unknown): HireTemplateParse {
  const parsed = hireTemplateSchema.safeParse(raw)
  if (parsed.success) return { ok: true, template: parsed.data }
  const issue = parsed.error.issues[0]
  const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'template'
  return { ok: false, reason: `${where}: ${issue?.message ?? 'invalid hire template'}` }
}

/** How a registry row names the template a hire came from. */
export function hireRef(template: HireTemplate): string {
  return `${template.name}@${String(template.version)}`
}

/** One claim in the retro, with the refs that make it checkable. */
export interface RetroFinding {
  readonly what: string
  readonly refs: readonly string[]
}

export interface RetroReport {
  readonly window: { readonly fromSeq: number; readonly toSeq: number }
  readonly metrics: readonly AgentMetrics[]
  readonly findings: readonly RetroFinding[]
}

/**
 * Contract: the weekly retro (FR-11.5, UC-12), computed and never narrated.
 *
 * Every finding carries refs for the same reason a brief's sentences do: a
 * claim about somebody's week that they cannot check is not a review, it is an
 * opinion with a number next to it. The findings are patterns the log can prove
 * — repeated escalations, breaker trips, rejected memos, rework — and nothing
 * else. What to DO about them is the org review's, and it is a human's.
 */
export function compileRetro(input: OrgInput): RetroReport {
  const metrics = computeMetrics(input)
  const findings: RetroFinding[] = []

  const trips = input.events.filter((event) => event.kind === 'breaker' && event['rung'] !== 0)
  if (trips.length > 0) {
    findings.push({
      what: `the breaker tripped ${String(trips.length)} time(s)`,
      refs: trips.map((event) => `log#${String(event.seq)}`)
    })
  }

  const rejected = input.events.filter(
    (event) => event.kind === 'memo' && event['verdict'] === 'rejected'
  )
  if (rejected.length > 0) {
    findings.push({
      what: `${String(rejected.length)} memo(s) were rejected`,
      refs: rejected.map((event) => `log#${String(event.seq)}`)
    })
  }

  const escalated = input.events.filter(
    (event) => event.kind === 'memo' && event['event'] === 'escalated'
  )
  if (escalated.length > 0) {
    findings.push({
      what: `${String(escalated.length)} memo(s) needed the Architect`,
      refs: escalated.map((event) => `log#${String(event.seq)}`)
    })
  }

  for (const row of metrics) {
    if (row.rework > 0) {
      findings.push({
        what: `${row.agentId} had ${String(row.rework)} piece(s) of work handed back`,
        refs: [`metrics:${row.agentId}`]
      })
    }
  }

  const seqs = input.events.map((event) => event.seq)
  return {
    window: {
      fromSeq: seqs.length === 0 ? 0 : Math.min(...seqs),
      toSeq: seqs.length === 0 ? 0 : Math.max(...seqs)
    },
    metrics,
    findings
  }
}

/**
 * Contract: the retro as the archived markdown artifact.
 *
 * Numbers in a table, findings with their refs, and an explicit note that
 * nothing here was decided. A report that read like a verdict would invite the
 * company to act on it without a human, which is the one thing UC-12 does not
 * do.
 */
export function renderRetro(report: RetroReport, at: string): string {
  const lines: string[] = [
    '# Weekly retro',
    '',
    `- generated: ${at}`,
    `- window: log#${String(report.window.fromSeq)}–log#${String(report.window.toSeq)}`,
    '',
    '## Per-agent metrics',
    '',
    '| agent | tasks done | rework | escalations | escalation rate | tokens | tokens/task |',
    '|---|---|---|---|---|---|---|'
  ]
  for (const row of report.metrics) {
    lines.push(
      `| ${row.agentId} | ${String(row.tasksDone)} | ${String(row.rework)} | ` +
        `${String(row.escalations)} | ${rate(row.escalationRate)} | ${String(row.tokens)} | ` +
        `${rate(row.tokensPerTask)} |`
    )
  }
  lines.push('', '## Findings', '')
  if (report.findings.length === 0) lines.push('Nothing the record flags this week.', '')
  for (const finding of report.findings) {
    lines.push(`- ${finding.what} [${finding.refs.join(', ')}]`)
  }
  lines.push(
    '',
    '## What was decided',
    '',
    'Nothing. Every figure above is folded from `log.jsonl` and the cost ledger,',
    'and every finding carries the refs to check it. Deciding what any of it means',
    'is the org review, and the org review is the Architect (UC-12).',
    ''
  )
  return lines.join('\n')
}

function rate(value: number | null): string {
  return value === null ? '—' : value.toFixed(2)
}

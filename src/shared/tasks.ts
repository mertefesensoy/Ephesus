import { z } from 'zod'
import { agentIdSchema } from './agents'

/**
 * The task ledger (`agora/tasks.json`, SDD §4.2). The kanban UI, the briefing
 * compiler and the Odeon's close gates all read this one file.
 *
 * The rule worth stating plainly, because it is the one the rest of the system
 * leans on: **the harness refuses `status → done` while a task still owes a
 * review artifact or has an open gate.** SDD §4.2 says so, ADR-0008 is why. M2
 * enforces the *shape* of that rule; the Odeon gates that populate `artifacts`
 * land in M5, and the Watch gates that populate `gates` in M3.
 */
export const TASKS_SCHEMA_VERSION = 1

export const TASK_STATUSES = [
  'todo',
  'in_progress',
  'blocked',
  'review',
  'done',
  'stalled'
] as const

export const taskStatusSchema = z.enum(TASK_STATUSES)

export type TaskStatus = z.infer<typeof taskStatusSchema>

/** Review obligations a task may carry (SDD §4.2 `review`). */
export const REVIEW_KINDS = ['deck', 'memo'] as const

export const reviewKindSchema = z.enum(REVIEW_KINDS)

export type ReviewKind = z.infer<typeof reviewKindSchema>

export const taskIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^t-[a-z0-9-]+$/, 'task id: "t-" followed by lowercase alphanumerics and dashes')

export const taskArtifactsSchema = z
  .object({
    deck: z.string().min(1).max(256).nullable(),
    memos: z.array(z.string().min(1).max(64)).max(64),
    resultRef: z.string().min(1).max(512).nullable()
  })
  .strict()

export const taskSourceSchema = z
  .object({
    kind: z.string().min(1).max(32),
    via: z.string().min(1).max(32),
    /** Where in `log.jsonl` this came from, e.g. `log#8842` (NFR-13). */
    log: z.string().min(1).max(64)
  })
  .strict()

export const taskSchema = z
  .object({
    id: taskIdSchema,
    title: z.string().min(1).max(200),
    spec: z.string().max(20_000),
    assignee: agentIdSchema.nullable(),
    status: taskStatusSchema,
    priority: z.number().int().min(0).max(9),
    deps: z.array(taskIdSchema).max(64),
    review: z.array(reviewKindSchema).max(2),
    /** Open Watch gate ids blocking this task. */
    gates: z.array(z.string().min(1).max(64)).max(32),
    artifacts: taskArtifactsSchema,
    source: taskSourceSchema,
    createdAt: z.string().min(1).max(64),
    updatedAt: z.string().min(1).max(64)
  })
  .strict()

export type Task = z.infer<typeof taskSchema>

export const taskLedgerSchema = z
  .object({
    schemaVersion: z.literal(TASKS_SCHEMA_VERSION),
    tasks: z.array(taskSchema).max(10_000)
  })
  .strict()

export type TaskLedger = z.infer<typeof taskLedgerSchema>

export const emptyLedger: TaskLedger = { schemaVersion: TASKS_SCHEMA_VERSION, tasks: [] }

export type CloseCheck =
  { readonly allowed: true } | { readonly allowed: false; readonly reasons: readonly string[] }

/**
 * Contract: may this task move to `done`? Pure, and it lists *every* reason it
 * cannot — a caller that fixes one obligation should not have to ask again to
 * discover the next.
 *
 * A task with no obligations closes freely; that is the common case and stays
 * cheap.
 */
export function canCloseTask(task: Task): CloseCheck {
  const reasons: string[] = []

  for (const kind of task.review) {
    if (kind === 'deck' && task.artifacts.deck === null) {
      reasons.push(`task ${task.id} owes a review deck`)
    }
    if (kind === 'memo' && task.artifacts.memos.length === 0) {
      reasons.push(`task ${task.id} owes a decision memo`)
    }
  }

  if (task.gates.length > 0) {
    reasons.push(`task ${task.id} is blocked by open gate(s): ${task.gates.join(', ')}`)
  }

  return reasons.length === 0 ? { allowed: true } : { allowed: false, reasons }
}

/**
 * Contract: validates a status change before it is written. Only `→ done` is
 * guarded (SDD §4.2); every other transition is the assignee's business, and
 * inventing a state machine the docs do not have would be exactly the
 * improvisation BUILD-PROMPT §7 forbids.
 */
export function checkStatusChange(task: Task, next: TaskStatus): CloseCheck {
  return next === 'done' ? canCloseTask(task) : { allowed: true }
}

/**
 * Contract: parses the ledger, or explains why it could not. Never throws, for
 * the same reason the registry parser does not.
 */
export function parseTaskLedger(
  raw: unknown
):
  | { readonly ok: true; readonly ledger: TaskLedger }
  | { readonly ok: false; readonly reason: string } {
  const parsed = taskLedgerSchema.safeParse(raw)
  if (parsed.success) return { ok: true, ledger: parsed.data }
  const issue = parsed.error.issues[0]
  const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'tasks'
  return { ok: false, reason: `${where}: ${issue?.message ?? 'invalid task ledger'}` }
}

import { z } from 'zod'
import { agentIdSchema } from './agents'
import { LEDGER_ENDPOINT } from './reserved'
import {
  canCloseTask,
  checkStatusChange,
  reviewKindSchema,
  taskIdSchema,
  taskStatusSchema,
  TASKS_SCHEMA_VERSION,
  type Task,
  type TaskLedger
} from './tasks'

/**
 * The ledger endpoint's protocol (SDD §7.1, §4.2, FR-5.2).
 *
 * SDD §7.1 says Artemis writes the ledger "via its ledger tool = files in its
 * own outbox as `propose` to harness ledger endpoint". So the shape of the
 * system is: **Artemis decides, the harness validates and writes.** She never
 * edits `tasks.json`; she proposes, and one writer — the single committer of
 * ADR-0004 — applies what survives validation.
 *
 * Everything here is pure. The endpoint in `src/main/ledger.ts` owns the file
 * and the replies; what a proposal *means* is decided by these functions, so
 * "the harness refuses a bad proposal" is a unit test rather than an
 * integration hope.
 */

export const LEDGER_SCHEMA_VERSION = 1

/**
 * The endpoint's address — a reserved agent id (`src/shared/reserved.ts`), so
 * SDD §4.4's `to` domain (`agentId | "broadcast" | "human"`) is used exactly as
 * documented. Nothing is ever spawned under it and it never has a mailbox: the
 * router recognises it and hands the message to the endpoint instead.
 */
export { LEDGER_ENDPOINT }

/**
 * Statuses that still owe the assignee work.
 *
 * This is what `pendingTasksFor` counts, so it is what the ADR-0013 Stop-hook
 * branch fires on. `blocked` and `stalled` are deliberately NOT pending: an
 * agent that cannot proceed should stop, not be told to continue. `review` is
 * owed to the Odeon, not to the assignee.
 */
export const PENDING_STATUSES: readonly Task['status'][] = ['todo', 'in_progress']

const taskDraftSchema = z
  .object({
    /** Optional: the endpoint mints one when Artemis does not name it. */
    id: taskIdSchema.optional(),
    title: z.string().min(1).max(200),
    /** SDD §7.1: "self-contained spec" — the assignee gets no other briefing. */
    spec: z.string().min(1).max(20_000),
    assignee: agentIdSchema.nullable(),
    priority: z.number().int().min(0).max(9).optional(),
    deps: z.array(taskIdSchema).max(64).optional(),
    review: z.array(reviewKindSchema).max(2).optional()
  })
  .strict()

const taskPatchSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    spec: z.string().min(1).max(20_000).optional(),
    assignee: agentIdSchema.nullable().optional(),
    status: taskStatusSchema.optional(),
    priority: z.number().int().min(0).max(9).optional(),
    deps: z.array(taskIdSchema).max(64).optional(),
    review: z.array(reviewKindSchema).max(2).optional(),
    resultRef: z.string().min(1).max(512).nullable().optional()
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'an update must change something' })

export const ledgerOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create'), task: taskDraftSchema }).strict(),
  z.object({ op: z.literal('update'), id: taskIdSchema, patch: taskPatchSchema }).strict(),
  /**
   * The blackboard. It travels with the ledger because it has the same rule:
   * exactly one scribe (SDD §2, FR-4.2), and the only way to enforce that is
   * for the write to go through the harness rather than to the file.
   */
  z.object({ op: z.literal('board'), body: z.string().max(100_000) }).strict()
])

export type LedgerOp = z.infer<typeof ledgerOpSchema>

export const ledgerProposalSchema = z
  .object({
    schemaVersion: z.literal(LEDGER_SCHEMA_VERSION),
    ops: z.array(ledgerOpSchema).min(1).max(64)
  })
  .strict()

export type LedgerProposal = z.infer<typeof ledgerProposalSchema>

export type ProposalParse =
  | { readonly ok: true; readonly proposal: LedgerProposal }
  | { readonly ok: false; readonly reason: string }

/**
 * Contract: parses a proposal out of a message body, naming the reason on
 * failure so the refusal Artemis reads says what to fix.
 *
 * The body is JSON written by an LLM, so it is treated as hostile input in the
 * ordinary way: parsed, validated, and refused with a reason — never repaired.
 */
export function parseProposal(body: string): ProposalParse {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch (err) {
    return { ok: false, reason: `body is not valid JSON: ${reason(err)}` }
  }
  const parsed = ledgerProposalSchema.safeParse(raw)
  if (parsed.success) return { ok: true, proposal: parsed.data }
  const issue = parsed.error.issues[0]
  const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'proposal'
  return { ok: false, reason: `${where}: ${issue?.message ?? 'invalid proposal'}` }
}

export interface ApplyContext {
  /** Agent ids with a mailbox — an assignee nobody can reach is refused. */
  readonly knownAgents: readonly string[]
  /** ISO timestamp stamped onto every touched task. */
  readonly at: string
  /** Where this proposal came from, for `task.source` (NFR-13). */
  readonly source: Task['source']
  /** Mints an id for a `create` that did not name one. Injected: no clock here. */
  mintId(index: number): string
}

export interface AppliedOp {
  readonly op: LedgerOp['op']
  readonly taskId: string | null
}

export type ApplyResult =
  | {
      readonly ok: true
      readonly ledger: TaskLedger
      readonly applied: readonly AppliedOp[]
      /** New board body when the proposal wrote one; null when it did not. */
      readonly board: string | null
    }
  | { readonly ok: false; readonly reasons: readonly string[] }

/**
 * Contract: applies a whole proposal, or none of it.
 *
 * All-or-nothing on purpose: a half-applied decomposition is a ledger nobody
 * can reason about, and Artemis's refusal has to be actionable — "these three
 * things are wrong" beats "the first one was wrong, and the rest may or may not
 * have happened". Every reason is collected for the same reason.
 *
 * Pure: the input ledger is never mutated.
 */
export function applyProposal(
  ledger: TaskLedger,
  proposal: LedgerProposal,
  ctx: ApplyContext
): ApplyResult {
  const reasons: string[] = []
  const tasks = new Map(ledger.tasks.map((task) => [task.id, task]))
  const applied: AppliedOp[] = []
  let board: string | null = null

  proposal.ops.forEach((op, index) => {
    if (op.op === 'board') {
      board = op.body
      applied.push({ op: 'board', taskId: null })
      return
    }

    if (op.op === 'create') {
      const id = op.task.id ?? ctx.mintId(index)
      if (tasks.has(id)) {
        reasons.push(`task ${id} already exists`)
        return
      }
      if (op.task.assignee !== null && !ctx.knownAgents.includes(op.task.assignee)) {
        reasons.push(`task ${id}: no mailbox for assignee "${op.task.assignee}"`)
        return
      }
      const created: Task = {
        id,
        title: op.task.title,
        spec: op.task.spec,
        assignee: op.task.assignee,
        status: 'todo',
        priority: op.task.priority ?? 5,
        deps: [...(op.task.deps ?? [])],
        review: [...(op.task.review ?? [])],
        gates: [],
        artifacts: { deck: null, memos: [], resultRef: null },
        source: ctx.source,
        createdAt: ctx.at,
        updatedAt: ctx.at
      }
      tasks.set(id, created)
      applied.push({ op: 'create', taskId: id })
      return
    }

    const existing = tasks.get(op.id)
    if (!existing) {
      reasons.push(`no task ${op.id}`)
      return
    }
    if (
      op.patch.assignee !== undefined &&
      op.patch.assignee !== null &&
      !ctx.knownAgents.includes(op.patch.assignee)
    ) {
      reasons.push(`task ${op.id}: no mailbox for assignee "${op.patch.assignee}"`)
      return
    }
    const next: Task = {
      ...existing,
      ...(op.patch.title === undefined ? {} : { title: op.patch.title }),
      ...(op.patch.spec === undefined ? {} : { spec: op.patch.spec }),
      ...(op.patch.assignee === undefined ? {} : { assignee: op.patch.assignee }),
      ...(op.patch.status === undefined ? {} : { status: op.patch.status }),
      ...(op.patch.priority === undefined ? {} : { priority: op.patch.priority }),
      ...(op.patch.deps === undefined ? {} : { deps: [...op.patch.deps] }),
      ...(op.patch.review === undefined ? {} : { review: [...op.patch.review] }),
      ...(op.patch.resultRef === undefined
        ? {}
        : { artifacts: { ...existing.artifacts, resultRef: op.patch.resultRef } }),
      updatedAt: ctx.at
    }
    if (op.patch.status !== undefined) {
      // SDD §4.2's one guarded transition, checked against the task AS IT WILL
      // BE: a proposal that adds a result ref and closes in the same op must be
      // judged on the closing state, not the opening one.
      const check = checkStatusChange(next, op.patch.status)
      if (!check.allowed) {
        reasons.push(...check.reasons)
        return
      }
    }
    tasks.set(op.id, next)
    applied.push({ op: 'update', taskId: op.id })
  })

  // Dependencies are checked once, at the end: a proposal may legitimately
  // create a task and something that depends on it in the same breath.
  for (const task of tasks.values()) {
    for (const dep of task.deps) {
      if (!tasks.has(dep)) reasons.push(`task ${task.id}: unknown dependency ${dep}`)
    }
  }

  if (reasons.length > 0) return { ok: false, reasons }
  return {
    ok: true,
    ledger: { schemaVersion: TASKS_SCHEMA_VERSION, tasks: [...tasks.values()] },
    applied,
    board
  }
}

/**
 * Contract: how many tasks still owe this agent work (ADR-0013's second
 * branch). Zero for an agent with nothing assigned, and zero for one whose only
 * tasks are blocked, stalled, in review or done.
 */
export function pendingTasksFor(ledger: TaskLedger, agentId: string): number {
  return ledger.tasks.filter(
    (task) => task.assignee === agentId && PENDING_STATUSES.includes(task.status)
  ).length
}

/**
 * Contract: the ledger with every task this agent had *in flight* returned to
 * `todo`, plus the ids that moved. Pure; the input ledger is never mutated.
 *
 * SDD §10's crash row: "ledger tasks back to `todo` with a note". Only
 * `in_progress` moves — a `blocked` task is waiting on something the crash did
 * not change, and `review` is owed to the Odeon rather than to the assignee.
 * The assignee is KEPT: the same row offers a respawn, and an unassigned task
 * would quietly lose the fact that this agent is the one who knows about it.
 */
export function returnTasksOf(
  ledger: TaskLedger,
  agentId: string,
  at: string
): { readonly ledger: TaskLedger; readonly returned: readonly string[] } {
  const returned: string[] = []
  const tasks = ledger.tasks.map((task) => {
    if (task.assignee !== agentId || task.status !== 'in_progress') return task
    returned.push(task.id)
    return { ...task, status: 'todo' as const, updatedAt: at }
  })
  if (returned.length === 0) return { ledger, returned }
  return { ledger: { ...ledger, tasks }, returned }
}

/**
 * Contract: the ledger task a live agent is bound to — the one a gate it opens
 * blocks (SDD §4.2 `gates`) and the one the breaker returns when it stops that
 * agent at rung 3 (ADR-0011). Null when the agent has no work in flight.
 *
 * The join is DERIVED, never remembered. A map from agent to task held in
 * memory would be empty after exactly the event that makes the binding matter
 * most — a restart — and `tasks.json` already records who owes what durably,
 * so this reads the book of record rather than keeping a second copy that
 * could disagree with it (the reasoning invariant §11 applies to spend).
 *
 * `in_progress` outranks `todo`: an agent working one task while another waits
 * in its queue is bound to the one it is working. Within a status the lower
 * priority number wins, ties broken by id, so the answer is STABLE across
 * calls — an unstable binding would let a gate open against one task and
 * settle against another.
 *
 * `blocked`, `review`, `done` and `stalled` are not work in flight — the same
 * reading `PENDING_STATUSES` already encodes.
 */
export function boundTaskFor(ledger: TaskLedger, agentId: string): string | null {
  const bound = ledger.tasks.reduce<Task | null>((best, task) => {
    if (task.assignee !== agentId || !PENDING_STATUSES.includes(task.status)) return best
    return best === null || outranksForBinding(task, best) ? task : best
  }, null)
  return bound === null ? null : bound.id
}

function outranksForBinding(candidate: Task, incumbent: Task): boolean {
  const rank = (task: Task): number => (task.status === 'in_progress' ? 0 : 1)
  if (rank(candidate) !== rank(incumbent)) return rank(candidate) < rank(incumbent)
  if (candidate.priority !== incumbent.priority) return candidate.priority < incumbent.priority
  return candidate.id.localeCompare(incumbent.id) < 0
}

/**
 * Contract: the ledger with one task moved to `stalled`, and whether it moved.
 * Pure; the input ledger is never mutated.
 *
 * This is ADR-0011 rung 3's owed clause: "task returns to the ledger as
 * `stalled` with the breaker report attached". The REPORT does not go into the
 * task — `taskSchema` is strict and has no notes field, and widening a
 * normative schema to carry a breaker trip would be a §8 deviation. It goes to
 * `log.jsonl` as the `task`/`stalled` event: the same split `returnTasksOf`
 * already makes for SDD §10's crash note, and what NFR-13 asks for — the
 * action reconstructible from the book of record.
 *
 * Only work in flight stalls. Stalling a `done` task would rewrite history,
 * and a `blocked` one is already waiting on something the breaker did not
 * cause.
 */
export function stallTask(
  ledger: TaskLedger,
  taskId: string,
  at: string
): { readonly ledger: TaskLedger; readonly stalled: boolean } {
  let stalled = false
  const tasks = ledger.tasks.map((task) => {
    if (task.id !== taskId || !PENDING_STATUSES.includes(task.status)) return task
    stalled = true
    return { ...task, status: 'stalled' as const, updatedAt: at }
  })
  return stalled ? { ledger: { ...ledger, tasks }, stalled } : { ledger, stalled }
}
/**
 * Contract: the ledger with `gateId` recorded against `taskId` (or removed).
 *
 * SDD §4.2's `gates` field has existed since M2 and nothing ever wrote it, so
 * "the harness refuses `→ done` while a gate is open" protected nothing. The
 * Watch feeds it from M3.
 */
export function withGate(
  ledger: TaskLedger,
  taskId: string,
  gateId: string,
  open: boolean
): TaskLedger {
  return {
    ...ledger,
    tasks: ledger.tasks.map((task) => {
      if (task.id !== taskId) return task
      const gates = open
        ? task.gates.includes(gateId)
          ? task.gates
          : [...task.gates, gateId]
        : task.gates.filter((id) => id !== gateId)
      return gates === task.gates ? task : { ...task, gates }
    })
  }
}

/** Contract: the tasks a kanban column holds, in priority then id order. */
export function tasksByStatus(ledger: TaskLedger, status: Task['status']): readonly Task[] {
  return ledger.tasks
    .filter((task) => task.status === status)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
}

/** Contract: whether this task can be closed right now, and why not. */
export { canCloseTask }

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

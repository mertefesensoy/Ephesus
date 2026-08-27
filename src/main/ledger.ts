import { randomBytes } from 'node:crypto'
import {
  applyProposal,
  parseProposal,
  pendingTasksFor,
  withGate,
  type AppliedOp
} from '../shared/ledger'
import type { Message } from '../shared/message'
import { emptyLedger, type Task, type TaskLedger } from '../shared/tasks'

/**
 * The ledger endpoint (SDD §7.1, FR-5.2).
 *
 * "Agents never touch `tasks.json`." Artemis proposes; this validates and
 * writes through the single committer (ADR-0004). That split is the whole
 * design: **main validates and executes, Artemis decides.** Nothing here has an
 * opinion about what a good decomposition looks like, who should get a task, or
 * when one is finished — only about whether a proposal is well-formed and legal
 * against the ledger as it stands.
 *
 * The rules it enforces come from documents, not from taste: SDD §4.2's guarded
 * `→ done` transition, its `gates` field, and FR-4.2's single scribe.
 */

/** What the endpoint owns: the ledger file and the board, through the Agora. */
export interface LedgerStore {
  tasks(): TaskLedger
  writeTasks(ledger: TaskLedger): void
  board(): string
  writeBoard(body: string): void
  commitSoon(subject: string): void
}

export interface LedgerEndpointOptions {
  readonly store: LedgerStore
  /** Agent ids with a mailbox — an assignee nobody can reach is refused. */
  knownAgents(): readonly string[]
  /** `log` kind `task` (SDD §4.3): every accepted op, and every refusal. */
  onLogEvent?(draft: { kind: 'task' } & Record<string, unknown>): void
  /** Raised when the ledger changed, so the kanban can re-read (`state:tasks`). */
  onChange?(): void
  /** Reported when the ledger file itself will not read (invariant §7). */
  onDegraded?(detail: string): void
  now?(): Date
}

export type SubmitOutcome =
  | { readonly ok: true; readonly applied: readonly AppliedOp[] }
  | { readonly ok: false; readonly reasons: readonly string[] }

export class LedgerEndpoint {
  private readonly now: () => Date

  constructor(private readonly options: LedgerEndpointOptions) {
    this.now = options.now ?? (() => new Date())
  }

  /** The ledger as the kanban and `pendingTasksFor` see it. */
  tasks(): TaskLedger {
    try {
      return this.options.store.tasks()
    } catch (err) {
      // A corrupt ledger is a visible degradation, never a silent empty board:
      // "no tasks" and "we cannot read the tasks" are different facts.
      this.options.onDegraded?.(`tasks.json unreadable — ${reason(err)}`)
      return emptyLedger
    }
  }

  board(): string {
    return this.options.store.board()
  }

  /**
   * ADR-0013's second branch, real at last (the M2 carried item). Through M2
   * this was hardcoded to 0, so a Stop hook only ever continued an agent that
   * had *mail* — an agent with three assigned tasks and an empty inbox stopped.
   */
  pendingFor(agentId: string): number {
    return pendingTasksFor(this.tasks(), agentId)
  }

  /**
   * Applies one `propose` message from the orchestrator.
   *
   * Contract: all-or-nothing. A proposal that fails any check writes nothing
   * and comes back with every reason, so the refusal Artemis reads is
   * actionable in one pass.
   *
   * The writer check is NOT here — it is in `routeMessage`, because ADR-0003
   * calls the addressing rules transport rules. By the time a message reaches
   * this method the router has already established that the orchestrator sent
   * it.
   */
  submit(message: Message): SubmitOutcome {
    const parsed = parseProposal(message.body)
    if (!parsed.ok) return this.refuse(message, [parsed.reason])

    const at = this.now().toISOString()
    const result = applyProposal(this.tasks(), parsed.proposal, {
      knownAgents: this.options.knownAgents(),
      at,
      // NFR-13: every task can be traced back to the message that asked for it.
      source: { kind: 'propose', via: 'hermes', log: `msg#${message.id}` },
      mintId: (index) => this.mintId(index)
    })
    if (!result.ok) return this.refuse(message, result.reasons)

    this.options.store.writeTasks(result.ledger)
    if (result.board !== null) this.options.store.writeBoard(result.board)
    this.options.store.commitSoon(`ledger: ${result.applied.length} op(s) from ${message.from}`)

    for (const op of result.applied) {
      this.options.onLogEvent?.({
        kind: 'task',
        event: op.op,
        taskId: op.taskId,
        by: message.from,
        msgId: message.id,
        ...(op.taskId === null
          ? {}
          : { assignee: findTask(result.ledger, op.taskId)?.assignee ?? null })
      })
    }
    this.options.onChange?.()
    return { ok: true, applied: result.applied }
  }

  /**
   * Records an open Watch gate against a task, or clears it (SDD §4.2 `gates`).
   *
   * The field has existed since M2 with nothing writing it, so the rule "the
   * harness refuses `→ done` while `gates` is non-empty" guarded nothing. This
   * is what makes it real.
   */
  noteGate(taskId: string, gateId: string, open: boolean): void {
    const before = this.tasks()
    const after = withGate(before, taskId, gateId, open)
    if (after === before || sameGates(before, after)) return
    this.options.store.writeTasks(after)
    this.options.store.commitSoon(`ledger: gate ${gateId} ${open ? 'opened' : 'settled'}`)
    this.options.onLogEvent?.({
      kind: 'task',
      event: open ? 'gate-opened' : 'gate-settled',
      taskId,
      gateId
    })
    this.options.onChange?.()
  }

  private refuse(message: Message, reasons: readonly string[]): SubmitOutcome {
    this.options.onLogEvent?.({
      kind: 'task',
      event: 'refused',
      by: message.from,
      msgId: message.id,
      reasons: [...reasons]
    })
    return { ok: false, reasons }
  }

  /**
   * `t-<date>-<random>` per SDD §4.2's example shape. Random rather than a
   * counter: two proposals in flight would otherwise mint the same id, and a
   * counter read from the ledger is a read-modify-write nobody holds a lock on.
   */
  private mintId(index: number): string {
    const day = this.now().toISOString().slice(0, 10)
    return `t-${day}-${randomBytes(3).toString('hex')}${index.toString(36)}`
  }
}

function findTask(ledger: TaskLedger, taskId: string): Task | undefined {
  return ledger.tasks.find((task) => task.id === taskId)
}

function sameGates(a: TaskLedger, b: TaskLedger): boolean {
  return a.tasks.every((task, index) => {
    const other = b.tasks[index]
    return other !== undefined && task.gates.join(',') === other.gates.join(',')
  })
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

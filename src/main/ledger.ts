import { randomBytes } from 'node:crypto'
import type { BreakerReport } from '../shared/breaker'
import {
  applyProposal,
  boundTaskFor as findBoundTask,
  parseProposal,
  pendingTasksFor,
  returnTasksOf,
  stallTask,
  withDeck,
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

  /**
   * The ledger task a live agent is bound to (M5.1).
   *
   * Contract: the id, or null when the agent has nothing in flight. This is
   * the join the gate choke points and the breaker were missing — without it
   * every production `GateSubmission` carried `taskId: null`, so SDD §4.2's
   * `gates` field was never written outside tests and the `status → done`
   * guard that reads it guarded nothing in the shipped app.
   */
  boundTaskFor(agentId: string): string | null {
    return findBoundTask(this.tasks(), agentId)
  }

  /**
   * Records an archived deck against its task (FR-7.2).
   *
   * The Odeon wrote the artifact; this makes the ledger agree, which is what
   * `canCloseTask` reads. Splitting it this way keeps `tasks.json` behind one
   * writer — the Odeon never edits the ledger, it asks.
   */
  noteDeck(taskId: string, deckRef: string): void {
    const before = this.tasks()
    const { ledger, recorded } = withDeck(before, taskId, deckRef, this.now().toISOString())
    if (!recorded) return
    this.options.store.writeTasks(ledger)
    this.options.store.commitSoon(`ledger: deck recorded for ${taskId}`)
    this.options.onLogEvent?.({ kind: 'task', event: 'deck-recorded', taskId, deckRef })
    this.options.onChange?.()
  }

  /**
   * ADR-0011 rung 3: the breaker stopped this agent, so the work it was doing
   * goes back to the ledger as `stalled`, carrying why.
   *
   * Contract: returns the task that stalled, or null when the agent had none
   * in flight — tripping the breaker on an unassigned agent is ordinary, not
   * an error. The report goes to `log.jsonl`, never into the task; see
   * `stallTask` for why a strict normative schema is not widened to hold it.
   */
  stallTaskOf(agentId: string, report: BreakerReport): string | null {
    const before = this.tasks()
    const taskId = findBoundTask(before, agentId)
    if (taskId === null) return null
    const { ledger, stalled } = stallTask(before, taskId, this.now().toISOString())
    if (!stalled) return null
    this.options.store.writeTasks(ledger)
    this.options.store.commitSoon(`ledger: ${taskId} stalled by the breaker`)
    this.options.onLogEvent?.({
      kind: 'task',
      event: 'stalled',
      taskId,
      assignee: agentId,
      because: 'breaker',
      rung: report.rung,
      // The trip, reconstructible after the fact (NFR-13).
      signals: report.signals.map((hit) => hit.signal),
      detail: report.signals.map((hit) => hit.detail)
    })
    this.options.onChange?.()
    return taskId
  }

  /**
   * Returns a dead agent's in-flight tasks to `todo` (SDD §10's crash row).
   *
   * Contract: returns the ids that moved, so the caller can put them in the
   * respawn offer. The *note* SDD §10 asks for goes to `log.jsonl` and not into
   * the task: `taskSchema` is strict and has no notes field, and widening a
   * normative schema to record a crash would be a §8 deviation. The book of
   * record is where every other harness fact about an agent already lives, and
   * NFR-13 asks for exactly this — the action reconstructible from the log.
   *
   * This is the crash path, not the breaker's: it returns EVERY task the dead
   * agent had in flight to `todo`, because a process that died tells us
   * nothing about which one it was on. `stallTaskOf` above is the deliberate
   * counterpart — the breaker knows exactly which task it stopped, so it
   * stalls that one and leaves the rest alone.
   */
  returnTasksOf(agentId: string, because: string): readonly string[] {
    const at = this.now().toISOString()
    const { ledger, returned } = returnTasksOf(this.tasks(), agentId, at)
    if (returned.length === 0) return returned
    this.options.store.writeTasks(ledger)
    this.options.store.commitSoon(`ledger: ${returned.length} task(s) returned by ${agentId}`)
    for (const taskId of returned) {
      this.options.onLogEvent?.({
        kind: 'task',
        event: 'returned',
        taskId,
        assignee: agentId,
        from: 'in_progress',
        to: 'todo',
        because
      })
    }
    this.options.onChange?.()
    return returned
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

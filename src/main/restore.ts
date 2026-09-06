import type { GatesRecord, OpenGate } from '../shared/gates'
import { reconcileGates } from '../shared/gates'
import type { DraftsRecord } from '../shared/outbound'
import type { ActivationsRecord } from '../shared/profile-activation'
import type { TriggersRecord } from '../shared/restart'
import type { ProfileInstance } from './profiles'
import type { StateLoad, StateStore } from './state-store'

/**
 * The boot replay: what the company gets back when the process it was running
 * in went away (M8.8, NFR-5, SRS §6 criterion 6).
 *
 * ## Why this is a module and not five lines in `boot()`
 *
 * The durable records are per-subsystem — each owns its own file, its own
 * schema and its own write-down point, following the M8.6 breaker-stop
 * precedent. What no store can own is the ORDER they come back in and what
 * happens when one of them cannot be read. Left inline in `index.ts` that
 * order would be four statements whose sequence matters and whose reason for
 * mattering is in nobody's head; here it is one function with the reason
 * written beside it.
 *
 * ## The order, and why each step is where it is
 *
 * 1. **Triggers first.** `Scheduler.add` consults the restored clock, so
 *    seeding it before activations arm anything means a restored trigger is
 *    not due the instant it comes back. The scheduler holds the clock
 *    separately from the registration precisely so this is a preference and
 *    not a hard ordering rule — but preferring the safe order costs nothing.
 * 2. **Activations.** Puts each instance back with its crew down, which makes
 *    `planFor` answer again: tool grants (M8.7b) and composed autonomy (M7.2)
 *    work for a rehired agent, and `watchedRepos` sees the instance so the
 *    Harbor resumes ingesting.
 * 3. **Gates**, then reconciled against the durable blocks in `tasks.json`.
 *
 * ## It never throws, and it never half-reports
 *
 * Boot runs before the window exists, so a throw here is a dead app rather
 * than a degraded one (FR-5.4). Every store is loaded independently: one
 * damaged record costs its own subsystem and nothing else, and each failure
 * comes back as a `RestoreProblem` for the caller to route to the degradation
 * channel (invariant §7). A restore that silently did less than it claimed
 * would be this codebase's recurring defect — a check that cannot fail — in
 * the one place nobody would look.
 */

/**
 * Contract: the live set as the durable record holds it — a deep copy, so the
 * bytes on disk cannot change under a caller that keeps mutating the original.
 *
 * One function for a conversion that happens in two places (the boot wiring and
 * the scenario that proves it), because the cast it contains needs a reason and
 * a reason written twice is a reason nobody maintains. The cast is the readonly
 * one and nothing more: `ProfileInstance` declares `readonly` arrays throughout
 * while the schema infers mutable ones, and `structuredClone` preserves the
 * modifier in the type though not in the value it actually returns.
 */
export function activationsRecord(instances: readonly ProfileInstance[]): ActivationsRecord {
  return {
    schemaVersion: 1,
    instances: instances.map(
      (instance) => structuredClone(instance) as ActivationsRecord['instances'][number]
    )
  }
}

/** What the reconcile needs off the Agora, and nothing more. */
export interface LedgerSource {
  tasks(): { readonly tasks: readonly { readonly id: string; readonly gates: readonly string[] }[] }
  fileWarnings(): readonly { readonly file: string }[]
}

/**
 * Contract: the durable blocks, or null when the ledger could not be READ.
 *
 * The distinction this exists to preserve, and the reason it is a function
 * rather than two lines in `index.ts`: **`Agora.tasks()` does not throw on a
 * corrupt ledger.** It returns the empty one and records the file in
 * `fileWarnings()` — deliberately, so a bad file is never destroyed by being
 * treated as an error. A caller that wrapped it in try/catch would therefore
 * never see a failure, would read "no blocks" off an unreadable file, and would
 * report zero orphans: silence in exactly the place this milestone exists to
 * remove.
 *
 * ABSENT is not unreadable. A first run has no ledger and therefore genuinely
 * has no blocks — that is true, not unknown, and must not be reported.
 */
export function blockedTasksFrom(
  agora: LedgerSource,
  tasksRel: string
): { readonly id: string; readonly gates: readonly string[] }[] | null {
  const ledger = agora.tasks()
  if (agora.fileWarnings().some((warning) => warning.file === tasksRel)) return null
  return ledger.tasks.map((task) => ({ id: task.id, gates: task.gates }))
}

/** One thing that did not come back, with the consequence stated. */
export interface RestoreProblem {
  /** The degradation cause, `<source>/<slug>` (M8.2). */
  readonly cause: string
  /** A whole sentence: what was lost, and what follows from losing it. */
  readonly detail: string
}

export interface RestoreReport {
  /** One sentence per thing restored, for the console and the log. */
  readonly notes: readonly string[]
  readonly problems: readonly RestoreProblem[]
  readonly counts: {
    readonly instances: number
    readonly triggers: number
    readonly openGates: number
    readonly settledGates: number
    readonly orphanBlocks: number
    readonly staleGates: number
    readonly drafts: number
    readonly draftlessGates: number
  }
}

export interface RestoreTargets {
  /** Seeds the last-fired clock. Returns how many ids were taken. */
  restoreTriggers(lastFired: Readonly<Record<string, number>>): number
  /** Puts instances back with their crews down. Returns one note each. */
  restoreActivations(record: ActivationsRecord): readonly string[]
  /**
   * Puts filed outbound drafts back (ADR-0030). Returns how many came back and
   * how many are still waiting at a gate.
   */
  restoreDrafts(record: DraftsRecord): { readonly filed: number; readonly held: number }
  /** Gate ids that have a draft to post. Read AFTER `restoreDrafts`. */
  gatesHoldingADraft(): readonly string[]
  /** Puts held gates and settled verdicts back. */
  restoreGates(record: GatesRecord): { readonly open: number; readonly settled: number }
  /** The gates now held, for the reconcile against `tasks.json`. */
  openGates(): readonly OpenGate[]
  /**
   * The durable blocks. Read through a function because `tasks.json` is the
   * Agora's and may legitimately be absent on a first run; a throw here must
   * not cost the whole replay, so the caller returns null and says why.
   */
  blockedTasks(): { readonly id: string; readonly gates: readonly string[] }[] | null
}

export interface RestoreStores {
  readonly triggers: StateStore<TriggersRecord>
  readonly activations: StateStore<ActivationsRecord>
  readonly gates: StateStore<GatesRecord>
  readonly drafts: StateStore<DraftsRecord>
}

export function restoreCompany(stores: RestoreStores, targets: RestoreTargets): RestoreReport {
  const notes: string[] = []
  const problems: RestoreProblem[] = []
  const counts = {
    instances: 0,
    triggers: 0,
    openGates: 0,
    settledGates: 0,
    orphanBlocks: 0,
    staleGates: 0,
    drafts: 0,
    draftlessGates: 0
  }

  // 1. Triggers. A damaged clock is not a reason to skip the rest; the
  //    consequence is bounded and it is stated.
  const triggers = read(stores.triggers.load(), problems, {
    cause: 'restart/triggers-unreadable',
    consequence:
      'every restored trigger is due immediately, so a scheduled job may run again sooner than its interval'
  })
  if (triggers?.seeded === true) {
    counts.triggers = targets.restoreTriggers(triggers.value.lastFired)
    if (counts.triggers > 0) {
      notes.push(`restored the last-fired clock for ${String(counts.triggers)} trigger(s)`)
    }
  }

  // 2. Activations. This is what makes `planFor` answer again.
  const activations = read(stores.activations.load(), problems, {
    cause: 'restart/activations-unreadable',
    consequence:
      'the company comes back un-hired: no mission is active, the Harbor watches nothing, and profile autonomy composes into no gate until a profile is activated again'
  })
  if (activations?.seeded === true) {
    const restored = targets.restoreActivations(activations.value)
    counts.instances = restored.length
    notes.push(...restored)
  }

  // 3. Gates, then the reconcile. Last, because the reconcile needs the gates
  //    that step 3 restored AND the ones boot may have opened before this ran.
  const gates = read(stores.gates.load(), problems, {
    cause: 'restart/gates-unreadable',
    consequence:
      'no block is released, but the approvals queue is empty while tasks.json still says those tasks are held — they cannot reach done until the record is repaired'
  })
  if (gates?.seeded === true) {
    const restored = targets.restoreGates(gates.value)
    counts.openGates = restored.open
    counts.settledGates = restored.settled
    if (restored.open > 0 || restored.settled > 0) {
      notes.push(
        `restored ${String(restored.open)} open gate(s) and ${String(restored.settled)} settled verdict(s)`
      )
    }
  }

  // 4. Outbound drafts, then the gates that hold none.
  //
  //    After the gates, because the check is a reconcile between the two: a
  //    restored `outbound` gate whose draft did not come back is a gate the
  //    Architect can approve into nothing. That is the failure ADR-0030 closes,
  //    and it is REPORTED rather than settled for the same reason an orphan
  //    block is — auto-denying it would drop the agent's words on the harness's
  //    own authority, and auto-approving it would publish a comment nobody can
  //    read (NFR-9).
  const drafts = read(stores.drafts.load(), problems, {
    cause: 'restart/drafts-unreadable',
    consequence:
      'any outbound gate still open holds no words, so approving it would post nothing — deny those gates and ask the agent to draft again'
  })
  if (drafts?.seeded === true) {
    const restored = targets.restoreDrafts(drafts.value)
    counts.drafts = restored.filed
    if (restored.filed > 0) {
      notes.push(
        `restored ${String(restored.filed)} filed draft(s), ${String(restored.held)} still waiting at a gate`
      )
    }
  }
  const withDrafts = new Set(targets.gatesHoldingADraft())
  const draftless = targets
    .openGates()
    .filter((gate) => gate.kind === 'outbound' && !withDrafts.has(gate.id))
  counts.draftlessGates = draftless.length
  for (const gate of draftless) {
    problems.push({
      cause: `restart/draftless-gate:${gate.id}`,
      detail:
        `outbound gate ${gate.id} came back without the draft it was holding, so approving it would ` +
        'post nothing — deny it and ask the agent to draft the comment again'
    })
  }

  const tasks = targets.blockedTasks()
  if (tasks === null) {
    problems.push({
      cause: 'restart/tasks-unreadable',
      detail:
        'the task ledger could not be read, so a block whose gate did not come back would not be noticed — a task could be held by a gate that is in no queue'
    })
  } else {
    const settled = gates?.seeded === true ? gates.value.settled : []
    const { orphans, stale } = reconcileGates(targets.openGates(), settled, tasks)
    counts.orphanBlocks = orphans.length
    counts.staleGates = stale.length
    for (const orphan of orphans) {
      problems.push({
        cause: `restart/orphan-block:${orphan.taskId}`,
        detail:
          `task ${orphan.taskId} is blocked by gate ${orphan.gateId}, which came back from no record — ` +
          'it cannot reach done, and nothing in the approvals queue explains why'
      })
    }
    if (stale.length > 0) {
      notes.push(
        `${String(stale.length)} restored gate(s) hold no task any more and were left in the queue for the Architect to close`
      )
    }
  }

  return { notes, problems, counts }
}

/**
 * Reads one store, turning a damaged record into a stated problem rather than
 * a throw or a silent empty.
 *
 * The distinction this preserves is the one that matters: an ABSENT file is an
 * ordinary first run and says nothing; a DAMAGED one means state exists that
 * can no longer be read, and the caller has a different, disclosed response to
 * each. Collapsing them is how a restart that restored nothing looks healthy.
 */
function read<T>(
  load: StateLoad<T>,
  problems: RestoreProblem[],
  failure: { readonly cause: string; readonly consequence: string }
): { readonly value: T; readonly seeded: boolean } | null {
  if (load.ok) return { value: load.value, seeded: load.seeded }
  problems.push({ cause: failure.cause, detail: `${load.because} — ${failure.consequence}` })
  return null
}

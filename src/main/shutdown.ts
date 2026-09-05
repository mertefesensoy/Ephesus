/**
 * The quit sequence (M8.1) — what has to happen, in what order, before Ephesus
 * is allowed to exit.
 *
 * ## Why this is a module and not a function in `index.ts`
 *
 * SDD §1.1 gives `index.ts` boot and wiring and says it "holds no logic of its
 * own". The quit path was logic: an offer, a protocol, an unwind, nine stops
 * and a drain, in an order that matters — written inline, twice (the branch for
 * "no agent manager" duplicated the whole tail), reachable by no test. There is
 * no Electron in the test runner (BUILD-PROMPT §10.3) and no Playwright in this
 * repository, so a scenario could not drive it at all. What S-CLOSING drove
 * instead was a *copy* of production's closing wiring in the rig, and the copy
 * omitted the one line that threw — which is why the suite was green against a
 * protocol that had never once run.
 *
 * So the sequence lives here, takes its collaborators as seams, and both
 * `index.ts` and the scenario rig run this same object. A rig can still lie
 * about a leaf (a fake engine, a temp home, a window it destroys on purpose),
 * but it can no longer lie about the sequence.
 *
 * ## The ordering, and why each edge is load-bearing
 *
 * 1. **Closing Time first** (GYM-003, SDD §612): agents can only park their
 *    work while they are still alive. Everything below kills them.
 * 2. **Agent unwind next**: settings files the harness wrote into the
 *    Architect's repositories are restored, worktrees released and tokens
 *    revoked (ADR-0009) — before the PTYs die, or the processes go away with
 *    the harness's edits still in their checkouts.
 * 3. **The stops last**, in the caller's order, ending with the Agora drained
 *    and the database closed: a commit still in flight is data the book of
 *    record has not got yet (ADR-0004).
 *
 * ## Every phase is isolated, because that is the same bug one level up
 *
 * `AgentManager.shutdown` used to be `for (const id of ...) await unwind(id)`
 * with no `try`, so the first agent that threw took the rest of the company
 * with it. A quit sequence that stopped at its first failing phase would repeat
 * exactly that mistake with bigger pieces. Here a phase that throws is
 * recorded, reported and stepped over: a closing protocol that cannot start
 * must not prevent agents from unwinding, and an agent that cannot unwind must
 * not leave the PTYs running and the database open.
 *
 * ## Idempotent by construction
 *
 * `run()` returns the same promise however many times it is called. Electron
 * fires `before-quit` again for the quit that ends the sequence, and a second
 * pass that re-ran closing time would mail every agent a second request and
 * wait out the deadline again.
 */

import type { DegradationCause } from '../shared/degradation'

/** One thing that must be stopped, named so a failure can say which. */
export interface QuitStep {
  readonly name: string
  run(): void | Promise<void>
}

/** What Closing Time reports back (`ClosingReport` satisfies it structurally). */
export interface ClosingOutcome {
  readonly acked: readonly string[]
  readonly missing: readonly string[]
  readonly timedOut: boolean
}

/** The slice of `ClosingTime` this sequence uses. */
export interface ClosingSeam {
  inProgress(): boolean
  begin(): Promise<ClosingOutcome>
}

/** What `AgentManager.shutdown` reports back; structural, so no import. */
export interface AgentsOutcome {
  readonly unwound: readonly string[]
  readonly failed: readonly { readonly agentId: string; readonly error: string }[]
}

/** The slice of `AgentManager` this sequence uses. */
export interface AgentsSeam {
  shutdown(): Promise<AgentsOutcome>
}

/** The Architect's answer to the closing-time offer. */
export type ClosingChoice = 'closing' | 'now'

export interface QuitSequenceOptions {
  /**
   * Who is still working. An empty floor skips the offer entirely — SDD §612's
   * "an empty floor skips straight to teardown".
   */
  liveAgents(): readonly string[]
  /**
   * Puts the offer to the Architect. The Electron dialog stays in `index.ts`:
   * this seam is what makes the sequence runnable without a window, and what
   * lets a test answer "closing" or "now" without one.
   */
  ask(liveAgents: readonly string[]): Promise<ClosingChoice> | ClosingChoice
  /** Read at run time: the company may not have finished booting. */
  closing(): ClosingSeam | null
  agents(): AgentsSeam | null
  /**
   * Disarmed BEFORE the agent unwind, in the order given (M8.7).
   *
   * The respawn ladders belong here and nowhere else. `steps()` runs AFTER the
   * unwind, so a ladder stopped there is armed while the unwind kills the very
   * agents it watches — it reads those kills as crashes and brings the company
   * back up as it is being torn down. M8.6 put `crew.stop()` in `steps()` with
   * a comment claiming it ran first; it did not.
   *
   * Isolated exactly as `steps` is: one that throws is reported and stepped
   * over, because a ladder that will not disarm must not stop the unwind.
   */
  disarm?(): readonly QuitStep[]
  /** Stops, in the order they must happen. Read at run time for the same reason. */
  steps(): readonly QuitStep[]
  /** Visible degradation (invariant §7). Never throws back into the sequence. */
  onDegraded(cause: DegradationCause, detail: string): void
}

export interface StepOutcome {
  readonly name: string
  readonly ok: boolean
  readonly error?: string
}

/** What happened, in enough detail for a log line and for a test to assert on. */
export interface QuitReport {
  /** Whether the Architect was asked (a floor with nobody on it is not). */
  readonly offered: boolean
  readonly choice: ClosingChoice | null
  readonly closing: ClosingOutcome | null
  /** Set when closing time was chosen and could not run. */
  readonly closingError: string | null
  readonly agentsUnwound: readonly string[]
  readonly agentsFailed: readonly string[]
  readonly agentsError: string | null
  /** What the pre-unwind disarm did (M8.7). */
  readonly disarmed: readonly StepOutcome[]
  readonly steps: readonly StepOutcome[]
}

export class QuitSequence {
  private started: Promise<QuitReport> | null = null
  private finished = false

  constructor(private readonly options: QuitSequenceOptions) {}

  /** True from the moment `run()` is first called. */
  hasStarted(): boolean {
    return this.started !== null
  }

  /** True once the sequence has run to completion — the app may exit. */
  hasFinished(): boolean {
    return this.finished
  }

  /** Contract: runs the sequence at most once; later calls await the first. */
  run(): Promise<QuitReport> {
    this.started ??= this.execute().then((report) => {
      this.finished = true
      return report
    })
    return this.started
  }

  private async execute(): Promise<QuitReport> {
    const closingPhase = await this.runClosing()
    // Before the unwind, and this time actually before it: the ladders must be
    // disarmed while the agents they watch are still alive, or the unwind's own
    // kills are read as crashes.
    const disarmed = await this.runPhase(this.disarmSteps(), 'disarm')
    const agentsPhase = await this.runAgents()
    const steps = await this.runSteps()
    return { ...closingPhase, ...agentsPhase, disarmed, steps }
  }

  private async runClosing(): Promise<
    Pick<QuitReport, 'offered' | 'choice' | 'closing' | 'closingError'>
  > {
    const idle = { offered: false, choice: null, closing: null, closingError: null } as const
    let live: readonly string[]
    try {
      live = this.options.liveAgents()
    } catch (err) {
      // Asking who is live must never be the reason a quit stalls.
      this.options.onDegraded('shutdown/live-agents', `could not list live agents: ${detail(err)}`)
      return idle
    }
    const closing = this.options.closing()
    if (closing === null || live.length === 0) return idle
    // Already running (the Architect chose closing time, then quit again):
    // the protocol owns its own deadline, so do not start a second one.
    if (closing.inProgress()) return idle

    let choice: ClosingChoice
    try {
      choice = await this.options.ask(live)
    } catch (err) {
      this.options.onDegraded('shutdown/offer', `closing time was not offered: ${detail(err)}`)
      return idle
    }
    if (choice !== 'closing') return { offered: true, choice, closing: null, closingError: null }

    try {
      const report = await closing.begin()
      if (report.missing.length > 0) {
        this.options.onDegraded(
          'shutdown/closing-acks',
          `closing time: no acknowledgment from ${report.missing.join(', ')} by the deadline`
        )
      }
      return { offered: true, choice, closing: report, closingError: null }
    } catch (err) {
      const message = detail(err)
      this.options.onDegraded('shutdown/closing-time', `closing time failed: ${message}`)
      return { offered: true, choice, closing: null, closingError: message }
    }
  }

  private async runAgents(): Promise<
    Pick<QuitReport, 'agentsUnwound' | 'agentsFailed' | 'agentsError'>
  > {
    const agents = this.options.agents()
    if (agents === null) return { agentsUnwound: [], agentsFailed: [], agentsError: null }
    try {
      const report = await agents.shutdown()
      // Deliberately NOT re-reported here: `AgentManager.shutdown` already puts
      // every per-agent failure through its own `onExitError` seam, which is
      // the visible degradation channel (invariant §7), and the same failure
      // arriving twice in the Architect's health list reads as two faults.
      // They stay in this report so the quit summary and a test can see them.
      return {
        agentsUnwound: report.unwound,
        agentsFailed: report.failed.map((failure) => failure.agentId),
        agentsError: null
      }
    } catch (err) {
      // `shutdown` isolates each agent itself; reaching here means the loop as a
      // whole failed, and the stops below still have to run.
      const message = detail(err)
      this.options.onDegraded('agents/shutdown', `shutdown failed: ${message}`)
      return { agentsUnwound: [], agentsFailed: [], agentsError: message }
    }
  }

  /** The ladders to disarm, or none — asking must never be why a quit stalls. */
  private disarmSteps(): readonly QuitStep[] {
    try {
      return this.options.disarm?.() ?? []
    } catch (err) {
      this.options.onDegraded('shutdown/disarm', `could not assemble the disarm: ${detail(err)}`)
      return []
    }
  }

  private async runSteps(): Promise<readonly StepOutcome[]> {
    let steps: readonly QuitStep[]
    try {
      steps = this.options.steps()
    } catch (err) {
      this.options.onDegraded('shutdown/steps', `could not assemble the teardown: ${detail(err)}`)
      return []
    }
    return this.runPhase(steps, 'stop')
  }

  /** One isolated phase: every step runs, a failure is reported and stepped over. */
  private async runPhase(
    steps: readonly QuitStep[],
    kind: 'disarm' | 'stop'
  ): Promise<readonly StepOutcome[]> {
    const outcomes: StepOutcome[] = []
    for (const step of steps) {
      try {
        await step.run()
        outcomes.push({ name: step.name, ok: true })
      } catch (err) {
        const message = detail(err)
        this.options.onDegraded(`shutdown/${kind}:${step.name}`, `${step.name}: ${message}`)
        outcomes.push({ name: step.name, ok: false, error: message })
      }
    }
    return outcomes
  }
}

function detail(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** One line for `log.jsonl` and the console: what the quit actually did. */
export function summarizeQuit(report: QuitReport): string {
  const parts: string[] = []
  parts.push(
    report.offered
      ? `closing time ${report.choice === 'closing' ? 'run' : 'declined'}`
      : 'no live agents'
  )
  if (report.closing !== null) {
    parts.push(`acked ${String(report.closing.acked.length)}`)
    if (report.closing.missing.length > 0) parts.push(`silent ${report.closing.missing.join(', ')}`)
  }
  if (report.closingError !== null) parts.push(`closing failed: ${report.closingError}`)
  parts.push(`unwound ${String(report.agentsUnwound.length)}`)
  if (report.agentsFailed.length > 0) parts.push(`unwind failed: ${report.agentsFailed.join(', ')}`)
  if (report.agentsError !== null) parts.push(`shutdown failed: ${report.agentsError}`)
  const failedSteps = report.steps.filter((step) => !step.ok).map((step) => step.name)
  parts.push(
    `${String(report.steps.length - failedSteps.length)}/${String(report.steps.length)} stops`
  )
  if (failedSteps.length > 0) parts.push(`stops failed: ${failedSteps.join(', ')}`)
  return parts.join('; ')
}

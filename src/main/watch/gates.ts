import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import {
  composeAutonomy,
  denyAllPolicy,
  evaluateGate,
  GATE_SCHEMA_VERSION,
  openGateSchema,
  parseGatePolicy,
  type GateDecision,
  type GatePackaging,
  type GatePolicy,
  type GateRequest,
  type GateVerdict,
  type OpenGate,
  type SourceChannel
} from '../../shared/gates'

/**
 * The approval queue and its policy (SDD §9, FR-11.1, UC-08).
 *
 * The division of labour is the point. `src/shared/gates.ts` decides *whether*
 * an action is permitted — pure, table-testable, no clock, no state. This class
 * owns *what happens when it is not*: an open gate with the UC-08 packaging
 * attached, a verdict the Architect eventually returns, and the log entries
 * that let the whole chain be reconstructed from `log.jsonl` alone (NFR-13).
 *
 * No prose lives here. Every word an agent or the Architect reads about a held
 * action is rendered from `prompts/` by the caller (invariant §8); a gate
 * carries a machine-readable `because` and the agent's own packaging.
 */

export interface GateManagerOptions {
  /** The composed policy. Read fresh so a policy edit takes effect at once. */
  policy(): GatePolicy
  /**
   * `log` kind `gate` (SDD §4.3) — every open and every verdict. Injected so
   * the manager stays testable without an Agora on disk.
   */
  onLogEvent?(draft: { kind: 'gate' } & Record<string, unknown>): void
  /** Pushed to the renderer as `gate:open` (SDD §5). */
  onOpen?(gate: OpenGate): void
  /** Fired when a gate is settled, so the UI and the avatar can follow. */
  onSettled?(gate: OpenGate, verdict: GateVerdict): void
  /** Injected for deterministic ids and timestamps in tests. */
  now?(): Date
}

/** What a caller asks for when it needs an action gated. */
export interface GateSubmission extends GateRequest {
  readonly packaging: GatePackaging
  /** Ledger task this gate blocks (SDD §4.2 `gates`), when there is one. */
  readonly taskId?: string
}

/** A submitted action: allowed outright, or held behind an open gate. */
export type GateOutcome =
  | { readonly held: false; readonly decision: GateDecision }
  | { readonly held: true; readonly gate: OpenGate; readonly decision: GateDecision }

export class GateManager {
  private readonly open = new Map<string, OpenGate>()
  /** Verdicts, kept so a caller that asks twice gets the same answer. */
  private readonly settled = new Map<string, GateVerdict>()
  private readonly now: () => Date

  constructor(private readonly options: GateManagerOptions) {
    this.now = options.now ?? (() => new Date())
  }

  /**
   * Submits an action to the Watch. Contract: an action is permitted only when
   * the policy says so explicitly; every other path opens a gate. There is no
   * branch that lets an unmatched action through, which is what
   * deny-by-default has to mean to be worth anything.
   */
  submit(submission: GateSubmission, context: { repeatBackConfirmed?: boolean } = {}): GateOutcome {
    const decision = evaluateGate(this.options.policy(), submission, context)
    if (decision.allow) {
      this.options.onLogEvent?.({
        kind: 'gate',
        event: 'allowed',
        agentId: submission.agentId,
        gateKind: submission.kind,
        because: decision.because,
        channel: submission.channel ?? 'local'
      })
      return { held: false, decision }
    }

    const gate = openGateSchema.parse({
      schemaVersion: GATE_SCHEMA_VERSION,
      id: this.mintId(),
      kind: submission.kind,
      agentId: submission.agentId,
      because: decision.because,
      channel: submission.channel ?? 'local',
      packaging: submission.packaging,
      taskId: submission.taskId ?? null,
      // The policy decides whether repeat-back is required; the surface that
      // takes the approval performs it (the Herald's seam, M6).
      requiresRepeatBack: decision.because === 'repeat-back',
      openedAt: this.now().toISOString()
    })
    this.open.set(gate.id, gate)
    this.options.onLogEvent?.({
      kind: 'gate',
      event: 'opened',
      gateId: gate.id,
      agentId: gate.agentId,
      gateKind: gate.kind,
      because: gate.because,
      channel: gate.channel,
      taskId: gate.taskId,
      // The packaging is the record UC-08 asks for; it belongs in the book.
      what: gate.packaging.what,
      blastRadius: gate.packaging.blastRadius
    })
    this.options.onOpen?.(gate)
    return { held: true, gate, decision }
  }

  /** Gates waiting on the Architect, oldest first (SDD §5 `watch:approvals`). */
  list(): readonly OpenGate[] {
    return [...this.open.values()].sort((a, b) => a.openedAt.localeCompare(b.openedAt))
  }

  get(gateId: string): OpenGate | null {
    return this.open.get(gateId) ?? null
  }

  /** True while any gate blocks this task — SDD §4.2's `status→done` guard. */
  gatesFor(taskId: string): readonly OpenGate[] {
    return this.list().filter((gate) => gate.taskId === taskId)
  }

  /** True while any gate blocks this agent, for the avatar's `blocked` state. */
  isBlocked(agentId: string): boolean {
    return this.list().some((gate) => gate.agentId === agentId)
  }

  /**
   * Records the Architect's verdict.
   *
   * Contract: a voice approval on a gate that requires repeat-back is REFUSED
   * unless the surface confirms the repeat-back happened (NFR-9). The refusal
   * is not a denial — the gate stays open — because "we could not confirm you
   * meant it" is not the same answer as "no".
   */
  decide(
    gateId: string,
    verdict: GateVerdict,
    context: { channel?: SourceChannel; repeatBackConfirmed?: boolean } = {}
  ):
    | { readonly ok: true; readonly gate: OpenGate }
    | { readonly ok: false; readonly reason: string } {
    const gate = this.open.get(gateId)
    if (!gate) {
      const already = this.settled.get(gateId)
      return {
        ok: false,
        reason: already ? `gate ${gateId} was already ${already}` : `no open gate ${gateId}`
      }
    }
    if (
      verdict === 'approved' &&
      gate.requiresRepeatBack &&
      (context.channel ?? 'local') === 'voice' &&
      context.repeatBackConfirmed !== true
    ) {
      return { ok: false, reason: 'voice approval of this action requires repeat-back' }
    }

    this.open.delete(gateId)
    this.settled.set(gateId, verdict)
    this.options.onLogEvent?.({
      kind: 'gate',
      event: verdict,
      gateId: gate.id,
      agentId: gate.agentId,
      gateKind: gate.kind,
      taskId: gate.taskId,
      // How the verdict arrived; NFR-9 makes remote and voice different from a
      // click, and the record has to say which it was.
      channel: context.channel ?? 'local',
      repeatBack: context.repeatBackConfirmed === true
    })
    this.options.onSettled?.(gate, verdict)
    return { ok: true, gate }
  }

  /** The verdict a settled gate received, or null while it is still open. */
  verdictOf(gateId: string): GateVerdict | null {
    return this.settled.get(gateId) ?? null
  }

  private mintId(): string {
    const stamp = this.now().toISOString().replace(/[:.]/g, '-').toLowerCase()
    return `g-${stamp}-${randomBytes(2).toString('hex')}`
  }
}

/**
 * Contract: composes the effective policy from the global one and a profile's
 * autonomy, never widening past the global (ADR-0012). A policy that failed to
 * load composes as deny-all, which is the safe direction for a parse error to
 * fail in (invariant §7 makes the failure itself visible elsewhere).
 */
export function effectivePolicy(
  global: GatePolicy | null,
  profileAutonomy: GatePolicy['autonomy'] | null
): GatePolicy {
  const base = global ?? denyAllPolicy
  if (profileAutonomy === null) return base
  return { ...base, autonomy: composeAutonomy(base.autonomy, profileAutonomy) }
}

/**
 * Loads `<harness home>/gate-policy.json`.
 *
 * Contract: NEVER throws and never widens on failure. A missing file is the
 * deny-all default (an unconfigured Ephesus holds everything), and a file that
 * fails to parse is ALSO deny-all with a visible reason — a policy the harness
 * cannot read must not become a policy that permits.
 */
export function loadGatePolicy(policyPath: string): {
  readonly policy: GatePolicy
  readonly warning: string | null
} {
  if (!fs.existsSync(policyPath)) return { policy: denyAllPolicy, warning: null }
  try {
    const parsed = parseGatePolicy(JSON.parse(fs.readFileSync(policyPath, 'utf8')))
    if (parsed.ok) return { policy: parsed.policy, warning: null }
    return {
      policy: denyAllPolicy,
      warning: `gate-policy.json invalid, holding everything: ${parsed.reason}`
    }
  } catch (err) {
    return {
      policy: denyAllPolicy,
      warning: `gate-policy.json unreadable, holding everything: ${
        err instanceof Error ? err.message.split('\n')[0] : String(err)
      }`
    }
  }
}

/**
 * Packages an engine's own permission prompt as a UC-08 gate (SDD §9 choke
 * point 1).
 *
 * The engine tells us only that it is waiting and, usually, roughly what
 * about. The rest of UC-08's four fields are supplied honestly rather than
 * invented: the blast radius of an action the engine has NOT performed is
 * exactly "whatever it was about to do", and the rollback for a refusal is
 * that it never happens. Claiming more than the engine said would be the
 * harness making up a risk assessment.
 */
export function packageNotification(payload: unknown): GatePackaging {
  const message =
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as Record<string, unknown>)['message'] === 'string'
      ? ((payload as Record<string, unknown>)['message'] as string).trim()
      : ''
  return {
    what: message.length > 0 ? message.slice(0, 2000) : 'the engine is waiting on a human decision',
    why: 'the engine asked for permission and will not proceed without an answer',
    blastRadius: 'whatever the engine was about to do; it has not done it yet',
    rollback: 'denying the gate leaves the action unperformed'
  }
}

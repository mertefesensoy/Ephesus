import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_MEMO_POLICY,
  matchMemoTrigger,
  type MemoAction,
  type MemoPolicy,
  type MemoTrigger
} from '../../shared/memo'
import {
  checkVerdictChannel,
  composeAutonomy,
  denyAllPolicy,
  evaluateGate,
  GATE_SCHEMA_VERSION,
  openGateSchema,
  parseGatePolicy,
  repeatBackRequired,
  type AutonomyLevel,
  type GateDecision,
  type GateKind,
  type GatePackaging,
  gatePackagingSchema,
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
  /**
   * Renders the prose shown when a verdict is refused (invariant §8). Injected
   * so the words live in `prompts/watch/`, never here; the fallback is the
   * machine-readable tag itself, which is data rather than prose.
   */
  refusalReason?(because: 'channel' | 'repeat-back'): string
  /**
   * The autonomy a PROFILE has granted this agent for this class, or null when
   * the agent belongs to no active profile (ADR-0012, FR-11.1 — M7.2).
   *
   * Resolved here rather than passed in by every caller, and that is the whole
   * reason it exists. `GateRequest.profileAutonomy` shipped at M3 and nothing
   * ever set it; a field the call site has to remember is a field that gets
   * forgotten, and a forgotten one means an agent whose profile TIGHTENED a
   * class quietly gets the looser company default — an escalation relative to
   * the plan the Architect approved at activation.
   *
   * Null means "no profile owns this agent", NOT "no restriction": the global
   * policy then applies alone, which is where deny-by-default already lives.
   */
  profileAutonomy?(agentId: string, kind: GateKind): AutonomyLevel | null
}

/** What a caller asks for when it needs an action gated. */
export interface GateSubmission extends GateRequest {
  readonly packaging: GatePackaging
  /** Ledger task this gate blocks (SDD §4.2 `gates`), when there is one. */
  readonly taskId?: string
  /**
   * Set when memo policy matched the action (FR-7.3). The gate then waits for
   * a memo, not for a bare verdict — the Architect or the orchestrator decides
   * on the memo's options, blast radius and rollback, which is the whole point
   * of ADR-0008 §3.
   */
  readonly memoTrigger?: MemoTrigger
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
    const policy = this.options.policy()
    // Composition is applied HERE, to every submission, rather than trusted to
    // arrive on it. When both a caller and a profile have an opinion the
    // STRICTER one is taken — composition can only ever narrow (SDD §9).
    const granted = this.options.profileAutonomy?.(submission.agentId, submission.kind) ?? null
    const composed: GateSubmission =
      granted === null
        ? submission
        : {
            ...submission,
            profileAutonomy:
              submission.profileAutonomy === undefined
                ? granted
                : composeAutonomy(submission.profileAutonomy, granted)
          }
    const decision = evaluateGate(policy, composed, context)
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

    // One open gate per (agent, kind). Engines emit notifications repeatedly —
    // idle reminders as well as permission dialogs — and a gate per event would
    // bury the queue and turn `log.jsonl` into a metronome. The FIRST packaging
    // is kept: it is the one the Architect is being asked about.
    const existing = this.list().find(
      (open) => open.agentId === composed.agentId && open.kind === composed.kind
    )
    if (existing) return { held: true, gate: existing, decision }

    const gate = openGateSchema.parse({
      schemaVersion: GATE_SCHEMA_VERSION,
      id: this.mintId(),
      kind: submission.kind,
      agentId: submission.agentId,
      because: decision.because,
      channel: submission.channel ?? 'local',
      packaging: submission.packaging,
      taskId: submission.taskId ?? null,
      memoTrigger: submission.memoTrigger ?? null,
      // From the gate's OWN facts, not from why it was held: under
      // deny-by-default the reason is almost always `no-rule`, so reading it
      // off `because` left the flag false on exactly the destructive ops
      // NFR-9's clause exists to protect.
      requiresRepeatBack: repeatBackRequired(policy, submission.kind),
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
      memoTrigger: gate.memoTrigger,
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
    if (verdict === 'approved') {
      // NFR-9 binds on the APPROVAL, not only on the request: a gate held under
      // deny-by-default matched no rule by definition, so checking the channel
      // only on the way in left the clause binding on nothing.
      const admissible = checkVerdictChannel(this.options.policy(), gate.kind, {
        channel: context.channel ?? 'local',
        ...(context.repeatBackConfirmed === undefined
          ? {}
          : { repeatBackConfirmed: context.repeatBackConfirmed })
      })
      if (!admissible.ok) {
        // Refusing is not denying: the gate stays open, because "we could not
        // take that verdict" and "no" are different answers.
        return {
          ok: false,
          reason: this.options.refusalReason?.(admissible.because) ?? admissible.because
        }
      }
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
    // 64 bits, not 16: two gates minted in the same millisecond used to have a
    // ~0.3% chance of colliding across twenty, and a collision silently
    // overwrote a still-open gate after its `onOpen` had already fired.
    return `g-${stamp}-${randomBytes(8).toString('hex')}`
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

/** Contract: the engine's own words about what it is waiting for, if any. */
export function notificationMessage(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const message = (payload as Record<string, unknown>)['message']
  if (typeof message !== 'string') return null
  const trimmed = message.trim()
  return trimmed.length > 0 ? trimmed.slice(0, 2000) : null
}

/**
 * Parses a packaging template into the four UC-08 fields.
 *
 * The templates live in `prompts/watch/` because every word in them is read by
 * a human deciding whether to allow a destructive act — a prompt surface as
 * much as a block reason is (invariant §8). The format is deliberately the
 * dullest thing that works: one `field: value` per line, so a template cannot
 * grow a syntax the Architect has to learn before editing it.
 *
 * Contract: throws when a field is missing. A gate filed with a blank blast
 * radius is worse than a gate that failed to file — the schema refuses it
 * anyway, and failing here names the template instead of the payload.
 */
export function parsePackaging(rendered: string, source: string): GatePackaging {
  const fields: Record<string, string> = {}
  let current: string | null = null
  for (const line of rendered.split('\n')) {
    const match = /^(what|why|blastRadius|rollback):\s*(.*)$/.exec(line)
    if (match?.[1] !== undefined) {
      current = match[1]
      fields[current] = match[2] ?? ''
    } else if (current !== null && line.trim().length > 0) {
      // A continuation line, so a long blast radius can wrap in the file.
      fields[current] = `${fields[current] ?? ''} ${line.trim()}`.trim()
    }
  }
  const parsed = gatePackagingSchema.safeParse(fields)
  if (!parsed.success) {
    throw new Error(
      `gates: ${source} is not a usable packaging template: ${
        parsed.error.issues[0]?.path.join('.') ?? 'unknown'
      } ${parsed.error.issues[0]?.message ?? ''}`
    )
  }
  return parsed.data
}

/** The event-plane slice the choke points subscribe to. */
export interface ChokePointHooks {
  /** Fires for every `notification` hook event (SDD §9 choke point 1). */
  onNotification(cb: (agentId: string, payload: unknown) => void): void
}

/** The Hermes slice the choke points subscribe to (SDD §9 choke point 2). */
export interface ChokePointMail {
  onNeedsHuman(cb: (message: NeedsHumanMessage) => void): void
}

export interface NeedsHumanMessage {
  readonly from: string
  readonly subject: string
  readonly conversation: string
}

/** Renders a packaging template from `prompts/watch/` (invariant §8). */
export interface PackagingRenderer {
  render(relPath: string, vars: Record<string, string>): string
}

/**
 * Wires SDD §9's choke points onto a gate manager.
 *
 * This exists in ONE place because the alternative was found by review: the
 * wiring lived inline in `src/main/index.ts` and was copied character-for-
 * character into the scenario rig, so S-GATE would have stayed green with the
 * production wiring deleted. Both callers now go through here, and the
 * scenarios exercise the shipped code path.
 *
 * Returns the submit functions the caller drives directly (spend has no event
 * source of its own — the budget watcher calls it).
 */
/**
 * Which gate kind a memo trigger is held under.
 *
 * The gate kinds are a documented closed set (SDD §9 / `gate-policy.json`), so
 * a memo trigger borrows the one that describes its blast radius rather than
 * inventing a seventh. The trigger itself rides on the gate, so nothing is
 * lost by the mapping.
 */
const GATE_KIND_FOR_TRIGGER: Readonly<Record<MemoTrigger, GateKind>> = {
  'new-dependency': 'scope-change',
  'api-or-schema-change': 'scope-change',
  'security-posture': 'prod-facing',
  spend: 'spend'
}

export function wireGateChokePoints(deps: {
  readonly gates: GateManager
  readonly prompts: PackagingRenderer
  readonly hooks?: ChokePointHooks
  readonly mail?: ChokePointMail
  /**
   * The ledger task this agent is bound to, so a gate is recorded against the
   * work it blocks (SDD §4.2 `gates`). Until M5.1 every production submission
   * carried `taskId: null`, so the field the `status → done` guard reads was
   * only ever written by tests — the guard protected nothing in the shipped
   * app. Optional because a harness with no ledger still gates; it just
   * cannot attribute.
   */
  taskOf?(agentId: string): string | null
  /** The memo policy in force (ADR-0008’s tuning knob). */
  memoPolicy?(): MemoPolicy
  /** Raised when a choke point could not file its gate (invariant §7). */
  onError?(detail: string): void
}): {
  submitNotification(agentId: string, payload: unknown): void
  submitMemoTrigger(agentId: string, action: MemoAction): MemoTrigger | null
  submitNeedsHuman(message: NeedsHumanMessage): void
  submitSpend(agentId: string, spentTokens: number, state: string): void
} {
  const guard = (what: string, run: () => void): void => {
    try {
      run()
    } catch (err) {
      deps.onError?.(
        `${what} could not be gated: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  // Spread, not a nullable field: `GateSubmission.taskId` is optional and
  // `exactOptionalPropertyTypes` refuses an explicit `undefined`.
  const bound = (agentId: string): { taskId?: string } => {
    const taskId = deps.taskOf?.(agentId) ?? null
    return taskId === null ? {} : { taskId }
  }

  const submitNotification = (agentId: string, payload: unknown): void =>
    guard('an engine permission prompt', () => {
      const message =
        notificationMessage(payload) ??
        deps.prompts.render(path.join('watch', 'notification-unspecified.md'), {}).trim()
      deps.gates.submit({
        kind: 'tool-permission',
        agentId,
        ...bound(agentId),
        packaging: parsePackaging(
          deps.prompts.render(path.join('watch', 'packaging-notification.md'), { message }),
          'watch/packaging-notification.md'
        )
      })
    })

  /**
   * SDD §7.3’s first step: an action that matches memo policy is HELD, and
   * the worker is told which memo it owes.
   *
   * Returns the trigger it matched, or null when the action is ordinary — so
   * the caller can tell "held for a memo" from "nothing to do" without
   * re-running the match.
   */
  const submitMemoTrigger = (agentId: string, action: MemoAction): MemoTrigger | null => {
    let matched: MemoTrigger | null = null
    guard('a memo-policy action', () => {
      const trigger = matchMemoTrigger(action, deps.memoPolicy?.() ?? DEFAULT_MEMO_POLICY)
      if (trigger === null) return
      matched = trigger
      deps.gates.submit({
        kind: GATE_KIND_FOR_TRIGGER[trigger],
        agentId,
        ...bound(agentId),
        memoTrigger: trigger,
        packaging: parsePackaging(
          deps.prompts.render(path.join('watch', 'packaging-memo.md'), {
            trigger,
            tool: action.tool,
            what: action.path ?? action.text ?? action.tool
          }),
          'watch/packaging-memo.md'
        )
      })
    })
    return matched
  }

  const submitNeedsHuman = (message: NeedsHumanMessage): void =>
    guard('a needs_human message', () => {
      deps.gates.submit({
        kind: 'needs-human',
        agentId: message.from,
        ...bound(message.from),
        packaging: parsePackaging(
          deps.prompts.render(path.join('watch', 'packaging-needs-human.md'), {
            subject: message.subject,
            from: message.from,
            conversation: message.conversation
          }),
          'watch/packaging-needs-human.md'
        )
      })
    })

  const submitSpend = (agentId: string, spentTokens: number, state: string): void =>
    guard('a budget breach', () => {
      deps.gates.submit({
        kind: 'spend',
        agentId,
        // The AMOUNT, which this submission used to omit.
        //
        // `evaluateGate` reads `request.spendTokens ?? Number.POSITIVE_INFINITY`
        // and holds anything over the rule's cap — so a submission without it
        // was held whatever cap the Architect wrote, and `maxSpendTokens` was a
        // knob connected to nothing. The old comment reasoned that holding was
        // "the safe direction", and it is, but a policy that cannot be
        // satisfied is not a conservative policy: it is an absent one, and the
        // Architect ends up clicking through the same gate forever without ever
        // having been asked a question they could answer differently.
        //
        // `maxSpendTokens` is in TOKENS and so is this, which is the pairing
        // the rule's own comment describes.
        spendTokens: spentTokens,
        ...bound(agentId),
        packaging: parsePackaging(
          deps.prompts.render(path.join('watch', 'packaging-spend.md'), {
            agentId,
            spent: String(spentTokens),
            state
          }),
          'watch/packaging-spend.md'
        )
      })
    })

  deps.hooks?.onNotification(submitNotification)
  deps.mail?.onNeedsHuman(submitNeedsHuman)
  return { submitNotification, submitNeedsHuman, submitSpend, submitMemoTrigger }
}

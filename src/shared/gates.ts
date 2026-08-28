import { z } from 'zod'
import { agentIdSchema } from './agents'
import { memoTriggerSchema } from './memo'

/**
 * The Watch's gate policy (SDD §9, FR-11.1, ADR-0011/0012, UC-08).
 *
 * Two rules shape every line in this file:
 *
 *  - **Deny by default.** A gated action with no matching allowance is held.
 *    Not "allowed unless denied" — the absence of a rule is a refusal, so a
 *    policy file that fails to mention tomorrow's dangerous action still holds
 *    it (FR-11.1 "defaults are conservative; autonomy is opt-in per profile").
 *  - **Stricter wins.** A profile may *loosen* only up to the global maximum
 *    (ADR-0012's stated consequence). Composition can never widen what the
 *    global policy allows, which is why `composeAutonomy` takes a minimum
 *    rather than the profile's own value.
 */

export const GATE_SCHEMA_VERSION = 1

/**
 * The action classes SRS FR-11.1 names: "spend above threshold, destructive
 * ops, scope changes, and prod-facing actions". `needs-human` is the Hermes
 * choke point (SDD §9) and `tool-permission` the engine one.
 */
export const GATE_KINDS = [
  'destructive',
  'spend',
  'scope-change',
  'prod-facing',
  'tool-permission',
  'needs-human'
] as const
export const gateKindSchema = z.enum(GATE_KINDS)
export type GateKind = z.infer<typeof gateKindSchema>

/**
 * Autonomy levels, ordered least→most permissive. The order IS the
 * composition rule: `Math.min` over the rank is "stricter wins".
 */
export const AUTONOMY_LEVELS = ['manual', 'supervised', 'autonomous'] as const
export const autonomyLevelSchema = z.enum(AUTONOMY_LEVELS)
export type AutonomyLevel = z.infer<typeof autonomyLevelSchema>

export const AUTONOMY_RANK: Readonly<Record<AutonomyLevel, number>> = {
  manual: 0,
  supervised: 1,
  autonomous: 2
}

/**
 * Contract: the stricter of two levels, always. A profile that asks for
 * `autonomous` under a global `supervised` gets `supervised` — ADR-0012's
 * "the *stricter* setting always wins", enforced by construction rather than
 * by a check somebody could forget.
 */
export function composeAutonomy(global: AutonomyLevel, profile: AutonomyLevel): AutonomyLevel {
  return AUTONOMY_RANK[profile] < AUTONOMY_RANK[global] ? profile : global
}

/**
 * How a request reached the harness. A first-class policy input by Architect
 * decision (M3 plan): NFR-9 makes remote approvals and voice approvals of
 * destructive ops different from a click at the keyboard, so the channel has
 * to be something policy can see rather than something the UI knows privately.
 */
export const SOURCE_CHANNELS = ['local', 'voice', 'remote'] as const
export const sourceChannelSchema = z.enum(SOURCE_CHANNELS)
export type SourceChannel = z.infer<typeof sourceChannelSchema>

/**
 * One policy rule. A rule can only ever *permit*; there is no deny rule,
 * because denial is the default and a deny rule would invite the "which one
 * wins" ordering bug that deny-by-default exists to avoid.
 */
export const gateRuleSchema = z
  .object({
    kind: gateKindSchema,
    /**
     * Minimum autonomy at which this rule permits without a human. At
     * `manual` a rule permits nothing — it exists to describe the class.
     */
    autonomy: autonomyLevelSchema,
    /**
     * Optional cap for `spend` rules, in TOKENS.
     *
     * Tokens, not currency: the durable ledger reports tokens (the engine
     * reports no per-message cost, ADR-0011/M3.2), so a cents field would be
     * compared against a token count and the knob would be silently
     * meaningless. It becomes a currency cap when an engine reports one.
     */
    maxSpendTokens: z.number().int().nonnegative().optional(),
    /** Channels this rule permits through; omitted means local only (NFR-9). */
    channels: z.array(sourceChannelSchema).min(1).optional(),
    /**
     * Whether an approval over voice must be repeated back before it counts
     * (NFR-9: "voice approval of destructive ops requires repeat-back").
     */
    requireRepeatBack: z.boolean().optional()
  })
  .strict()

export type GateRule = z.infer<typeof gateRuleSchema>

export const gatePolicySchema = z
  .object({
    schemaVersion: z.literal(GATE_SCHEMA_VERSION),
    /** The company-wide ceiling. A profile may only go lower (ADR-0012). */
    autonomy: autonomyLevelSchema,
    rules: z
      .array(gateRuleSchema)
      .max(64)
      // Two rules for one kind would let array order decide which applies —
      // the "which one wins" ambiguity deny-by-default exists to avoid. The
      // matcher takes the strictest anyway; refusing the file as well means an
      // Architect who wrote two by accident is told, not quietly overruled.
      .refine(
        (rules) => new Set(rules.map((rule) => rule.kind)).size === rules.length,
        'gate policy: one rule per kind'
      )
  })
  .strict()

export type GatePolicy = z.infer<typeof gatePolicySchema>

/**
 * The default policy: deny-by-default with nothing opted in. An Ephesus that
 * has never been configured holds every gated action, which is the direction
 * FR-11.1 requires a default to fail in.
 */
export const denyAllPolicy: GatePolicy = {
  schemaVersion: GATE_SCHEMA_VERSION,
  autonomy: 'manual',
  rules: []
}

export function parseGatePolicy(
  raw: unknown
):
  | { readonly ok: true; readonly policy: GatePolicy }
  | { readonly ok: false; readonly reason: string } {
  const parsed = gatePolicySchema.safeParse(raw)
  if (parsed.success) return { ok: true, policy: parsed.data }
  const issue = parsed.error.issues[0]
  const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'policy'
  return { ok: false, reason: `${where}: ${issue?.message ?? 'invalid gate policy'}` }
}

/**
 * Contract: the STRICTEST rule for a kind, not the first one written. A policy
 * with two rules for one kind would otherwise let array order decide, which is
 * precisely the "which one wins" ambiguity deny-by-default exists to avoid.
 * Strictest means: highest autonomy floor, then the lowest spend cap, then the
 * narrowest channel set, then repeat-back required if any rule requires it.
 */
export function strictestRuleFor(policy: GatePolicy, kind: GateKind): GateRule | null {
  const matching = policy.rules.filter((rule) => rule.kind === kind)
  const first = matching[0]
  if (first === undefined) return null
  return matching.reduce((strictest, rule) => ({
    kind,
    autonomy:
      AUTONOMY_RANK[rule.autonomy] > AUTONOMY_RANK[strictest.autonomy]
        ? rule.autonomy
        : strictest.autonomy,
    ...(rule.maxSpendTokens === undefined && strictest.maxSpendTokens === undefined
      ? {}
      : { maxSpendTokens: Math.min(rule.maxSpendTokens ?? 0, strictest.maxSpendTokens ?? 0) }),
    ...(rule.channels === undefined || strictest.channels === undefined
      ? {}
      : {
          channels: strictest.channels.filter((channel) => rule.channels?.includes(channel)) as [
            SourceChannel,
            ...SourceChannel[]
          ]
        }),
    ...(rule.requireRepeatBack === true || strictest.requireRepeatBack === true
      ? { requireRepeatBack: true }
      : {})
  }))
}

/** What the harness asks the policy about. */
export interface GateRequest {
  readonly kind: GateKind
  readonly agentId: string
  /** Tokens at stake, for `spend`. */
  readonly spendTokens?: number
  /** How the request arrived; defaults to `local`. */
  readonly channel?: SourceChannel
  /** The profile's autonomy level, if the agent belongs to one (ADR-0012). */
  readonly profileAutonomy?: AutonomyLevel
}

export type GateDecision =
  | { readonly allow: true; readonly because: 'rule' }
  | {
      readonly allow: false
      /**
       * Which input held it. Machine-readable on purpose: the prose an agent
       * or the Architect reads is rendered from `prompts/`, never from here
       * (invariant §8).
       */
      readonly because:
        'no-rule' | 'autonomy' | 'spend-cap' | 'channel' | 'repeat-back' | 'no-policy'
    }

/**
 * Contract: evaluates one request against the composed policy. Returns
 * `allow: false` for anything it is not sure about — every path that is not an
 * explicit permission ends in a hold.
 *
 * `repeatBackConfirmed` is supplied by the caller because only the surface that
 * took the approval knows whether the human actually repeated it back; the
 * policy's job is to *require* it, not to perform it. That is the seam the
 * Herald plugs into in M6 (Architect decision), and it is why the voice clause
 * of S-GATE is testable now with a scripted stub.
 */
export function evaluateGate(
  policy: GatePolicy,
  request: GateRequest,
  context: { readonly repeatBackConfirmed?: boolean } = {}
): GateDecision {
  const channel: SourceChannel = request.channel ?? 'local'
  const effective = composeAutonomy(policy.autonomy, request.profileAutonomy ?? policy.autonomy)

  // The engine's own permission dialog is never permittable, whatever the
  // policy says. "Allow" is not a meaningful verdict here: the harness has no
  // action to permit — the engine is blocked on a human, and letting the
  // policy answer it would silently restore the invisible stall that the
  // M1 carried item was about (invariant §7).
  if (request.kind === 'tool-permission') return { allow: false, because: 'no-rule' }

  const rule = strictestRuleFor(policy, request.kind)
  if (!rule) return { allow: false, because: 'no-rule' }

  // `manual` means "I approve this by hand" (FR-11.1). A rule at `manual`
  // permits nothing — it exists to describe the class — and this is also where
  // ADR-0012's tightening has to bottom out: a profile that composes down to
  // `manual` must not still be permitting.
  if (rule.autonomy === 'manual' || effective === 'manual') {
    return { allow: false, because: 'autonomy' }
  }
  // The rule's own floor and the composed ceiling both have to be cleared.
  if (AUTONOMY_RANK[effective] < AUTONOMY_RANK[rule.autonomy]) {
    return { allow: false, because: 'autonomy' }
  }

  const channels = rule.channels ?? ['local']
  if (!channels.includes(channel)) return { allow: false, because: 'channel' }

  if (
    rule.requireRepeatBack === true &&
    channel === 'voice' &&
    context.repeatBackConfirmed !== true
  ) {
    return { allow: false, because: 'repeat-back' }
  }

  if (rule.kind === 'spend') {
    const cap = rule.maxSpendTokens
    // A spend rule with no cap caps nothing, which would be an allowance
    // nobody wrote. An uncapped spend rule permits nothing.
    if (cap === undefined) return { allow: false, because: 'spend-cap' }
    if ((request.spendTokens ?? Number.POSITIVE_INFINITY) > cap) {
      return { allow: false, because: 'spend-cap' }
    }
  }

  return { allow: true, because: 'rule' }
}

/**
 * The packaging UC-08 step 2 requires: "what, why, blast radius, rollback".
 * Schema'd and validated because it is a file the approvals UI, the log and
 * (in M6) a remote push all read (invariant §9).
 */
export const gatePackagingSchema = z
  .object({
    /** The action itself, e.g. `rm -rf build/`. */
    what: z.string().min(1).max(2000),
    /** Why the agent believes it is necessary. */
    why: z.string().min(1).max(2000),
    /** What is affected if it goes wrong. */
    blastRadius: z.string().min(1).max(2000),
    /** How to undo it, or an explicit statement that it cannot be undone. */
    rollback: z.string().min(1).max(2000)
  })
  .strict()

export type GatePackaging = z.infer<typeof gatePackagingSchema>

export const GATE_VERDICTS = ['approved', 'denied'] as const
export const gateVerdictSchema = z.enum(GATE_VERDICTS)
export type GateVerdict = z.infer<typeof gateVerdictSchema>

export const gateIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^g-[0-9a-z-]+$/, 'gate id: g-<time>-<suffix>')

/** An open gate, as the approvals UI and the log see it. */
export const openGateSchema = z
  .object({
    schemaVersion: z.literal(GATE_SCHEMA_VERSION),
    id: gateIdSchema,
    kind: gateKindSchema,
    agentId: agentIdSchema,
    /** Why the policy held it — the machine-readable reason, not prose. */
    because: z.string().min(1).max(64),
    channel: sourceChannelSchema,
    packaging: gatePackagingSchema,
    /** Ledger task this gate blocks, when it has one (SDD §4.2 `gates`). */
    taskId: z.string().min(1).max(64).nullable(),
    /** True when a voice approval must be repeated back before it counts. */
    requiresRepeatBack: z.boolean(),
    /**
     * Set when memo policy is what held this action (ADR-0008 §3, FR-7.3): the
     * gate does not open to a plain verdict, it waits for a filed memo whose
     * verdict then settles it. Null for every other hold.
     */
    memoTrigger: memoTriggerSchema.nullable(),
    openedAt: z.string().min(1).max(64)
  })
  .strict()

export type OpenGate = z.infer<typeof openGateSchema>

/**
 * The `watch:approve` payload (SDD §5). It lives here with the other gate
 * validators rather than inline in `ipc.ts`, so the shape the renderer must
 * satisfy is defined next to the types it validates (ENGINEERING-STANDARDS §3).
 *
 * It carries NO channel and NO repeat-back flag, deliberately. A verdict
 * arriving through the window bridge *is* `local` — main knows that with
 * certainty — and taking the renderer's word for the provenance would let an
 * untrusted surface stamp "approved by voice, repeat-back confirmed" onto the
 * append-only record of a destructive act (invariant §2, NFR-13). Voice and
 * remote verdicts arrive on the Herald (M6) and Harbor (M7) paths inside main,
 * which know their own channel because they are it.
 */
export const gateApproveSchema = z
  .object({ gateId: gateIdSchema, verdict: gateVerdictSchema })
  .strict()

export type GateApprove = z.infer<typeof gateApproveSchema>

/**
 * Whether a gate's approval must be repeated back before it counts (NFR-9:
 * "voice approval of destructive ops requires repeat-back").
 *
 * Derived from the gate's OWN facts, not from why it was held. The first draft
 * read it off the hold reason, which under deny-by-default is almost always
 * `no-rule` — so the flag was false on exactly the destructive ops the clause
 * exists to protect, and a voice approval sailed straight through.
 */
export function repeatBackRequired(policy: GatePolicy, kind: GateKind): boolean {
  if (kind === 'destructive') return true
  return strictestRuleFor(policy, kind)?.requireRepeatBack === true
}

export type VerdictCheck =
  { readonly ok: true } | { readonly ok: false; readonly because: 'channel' | 'repeat-back' }

/**
 * Contract: whether a VERDICT may be taken over this channel.
 *
 * NFR-9 constrains the approval side, not only the request side: "remote
 * approvals require the bridge's authenticated channel; voice approval of
 * destructive ops requires repeat-back". A gate held under deny-by-default
 * still has to be *approved* through a channel the policy admits — otherwise
 * the whole clause binds on nothing, since a held gate matched no rule by
 * definition.
 *
 * `local` is always admissible: the Architect at their own keyboard is the
 * baseline every other channel is measured against.
 */
export function checkVerdictChannel(
  policy: GatePolicy,
  kind: GateKind,
  context: { readonly channel: SourceChannel; readonly repeatBackConfirmed?: boolean }
): VerdictCheck {
  if (context.channel !== 'local') {
    const admitted = strictestRuleFor(policy, kind)?.channels ?? ['local']
    if (!admitted.includes(context.channel)) return { ok: false, because: 'channel' }
  }
  if (
    context.channel === 'voice' &&
    repeatBackRequired(policy, kind) &&
    context.repeatBackConfirmed !== true
  ) {
    return { ok: false, because: 'repeat-back' }
  }
  return { ok: true }
}

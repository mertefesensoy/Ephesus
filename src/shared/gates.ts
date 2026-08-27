import { z } from 'zod'

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
    /** Optional cap for `spend` rules, in whole US cents. */
    maxSpendCents: z.number().int().nonnegative().optional(),
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
    rules: z.array(gateRuleSchema).max(64)
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

/** What the harness asks the policy about. */
export interface GateRequest {
  readonly kind: GateKind
  readonly agentId: string
  /** Cents at stake, for `spend`. */
  readonly spendCents?: number
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

  const rule = policy.rules.find((candidate) => candidate.kind === request.kind)
  if (!rule) return { allow: false, because: 'no-rule' }

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
    const cap = rule.maxSpendCents
    // A spend rule with no cap caps nothing, which would be an allowance
    // nobody wrote. An uncapped spend rule permits nothing.
    if (cap === undefined) return { allow: false, because: 'spend-cap' }
    if ((request.spendCents ?? Number.POSITIVE_INFINITY) > cap) {
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
    agentId: z.string().min(1).max(128),
    /** Why the policy held it — the machine-readable reason, not prose. */
    because: z.string().min(1).max(64),
    channel: sourceChannelSchema,
    packaging: gatePackagingSchema,
    /** Ledger task this gate blocks, when it has one (SDD §4.2 `gates`). */
    taskId: z.string().min(1).max(64).nullable(),
    /** True when a voice approval must be repeated back before it counts. */
    requiresRepeatBack: z.boolean(),
    openedAt: z.string().min(1).max(64)
  })
  .strict()

export type OpenGate = z.infer<typeof openGateSchema>

/**
 * The `watch:approve` payload (SDD §5). It lives here with the other gate
 * validators rather than inline in `ipc.ts`, so the shape the renderer must
 * satisfy is defined next to the types it validates (ENGINEERING-STANDARDS §3).
 */
export const gateApproveSchema = z
  .object({
    gateId: gateIdSchema,
    verdict: gateVerdictSchema,
    context: z
      .object({
        channel: sourceChannelSchema.optional(),
        repeatBackConfirmed: z.boolean().optional()
      })
      .strict()
      .optional()
  })
  .strict()

export type GateApprove = z.infer<typeof gateApproveSchema>

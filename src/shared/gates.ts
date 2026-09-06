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
 * ops, scope changes, prod-facing actions, and outbound public communication".
 * `needs-human` is the Hermes choke point (SDD §9) and `tool-permission` the
 * engine one.
 *
 * ## Why `outbound` is a seventh kind (Architect decision, 2026-08-31, M7.5)
 *
 * DECISIONS-LOG records a standing rule from M5.3: *a memo trigger borrows an
 * existing gate KIND rather than inventing a seventh*, justified there because
 * "the trigger itself is on the gate, so **the mapping loses nothing**".
 *
 * That qualifier is what fails here. FR-9.3 requires the Front Office's reply
 * autonomy to be configurable on its own ladder (draft-only → auto-post), and
 * the nearest existing kind is `prod-facing` — "this reaches the deployed
 * system". Borrowing it would mean an Architect who wants the company to answer
 * issues unattended has, in the same setting, granted it autonomous production
 * actions; there would be no way to write "may reply, may not touch prod". The
 * mapping would lose exactly the independence the requirement is about.
 *
 * Additive and backward-compatible by construction: a policy that never
 * mentions `outbound` has no rule for it, and no rule means DENIED
 * (`strictestRuleFor` returns null → `evaluateGate` holds). Every gate policy
 * written before this kind existed therefore refuses outbound comment posting,
 * which is the direction a new permission class must fail in.
 */
export const GATE_KINDS = [
  'destructive',
  'spend',
  'scope-change',
  'prod-facing',
  /**
   * Public communication the company sends OUT under its own name: an issue or
   * PR comment, a chat post. Distinct from `prod-facing` because the blast
   * radius is reputational rather than operational, and because it is the first
   * irreversible outward act the company can take on its own initiative — a
   * posted comment has been read and mailed to subscribers before anyone can
   * delete it.
   */
  'outbound',
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

/**
 * The daily token ceiling's bounds, defined ONCE and used by both the file
 * schema and the wire schema. Written twice they agreed by coincidence, and a
 * later widening of one would have let a figure the policy file rejects reach
 * the writer — a save that refuses with a message naming no field.
 */
export const maxDailyTokensSchema = z.number().int().positive().max(1_000_000_000)

export const gatePolicySchema = z
  .object({
    schemaVersion: z.literal(GATE_SCHEMA_VERSION),
    /** The company-wide ceiling. A profile may only go lower (ADR-0012). */
    autonomy: autonomyLevelSchema,
    /**
     * The company-wide DAILY TOKEN ceiling, in tokens, or absent for none.
     *
     * Beside `autonomy` because it is the same kind of thing and must behave
     * the same way: a ceiling the Architect sets that a profile may sit under
     * and never exceed. The autonomy ceiling has clamped since ADR-0012; the
     * budget one did not exist, so a company-wide figure could be quietly
     * overruled by any hire that declared a bigger number — a setting that
     * looks like a limit and is not.
     *
     * One knob, two jobs, deliberately. Set, it is BOTH the figure a hire with
     * no budget of its own receives AND the most any hire may have. Absent,
     * hires are unbudgeted unless they declare otherwise (ADR-0029). Splitting
     * "default" from "maximum" into two settings would ask the Architect to
     * reason about their interaction to answer one question — "is this company
     * capped?" — which is the question they actually have.
     *
     * Tokens for the same reason `maxSpendTokens` is: the durable ledger
     * reports tokens, so a currency field would be compared against a token
     * count and mean nothing.
     */
    maxDailyTokens: maxDailyTokensSchema.optional(),
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

/**
 * The policy Ephesus ships with (M8.4, Architect decision DD-1, 2026-09-04).
 *
 * ## Why a permissive CEILING is the safe choice, not the loose one
 *
 * Autonomy composes stricter-wins (ADR-0012): the company ceiling and the
 * profile's own table are compared and the tighter one governs. So a ceiling of
 * `manual` — which is what an absent `gate-policy.json` produced — does not make
 * the company careful, it makes every profile decorative. The Skeleton Crew
 * ships `autonomous` with its irreversible classes at `supervised`, and on every
 * install that has ever existed it ran at `manual` for everything, so each agent
 * sat at a permission prompt nobody was there to answer. Unattended running,
 * which is what this whole milestone is named for, was impossible out of the box
 * and nothing said why.
 *
 * This ceiling lets a profile's declaration mean what it says, and holds the
 * classes where being wrong cannot be undone:
 *
 * - `destructive`, `prod-facing`, `spend`, `scope-change`, `outbound` sit at
 *   `supervised` — attempted with a human able to see and stop it, never
 *   silently. `outbound` is here because a posted comment has been read and
 *   mailed to subscribers before anyone can delete it.
 * - `needs-human` stays `manual`: it is the class whose whole meaning is that
 *   the Architect decides.
 * - `tool-permission` is deliberately absent. `evaluateGate` refuses that kind
 *   by construction — it is the engine's own prompt, and the harness has no
 *   action to permit there (M7.4).
 *
 * "The Watch held every gated action" stays true for every class that can hurt
 * you. What changes is that routine work is no longer stopped for a prompt
 * nobody will answer.
 *
 * Written as a value rather than as a JSON file so it cannot drift from the
 * schema it must satisfy; `home.ts` seeds it and a test parses it.
 */
export const shippedGatePolicy: GatePolicy = gatePolicySchema.parse({
  schemaVersion: GATE_SCHEMA_VERSION,
  autonomy: 'autonomous',
  rules: [
    { kind: 'destructive', autonomy: 'supervised' },
    { kind: 'prod-facing', autonomy: 'supervised' },
    { kind: 'scope-change', autonomy: 'supervised' },
    { kind: 'outbound', autonomy: 'supervised' },
    // A spend ceiling has to carry a number or it permits nothing meaningful.
    // This is the company-wide ceiling; a profile's own budget is tighter.
    { kind: 'spend', autonomy: 'supervised', maxSpendTokens: 200_000 },
    { kind: 'needs-human', autonomy: 'manual' }
  ]
})

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
 * The two company-wide ceilings, as the settings surface sends them (FR-11.7).
 *
 * ## Why the wire form is not the file form
 *
 * On disk `maxDailyTokens` is `positive().optional()`: unbudgeted is the
 * ABSENCE of a figure (ADR-0029), and there is deliberately no zero and no
 * null that means it — a zero reads as "breached before the first token".
 *
 * On the wire it is required and `nullable()`, because a patch that simply
 * omits the field cannot distinguish "leave the ceiling alone" from "remove
 * the ceiling", and a settings surface that cannot say *unbudgeted* out loud
 * cannot turn a ceiling off. The writer translates: `null` deletes the key.
 *
 * `rules` is deliberately absent, and that is the design, not an omission.
 * The rules table decides which action CLASSES need a human; it is edited in
 * the file, by someone who has read what a kind means. A control that could
 * widen `needs-human` with one click is not a setting, it is a hole.
 */
export const gateCeilingsSchema = z
  .object({
    autonomy: autonomyLevelSchema,
    maxDailyTokens: maxDailyTokensSchema.nullable()
  })
  .strict()

export type GateCeilings = z.infer<typeof gateCeilingsSchema>

/**
 * What the settings surface is shown: the ceilings as they stand on disk, and
 * the reason they might not be the ones the Architect wrote.
 *
 * `warning` is not decoration. When `gate-policy.json` is missing or corrupt
 * the harness runs on `denyAllPolicy` — every profile clamped to `manual`,
 * every agent parked at a permission prompt — and a panel that rendered that
 * fallback as though it had been chosen would be showing a degradation as a
 * setting. That is invariant §7's exact failure: bad news arriving as good.
 */
export interface GatePolicyView {
  readonly autonomy: AutonomyLevel
  readonly maxDailyTokens: number | null
  /** Non-null when what is shown is the deny-all fallback, not the file. */
  readonly warning: string | null
}

/** Contract: pure. The ceilings a view carries, ready to send back unchanged. */
export function ceilingsOf(view: GatePolicyView): GateCeilings {
  return { autonomy: view.autonomy, maxDailyTokens: view.maxDailyTokens }
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
/**
 * Open gates across a restart (M8.8).
 *
 * The gate is in memory; the BLOCK is durable. `tasks.json` carries
 * `task.gates`, and `refuseDone` above will not let a task reach `done` while
 * that array is non-empty — so a gate opened at 3am and unanswered at restart
 * left its task blocked forever, with an empty approvals queue and no way back
 * but hand-editing the book of record. That asymmetry is the defect; this
 * record closes it.
 *
 * `settled` is kept as well as `open`, and it is not decoration: `decide`
 * answers "was already approved" from it, which is what stops a repeated
 * verdict from being processed twice (SRS §6 criterion 6). Without it a
 * restart turns every settled gate back into "no open gate" — a different
 * answer to the same question.
 */
export const SETTLED_GATE_LIMIT = 1000

export const settledGateSchema = z.object({ id: gateIdSchema, verdict: gateVerdictSchema }).strict()

export const gatesRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    open: z.array(openGateSchema),
    /**
     * Bounded, newest kept. Gate ids are time-prefixed (`g-<iso>-<hex>`), so
     * "newest" is a lexicographic sort and needs no second timestamp. The
     * bound exists because this is the only part of the record that grows
     * without limit, and an unbounded file is the M8.10 defect class arriving
     * early; a thousand verdicts is far more than any agent retries against.
     */
    settled: z.array(settledGateSchema).max(SETTLED_GATE_LIMIT)
  })
  .strict()
  .refine(
    (value) => new Set(value.open.map((gate) => gate.id)).size === value.open.length,
    'duplicate open gate id'
  )
  .refine(
    (value) => new Set(value.settled.map((row) => row.id)).size === value.settled.length,
    'duplicate settled gate id'
  )
export type GatesRecord = z.infer<typeof gatesRecordSchema>
export const EMPTY_GATES: GatesRecord = {
  schemaVersion: 1,
  open: [],
  settled: []
}
export const GATES_REL = 'gates.json'

/** A durable block whose gate no longer exists anywhere. */
export interface OrphanBlock {
  readonly taskId: string
  readonly gateId: string
}

export interface GateReconciliation {
  /**
   * Tasks held by a gate id that is in neither the open set nor the settled
   * one. The task cannot reach `done` and nothing in the queue explains why.
   */
  readonly orphans: readonly OrphanBlock[]
  /**
   * Restored gates whose task no longer lists them — the block was released
   * while the harness was down, or the task was deleted. Dropping them keeps
   * the queue honest; keeping them would ask the Architect to rule on a hold
   * that no longer holds anything.
   */
  readonly stale: readonly string[]
}

/**
 * Contract: compares the restored gates against the durable blocks in
 * `tasks.json`. Pure, total, no clock, no filesystem — so the disagreement
 * this looks for is a table rather than an integration test nobody writes.
 *
 * It REPORTS; it never releases. Auto-clearing a block whose gate cannot be
 * reconstructed would be a deny-by-default hole (NFR-9): the block is the only
 * remaining evidence that something was held, and a harness that quietly drops
 * it has approved an action no human ever saw.
 *
 * A gate with a null `taskId` blocks no task and is never stale — it is held
 * against an agent, not against the ledger.
 */
export function reconcileGates(
  restored: readonly OpenGate[],
  settled: readonly { readonly id: string }[],
  tasks: readonly { readonly id: string; readonly gates: readonly string[] }[]
): GateReconciliation {
  const known = new Set<string>([
    ...restored.map((gate) => gate.id),
    ...settled.map((row) => row.id)
  ])
  const blocked = new Set(tasks.flatMap((task) => task.gates))
  const orphans: OrphanBlock[] = []
  for (const task of tasks) {
    for (const gateId of task.gates) {
      if (!known.has(gateId)) orphans.push({ taskId: task.id, gateId })
    }
  }
  const stale = restored
    .filter((gate) => gate.taskId !== null && !blocked.has(gate.id))
    .map((gate) => gate.id)
  return { orphans, stale }
}

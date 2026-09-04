import { z } from 'zod'
import {
  AUTONOMY_RANK,
  GATE_KINDS,
  composeAutonomy,
  type AutonomyLevel,
  type GateKind
} from './gates'
import { isReservedAgentId } from './reserved'
import {
  declaredEnvGrants,
  profileNameSchema,
  requestedAutonomy,
  targetKindSchema,
  VERIFIER_HIRE,
  type ProfileAutonomy,
  type ProfileBundle,
  type TargetKind,
  type TriggerEvent
} from './profile'
import type { SpawnRequest } from './agents'
import type { RepoDerivation } from './repo-remote'

/**
 * Activating a mission profile (ADR-0012, FR-9.4, FR-11.1, SDD §9 — M7.2).
 *
 * Loading a bundle is pure (M7.1). Activation is where it starts to cost
 * something: agents get spawned, grants get handed out, triggers get armed. So
 * every decision activation makes is computed HERE, as pure functions over a
 * loaded bundle and a target, and `src/main/profiles.ts` merely carries the
 * results out. Two things follow from that split, and both are the point:
 *
 * - **The disclosure and the act come from one place.** The activation UI shows
 *   what a profile MAY do by calling `activationPlan`; activation does it by
 *   calling the same function. A UI that computed the preview separately would
 *   eventually show one thing and do another, and ADR-0012's entire safety
 *   argument is that you can read the bundle before you trust it.
 * - **The direction of composition is testable without spawning anything.**
 *   FR-11.1's "stricter wins" is arithmetic on a rank; making it a pure table
 *   means the case that matters — a profile asking for MORE than the global
 *   allows — is a unit test rather than an integration one nobody writes.
 */

/**
 * A concrete target: what the profile is being pointed at, and where that lives
 * on this machine.
 *
 * The `ref` is what the registry records (SDD §4.1's `"target": "repo:myapp"`);
 * the `path` is the working directory its agents get. They are separate fields
 * because they answer different questions — the ref identifies the target
 * across machines and appears in the ledger, the path is local and is nobody
 * else's business. No document says how a ref resolves to a path, so it does
 * not: the Architect names the directory at activation, exactly as they already
 * do for a bare spawn (`spawnRequestSchema.cwd`), and main validates it. A
 * harness that inferred the path would be guessing which checkout the Architect
 * meant.
 */
export const activationTargetSchema = z
  .object({
    kind: targetKindSchema,
    /**
     * The target's short name — the `myapp` in `repo:myapp`. Slug-shaped
     * because it becomes part of an agent id, and an agent id is a directory
     * name under `agora/agents/`.
     */
    id: z
      .string()
      .min(1)
      .max(48)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'a lowercase target id like myapp'),
    /** The working directory the instantiated agents run in. */
    path: z.string().min(1).max(4096)
  })
  .strict()

export type ActivationTarget = z.infer<typeof activationTargetSchema>

/**
 * `owner/repo`, the only shape `gh` takes (`src/shared/harbor.ts`).
 *
 * Stated here rather than imported so the activation contract does not depend
 * on the Harbor's module, and kept byte-identical to it; a test asserts the two
 * accept and refuse the same strings, because two regexes that drift are how a
 * value validated on one screen is rejected by the subsystem that consumes it.
 */
const repoSlugSchema = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[\w.-]+\/[\w.-]+$/, 'a remote like owner/repo')

export const activationRequestSchema = z
  .object({
    profile: profileNameSchema,
    target: activationTargetSchema,
    /**
     * The repositories the Architect chose to watch, overriding both the
     * bundle's declaration and whatever the target's remotes say (M8.5).
     *
     * Optional because the normal path is that nobody types anything: the
     * checkout knows what it is. It exists because a derivation can be REFUSED
     * — a fork has two remotes and two answers, and guessing between them would
     * be the harness deciding whose repository the company files incidents
     * against — and a refusal that the Architect cannot answer is a dead end.
     */
    repos: z.array(repoSlugSchema).max(64).optional()
  })
  .strict()

export type ActivationRequest = z.infer<typeof activationRequestSchema>

/** `repo:myapp` — how the registry and the log name a target (SDD §4.1). */
export function targetRef(target: { kind: TargetKind; id: string }): string {
  return `${target.kind}:${target.id}`
}

export const instanceIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(
    /^[a-z0-9][a-z0-9-]*@(repo|app):[a-z0-9][a-z0-9-]*$/,
    'an instance id like crew@repo:myapp'
  )

/**
 * Contract: the instance id for a profile on a target — `<profile>@<ref>`.
 *
 * Deterministic, and that is what makes FR-9.4 work in both directions: "the
 * same profile can be activated per-target multiple times" is true because two
 * different targets give two different ids, and "activated twice on the SAME
 * target" is refusable because they give the same one. A random id would have
 * made the second case unrepresentable and the duplicate silent.
 */
export function instanceIdFor(profile: string, target: { kind: TargetKind; id: string }): string {
  return `${profile}@${targetRef(target)}`
}

/**
 * Contract: the agent id one hire takes in one instance.
 *
 * Carries the profile AND the target, so two profiles on one floor — and one
 * profile on two targets — can never collide on an id. That is not tidiness:
 * `AgentManager.spawn` keys live agents by id, `agora/agents/<id>/` is a
 * directory, and a collision would put two crews' mail in one inbox.
 *
 * Returns null when the composed id would be illegal (too long, or one the
 * harness reserves for itself). A caller must refuse rather than truncate: a
 * truncated id is exactly how two agents come to share one.
 */
export function agentIdForHire(
  profile: string,
  target: { kind: TargetKind; id: string },
  hire: string
): string | null {
  const id = `agent.${profile}-${target.id}-${hire}`
  if (id.length > 64) return null
  if (isReservedAgentId(id)) return null
  return id
}

/** One gate class's composed answer, with both inputs kept beside it. */
export interface ComposedAutonomy {
  readonly kind: GateKind
  /** What the global gate policy allows company-wide. */
  readonly global: AutonomyLevel
  /** What the profile asked for. */
  readonly requested: AutonomyLevel
  /** What the agent actually gets — the stricter of the two, always. */
  readonly effective: AutonomyLevel
  /**
   * True when the profile asked for more than the global allows and was cut
   * back. Surfaced rather than swallowed: an Architect reading the activation
   * screen should see that a bundle wanted `autonomous` here and did not get
   * it, because that is a fact about the bundle they are about to trust.
   */
  readonly clamped: boolean
}

/**
 * Contract: the composed autonomy for every gate kind the Watch knows.
 *
 * "Stricter wins" (FR-11.1, ADR-0012's stated consequence, SDD §9). The
 * composition is `composeAutonomy`, which takes the lower rank — so a profile
 * can only ever narrow. This function exists so the DIRECTION is assertable as
 * a table: the M7.2 risk line is that composing by "profile wins" is a silent
 * privilege escalation, and a test that only checked composition happened would
 * pass under exactly that bug.
 *
 * Total over `GATE_KINDS`: a kind the profile does not mention takes its
 * `default`, never a gap that some caller later reads as "unrestricted".
 */
export function composeAutonomyTable(
  global: AutonomyLevel,
  profile: ProfileAutonomy
): readonly ComposedAutonomy[] {
  return GATE_KINDS.map((kind) => {
    const requested = requestedAutonomy(profile, kind)
    const effective = composeAutonomy(global, requested)
    return {
      kind,
      global,
      requested,
      effective,
      clamped: AUTONOMY_RANK[requested] > AUTONOMY_RANK[global]
    }
  })
}

/** What one hire becomes when the profile is activated on a target. */
export interface PlannedHire {
  readonly agentId: string
  readonly hire: string
  /** `<name>@<version>` — the template this agent descends from (SDD §4.1). */
  readonly hireRef: string
  readonly spawn: SpawnRequest
}

/**
 * Everything activating this bundle on this target would do — the disclosure
 * and the plan, which are the same object on purpose.
 */
export interface ActivationPlan {
  readonly instanceId: string
  readonly profile: string
  readonly profileVersion: number
  readonly targetRef: string
  readonly targetPath: string
  readonly hires: readonly PlannedHire[]
  /** Secret NAMES the instance would hold, across all its hires (ADR-0010). */
  readonly envGrants: readonly string[]
  /**
   * Declared grants the broker CANNOT supply right now (M8.4).
   *
   * The preview used to list what a profile declares and stop there, so the
   * activation screen promised `GH_TOKEN` on an install with no
   * `github-app.json` and no such secret — an affirmative promise about
   * something that would silently be missing at spawn. This is answered by
   * the SAME resolver the spawn uses, so the screen and the outcome cannot
   * disagree.
   */
  readonly grantsUnavailable: readonly string[]
  /** Per-class autonomy, after composition against the global ceiling. */
  readonly autonomy: readonly ComposedAutonomy[]
  /**
   * Triggers that would be armed, by id and what wakes them.
   *
   * `when` is a HUMAN-READABLE label for the activation screen. `everyMs` and
   * `event` are the machine-readable binding, and consumers must key on those.
   *
   * They exist because keying on `when` cost the incident path its whole
   * production life: `index.ts` filtered `when === 'ci'` while this renders
   * `"on ci"`, so every CI failure was dropped as `incident-unclaimed` and no
   * incident was ever raised on a real repository. The unit tests passed
   * bindings in directly and never derived one from a plan, so both halves were
   * green. A display string is not a contract; these two fields are.
   */
  readonly triggers: readonly {
    readonly id: string
    readonly when: string
    /** Set for a schedule trigger; null for an event binding. */
    readonly everyMs: number | null
    /** Set for an event binding (`webhook`/`ci`/`health`); null otherwise. */
    readonly event: TriggerEvent | null
    readonly agentId: string
    readonly playbook: string
  }[]
  /** Action classes this profile holds for a memo (ADR-0008). */
  readonly memoRequires: readonly string[]
  /** Repositories the instance would reach through the Harbor (FR-10.1). */
  readonly repos: readonly string[]
  /**
   * Where `repos` came from (M8.5, B7).
   *
   * On the screen so the Architect can tell a repository they chose from one
   * the harness read off the checkout, and — when it is `none` — so the fact
   * that this mission will watch nothing is a sentence rather than an empty
   * list. Both shipped bundles carry `repos: []`, so `none` was the silent
   * outcome of every activation that has ever happened.
   */
  readonly reposFrom: 'architect' | 'bundle' | 'target' | 'none'
  /** How it was derived, or why there is nothing. Always a sentence. */
  readonly reposBecause: string
  /** Playbook file names the hires read. Prose — listed, never parsed. */
  readonly playbooks: readonly string[]
}

export type ActivationPlanResult =
  | { readonly ok: true; readonly plan: ActivationPlan }
  | { readonly ok: false; readonly reasons: readonly string[] }

/**
 * Contract: what activating `bundle` on `target` would do, or why it cannot.
 * Pure — plans nothing into existence. Never throws.
 *
 * This is both the preview the activation UI renders and the plan activation
 * executes, deliberately. ADR-0012 chose declarative bundles so an Architect
 * can "read what this profile may do before activating"; if the preview came
 * from a second code path it would drift, and the screen that exists to be
 * trusted would be the one place nothing checks.
 */
export function activationPlan(
  bundle: ProfileBundle,
  target: ActivationTarget,
  globalAutonomy: AutonomyLevel,
  /**
   * Which of these declared grants the broker cannot supply. Required rather
   * than optional: a default of "assume they are all available" is exactly the
   * silent assertion this parameter exists to remove.
   */
  missingGrants: (declared: readonly string[]) => readonly string[],
  /**
   * What the TARGET's own git remotes say this repository is (M8.5). Required
   * for the same reason `missingGrants` is: a default of "assume there is
   * none" is how both shipped bundles' `repos: []` became an inert mission
   * nobody could see.
   */
  derivedRepo: RepoDerivation,
  /** The `owner/repo` list the Architect typed on the activation screen. */
  chosenRepos: readonly string[] = []
): ActivationPlanResult {
  const reasons: string[] = []

  if (bundle.document.target.kind !== target.kind) {
    reasons.push(
      `profile "${bundle.name}" binds to a ${bundle.document.target.kind}, not a ${target.kind}`
    )
  }

  const hires: PlannedHire[] = []
  for (const hire of bundle.hires) {
    const agentId = agentIdForHire(bundle.name, target, hire.name)
    if (agentId === null) {
      reasons.push(
        `hire "${hire.name}" on target "${target.id}" makes no legal agent id — shorten the profile, target or hire name`
      )
      continue
    }
    hires.push({
      agentId,
      hire: hire.name,
      hireRef: `${hire.name}@${String(hire.version)}`,
      spawn: {
        agentId,
        // The name a person reads; the role stays the role. A hire that
        // declares no name keeps the old behaviour exactly.
        name: hire.displayName ?? hire.role,
        role: hire.role,
        // The registry types `engine` as an `EngineId`; the hire template types
        // it as a string, because a template may name an engine this build does
        // not carry. `AgentManager.spawn` validates it against the registry and
        // refuses an unknown one, which is where that check belongs — here it
        // would be a second, drifting list of engines.
        engine: hire.engine as SpawnRequest['engine'],
        cwd: target.path,
        capabilities: [...hire.capabilities],
        envGrants: [...hire.envGrants],
        ...(hire.budget === undefined ? {} : { budget: hire.budget })
      }
    })
  }

  const byHire = new Map(hires.map((planned) => [planned.hire, planned.agentId]))
  const triggers = bundle.triggers.flatMap((trigger) => {
    const agentId = byHire.get(trigger.hire)
    // The bundle loader already refuses a trigger naming an absent hire
    // (M7.1), so this only fires when the hire was dropped above.
    if (agentId === undefined) return []
    return [
      {
        id: `${instanceIdFor(bundle.name, target)}/${trigger.id}`,
        when:
          trigger.kind === 'schedule'
            ? `every ${String(Math.round(trigger.everyMs / 60_000))} min`
            : `on ${trigger.event}`,
        everyMs: trigger.kind === 'schedule' ? trigger.everyMs : null,
        event: trigger.kind === 'event' ? trigger.event : null,
        agentId,
        playbook: trigger.playbook
      }
    ]
  })

  if (reasons.length > 0) return { ok: false, reasons }

  return {
    ok: true,
    plan: {
      instanceId: instanceIdFor(bundle.name, target),
      profile: bundle.name,
      profileVersion: bundle.document.version,
      targetRef: targetRef(target),
      targetPath: target.path,
      hires,
      envGrants: declaredEnvGrants(bundle),
      grantsUnavailable: missingGrants(declaredEnvGrants(bundle)),
      autonomy: composeAutonomyTable(globalAutonomy, bundle.document.autonomy),
      triggers,
      memoRequires: [...bundle.memoPolicy.requires],
      ...plannedRepos(bundle, chosenRepos, derivedRepo),
      playbooks: bundle.playbooks.map((book) => book.file)
    }
  }
}

/**
 * Contract: the agent on `instanceId` who may verify a root cause `reportedBy`
 * asserted, or null when nobody may. Pure and total; never throws.
 *
 * Lives here rather than as a closure in `src/main/index.ts` on purpose. The
 * expression is small enough to inline and that is exactly the trap: an
 * inlined resolver is untestable, so the assertion would have to be a COPY of
 * it in a test file, and a copy stays green while the original rots. M7.4 shipped
 * that failure — `index.ts` filtered `trigger.when === 'ci'` against a plan
 * rendering `"on ci"`, every unit test passed bindings in by hand, and every CI
 * failure on a real repository was dropped. What a test can reach, a test can
 * hold to account.
 *
 * Two rules, in this order:
 *
 *  - **Same instance.** A verifier has to be pointed at the same checkout as the
 *    claim, and an agent from another activation is not.
 *  - **Not the author.** Independence is the entire product here. Returning the
 *    claimant would produce a record that looks checked, which is worse than an
 *    unchecked one — `IncidentEndpoint.verify` refuses it a second time, and the
 *    belt and the braces are both deliberate.
 *
 * Null when the profile declares no `VERIFIER_HIRE`. That is an ordinary state,
 * not a fault: a company that has not hired a verifier gets triaged, unverified
 * incidents, and the endpoint writes the reason into the log rather than leaving
 * a silence.
 */
export function verifierAgentFor(
  instances: readonly { readonly instanceId: string; readonly plan: ActivationPlan }[],
  instanceId: string,
  reportedBy: string
): string | null {
  const instance = instances.find((candidate) => candidate.instanceId === instanceId)
  if (instance === undefined) return null
  const hire = instance.plan.hires.find(
    (candidate) => candidate.hire === VERIFIER_HIRE && candidate.agentId !== reportedBy
  )
  return hire?.agentId ?? null
}

/**
 * Which repositories the instance will watch, and where that came from (M8.5).
 *
 * ## Precedence, and the reason for each step
 *
 * 1. **What the Architect typed.** The most specific and most recent statement
 *    anyone has made about this activation, and the override that exists so a
 *    refused or wrong derivation is never a dead end.
 * 2. **What the bundle declares.** Explicit configuration, and a profile
 *    written for a fixed set of repositories means it.
 * 3. **What the target's remotes say.** The checkout already knows what it is;
 *    asking it is what removes the setup step.
 * 4. **Nothing, with the reason.** The mission will ingest no CI run, issue or
 *    pull request, so it can raise no incident — which is exactly what happened
 *    on every activation before this, silently. It is a sentence now.
 *
 * The refusal is never repaired by guessing. A wrong slug is worse than no
 * slug: the company would watch somebody else's repository and raise incidents
 * about it.
 */
function plannedRepos(
  bundle: ProfileBundle,
  chosen: readonly string[],
  derived: RepoDerivation
): {
  readonly repos: readonly string[]
  readonly reposFrom: ActivationPlan['reposFrom']
  readonly reposBecause: string
} {
  if (chosen.length > 0) {
    return {
      repos: [...chosen],
      reposFrom: 'architect',
      reposBecause: 'named on the activation screen'
    }
  }
  const declared = bundle.harbor.repos.map((repo) => repo.remote)
  if (declared.length > 0) {
    return {
      repos: declared,
      reposFrom: 'bundle',
      reposBecause: `declared by ${bundle.name}'s harbor.json`
    }
  }
  if (derived.ok) {
    return {
      repos: [derived.slug],
      reposFrom: 'target',
      reposBecause: `read from the target's ${derived.from} remote`
    }
  }
  return {
    repos: [],
    reposFrom: 'none',
    reposBecause: `${derived.because} — this instance will watch no repository, so no CI run, issue or pull request can reach it`
  }
}

/**
 * Contract: the repositories the live instances watch, deduplicated and sorted.
 * Pure; never throws.
 *
 * ONE function for two questions that must never disagree (M8.5): what the
 * Harbor ingests from, and whether the ingest cadence is armed at all. They
 * were two expressions inlined in `index.ts` —
 * `[...new Set(instances.flatMap(i => i.plan.repos))]` beside
 * `instances.some(i => i.plan.repos.length > 0)` — and an inlined resolver is
 * untestable, so the only assertion available would be a COPY in a test file
 * that stays green while the original rots. M7.4 shipped exactly that: the
 * incident path filtered `trigger.when === 'ci'` against a plan rendering
 * `"on ci"`, every unit test passed bindings in by hand, and every CI failure
 * on a real repository was dropped.
 *
 * Sorted so the ingest order does not depend on activation order, which is the
 * kind of difference that makes one machine's log unlike another's.
 */
export function watchedRepos(
  instances: readonly { readonly plan: { readonly repos: readonly string[] } }[]
): readonly string[] {
  return [...new Set(instances.flatMap((instance) => instance.plan.repos))].sort()
}

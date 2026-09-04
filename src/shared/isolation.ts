import { z } from 'zod'

/**
 * Where a hire actually works: its own git worktree, or the Architect's target
 * checkout (FR-1.5, UC-01 alternate 2a, ADR-0004).
 *
 * This module is the composition, and it exists because the profile spawn path
 * never asked for isolation at all. Every hire in both shipped bundles ran
 * concurrent git operations and file edits **in the Architect's own working
 * copy** — the one item in the 2026-09-02 MVP register that can destroy
 * uncommitted work. `AgentManager` could already isolate a spawn; nothing ever
 * asked it to.
 *
 * The shape deliberately mirrors `composeAutonomyTable` in
 * `profile-activation.ts`, because the two answer the same kind of question and
 * an Architect should not have to learn two mental models for "what did the
 * bundle ask for, what did I say, and what will actually happen":
 *
 *   hire declares  →  profile default  →  built-in default
 *                                      ↓
 *                          the Architect's activation choice
 *                                      ↓
 *                                  effective
 *
 * The safe direction is INWARD. `worktree` is the isolated, non-destructive
 * mode and it is the built-in default, so a bundle that says nothing gets
 * isolation rather than the Architect's checkout. Relaxing that is possible —
 * some targets genuinely want an agent in the working copy — but only as an
 * explicit per-activation act that the screen names and the log records. A
 * relaxation nobody chose is exactly the failure this module was written for.
 *
 * Everything here is pure: no fs, no git, no clock. Whether a worktree can
 * actually be created is `git.ts`'s answer, given at activation time in git's
 * own words (see `AgentManager.isolate`) — deliberately NOT pre-checked here,
 * because a screen that says "ok" and an activation that then fails are two
 * code paths that can disagree, and M8.5 already paid for that lesson.
 */

/**
 * `worktree` — the agent gets its own checkout of the target repo, on its own
 * `agent/<name>` branch. `target` — the agent works directly in the target
 * directory, alongside whatever the Architect has open there.
 */
export const ISOLATION_MODES = ['worktree', 'target'] as const
export const isolationModeSchema = z.enum(ISOLATION_MODES)
export type IsolationMode = (typeof ISOLATION_MODES)[number]

/**
 * Higher is more isolated. Used only to describe a composition as a tightening
 * or a relaxation — never to pick a winner, because the Architect's explicit
 * choice wins in both directions and that is the whole point of asking them.
 */
export const ISOLATION_RANK: Readonly<Record<IsolationMode, number>> = {
  target: 0,
  worktree: 1
}

/**
 * What a hire gets when neither it nor its profile says anything.
 *
 * `worktree`, not `target`. A bundle that forgot to declare isolation is the
 * case this default exists for, and the two shipped bundles were exactly that
 * case for the whole of their production life.
 *
 * NOTE this is the default for a PROFILE ACTIVATION, which hires several agents
 * from one confirmation. A bare `agents.spawn` (UC-01, where the Architect
 * types the working directory themselves and confirms one agent) keeps
 * `spawnRequestSchema.worktree`'s own optional-false default: there is no
 * surprise to protect against when the human named the directory.
 */
export const DEFAULT_ISOLATION: IsolationMode = 'worktree'

/** Which layer supplied the declared mode, so the screen can attribute it. */
export const ISOLATION_SOURCES = ['hire', 'profile', 'default'] as const
export type IsolationSource = (typeof ISOLATION_SOURCES)[number]

/**
 * What the Architect said on the activation screen.
 *
 * `as-declared` is the normal path and reads the bundle. The other two are
 * blanket overrides, and they are values rather than a boolean because
 * "isolate everything" and "isolate nothing" are different acts with different
 * consequences, and a boolean would have made one of them the absence of a
 * choice.
 */
export const ACTIVATION_ISOLATIONS = ['as-declared', 'isolate-all', 'none'] as const
export const activationIsolationSchema = z.enum(ACTIVATION_ISOLATIONS)
export type ActivationIsolation = (typeof ACTIVATION_ISOLATIONS)[number]

/** One hire's isolation, after composition — the plan row and the disclosure. */
export interface ComposedIsolation {
  /** The hire template's name, as the bundle spells it. */
  readonly hire: string
  readonly agentId: string
  /** What the bundle asked for, before the Architect's choice. */
  readonly declared: IsolationMode
  readonly declaredFrom: IsolationSource
  /** What will actually happen. */
  readonly effective: IsolationMode
  /** The Architect's choice made this hire LESS isolated than declared. */
  readonly relaxed: boolean
  /** The Architect's choice made this hire MORE isolated than declared. */
  readonly tightened: boolean
  /**
   * Why, as a sentence, always present.
   *
   * A sentence rather than a flag because the same `effective` value arrives
   * for opposite reasons — a hire that asked to work in the checkout and a
   * target that cannot hold a worktree both read `target` — and an Architect
   * deciding whether to activate needs to tell those two apart.
   */
  readonly because: string
}

export interface IsolationInput {
  readonly hire: string
  readonly agentId: string
  /** The hire template's declaration, or undefined when it says nothing. */
  readonly declaredByHire: IsolationMode | undefined
  /** The profile document's default, or undefined when it says nothing. */
  readonly declaredByProfile: IsolationMode | undefined
  /** The Architect's activation choice. */
  readonly choice: ActivationIsolation
  /**
   * Whether this target can hold a worktree at all.
   *
   * A boolean rather than the `TargetKind` on purpose: `profile.ts` imports
   * this module for its schema, so importing `TargetKind` back would be a
   * cycle — and a cycle in a module zod initializes at import time is a crash,
   * not a style problem (the same reasoning `budgetSchema` carries).
   */
  readonly targetCanHoldWorktree: boolean
}

/**
 * Contract: what one hire's isolation composes to, and why. Pure; never throws.
 *
 * The order is fixed and each step is visible in the result: read the
 * declaration and remember which layer gave it, apply the Architect's blanket
 * choice, then clamp against a target that has no repository to make a
 * worktree of. The clamp is last because it is a fact about the world rather
 * than an opinion, and it can only ever loosen.
 */
export function composeIsolation(input: IsolationInput): ComposedIsolation {
  const declaredFrom: IsolationSource =
    input.declaredByHire !== undefined
      ? 'hire'
      : input.declaredByProfile !== undefined
        ? 'profile'
        : 'default'
  const declared = input.declaredByHire ?? input.declaredByProfile ?? DEFAULT_ISOLATION

  const chosen: IsolationMode =
    input.choice === 'isolate-all' ? 'worktree' : input.choice === 'none' ? 'target' : declared

  // The world's veto: an `app` target is a directory, not a repository, and
  // there is nothing to make a worktree of. Said out loud rather than silently
  // producing a spawn that would be refused at `git worktree add`.
  const effective: IsolationMode =
    chosen === 'worktree' && !input.targetCanHoldWorktree ? 'target' : chosen

  const relaxed = ISOLATION_RANK[effective] < ISOLATION_RANK[declared]
  const tightened = ISOLATION_RANK[effective] > ISOLATION_RANK[declared]

  return {
    hire: input.hire,
    agentId: input.agentId,
    declared,
    declaredFrom,
    effective,
    relaxed,
    tightened,
    because: reasonFor({ declared, declaredFrom, chosen, effective, input })
  }
}

function reasonFor(state: {
  readonly declared: IsolationMode
  readonly declaredFrom: IsolationSource
  readonly chosen: IsolationMode
  readonly effective: IsolationMode
  readonly input: IsolationInput
}): string {
  const { declared, declaredFrom, chosen, effective, input } = state

  if (chosen === 'worktree' && effective === 'target') {
    return 'this target is not a repository, so there is nothing to make a worktree of — it will work in the target directory'
  }
  if (input.choice === 'none') {
    return declared === 'target'
      ? 'it will work in your checkout, as the bundle declares'
      : 'it will work in YOUR CHECKOUT — you activated without isolation, overriding the bundle'
  }
  if (input.choice === 'isolate-all') {
    return declared === 'worktree'
      ? 'its own worktree of the target, as the bundle declares'
      : 'its own worktree — you activated with isolation for every hire, overriding the bundle'
  }
  if (effective === 'worktree') {
    return declaredFrom === 'default'
      ? 'its own worktree of the target (nothing declared isolation, so it is isolated)'
      : `its own worktree of the target, declared by the ${declaredFrom}`
  }
  return `it will work in YOUR CHECKOUT, declared by the ${declaredFrom}`
}

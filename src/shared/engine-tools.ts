import { z } from 'zod'

/**
 * The tools a hire may load into its engine (ADR-0026, M8.7b).
 *
 * ADR-0026 stopped the engine reading any settings source but the harness's, so
 * a target repository can no longer hand a semi-trusted agent hooks — and, as a
 * measured consequence, can no longer hand it skills or subagents either. That
 * is the right default: a repository is not the company. But it left a crew
 * working on THIS repository unable to reach `doc-guardian`, `spec-verifier` or
 * the `/build-package` family, which is the recursive-improvement profile's own
 * toolbox (ADR-0019).
 *
 * The Architect's decision is that the company decides what its agents run
 * with, **by name**. So a tool directory reaches an agent only because a hire
 * template said so, in a bundle the Architect reads before activating — the
 * same argument ADR-0012 makes for declaring everything else a profile may do.
 *
 * **One mechanism, not two.** The engine also accepts inline agent definitions
 * on the command line, and modelling those here as well would give a profile
 * two ways to say one thing and the harness two code paths to keep in step. A
 * directory already carries skills, subagents and commands together, so a
 * company that wants its own subagent writes it into a granted directory.
 */

/**
 * The roots a grant may be relative to. Named rather than free-form, because a
 * grant that could start with an absolute path would make "by name" meaningless
 * — the point is that the Architect can read the list and know what it reaches.
 */
export const TOOL_GRANT_ROOTS = ['target', 'home'] as const

export type ToolGrantRoot = (typeof TOOL_GRANT_ROOTS)[number]

export const toolGrantRootSchema = z.enum(TOOL_GRANT_ROOTS)

export const toolGrantSchema = z
  .object({
    /**
     * `target`: inside the repository this profile was activated on — how a
     * crew regains the tooling that repository ships.
     *
     * `home`: inside `~/.ephesus/tools/` — how the COMPANY ships its own, once,
     * in an Architect-editable place rather than copied into every bundle that
     * wants it (the same reasoning invariant §8 applies to `prompts/`).
     */
    root: toolGrantRootSchema,
    /**
     * A relative path under that root. Validated for shape here and for
     * CONTAINMENT where paths are real (`main/engines/tool-grants.ts`) — this
     * module is shared with the renderer and may not touch `node:path`, and a
     * containment check written against string prefixes rather than resolved
     * paths is the kind that passes its tests and fails on a junction.
     */
    path: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => !value.includes('\0'), 'a path, with no NUL')
  })
  .strict()

export type ToolGrant = z.infer<typeof toolGrantSchema>

/**
 * At most eight per hire. A cap rather than none, because every granted
 * directory is a directory whose skills and subagents the agent will read as
 * instructions, and a list too long to read is a list nobody read.
 */
export const toolGrantsSchema = z.array(toolGrantSchema).max(8)

/** What a hire's grants resolved to — absolute directories, in declared order. */
export interface ResolvedTools {
  readonly pluginDirs: readonly string[]
  /**
   * Grants that named a directory which is not there.
   *
   * Reported, never fatal: the precedent is `envGrants`, where a grant the
   * broker cannot supply is a visible degradation rather than a refused spawn.
   * An agent missing a tool it was promised is a diminished agent, not a
   * dangerous one — but it must never be a SILENT one, because the symptom is
   * an agent that simply does not use a skill and no one can say why.
   */
  readonly missing: readonly string[]
}

/** An agent with no profile, or a hire that declared nothing. */
export const NO_TOOLS: ResolvedTools = { pluginDirs: [], missing: [] }

/**
 * Contract: one line per grant, for the activation screen. Pure.
 *
 * The screen exists to be read before the Architect commits, so it renders what
 * the bundle DECLARED — `target:.claude` — rather than a resolved absolute
 * path. The declaration is the decision; the path is its consequence, and it is
 * the decision the Architect is being asked to approve.
 */
export function describeToolGrants(grants: readonly ToolGrant[]): readonly string[] {
  return grants.map((grant) => `${grant.root}:${grant.path}`)
}

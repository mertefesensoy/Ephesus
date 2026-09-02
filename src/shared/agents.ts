import { z } from 'zod'
import { engineIdSchema, type EngineId, type HookSupport } from './engines'
import { isReservedAgentId } from './reserved'

/**
 * The agent surface both planes share (SDD §5 `agents:` group). Main validates
 * every renderer-supplied payload with the schemas here before touching a
 * process (BUILD-PROMPT §3.2); the renderer renders `AgentCard`s and nothing
 * else — it holds no authoritative agent state.
 */

/**
 * A role's spending allowance (ADR-0011, registry §4.1 `budget`). It lives
 * here rather than in `registry.ts` because `registry.ts` already imports this
 * module for `agentIdSchema` — defining it there and importing it back would
 * be a cycle, and a cycle in a module zod initializes at import time is not a
 * style problem but a crash.
 */
export const budgetSchema = z.object({ dailyTokens: z.number().int().nonnegative() }).strict()

/** Registry-style agent ids: `agent.mason`. Kept short and filesystem-safe. */
export const agentIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^agent\.[a-z0-9][a-z0-9-]*$/, 'agent id: "agent." followed by lowercase alphanumerics')

/**
 * A hire's id. Same shape as `agentIdSchema`, minus the ids the harness writes
 * mail under (`src/shared/reserved.ts`) — a hire that took one could forge a
 * router refusal or a ledger reply in the harness's name.
 */
export const hireIdSchema = agentIdSchema.refine((id) => !isReservedAgentId(id), {
  message: 'agent id: reserved for the harness'
})

/**
 * Process lifecycle, distinct from the avatar state machine of SDD §6. This
 * answers "does a process exist and can it be talked to"; the avatar answers
 * "what is the agent doing", from the event plane. Conflating them is how a
 * floor starts inventing motion.
 *
 * `starting` is a real state, not bookkeeping: probing the engine binary and
 * installing its settings takes time, during which the id is claimed but no
 * process exists yet.
 */
export const AGENT_LIFECYCLES = [
  'starting',
  'installing',
  'missing-binary',
  'running',
  'exited'
] as const

export const agentLifecycleSchema = z.enum(AGENT_LIFECYCLES)

export type AgentLifecycle = z.infer<typeof agentLifecycleSchema>

export const spawnRequestSchema = z
  .object({
    agentId: hireIdSchema,
    name: z.string().min(1).max(64),
    role: z.string().min(1).max(64),
    engine: engineIdSchema,
    /** Target repo or worktree the agent works in. */
    cwd: z.string().min(1).max(4096),
    capabilities: z.array(z.string().min(1).max(64)).max(32).default([]),
    /**
     * Secret NAMES the role declares (ADR-0010). Values never cross this
     * boundary in either direction — the broker resolves them in main (M3).
     */
    envGrants: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'env grant: an environment variable name'))
      .max(32)
      .default([]),
    /**
     * The role's daily token budget (ADR-0011, FR-11.2). Optional exactly as
     * `registryEntrySchema.budget` is: an unbudgeted hire is legal and shows as
     * `unbudgeted` rather than as a zero the Watch would immediately breach.
     */
    budget: budgetSchema.optional(),
    /**
     * SRS UC-01 alternate 2a: give this spawn its own git worktree of the
     * target repo, so two agents in one repository cannot fight over a working
     * copy. Optional and false by default — isolation is a choice the Architect
     * makes per hire, not a default that would surprise them with a branch.
     */
    worktree: z.boolean().optional()
  })
  .strict()

export type SpawnRequest = z.infer<typeof spawnRequestSchema>

export const agentIdPayloadSchema = z.object({ agentId: agentIdSchema }).strict()

/**
 * What coming back would restore, offered when a spawn's process ends
 * (SDD §10's crash row: "respawn offer (resume if engine supports)").
 *
 * Every field is a fact, not a hope: an offer that promised a resumed session
 * for an engine with no `resume`, or memory for an agent that never wrote any,
 * would be the silent-fallback failure invariant §7 forbids — just moved into
 * the UI.
 */
export interface RespawnOffer {
  /** The adapter has `resume` AND the event plane saw a session to resume. */
  readonly resumable: boolean
  /** Dated sections waiting in `memory.md` (ADR-0006 layer 1). */
  readonly memorySections: number
  /** Ledger task ids this exit put back to `todo` (SDD §10). */
  readonly tasksReturned: readonly string[]
  /**
   * The company was parked on provider capacity when this process ended
   * (`src/shared/capacity.ts`).
   *
   * A fact, and a load-bearing one: an agent that stopped because the provider
   * refused did not crash, and a UI that says "exited" over it invites the
   * Architect to go looking for a fault there isn't one of. The harness brings
   * this agent back when capacity returns rather than offering a restart the
   * human has to remember to press.
   */
  readonly waitingForCapacity: boolean
}

/**
 * What the agent card shows (SDD §5 `agents.card`). Two rules shape it:
 * everything the harness writes into an agent's environment is inspectable
 * here (ENGINEERING-STANDARDS §4, "no hidden side effects for agents"), and no
 * secret value appears — grants are listed by name only (ADR-0010).
 */
export interface AgentCard {
  readonly agentId: string
  readonly name: string
  readonly role: string
  readonly engine: EngineId
  /** Declared hook fidelity of the engine, shown honestly even when degraded. */
  readonly hookFidelity: HookSupport
  readonly lifecycle: AgentLifecycle
  /** Engine version reported by the probe; null means "could not be determined". */
  readonly engineVersion: string | null
  readonly cwd: string
  /** PTY id to attach a terminal view to (`pty:data:<id>`). */
  readonly ptyId: string
  /** Files the harness wrote into the agent's cwd, so they can be inspected. */
  readonly settingsWritten: readonly string[]
  /** Names only — never values. */
  readonly envGrants: readonly string[]
  /** The role's daily token budget (ADR-0011), or null when unbudgeted. */
  readonly dailyTokens: number | null
  readonly capabilities: readonly string[]
  /** Where this citizen sits (`temple`, `terrace-3` — SDD §4.1, `src/shared/seats.ts`). */
  readonly seat: string
  readonly spawnedAt: string
  /** Exit code once the process is gone; null while it lives. */
  readonly exitCode: number | null
  /** Set when the process ended and coming back is possible; null while it runs. */
  readonly respawnOffer: RespawnOffer | null
  /**
   * The isolated worktree this agent works in, or null when it works directly
   * in the target repo (UC-01 alternate 2a).
   *
   * On the card because everything the harness puts in an agent's environment
   * is inspectable from it (ENGINEERING-STANDARDS §4) — a branch created in the
   * Architect's repository is exactly the kind of thing that must not be a
   * surprise.
   */
  readonly worktree: WorktreeInfo | null
}

/** Where an isolated spawn works, and on which branch (UC-01 alternate 2a). */
export interface WorktreeInfo {
  readonly path: string
  readonly branch: string
  /** True when the harness created the branch; false when it reused one. */
  readonly branchCreated: boolean
}

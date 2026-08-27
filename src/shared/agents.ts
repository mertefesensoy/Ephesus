import { z } from 'zod'
import { engineIdSchema, type EngineId, type HookSupport } from './engines'

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
    agentId: agentIdSchema,
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
    budget: budgetSchema.optional()
  })
  .strict()

export type SpawnRequest = z.infer<typeof spawnRequestSchema>

export const agentIdPayloadSchema = z.object({ agentId: agentIdSchema }).strict()

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
  readonly spawnedAt: string
  /** Exit code once the process is gone; null while it lives. */
  readonly exitCode: number | null
}

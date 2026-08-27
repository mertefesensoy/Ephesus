import { z } from 'zod'
import { agentIdSchema, budgetSchema } from './agents'
import { engineIdSchema, hookSupportSchema } from './engines'

/**
 * The roster (`agora/registry.json`, SDD §4.1) — the company's list of who
 * exists. Written only by main (ADR-0004) and read by agents as a plain file.
 *
 * Fields split three ways, following the two worked examples in §4.1: what
 * every hire has, what is present but may be empty, and what only exists once
 * something has happened (a spawn timestamp, a hook grade the adapter declared,
 * a hire template version).
 */
export const REGISTRY_SCHEMA_VERSION = 1

/** Coarse mirror of the avatar state (SDD §4.1: "mirror of avatar state, coarse"). */
export const AGENT_STATUSES = [
  'idle',
  'working',
  'waiting',
  'blocked',
  'ghost',
  'archived'
] as const

export const agentStatusSchema = z.enum(AGENT_STATUSES)

export type AgentStatus = z.infer<typeof agentStatusSchema>

/** Re-exported so `registry.budget` reads from the schema it validates with. */
export { budgetSchema }

export const hireSchema = z
  .object({ template: z.string().min(1).max(64), version: z.number().int().positive() })
  .strict()

export const registryEntrySchema = z
  .object({
    name: z.string().min(1).max(64),
    role: z.string().min(1).max(64),
    engine: engineIdSchema,
    capabilities: z.array(z.string().min(1).max(64)).max(32),
    /** Where the avatar sits on the floor, e.g. `temple`, `terrace-3`. */
    seat: z.string().min(1).max(32),
    /** Secret NAMES only — a value in the roster would be a leak (ADR-0010). */
    envGrants: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(32),
    /** Mission profile this hire belongs to, or null for a standalone agent. */
    profile: z.string().min(1).max(64).nullable(),
    /** What it works on, e.g. `repo:myapp`. */
    target: z.string().min(1).max(256).nullable(),

    isOrchestrator: z.boolean().optional(),
    status: agentStatusSchema.optional(),
    hookFidelity: hookSupportSchema.optional(),
    budget: budgetSchema.optional(),
    hire: hireSchema.optional(),
    spawnedAt: z.string().min(1).max(64).optional(),
    lastSeen: z.string().min(1).max(64).optional()
  })
  .strict()

export type RegistryEntry = z.infer<typeof registryEntrySchema>

export const registrySchema = z
  .object({
    schemaVersion: z.literal(REGISTRY_SCHEMA_VERSION),
    /** The orchestrator's id, or null before Artemis is hired (M3). */
    orchestratorId: agentIdSchema.nullable(),
    agents: z.record(agentIdSchema, registryEntrySchema)
  })
  .strict()

export type Registry = z.infer<typeof registrySchema>

export const emptyRegistry: Registry = {
  schemaVersion: REGISTRY_SCHEMA_VERSION,
  orchestratorId: null,
  agents: {}
}

/**
 * Contract: parses a roster, or explains why it could not. Never throws — a
 * corrupt roster must surface as a visible degradation, not a dead boot
 * (invariant §7), and the file is never rewritten from a guess.
 */
export function parseRegistry(
  raw: unknown
):
  | { readonly ok: true; readonly registry: Registry }
  | { readonly ok: false; readonly reason: string } {
  const parsed = registrySchema.safeParse(raw)
  if (parsed.success) return { ok: true, registry: parsed.data }
  const issue = parsed.error.issues[0]
  const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'registry'
  return { ok: false, reason: `${where}: ${issue?.message ?? 'invalid registry'}` }
}

import { z } from 'zod'

/**
 * App config (`~/.ephesus/config.json`, SDD §2). Carries no secrets — ever
 * (ADR-0010). Every schema'd file declares `schemaVersion` and validates here
 * in src/shared/ (BUILD-PROMPT §3.9); fields grow as milestones need them.
 */
export const CONFIG_SCHEMA_VERSION = 1

export const configSchema = z
  .object({
    schemaVersion: z.literal(CONFIG_SCHEMA_VERSION)
  })
  .strict()

export type EphConfig = z.infer<typeof configSchema>

export const defaultConfig: EphConfig = {
  schemaVersion: CONFIG_SCHEMA_VERSION
}

/**
 * Contract: returns the parsed config or throws ZodError with the shape
 * mismatch; never mutates its input. Callers on the main side surface a
 * visible degradation state on failure — no silent fallback (BUILD-PROMPT §3.7).
 */
export function parseConfig(raw: unknown): EphConfig {
  return configSchema.parse(raw)
}

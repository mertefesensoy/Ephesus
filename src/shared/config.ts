import { z } from 'zod'

/**
 * App config (`~/.ephesus/config.json`, SDD §2). Carries no secrets — ever
 * (ADR-0010). Every schema'd file declares `schemaVersion` and validates here
 * in src/shared/ (BUILD-PROMPT §3.9); fields grow as milestones need them.
 */
export const CONFIG_SCHEMA_VERSION = 1

export const configSchema = z
  .object({
    schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
    /**
     * Where MemPalace lives, when it is not simply `mempalace` on PATH
     * (ADR-0016 — an *optional* external, commonly installed into a virtualenv
     * or with pipx). Optional, so an existing `config.json` stays valid without
     * a migration: absent means "use the name on PATH", which is what every
     * global install gives you.
     */
    mempalaceCommand: z.string().min(1).max(4096).optional()
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

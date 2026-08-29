import { z } from 'zod'
import { companyModeSchema } from './mode'

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
    mempalaceCommand: z.string().min(1).max(4096).optional(),
    /**
     * The company mode (ADR-0018, FR-14.1): `directed` or `improving`. Optional
     * for the same reason `mempalaceCommand` is — an existing `config.json`
     * stays valid without a migration — and absent means `directed`, which is
     * the honest default: a company that has never been told to act on its own
     * initiative does not.
     */
    mode: companyModeSchema.optional(),
    /**
     * Whether `improving` has EVER been enabled. The proof gate (SRS §6.9) is a
     * first-enable check (FR-14.3): once the company has proved the loop works,
     * a later revert-and-re-enable is an ordinary Architect action, not a fresh
     * examination. Recorded here rather than inferred from the ledger, because
     * inferring it would make a rung-3 auto-revert look like the gate had never
     * been met and silently re-impose it — turning a safety stop into a
     * demotion nobody asked for.
     */
    everEnabledImproving: z.boolean().optional(),
    /**
     * The Herald's optional local wake word (FR-8.3, VOICE-DESIGN §2).
     *
     * Optional and absent-means-false, because off is the honest default:
     * NFR-10 says no audio leaves the machine while idle, and a wake word is
     * the one mode that has to be listening to work. Push-to-talk is always
     * available whatever this says (`policy.activeModes`), so enabling it adds
     * a way in and never removes one.
     *
     * DETECTION IS NOT BUILT. Turning this on today advertises the mode and
     * nothing else — no local wake-word engine is an approved dependency, and
     * shipping one that only pretended to listen would be worse than the gap.
     * Recorded as owed in DECISIONS-LOG and PROGRESS rather than faked.
     */
    wakeWordEnabled: z.boolean().optional()
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

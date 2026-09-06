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
     * A daily token ceiling for hires that declare none of their own.
     *
     * ADR-0029 made unbudgeted the DEFAULT after ceilings stopped four of five
     * agents mid-run, and it is the right default for an Architect watching
     * their own account with the figures in front of them. It is the wrong one
     * to hand a stranger: somebody installing Ephesus on their own repositories
     * should not discover uncapped spend by finding out what it cost.
     *
     * So the choice is a dial rather than a constant. Absent means unbudgeted,
     * which keeps ADR-0029's decision intact for anyone who has already made
     * it; a number means every hire without its own `budget` inherits that
     * ceiling. A hire that declares one always wins — this is a floor for the
     * silent case, never an override of a stated intent.
     *
     * Deliberately a number and not a boolean. "Budgets on" would put the
     * figure back in code, which is the thing ADR-0011's own history shows
     * going wrong twice: two million and then forty million were both chosen by
     * a program rather than by the person paying.
     */
    defaultDailyTokens: z.number().int().min(1).max(1_000_000_000).optional(),
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
    wakeWordEnabled: z.boolean().optional(),
    /**
     * Usage-aware pacing (ADR-0023). Optional and absent-means-defaults, for
     * the same no-migration reason as every field above it.
     *
     * These are Architect-facing dials rather than constants in code because
     * they encode a judgement about *their* account, not about this program:
     * how close to a limit is close enough to slow, and how much space a
     * slowed company should leave between wakes. The defaults come from the
     * Architect's own stated rule (slow at 90%) and from the measured wake
     * cadence (`DEFAULT_SLOW_WAKE_GAP_MS`).
     */
    pacing: z
      .object({
        /** Used-percentage at which the company slows down. */
        slowAtPercent: z.number().min(1).max(100).optional(),
        /** Used-percentage at which it holds until the window resets. */
        holdAtPercent: z.number().min(1).max(200).optional(),
        /** Minimum gap between one agent's wakes while pacing `slow`, ms. */
        slowWakeGapMs: z
          .number()
          .int()
          .min(0)
          .max(6 * 60 * 60 * 1000)
          .optional(),
        /**
         * Wall-clock cap on a single wake, ms — the second, independent limit.
         * A floor of one minute: anything under that would interrupt ordinary
         * work, whose measured median wake was 49 s.
         */
        wakeCapMs: z
          .number()
          .int()
          .min(60 * 1000)
          .max(6 * 60 * 60 * 1000)
          .optional()
      })
      .strict()
      .optional()
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

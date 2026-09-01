import { z } from 'zod'
import { profileNameSchema } from './profile'
import { activationTargetSchema, targetRef } from './profile-activation'

/**
 * The targets an Architect has already activated a profile against
 * (`<harness home>/known-targets.json`).
 *
 * Activation asks for a working directory, and a working directory is a long
 * absolute path that nobody wants to retype. Nothing persisted it: the live
 * instances live in an in-memory Map, so every restart returned the panel to an
 * empty form and the same path had to be typed again from memory. This file is
 * the smallest thing that fixes that — a list of what has been activated
 * before, so the panel can offer it instead of asking.
 *
 * What it deliberately is NOT: a list of what should be running. Restoring it
 * on boot would spawn agents nobody asked for at that moment, and "the harness
 * started a company while I was making coffee" is a different feature with a
 * different consent story. This remembers the *typing*, not the decision.
 */
export const KNOWN_TARGETS_SCHEMA_VERSION = 1

/**
 * How many rows the panel keeps. A cap rather than none: the file is read on
 * every profiles list, and an unbounded list of every directory ever typed is a
 * slow panel and a privacy footprint nobody chose.
 */
export const KNOWN_TARGETS_LIMIT = 50

/**
 * The schema's ceiling, above the working limit so that a file hand-edited to
 * hold a few more rows is read rather than refused.
 */
export const KNOWN_TARGETS_MAX = 200

export const knownTargetSchema = z
  .object({
    profile: profileNameSchema,
    target: activationTargetSchema,
    /** ISO-8601, from the activation that last used it. */
    lastUsedAt: z.string().min(1).max(64)
  })
  .strict()

export type KnownTarget = z.infer<typeof knownTargetSchema>

export const knownTargetsFileSchema = z
  .object({
    schemaVersion: z.literal(KNOWN_TARGETS_SCHEMA_VERSION),
    targets: z.array(knownTargetSchema).max(KNOWN_TARGETS_MAX)
  })
  .strict()

export type KnownTargetsFile = z.infer<typeof knownTargetsFileSchema>

/**
 * Contract: pure. Returns the list with `entry` remembered — most recently used
 * first, one row per (profile, target), never longer than `limit`.
 *
 * Upserting on (profile, kind, id) rather than on the whole row is what makes a
 * moved repository work: activating `repo:musahit` from a new directory updates
 * the remembered path instead of leaving two rows that differ only in a detail
 * the Architect cannot see on a chip.
 */
export function rememberTarget(
  known: readonly KnownTarget[],
  entry: KnownTarget,
  limit: number = KNOWN_TARGETS_LIMIT
): readonly KnownTarget[] {
  const key = `${entry.profile} ${targetRef(entry.target)}`
  const rest = known.filter((row) => `${row.profile} ${targetRef(row.target)}` !== key)
  return [entry, ...rest].slice(0, Math.max(1, limit))
}

/** Contract: pure. The rows for one profile, most recently used first. */
export function knownTargetsFor(
  known: readonly KnownTarget[],
  profile: string
): readonly KnownTarget[] {
  return known.filter((row) => row.profile === profile)
}

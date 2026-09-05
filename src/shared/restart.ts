import { z } from 'zod'

/**
 * Records a restart restores that have no domain module of their own (M8.8).
 *
 * Activations live in `profile-activation.ts` and gates in `gates.ts`, beside
 * the types they validate. What is left is the scheduler's clock, which
 * belongs to no subsystem's vocabulary.
 *
 * ## What is deliberately NOT here, and why
 *
 * The 2026-09-02 register listed five things as lost at restart. Three of them
 * are not lost, and building stores for them would have added state the tree
 * already answers better:
 *
 * - **Incident correlation** is in memory *by a recorded decision*
 *   (`incidents.ts`, the `raised` set): a restart SHOULD re-raise a
 *   still-failing incident, because nobody can be sure the earlier triage
 *   request survived in an inbox, and a duplicate incident is a cheap failure
 *   while a dropped one is the subsystem not working. Persisting it would
 *   quietly reverse that decision.
 * - **Capacity parks** are derived, not held: `CapacityWatch` re-reads the tail
 *   of each transcript every tick and re-parks from the same refusal record
 *   (that is what its `handled` set exists to deduplicate). It also iterates
 *   LIVE agents, and after a restart there are none until the Architect
 *   rehires. Known bounded loss: the retry `attempts` rung resets, so the first
 *   retry after a restart comes sooner than the ladder intended; the next
 *   refusal re-parks one rung higher, so it self-corrects.
 * - **Breaker rungs 1-2** are observations about a process — they are computed
 *   from that process's own turn spans. A rehired agent is a new process that
 *   has not looped, has not errored and has no hop escalations, so restoring a
 *   rung onto it would assert a condition that is not true of it. Rung-3
 *   **stops** are different in kind — a standing decision about an agent
 *   identity, not an observation — which is exactly why M8.6 persisted those
 *   and only those.
 */

export const TRIGGERS_REL = 'triggers.json'

export const triggersRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    /**
     * Trigger id → epoch ms it last fired.
     *
     * The one piece of scheduler state a restart cannot re-derive. Everything
     * else about a trigger comes back with the activation that armed it; when
     * it last fired is known only to the scheduler, and losing it makes every
     * restored trigger due immediately — so a machine that reboots nightly
     * runs its daily jobs twice, and one that crash-loops runs them on every
     * boot.
     */
    lastFired: z.record(z.string().min(1).max(128), z.number().int().nonnegative())
  })
  .strict()
export type TriggersRecord = z.infer<typeof triggersRecordSchema>
export const EMPTY_TRIGGERS: TriggersRecord = { schemaVersion: 1, lastFired: {} }

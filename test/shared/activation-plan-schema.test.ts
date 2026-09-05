import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  activationPlanSchema,
  composedAutonomySchema,
  plannedHireSchema,
  profileInstanceSchema,
  type ActivationPlan,
  type ComposedAutonomy,
  type PlannedHire
} from '../../src/shared/profile-activation'
import { composedIsolationSchema, type ComposedIsolation } from '../../src/shared/isolation'
import type { ProfileInstance } from '../../src/main/profiles'

/**
 * `true` only when A and B are mutually assignable — so a field added to one
 * side and not the other collapses this to `false`, and the `= true` below
 * stops compiling.
 *
 * The wrapping in a tuple is what makes it exact rather than merely
 * assignable: `[A] extends [B]` defeats the distribution that would let a
 * union quietly satisfy one of its own members.
 */
type Exact<A, B> = [Mutable<A>] extends [Mutable<B>]
  ? [Mutable<B>] extends [Mutable<A>]
    ? true
    : false
  : false

/**
 * Compares FIELDS, not variance. The interfaces declare `readonly` throughout
 * and zod infers mutable types; `readonly T[]` is not assignable to `T[]`, so
 * without this every assertion would fail for a reason that has nothing to do
 * with the shape on disk. Stripping `readonly` from both sides leaves exactly
 * the drift that matters: a field added, removed, renamed or retyped.
 */
type Mutable<T> = T extends readonly (infer E)[]
  ? Mutable<E>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T

/**
 * The restart record persists the activation plan verbatim (M8.8), so every
 * part of the plan needs a validator that describes the SAME shape as the
 * interface the rest of the code reads.
 *
 * These assertions are checked by `npm run typecheck`, not at runtime —
 * `test/**` is inside `tsconfig.node.json`. That is the point: a drifted
 * schema must fail the build, not a test run, because the failure it prevents
 * (a plan written with a field the next boot silently drops) is invisible
 * until a restart that may be weeks away.
 */
describe('the plan schema and the plan interface cannot drift', () => {
  it('ComposedIsolation', () => {
    const proof: Exact<z.infer<typeof composedIsolationSchema>, ComposedIsolation> = true
    expect(proof).toBe(true)
  })

  it('ComposedAutonomy', () => {
    const proof: Exact<z.infer<typeof composedAutonomySchema>, ComposedAutonomy> = true
    expect(proof).toBe(true)
  })

  it('PlannedHire', () => {
    const proof: Exact<z.infer<typeof plannedHireSchema>, PlannedHire> = true
    expect(proof).toBe(true)
  })

  it('ActivationPlan', () => {
    const proof: Exact<z.infer<typeof activationPlanSchema>, ActivationPlan> = true
    expect(proof).toBe(true)
  })

  /**
   * The instance is what `planFor` walks, so its `agentIds` and `armed` are
   * load-bearing for tool grants and autonomy after a restart, not decoration.
   */
  it('ProfileInstance', () => {
    const proof: Exact<z.infer<typeof profileInstanceSchema>, ProfileInstance> = true
    expect(proof).toBe(true)
  })
})

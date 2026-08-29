import { describe, expect, it } from 'vitest'
import { stoaCadenceTick, type StoaCadenceDeps } from '../../src/main/stoa-cadence'
import { isImprovementRole } from '../../src/shared/mode'

/**
 * The SHIPPED Stoa-cadence tick (M5b close-out audit, finding 5) and the
 * shared role test that gates FR-14.5's mode revert (finding 12).
 */

function rig(over: Partial<StoaCadenceDeps> = {}): {
  deps: StoaCadenceDeps
  logged: Record<string, unknown>[]
} {
  const logged: Record<string, unknown>[] = []
  const deps: StoaCadenceDeps = {
    sources: () => [
      { id: 'src-unpinned', pin: null },
      { id: 'src-pinned', pin: 'b91a49f' }
    ],
    plan: () => ({ ok: true }),
    mode: () => 'improving',
    appendLog: (draft) => logged.push(draft),
    ...over
  }
  return { deps, logged }
}

describe('stoaCadenceTick — the shipped body the scheduler runs', () => {
  it('picks the first PINNED source, plans it, and logs the mode tag (FR-14.1)', () => {
    const { deps, logged } = rig()
    const outcome = stoaCadenceTick(deps)
    expect(outcome).toEqual({ fired: true, sourceId: 'src-pinned' })
    expect(logged).toEqual([
      {
        kind: 'stoa',
        event: 'cadence-fired',
        sourceId: 'src-pinned',
        mode: 'improving',
        planned: true
      }
    ])
  })

  it('logs an idle heartbeat when nothing is studiable — never invents a study', () => {
    const { deps, logged } = rig({ sources: () => [{ id: 'src-unpinned', pin: null }] })
    expect(stoaCadenceTick(deps)).toEqual({ fired: false, sourceId: null })
    expect(logged[0]).toMatchObject({ kind: 'stoa', event: 'cadence-idle' })
  })

  it('records a failed plan honestly (planned: false), still on the record', () => {
    const { deps, logged } = rig({ plan: () => ({ ok: false }) })
    expect(stoaCadenceTick(deps).fired).toBe(true)
    expect(logged[0]).toMatchObject({ event: 'cadence-fired', planned: false })
  })
})

describe('isImprovementRole — exact roles, not substrings (FR-14.5)', () => {
  it('matches the roles autonomy creates', () => {
    expect(isImprovementRole('researcher')).toBe(true)
    expect(isImprovementRole('improver')).toBe(true)
    expect(isImprovementRole('  Researcher ')).toBe(true)
  })

  it("refuses the audit's own counter-example and mission roles", () => {
    // The old substring heuristic counted this mission hire as gym work and
    // would have reverted the mode over a stop that had nothing to do with it.
    expect(isImprovementRole('process-improver-docs')).toBe(false)
    expect(isImprovementRole('ci-babysitter')).toBe(false)
    expect(isImprovementRole('research-lead')).toBe(false)
    expect(isImprovementRole('')).toBe(false)
  })
})

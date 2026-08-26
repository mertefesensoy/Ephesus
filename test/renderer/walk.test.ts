import { describe, expect, it } from 'vitest'
import {
  MS_PER_TILE,
  patrolPose,
  steppedProgress,
  STEPS_PER_TILE,
  TILE_PX,
  walkPose
} from '../../src/renderer/src/floor/walk'

describe('stepped easing (UI-DESIGN §6: 250 ms/tile, 4–6 frames, never smooth)', () => {
  it('uses the documented motion constants', () => {
    expect(MS_PER_TILE).toBe(250)
    expect(STEPS_PER_TILE).toBeGreaterThanOrEqual(4)
    expect(STEPS_PER_TILE).toBeLessThanOrEqual(6)
    expect(TILE_PX).toBe(32)
  })

  it('quantizes progress to discrete steps', () => {
    const steps = 5
    // mid-step times must snap to the step below — no smooth interpolation
    expect(steppedProgress(0, 250, steps)).toBe(0)
    expect(steppedProgress(49, 250, steps)).toBe(0)
    expect(steppedProgress(50, 250, steps)).toBe(0.2)
    expect(steppedProgress(99, 250, steps)).toBe(0.2)
    expect(steppedProgress(125, 250, steps)).toBe(0.4)
    expect(steppedProgress(250, 250, steps)).toBe(1)
  })

  it('clamps outside the duration window', () => {
    expect(steppedProgress(-10, 250, 5)).toBe(0)
    expect(steppedProgress(9999, 250, 5)).toBe(1)
  })

  it('throws on degenerate inputs', () => {
    expect(() => steppedProgress(0, 0, 5)).toThrow()
    expect(() => steppedProgress(0, 250, 0)).toThrow()
  })
})

describe('walkPose', () => {
  const a = { x: 0, y: 0 }
  const b = { x: 4 * TILE_PX, y: 0 } // 4 tiles → 1000 ms, 20 steps

  it('takes exactly MS_PER_TILE per tile', () => {
    expect(walkPose(a, b, 0).x).toBe(0)
    expect(walkPose(a, b, 4 * MS_PER_TILE).done).toBe(true)
    expect(walkPose(a, b, 4 * MS_PER_TILE).x).toBe(4 * TILE_PX)
    expect(walkPose(a, b, 4 * MS_PER_TILE - 1).done).toBe(false)
  })

  it('moves in quantized increments, never smoothly', () => {
    const stepPx = (4 * TILE_PX) / 20
    const seen = new Set<number>()
    for (let t = 0; t <= 1000; t += 7) seen.add(walkPose(a, b, t).x)
    seen.add(walkPose(a, b, 1000).x) // exact endpoint (stride 7 skips t=1000)
    for (const x of seen) {
      const ratio = x / stepPx
      expect(Math.abs(ratio - Math.round(ratio))).toBeLessThan(1e-9)
    }
    expect(seen.size).toBe(21) // 20 steps + start
  })

  it('faces the walk direction', () => {
    expect(walkPose(a, b, 100).facing).toBe(1)
    expect(walkPose(b, a, 100).facing).toBe(-1)
  })

  it('alternates gait frames per step', () => {
    const atStep = (n: number): 0 | 1 => walkPose(a, b, n * 50).frame
    expect(atStep(0)).toBe(0)
    expect(atStep(1)).toBe(1)
    expect(atStep(2)).toBe(0)
  })
})

describe('patrolPose', () => {
  const a = { x: 2 * TILE_PX, y: 4 * TILE_PX }
  const b = { x: 11 * TILE_PX, y: 4 * TILE_PX } // 9 tiles → 2250 ms per leg

  it('walks A→B then B→A and loops', () => {
    const leg = 9 * MS_PER_TILE
    expect(patrolPose(a, b, 0)).toMatchObject({ x: a.x, facing: 1 })
    expect(patrolPose(a, b, leg - 1).facing).toBe(1)
    expect(patrolPose(a, b, leg + 1).facing).toBe(-1)
    expect(patrolPose(a, b, 2 * leg + 1).facing).toBe(1) // wrapped
  })

  it('is pure — same elapsed, same pose', () => {
    expect(patrolPose(a, b, 1234)).toEqual(patrolPose(a, b, 1234))
  })

  it('degenerates safely when the waypoints coincide', () => {
    expect(patrolPose(a, a, 500)).toMatchObject({ x: a.x, y: a.y, done: true })
  })
})

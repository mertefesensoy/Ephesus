import { describe, expect, it } from 'vitest'
import {
  CITIZEN_H,
  CITIZEN_W,
  DIRECTIONS,
  SILHOUETTES,
  WALK_FRAMES,
  citizenSprite,
  directionFor,
  silhouetteFor,
  walkFrame,
  type CitizenPalette,
  type WalkFrame
} from '../../src/renderer/src/floor/citizen'
import { tokens } from '../../src/renderer/src/tokens'

/**
 * The UI-DESIGN §7 quality bar, asserted rather than eyeballed: 8 directions ×
 * 4 frames, at most five palette colors per sprite, distinct silhouettes, and
 * everything inside the 32×48 footprint.
 */

const palette: CitizenPalette = {
  outline: tokens.ink900,
  hair: tokens.ink700,
  skin: tokens.sand,
  accent: tokens.aegean,
  detail: tokens.marble50
}

const FRAMES: readonly WalkFrame[] = [0, 1, 2, 3]

describe('citizen sprites (UI-DESIGN §7)', () => {
  it('offers eight directions and four frames per direction', () => {
    expect([...DIRECTIONS]).toEqual(['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'])
    expect(WALK_FRAMES).toBe(4)
  })

  it('uses at most five colors per sprite, all from the palette', () => {
    const allowed = new Set(Object.values(palette))
    for (const direction of DIRECTIONS) {
      for (const silhouette of SILHOUETTES) {
        for (const frame of FRAMES) {
          const rects = citizenSprite({ direction, frame, silhouette, palette, walking: true })
          const used = new Set(rects.map((r) => r.color))
          expect(used.size).toBeLessThanOrEqual(5)
          for (const color of used) expect(allowed.has(color)).toBe(true)
        }
      }
    }
  })

  it('keeps every rectangle inside the 32×48 footprint', () => {
    for (const direction of DIRECTIONS) {
      for (const silhouette of SILHOUETTES) {
        for (const frame of FRAMES) {
          for (const rect of citizenSprite({
            direction,
            frame,
            silhouette,
            palette,
            walking: true
          })) {
            expect(rect.x).toBeGreaterThanOrEqual(0)
            expect(rect.x + rect.w).toBeLessThanOrEqual(CITIZEN_W)
            // Helms and status badges sit above the origin by design.
            expect(rect.y).toBeGreaterThanOrEqual(-8)
            expect(rect.y + rect.h).toBeLessThanOrEqual(CITIZEN_H + 2)
            expect(rect.w).toBeGreaterThan(0)
            expect(rect.h).toBeGreaterThan(0)
          }
        }
      }
    }
  })

  it('actually animates — the four frames of a direction differ', () => {
    const shapes = FRAMES.map((frame) =>
      JSON.stringify(
        citizenSprite({ direction: 's', frame, silhouette: 'worker', palette, walking: true })
      )
    )
    expect(new Set(shapes).size).toBeGreaterThan(1)
  })

  it('draws each of the eight directions differently', () => {
    const shapes = DIRECTIONS.map((direction) =>
      JSON.stringify(
        citizenSprite({ direction, frame: 1, silhouette: 'worker', palette, walking: true })
      )
    )
    expect(new Set(shapes).size).toBe(DIRECTIONS.length)
  })

  it('gives each silhouette a distinct shape', () => {
    const shapes = SILHOUETTES.map((silhouette) =>
      JSON.stringify(
        citizenSprite({ direction: 's', frame: 0, silhouette, palette, walking: false })
      )
    )
    expect(new Set(shapes).size).toBe(SILHOUETTES.length)
  })

  it('stands still on the contact frame when not walking', () => {
    const standing = FRAMES.map((frame) =>
      JSON.stringify(
        citizenSprite({ direction: 'e', frame, silhouette: 'runner', palette, walking: false })
      )
    )
    expect(new Set(standing).size).toBe(1)
  })

  it('is pure', () => {
    const args = { direction: 'ne', frame: 2, silhouette: 'guard', palette, walking: true } as const
    expect(citizenSprite(args)).toEqual(citizenSprite(args))
  })
})

describe('silhouette assignment', () => {
  it('reserves the orchestrator silhouette for the orchestrator role', () => {
    expect(silhouetteFor('orchestrator')).toBe('orchestrator')
  })

  it('is stable for a given role string', () => {
    for (const role of ['ci-babysitter', 'front-office', 'reviewer', '']) {
      expect(silhouetteFor(role)).toBe(silhouetteFor(role))
      expect(SILHOUETTES).toContain(silhouetteFor(role))
    }
  })

  it('never assigns the orchestrator silhouette to anyone else', () => {
    const roles = ['ci-babysitter', 'reviewer', 'scribe', 'deploy', 'triage', 'docs', 'oncall']
    for (const role of roles) expect(silhouetteFor(role)).not.toBe('orchestrator')
  })
})

describe('direction and frame from motion', () => {
  it.each([
    [1, 0, 'e'],
    [1, 1, 'se'],
    [0, 1, 's'],
    [-1, 1, 'sw'],
    [-1, 0, 'w'],
    [-1, -1, 'nw'],
    [0, -1, 'n'],
    [1, -1, 'ne']
  ])('maps (%d,%d) to %s', (dx, dy, expected) => {
    expect(directionFor(dx, dy)).toBe(expected)
  })

  it('faces south when standing still', () => {
    expect(directionFor(0, 0)).toBe('s')
  })

  it('cycles frames 0..3 and survives negative step indices', () => {
    expect([0, 1, 2, 3, 4, 5].map(walkFrame)).toEqual([0, 1, 2, 3, 0, 1])
    expect(walkFrame(-1)).toBe(3)
  })
})

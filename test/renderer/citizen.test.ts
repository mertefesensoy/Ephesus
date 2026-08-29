import { describe, expect, it } from 'vitest'
import {
  CITIZEN_H,
  CITIZEN_W,
  DIRECTIONS,
  FOOT_ROWS,
  FOOT_TOP,
  FRAME_MS,
  FRAMES_PER_TILE,
  HEADROOM_ROWS,
  ROLE_SILHOUETTES,
  SILHOUETTES,
  WALK_FRAMES,
  citizenSprite,
  directionFor,
  frameAt,
  silhouetteFor,
  walkFrame,
  type CitizenPalette,
  type Direction,
  type Silhouette,
  type SpriteRect,
  type WalkFrame
} from '../../src/renderer/src/floor/citizen'
import { MS_PER_TILE } from '../../src/renderer/src/floor/walk'
import { tokens } from '../../src/renderer/src/tokens'

/**
 * UI-DESIGN §5.1, asserted rather than eyeballed. The four clauses that are
 * easy to regress — the head-room reservation, the planted feet, the ±1 px bob
 * sampled at frame boundaries, and above all the ban on runtime flips — each
 * get a test that would fail if the clause were quietly dropped.
 */

const palette: CitizenPalette = {
  outline: tokens.ink900,
  hair: tokens.ink700,
  skin: tokens.sand,
  primary: tokens.aegean,
  secondary: tokens.marble50
}

const FRAMES: readonly WalkFrame[] = [0, 1, 2, 3]

function sprite(
  direction: Direction,
  frame: WalkFrame,
  silhouette: Silhouette,
  walking = true
): readonly SpriteRect[] {
  return citizenSprite({ direction, frame, silhouette, palette, walking })
}

/** Every (direction × frame × silhouette) the floor can ask for. */
function everySprite(): { key: string; rects: readonly SpriteRect[] }[] {
  const all: { key: string; rects: readonly SpriteRect[] }[] = []
  for (const direction of DIRECTIONS) {
    for (const frame of FRAMES) {
      for (const silhouette of SILHOUETTES) {
        all.push({
          key: `${direction}/${String(frame)}/${silhouette}`,
          rects: sprite(direction, frame, silhouette)
        })
      }
    }
  }
  return all
}

describe('citizen anatomy (UI-DESIGN §5.1)', () => {
  it('is a 32×48 cell with eight directions and four frames', () => {
    expect([CITIZEN_W, CITIZEN_H]).toEqual([32, 48])
    expect([...DIRECTIONS]).toEqual(['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'])
    expect(DIRECTIONS.length).toBe(8)
    expect(WALK_FRAMES).toBe(4)
  })

  it('steps at 125 ms — exactly two frames per 250 ms tile walk', () => {
    expect(FRAME_MS).toBe(125)
    expect(MS_PER_TILE / FRAME_MS).toBe(FRAMES_PER_TILE)
    expect(FRAMES_PER_TILE).toBe(2)
  })

  it('samples the frame at 125 ms boundaries only', () => {
    // Inside a frame the value never moves; it changes only on the boundary.
    expect(frameAt(0)).toBe(0)
    expect(frameAt(124)).toBe(0)
    expect(frameAt(125)).toBe(1)
    expect(frameAt(249)).toBe(1)
    expect(frameAt(250)).toBe(2)
    expect(frameAt(500)).toBe(0)
    // Negative elapsed clamps rather than reading a negative frame.
    expect(frameAt(-1)).toBe(0)
  })

  it('leaves rows 0-7 clear for the §5.2 overlays, at every bob phase', () => {
    expect(HEADROOM_ROWS).toBe(8)
    for (const { key, rects } of everySprite()) {
      for (const rect of rects) {
        expect(rect.y, `${key} enters the overlay head-room`).toBeGreaterThanOrEqual(HEADROOM_ROWS)
      }
    }
  })

  it('keeps every rectangle inside the 32×48 cell', () => {
    for (const { key, rects } of everySprite()) {
      for (const rect of rects) {
        expect(rect.x, key).toBeGreaterThanOrEqual(0)
        expect(rect.x + rect.w, key).toBeLessThanOrEqual(CITIZEN_W)
        expect(rect.y + rect.h, key).toBeLessThanOrEqual(CITIZEN_H)
      }
    }
  })

  it('plants the feet in the bottom four rows through the whole cycle', () => {
    expect([FOOT_TOP, FOOT_ROWS]).toEqual([44, 4])
    for (const direction of DIRECTIONS) {
      for (const frame of FRAMES) {
        const feet = sprite(direction, frame, 'builder').filter((r) => r.y === FOOT_TOP)
        // Two feet, both exactly the bottom four rows: the bob lifts the body,
        // never the feet, which is what keeps the sprite inside its cell.
        expect(feet.length, `${direction}/${String(frame)}`).toBe(2)
        for (const foot of feet) expect(foot.h).toBe(FOOT_ROWS)
      }
    }
  })

  it('bobs the body ±1 px, level on the two idle frames', () => {
    for (const direction of DIRECTIONS) {
      const headTop = (frame: WalkFrame): number =>
        Math.min(...sprite(direction, frame, 'builder').map((r) => r.y))
      const level = headTop(0)
      expect(headTop(2), `${direction} idle frames must be level`).toBe(level)
      expect(headTop(1) - level, `${direction} step-A rises 1 px`).toBe(-1)
      expect(headTop(3) - level, `${direction} step-B falls 1 px`).toBe(1)
    }
  })

  it('does not bob a standing citizen (§6 bans ambient idle motion)', () => {
    for (const direction of DIRECTIONS) {
      const still = sprite(direction, 0, 'builder', false)
      // Every walk frame collapses to the idle pose when not walking.
      for (const frame of FRAMES) {
        expect(sprite(direction, frame, 'builder', false), `${direction}/${String(frame)}`).toEqual(
          still
        )
      }
    }
  })

  it('uses at most five colours per sprite, all from the palette', () => {
    const allowed = new Set(Object.values(palette))
    for (const { key, rects } of everySprite()) {
      const used = new Set(rects.map((r) => r.color))
      expect(used.size, `${key} exceeds the five-colour budget`).toBeLessThanOrEqual(5)
      for (const color of used)
        expect(allowed.has(color), `${key} uses ${String(color)}`).toBe(true)
    }
  })

  it('is deterministic — same arguments, same rectangles', () => {
    for (const direction of DIRECTIONS) {
      for (const frame of FRAMES) {
        expect(sprite(direction, frame, 'scribe')).toEqual(sprite(direction, frame, 'scribe'))
      }
    }
  })
})

describe('eight DRAWN directions — no runtime flips (§5.1)', () => {
  /** What a mirror would have produced, had the module taken that shortcut. */
  const mirrored = (rects: readonly SpriteRect[]): SpriteRect[] =>
    rects
      .map((r) => ({ ...r, x: CITIZEN_W - r.x - r.w }))
      .sort((a, b) => a.x - b.x || a.y - b.y || a.w - b.w || a.h - b.h)

  const sorted = (rects: readonly SpriteRect[]): SpriteRect[] =>
    [...rects].sort((a, b) => a.x - b.x || a.y - b.y || a.w - b.w || a.h - b.h)

  const PAIRS: readonly [Direction, Direction][] = [
    ['e', 'w'],
    ['se', 'sw'],
    ['ne', 'nw']
  ]

  it('does not build a westward direction by flipping its eastward twin', () => {
    // The clause this protects: "diagonals are frames, not runtime flips (a
    // flip breaks asymmetric silhouettes: a satchel, a scroll case)". If the
    // module ever goes back to mirroring, these become equal and this fails.
    for (const [east, west] of PAIRS) {
      for (const frame of FRAMES) {
        for (const silhouette of SILHOUETTES) {
          expect(
            sorted(sprite(west, frame, silhouette)),
            `${west} is a flip of ${east} (${silhouette}, frame ${String(frame)})`
          ).not.toEqual(mirrored(sprite(east, frame, silhouette)))
        }
      }
    }
  })

  it('draws all eight directions distinctly', () => {
    for (const frame of FRAMES) {
      const seen = new Map<string, Direction>()
      for (const direction of DIRECTIONS) {
        const key = JSON.stringify(sprite(direction, frame, 'researcher'))
        expect(seen.has(key), `${direction} duplicates ${String(seen.get(key))}`).toBe(false)
        seen.set(key, direction)
      }
    }
  })
})

describe('role silhouettes (§5.1 table)', () => {
  it('names the six roles the table prints', () => {
    expect([...SILHOUETTES]).toEqual([
      'orchestrator',
      'scribe',
      'builder',
      'researcher',
      'watch',
      'herald'
    ])
  })

  it('reserves the orchestrator silhouette for Artemis alone', () => {
    expect(silhouetteFor('orchestrator')).toBe('orchestrator')
    for (const role of ['engineer', 'scribe', 'researcher', 'watch', 'herald', 'ci-babysitter']) {
      if (role === 'orchestrator') continue
      expect(silhouetteFor(role), role).not.toBe('orchestrator')
    }
  })

  it('maps the documented vocabulary exactly, not by substring', () => {
    for (const [role, silhouette] of Object.entries(ROLE_SILHOUETTES)) {
      expect(silhouetteFor(role), role).toBe(silhouette)
      expect(silhouetteFor(role.toUpperCase()), role).toBe(silhouette)
    }
    // The M5b audit's counter-example class, one domain over: a compound role
    // must not inherit a silhouette from a word it merely contains.
    const compound = silhouetteFor('process-improver-docs')
    expect(compound).not.toBe('scribe')
    expect(silhouetteFor('process-improver-docs')).toBe(compound) // still deterministic
  })

  it('assigns unknown roles deterministically and totally', () => {
    for (const role of ['', 'ci-babysitter', 'worker', 'ci', 'improver', 'νεωκόρος']) {
      const first = silhouetteFor(role)
      expect(SILHOUETTES).toContain(first)
      expect(silhouetteFor(role), role).toBe(first)
    }
  })

  /**
   * The silhouette prop is appended last by `citizenSprite`, and the body is
   * identical across silhouettes for a given direction — so the shortest
   * sprite in a direction IS the body, and everything past it is the prop.
   * Comparing rectangle counts across *different* directions would not work:
   * a back view draws no eyes, so the bodies differ.
   */
  const propsOf = (silhouette: Silhouette, direction: Direction): SpriteRect[] => {
    const bodyLen = Math.min(...SILHOUETTES.map((s) => sprite(direction, 0, s).length))
    return [...sprite(direction, 0, silhouette)].slice(bodyLen)
  }

  it('cuts each signature element at the size the table prints', () => {
    // Scroll case slung on the back, 3×8 — read from behind, where it shows.
    expect(propsOf('scribe', 'n')).toContainEqual(
      expect.objectContaining({ w: 3, h: 8, color: palette.secondary })
    )
    // Shoulder satchel + tablet, 4×5.
    expect(propsOf('researcher', 'e')).toContainEqual(
      expect.objectContaining({ w: 4, h: 5, color: palette.secondary })
    )
    // Cloak clasp, 2×2 at the collar.
    expect(propsOf('watch', 's')).toContainEqual(
      expect.objectContaining({ w: 2, h: 2, color: palette.secondary })
    )
    // Lyre pin, 3×3 at the chest.
    expect(propsOf('herald', 's')).toContainEqual(
      expect.objectContaining({ w: 3, h: 3, color: palette.secondary })
    )
    // Laurel circlet, 2 px — a band across the head, in Artemis's own colour.
    expect(propsOf('orchestrator', 's')).toContainEqual(
      expect.objectContaining({ h: 2, color: palette.primary })
    )
    // Tool belt, 2 px waist band, as wide as the torso it wraps.
    expect(propsOf('builder', 's')).toContainEqual(
      expect.objectContaining({ h: 2, color: palette.secondary })
    )
  })

  it('keeps a back-slung prop off the front views, and vice versa', () => {
    // The scroll case is worn on the back: present from behind, gone in front.
    expect(propsOf('scribe', 'n').length).toBe(1)
    expect(propsOf('scribe', 's').length).toBe(0)
    // The lyre pin is worn on the chest: the other way round.
    expect(propsOf('herald', 's').length).toBe(1)
    expect(propsOf('herald', 'n').length).toBe(0)
    // A prop that wraps the body is visible from every side — no view loses it.
    for (const direction of DIRECTIONS) {
      expect(propsOf('builder', direction).length, direction).toBe(1)
      expect(propsOf('orchestrator', direction).length, direction).toBe(1)
    }
  })
})

describe('walk helpers', () => {
  it('reads the compass direction of a walk, south when standing', () => {
    expect(directionFor(0, 0)).toBe('s')
    expect(directionFor(1, 0)).toBe('e')
    expect(directionFor(-1, 0)).toBe('w')
    expect(directionFor(0, 1)).toBe('s')
    expect(directionFor(0, -1)).toBe('n')
    expect(directionFor(1, 1)).toBe('se')
    expect(directionFor(-1, -1)).toBe('nw')
  })

  it('wraps the frame index in both directions', () => {
    expect(walkFrame(0)).toBe(0)
    expect(walkFrame(4)).toBe(0)
    expect(walkFrame(5)).toBe(1)
    expect(walkFrame(-1)).toBe(3)
  })
})

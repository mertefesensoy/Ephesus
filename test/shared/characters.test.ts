import { describe, expect, it } from 'vitest'
import {
  CHARACTERS_SCHEMA_VERSION,
  SHEET_FACINGS,
  characterFrame,
  charactersManifestSchema,
  facingFor,
  sheetForAgent,
  type CharactersManifest
} from '../../src/shared/characters'

const MANIFEST: CharactersManifest = {
  schemaVersion: CHARACTERS_SCHEMA_VERSION,
  name: 'test pack',
  sheets: ['a.png', 'b.png', 'c.png'],
  frameW: 16,
  frameH: 32,
  idleRow: 0,
  walkRow: 1,
  walkFrames: 6
}

/**
 * The sheet's four facings, in the order the pack lays them out, were MEASURED
 * rather than read off by eye — and the measurement corrected a first reading
 * that had column 12 wrong. Skin-pixel centroid of `Premade_Character_01`:
 * +1.82 px at column 0, a back-of-head at column 1, -1.82 at column 2, a
 * face-on at column 3, and the same pattern at columns 0/6/12/18 of the walk
 * row. Getting this wrong makes every citizen walk backwards, which is the sort
 * of thing that looks like a physics bug for a week.
 */
describe('which way a citizen is drawn facing', () => {
  it('draws a diagonal as its HORIZONTAL facing, so a face stays visible', () => {
    // The back of a head shows nothing. `ne` as north would turn a citizen away
    // from the room for a walk that is mostly sideways.
    expect(facingFor('ne')).toBe('east')
    expect(facingFor('se')).toBe('east')
    expect(facingFor('nw')).toBe('west')
    expect(facingFor('sw')).toBe('west')
  })

  it('draws the cardinals as themselves', () => {
    expect(facingFor('e')).toBe('east')
    expect(facingFor('w')).toBe('west')
    expect(facingFor('n')).toBe('north')
    expect(facingFor('s')).toBe('south')
  })

  it('never leaves a direction undrawn', () => {
    for (const d of ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'] as const) {
      expect(SHEET_FACINGS).toContain(facingFor(d))
    }
  })
})

describe('which frame of the sheet a citizen shows', () => {
  it('takes the idle row, one column per facing, when standing', () => {
    const east = characterFrame(MANIFEST, { direction: 'e', frame: 3, walking: false })
    expect(east).toEqual({ x: 0, y: 0, w: 16, h: 32 })
    const south = characterFrame(MANIFEST, { direction: 's', frame: 0, walking: false })
    // south is the fourth facing: column 3.
    expect(south.x).toBe(3 * 16)
    expect(south.y).toBe(0)
  })

  it('takes the walk row, in that facing’s own block of frames', () => {
    const north = characterFrame(MANIFEST, { direction: 'n', frame: 2, walking: true })
    // north is lane 1, so its block starts at column 6.
    expect(north.x).toBe((6 + 2) * 16)
    expect(north.y).toBe(32)
  })

  /**
   * The floor runs a four-frame cycle and the pack ships six. Reading past the
   * block would show the NEXT facing's art mid-stride — a citizen walking west
   * would flash north.
   */
  it('wraps inside the block rather than reading into the next facing', () => {
    const west = characterFrame(MANIFEST, { direction: 'w', frame: 9, walking: true })
    const lane = 2
    expect(west.x).toBe((lane * 6 + 3) * 16)
    expect(west.x).toBeLessThan((lane + 1) * 6 * 16)
  })

  it('never produces a negative column for a negative frame', () => {
    const f = characterFrame(MANIFEST, { direction: 'e', frame: -1, walking: true })
    expect(f.x).toBeGreaterThanOrEqual(0)
  })
})

describe('which face an agent wears', () => {
  it('is stable for the same id, so the floor stays readable', () => {
    // A citizen that changed face every boot would defeat the one thing the
    // floor is for: recognising who is where.
    const a = sheetForAgent('agent.skeleton-crew-musahit-ci-babysitter', 12)
    const b = sheetForAgent('agent.skeleton-crew-musahit-ci-babysitter', 12)
    expect(a).toBe(b)
  })

  it('stays inside the installed pack', () => {
    for (const id of ['agent.a', 'agent.mason', 'agent.artemis', '']) {
      const index = sheetForAgent(id, 3)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(3)
    }
  })

  it('does not divide by an empty pack', () => {
    expect(sheetForAgent('agent.a', 0)).toBe(0)
  })

  it('gives different agents different faces, at least sometimes', () => {
    const seen = new Set(
      ['agent.a', 'agent.b', 'agent.c', 'agent.d', 'agent.e'].map((id) => sheetForAgent(id, 12))
    )
    expect(seen.size).toBeGreaterThan(1)
  })
})

describe('the manifest refuses what it cannot draw', () => {
  it('accepts the shipped shape', () => {
    expect(charactersManifestSchema.safeParse(MANIFEST).success).toBe(true)
  })

  it('refuses a pack with no sheets, rather than dividing by zero later', () => {
    expect(charactersManifestSchema.safeParse({ ...MANIFEST, sheets: [] }).success).toBe(false)
  })

  it('refuses an unknown field instead of ignoring it', () => {
    expect(charactersManifestSchema.safeParse({ ...MANIFEST, runFrames: 6 }).success).toBe(false)
  })
})

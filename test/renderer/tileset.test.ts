import { describe, expect, it } from 'vitest'
import { floorPlan, TILE_PX, type PlanCell } from '../../src/shared/floor'
import { atlasScale, FRAME_KEYS, parseTilesetMap, resolveTileset } from '../../src/shared/tileset'
import {
  atlasFrame,
  frameFor,
  frameIndexFor,
  frameKeysFor
} from '../../src/renderer/src/floor/atlas'
import { paintCell, paintPlan, PROCEDURAL_FILL } from '../../src/renderer/src/floor/painter'

/**
 * Sheet rendering (UI-DESIGN §7) and the procedural fallback it degrades to.
 *
 * The sheets themselves are not in the repository — §7 keeps licensed art out
 * of source — so what is testable is everything *except* the pixels: the frame
 * arithmetic, the lookup order, the validation of a pack's tile map, and the
 * rule that matters most architecturally — **art paints the plan and cannot
 * change it** (ADR-0014).
 */

const MAP = {
  schemaVersion: 1,
  name: 'Test Pack',
  sheet: 'pack.png',
  tilePx: 16,
  columns: 10,
  frames: { wall: 0, 'floor-a': 11, 'floor-b': 12, station: 20, 'station:odeon': 21 }
}

function map() {
  const parsed = parseTilesetMap(MAP)
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.map
}

function cell(over: Partial<PlanCell> = {}): PlanCell {
  return { col: 0, row: 0, kind: 'wall', of: null, ...over }
}

describe('the tile map is validated like any other file the harness reads', () => {
  it('accepts a well-formed pack', () => {
    expect(parseTilesetMap(MAP).ok).toBe(true)
  })

  it('carries a schemaVersion (invariant §9)', () => {
    expect(parseTilesetMap({ ...MAP, schemaVersion: undefined }).ok).toBe(false)
    expect(parseTilesetMap({ ...MAP, schemaVersion: 2 }).ok).toBe(false)
  })

  it('refuses a non-integer scale — §7 allows integer scaling only', () => {
    const parsed = parseTilesetMap({ ...MAP, tilePx: 12 })
    expect(parsed.ok).toBe(false)
    expect(parsed.ok ? '' : parsed.reason).toMatch(/tilePx/)
  })

  it.each([8, 16, 32])('accepts %dpx tiles, which divide the world tile', (tilePx) => {
    expect(parseTilesetMap({ ...MAP, tilePx }).ok).toBe(true)
    expect(TILE_PX % tilePx).toBe(0)
  })

  it('refuses a frame key that names nothing on the floor', () => {
    // A typo'd key is a tile that silently never paints; better a parse error.
    const parsed = parseTilesetMap({ ...MAP, frames: { walls: 1 } })
    expect(parsed.ok).toBe(false)
    // The reason names the offending key, so a typo is findable.
    expect(parsed.ok ? '' : parsed.reason).toMatch(/frames\.walls/)
  })

  it('names every key a pack may use', () => {
    expect(FRAME_KEYS).toContain('wall')
    expect(FRAME_KEYS).toContain('seat')
    expect(FRAME_KEYS).toContain('temple')
    expect(FRAME_KEYS).toContain('station:odeon')
    expect(FRAME_KEYS).not.toContain('station:balcony')
  })

  it('refuses an unknown field rather than ignoring it', () => {
    expect(parseTilesetMap({ ...MAP, rotate: true }).ok).toBe(false)
  })

  it('reports the scale a pack draws at', () => {
    expect(atlasScale({ tilePx: 16 })).toBe(2)
    expect(atlasScale({ tilePx: 32 })).toBe(1)
  })
})

describe('atlas arithmetic', () => {
  it('walks the sheet row-major', () => {
    expect(atlasFrame(0, map())).toEqual({ x: 0, y: 0, w: 16, h: 16 })
    expect(atlasFrame(9, map())).toEqual({ x: 144, y: 0, w: 16, h: 16 })
    expect(atlasFrame(10, map())).toEqual({ x: 0, y: 16, w: 16, h: 16 })
    expect(atlasFrame(11, map())).toEqual({ x: 16, y: 16, w: 16, h: 16 })
  })

  it('honours a packed grid’s spacing', () => {
    const parsed = parseTilesetMap({ ...MAP, spacing: 1 })
    if (!parsed.ok) throw new Error(parsed.reason)
    expect(atlasFrame(11, parsed.map)).toEqual({ x: 17, y: 17, w: 16, h: 16 })
  })

  it('refuses an index that is not a frame', () => {
    expect(() => atlasFrame(-1, map())).toThrow(/non-negative integer/)
    expect(() => atlasFrame(1.5, map())).toThrow(/non-negative integer/)
  })

  it('prefers a pack’s specific station tile over its generic one', () => {
    expect(frameKeysFor(cell({ kind: 'station', of: 'odeon' }))).toEqual([
      'station:odeon',
      'station'
    ])
    expect(frameIndexFor(map(), cell({ kind: 'station', of: 'odeon' }))).toBe(21)
    expect(frameIndexFor(map(), cell({ kind: 'station', of: 'shelf' }))).toBe(20)
  })

  it('resolves nothing for a cell the pack does not map', () => {
    expect(frameIndexFor(map(), cell({ kind: 'seat', of: 'terrace-1' }))).toBeNull()
    expect(frameFor(map(), cell({ kind: 'seat', of: 'terrace-1' }))).toBeNull()
  })
})

describe('art paints the plan and cannot change it (ADR-0014)', () => {
  it('paints every cell either way', () => {
    const plan = floorPlan()
    expect(paintPlan(plan, null).length).toBeGreaterThanOrEqual(plan.length)
    expect(paintPlan(plan, map()).length).toBeGreaterThanOrEqual(plan.length)
  })

  it('blits a mapped cell from the sheet', () => {
    const ops = paintCell(cell({ kind: 'wall' }), map())
    expect(ops).toEqual([{ op: 'blit', x: 0, y: 0, scale: 2, frame: { x: 0, y: 0, w: 16, h: 16 } }])
  })

  it('falls back to the procedural tile for a cell the pack misses', () => {
    // A partial pack must not punch holes in the floor.
    const ops = paintCell(cell({ kind: 'seat', of: 'terrace-1' }), map())
    expect(ops.every((op) => op.op === 'fill')).toBe(true)
    expect(ops.length).toBeGreaterThan(0)
  })

  it('draws procedurally when no pack is installed', () => {
    const ops = paintCell(cell({ kind: 'wall' }), null)
    expect(ops).toEqual([
      { op: 'fill', x: 0, y: 0, w: TILE_PX, h: TILE_PX, color: PROCEDURAL_FILL.wall }
    ])
  })

  it('positions a cell at its tile, whichever painter draws it', () => {
    const target = cell({ col: 3, row: 5, kind: 'wall' })
    for (const painted of [paintCell(target, null), paintCell(target, map())]) {
      expect(painted[0]).toMatchObject({ x: 3 * TILE_PX, y: 5 * TILE_PX })
    }
  })

  it('gives a fill for every plan kind, so nothing is ever unpainted', () => {
    for (const planCell of floorPlan()) {
      expect(paintCell(planCell, null).length).toBeGreaterThan(0)
    }
  })
})

describe('the floor says which art it is drawing (invariant §7)', () => {
  it('is procedural with nothing installed', () => {
    const state = resolveTileset({}, {})
    expect(state.installed).toBe(false)
    expect(state.map).toBeNull()
    expect(state.note).toMatch(/procedural \(no sheet installed\)/)
  })

  it('is procedural with a sheet but no map — the pack’s layout is unknown', () => {
    const state = resolveTileset({ '../assets/tileset/pack.png': '/pack.png' }, {})
    expect(state.installed).toBe(false)
    expect(state.note).toMatch(/no tile map/)
    expect(state.sheets).toEqual(['/pack.png'])
  })

  it('is procedural with an invalid map, and names the reason', () => {
    const state = resolveTileset(
      { '../assets/tileset/pack.png': '/pack.png' },
      { '../assets/tileset/pack.tiles.json': { ...MAP, tilePx: 12 } }
    )
    expect(state.installed).toBe(false)
    expect(state.note).toMatch(/tile map invalid — tilePx/)
  })

  it('is procedural when the map names a sheet that is not there', () => {
    const state = resolveTileset(
      { '../assets/tileset/other.png': '/other.png' },
      { '../assets/tileset/pack.tiles.json': MAP }
    )
    expect(state.installed).toBe(false)
    expect(state.note).toMatch(/missing sheet: pack\.png/)
  })

  it('installs when a sheet and its map are both there, and credits the pack', () => {
    const state = resolveTileset(
      { '../assets/tileset/pack.png': '/pack.png' },
      { '../assets/tileset/pack.tiles.json': MAP }
    )
    expect(state.installed).toBe(true)
    expect(state.sheetUrl).toBe('/pack.png')
    expect(state.map?.name).toBe('Test Pack')
    expect(state.note).toBe('tileset: Test Pack')
  })

  it('blits from the sheet the map names, not whichever came first', () => {
    const state = resolveTileset(
      {
        '../assets/tileset/aaa-other.png': '/other.png',
        '../assets/tileset/pack.png': '/pack.png'
      },
      { '../assets/tileset/pack.tiles.json': MAP }
    )
    expect(state.sheetUrl).toBe('/pack.png')
  })
})

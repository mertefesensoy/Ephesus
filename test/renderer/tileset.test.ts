import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
import type { TilesetLayer, TilesetMap } from '../../src/shared/tileset'

/**
 * One pack, as a layer. The painter takes layers now (a frame index only means
 * something against its own sheet), so a single-pack test says so explicitly.
 */
function asLayer(map: TilesetMap): readonly TilesetLayer[] {
  return [{ map, sheet: map.sheet, sheetUrl: `mem://${map.sheet}` }]
}

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
  return { col: 0, row: 0, kind: 'wall', of: null, part: null, ...over }
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
    expect(frameKeysFor(cell({ kind: 'station', of: 'odeon', part: null }))).toEqual([
      'station:odeon',
      'station'
    ])
    expect(frameIndexFor(map(), cell({ kind: 'station', of: 'odeon', part: null }))).toBe(21)
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
    expect(paintPlan(plan, []).length).toBeGreaterThanOrEqual(plan.length)
    expect(paintPlan(plan, asLayer(map())).length).toBeGreaterThanOrEqual(plan.length)
  })

  it('blits a mapped cell from the sheet', () => {
    const ops = paintCell(cell({ kind: 'wall' }), asLayer(map()))
    // The blit names its sheet: a frame index means nothing without the image
    // it indexes, and a floor can now be painted from more than one pack.
    expect(ops).toEqual([
      { op: 'blit', x: 0, y: 0, scale: 2, sheet: 'pack.png', frame: { x: 0, y: 0, w: 16, h: 16 } }
    ])
  })

  it('falls back to the procedural tile for a cell the pack misses', () => {
    // A partial pack must not punch holes in the floor.
    const ops = paintCell(cell({ kind: 'seat', of: 'terrace-1' }), asLayer(map()))
    expect(ops.every((op) => op.op === 'fill')).toBe(true)
    expect(ops.length).toBeGreaterThan(0)
  })

  it('draws procedurally when no pack is installed', () => {
    const ops = paintCell(cell({ kind: 'wall' }), [])
    expect(ops).toEqual([
      { op: 'fill', x: 0, y: 0, w: TILE_PX, h: TILE_PX, color: PROCEDURAL_FILL.wall }
    ])
  })

  it('positions a cell at its tile, whichever painter draws it', () => {
    const target = cell({ col: 3, row: 5, kind: 'wall' })
    for (const painted of [paintCell(target, []), paintCell(target, asLayer(map()))]) {
      expect(painted[0]).toMatchObject({ x: 3 * TILE_PX, y: 5 * TILE_PX })
    }
  })

  it('gives a fill for every plan kind, so nothing is ever unpainted', () => {
    for (const planCell of floorPlan()) {
      expect(paintCell(planCell, []).length).toBeGreaterThan(0)
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
    // The note names WHICH map failed, not just that one did: with several
    // packs installable, "a map is invalid" is not an actionable sentence.
    expect(state.note).toMatch(/pack\.tiles\.json invalid — tilePx/)
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

  // ── The M6 close-out audit's finding, as a regression ─────────────────────
  // `validateCompositions` had only TEST callers: a pack shipping a wrong-sized
  // composition really did fall back to the procedural painter, and really did
  // not say so. Invariant §7 requires the saying-so half too.
  it('SAYS SO when a composition is the wrong size, rather than degrading in silence', () => {
    const state = resolveTileset(
      { '../assets/tileset/pack.png': '/pack.png' },
      {
        '../assets/tileset/pack.tiles.json': {
          ...MAP,
          compositions: { 'station:odeon': { cols: 2, rows: 2, frames: [1, 2, 3, 4] } }
        }
      }
    )
    // The pack still installs — one wrong entry must not cost the whole pack.
    expect(state.installed).toBe(true)
    // But the note carries the degradation, because the status strip shows it.
    expect(state.note).toContain('procedural')
    expect(state.note).toContain('station:odeon')
    expect(state.note).toContain('does not match')
  })

  it('says nothing extra when every composition is sound', () => {
    const state = resolveTileset(
      { '../assets/tileset/pack.png': '/pack.png' },
      {
        '../assets/tileset/pack.tiles.json': {
          ...MAP,
          compositions: {
            'station:odeon': { cols: 3, rows: 2, frames: [1, 2, 3, 4, 5, 6] }
          }
        }
      }
    )
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

/**
 * The installed drop, when there is one (UI-DESIGN §7, ATTRIBUTION rule 2).
 *
 * The sheets and their maps are gitignored — a licence that forbids
 * redistributing the asset keeps them out of the repository — so CI runs this
 * block with nothing to check and says so. On a machine where the Architect has
 * restored the packs, it is the only thing that can catch a map that names a
 * missing sheet, an index past the end of its sheet, or a `tilePx` that would
 * break §7's integer-scale rule. Those are exactly the mistakes a human makes
 * authoring a layout by hand, and they are invisible until the floor paints
 * garbage.
 */
describe('the installed tileset drop (skipped when the drop is empty)', () => {
  const DROP = path.join(
    fileURLToPath(new URL('../../', import.meta.url)),
    'src/renderer/src/assets/tileset'
  )
  // Two different populations, because they are checkable in two different
  // places. The MAPS are committed — they are our own work — so CI can and
  // should validate their shape. The SHEETS are the licensed asset and are
  // never committed, so anything that has to open one only runs where the
  // Architect has restored the drop. Guarding both on `maps` was wrong the
  // moment the maps became tracked, and CI said so on the next push.
  const maps = fs.existsSync(DROP)
    ? fs.readdirSync(DROP).filter((name) => name.endsWith('.tiles.json'))
    : []
  const withSheet = maps.filter((name) => {
    const parsed = parseTilesetMap(JSON.parse(fs.readFileSync(path.join(DROP, name), 'utf8')))
    return parsed.ok && fs.existsSync(path.join(DROP, parsed.map.sheet))
  })

  it('reports what is installed, so an empty run is not mistaken for a pass', () => {
    // Not an assertion about the count — the drop is a local artifact. This
    // exists so the reporter prints the number a reader can compare against
    // ATTRIBUTION.md.
    expect(Array.isArray(maps)).toBe(true)
  })

  it.runIf(maps.length > 0).each(maps)('%s is a valid tile map', (name) => {
    const parsed = parseTilesetMap(JSON.parse(fs.readFileSync(path.join(DROP, name), 'utf8')))
    expect(parsed.ok ? 'valid' : parsed.reason).toBe('valid')
  })

  it('says how much of the drop is present, so an empty run is legible', () => {
    // CI sees maps and no sheets; a restored machine sees both. Neither is a
    // failure — but a reader of the reporter should be able to tell which run
    // they are looking at.
    expect(withSheet.length).toBeLessThanOrEqual(maps.length)
  })

  it.runIf(maps.length > 0).each(maps)('%s scales the sheet by a whole number (§7)', (name) => {
    const parsed = parseTilesetMap(JSON.parse(fs.readFileSync(path.join(DROP, name), 'utf8')))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const scale = atlasScale(parsed.map)
    expect(Number.isInteger(scale)).toBe(true)
    expect(scale).toBeGreaterThanOrEqual(1)
  })

  it.runIf(withSheet.length > 0).each(withSheet)('%s frames all land inside its sheet', (name) => {
    const parsed = parseTilesetMap(JSON.parse(fs.readFileSync(path.join(DROP, name), 'utf8')))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const sheet = path.join(DROP, parsed.map.sheet)
    // PNG dimensions from the IHDR chunk — no image decoder, and no new
    // dependency for one arithmetic check (invariant §10).
    const head = fs.readFileSync(sheet).subarray(16, 24)
    const width = head.readUInt32BE(0)
    const height = head.readUInt32BE(4)
    const stride = parsed.map.tilePx + (parsed.map.spacing ?? 0)
    const rows = Math.floor(height / stride)
    const last = parsed.map.columns * rows - 1
    expect(Math.floor(width / stride)).toBe(parsed.map.columns)
    for (const [key, index] of Object.entries(parsed.map.frames)) {
      expect(`${key}:${String(index <= last)}`).toBe(`${key}:true`)
    }
  })
})

/**
 * A drop is a stack, not a choice (UI-DESIGN §7).
 *
 * `resolveTileset` read `mapPaths[0]` and stopped, so a second installed pack
 * sat inert — ATTRIBUTION recorded exactly that state for the office pack:
 * "installed and mapped, inactive while the interiors map sorts first". It also
 * meant a pack of office FURNITURE could never reach a floor whose walls came
 * from the interiors pack, because frame indices only mean anything against the
 * sheet that shipped them.
 */
describe('a floor can be painted from more than one pack', () => {
  const packMap = (name: string, sheet: string, frames: Record<string, number>) => ({
    schemaVersion: 1,
    name,
    sheet,
    tilePx: 16,
    columns: 4,
    frames
  })

  it('resolves every installed pack, in map-file order', () => {
    const state = resolveTileset(
      { '/a/base.png': 'blob:base', '/a/extra.png': 'blob:extra' },
      {
        '/a/1-base.tiles.json': packMap('Base', 'base.png', { wall: 0 }),
        '/a/2-extra.tiles.json': packMap('Extra', 'extra.png', { 'station:desk': 3 })
      }
    )
    expect(state.installed).toBe(true)
    expect(state.layers.map((layer) => layer.sheet)).toEqual(['base.png', 'extra.png'])
    expect(state.note).toContain('Base')
    expect(state.note).toContain('Extra')
  })

  it('keeps a pack whose sheet is missing out, and says which', () => {
    const state = resolveTileset(
      { '/a/base.png': 'blob:base' },
      {
        '/a/1-base.tiles.json': packMap('Base', 'base.png', { wall: 0 }),
        '/a/2-extra.tiles.json': packMap('Extra', 'nowhere.png', { 'station:desk': 3 })
      }
    )
    expect(state.layers).toHaveLength(1)
    expect(state.note).toContain('nowhere.png')
  })

  it('gives a contested key to the FIRST pack, and names the contest', () => {
    // Silently picking one of two definitions is how a floor comes to look
    // wrong with no way to find out why.
    const state = resolveTileset(
      { '/a/base.png': 'blob:base', '/a/extra.png': 'blob:extra' },
      {
        '/a/1-base.tiles.json': packMap('Base', 'base.png', { wall: 0 }),
        '/a/2-extra.tiles.json': packMap('Extra', 'extra.png', { wall: 3 })
      }
    )
    expect(state.note).toContain('wall')
    expect(state.note).toContain('first pack')
  })

  it('paints a cell from the first layer that covers it, naming that sheet', () => {
    const layers = [
      { map: packMap('Base', 'base.png', { wall: 0 }), sheet: 'base.png', sheetUrl: 'u' },
      {
        map: packMap('Extra', 'extra.png', { 'station:terminal-bench': 2 }),
        sheet: 'extra.png',
        sheetUrl: 'u'
      }
    ] as never
    const wall = paintCell(cell({ kind: 'wall' }), layers)
    expect(wall[0]).toMatchObject({ op: 'blit', sheet: 'base.png' })
    // The second pack fills what the first left unmapped — it does not overpaint.
    const bench = paintCell(cell({ kind: 'station', of: 'terminal-bench' }), layers)
    expect(bench[0]).toMatchObject({ op: 'blit', sheet: 'extra.png' })
  })
})

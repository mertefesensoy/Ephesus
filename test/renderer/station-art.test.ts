import { describe, expect, it } from 'vitest'
import { STATION_SIZES, STATION_TILES, TILE_PX, stationTiles } from '../../src/shared/floor'
import {
  compositionFor,
  furnishingsOf,
  parseTilesetMap,
  validateCompositions,
  type TilesetMap
} from '../../src/shared/tileset'
import { NO_FACTS, stationView, deskTray } from '../../src/shared/stations'
import {
  ODEON_BENCHES,
  odeonFill,
  stationMarks,
  stationOrigin,
  trayMarks
} from '../../src/renderer/src/floor/station-art'
import { compositionFrameFor, frameFor } from '../../src/renderer/src/floor/atlas'
import { paintFurnishings } from '../../src/renderer/src/floor/painter'
import { tokens } from '../../src/renderer/src/tokens'

/**
 * The presentation half of UI-DESIGN §5.4 and §5.7.
 *
 * The state model decides WHETHER a station is in use and names the fact;
 * these functions decide only what that looks like. So the properties worth
 * pinning are the ones that would let art become a second source of truth: a
 * mark drawn with no state behind it, a composition sized differently from the
 * catalog, a furnishing that animates.
 */

const baseMap = (over: Partial<TilesetMap> = {}): TilesetMap => {
  const parsed = parseTilesetMap({
    schemaVersion: 1,
    name: 'test pack',
    sheet: 'sheet.png',
    tilePx: 16,
    columns: 32,
    frames: { wall: 1, 'floor-a': 2, 'floor-b': 3, path: 4 },
    ...over
  })
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.map
}

describe('station marks are drawn only from a state (§5.4)', () => {
  it('draws nothing at all for an idle station', () => {
    // "idle (static)" — static means static, not a slow pulse.
    expect(stationMarks(stationView('shelf', NO_FACTS, 0), 0)).toEqual([])
    expect(stationMarks(stationView('watch-post', NO_FACTS, 0), 0)).toEqual([])
  })

  it('outlines a highlighted station in 1 px of marble-50, on its own bounds', () => {
    const view = stationView('shelf', { ...NO_FACTS, hovered: 'shelf' }, 0)
    const marks = stationMarks(view, 0)
    expect(marks).toHaveLength(4)
    for (const mark of marks) {
      expect(mark.color).toBe(tokens.marble50)
      expect(Math.min(mark.w, mark.h)).toBe(1)
    }
    const size = STATION_SIZES.shelf
    for (const mark of marks) {
      expect(mark.x + mark.w).toBeLessThanOrEqual(size.w)
      expect(mark.y + mark.h).toBeLessThanOrEqual(size.h)
    }
  })

  it('lights the brazier only while a gate is open, and animates two frames', () => {
    const lit = stationMarks(stationView('watch-post', { ...NO_FACTS, openGates: 1 }, 0), 0)
    expect(lit.length).toBeGreaterThan(0)
    const other = stationMarks(stationView('watch-post', { ...NO_FACTS, openGates: 1 }, 250), 0)
    // Two distinct frames — a flame that never changes is a painted flame.
    expect(other).not.toEqual(lit)
    // And nothing at all with no gate open.
    expect(stationMarks(stationView('watch-post', NO_FACTS, 0), 0)).toEqual([])
  })

  it('fills one Odeon bench per attendee, and caps at the benches drawn', () => {
    expect(odeonFill(0)).toHaveLength(0)
    expect(odeonFill(3)).toHaveLength(3)
    expect(odeonFill(ODEON_BENCHES)).toHaveLength(ODEON_BENCHES)
    // Beyond the benches the room is full; it does not stack occupants.
    expect(odeonFill(ODEON_BENCHES + 5)).toHaveLength(ODEON_BENCHES)
    expect(odeonFill(-2)).toHaveLength(0)
    // Every occupant sits inside the 96×64 station.
    for (const mark of odeonFill(ODEON_BENCHES)) {
      expect(mark.x + mark.w).toBeLessThanOrEqual(STATION_SIZES.odeon.w)
      expect(mark.y + mark.h).toBeLessThanOrEqual(STATION_SIZES.odeon.h)
    }
  })

  it('anchors a station so it rises above the tile a walk targets', () => {
    const anchor = STATION_TILES.odeon
    const origin = stationOrigin('odeon', anchor)
    expect(origin.x).toBe(anchor.col * TILE_PX)
    // 96×64 is two tiles tall, so the top edge is one tile above the anchor.
    expect(origin.y).toBe((anchor.row - stationTiles('odeon').rows + 1) * TILE_PX)
    // A one-tile-tall station starts on its own tile.
    expect(stationOrigin('desk', anchor).y).toBe(anchor.row * TILE_PX)
  })
})

describe('the desk tray flag (§5.4)', () => {
  it('draws the tray always and the flag only with mail waiting', () => {
    const empty = trayMarks(deskTray(0))
    const full = trayMarks(deskTray(3))
    // A desk has a tray whether or not mail is in it.
    expect(empty.length).toBeGreaterThan(0)
    expect(full.length).toBeGreaterThan(empty.length)
    // The raised flag is the only difference, and it is gold — §2.4's
    // "attention" colour, the same one the panels use.
    expect(full.some((m) => m.color === tokens.gold)).toBe(true)
    expect(empty.some((m) => m.color === tokens.gold)).toBe(false)
  })

  it('keeps the tray inside the desk it belongs to', () => {
    for (const mark of trayMarks(deskTray(9))) {
      expect(mark.x).toBeGreaterThanOrEqual(0)
      expect(mark.x + mark.w).toBeLessThanOrEqual(STATION_SIZES.desk.w)
      expect(mark.y + mark.h).toBeLessThanOrEqual(STATION_SIZES.desk.h)
    }
  })
})

describe('§5.4 compositions ride the pack, and are validated', () => {
  const odeon = stationTiles('odeon')

  it('accepts a composition that matches the catalog', () => {
    const map = baseMap({
      compositions: {
        'station:odeon': { cols: odeon.cols, rows: odeon.rows, frames: [1, 2, 3, 4, 5, 6] }
      }
    })
    expect(validateCompositions(map)).toEqual([])
    expect(compositionFor(map, 'odeon')).not.toBeNull()
  })

  it('refuses a frame list that does not fill the footprint', () => {
    // A short list leaves holes; a long one paints over the neighbour.
    const short = baseMap({
      compositions: { 'station:odeon': { cols: 3, rows: 2, frames: [1, 2, 3] } }
    })
    expect(validateCompositions(short)[0]).toContain('3 frames')
    expect(compositionFor(short, 'odeon')).toBeNull()
  })

  it('refuses a footprint that disagrees with the §5.4 catalog', () => {
    const wrong = baseMap({
      compositions: { 'station:odeon': { cols: 2, rows: 2, frames: [1, 2, 3, 4] } }
    })
    expect(validateCompositions(wrong)[0]).toContain('does not match')
    // Degradation, not a crash: this station falls back to the single frame
    // and then to the procedural painter (invariant §7).
    expect(compositionFor(wrong, 'odeon')).toBeNull()
  })

  it('maps composition frames row-major from the top-left', () => {
    const map = baseMap({
      compositions: {
        'station:odeon': { cols: 3, rows: 2, frames: [10, 11, 12, 20, 21, 22] }
      }
    })
    const anchor = STATION_TILES.odeon
    const top = anchor.row - odeon.rows + 1
    const frameAt = (col: number, row: number): number | null => {
      const rect = compositionFrameFor(map, { col, row, kind: 'station', of: 'odeon', part: null })
      return rect ? rect.x / map.tilePx + (rect.y / map.tilePx) * map.columns : null
    }
    // Top-left is the first frame; the anchor tile is on the BOTTOM row,
    // because a tall station rises above the ground it stands on.
    expect(frameAt(anchor.col, top)).toBe(10)
    expect(frameAt(anchor.col + 2, top)).toBe(12)
    expect(frameAt(anchor.col, anchor.row)).toBe(20)
    expect(frameAt(anchor.col + 2, anchor.row)).toBe(22)
    // Outside the footprint the composition says nothing.
    expect(frameAt(anchor.col + 3, anchor.row)).toBeNull()
  })

  it('prefers a composition over the single station frame', () => {
    const map = baseMap({
      frames: { wall: 1, 'floor-a': 2, 'floor-b': 3, path: 4, 'station:odeon': 99 },
      compositions: {
        'station:odeon': { cols: 3, rows: 2, frames: [10, 11, 12, 20, 21, 22] }
      }
    })
    const anchor = STATION_TILES.odeon
    const rect = frameFor(map, {
      col: anchor.col,
      row: anchor.row,
      kind: 'station',
      of: 'odeon',
      part: null
    })
    // A pack that drew a 3×2 Odeon should not have one tile repeated six times.
    expect(rect).not.toBeNull()
    expect(rect?.x).toBe((20 % map.columns) * map.tilePx)
  })

  it('falls back to the single frame when the pack ships no composition', () => {
    const map = baseMap({ frames: { wall: 1, 'station:odeon': 7 } })
    const anchor = STATION_TILES.odeon
    expect(
      frameFor(map, { col: anchor.col, row: anchor.row, kind: 'station', of: 'odeon', part: null })
    ).not.toBeNull()
  })
})

describe('§5.7 furnishings are place identity, and static', () => {
  it('paints nothing without a pack', () => {
    expect(paintFurnishings(null)).toEqual([])
    expect(paintFurnishings(baseMap())).toEqual([])
  })

  it('paints one static blit per placement', () => {
    const map = baseMap({
      furnishings: [
        { col: 3, row: 3, frame: 40 },
        { col: 9, row: 5, frame: 41 }
      ]
    })
    const ops = paintFurnishings(map)
    expect(ops).toHaveLength(2)
    for (const op of ops) {
      // Blits only — a furnishing that could animate would be the decorative
      // motion §1.2 bans.
      expect(op.op).toBe('blit')
    }
    expect(ops[0]).toMatchObject({ x: 3 * TILE_PX, y: 3 * TILE_PX })
  })

  it('cannot place furniture outside the room', () => {
    // The schema bounds col/row; this is the belt to that braces, for a map
    // hand-edited past the validator.
    expect(furnishingsOf(baseMap({ furnishings: [{ col: 0, row: 0, frame: 1 }] }))).toHaveLength(1)
    expect(
      furnishingsOf({
        ...baseMap(),
        furnishings: [{ col: 999, row: 0, frame: 1 }]
      })
    ).toHaveLength(0)
  })

  it('is optional — every committed map still parses', () => {
    // The packs shipped in M5b carry neither compositions nor furnishings;
    // adding both must not have invalidated them.
    const map = baseMap()
    expect(map.compositions).toBeUndefined()
    expect(map.furnishings).toBeUndefined()
    expect(validateCompositions(map)).toEqual([])
  })
})

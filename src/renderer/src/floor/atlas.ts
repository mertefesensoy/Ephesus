import { STATION_TILES, type PlanCell } from '../../../shared/floor'
import { STATIONS, type Station } from '../../../shared/avatar'
import {
  atlasScale,
  compositionFor,
  type Furnishing,
  type TilesetMap
} from '../../../shared/tileset'

/**
 * Atlas arithmetic — where a frame lives on an installed sheet (UI-DESIGN §7).
 *
 * Pure on purpose: the sheets are not in the repository (§7 licence rules), so
 * the only part of sheet rendering that *can* be tested without art is the
 * maths and the lookup order. Both are here; `FloorCanvas` only blits what this
 * module resolves.
 */

export interface AtlasFrame {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * Contract: the source rectangle of frame `index` on the sheet, row-major.
 * Negative or non-integer indices are refused rather than resolved to a
 * plausible-looking rectangle somewhere on the sheet.
 */
export function atlasFrame(index: number, map: TilesetMap): AtlasFrame {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`atlas: frame index must be a non-negative integer, got ${String(index)}`)
  }
  const spacing = map.spacing ?? 0
  const stride = map.tilePx + spacing
  const col = index % map.columns
  const row = Math.floor(index / map.columns)
  return { x: col * stride, y: row * stride, w: map.tilePx, h: map.tilePx }
}

/**
 * Contract: the keys that may paint a cell, most specific first. A pack that
 * has a dedicated tile for the Odeon uses it; one that only distinguishes
 * `station` paints every station alike; one that has neither leaves the cell to
 * the procedural painter.
 */
export function frameKeysFor(cell: PlanCell): readonly string[] {
  return cell.kind === 'station' && cell.of ? [`station:${cell.of}`, cell.kind] : [cell.kind]
}

/** Contract: the frame index for a cell, or null when the pack does not map it. */
export function frameIndexFor(map: TilesetMap, cell: PlanCell): number | null {
  for (const key of frameKeysFor(cell)) {
    const index = map.frames[key]
    if (typeof index === 'number') return index
  }
  return null
}

/**
 * Contract: which frame of a station's §5.4 composition paints this cell, or
 * null when the pack ships no usable composition for it.
 *
 * A station is not one tile — the Odeon is 96×64, the temple seat 64×64 — so a
 * pack that ships a composition supplies one frame per tile of the footprint,
 * row-major from the TOP-LEFT. The footprint rises above its anchor tile, so
 * the top row is `anchor.row - rows + 1`; getting that backwards would paint
 * the structure upside down, which is why the arithmetic lives here beside the
 * rest of the atlas maths rather than in the canvas.
 */
export function compositionFrameFor(map: TilesetMap, cell: PlanCell): AtlasFrame | null {
  if (cell.kind !== 'station' || !cell.of) return null
  const station = cell.of as Station
  if (!STATIONS.includes(station)) return null
  const composition = compositionFor(map, station)
  if (!composition) return null
  const anchor = STATION_TILES[station]
  const top = anchor.row - composition.rows + 1
  const dCol = cell.col - anchor.col
  const dRow = cell.row - top
  if (dCol < 0 || dCol >= composition.cols || dRow < 0 || dRow >= composition.rows) return null
  const index = composition.frames[dRow * composition.cols + dCol]
  return index === undefined ? null : atlasFrame(index, map)
}

/**
 * Contract: the source rect for a cell, or null when the pack does not map it.
 *
 * A §5.4 composition wins over the single `station:<name>` frame: a pack that
 * went to the trouble of drawing a 3×2 Odeon should not have one of its tiles
 * repeated nine times.
 */
export function frameFor(map: TilesetMap, cell: PlanCell): AtlasFrame | null {
  const composed = compositionFrameFor(map, cell)
  if (composed) return composed
  const index = frameIndexFor(map, cell)
  return index === null ? null : atlasFrame(index, map)
}

/** Contract: the source rect for one §5.7 furnishing placement. */
export function furnishingFrame(map: TilesetMap, furnishing: Furnishing): AtlasFrame {
  return atlasFrame(furnishing.frame, map)
}

/** Contract: the integer factor the sheet is drawn at, re-exported for the painter. */
export { atlasScale }

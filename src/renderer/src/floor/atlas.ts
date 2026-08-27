import type { PlanCell } from '../../../shared/floor'
import { atlasScale, type TilesetMap } from '../../../shared/tileset'

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

/** Contract: the source rect for a cell, or null when the pack does not map it. */
export function frameFor(map: TilesetMap, cell: PlanCell): AtlasFrame | null {
  const index = frameIndexFor(map, cell)
  return index === null ? null : atlasFrame(index, map)
}

/** Contract: the integer factor the sheet is drawn at, re-exported for the painter. */
export { atlasScale }

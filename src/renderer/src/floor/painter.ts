import { TILE_PX, type PlanCell, type PlanKind } from '../../../shared/floor'
import type { TilesetMap } from '../../../shared/tileset'
import { tokens } from '../tokens'
import { atlasScale, frameFor, type AtlasFrame } from './atlas'

/**
 * How a plan cell is painted — the *presentation* half of the seam
 * `floorPlan()` opens (ADR-0014: the floor is a projection, art never becomes a
 * second source of truth).
 *
 * Two painters, one plan. The procedural painter is the shipped floor and the
 * documented fallback (UI-DESIGN §7); the sheet painter takes over per cell
 * when an installed pack maps that cell's kind. A pack that maps only walls
 * gets sheet walls and procedural everything else, which is the honest
 * behaviour: nothing is left unpainted because a pack was partial.
 *
 * Pure — it returns instructions, not draw calls — so both paths are unit
 * testable without Pixi, a canvas or a sheet.
 */

/** Procedural fills, from UI-DESIGN §2.5 (world) and §2.3 (accents). */
export const PROCEDURAL_FILL: Readonly<Record<PlanKind, number>> = {
  'floor-a': tokens.worldTerraceA,
  'floor-b': tokens.worldTerraceB,
  path: tokens.worldPath,
  wall: tokens.worldWall,
  // The temple precinct is marble, so Artemis's room reads as a room.
  temple: tokens.marble100,
  station: tokens.worldWall,
  seat: tokens.worldWall
}

export interface FillOp {
  readonly op: 'fill'
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly color: number
}

export interface BlitOp {
  readonly op: 'blit'
  readonly x: number
  readonly y: number
  /** Integer scale factor (§7: integer scaling only). */
  readonly scale: number
  readonly frame: AtlasFrame
}

export type PaintOp = FillOp | BlitOp

/**
 * Contract: the ops that paint one cell. With no map, or with a map that does
 * not cover this cell, the result is the procedural drawing; with a mapped cell
 * it is a single blit.
 */
export function paintCell(cell: PlanCell, map: TilesetMap | null): readonly PaintOp[] {
  const x = cell.col * TILE_PX
  const y = cell.row * TILE_PX
  if (map) {
    const frame = frameFor(map, cell)
    if (frame) return [{ op: 'blit', x, y, scale: atlasScale(map), frame }]
  }
  return proceduralCell(cell, x, y)
}

/** The 8-colour tiles the floor draws for itself (UI-DESIGN §7 fallback). */
function proceduralCell(cell: PlanCell, x: number, y: number): readonly PaintOp[] {
  const ground: FillOp = {
    op: 'fill',
    x,
    y,
    w: TILE_PX,
    h: TILE_PX,
    color: PROCEDURAL_FILL[cell.kind]
  }
  if (cell.kind === 'path') {
    // A worn strip rather than a full tile, so the path reads as a path.
    return [
      { op: 'fill', x, y, w: TILE_PX, h: TILE_PX, color: tokens.worldTerraceB },
      { op: 'fill', x, y: y + 4, w: TILE_PX, h: TILE_PX - 8, color: tokens.worldPath }
    ]
  }
  if (cell.kind === 'station') {
    return [
      ground,
      { op: 'fill', x: x + 2, y: y + 2, w: TILE_PX - 4, h: TILE_PX - 4, color: tokens.worldWall },
      { op: 'fill', x: x + 6, y: y + 6, w: TILE_PX - 12, h: TILE_PX - 12, color: tokens.gold }
    ]
  }
  if (cell.kind === 'seat') {
    // A desk: a surface with a shadowed front edge, inset so the citizen
    // sprite standing on the tile still reads as being *at* it.
    return [
      { op: 'fill', x, y, w: TILE_PX, h: TILE_PX, color: tokens.worldTerraceB },
      { op: 'fill', x: x + 3, y: y + 10, w: TILE_PX - 6, h: TILE_PX - 16, color: tokens.sand },
      { op: 'fill', x: x + 3, y: y + TILE_PX - 8, w: TILE_PX - 6, h: 2, color: tokens.worldWall }
    ]
  }
  if (cell.kind === 'temple') {
    return [
      ground,
      // Marble joints, so the precinct is a floor and not a blank rectangle.
      { op: 'fill', x, y, w: TILE_PX, h: 1, color: tokens.marble300 },
      { op: 'fill', x, y, w: 1, h: TILE_PX, color: tokens.marble300 }
    ]
  }
  return [ground]
}

/** Contract: the whole room's ops, in plan order. */
export function paintPlan(plan: readonly PlanCell[], map: TilesetMap | null): readonly PaintOp[] {
  return plan.flatMap((cell) => paintCell(cell, map))
}

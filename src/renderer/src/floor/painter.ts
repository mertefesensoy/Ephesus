import { TILE_PX, type PlanCell, type PlanKind } from '../../../shared/floor'
import { furnishingsOf, type TilesetMap } from '../../../shared/tileset'
import { tokens } from '../tokens'
import { atlasScale, frameFor, furnishingFrame, type AtlasFrame } from './atlas'

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

/**
 * Which sides of a cell are the outer edge of the structure it belongs to.
 * A single-tile structure (or plain ground) is an edge on all four sides, so
 * the one-tile case is unchanged from M1.
 */
function edges(cell: PlanCell): {
  left: number
  right: number
  top: number
  bottom: number
} {
  const part = cell.part
  if (!part) return { left: 1, right: 1, top: 1, bottom: 1 }
  return {
    left: part.col === 0 ? 1 : 0,
    right: part.col === part.cols - 1 ? 1 : 0,
    top: part.row === 0 ? 1 : 0,
    bottom: part.row === part.rows - 1 ? 1 : 0
  }
}

/** The structure's anchor tile — bottom-left, the tile a walk targets. */
function isAnchor(cell: PlanCell): boolean {
  const part = cell.part
  return !part || (part.col === 0 && part.row === part.rows - 1)
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
    // A station is one STRUCTURE, not a grid of identical tiles (§5.4 sizes).
    // The inset is applied only on the structure's outer edges, so a 96×64
    // Odeon reads as one building rather than as six little ones.
    const e = edges(cell)
    return [
      ground,
      {
        op: 'fill',
        x: x + e.left * 2,
        y: y + e.top * 2,
        w: TILE_PX - (e.left + e.right) * 2,
        h: TILE_PX - (e.top + e.bottom) * 2,
        color: tokens.worldWall
      },
      // The marker sits once per structure, on its anchor tile, rather than
      // once per tile — nine gold squares are not a station, they are wallpaper.
      ...(isAnchor(cell)
        ? [
            {
              op: 'fill' as const,
              x: x + 6,
              y: y + 6,
              w: TILE_PX - 12,
              h: TILE_PX - 12,
              color: tokens.gold
            }
          ]
        : [])
    ]
  }
  if (cell.kind === 'seat') {
    // A desk: a surface with a shadowed front edge, inset so the citizen
    // sprite standing on the tile still reads as being *at* it. A desk is
    // 64×32 (§5.4), so the inset skips the seam between its two tiles —
    // otherwise a row of desks paints as one long slab, which is exactly what
    // the live floor showed when the footprints landed.
    const e = edges(cell)
    return [
      { op: 'fill', x, y, w: TILE_PX, h: TILE_PX, color: tokens.worldTerraceB },
      {
        op: 'fill',
        x: x + e.left * 3,
        y: y + 10,
        w: TILE_PX - (e.left + e.right) * 3,
        h: TILE_PX - 16,
        color: tokens.sand
      },
      {
        op: 'fill',
        x: x + e.left * 3,
        y: y + TILE_PX - 8,
        w: TILE_PX - (e.left + e.right) * 3,
        h: 2,
        color: tokens.worldWall
      }
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

/**
 * Contract: the §5.7 furnishings, painted over the floor.
 *
 * Furnishings are **place identity, not ambience**: furniture says what happens
 * in a room. They are STATIC by construction — this returns blits, never an
 * animation — because §1.2 bans decorative motion and the review rule cuts
 * anything that moves without meaning.
 *
 * They come only from the pack's map, so a pack swap re-furnishes the floor
 * without touching code; with no pack installed there are none, and the room
 * still reads because the plan (not the furniture) is what says a station is
 * there.
 */
export function paintFurnishings(map: TilesetMap | null): readonly PaintOp[] {
  if (!map) return []
  return furnishingsOf(map).map((item) => ({
    op: 'blit' as const,
    x: item.col * TILE_PX,
    y: item.row * TILE_PX,
    scale: atlasScale(map),
    frame: furnishingFrame(map, item)
  }))
}

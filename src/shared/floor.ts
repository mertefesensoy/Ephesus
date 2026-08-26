import { STATIONS, type Station } from './avatar'

/**
 * Floor geometry (UI-DESIGN §5): where each station sits on the 32×32 tile grid,
 * and how long walking between two of them takes.
 *
 * It lives in `src/shared/` because both planes need it and must agree: main
 * decides *when* a walk finishes (the SDD §6 `arrive` edge) and the renderer
 * decides *where the avatar is drawn* meanwhile. If the renderer owned the
 * timing it would be holding authoritative state, which the architecture does
 * not allow (ENGINEERING-STANDARDS §4, "the renderer is a projection").
 */

export const TILE_PX = 32
/** UI-DESIGN §6: 250 ms per tile, everywhere. */
export const MS_PER_TILE = 250

export interface TilePoint {
  readonly col: number
  readonly row: number
}

/** One terrace room, 20×12 tiles, with the stations placed around its edges. */
export const ROOM_COLS = 20
export const ROOM_ROWS = 12

export const STATION_TILES: Readonly<Record<Station, TilePoint>> = {
  desk: { col: 9, row: 7 },
  shelf: { col: 2, row: 2 },
  'terminal-bench': { col: 6, row: 2 },
  portal: { col: 10, row: 2 },
  'harbor-kiosk': { col: 14, row: 2 },
  'agora-board': { col: 17, row: 5 },
  odeon: { col: 17, row: 9 },
  'watch-post': { col: 2, row: 9 },
  'temple-seat': { col: 10, row: 10 }
}

/** Chebyshev tile distance — avatars walk the 8 directions of UI-DESIGN §5. */
export function tileDistance(from: Station, to: Station): number {
  const a = STATION_TILES[from]
  const b = STATION_TILES[to]
  return Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row))
}

/** Contract: how long a walk between two stations takes, in milliseconds. */
export function walkDurationMs(from: Station, to: Station): number {
  return tileDistance(from, to) * MS_PER_TILE
}

/**
 * Per-agent desks fan out along the desk row so avatars do not overlap. Agents
 * are placed by their index in the roster, which is stable for a session.
 */
export function deskTileFor(index: number): TilePoint {
  const base = STATION_TILES.desk
  return { col: base.col - 3 + ((index * 3) % 9), row: base.row }
}

/** Every station has coordinates — a missing one would be an undrawable avatar. */
export function assertStationsPlaced(): void {
  for (const station of STATIONS) {
    if (!(station in STATION_TILES)) throw new Error(`floor: station "${station}" has no tile`)
  }
}

import { STATIONS, type Station } from './avatar'
import { parseSeat, terraceSeat } from './seats'

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
 * The terrace desk block — where seated citizens sit (UI-DESIGN §5).
 *
 * Columns are spaced two apart so neighbouring 32×48 sprites never overlap, and
 * the rows avoid the two stone paths (rows 2 and 7) so a desk is never drawn on
 * a walkway. Seats are numbered row-major from the front-left, which is what
 * makes `terrace-3` a place the Architect can point at.
 */
export const TERRACE_COLS: readonly number[] = [3, 5, 7, 9, 11, 13, 15]
export const TERRACE_ROWS: readonly number[] = [4, 5, 6]

/** Seats the block can draw. Beyond this a seat is an overflow seat. */
export const TERRACE_SEATS = TERRACE_COLS.length * TERRACE_ROWS.length

/**
 * Artemis's temple precinct (UI-DESIGN §5, "Artemis's temple seat"; ADR-0005).
 * A room of its own rather than a tile, so the reserved seat reads as reserved
 * on the floor and not merely in the roster.
 */
export const TEMPLE_ROOM = { col: 8, row: 9, cols: 5, rows: 3 } as const

/** Contract: whether a tile falls inside the temple precinct. */
export function inTempleRoom(point: TilePoint): boolean {
  return (
    point.col >= TEMPLE_ROOM.col &&
    point.col < TEMPLE_ROOM.col + TEMPLE_ROOM.cols &&
    point.row >= TEMPLE_ROOM.row &&
    point.row < TEMPLE_ROOM.row + TEMPLE_ROOM.rows
  )
}

/**
 * Contract: whether a seat exists but has no drawn desk — more hires than the
 * block holds. Overflow seats are still seated (a hire is never refused a
 * place), and the floor says so rather than silently stacking two citizens on
 * one desk (invariant §7: every degradation is visible).
 */
export function isOverflowSeat(seat: string): boolean {
  const place = parseSeat(seat)
  return place?.kind === 'terrace' && place.index > TERRACE_SEATS
}

/**
 * Contract: the tile a seat occupies. The temple seat is Artemis's station
 * tile; terrace seats walk the block row-major. An unparseable seat — the M2
 * `'terrace'` placeholder, or a roster written by another harness — lands on
 * the first terrace tile, which is visibly wrong-looking rather than crashing
 * the floor.
 */
export function seatTile(seat: string): TilePoint {
  const place = parseSeat(seat)
  if (place?.kind === 'temple') return STATION_TILES['temple-seat']
  const index = place?.kind === 'terrace' ? place.index - 1 : 0
  // Overflow wraps the block: two citizens on one desk, which `isOverflowSeat`
  // lets the UI report instead of leaving it to be discovered by eye.
  const slot = index % TERRACE_SEATS
  const row = TERRACE_ROWS[Math.floor(slot / TERRACE_COLS.length)] ?? TERRACE_ROWS[0] ?? 0
  const col = TERRACE_COLS[slot % TERRACE_COLS.length] ?? TERRACE_COLS[0] ?? 0
  return { col, row }
}

/** Contract: how many of these seats have no drawn desk of their own. */
export function sharingDesks(seats: Iterable<string>): number {
  let count = 0
  for (const seat of seats) if (isOverflowSeat(seat)) count += 1
  return count
}

/**
 * The room, tile by tile — what is at every coordinate, with no colour, no
 * texture and no sheet in sight.
 *
 * This is the seam ADR-0014 asks for: "the floor renders *only* from
 * event-plane data … never a second source of truth". The plan is the floor's
 * layout as *state*; a tileset (UI-DESIGN §7) and the procedural fallback are
 * two ways of *painting* the same plan, so installing art can change how the
 * floor looks and can never change what is on it.
 */
export const PLAN_KINDS = [
  'floor-a',
  'floor-b',
  'path',
  'wall',
  'temple',
  'station',
  'seat'
] as const

export type PlanKind = (typeof PLAN_KINDS)[number]

export interface PlanCell {
  readonly col: number
  readonly row: number
  readonly kind: PlanKind
  /** The station or seat this cell belongs to; null for plain ground. */
  readonly of: string | null
}

/** The two stone paths of §2.5, by row. */
export const PATH_ROWS: readonly number[] = [2, 7]

/**
 * Contract: every tile of the room, row-major, exactly `ROOM_COLS × ROOM_ROWS`
 * cells, one kind each. Pure and total — the same plan every call.
 *
 * Precedence where a tile is claimed twice: wall, then station, then seat, then
 * temple floor, then path, then ground. A station inside the temple is drawn as
 * the station (Artemis's seat is a seat *and* a station; the station wins so it
 * reads the same as every other station on the floor).
 */
export function floorPlan(): readonly PlanCell[] {
  const stationAt = new Map<string, Station>()
  for (const [station, tile] of Object.entries(STATION_TILES) as [Station, TilePoint][]) {
    // `desk` is the nominal anchor for walk timing, not a drawn station: the
    // drawn desks are the seats.
    if (station === 'desk') continue
    stationAt.set(`${tile.col},${tile.row}`, station)
  }
  const seatAt = new Map<string, string>()
  for (let index = 1; index <= TERRACE_SEATS; index += 1) {
    const tile = seatTile(terraceSeat(index))
    seatAt.set(`${tile.col},${tile.row}`, terraceSeat(index))
  }

  const cells: PlanCell[] = []
  for (let row = 0; row < ROOM_ROWS; row += 1) {
    for (let col = 0; col < ROOM_COLS; col += 1) {
      const key = `${col},${row}`
      const edge = col === 0 || row === 0 || col === ROOM_COLS - 1 || row === ROOM_ROWS - 1
      const station = stationAt.get(key)
      const seat = seatAt.get(key)
      if (edge) cells.push({ col, row, kind: 'wall', of: null })
      else if (station) cells.push({ col, row, kind: 'station', of: station })
      else if (seat) cells.push({ col, row, kind: 'seat', of: seat })
      else if (inTempleRoom({ col, row })) cells.push({ col, row, kind: 'temple', of: null })
      else if (PATH_ROWS.includes(row)) cells.push({ col, row, kind: 'path', of: null })
      else cells.push({ col, row, kind: (col + row) % 2 === 0 ? 'floor-a' : 'floor-b', of: null })
    }
  }
  return cells
}

/** Every station has coordinates — a missing one would be an undrawable avatar. */
export function assertStationsPlaced(): void {
  for (const station of STATIONS) {
    if (!(station in STATION_TILES)) throw new Error(`floor: station "${station}" has no tile`)
  }
}

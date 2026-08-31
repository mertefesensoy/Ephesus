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
  odeon: { col: 16, row: 9 },
  'watch-post': { col: 2, row: 9 },
  'temple-seat': { col: 10, row: 10 }
}

/**
 * UI-DESIGN §5.4's size column, in pixels on the 32 px grid. A station taller
 * than one tile rises ABOVE its anchor tile, exactly as the 32x48 citizen does,
 * so the floor it stands on is still the tile a walk targets.
 *
 * Geometry lives here rather than beside the state model in `stations.ts`
 * because the plan needs it and the state model does not: one direction of
 * dependency, no cycle.
 */
export interface StationSize {
  readonly w: number
  readonly h: number
}

export const STATION_SIZES: Readonly<Record<Station, StationSize>> = {
  desk: { w: 64, h: 32 },
  shelf: { w: 64, h: 48 },
  'terminal-bench': { w: 32, h: 48 },
  portal: { w: 48, h: 48 },
  'harbor-kiosk': { w: 48, h: 48 },
  'agora-board': { w: 32, h: 48 },
  odeon: { w: 96, h: 64 },
  'watch-post': { w: 32, h: 48 },
  'temple-seat': { w: 64, h: 64 }
}

/** Contract: a station's footprint in whole tiles — what the plan claims. */
export function stationTiles(station: Station): { readonly cols: number; readonly rows: number } {
  const size = STATION_SIZES[station]
  return { cols: Math.ceil(size.w / TILE_PX), rows: Math.ceil(size.h / TILE_PX) }
}

/**
 * Contract: every tile a station covers, anchored at its `STATION_TILES` tile
 * and extending RIGHT and UP — up, because a station taller than a tile rises
 * above the ground it stands on. Tiles outside the room are dropped, so a
 * footprint can never claim a wall out from under the room.
 */
export function stationFootprint(station: Station): readonly TilePoint[] {
  const anchor = STATION_TILES[station]
  const { cols, rows } = stationTiles(station)
  const tiles: TilePoint[] = []
  for (let dRow = 0; dRow < rows; dRow += 1) {
    for (let dCol = 0; dCol < cols; dCol += 1) {
      const col = anchor.col + dCol
      const row = anchor.row - dRow
      if (col > 0 && col < ROOM_COLS - 1 && row > 0 && row < ROOM_ROWS - 1) {
        tiles.push({ col, row })
      }
    }
  }
  return tiles
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

/**
 * Where a cell sits inside the multi-tile structure it belongs to (§5.4 sizes).
 *
 * Without it a painter has no way to tell "the left half of a 64px desk" from
 * "a whole 32px desk", so a two-tile desk paints as two desks and a row of
 * them reads as one long slab. Observed live at M6.2, which is the second time
 * this milestone that the running floor said something the suite could not.
 */
export interface PlanPart {
  /** Offset within the structure, 0-based from its top-left. */
  readonly col: number
  readonly row: number
  /** The structure's full footprint, so an edge is recognisable as an edge. */
  readonly cols: number
  readonly rows: number
}

export interface PlanCell {
  readonly col: number
  readonly row: number
  readonly kind: PlanKind
  /** The station or seat this cell belongs to; null for plain ground. */
  readonly of: string | null
  /** Which tile of that structure this is; null for plain ground. */
  readonly part: PlanPart | null
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
  const stationAt = new Map<string, { station: Station; part: PlanPart }>()
  for (const station of STATIONS) {
    // `desk` is the nominal anchor for walk timing, not a drawn station: the
    // drawn desks are the seats.
    if (station === 'desk') continue
    // §5.4 gives every station a SIZE, not a tile — the Odeon is 96x64, the
    // temple seat 64x64 — so the plan claims the whole footprint. Before M6.2
    // each station held one tile and the size column was decorative.
    const size = stationTiles(station)
    const anchor = STATION_TILES[station]
    for (const tile of stationFootprint(station)) {
      stationAt.set(`${tile.col},${tile.row}`, {
        station,
        part: {
          col: tile.col - anchor.col,
          row: tile.row - (anchor.row - size.rows + 1),
          cols: size.cols,
          rows: size.rows
        }
      })
    }
  }
  const seatAt = new Map<string, { seat: string; part: PlanPart }>()
  // A desk is 64x32 (§5.4): two tiles wide, which is why TERRACE_COLS are
  // spaced two apart.
  const deskCols = stationTiles('desk').cols
  for (let index = 1; index <= TERRACE_SEATS; index += 1) {
    const tile = seatTile(terraceSeat(index))
    for (let dCol = 0; dCol < deskCols; dCol += 1) {
      const col = tile.col + dCol
      if (col > 0 && col < ROOM_COLS - 1) {
        seatAt.set(`${col},${tile.row}`, {
          seat: terraceSeat(index),
          part: { col: dCol, row: 0, cols: deskCols, rows: 1 }
        })
      }
    }
  }

  const cells: PlanCell[] = []
  for (let row = 0; row < ROOM_ROWS; row += 1) {
    for (let col = 0; col < ROOM_COLS; col += 1) {
      const key = `${col},${row}`
      const edge = col === 0 || row === 0 || col === ROOM_COLS - 1 || row === ROOM_ROWS - 1
      const station = stationAt.get(key)
      const seat = seatAt.get(key)
      const ground = { col, row, of: null, part: null } as const
      if (edge) cells.push({ ...ground, kind: 'wall' })
      else if (station) {
        cells.push({ col, row, kind: 'station', of: station.station, part: station.part })
      } else if (seat) cells.push({ col, row, kind: 'seat', of: seat.seat, part: seat.part })
      else if (inTempleRoom({ col, row })) cells.push({ ...ground, kind: 'temple' })
      else if (PATH_ROWS.includes(row)) cells.push({ ...ground, kind: 'path' })
      else cells.push({ ...ground, kind: (col + row) % 2 === 0 ? 'floor-a' : 'floor-b' })
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

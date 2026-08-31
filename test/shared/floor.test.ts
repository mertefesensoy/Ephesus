import { describe, expect, it } from 'vitest'
import { STATIONS } from '../../src/shared/avatar'
import {
  assertStationsPlaced,
  floorPlan,
  inTempleRoom,
  isOverflowSeat,
  PATH_ROWS,
  PLAN_KINDS,
  ROOM_COLS,
  ROOM_ROWS,
  seatTile,
  sharingDesks,
  STATION_TILES,
  stationTiles,
  TEMPLE_ROOM,
  TERRACE_COLS,
  TERRACE_ROWS,
  TERRACE_SEATS,
  tileDistance,
  walkDurationMs,
  type PlanCell
} from '../../src/shared/floor'
import { terraceSeat, TEMPLE_SEAT } from '../../src/shared/seats'

/**
 * The floor as *state* (ADR-0014: "the floor renders only from event-plane data
 * … never a second source of truth").
 *
 * `floorPlan()` is the layout with no colour, no texture and no sheet in it, so
 * these assertions are about what is on the floor. UI-DESIGN §7 permits a
 * licensed tileset; the risk it carries is that art quietly becomes the model —
 * a station that exists because a tile was drawn there. The plan is the answer:
 * art paints it and cannot change it, which `test/renderer/painter.test.ts`
 * then pins from the other side.
 */

function cellAt(plan: readonly PlanCell[], col: number, row: number): PlanCell {
  const cell = plan.find((c) => c.col === col && c.row === row)
  if (!cell) throw new Error(`no cell at ${col},${row}`)
  return cell
}

describe('the plan covers the room exactly', () => {
  it('has one cell per tile, row-major', () => {
    const plan = floorPlan()
    expect(plan).toHaveLength(ROOM_COLS * ROOM_ROWS)
    expect(plan[0]).toMatchObject({ col: 0, row: 0 })
    expect(plan.at(-1)).toMatchObject({ col: ROOM_COLS - 1, row: ROOM_ROWS - 1 })
  })

  it('gives every tile exactly one kind, all of them known', () => {
    const seen = new Set<string>()
    for (const cell of floorPlan()) {
      const key = `${cell.col},${cell.row}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
      expect(PLAN_KINDS).toContain(cell.kind)
    }
  })

  it('is pure — the same plan every call', () => {
    expect(floorPlan()).toEqual(floorPlan())
  })

  it('walls the room in on all four sides', () => {
    const plan = floorPlan()
    for (let col = 0; col < ROOM_COLS; col += 1) {
      expect(cellAt(plan, col, 0).kind).toBe('wall')
      expect(cellAt(plan, col, ROOM_ROWS - 1).kind).toBe('wall')
    }
    for (let row = 0; row < ROOM_ROWS; row += 1) {
      expect(cellAt(plan, 0, row).kind).toBe('wall')
      expect(cellAt(plan, ROOM_COLS - 1, row).kind).toBe('wall')
    }
  })
})

describe('every station the state machine can name is on the plan', () => {
  it('places all of UI-DESIGN §5’s stations', () => {
    assertStationsPlaced()
    const drawn = new Set(
      floorPlan()
        .filter((cell) => cell.kind === 'station')
        .map((cell) => cell.of)
    )
    // `desk` is the walk-timing anchor, not a drawn station: the drawn desks
    // are the seats, which is what M3.6 changed.
    for (const station of STATIONS) {
      if (station === 'desk') continue
      expect(drawn).toContain(station)
    }
    expect(drawn.has('desk')).toBe(false)
  })

  it('draws each station on the tile the geometry names', () => {
    const plan = floorPlan()
    for (const [station, tile] of Object.entries(STATION_TILES)) {
      if (station === 'desk') continue
      expect(cellAt(plan, tile.col, tile.row)).toMatchObject({ kind: 'station', of: station })
    }
  })

  it('keeps walk timing station-to-station', () => {
    expect(tileDistance('shelf', 'shelf')).toBe(0)
    expect(walkDurationMs('shelf', 'shelf')).toBe(0)
    expect(walkDurationMs('shelf', 'odeon')).toBeGreaterThan(0)
  })
})

describe('the temple is a room, not a tile (UI-DESIGN §5, ADR-0005)', () => {
  it('contains Artemis’s seat', () => {
    expect(inTempleRoom(STATION_TILES['temple-seat'])).toBe(true)
    expect(seatTile(TEMPLE_SEAT)).toEqual(STATION_TILES['temple-seat'])
  })

  it('is drawn as its own precinct', () => {
    const temple = floorPlan().filter((cell) => cell.kind === 'temple')
    expect(temple.length).toBeGreaterThan(0)
    for (const cell of temple) expect(inTempleRoom(cell)).toBe(true)
  })

  it('shows the temple seat as a station, so it reads like every other station', () => {
    const seat = STATION_TILES['temple-seat']
    expect(cellAt(floorPlan(), seat.col, seat.row)).toMatchObject({
      kind: 'station',
      of: 'temple-seat'
    })
  })

  it('does not swallow another station', () => {
    for (const [station, tile] of Object.entries(STATION_TILES)) {
      if (station === 'temple-seat') continue
      expect(inTempleRoom(tile)).toBe(false)
    }
  })

  it('seats no terrace inside it', () => {
    for (let index = 1; index <= TERRACE_SEATS; index += 1) {
      expect(inTempleRoom(seatTile(terraceSeat(index)))).toBe(false)
    }
  })

  it('stays inside the room', () => {
    expect(TEMPLE_ROOM.col).toBeGreaterThan(0)
    expect(TEMPLE_ROOM.col + TEMPLE_ROOM.cols).toBeLessThanOrEqual(ROOM_COLS)
    expect(TEMPLE_ROOM.row + TEMPLE_ROOM.rows).toBeLessThanOrEqual(ROOM_ROWS)
  })
})

describe('the terrace block', () => {
  it('gives every seat its own tile', () => {
    const tiles = new Set<string>()
    for (let index = 1; index <= TERRACE_SEATS; index += 1) {
      const tile = seatTile(terraceSeat(index))
      tiles.add(`${tile.col},${tile.row}`)
    }
    expect(tiles.size).toBe(TERRACE_SEATS)
  })

  it('numbers seats row-major from the front-left', () => {
    expect(seatTile(terraceSeat(1))).toEqual({ col: TERRACE_COLS[0], row: TERRACE_ROWS[0] })
    expect(seatTile(terraceSeat(2))).toEqual({ col: TERRACE_COLS[1], row: TERRACE_ROWS[0] })
    expect(seatTile(terraceSeat(TERRACE_COLS.length + 1))).toEqual({
      col: TERRACE_COLS[0],
      row: TERRACE_ROWS[1]
    })
  })

  it('never puts a desk on a walkway or a station', () => {
    const stations = new Set(
      Object.entries(STATION_TILES)
        .filter(([station]) => station !== 'desk')
        .map(([, tile]) => `${tile.col},${tile.row}`)
    )
    for (let index = 1; index <= TERRACE_SEATS; index += 1) {
      const tile = seatTile(terraceSeat(index))
      expect(PATH_ROWS).not.toContain(tile.row)
      expect(stations.has(`${tile.col},${tile.row}`)).toBe(false)
    }
  })

  it('leaves a column between neighbours so 32×48 sprites do not overlap', () => {
    for (let i = 1; i < TERRACE_COLS.length; i += 1) {
      expect((TERRACE_COLS[i] ?? 0) - (TERRACE_COLS[i - 1] ?? 0)).toBeGreaterThanOrEqual(2)
    }
  })

  it('draws a desk for every seat it can hold, at the §5.4 size', () => {
    const seats = floorPlan().filter((cell) => cell.kind === 'seat')
    expect(new Set(seats.map((cell) => cell.of)).size).toBe(TERRACE_SEATS)
    // A desk is 64×32 (UI-DESIGN §5.4), i.e. two tiles wide — which is why
    // TERRACE_COLS are spaced two apart. Before M6.2 each seat held one tile
    // and the size column was decorative.
    const perDesk = stationTiles('desk').cols
    expect(perDesk).toBe(2)
    expect(seats).toHaveLength(TERRACE_SEATS * perDesk)
    const byDesk = new Map<string, number>()
    for (const cell of seats) byDesk.set(cell.of ?? '', (byDesk.get(cell.of ?? '') ?? 0) + 1)
    for (const [seat, count] of byDesk) expect(count, seat).toBe(perDesk)
  })
})

describe('more hires than desks is a visible degradation, not a silent overlap', () => {
  it('is not overflow while the block has room', () => {
    expect(isOverflowSeat(terraceSeat(TERRACE_SEATS))).toBe(false)
  })

  it('reports overflow past the block', () => {
    expect(isOverflowSeat(terraceSeat(TERRACE_SEATS + 1))).toBe(true)
  })

  it('still gives an overflow seat a tile rather than dropping the citizen', () => {
    const tile = seatTile(terraceSeat(TERRACE_SEATS + 1))
    expect(tile).toEqual(seatTile(terraceSeat(1)))
  })

  it('does not call the temple an overflow seat', () => {
    expect(isOverflowSeat(TEMPLE_SEAT)).toBe(false)
  })
})

describe('a seat the floor cannot read still draws', () => {
  it.each([['terrace'], [''], ['balcony']])('places %s on the first terrace', (seat) => {
    // An unreadable roster seat must not take the floor down; M2's rosters all
    // say `terrace`.
    expect(seatTile(seat)).toEqual(seatTile(terraceSeat(1)))
  })
})

describe('the floor counts only the citizens who are on it', () => {
  it('counts nothing when every seat has a desk', () => {
    expect(sharingDesks([terraceSeat(1), terraceSeat(TERRACE_SEATS), TEMPLE_SEAT])).toBe(0)
  })

  it('counts the seats past the block', () => {
    expect(sharingDesks([terraceSeat(1), terraceSeat(TERRACE_SEATS + 1)])).toBe(1)
  })

  it('does not count a citizen whose card has not arrived yet', () => {
    // FloorCanvas passes '' for an avatar it has no card for.
    expect(sharingDesks(['', 'terrace'])).toBe(0)
  })
})

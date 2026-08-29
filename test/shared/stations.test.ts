import { describe, expect, it } from 'vitest'
import { AVATAR_STATES, STATIONS, type AvatarPhase, type Station } from '../../src/shared/avatar'
import {
  ROOM_COLS,
  ROOM_ROWS,
  STATION_SIZES,
  STATION_TILES,
  TILE_PX,
  floorPlan,
  stationFootprint,
  stationTiles
} from '../../src/shared/floor'
import {
  NO_FACTS,
  STATION_ACTIVITIES,
  STATION_FRAMES,
  STATION_FRAME_MS,
  deskTray,
  stationCensus,
  stationView,
  stationViews,
  type AvatarPresence,
  type FloorFacts
} from '../../src/shared/stations'

/**
 * UI-DESIGN §5.4 — the station catalog and its states.
 *
 * The clause under test is the last one: *"Every state maps to an event-plane
 * fact; no station animates on a timer alone."* So the tests are mostly about
 * what CANNOT happen — a station that lights with no fact behind it, a tray
 * flag that outlives its mail, a brazier that burns with no gate open.
 */

const at = (station: Station, over: Partial<AvatarPresence> = {}): AvatarPresence => ({
  station,
  walking: false,
  phase: 'working',
  ...over
})

const facts = (over: Partial<FloorFacts> = {}): FloorFacts => ({ ...NO_FACTS, ...over })

describe('the §5.4 size catalog', () => {
  it('sizes every station the state machine can name', () => {
    for (const station of STATIONS) {
      const size = STATION_SIZES[station]
      expect(size, station).toBeDefined()
      expect(size.w % 16, `${station} width is off the pixel grid`).toBe(0)
      expect(size.h % 16, `${station} height is off the pixel grid`).toBe(0)
    }
    // The five §5.4 prints that are not one tile square.
    expect(STATION_SIZES.desk).toEqual({ w: 64, h: 32 })
    expect(STATION_SIZES.odeon).toEqual({ w: 96, h: 64 })
    expect(STATION_SIZES['temple-seat']).toEqual({ w: 64, h: 64 })
    expect(STATION_SIZES['watch-post']).toEqual({ w: 32, h: 48 })
    expect(STATION_SIZES.portal).toEqual({ w: 48, h: 48 })
  })

  it('turns each size into a whole-tile footprint', () => {
    expect(stationTiles('odeon')).toEqual({ cols: 3, rows: 2 })
    expect(stationTiles('desk')).toEqual({ cols: 2, rows: 1 })
    expect(stationTiles('watch-post')).toEqual({ cols: 1, rows: 2 })
    for (const station of STATIONS) {
      const { cols, rows } = stationTiles(station)
      expect(cols * TILE_PX, station).toBeGreaterThanOrEqual(STATION_SIZES[station].w)
      expect(rows * TILE_PX, station).toBeGreaterThanOrEqual(STATION_SIZES[station].h)
    }
  })

  it('keeps every footprint inside the room, never on a wall', () => {
    for (const station of STATIONS) {
      if (station === 'desk') continue
      const tiles = stationFootprint(station)
      expect(tiles.length, `${station} has no footprint`).toBeGreaterThan(0)
      for (const tile of tiles) {
        expect(tile.col, station).toBeGreaterThan(0)
        expect(tile.col, station).toBeLessThan(ROOM_COLS - 1)
        expect(tile.row, station).toBeGreaterThan(0)
        expect(tile.row, station).toBeLessThan(ROOM_ROWS - 1)
      }
      // The anchor is always part of its own footprint: it is the tile a walk
      // targets, so a station that did not cover it would be walkable-to and
      // invisible.
      expect(tiles).toContainEqual(STATION_TILES[station])
    }
  })

  it('claims the whole footprint on the plan, and no two stations overlap', () => {
    const plan = floorPlan()
    const owner = new Map<string, string>()
    for (const cell of plan) {
      if (cell.kind === 'station' && cell.of) owner.set(`${cell.col},${cell.row}`, cell.of)
    }
    for (const station of STATIONS) {
      if (station === 'desk') continue
      for (const tile of stationFootprint(station)) {
        expect(owner.get(`${tile.col},${tile.row}`), `${station} at ${tile.col},${tile.row}`).toBe(
          station
        )
      }
    }
  })
})

describe('a station animates only from a fact (§5.4)', () => {
  it('is idle, frameless and reasonless when nothing is happening', () => {
    for (const view of stationViews(NO_FACTS, 1_000)) {
      expect(view.activity, view.station).toBe('idle')
      expect(view.frame, view.station).toBeNull()
      expect(view.because, view.station).toBe('')
    }
  })

  it('names the fact behind every non-idle state', () => {
    const busy = facts({
      avatars: [at('shelf'), at('portal', { walking: true })],
      openGates: 2,
      meetingAttendees: 3,
      hovered: 'agora-board'
    })
    for (const view of stationViews(busy, 0)) {
      if (view.activity === 'idle') continue
      // The structural half of "no station animates on a timer alone": a
      // non-idle state without a reason is unreachable.
      expect(view.because, view.station).not.toBe('')
    }
  })

  it('offers exactly the three §5.4 states', () => {
    expect([...STATION_ACTIVITIES]).toEqual(['idle', 'in-use', 'highlighted'])
  })
})

describe('the Watch brazier IS an open gate', () => {
  it('is lit exactly while a gate is open, and never otherwise', () => {
    expect(stationView('watch-post', facts({ openGates: 0 }), 0).activity).toBe('idle')
    for (const open of [1, 2, 7]) {
      const view = stationView('watch-post', facts({ openGates: open }), 0)
      expect(view.activity, `${String(open)} open`).toBe('in-use')
      expect(view.because).toContain(String(open))
      expect(view.because).toContain('gate')
    }
  })

  it('burns whether or not anyone is standing at the post', () => {
    // The point of showing it: the Architect owes a verdict even when no
    // citizen is waving at the post.
    expect(stationView('watch-post', facts({ openGates: 1, avatars: [] }), 0).activity).toBe(
      'in-use'
    )
  })

  it('lights no other station when a gate opens', () => {
    for (const view of stationViews(facts({ openGates: 3 }), 0)) {
      if (view.station === 'watch-post') continue
      expect(view.activity, view.station).toBe('idle')
    }
  })
})

describe('the Odeon fills when a meeting gathers', () => {
  it('is in use exactly while attendees are gathered', () => {
    expect(stationView('odeon', facts({ meetingAttendees: 0 }), 0).activity).toBe('idle')
    const view = stationView('odeon', facts({ meetingAttendees: 4 }), 0)
    expect(view.activity).toBe('in-use')
    expect(view.because).toContain('4')
  })

  it('fills no other station', () => {
    for (const view of stationViews(facts({ meetingAttendees: 5 }), 0)) {
      if (view.station === 'odeon') continue
      expect(view.activity, view.station).toBe('idle')
    }
  })
})

describe('a citizen at a station puts it in use', () => {
  it('counts only citizens who have arrived and are working', () => {
    expect(stationView('shelf', facts({ avatars: [at('shelf')] }), 0).activity).toBe('in-use')
    // En route is `highlighted`, not `in-use` — §5.4's "while its citizen
    // approaches".
    expect(
      stationView('shelf', facts({ avatars: [at('shelf', { walking: true })] }), 0).activity
    ).toBe('highlighted')
    // Standing there in any other phase is not "tool in use" (§2.4).
    for (const phase of AVATAR_STATES.filter((p) => p !== 'working')) {
      expect(
        stationView('shelf', facts({ avatars: [at('shelf', { phase })] }), 0).activity,
        phase
      ).not.toBe('in-use')
    }
  })

  it('ranks in-use over highlighted over idle', () => {
    const both = facts({
      avatars: [at('shelf'), at('shelf', { walking: true })],
      hovered: 'shelf'
    })
    expect(stationView('shelf', both, 0).activity).toBe('in-use')
    expect(stationView('shelf', facts({ hovered: 'shelf' }), 0).activity).toBe('highlighted')
  })

  it('leaves an unrelated phase out of it', () => {
    const ghosts: AvatarPhase[] = ['ghost', 'archived', 'stopped']
    for (const phase of ghosts) {
      expect(stationView('portal', facts({ avatars: [at('portal', { phase })] }), 0).activity).toBe(
        'idle'
      )
    }
  })
})

describe('the in-use frame is time, not state', () => {
  it('advances on §5.4 frame boundaries and wraps', () => {
    const busy = facts({ openGates: 1 })
    const frameAt = (nowMs: number): number | null => stationView('watch-post', busy, nowMs).frame
    expect(frameAt(0)).toBe(0)
    expect(frameAt(STATION_FRAME_MS - 1)).toBe(0)
    expect(frameAt(STATION_FRAME_MS)).toBe(1)
    expect(frameAt(STATION_FRAME_MS * STATION_FRAMES)).toBe(0)
  })

  it('is pure — the same clock reading gives the same frame', () => {
    const busy = facts({ openGates: 1 })
    for (const now of [0, 137, 999, 250_000]) {
      expect(stationView('watch-post', busy, now)).toEqual(stationView('watch-post', busy, now))
    }
  })

  it('gives an idle or highlighted station no frame at all', () => {
    expect(stationView('shelf', NO_FACTS, 12_345).frame).toBeNull()
    expect(stationView('shelf', facts({ hovered: 'shelf' }), 12_345).frame).toBeNull()
  })
})

describe('the desk tray flag IS pendingMailCount', () => {
  it('is up for any waiting mail and down for none', () => {
    expect(deskTray(0)).toEqual({ flagUp: false, because: '' })
    for (const waiting of [1, 2, 40]) {
      const tray = deskTray(waiting)
      expect(tray.flagUp, `${String(waiting)} waiting`).toBe(true)
      expect(tray.because).toContain(String(waiting))
    }
  })

  it('has no threshold, no decay and no hysteresis', () => {
    // The flag is the count, so it can only be wrong if the count is. A
    // threshold here would make the floor disagree with the wake watchdog
    // reading the same number (ADR-0013).
    for (let n = 0; n <= 20; n += 1) expect(deskTray(n).flagUp).toBe(n > 0)
  })

  it('treats nonsense counts as no mail rather than raising a flag', () => {
    for (const bad of [-1, -100, Number.NaN, 0.4]) {
      expect(deskTray(bad).flagUp, String(bad)).toBe(false)
    }
  })
})

describe('the station census (§8 information parity)', () => {
  it('says so when nothing is happening', () => {
    expect(stationCensus(NO_FACTS, 0)).toBe('stations: all quiet')
  })

  it('names every busy station and its reason, and no idle ones', () => {
    const line = stationCensus(facts({ openGates: 1, meetingAttendees: 2 }), 0)
    expect(line).toContain('watch-post')
    expect(line).toContain('gate open')
    expect(line).toContain('odeon')
    // An idle station is omitted, or the one thing happening is buried.
    expect(line).not.toContain('shelf')
  })

  it('carries the same facts the drawing does', () => {
    // Parity, not resemblance: every non-idle station in the model appears in
    // the words, so nothing is visible only as motion (NFR-15).
    const busy = facts({ openGates: 1, meetingAttendees: 3, avatars: [at('portal')] })
    const line = stationCensus(busy, 0)
    for (const view of stationViews(busy, 0)) {
      if (view.activity === 'idle') continue
      expect(line, view.station).toContain(view.station)
      expect(line, view.because).toContain(view.because)
    }
  })
})

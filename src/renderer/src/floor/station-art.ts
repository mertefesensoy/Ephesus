import { TILE_PX, STATION_SIZES, stationTiles, type TilePoint } from '../../../shared/floor'
import type { Station } from '../../../shared/avatar'
import type { StationView, TrayView } from '../../../shared/stations'
import { tokens } from '../tokens'

/**
 * What a station's state looks like — UI-DESIGN §5.4's three states, drawn.
 *
 * The division of labour matters more than the pixels: `shared/stations.ts`
 * decides WHETHER a station is in use and names the fact; this module decides
 * only what that looks like. So there is no way to animate a station from here
 * — every function below takes a `StationView` it cannot construct, and a view
 * carries an `activity` that came from an event-plane fact. §5.4's closing rule
 * ("no station animates on a timer alone") is therefore structural.
 *
 * Pure: rectangles in the station's own pixel space, so the marks are unit
 * testable without Pixi, and they sit correctly whether the station beneath
 * them was painted from a pack or by the procedural painter.
 */

export interface MarkRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly color: number
}

/**
 * Contract: a station's top-left corner in pixels. Stations anchor on their
 * `STATION_TILES` tile and rise ABOVE it (§5.4 sizes are 48 and 64 px tall on a
 * 32 px grid), so the origin is up and to the left of the anchor's own pixel.
 */
export function stationOrigin(station: Station, anchor: TilePoint): { x: number; y: number } {
  const { rows } = stationTiles(station)
  return { x: anchor.col * TILE_PX, y: (anchor.row - rows + 1) * TILE_PX }
}

/**
 * §5.4 highlighted: "1 px marble-50 outline while hovered or while its citizen
 * approaches". One pixel, on the station's own bounds — an affordance, not a
 * glow.
 */
export function highlightOutline(station: Station): readonly MarkRect[] {
  const { w, h } = STATION_SIZES[station]
  const c = tokens.marble50
  return [
    { x: 0, y: 0, w, h: 1, color: c },
    { x: 0, y: h - 1, w, h: 1, color: c },
    { x: 0, y: 0, w: 1, h, color: c },
    { x: w - 1, y: 0, w: 1, h, color: c }
  ]
}

/**
 * The Watch post's brazier — §5.4: "flame lit while a gate is open". The flame
 * IS the open gate: it exists only while `stationView` says the post is in use,
 * which for this station happens only when `openGates > 0`.
 *
 * Two frames, because §5.4 gives in-use stations a 2-frame animation; the
 * frame index comes from the view, which got it from elapsed time.
 */
export function brazierFlame(frame: number): readonly MarkRect[] {
  const { w } = STATION_SIZES['watch-post']
  const midX = Math.floor(w / 2)
  // The bowl sits at the top of the 32×48 post; the flame rises out of it.
  return frame % 2 === 0
    ? [
        { x: midX - 3, y: 4, w: 6, h: 6, color: tokens.gold },
        { x: midX - 1, y: 1, w: 2, h: 4, color: tokens.goldLight },
        { x: midX - 4, y: 10, w: 8, h: 3, color: tokens.terracotta }
      ]
    : [
        { x: midX - 3, y: 5, w: 6, h: 5, color: tokens.goldLight },
        { x: midX - 2, y: 2, w: 3, h: 4, color: tokens.gold },
        { x: midX - 4, y: 10, w: 8, h: 3, color: tokens.terracotta }
      ]
}

/** §5.4: the Odeon is 96×64, a semicircle of benches in three rows. */
export const ODEON_BENCHES = 9

/**
 * The Odeon "fills when a meeting gathers" — one bench occupant per attendee,
 * so the count on the floor IS the attendee count. Beyond the drawn benches the
 * room is simply full; it does not stack, and the census line still names the
 * true number (invariant §7: the degradation is visible, not silent).
 */
export function odeonFill(attendees: number): readonly MarkRect[] {
  const filled = Math.min(Math.max(0, Math.trunc(attendees)), ODEON_BENCHES)
  const marks: MarkRect[] = []
  for (let i = 0; i < filled; i += 1) {
    const row = Math.floor(i / 3)
    const col = i % 3
    // Three rows of three, inset so the occupants sit ON the benches.
    marks.push({
      x: 16 + col * 24 + row * 8,
      y: 20 + row * 14,
      w: 8,
      h: 10,
      color: tokens.aegeanLight
    })
  }
  return marks
}

/**
 * The generic in-use accent for the stations §5.4 does not single out — a
 * 2-frame mark in `status-working`, the same colour the badge uses for
 * "at a station, tool in use" (§2.4), so the floor and the panels say the same
 * thing about the same fact.
 */
export function workingAccent(station: Station, frame: number): readonly MarkRect[] {
  const { w } = STATION_SIZES[station]
  const x = Math.floor(w / 2) - 2
  return frame % 2 === 0
    ? [{ x, y: 2, w: 4, h: 4, color: tokens.statusWorking }]
    : [{ x, y: 3, w: 4, h: 2, color: tokens.statusWorking }]
}

/**
 * Contract: everything drawn ON a station for its current state, in the
 * station's own pixel space. An idle station draws nothing — §5.4 calls it
 * "static", and static means static.
 */
export function stationMarks(view: StationView, meetingAttendees: number): readonly MarkRect[] {
  if (view.activity === 'highlighted') return highlightOutline(view.station)
  if (view.activity !== 'in-use' || view.frame === null) return []
  if (view.station === 'watch-post') return brazierFlame(view.frame)
  if (view.station === 'odeon') return odeonFill(meetingAttendees)
  return workingAccent(view.station, view.frame)
}

/** §5.4's desk: "inbox tray, flag UP while unread mail waits". */
export const TRAY_W = 8

/**
 * Contract: the desk's inbox tray, drawn in the desk's own pixel space. The
 * tray itself is always there; the FLAG is what moves, and it moves only
 * because `deskTray()` read `pendingMailCount`. A raised flag on a desk with no
 * mail would be the floor telling a lie about the wake watchdog.
 */
export function trayMarks(tray: TrayView): readonly MarkRect[] {
  const { w } = STATION_SIZES.desk
  const x = w - TRAY_W - 4
  const marks: MarkRect[] = [
    // The tray, static: a desk has one whether or not mail is waiting.
    { x, y: 20, w: TRAY_W, h: 4, color: tokens.ink700 }
  ]
  if (!tray.flagUp) return marks
  return [
    ...marks,
    { x: x + TRAY_W - 2, y: 12, w: 2, h: 8, color: tokens.ink900 },
    { x: x + 1, y: 12, w: TRAY_W - 3, h: 5, color: tokens.gold }
  ]
}

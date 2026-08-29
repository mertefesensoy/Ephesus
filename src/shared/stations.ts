import { STATIONS, type AvatarPhase, type Station } from './avatar'

/**
 * The station catalog and its state model — UI-DESIGN §5.4.
 *
 * The governing sentence is the last one of §5.4: *"Every state maps to an
 * event-plane fact; no station animates on a timer alone."* That is enforced
 * here by construction rather than by discipline: `stationView` cannot return
 * anything but `idle` without also returning the `because` — the fact, in
 * words, that put it in that state. A station somebody wants to animate for
 * decoration has nothing to put in that field, and the compiler asks for it.
 *
 * The three facts §5.4 singles out are wired to the three things they actually
 * are, not to look-alikes:
 *
 * - the desk's **inbox tray flag IS `pendingMailCount`** — the ADR-0013 wake
 *   watchdog made visible, so the reason an agent will wake is on the floor;
 * - the Watch post's **brazier IS an open gate** — lit exactly while the
 *   Architect owes a verdict;
 * - the **Odeon fills when a meeting gathers** — the bench count is the
 *   attendee count, not a mood.
 *
 * Pure and shared: the model is data over facts, so both the floor and any
 * text projection of it (the census line, §8's information parity) read the
 * same answer.
 */

/** §5.4's three states. Exclusive — a station is in exactly one. */
export const STATION_ACTIVITIES = ['idle', 'in-use', 'highlighted'] as const

export type StationActivity = (typeof STATION_ACTIVITIES)[number]

/** §5.4: "in use (2-frame animation …)". */
export const STATION_FRAMES = 2
/**
 * One §6 duration, reused — 250 ms is already the walk/flash tick, and §6's
 * forbidden list exists so the floor does not accumulate bespoke timings.
 */
export const STATION_FRAME_MS = 250

/** One avatar's presence, as the floor reads it off an SDD §6 snapshot. */
export interface AvatarPresence {
  readonly station: Station
  /** True while en route — §5.4's "while its citizen approaches". */
  readonly walking: boolean
  readonly phase: AvatarPhase
}

/**
 * Everything the station model is allowed to know. Every field is an
 * event-plane fact or an Architect input (`hovered`); there is no clock, no
 * counter and no previous frame, so the model cannot invent a state.
 */
export interface FloorFacts {
  readonly avatars: readonly AvatarPresence[]
  /** Gates awaiting the Architect (FR-4.x) — the brazier IS this number. */
  readonly openGates: number
  /** Attendees gathered in the Odeon; 0 when no meeting is in session. */
  readonly meetingAttendees: number
  /** The station under the pointer, or null. */
  readonly hovered: Station | null
}

export const NO_FACTS: FloorFacts = {
  avatars: [],
  openGates: 0,
  meetingAttendees: 0,
  hovered: null
}

export interface StationView {
  readonly station: Station
  readonly activity: StationActivity
  /** Frame of the 2-frame in-use animation; null whenever nothing animates. */
  readonly frame: number | null
  /**
   * The event-plane fact this state projects, in words — §9's register, and
   * the text half of §8's information parity. Empty only for `idle`, which
   * projects the absence of a fact.
   */
  readonly because: string
}

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`

/**
 * Contract: one station's state, given the facts. Pure over `(station, facts,
 * nowMs)`, so replaying the same snapshots puts the same floor on screen.
 *
 * Precedence is `in-use` > `highlighted` > `idle`: something happening at a
 * station outranks the hover affordance that anticipates it, and the two are
 * naturally sequential anyway (a citizen approaches, then arrives, then works).
 */
export function stationView(station: Station, facts: FloorFacts, nowMs: number): StationView {
  const frame = Math.floor(Math.max(nowMs, 0) / STATION_FRAME_MS) % STATION_FRAMES
  const inUse = (because: string): StationView => ({
    station,
    activity: 'in-use',
    frame,
    because
  })

  // The two stations whose in-use fact is a room-level one rather than a
  // citizen standing there. Both are checked first: a gate is open whether or
  // not anyone is at the post, which is the whole point of showing it.
  if (station === 'watch-post' && facts.openGates > 0) {
    return inUse(plural(facts.openGates, 'gate open', 'gates open'))
  }
  if (station === 'odeon' && facts.meetingAttendees > 0) {
    return inUse(plural(facts.meetingAttendees, 'in session', 'in session'))
  }

  const working = facts.avatars.filter(
    (a) => a.station === station && !a.walking && a.phase === 'working'
  ).length
  if (working > 0) return inUse(plural(working, 'working here', 'working here'))

  if (facts.hovered === station) {
    return { station, activity: 'highlighted', frame: null, because: 'selected' }
  }
  const approaching = facts.avatars.filter((a) => a.station === station && a.walking).length
  if (approaching > 0) {
    return {
      station,
      activity: 'highlighted',
      frame: null,
      because: plural(approaching, 'on the way', 'on the way')
    }
  }

  return { station, activity: 'idle', frame: null, because: '' }
}

/** Contract: every station's state, in the §6 station order. */
export function stationViews(facts: FloorFacts, nowMs: number): readonly StationView[] {
  return STATIONS.map((station) => stationView(station, facts, nowMs))
}

export interface TrayView {
  /** §5.4: "flag UP while unread mail waits". */
  readonly flagUp: boolean
  readonly because: string
}

/**
 * Contract: a desk's inbox-tray flag. It IS `pendingMailCount` — up exactly
 * while at least one message waits, down otherwise, with no threshold, decay or
 * animation of its own. §5.6's tray pulse rides this flag and stops when it
 * drops, which is why the pulse cannot outlive the mail.
 */
export function deskTray(pendingMail: number): TrayView {
  const waiting = Math.max(0, Math.trunc(pendingMail))
  return waiting > 0
    ? { flagUp: true, because: plural(waiting, 'unread', 'unread') }
    : { flagUp: false, because: '' }
}

/**
 * Contract: what the floor's stations are doing, in words — appended to the
 * §8 census so the information a station's animation carries is reachable
 * without looking at pixels (NFR-15). Idle stations are omitted: a list of
 * nine "idle" lines would bury the one thing that is happening.
 */
export function stationCensus(facts: FloorFacts, nowMs: number): string {
  const busy = stationViews(facts, nowMs).filter((view) => view.activity !== 'idle')
  if (busy.length === 0) return 'stations: all quiet'
  return `stations: ${busy.map((v) => `${v.station} — ${v.because}`).join(', ')}`
}

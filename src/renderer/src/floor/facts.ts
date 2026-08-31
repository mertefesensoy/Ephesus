import type { AvatarSnapshot } from '../../../shared/avatar'
import type { AvatarUpdate } from '../../../shared/ipc'
import type { AvatarPresence, FloorFacts } from '../../../shared/stations'

/**
 * The renderer's half of the floor's facts — UI-DESIGN §5.4, ADR-0014.
 *
 * `FloorCanvas` used to assemble all of this inline, which meant the renderer
 * half of §5.4's three named facts had **no test at all**: the M6 close-out
 * audit broke "the tray flag IS `pendingMailCount`" and "the brazier IS an open
 * gate" inside the component, and every suite stayed green because nothing
 * imports a `.tsx` that needs Pixi and a canvas. The main-process half was
 * proven; the half the Architect actually looks at was not.
 *
 * So the reducers live here, pure. They hold no clock (the floor's models never
 * do — `check-invariants` enforces it in this directory) and they decide
 * nothing: each one takes what a channel reported and folds it into state the
 * station model already knows how to read.
 */

export interface FloorState {
  readonly avatars: ReadonlyMap<string, AvatarSnapshot>
  /** Per agent, the count `avatars:list`/`avatars:change` reported. */
  readonly mail: ReadonlyMap<string, number>
  readonly openGates: number
  readonly meetingAttendees: number
}

export const EMPTY_FLOOR: FloorState = {
  avatars: new Map(),
  mail: new Map(),
  openGates: 0,
  meetingAttendees: 0
}

/**
 * Contract: fold one avatar update in.
 *
 * The mail count is taken from the update's own `pendingMail` and from nowhere
 * else. It is not derived from the phase, not inferred from `waiting`, and not
 * remembered from a previous update — §5.4 says the tray flag **IS**
 * `pendingMailCount`, and anything that merely correlates with it is a
 * look-alike that will disagree the first time they diverge.
 */
export function noteAvatar(state: FloorState, update: AvatarUpdate): FloorState {
  const avatars = new Map(state.avatars)
  const mail = new Map(state.mail)
  avatars.set(update.agentId, update.snapshot)
  mail.set(update.agentId, update.pendingMail)
  return { ...state, avatars, mail }
}

/**
 * Contract: the open-gate count is exactly what the Watch reported.
 *
 * Exactly — never the larger of this and what was here before. A carried-over
 * maximum would leave the brazier lit after the last gate was answered, which
 * is the failure §5.4's "the brazier IS an open gate" exists to forbid: the
 * Architect would see work owed that they had already done.
 */
export function noteGates(state: FloorState, gates: readonly unknown[]): FloorState {
  return { ...state, openGates: gates.length }
}

/** Contract: the Odeon's bench count is the attendee count, or zero. */
export function noteMeeting(
  state: FloorState,
  meeting: { readonly attendees: readonly unknown[] } | null
): FloorState {
  return { ...state, meetingAttendees: meeting ? meeting.attendees.length : 0 }
}

/** Contract: an agent leaving the floor takes its mail count with it. */
export function forgetAvatar(state: FloorState, agentId: string): FloorState {
  const avatars = new Map(state.avatars)
  const mail = new Map(state.mail)
  avatars.delete(agentId)
  mail.delete(agentId)
  return { ...state, avatars, mail }
}

/** Contract: what the station model reads — a projection, inventing nothing. */
export function factsOf(state: FloorState): FloorFacts {
  const avatars: AvatarPresence[] = [...state.avatars.values()].map((snapshot) => ({
    station: snapshot.station,
    walking: snapshot.walking,
    phase: snapshot.phase
  }))
  return {
    avatars,
    openGates: state.openGates,
    meetingAttendees: state.meetingAttendees,
    // Hover selection is UI-DESIGN §5's camera work, not M6.2's — the model
    // takes it, and the floor has nothing to put there yet.
    hovered: null
  }
}

/** Contract: an agent's pending mail; zero when nothing has reported yet. */
export function mailFor(state: FloorState, agentId: string): number {
  return state.mail.get(agentId) ?? 0
}

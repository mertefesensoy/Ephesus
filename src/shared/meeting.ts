import { z } from 'zod'
import { agentIdSchema } from './agents'
import { HUMAN } from './message'

/**
 * Live meetings (ADR-0008 §4, FR-7.4, UC-07, SDD §6 station `odeon`).
 *
 * The split, again, is the design:
 *
 * - **The driver enforces ORDER.** Who holds the floor, whose reply counts
 *   right now, and what happens to one that arrives early — all mechanical,
 *   all here, all pure.
 * - **Artemis chairs.** Who should answer which question, what the meeting is
 *   for, when it is finished: judgement, and it stays hers.
 *
 * The rule worth stating plainly, because it is what makes a meeting a meeting
 * rather than a broadcast: **an out-of-turn reply is HELD, not lost.** Agents
 * answer at their own pace and a fast one must not be able to talk over a slow
 * one — but nor may its answer be thrown away, because it was a real answer to
 * a real question. It waits, and it is released the moment the floor reaches
 * its author.
 */

export const MEETING_SCHEMA_VERSION = 1

export const meetingIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^mt-[a-z0-9-]+$/, 'meeting id: "mt-" followed by lowercase alphanumerics and dashes')

export const conveneSchema = z
  .object({
    /** At least two: one agent and a chair is a conversation, not a meeting. */
    attendees: z.array(agentIdSchema).min(1).max(16),
    agenda: z.string().min(1).max(2_000)
  })
  .strict()

export type ConveneRequest = z.infer<typeof conveneSchema>

/** One thing said, in the order it was accepted into the record. */
export interface MeetingTurn {
  readonly from: string
  readonly text: string
  readonly at: string
}

export type MeetingStatus = 'open' | 'closed'

export interface MeetingState {
  readonly id: string
  readonly agenda: string
  readonly attendees: readonly string[]
  /** Who may speak now. Null only when the meeting is closed. */
  readonly floor: string | null
  readonly transcript: readonly MeetingTurn[]
  /** Replies that arrived out of turn, kept in arrival order. */
  readonly held: readonly MeetingTurn[]
  readonly status: MeetingStatus
  /**
   * How many attendees have declined the floor since anything was last said
   * (M8b.2).
   *
   * A COUNT rather than a set of names, and that is exact rather than lazy:
   * the floor advances on a decline, so consecutive declines are consecutive
   * ATTENDEES by construction. Reaching `attendees.length` therefore means one
   * full round in which nobody had anything to add — which is the only
   * evidence a meeting has that it is over.
   *
   * Before this, no meeting of ANY size could end without a person clicking
   * close. The 2026-09-09 run found it at one attendee, where `after()` wraps
   * to the same agent and the loop is visible in the log (seq 387 → 393 → 395
   * → 427 → 429); Artemis diagnosed it from her own transcript and declined
   * rather than speak a third time. A two-attendee meeting had the same defect
   * one step further away.
   */
  readonly declinedInARow: number
}

/**
 * Contract: a new meeting with the floor at the first attendee.
 *
 * The order is the order the Architect named them in. The chair may ask
 * whatever she likes of whoever holds the floor; what she may not do is let two
 * people hold it at once.
 */
export function convene(id: string, request: ConveneRequest, at: string): MeetingState {
  return {
    id,
    agenda: request.agenda,
    attendees: [...request.attendees],
    floor: request.attendees[0] ?? null,
    transcript: [{ from: HUMAN, text: request.agenda, at }],
    held: [],
    status: 'open',
    declinedInARow: 0
  }
}

export type ReplyOutcome =
  | { readonly kind: 'accepted'; readonly state: MeetingState }
  /** Kept, not lost: it is released when the floor reaches its author. */
  | { readonly kind: 'held'; readonly state: MeetingState }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * Contract: takes one reply and says what became of it.
 *
 * Accepting a reply advances the floor to the next attendee — and immediately
 * releases anything that attendee had already said out of turn, which is the
 * whole point of holding rather than dropping. Releases cascade: three agents
 * answering at once produce one accepted turn and two held ones, and closing
 * the round drains both in attendee order rather than in arrival order.
 */
export function reply(state: MeetingState, from: string, text: string, at: string): ReplyOutcome {
  if (state.status === 'closed') {
    return { kind: 'refused', reason: `meeting ${state.id} is closed` }
  }
  if (!state.attendees.includes(from)) {
    return { kind: 'refused', reason: `"${from}" is not in meeting ${state.id}` }
  }
  const turn: MeetingTurn = { from, text, at }

  if (state.floor !== from) {
    // Early, not wrong. It waits its turn.
    return { kind: 'held', state: { ...state, held: [...state.held, turn] } }
  }

  // Anything SAID restarts the round. The counter measures silence since the
  // last contribution, so a meeting where one attendee keeps talking never
  // adjourns itself, and one where nobody does always will.
  return {
    kind: 'accepted',
    state: drain({
      ...state,
      transcript: [...state.transcript, turn],
      floor: after(state, from),
      declinedInARow: 0
    })
  }
}

/**
 * Contract: whether this message is the floor-holder yielding. Pure.
 *
 * Extracted rather than written inline at the dispatch, and a mutation run is
 * why: the condition lived in `index.ts` AND in the scenario rig's hand-copy
 * of it, so breaking the shipped one left every test green. Two copies of a
 * routing rule is the same defect shape as two copies of a schema — they agree
 * until one of them is edited, and the disagreement is invisible.
 *
 * The narrowness is the design. A `refuse` from anyone but the current
 * floor-holder is NOT a declined floor: it is an ordinary refusal that belongs
 * to the filing endpoint's aside path, and widening this would let any agent's
 * unrelated "I cannot do that" advance a meeting it is not even in.
 */
export function isFloorDecline(
  message: { readonly act: string; readonly from: string },
  state: MeetingState | null
): boolean {
  return (
    message.act === 'refuse' &&
    state !== null &&
    state.status === 'open' &&
    state.floor === message.from
  )
}

/** What became of a declined floor. */
export type DeclineOutcome =
  /** The floor moved on; the meeting is still open. */
  | { readonly kind: 'passed'; readonly state: MeetingState }
  /** A full round declined with nothing said: the meeting is over. */
  | { readonly kind: 'adjourned'; readonly state: MeetingState }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * Contract: the floor-holder has nothing to add. Pure.
 *
 * A decline writes NO transcript entry. "I have nothing further" is not a
 * contribution to the minutes, and recording one would make a silent round
 * read like a discussion.
 *
 * Only the floor-holder may decline, and a decline out of turn is refused
 * rather than held. A held REPLY is a contribution that arrived early and is
 * worth keeping; a held decline is worth nothing by the time it is released,
 * because the question it answers has moved on.
 *
 * Adjourning is left to the caller to act on: this returns the closed state,
 * and the driver is what writes minutes and tells the room.
 *
 * It takes no timestamp, unlike `reply` and `interject`. Those two record a
 * turn and a turn needs a time; a decline records nothing, so a parameter kept
 * only for symmetry with its neighbours would be an unused one — and an unused
 * parameter is a thing every formatter and fixer in the toolchain feels
 * entitled to change underneath you.
 */
export function decline(state: MeetingState, from: string): DeclineOutcome {
  if (state.status === 'closed') {
    return { kind: 'refused', reason: `meeting ${state.id} is closed` }
  }
  if (!state.attendees.includes(from)) {
    return { kind: 'refused', reason: `"${from}" is not in meeting ${state.id}` }
  }
  if (state.floor !== from) {
    return { kind: 'refused', reason: `"${from}" does not hold the floor in meeting ${state.id}` }
  }
  const declinedInARow = state.declinedInARow + 1
  // One full round of declines with nothing said between them. `>=` rather
  // than `===` because a meeting with no attendees would otherwise never
  // satisfy it, and `attendees.length` is 0 there.
  if (declinedInARow >= state.attendees.length) {
    return { kind: 'adjourned', state: close({ ...state, declinedInARow }) }
  }
  return {
    kind: 'passed',
    state: drain({ ...state, floor: after(state, from), declinedInARow })
  }
}

/**
 * Contract: the Architect takes the floor (UC-07 step 3).
 *
 * An interjection is recorded immediately rather than queued behind the
 * attendees: the Architect is not one of the speakers waiting a turn, they are
 * the reason the meeting is happening. Naming an attendee hands them the floor
 * next; naming nobody leaves it where it was, so an aside does not cost the
 * current speaker their turn.
 */
export function interject(
  state: MeetingState,
  text: string,
  at: string,
  to?: string
): ReplyOutcome {
  if (state.status === 'closed') {
    return { kind: 'refused', reason: `meeting ${state.id} is closed` }
  }
  if (to !== undefined && !state.attendees.includes(to)) {
    return { kind: 'refused', reason: `"${to}" is not in meeting ${state.id}` }
  }
  return {
    kind: 'accepted',
    state: drain({
      ...state,
      transcript: [...state.transcript, { from: HUMAN, text, at }],
      floor: to ?? state.floor,
      // A new question restarts the round. An attendee who had nothing to add
      // to the last one may well have something to say about this one, and a
      // meeting that adjourned under the Architect's own follow-up would be
      // the rudest possible reading of the rule.
      declinedInARow: 0
    })
  }
}

/** Contract: the meeting closed, with the floor released. */
export function close(state: MeetingState): MeetingState {
  return { ...state, status: 'closed', floor: null }
}

/**
 * Releases every held reply the floor has now reached, in attendee order, and
 * advances past each one.
 *
 * Attendee order rather than arrival order, deliberately: the transcript should
 * read the way the meeting was convened, not the way the network happened to
 * deliver it.
 */
function drain(state: MeetingState): MeetingState {
  let current = state
  for (;;) {
    const floor = current.floor
    if (floor === null) return current
    const index = current.held.findIndex((turn) => turn.from === floor)
    if (index === -1) return current
    const released = current.held[index]
    if (released === undefined) return current
    current = {
      ...current,
      transcript: [...current.transcript, released],
      held: current.held.filter((_unused, at) => at !== index),
      floor: after(current, floor)
    }
  }
}

/** The next attendee after `who`, wrapping. Null when there are no attendees. */
function after(state: MeetingState, who: string): string | null {
  if (state.attendees.length === 0) return null
  const index = state.attendees.indexOf(who)
  return state.attendees[(index + 1) % state.attendees.length] ?? null
}

/** An action item the meeting produced, for the ledger (FR-7.4). */
export const actionItemSchema = z
  .object({
    title: z.string().min(1).max(200),
    assignee: agentIdSchema,
    spec: z.string().min(1).max(20_000)
  })
  .strict()

export type ActionItem = z.infer<typeof actionItemSchema>

/**
 * Contract: the archived minutes (SDD §2's `odeon/minutes/<meetingId>.md`).
 *
 * Held replies that were never released are printed under their own heading
 * rather than dropped. A meeting closed while somebody was still waiting to
 * speak is a fact about that meeting, and hiding it would make the minutes a
 * summary instead of a record.
 */
export function renderMinutes(
  state: MeetingState,
  actions: readonly ActionItem[],
  at: string
): string {
  const lines: string[] = [
    `# Meeting ${state.id}`,
    '',
    `- meeting: ${state.id}`,
    `- closed: ${at}`,
    `- attendees: ${state.attendees.join(', ')}`,
    '',
    '## Agenda',
    '',
    state.agenda,
    '',
    '## Transcript',
    ''
  ]
  for (const turn of state.transcript) {
    lines.push(`**${turn.from}** — ${turn.text}`, '')
  }
  if (state.held.length > 0) {
    lines.push('## Never reached the floor', '')
    for (const turn of state.held) {
      lines.push(`**${turn.from}** — ${turn.text}`, '')
    }
  }
  lines.push('## Action items', '')
  if (actions.length === 0) lines.push('None.', '')
  for (const action of actions) {
    lines.push(`- ${action.title} → ${action.assignee}`)
  }
  lines.push('')
  return lines.join('\n')
}

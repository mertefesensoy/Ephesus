import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { writeFileAtomic } from './fsx'
import {
  close as closeMeeting,
  convene,
  interject,
  renderMinutes,
  reply,
  type ActionItem,
  type ConveneRequest,
  type MeetingState
} from '../shared/meeting'
import { composeMessage, makeMessageId, type Message } from '../shared/message'
import { ODEON_ENDPOINT } from '../shared/reserved'
import type { PromptStore } from './prompts'

/**
 * The meeting driver (ADR-0008 §4, FR-7.4, UC-07).
 *
 * It owns exactly one thing: **who may speak now**. Every question it sends
 * goes to the agent holding the floor and to nobody else, and every reply is
 * accepted, held or refused by the pure rules in `shared/meeting.ts`.
 *
 * It does NOT chair. It never decides what to ask, who should answer it, or
 * when the meeting is over — those are Artemis's, and the Architect's. The
 * driver's whole contribution is that two people can never hold the floor at
 * once and that nobody's answer is thrown away for arriving early.
 *
 * One meeting at a time. Two live meetings would put the same agent on two
 * floors, and the Odeon room on the floor plan is one room.
 */

const QUESTION_PROMPT = path.join('odeon', 'meeting-floor.md')
const QUESTION_SUBJECT = path.join('odeon', 'meeting-floor-subject.md')
const ACTIONS_PROMPT = path.join('odeon', 'meeting-actions.md')
const ACTIONS_SUBJECT = path.join('odeon', 'meeting-actions-subject.md')

export interface MeetingOptions {
  readonly agoraRoot: string
  readonly prompts: PromptStore
  /** Delivers a harness-authored message (injected, like the briefing's). */
  deliver(message: Message): void
  /** The orchestrator, who is asked to propose the action items (FR-4.2). */
  orchestrator(): string | null
  /** Drives the floor: attendees gather in the Odeon room (SDD §6). */
  onAttendance?(agentId: string, present: boolean): void
  /** `log` kind `meeting` (SDD §4.3). */
  onLogEvent?(draft: { kind: 'meeting' } & Record<string, unknown>): void
  /** Pushed to the renderer so the meeting panel re-reads. */
  onChange?(): void
  now?(): Date
}

export type SayOutcome =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'held' }
  | { readonly kind: 'refused'; readonly reason: string }

export class MeetingDriver {
  private readonly now: () => Date
  private state: MeetingState | null = null

  constructor(private readonly options: MeetingOptions) {
    this.now = options.now ?? (() => new Date())
  }

  /** The live meeting, or null. The panel is a projection of exactly this. */
  current(): MeetingState | null {
    return this.state
  }

  /**
   * Convenes a meeting and hands the floor to the first attendee.
   *
   * Contract: refuses while another meeting is open, rather than replacing it.
   * Silently dropping a live meeting would lose a transcript nobody had
   * archived yet.
   */
  convene(
    request: ConveneRequest
  ): { readonly ok: true; readonly id: string } | { readonly ok: false; readonly reason: string } {
    if (this.state !== null && this.state.status === 'open') {
      return { ok: false, reason: `meeting ${this.state.id} is still open` }
    }
    const at = this.now()
    const id = `mt-${at.toISOString().replace(/[:.]/g, '-').toLowerCase()}-${randomBytes(2).toString('hex')}`
    this.state = convene(id, request, at.toISOString())

    for (const attendee of request.attendees) this.options.onAttendance?.(attendee, true)
    this.options.onLogEvent?.({
      kind: 'meeting',
      event: 'convened',
      meetingId: id,
      attendees: [...request.attendees],
      agenda: request.agenda
    })
    this.handFloor()
    this.options.onChange?.()
    return { ok: true, id }
  }

  /**
   * Takes one attendee's reply.
   *
   * A held reply is answered with nothing at all — the agent said its piece and
   * the driver will use it; telling it "wait your turn" would invite it to say
   * the same thing again.
   */
  say(from: string, text: string): SayOutcome {
    if (this.state === null) return { kind: 'refused', reason: 'no meeting is open' }
    const outcome = reply(this.state, from, text, this.now().toISOString())
    if (outcome.kind === 'refused') return outcome

    this.state = outcome.state
    this.options.onLogEvent?.({
      kind: 'meeting',
      event: outcome.kind === 'held' ? 'held' : 'said',
      meetingId: this.state.id,
      from,
      floor: this.state.floor
    })
    // Hand the floor after EVERY accepted turn, never only when the holder
    // changed. A drain that releases held replies can wrap the floor back to
    // the same agent, and comparing identity there left nobody asked and the
    // meeting stalled with a full transcript — found by a test.
    if (outcome.kind === 'accepted') this.handFloor()
    this.options.onChange?.()
    return { kind: outcome.kind }
  }

  /** The Architect takes the floor (UC-07 step 3, SDD §5 `odeon:meetingSay`). */
  interject(text: string, to?: string): SayOutcome {
    if (this.state === null) return { kind: 'refused', reason: 'no meeting is open' }
    const outcome = interject(
      this.state,
      text,
      this.now().toISOString(),
      ...(to === undefined ? [] : [to])
    )
    if (outcome.kind === 'refused') return outcome

    this.state = outcome.state
    this.options.onLogEvent?.({
      kind: 'meeting',
      event: 'interjected',
      meetingId: this.state.id,
      floor: this.state.floor
    })
    // The holder now has something new to answer, whether or not the floor
    // moved: an interjection IS the question.
    this.handFloor()
    this.options.onChange?.()
    return { kind: 'accepted' }
  }

  /**
   * Closes the meeting: minutes archived immutably, action items proposed.
   *
   * The minutes are the harness's to write (SDD §2 gives it `odeon/`). The
   * ACTION ITEMS are not: FR-4.2 gives the ledger one scribe, so they go to the
   * orchestrator as a request for her to propose. A harness that wrote tasks
   * here would be a second writer on `tasks.json`, which ADR-0004 spent a
   * package removing.
   */
  close(
    actions: readonly ActionItem[] = []
  ): { readonly ok: true; readonly ref: string } | { readonly ok: false; readonly reason: string } {
    if (this.state === null || this.state.status === 'closed') {
      return { ok: false, reason: 'no meeting is open' }
    }
    const at = this.now()
    this.state = closeMeeting(this.state)
    const state = this.state

    const dir = path.join(this.options.agoraRoot, 'odeon', 'minutes')
    const file = path.join(dir, `${state.id}.md`)
    // Append-only: a meeting id is minted once, so a second close cannot
    // overwrite the record of the first (invariant §5).
    mkdirSync(dir, { recursive: true })
    writeFileAtomic(file, renderMinutes(state, actions, at.toISOString()))

    for (const attendee of state.attendees) this.options.onAttendance?.(attendee, false)

    const ref = path.posix.join('odeon', 'minutes', `${state.id}.md`)
    this.options.onLogEvent?.({
      kind: 'meeting',
      event: 'closed',
      meetingId: state.id,
      minutesRef: ref,
      turns: state.transcript.length,
      unheard: state.held.length,
      actions: actions.length
    })

    const to = this.options.orchestrator()
    if (actions.length > 0 && to !== null) {
      const vars = {
        meetingId: state.id,
        actions: actions
          .map((action) => `- ${action.title} → ${action.assignee}: ${action.spec}`)
          .join('\n')
      }
      this.options.deliver(
        composeMessage({
          id: makeMessageId(at, `act${randomBytes(3).toString('hex')}`),
          conversation: `conv-meeting-${state.id}`,
          in_reply_to: null,
          from: ODEON_ENDPOINT,
          to,
          act: 'request',
          subject: this.options.prompts
            .render(ACTIONS_SUBJECT, { meetingId: state.id })
            .trim()
            .slice(0, 200),
          body: this.options.prompts.render(ACTIONS_PROMPT, vars).trim(),
          hops: 0,
          created_at: at.toISOString()
        })
      )
    }
    this.options.onChange?.()
    return { ok: true, ref }
  }

  /** Sends the floor-holder the question. Nobody else is asked anything. */
  private handFloor(): void {
    const state = this.state
    if (state === null || state.floor === null || state.status === 'closed') return
    const at = this.now()
    const said = state.transcript.at(-1)
    this.options.deliver(
      composeMessage({
        id: makeMessageId(at, `mtg${randomBytes(3).toString('hex')}`),
        conversation: `conv-meeting-${state.id}`,
        in_reply_to: null,
        from: ODEON_ENDPOINT,
        to: state.floor,
        // `query` obligates a reply (ADR-0003's table) — the floor is a
        // question, not an announcement.
        act: 'query',
        subject: this.options.prompts
          .render(QUESTION_SUBJECT, { meetingId: state.id })
          .trim()
          .slice(0, 200),
        body: this.options.prompts
          .render(QUESTION_PROMPT, {
            meetingId: state.id,
            agenda: state.agenda,
            last: said === undefined ? state.agenda : `${said.from}: ${said.text}`
          })
          .trim(),
        hops: 0,
        created_at: at.toISOString()
      })
    )
    this.options.onLogEvent?.({
      kind: 'meeting',
      event: 'floor',
      meetingId: state.id,
      to: state.floor
    })
  }
}

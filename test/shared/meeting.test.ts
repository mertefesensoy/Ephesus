import { describe, expect, it } from 'vitest'
import {
  close,
  convene,
  interject,
  MEETING_SCHEMA_VERSION,
  conveneSchema,
  renderMinutes,
  reply,
  type MeetingState
} from '../../src/shared/meeting'
import { HUMAN } from '../../src/shared/message'

/**
 * Turn order (ADR-0008 §4, FR-7.4, UC-07) — S-MEETING's core.
 *
 * One claim carries this file: **an out-of-turn reply is held, not lost.** A
 * fast agent must not talk over a slow one, and its answer must not be thrown
 * away for arriving early — it was a real answer to a real question. Everything
 * else here exists to show that holding actually pays out.
 */

const AT = '2026-08-28T10:00:00.000Z'

function meeting(...attendees: string[]): MeetingState {
  return convene(
    'mt-2026-08-28-01',
    { attendees, agenda: 'What is blocking the checkout fix?' },
    AT
  )
}

function said(state: MeetingState): string[] {
  return state.transcript.map((turn) => `${turn.from}:${turn.text}`)
}

describe('convening puts exactly one agent on the floor', () => {
  it('gives the floor to the first attendee named', () => {
    const state = meeting('agent.mason', 'agent.scribe')
    expect(state.floor).toBe('agent.mason')
    expect(state.status).toBe('open')
  })

  it('opens the transcript with the agenda, attributed to the Architect', () => {
    expect(said(meeting('agent.mason'))[0]).toBe(`${HUMAN}:What is blocking the checkout fix?`)
  })

  it('refuses a convene request with no attendees', () => {
    expect(conveneSchema.safeParse({ attendees: [], agenda: 'x' }).success).toBe(false)
  })

  it('refuses a convene request with no agenda', () => {
    expect(conveneSchema.safeParse({ attendees: ['agent.mason'], agenda: '' }).success).toBe(false)
  })
})

describe('S-MEETING — an out-of-turn reply is HELD, not lost', () => {
  it('accepts the floor-holder and advances', () => {
    const state = meeting('agent.mason', 'agent.scribe')
    const outcome = reply(state, 'agent.mason', 'The fixture is stale.', AT)
    expect(outcome.kind).toBe('accepted')
    if (outcome.kind !== 'accepted') return
    expect(outcome.state.floor).toBe('agent.scribe')
    expect(said(outcome.state)).toContain('agent.mason:The fixture is stale.')
  })

  it('HOLDS a reply from an attendee who does not have the floor', () => {
    const state = meeting('agent.mason', 'agent.scribe')
    const outcome = reply(state, 'agent.scribe', 'I already know why.', AT)

    expect(outcome.kind).toBe('held')
    if (outcome.kind !== 'held') return
    // Held, not lost: it is off the transcript but still in the meeting.
    expect(said(outcome.state)).not.toContain('agent.scribe:I already know why.')
    expect(outcome.state.held).toHaveLength(1)
    // …and it did not steal the floor.
    expect(outcome.state.floor).toBe('agent.mason')
  })

  it('RELEASES the held reply the moment the floor reaches its author', () => {
    // This is the payoff. Without it, holding would just be a slower way of
    // dropping the answer.
    let state = meeting('agent.mason', 'agent.scribe')
    const early = reply(state, 'agent.scribe', 'I already know why.', AT)
    if (early.kind !== 'held') throw new Error('expected held')
    state = early.state

    const inTurn = reply(state, 'agent.mason', 'The fixture is stale.', AT)
    if (inTurn.kind !== 'accepted') throw new Error('expected accepted')

    expect(said(inTurn.state)).toContain('agent.scribe:I already know why.')
    expect(inTurn.state.held).toEqual([])
  })

  it('drains a whole round in ATTENDEE order, not arrival order', () => {
    // Three agents answering at once: the transcript should read the way the
    // meeting was convened, not the way the network delivered it.
    let state = meeting('agent.a', 'agent.b', 'agent.c')
    for (const who of ['agent.c', 'agent.b']) {
      const held = reply(state, who, `${who} says so`, AT)
      if (held.kind !== 'held') throw new Error('expected held')
      state = held.state
    }
    const first = reply(state, 'agent.a', 'agent.a says so', AT)
    if (first.kind !== 'accepted') throw new Error('expected accepted')

    expect(said(first.state).slice(1)).toEqual([
      'agent.a:agent.a says so',
      'agent.b:agent.b says so',
      'agent.c:agent.c says so'
    ])
    expect(first.state.held).toEqual([])
  })

  it('wraps the floor back to the first attendee after the last', () => {
    let state = meeting('agent.a', 'agent.b')
    const a = reply(state, 'agent.a', '1', AT)
    if (a.kind !== 'accepted') throw new Error('expected accepted')
    const b = reply(a.state, 'agent.b', '2', AT)
    if (b.kind !== 'accepted') throw new Error('expected accepted')
    expect(b.state.floor).toBe('agent.a')
    state = b.state
    expect(state.held).toEqual([])
  })

  it('REFUSES somebody who is not in the meeting', () => {
    // Not held: a non-attendee has no turn to wait for.
    const outcome = reply(meeting('agent.mason'), 'agent.stranger', 'hello', AT)
    expect(outcome.kind).toBe('refused')
    if (outcome.kind === 'refused') expect(outcome.reason).toContain('not in meeting')
  })

  it('refuses everything once the meeting is closed', () => {
    const closed = close(meeting('agent.mason'))
    expect(reply(closed, 'agent.mason', 'one more thing', AT).kind).toBe('refused')
    expect(interject(closed, 'and another', AT).kind).toBe('refused')
  })
})

describe('the Architect can take the floor (UC-07 step 3)', () => {
  it('records the interjection immediately, ahead of the queue', () => {
    const state = meeting('agent.mason', 'agent.scribe')
    const outcome = interject(state, 'Skip that — what about the deploy?', AT)
    expect(outcome.kind).toBe('accepted')
    if (outcome.kind !== 'accepted') return
    expect(said(outcome.state).at(-1)).toBe(`${HUMAN}:Skip that — what about the deploy?`)
  })

  it('leaves the floor where it was when nobody is named', () => {
    // An aside must not cost the current speaker their turn.
    const outcome = interject(meeting('agent.mason', 'agent.scribe'), 'Carry on.', AT)
    if (outcome.kind !== 'accepted') throw new Error('expected accepted')
    expect(outcome.state.floor).toBe('agent.mason')
  })

  it('hands the floor to the attendee it names', () => {
    const outcome = interject(
      meeting('agent.mason', 'agent.scribe'),
      'Scribe, you take this one.',
      AT,
      'agent.scribe'
    )
    if (outcome.kind !== 'accepted') throw new Error('expected accepted')
    expect(outcome.state.floor).toBe('agent.scribe')
  })

  it('releases that attendee’s held reply when it grabs the floor for them', () => {
    let state = meeting('agent.mason', 'agent.scribe')
    const early = reply(state, 'agent.scribe', 'I have the answer.', AT)
    if (early.kind !== 'held') throw new Error('expected held')
    state = early.state

    const grab = interject(state, 'Scribe, go ahead.', AT, 'agent.scribe')
    if (grab.kind !== 'accepted') throw new Error('expected accepted')
    expect(said(grab.state)).toContain('agent.scribe:I have the answer.')
  })

  it('refuses to hand the floor to somebody who is not in the meeting', () => {
    const outcome = interject(meeting('agent.mason'), 'You there.', AT, 'agent.stranger')
    expect(outcome.kind).toBe('refused')
  })
})

describe('the minutes are a record, not a summary', () => {
  it('prints the agenda, the transcript and the attendees', () => {
    const state = meeting('agent.mason', 'agent.scribe')
    const md = renderMinutes(state, [], AT)
    expect(md).toContain('# Meeting mt-2026-08-28-01')
    expect(md).toContain('agent.mason, agent.scribe')
    expect(md).toContain('## Agenda')
    expect(md).toContain('What is blocking the checkout fix?')
  })

  it('prints action items when there are any, and says so when there are none', () => {
    const state = meeting('agent.mason')
    expect(renderMinutes(state, [], AT)).toContain('None.')
    expect(
      renderMinutes(
        state,
        [{ title: 'Rebuild the fixture', assignee: 'agent.mason', spec: 'do it' }],
        AT
      )
    ).toContain('Rebuild the fixture → agent.mason')
  })

  it('prints what NEVER reached the floor rather than dropping it', () => {
    // A meeting closed while somebody was still waiting to speak is a fact
    // about that meeting; hiding it would make the minutes a summary.
    const early = reply(meeting('agent.mason', 'agent.scribe'), 'agent.scribe', 'unheard', AT)
    if (early.kind !== 'held') throw new Error('expected held')
    const md = renderMinutes(close(early.state), [], AT)
    expect(md).toContain('## Never reached the floor')
    expect(md).toContain('agent.scribe')
    expect(md).toContain('unheard')
  })

  it('omits that heading when everyone was heard', () => {
    expect(renderMinutes(close(meeting('agent.mason')), [], AT)).not.toContain(
      'Never reached the floor'
    )
  })
})

describe('the schema is versioned like every other artifact (invariant §9)', () => {
  it('carries a schema version', () => {
    expect(MEETING_SCHEMA_VERSION).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import {
  EMPTY_FLOOR,
  factsOf,
  forgetAvatar,
  mailFor,
  noteAvatar,
  noteGates,
  noteMeeting
} from '../../src/renderer/src/floor/facts'
import { stationView } from '../../src/shared/stations'
import type { AvatarUpdate } from '../../src/shared/ipc'
import type { AvatarSnapshot } from '../../src/shared/avatar'

/**
 * The renderer half of §5.4's three named facts.
 *
 * The M6 close-out audit broke both of the wired ones INSIDE `FloorCanvas` —
 * the tray flag reading a different field, the brazier carrying a stale
 * maximum — and every suite stayed green, because nothing imports a `.tsx`
 * needing Pixi and a canvas. The main-process half was mutation-checked; this
 * half had no test at all. These are those tests.
 */

const snapshot = (over: Partial<AvatarSnapshot> = {}): AvatarSnapshot =>
  ({
    phase: 'working',
    station: 'shelf',
    origin: 'desk',
    walking: false,
    sinceMs: 0,
    ...over
  }) as AvatarSnapshot

const update = (
  agentId: string,
  pendingMail: number,
  over: Partial<AvatarSnapshot> = {}
): AvatarUpdate => ({ agentId, snapshot: snapshot(over), pendingMail }) as AvatarUpdate

describe('the tray flag IS pendingMailCount (§5.4)', () => {
  it('takes the count from the update, not from the phase', () => {
    // The audit's mutation: `update.snapshot.phase === 'waiting' ? 1 : 0`.
    // A `waiting` agent with an EMPTY inbox is the counter-example — the two
    // correlate often enough to look right and are not the same fact.
    const state = noteAvatar(EMPTY_FLOOR, update('iris', 0, { phase: 'waiting' }))
    expect(mailFor(state, 'iris')).toBe(0)

    // And a working agent WITH mail waiting is the other half of it.
    const busy = noteAvatar(state, update('mason', 3, { phase: 'working' }))
    expect(mailFor(busy, 'mason')).toBe(3)
  })

  it('follows the count down as well as up', () => {
    let state = noteAvatar(EMPTY_FLOOR, update('iris', 4))
    expect(mailFor(state, 'iris')).toBe(4)
    state = noteAvatar(state, update('iris', 0))
    // A flag that only ever rose would leave the desk claiming mail that was
    // read — the tray is the live count, not a high-water mark.
    expect(mailFor(state, 'iris')).toBe(0)
  })

  it('reports zero for an agent nothing has said anything about', () => {
    expect(mailFor(EMPTY_FLOOR, 'nobody')).toBe(0)
  })

  it('forgets an agent that left, mail and all', () => {
    const state = forgetAvatar(noteAvatar(EMPTY_FLOOR, update('iris', 2)), 'iris')
    expect(mailFor(state, 'iris')).toBe(0)
    expect(factsOf(state).avatars).toHaveLength(0)
  })
})

describe('the brazier IS an open gate (§5.4)', () => {
  it('is exactly what the Watch reported, never a carried maximum', () => {
    // The audit's mutation: `Math.max(previous, gates.length)`. It passes every
    // test that only ever adds gates, and leaves the brazier lit forever once
    // the Architect answers the last one.
    let state = noteGates(EMPTY_FLOOR, [{}, {}, {}])
    expect(factsOf(state).openGates).toBe(3)
    state = noteGates(state, [])
    expect(factsOf(state).openGates).toBe(0)
  })

  it('lights the Watch post exactly while a gate is open', () => {
    // Through the real station model, because that is what the floor draws.
    const lit = stationView('watch-post', factsOf(noteGates(EMPTY_FLOOR, [{}])), 0)
    expect(lit.activity).toBe('in-use')
    expect(lit.because).toContain('gate open')

    const dark = stationView('watch-post', factsOf(noteGates(EMPTY_FLOOR, [])), 0)
    expect(dark.activity).toBe('idle')
  })
})

describe('the Odeon fills when a meeting gathers (§5.4)', () => {
  it('seats one bench per attendee, and empties when the meeting ends', () => {
    const gathered = noteMeeting(EMPTY_FLOOR, { attendees: ['a', 'b', 'c'] })
    expect(factsOf(gathered).meetingAttendees).toBe(3)
    expect(stationView('odeon', factsOf(gathered), 0).activity).toBe('in-use')

    const over = noteMeeting(gathered, null)
    expect(factsOf(over).meetingAttendees).toBe(0)
    expect(stationView('odeon', factsOf(over), 0).activity).toBe('idle')
  })
})

describe('the facts are a projection and nothing else (ADR-0014)', () => {
  it('carries every live avatar through to the station model', () => {
    const state = noteAvatar(
      noteAvatar(EMPTY_FLOOR, update('iris', 0, { station: 'shelf' })),
      update('mason', 0, { station: 'portal', walking: true })
    )
    const facts = factsOf(state)
    expect(facts.avatars).toHaveLength(2)
    // Working at the shelf makes it live; walking to the portal only
    // highlights it — the §5.4 precedence, read off real presences.
    expect(stationView('shelf', facts, 0).activity).toBe('in-use')
    expect(stationView('portal', facts, 0).activity).toBe('highlighted')
  })

  it('invents no hover — the floor has no camera yet', () => {
    expect(factsOf(EMPTY_FLOOR).hovered).toBeNull()
  })

  it('does not mutate the state handed to it', () => {
    // Every reducer returns a new value: a ref holding one of these must not
    // change under a caller that kept an earlier copy.
    const before = noteAvatar(EMPTY_FLOOR, update('iris', 1))
    const after = noteAvatar(before, update('mason', 2))
    expect(mailFor(before, 'mason')).toBe(0)
    expect(mailFor(after, 'mason')).toBe(2)
    expect(before.avatars.size).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import {
  assignSeat,
  isReserved,
  parseSeat,
  terraceSeat,
  TEMPLE_SEAT,
  type Seat
} from '../../src/shared/seats'

/**
 * Seating (UI-DESIGN §5, SDD §4.1) — the M2 carried item.
 *
 * Until M3.6 every hire was written into the roster as `seat: 'terrace'` and
 * the floor placed avatars by their index in a `Map`, so a citizen changed
 * desks whenever anyone else was hired or exited. The two properties that make
 * a seat a place — it is *stable* and the temple is *reserved* — are what this
 * file pins.
 */

function taken(...pairs: [string, Seat][]): Map<string, Seat> {
  return new Map(pairs)
}

describe('seat vocabulary', () => {
  it('reads the two seats SDD §4.1 writes by example', () => {
    expect(parseSeat('temple')).toEqual({ kind: 'temple' })
    expect(parseSeat('terrace-3')).toEqual({ kind: 'terrace', index: 3 })
  })

  it.each([
    ['the M2 placeholder', 'terrace'],
    ['a zeroth terrace', 'terrace-0'],
    ['a padded number', 'terrace-03'],
    ['a spaced number', 'terrace- 3'],
    ['a hex number', 'terrace-0x3'],
    ['a fraction', 'terrace-3.5'],
    ['a negative', 'terrace--3'],
    ['another harness’s word', 'balcony'],
    ['nothing', ''],
    ['a non-string', 7]
  ])('refuses %s', (_name, seat) => {
    expect(parseSeat(seat)).toBeNull()
  })

  it('round-trips a terrace number', () => {
    for (const index of [1, 2, 9, 21, 500]) {
      expect(parseSeat(terraceSeat(index))).toEqual({ kind: 'terrace', index })
    }
  })

  it('refuses to name a seat that is not a place', () => {
    expect(() => terraceSeat(0)).toThrow(/1-based/)
    expect(() => terraceSeat(-1)).toThrow(/1-based/)
    expect(() => terraceSeat(1.5)).toThrow(/1-based/)
  })

  it('knows which seat is reserved', () => {
    expect(isReserved(TEMPLE_SEAT)).toBe(true)
    expect(isReserved('terrace-1')).toBe(false)
    expect(isReserved('terrace')).toBe(false)
  })
})

describe('assignment is deterministic', () => {
  it('gives the first hire the first terrace', () => {
    expect(assignSeat({ agentId: 'agent.mason', isOrchestrator: false, taken: taken() })).toBe(
      'terrace-1'
    )
  })

  it('gives the same answer every time, for the same roster', () => {
    const roster = taken(['agent.a', 'terrace-1'], ['agent.b', 'terrace-2'])
    const once = assignSeat({ agentId: 'agent.c', isOrchestrator: false, taken: roster })
    const again = assignSeat({ agentId: 'agent.c', isOrchestrator: false, taken: roster })
    expect(once).toBe('terrace-3')
    expect(again).toBe(once)
  })

  it('does not depend on the order the roster is read in', () => {
    const forward = assignSeat({
      agentId: 'agent.c',
      isOrchestrator: false,
      taken: taken(['agent.a', 'terrace-1'], ['agent.b', 'terrace-4'])
    })
    const backward = assignSeat({
      agentId: 'agent.c',
      isOrchestrator: false,
      taken: taken(['agent.b', 'terrace-4'], ['agent.a', 'terrace-1'])
    })
    expect(forward).toBe(backward)
  })

  it('never seats two agents on one desk', () => {
    const roster = new Map<string, Seat>()
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      roster.set(id, assignSeat({ agentId: id, isOrchestrator: false, taken: roster }))
    }
    expect(new Set(roster.values()).size).toBe(roster.size)
  })

  it('reuses a vacated number rather than leaving a gap', () => {
    const roster = taken(['agent.a', 'terrace-1'], ['agent.b', 'terrace-2'])
    roster.delete('agent.a')
    expect(assignSeat({ agentId: 'agent.c', isOrchestrator: false, taken: roster })).toBe(
      'terrace-1'
    )
  })

  it('takes the lowest free number, not the next one up', () => {
    const roster = taken(['agent.a', 'terrace-2'], ['agent.b', 'terrace-3'])
    expect(assignSeat({ agentId: 'agent.c', isOrchestrator: false, taken: roster })).toBe(
      'terrace-1'
    )
  })
})

describe('assignment is stable', () => {
  it('leaves an agent in the seat it already holds', () => {
    const roster = taken(['agent.mason', 'terrace-7'], ['agent.scribe', 'terrace-1'])
    // This is the property the placeholder could not have: re-registering an
    // agent — a respawn, a status mirror, a restart replaying the roster —
    // must not move it.
    expect(assignSeat({ agentId: 'agent.mason', isOrchestrator: false, taken: roster })).toBe(
      'terrace-7'
    )
  })

  it('reassigns an agent holding a seat that names no place', () => {
    // Every roster written before M3.6 says exactly this.
    const roster = taken(['agent.mason', 'terrace'])
    expect(assignSeat({ agentId: 'agent.mason', isOrchestrator: false, taken: roster })).toBe(
      'terrace-1'
    )
  })

  it('does not count its own stale seat as taken by someone else', () => {
    const roster = taken(['agent.mason', 'terrace'], ['agent.scribe', 'terrace-2'])
    expect(assignSeat({ agentId: 'agent.mason', isOrchestrator: false, taken: roster })).toBe(
      'terrace-1'
    )
  })
})

describe('the temple is reserved (ADR-0005)', () => {
  it('seats the orchestrator in the temple', () => {
    expect(assignSeat({ agentId: 'agent.artemis', isOrchestrator: true, taken: taken() })).toBe(
      TEMPLE_SEAT
    )
  })

  it('keeps the temple for her however full the terraces are', () => {
    const roster = new Map<string, Seat>()
    for (let i = 0; i < 40; i += 1) {
      roster.set(
        `agent.${i}`,
        assignSeat({ agentId: `agent.${i}`, isOrchestrator: false, taken: roster })
      )
    }
    expect([...roster.values()]).not.toContain(TEMPLE_SEAT)
    expect(assignSeat({ agentId: 'agent.artemis', isOrchestrator: true, taken: roster })).toBe(
      TEMPLE_SEAT
    )
  })

  it('moves her back into the temple if a roster seated her elsewhere', () => {
    const roster = taken(['agent.artemis', 'terrace-4'])
    expect(assignSeat({ agentId: 'agent.artemis', isOrchestrator: true, taken: roster })).toBe(
      TEMPLE_SEAT
    )
  })

  it('turns a worker out of the temple rather than honouring it', () => {
    // A roster written by hand, or by an older harness, is not authority to
    // sit in the temple.
    const roster = taken(['agent.mason', TEMPLE_SEAT])
    expect(assignSeat({ agentId: 'agent.mason', isOrchestrator: false, taken: roster })).toBe(
      'terrace-1'
    )
  })

  it('does not let a worker’s claim on the temple block a terrace number', () => {
    const roster = taken(['agent.mason', TEMPLE_SEAT], ['agent.scribe', 'terrace-1'])
    expect(assignSeat({ agentId: 'agent.other', isOrchestrator: false, taken: roster })).toBe(
      'terrace-2'
    )
  })
})

/**
 * Seats — where a citizen sits when it is not at a station (UI-DESIGN §5,
 * SDD §4.1's `seat` field).
 *
 * From M1 to M2 every hire was written into the roster as `seat: 'terrace'`,
 * a placeholder that named no place: the floor positioned avatars by their
 * index in a `Map`, so a citizen moved desks whenever another agent was hired
 * or exited, and the roster's own field said nothing. That is the carried item
 * this module closes.
 *
 * Two rules make a seat mean something:
 *
 *  - **Stable.** An agent keeps its seat for as long as it is in the roster, so
 *    the Architect can learn where someone sits. The roster is the memory; this
 *    module is pure and is handed the seats already taken.
 *  - **Reserved.** `temple` is Artemis's alone (ADR-0005, SDD §4.1). No number
 *    of hires can crowd her out of it, and no worker can be seated there.
 *
 * Kept in `src/shared/` because both planes need it: main assigns the seat and
 * writes it to the roster, the floor reads it back to place the sprite.
 */

/** Artemis's reserved seat (SDD §4.1: `"seat": "temple"`). */
export const TEMPLE_SEAT = 'temple'

/** Every other seat is `terrace-<n>`, 1-based (SDD §4.1: `"seat": "terrace-3"`). */
export const TERRACE_PREFIX = 'terrace-'

/**
 * A seat as it appears in the roster. Deliberately a plain string: the registry
 * schema has carried `seat: string` since M1 and rosters written before this
 * module exist, holding the old `'terrace'` placeholder. Tightening the schema
 * would turn those rosters into parse failures — an unreadable roster — so a
 * seat that does not parse is *reassigned*, not rejected.
 */
export type Seat = string

export type SeatPlace =
  { readonly kind: 'temple' } | { readonly kind: 'terrace'; readonly index: number }

/** Contract: the seat string for a 1-based terrace number. */
export function terraceSeat(index: number): Seat {
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`terrace seats are 1-based integers, got ${String(index)}`)
  }
  return `${TERRACE_PREFIX}${index}`
}

/**
 * Contract: parses a roster seat, or null when it names no place this floor
 * knows — including M2's `'terrace'` placeholder, `terrace-0`, and anything an
 * older or newer harness wrote.
 */
export function parseSeat(seat: unknown): SeatPlace | null {
  if (typeof seat !== 'string') return null
  if (seat === TEMPLE_SEAT) return { kind: 'temple' }
  if (!seat.startsWith(TERRACE_PREFIX)) return null
  const rest = seat.slice(TERRACE_PREFIX.length)
  // `Number()` would accept ' 3', '3.0' and '0x3'; a seat is a plain integer.
  if (!/^[1-9][0-9]{0,3}$/.test(rest)) return null
  return { kind: 'terrace', index: Number(rest) }
}

/** Contract: true for a seat no ordinary hire may be given. */
export function isReserved(seat: unknown): boolean {
  return parseSeat(seat)?.kind === 'temple'
}

export interface SeatAssignment {
  readonly agentId: string
  /** Artemis alone: the temple seat is hers whatever else she was holding. */
  readonly isOrchestrator: boolean
  /** Seats already held, agent id → seat. Usually the roster, read as it is. */
  readonly taken: ReadonlyMap<string, Seat> | Iterable<readonly [string, Seat]>
}

/**
 * Contract: the seat for one agent, given who is already seated.
 *
 * Deterministic — the same roster and the same agent always give the same seat,
 * with no clock, no randomness and no iteration order in play. Idempotent: an
 * agent already holding a valid seat keeps it, so re-registering an agent (a
 * respawn, a status mirror, a restart that replays the roster) never moves it.
 *
 * A vacated number is reused, which keeps the terraces packed from the front
 * rather than leaving gaps where agents used to be.
 */
export function assignSeat(assignment: SeatAssignment): Seat {
  const taken = new Map(assignment.taken)
  if (assignment.isOrchestrator) return TEMPLE_SEAT

  const held = parseSeat(taken.get(assignment.agentId))
  // A worker holding the temple seat is a roster written by an older harness
  // (or by hand); it is corrected here rather than honoured.
  if (held?.kind === 'terrace') return terraceSeat(held.index)

  const used = new Set<number>()
  for (const [agentId, seat] of taken) {
    if (agentId === assignment.agentId) continue
    const place = parseSeat(seat)
    if (place?.kind === 'terrace') used.add(place.index)
  }
  let index = 1
  while (used.has(index)) index += 1
  return terraceSeat(index)
}

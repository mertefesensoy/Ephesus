import type { ToolClass } from './avatar'
import { SPEECH_ACTS, type SpeechAct } from './message'
import type { LogEntry } from './log'

/**
 * The floor's moving parts — UI-DESIGN §5.3 (carrying tokens), §5.5 (envelopes)
 * and §5.6 (particles), with §8's reduced-motion parity for all of it.
 *
 * **Everything here is reconstructible from `log.jsonl`.** That is NFR-13's
 * spirit applied to the vfx layer, and it is why this module takes log entries
 * rather than events of its own invention: an envelope's identity is the
 * message id, its colour is the speech act, its kind is what the record says
 * happened to it. A renderer that minted its own ids, parties or acts would be
 * holding state the record cannot account for — a second source of truth, which
 * ADR-0014 forbids the floor.
 *
 * **The one thing the renderer supplies is the presentation clock.**
 * `envelopeFor` reads `startedMs` from the entry's own timestamp, and
 * `envelopePose` is pure in it, so REPLAY is faithful: feed the same entries and
 * the same envelopes fly the same way. The LIVE floor re-anchors each flight to
 * the moment it observes the entry, because a flight lasts `ENVELOPE_MS` and a
 * delivery seen later than that after it was logged would arrive already
 * finished and never be seen at all. That is presentation timing, not truth —
 * every fact still comes from the record.
 *
 * *(Corrected at M6.10 on an Architect decision. This comment used to promise
 * "replay the log and the same envelopes fly at the same moments" and call a
 * renderer clock forbidden, while `FloorCanvas` re-anchored every flight. The
 * close-out audit found the contradiction; the code was right about what a live
 * floor needs and the comment was claiming more than anything did.)*
 *
 * **Nothing here decides whether an effect happens.** These functions turn a
 * fact into a shape; a fact with no log entry produces nothing at all.
 */

// ── §5.3 Carrying tokens ────────────────────────────────────────────────────

/**
 * §5.3's tokens, keyed by **tool class** — never a tool name.
 *
 * The engine's adapter classifies a tool before the event ever reaches core
 * (NFR-12), so no `Read`, no `Bash`, no Claude-ism can appear here. That is the
 * whole reason the table is keyed this way: swap the engine and the floor is
 * unchanged.
 */
export const TOKEN_KINDS = ['scroll', 'tablet', 'amphora', 'diamond', 'tally'] as const

export type TokenKind = (typeof TOKEN_KINDS)[number]

export interface CarriedToken {
  readonly kind: TokenKind
  /** §5.3 sizes the token 6–8 px, carried at hand height. */
  readonly w: number
  readonly h: number
  /** What it is, in words — §8's parity and the §9 register. */
  readonly label: string
}

/**
 * Total over `ToolClass`, which is the point: a class with no token would be a
 * citizen walking back empty-handed from work that did happen.
 *
 * Two notes on the mapping against §5.3's printed table:
 *
 * - §5.3 lists a **search** row, but SDD §6's station map — the normative list
 *   of tool classes — has no `search` class. The row is unreachable until one
 *   exists, so it is not invented here; adding a class is an SDD change, not a
 *   floor change.
 * - SDD §6 has a **meeting** class that §5.3 does not give a token. A citizen
 *   comes back from the Odeon carrying nothing, which is honest: `null` rather
 *   than art this design does not specify.
 */
export const TOKEN_FOR_TOOL_CLASS: Readonly<Record<ToolClass, CarriedToken | null>> = {
  file: { kind: 'scroll', w: 6, h: 8, label: 'a scroll' },
  shell: { kind: 'tablet', w: 8, h: 6, label: 'a wax tablet' },
  web: { kind: 'amphora', w: 6, h: 8, label: 'an amphora' },
  mcp: { kind: 'diamond', w: 6, h: 6, label: 'an integration token' },
  ledger: { kind: 'tally', w: 8, h: 6, label: 'a tally tablet' },
  meeting: null
}

/** Contract: the token a citizen carries back for a tool class, or none. */
export function tokenFor(toolClass: unknown): CarriedToken | null {
  return typeof toolClass === 'string' && toolClass in TOKEN_FOR_TOOL_CLASS
    ? TOKEN_FOR_TOOL_CLASS[toolClass as ToolClass]
    : null
}

/** §5.3: "dropped onto the desk with a 3-frame fade on arrival". */
export const TOKEN_FADE_FRAMES = 3
export const TOKEN_FADE_MS = 120

/**
 * Contract: how opaque a dropped token is, `elapsedMs` after it landed — a
 * stepped 3-frame fade, then gone (`null`). Stepped, never a smooth ramp: §6
 * forbids tweening on the floor.
 */
export function tokenFade(elapsedMs: number): number | null {
  if (elapsedMs < 0) return 1
  const step = Math.floor(elapsedMs / TOKEN_FADE_MS)
  if (step >= TOKEN_FADE_FRAMES) return null
  return (TOKEN_FADE_FRAMES - step) / TOKEN_FADE_FRAMES
}

// ── §5.5 The envelope ───────────────────────────────────────────────────────

/** §5.5: 400 ms, stepped — the §6 duration for a panel open and a flight. */
export const ENVELOPE_MS = 400
/** §6: stepped easing, 4–6 frames. Five, matching the walk clock. */
export const ENVELOPE_STEPS = 5
/** §5.5: an 8×6 envelope. */
export const ENVELOPE_W = 8
export const ENVELOPE_H = 6
/** §5.5: "broadcast — three envelopes fanning out". */
export const BROADCAST_FAN = 3

/**
 * §5.5's act colours, as token NAMES rather than hex — the numeric values live
 * in `tokens.ts`, and invariant §12 keeps colour out of shared logic.
 */
export const ENVELOPE_COLOR: Readonly<Record<SpeechAct, string>> = {
  request: 'aegean',
  query: 'aegean',
  inform: 'olive',
  done: 'olive',
  propose: 'gold',
  agree: 'laurel',
  refuse: 'wine'
}

export const ENVELOPE_KINDS = ['deliver', 'broadcast', 'divert', 'bounce'] as const

export type EnvelopeKind = (typeof ENVELOPE_KINDS)[number]

export interface EnvelopeFlight {
  /** The message id — the flight's identity comes from the record, not the UI. */
  readonly id: string
  readonly from: string
  readonly to: string
  readonly act: SpeechAct
  readonly kind: EnvelopeKind
  /** A §2.3/§2.4 token name; the canvas resolves it. */
  readonly color: string
  /** When it left, from the log entry's own timestamp. */
  readonly startedMs: number
  /** §5.5: a refusal or bounce "wobbles on landing". */
  readonly wobble: boolean
  /** §5.5: at the hop cap the envelope turns mid-flight toward the temple. */
  readonly towardTemple: boolean
  /** How many envelopes fly — three, fanning out, for a broadcast. */
  readonly fan: number
}

const isAct = (value: unknown): value is SpeechAct =>
  typeof value === 'string' && (SPEECH_ACTS as readonly string[]).includes(value)

/**
 * Contract: the flight one log entry calls for, or null when the entry is not a
 * delivery at all.
 *
 * Reading the RECORD is the whole design. An envelope exists because a message
 * was delivered, bounced or diverted and `log.jsonl` says so; there is no other
 * way to make one fly.
 */
export function envelopeFor(entry: LogEntry): EnvelopeFlight | null {
  const kind = entry.kind
  if (kind !== 'delivery' && kind !== 'bounce') return null
  const record = entry as unknown as Record<string, unknown>
  const id = typeof record['msgId'] === 'string' ? record['msgId'] : null
  const from = typeof record['from'] === 'string' ? record['from'] : null
  const to = typeof record['to'] === 'string' ? record['to'] : null
  if (!id || !from || !to) return null
  const act = isAct(record['act']) ? record['act'] : 'inform'

  const diverted = typeof record['reason'] === 'string' && record['reason'].includes('hop cap')
  const flightKind: EnvelopeKind =
    kind === 'bounce'
      ? diverted
        ? 'divert'
        : 'bounce'
      : to === 'broadcast'
        ? 'broadcast'
        : 'deliver'

  return {
    id,
    from,
    to,
    act,
    kind: flightKind,
    // A bounce is `wine` whatever act it carried — §5.5 gives refusal and bounce
    // the same colour, because to the reader they are the same event.
    color: flightKind === 'bounce' ? ENVELOPE_COLOR.refuse : (ENVELOPE_COLOR[act] ?? 'aegean'),
    startedMs: typeof entry.ts === 'number' ? entry.ts : Date.parse(String(entry.ts)),
    wobble: flightKind === 'bounce' || act === 'refuse',
    towardTemple: flightKind === 'divert',
    fan: flightKind === 'broadcast' ? BROADCAST_FAN : 1
  }
}

export interface Point {
  readonly x: number
  readonly y: number
}

export interface EnvelopePose {
  readonly x: number
  readonly y: number
  /** Stepped frame index along the flight. */
  readonly step: number
  readonly done: boolean
}

/**
 * Contract: where an envelope is, `elapsedMs` into its 400 ms flight.
 *
 * Stepped, and an arc rather than a straight line — the arc is what separates a
 * letter in flight from a sprite sliding. A diverted envelope turns toward
 * `temple` at the halfway step, which is §5.5's "turns mid-flight toward the
 * temple" made literal rather than decorative.
 */
export function envelopePose(
  flight: EnvelopeFlight,
  from: Point,
  to: Point,
  temple: Point,
  elapsedMs: number
): EnvelopePose {
  const clamped = Math.min(Math.max(elapsedMs, 0), ENVELOPE_MS)
  const step = Math.min(Math.floor((clamped / ENVELOPE_MS) * ENVELOPE_STEPS), ENVELOPE_STEPS)
  const progress = step / ENVELOPE_STEPS
  const half = ENVELOPE_STEPS / 2
  // Past the halfway step a diverted envelope is heading somewhere else.
  const target = flight.towardTemple && step > half ? temple : to
  const start = flight.towardTemple && step > half ? midpoint(from, to) : from
  const local = flight.towardTemple && step > half ? (progress - 0.5) * 2 : progress
  const x = start.x + (target.x - start.x) * local
  const y = start.y + (target.y - start.y) * local
  // A stepped parabola: up over the middle of the flight, back down at the end.
  const lift = Math.round(6 * Math.sin(Math.PI * local) * ENVELOPE_STEPS) / ENVELOPE_STEPS
  return { x: Math.round(x), y: Math.round(y - lift), step, done: clamped >= ENVELOPE_MS }
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/** Contract: the fan offsets for a broadcast — three envelopes, spread. */
export function fanOffsets(flight: EnvelopeFlight): readonly number[] {
  return flight.fan === 1 ? [0] : [-8, 0, 8].slice(0, flight.fan)
}

// ── §5.6 Particles ──────────────────────────────────────────────────────────

/**
 * §5.6: "Each tied to a logged event; ≤ 2 systems live per citizen." And then,
 * unusually explicitly: *"Nothing else. No weather, no fireflies, no screen
 * shake."* So the list is closed, and a test asserts there is no fourth.
 */
export const PARTICLE_SYSTEMS = ['sparkle', 'dust', 'tray-pulse'] as const

export type ParticleSystem = (typeof PARTICLE_SYSTEMS)[number]

export interface ParticleSpec {
  readonly system: ParticleSystem
  /** How many pixels the system emits. */
  readonly count: number
  /** Total lifetime in ms; a repeating system uses this as its period. */
  readonly durationMs: number
  /** True for a system that repeats while its fact holds, rather than firing once. */
  readonly repeats: boolean
  /** The logged event this is tied to — §5.6's own requirement. */
  readonly firedBy: string
}

export const PARTICLES: Readonly<Record<ParticleSystem, ParticleSpec>> = {
  // "Sparkle — tool/task success: 4 pixel stars from the desk, 250 ms."
  sparkle: {
    system: 'sparkle',
    count: 4,
    durationMs: 250,
    repeats: false,
    firedBy: 'a tool or task finishing'
  },
  // "Dust — station arrival: 3 arcing dots, 300 ms."
  dust: {
    system: 'dust',
    count: 3,
    durationMs: 300,
    repeats: false,
    firedBy: 'arriving at a station'
  },
  // "Tray pulse — unread mail: the tray flag scales +1 px, one frame, every
  // 800 ms while mail waits." It repeats while the FACT holds, which is why it
  // cannot outlive the mail: the flag it rides is `pendingMailCount`.
  'tray-pulse': {
    system: 'tray-pulse',
    count: 1,
    durationMs: 800,
    repeats: true,
    firedBy: 'mail waiting in the inbox tray'
  }
}

/** §5.6: at most two particle systems live on one citizen at a time. */
export const MAX_PARTICLES_PER_CITIZEN = 2

/**
 * Contract: the systems that may run on one citizen, capped at two. Ordered by
 * the §5.6 list so the cap drops the same one every time rather than whichever
 * happened to be added last.
 */
export function budgetParticles(wanted: Iterable<ParticleSystem>): readonly ParticleSystem[] {
  const asked = new Set(wanted)
  return PARTICLE_SYSTEMS.filter((system) => asked.has(system)).slice(0, MAX_PARTICLES_PER_CITIZEN)
}

// ── §8 Reduced motion ───────────────────────────────────────────────────────

/**
 * What a moving thing MEANS, separately from how it moves.
 *
 * §8 requires that with reduced motion "information parity is a test case, not
 * a hope". Parity is only checkable if the information exists as a value rather
 * than as an animation — so every effect produces one of these, and the reduced
 * form produces the identical one. The test then asserts equality instead of
 * asserting that somebody remembered to add a label.
 */
export interface VfxInfo {
  /** One line in the §9 register — short, calm, names the agents. */
  readonly text: string
  /** Where the information is available on the floor. */
  readonly at: readonly string[]
}

/** Contract: what an envelope tells the reader, motion or not. */
export function envelopeInfo(flight: EnvelopeFlight): VfxInfo {
  const verb =
    flight.kind === 'bounce'
      ? 'could not reach'
      : flight.kind === 'divert'
        ? 'was diverted from'
        : 'sent'
  return {
    text: `${flight.from} ${verb} ${flight.to}: ${flight.act}`,
    at: [flight.from, flight.to]
  }
}

/** §8: "envelopes become list flashes" — one frame on both trays. */
export interface TrayFlash {
  readonly at: readonly string[]
  readonly color: string
  readonly info: VfxInfo
}

/**
 * Contract: the reduced-motion form of a flight. The flight is not shortened or
 * sped up — it does not happen at all; both trays flash once, and the SAME
 * information is attached. Parity, not decoration parity (§5.5).
 */
export function reduceEnvelope(flight: EnvelopeFlight): TrayFlash {
  return { at: [flight.from, flight.to], color: flight.color, info: envelopeInfo(flight) }
}

/** Contract: what a walk tells the reader — who went where, and why. */
export function walkInfo(agentId: string, station: string): VfxInfo {
  return { text: `${agentId} is at the ${station}`, at: [agentId, station] }
}

/**
 * Contract: the reduced-motion form of a walk — §8's "walks become teleports +
 * labels". The destination and the information are unchanged; only the
 * interpolation is dropped, so `progress` is 1 from the first frame.
 */
export function reduceWalk(
  agentId: string,
  station: string
): { readonly progress: 1; readonly info: VfxInfo } {
  return { progress: 1, info: walkInfo(agentId, station) }
}

/**
 * Contract: whether a particle system runs under reduced motion.
 *
 * None of them do: every one is decoration over a fact that is already carried
 * by a badge, a tray flag or a log line, so suppressing them costs no
 * information — which is exactly the test §8 asks for.
 */
export function particlesUnderReducedMotion(): readonly ParticleSystem[] {
  return []
}

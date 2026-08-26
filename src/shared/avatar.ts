/**
 * The avatar state machine — SDD §6, transcribed.
 *
 * This is a pure reducer on purpose (ADR-0002, two data planes): the floor is a
 * *projection* of the event plane, never a source of truth. If the events stop,
 * the avatars stop; the renderer has no way to invent motion because it has no
 * state of its own to invent it from.
 *
 * Nothing here knows what engine produced an event. Tool *classes* arrive
 * already classified by the engine's adapter (NFR-12), so no Claude-ism — no
 * `Read`, no `Bash` — appears in this file or on the floor.
 */

/** The ten avatar states of SDD §6. */
export const AVATAR_STATES = [
  'idle',
  'alert',
  'thinking',
  'working',
  'waiting',
  'blocked',
  'success',
  'ghost',
  'compacting',
  'looping'
] as const

export type AvatarState = (typeof AVATAR_STATES)[number]

/**
 * The two terminal outcomes the §6 diagram names but does not list as states
 * (`rung 3 ──► stopped`, `ghost ──30s──► archived`). They are not poses: an
 * avatar in either has left the floor.
 */
export const AVATAR_TERMINALS = ['stopped', 'archived'] as const

export type AvatarTerminal = (typeof AVATAR_TERMINALS)[number]

export type AvatarPhase = AvatarState | AvatarTerminal

/** Floor stations (UI-DESIGN §5). */
export const STATIONS = [
  'desk',
  'shelf',
  'terminal-bench',
  'portal',
  'harbor-kiosk',
  'agora-board',
  'odeon',
  'watch-post',
  'temple-seat'
] as const

export type Station = (typeof STATIONS)[number]

/** Tool classes the SDD §6 station map is keyed by. */
export const TOOL_CLASSES = ['file', 'shell', 'web', 'mcp', 'ledger', 'meeting'] as const

export type ToolClass = (typeof TOOL_CLASSES)[number]

/** SDD §6 station map, verbatim: tool class → floor station. */
export const STATION_FOR_TOOL_CLASS: Readonly<Record<ToolClass, Station>> = {
  file: 'shelf',
  shell: 'terminal-bench',
  web: 'portal',
  mcp: 'harbor-kiosk',
  ledger: 'agora-board',
  meeting: 'odeon'
}

/**
 * Contract: maps a class to its station; anything unrecognised maps to `desk`.
 * An unclassified tool is a degradation, not a crash — the avatar works at its
 * desk instead of walking somewhere invented, which is the honest rendering of
 * "a tool ran and we could not tell which kind" (FR-2.3 in the visual domain).
 */
export function stationForToolClass(toolClass: unknown): Station {
  return typeof toolClass === 'string' && toolClass in STATION_FOR_TOOL_CLASS
    ? STATION_FOR_TOOL_CLASS[toolClass as ToolClass]
    : 'desk'
}

/** UI-DESIGN §6: success flashes for 250 ms before returning to idle. */
export const SUCCESS_IDLE_MS = 250
/** SDD §6: a ghost is archived after a 30 s grace period (FR-1.4). */
export const GHOST_ARCHIVE_MS = 30_000

/**
 * Inputs to the machine. Everything except `arrive` and `tick` comes off the
 * event plane; `arrive` is the floor reporting that a walk finished (the §6
 * `thinking(→station) ──arrive──► working` edge), and `tick` advances the two
 * documented timers.
 */
export type AvatarEvent =
  | { readonly kind: 'prompt-submitted' }
  | { readonly kind: 'pre-tool'; readonly toolClass?: unknown }
  | { readonly kind: 'arrive' }
  | { readonly kind: 'post-tool' }
  /** `pending` = mail or task waiting, the ADR-0013 autonomy-loop branch. */
  | { readonly kind: 'stop'; readonly pending: boolean }
  | { readonly kind: 'compact-start' }
  | { readonly kind: 'compact-end' }
  | { readonly kind: 'gate-opened' }
  | { readonly kind: 'gate-verdict' }
  | { readonly kind: 'waiting-on'; readonly who: string }
  | { readonly kind: 'breaker'; readonly rung: 1 | 2 | 3 }
  | { readonly kind: 'breaker-recover' }
  | { readonly kind: 'process-exit' }
  | { readonly kind: 'tick' }

export interface AvatarSnapshot {
  readonly phase: AvatarPhase
  /** Where the avatar is, or is heading when `walking`. */
  readonly station: Station
  /**
   * Where the current walk started. With `station` and `sinceMs` this is the
   * whole walk: the renderer interpolates between the two and invents nothing.
   */
  readonly origin: Station
  /** True while en route — the §6 `thinking(→station)` leg. */
  readonly walking: boolean
  /**
   * The phase to come back to after an interruption that the SDD returns to
   * "prior state": a gate verdict, compaction finishing, breaker recovery.
   */
  readonly resume: AvatarPhase | null
  /** Who the agent is waiting on, when `phase === 'waiting'`. */
  readonly waitingOn: string | null
  /** Timestamp (ms) the current phase began — the two timers read from here. */
  readonly sinceMs: number
}

export function initialAvatar(nowMs: number): AvatarSnapshot {
  return {
    phase: 'idle',
    station: 'desk',
    origin: 'desk',
    walking: false,
    resume: null,
    waitingOn: null,
    sinceMs: nowMs
  }
}

/** Phases from which an interruption should remember where to come back to. */
function resumableFrom(snapshot: AvatarSnapshot): AvatarPhase {
  // Never stack interruptions: coming back from a gate while compacting should
  // return to what was happening before the compaction, not to `compacting`.
  return snapshot.resume ?? snapshot.phase
}

function enter(
  snapshot: AvatarSnapshot,
  phase: AvatarPhase,
  nowMs: number,
  patch: Partial<AvatarSnapshot> = {}
): AvatarSnapshot {
  return { ...snapshot, phase, sinceMs: nowMs, ...patch }
}

/**
 * Contract: pure. Applies one event and returns the next snapshot, or the
 * *same object* when the event has no transition from this phase — an edge the
 * SDD does not have is inert, never improvised, so `next === prev` is how a
 * caller detects an ignored event.
 *
 * Terminal phases (`stopped`, `archived`) absorb everything: the avatar is off
 * the floor and nothing brings it back except a fresh spawn.
 */
export function reduceAvatar(
  snapshot: AvatarSnapshot,
  event: AvatarEvent,
  nowMs: number
): AvatarSnapshot {
  if (snapshot.phase === 'stopped' || snapshot.phase === 'archived') return snapshot

  switch (event.kind) {
    // ── `any ──process-exit──► ghost ──30s──► archived`
    case 'process-exit':
      return snapshot.phase === 'ghost'
        ? snapshot
        : enter(snapshot, 'ghost', nowMs, { walking: false, resume: null, waitingOn: null })

    // ── `any ──gate-opened──► blocked (wave at Watch post) ──verdict──► prior state`
    case 'gate-opened':
      return snapshot.phase === 'blocked'
        ? snapshot
        : enter(snapshot, 'blocked', nowMs, {
            origin: snapshot.station,
            station: 'watch-post',
            walking: true,
            resume: resumableFrom(snapshot)
          })

    case 'gate-verdict':
      if (snapshot.phase !== 'blocked') return snapshot
      return enter(snapshot, snapshot.resume ?? 'idle', nowMs, {
        origin: 'desk',
        station: 'desk',
        walking: false,
        resume: null
      })

    // ── `any ──waiting-on(agent|artemis)──► waiting`
    case 'waiting-on':
      return enter(snapshot, 'waiting', nowMs, {
        walking: false,
        waitingOn: event.who,
        resume: null
      })

    // ── `any ──breaker rung 1──► looping ──recover──► prior ──rung 3──► stopped`
    case 'breaker':
      if (event.rung === 1) {
        return snapshot.phase === 'looping'
          ? snapshot
          : enter(snapshot, 'looping', nowMs, { resume: resumableFrom(snapshot) })
      }
      if (event.rung === 3) {
        return enter(snapshot, 'stopped', nowMs, { walking: false, resume: null })
      }
      // Rung 2 (constrain) changes what the agent may do, not where it stands.
      return snapshot

    case 'breaker-recover':
      if (snapshot.phase !== 'looping') return snapshot
      return enter(snapshot, snapshot.resume ?? 'idle', nowMs, { resume: null })

    // ── `compaction events ──► compacting ──done──► prior state`
    case 'compact-start':
      return snapshot.phase === 'compacting'
        ? snapshot
        : enter(snapshot, 'compacting', nowMs, {
            walking: false,
            resume: resumableFrom(snapshot)
          })

    case 'compact-end':
      if (snapshot.phase !== 'compacting') return snapshot
      return enter(snapshot, snapshot.resume ?? 'idle', nowMs, { resume: null })

    // ── `idle ──prompt-submitted──► alert`
    case 'prompt-submitted':
      if (snapshot.phase !== 'idle') return snapshot
      return enter(snapshot, 'alert', nowMs, { origin: 'desk', station: 'desk', walking: false })

    // ── `alert ──pre-tool──► thinking(→station)`, and the `working ──post-tool──►
    //    thinking(→next station)` continuation.
    case 'pre-tool': {
      if (snapshot.phase !== 'alert' && snapshot.phase !== 'thinking') return snapshot
      const station = stationForToolClass(event.toolClass)
      return enter(snapshot, 'thinking', nowMs, {
        origin: snapshot.station,
        station,
        // Already there? Then there is nothing to walk, and `arrive` is implicit.
        walking: station !== snapshot.station || snapshot.walking
      })
    }

    // ── `thinking(→station) ──arrive──► working`
    case 'arrive': {
      if (snapshot.phase !== 'thinking' && snapshot.phase !== 'blocked') return snapshot
      if (snapshot.phase === 'blocked') return { ...snapshot, walking: false }
      // At a work station the agent is `working`; back at its own desk it is
      // still thinking — §2.4 defines `working` as "at a station, tool in use",
      // and a desk is not a station a tool runs at.
      return snapshot.station === 'desk'
        ? { ...snapshot, walking: false, origin: snapshot.station }
        : enter(snapshot, 'working', nowMs, { walking: false, origin: snapshot.station })
    }

    // ── `working ──post-tool──► thinking(→desk|→next station)`
    case 'post-tool': {
      if (snapshot.phase !== 'working' && snapshot.phase !== 'thinking') return snapshot
      return enter(snapshot, 'thinking', nowMs, {
        origin: snapshot.station,
        station: 'desk',
        walking: snapshot.station !== 'desk'
      })
    }

    // ── `working|thinking ──stop(no pending)──► success`
    // ── `stop(pending mail/task) ──block──► alert`  (ADR-0013 autonomy loop)
    case 'stop': {
      if (snapshot.phase !== 'working' && snapshot.phase !== 'thinking') return snapshot
      return event.pending
        ? enter(snapshot, 'alert', nowMs, { origin: 'desk', station: 'desk', walking: false })
        : enter(snapshot, 'success', nowMs, { origin: 'desk', station: 'desk', walking: false })
    }

    // ── the two documented timers: `success ──250ms──► idle`, `ghost ──30s──► archived`
    case 'tick': {
      if (snapshot.phase === 'success' && nowMs - snapshot.sinceMs >= SUCCESS_IDLE_MS) {
        return enter(snapshot, 'idle', nowMs, { origin: 'desk', station: 'desk', walking: false })
      }
      if (snapshot.phase === 'ghost' && nowMs - snapshot.sinceMs >= GHOST_ARCHIVE_MS) {
        return enter(snapshot, 'archived', nowMs, { walking: false })
      }
      return snapshot
    }
  }
}

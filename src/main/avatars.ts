import {
  initialAvatar,
  reduceAvatar,
  type AvatarEvent,
  type AvatarSnapshot
} from '../shared/avatar'
import { walkDurationMs } from '../shared/floor'
import type { HookEventRecord } from './hooks'

/**
 * The event plane's consumer (ADR-0002): hook envelopes in, avatar snapshots
 * out. Main owns the machine — including the walk clock — so the renderer stays
 * a projection that interpolates between snapshots and cannot invent motion of
 * its own (ENGINEERING-STANDARDS §4).
 *
 * Nothing here reads an engine's vocabulary: hook events arrive already
 * normalized (`pre-tool`, not `PreToolUse`) and tool classes already classified
 * by the adapter, so the SDD §6 machine never learns a Claude-ism (NFR-12).
 */

/** Cadence for the two SDD §6 timers and the walk clock. */
export const AVATAR_TICK_MS = 50

export interface AvatarDirectorOptions {
  /** Called whenever an agent's snapshot actually changes. */
  onChange(agentId: string, snapshot: AvatarSnapshot): void
  /** Injected in tests; defaults to the wall clock. */
  now?: () => number
}

/**
 * Contract: maps one normalized hook event onto an avatar event, or null when
 * the hook has no §6 transition. `session-start`/`session-end` deliberately map
 * to nothing — the process bracket is the PTY's business (`process-exit`), and
 * inventing a transition for them would be exactly the improvisation the SDD
 * forbids.
 */
export function avatarEventForHook(record: HookEventRecord): AvatarEvent | null {
  const payload =
    typeof record.envelope.payload === 'object' && record.envelope.payload !== null
      ? (record.envelope.payload as Record<string, unknown>)
      : {}

  switch (record.envelope.event) {
    case 'prompt-submitted':
      return { kind: 'prompt-submitted' }
    case 'pre-tool':
      return { kind: 'pre-tool', toolClass: payload['toolClass'] }
    case 'post-tool':
      return { kind: 'post-tool' }
    case 'stop':
      // `pending` is Hermes's answer — is mail or a task waiting (ADR-0013)?
      // Hermes lands in M2; until it does, nothing is ever pending, which is
      // the truth about this system today rather than a placeholder.
      return { kind: 'stop', pending: false }
    case 'compact-start':
      return { kind: 'compact-start' }
    case 'compact-end':
      return { kind: 'compact-end' }
    default:
      return null
  }
}

export class AvatarDirector {
  private readonly avatars = new Map<string, AvatarSnapshot>()
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly now: () => number

  constructor(private readonly options: AvatarDirectorOptions) {
    this.now = options.now ?? ((): number => Date.now())
  }

  /** Puts an agent on the floor at its desk, idle. */
  add(agentId: string): AvatarSnapshot {
    const snapshot = initialAvatar(this.now())
    this.avatars.set(agentId, snapshot)
    this.options.onChange(agentId, snapshot)
    return snapshot
  }

  remove(agentId: string): void {
    this.avatars.delete(agentId)
  }

  get(agentId: string): AvatarSnapshot | null {
    return this.avatars.get(agentId) ?? null
  }

  list(): ReadonlyMap<string, AvatarSnapshot> {
    return this.avatars
  }

  /** Feeds one accepted hook post to that agent's machine. */
  handleHook(record: HookEventRecord): void {
    const event = avatarEventForHook(record)
    if (!event) return
    this.apply(record.envelope.agentId, event)
  }

  /** The PTY reporting an agent's process is gone (SDD §6 `process-exit`). */
  handleExit(agentId: string): void {
    this.apply(agentId, { kind: 'process-exit' })
  }

  /** Applies any avatar event by id; the entry point for gates and the breaker. */
  apply(agentId: string, event: AvatarEvent): void {
    const before = this.avatars.get(agentId)
    if (!before) return
    const after = reduceAvatar(before, event, this.now())
    if (after === before) return
    this.avatars.set(agentId, after)
    this.options.onChange(agentId, after)
  }

  /**
   * Advances the two documented timers and the walk clock. `arrive` is emitted
   * here, from the walk duration the shared floor geometry defines — so the
   * moment an avatar reaches a station is a fact both planes agree on rather
   * than something the renderer decides on its own.
   */
  tick(): void {
    const now = this.now()
    for (const [agentId, before] of [...this.avatars]) {
      let snapshot = before
      if (snapshot.walking) {
        const walkMs = walkDurationMs(snapshot.origin, snapshot.station)
        if (now - snapshot.sinceMs >= walkMs) {
          snapshot = reduceAvatar(snapshot, { kind: 'arrive' }, now)
        }
      }
      snapshot = reduceAvatar(snapshot, { kind: 'tick' }, now)
      if (snapshot !== before) {
        this.avatars.set(agentId, snapshot)
        this.options.onChange(agentId, snapshot)
      }
    }
  }

  /** Starts the tick loop. Idempotent. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), AVATAR_TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }
}

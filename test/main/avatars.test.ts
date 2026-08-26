import { describe, expect, it } from 'vitest'
import { GHOST_ARCHIVE_MS, SUCCESS_IDLE_MS, type AvatarSnapshot } from '../../src/shared/avatar'
import { MS_PER_TILE, STATION_TILES, tileDistance, walkDurationMs } from '../../src/shared/floor'
import { AvatarDirector, avatarEventForHook } from '../../src/main/avatars'
import { HOOK_ENVELOPE_SCHEMA_VERSION } from '../../src/shared/hooks'
import type { HookEventRecord } from '../../src/main/hooks'

/**
 * The event plane → floor seam. What matters here is that main owns the clock:
 * `arrive` is emitted from the shared walk geometry, not by the renderer, so
 * both planes agree on when an avatar reached a station.
 */

function record(event: string, payload: unknown = {}): HookEventRecord {
  return {
    envelope: {
      schemaVersion: HOOK_ENVELOPE_SCHEMA_VERSION,
      token: 'spawn-token-1',
      agentId: 'agent.mason',
      event,
      sessionId: 'sess-1',
      ts: 0,
      payload
    },
    known: true,
    warning: null,
    receivedAt: 0
  }
}

interface Rig {
  readonly director: AvatarDirector
  readonly changes: AvatarSnapshot[]
  advance(ms: number): void
  snapshot(): AvatarSnapshot
}

function rig(): Rig {
  let now = 1_000_000
  const changes: AvatarSnapshot[] = []
  const director = new AvatarDirector({
    onChange: (_agentId, snapshot) => changes.push(snapshot),
    now: () => now
  })
  director.add('agent.mason')
  return {
    director,
    changes,
    advance(ms) {
      now += ms
      director.tick()
    },
    snapshot() {
      const snapshot = director.get('agent.mason')
      if (!snapshot) throw new Error('avatar missing')
      return snapshot
    }
  }
}

describe('hook event → avatar event mapping', () => {
  it.each([
    ['prompt-submitted', 'prompt-submitted'],
    ['pre-tool', 'pre-tool'],
    ['post-tool', 'post-tool'],
    ['stop', 'stop'],
    ['compact-start', 'compact-start'],
    ['compact-end', 'compact-end']
  ])('maps %s to the %s avatar event', (hook, kind) => {
    expect(avatarEventForHook(record(hook))?.kind).toBe(kind)
  })

  it('carries the adapter-supplied tool class through', () => {
    const event = avatarEventForHook(record('pre-tool', { tool: 'Edit', toolClass: 'file' }))
    expect(event).toEqual({ kind: 'pre-tool', toolClass: 'file' })
  })

  it('maps the session bracket to nothing — the PTY owns the process bracket', () => {
    expect(avatarEventForHook(record('session-start'))).toBeNull()
    expect(avatarEventForHook(record('session-end'))).toBeNull()
  })

  it('maps a drifted event name to nothing rather than guessing', () => {
    expect(avatarEventForHook(record('SubagentStop'))).toBeNull()
  })

  it('survives a payload that is not an object', () => {
    expect(avatarEventForHook(record('pre-tool', 'nonsense'))).toEqual({
      kind: 'pre-tool',
      toolClass: undefined
    })
  })
})

describe('AvatarDirector — main owns the walk clock', () => {
  it('puts a new agent at its desk, idle', () => {
    const r = rig()
    expect(r.snapshot()).toMatchObject({ phase: 'idle', station: 'desk', walking: false })
  })

  it('walks to the shelf and arrives after exactly the geometry duration', () => {
    const r = rig()
    r.director.handleHook(record('prompt-submitted'))
    r.director.handleHook(record('pre-tool', { toolClass: 'file' }))

    const walking = r.snapshot()
    expect(walking).toMatchObject({ phase: 'thinking', station: 'shelf', walking: true })

    const duration = walkDurationMs('desk', 'shelf')
    expect(duration).toBe(tileDistance('desk', 'shelf') * MS_PER_TILE)

    r.advance(duration - MS_PER_TILE)
    expect(r.snapshot().phase).toBe('thinking')
    expect(r.snapshot().walking).toBe(true)

    r.advance(MS_PER_TILE)
    expect(r.snapshot()).toMatchObject({ phase: 'working', station: 'shelf', walking: false })
  })

  it('runs the success → idle timer', () => {
    const r = rig()
    r.director.handleHook(record('prompt-submitted'))
    r.director.handleHook(record('pre-tool', { toolClass: 'shell' }))
    r.advance(walkDurationMs('desk', 'terminal-bench'))
    r.director.handleHook(record('stop'))
    expect(r.snapshot().phase).toBe('success')

    r.advance(SUCCESS_IDLE_MS)
    expect(r.snapshot().phase).toBe('idle')
  })

  it('ghosts on process exit and archives after the grace period', () => {
    const r = rig()
    r.director.handleExit('agent.mason')
    expect(r.snapshot().phase).toBe('ghost')

    r.advance(GHOST_ARCHIVE_MS)
    expect(r.snapshot().phase).toBe('archived')
  })

  it('ignores events for an agent that is not on the floor', () => {
    const r = rig()
    const before = r.changes.length
    r.director.handleHook({
      ...record('prompt-submitted'),
      envelope: { ...record('prompt-submitted').envelope, agentId: 'agent.ghost' }
    })
    expect(r.changes).toHaveLength(before)
  })

  it('emits a change only when the snapshot actually changes', () => {
    const r = rig()
    const before = r.changes.length
    r.advance(10)
    r.advance(10)
    expect(r.changes).toHaveLength(before)
  })

  it('forgets an agent that is removed', () => {
    const r = rig()
    r.director.remove('agent.mason')
    expect(r.director.get('agent.mason')).toBeNull()
    expect(r.director.list().size).toBe(0)
  })
})

describe('floor geometry (UI-DESIGN §5)', () => {
  it('places every station on the grid', () => {
    for (const tile of Object.values(STATION_TILES)) {
      expect(tile.col).toBeGreaterThanOrEqual(0)
      expect(tile.row).toBeGreaterThanOrEqual(0)
    }
  })

  it('charges 250 ms per tile, both directions alike', () => {
    expect(walkDurationMs('desk', 'shelf')).toBe(walkDurationMs('shelf', 'desk'))
    expect(walkDurationMs('desk', 'desk')).toBe(0)
    expect(walkDurationMs('shelf', 'portal') % MS_PER_TILE).toBe(0)
  })
})

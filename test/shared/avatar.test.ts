import { describe, expect, it } from 'vitest'
import {
  AVATAR_STATES,
  GHOST_ARCHIVE_MS,
  STATIONS,
  STATION_FOR_TOOL_CLASS,
  SUCCESS_IDLE_MS,
  TOOL_CLASSES,
  initialAvatar,
  reduceAvatar,
  stationForToolClass,
  type AvatarEvent,
  type AvatarPhase,
  type AvatarSnapshot
} from '../../src/shared/avatar'

/**
 * Table-driven coverage of SDD §6. Two things are asserted throughout: every
 * documented edge exists, and every edge the SDD does NOT document is inert —
 * the reducer returns its input unchanged rather than improvising a transition.
 */

const T0 = 1_000_000

/** Drives the machine through a script of events, returning the final snapshot. */
function run(events: readonly (AvatarEvent | number)[], from = initialAvatar(T0)): AvatarSnapshot {
  let snapshot = from
  let now = T0
  for (const step of events) {
    if (typeof step === 'number') {
      now += step
      snapshot = reduceAvatar(snapshot, { kind: 'tick' }, now)
    } else {
      snapshot = reduceAvatar(snapshot, step, now)
    }
  }
  return snapshot
}

/** Puts the machine into a given phase using only documented transitions. */
function inPhase(phase: AvatarPhase): AvatarSnapshot {
  switch (phase) {
    case 'idle':
      return initialAvatar(T0)
    case 'alert':
      return run([{ kind: 'prompt-submitted' }])
    case 'thinking':
      return run([{ kind: 'prompt-submitted' }, { kind: 'pre-tool', toolClass: 'file' }])
    case 'working':
      return run([
        { kind: 'prompt-submitted' },
        { kind: 'pre-tool', toolClass: 'file' },
        { kind: 'arrive' }
      ])
    case 'success':
      return run([
        { kind: 'prompt-submitted' },
        { kind: 'pre-tool', toolClass: 'file' },
        { kind: 'arrive' },
        { kind: 'stop', pending: false }
      ])
    case 'waiting':
      return run([{ kind: 'waiting-on', who: 'agent.artemis' }])
    case 'blocked':
      return run([{ kind: 'gate-opened' }])
    case 'compacting':
      return run([{ kind: 'compact-start' }])
    case 'looping':
      return run([{ kind: 'breaker', rung: 1 }])
    case 'ghost':
      return run([{ kind: 'process-exit' }])
    case 'stopped':
      return run([{ kind: 'breaker', rung: 3 }])
    case 'archived':
      return run([{ kind: 'process-exit' }, GHOST_ARCHIVE_MS])
  }
}

describe('station map (SDD §6)', () => {
  it('maps every documented tool class to its station', () => {
    expect(STATION_FOR_TOOL_CLASS).toEqual({
      file: 'shelf',
      shell: 'terminal-bench',
      web: 'portal',
      mcp: 'harbor-kiosk',
      ledger: 'agora-board',
      meeting: 'odeon'
    })
  })

  it.each(TOOL_CLASSES)('routes %s through the shared helper', (cls) => {
    expect(stationForToolClass(cls)).toBe(STATION_FOR_TOOL_CLASS[cls])
  })

  it('sends an unclassified tool to the desk rather than an invented station', () => {
    for (const raw of [undefined, null, '', 'BrandNewTool', 42, {}]) {
      expect(stationForToolClass(raw)).toBe('desk')
    }
  })

  it('names every station in UI-DESIGN §5', () => {
    expect([...STATIONS]).toEqual([
      'desk',
      'shelf',
      'terminal-bench',
      'portal',
      'harbor-kiosk',
      'agora-board',
      'odeon',
      'watch-post',
      'temple-seat'
    ])
  })

  it('names exactly the ten SDD §6 states', () => {
    expect([...AVATAR_STATES]).toEqual([
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
    ])
  })
})

describe('the documented happy path', () => {
  it('walks idle → alert → thinking(→shelf) → working → thinking(→desk) → success → idle', () => {
    let s = initialAvatar(T0)
    let now = T0

    s = reduceAvatar(s, { kind: 'prompt-submitted' }, now)
    expect(s.phase).toBe('alert')

    s = reduceAvatar(s, { kind: 'pre-tool', toolClass: 'file' }, now)
    expect(s.phase).toBe('thinking')
    expect(s.station).toBe('shelf')
    expect(s.walking).toBe(true)

    s = reduceAvatar(s, { kind: 'arrive' }, now)
    expect(s.phase).toBe('working')
    expect(s.walking).toBe(false)

    s = reduceAvatar(s, { kind: 'post-tool' }, now)
    expect(s.phase).toBe('thinking')
    expect(s.station).toBe('desk')
    expect(s.walking).toBe(true)

    s = reduceAvatar(s, { kind: 'stop', pending: false }, now)
    expect(s.phase).toBe('success')

    now += SUCCESS_IDLE_MS - 1
    expect(reduceAvatar(s, { kind: 'tick' }, now).phase).toBe('success')
    now += 1
    expect(reduceAvatar(s, { kind: 'tick' }, now).phase).toBe('idle')
  })

  it('chains a second tool straight from thinking to the next station', () => {
    const s = run([
      { kind: 'prompt-submitted' },
      { kind: 'pre-tool', toolClass: 'file' },
      { kind: 'arrive' },
      { kind: 'post-tool' },
      { kind: 'pre-tool', toolClass: 'shell' }
    ])
    expect(s.phase).toBe('thinking')
    expect(s.station).toBe('terminal-bench')
  })

  it('stays at the desk on arrive — a desk is not a station a tool runs at', () => {
    // §2.4 defines `working` as "at a station, tool in use"; arriving back at
    // one's own desk is still thinking.
    const s = run([
      { kind: 'prompt-submitted' },
      { kind: 'pre-tool', toolClass: 'file' },
      { kind: 'arrive' },
      { kind: 'post-tool' },
      { kind: 'arrive' }
    ])
    expect(s.phase).toBe('thinking')
    expect(s.station).toBe('desk')
    expect(s.walking).toBe(false)
  })

  it('does not walk when the next tool uses the station it is already at', () => {
    const s = run([
      { kind: 'prompt-submitted' },
      { kind: 'pre-tool', toolClass: 'file' },
      { kind: 'arrive' },
      { kind: 'pre-tool', toolClass: 'file' }
    ])
    expect(s.station).toBe('shelf')
    expect(s.walking).toBe(false)
  })
})

describe('the autonomy-loop branch (ADR-0013)', () => {
  it('returns to alert instead of success when mail or a task is pending', () => {
    const s = run([
      { kind: 'prompt-submitted' },
      { kind: 'pre-tool', toolClass: 'shell' },
      { kind: 'arrive' },
      { kind: 'stop', pending: true }
    ])
    expect(s.phase).toBe('alert')
  })

  it('flashes success and returns to idle when nothing is pending', () => {
    const s = run([
      { kind: 'prompt-submitted' },
      { kind: 'pre-tool', toolClass: 'shell' },
      { kind: 'arrive' },
      { kind: 'stop', pending: false },
      SUCCESS_IDLE_MS
    ])
    expect(s.phase).toBe('idle')
  })
})

describe('interruptions return to the prior state', () => {
  const interruptible: readonly AvatarPhase[] = ['idle', 'alert', 'thinking', 'working', 'waiting']

  it.each(interruptible)('a gate blocks %s and the verdict restores it', (phase) => {
    const before = inPhase(phase)
    const blocked = reduceAvatar(before, { kind: 'gate-opened' }, T0)

    expect(blocked.phase).toBe('blocked')
    expect(blocked.station).toBe('watch-post')
    expect(blocked.walking).toBe(true)

    expect(reduceAvatar(blocked, { kind: 'gate-verdict' }, T0).phase).toBe(phase)
  })

  it.each(interruptible)('compaction interrupts %s and finishing restores it', (phase) => {
    const before = inPhase(phase)
    const compacting = reduceAvatar(before, { kind: 'compact-start' }, T0)

    expect(compacting.phase).toBe('compacting')
    expect(reduceAvatar(compacting, { kind: 'compact-end' }, T0).phase).toBe(phase)
  })

  it.each(interruptible)('breaker rung 1 tints %s and recovery restores it', (phase) => {
    const before = inPhase(phase)
    const looping = reduceAvatar(before, { kind: 'breaker', rung: 1 }, T0)

    expect(looping.phase).toBe('looping')
    expect(reduceAvatar(looping, { kind: 'breaker-recover' }, T0).phase).toBe(phase)
  })

  it('does not stack interruptions — a gate during compaction returns past it', () => {
    const compacting = run([
      { kind: 'prompt-submitted' },
      { kind: 'pre-tool', toolClass: 'web' },
      { kind: 'arrive' },
      { kind: 'compact-start' }
    ])
    const blocked = reduceAvatar(compacting, { kind: 'gate-opened' }, T0)
    expect(reduceAvatar(blocked, { kind: 'gate-verdict' }, T0).phase).toBe('working')
  })

  it('records who an agent is waiting on', () => {
    const s = run([{ kind: 'waiting-on', who: 'agent.artemis' }])
    expect(s.phase).toBe('waiting')
    expect(s.waitingOn).toBe('agent.artemis')
  })
})

describe('the breaker ladder and process exit', () => {
  it('stops at rung 3, from anywhere', () => {
    for (const phase of ['idle', 'working', 'looping', 'blocked'] as const) {
      expect(reduceAvatar(inPhase(phase), { kind: 'breaker', rung: 3 }, T0).phase).toBe('stopped')
    }
  })

  it('leaves the pose alone at rung 2 — constrain changes what, not where', () => {
    const working = inPhase('working')
    expect(reduceAvatar(working, { kind: 'breaker', rung: 2 }, T0)).toBe(working)
  })

  it('ghosts on process exit from any live phase, and archives after 30 s', () => {
    for (const phase of ['idle', 'alert', 'thinking', 'working', 'blocked', 'looping'] as const) {
      const ghost = reduceAvatar(inPhase(phase), { kind: 'process-exit' }, T0)
      expect(ghost.phase).toBe('ghost')
      expect(reduceAvatar(ghost, { kind: 'tick' }, T0 + GHOST_ARCHIVE_MS - 1).phase).toBe('ghost')
      expect(reduceAvatar(ghost, { kind: 'tick' }, T0 + GHOST_ARCHIVE_MS).phase).toBe('archived')
    }
  })

  it('absorbs every event once terminal — nothing brings an avatar back', () => {
    const events: readonly AvatarEvent[] = [
      { kind: 'prompt-submitted' },
      { kind: 'pre-tool', toolClass: 'file' },
      { kind: 'arrive' },
      { kind: 'post-tool' },
      { kind: 'stop', pending: false },
      { kind: 'gate-opened' },
      { kind: 'gate-verdict' },
      { kind: 'compact-start' },
      { kind: 'breaker-recover' },
      { kind: 'process-exit' },
      { kind: 'tick' }
    ]
    for (const terminal of ['stopped', 'archived'] as const) {
      const before = inPhase(terminal)
      for (const event of events) {
        expect(reduceAvatar(before, event, T0 + 60_000)).toBe(before)
      }
    }
  })
})

describe('undocumented edges are inert, never improvised', () => {
  const illegal: readonly [AvatarPhase, AvatarEvent][] = [
    // §6 has `idle ──prompt-submitted──► alert`, and pre-tool only from alert.
    ['idle', { kind: 'pre-tool', toolClass: 'file' }],
    ['idle', { kind: 'post-tool' }],
    ['idle', { kind: 'stop', pending: false }],
    ['idle', { kind: 'arrive' }],
    // A prompt while already busy does not restart the machine.
    ['working', { kind: 'prompt-submitted' }],
    ['thinking', { kind: 'prompt-submitted' }],
    // "Return to prior state" edges only fire from the state they leave.
    ['idle', { kind: 'gate-verdict' }],
    ['working', { kind: 'compact-end' }],
    ['working', { kind: 'breaker-recover' }],
    // Success and ghost advance by their timers only.
    ['success', { kind: 'post-tool' }],
    ['ghost', { kind: 'prompt-submitted' }]
  ]

  it.each(illegal)('%s ignores %o', (phase, event) => {
    const before = inPhase(phase)
    expect(reduceAvatar(before, event, T0)).toBe(before)
  })

  it('never returns a phase outside the documented vocabulary', () => {
    const vocabulary = new Set<string>([...AVATAR_STATES, 'stopped', 'archived'])
    const events: readonly AvatarEvent[] = [
      { kind: 'prompt-submitted' },
      { kind: 'pre-tool', toolClass: 'mcp' },
      { kind: 'arrive' },
      { kind: 'gate-opened' },
      { kind: 'gate-verdict' },
      { kind: 'compact-start' },
      { kind: 'compact-end' },
      { kind: 'waiting-on', who: 'agent.x' },
      { kind: 'breaker', rung: 1 },
      { kind: 'breaker-recover' },
      { kind: 'post-tool' },
      { kind: 'stop', pending: true },
      { kind: 'process-exit' },
      { kind: 'tick' }
    ]
    let s = initialAvatar(T0)
    for (const event of events) {
      s = reduceAvatar(s, event, T0)
      expect(vocabulary.has(s.phase)).toBe(true)
      expect(STATIONS).toContain(s.station)
    }
  })

  it('is pure — the same input always gives the same output', () => {
    const before = inPhase('working')
    const a = reduceAvatar(before, { kind: 'post-tool' }, T0)
    const b = reduceAvatar(before, { kind: 'post-tool' }, T0)
    expect(a).toEqual(b)
    expect(before.phase).toBe('working')
  })
})

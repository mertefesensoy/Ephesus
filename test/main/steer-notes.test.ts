import { describe, expect, it } from 'vitest'
import { SteerNotes, type SteerNotesOptions } from '../../src/main/watch/steer-notes'

/**
 * GYM-002 — the rung-1 steer channel (ADR-0011, RB-001).
 *
 * The contract under test: `native` grade rides the next `post-tool` hook
 * reply, exactly once; every other grade falls back to the queue path; a
 * `session-start` clears a stale note so a fresh session is never steered by
 * a sentence aimed at its dead predecessor.
 */

function rig(grade = 'native'): {
  notes: SteerNotes
  queued: string[]
  record: string[]
} {
  const queued: string[] = []
  const record: string[] = []
  const options: SteerNotesOptions = {
    hookFidelity: () => grade,
    queueSubmit: (agentId, text) => queued.push(`${agentId}:${text}`),
    onSteer: (agentId, _text, channel) => record.push(`${agentId}:${channel}`)
  }
  return { notes: new SteerNotes(options), queued, record }
}

describe('SteerNotes — the native-grade hook channel', () => {
  it('holds the sentence and answers it on the next post-tool, as a block', () => {
    const { notes, queued } = rig()
    notes.steer('agent.mason', 'You appear to be looping.')
    expect(queued).toEqual([])
    expect(notes.pending('agent.mason')).toBe(true)

    const reply = notes.answer('agent.mason', 'post-tool')
    expect(reply).toEqual({ decision: 'block', reason: 'You appear to be looping.' })
  })

  it('delivers exactly once — the boundary after carries nothing', () => {
    const { notes } = rig()
    notes.steer('agent.mason', 'Step back and state your plan.')
    expect(notes.answer('agent.mason', 'post-tool')).not.toBeNull()
    expect(notes.answer('agent.mason', 'post-tool')).toBeNull()
    expect(notes.pending('agent.mason')).toBe(false)
  })

  it('answers only on post-tool — a block anywhere else would deny or erase', () => {
    const { notes } = rig()
    notes.steer('agent.mason', 'Corrective sentence.')
    for (const event of ['pre-tool', 'stop', 'prompt-submitted', 'notification']) {
      expect(notes.answer('agent.mason', event)).toBeNull()
    }
    // The note survived all of them for its real boundary.
    expect(notes.answer('agent.mason', 'post-tool')).not.toBeNull()
  })

  it('latest wins — a second trip must not queue behind a stale sentence', () => {
    const { notes } = rig()
    notes.steer('agent.mason', 'first')
    notes.steer('agent.mason', 'second')
    expect(notes.answer('agent.mason', 'post-tool')).toEqual({
      decision: 'block',
      reason: 'second'
    })
    expect(notes.answer('agent.mason', 'post-tool')).toBeNull()
  })

  it('session-start clears a stale note — a successor session is never steered', () => {
    const { notes } = rig()
    notes.steer('agent.mason', 'aimed at the dead session')
    expect(notes.answer('agent.mason', 'session-start')).toBeNull()
    expect(notes.pending('agent.mason')).toBe(false)
    expect(notes.answer('agent.mason', 'post-tool')).toBeNull()
  })

  it('notes are per-agent', () => {
    const { notes } = rig()
    notes.steer('agent.mason', 'for mason')
    expect(notes.answer('agent.scribe', 'post-tool')).toBeNull()
    expect(notes.answer('agent.mason', 'post-tool')).not.toBeNull()
  })
})

describe('SteerNotes — below native the queue path stands', () => {
  it('submits through the queue and holds no note', () => {
    const { notes, queued, record } = rig('pty-heuristic')
    notes.steer('agent.mason', 'Corrective sentence.')
    expect(queued).toEqual(['agent.mason:Corrective sentence.'])
    expect(notes.pending('agent.mason')).toBe(false)
    expect(notes.answer('agent.mason', 'post-tool')).toBeNull()
    expect(record).toEqual(['agent.mason:queue'])
  })

  it('the channel taken is part of the record (invariant §7)', () => {
    const { notes, record } = rig()
    notes.steer('agent.mason', 'text')
    expect(record).toEqual(['agent.mason:hook'])
  })
})

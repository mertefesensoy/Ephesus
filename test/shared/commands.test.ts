import { describe, expect, it } from 'vitest'
import { AVATAR_STATES, AVATAR_TERMINALS, type AvatarPhase } from '../../src/shared/avatar'
import { commandSubmitSchema, decideCommand } from '../../src/shared/commands'

/**
 * The queue-until-idle rule of FR-1.3, as a table. Every phase the avatar
 * machine can be in has a decision, and the default when in doubt is to hold —
 * sending into an unknown state is the one outcome that cannot be undone.
 */

const ALL: readonly AvatarPhase[] = [...AVATAR_STATES, ...AVATAR_TERMINALS]

describe('decideCommand (FR-1.3)', () => {
  it.each(['idle', 'success'] as const)('sends immediately when the agent is %s', (phase) => {
    expect(decideCommand(phase)).toEqual({ kind: 'send' })
  })

  it.each([
    ['alert', 'starting its turn'],
    ['thinking', 'mid-turn'],
    ['working', 'mid-tool'],
    ['waiting', 'waiting on another agent'],
    ['blocked', 'blocked at a gate'],
    ['compacting', 'compacting'],
    ['looping', 'breaker armed']
  ] as const)('holds while the agent is %s, and says why', (phase, reason) => {
    const decision = decideCommand(phase)
    expect(decision.kind).toBe('hold')
    if (decision.kind === 'hold') expect(decision.reason).toContain(reason)
  })

  it.each(['ghost', 'stopped', 'archived'] as const)(
    'refuses when the agent is %s — there is no process to type into',
    (phase) => {
      const decision = decideCommand(phase)
      expect(decision.kind).toBe('refuse')
      if (decision.kind === 'refuse') expect(decision.reason).toContain(phase)
    }
  )

  it('refuses when no agent is selected', () => {
    expect(decideCommand(null)).toEqual({ kind: 'refuse', reason: 'no agent selected' })
  })

  it('has a decision for every phase the avatar machine can reach', () => {
    for (const phase of ALL) {
      expect(['send', 'hold', 'refuse']).toContain(decideCommand(phase).kind)
    }
  })

  it('gives every held phase a reason the Architect could act on', () => {
    for (const phase of ALL) {
      const decision = decideCommand(phase)
      if (decision.kind === 'hold') {
        expect(decision.reason.length).toBeGreaterThan(0)
        expect(decision.reason).not.toBe('agent is busy')
      }
    }
  })
})

describe('commandSubmitSchema', () => {
  it('accepts a well-formed submission', () => {
    expect(commandSubmitSchema.parse({ agentId: 'agent.mason', text: 'fix the test' })).toEqual({
      agentId: 'agent.mason',
      text: 'fix the test'
    })
  })

  const rejected: readonly [string, unknown][] = [
    ['empty text', { agentId: 'agent.mason', text: '' }],
    ['a bad agent id', { agentId: 'Mason', text: 'hi' }],
    ['an extra key', { agentId: 'agent.mason', text: 'hi', sudo: true }],
    ['text over the cap', { agentId: 'agent.mason', text: 'x'.repeat(16385) }],
    ['a missing agent', { text: 'hi' }]
  ]

  it.each(rejected)('rejects %s', (_label, raw) => {
    expect(commandSubmitSchema.safeParse(raw).success).toBe(false)
  })
})

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentDock, dockRows, toneFor } from '../../src/renderer/src/AgentDock'
import type { AgentCard } from '../../src/shared/agents'

function card(over: Partial<AgentCard> = {}): AgentCard {
  return {
    agentId: 'agent.mason',
    name: 'Mason',
    role: 'ci-babysitter',
    lifecycle: 'running',
    engine: 'claude',
    engineVersion: null,
    cwd: 'C:/repo',
    ptyId: 'pty-1',
    settingsWritten: [],
    envGrants: [],
    dailyTokens: null,
    capabilities: [],
    seat: 'terrace-1',
    spawnedAt: '2026-09-01T00:00:00.000Z',
    ...over
  } as AgentCard
}

/**
 * The company at a glance (UI-DESIGN §5).
 *
 * On the 2026-09-01 live run, three crew agents were parked on an engine dialog
 * for their entire lives while the floor showed them as spawned. Finding that
 * out took picking each agent out of a dropdown and reading its terminal. Three
 * cards reading the same status would have said it in one look, which is the
 * whole argument for this panel.
 */
describe('the company, at a glance', () => {
  it('lists an agent the floor has not placed yet, rather than hiding it', () => {
    // A spawning company that renders empty is the blindness this exists to end.
    const rows = dockRows([card()], new Map())
    expect(rows).toHaveLength(1)
    expect(rows[0]?.phase).toBeNull()
    expect(rows[0]?.status).toBe('no signal yet')
  })

  it('says what a phase MEANS, not the glyph that stands for it', () => {
    // The floor draws `ring` for `looping`; the Architect's question on seeing
    // one was "why is it like this". The label existed all along.
    const rows = dockRows(
      [card()],
      new Map([['agent.mason', { phase: 'looping', pendingMail: 0 }]])
    )
    expect(rows[0]?.status).toBe('breaker tripped')
    expect(rows[0]?.status).not.toContain('ring')
  })

  it('carries waiting mail, because an idle agent with mail is not idle', () => {
    const rows = dockRows([card()], new Map([['agent.mason', { phase: 'idle', pendingMail: 3 }]]))
    expect(rows[0]?.pendingMail).toBe(3)
  })

  it('gives a distinct tone to trouble, and a neutral one to no signal', () => {
    expect(toneFor('looping')).not.toBe(toneFor('working'))
    expect(toneFor('blocked')).not.toBe(toneFor('idle'))
    expect(toneFor(null)).toBe('var(--eph-ink-500)')
  })

  it('renders an empty company honestly', () => {
    const html = renderToStaticMarkup(<AgentDock selected={null} onSelect={() => {}} />)
    expect(html).toContain('nobody hired yet')
  })
})

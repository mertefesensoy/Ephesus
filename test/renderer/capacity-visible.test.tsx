import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CapacityBadge } from '../../src/renderer/src/StatusBadge'
import { dockRows, rowTone } from '../../src/renderer/src/AgentDock'
import { capacityView, type ParkedAgent } from '../../src/shared/capacity'
import type { AgentCard } from '../../src/shared/agents'

/**
 * Invariant §7, for the one degradation that is invisible by construction.
 *
 * A company that has hit the provider's usage limit looks EXACTLY like a
 * company that has finished its work: quiet terminals, still avatars, no
 * errors, no exit codes. On a system whose premise is running unattended for
 * days, "looks finished" is the most expensive lie the UI can tell — so both
 * surfaces the Architect actually watches are pinned here.
 */

const NOW = Date.parse('2026-08-30T22:00:00.000Z')

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

function parked(over: Partial<ParkedAgent> = {}): ParkedAgent {
  return {
    agentId: 'agent.mason',
    phase: 'parked',
    limit: {
      kind: 'rate-limit',
      recordId: 'u1',
      sessionId: 'sess-a',
      at: '2026-08-30T22:00:00.000Z',
      detail: "You're out of usage credits.",
      resetsAt: null
    },
    since: '2026-08-30T22:00:00.000Z',
    attempts: 0,
    retryAt: new Date(NOW + 5 * 60_000).toISOString(),
    processAlive: true,
    ...over
  }
}

const badge = (view: Parameters<typeof CapacityBadge>[0]['view']): string =>
  renderToStaticMarkup(<CapacityBadge view={view} now={NOW} />)

describe('the status strip says the company is stopped', () => {
  it('shows an unread state before it has read anything, never "clear"', () => {
    // The same rule the gate and memo badges keep: an unknown must not render
    // as reassurance. A strip claiming the provider is talking to us while
    // nobody has asked is a degradation failing as GOOD news.
    expect(badge(null)).toContain('capacity: …')
    expect(badge(null)).not.toContain('clear')
  })

  it('says clear only when it has actually looked', () => {
    expect(badge(capacityView([]))).toContain('capacity: clear')
  })

  it('names the wait and when it ends', () => {
    const html = badge(capacityView([parked()]))
    expect(html).toContain('waiting for provider capacity')
    expect(html).toContain('retry in 5 min')
    expect(html).not.toContain('clear')
  })

  it("carries the provider's own words, so the Architect can tell which limit", () => {
    // "Out of usage credits" and "rate limited" need different things from a
    // human. A harness that paraphrased them would erase the difference.
    expect(badge(capacityView([parked()]))).toContain('out of usage credits')
  })
})

describe('the dock says which agent is stopped, and why', () => {
  it('replaces the idle word with the park, because idle is the wrong word', () => {
    const rows = dockRows(
      [card()],
      new Map([['agent.mason', { phase: 'idle', pendingMail: 0 }]]),
      new Map(),
      new Map([['agent.mason', parked()]])
    )
    expect(rows[0]?.status).toBe('waiting for provider capacity')
    // The failure this test exists to catch: a parked agent reading as idle.
    expect(rows[0]?.status).not.toBe('idle')
  })

  it('distinguishes waiting from being brought back', () => {
    const rows = dockRows(
      [card()],
      new Map([['agent.mason', { phase: 'idle', pendingMail: 0 }]]),
      new Map(),
      new Map([['agent.mason', parked({ phase: 'resuming' })]])
    )
    expect(rows[0]?.status).toBe('capacity back — continuing')
  })

  it('keeps the phase alongside the park rather than overwriting the fact', () => {
    const rows = dockRows(
      [card()],
      new Map([['agent.mason', { phase: 'idle', pendingMail: 0 }]]),
      new Map(),
      new Map([['agent.mason', parked()]])
    )
    // Both facts survive: the process IS idle, and this is why.
    expect(rows[0]?.phase).toBe('idle')
    expect(rows[0]?.capacity?.limit.detail).toContain('out of usage credits')
  })

  it("leaves an unparked agent's status exactly as it was", () => {
    const rows = dockRows([card()], new Map([['agent.mason', { phase: 'idle', pendingMail: 0 }]]))
    expect(rows[0]?.capacity).toBeNull()
    expect(rows[0]?.status).toBe('idle')
  })

  it('colours a parked row as blocked, not as idle', () => {
    const [row] = dockRows(
      [card()],
      new Map([['agent.mason', { phase: 'idle', pendingMail: 0 }]]),
      new Map(),
      new Map([['agent.mason', parked()]])
    )
    expect(rowTone(row as never)).toBe('var(--eph-status-blocked)')
    const [clear] = dockRows(
      [card()],
      new Map([['agent.mason', { phase: 'idle', pendingMail: 0 }]])
    )
    expect(rowTone(clear as never)).not.toBe('var(--eph-status-blocked)')
  })
})

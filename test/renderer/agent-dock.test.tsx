import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentDock, dockRows, toneFor } from '../../src/renderer/src/AgentDock'
import { strictestLevel } from '../../src/renderer/src/AutonomyBadge'
import { spendLines } from '../../src/renderer/src/AgentPanel'
import type { AgentCard } from '../../src/shared/agents'

function card(over: Partial<AgentCard> = {}): AgentCard {
  return {
    agentId: 'agent.mason',
    name: 'Mason',
    role: 'ci-babysitter',
    lifecycle: 'running',
    fixCommand: null,
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

function spendRow(over: Record<string, unknown> = {}) {
  return {
    agent: 'agent.mason',
    reporting: 'engine',
    session: 's-1',
    sessionTotals: { inTokens: 0, outTokens: 0, costUsd: null, rows: 0 },
    todayTotals: { inTokens: 0, outTokens: 0, costUsd: null, rows: 0 },
    cumulativeTotals: { inTokens: 0, outTokens: 0, costUsd: null, rows: 0 },
    liveSessionCostUsd: null,
    dailyTokens: 20_000_000,
    budget: { state: 'ok', spent: 5_000_000, remaining: 15_000_000, projected: null, because: '' },
    ...over
  } as never
}

/**
 * A meter that reads empty when nothing is measuring is the silent fallback
 * invariant §7 forbids — `reporting: 'none'` is a product tier (ADR-0009 makes
 * transcripts optional), not a spend of zero. These pin the three states apart.
 */
describe('how much of today an agent has spent', () => {
  const live = new Map([['agent.mason', { phase: 'working', pendingMail: 0 }]])

  it('shows a fraction when there is a budget and something measuring it', () => {
    const rows = dockRows([card()], live, new Map([['agent.mason', spendRow()]]))
    expect(rows[0]?.spent).toBeCloseTo(0.25)
    expect(rows[0]?.spendNote).toContain('25%')
  })

  it('never renders an empty bar for an engine that reports nothing', () => {
    const rows = dockRows(
      [card()],
      live,
      new Map([['agent.mason', spendRow({ reporting: 'none' })]])
    )
    expect(rows[0]?.spent).toBeNull()
    expect(rows[0]?.spendNote).toContain('reports no usage')
  })

  it('says so when a role is unbudgeted, rather than showing nothing spent', () => {
    const rows = dockRows(
      [card()],
      live,
      new Map([['agent.mason', spendRow({ dailyTokens: null })]])
    )
    expect(rows[0]?.spent).toBeNull()
    expect(rows[0]?.spendNote).toBe('unbudgeted')
  })

  it('clamps a breach to full rather than overflowing the bar', () => {
    const rows = dockRows(
      [card()],
      live,
      new Map([
        [
          'agent.mason',
          spendRow({
            budget: {
              state: 'breached',
              spent: 40_000_000,
              remaining: -20_000_000,
              projected: null,
              because: 'over'
            }
          })
        ]
      ])
    )
    expect(rows[0]?.spent).toBe(1)
  })
})

/**
 * The Architect asked, repeatedly across one evening, whether the crew were
 * really running autonomously. Answering it meant reading a bundle, composing
 * it against the gate policy by hand, and checking a log. It is a fact about
 * the running system, so it belongs on the screen.
 */
describe('what the company may do without asking', () => {
  const row = (kind: string, effective: string, clamped = false) => ({
    kind,
    global: 'autonomous',
    requested: effective,
    effective,
    clamped
  })
  const instance = (autonomy: readonly unknown[]) =>
    ({
      instanceId: 'i',
      plan: { autonomy },
      agentIds: [],
      armed: [],
      pendingEvents: [],
      activatedAt: ''
    }) as never

  it('reports the STRICTEST level, because that is the one that bites', () => {
    // A profile that is autonomous for four kinds and manual for one is not an
    // autonomous profile; the badge must not read as though it were.
    const said = strictestLevel([
      instance([row('tool-permission', 'autonomous'), row('spend', 'manual', true)])
    ])
    expect(said.level).toBe('manual')
    expect(said.detail).toContain('spend')
  })

  it('names how many kinds the profile clamped', () => {
    const said = strictestLevel([
      instance([row('spend', 'manual', true), row('destructive', 'manual', true)])
    ])
    expect(said.detail).toContain('2 clamped')
  })

  it('says nothing is active rather than implying manual', () => {
    expect(strictestLevel([]).level).toBeNull()
    expect(strictestLevel([]).detail).toBe('no profile is active')
  })
})

/**
 * Everything about ONE agent, beside the floor.
 *
 * The app's tabs replace the whole view, so reading an agent's terminal meant
 * losing the floor and reading what it was ALLOWED to do meant leaving the
 * terminal. Every question about one agent became a sequence of navigations
 * and, in practice, a question to me.
 */
describe('what one agent is spending', () => {
  const base = {
    agent: 'agent.mason',
    reporting: 'engine' as const,
    session: 's',
    sessionTotals: { inTokens: 10, outTokens: 5, costUsd: null, rows: 1 },
    todayTotals: { inTokens: 10, outTokens: 5, costUsd: null, rows: 1 },
    cumulativeTotals: { inTokens: 10, outTokens: 5, costUsd: null, rows: 1 },
    dailyTokens: 20_000_000,
    budget: { state: 'ok', spent: 1000, remaining: 19_999_000, projected: null, because: '' }
  }

  it('says an engine measures nothing, rather than printing zeroes', () => {
    const said = spendLines({ ...base, reporting: 'none' } as never)
    expect(said.join(' ')).toContain('reports no usage')
    expect(said.join(' ')).not.toContain('0 tokens')
  })

  it('says cost is not reported rather than inventing a dollar figure', () => {
    // Ephesus never derives dollars from a guessed price table (M3): a guessed
    // number is worse than an honest silence.
    expect(spendLines(base as never).join(' ')).toContain('not reported')
  })

  it('reports a real cost when the engine gave one', () => {
    const said = spendLines({
      ...base,
      todayTotals: { ...base.todayTotals, costUsd: 1.5 }
    } as never)
    expect(said.join(' ')).toContain('$1.50')
  })

  it('distinguishes an unbudgeted role from a budget of zero', () => {
    expect(spendLines({ ...base, dailyTokens: null } as never).join(' ')).toContain(
      'no daily budget'
    )
  })

  it('says so when there is nothing recorded at all', () => {
    expect(spendLines(null).join(' ')).toContain('no spend recorded')
  })
})

/**
 * An agent that cannot work yet says so, and says what to do (M8.4, B8).
 *
 * These lifecycles mean NO PROCESS EXISTS, so nothing on the event plane will
 * ever describe them and the dock has to read the card. Before M8.4 every one
 * of them rendered as `no signal yet` — which reads as "any moment now" to an
 * Architect whose engine is simply logged out, and is how three crew agents
 * spent a whole day parked on a login prompt while the floor showed them as
 * spawned.
 *
 * Nothing asserted any of this: deleting the branch entirely, and deleting the
 * fix command from it, both passed the whole file.
 */
describe('an agent that cannot start says why, and what fixes it', () => {
  it('names a logged-out engine and the command that fixes it', () => {
    const rows = dockRows(
      [card({ lifecycle: 'needs-login', fixCommand: 'claude auth login' })],
      new Map()
    )
    expect(rows[0]?.status).toBe('engine not logged in — run: claude auth login')
    // The wrong answer is the one it replaced: "no signal yet" is a promise
    // that something is coming, and nothing is.
    expect(rows[0]?.status).not.toContain('no signal yet')
  })

  it('names a missing binary the same way', () => {
    const rows = dockRows([card({ lifecycle: 'missing-binary' })], new Map())
    expect(rows[0]?.status).toBe('engine not installed')
  })

  it('says an install is under way rather than nothing at all', () => {
    const rows = dockRows([card({ lifecycle: 'installing' })], new Map())
    expect(rows[0]?.status).toBe('installing the engine')
  })

  it('still says it when the floor HAS a phase for the agent', () => {
    // A stale phase from a previous life must not paper over a card that says
    // the engine cannot run — the card is the fact about the process.
    const rows = dockRows(
      [card({ lifecycle: 'needs-login', fixCommand: 'claude auth login' })],
      new Map([['agent.mason', { phase: 'idle', pendingMail: 0 }]])
    )
    expect(rows[0]?.status).toContain('engine not logged in')
  })

  it(`leaves a working agent's status alone`, () => {
    const rows = dockRows([card()], new Map([['agent.mason', { phase: 'idle', pendingMail: 0 }]]))
    expect(rows[0]?.status).not.toContain('engine not')
  })

  // The component renders `row.status` verbatim (AgentDock.tsx:405, and into
  // the row's aria-label at :379), so what `dockRows` decides above is what
  // reaches the screen. `AgentDock` fetches its own cards over IPC and cannot
  // be handed one, so the seam worth asserting is this projection rather than
  // a second render that would only re-check React.
})

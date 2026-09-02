import { useEffect, useState, type ReactElement } from 'react'
import { TerminalPanel } from './TerminalPanel'
import type { AgentCard } from '../../shared/agents'
import { formatUsd, sessionCostOf, type AgentSpend } from '../../shared/cost'

/**
 * Everything about ONE agent, beside the floor (UI-DESIGN §4).
 *
 * The app's tabs replace the whole view, so reading an agent's terminal meant
 * losing sight of the floor, and reading what it was *allowed* to do meant
 * leaving the terminal. Across one evening that turned every question about a
 * single agent — is it running, what did it spend, why can it not reach GitHub
 * — into a sequence of navigations and a question to me.
 *
 * Scoped to the selection, and honest when there is none: an empty terminal
 * with no explanation is indistinguishable from a broken one.
 */

export const AGENT_TABS = ['terminal', 'spend', 'grants'] as const
export type AgentTab = (typeof AGENT_TABS)[number]

/** Contract: pure. What the spend tab says, including why it may say nothing. */
export function spendLines(spend: AgentSpend | null): readonly string[] {
  if (spend === null) return ['no spend recorded for this agent yet']
  if (spend.reporting === 'none') {
    // A product tier, not a zero (ADR-0009 makes transcripts optional).
    return ['this engine reports no usage, so nothing here is measured']
  }
  const lines = [
    `today: ${spend.budget.spent.toLocaleString()} tokens`,
    spend.dailyTokens === null
      ? 'no daily budget for this role'
      : `budget: ${spend.dailyTokens.toLocaleString()} · ${spend.budget.state}`,
    `session: ${spend.sessionTotals.inTokens.toLocaleString()} in · ${spend.sessionTotals.outTokens.toLocaleString()} out`
  ]
  // Cost is reported only when the engine reports one; Ephesus never derives
  // dollars from a guessed price table (M3 decision), and a guessed figure is
  // worse than an honest silence. What changed with ADR-0023 is only that the
  // engine turns out to report one — nothing here is computed from a price.
  // ADR-0011's dual figure, finally in money as well as tokens. Each window is
  // reported INDEPENDENTLY: an agent can easily have money recorded for today
  // and none yet for its current session — an earlier session today, a fresh
  // one now — and a missing session figure must not suppress the others.
  const session = sessionCostOf(spend)
  const money: string[] = []
  if (session.usd !== null) {
    money.push(
      session.from === 'live'
        ? `cost this session: ${formatUsd(session.usd)} so far (live — the engine files the final figure when the session ends)`
        : `cost this session: ${formatUsd(session.usd)} (final, from the engine's own transcript)`
    )
  }
  if (spend.todayTotals.costUsd !== null) {
    money.push(`cost today: ${formatUsd(spend.todayTotals.costUsd)}`)
  }
  if (spend.cumulativeTotals.costUsd !== null) {
    money.push(`cost all time: ${formatUsd(spend.cumulativeTotals.costUsd)}`)
  }
  // Only when NOTHING is reported does the tab say so — the same "not reported
  // is not zero" rule the token meter follows.
  lines.push(...(money.length === 0 ? ['cost: not reported by this engine'] : money))
  return lines
}

const tabBar = { display: 'flex', gap: '4px', marginBottom: '6px' } as const

const tabButton = (active: boolean) =>
  ({
    fontFamily: 'var(--eph-face-display)',
    fontSize: '8px',
    padding: '4px 8px',
    border: '2px solid var(--eph-ink-900)',
    background: active ? 'var(--eph-ink-900)' : 'var(--eph-marble-200)',
    color: active ? 'var(--eph-marble-50)' : 'var(--eph-ink-900)',
    cursor: 'pointer'
  }) as const

const body = {
  fontFamily: 'var(--eph-face-data)',
  fontSize: '12px',
  color: 'var(--eph-ink-900)'
} as const

export function AgentPanel({ agentId }: { readonly agentId: string | null }): ReactElement {
  const [tab, setTab] = useState<AgentTab>('terminal')
  const [card, setCard] = useState<AgentCard | null>(null)
  const [spend, setSpend] = useState<AgentSpend | null>(null)

  useEffect(() => {
    const eph = window.eph
    if (!eph || agentId === null) {
      setCard(null)
      setSpend(null)
      return
    }
    void eph.agents.card(agentId).then(setCard, () => setCard(null))
    const read = (): void => {
      void eph.watch.budgets().then((rows) => {
        setSpend(rows.find((row) => row.agent === agentId) ?? null)
      })
    }
    read()
    const timer = setInterval(read, 5000)
    return () => clearInterval(timer)
  }, [agentId])

  return (
    <section aria-label="Selected agent" style={{ flex: '1 1 0', minWidth: 0 }}>
      <div style={tabBar}>
        {AGENT_TABS.map((name) => (
          <button
            key={name}
            type="button"
            style={tabButton(tab === name)}
            onClick={() => setTab(name)}
          >
            {name.toUpperCase()}
          </button>
        ))}
      </div>

      {/* The terminal stays mounted across tab changes: xterm owns a live PTY
          attachment, and unmounting it to show a list would drop the scrollback
          the Architect was reading. */}
      <div style={{ display: tab === 'terminal' ? 'block' : 'none' }}>
        <TerminalPanel agentId={agentId} />
      </div>

      {tab === 'spend' && (
        <div style={body}>
          {spendLines(spend).map((line) => (
            <div key={line} style={{ margin: '2px 0' }}>
              {line}
            </div>
          ))}
        </div>
      )}

      {tab === 'grants' && (
        <div style={body}>
          {card === null && <div>select an agent to see what it was given</div>}
          {card !== null && (
            <>
              <div>
                engine: {card.engine}
                {card.engineVersion === null ? ' (version unknown)' : ` ${card.engineVersion}`}
              </div>
              <div>hooks: {card.hookFidelity}</div>
              <div>cwd: {card.cwd}</div>
              {/* Names only, never values — ADR-0010. */}
              <div style={{ marginTop: '4px' }}>
                grants: {card.envGrants.length === 0 ? 'none declared' : card.envGrants.join(', ')}
              </div>
              <div>seat: {card.seat}</div>
            </>
          )}
        </div>
      )}
    </section>
  )
}

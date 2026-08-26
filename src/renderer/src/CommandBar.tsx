import { useEffect, useState, type FormEvent, type ReactElement } from 'react'
import type { AgentCard } from '../../shared/agents'
import type { CommandState } from '../../shared/commands'

/**
 * The command bar (UI-DESIGN §4: bottom = command bar). A free prompt to the
 * selected agent, an interrupt button, and — the part that matters — a visible
 * account of anything the harness is holding on the Architect's behalf.
 *
 * It decides nothing. Whether text is sent now or queued until the agent is
 * idle is main's call (FR-1.3, `src/main/commands.ts`); this component sends
 * the text and renders the answer. Held text is shown back verbatim, because
 * unsent text the UI has swallowed is exactly the silent state this codebase
 * forbids (ENGINEERING-STANDARDS §4).
 */
export function CommandBar({
  selected,
  onSelect,
  onAgentSeen
}: {
  selected: string | null
  /** The Architect chose an agent. */
  onSelect: (agentId: string | null) => void
  /** An agent appeared; App decides whether it becomes the selection. */
  onAgentSeen: (agentId: string) => void
}): ReactElement {
  const [agents, setAgents] = useState<readonly AgentCard[]>([])
  const [text, setText] = useState('')
  const [held, setHeld] = useState<Map<string, CommandState>>(new Map())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const eph = window.eph
    if (!eph) return

    void eph.agents.list().then((cards) => {
      setAgents(cards)
      if (cards[0]) onAgentSeen(cards[0].agentId)
    })
    void eph.commands.list().then((states) => {
      setHeld(new Map(states.map((state) => [state.agentId, state])))
    })

    const offAgents = eph.agents.onChange((card) => {
      setAgents((current) => {
        const next = current.filter((c) => c.agentId !== card.agentId)
        return [...next, card].sort((a, b) => a.agentId.localeCompare(b.agentId))
      })
      onAgentSeen(card.agentId)
    })
    const offCommands = eph.commands.onChange((state) => {
      setHeld((current) => {
        const next = new Map(current)
        if (state.held === null) next.delete(state.agentId)
        else next.set(state.agentId, state)
        return next
      })
    })
    return () => {
      offAgents()
      offCommands()
    }
    // Subscribed once: the callbacks are stable in App, and re-subscribing on
    // every render would leak listeners.
  }, [onAgentSeen])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const eph = window.eph
    const trimmed = text.trim()
    if (!eph || !selected || trimmed.length === 0) return
    setError(null)
    eph.commands
      .submit(selected, trimmed)
      .then(() => setText(''))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }

  const interrupt = (): void => {
    const eph = window.eph
    if (!eph || !selected) return
    setError(null)
    eph.agents.interrupt(selected).catch((err: unknown) => setError(String(err)))
  }

  const queued = selected ? (held.get(selected) ?? null) : null
  const disabled = selected === null

  return (
    <form
      onSubmit={submit}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        border: '2px solid var(--eph-ink-900)',
        boxShadow: '2px 2px 0 var(--eph-ink-900)',
        background: 'var(--eph-marble-50)',
        padding: '8px'
      }}
    >
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <select
          aria-label="Selected agent"
          value={selected ?? ''}
          onChange={(e) => onSelect(e.target.value || null)}
          style={{ fontFamily: 'var(--eph-face-ui)', fontSize: '12px' }}
        >
          {agents.length === 0 && <option value="">no agents</option>}
          {agents.map((card) => (
            <option key={card.agentId} value={card.agentId}>
              {card.name} · {card.role} · {card.lifecycle}
            </option>
          ))}
        </select>
        <input
          aria-label="Prompt"
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            disabled ? 'spawn an agent to send a prompt' : 'say something to this agent…'
          }
          style={{
            flex: 1,
            fontFamily: 'var(--eph-face-data)',
            fontSize: '13px',
            padding: '4px'
          }}
        />
        <button type="submit" disabled={disabled} style={{ fontFamily: 'var(--eph-face-ui)' }}>
          Send
        </button>
        <button
          type="button"
          onClick={interrupt}
          disabled={disabled}
          title="Sends the engine's cancel key and drops any queued text"
          style={{ fontFamily: 'var(--eph-face-ui)' }}
        >
          Interrupt
        </button>
      </div>
      <span style={{ fontFamily: 'var(--eph-face-data)', fontSize: '12px', minHeight: '16px' }}>
        {error && <span style={{ color: 'var(--eph-status-blocked)' }}>{error}</span>}
        {!error && queued && (
          // §2.4 `status-typing`: the Architect holds unsent text on this agent.
          <span style={{ color: 'var(--eph-status-typing)' }}>
            ✎ queued ({queued.reason}): {queued.held}
          </span>
        )}
        {!error && !queued && !disabled && (
          <span style={{ color: 'var(--eph-ink-700)' }}>nothing queued</span>
        )}
      </span>
    </form>
  )
}

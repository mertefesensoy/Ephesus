import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { badgeFor } from '../../shared/badges'
import type { AgentCard } from '../../shared/agents'
import type { AvatarUpdate } from '../../shared/ipc'

/**
 * The company at a glance (UI-DESIGN §5).
 *
 * Until this existed, the only way to learn what an agent was doing was to pick
 * it out of a dropdown one at a time and read its terminal. On the 2026-09-01
 * live run that cost hours: three crew agents were parked on an engine dialog
 * for their entire lives, the floor showed them as spawned, and the fact only
 * surfaced because someone went looking agent by agent. A row of cards would
 * have shown three identical "waiting" states in one glance.
 *
 * What each card says is deliberately the WORD, not the glyph. The floor draws
 * a 3×5 pixel badge per phase, and the Architect's own question on seeing one
 * was "why is it like this" — a status you have to decode is not a status.
 * `badgeFor(phase).label` already carried the sentence; nothing rendered it.
 */

/** Contract: pure. What one card says, derived from the two live sources. */
export interface DockRow {
  readonly agentId: string
  readonly name: string
  readonly role: string
  readonly lifecycle: string
  /** The SDD §6 phase word, or null when the floor has not placed it yet. */
  readonly phase: string | null
  /** What the phase MEANS, in words — `badgeFor`'s own label. */
  readonly status: string
  readonly pendingMail: number
}

/**
 * Contract: pure. Joins the roster to the floor's live phases.
 *
 * The roster is the source of who exists; the avatar stream is the source of
 * what they are doing. An agent with no avatar update yet is still listed —
 * omitting it would make a spawning company look empty, which is the exact
 * blindness this panel exists to end.
 */
export function dockRows(
  cards: readonly AgentCard[],
  phases: ReadonlyMap<string, { phase: string; pendingMail: number }>
): readonly DockRow[] {
  return cards.map((card) => {
    const live = phases.get(card.agentId) ?? null
    return {
      agentId: card.agentId,
      name: card.name,
      role: card.role,
      lifecycle: card.lifecycle,
      phase: live?.phase ?? null,
      status: live === null ? 'no signal yet' : badgeFor(live.phase).label,
      pendingMail: live?.pendingMail ?? 0
    }
  })
}

const PHASE_TONE: Readonly<Record<string, string>> = {
  idle: 'var(--eph-status-idle)',
  working: 'var(--eph-status-working)',
  thinking: 'var(--eph-status-working)',
  blocked: 'var(--eph-status-blocked)',
  looping: 'var(--eph-status-looping)',
  done: 'var(--eph-status-success)'
}

/** Contract: pure. The colour a status pill takes for a phase. */
export function toneFor(phase: string | null): string {
  return phase === null ? 'var(--eph-ink-500)' : (PHASE_TONE[phase] ?? 'var(--eph-status-idle)')
}

const dock = {
  display: 'flex',
  gap: '6px',
  overflowX: 'auto',
  padding: '6px',
  borderTop: '2px solid var(--eph-ink-900)',
  background: 'var(--eph-parchment-100)'
} as const

const card = {
  minWidth: '168px',
  border: '2px solid var(--eph-ink-900)',
  background: 'var(--eph-marble-50)',
  padding: '6px',
  textAlign: 'left',
  cursor: 'pointer',
  fontFamily: 'var(--eph-face-data)',
  fontSize: '11px'
} as const

export function AgentDock({
  selected,
  onSelect
}: {
  readonly selected: string | null
  readonly onSelect: (agentId: string) => void
}): ReactElement {
  const [cards, setCards] = useState<readonly AgentCard[]>([])
  const [phases, setPhases] = useState<ReadonlyMap<string, { phase: string; pendingMail: number }>>(
    new Map()
  )

  const applyAvatar = useCallback((update: AvatarUpdate) => {
    setPhases((prev) => {
      const next = new Map(prev)
      next.set(update.agentId, {
        phase: update.snapshot.phase,
        pendingMail: update.pendingMail
      })
      return next
    })
  }, [])

  useEffect(() => {
    const eph = window.eph
    if (!eph) return
    void eph.agents.list().then(setCards)
    void eph.avatars.list().then((updates) => {
      for (const update of updates) applyAvatar(update)
    })
    const offAgents = eph.agents.onChange(() => {
      void eph.agents.list().then(setCards)
    })
    const offAvatars = eph.avatars.onChange(applyAvatar)
    return () => {
      offAgents()
      offAvatars()
    }
  }, [applyAvatar])

  const rows = dockRows(cards, phases)

  return (
    <div style={dock} aria-label="The company">
      {rows.length === 0 && (
        <span style={{ fontFamily: 'var(--eph-face-data)', color: 'var(--eph-ink-500)' }}>
          nobody hired yet
        </span>
      )}
      {rows.map((row) => (
        <button
          key={row.agentId}
          type="button"
          onClick={() => onSelect(row.agentId)}
          aria-label={`${row.name}: ${row.status}`}
          style={{
            ...card,
            outline: row.agentId === selected ? '2px solid var(--eph-status-working)' : 'none'
          }}
        >
          <div style={{ fontFamily: 'var(--eph-face-ui)', fontSize: '10px' }}>{row.name}</div>
          <div style={{ color: 'var(--eph-ink-500)' }}>{row.role}</div>
          <div style={{ marginTop: '4px', color: toneFor(row.phase) }}>■ {row.status}</div>
          {row.pendingMail > 0 && (
            <div style={{ color: 'var(--eph-status-blocked)' }}>
              {String(row.pendingMail)} waiting
            </div>
          )}
        </button>
      ))}
    </div>
  )
}

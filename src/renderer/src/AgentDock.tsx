import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { badgeFor } from '../../shared/badges'
import { emoteFrame } from '../../shared/emotes'
import { emotesState } from './emotes'
import type { AgentCard } from '../../shared/agents'
import type { AvatarUpdate } from '../../shared/ipc'
import type { AgentSpend } from '../../shared/cost'
import type { CapacityView, ParkedAgent } from '../../shared/capacity'

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
  /**
   * How much of today's allowance is gone, 0..1 — or null when the role is
   * unbudgeted, or when the engine reports no usage at all.
   *
   * `reporting: 'none'` is a product tier, not a zero (ADR-0009 makes
   * transcripts optional), so it must not render as an empty bar. An agent
   * that looks like it has spent nothing when nothing is measuring it is the
   * silent fallback invariant §7 forbids.
   */
  readonly spent: number | null
  /** The reason there is no bar, when there is none. */
  readonly spendNote: string
  /**
   * This agent's provider-capacity park, or null when nothing is blocking.
   *
   * It sits BESIDE `phase` rather than replacing it because they are different
   * facts and the card shows both: the phase is what the process is doing
   * (nothing — it is idle), and this is why. Collapsing them would leave a
   * parked company reading exactly like a finished one, which is the whole
   * failure this row exists to prevent.
   */
  readonly capacity: ParkedAgent | null
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
  phases: ReadonlyMap<string, { phase: string; pendingMail: number }>,
  spend: ReadonlyMap<string, AgentSpend> = new Map(),
  capacity: ReadonlyMap<string, ParkedAgent> = new Map()
): readonly DockRow[] {
  return cards.map((card) => {
    const live = phases.get(card.agentId) ?? null
    const money = spend.get(card.agentId) ?? null
    const parked = capacity.get(card.agentId) ?? null
    const budgeted = money !== null && money.dailyTokens !== null && money.dailyTokens > 0
    const measured = money !== null && money.reporting === 'engine'
    return {
      agentId: card.agentId,
      name: card.name,
      role: card.role,
      lifecycle: card.lifecycle,
      phase: live?.phase ?? null,
      capacity: parked,
      // The park OUTRANKS the phase word. An agent the provider has refused is
      // idle in every sense the avatar can see, and "idle" is precisely the
      // wrong thing to tell an Architect who is waiting for work to happen.
      status:
        parked !== null
          ? parked.phase === 'resuming'
            ? 'capacity back — continuing'
            : 'waiting for provider capacity'
          : live === null
            ? 'no signal yet'
            : badgeFor(live.phase).label,
      pendingMail: live?.pendingMail ?? 0,
      spent:
        budgeted && measured
          ? Math.min(1, money.budget.spent / (money.dailyTokens as number))
          : null,
      spendNote:
        money === null
          ? 'no spend recorded'
          : !measured
            ? 'this engine reports no usage'
            : !budgeted
              ? 'unbudgeted'
              : `${Math.round((money.budget.spent / (money.dailyTokens as number)) * 100).toString()}% of today`
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

/**
 * Contract: pure. The colour one row takes, park included.
 *
 * A parked agent borrows the `blocked` token rather than a new one: it IS
 * blocked, on something outside the company, and §2.4 already spends that
 * colour on "stopped, waiting for something that is not you".
 */
export function rowTone(row: DockRow): string {
  return row.capacity === null ? toneFor(row.phase) : 'var(--eph-status-blocked)'
}

/**
 * Contract: the CSS that shows one phase's emote, or null when no pack is
 * installed. A sprite sheet is positioned rather than sliced: the dock is HTML,
 * and background-position is the one way to blit in it without a canvas.
 */
function emoteStyle(phase: string | null): Record<string, string> | null {
  if (!EMOTES.installed || EMOTES.manifest === null || EMOTES.url === null) return null
  const frame = phase === null ? null : emoteFrame(EMOTES.manifest, phase)
  if (frame === null) return null
  const scale = 1
  return {
    width: `${String(frame.size * scale)}px`,
    height: `${String(frame.size * scale)}px`,
    backgroundImage: `url(${EMOTES.url})`,
    backgroundPosition: `-${String(frame.x * scale)}px -${String(frame.y * scale)}px`,
    imageRendering: 'pixelated',
    flex: '0 0 auto'
  }
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

const EMOTES = emotesState()

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
  const [spend, setSpend] = useState<ReadonlyMap<string, AgentSpend>>(new Map())
  /**
   * Who is waiting on the provider. Read on the same slow poll as spend AND on
   * the `capacity:state` push, the belt-and-braces the gate badge already uses:
   * the push makes it prompt, the poll makes it right after a missed event.
   */
  const [capacity, setCapacity] = useState<ReadonlyMap<string, ParkedAgent>>(new Map())

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
    // Spend is a slow poll rather than a subscription: it is folded post-hoc
    // from transcripts, so there is no event to ride, and a stale bar is a far
    // smaller lie than no bar at all.
    const readSpend = (): void => {
      void eph.watch.budgets().then((rows) => {
        setSpend(new Map(rows.map((row) => [row.agent, row])))
      })
    }
    const readCapacity = (): void => {
      void eph.watch
        .capacity()
        .then((view: CapacityView) => {
          setCapacity(new Map(view.parked.map((row) => [row.agentId, row])))
        })
        .catch(() => {
          // Left alone rather than cleared: dropping the map on one failed read
          // would show a parked company as a working one, which is a
          // degradation failing as GOOD news (invariant §7).
        })
    }
    readSpend()
    readCapacity()
    const offCapacity = eph.watch.onCapacityChange(readCapacity)
    const timer = setInterval(() => {
      readSpend()
      readCapacity()
    }, 5000)
    return () => {
      offAgents()
      offAvatars()
      offCapacity()
      clearInterval(timer)
    }
  }, [applyAvatar])

  const rows = dockRows(cards, phases, spend, capacity)

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
          <div
            style={{
              marginTop: '4px',
              color: rowTone(row),
              display: 'flex',
              alignItems: 'center',
              gap: '4px'
            }}
          >
            {/* Beside the word, never instead of it (§8 double-encoding). The
                icon is what a reader recognises; the word is what makes it
                unambiguous, and the 3x5 glyph proved an icon alone is not
                enough — somebody had to ask what a ring meant. */}
            {emoteStyle(row.phase) === null ? (
              <span aria-hidden="true">■</span>
            ) : (
              <span aria-hidden="true" style={emoteStyle(row.phase) ?? undefined} />
            )}
            <span>{row.status}</span>
          </div>
          {row.capacity !== null && (
            <div style={{ color: 'var(--eph-status-blocked)' }} title={row.capacity.limit.detail}>
              retry {new Date(row.capacity.retryAt).toLocaleTimeString()}
            </div>
          )}
          {row.pendingMail > 0 && (
            <div style={{ color: 'var(--eph-status-blocked)' }}>
              {String(row.pendingMail)} waiting
            </div>
          )}
          <div style={{ marginTop: '4px', color: 'var(--eph-ink-500)' }} title={row.spendNote}>
            {row.spent === null ? (
              row.spendNote
            ) : (
              <span
                style={{
                  display: 'inline-block',
                  width: '100%',
                  height: '4px',
                  background: 'var(--eph-marble-200)',
                  border: '1px solid var(--eph-ink-500)'
                }}
              >
                <span
                  style={{
                    display: 'block',
                    height: '100%',
                    width: `${String(Math.round(row.spent * 100))}%`,
                    background:
                      row.spent >= 1 ? 'var(--eph-status-looping)' : 'var(--eph-status-working)'
                  }}
                />
              </span>
            )}
          </div>
        </button>
      ))}
    </div>
  )
}

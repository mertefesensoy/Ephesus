import { useEffect, useState, type ReactElement } from 'react'
import type { ProfileInstanceView } from '../../shared/profile-view'

/**
 * What the company is actually allowed to do without asking (FR-11.1).
 *
 * The Architect asked repeatedly, across one evening, whether the crew were
 * really running autonomously — and answering it meant reading a profile
 * bundle, composing it against the gate policy in my head, and checking a log.
 * That is a fact about the running system, so it belongs on the screen.
 *
 * It reads the COMPOSED level from the live activation plan rather than the
 * global policy, because composition is stricter-wins: a global `autonomous`
 * clamped by a profile's `manual` runs at manual, and showing the global would
 * state the opposite of what happens.
 */

/** Contract: pure. The strictest level in force, which is the one that bites. */
export function strictestLevel(instances: readonly ProfileInstanceView[]): {
  readonly level: string | null
  readonly detail: string
} {
  const rows = instances.flatMap((instance) => instance.plan.autonomy)
  if (rows.length === 0) return { level: null, detail: 'no profile is active' }
  const rank: Readonly<Record<string, number>> = { manual: 0, supervised: 1, autonomous: 2 }
  let worst = rows[0]
  for (const row of rows) {
    if ((rank[row.effective] ?? 0) < (rank[worst?.effective ?? 'manual'] ?? 0)) worst = row
  }
  // Naming the KIND is the difference between a badge and an answer: "manual"
  // alone sends someone hunting for which class of action is clamped.
  const clamped = rows.filter((row) => row.clamped).length
  return {
    level: worst?.effective ?? null,
    detail:
      `strictest: ${worst?.kind ?? '?'} is ${worst?.effective ?? '?'}` +
      (clamped > 0 ? ` · ${String(clamped)} clamped by the profile` : '')
  }
}

const TONE: Readonly<Record<string, string>> = {
  autonomous: 'var(--eph-status-success)',
  supervised: 'var(--eph-status-working)',
  manual: 'var(--eph-status-blocked)'
}

export function AutonomyBadge(): ReactElement {
  const [instances, setInstances] = useState<readonly ProfileInstanceView[]>([])

  useEffect(() => {
    const eph = window.eph
    if (!eph) return
    const read = (): void => {
      void eph.profiles.instances().then(setInstances)
    }
    read()
    const timer = setInterval(read, 5000)
    return () => clearInterval(timer)
  }, [])

  const { level, detail } = strictestLevel(instances)
  return (
    <span
      style={{
        marginLeft: '8px',
        fontFamily: 'var(--eph-face-data)',
        fontSize: '12px',
        color: level === null ? 'var(--eph-ink-500)' : (TONE[level] ?? 'var(--eph-ink-500)')
      }}
      title={detail}
    >
      {' · '}autonomy: {level ?? 'none active'}
    </span>
  )
}

import type { ReactElement } from 'react'
import { capacitySentence, type CapacityView } from '../../shared/capacity'

/**
 * A status-strip count badge (UI-DESIGN §4) — gates, memos, and anything else
 * the strip counts.
 *
 * Shared because the badges obey one rule that is easy to get wrong separately:
 * **an unknown count must never render as reassurance.** `null` (not read yet)
 * and `'error'` (could not be read) are distinct from `0`, because a stale
 * badge showing "none" is a degradation failing as GOOD news — the one
 * direction invariant §7 does not allow.
 *
 * It lives in its own module rather than beside `App` so the M6.1 render
 * harness can reach it: importing `App` pulls in xterm and Pixi, which need a
 * browser. Chrome that carries a rule worth pinning should be importable
 * without booting the whole shell.
 */
export function CountBadge(props: {
  readonly label: string
  readonly count: number | 'error' | null
  /** §9 copy voice: what to say when there are none, and when there are some. */
  readonly none: string
  readonly some: (n: number) => string
  /** The §2.4 status token used when the count is non-zero. */
  readonly tone: string
}): ReactElement {
  const { label, count, none, some, tone } = props
  return (
    <span style={{ fontFamily: 'var(--eph-face-data)', fontSize: '12px' }}>
      {count === null && `${label}: …`}
      {count === 'error' && (
        <span style={{ color: 'var(--eph-status-looping)' }}>⚠ {label}: unavailable</span>
      )}
      {count === 0 && (
        <span style={{ color: 'var(--eph-status-success)' }}>
          ● {label}: {none}
        </span>
      )}
      {typeof count === 'number' && count > 0 && (
        <span style={{ color: tone }}>
          ⚠ {label}: {some(count)}
        </span>
      )}
    </span>
  )
}

/**
 * The provider-capacity badge (invariant §7).
 *
 * A company that has hit the provider's usage limit looks EXACTLY like a
 * company that has finished its work: quiet terminals, still avatars, no
 * errors. That is the failure this badge exists to make impossible, on a system
 * whose whole premise is running unattended for days.
 *
 * Three states, and the middle one is why this is not a `CountBadge`: an
 * unknown must not render as reassurance, so `null` says "…" rather than
 * "clear". A stale badge claiming the provider is talking to us is a
 * degradation failing as GOOD news — the one direction invariant §7 does not
 * allow.
 */
export function CapacityBadge(props: {
  readonly view: CapacityView | null
  /** Injected in tests so the "retry in N min" phrasing is deterministic. */
  readonly now?: number
}): ReactElement {
  const { view } = props
  const now = props.now ?? Date.now()
  const sentence = view === null ? null : capacitySentence(view, now)
  return (
    <span style={{ fontFamily: 'var(--eph-face-data)', fontSize: '12px' }}>
      {view === null && 'capacity: …'}
      {view !== null && sentence === null && (
        <span style={{ color: 'var(--eph-status-success)' }}>● capacity: clear</span>
      )}
      {sentence !== null && (
        <span
          style={{ color: 'var(--eph-status-blocked)' }}
          title={view?.parked
            .map((row) => `${row.agentId}: ${row.limit.detail}`)
            .join(String.fromCharCode(10))}
        >
          ⚠ {sentence}
        </span>
      )}
    </span>
  )
}

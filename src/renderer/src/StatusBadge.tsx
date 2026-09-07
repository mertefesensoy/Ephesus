import type { ReactElement } from 'react'
import { capacitySentence, type CapacityView } from '../../shared/capacity'
import { stallSeconds } from '../../shared/freshness'
import type { ConfigSnapshot } from '../../shared/ipc'

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
  /**
   * Milliseconds since this reading last answered, once it is past its deadline
   * (`stallOf`); null while it is current.
   *
   * The poll HOLDS its last value on failure and that is deliberate — a failed
   * read must never repaint a parked company as a working one. But a held value
   * and a current one rendered identically, so "the provider was clear at 3am
   * and nothing has answered since" read exactly like "the provider is clear".
   * Holding the value is right; holding it silently is the degradation.
   */
  readonly staleFor?: number | null
}): ReactElement {
  const { view } = props
  const now = props.now ?? Date.now()
  const sentence = view === null ? null : capacitySentence(view, now)
  const stale = props.staleFor ?? null
  // A stale reading is reported as stale WHATEVER it says. A held "clear" is
  // the dangerous one — it is the reading that says nothing is wrong — so the
  // disclosure cannot be attached only to the alarming branch.
  if (stale !== null && view !== null) {
    return (
      <span style={{ fontFamily: 'var(--eph-face-data)', fontSize: '12px' }}>
        <span style={{ color: 'var(--eph-status-looping)' }}>
          ⚠ capacity: last read {stallSeconds(stale)}s ago
          {sentence === null ? '' : ` — ${sentence}`}
        </span>
      </span>
    )
  }
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

/**
 * What the renderer knows about the process on the other side of the bridge.
 *
 * `ready` carries `lastOkAt` because "we got a snapshot" is a fact with a TIME:
 * without it the state means "the bridge answered at least once, ever", which
 * is what let the strip read `bridge: ready` for an hour after main died.
 */
export type BridgeState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly snapshot: ConfigSnapshot; readonly lastOkAt: number }
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * The bridge badge — a hung harness said out loud (B15).
 *
 * The three states the renderer can be in are NOT the three this renders. A
 * `ready` whose last answer is older than the deadline is the fourth, and it is
 * the one the company's whole "leave it running" premise depends on: an idle
 * harness and a hung one produce the same still floor, the same quiet terminals
 * and the same unchanging badges, so the only thing that can tell them apart is
 * whether the harness is still ANSWERING.
 *
 * `stallFor` is passed in rather than computed from `lastOkAt` here so the
 * deadline is decided in one place (`stallOf`) for every reading on the strip,
 * and so this stays a pure render of a decision made elsewhere.
 */
export function BridgeBadge(props: {
  readonly state: BridgeState
  readonly stallFor?: number | null
}): ReactElement {
  const { state } = props
  const stall = props.stallFor ?? null
  return (
    <span style={{ fontFamily: 'var(--eph-face-data)', fontSize: '12px' }}>
      {state.kind === 'loading' && stall === null && 'bridge: connecting…'}
      {state.kind === 'loading' && stall !== null && (
        <span style={{ color: 'var(--eph-status-blocked)' }}>
          ⚠ bridge: no answer in {stallSeconds(stall)}s — the harness may be hung
        </span>
      )}
      {state.kind === 'ready' && stall !== null && (
        <span style={{ color: 'var(--eph-status-blocked)' }}>
          ⚠ bridge: silent for {stallSeconds(stall)}s — the harness may be hung
        </span>
      )}
      {state.kind === 'ready' && stall === null && (
        <>
          {`bridge: ready · config schema v${String(state.snapshot.config.schemaVersion)}`}
          {state.snapshot.warning !== null && (
            <span style={{ color: 'var(--eph-status-blocked)' }}> · {state.snapshot.warning}</span>
          )}
        </>
      )}
      {state.kind === 'unavailable' && (
        <span style={{ color: 'var(--eph-status-blocked)' }}>bridge: {state.reason}</span>
      )}
    </span>
  )
}

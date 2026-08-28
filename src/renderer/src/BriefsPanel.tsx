import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { BriefRecord } from '../../shared/odeon'

/**
 * The Briefs tab (UI-DESIGN §4, ADR-0008 §1, FR-7.1, UC-04).
 *
 * The card, and only the card: the Herald speaks a brief in M6, and this shows
 * the same artifact it will read from. Every archived brief carries its source
 * refs inline and again in an appendix, so the Architect can check any sentence
 * without leaving the panel — which is the point of FR-7.1's "every claim
 * traceable to a ledger/log entry".
 *
 * A projection (invariant §2): the markdown shown is the archived file itself.
 */

const REFRESH_MS = 10_000

const panel = {
  fontFamily: 'var(--eph-face-data)',
  fontSize: '12px',
  flex: '1 1 0',
  minWidth: 0,
  border: '2px solid var(--eph-ink-900)',
  boxShadow:
    'inset 0 0 0 1px var(--eph-marble-50), inset 0 0 0 2px var(--eph-ink-700), 2px 2px 0 var(--eph-ink-900)',
  background: 'var(--eph-marble-50)',
  padding: '12px',
  overflowY: 'auto'
} as const

const titleTab = {
  fontFamily: 'var(--eph-face-display)',
  fontSize: '8px',
  fontWeight: 'normal',
  display: 'inline-block',
  margin: '-12px 0 12px -12px',
  padding: '4px 8px',
  background: 'var(--eph-ink-900)',
  color: 'var(--eph-marble-50)'
} as const

const card = {
  border: '1px solid var(--eph-ink-700)',
  background: 'var(--eph-parchment-100)',
  padding: '10px',
  marginBottom: '10px'
} as const

const body = {
  margin: 0,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontFamily: 'var(--eph-face-data)',
  fontSize: '12px'
} as const

const note = { color: 'var(--eph-ink-500)', margin: '4px 0' } as const

export function BriefsPanel(): ReactElement {
  const [briefs, setBriefs] = useState<readonly BriefRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback((): void => {
    // No bridge means the preload did not load; the shell shows that banner.
    const eph = window.eph
    if (!eph) return
    eph.odeon
      .briefs()
      .then(setBriefs)
      .catch((err: unknown) => setError(String(err)))
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(timer)
  }, [refresh])

  return (
    <div style={panel}>
      <h2 style={titleTab}>BRIEFS</h2>
      {error !== null && <p style={note}>⚠ {error}</p>}
      {briefs === null && <p style={note}>reading the archive…</p>}
      {briefs !== null && briefs.length === 0 && (
        <p style={note}>
          No standup briefs yet. One is compiled on the standup trigger and narrated by the
          orchestrator; every sentence must cite a fact the compiler issued.
        </p>
      )}
      {briefs?.map((brief) => (
        <div key={brief.ref} style={card}>
          <p style={{ ...note, color: 'var(--eph-ink-700)' }}>{brief.archivedAt}</p>
          <pre style={body}>{brief.markdown}</pre>
        </div>
      ))}
    </div>
  )
}

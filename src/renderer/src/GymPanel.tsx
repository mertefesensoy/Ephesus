import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { GymRowView } from '../../shared/gym-view'
import type { ModeView } from '../../shared/mode-view'

/**
 * The Gymnasium tab (UI-DESIGN §4, ADR-0015, FR-12, UC-13).
 *
 * The Architect's bench, and the only bench there is: nothing self-approves
 * (R1), so every proposal in this list is waiting on the person reading it.
 * Artemis may rank and pre-screen; she has no control here and no channel to
 * one.
 *
 * Rejected and regressed rows stay on the list. ADR-0015 R2 calls them training
 * data for better proposals, and a ledger that hid its failures would be a
 * highlight reel.
 */

const REFRESH_MS = 5_000

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
  marginBottom: '8px'
} as const

const button = {
  fontFamily: 'var(--eph-face-display)',
  fontSize: '8px',
  padding: '4px 8px',
  marginRight: '4px',
  border: '2px solid var(--eph-ink-900)',
  background: 'var(--eph-marble-200)'
} as const

const note = { color: 'var(--eph-ink-500)', margin: '4px 0' } as const

export function GymPanel(): ReactElement {
  const [rows, setRows] = useState<readonly GymRowView[]>([])
  const [mode, setMode] = useState<ModeView | null>(null)
  const [open, setOpen] = useState<Record<string, string>>({})
  const [outcome, setOutcome] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback((): void => {
    // No bridge means the preload did not load; the shell shows that banner.
    const eph = window.eph
    if (!eph) return
    eph.gym
      .ledger()
      .then(setRows)
      .catch((err: unknown) => setError(String(err)))
    eph.gym
      .mode()
      .then(setMode)
      .catch((err: unknown) => setError(String(err)))
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const show = useCallback((id: string): void => {
    const eph = window.eph
    if (!eph) return
    eph.gym
      .proposal(id)
      .then((doc) => setOpen((prev) => ({ ...prev, [id]: doc ?? 'not on file' })))
      .catch((err: unknown) => setError(String(err)))
  }, [])

  const decide = useCallback(
    (id: string, verdict: 'approved' | 'rejected'): void => {
      const eph = window.eph
      if (!eph) return
      eph.gym
        .verdict(id, verdict)
        .then((result) => {
          setOutcome(result.ok ? `${id}: ${result.status}` : `${id}: ${result.reason}`)
          refresh()
        })
        .catch((err: unknown) => setError(String(err)))
    },
    [refresh]
  )

  const changeMode = useCallback(
    (next: 'directed' | 'improving'): void => {
      const eph = window.eph
      if (!eph) return
      eph.gym
        .setMode(next)
        .then((result) => {
          setOutcome(
            result.ok
              ? `mode: ${result.mode}`
              : `${result.reason}${result.missing.length > 0 ? ` — still missing: ${result.missing.join('; ')}` : ''}`
          )
          refresh()
        })
        .catch((err: unknown) => setError(String(err)))
    },
    [refresh]
  )

  const waiting = rows.filter((row) => row.status === 'proposed')

  return (
    <div style={panel}>
      <h2 style={titleTab}>GYMNASIUM</h2>
      {error !== null && <p style={note}>⚠ {error}</p>}
      {outcome !== null && <p style={note}>{outcome}</p>}
      <p style={note}>
        Nothing self-approves (ADR-0015 R1): every proposal here is yours to decide, and the ledger
        keeps rejected and regressed rows as training data for better ones.
      </p>
      {mode !== null && (
        <div style={card}>
          <p style={{ margin: '0 0 4px' }}>
            <strong>Company mode</strong> — {mode.mode}
          </p>
          <p style={note}>
            {mode.mode === 'improving'
              ? 'The Stoa and Gymnasium cadences run on their own initiative. Gating is unchanged: every proposal still reaches you (FR-14.4).'
              : 'Those cadences run only on demand. The mode governs initiative, never approval.'}
          </p>
          {mode.mode === 'directed' && !mode.gateMet && (
            <>
              <p style={note}>Still missing before improving can be enabled (SRS §6.9):</p>
              <ul style={{ ...note, paddingLeft: '18px' }}>
                {mode.missing.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          )}
          {mode.mode === 'directed' ? (
            <button type="button" style={button} onClick={() => changeMode('improving')}>
              ENABLE IMPROVING
            </button>
          ) : (
            <button type="button" style={button} onClick={() => changeMode('directed')}>
              REVERT TO DIRECTED
            </button>
          )}
        </div>
      )}
      {rows.length === 0 && <p style={note}>No proposals on file.</p>}
      {waiting.length > 0 && <p style={note}>Waiting on you — {waiting.length}</p>}

      {rows.map((row) => (
        <div key={row.id} style={card}>
          <p style={{ margin: '0 0 4px' }}>
            <strong>{row.id}</strong> — {row.title}
          </p>
          <p style={note}>
            {row.status} · metric: {row.metric}
            {row.outcome === null ? '' : ` · outcome: ${row.outcome}`}
          </p>
          <button type="button" style={button} onClick={() => show(row.id)}>
            READ
          </button>
          {row.status === 'proposed' && (
            <>
              <button type="button" style={button} onClick={() => decide(row.id, 'approved')}>
                APPROVE
              </button>
              <button type="button" style={button} onClick={() => decide(row.id, 'rejected')}>
                REJECT
              </button>
            </>
          )}
          {open[row.id] !== undefined && (
            <pre style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0', fontSize: '12px' }}>
              {open[row.id]}
            </pre>
          )}
        </div>
      ))}
    </div>
  )
}

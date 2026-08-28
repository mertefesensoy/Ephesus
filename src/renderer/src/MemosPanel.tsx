import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { MemoQueueRow } from '../../shared/odeon'
import type { MemoVerdictName } from '../../shared/memo'

/**
 * The Memos tab (UI-DESIGN §4, ADR-0008 §3, FR-7.3, UC-06 steps 3–4).
 *
 * This is the Architect bench. Memos inside the orchestrator's delegated
 * authority never reach it — she settles those and the harness countersigns
 * (FR-5.5) — so what is listed here is exactly what nobody else was allowed to
 * decide.
 *
 * A projection like every other panel (invariant §2): the markdown shown is the
 * archived artifact itself, read through IPC, so the panel can never display a
 * memo that differs from the one on disk.
 */

const VERDICTS: readonly MemoVerdictName[] = ['approved', 'rejected', 'amended']

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
  maxHeight: '260px',
  overflowY: 'auto',
  fontFamily: 'var(--eph-face-data)',
  fontSize: '12px'
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

export function MemosPanel(): ReactElement {
  const [rows, setRows] = useState<readonly MemoQueueRow[] | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [outcome, setOutcome] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback((): void => {
    // No bridge means the preload did not load; the shell shows that banner.
    const eph = window.eph
    if (!eph) return
    eph.odeon
      .memos('all')
      .then(setRows)
      .catch((err: unknown) => setError(String(err)))
  }, [])

  useEffect(() => {
    refresh()
    const eph = window.eph
    if (!eph) return
    // A nudge, not a payload: the panel re-reads, so it cannot hold a second
    // copy of the queue that disagrees with the archive.
    return eph.odeon.onQueue(refresh)
  }, [refresh])

  const decide = useCallback(
    (memoId: string, verdict: MemoVerdictName): void => {
      const eph = window.eph
      if (!eph) return
      eph.odeon
        .verdict(memoId, verdict, notes[memoId] ?? '')
        .then((result) => {
          setOutcome(
            result.ok
              ? `${memoId}: ${verdict} — the held action was ${result.gateVerdict}`
              : `${memoId}: ${result.reason}`
          )
          refresh()
        })
        .catch((err: unknown) => setError(String(err)))
    },
    [notes, refresh]
  )

  const open = rows?.filter((row) => !row.decided) ?? []
  const decided = rows?.filter((row) => row.decided) ?? []

  return (
    <div style={panel}>
      <h2 style={titleTab}>MEMOS</h2>
      {error !== null && <p style={note}>⚠ {error}</p>}
      {outcome !== null && <p style={note}>{outcome}</p>}
      {rows === null && <p style={note}>reading the archive…</p>}
      {rows !== null && rows.length === 0 && (
        <p style={note}>
          No memos filed. A choice matching memo policy is held until one is written and decided
          (ADR-0008 §3).
        </p>
      )}

      {open.length > 0 && <p style={note}>Awaiting your verdict — {open.length}</p>}
      {open.map((row) => (
        <div key={row.memoId} style={card}>
          <p style={{ ...note, color: 'var(--eph-ink-700)' }}>{row.memoId}</p>
          <pre style={body}>{row.markdown}</pre>
          <label htmlFor={`notes-${row.memoId}`} style={note}>
            Notes (recorded with the verdict)
          </label>
          <textarea
            id={`notes-${row.memoId}`}
            rows={2}
            value={notes[row.memoId] ?? ''}
            onChange={(event) =>
              setNotes((prev) => ({ ...prev, [row.memoId]: event.target.value }))
            }
            style={{
              display: 'block',
              width: '100%',
              fontFamily: 'var(--eph-face-data)',
              fontSize: '12px',
              border: '1px solid var(--eph-ink-700)',
              background: 'var(--eph-marble-100)',
              padding: '6px',
              marginBottom: '6px'
            }}
          />
          {VERDICTS.map((verdict) => (
            <button
              key={verdict}
              type="button"
              style={button}
              onClick={() => decide(row.memoId, verdict)}
            >
              {verdict.toUpperCase()}
            </button>
          ))}
        </div>
      ))}

      {decided.length > 0 && <p style={note}>Decided — {decided.length}</p>}
      {decided.map((row) => (
        <div key={row.memoId} style={{ ...card, background: 'var(--eph-marble-200)' }}>
          <p style={{ ...note, color: 'var(--eph-ink-700)' }}>
            {row.memoId} · {row.verdict} by {row.decidedBy}
            {row.countersigned ? ' · countersigned' : ''}
          </p>
        </div>
      ))}
    </div>
  )
}

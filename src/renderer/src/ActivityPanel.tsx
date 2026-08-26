import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { LogEntry } from '../../shared/log'

/**
 * The Activity tab (UI-DESIGN §4) — a live view of `log.jsonl`, the company's
 * book of record (SDD §4.3).
 *
 * It is a **pointer to the log, never a second record**. Nothing is stored here
 * that is not already a line in that file; the panel holds a cursor and pages
 * forward from it, so what you read on screen and what a forensic reader finds
 * on disk are the same rows in the same order (NFR-13).
 *
 * Appends are batched (SDD §11 "log rendering virtualized + batched"): main
 * says only "the log grew" and this panel then pulls whatever it has not seen,
 * so a burst of thirty events costs one render rather than thirty.
 */

/** How many rows to keep in the DOM. Older rows stay in the log, not here. */
const WINDOW_SIZE = 300
/** Batching window for a burst of appends (SDD §11). */
const BATCH_MS = 120

/** The refs worth putting in front of a human, per kind (SDD §4.3). */
function summarise(entry: LogEntry): string {
  const ref = (name: string): string => {
    const value = entry[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  }
  switch (entry.kind) {
    case 'delivery':
      return `${ref('from')} → ${ref('to')} · ${ref('act')} · ${ref('subject')}`
    case 'bounce':
      return `${ref('from')} → ${ref('to')} · ${ref('reason')}`
    case 'spawn':
      return `${ref('agentId')} · ${ref('engine')} ${ref('engineVersion')} · ${ref('role')}`
    case 'exit':
      return `${ref('agentId')} · exit ${ref('exitCode')}`
    case 'hook':
      return `${ref('agentId')} · ${ref('event')} ${ref('decision')} ${ref('because')}`.trim()
    case 'breaker':
      return `${ref('agentId')} · ${ref('signal')} · rung ${ref('rung')}`
    case 'error':
      return `${ref('subsystem')} · ${ref('reason')}`
    default:
      return ref('agentId') || ref('subject') || ''
  }
}

export function ActivityPanel(): ReactElement {
  const [entries, setEntries] = useState<readonly LogEntry[]>([])
  const cursorRef = useRef(0)
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const eph = window.eph
    if (!eph) return

    const pull = (): void => {
      void eph.agora.log(cursorRef.current, WINDOW_SIZE).then((batch) => {
        if (batch.length === 0) return
        cursorRef.current = batch[batch.length - 1]?.seq ?? cursorRef.current
        setEntries((current) => [...current, ...batch].slice(-WINDOW_SIZE))
      })
    }

    pull()
    const off = eph.agora.onAppend(() => {
      // Coalesce a burst into one pull, and therefore one render (SDD §11).
      if (pendingRef.current) return
      pendingRef.current = setTimeout(() => {
        pendingRef.current = null
        pull()
      }, BATCH_MS)
    })

    return () => {
      off()
      if (pendingRef.current) clearTimeout(pendingRef.current)
    }
  }, [])

  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minWidth: 0,
        border: '2px solid var(--eph-ink-900)',
        boxShadow: '2px 2px 0 var(--eph-ink-900)',
        background: 'var(--eph-marble-50)'
      }}
    >
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--eph-ink-700)',
          padding: '4px 8px',
          fontFamily: 'var(--eph-face-display)',
          fontSize: '8px'
        }}
      >
        <span>ACTIVITY</span>
        <span style={{ fontFamily: 'var(--eph-face-data)', fontSize: '12px' }}>
          {entries.length === 0
            ? 'no events yet'
            : `${entries.length} shown · seq ≤ ${cursorRef.current}`}
        </span>
      </header>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px' }}>
        {entries.length === 0 && (
          <p
            style={{
              fontFamily: 'var(--eph-face-data)',
              fontSize: '12px',
              color: 'var(--eph-ink-700)',
              margin: '8px'
            }}
          >
            Every autonomous action lands here, and in <code>agora/log.jsonl</code>.
          </p>
        )}
        {entries.map((entry) => (
          <div
            key={entry.seq}
            style={{
              display: 'flex',
              gap: '8px',
              alignItems: 'baseline',
              fontFamily: 'var(--eph-face-data)',
              fontSize: '12px',
              padding: '2px 4px',
              borderBottom: '1px solid var(--eph-marble-200)'
            }}
          >
            <span style={{ color: 'var(--eph-ink-700)', minWidth: '48px' }}>#{entry.seq}</span>
            <span style={{ color: 'var(--eph-aegean)', minWidth: '84px' }}>{entry.kind}</span>
            <span style={{ flex: 1, wordBreak: 'break-word' }}>{summarise(entry)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

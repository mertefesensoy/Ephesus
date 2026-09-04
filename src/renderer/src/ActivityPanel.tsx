import { useEffect, useRef, useState, type ReactElement } from 'react'
import { logRowSummary, type LogEntry } from '../../shared/log'

/**
 * The Activity tab (UI-DESIGN §4) — a live view of `log.jsonl`, the company's
 * book of record (SDD §4.3).
 *
 * It is a **pointer to the log, never a second record**. Nothing is stored here
 * that is not already a line in that file, so what you read on screen and what
 * a forensic reader finds on disk are the same rows in the same order (NFR-13).
 *
 * It opens at the END of the book and then follows forward (M8.3). Opening at
 * seq 0 is what register item B4 describes: after an overnight run the panel
 * showed the company's FIRST 300 events and crawled towards the present one
 * append at a time. The row text lives in `shared/log.ts` beside the kind list,
 * because it has to be total over it — the version that lived here had seven
 * cases and a fallback, and 19% of rows rendered blank.
 *
 * Appends are batched (SDD §11 "log rendering virtualized + batched"): main
 * says only "the log grew" and this panel then pulls whatever it has not seen,
 * so a burst of thirty events costs one render rather than thirty.
 */

/** How many rows to keep in the DOM. Older rows stay in the log, not here. */
const WINDOW_SIZE = 300
/** Batching window for a burst of appends (SDD §11). */
const BATCH_MS = 120

export function ActivityPanel(): ReactElement {
  const [entries, setEntries] = useState<readonly LogEntry[]>([])
  const cursorRef = useRef(0)
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const eph = window.eph
    if (!eph) return

    /** Set once the opening tail read has landed; see `onAppend` below. */
    let opened = false
    /** An append arrived before it did, and is owed a pull. */
    let missed = false

    /**
     * Adds a batch, and is MONOTONIC on purpose.
     *
     * Two reads can be in flight at once, and they may answer in either order.
     * A batch that is not newer than what the panel has already shown is
     * dropped rather than appended, and the cursor never moves backwards —
     * without that, a forward page issued at seq 0 answering after the tail
     * would rewind the cursor to 300 and put the company's FIRST rows back on
     * screen, which is register item B4 arriving through the back door.
     */
    const absorb = (batch: readonly LogEntry[]): void => {
      const fresh = batch.filter((entry) => entry.seq > cursorRef.current)
      if (fresh.length === 0) return
      cursorRef.current = fresh[fresh.length - 1]?.seq ?? cursorRef.current
      setEntries((current) => [...current, ...fresh].slice(-WINDOW_SIZE))
    }

    /** Follows the log forward from what this panel has already shown. */
    const pull = (): void => {
      void eph.agora.log(cursorRef.current, WINDOW_SIZE).then(absorb)
    }

    // A live view of a book of record opens at the END of the book. Paging
    // forward from seq 0 is right for following along and wrong for arriving:
    // it showed an overnight run's FIRST 300 events and then crawled towards
    // the present one append at a time (register item B4). The tail read is the
    // one M8.2 added for the degradation replay, which had the same question.
    void eph.agora.logTail(WINDOW_SIZE).then((batch) => {
      absorb(batch)
      opened = true
      // Whatever landed while the tail was in flight is newer than the tail,
      // so one forward page from the new cursor collects all of it.
      if (missed) {
        missed = false
        pull()
      }
    })
    const off = eph.agora.onAppend(() => {
      // Before the panel has opened there is no cursor to page from: a pull
      // now would ask for seq 0 and race the tail. Remember it instead.
      if (!opened) {
        missed = true
        return
      }
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
            <span style={{ flex: 1, wordBreak: 'break-word' }}>{logRowSummary(entry)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

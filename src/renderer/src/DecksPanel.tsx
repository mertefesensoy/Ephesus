import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { DeckRecord } from '../../shared/odeon'

/**
 * The Decks tab (UI-DESIGN §4, ADR-0008 §2, FR-7.2, UC-05 step 4).
 *
 * A projection, like every other panel (invariant §2): it holds no archive
 * state, every read is an IPC call, and the one thing it can write — a review
 * comment — does not touch the ledger. It goes to Artemis as mail, because
 * FR-5.2 gives her the ledger and SDD §5 routes human-authored mail through
 * her. The Architect says what they think; the orchestrator decides what task
 * that becomes.
 *
 * The deck itself renders in a SANDBOXED iframe with no script permission. A
 * deck is agent-authored HTML, and the harness escaping its content on the way
 * in is one wall; refusing to execute it on the way out is the second.
 */

const REFRESH_MS = 5000

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
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0
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

const row = {
  display: 'flex',
  gap: '8px',
  alignItems: 'baseline',
  width: '100%',
  textAlign: 'left',
  padding: '6px 8px',
  border: '1px solid var(--eph-ink-700)',
  marginBottom: '4px',
  fontFamily: 'var(--eph-face-data)',
  fontSize: '12px'
} as const

const frame = {
  flex: 1,
  minHeight: '260px',
  width: '100%',
  border: '1px solid var(--eph-ink-700)',
  background: 'var(--eph-parchment-100)'
} as const

const note = { color: 'var(--eph-ink-500)', margin: '4px 0' } as const

export function DecksPanel(): ReactElement {
  const [decks, setDecks] = useState<readonly DeckRecord[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [html, setHtml] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [sent, setSent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback((): void => {
    // No bridge means the preload did not load; the shell already shows that
    // banner, and every panel simply has nothing to render (M3 pattern).
    const eph = window.eph
    if (!eph) return
    eph.odeon
      .decks()
      .then(setDecks)
      .catch((err: unknown) => setError(String(err)))
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    if (selected === null) {
      setHtml(null)
      return
    }
    const eph = window.eph
    if (!eph) return
    eph.odeon
      .deck(selected)
      .then(setHtml)
      .catch((err: unknown) => setError(String(err)))
  }, [selected])

  const send = useCallback((): void => {
    if (selected === null || comment.trim().length === 0) return
    const eph = window.eph
    if (!eph) return
    eph.odeon
      .comment(selected, comment.trim())
      .then((outcome) => {
        setSent(outcome.queued ? `sent to ${outcome.to}` : outcome.because)
        if (outcome.queued) setComment('')
      })
      .catch((err: unknown) => setError(String(err)))
  }, [selected, comment])

  return (
    <div style={panel}>
      <h2 style={titleTab}>DECKS</h2>
      {error !== null && <p style={note}>⚠ {error}</p>}
      {decks === null && <p style={note}>reading the archive…</p>}
      {decks !== null && decks.length === 0 && (
        <p style={note}>
          No review decks archived yet. A task flagged <code>review:deck</code> cannot close until
          its assignee files one.
        </p>
      )}
      {decks !== null &&
        decks.map((deck) => (
          <button
            key={deck.ref}
            type="button"
            onClick={() => setSelected(deck.ref)}
            aria-current={selected === deck.ref}
            style={{
              ...row,
              background: selected === deck.ref ? 'var(--eph-marble-50)' : 'var(--eph-marble-200)'
            }}
          >
            <span style={{ flex: 1 }}>{deck.taskId}</span>
            <span style={{ color: 'var(--eph-ink-500)' }}>{deck.archivedAt}</span>
          </button>
        ))}

      {selected !== null && (
        <>
          {/* No allow-scripts: the archive escapes content on the way in, and
              this refuses to execute it on the way out. */}
          <iframe title={`deck ${selected}`} sandbox="" srcDoc={html ?? ''} style={frame} />
          <label htmlFor="deck-comment" style={note}>
            Comment — goes to the orchestrator, who decides the follow-up task (FR-5.2)
          </label>
          <textarea
            id="deck-comment"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            rows={3}
            style={{
              fontFamily: 'var(--eph-face-data)',
              fontSize: '12px',
              border: '1px solid var(--eph-ink-700)',
              background: 'var(--eph-marble-100)',
              padding: '6px'
            }}
          />
          <button
            type="button"
            onClick={send}
            disabled={comment.trim().length === 0}
            style={{
              fontFamily: 'var(--eph-face-display)',
              fontSize: '8px',
              padding: '4px 8px',
              marginTop: '4px',
              alignSelf: 'flex-start',
              border: '2px solid var(--eph-ink-900)',
              background: 'var(--eph-marble-200)'
            }}
          >
            FILE COMMENT
          </button>
          {sent !== null && <p style={note}>{sent}</p>}
        </>
      )}
    </div>
  )
}

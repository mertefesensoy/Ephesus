import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { MeetingView } from '../../shared/odeon'

/**
 * The Meeting panel (UI-DESIGN §4, ADR-0008 §4, FR-7.4, UC-07).
 *
 * A projection of the driver (invariant §2): it holds no meeting state, and the
 * one thing it can do — put the Architect's words on the record — goes through
 * main, which decides whether that grabs the floor.
 *
 * Held replies are SHOWN, under their own heading. An agent that answered early
 * has said something real, and hiding it until its turn came would make the
 * panel look like the answer was lost — which is exactly what holding exists to
 * avoid.
 */

const REFRESH_MS = 1_000

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

const turn = {
  borderLeft: '3px solid var(--eph-aegean)',
  paddingLeft: '8px',
  marginBottom: '6px'
} as const

const heldTurn = {
  ...turn,
  borderLeftColor: 'var(--eph-status-waiting)',
  opacity: 0.85
} as const

const who = {
  fontFamily: 'var(--eph-face-display)',
  fontSize: '8px',
  color: 'var(--eph-ink-700)'
} as const

const field = {
  fontFamily: 'var(--eph-face-data)',
  fontSize: '12px',
  border: '1px solid var(--eph-ink-700)',
  background: 'var(--eph-marble-100)',
  padding: '6px',
  width: '100%',
  marginBottom: '4px'
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

export function MeetingPanel(): ReactElement {
  const [meeting, setMeeting] = useState<MeetingView | null>(null)
  const [attendees, setAttendees] = useState('')
  const [agenda, setAgenda] = useState('')
  const [say, setSay] = useState('')
  const [to, setTo] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback((): void => {
    // No bridge means the preload did not load; the shell shows that banner.
    const eph = window.eph
    if (!eph) return
    eph.odeon
      .meeting()
      .then(setMeeting)
      .catch((err: unknown) => setError(String(err)))
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const open = meeting !== null && meeting.status === 'open'

  const doConvene = useCallback((): void => {
    const eph = window.eph
    if (!eph) return
    const list = attendees
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
    if (list.length === 0 || agenda.trim().length === 0) return
    eph.odeon
      .convene(list, agenda.trim())
      .then((outcome) => {
        if (!outcome.ok) setError(outcome.reason)
        refresh()
      })
      .catch((err: unknown) => setError(String(err)))
  }, [attendees, agenda, refresh])

  const doSay = useCallback((): void => {
    const eph = window.eph
    if (!eph || say.trim().length === 0) return
    eph.odeon
      .meetingSay(say.trim(), to.trim() === '' ? undefined : to.trim())
      .then((outcome) => {
        if (outcome.kind === 'refused') setError(outcome.reason ?? 'refused')
        else setSay('')
        refresh()
      })
      .catch((err: unknown) => setError(String(err)))
  }, [say, to, refresh])

  const doClose = useCallback((): void => {
    const eph = window.eph
    if (!eph) return
    eph.odeon
      .meetingClose([])
      .then((outcome) => {
        if (!outcome.ok) setError(outcome.reason)
        refresh()
      })
      .catch((err: unknown) => setError(String(err)))
  }, [refresh])

  return (
    <div style={panel}>
      <h2 style={titleTab}>ODEON</h2>
      {error !== null && <p style={note}>⚠ {error}</p>}

      {!open && (
        <>
          <p style={note}>Convene a meeting — attendees (comma-separated) and one agenda line.</p>
          <input
            aria-label="attendees"
            style={field}
            value={attendees}
            onChange={(event) => setAttendees(event.target.value)}
            placeholder="agent.mason, agent.scribe"
          />
          <input
            aria-label="agenda"
            style={field}
            value={agenda}
            onChange={(event) => setAgenda(event.target.value)}
            placeholder="What is blocking the checkout fix?"
          />
          <button type="button" style={button} onClick={doConvene}>
            CONVENE
          </button>
        </>
      )}

      {meeting !== null && (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: '8px' }}>
          <p style={note}>
            {meeting.id} · {meeting.status}
            {meeting.floor === null ? '' : ` · floor: ${meeting.floor}`}
          </p>
          {meeting.transcript.map((entry, index) => (
            <div key={`${entry.at}-${String(index)}`} style={turn}>
              <p style={who}>{entry.from.toUpperCase()}</p>
              <p style={{ margin: 0 }}>{entry.text}</p>
            </div>
          ))}
          {meeting.held.length > 0 && (
            <>
              <p style={note}>Said early — waiting for the floor ({meeting.held.length})</p>
              {meeting.held.map((entry, index) => (
                <div key={`held-${entry.at}-${String(index)}`} style={heldTurn}>
                  <p style={who}>{entry.from.toUpperCase()}</p>
                  <p style={{ margin: 0 }}>{entry.text}</p>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {open && (
        <>
          <input
            aria-label="say"
            style={field}
            value={say}
            onChange={(event) => setSay(event.target.value)}
            placeholder="Take the floor…"
          />
          <input
            aria-label="hand the floor to"
            style={field}
            value={to}
            onChange={(event) => setTo(event.target.value)}
            placeholder="hand the floor to (optional)"
          />
          <div>
            <button type="button" style={button} onClick={doSay}>
              SAY
            </button>
            <button type="button" style={button} onClick={doClose}>
              CLOSE
            </button>
          </div>
        </>
      )}
    </div>
  )
}

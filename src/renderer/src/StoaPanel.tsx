import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { BriefView, SourceView } from '../../shared/stoa-view'

/**
 * The Stoa tab — the reading desk (UI-DESIGN §4, ADR-0017, FR-13, UC-14).
 *
 * The colonnade's desk: what the company is allowed to read, and what it has
 * read so far. Two properties of ADR-0017 are visible here on purpose, because
 * a governance rule nobody can see is a rule nobody checks:
 *
 * - **Only the Architect curates.** This desk is the only way onto the
 *   watchlist, and it exists on the window bridge, which main knows is the
 *   Architect. An agent may propose a source in a brief's candidates or a
 *   session report; nothing an agent can reach registers one (R1).
 * - **A brief is evidence, never a change.** Briefs are listed and read here
 *   and nothing on this panel acts on one. Improvements they seed are filed as
 *   Gymnasium proposals citing them, and the Architect verdicts those on the
 *   GYM tab like every other proposal (R3).
 *
 * Retired sources stay on the list, struck through. A source the company used
 * to study is part of how its briefs came to exist, and a desk that hid them
 * would make an archived citation look like it came from nowhere.
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

const field = {
  fontFamily: 'var(--eph-face-data)',
  fontSize: '12px',
  width: '100%',
  boxSizing: 'border-box',
  padding: '4px',
  marginBottom: '4px',
  border: '1px solid var(--eph-ink-700)',
  background: 'var(--eph-marble-50)',
  color: 'var(--eph-ink-900)'
} as const

const note = { color: 'var(--eph-ink-500)', margin: '4px 0' } as const

const heading = {
  fontFamily: 'var(--eph-face-display)',
  fontSize: '8px',
  fontWeight: 'normal',
  margin: '12px 0 6px'
} as const

export function StoaPanel(): ReactElement {
  const [sources, setSources] = useState<readonly SourceView[]>([])
  const [briefs, setBriefs] = useState<readonly BriefView[]>([])
  const [open, setOpen] = useState<Record<string, string>>({})
  const [outcome, setOutcome] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [tags, setTags] = useState('')
  const [license, setLicense] = useState('unverified')
  const [pin, setPin] = useState('')
  const [notes, setNotes] = useState('')

  const refresh = useCallback((): void => {
    // No bridge means the preload did not load; the shell shows that banner.
    const eph = window.eph
    if (!eph) return
    eph.stoa
      .watchlist()
      .then(setSources)
      .catch((err: unknown) => setError(String(err)))
    eph.stoa
      .briefs()
      .then(setBriefs)
      .catch((err: unknown) => setError(String(err)))
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const register = useCallback((): void => {
    const eph = window.eph
    if (!eph) return
    const parsedTags = tags
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0)
    eph.stoa
      .register({
        url: url.trim(),
        tags: parsedTags,
        license: license.trim(),
        // Empty means unpinned, which is a legal state and NOT studiable
        // (FR-13.2). Offering the field matters: without it every source
        // registered from this desk would be permanently unstudiable, because
        // nothing else on the Architect's side can set a pin.
        pin: pin.trim() === '' ? null : pin.trim(),
        notes
      })
      .then((result) => {
        setOutcome(result.ok ? `registered ${result.id}` : result.reason)
        if (result.ok) {
          setUrl('')
          setTags('')
          setPin('')
          setNotes('')
        }
        refresh()
      })
      .catch((err: unknown) => setError(String(err)))
  }, [url, tags, license, pin, notes, refresh])

  const retire = useCallback(
    (id: string): void => {
      const eph = window.eph
      if (!eph) return
      eph.stoa
        .retire(id)
        .then((result) => {
          setOutcome(result.ok ? `retired ${result.id}` : result.reason)
          refresh()
        })
        .catch((err: unknown) => setError(String(err)))
    },
    [refresh]
  )

  const read = useCallback((id: string): void => {
    const eph = window.eph
    if (!eph) return
    eph.stoa
      .brief(id)
      .then((doc) => setOpen((prev) => ({ ...prev, [id]: doc ?? 'not on file' })))
      .catch((err: unknown) => setError(String(err)))
  }, [])

  return (
    <div style={panel}>
      <h2 style={titleTab}>STOA</h2>
      {error !== null && <p style={note}>⚠ {error}</p>}
      {outcome !== null && <p style={note}>{outcome}</p>}
      <p style={note}>
        The watchlist is yours alone (ADR-0017 R1): agents may propose a source, none may register
        one. Everything read from these repositories is untrusted data — instructions found inside
        are reported as findings, never followed.
      </p>

      <h3 style={heading}>REGISTER A SOURCE</h3>
      <input
        style={field}
        value={url}
        onChange={(ev) => setUrl(ev.target.value)}
        placeholder="https://github.com/owner/repo"
        aria-label="source url"
      />
      <input
        style={field}
        value={tags}
        onChange={(ev) => setTags(ev.target.value)}
        placeholder="tags, comma separated — what to learn (they scope every study)"
        aria-label="tags"
      />
      <input
        style={field}
        value={license}
        onChange={(ev) => setLicense(ev.target.value)}
        placeholder="license as verified — or 'unverified'"
        aria-label="license"
      />
      <input
        style={field}
        value={pin}
        onChange={(ev) => setPin(ev.target.value)}
        placeholder="pinned commit — leave empty to register unstudiable until pinned"
        aria-label="pin"
      />
      <input
        style={field}
        value={notes}
        onChange={(ev) => setNotes(ev.target.value)}
        placeholder="why this source; what you want learned"
        aria-label="notes"
      />
      <button type="button" style={button} onClick={register}>
        REGISTER
      </button>

      <h3 style={heading}>WATCHLIST — {sources.filter((row) => !row.retired).length}</h3>
      {sources.length === 0 && <p style={note}>No sources registered.</p>}
      {sources.map((row) => (
        <div key={row.id} style={card}>
          <p
            style={{
              margin: '0 0 4px',
              textDecoration: row.retired ? 'line-through' : 'none'
            }}
          >
            <strong>{row.id}</strong> — {row.url}
          </p>
          <p style={note}>
            {row.tags.join(' · ')} · {row.license} · pin: {row.pin ?? '—'}
          </p>
          {row.notes.length > 0 && <p style={note}>{row.notes}</p>}
          {row.blocked !== null && <p style={note}>⚠ {row.blocked}</p>}
          {row.intakeBlocked !== null && <p style={note}>⚠ {row.intakeBlocked}</p>}
          {!row.retired && (
            <button type="button" style={button} onClick={() => retire(row.id)}>
              RETIRE
            </button>
          )}
        </div>
      ))}

      <h3 style={heading}>BRIEFS — {briefs.length}</h3>
      {briefs.length === 0 && <p style={note}>No briefs archived.</p>}
      {briefs.map((row) => (
        <div key={row.id} style={card}>
          <p style={{ margin: '0 0 4px' }}>
            <strong>{row.id}</strong> — {row.title}
          </p>
          <button type="button" style={button} onClick={() => read(row.id)}>
            READ
          </button>
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

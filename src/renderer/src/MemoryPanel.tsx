import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { KnowledgeDoc, MemoryView } from '../../shared/memory'
import type { RecallResponse, RecallRung } from '../../shared/recall'

/**
 * The Memory tab (UI-DESIGN §4, ADR-0006, SDD §5 `agora: memory(id)`).
 *
 * Three things the documents ask for, and nothing invented beyond them:
 * a per-agent memory view with its archive, recall search over the same path
 * `eph-recall` uses, and **the ladder state, visible** — which rung answered
 * and why it was not a higher one (FR-6, invariant §7).
 *
 * It is a projection (invariant §2): it holds no memory state, every read is an
 * IPC call, and the one thing it can write — registering a shelf document —
 * goes back through main, which validates the name and commits through the
 * single committer.
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

const sectionHead = {
  fontFamily: 'var(--eph-face-display)',
  fontSize: '8px',
  fontWeight: 'normal',
  margin: '16px 0 8px 0',
  padding: '4px 6px',
  background: 'var(--eph-marble-200)',
  border: '1px solid var(--eph-ink-700)'
} as const

const document = {
  margin: 0,
  padding: '8px',
  border: '1px solid var(--eph-ink-700)',
  background: 'var(--eph-marble-100)',
  maxHeight: '240px',
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontSize: '11px'
} as const

const control = {
  fontFamily: 'var(--eph-face-data)',
  fontSize: '12px',
  padding: '4px 8px',
  border: '1px solid var(--eph-ink-700)',
  background: 'var(--eph-marble-50)',
  color: 'var(--eph-ink-900)'
} as const

/**
 * The ladder's three rungs in status colors (UI-DESIGN §2.4). `mempalace` is
 * the undegraded state; the two below it are degradations, and they are
 * coloured as such — a chip that looked the same on every rung would be a
 * degradation nobody notices.
 */
const RUNG_COLOR: Record<RecallRung, string> = {
  mempalace: 'var(--eph-status-success)',
  fts: 'var(--eph-status-working)',
  grep: 'var(--eph-status-looping)'
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function MemoryPanel(): ReactElement {
  const [agentIds, setAgentIds] = useState<readonly string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<MemoryView | null>(null)
  const [shelf, setShelf] = useState<readonly KnowledgeDoc[]>([])
  const [openArchive, setOpenArchive] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [scoped, setScoped] = useState(false)
  const [answer, setAnswer] = useState<RecallResponse | null>(null)
  const [searching, setSearching] = useState(false)

  const [docName, setDocName] = useState('')
  const [docText, setDocText] = useState('')
  const [shelfError, setShelfError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    // No bridge means the preload did not load; the shell already shows that
    // banner, and every panel simply has nothing to render (M3 pattern).
    const eph = window.eph
    if (!eph) return
    const registry = await eph.agora.registry()
    const ids = Object.keys(registry.agents).sort()
    setAgentIds(ids)
    setShelf(await eph.agora.knowledge())
    setSelected((current) => current ?? ids[0] ?? null)
  }, [])

  useEffect(() => {
    const tick = (): void => {
      void refresh().catch((err: unknown) => setShelfError(reasonOf(err)))
    }
    tick()
    const timer = setInterval(tick, REFRESH_MS)
    return () => clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    const eph = window.eph
    if (selected === null || !eph) {
      setView(null)
      return
    }
    void eph.agora
      .memory(selected)
      .then(setView)
      .catch(() => setView(null))
  }, [selected])

  const search = useCallback(async () => {
    const eph = window.eph
    if (!eph || query.trim().length === 0) return
    setSearching(true)
    try {
      setAnswer(await eph.agora.recall(query, scoped ? selected : null, 8))
    } finally {
      setSearching(false)
    }
  }, [query, scoped, selected])

  const register = useCallback(async () => {
    const eph = window.eph
    if (!eph) return
    setShelfError(null)
    try {
      setShelf(await eph.agora.registerKnowledge(docName, docText))
      setDocName('')
      setDocText('')
    } catch (err) {
      // A refused name is the Architect's to see, not something to swallow.
      setShelfError(reasonOf(err))
    }
  }, [docName, docText])

  return (
    <section style={panel} aria-label="Memory">
      <h2 style={titleTab}>MEMORY</h2>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <label htmlFor="memory-agent">agent</label>
        <select
          id="memory-agent"
          style={control}
          value={selected ?? ''}
          onChange={(event) => {
            setSelected(event.target.value)
            setOpenArchive(null)
          }}
        >
          {agentIds.length === 0 && <option value="">(nobody hired yet)</option>}
          {agentIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        {view && (
          <span>
            {view.sections} section(s) · {view.reflection.chars} chars ·{' '}
            {view.reflection.due ? 'reflection due' : view.reflection.because}
          </span>
        )}
      </div>

      <h3 style={sectionHead}>RECALL</h3>
      <form
        style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}
        onSubmit={(event) => {
          event.preventDefault()
          void search()
        }}
      >
        <input
          aria-label="recall query"
          style={{ ...control, flex: '1 1 240px' }}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="what do we know about…"
        />
        <label>
          <input
            type="checkbox"
            checked={scoped}
            onChange={(event) => setScoped(event.target.checked)}
          />{' '}
          this agent only
        </label>
        <button type="submit" style={control} disabled={searching}>
          {searching ? 'searching…' : 'search'}
        </button>
      </form>

      {answer && (
        <div style={{ marginTop: '8px' }}>
          <p style={{ margin: '0 0 8px 0' }}>
            <span
              aria-label="recall rung"
              style={{
                display: 'inline-block',
                padding: '2px 6px',
                marginRight: '8px',
                border: '1px solid var(--eph-ink-700)',
                background: RUNG_COLOR[answer.rung],
                color: 'var(--eph-ink-900)'
              }}
            >
              {answer.rung}
            </span>
            {answer.hits.length} result(s)
            {answer.degraded !== null && (
              /* Invariant §7: the step down the ladder is stated, not implied. */
              <span style={{ color: 'var(--eph-ink-700)' }}> — {answer.degraded}</span>
            )}
          </p>
          {answer.hits.map((hit) => (
            <div key={`${hit.ref}:${hit.title}`} style={{ marginBottom: '8px' }}>
              <div style={{ fontWeight: 'bold' }}>
                {hit.scope} · {hit.title} ({hit.source})
              </div>
              <div style={{ opacity: 0.7 }}>{hit.ref}</div>
              <pre style={document}>{hit.snippet}</pre>
            </div>
          ))}
        </div>
      )}

      <h3 style={sectionHead}>MEMORY.MD</h3>
      {view === null ? (
        <p>(no agent selected)</p>
      ) : (
        <pre style={document}>{view.text || '(empty)'}</pre>
      )}

      <h3 style={sectionHead}>ARCHIVE</h3>
      {view === null || view.archive.length === 0 ? (
        <p>(nothing condensed yet)</p>
      ) : (
        <div>
          {view.archive.map((file) => (
            <div key={file.name} style={{ marginBottom: '4px' }}>
              <button
                type="button"
                style={control}
                aria-expanded={openArchive === file.name}
                onClick={() => setOpenArchive(openArchive === file.name ? null : file.name)}
              >
                {file.name}
              </button>
              {openArchive === file.name && <pre style={document}>{file.text}</pre>}
            </div>
          ))}
        </div>
      )}

      <h3 style={sectionHead}>KNOWLEDGE SHELF</h3>
      {shelf.length === 0 ? (
        <p>(nothing registered yet)</p>
      ) : (
        <ul style={{ margin: '0 0 8px 0', paddingLeft: '16px' }}>
          {shelf.map((doc) => (
            <li key={doc.name}>
              {doc.name} — {doc.bytes} bytes
            </li>
          ))}
        </ul>
      )}
      <form
        style={{ display: 'flex', gap: '8px', flexDirection: 'column' }}
        onSubmit={(event) => {
          event.preventDefault()
          void register()
        }}
      >
        <input
          aria-label="document name"
          style={control}
          value={docName}
          onChange={(event) => setDocName(event.target.value)}
          placeholder="release-runbook"
        />
        <textarea
          aria-label="document text"
          style={{ ...control, minHeight: '80px' }}
          value={docText}
          onChange={(event) => setDocText(event.target.value)}
          placeholder="# Release runbook…"
        />
        <button
          type="submit"
          style={control}
          disabled={docName.length === 0 || docText.length === 0}
        >
          register
        </button>
        {shelfError !== null && (
          <span style={{ color: 'var(--eph-status-blocked)' }}>{shelfError}</span>
        )}
      </form>
    </section>
  )
}

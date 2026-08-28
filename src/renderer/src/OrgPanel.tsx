import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { OrgNode } from '../../shared/org'
import type { RetroRow, RetroView } from '../../shared/odeon'

/**
 * The Org tab (UI-DESIGN §4, FR-11.5, UC-12).
 *
 * Every number here is folded from `log.jsonl` and the durable cost ledger on
 * each read — there is no counter behind it, in main or here. A rate shows as
 * `—` rather than `0` when nothing has completed, because zero would read as
 * "perfectly efficient" about an agent that has finished nothing.
 *
 * The panel shows and archives. It never acts: no reassignment, no hire, no
 * nudge. UC-12 puts a human between the numbers and any decision, and this is
 * deliberately the half that cannot decide.
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

const sectionHead = {
  fontFamily: 'var(--eph-face-display)',
  fontSize: '8px',
  fontWeight: 'normal',
  margin: '16px 0 8px 0',
  padding: '4px 6px',
  background: 'var(--eph-marble-200)',
  border: '1px solid var(--eph-ink-700)'
} as const

const cell = { padding: '3px 6px', border: '1px solid var(--eph-ink-300)' } as const

const button = {
  fontFamily: 'var(--eph-face-display)',
  fontSize: '8px',
  padding: '4px 8px',
  border: '2px solid var(--eph-ink-900)',
  background: 'var(--eph-marble-200)'
} as const

const note = { color: 'var(--eph-ink-500)', margin: '4px 0' } as const

function rate(value: number | null): string {
  return value === null ? '—' : value.toFixed(2)
}

export function OrgPanel(): ReactElement {
  const [chart, setChart] = useState<readonly OrgNode[]>([])
  const [view, setView] = useState<RetroView | null>(null)
  const [retros, setRetros] = useState<readonly RetroRow[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback((): void => {
    // No bridge means the preload did not load; the shell shows that banner.
    const eph = window.eph
    if (!eph) return
    Promise.all([eph.org.chart(), eph.org.metrics(), eph.org.retros()])
      .then(([nextChart, nextView, nextRetros]) => {
        setChart(nextChart)
        setView(nextView)
        setRetros(nextRetros)
      })
      .catch((err: unknown) => setError(String(err)))
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const generate = useCallback((): void => {
    const eph = window.eph
    if (!eph) return
    eph.org
      .generateRetro()
      .then((outcome) => {
        if (!outcome.ok) setError(outcome.reason)
        refresh()
      })
      .catch((err: unknown) => setError(String(err)))
  }, [refresh])

  return (
    <div style={panel}>
      <h2 style={titleTab}>ORG</h2>
      {error !== null && <p style={note}>⚠ {error}</p>}

      <h3 style={sectionHead}>CHART</h3>
      {chart.length === 0 && <p style={note}>Nobody is hired yet.</p>}
      {chart.map((node) => (
        <p key={node.agentId} style={{ margin: '2px 0' }}>
          {node.orchestrator ? '★ ' : '· '}
          {node.name} — {node.role} ({node.seat})
        </p>
      ))}

      <h3 style={sectionHead}>METRICS</h3>
      <p style={note}>Folded from log.jsonl and the cost ledger on every read.</p>
      <table style={{ borderCollapse: 'collapse', fontSize: '12px' }}>
        <thead>
          <tr>
            {['agent', 'done', 'rework', 'escal.', 'esc/task', 'tokens', 'tok/task'].map((head) => (
              <th key={head} style={{ ...cell, background: 'var(--eph-marble-200)' }}>
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(view?.metrics ?? []).map((row) => (
            <tr key={row.agentId}>
              <td style={cell}>{row.agentId}</td>
              <td style={cell}>{row.tasksDone}</td>
              <td style={cell}>{row.rework}</td>
              <td style={cell}>{row.escalations}</td>
              <td style={cell}>{rate(row.escalationRate)}</td>
              <td style={cell}>{row.tokens}</td>
              <td style={cell}>{rate(row.tokensPerTask)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={sectionHead}>FINDINGS</h3>
      {(view?.findings ?? []).length === 0 && <p style={note}>Nothing the record flags.</p>}
      {(view?.findings ?? []).map((finding) => (
        <p key={finding.what} style={{ margin: '2px 0' }}>
          · {finding.what} <span style={note}>[{finding.refs.join(', ')}]</span>
        </p>
      ))}

      <h3 style={sectionHead}>RETROS</h3>
      <button type="button" style={button} onClick={generate}>
        GENERATE NOW
      </button>
      {retros.length === 0 && <p style={note}>None archived yet.</p>}
      {retros.map((retro) => (
        <details key={retro.ref} style={{ marginTop: '8px' }}>
          <summary>{retro.generatedAt}</summary>
          <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0', fontSize: '12px' }}>
            {retro.markdown}
          </pre>
        </details>
      ))}
    </div>
  )
}

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { tasksByStatus } from '../../shared/ledger'
import { emptyLedger, TASK_STATUSES, type Task, type TaskLedger } from '../../shared/tasks'

/**
 * The kanban Ledger tab (FR-4.3, SDD §4.2).
 *
 * FR-4.3 names what it must show — dependencies, assignee, status, priority,
 * result refs and review flags — and says the ledger "SHALL drive the kanban
 * UI". Drive is the operative word: this panel holds no task state of its own.
 * Every column comes from `agora:tasks`, and a `state:tasks` push only tells it
 * to re-read, so it can never disagree with main about what the ledger says
 * (invariant §2, the renderer is a projection).
 *
 * Nothing here can write. Tasks are Artemis's to propose and the endpoint's to
 * apply (SDD §7.1); a board the Architect could drag cards on would be a second
 * writer to a file ADR-0004 gives exactly one.
 */

/** Re-read floor. The `state:tasks` push is the fast path; this is the backstop. */
const LEDGER_POLL_MS = 5000

const panel = {
  fontFamily: 'var(--eph-face-data)',
  fontSize: '12px',
  /**
   * A flex child defaults to `min-width: auto`, which means "never shrink below
   * my content" — and six kanban columns are wider than the shell. Without this
   * the board pushed the terminal pane to a sliver and gave the whole window a
   * horizontal scrollbar. The columns scroll inside the panel instead.
   */
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

const columnHead = {
  fontFamily: 'var(--eph-face-display)',
  fontSize: '8px',
  fontWeight: 'normal',
  margin: '0 0 6px 0',
  padding: '4px 6px',
  background: 'var(--eph-marble-200)',
  border: '1px solid var(--eph-ink-700)'
} as const

const card = {
  border: '1px solid var(--eph-ink-700)',
  background: 'var(--eph-marble-100)',
  padding: '6px',
  marginBottom: '6px'
} as const

/**
 * Status colours from UI-DESIGN §2.4. The column NAME carries the same fact, so
 * the board is readable with no colour at all (§8, NFR-15) — the stripe is a
 * second encoding, never the only one.
 */
const STATUS_STRIPE: Readonly<Record<Task['status'], string>> = {
  todo: 'var(--eph-status-idle)',
  in_progress: 'var(--eph-status-working)',
  blocked: 'var(--eph-status-blocked)',
  review: 'var(--eph-status-waiting)',
  done: 'var(--eph-status-success)',
  stalled: 'var(--eph-status-looping)'
}

function TaskCard({ task }: { task: Task }): ReactElement {
  // FR-4.3's full set: deps, assignee, status, priority, result ref, review
  // flags. A field with nothing in it is omitted rather than shown as a blank —
  // an empty row reads as data the panel failed to load.
  const facts: string[] = [`p${String(task.priority)}`]
  if (task.assignee) facts.push(task.assignee)
  if (task.deps.length > 0) facts.push(`deps: ${task.deps.join(', ')}`)
  if (task.review.length > 0) facts.push(`review: ${task.review.join('+')}`)
  if (task.gates.length > 0) facts.push(`gated: ${task.gates.length}`)
  if (task.artifacts.resultRef) facts.push(`result: ${task.artifacts.resultRef}`)
  if (task.artifacts.deck) facts.push('deck ✓')
  if (task.artifacts.memos.length > 0) facts.push(`memos: ${task.artifacts.memos.join(', ')}`)

  return (
    <li style={card}>
      <div style={{ borderLeft: `3px solid ${STATUS_STRIPE[task.status]}`, paddingLeft: '6px' }}>
        <div>{task.title}</div>
        <div style={{ color: 'var(--eph-ink-700)', fontSize: '11px', marginTop: '2px' }}>
          {task.id}
        </div>
        <div style={{ color: 'var(--eph-ink-700)', fontSize: '11px', marginTop: '2px' }}>
          {facts.join(' · ')}
        </div>
      </div>
    </li>
  )
}

export function LedgerPanel(): ReactElement {
  const [ledger, setLedger] = useState<TaskLedger>(emptyLedger)
  const [board, setBoard] = useState('')
  const [error, setError] = useState<string | null>(null)
  /** Newest-read-wins: a slow read must never overwrite a newer one. */
  const generation = useRef(0)

  const refresh = useCallback(() => {
    const eph = window.eph
    if (!eph) return
    const mine = ++generation.current
    void Promise.all([eph.agora.tasks(), eph.agora.board()])
      .then(([tasks, body]) => {
        if (mine !== generation.current) return
        setLedger(tasks)
        setBoard(body)
        setError(null)
      })
      .catch((err: unknown) => {
        if (mine !== generation.current) return
        // A ledger that will not read is shown, never swallowed (invariant §7).
        setError(err instanceof Error ? err.message : String(err))
      })
  }, [])

  useEffect(() => {
    refresh()
    const eph = window.eph
    const timer = setInterval(refresh, LEDGER_POLL_MS)
    const off = eph?.agora.onTasks(refresh)
    return () => {
      clearInterval(timer)
      off?.()
    }
  }, [refresh])

  return (
    <div style={{ ...panel, display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <span style={titleTab}>LEDGER</span>

      {error && (
        <div style={{ color: 'var(--eph-status-blocked)' }}>ledger unavailable: {error}</div>
      )}

      <div
        style={{
          display: 'flex',
          gap: '8px',
          alignItems: 'flex-start',
          overflowX: 'auto',
          // The scroll happens here, so nothing above it has to widen.
          minWidth: 0
        }}
      >
        {TASK_STATUSES.map((status) => {
          const column = tasksByStatus(ledger, status)
          return (
            <div key={status} style={{ flex: '0 0 180px' }}>
              <h3 style={columnHead}>
                {status.replace('_', ' ')} ({column.length})
              </h3>
              {column.length === 0 ? (
                <div style={{ color: 'var(--eph-ink-700)', fontSize: '11px' }}>—</div>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {column.map((task) => (
                    <TaskCard key={task.id} task={task} />
                  ))}
                </ul>
              )}
            </div>
          )
        })}
      </div>

      <div>
        <h3 style={columnHead}>board.md — scribe: Artemis</h3>
        <pre
          style={{
            margin: 0,
            padding: '8px',
            border: '1px solid var(--eph-ink-700)',
            background: 'var(--eph-marble-100)',
            whiteSpace: 'pre-wrap',
            fontFamily: 'var(--eph-face-data)',
            fontSize: '11px'
          }}
        >
          {board.trim().length > 0 ? board : 'nothing posted yet'}
        </pre>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { BreakerState } from '../../shared/breaker'
import type { AgentSpend } from '../../shared/cost'
import { RUNG_NAMES } from '../../shared/breaker'
import type { GateVerdict, OpenGate } from '../../shared/gates'
import type { Message } from '../../shared/message'

/**
 * The approvals post (UI-DESIGN §4, SRS UC-08).
 *
 * "Every item shows *what, why, blast radius, rollback* before the approve/deny
 * controls" — so this panel renders all four, always, and the controls sit
 * after them. It also carries the Architect's own diverted-mail queue
 * (`agora/human/`), which accumulated unread from M2 until this surface, and
 * the two spend figures FR-11.2 requires side by side.
 *
 * The panel holds no authoritative state (invariant §2). Every gate it shows
 * came from `watch:approvals`, every verdict goes back through
 * `watch:approve` for main to validate, and after a verdict it re-reads rather
 * than editing its own copy — so it can never disagree with main about what is
 * open.
 */

/** Re-read cadence. The `gate:open` push is the fast path; this is the floor. */
const WATCH_POLL_MS = 3000

interface WatchState {
  readonly gates: readonly OpenGate[]
  readonly queue: readonly Message[]
  readonly spend: readonly AgentSpend[]
  readonly breaker: readonly BreakerState[]
}

const EMPTY: WatchState = { gates: [], queue: [], spend: [], breaker: [] }

const panel = {
  fontFamily: 'var(--eph-face-data)',
  fontSize: '12px',
  border: '2px solid var(--eph-ink-900)',
  background: 'var(--eph-marble-50)',
  padding: '12px',
  overflowY: 'auto'
} as const

const heading = {
  fontFamily: 'var(--eph-face-display)',
  fontSize: '8px',
  margin: '0 0 8px 0'
} as const

/** One labelled line of a gate's packaging. */
function Field({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div style={{ display: 'flex', gap: '8px', marginBottom: '4px' }}>
      <span style={{ color: 'var(--eph-ink-500)', minWidth: '88px' }}>{label}</span>
      <span style={{ color: 'var(--eph-ink-900)' }}>{value}</span>
    </div>
  )
}

function tokens(spend: AgentSpend, which: 'sessionTotals' | 'cumulativeTotals'): string {
  const totals = spend[which]
  return `${(totals.inTokens + totals.outTokens).toLocaleString()} tok`
}

export function WatchPanel(): ReactElement {
  const [state, setState] = useState<WatchState>(EMPTY)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [bridge, setBridge] = useState<string | null>(null)

  const refresh = useCallback(() => {
    const eph = window.eph
    if (!eph) {
      setBridge('window.eph bridge not exposed')
      return
    }
    void Promise.all([
      eph.watch.approvals(),
      eph.watch.humanQueue(),
      eph.watch.budgets(),
      eph.watch.breakerState()
    ])
      .then(([gates, queue, spend, breaker]) => {
        setBridge(null)
        setState({ gates, queue, spend, breaker })
      })
      .catch((err: unknown) => setBridge(String(err)))
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, WATCH_POLL_MS)
    // The push is a nudge that the queue changed; the panel then re-reads it
    // from main rather than trusting a payload (invariant §2).
    const off = window.eph?.watch.onGateChange(refresh)
    return () => {
      clearInterval(timer)
      off?.()
    }
  }, [refresh])

  const decide = useCallback(
    (gateId: string, verdict: GateVerdict) => {
      const eph = window.eph
      if (!eph) return
      void eph.watch
        .approve(gateId, verdict)
        .then((result) => {
          // A refusal is shown, not swallowed: "we could not take that verdict"
          // is exactly the state the Architect must see (invariant §7).
          setRefusal(result.ok ? null : result.reason)
          refresh()
        })
        .catch((err: unknown) => setRefusal(String(err)))
    },
    [refresh]
  )

  return (
    <section style={{ ...panel, flex: 1, minWidth: 0 }} aria-label="Watch">
      {bridge !== null && (
        <p style={{ color: 'var(--eph-status-blocked)', margin: '0 0 8px 0' }}>
          watch unavailable: {bridge}
        </p>
      )}

      <h2 style={heading}>SPEND</h2>
      {state.spend.length === 0 && (
        <p style={{ color: 'var(--eph-ink-500)', margin: '0 0 16px 0' }}>no agents yet</p>
      )}
      {state.spend.length > 0 && (
        <table
          style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '16px' }}
          aria-label="spend"
        >
          <thead>
            <tr style={{ color: 'var(--eph-ink-500)', textAlign: 'left' }}>
              <th style={{ fontWeight: 'normal', padding: '0 8px 4px 0' }}>agent</th>
              <th style={{ fontWeight: 'normal', padding: '0 8px 4px 0' }}>session</th>
              <th style={{ fontWeight: 'normal', padding: '0 8px 4px 0' }}>cumulative</th>
              <th style={{ fontWeight: 'normal', padding: '0 0 4px 0' }}>budget</th>
            </tr>
          </thead>
          <tbody>
            {state.spend.map((spend) => (
              <tr key={spend.agent}>
                <td style={{ padding: '0 8px 4px 0' }}>{spend.agent}</td>
                {/* FR-11.2 / ADR-0011: session and cumulative, side by side. */}
                <td style={{ padding: '0 8px 4px 0' }}>
                  {spend.reporting === 'none' ? '—' : tokens(spend, 'sessionTotals')}
                </td>
                <td style={{ padding: '0 8px 4px 0' }}>
                  {spend.reporting === 'none' ? '—' : tokens(spend, 'cumulativeTotals')}
                </td>
                <td
                  style={{
                    padding: '0 0 4px 0',
                    color:
                      spend.budget.state === 'breached'
                        ? 'var(--eph-status-blocked)'
                        : spend.budget.state === 'projected-breach'
                          ? 'var(--eph-status-looping)'
                          : 'var(--eph-ink-500)'
                  }}
                  // Double-encoded: the word carries the state, not the colour
                  // alone (UI-DESIGN §8, NFR-15).
                  title={`because: ${spend.budget.because}`}
                >
                  {spend.reporting === 'none' ? 'engine reports no usage' : spend.budget.state}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={heading}>BREAKER</h2>
      {state.breaker.length === 0 && (
        <p style={{ color: 'var(--eph-ink-500)', margin: '0 0 16px 0' }}>no agents yet</p>
      )}
      {state.breaker.length > 0 && (
        <table
          style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '16px' }}
          aria-label="breaker"
        >
          <thead>
            <tr style={{ color: 'var(--eph-ink-500)', textAlign: 'left' }}>
              <th style={{ fontWeight: 'normal', padding: '0 8px 4px 0' }}>agent</th>
              <th style={{ fontWeight: 'normal', padding: '0 8px 4px 0' }}>rung</th>
              <th style={{ fontWeight: 'normal', padding: '0 8px 4px 0' }}>firing</th>
              <th style={{ fontWeight: 'normal', padding: '0 0 4px 0' }}>protection</th>
            </tr>
          </thead>
          <tbody>
            {state.breaker.map((agent) => (
              <tr key={agent.agentId}>
                <td style={{ padding: '0 8px 4px 0' }}>{agent.agentId}</td>
                {/* The rung NAME, not just a number or a colour (UI-DESIGN §8). */}
                <td
                  style={{
                    padding: '0 8px 4px 0',
                    color: agent.rung === 0 ? 'var(--eph-ink-500)' : 'var(--eph-status-looping)'
                  }}
                >
                  {agent.rung === 0 ? 'clear' : `${String(agent.rung)} · ${RUNG_NAMES[agent.rung]}`}
                </td>
                <td style={{ padding: '0 8px 4px 0' }}>
                  {agent.firing.length === 0
                    ? '—'
                    : agent.firing.map((hit) => hit.signal).join(', ')}
                </td>
                <td style={{ padding: '0 0 4px 0' }}>
                  {/* ADR-0011's stated consequence: a weaker engine's reduced
                      protection is surfaced here, never hidden. */}
                  {agent.reducedProtection ? (
                    <span
                      style={{ color: 'var(--eph-status-looping)' }}
                      title={`blind to: ${agent.blindSignals.join(', ')}`}
                    >
                      ⚠ reduced ({agent.blindSignals.length} signals blind)
                    </span>
                  ) : (
                    `full · ${String(agent.spanCount)} spans`
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={heading}>
        GATES{state.gates.length > 0 ? ` (${String(state.gates.length)})` : ''}
      </h2>
      {refusal !== null && (
        <p style={{ color: 'var(--eph-status-blocked)', margin: '0 0 8px 0' }}>
          verdict refused: {refusal}
        </p>
      )}
      {state.gates.length === 0 && (
        <p style={{ color: 'var(--eph-ink-500)', margin: '0 0 16px 0' }}>nothing waiting on you</p>
      )}
      {state.gates.map((gate) => (
        <article
          key={gate.id}
          style={{
            border: '1px solid var(--eph-ink-700)',
            padding: '8px',
            marginBottom: '8px',
            background: 'var(--eph-parchment-100)'
          }}
        >
          <div style={{ color: 'var(--eph-ink-500)', marginBottom: '8px' }}>
            {gate.agentId} · {gate.kind} · held: {gate.because} · via {gate.channel}
            {gate.requiresRepeatBack ? ' · repeat-back required' : ''}
          </div>
          {/* UC-08 packaging, in full, BEFORE the controls. */}
          <Field label="what" value={gate.packaging.what} />
          <Field label="why" value={gate.packaging.why} />
          <Field label="blast radius" value={gate.packaging.blastRadius} />
          <Field label="rollback" value={gate.packaging.rollback} />
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
            <button
              type="button"
              onClick={() => decide(gate.id, 'approved')}
              style={{
                fontFamily: 'var(--eph-face-display)',
                fontSize: '8px',
                padding: '4px 8px',
                border: '2px solid var(--eph-ink-900)',
                background: 'var(--eph-marble-100)'
              }}
            >
              APPROVE
            </button>
            <button
              type="button"
              onClick={() => decide(gate.id, 'denied')}
              style={{
                fontFamily: 'var(--eph-face-display)',
                fontSize: '8px',
                padding: '4px 8px',
                border: '2px solid var(--eph-ink-900)',
                background: 'var(--eph-marble-100)'
              }}
            >
              DENY
            </button>
          </div>
        </article>
      ))}

      <h2 style={{ ...heading, marginTop: '16px' }}>
        YOUR QUEUE{state.queue.length > 0 ? ` (${String(state.queue.length)})` : ''}
      </h2>
      {state.queue.length === 0 && (
        <p style={{ color: 'var(--eph-ink-500)', margin: 0 }}>no mail diverted to you</p>
      )}
      {state.queue.map((message) => (
        <article
          key={message.id}
          style={{ border: '1px solid var(--eph-ink-700)', padding: '8px', marginBottom: '8px' }}
        >
          <div style={{ color: 'var(--eph-ink-500)', marginBottom: '4px' }}>
            {message.from} · {message.act} · hops {message.hops}
            {message.needs_human ? ' · flagged for you' : ''}
          </div>
          <div style={{ color: 'var(--eph-ink-900)' }}>{message.subject}</div>
          <div style={{ color: 'var(--eph-ink-700)', marginTop: '4px', whiteSpace: 'pre-wrap' }}>
            {message.body}
          </div>
        </article>
      ))}
    </section>
  )
}

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { SecretsPanel } from './SecretsPanel'
import { SettingsPanel } from './SettingsPanel'
import type { BreakerState, BreakerStop, BreakerStopsView } from '../../shared/breaker'
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
  readonly stops: BreakerStopsView
}

const EMPTY: WatchState = {
  gates: [],
  queue: [],
  spend: [],
  breaker: [],
  stops: { stops: [], error: null }
}

/**
 * UI-DESIGN §4 panel anatomy: "3-layer border (ink-900 2px → marble-50 1px
 * light seam → ink-700 1px), title tab top-left in Display face, hard 2px
 * ink-900 offset shadow." The inner two layers are insets so the outer stroke
 * stays exactly 2px on the pixel grid.
 */
const panel = {
  fontFamily: 'var(--eph-face-data)',
  fontSize: '12px',
  border: '2px solid var(--eph-ink-900)',
  boxShadow:
    'inset 0 0 0 1px var(--eph-marble-50), inset 0 0 0 2px var(--eph-ink-700), 2px 2px 0 var(--eph-ink-900)',
  background: 'var(--eph-marble-50)',
  padding: '12px',
  overflowY: 'auto'
} as const

/**
 * `fontWeight: 'normal'` is explicit: only Regular files are bundled
 * (UI-DESIGN §3 "no faux bold/italic"), and an <h2> would otherwise be
 * synthesized bold by the browser.
 */
const heading = {
  fontFamily: 'var(--eph-face-display)',
  fontSize: '8px',
  fontWeight: 'normal',
  margin: '0 0 8px 0'
} as const

/** The §4 title tab: the panel says its own name, not only the nav button. */
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

/** A gate's approve/deny control. The hue distinguishes them; the word names them. */
const control = {
  fontFamily: 'var(--eph-face-display)',
  fontSize: '8px',
  fontWeight: 'normal',
  color: 'var(--eph-ink-900)',
  padding: '4px 8px',
  border: '2px solid var(--eph-ink-900)',
  background: 'var(--eph-marble-100)'
} as const

/** One labelled line of a gate's packaging. */
function Field({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div style={{ display: 'flex', gap: '8px', marginBottom: '4px' }}>
      <span style={{ color: 'var(--eph-ink-700)', minWidth: '96px' }}>{label}</span>
      <span style={{ color: 'var(--eph-ink-900)' }}>{value}</span>
    </div>
  )
}

/** The hue that reinforces a budget word. Never the only carrier of meaning. */
function budgetHue(state: AgentSpend['budget']['state']): string {
  if (state === 'breached') return 'var(--eph-status-blocked)'
  if (state === 'projected-breach') return 'var(--eph-status-looping)'
  return 'var(--eph-ink-700)'
}

function tokens(spend: AgentSpend, which: 'sessionTotals' | 'cumulativeTotals'): string {
  const totals = spend[which]
  return `${(totals.inTokens + totals.outTokens).toLocaleString()} tok`
}

export function BreakerStops({
  view,
  onClear
}: {
  view: BreakerStopsView
  onClear(stop: BreakerStop): Promise<void>
}): ReactElement {
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  return (
    <section aria-label="Standing breaker stops">
      <h2 style={heading}>STOPPED AGENTS</h2>
      {view.error !== null && <p role="alert">{view.error}</p>}
      {error !== null && <p role="alert">{error}</p>}
      {view.stops.length === 0 && view.error === null && <p>No standing stops.</p>}
      {view.stops.map((stop) => (
        <article key={stop.agentId} style={{ marginBottom: '12px' }}>
          <Field label="agent" value={stop.agentId} />
          <Field label="stopped" value={new Date(stop.at).toLocaleString()} />
          <Field label="reason" value={`rung 3 · ${stop.signals.join(', ')}`} />
          <p>
            Resolve the cause before clearing. Clearing permits a restart; it does not start the
            agent. Use the agent card to restart, or activate its profile if it is no longer on the
            floor.
          </p>
          <button
            type="button"
            style={control}
            disabled={pending !== null || view.error !== null}
            onClick={() => {
              setPending(stop.agentId)
              setError(null)
              void onClear(stop)
                .catch((err: unknown) => setError(String(err)))
                .finally(() => setPending(null))
            }}
          >
            {pending === stop.agentId ? 'Clearing…' : `Clear stop for ${stop.agentId}`}
          </button>
        </article>
      ))}
    </section>
  )
}

export function WatchPanel(): ReactElement {
  const [state, setState] = useState<WatchState>(EMPTY)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [bridge, setBridge] = useState<string | null>(null)

  /** Monotonic, so a slow earlier read cannot overwrite a newer one. */
  const generation = useRef(0)

  const refresh = useCallback(() => {
    const eph = window.eph
    if (!eph) {
      setBridge('window.eph bridge not exposed')
      return
    }
    generation.current += 1
    const mine = generation.current
    void Promise.all([
      eph.watch.approvals(),
      eph.watch.humanQueue(),
      eph.watch.budgets(),
      eph.watch.breakerState(),
      eph.watch.breakerStops()
    ])
      .then(([gates, queue, spend, breaker, stops]) => {
        // A stale read must not re-show a gate main has already settled.
        if (mine !== generation.current) return
        setBridge(null)
        setState({ gates, queue, spend, breaker, stops })
      })
      .catch((err: unknown) => {
        if (mine === generation.current) setBridge(String(err))
      })
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

  const dismiss = useCallback(
    (messageId: string) => {
      void window.eph?.watch
        .dismiss(messageId)
        .then(() => refresh())
        .catch((err: unknown) => setRefusal(String(err)))
    },
    [refresh]
  )

  return (
    <section style={{ ...panel, flex: 1, minWidth: 0 }} aria-label="Watch">
      <div style={titleTab}>WATCH</div>
      {bridge !== null && (
        <p style={{ color: 'var(--eph-ink-900)', margin: '0 0 8px 0' }}>
          ⚠ watch unavailable: {bridge}
        </p>
      )}

      {/* The broker's only surface. It lives in the Watch because the Watch is
          what already owns it (`src/main/watch/secrets.ts`), and because a
          credential store nobody can reach is how five hires spent an evening
          spawning with `grantsMissing: ["GH_TOKEN"]`. */}
      <SecretsPanel />

      {/* The two ceilings, beside the credentials and above the spend they
          cap. In the Watch because the Watch already owns the policy file
          (`main/watch/gates.ts`), and because the question "what may the
          company do, and what is it doing" has one answer or none. */}
      <SettingsPanel />

      <BreakerStops
        view={state.stops}
        onClear={async (stop) => {
          if (!window.eph) throw new Error('Watch unavailable')
          const cleared = await window.eph.watch.clearBreakerStop(stop.agentId, stop.at)
          refresh()
          if (!cleared)
            throw new Error('This stop is no longer present; the list has been refreshed.')
        }}
      />

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
                {/* The WORD carries the state and clears AA in ink-900; the
                    status hue is a leading glyph beside it, never the only
                    carrier of meaning (UI-DESIGN §8, NFR-15). `because` is
                    visible text, not a hover-only title. */}
                <td style={{ padding: '0 0 4px 0', color: 'var(--eph-ink-900)' }}>
                  {spend.budget.state !== 'ok' && spend.reporting !== 'none' && (
                    <span aria-hidden="true" style={{ color: budgetHue(spend.budget.state) }}>
                      {'\u25CF '}
                    </span>
                  )}
                  {spend.reporting === 'none' ? 'engine reports no usage' : spend.budget.state}
                  {spend.reporting !== 'none' && (
                    <span style={{ color: 'var(--eph-ink-700)' }}> ({spend.budget.because})</span>
                  )}
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
                <td style={{ padding: '0 8px 4px 0', color: 'var(--eph-ink-900)' }}>
                  {agent.rung !== 0 && (
                    <span aria-hidden="true" style={{ color: 'var(--eph-status-looping)' }}>
                      {'\u25CF '}
                    </span>
                  )}
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
                  {agent.reducedProtection
                    ? `⚠ reduced · blind to ${agent.blindSignals.join(', ')}`
                    : `full · ${String(agent.spanCount)} spans`}
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
        <p style={{ color: 'var(--eph-ink-900)', margin: '0 0 8px 0' }} role="alert">
          ⚠ verdict refused: {refusal}
        </p>
      )}
      {state.gates.length === 0 && (
        <p style={{ color: 'var(--eph-ink-500)', margin: '0 0 16px 0' }}>nothing waiting on you</p>
      )}
      {state.gates.map((gate) => (
        <article
          key={gate.id}
          aria-label={`gate: ${gate.packaging.what}`}
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
            {/* UI-DESIGN §2.3 names `laurel` for approvals granted and `wine`
                for destructive; on a gate the irreversible control must not
                look identical to the safe one. The hue is the BORDER — the
                letters stay ink-900, which clears AA. */}
            <button
              type="button"
              onClick={() => decide(gate.id, 'approved')}
              aria-label={`approve: ${gate.packaging.what}`}
              style={{ ...control, borderColor: 'var(--eph-laurel)' }}
            >
              APPROVE
            </button>
            <button
              type="button"
              onClick={() => decide(gate.id, 'denied')}
              aria-label={`deny: ${gate.packaging.what}`}
              style={{ ...control, borderColor: 'var(--eph-wine)' }}
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
          aria-label={`diverted mail: ${message.subject}`}
          style={{ border: '1px solid var(--eph-ink-700)', padding: '8px', marginBottom: '8px' }}
        >
          <div style={{ color: 'var(--eph-ink-700)', marginBottom: '4px' }}>
            {message.from} · {message.act} · hops {message.hops}
            {message.needs_human ? ' · flagged for you' : ''}
          </div>
          <div style={{ color: 'var(--eph-ink-900)' }}>{message.subject}</div>
          <div style={{ color: 'var(--eph-ink-700)', marginTop: '4px', whiteSpace: 'pre-wrap' }}>
            {message.body}
          </div>
          {/* The queue has to be drainable, not only readable: a queue you can
              read but never clear is only half of "no more invisible mail".
              Archived, never deleted — atomic rename into `.done/`. */}
          <button
            type="button"
            onClick={() => dismiss(message.id)}
            aria-label={`archive: ${message.subject}`}
            style={{ ...control, marginTop: '8px' }}
          >
            ARCHIVE
          </button>
        </article>
      ))}
    </section>
  )
}

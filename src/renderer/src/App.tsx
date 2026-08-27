import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { AgoraHealth, ConfigSnapshot, HooksState } from '../../shared/ipc'
import { loadPixelFonts, PIXEL_FACES, type FontStatus } from './fonts'
import { ActivityPanel } from './ActivityPanel'
import { CommandBar } from './CommandBar'
import { TerminalPanel } from './TerminalPanel'
import { WatchPanel } from './WatchPanel'
import { FloorCanvas } from './floor/FloorCanvas'

type BridgeState =
  | { kind: 'loading' }
  | { kind: 'ready'; snapshot: ConfigSnapshot }
  | { kind: 'unavailable'; reason: string }

/** Flattens the data-plane health into one visible line per issue. */
function agoraIssues(health: AgoraHealth): readonly string[] {
  return [
    ...health.fileWarnings.map((w) => `${w.file}: ${w.reason}`),
    ...health.commitFailures.map((f) => `commit "${f.subject}": ${f.reason}`),
    ...health.runtime.map((r) => `${r.source}: ${r.detail}`)
  ]
}

/**
 * Event-plane health, refreshed on a slow poll. FR-2.3 requires hook schema
 * drift to be *visible*, and SDD §10 requires an endpoint that is down to say so
 * rather than leaving a silently frozen floor.
 */
const HOOKS_POLL_MS = 2000

export function App(): ReactElement {
  const [bridge, setBridge] = useState<BridgeState>({ kind: 'loading' })
  const [hooks, setHooks] = useState<HooksState | null>(null)
  const [health, setHealth] = useState<AgoraHealth | null>(null)
  const [fonts, setFonts] = useState<FontStatus | null>(null)
  /** The agent the terminal and the command bar both act on (UC-03 step 2). */
  const [selected, setSelected] = useState<string | null>(null)
  /**
   * Command Center tabs (UI-DESIGN §4). Only the two that exist are shown —
   * offering a tab for a subsystem that has not been built would be inventing
   * UI (BUILD-PROMPT §7); the rest arrive with their milestones.
   */
  const [tab, setTab] = useState<'floor' | 'activity' | 'watch'>('floor')
  /**
   * Open gates, for the status strip's badge (UI-DESIGN §4). `'error'` is a
   * distinct state from `null`: a stale gate count that keeps showing "none
   * open" is a degradation failing as GOOD news, which is the one direction
   * invariant §7 does not allow.
   */
  const [openGates, setOpenGates] = useState<number | 'error' | null>(null)
  // A newly spawned agent is selected only when nothing is: an agent appearing
  // must never yank the Architect's attention off the one they are watching.
  const onAgentSeen = useCallback((agentId: string) => {
    setSelected((current) => current ?? agentId)
  }, [])

  // UI-DESIGN §3 requires the pixel faces bundled. A face that is not installed
  // is shown, never silently swapped for a fallback (invariant §7).
  useEffect(() => {
    let cancelled = false
    void loadPixelFonts().then((status) => {
      if (!cancelled) setFonts(status)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const eph = window.eph
    if (!eph) return
    let cancelled = false
    const poll = (): void => {
      eph.hooks
        .state()
        .then((state) => {
          if (!cancelled) setHooks(state)
        })
        .catch(() => {
          /* the bridge banner already reports a dead bridge */
        })
      // The status strip counts open gates (UI-DESIGN §4). It rides the same
      // slow poll so the badge is right even when the push was missed.
      eph.watch
        .approvals()
        .then((gates) => {
          if (!cancelled) setOpenGates(gates.length)
        })
        .catch(() => {
          // Not swallowed: an unknown gate count must never render as "none".
          if (!cancelled) setOpenGates('error')
        })
      // Data-plane health rides the same slow poll (invariant §7: every
      // degradation is a visible state, never only a main-process warn).
      eph.agora
        .health()
        .then((state) => {
          if (!cancelled) setHealth(state)
        })
        .catch(() => {
          /* the bridge banner already reports a dead bridge */
        })
    }
    poll()
    const timer = setInterval(poll, HOOKS_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const eph = window.eph
    if (!eph) {
      // Degradations are visible, never silent (BUILD-PROMPT §3.7).
      setBridge({ kind: 'unavailable', reason: 'window.eph bridge not exposed' })
      return
    }
    eph.config
      .get()
      .then((snapshot) => setBridge({ kind: 'ready', snapshot }))
      .catch((err: unknown) => setBridge({ kind: 'unavailable', reason: String(err) }))
  }, [])

  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        gap: '8px',
        padding: '8px',
        boxSizing: 'border-box'
      }}
    >
      <header style={{ display: 'flex', alignItems: 'baseline', gap: '12px' }}>
        <h1 style={{ fontFamily: 'var(--eph-face-display)', fontSize: '16px', margin: 0 }}>
          Ephesus
        </h1>
        <span style={{ fontFamily: 'var(--eph-face-data)', fontSize: '12px' }}>
          {bridge.kind === 'loading' && 'bridge: connecting…'}
          {bridge.kind === 'ready' && (
            <>
              {`bridge: ready · config schema v${bridge.snapshot.config.schemaVersion}`}
              {bridge.snapshot.warning && (
                <span style={{ color: 'var(--eph-status-blocked)' }}>
                  {' '}
                  · {bridge.snapshot.warning}
                </span>
              )}
            </>
          )}
          {bridge.kind === 'unavailable' && (
            <span style={{ color: 'var(--eph-status-blocked)' }}>bridge: {bridge.reason}</span>
          )}
        </span>
        <span style={{ fontFamily: 'var(--eph-face-data)', fontSize: '12px' }}>
          {hooks === null && 'events: …'}
          {hooks !== null && hooks.endpoint === null && (
            <span style={{ color: 'var(--eph-status-blocked)' }}>
              ⚠ events stale — hook endpoint unavailable
              {hooks.failure ? `: ${hooks.failure}` : ''}
            </span>
          )}
          {hooks !== null && hooks.endpoint !== null && hooks.driftWarnings.length === 0 && (
            <span style={{ color: 'var(--eph-status-success)' }}>● events: live</span>
          )}
          {hooks !== null && hooks.endpoint !== null && hooks.driftWarnings.length > 0 && (
            <span
              style={{ color: 'var(--eph-status-looping)' }}
              title={hooks.driftWarnings.join(String.fromCharCode(10))}
            >
              ⚠ events: live · {hooks.driftWarnings.length} schema drift warning
              {hooks.driftWarnings.length === 1 ? '' : 's'}
            </span>
          )}
        </span>
        <span style={{ fontFamily: 'var(--eph-face-data)', fontSize: '12px' }}>
          {fonts !== null && fonts.missing.length > 0 && (
            <span
              style={{ color: 'var(--eph-status-looping)' }}
              title={`missing: ${fonts.missing.join(', ')}`}
            >
              ⚠ fonts: {fonts.missing.length} of {PIXEL_FACES.length} pixel faces missing
            </span>
          )}
          {fonts !== null && fonts.missing.length === 0 && (
            <span style={{ color: 'var(--eph-status-success)' }}>● fonts: bundled</span>
          )}
        </span>
        <span style={{ fontFamily: 'var(--eph-face-data)', fontSize: '12px' }}>
          {openGates === null && 'gates: …'}
          {openGates === 'error' && (
            <span style={{ color: 'var(--eph-status-looping)' }}>⚠ gates: unavailable</span>
          )}
          {openGates === 0 && (
            <span style={{ color: 'var(--eph-status-success)' }}>● gates: none open</span>
          )}
          {typeof openGates === 'number' && openGates > 0 && (
            <span style={{ color: 'var(--eph-status-blocked)' }}>
              ⚠ gates: {openGates} waiting on you
            </span>
          )}
        </span>
        <span style={{ fontFamily: 'var(--eph-face-data)', fontSize: '12px' }}>
          {health === null && 'agora: …'}
          {health !== null && agoraIssues(health).length === 0 && (
            <span style={{ color: 'var(--eph-status-success)' }}>● agora: ok</span>
          )}
          {health !== null && agoraIssues(health).length > 0 && (
            <span
              style={{ color: 'var(--eph-status-looping)' }}
              title={agoraIssues(health).join(String.fromCharCode(10))}
            >
              ⚠ agora: {agoraIssues(health).length} issue
              {agoraIssues(health).length === 1 ? '' : 's'}
            </span>
          )}
        </span>
      </header>
      <nav style={{ display: 'flex', gap: '4px' }}>
        {(['floor', 'activity', 'watch'] as const).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            aria-current={tab === name}
            style={{
              fontFamily: 'var(--eph-face-display)',
              fontSize: '8px',
              padding: '4px 8px',
              border: '2px solid var(--eph-ink-900)',
              background: tab === name ? 'var(--eph-marble-50)' : 'var(--eph-marble-200)'
            }}
          >
            {name.toUpperCase()}
            {name === 'watch' && typeof openGates === 'number' && openGates > 0
              ? ` ${String(openGates)}`
              : ''}
          </button>
        ))}
      </nav>
      <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: '8px' }}>
        {/* App shell (UI-DESIGN §4): floor left (dominant), context stack right. */}
        {tab === 'floor' && <FloorCanvas />}
        {tab === 'activity' && <ActivityPanel />}
        {tab === 'watch' && <WatchPanel />}
        {bridge.kind === 'ready' && <TerminalPanel agentId={selected} />}
      </div>
      {/* UI-DESIGN §4 app shell: bottom = command bar. */}
      {bridge.kind === 'ready' && (
        <CommandBar selected={selected} onSelect={setSelected} onAgentSeen={onAgentSeen} />
      )}
    </main>
  )
}

import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { AgoraHealth, ConfigSnapshot, HooksState } from '../../shared/ipc'
import type { ModeView } from '../../shared/mode-view'
import { loadPixelFonts, PIXEL_FACES, type FontStatus } from './fonts'
import { CountBadge } from './StatusBadge'
import { ActivityPanel } from './ActivityPanel'
import { CommandBar } from './CommandBar'
import { TerminalPanel } from './TerminalPanel'
import { BriefsPanel } from './BriefsPanel'
import { MeetingPanel } from './MeetingPanel'
import { GymPanel } from './GymPanel'
import { StoaPanel } from './StoaPanel'
import { ProfilesPanel } from './ProfilesPanel'
import { OrgPanel } from './OrgPanel'
import { DecksPanel } from './DecksPanel'
import { MemosPanel } from './MemosPanel'
import { LedgerPanel } from './LedgerPanel'
import { MemoryPanel } from './MemoryPanel'
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
   * Command Center tabs (UI-DESIGN §4). Only the ones that exist are shown —
   * offering a tab for a subsystem that has not been built would be inventing
   * UI (BUILD-PROMPT §7); the rest arrive with their milestones.
   */
  const [tab, setTab] = useState<
    | 'floor'
    | 'activity'
    | 'ledger'
    | 'briefs'
    | 'decks'
    | 'memos'
    | 'odeon'
    | 'org'
    | 'gym'
    | 'stoa'
    | 'profiles'
    | 'memory'
    | 'watch'
  >('floor')
  /**
   * Open gates, for the status strip's badge (UI-DESIGN §4). `'error'` is a
   * distinct state from `null`: a stale gate count that keeps showing "none
   * open" is a degradation failing as GOOD news, which is the one direction
   * invariant §7 does not allow.
   */
  const [openGates, setOpenGates] = useState<number | 'error' | null>(null)
  /**
   * The company mode (FR-14.1 — "visible at all times in the UI"). Null while
   * it is still being read; the strip shows nothing rather than guessing
   * `directed`, because claiming the safe mode when the real one is unknown is
   * a degradation failing as good news (invariant §7).
   */
  const [mode, setMode] = useState<ModeView | null>(null)
  /**
   * Memos waiting on the Architect, for the status strip's badge — the carried
   * item from the M5 close-out ("the panels poll today").
   *
   * `odeon:queue` has been a push channel since M5 and nothing above the panels
   * listened to it, so a memo could sit in the queue with no sign of it unless
   * the Architect happened to open the tab. It is driven by the push AND the
   * slow poll: the push makes it prompt, the poll makes it right after a missed
   * event — the same belt-and-braces the gate badge already uses. `'error'`
   * stays distinct from `null` for the same reason it does there: a stale count
   * showing "none" is a degradation failing as GOOD news (invariant §7).
   */
  const [memoQueue, setMemoQueue] = useState<number | 'error' | null>(null)
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
      // The memo queue rides the same slow poll as its push, so a missed
      // `odeon:queue` event cannot leave the badge wrong indefinitely.
      eph.odeon
        .memos('open')
        .then((rows) => {
          if (!cancelled) setMemoQueue(rows.length)
        })
        .catch(() => {
          if (!cancelled) setMemoQueue('error')
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

  /**
   * The `odeon:queue` push, finally consumed above the panels. It is a nudge,
   * not a payload (SDD §5), so the badge re-reads rather than holding a second
   * copy of a queue main owns.
   */
  useEffect(() => {
    const eph = window.eph
    if (!eph) return
    let cancelled = false
    const reread = (): void => {
      eph.odeon
        .memos('open')
        .then((rows) => {
          if (!cancelled) setMemoQueue(rows.length)
        })
        .catch(() => {
          if (!cancelled) setMemoQueue('error')
        })
    }
    const off = eph.odeon.onQueue(reread)
    return () => {
      cancelled = true
      off()
    }
  }, [])

  // FR-14.1: the company mode is visible at ALL times. Polled on the same slow
  // cadence as the other strip facts, and left null on failure rather than
  // shown as `directed` — a mode nobody could read is not a mode that is off.
  useEffect(() => {
    const read = (): void => {
      const eph = window.eph
      if (!eph) return
      eph.gym
        .mode()
        .then(setMode)
        .catch(() => setMode(null))
    }
    read()
    const timer = setInterval(read, 5_000)
    return () => clearInterval(timer)
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
        <CountBadge
          label="gates"
          count={openGates}
          none="none open"
          some={(n) => `${String(n)} waiting on you`}
          tone="var(--eph-status-blocked)"
        />
        <CountBadge
          label="memos"
          count={memoQueue}
          none="none waiting"
          // §9 copy voice: "Three items need you" beats a count with no verb.
          some={(n) => `${String(n)} need you`}
          tone="var(--eph-status-working)"
        />
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
          {mode !== null && (
            <span
              style={{
                marginLeft: '8px',
                color:
                  mode.mode === 'improving' ? 'var(--eph-status-working)' : 'var(--eph-ink-500)'
              }}
            >
              {' · '}mode: {mode.mode}
            </span>
          )}
        </span>
      </header>
      <nav style={{ display: 'flex', gap: '4px' }}>
        {(
          [
            'floor',
            'activity',
            'ledger',
            'briefs',
            'decks',
            'memos',
            'odeon',
            'org',
            'gym',
            'stoa',
            'profiles',
            'memory',
            'watch'
          ] as const
        ).map((name) => (
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
        {tab === 'ledger' && <LedgerPanel />}
        {tab === 'briefs' && <BriefsPanel />}
        {tab === 'decks' && <DecksPanel />}
        {tab === 'memos' && <MemosPanel />}
        {tab === 'odeon' && <MeetingPanel />}
        {tab === 'org' && <OrgPanel />}
        {tab === 'gym' && <GymPanel />}
        {tab === 'stoa' && <StoaPanel />}
        {tab === 'profiles' && <ProfilesPanel />}
        {tab === 'memory' && <MemoryPanel />}
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

import { useEffect, useState, type ReactElement } from 'react'
import type { EphConfig } from '../../shared/config'
import { TerminalPanel } from './TerminalPanel'
import { FloorCanvas } from './floor/FloorCanvas'

type BridgeState =
  | { kind: 'loading' }
  | { kind: 'ready'; config: EphConfig }
  | { kind: 'unavailable'; reason: string }

export function App(): ReactElement {
  const [bridge, setBridge] = useState<BridgeState>({ kind: 'loading' })

  useEffect(() => {
    const eph = window.eph
    if (!eph) {
      // Degradations are visible, never silent (BUILD-PROMPT §3.7).
      setBridge({ kind: 'unavailable', reason: 'window.eph bridge not exposed' })
      return
    }
    eph.config
      .get()
      .then((config) => setBridge({ kind: 'ready', config }))
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
          {bridge.kind === 'ready' &&
            `bridge: ready · config schema v${bridge.config.schemaVersion}`}
          {bridge.kind === 'unavailable' && (
            <span style={{ color: 'var(--eph-status-blocked)' }}>bridge: {bridge.reason}</span>
          )}
        </span>
      </header>
      <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: '8px' }}>
        {/* App shell (UI-DESIGN §4): floor left (dominant), context stack right. */}
        <FloorCanvas />
        {bridge.kind === 'ready' && <TerminalPanel />}
      </div>
    </main>
  )
}

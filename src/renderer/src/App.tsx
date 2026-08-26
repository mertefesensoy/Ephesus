import { useEffect, useState, type ReactElement } from 'react'
import type { EphConfig } from '../../shared/config'

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
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: '8px'
      }}
    >
      <h1 style={{ fontFamily: 'var(--eph-face-display)', fontSize: '16px', margin: 0 }}>
        Ephesus
      </h1>
      <p style={{ color: 'var(--eph-ink-700)', margin: 0 }}>
        Skeleton shell — M0 in progress. The Terraces floor and terminal land next.
      </p>
      <p style={{ fontFamily: 'var(--eph-face-data)', fontSize: '12px', margin: 0 }}>
        {bridge.kind === 'loading' && 'bridge: connecting…'}
        {bridge.kind === 'ready' && `bridge: ready · config schema v${bridge.config.schemaVersion}`}
        {bridge.kind === 'unavailable' && (
          <span style={{ color: 'var(--eph-status-blocked)' }}>bridge: {bridge.reason}</span>
        )}
      </p>
    </main>
  )
}

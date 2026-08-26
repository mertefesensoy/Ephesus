import type { ReactElement } from 'react'

export function App(): ReactElement {
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
    </main>
  )
}

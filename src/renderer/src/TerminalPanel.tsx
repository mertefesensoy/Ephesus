import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

type ShellState = { kind: 'running'; id: string } | { kind: 'exited'; code: number }

/**
 * Live terminal for the M0.3 dev shell. The terminal is sacred (UI-DESIGN §1.6):
 * xterm keeps its authentic default colors and fonts inside the panel frame;
 * only the frame uses Ephesus tokens.
 */
export function TerminalPanel(): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const [shell, setShell] = useState<ShellState | null>(null)
  const shellIdRef = useRef<string | null>(null)

  useEffect(() => {
    const eph = window.eph
    const host = hostRef.current
    if (!eph || !host) return

    const term = new Terminal({ scrollback: 5000 })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    const cleanups: Array<() => void> = [() => term.dispose()]
    let cancelled = false

    void (async () => {
      // Subscribe before spawning so the first prompt bytes are never lost.
      const id = await eph.pty.ensureDevShell()
      if (cancelled) return
      shellIdRef.current = id
      cleanups.push(eph.pty.onData(id, (data) => term.write(data)))
      cleanups.push(eph.pty.onExit(id, (code) => setShell({ kind: 'exited', code })))
      cleanups.push(term.onData((data) => void eph.pty.write(id, data)).dispose)
      setShell({ kind: 'running', id })
      await eph.pty.resize(id, term.cols, term.rows)
    })()

    const onResize = (): void => {
      fit.fit()
      const id = shellIdRef.current
      if (id) void eph.pty.resize(id, term.cols, term.rows)
    }
    const observer = new ResizeObserver(onResize)
    observer.observe(host)
    cleanups.push(() => observer.disconnect())

    return () => {
      cancelled = true
      for (const cleanup of cleanups.reverse()) cleanup()
    }
  }, [])

  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        // Panel anatomy (UI-DESIGN §4): ink-900 2px → marble-50 seam → ink-700 1px
        border: '2px solid var(--eph-ink-900)',
        boxShadow:
          'inset 0 0 0 1px var(--eph-marble-50), inset 0 0 0 2px var(--eph-ink-700), 2px 2px 0 var(--eph-ink-900)',
        background: 'var(--eph-marble-100)'
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 8px',
          borderBottom: '1px solid var(--eph-ink-700)'
        }}
      >
        <span style={{ fontFamily: 'var(--eph-face-display)', fontSize: '8px' }}>
          TERMINAL BENCH
        </span>
        <span style={{ fontFamily: 'var(--eph-face-data)', fontSize: '12px' }}>
          {shell === null && 'starting…'}
          {shell?.kind === 'running' && (
            <>
              {shell.id}{' '}
              <button
                onClick={() => void window.eph?.pty.kill(shell.id)}
                style={{
                  fontFamily: 'var(--eph-face-ui)',
                  fontSize: '12px',
                  color: 'var(--eph-marble-50)',
                  background: 'var(--eph-wine)',
                  border: '1px solid var(--eph-ink-900)',
                  cursor: 'pointer'
                }}
              >
                kill
              </button>
            </>
          )}
          {shell?.kind === 'exited' && (
            <span style={{ color: 'var(--eph-status-blocked)' }}>exited (code {shell.code})</span>
          )}
        </span>
      </header>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, padding: '4px' }} />
    </section>
  )
}

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

type PtyState = { kind: 'running' } | { kind: 'exited'; code: number }

/**
 * The selected agent's live terminal (UC-03 step 2). The terminal is sacred
 * (UI-DESIGN §1.6): xterm keeps its authentic default colors and fonts inside
 * the panel frame, and only the frame uses Ephesus tokens.
 *
 * Typing here writes straight to the PTY, bypassing the command queue on
 * purpose: this is the Architect operating the engine's own interface —
 * answering its permission dialog, cycling its modes — and none of that is a
 * prompt to be held until the agent is idle (FR-1.3 governs prompts, not
 * keystrokes).
 */
export function TerminalPanel({ agentId }: { agentId: string | null }): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<PtyState | null>(null)

  useEffect(() => {
    const eph = window.eph
    const host = hostRef.current
    if (!eph || !host || !agentId) {
      setState(null)
      return
    }

    const term = new Terminal({ scrollback: 5000 })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    const cleanups: Array<() => void> = [() => term.dispose()]
    cleanups.push(eph.pty.onData(agentId, (data) => term.write(data)))
    cleanups.push(eph.pty.onExit(agentId, (code) => setState({ kind: 'exited', code })))
    cleanups.push(term.onData((data) => void eph.agents.send(agentId, data)).dispose)
    setState({ kind: 'running' })
    void eph.pty.resize(agentId, term.cols, term.rows)

    const onResize = (): void => {
      fit.fit()
      void eph.pty.resize(agentId, term.cols, term.rows)
    }
    const observer = new ResizeObserver(onResize)
    observer.observe(host)
    cleanups.push(() => observer.disconnect())

    return () => {
      for (const cleanup of cleanups.reverse()) cleanup()
    }
  }, [agentId])

  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minWidth: 0,
        border: '2px solid var(--eph-ink-900)',
        boxShadow: '2px 2px 0 var(--eph-ink-900)',
        background: 'var(--eph-marble-50)'
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          borderBottom: '1px solid var(--eph-ink-700)',
          padding: '4px 8px',
          fontFamily: 'var(--eph-face-display)',
          fontSize: '8px'
        }}
      >
        <span>{agentId ?? 'TERMINAL'}</span>
        <span style={{ fontFamily: 'var(--eph-face-data)', fontSize: '12px' }}>
          {agentId === null && 'no agent selected'}
          {state?.kind === 'running' && 'live'}
          {state?.kind === 'exited' && (
            <span style={{ color: 'var(--eph-status-ghost)' }}>exited ({state.code})</span>
          )}
        </span>
        <button
          type="button"
          disabled={agentId === null}
          onClick={() => {
            if (agentId) void window.eph?.agents.kill(agentId)
          }}
          style={{ fontFamily: 'var(--eph-face-ui)', fontSize: '12px' }}
        >
          Kill
        </button>
      </header>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, padding: '4px' }} />
    </section>
  )
}

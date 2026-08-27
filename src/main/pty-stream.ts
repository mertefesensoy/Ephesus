import { ptyDataChannel, ptyExitChannel } from '../shared/ipc'
import type { RedactionFilter } from '../shared/redaction'

/**
 * The outbound edge of a PTY: bytes → redaction filter → renderer.
 *
 * This lives apart from `pty.ts` for one reason — `pty.ts` imports `node-pty`,
 * which is rebuilt against Electron's ABI and must not be imported by vitest
 * (M0 constraint 3). Without this split the wiring below would be reachable
 * only through a manual live run, and deleting the `filter.push` call would
 * leave the whole suite green while every credential an agent echoed reached
 * the renderer in the clear (ADR-0010).
 */

/** The filter a harness with no secret broker gets. */
export const PASS_THROUGH: RedactionFilter = { push: (chunk) => chunk, flush: () => '' }

/** The slice of a live process this module consumes; node-pty's `IPty` fits. */
export interface PtyDataSource {
  onData(cb: (data: string) => void): void
  onExit(cb: (event: { exitCode: number }) => void): void
}

/** Where forwarded bytes go; Electron's `WebContents` fits. */
export interface PtySink {
  send(channel: string, payload: string | number): void
}

/**
 * Contract: every byte the process produces passes through `filter` before it
 * reaches `sink`, and the filter's held tail is flushed on exit — otherwise the
 * last characters of a run would vanish whenever the filter was mid-match.
 * `onExit` runs before the flush so the manager's bookkeeping is done first.
 */
export function attachRedactedStream(options: {
  readonly id: string
  readonly source: PtyDataSource
  readonly filter: RedactionFilter
  /** Read on every event, so a window recreated mid-run still receives bytes. */
  sink(): PtySink | null
  onExit(exitCode: number): void
}): void {
  const { id, source, filter } = options
  source.onData((data) => {
    const safe = filter.push(data)
    if (safe.length > 0) options.sink()?.send(ptyDataChannel(id), safe)
  })
  source.onExit(({ exitCode }) => {
    const tail = filter.flush()
    if (tail.length > 0) options.sink()?.send(ptyDataChannel(id), tail)
    options.sink()?.send(ptyExitChannel(id), exitCode)
    options.onExit(exitCode)
  })
}

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

/** How much of an agent's final output is kept. Enough to see a stack, no more. */
export const LAST_WORDS_BYTES = 4096
/** What survives into the record, once the choreography is stripped. */
export const LAST_WORDS_REPORTED = 600

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
  /**
   * The last thing this process said before it ended.
   *
   * An agent that dies takes its terminal with it, and until this existed the
   * harness kept nothing: a crash was an exit code and a shrug. The real
   * one-hour run on 2026-09-05 hit exactly that wall — agents exiting 1 within
   * a second of a wake, with no way to ask them why, and the investigation
   * stopped there.
   *
   * Fed from the REDACTED stream and never the raw one, because this reaches
   * `log.jsonl` — which is committed (ADR-0004) and must never carry a secret
   * (ADR-0010, NFR-8). Bounded, because a book of record is not a transcript.
   */
  onLastWords?(tail: string): void
}): void {
  const { id, source, filter } = options
  // A ring in the closure: the newest bytes only, and dropped with the stream.
  let recent = ''
  const keep = (safe: string): void => {
    recent = (recent + safe).slice(-LAST_WORDS_BYTES)
  }
  source.onData((data) => {
    const safe = filter.push(data)
    if (safe.length > 0) {
      keep(safe)
      options.sink()?.send(ptyDataChannel(id), safe)
    }
  })
  source.onExit(({ exitCode }) => {
    const tail = filter.flush()
    if (tail.length > 0) {
      keep(tail)
      options.sink()?.send(ptyDataChannel(id), tail)
    }
    options.sink()?.send(ptyExitChannel(id), exitCode)
    options.onLastWords?.(readableTail(recent))
    options.onExit(exitCode)
  })
}

/**
 * The control bytes a terminal uses, named from their codes.
 *
 * Built with `String.fromCharCode` rather than written as literal control
 * characters or `\u` escapes in a pattern: a regex holding a raw ESC is
 * invisible in a diff and survives neither a copy-paste nor a formatter, and
 * this file has already had both eat it once.
 */
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

/** OSC: ESC ] … terminated by BEL, or by ST (ESC \). */
const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`, 'g')
/** CSI and friends: ESC, optional intermediates, digits, a final letter. */
const CSI = new RegExp(`${ESC}[[\\]()#;?]*[0-9;]*[A-Za-z]`, 'g')

/** Everything else non-printing, including the CRs a redraw leans on. */
function isControl(code: number): boolean {
  return code < 32 || code === 127
}

/**
 * Contract: a terminal's bytes as one readable line, or `''`. Pure.
 *
 * A TUI's output is mostly cursor movement, colour and redraws; put into a log
 * row verbatim it is unreadable and enormous. This keeps the words and throws
 * the choreography away — the whole point is to be able to READ what the agent
 * said as it died.
 */
export function readableTail(raw: string): string {
  const stripped = raw.replace(OSC, '').replace(CSI, '')
  let out = ''
  for (const ch of stripped) out += isControl(ch.charCodeAt(0)) ? ' ' : ch
  return out.replace(/\s+/g, ' ').trim().slice(-LAST_WORDS_REPORTED)
}

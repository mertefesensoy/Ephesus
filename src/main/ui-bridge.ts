import type { PtySink } from './pty-stream'

/**
 * The one door from main to the renderer (M8.1).
 *
 * ## The defect this class makes unrepresentable
 *
 * `index.ts` held the window in a `BrowserWindow | null` and sent through it
 * forty-six times as `mainWindow?.webContents.send(...)`. The optional chain
 * reads as safety and is not: the reference is only ever null BEFORE the first
 * window is created, and nothing nulls it afterwards. Once the window closes,
 * `mainWindow` holds a *destroyed* object, `?.` happily proceeds, and
 * `webContents.send` throws `Object has been destroyed`.
 *
 * That is the quit path's whole failure. Closing Time logs its first event
 * through such a send, so `begin()` rejected before a single agent was asked to
 * park its work; the agent manager's log and card callbacks do the same, so
 * `shutdown()` threw on its first agent and skipped the rest; and the PTY sink
 * was the window's `webContents` itself, so killing the terminals threw too.
 * Verified on the Architect's machine: one `closing-begin` in the book of
 * record, no ack, no complete, ever — with every test green.
 *
 * So the window is not a variable any more. It is behind this object, which:
 *
 * - forgets the window when it closes (`once('closed')`), so the reference
 *   cannot outlive the thing it names;
 * - checks `isDestroyed()` on both the window and its contents before every
 *   send, because a window can be destroyed without the event having run yet
 *   (teardown ordering) — the null check alone is what failed;
 * - never throws at a caller. A send with no live window is a no-op that
 *   returns `false`, which is the honest answer during a quit: the UI is gone,
 *   the work is not.
 *
 * `check-invariants.cjs` fails on `webContents.send` anywhere but here, so the
 * next author cannot reopen the hole by writing the old line again.
 *
 * ## Why a no-op is not a silent degradation
 *
 * Invariant §7 forbids silent fallback, and this class is deliberately silent
 * about exactly one thing: sending to a window that is closed or closing. That
 * is not a degradation, it is the normal end of a session — the renderer is a
 * projection (ENGINEERING-STANDARDS §4) and it holds no state whose loss means
 * anything. Anything ELSE that goes wrong in a send is reported through
 * `onDropped`, because a live window that refuses a message IS a fault, and the
 * one place that can tell the difference is here.
 *
 * Electron-free by construction: it takes a structural window, so the whole
 * class is testable under the Node runner (BUILD-PROMPT §10.3) and a
 * `BrowserWindow` satisfies it without a cast.
 */

/** The shape of the thing this bridge talks to; `BrowserWindow` satisfies it. */
export interface RendererWindow {
  isDestroyed(): boolean
  readonly webContents: {
    isDestroyed(): boolean
    send(channel: string, ...args: unknown[]): void
  }
  once(event: 'closed', listener: () => void): unknown
}

export interface UiBridgeOptions {
  /**
   * A send that failed for a reason other than "there is no live window" —
   * a real fault, and the only thing here worth a visible degradation.
   */
  onDropped?(channel: string, detail: string): void
}

/**
 * Contract: `send` delivers to the attached window, or returns `false` and does
 * nothing. It never throws, whatever state the window is in. `attach` replaces
 * any previous window (macOS re-open goes through here) and arms the forget.
 *
 * Implements `PtySink` so the terminal stream can be pointed at the bridge once
 * at boot, instead of at a `webContents` that a later window replaces.
 */
export class UiBridge implements PtySink {
  private target: RendererWindow | null = null

  constructor(private readonly options: UiBridgeOptions = {}) {}

  attach(window: RendererWindow): void {
    this.target = window
    // Guarded against a stale close: a window that has already been replaced
    // must not null out its successor when its own event finally runs.
    window.once('closed', () => {
      if (this.target === window) this.target = null
    })
  }

  detach(): void {
    this.target = null
  }

  /** Whether a send would reach a renderer right now. */
  attached(): boolean {
    return this.live() !== null
  }

  /**
   * The window if it can still receive, else null — and the reference is
   * dropped on the way out, so a destroyed window is asked exactly once.
   */
  private live(): RendererWindow | null {
    const target = this.target
    if (target === null) return null
    try {
      if (target.isDestroyed() || target.webContents.isDestroyed()) {
        this.target = null
        return null
      }
    } catch {
      // Reading `isDestroyed` off a torn-down native object can itself throw;
      // that is as good an answer as `true`.
      this.target = null
      return null
    }
    return target
  }

  send(channel: string, ...args: unknown[]): boolean {
    const target = this.live()
    if (target === null) return false
    try {
      target.webContents.send(channel, ...args)
      return true
    } catch (err) {
      // The window passed both destroyed checks and still refused: a fault, not
      // a shutdown. Report it once and stop using this window.
      this.target = null
      this.options.onDropped?.(channel, err instanceof Error ? err.message : String(err))
      return false
    }
  }
}

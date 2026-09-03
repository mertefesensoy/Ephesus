import type { RendererWindow } from '../../src/main/ui-bridge'

/**
 * A `BrowserWindow` for tests, structural exactly as the real one is.
 *
 * It exists to reproduce the state that broke the quit path and that the old
 * null check could not see: a window that is PRESENT and DESTROYED. Electron
 * tears a window down and runs its `closed` listener afterwards, so
 * `destroy({ fireClosed: false })` is the real teardown ordering rather than a
 * convenience — a fake that always fired the event would have made the fix look
 * correct without ever exercising the case that actually failed.
 */
export class FakeWindow implements RendererWindow {
  readonly sent: { channel: string; args: unknown[] }[] = []
  private destroyed = false
  private contentsDestroyed = false
  private closedListeners: (() => void)[] = []
  /** Set to make `send` throw the way a torn-down native object does. */
  throwOnSend: string | null = null
  /** Set to make the destroyed checks themselves throw, as a dead handle can. */
  throwOnCheck = false
  /** How many times the bridge asked whether this window is gone. */
  destroyedChecks = 0

  readonly webContents = {
    isDestroyed: (): boolean => {
      if (this.throwOnCheck) throw new Error('Object has been destroyed')
      return this.contentsDestroyed
    },
    send: (channel: string, ...args: unknown[]): void => {
      if (this.throwOnSend !== null) throw new Error(this.throwOnSend)
      // What Electron does, and the whole defect: a destroyed window does not
      // return quietly, it throws — so a fake that accepted the send would let
      // the old wiring look survivable.
      if (this.destroyed || this.contentsDestroyed) throw new Error('Object has been destroyed')
      this.sent.push({ channel, args })
    }
  }

  isDestroyed(): boolean {
    this.destroyedChecks += 1
    if (this.throwOnCheck) throw new Error('Object has been destroyed')
    return this.destroyed
  }

  once(event: 'closed', listener: () => void): unknown {
    if (event === 'closed') this.closedListeners.push(listener)
    return this
  }

  /** Electron destroys the window and only then runs `closed`. */
  destroy(options: { readonly fireClosed?: boolean } = {}): void {
    this.destroyed = true
    this.contentsDestroyed = true
    if (options.fireClosed !== false)
      for (const listener of this.closedListeners.splice(0)) listener()
  }

  /** Only the contents go, which is what a crashed renderer looks like. */
  destroyContents(): void {
    this.contentsDestroyed = true
  }
}

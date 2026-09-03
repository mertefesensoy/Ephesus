import { describe, expect, it } from 'vitest'
import { UiBridge } from '../../src/main/ui-bridge'
import { attachRedactedStream, PASS_THROUGH, type PtySink } from '../../src/main/pty-stream'
import { FakeWindow } from '../fakes/fake-window'

/**
 * The renderer seam (M8.1).
 *
 * The defect this class exists for is not "the window might be null" — the old
 * code checked that, forty-three times, with `?.`. It is that a CLOSED window is
 * not null: `mainWindow` held a destroyed `BrowserWindow`, the optional chain
 * proceeded, and `webContents.send` threw. So every case here that matters is
 * about a window that is *present and dead*, which is the state the old check
 * could not see and the state every quit is in.
 *
 * The fake is structural, exactly as `BrowserWindow` is: nothing here mocks the
 * bridge's own behaviour, and a case that passed against a mocked `send` would
 * prove nothing about the thing that threw.
 */

describe('UiBridge — a live window', () => {
  it('delivers the channel and every argument', () => {
    const bridge = new UiBridge()
    const win = new FakeWindow()
    bridge.attach(win)
    expect(bridge.send('log:append')).toBe(true)
    expect(bridge.send('state:agents', { id: 'agent.mason' })).toBe(true)
    expect(win.sent).toEqual([
      { channel: 'log:append', args: [] },
      { channel: 'state:agents', args: [{ id: 'agent.mason' }] }
    ])
  })

  it('reports attached only while a send would arrive', () => {
    const bridge = new UiBridge()
    expect(bridge.attached()).toBe(false)
    const win = new FakeWindow()
    bridge.attach(win)
    expect(bridge.attached()).toBe(true)
    win.destroy()
    expect(bridge.attached()).toBe(false)
  })
})

describe('UiBridge — a window that is present and dead', () => {
  it('is a no-op after the window is destroyed WITHOUT its closed event — the production case', () => {
    // Teardown destroys windows and the event runs later, if at all. This is
    // the exact state `mainWindow?.webContents.send(...)` could not detect, and
    // the reason Closing Time never got past its first log line.
    //
    // The `isDestroyed` check is what makes this SILENT. Catching the throw
    // alone would also keep the quit alive, but it would report a fault for
    // every one of the forty-odd sends a shutdown makes — so the spy below is
    // the assertion that pins the check rather than the catch behind it.
    const dropped: string[] = []
    const bridge = new UiBridge({ onDropped: (channel) => dropped.push(channel) })
    const win = new FakeWindow()
    bridge.attach(win)
    win.destroy({ fireClosed: false })
    expect(bridge.send('log:append')).toBe(false)
    expect(win.sent).toEqual([])
    expect(dropped).toEqual([])
  })

  it('stops asking a window once its closed event has run', () => {
    // The listener is not merely tidy: it drops the reference so a closed
    // window is not consulted (or retained) for the rest of the session.
    const bridge = new UiBridge()
    const win = new FakeWindow()
    bridge.attach(win)
    win.destroy()
    const before = win.destroyedChecks
    bridge.send('log:append')
    expect(win.destroyedChecks).toBe(before)
  })

  it('is a no-op once the closed event has run', () => {
    const bridge = new UiBridge()
    const win = new FakeWindow()
    bridge.attach(win)
    win.destroy()
    expect(bridge.send('log:append')).toBe(false)
    expect(win.sent).toEqual([])
  })

  it('is a no-op when only the contents are gone (a crashed renderer)', () => {
    const bridge = new UiBridge()
    const win = new FakeWindow()
    bridge.attach(win)
    win.destroyContents()
    expect(bridge.send('log:append')).toBe(false)
  })

  it('treats a check that itself throws as "no window", never as an error', () => {
    const bridge = new UiBridge()
    const win = new FakeWindow()
    bridge.attach(win)
    win.throwOnCheck = true
    expect(() => bridge.send('log:append')).not.toThrow()
    expect(bridge.send('log:append')).toBe(false)
  })

  it('never sends with no window attached', () => {
    expect(new UiBridge().send('log:append')).toBe(false)
  })
})

describe('UiBridge — a send that fails anyway', () => {
  it('reports it once, as a fault, and stops using that window', () => {
    // A window that passes both destroyed checks and still refuses IS a
    // degradation (invariant §7) — unlike a closed window, which is just the
    // end of a session and stays silent.
    const dropped: { channel: string; detail: string }[] = []
    const bridge = new UiBridge({
      onDropped: (channel, detail) => dropped.push({ channel, detail })
    })
    const win = new FakeWindow()
    bridge.attach(win)
    win.throwOnSend = 'render process gone'

    expect(bridge.send('log:append')).toBe(false)
    expect(dropped).toEqual([{ channel: 'log:append', detail: 'render process gone' }])
    // Detached: a window that refused once is not asked again, so one fault
    // cannot become one per event for the rest of the session.
    expect(bridge.send('log:append')).toBe(false)
    expect(dropped).toHaveLength(1)
  })

  it('stays silent for a closed window — that is not a degradation', () => {
    const dropped: string[] = []
    const bridge = new UiBridge({ onDropped: (channel) => dropped.push(channel) })
    const win = new FakeWindow()
    bridge.attach(win)
    win.destroy()
    bridge.send('log:append')
    expect(dropped).toEqual([])
  })
})

describe('UiBridge — windows come and go', () => {
  it('sends to the newest window (macOS re-open)', () => {
    const bridge = new UiBridge()
    const first = new FakeWindow()
    const second = new FakeWindow()
    bridge.attach(first)
    bridge.attach(second)
    bridge.send('log:append')
    expect(first.sent).toEqual([])
    expect(second.sent).toHaveLength(1)
  })

  it("a replaced window's late close event does not silence its successor", () => {
    // `first` is destroyed after `second` is attached; Electron runs the
    // listener then. Nulling on that would leave the live window unreachable
    // with no way to notice.
    const bridge = new UiBridge()
    const first = new FakeWindow()
    const second = new FakeWindow()
    bridge.attach(first)
    bridge.attach(second)
    first.destroy()
    expect(bridge.send('log:append')).toBe(true)
    expect(second.sent).toHaveLength(1)
  })

  it('detach stops delivery without destroying anything', () => {
    const bridge = new UiBridge()
    const win = new FakeWindow()
    bridge.attach(win)
    bridge.detach()
    expect(bridge.send('log:append')).toBe(false)
    expect(win.isDestroyed()).toBe(false)
  })
})

describe('UiBridge — the terminal stream', () => {
  it('is a PtySink, so PTY bytes stop at the bridge instead of throwing', () => {
    // `index.ts` used to hand `win.webContents` straight to the PtyManager, so
    // killing the terminals at teardown threw on the dead window. The bridge is
    // attached once at boot and survives the window.
    const bridge = new UiBridge()
    const sink: PtySink = bridge
    const win = new FakeWindow()
    bridge.attach(win)

    // Defaulted rather than nullable: the assertion below proves they were
    // really replaced, and a nullable pair narrows to `never` at the call.
    let emitData: (data: string) => void = () => undefined
    let emitExit: (event: { exitCode: number }) => void = () => undefined
    const exits: number[] = []
    attachRedactedStream({
      id: 'agent.mason',
      source: {
        onData: (cb) => {
          emitData = cb
        },
        onExit: (cb) => {
          emitExit = cb
        }
      },
      filter: PASS_THROUGH,
      sink: () => sink,
      onExit: (code) => exits.push(code)
    })

    emitData('hello')
    expect(win.sent).toEqual([{ channel: 'pty:data:agent.mason', args: ['hello'] }])

    win.destroy()
    expect(() => emitExit({ exitCode: 0 })).not.toThrow()
    expect(exits).toEqual([0])
  })
})

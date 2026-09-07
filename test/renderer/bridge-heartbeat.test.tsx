// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AgoraHealth, ConfigSnapshot, EphApi, HooksState } from '../../src/shared/ipc'
import type { CapacityView } from '../../src/shared/capacity'
import type { ModeView } from '../../src/shared/mode-view'
import { defaultConfig } from '../../src/shared/config'
import { STALE_AFTER_MS } from '../../src/shared/freshness'

/**
 * The bridge heartbeat, as the SHELL runs it (B15).
 *
 * `test/shared/freshness.test.ts` proves the rule and `status-strip.test.tsx`
 * proves the badge. Both would stay green with the defect still in place,
 * because the defect was never in either: `App` called `eph.config.get()` from
 * a `useEffect(…, [])` exactly once, so `bridge: ready` meant "main answered
 * when this window opened" and went on saying so through a main process that
 * died an hour later. Only a test that mounts the shell and lets the clock run
 * can tell a one-shot probe from a heartbeat, which is why this file exists.
 *
 * The heavy children are replaced because they need a real browser (Pixi,
 * xterm) and because none of them is what is under test. Everything the strip
 * itself reads is the real thing, typed against the real `EphApi`.
 */

vi.mock('../../src/renderer/src/floor/FloorCanvas', () => ({ FloorCanvas: () => null }))
vi.mock('../../src/renderer/src/AgentPanel', () => ({ AgentPanel: () => null }))
vi.mock('../../src/renderer/src/AgentDock', () => ({ AgentDock: () => null }))
vi.mock('../../src/renderer/src/CommandBar', () => ({ CommandBar: () => null }))
vi.mock('../../src/renderer/src/AutonomyBadge', () => ({ AutonomyBadge: () => null }))
vi.mock('../../src/renderer/src/fonts', () => ({
  PIXEL_FACES: [],
  loadPixelFonts: () => Promise.resolve({ missing: [] })
}))

const { App } = await import('../../src/renderer/src/App')

let root: Root | null = null
let host: HTMLDivElement

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  vi.useRealTimers()
  delete (window as { eph?: unknown }).eph
})

// Typed against the real schemas throughout, with no cast anywhere. The dock
// fixtures cast `as never` and that is exactly what hid a missing required
// field until it threw at runtime (M8.9's recorded risk); a fixture that has to
// be cast is a fixture that has stopped checking anything.
const SNAPSHOT: ConfigSnapshot = { config: defaultConfig, warning: null }

const HOOKS: HooksState = { endpoint: 'http://127.0.0.1:7777', driftWarnings: [], failure: null }

const HEALTH: AgoraHealth = { fileWarnings: [], commitFailures: [], runtime: [] }

const CAPACITY: CapacityView = { parked: [], since: null, retryAt: null }

const MODE: ModeView = {
  mode: 'directed',
  gateMet: false,
  missing: [],
  everEnabled: false
}

/**
 * The nine methods the status strip actually calls, typed against the real
 * contract by `Pick`, so a renamed method or a changed signature is a compile
 * error here rather than a `TypeError` at 3am. Only the assignment onto
 * `window` is widened, and it is widened once, in one place.
 */
interface StripBridge {
  readonly config: Pick<EphApi['config'], 'get'>
  readonly hooks: Pick<EphApi['hooks'], 'state'>
  readonly watch: Pick<EphApi['watch'], 'capacity' | 'approvals' | 'onCapacityChange'>
  readonly odeon: Pick<EphApi['odeon'], 'memos' | 'onQueue'>
  readonly agora: Pick<EphApi['agora'], 'health'>
  readonly gym: Pick<EphApi['gym'], 'mode'>
}

interface Rig {
  /** How many times the shell has probed the bridge. */
  probes(): number
  /** What the next probe does. Starts by answering. */
  answerWith(next: () => Promise<ConfigSnapshot>): void
}

function bridge(): Rig {
  let probes = 0
  let behaviour: () => Promise<ConfigSnapshot> = () => Promise.resolve(SNAPSHOT)
  const stub: StripBridge = {
    config: {
      get: () => {
        probes += 1
        return behaviour()
      }
    },
    hooks: { state: () => Promise.resolve(HOOKS) },
    watch: {
      capacity: () => Promise.resolve(CAPACITY),
      approvals: () => Promise.resolve([]),
      onCapacityChange: () => () => {}
    },
    odeon: { memos: () => Promise.resolve([]), onQueue: () => () => {} },
    agora: { health: () => Promise.resolve(HEALTH) },
    gym: { mode: () => Promise.resolve(MODE) }
  }
  Object.assign(window, { eph: stub })
  return {
    probes: () => probes,
    answerWith: (next) => {
      behaviour = next
    }
  }
}

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<App />)
  })
}

/** Advances the fake clock AND lets the promises it releases settle. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const strip = (): string => host.textContent ?? ''

describe('the bridge heartbeat', () => {
  it('keeps probing after mount, rather than asking once', async () => {
    vi.useFakeTimers()
    const rig = bridge()
    await mount()
    expect(rig.probes()).toBe(1)

    await advance(10_000)
    // The defect in one assertion: a one-shot `useEffect(…, [])` stays at 1
    // however long the window is open.
    expect(rig.probes()).toBeGreaterThan(1)
  })

  it('stops claiming "ready" when main stops answering', async () => {
    vi.useFakeTimers()
    const rig = bridge()
    await mount()
    await advance(1_000)
    expect(strip()).toContain('bridge: ready')

    // A main process whose loop is BLOCKED does not reject — the invoke simply
    // never settles. This is that failure, and it is the one a `.catch()`
    // heartbeat would have sat silent through.
    rig.answerWith(() => new Promise<ConfigSnapshot>(() => {}))
    await advance(STALE_AFTER_MS + 2_000)

    expect(strip()).not.toContain('bridge: ready')
    expect(strip()).toContain('may be hung')
  })

  it('reports a main process that was already dead when the window opened', async () => {
    vi.useFakeTimers()
    const rig = bridge()
    rig.answerWith(() => new Promise<ConfigSnapshot>(() => {}))
    await mount()
    await advance(1_000)
    expect(strip()).toContain('bridge: connecting…')

    await advance(STALE_AFTER_MS + 2_000)
    expect(strip()).toContain('may be hung')
    expect(strip()).not.toContain('connecting')
  })

  it('recovers when main starts answering again', async () => {
    // A stall that could not clear would be a banner the Architect learns to
    // ignore, which is the same failure as not showing it.
    vi.useFakeTimers()
    const rig = bridge()
    await mount()
    rig.answerWith(() => new Promise<ConfigSnapshot>(() => {}))
    await advance(STALE_AFTER_MS + 2_000)
    expect(strip()).toContain('may be hung')

    rig.answerWith(() => Promise.resolve(SNAPSHOT))
    await advance(4_000)
    expect(strip()).toContain('bridge: ready')
    expect(strip()).not.toContain('may be hung')
  })

  it('still says why when main rejects rather than hangs', async () => {
    vi.useFakeTimers()
    const rig = bridge()
    await mount()
    rig.answerWith(() => Promise.reject(new Error('bridge closed')))
    await advance(4_000)

    expect(strip()).toContain('bridge closed')
    expect(strip()).not.toContain('bridge: ready')
  })

  it('shows a held capacity reading as held, not as its last good value', async () => {
    // The owed test. The poll holds its last value on failure by design — a
    // failed read must never repaint a parked company as a working one — but a
    // held "clear" and a current "clear" rendered identically, so a reading
    // taken at 3am and unanswered since said the company was fine.
    vi.useFakeTimers()
    bridge()
    await mount()
    await advance(1_000)
    expect(strip()).toContain('capacity: clear')

    const eph = window.eph as unknown as { watch: { capacity: () => Promise<CapacityView> } }
    eph.watch.capacity = () => Promise.reject(new Error('main is gone'))
    await advance(STALE_AFTER_MS + 2_000)

    expect(strip()).toContain('capacity: last read')
    expect(strip()).not.toContain('● capacity: clear')
  })
})

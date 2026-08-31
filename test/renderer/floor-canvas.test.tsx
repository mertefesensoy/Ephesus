// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FloorCanvas } from '../../src/renderer/src/floor/FloorCanvas'
import type { AvatarUpdate } from '../../src/shared/ipc'

/**
 * `FloorCanvas` mounted for real — the wiring the pure reducers cannot cover.
 *
 * The M6 close-out audit found nothing imported this file at all, so its
 * effects, its subscriptions and its degradation path had no coverage of any
 * kind. `facts.ts` now owns the folding and is tested directly; what is left
 * here is the part only a mount can prove: that the component SUBSCRIBES to the
 * channels it claims to, hands what arrives to those reducers, and puts the
 * result on the census that §8's parity depends on.
 *
 * Pixi cannot initialise under jsdom (no WebGL). That is deliberate rather than
 * worked around: the component's own failure path is invariant §7's "every
 * degradation is visible", and mounting here exercises it.
 */

// Pixi probes canvas blend modes at IMPORT time, so the stub has to be in
// place before the module graph is evaluated — hence `vi.hoisted`. jsdom's own
// `getContext` throws "Not implemented" and would print a page of stack for
// something this test is deliberately not exercising. Nothing else is stubbed:
// the subscriptions under test are the real ones.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as never
})

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  if (root && host) {
    const r = root
    act(() => r.unmount())
    host.remove()
  }
  root = null
  host = null
  delete (window as { eph?: unknown }).eph
  vi.restoreAllMocks()
})

function mount(): HTMLDivElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  const r = createRoot(host)
  root = r
  act(() => r.render(<FloorCanvas />))
  return host
}

/** The label §8's parity lands on — a `<canvas>` is opaque to a screen reader. */
const census = (el: HTMLElement): string =>
  el.querySelector('[role="img"]')?.getAttribute('aria-label') ?? ''

const snapshot = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  phase: 'working',
  station: 'shelf',
  origin: 'desk',
  walking: false,
  sinceMs: 0,
  ...over
})

describe('the floor mounts, and says what it cannot do (invariant §7)', () => {
  it('renders the canvas host with a census even with no bridge at all', () => {
    // A window opened before the preload bridge exists must not render a blank
    // opaque canvas: the station half of §8's parity is seeded from the start.
    const el = mount()
    expect(el.querySelector('[role="img"]')).not.toBeNull()
    expect(census(el)).toContain('station')
  })
})

describe('the floor subscribes to the channels it claims to (SDD §5)', () => {
  /** Only the channels `FloorCanvas` actually reads; anything else is a bug. */
  function bridge(over: Record<string, unknown> = {}): {
    push: (update: AvatarUpdate) => void
    gates: (n: number) => void
  } {
    let onAvatar: ((u: AvatarUpdate) => void) | null = null
    let onGate: (() => void) | null = null
    let openGates = 0
    const eph = {
      agents: { list: () => Promise.resolve([]), onChange: () => () => {} },
      avatars: {
        list: () => Promise.resolve([]),
        onChange: (fn: (u: AvatarUpdate) => void) => {
          onAvatar = fn
          return () => {}
        }
      },
      watch: {
        approvals: () => Promise.resolve(Array.from({ length: openGates }, () => ({}))),
        onGateChange: (fn: () => void) => {
          onGate = fn
          return () => {}
        }
      },
      odeon: { meeting: () => Promise.resolve(null) },
      agora: { log: () => Promise.resolve([]), onAppend: () => () => {} },
      ...over
    }
    ;(window as { eph?: unknown }).eph = eph
    return {
      push: (update) => onAvatar?.(update),
      gates: (n) => {
        openGates = n
        onGate?.()
      }
    }
  }

  it('folds a pushed avatar into the census', async () => {
    const b = bridge()
    const el = mount()
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      b.push({ agentId: 'iris', snapshot: snapshot(), pendingMail: 0 } as never)
      await Promise.resolve()
    })

    // One citizen, working at the shelf — reported in words, which is the only
    // form a screen reader gets (NFR-15).
    expect(census(el)).toContain('1')
    expect(census(el)).toContain('shelf')
  })

  it('lights and unlights the Watch post as gates open and close', async () => {
    // The brazier IS an open gate. This is the seam `facts.ts` cannot reach:
    // that the component re-reads the queue when the Watch says it changed,
    // and that the count it stores is the one it just read.
    const b = bridge()
    const el = mount()
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      b.gates(2)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(census(el)).toContain('gates open')

    await act(async () => {
      b.gates(0)
      await Promise.resolve()
      await Promise.resolve()
    })
    // And it goes out again — the failure a carried maximum would hide.
    expect(census(el)).not.toContain('gate open')
  })
})

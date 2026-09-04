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

/**
 * The licensed art pack, supplied to this file rather than read off the disk.
 *
 * ## Why this stub exists, and why it is not a convenience
 *
 * `floor/tileset.ts` and `floor/characters.ts` resolve their state from
 * `import.meta.glob('../assets/{tileset,characters}/*.png')`. Those PNGs are a
 * deliberate gitignored drop (`.gitignore:14`, `:26`; `assets/ATTRIBUTION.md`
 * rule 2 keeps assets whose licence forbids redistributing them in source form
 * out of the repository). So the glob is populated on a machine that bought the
 * pack and EMPTY everywhere else — every CI runner, every fresh clone, every
 * `git worktree`, permanently and by design.
 *
 * With the glob empty, `tileset.layers` and `characters.urls` are both empty,
 * the two loader loops in `FloorCanvas` iterate zero times, and `loadOne` is
 * never called. That had two consequences, and the second is the serious one:
 *
 *  - The subsystem's coverage differed by ten lines, one function, six branches
 *    and ten statements depending on whether the machine held a licence — a
 *    build input `scripts/check-coverage.cjs` cannot see, because its tree hash
 *    covers `.ts`/`.tsx` only. On 2026-09-04 that split reached the gate as a
 *    win32 floor recorded WITH the pack and a worktree measurement taken
 *    without one, and was misread twice: first as a ratchet on a lucky run,
 *    then as machine jitter.
 *  - **The art-loading path was exercised on exactly one machine on earth.**
 *    `loadOne`, both loader loops and the sheet-error arm have never once run
 *    in CI. Under this repository's own seam rule (ENGINEERING-STANDARDS §6.7)
 *    that is a defect, and it would still be one if the floors were perfect.
 *
 * So the inputs are pinned here. The stub calls the REAL resolvers over fixed
 * glob records rather than hand-building a `TilesetState`/`CharactersState`,
 * for the reason the M8.4 fixtures were captured rather than typed: a literal
 * state object is our idea of the shape, and it drifts from the schema the
 * moment the schema moves. What the component receives is what
 * `resolveTileset`/`resolveCharacters` actually produce for an installed pack.
 */
vi.mock('../../src/renderer/src/floor/tileset', async () => {
  const { resolveTileset } = await vi.importActual<typeof import('../../src/shared/tileset')>(
    '../../src/shared/tileset'
  )
  return {
    tilesetState: () =>
      resolveTileset(
        { '../assets/tileset/pack.png': '/pack.png' },
        {
          '../assets/tileset/pack.tiles.json': {
            schemaVersion: 1,
            name: 'Stub Pack',
            sheet: 'pack.png',
            tilePx: 16,
            columns: 10,
            frames: { wall: 0, 'floor-a': 11, 'floor-b': 12, station: 20 }
          }
        }
      )
  }
})

vi.mock('../../src/renderer/src/floor/characters', async () => {
  const { resolveCharacters } = await vi.importActual<typeof import('../../src/shared/characters')>(
    '../../src/shared/characters'
  )
  return {
    charactersState: () =>
      resolveCharacters(
        { '../assets/characters/a.png': '/a.png', '../assets/characters/b.png': '/b.png' },
        {
          '../assets/characters/pack.chars.json': {
            schemaVersion: 1,
            name: 'stub pack',
            sheets: ['a.png', 'b.png'],
            frameW: 16,
            frameH: 32,
            idleRow: 0,
            walkRow: 1,
            walkFrames: 6
          }
        }
      )
  }
})

let root: Root | null = null
let host: HTMLDivElement | null = null
/**
 * The mount's bring-up, captured so every case can WAIT for it.
 *
 * Without it each case raced the component's own fire-and-forget chain and
 * measured whatever had happened by the time the file tore down: this file's
 * covered line count moved between runs on an unchanged tree (103 or 104 of
 * 324, 26 or 27 functions), and that reached the coverage gate as
 * `terraces.functions` 84.16 against a floor of 84.65. Flushing a couple of
 * microtasks — `await Promise.resolve()`, which is what these cases used to
 * do — is not waiting; it is guessing how deep the chain is.
 */
let broughtUp: Promise<void> = Promise.resolve()

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
  broughtUp = Promise.resolve()
  act(() =>
    r.render(
      <FloorCanvas
        onBringUp={(settled) => {
          broughtUp = settled
        }}
      />
    )
  )
  return host
}

/**
 * Mount, and wait until the floor has finished trying — every case starts here.
 * `act` around the await is what flushes the state update the bring-up's
 * failure arm makes, so the degradation the next assertion reads is on screen.
 */
async function mounted(): Promise<HTMLDivElement> {
  const el = mount()
  await act(async () => {
    await broughtUp
  })
  return el
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
  it('renders the canvas host with a census even with no bridge at all', async () => {
    // A window opened before the preload bridge exists must not render a blank
    // opaque canvas: the station half of §8's parity is seeded from the start.
    const el = await mounted()
    expect(el.querySelector('[role="img"]')).not.toBeNull()
    expect(census(el)).toContain('station')
  })

  it('says the floor is unavailable once the bring-up has finished failing', async () => {
    // The assertion this file's own docblock has always claimed and never
    // made. It could not be made: the failure arm runs whenever the bring-up
    // gets round to it, and before `onBringUp` there was no way to know that
    // had happened — so the degradation was EXERCISED (which is why its lines
    // moved between runs) and never READ.
    //
    // It is also what keeps the wait in `mounted` load-bearing: drop the await
    // and this case fails, rather than the suite quietly going back to
    // measuring whatever the machine felt like doing.
    const el = await mounted()
    expect(el.textContent).toContain('floor unavailable:')
    // And the census survives it. A floor that cannot paint a single pixel
    // still reports its population in words, which is the whole of what a
    // screen reader was ever getting (NFR-15, §8 parity).
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
    const el = await mounted()

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
    const el = await mounted()

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

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ProfilesPanel } from '../../src/renderer/src/ProfilesPanel'

/**
 * The override's drop rule, wired (M8.5 audit, 2026-09-07).
 *
 * `overrideAfterRetarget` is table-tested next door. This file covers the SEAM
 * — that the panel actually consults it when the Architect edits the target —
 * because a mutation that stopped the panel calling it at all killed nothing:
 * the static-markup harness runs no handler, so a rule extracted for
 * testability was still wired to nothing that could notice.
 *
 * That is the M6 lesson in miniature, and the reason the extraction alone was
 * not the fix: a green pure function reachable from no running component is
 * exactly the shape this repository has paid for before.
 */

let root: Root | null = null
let host: HTMLDivElement

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  delete (window as { eph?: unknown }).eph
})

/** The two reads `ProfilesPanel` makes on mount, and nothing else. */
function bridge(): void {
  Object.assign(window, {
    eph: {
      profiles: {
        list: async () => [],
        instances: async () => []
      }
    }
  })
}

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ProfilesPanel />)
  })
}

function field(label: string): HTMLInputElement {
  const found = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!found) throw new Error(`no field labelled ${label}`)
  return found
}

/** React tracks the previous value on the node, so a bare assignment is eaten. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.bind(
      input
    )
    setter?.(value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the repository override, in a running panel', () => {
  it('drops what was typed for the previous checkout when the target moves', async () => {
    bridge()
    await mount()
    await type(field('target id'), 'musahit')
    await type(field('target path'), 'C:/checkouts/musahit')
    await type(field('repositories to watch'), 'upstream-owner/app')
    expect(field('repositories to watch').value).toBe('upstream-owner/app')

    // The Architect points the form at a different checkout. The answer they
    // gave about the FIRST one must not travel: a slug typed for one fork,
    // applied to another target, files this company's incidents against a
    // repository nobody chose — which is the outcome `deriveRepo` refuses to
    // risk by guessing, reached from the other side.
    await type(field('target path'), 'C:/checkouts/something-else')

    expect(field('repositories to watch').value).toBe('')
  })

  it('keeps it while the Architect is still editing the same checkout', async () => {
    // The counterweight: clearing on every keystroke regardless would make the
    // box unusable, and "blunt in the safe direction" still has to leave the
    // safe direction usable.
    bridge()
    await mount()
    await type(field('target path'), 'C:/checkouts/musahit')
    await type(field('repositories to watch'), 'owner/app')

    // A re-render with the same values, the way an unrelated state change does.
    await type(field('target path'), 'C:/checkouts/musahit')

    expect(field('repositories to watch').value).toBe('owner/app')
  })
})

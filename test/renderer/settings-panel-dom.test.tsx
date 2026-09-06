// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SettingsPanel } from '../../src/renderer/src/SettingsPanel'
import type { GateCeilings, GatePolicyView } from '../../src/shared/gates'

/**
 * The ceilings panel as a running component (FR-11.7).
 *
 * `test/renderer/settings-panel.test.tsx` covers the decisions; this file
 * covers the WIRE — button → `ceilingForm` → `watch:set-policy` → what the
 * panel does with the answer. A seam with no test is a defect (M8.0), and this
 * seam carries a safety control: a SAVE that posted the wrong ceilings, or a
 * panel that kept displaying an edit main refused, would both be silent.
 */

let root: Root | null = null
let host: HTMLDivElement

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  delete (window as { eph?: unknown }).eph
})

interface Rig {
  readonly sent: GateCeilings[]
}

function bridge(
  view: GatePolicyView,
  answer?: (ceilings: GateCeilings) => {
    ok: boolean
    reason: string | null
    view: GatePolicyView
  }
): Rig {
  const sent: GateCeilings[] = []
  Object.assign(window, {
    eph: {
      watch: {
        policy: async () => view,
        setPolicy: async (ceilings: GateCeilings) => {
          sent.push(ceilings)
          return answer === undefined
            ? { ok: true, reason: null, view: { ...ceilings, warning: null } }
            : answer(ceilings)
        }
      }
    }
  })
  return { sent }
}

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<SettingsPanel />)
  })
}

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!found) throw new Error(`no button labelled ${label}`)
  return found
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click()
  })
}

describe('the ceilings panel, wired', () => {
  it('shows what is in force once main answers', async () => {
    bridge({ autonomy: 'supervised', maxDailyTokens: 250, warning: null })
    await mount()

    expect(button('SUPERVISED').getAttribute('aria-pressed')).toBe('true')
    expect(button('CEILING').getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelector('input')?.value).toBe('250')
    expect(host.textContent).toContain('250 tokens a day')
  })

  it('sends the autonomy ceiling the Architect chose', async () => {
    const rig = bridge({ autonomy: 'manual', maxDailyTokens: null, warning: null })
    await mount()

    await click('AUTONOMOUS')
    expect(host.textContent).toContain('unsaved')
    await click('SAVE CEILINGS')

    expect(rig.sent).toEqual([{ autonomy: 'autonomous', maxDailyTokens: null }])
    expect(host.textContent).not.toContain('unsaved')
  })

  it('turns a ceiling on, and off again, from the same two controls', async () => {
    const rig = bridge({ autonomy: 'autonomous', maxDailyTokens: null, warning: null })
    await mount()

    await click('CEILING')
    const input = host.querySelector('input')
    if (!input) throw new Error('no ceiling field')
    await act(async () => {
      // React tracks the previous value on the node, so a bare `.value =`
      // assignment is swallowed as "no change" and no onChange fires.
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      )?.set?.bind(input)
      setter?.('40,000,000')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('SAVE CEILINGS')
    expect(rig.sent.at(-1)).toEqual({ autonomy: 'autonomous', maxDailyTokens: 40_000_000 })

    await click('UNBUDGETED')
    await click('SAVE CEILINGS')
    // `null` is what deletes the key. A zero here would read as a company
    // breached before its first token (ADR-0029).
    expect(rig.sent.at(-1)).toEqual({ autonomy: 'autonomous', maxDailyTokens: null })
  })

  it('will not post a half-typed figure', async () => {
    const rig = bridge({ autonomy: 'autonomous', maxDailyTokens: null, warning: null })
    await mount()

    await click('CEILING')

    expect(button('SAVE CEILINGS').disabled).toBe(true)
    expect(host.textContent).toContain('enter a number of tokens')
    expect(rig.sent).toEqual([])
  })

  it('shows the ceilings still IN FORCE after a refused save, not the edit', async () => {
    // The §7 case. A panel left displaying the value it failed to write tells
    // the Architect the company is capped when it is not.
    const inForce: GatePolicyView = { autonomy: 'manual', maxDailyTokens: null, warning: null }
    bridge(inForce, () => ({
      ok: false,
      reason: 'gate-policy.json could not be read, so nothing was changed: ENOENT',
      view: inForce
    }))
    await mount()

    await click('AUTONOMOUS')
    await click('SAVE CEILINGS')

    expect(host.textContent).toContain('nothing was changed')
    expect(button('MANUAL').getAttribute('aria-pressed')).toBe('true')
    expect(button('AUTONOMOUS').getAttribute('aria-pressed')).toBe('false')
  })

  it('says so when what it is showing is the deny-all fallback', async () => {
    bridge({
      autonomy: 'manual',
      maxDailyTokens: null,
      warning: 'gate-policy.json is missing, so every gated action is held'
    })
    await mount()

    expect(host.textContent).toContain('gate-policy.json is missing')
  })

  it('does not offer the rules table', async () => {
    bridge({ autonomy: 'autonomous', maxDailyTokens: null, warning: null })
    await mount()

    // Deliberate: widening `needs-human` is a file edit by someone who has read
    // what the kind means, not a click. See `gateCeilingsSchema`.
    expect(host.textContent).not.toMatch(/needs-human|destructive|prod-facing/)
  })

  it('does nothing at all without the bridge', async () => {
    await mount()

    expect(host.textContent).toContain('reading gate-policy.json')
    expect(button('AUTONOMOUS').disabled).toBe(true)
  })
})

describe('a bridge that rejects', () => {
  it('reports the failure rather than showing a ceiling it never read', async () => {
    Object.assign(window, {
      eph: { watch: { policy: () => Promise.reject(new Error('bridge down')) } }
    })
    await mount()
    await act(async () => {
      await Promise.resolve()
    })

    expect(host.textContent).toContain('bridge down')
    expect(host.textContent).toContain('reading gate-policy.json')
  })

  it('reports a save that never landed', async () => {
    const view: GatePolicyView = { autonomy: 'manual', maxDailyTokens: null, warning: null }
    Object.assign(window, {
      eph: {
        watch: {
          policy: async () => view,
          setPolicy: () => Promise.reject(new Error('ipc closed'))
        }
      }
    })
    await mount()

    await click('SUPERVISED')
    await click('SAVE CEILINGS')

    expect(host.textContent).toContain('ipc closed')
    // And is not left wedged in SAVING… with a button nobody can press again.
    expect(button('SAVE CEILINGS').disabled).toBe(false)
  })
})

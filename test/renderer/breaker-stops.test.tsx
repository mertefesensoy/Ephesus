// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BreakerStops, WatchPanel } from '../../src/renderer/src/WatchPanel'
import type { BreakerStop } from '../../src/shared/breaker'

vi.mock('../../src/renderer/src/SecretsPanel', () => ({ SecretsPanel: () => null }))
const stop: BreakerStop = {
  agentId: 'agent.artemis',
  at: 100_000,
  signals: ['burn-rate'],
  detail: [{ tokens: 100 }]
}
let root: Root | null = null
let host: HTMLDivElement
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  delete (window as { eph?: unknown }).eph
})
async function mount(element: React.ReactElement): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(element)
  })
}

describe('standing stops on the Watch', () => {
  it('shows a restored agent with no live card and clears the reviewed revision through IPC', async () => {
    let stops = [stop]
    const clear = vi.fn(async () => {
      stops = []
      return true
    })
    Object.assign(window, {
      eph: {
        watch: {
          approvals: async () => [],
          humanQueue: async () => [],
          budgets: async () => [],
          breakerState: async () => [],
          breakerStops: async () => ({ stops, error: null }),
          clearBreakerStop: clear,
          onGateChange: () => () => {}
        }
      }
    })
    await mount(<WatchPanel />)
    expect(host.textContent).toContain('agent.artemis')
    expect(host.textContent).toContain('burn-rate')
    expect(host.textContent).toContain('does not start the agent')
    await act(async () => {
      host.querySelector('button')!.click()
    })
    expect(clear).toHaveBeenCalledWith('agent.artemis', 100_000)
    expect(host.textContent).toContain('No standing stops.')
  })

  it('keeps a failed clear visible and prevents duplicate requests while pending', async () => {
    let reject!: (reason: Error) => void
    const clear = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail
        })
    )
    await mount(<BreakerStops view={{ stops: [stop], error: null }} onClear={clear} />)
    await act(async () => {
      host.querySelector('button')!.click()
    })
    expect(host.querySelector('button')!.disabled).toBe(true)
    await act(async () => {
      host.querySelector('button')!.click()
      reject(new Error('stop changed'))
    })
    expect(clear).toHaveBeenCalledOnce()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('stop changed')
    expect(host.textContent).toContain('agent.artemis')
    expect(host.querySelector('button')!.disabled).toBe(false)
  })

  it('disables clearing and shows storage faults', async () => {
    await mount(
      <BreakerStops
        view={{ stops: [stop], error: 'Storage unreadable' }}
        onClear={async () => {}}
      />
    )
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Storage unreadable')
    expect(host.querySelector('button')!.disabled).toBe(true)
  })
})

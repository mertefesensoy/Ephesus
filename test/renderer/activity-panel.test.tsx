// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ActivityPanel } from '../../src/renderer/src/ActivityPanel'
import type { LogEntry } from '../../src/shared/log'

/**
 * The Activity panel's window on the book of record (M8.3).
 *
 * Register item B4: the panel opened its cursor at seq 0 and paged forward, so
 * after an overnight run it showed the company's FIRST 300 events and then
 * crawled towards the present one append at a time. Nothing failed; the panel
 * was simply looking at the wrong end of the file, and every fixture was small
 * enough that head and tail were the same rows.
 *
 * So this mounts the real component against a log LARGER than its window and
 * asserts WHICH rows arrive — never how many, which would have passed against
 * the defect.
 */

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  if (root && host) {
    const current = root
    act(() => current.unmount())
    host.remove()
  }
  root = null
  host = null
  delete (window as { eph?: unknown }).eph
})

interface Calls {
  readonly tail: number[]
  readonly forward: { afterSeq: number; limit: number }[]
  fire: () => void
}

/** A log of `total` entries behind the real IPC shape the panel calls. */
function bridge(total: number): Calls {
  const entries: LogEntry[] = Array.from({ length: total }, (_, i) => ({
    ts: 1_000 + i,
    seq: i + 1,
    kind: 'delivery',
    from: 'agent.mason',
    to: 'agent.tess',
    act: 'inform',
    subject: `event ${String(i + 1)}`
  })) as LogEntry[]
  const tail: number[] = []
  const forward: { afterSeq: number; limit: number }[] = []
  let listener: (() => void) | null = null
  ;(window as unknown as { eph: unknown }).eph = {
    agora: {
      logTail: (limit: number) => {
        tail.push(limit)
        return Promise.resolve(entries.slice(-limit))
      },
      log: (afterSeq: number, limit: number) => {
        forward.push({ afterSeq, limit })
        return Promise.resolve(entries.filter((entry) => entry.seq > afterSeq).slice(0, limit))
      },
      onAppend: (cb: () => void) => {
        listener = cb
        return () => {
          listener = null
        }
      }
    }
  }
  return {
    tail,
    forward,
    fire: () => listener?.()
  }
}

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  const created = createRoot(host)
  root = created
  await act(async () => {
    created.render(<ActivityPanel />)
    await Promise.resolve()
  })
  // let the tail promise settle into state
  await act(async () => {
    await Promise.resolve()
  })
}

describe('the Activity panel opens at the end of the book', () => {
  it('asks for the TAIL first, not the head', async () => {
    const calls = bridge(1_177)
    await mount()
    expect(calls.tail).toEqual([300])
    // The forward cursor is for following along, and nothing has arrived yet.
    expect(calls.forward).toEqual([])
  })

  it('shows the NEWEST events, which is what an overnight run needs', async () => {
    const calls = bridge(1_177)
    await mount()
    const text = host?.textContent ?? ''
    // The last event is on screen…
    expect(text).toContain('event 1177')
    expect(text).toContain('#1177')
    // …and the company's first morning is not, which is what B4 showed.
    expect(text).not.toContain('event 1 ')
    expect(text).not.toContain('#1<')
    expect(calls.tail).toHaveLength(1)
  })

  it('then follows forward from where the tail left it', async () => {
    const calls = bridge(1_177)
    await mount()
    await act(async () => {
      calls.fire()
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    // Paging resumes from the newest seq the panel has shown, never from 0.
    expect(calls.forward).toEqual([{ afterSeq: 1_177, limit: 300 }])
  })

  it('renders the row text the shared formatter produces', async () => {
    bridge(3)
    await mount()
    const text = host?.textContent ?? ''
    expect(text).toContain('agent.mason → agent.tess · inform · event 3')
  })

  it('says so when the book is empty', async () => {
    bridge(0)
    await mount()
    expect(host?.textContent ?? '').toContain('no events yet')
  })
})

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
  /** Only meaningful under `deferTail`; lets the tail read answer late. */
  releaseTail: () => void
  /** Only meaningful under `deferForward`; answers forward page `index`. */
  releaseForward: (index: number) => void
  /** Appends one entry to the log the rig serves, and returns its seq. */
  append: () => number
}

/**
 * A log of `total` entries behind the real IPC shape the panel calls.
 *
 * `deferTail` and `deferForward` hold a read open so a test can decide the
 * ORDER the reads answer in. Both are real IPC round trips in the product and
 * neither is guaranteed to win, so the order is a property of the panel rather
 * than of the rig — and every one of these orderings really happens on a
 * company that is appending while a window opens.
 */
function bridge(
  total: number,
  options: { readonly deferTail?: boolean; readonly deferForward?: boolean } = {}
): Calls {
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
  const forwardResolvers: (() => void)[] = []
  let listener: (() => void) | null = null
  let releaseTail: (() => void) | undefined
  ;(window as unknown as { eph: unknown }).eph = {
    agora: {
      logTail: (limit: number) => {
        tail.push(limit)
        const answer = entries.slice(-limit)
        if (!options.deferTail) return Promise.resolve(answer)
        return new Promise<readonly LogEntry[]>((resolve) => {
          releaseTail = () => resolve(answer)
        })
      },
      log: (afterSeq: number, limit: number) => {
        forward.push({ afterSeq, limit })
        const answer = entries.filter((entry) => entry.seq > afterSeq).slice(0, limit)
        if (!options.deferForward) return Promise.resolve(answer)
        return new Promise<readonly LogEntry[]>((resolve) => {
          forwardResolvers.push(() => resolve(answer))
        })
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
    fire: () => listener?.(),
    releaseTail: () => releaseTail?.(),
    releaseForward: (index: number) => forwardResolvers[index]?.(),
    append: () => {
      const seq = entries.length + 1
      entries.push({
        ts: 1_000 + seq,
        seq,
        kind: 'delivery',
        from: 'agent.mason',
        to: 'agent.tess',
        act: 'inform',
        subject: `event ${String(seq)}`
      } as LogEntry)
      return seq
    }
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

/**
 * The two reads race, and the panel has to survive either order.
 *
 * Opening the panel starts a tail read; the company does not stop appending
 * while it is in flight. Both legs are IPC round trips, so nothing orders them,
 * and the M8.3 version had no defence at all: a forward page issued at seq 0
 * while the tail was still open would answer with the company's FIRST rows,
 * append them, and rewind the cursor to 300 — register item B4 arriving through
 * the back door, on the very code path added to fix it.
 *
 * Neither case is reachable through the panel's own API once the fix is in
 * place, which is the point: these assert the two independent guarantees that
 * make it unreachable, so removing either one fails a test.
 */
describe('the Activity panel survives the opening race', () => {
  it('does not page from seq 0 when an append lands before the panel has opened', async () => {
    const calls = bridge(1_177, { deferTail: true })
    await mount()
    // The company keeps working while the window is opening.
    calls.append()
    await act(async () => {
      calls.fire()
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    // Nothing has been asked for: the only cursor available right now is 0,
    // and a page from there is the defect.
    expect(calls.forward).toEqual([])
    expect(calls.tail).toEqual([300])

    await act(async () => {
      calls.releaseTail()
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    // The tail is on screen…
    expect(host?.textContent ?? '').toContain('#1177')
    // …the append that arrived during the opening read is NOT lost…
    expect(host?.textContent ?? '').toContain('event 1178')
    // …and it was collected from the tail's cursor, never from the head.
    expect(calls.forward).toEqual([{ afterSeq: 1_177, limit: 300 }])
  })

  it('drops a forward page that answers after a newer one', async () => {
    const calls = bridge(1_177, { deferForward: true })
    await mount()
    // Two pulls end up in flight together: the second is scheduled while the
    // first is still open, so both ask from the same cursor.
    calls.append()
    await act(async () => {
      calls.fire()
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    calls.append()
    await act(async () => {
      calls.fire()
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    expect(calls.forward).toEqual([
      { afterSeq: 1_177, limit: 300 },
      { afterSeq: 1_177, limit: 300 }
    ])

    // The NEWER answer lands first, then the older one.
    await act(async () => {
      calls.releaseForward(1)
      await new Promise((resolve) => setTimeout(resolve, 0))
      calls.releaseForward(0)
      await new Promise((resolve) => setTimeout(resolve, 200))
    })

    const text = host?.textContent ?? ''
    expect(text).toContain('event 1179')
    // Row 1178 arrived in both answers and appears exactly once — a book of
    // record shown twice is a second record, which this panel must never be.
    expect(text.split('#1178').length - 1).toBe(1)

    // And the cursor did not rewind: the next page starts after the newest row.
    await act(async () => {
      calls.append()
      calls.fire()
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    expect(calls.forward[2]).toEqual({ afterSeq: 1_179, limit: 300 })
  })
})

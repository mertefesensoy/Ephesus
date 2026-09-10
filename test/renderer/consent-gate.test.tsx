// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ConsentGate, headlineFor } from '../../src/renderer/src/ConsentGate'
import {
  CONSENT_TERMS_VERSION,
  type ConsentGrantOutcome,
  type ConsentView
} from '../../src/shared/consent'

/**
 * The consent banner as a running component (DD-6, M8.12).
 *
 * The seam this covers is the one a stranger meets in their first thirty
 * seconds: main says the company is not working, the banner says what starting
 * it would do, and the button reaches `consent:grant`. A seam with no test is a
 * defect (M8.0), and this one is the difference between a gate and a
 * decoration.
 */

let root: Root | null = null
let host: HTMLDivElement

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  delete (window as { eph?: unknown }).eph
})

const WITHHELD: ConsentView = {
  state: 'never-asked',
  mayStartWork: false,
  because: 'nobody has said go on this machine yet',
  terms: CONSENT_TERMS_VERSION,
  grantedAt: null,
  disclosure: {
    hire: { agentId: 'artemis', engine: 'claude' },
    triggers: [{ id: 'standup', everyMs: 1_800_000 }],
    dailyCeiling: null
  }
}

const GRANTED: ConsentView = {
  ...WITHHELD,
  state: 'granted',
  mayStartWork: true,
  because: 'granted 2026-09-07T22:00:00.000Z',
  grantedAt: '2026-09-07T22:00:00.000Z'
}

interface Rig {
  readonly grants: number[]
  /** M8c.3: what the banner ANSWERED about the ceiling, per grant. */
  readonly unbudgeted: boolean[]
}

function bridge(view: ConsentView, answer?: () => ConsentGrantOutcome): Rig {
  const grants: number[] = []
  const unbudgeted: boolean[] = []
  Object.assign(window, {
    eph: {
      consent: {
        get: async () => view,
        grant: async (accept: boolean) => {
          grants.push(grants.length + 1)
          unbudgeted.push(accept)
          return answer?.() ?? { ok: true, reason: null, view: GRANTED }
        }
      }
    }
  })
  return { grants, unbudgeted }
}

async function render(): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<ConsentGate />)
  })
}

const button = (): HTMLButtonElement | null => host.querySelector('button')

describe('while consent is withheld', () => {
  it('renders the banner, so an unstarted company is not a quiet one', async () => {
    bridge(WITHHELD)
    await render()
    expect(host.textContent).toContain('The company is not working yet')
    expect(host.textContent).toContain('nobody has said go')
  })

  it('shows the SPECIFIC disclosure main sent, not a fixed paragraph', async () => {
    bridge(WITHHELD)
    await render()
    // The three things a person needs to refuse on: who, whose money, what clocks.
    expect(host.textContent).toContain('artemis')
    expect(host.textContent).toContain('claude')
    expect(host.textContent).toContain('YOUR subscription')
    expect(host.textContent).toContain('standup (every 30 minutes)')
    expect(host.textContent).toContain('unbudgeted')
  })

  it('offers exactly one control', async () => {
    bridge(WITHHELD)
    await render()
    expect(host.querySelectorAll('button')).toHaveLength(1)
    // M8c.3. With no ceiling set, starting IS the unbudgeted answer, and the
    // button says which answer it is giving rather than hiding it behind a
    // neutral verb. A company with a ceiling reads 'START THE COMPANY'.
    expect(button()?.textContent).toBe('START UNBUDGETED')
  })

  it('says START THE COMPANY once a ceiling is set', async () => {
    bridge({ ...WITHHELD, disclosure: { ...WITHHELD.disclosure, dailyCeiling: 300_000 } })
    await render()
    expect(button()?.textContent).toBe('START THE COMPANY')
  })

  it('answers the ceiling question, and answers it HONESTLY', async () => {
    // The banner must not send `unbudgeted: true` for a company that has a
    // ceiling — that would be an answer to a question nobody asked, and it
    // would pass the gate for the wrong reason on the day the ceiling is
    // dropped.
    const bounded = bridge({
      ...WITHHELD,
      disclosure: { ...WITHHELD.disclosure, dailyCeiling: 300_000 }
    })
    await render()
    await act(async () => {
      button()?.click()
    })
    expect(bounded.unbudgeted).toEqual([false])
  })
})

describe('the grant', () => {
  it('reaches main and clears the banner', async () => {
    const rig = bridge(WITHHELD)
    await render()
    await act(async () => {
      button()?.click()
    })
    expect(rig.grants).toEqual([1])
    // No ceiling on this fixture, so the banner's answer is the explicit one.
    expect(rig.unbudgeted).toEqual([true])
    expect(host.textContent).toBe('')
  })

  it('keeps the banner up when main refuses, and says why', async () => {
    // A grant that could not be written down must not look like a grant. This
    // is the direction that would be easy to get wrong: optimistically hiding
    // the banner would tell the Architect the company started when it did not.
    bridge(WITHHELD, () => ({
      ok: false,
      reason: 'consent could not be recorded: EROFS: read-only file system',
      view: WITHHELD
    }))
    await render()
    await act(async () => {
      button()?.click()
    })
    expect(host.textContent).toContain('The company is not working yet')
    expect(host.textContent).toContain('EROFS')
  })
})

describe('once consent is on file', () => {
  it('renders nothing at all', async () => {
    bridge(GRANTED)
    await render()
    expect(host.textContent).toBe('')
  })

  it('renders nothing when main cannot be reached', async () => {
    // A banner that appeared because it could not READ the state would block an
    // app whose company is already running. The strip's bridge badge is what
    // reports a main process that will not answer.
    Object.assign(window, {
      eph: {
        consent: {
          get: async () => {
            throw new Error('bridge down')
          },
          grant: async () => ({ ok: false, reason: 'unreachable', view: WITHHELD })
        }
      }
    })
    await render()
    expect(host.textContent).toBe('')
  })
})

describe('headlineFor', () => {
  it('names a moved disclosure differently from a first launch', () => {
    // The two withheld states are not the same news: one is "you have not been
    // asked", the other is "what you agreed to has changed".
    expect(headlineFor(WITHHELD)).toContain('not working yet')
    expect(headlineFor({ ...WITHHELD, state: 'stale-terms' })).toContain('has changed')
  })
})

describe('a preload older than this renderer', () => {
  it('renders nothing instead of crashing the app at the top of the tree', async () => {
    // `window.eph` comes from preload. A renderer that mounted against a build
    // without `consent` would throw in a mount effect ABOVE every panel, and
    // the whole window would go blank — a worse failure than no banner. Main
    // still reports the withheld condition through the degradation channel, so
    // the state is not invisible.
    Object.assign(window, { eph: { config: { get: async () => ({}) } } })
    await render()
    expect(host.textContent).toBe('')
  })
})

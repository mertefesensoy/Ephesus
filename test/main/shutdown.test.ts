import { describe, expect, it } from 'vitest'
import { ClosingTime, CLOSING_ACK_SUBJECT } from '../../src/main/closing'
import { QuitSequence, summarizeQuit, type QuitStep } from '../../src/main/shutdown'
import { UiBridge } from '../../src/main/ui-bridge'
import { composeMessage, makeMessageId, type Message } from '../../src/shared/message'
import { CLOSING_ENDPOINT } from '../../src/shared/reserved'
import { FakeWindow } from '../fakes/fake-window'

/**
 * The quit sequence (M8.1) — the thing S-CLOSING could not reach.
 *
 * The old quit path lived inside `index.ts` as a closure over module state, so
 * no test could run it. What the scenario ran instead was the rig's own copy of
 * production's closing wiring, and the copy left out the one line that threw:
 * `mainWindow?.webContents.send(LOG_APPEND_CHANNEL)` in `onLogEvent`. Three
 * suites were green against a protocol that had never once completed on the
 * Architect's machine.
 *
 * So the last block here wires the REAL `ClosingTime` to the REAL `UiBridge`
 * exactly as `index.ts` does, destroys the window the way Electron does, and
 * asserts the sequence finishes anyway — beside a case that reproduces the old
 * wiring and shows it throwing. Those two are the package.
 */

/** Records the order phases ran in; the ordering is the sequence's whole job. */
function timeline(): { readonly seen: string[]; step: (name: string) => QuitStep } {
  const seen: string[] = []
  return {
    seen,
    step: (name) => ({
      name,
      run: () => {
        seen.push(name)
      }
    })
  }
}

interface Recorded {
  readonly source: string
  readonly detail: string
}

function sequence(over: Partial<Parameters<typeof buildOptions>[0]> = {}): {
  quit: QuitSequence
  degradations: Recorded[]
  seen: string[]
} {
  const degradations: Recorded[] = []
  const t = timeline()
  const options = buildOptions({
    live: ['agent.mason'],
    answer: 'closing',
    closing: null,
    agents: { unwound: ['agent.mason'], failed: [] },
    steps: [t.step('ptys'), t.step('db')],
    ...over
  })
  return {
    quit: new QuitSequence({
      ...options,
      onDegraded: (source, detail) => degradations.push({ source, detail })
    }),
    degradations,
    seen: t.seen
  }
}

function buildOptions(spec: {
  live: readonly string[] | (() => never)
  answer: 'closing' | 'now' | (() => never)
  closing: null | {
    readonly begin: () => Promise<{
      acked: readonly string[]
      missing: readonly string[]
      timedOut: boolean
    }>
    readonly inProgress?: boolean
  }
  agents:
    | null
    | { unwound: readonly string[]; failed: readonly { agentId: string; error: string }[] }
    | (() => never)
  steps: readonly QuitStep[]
}): Omit<ConstructorParameters<typeof QuitSequence>[0], 'onDegraded'> {
  return {
    liveAgents: () => (typeof spec.live === 'function' ? spec.live() : spec.live),
    ask: () => (typeof spec.answer === 'function' ? spec.answer() : spec.answer),
    closing: () =>
      spec.closing === null
        ? null
        : {
            inProgress: () => spec.closing?.inProgress ?? false,
            begin: spec.closing.begin
          },
    agents: () =>
      spec.agents === null
        ? null
        : {
            shutdown: async () => {
              if (typeof spec.agents === 'function') spec.agents()
              return spec.agents as {
                unwound: readonly string[]
                failed: readonly { agentId: string; error: string }[]
              }
            }
          },
    steps: () => spec.steps
  }
}

const acked =
  (
    acks: readonly string[],
    missing: readonly string[] = []
  ): (() => Promise<{ acked: readonly string[]; missing: readonly string[]; timedOut: boolean }>) =>
  async () => ({ acked: acks, missing, timedOut: missing.length > 0 })

describe('the quit sequence — order', () => {
  it('parks the agents, then unwinds them, then stops everything', async () => {
    const order: string[] = []
    const t = timeline()
    const quit = new QuitSequence({
      liveAgents: () => ['agent.mason'],
      ask: () => {
        order.push('ask')
        return 'closing'
      },
      closing: () => ({
        inProgress: () => false,
        begin: async () => {
          order.push('closing')
          return { acked: ['agent.mason'], missing: [], timedOut: false }
        }
      }),
      agents: () => ({
        shutdown: async () => {
          order.push('unwind')
          return { unwound: ['agent.mason'], failed: [] }
        }
      }),
      steps: () => [t.step('ptys'), t.step('db')],
      onDegraded: () => undefined
    })

    const report = await quit.run()
    // Agents can only park while they are alive, and settings files are only
    // restored while the ptys are; every edge here is load-bearing.
    expect([...order, ...t.seen]).toEqual(['ask', 'closing', 'unwind', 'ptys', 'db'])
    expect(report.steps).toEqual([
      { name: 'ptys', ok: true },
      { name: 'db', ok: true }
    ])
  })

  it('runs the stops in the caller’s order, not in parallel', async () => {
    const seen: string[] = []
    const slow: QuitStep = {
      name: 'agora-drain',
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        seen.push('agora-drain')
      }
    }
    const fast: QuitStep = {
      name: 'db',
      run: () => {
        seen.push('db')
      }
    }
    const { quit } = sequence({ closing: null, steps: [slow, fast] })
    await quit.run()
    expect(seen).toEqual(['agora-drain', 'db'])
  })
})

describe('the quit sequence — the offer', () => {
  it('does not ask when nobody is working, and still tears down', async () => {
    let asked = false
    const t = timeline()
    const quit = new QuitSequence({
      liveAgents: () => [],
      ask: () => {
        asked = true
        return 'closing'
      },
      closing: () => ({ inProgress: () => false, begin: acked([]) }),
      agents: () => ({ shutdown: async () => ({ unwound: [], failed: [] }) }),
      steps: () => [t.step('db')],
      onDegraded: () => undefined
    })
    const report = await quit.run()
    expect(asked).toBe(false)
    expect(report.offered).toBe(false)
    expect(t.seen).toEqual(['db'])
  })

  it('skips closing time on "quit now" and tears down anyway', async () => {
    let began = false
    const { quit, seen } = sequence({
      answer: 'now',
      closing: {
        begin: async () => {
          began = true
          return { acked: [], missing: [], timedOut: false }
        }
      }
    })
    const report = await quit.run()
    expect(began).toBe(false)
    expect(report).toMatchObject({ offered: true, choice: 'now', closing: null })
    expect(seen).toEqual(['ptys', 'db'])
  })

  it('names the agents that never acknowledged', async () => {
    const { quit, degradations } = sequence({
      closing: { begin: acked(['agent.mason'], ['agent.tess']) }
    })
    const report = await quit.run()
    expect(report.closing).toMatchObject({ acked: ['agent.mason'], missing: ['agent.tess'] })
    expect(degradations).toEqual([
      {
        source: 'shutdown/closing-acks',
        detail: 'closing time: no acknowledgment from agent.tess by the deadline'
      }
    ])
  })

  it('does not start a second closing while one is in flight', async () => {
    let began = 0
    const { quit } = sequence({
      closing: {
        inProgress: true,
        begin: async () => {
          began += 1
          return { acked: [], missing: [], timedOut: false }
        }
      }
    })
    const report = await quit.run()
    expect(began).toBe(0)
    expect(report.offered).toBe(false)
  })
})

describe('the quit sequence — one phase failing never skips the next', () => {
  it('unwinds and stops even when closing time cannot start', async () => {
    const { quit, seen, degradations } = sequence({
      closing: {
        begin: () => {
          throw new Error('Object has been destroyed')
        }
      }
    })
    const report = await quit.run()
    expect(report.closingError).toBe('Object has been destroyed')
    expect(report.agentsUnwound).toEqual(['agent.mason'])
    expect(seen).toEqual(['ptys', 'db'])
    expect(degradations[0]).toEqual({
      source: 'shutdown/closing-time',
      detail: 'closing time failed: Object has been destroyed'
    })
  })

  it('stops everything even when the whole agent shutdown fails', async () => {
    const { quit, seen, degradations } = sequence({
      agents: () => {
        throw new Error('spawner is gone')
      }
    })
    const report = await quit.run()
    expect(report.agentsError).toBe('spawner is gone')
    expect(seen).toEqual(['ptys', 'db'])
    expect(degradations).toContainEqual({
      source: 'agents/shutdown',
      detail: 'shutdown failed: spawner is gone'
    })
  })

  it('carries per-agent failures without re-reporting them', async () => {
    // `AgentManager.shutdown` already reports each one through `onExitError`;
    // reporting again here would show the Architect one fault twice.
    const { quit, degradations } = sequence({
      agents: { unwound: ['agent.tess'], failed: [{ agentId: 'agent.mason', error: 'EBUSY' }] }
    })
    const report = await quit.run()
    expect(report.agentsFailed).toEqual(['agent.mason'])
    expect(degradations.filter((entry) => entry.source === 'agents')).toEqual([])
  })

  it('runs every later stop after one throws, and names the one that failed', async () => {
    const seen: string[] = []
    const steps: QuitStep[] = [
      {
        name: 'ptys',
        run: () => {
          throw new Error('kill failed')
        }
      },
      {
        name: 'hooks',
        run: () => {
          seen.push('hooks')
        }
      },
      {
        name: 'db',
        run: () => {
          seen.push('db')
        }
      }
    ]
    const { quit, degradations } = sequence({ closing: null, steps })
    const report = await quit.run()
    // The database being closed must not depend on the terminals dying cleanly.
    expect(seen).toEqual(['hooks', 'db'])
    expect(report.steps).toEqual([
      { name: 'ptys', ok: false, error: 'kill failed' },
      { name: 'hooks', ok: true },
      { name: 'db', ok: true }
    ])
    expect(degradations).toContainEqual({
      source: 'shutdown/stop:ptys',
      detail: 'ptys: kill failed'
    })
  })

  it('tears down even when asking who is live throws', async () => {
    const { quit, seen, degradations } = sequence({
      live: () => {
        throw new Error('roster unreadable')
      }
    })
    const report = await quit.run()
    expect(report.offered).toBe(false)
    expect(seen).toEqual(['ptys', 'db'])
    expect(degradations[0]).toEqual({
      source: 'shutdown/live-agents',
      detail: 'could not list live agents: roster unreadable'
    })
  })

  it('tears down even when the offer itself throws', async () => {
    const { quit, seen, degradations } = sequence({
      closing: { begin: acked(['agent.mason']) },
      answer: () => {
        throw new Error('no window to parent the dialog')
      }
    })
    await quit.run()
    expect(seen).toEqual(['ptys', 'db'])
    expect(degradations[0]).toEqual({
      source: 'shutdown/offer',
      detail: 'closing time was not offered: no window to parent the dialog'
    })
  })
})

describe('the quit sequence — runs once', () => {
  it('is idempotent: a second quit gesture never re-mails the company', async () => {
    let begins = 0
    let shutdowns = 0
    const t = timeline()
    const quit = new QuitSequence({
      liveAgents: () => ['agent.mason'],
      ask: () => 'closing',
      closing: () => ({
        inProgress: () => false,
        begin: async () => {
          begins += 1
          return { acked: ['agent.mason'], missing: [], timedOut: false }
        }
      }),
      agents: () => ({
        shutdown: async () => {
          shutdowns += 1
          return { unwound: ['agent.mason'], failed: [] }
        }
      }),
      steps: () => [t.step('db')],
      onDegraded: () => undefined
    })

    const [first, second] = await Promise.all([quit.run(), quit.run()])
    const third = await quit.run()
    expect(begins).toBe(1)
    expect(shutdowns).toBe(1)
    expect(t.seen).toEqual(['db'])
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('reports started before finished, so the app knows when it may exit', async () => {
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { quit } = sequence({
      closing: null,
      steps: [{ name: 'slow', run: () => gate }]
    })
    expect(quit.hasStarted()).toBe(false)
    expect(quit.hasFinished()).toBe(false)
    const running = quit.run()
    expect(quit.hasStarted()).toBe(true)
    expect(quit.hasFinished()).toBe(false)
    release()
    await running
    expect(quit.hasFinished()).toBe(true)
  })
})

describe('the quit sequence — the report', () => {
  it('summarizes what happened in one line', async () => {
    const { quit } = sequence({
      closing: { begin: acked(['agent.mason'], ['agent.tess']) },
      agents: { unwound: ['agent.mason'], failed: [{ agentId: 'agent.tess', error: 'EBUSY' }] }
    })
    expect(summarizeQuit(await quit.run())).toBe(
      'closing time run; acked 1; silent agent.tess; unwound 1; unwind failed: agent.tess; 2/2 stops'
    )
  })

  it('says so when there was nobody to ask', async () => {
    const { quit } = sequence({ live: [], closing: null, agents: { unwound: [], failed: [] } })
    expect(summarizeQuit(await quit.run())).toBe('no live agents; unwound 0; 2/2 stops')
  })
})

/**
 * The regression this package exists for, wired the way `index.ts` wires it.
 */
describe('the quit sequence — a destroyed window (the M8.1 defect)', () => {
  /** Production's `onLogEvent`: append to the book of record, then tell the UI. */
  function closingWiredLike(
    index: { readonly log: Record<string, unknown>[]; readonly delivered: Message[] },
    tellTheUi: () => void
  ): ClosingTime {
    return new ClosingTime({
      liveAgents: () => ['agent.mason'],
      deliver: (message) => index.delivered.push(message),
      render: (kind) => (kind === 'subject' ? 'Closing time' : 'park your work'),
      onLogEvent: (draft) => {
        index.log.push(draft)
        tellTheUi()
      },
      deadlineMs: 50
    })
  }

  it('reproduces the old wiring: begin() throws on its first log line', () => {
    // Not a hypothesis. On the Architect's machine the book of record held
    // exactly one shutdown event — `closing-begin` — and no ack and no complete,
    // ever, because this is where it stopped.
    const index = { log: [] as Record<string, unknown>[], delivered: [] as Message[] }
    const win = new FakeWindow()
    win.destroy({ fireClosed: false })
    const closing = closingWiredLike(index, () => {
      // The line the scenario rig omitted, exactly as `index.ts` used to run it.
      win.webContents.send('log:append')
    })

    expect(() => closing.begin()).toThrow('Object has been destroyed')
    // The shape of the evidence: the log line landed, the requests never did.
    expect(index.log).toHaveLength(1)
    expect(index.log[0]).toMatchObject({ event: 'closing-begin' })
    expect(index.delivered).toEqual([])
  })

  it('through the bridge, the same quit asks every agent and completes', async () => {
    const index = { log: [] as Record<string, unknown>[], delivered: [] as Message[] }
    const bridge = new UiBridge()
    const win = new FakeWindow()
    bridge.attach(win)
    const closing = closingWiredLike(index, () => {
      bridge.send('log:append')
    })
    // Electron's own ordering: destroyed first, `closed` afterwards.
    win.destroy({ fireClosed: false })

    const t = timeline()
    const degradations: Recorded[] = []
    const quit = new QuitSequence({
      liveAgents: () => ['agent.mason'],
      ask: () => 'closing',
      closing: () => closing,
      agents: () => ({ shutdown: async () => ({ unwound: ['agent.mason'], failed: [] }) }),
      steps: () => [t.step('ptys'), t.step('db')],
      onDegraded: (source, detail) => degradations.push({ source, detail })
    })

    const running = quit.run()
    // The offer is awaited before closing time starts, so let that settle.
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The agent really is asked — the request is in its inbox — and answers.
    expect(index.delivered).toHaveLength(1)
    const request = index.delivered[0]
    expect(request?.to).toBe('agent.mason')
    expect(request?.from).toBe(CLOSING_ENDPOINT)
    closing.noteReply(
      composeMessage({
        id: makeMessageId(new Date('2026-09-03T00:00:00.000Z'), 'ack1'),
        conversation: request?.conversation ?? 'c',
        from: 'agent.mason',
        to: CLOSING_ENDPOINT,
        act: 'inform',
        subject: CLOSING_ACK_SUBJECT,
        body: 'parked',
        hops: 1,
        created_at: '2026-09-03T00:00:00.000Z',
        in_reply_to: request?.id ?? 'x'
      })
    )

    const report = await running
    expect(report.closing).toMatchObject({ acked: ['agent.mason'], missing: [], timedOut: false })
    expect(report.agentsUnwound).toEqual(['agent.mason'])
    expect(t.seen).toEqual(['ptys', 'db'])
    // Every shutdown event reached the book of record, not just the first.
    expect(index.log.map((entry) => entry['event'])).toEqual([
      'closing-begin',
      'closing-ack',
      'closing-complete'
    ])
    // And a window that is simply gone is not a fault worth showing anybody.
    expect(degradations).toEqual([])
  })
})
/**
 * M8.7 — the disarm phase, and the ordering nothing pinned.
 *
 * M8.6 put `crew.stop()` in `steps()` with a comment saying it ran "before the
 * unwind, not after". It did not: `steps()` is the LAST phase. So every respawn
 * ladder was armed while the unwind killed the agents it was watching, and read
 * those kills as crashes. Nothing caught it because no test related the phase a
 * step is registered in to the phase it actually runs in.
 */
describe('the ladders are disarmed before the unwind (M8.7)', () => {
  it('runs disarm after closing time and before the unwind', async () => {
    const order: string[] = []
    const t = timeline()
    const quit = new QuitSequence({
      liveAgents: () => ['agent.mason'],
      ask: () => {
        order.push('ask')
        return 'closing'
      },
      closing: () => ({
        inProgress: () => false,
        begin: async () => {
          order.push('closing')
          return { acked: ['agent.mason'], missing: [], timedOut: false }
        }
      }),
      agents: () => ({
        shutdown: async () => {
          order.push('unwind')
          return { unwound: ['agent.mason'], failed: [] }
        }
      }),
      disarm: () => [
        { name: 'crew-survival', run: () => void order.push('disarm:crew') },
        {
          name: 'orchestrator-ladder',
          run: () => void order.push('disarm:artemis')
        }
      ],
      steps: () => [t.step('ptys')],
      onDegraded: () => undefined
    })

    const report = await quit.run()
    // The load-bearing edge: BOTH ladders are down before `unwind` runs, so the
    // kills it performs cannot be read as crashes.
    expect([...order, ...t.seen]).toEqual([
      'ask',
      'closing',
      'disarm:crew',
      'disarm:artemis',
      'unwind',
      'ptys'
    ])
    expect(report.disarmed).toEqual([
      { name: 'crew-survival', ok: true },
      { name: 'orchestrator-ladder', ok: true }
    ])
  })

  it('disarms even when there was no closing time to run', async () => {
    // An empty floor skips straight to teardown (SDD §612), and a ladder can
    // still be armed for an agent that exited moments ago.
    const order: string[] = []
    const quit = new QuitSequence({
      liveAgents: () => [],
      ask: () => 'now',
      closing: () => null,
      agents: () => ({
        shutdown: async () => {
          order.push('unwind')
          return { unwound: [], failed: [] }
        }
      }),
      disarm: () => [{ name: 'crew-survival', run: () => void order.push('disarm') }],
      steps: () => [],
      onDegraded: () => undefined
    })

    await quit.run()
    expect(order).toEqual(['disarm', 'unwind'])
  })

  it('a ladder that will not disarm is reported and stepped over', async () => {
    // Same isolation `steps` has: the unwind must still restore every settings
    // file the harness wrote into somebody's repository.
    const order: string[] = []
    const degradations: { source: string; detail: string }[] = []
    const quit = new QuitSequence({
      liveAgents: () => [],
      ask: () => 'now',
      closing: () => null,
      agents: () => ({
        shutdown: async () => {
          order.push('unwind')
          return { unwound: [], failed: [] }
        }
      }),
      disarm: () => [
        {
          name: 'crew-survival',
          run: () => {
            throw new Error('ladder wedged')
          }
        },
        {
          name: 'orchestrator-ladder',
          run: () => void order.push('disarm:artemis')
        }
      ],
      steps: () => [],
      onDegraded: (source, detail) => degradations.push({ source, detail })
    })

    const report = await quit.run()
    expect(order).toEqual(['disarm:artemis', 'unwind'])
    expect(report.disarmed[0]).toEqual({
      name: 'crew-survival',
      ok: false,
      error: 'ladder wedged'
    })
    // Its own cause, distinct from a teardown stop's, so a reader can tell a
    // ladder that would not disarm from a pty that would not die.
    expect(degradations[0]?.source).toBe('shutdown/disarm:crew-survival')
  })

  it('quits normally when nothing declares a disarm at all', async () => {
    const order: string[] = []
    const quit = new QuitSequence({
      liveAgents: () => [],
      ask: () => 'now',
      closing: () => null,
      agents: () => ({
        shutdown: async () => {
          order.push('unwind')
          return { unwound: [], failed: [] }
        }
      }),
      steps: () => [],
      onDegraded: () => undefined
    })

    const report = await quit.run()
    expect(order).toEqual(['unwind'])
    expect(report.disarmed).toEqual([])
  })

  it('an assembly that throws does not stall the quit', async () => {
    const order: string[] = []
    const degradations: { source: string; detail: string }[] = []
    const quit = new QuitSequence({
      liveAgents: () => [],
      ask: () => 'now',
      closing: () => null,
      agents: () => ({
        shutdown: async () => {
          order.push('unwind')
          return { unwound: [], failed: [] }
        }
      }),
      disarm: () => {
        throw new Error('company half-built')
      },
      steps: () => [],
      onDegraded: (source, detail) => degradations.push({ source, detail })
    })

    await quit.run()
    expect(order).toEqual(['unwind'])
    expect(degradations[0]?.source).toBe('shutdown/disarm')
  })
})

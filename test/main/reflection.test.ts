import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Library } from '../../src/main/library'
import { PromptStore } from '../../src/main/prompts'
import { ReflectionJob, REFLECTION_RETRY_MS } from '../../src/main/reflection'
import { Scheduler } from '../../src/main/scheduler'
import { composeMessage, makeMessageId, type Message } from '../../src/shared/message'
import { LIBRARY_ENDPOINT } from '../../src/shared/reserved'
import { REFLECTION_SCHEMA_VERSION, nothingDestroyed } from '../../src/shared/reflection'
import { parseMemorySections } from '../../src/shared/memory'
import { removeTempDir } from '../tmpdir'

/**
 * Reflection end to end (ADR-0006 layer 3, NFR-7) — the job, the endpoint, the
 * archive, on a real filesystem.
 *
 * The property this suite exists to hold is NFR-7's: **nothing is destroyed**.
 * It is asserted the hard way, by reading the old memory back out of what
 * remains, rather than by trusting that a summary contained it.
 */

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const AGENT = 'agent.mason'
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

interface Rig {
  readonly library: Library
  readonly job: ReflectionJob
  readonly delivered: Message[]
  readonly degradations: string[]
  now: Date
}

function rig(options: { reachable?: readonly string[] } = {}): Rig {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-reflect-'))
  temps.push(home)
  const prompts = new PromptStore(path.join(home, 'prompts'), path.join(REPO, 'prompts'))
  const state = { now: new Date('2026-08-27T09:00:00Z') }
  const library = new Library({
    agoraRoot: path.join(home, 'agora'),
    prompts,
    now: () => state.now
  })
  const delivered: Message[] = []
  const degradations: string[] = []
  const job = new ReflectionJob({
    library,
    prompts,
    reachableAgents: () => options.reachable ?? [AGENT],
    deliver: (message) => delivered.push(message),
    onDegraded: (detail) => degradations.push(detail),
    now: () => state.now
  })
  return {
    library,
    job,
    delivered,
    degradations,
    get now() {
      return state.now
    },
    set now(value: Date) {
      state.now = value
    }
  }
}

/** Writes a memory past the threshold, with distinctive content per section. */
function fatMemory(library: Library, sections = 12): void {
  for (let i = 0; i < sections; i += 1) {
    library.note(
      AGENT,
      AGENT,
      `Learning number ${String(i)}: ${'detail '.repeat(400)}marker-${String(i)}`
    )
  }
}

/** `fatMemory` for an agent other than the default one. */
function fatMemoryFor(library: Library, agentId: string, sections = 12): void {
  for (let i = 0; i < sections; i += 1) {
    library.note(
      agentId,
      agentId,
      `Learning number ${String(i)}: ${'detail '.repeat(400)}marker-${String(i)}`
    )
  }
}

function condensation(core: string): string {
  return JSON.stringify({ schemaVersion: REFLECTION_SCHEMA_VERSION, core })
}

function proposalFrom(agentId: string, body: string): Message {
  return composeMessage({
    id: makeMessageId(new Date(), 'rfl1'),
    conversation: `conv-reflect-${agentId}`,
    in_reply_to: null,
    from: agentId,
    to: LIBRARY_ENDPOINT,
    act: 'propose',
    subject: 'condensed',
    body,
    hops: 1,
    created_at: new Date().toISOString()
  })
}

describe('the reflection request (ADR-0005: the harness asks, it does not summarize)', () => {
  it('asks nobody while every memory is under the threshold', () => {
    const r = rig()
    r.library.note(AGENT, AGENT, 'one short thing')
    r.job.sweep()
    expect(r.delivered).toEqual([])
  })

  it('asks the agent whose memory it is, as a normal turn', () => {
    const r = rig()
    fatMemory(r.library)
    r.job.sweep()

    expect(r.delivered).toHaveLength(1)
    const request = r.delivered[0]
    expect(request?.from).toBe(LIBRARY_ENDPOINT)
    expect(request?.to).toBe(AGENT)
    expect(request?.act).toBe('request')
    // The prose is a prompt surface, and it carries the sections themselves so
    // the agent can condense from what it actually wrote.
    expect(request?.body).toContain('marker-0')
    expect(request?.body).toContain(LIBRARY_ENDPOINT)
    expect(r.job.pending()).toEqual([AGENT])
  })

  it('asks once, not once per sweep', () => {
    const r = rig()
    fatMemory(r.library)
    r.job.sweep()
    r.job.sweep()
    r.job.sweep()
    expect(r.delivered).toHaveLength(1)
  })

  it('asks again, visibly, when the first request goes unanswered', () => {
    const r = rig()
    fatMemory(r.library)
    r.job.sweep()
    r.now = new Date(r.now.getTime() + REFLECTION_RETRY_MS + 1)
    r.job.sweep()

    expect(r.delivered).toHaveLength(2)
    expect(r.degradations.join(' ')).toContain('has not answered')
  })

  it('cannot ask an agent with no mailbox, and defers rather than dropping', () => {
    const r = rig({ reachable: [] })
    fatMemory(r.library)
    r.job.sweep()
    expect(r.delivered).toEqual([])
    // Still due: the next sweep with a reachable agent asks.
    expect(r.library.reflectionPlan(AGENT).due).toBe(true)
  })

  it('says so when an agent leaves mid-reflection', () => {
    const r = rig()
    fatMemory(r.library)
    r.job.sweep()
    r.job.forget(AGENT)
    expect(r.degradations.join(' ')).toContain('left before condensing')
    expect(r.job.pending()).toEqual([])
  })
})

describe('applying a condensation (NFR-7: nothing is destroyed)', () => {
  it('archives verbatim, condenses the core, and keeps the newest sections', () => {
    const r = rig()
    fatMemory(r.library)
    const before = r.library.read(AGENT)
    const plan = r.library.reflectionPlan(AGENT)
    r.job.sweep()

    const outcome = r.job.submit(
      proposalFrom(AGENT, condensation('Numbers 0-6 were about details.'))
    )
    expect(outcome.ok).toBe(true)

    const after = r.library.read(AGENT)
    expect(after.length).toBeLessThan(before.length)
    expect(after).toContain('Numbers 0-6 were about details.')
    // The newest sections stayed put.
    expect(after).toContain('marker-11')
    // The oldest are gone from memory.md…
    expect(after).not.toContain('marker-0\n')
    // …and present in the archive, verbatim.
    const archive = r.library.archiveText(AGENT)
    for (const section of plan.condensing) expect(archive).toContain(section.text)
    // The property itself, checked the way the Library checks it.
    expect(nothingDestroyed(before, after, archive)).toEqual({ ok: true })
  })

  it('names the archive file in the reply the agent reads', () => {
    const r = rig()
    fatMemory(r.library)
    r.job.sweep()
    const outcome = r.job.submit(proposalFrom(AGENT, condensation('core')))
    const reply = r.job.replyText(AGENT, outcome)

    expect(reply.subject).toContain('2026-08-27-001.md')
    expect(reply.body).toContain('2026-08-27-001.md')
    expect(reply.body).toContain('Nothing was lost')
    expect(r.library.archiveFiles(AGENT)).toEqual(['2026-08-27-001.md'])
  })

  it('keeps the seed preamble at the top', () => {
    const r = rig()
    fatMemory(r.library)
    r.job.sweep()
    r.job.submit(proposalFrom(AGENT, condensation('core')))
    expect(r.library.read(AGENT)).toContain('This file is your long-term memory')
  })

  it('condenses twice in a day into two archive files', () => {
    const r = rig()
    fatMemory(r.library)
    r.job.sweep()
    r.job.submit(proposalFrom(AGENT, condensation('first core')))
    fatMemory(r.library)
    r.job.sweep()
    r.job.submit(proposalFrom(AGENT, condensation('second core')))

    expect(r.library.archiveFiles(AGENT)).toEqual(['2026-08-27-001.md', '2026-08-27-002.md'])
    expect(r.library.read(AGENT)).toContain('second core')
    // The first core survives its own condensation — it is a section like any
    // other, so it is archived rather than dropped.
    expect(r.library.archiveText(AGENT)).toContain('first core')
  })

  it('leaves the memory readable: sections still parse after a condensation', () => {
    const r = rig()
    fatMemory(r.library)
    r.job.sweep()
    r.job.submit(proposalFrom(AGENT, condensation('core')))
    const sections = parseMemorySections(r.library.read(AGENT)).filter((s) => s.heading !== null)
    expect(sections).toHaveLength(6)
    expect(sections[0]?.heading).toContain('condensed by')
  })
})

describe('refusals carry every reason, and change nothing', () => {
  it('refuses a body that is not a condensation', () => {
    const r = rig()
    fatMemory(r.library)
    const before = r.library.read(AGENT)
    r.job.sweep()

    const outcome = r.job.submit(proposalFrom(AGENT, 'I have thought about it.'))
    expect(outcome.ok).toBe(false)
    expect(outcome.reasons?.[0]).toContain('not valid JSON')
    expect(r.library.read(AGENT)).toBe(before)
    expect(r.library.archiveFiles(AGENT)).toEqual([])
    expect(r.degradations.join(' ')).toContain('was refused')

    const reply = r.job.replyText(AGENT, outcome)
    expect(reply.body).toContain('Nothing has changed')
  })

  it('refuses a condensation for a memory that is not due', () => {
    const r = rig()
    r.library.note(AGENT, AGENT, 'one short thing')
    const outcome = r.job.submit(proposalFrom(AGENT, condensation('core')))
    expect(outcome.ok).toBe(false)
    expect(outcome.reasons?.[0]).toContain('nothing to condense')
  })

  it('keeps the agent pending after a refusal, so it is asked again', () => {
    const r = rig()
    fatMemory(r.library)
    r.job.sweep()
    r.job.submit(proposalFrom(AGENT, 'nope'))
    expect(r.job.pending()).toEqual([AGENT])
  })
})

describe('the scheduler drives it', () => {
  it('fires reflection on its own interval, idempotently', async () => {
    const r = rig()
    fatMemory(r.library)
    let nowMs = 0
    const scheduler = new Scheduler({ now: () => new Date(nowMs) })
    scheduler.add(r.job.trigger())

    await scheduler.tick()
    await scheduler.tick()
    expect(r.delivered).toHaveLength(1)
    expect(scheduler.ids()).toEqual(['library.reflection'])

    nowMs += 60 * 60 * 1_000
    await scheduler.tick()
    // Still one: the agent has not answered, and the retry window has not passed.
    expect(r.delivered).toHaveLength(1)
  })
})

/**
 * D6 (M8.10) — one bad agent must not stop reflection for everyone after it.
 *
 * The failure is driven through the REAL path rather than a stub that throws:
 * `ask` composes a `Message`, and `messageSchema` caps `body` at 200 000
 * characters, so an agent whose condensing sections exceed that cap throws on
 * validation inside the sweep. A stub that threw would have proved only that a
 * try/catch catches; this proves the condition the guard was written for can
 * actually occur, and that the guard catches THAT.
 *
 * Iteration order is `reachableAgents()`, which the harness sorts, so the
 * agents that lost their reflection were the ones whose names sort after the
 * oversized one. Both agents below are named so that ordering is explicit.
 */
describe('D6 — reflection survives one bad agent', () => {
  const EARLY = 'agent.aaa-oversized'
  const LATER = 'agent.zzz-healthy'

  /** A memory whose condensing sections exceed the 200 000-char message cap. */
  function oversizedMemory(library: Library, agentId: string): void {
    for (let i = 0; i < 12; i += 1) {
      library.note(agentId, agentId, `Chapter ${String(i)}: ${'x'.repeat(30_000)}`)
    }
  }

  it('the oversized memory really does throw — the condition is reachable', () => {
    const r = rig({ reachable: [EARLY] })
    oversizedMemory(r.library, EARLY)
    const plan = r.library.reflectionPlan(EARLY)
    expect(plan.due).toBe(true)
    const body = plan.condensing.map((section) => section.text).join('\n\n')
    expect(body.length).toBeGreaterThan(200_000)
  })

  it('asks every other agent, and names the one it could not ask', () => {
    const r = rig({ reachable: [EARLY, LATER] })
    oversizedMemory(r.library, EARLY)
    fatMemoryFor(r.library, LATER)

    const report = r.job.sweep()

    // The healthy agent is asked even though it sorts AFTER the broken one.
    expect(report.asked).toEqual([LATER])
    expect(r.delivered.map((message) => message.to)).toEqual([LATER])

    // The failure is reported, not swallowed: the agent by name and the reason.
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]?.agentId).toBe(EARLY)
    const detail = r.degradations.join('\n')
    expect(detail).toContain(EARLY)
    expect(detail).toContain('could not be asked to condense its memory')
    // Not a silence: the line says the rest of the sweep still happened.
    expect(detail).toContain('every other agent was still swept')
  })

  it('keeps asking the healthy agent on later sweeps', () => {
    const r = rig({ reachable: [EARLY, LATER] })
    oversizedMemory(r.library, EARLY)
    fatMemoryFor(r.library, LATER)

    r.job.sweep()
    // The broken agent left no outstanding request, so it is retried; the
    // healthy one is now awaiting an answer and is not asked twice.
    const second = r.job.sweep()
    expect(second.failed.map((row) => row.agentId)).toEqual([EARLY])
    expect(r.delivered).toHaveLength(1)
    expect(r.job.pending()).toEqual([LATER])
  })

  it('reports one line per failing agent, so six are six', () => {
    const broken = ['agent.b1', 'agent.b2', 'agent.b3']
    const r = rig({ reachable: [...broken, LATER] })
    for (const agentId of broken) oversizedMemory(r.library, agentId)
    fatMemoryFor(r.library, LATER)

    const report = r.job.sweep()

    expect(report.failed.map((row) => row.agentId)).toEqual(broken)
    expect(report.asked).toEqual([LATER])
    for (const agentId of broken) {
      expect(r.degradations.filter((line) => line.includes(agentId))).toHaveLength(1)
    }
  })
})

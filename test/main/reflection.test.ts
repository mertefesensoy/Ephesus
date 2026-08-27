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
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
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

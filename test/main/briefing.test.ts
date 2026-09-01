import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { BRIEF_SCHEMA_VERSION, type BriefFact, type BriefInput } from '../../src/shared/brief'
import { composeMessage, makeMessageId, type Message } from '../../src/shared/message'
import { ODEON_ENDPOINT } from '../../src/shared/reserved'
import { TASKS_SCHEMA_VERSION, type Task } from '../../src/shared/tasks'
import { Agora } from '../../src/main/agora'
import { BriefingJob } from '../../src/main/briefing'
import { Odeon } from '../../src/main/odeon'
import { PromptStore } from '../../src/main/prompts'
import { removeTempDir } from '../tmpdir'

/**
 * The standup job and the brief archive (FR-7.1, SDD §7.2, UC-04).
 *
 * The division ADR-0005 draws is what these assert: the harness asks, and the
 * harness checks; it never narrates. So the interesting cases are the ones
 * where an answer is wrong — a brief nobody asked for, a sentence citing a fact
 * that was never issued, a second narration of a window already closed.
 */

const BUNDLED_PROMPTS = fileURLToPath(new URL('../../prompts/', import.meta.url))
const homes: string[] = []
const agoras: Agora[] = []

afterEach(async () => {
  for (const agora of agoras.splice(0)) await agora.drained().catch(() => {})
  for (const home of homes.splice(0)) {
    removeTempDir(home)
  }
})

const TASK: Task = {
  id: 't-2026-08-28-01',
  title: 'Fix the flaky checkout test',
  spec: 'spec',
  assignee: 'agent.mason',
  status: 'done',
  priority: 5,
  deps: [],
  review: [],
  gates: [],
  artifacts: { deck: null, memos: [], resultRef: null },
  source: { kind: 'propose', via: 'hermes', log: 'msg#1' },
  createdAt: '2026-08-28T09:00:00.000Z',
  updatedAt: '2026-08-28T09:00:00.000Z'
}

const INPUT: BriefInput = {
  events: [],
  ledger: { schemaVersion: TASKS_SCHEMA_VERSION, tasks: [TASK] },
  openGates: [{ id: 'g-1', agentId: 'agent.mason' }],
  openMemos: [],
  spend: [{ agentId: 'agent.mason', tokens: 4200 }]
}

interface Rig {
  readonly agora: Agora
  readonly odeon: Odeon
  readonly job: BriefingJob
  readonly sent: Message[]
  readonly logs: Record<string, unknown>[]
  readonly degradations: string[]
  briefFiles(): string[]
  briefText(): string
}

async function rig(over: { orchestrator?: string | null; input?: BriefInput } = {}): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-brief-'))
  homes.push(home)
  const prompts = new PromptStore(path.join(home, 'prompts'), BUNDLED_PROMPTS)
  const agora = new Agora({ root: path.join(home, 'agora'), prompts, backoffMs: 1 })
  await agora.ensureRepo()
  agoras.push(agora)

  const sent: Message[] = []
  const logs: Record<string, unknown>[] = []
  const degradations: string[] = []
  const odeon = new Odeon({
    agoraRoot: agora.root,
    prompts,
    task: () => null,
    recordDeck: () => {},
    onLogEvent: (draft) => logs.push(draft)
  })
  const job = new BriefingJob({
    prompts,
    gather: () => over.input ?? INPUT,
    orchestrator: () => (over.orchestrator === undefined ? 'agent.artemis' : over.orchestrator),
    deliver: (message) => sent.push(message),
    onLogEvent: (draft) => logs.push(draft),
    onDegraded: (detail) => degradations.push(detail)
  })

  const briefsDir = path.join(agora.root, 'odeon', 'briefs')
  return {
    agora,
    odeon,
    job,
    sent,
    logs,
    degradations,
    briefFiles: () => (fs.existsSync(briefsDir) ? fs.readdirSync(briefsDir).sort() : []),
    briefText: () => {
      const first = fs.existsSync(briefsDir) ? fs.readdirSync(briefsDir).sort()[0] : undefined
      return first === undefined ? '' : fs.readFileSync(path.join(briefsDir, first), 'utf8')
    }
  }
}

let seq = 0

function narration(
  briefId: string,
  sentences: readonly { section: string; text: string; refs: readonly string[] }[]
): Message {
  seq += 1
  return composeMessage({
    id: makeMessageId(new Date(2026, 7, 28, 11, 0, seq), 'dd44'),
    conversation: `conv-brief-${briefId}`,
    in_reply_to: null,
    from: 'agent.artemis',
    to: ODEON_ENDPOINT,
    act: 'propose',
    subject: 'brief',
    body: JSON.stringify({
      schemaVersion: BRIEF_SCHEMA_VERSION,
      kind: 'brief',
      briefId,
      sentences
    }),
    hops: 0,
    created_at: new Date().toISOString()
  })
}

describe('the harness asks; it does not narrate', () => {
  it('sends the facts to the orchestrator and says which brief they are for', async () => {
    const r = await rig()
    const facts = r.job.request()

    expect(facts).not.toBeNull()
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toMatchObject({ from: ODEON_ENDPOINT, to: 'agent.artemis', act: 'request' })
    // The facts travel in the message; nothing asks her to recall anything.
    expect(r.sent[0]?.body).toContain('gate:g-1')
    expect(r.sent[0]?.body).toContain('task:t-2026-08-28-01')
  })

  it('renders its ask from prompts/, never from code (invariant §8)', async () => {
    const r = await rig()
    r.job.request()
    const template = fs.readFileSync('prompts/odeon/brief-request.md', 'utf8')
    expect(template).toContain('Every sentence must carry at least one ref')
    expect(r.sent[0]?.body).toContain('Every sentence must carry at least one ref')
  })

  it('skips the standup visibly when nobody is hired to narrate it', async () => {
    const r = await rig({ orchestrator: null })
    expect(r.job.request()).toBeNull()
    expect(r.degradations.join(' ')).toContain('no orchestrator')
  })

  it('does not ask twice while the first ask is unanswered', async () => {
    // Two overlapping windows would ask her to narrate the same events twice.
    const r = await rig()
    r.job.request()
    expect(r.job.request()).toBeNull()
    expect(r.sent).toHaveLength(1)
    expect(r.degradations.join(' ')).toContain('never narrated')
  })

  it('records the ask in the book of record (NFR-13)', async () => {
    const r = await rig()
    r.job.request()
    expect(r.logs.find((log) => log['event'] === 'requested')).toMatchObject({
      kind: 'brief',
      to: 'agent.artemis'
    })
  })
})

describe('the archive checks the narration against the facts it issued', () => {
  it('archives a brief whose every sentence resolves', async () => {
    const r = await rig()
    const facts = r.job.request() as readonly BriefFact[]
    const briefId = r.job.pending() ?? ''

    const outcome = r.odeon.fileBrief(
      narration(briefId, [
        { section: 'headline', text: 'One action is waiting on you.', refs: ['gate:g-1'] },
        { section: 'done', text: 'The checkout test is fixed.', refs: ['task:t-2026-08-28-01'] }
      ]),
      facts
    )

    expect(outcome.ok).toBe(true)
    expect(r.briefFiles()).toHaveLength(1)
    expect(r.briefText()).toContain('One action is waiting on you. [gate:g-1]')
    expect(r.briefText()).toContain('## Source refs')
  })

  it('REFUSES a narration citing a fact that was never issued', async () => {
    const r = await rig()
    const facts = r.job.request() as readonly BriefFact[]
    const briefId = r.job.pending() ?? ''

    const outcome = r.odeon.fileBrief(
      narration(briefId, [
        { section: 'headline', text: 'Everything shipped.', refs: ['task:t-invented'] }
      ]),
      facts
    )

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reasons.join(' ')).toContain('no fact supports')
    // Nothing was written: a refused brief leaves no artifact behind.
    expect(r.briefFiles()).toEqual([])
  })

  it('refuses a narration over the spoken budget', async () => {
    const r = await rig()
    const facts = r.job.request() as readonly BriefFact[]
    const briefId = r.job.pending() ?? ''
    const long = Array.from({ length: 400 }, () => 'word').join(' ')

    const outcome = r.odeon.fileBrief(
      narration(briefId, [{ section: 'done', text: long, refs: ['task:t-2026-08-28-01'] }]),
      facts
    )
    expect(outcome.ok).toBe(false)
    expect(r.briefFiles()).toEqual([])
  })

  it('records the archive with its length and fact count (NFR-13)', async () => {
    const r = await rig()
    const facts = r.job.request() as readonly BriefFact[]
    const briefId = r.job.pending() ?? ''
    r.odeon.fileBrief(
      narration(briefId, [{ section: 'headline', text: 'Short.', refs: ['gate:g-1'] }]),
      facts
    )
    expect(r.logs.find((log) => log['event'] === 'archived')).toMatchObject({
      kind: 'brief',
      briefId,
      by: 'agent.artemis'
    })
  })

  it('logs a refusal too, so a failed brief is not silence', async () => {
    const r = await rig()
    const facts = r.job.request() as readonly BriefFact[]
    r.odeon.fileBrief(
      narration(r.job.pending() ?? '', [
        { section: 'headline', text: 'A.', refs: ['task:t-invented'] }
      ]),
      facts
    )
    expect(r.logs.find((log) => log['event'] === 'refused')).toMatchObject({ kind: 'brief' })
  })
})

describe('the outstanding ask is the question, and it closes', () => {
  it('hands back the facts for the brief it asked about', async () => {
    const r = await rig()
    const facts = r.job.request()
    const briefId = r.job.pending() ?? ''
    expect(r.job.factsFor(briefId)).toEqual(facts)
  })

  it('knows nothing about a briefId nobody asked for', async () => {
    // A narration inventing its own id is caught before a sentence is read.
    const r = await rig()
    r.job.request()
    expect(r.job.factsFor('b-made-up')).toBeNull()
  })

  it('settles, so the next standup can run', async () => {
    const r = await rig()
    r.job.request()
    const briefId = r.job.pending() ?? ''
    r.job.settle(briefId)

    expect(r.job.pending()).toBeNull()
    expect(r.job.request()).not.toBeNull()
    expect(r.sent).toHaveLength(2)
  })

  it('ignores a settle for a brief it is not waiting on', async () => {
    const r = await rig()
    r.job.request()
    r.job.settle('b-something-else')
    expect(r.job.pending()).not.toBeNull()
  })

  it('offers the scheduler a trigger with a standup id', async () => {
    const r = await rig()
    const trigger = r.job.trigger(1_000)
    expect(trigger.id).toBe('standup')
    expect(trigger.everyMs).toBe(1_000)
  })
})

describe('the Briefs tab reads the archive', () => {
  it('lists nothing before a brief is archived', async () => {
    expect((await rig()).odeon.briefs()).toEqual([])
  })

  it('lists an archived brief with its markdown', async () => {
    const r = await rig()
    const facts = r.job.request() as readonly BriefFact[]
    r.odeon.fileBrief(
      narration(r.job.pending() ?? '', [
        { section: 'headline', text: 'One action waits.', refs: ['gate:g-1'] }
      ]),
      facts
    )
    const listed = r.odeon.briefs()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.markdown).toContain('One action waits.')
    expect(listed[0]?.ref).toContain('odeon/briefs/')
  })
})

describe('a refused narration leaves the question open (regression)', () => {
  it('does NOT settle on refusal, so the same window can be narrated again', async () => {
    // Found by a live run: `archiveBrief` settled unconditionally, so a
    // refusal closed the ask and the corrected narration was then rejected as
    // answering a brief nobody had asked for. The refusal became terminal.
    const r = await rig()
    r.job.request()
    const briefId = r.job.pending() ?? ''

    r.job.narrated(briefId, false)
    expect(r.job.pending()).toBe(briefId)
    expect(r.job.factsFor(briefId)).not.toBeNull()

    r.job.narrated(briefId, true)
    expect(r.job.pending()).toBeNull()
  })

  it('accepts a corrected narration after a refused one', async () => {
    const r = await rig()
    const facts = r.job.request() as readonly BriefFact[]
    const briefId = r.job.pending() ?? ''

    const refused = r.odeon.fileBrief(
      narration(briefId, [{ section: 'headline', text: 'A.', refs: ['task:t-invented'] }]),
      facts
    )
    expect(refused.ok).toBe(false)
    r.job.narrated(briefId, false)

    const corrected = r.odeon.fileBrief(
      narration(briefId, [{ section: 'headline', text: 'One action waits.', refs: ['gate:g-1'] }]),
      r.job.factsFor(briefId) ?? []
    )
    expect(corrected.ok).toBe(true)
    expect(r.briefFiles()).toHaveLength(1)
  })
})

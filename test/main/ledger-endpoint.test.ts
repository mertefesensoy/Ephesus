import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { LEDGER_SCHEMA_VERSION } from '../../src/shared/ledger'
import { composeMessage, makeMessageId, type Message } from '../../src/shared/message'
import { HERMES_SENDER, LEDGER_ENDPOINT } from '../../src/shared/reserved'
import type { RoutingContext } from '../../src/shared/routing'
import { spawnRequestSchema } from '../../src/shared/agents'
import { Agora } from '../../src/main/agora'
import { Hermes } from '../../src/main/hermes'
import { LedgerEndpoint } from '../../src/main/ledger'
import { PromptStore } from '../../src/main/prompts'

/**
 * The ledger endpoint, through the SHIPPED path: a proposal written into
 * Artemis's own outbox, drained by the real Hermes, routed by the real rules,
 * applied by the real endpoint, and written to a real `tasks.json`.
 *
 * That end-to-end shape is the point. "Agents never touch tasks.json" is only
 * true if the *only* way in goes through the router's writer check and the
 * endpoint's validation, and a test that called `endpoint.submit()` directly
 * would prove nothing about the way in.
 */

const BUNDLED_PROMPTS = fileURLToPath(new URL('../../prompts/', import.meta.url))
const homes: string[] = []
const agoras: Agora[] = []

afterEach(async () => {
  for (const agora of agoras.splice(0)) await agora.drained().catch(() => {})
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

interface Rig {
  readonly agora: Agora
  readonly hermes: Hermes
  readonly ledger: LedgerEndpoint
  readonly logs: Record<string, unknown>[]
  readonly changes: number[]
  /** Writes a message into an agent's outbox, the way an agent would. */
  post(ownerId: string, message: Message): void
  /** Runs one real delivery sweep. */
  sweep(): Promise<void>
  inbox(agentId: string): Message[]
}

async function rig(orchestratorId: string | null = 'agent.artemis'): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-ledger-'))
  homes.push(home)
  const prompts = new PromptStore(path.join(home, 'prompts'), BUNDLED_PROMPTS)
  const agora = new Agora({ root: path.join(home, 'agora'), prompts, backoffMs: 1 })
  await agora.ensureRepo()
  agoras.push(agora)

  const logs: Record<string, unknown>[] = []
  const changes: number[] = []
  const ledger = new LedgerEndpoint({
    store: agora,
    knownAgents: () => hermes.knownAgents(),
    onLogEvent: (draft) => logs.push(draft),
    onChange: () => changes.push(1),
    now: () => new Date('2026-08-27T09:00:00.000Z')
  })
  const hermes: Hermes = new Hermes({
    agora,
    prompts,
    ledger: (message) => ledger.submit(message),
    context: (): RoutingContext => ({ knownAgents: hermes.knownAgents(), orchestratorId })
  })

  for (const agentId of ['agent.artemis', 'agent.mason']) hermes.ensureMailbox(agentId)

  return {
    agora,
    hermes,
    ledger,
    logs,
    changes,
    post: (ownerId, message) => {
      const outbox = path.join(hermes.mailboxDir(ownerId), 'outbox')
      fs.mkdirSync(outbox, { recursive: true })
      fs.writeFileSync(path.join(outbox, `${message.id}.json`), JSON.stringify(message, null, 2))
    },
    sweep: async () => {
      await hermes.sweep()
    },
    inbox: (agentId) => {
      const dir = path.join(hermes.mailboxDir(agentId), 'inbox')
      if (!fs.existsSync(dir)) return []
      return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Message)
    }
  }
}

let seq = 0
function propose(over: Partial<Message> & { ops?: unknown[] } = {}): Message {
  const { ops, ...rest } = over
  return composeMessage({
    id: makeMessageId(new Date(2026, 7, 27, 9, 0, seq++), 'aa11'),
    conversation: 'conv-1',
    from: 'agent.artemis',
    to: LEDGER_ENDPOINT,
    act: 'propose',
    subject: 'decompose the directive',
    body: JSON.stringify({
      schemaVersion: LEDGER_SCHEMA_VERSION,
      ops: ops ?? [
        {
          op: 'create',
          task: {
            title: 'Fix flaky checkout test',
            spec: 'Reproduce it, then fix it.',
            assignee: 'agent.mason'
          }
        }
      ]
    }),
    created_at: new Date().toISOString(),
    ...rest
  })
}

describe('Artemis proposes, the harness writes (SDD §7.1)', () => {
  it('applies a proposal that arrived through her own outbox', async () => {
    const r = await rig()
    r.post('agent.artemis', propose())
    await r.sweep()
    const tasks = r.agora.tasks().tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ title: 'Fix flaky checkout test', assignee: 'agent.mason' })
  })

  it('never delivers the proposal to a mailbox', async () => {
    const r = await rig()
    r.post('agent.artemis', propose())
    await r.sweep()
    // `agent.ledger` is an endpoint, not a correspondent with an inbox.
    expect(fs.existsSync(path.join(r.hermes.mailboxDir(LEDGER_ENDPOINT), 'inbox'))).toBe(false)
  })

  it('answers her, so a proposal never vanishes silently', async () => {
    const r = await rig()
    r.post('agent.artemis', propose())
    await r.sweep()
    const reply = r.inbox('agent.artemis').at(-1)
    expect(reply).toMatchObject({ act: 'agree', from: LEDGER_ENDPOINT })
  })

  it('refuses with every reason, so she can fix it in one pass', async () => {
    const r = await rig()
    r.post(
      'agent.artemis',
      propose({
        ops: [
          { op: 'update', id: 't-nope', patch: { priority: 1 } },
          { op: 'update', id: 't-also-nope', patch: { priority: 2 } }
        ]
      })
    )
    await r.sweep()
    const reply = r.inbox('agent.artemis').at(-1)
    expect(reply?.act).toBe('refuse')
    expect(reply?.body).toContain('t-nope')
    expect(reply?.body).toContain('t-also-nope')
    expect(r.agora.tasks().tasks).toEqual([])
  })

  it('logs each applied op against the message that asked for it (NFR-13)', async () => {
    const r = await rig()
    r.post('agent.artemis', propose())
    await r.sweep()
    expect(r.logs.at(-1)).toMatchObject({
      kind: 'task',
      event: 'create',
      by: 'agent.artemis',
      assignee: 'agent.mason'
    })
  })

  it('logs a refusal too', async () => {
    const r = await rig()
    r.post(
      'agent.artemis',
      propose({ ops: [{ op: 'update', id: 't-nope', patch: { priority: 1 } }] })
    )
    await r.sweep()
    expect(r.logs.at(-1)).toMatchObject({ kind: 'task', event: 'refused' })
  })

  it('tells the kanban to re-read', async () => {
    const r = await rig()
    r.post('agent.artemis', propose())
    await r.sweep()
    expect(r.changes.length).toBeGreaterThan(0)
  })
})

describe('agents never touch tasks.json', () => {
  it('refuses a proposal from a worker, and bounces it back', async () => {
    const r = await rig()
    r.post('agent.mason', propose({ from: 'agent.mason' }))
    await r.sweep()
    expect(r.agora.tasks().tasks).toEqual([])
    const bounce = r.inbox('agent.mason').at(-1)
    expect(bounce?.act).toBe('refuse')
    expect(bounce?.body).toMatch(/only the orchestrator/)
  })

  it('refuses an act that is not a proposal', async () => {
    const r = await rig()
    r.post('agent.artemis', propose({ act: 'inform', subject: 'ledger note' }))
    await r.sweep()
    expect(r.agora.tasks().tasks).toEqual([])
  })

  it('refuses every proposal when no orchestrator is hired', async () => {
    const r = await rig(null)
    r.post('agent.artemis', propose())
    await r.sweep()
    expect(r.agora.tasks().tasks).toEqual([])
  })
})

describe('board.md has exactly one scribe (FR-4.2, SDD §2)', () => {
  it('is written when Artemis posts to it', async () => {
    const r = await rig()
    r.post(
      'agent.artemis',
      propose({ ops: [{ op: 'board', body: '# Board\n\nCheckout is green.' }] })
    )
    await r.sweep()
    expect(r.agora.board()).toContain('Checkout is green.')
  })

  it('is not written when anyone else tries', async () => {
    const r = await rig()
    const before = r.agora.board()
    r.post(
      'agent.mason',
      propose({ from: 'agent.mason', ops: [{ op: 'board', body: 'mason was here' }] })
    )
    await r.sweep()
    expect(r.agora.board()).toBe(before)
    expect(r.agora.board()).not.toContain('mason was here')
  })

  it('is seeded so the tab has something honest to show', async () => {
    const r = await rig()
    expect(r.agora.board()).toContain('Artemis')
  })
})

describe('the assignment flow, with two agents (SDD §7.1)', () => {
  it('files the task, then carries her request to the assignee', async () => {
    const r = await rig()
    r.post('agent.artemis', propose())
    await r.sweep()

    // SDD §7.1: Artemis sends the `request` — the harness delivers it. Deciding
    // who to ask, and what to say, is hers; that is the whole split.
    const taskId = r.agora.tasks().tasks[0]?.id ?? ''
    r.post(
      'agent.artemis',
      composeMessage({
        id: makeMessageId(new Date(2026, 7, 27, 10), 'bb22'),
        conversation: 'conv-1',
        from: 'agent.artemis',
        to: 'agent.mason',
        act: 'request',
        subject: `${taskId}: Fix flaky checkout test`,
        body: 'Reproduce it, then fix it.',
        created_at: new Date().toISOString()
      })
    )
    await r.sweep()

    const delivered = r.inbox('agent.mason').at(-1)
    expect(delivered).toMatchObject({ act: 'request', from: 'agent.artemis' })
    expect(delivered?.body).toContain('Reproduce it')
  })

  it('counts the assignee’s work for the Stop-hook branch (the M2 carried item)', async () => {
    const r = await rig()
    r.post('agent.artemis', propose())
    await r.sweep()
    // Through M2 this was hardcoded to 0, so an agent with assigned work and an
    // empty inbox stopped.
    expect(r.ledger.pendingFor('agent.mason')).toBe(1)
    expect(r.ledger.pendingFor('agent.artemis')).toBe(0)
  })

  it('stops counting once the work is done', async () => {
    const r = await rig()
    r.post('agent.artemis', propose())
    await r.sweep()
    const taskId = r.agora.tasks().tasks[0]?.id ?? ''
    r.post(
      'agent.artemis',
      propose({
        ops: [{ op: 'update', id: taskId, patch: { status: 'done', resultRef: 'pr#12' } }]
      })
    )
    await r.sweep()
    expect(r.ledger.pendingFor('agent.mason')).toBe(0)
  })
})

describe('the Watch feeds task.gates (carried from the M3.3 review)', () => {
  it('records and clears a gate, and blocks the close while it is open', async () => {
    const r = await rig()
    r.post('agent.artemis', propose())
    await r.sweep()
    const taskId = r.agora.tasks().tasks[0]?.id ?? ''

    r.ledger.noteGate(taskId, 'g-1', true)
    expect(r.agora.tasks().tasks[0]?.gates).toEqual(['g-1'])

    r.post(
      'agent.artemis',
      propose({ ops: [{ op: 'update', id: taskId, patch: { status: 'done' } }] })
    )
    await r.sweep()
    expect(r.agora.tasks().tasks[0]?.status).toBe('todo')

    r.ledger.noteGate(taskId, 'g-1', false)
    expect(r.agora.tasks().tasks[0]?.gates).toEqual([])
    r.post(
      'agent.artemis',
      propose({ ops: [{ op: 'update', id: taskId, patch: { status: 'done' } }] })
    )
    await r.sweep()
    expect(r.agora.tasks().tasks[0]?.status).toBe('done')
  })
})

describe('the harness writes mail under its own name (the M2 close-out gap)', () => {
  it('authors a bounce as Hermes, not as the sender who never wrote it', async () => {
    const r = await rig()
    r.post(
      'agent.mason',
      composeMessage({
        id: makeMessageId(new Date(2026, 7, 27, 11), 'cc33'),
        conversation: 'conv-3',
        from: 'agent.mason',
        to: 'agent.ghost',
        act: 'request',
        subject: 'do a thing',
        body: 'please',
        created_at: new Date().toISOString()
      })
    )
    await r.sweep()
    const bounce = r.inbox('agent.mason').at(-1)
    expect(bounce?.from).toBe(HERMES_SENDER)
    expect(bounce?.to).toBe('agent.mason')
  })

  it('authors a ledger reply as the endpoint', async () => {
    const r = await rig()
    r.post('agent.artemis', propose())
    await r.sweep()
    expect(r.inbox('agent.artemis').at(-1)?.from).toBe(LEDGER_ENDPOINT)
  })

  it('refuses to hire an agent under a reserved id', () => {
    // Otherwise a hire could take `agent.hermes` and forge a refusal.
    for (const agentId of [HERMES_SENDER, LEDGER_ENDPOINT]) {
      const parsed = spawnRequestSchema.safeParse({
        agentId,
        name: 'Impostor',
        role: 'worker',
        engine: 'claude',
        cwd: '/tmp/repo'
      })
      expect(parsed.success, agentId).toBe(false)
    }
  })
})

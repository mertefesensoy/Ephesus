import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { LEDGER_SCHEMA_VERSION } from '../../src/shared/ledger'
import { composeMessage, makeMessageId, type Message } from '../../src/shared/message'
import { LEDGER_ENDPOINT, ODEON_ENDPOINT } from '../../src/shared/reserved'
import { DECK_SECTIONS, ODEON_SCHEMA_VERSION } from '../../src/shared/odeon'
import type { RoutingContext } from '../../src/shared/routing'
import { Agora } from '../../src/main/agora'
import { Hermes } from '../../src/main/hermes'
import { LedgerEndpoint } from '../../src/main/ledger'
import { Odeon } from '../../src/main/odeon'
import { PromptStore } from '../../src/main/prompts'

/**
 * The Odeon archive (ADR-0008, FR-7.2, UC-05), through the SHIPPED path: the
 * agent writes a filing into its OWN outbox, the real router carries it, and
 * the real archive writes it. That shape is the point — SDD §2 gives `odeon/`
 * to the harness, so a test that called `odeon.fileDeck()` past the router
 * would prove nothing about the only way in.
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

let seq = 0

function message(fields: {
  from: string
  to: string
  subject: string
  body: string
  act?: 'propose' | 'inform'
}): Message {
  seq += 1
  return composeMessage({
    id: makeMessageId(new Date(2026, 7, 28, 9, 0, seq), 'bb22'),
    conversation: 'conv-odeon',
    in_reply_to: null,
    from: fields.from,
    to: fields.to,
    act: fields.act ?? 'propose',
    subject: fields.subject,
    body: fields.body,
    hops: 0,
    created_at: new Date().toISOString()
  })
}

function deckBody(taskId: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: ODEON_SCHEMA_VERSION,
    kind: 'deck',
    taskId,
    title: 'Checkout flakiness',
    sections: Object.fromEntries(DECK_SECTIONS.map((s) => [s, s + ' content'])),
    ...over
  })
}

interface Rig {
  readonly agora: Agora
  readonly hermes: Hermes
  readonly ledger: LedgerEndpoint
  readonly odeon: Odeon
  readonly logs: Record<string, unknown>[]
  post(ownerId: string, message: Message): void
  sweep(): Promise<void>
  inbox(agentId: string): Message[]
  /** Creates one task through the real ledger endpoint. */
  createTask(over?: { review?: string[]; assignee?: string }): Promise<string>
  deckFiles(): string[]
  deckHtml(): string
}

async function rig(): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-odeon-'))
  homes.push(home)
  const prompts = new PromptStore(path.join(home, 'prompts'), BUNDLED_PROMPTS)
  const agora = new Agora({ root: path.join(home, 'agora'), prompts, backoffMs: 1 })
  await agora.ensureRepo()
  agoras.push(agora)

  const logs: Record<string, unknown>[] = []
  const ledger = new LedgerEndpoint({
    store: agora,
    knownAgents: () => hermes.knownAgents(),
    onLogEvent: (draft) => logs.push(draft)
  })
  const odeon = new Odeon({
    agoraRoot: agora.root,
    prompts,
    task: (taskId) => ledger.tasks().tasks.find((row) => row.id === taskId) ?? null,
    recordDeck: (taskId, ref) => ledger.noteDeck(taskId, ref),
    onLogEvent: (draft) => logs.push(draft),
    commitSoon: (subject) => agora.commitSoon(subject)
  })
  const hermes: Hermes = new Hermes({
    agora,
    prompts,
    ledger: (msg) => ledger.submit(msg),
    odeon: (msg) => {
      const outcome = odeon.fileDeck(msg)
      if (outcome.ok) return { ok: true, subject: 'archived', body: outcome.ref }
      return {
        ok: false,
        reasons: outcome.reasons,
        subject: 'refused',
        body: outcome.reasons.join('; ')
      }
    },
    context: (): RoutingContext => ({
      knownAgents: hermes.knownAgents(),
      orchestratorId: 'agent.artemis'
    })
  })
  for (const agentId of ['agent.artemis', 'agent.mason', 'agent.scribe']) {
    hermes.ensureMailbox(agentId)
  }

  const post = (ownerId: string, msg: Message): void => {
    const outbox = path.join(hermes.mailboxDir(ownerId), 'outbox')
    fs.mkdirSync(outbox, { recursive: true })
    fs.writeFileSync(path.join(outbox, msg.id + '.json'), JSON.stringify(msg, null, 2))
  }

  const deckFiles = (): string[] => {
    const dir = path.join(agora.root, 'odeon', 'decks')
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
  }

  return {
    agora,
    hermes,
    ledger,
    odeon,
    logs,
    post,
    deckFiles,
    deckHtml: () =>
      fs.readFileSync(path.join(agora.root, 'odeon', 'decks', deckFiles()[0] ?? ''), 'utf8'),
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
    },
    createTask: async (over = {}) => {
      seq += 1
      const id = 't-2026-08-28-' + String(seq).padStart(3, '0')
      post(
        'agent.artemis',
        message({
          from: 'agent.artemis',
          to: LEDGER_ENDPOINT,
          subject: 'decompose',
          body: JSON.stringify({
            schemaVersion: LEDGER_SCHEMA_VERSION,
            ops: [
              {
                op: 'create',
                task: {
                  id,
                  title: 'Fix the flaky checkout test',
                  spec: 'Reproduce it, then fix it.',
                  assignee: over.assignee ?? 'agent.mason',
                  review: over.review ?? ['deck']
                }
              }
            ]
          })
        })
      )
      await hermes.sweep()
      return id
    }
  }
}

async function fileDeck(
  r: Rig,
  taskId: string,
  from = 'agent.mason',
  over: Record<string, unknown> = {}
): Promise<void> {
  r.post(from, message({ from, to: ODEON_ENDPOINT, subject: 'deck', body: deckBody(taskId, over) }))
  await r.sweep()
}

function sectionsExcept(missing: string): Record<string, string> {
  return Object.fromEntries(DECK_SECTIONS.filter((s) => s !== missing).map((s) => [s, 'x']))
}

describe('a deck is filed from an outbox and archived by the harness (SDD §2)', () => {
  it('archives the deck and records it against the task', async () => {
    const r = await rig()
    const taskId = await r.createTask()
    await fileDeck(r, taskId)

    expect(r.deckFiles()).toHaveLength(1)
    expect(r.deckFiles()[0]).toContain(taskId)
    expect(r.agora.tasks().tasks[0]?.artifacts.deck).toContain('odeon/decks/')
  })

  it('renders the STANDARD template, with all six sections', async () => {
    const r = await rig()
    const taskId = await r.createTask()
    await fileDeck(r, taskId)

    const html = r.deckHtml()
    // FR-7.2's six, by their template headings — the agent supplied content,
    // the harness supplied the shape.
    for (const heading of [
      'Goal',
      'What was built',
      'Decisions',
      'Trade-offs',
      'Evidence',
      'Open questions'
    ]) {
      expect(html, heading).toContain(heading)
    }
    expect(html).toContain('tradeOffs content')
    // Single file: nothing external to go stale or leak (ADR-0008).
    expect(html).not.toMatch(/<link[^>]+stylesheet/i)
    expect(html).not.toMatch(/<script\s+src=/i)
  })

  it('ESCAPES agent-authored content instead of executing it', async () => {
    const r = await rig()
    const taskId = await r.createTask()
    await fileDeck(r, taskId, 'agent.mason', {
      sections: Object.fromEntries(
        DECK_SECTIONS.map((s) => [s, s === 'evidence' ? '<script>alert(1)</script>' : 'x'])
      )
    })

    const html = r.deckHtml()
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('answers the filing agent, so a deck never vanishes silently', async () => {
    const r = await rig()
    const taskId = await r.createTask()
    await fileDeck(r, taskId)
    expect(r.inbox('agent.mason').at(-1)).toMatchObject({ act: 'agree', from: ODEON_ENDPOINT })
  })

  it('records the archive in the book of record (NFR-13)', async () => {
    const r = await rig()
    const taskId = await r.createTask()
    await fileDeck(r, taskId)
    expect(r.logs.find((log) => log['kind'] === 'deck')).toMatchObject({
      event: 'archived',
      taskId,
      by: 'agent.mason'
    })
  })
})

describe('the archive is append-only (invariant §5)', () => {
  it('makes a SECOND deck a new file, keeping the first byte-for-byte', async () => {
    const r = await rig()
    const taskId = await r.createTask()
    await fileDeck(r, taskId)
    const first = r.deckFiles()[0] ?? ''
    const firstBytes = fs.readFileSync(path.join(r.agora.root, 'odeon', 'decks', first))

    await new Promise((resolve) => setTimeout(resolve, 5))
    await fileDeck(r, taskId)

    expect(r.deckFiles()).toHaveLength(2)
    expect(fs.readFileSync(path.join(r.agora.root, 'odeon', 'decks', first))).toEqual(firstBytes)
    // The ledger points at the newest; the older one is still on the shelf.
    expect(r.agora.tasks().tasks[0]?.artifacts.deck).not.toContain(first)
  })
})

describe('who may file a deck, and for what', () => {
  it('refuses a deck for a task assigned to somebody else', async () => {
    const r = await rig()
    const taskId = await r.createTask({ assignee: 'agent.mason' })
    await fileDeck(r, taskId, 'agent.scribe')

    expect(r.deckFiles()).toEqual([])
    expect(r.inbox('agent.scribe').at(-1)?.act).toBe('refuse')
  })

  it('refuses a deck for a task that never asked for one', async () => {
    // Otherwise an agent could manufacture an artifact the ledger then treats
    // as an obligation met.
    const r = await rig()
    const taskId = await r.createTask({ review: [] })
    await fileDeck(r, taskId)
    expect(r.deckFiles()).toEqual([])
  })

  it('refuses a deck for a task that does not exist', async () => {
    const r = await rig()
    await fileDeck(r, 't-2026-08-28-nope')
    expect(r.deckFiles()).toEqual([])
  })

  it('refuses an incomplete deck and says which section', async () => {
    const r = await rig()
    const taskId = await r.createTask()
    await fileDeck(r, taskId, 'agent.mason', { sections: sectionsExcept('tradeOffs') })

    expect(r.deckFiles()).toEqual([])
    expect(r.inbox('agent.mason').at(-1)?.body).toContain('tradeOffs')
  })

  it('bounces a non-propose act at the router, before the archive sees it', async () => {
    const r = await rig()
    const taskId = await r.createTask()
    r.post(
      'agent.mason',
      message({
        from: 'agent.mason',
        to: ODEON_ENDPOINT,
        subject: 'deck',
        body: deckBody(taskId),
        act: 'inform'
      })
    )
    await r.sweep()
    expect(r.deckFiles()).toEqual([])
  })
})

describe('S-DECKGATE — a review:deck task is mechanically unclosable (FR-7.2)', () => {
  async function close(r: Rig, taskId: string): Promise<void> {
    r.post(
      'agent.artemis',
      message({
        from: 'agent.artemis',
        to: LEDGER_ENDPOINT,
        subject: 'close it',
        body: JSON.stringify({
          schemaVersion: LEDGER_SCHEMA_VERSION,
          ops: [{ op: 'update', id: taskId, patch: { status: 'done' } }]
        })
      })
    )
    await r.sweep()
  }

  it('REFUSES to close while the deck is missing, naming the obligation', async () => {
    const r = await rig()
    const taskId = await r.createTask()
    await close(r, taskId)

    expect(r.agora.tasks().tasks[0]?.status).not.toBe('done')
    expect(r.inbox('agent.artemis').at(-1)?.body).toContain('owes a review deck')
  })

  it('lets the SAME close through once the deck is archived', async () => {
    // The refusal above must be the deck talking, not a ledger that refuses
    // every close — otherwise that test would pass for the wrong reason.
    const r = await rig()
    const taskId = await r.createTask()
    await fileDeck(r, taskId)
    await close(r, taskId)

    expect(r.agora.tasks().tasks[0]?.status).toBe('done')
  })
})

describe('the viewer reads the archive, and only the archive', () => {
  it('lists archived decks newest first', async () => {
    const r = await rig()
    const a = await r.createTask()
    await fileDeck(r, a)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const b = await r.createTask()
    await fileDeck(r, b)

    const listed = r.odeon.decks()
    expect(listed).toHaveLength(2)
    expect(listed[0]?.taskId).toBe(b)
  })

  it('reads one deck back by its ref', async () => {
    const r = await rig()
    const taskId = await r.createTask()
    await fileDeck(r, taskId)
    const ref = r.odeon.decks()[0]?.ref ?? ''
    expect(r.odeon.read(ref)).toContain('Checkout flakiness')
  })

  it.each([
    '../../../../etc/passwd',
    'odeon/decks/../../config.json',
    'notes.html',
    'odeon/decks/t-x.html'
  ])('refuses to read %s', async (ref) => {
    const r = await rig()
    expect(r.odeon.read(ref)).toBeNull()
  })
})

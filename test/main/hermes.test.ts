import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { composeMessage, makeMessageId, type Message } from '../../src/shared/message'
import { Agora } from '../../src/main/agora'
import { DONE_DIR, Hermes, REJECTED_DIR, type HermesFaultPoint } from '../../src/main/hermes'
import { PromptStore } from '../../src/main/prompts'
import { DEFAULT_HOP_CAP } from '../../src/shared/routing'
import { PATHOLOGY_SIGNAL_AT } from '../../src/shared/autonomy'

/**
 * Delivery on **real fs in temp dirs** with two agents (TEST-STRATEGY §2). The
 * mechanism under test is the file dance itself — outbox → temp+rename →
 * inbox → `.done/` — so nothing here is mocked.
 */

const BUNDLED_PROMPTS = fileURLToPath(new URL('../../prompts/', import.meta.url))
const temps: string[] = []
const routers: Hermes[] = []
const agoras: Agora[] = []

afterEach(async () => {
  for (const hermes of routers.splice(0)) hermes.stop()
  // Delivery queues its commits rather than awaiting them (ADR-0004), so a
  // teardown that does not drain them races git for the temp directory.
  for (const agora of agoras.splice(0)) await agora.drained().catch(() => {})
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

interface Rig {
  readonly agora: Agora
  readonly hermes: Hermes
  readonly home: string
  send(from: string, message: Message): string
  inbox(agentId: string): readonly string[]
  done(agentId: string): readonly string[]
}

async function rig(
  options: {
    faults?: (point: HermesFaultPoint) => void | Promise<void>
    context?: NonNullable<ConstructorParameters<typeof Hermes>[0]['context']>
    blockCap?: number
    isIdle?: (agentId: string) => boolean
    nudge?: (agentId: string, text: string) => void
    onPathology?: (agentId: string, blocks: number) => void
    onSweepError?: (err: unknown) => void
  } = {}
): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-hermes-'))
  temps.push(home)
  const agora = new Agora({
    root: path.join(home, 'agora'),
    prompts: new PromptStore(path.join(home, 'prompts'), BUNDLED_PROMPTS),
    backoffMs: 1
  })
  await agora.ensureRepo()
  agoras.push(agora)

  const hermes = new Hermes({ agora, ...options })
  routers.push(hermes)
  hermes.ensureMailbox('agent.a')
  hermes.ensureMailbox('agent.b')

  return {
    agora,
    hermes,
    home,
    send(from, message) {
      const file = path.join(agora.agentDir(from), 'outbox', `${message.id}.json`)
      fs.writeFileSync(file, JSON.stringify(message, null, 2), 'utf8')
      return file
    },
    inbox(agentId) {
      const dir = path.join(agora.agentDir(agentId), 'inbox')
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')) : []
    },
    done(agentId) {
      const dir = path.join(agora.agentDir(agentId), 'inbox', DONE_DIR)
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')) : []
    }
  }
}

let counter = 0
function message(over: Partial<Parameters<typeof composeMessage>[0]> = {}): Message {
  counter += 1
  return composeMessage({
    id: makeMessageId(
      new Date(Date.UTC(2026, 7, 26, 14, 3, 11, counter % 1000)),
      `a${String(counter).padStart(4, '0')}`
    ),
    conversation: 'conv-7f3',
    from: 'agent.a',
    to: 'agent.b',
    act: 'request',
    subject: 'need the checkout numbers',
    body: 'Please send last week’s totals.',
    created_at: '2026-08-26T14:03:11.123Z',
    ...over
  })
}

describe('Hermes — delivery (ADR-0003, FR-3.2)', () => {
  it('moves a message from one agent outbox to the other inbox', async () => {
    const r = await rig()
    const sent = message()
    const outboxFile = r.send('agent.a', sent)

    const report = await r.hermes.sweep()

    expect(report.delivered).toHaveLength(1)
    expect(r.inbox('agent.b')).toEqual([`${sent.id}.json`])
    // The outbox is router-drained (SDD §2) — the message lives in the inbox now.
    expect(fs.existsSync(outboxFile)).toBe(false)

    const delivered = JSON.parse(
      fs.readFileSync(path.join(r.agora.agentDir('agent.b'), 'inbox', `${sent.id}.json`), 'utf8')
    ) as Message
    expect(delivered).toEqual(sent)
  })

  it('never leaves a half-written file visible in the inbox', async () => {
    const r = await rig()
    r.send('agent.a', message({ body: 'x'.repeat(50_000) }))
    await r.hermes.sweep()

    const inbox = path.join(r.agora.agentDir('agent.b'), 'inbox')
    // temp+rename means no `.tmp` residue and no partial JSON.
    expect(fs.readdirSync(inbox).filter((n) => n.includes('.tmp'))).toEqual([])
    for (const name of r.inbox('agent.b')) {
      expect(() => JSON.parse(fs.readFileSync(path.join(inbox, name), 'utf8'))).not.toThrow()
    }
  })

  it('logs every delivery with the refs needed to find it again (NFR-13)', async () => {
    const r = await rig()
    const sent = message()
    r.send('agent.a', sent)
    await r.hermes.sweep()

    const entry = r.agora.readLog().find((e) => e['kind'] === 'delivery')
    expect(entry).toMatchObject({
      kind: 'delivery',
      msgId: sent.id,
      from: 'agent.a',
      to: 'agent.b',
      act: 'request',
      conversation: 'conv-7f3'
    })
  })

  it('delivers several messages in one pass, in id order', async () => {
    const r = await rig()
    const first = message({ subject: 'first' })
    const second = message({ subject: 'second' })
    r.send('agent.a', first)
    r.send('agent.a', second)

    const report = await r.hermes.sweep()

    expect(report.delivered.map((d) => d.message.subject)).toEqual(['first', 'second'])
    expect(r.inbox('agent.b')).toHaveLength(2)
  })
})

describe('Hermes — a message the router will not carry', () => {
  it('parks unparseable JSON instead of dropping or retrying it forever', async () => {
    const r = await rig()
    const file = path.join(r.agora.agentDir('agent.a'), 'outbox', 'broken.json')
    fs.writeFileSync(file, '{ not json', 'utf8')

    const report = await r.hermes.sweep()

    expect(report.rejected).toHaveLength(1)
    expect(report.rejected[0]?.reason).toContain('not valid JSON')
    expect(fs.existsSync(file)).toBe(false)
    expect(
      fs.existsSync(path.join(r.agora.agentDir('agent.a'), 'outbox', REJECTED_DIR, 'broken.json'))
    ).toBe(true)
    // A second sweep must not re-reject it.
    expect((await r.hermes.sweep()).rejected).toHaveLength(0)
  })

  it('rejects a forged sender — an outbox may only carry its owner mail', async () => {
    const r = await rig()
    // agent.a writes a message claiming to be from agent.b.
    r.send('agent.a', message({ from: 'agent.b', to: 'agent.a' }))

    const report = await r.hermes.sweep()

    expect(report.rejected[0]?.reason).toContain('does not own this outbox')
    expect(r.inbox('agent.a')).toEqual([])
  })

  it('rejects a message that lies about owing a reply (ADR-0003 obligation table)', async () => {
    const r = await rig()
    const forged = { ...message({ act: 'request' }), requires_reply: false }
    fs.writeFileSync(
      path.join(r.agora.agentDir('agent.a'), 'outbox', `${forged.id}.json`),
      JSON.stringify(forged),
      'utf8'
    )

    const report = await r.hermes.sweep()

    expect(report.rejected[0]?.reason).toContain('requires_reply must be true')
    expect(r.inbox('agent.b')).toEqual([])
  })

  it('records every rejection in the log — never a silent drop', async () => {
    const r = await rig()
    fs.writeFileSync(path.join(r.agora.agentDir('agent.a'), 'outbox', 'bad.json'), '{', 'utf8')
    await r.hermes.sweep()

    expect(
      r.agora.readLog().some((e) => e['kind'] === 'error' && e['subsystem'] === 'hermes')
    ).toBe(true)
  })
})

describe('Hermes — inbox consumption is idempotent (ADR-0003, FR-3.6)', () => {
  it('consumes mail once and moves it to .done/', async () => {
    const r = await rig()
    const sent = message()
    r.send('agent.a', sent)
    await r.hermes.sweep()

    const consumed = await r.hermes.consumeInbox('agent.b')

    expect(consumed.map((m) => m.id)).toEqual([sent.id])
    expect(r.inbox('agent.b')).toEqual([])
    expect(r.done('agent.b')).toEqual([`${sent.id}.json`])
    expect(r.hermes.readCursor('agent.b').lastProcessed).toBe(sent.id)
  })

  it('returns nothing on a second call — no double-processing', async () => {
    const r = await rig()
    r.send('agent.a', message())
    await r.hermes.sweep()

    expect(await r.hermes.consumeInbox('agent.b')).toHaveLength(1)
    expect(await r.hermes.consumeInbox('agent.b')).toEqual([])
  })

  it('ignores a redelivery of an id already in .done/ (replay after a crash)', async () => {
    const r = await rig()
    const sent = message()
    r.send('agent.a', sent)
    await r.hermes.sweep()
    await r.hermes.consumeInbox('agent.b')

    // A crash mid-drain could leave the same file delivered again.
    fs.writeFileSync(
      path.join(r.agora.agentDir('agent.b'), 'inbox', `${sent.id}.json`),
      JSON.stringify(sent),
      'utf8'
    )

    expect(await r.hermes.consumeInbox('agent.b')).toEqual([])
    expect(r.inbox('agent.b')).toEqual([])
  })

  it('reports pending mail, which is what the wake watchdog reads', async () => {
    const r = await rig()
    expect(r.hermes.hasPendingMail('agent.b')).toBe(false)

    r.send('agent.a', message())
    await r.hermes.sweep()
    expect(r.hermes.hasPendingMail('agent.b')).toBe(true)

    await r.hermes.consumeInbox('agent.b')
    expect(r.hermes.hasPendingMail('agent.b')).toBe(false)
  })

  it('reads an unreadable cursor as empty rather than failing', async () => {
    const r = await rig()
    fs.writeFileSync(r.hermes.cursorPath('agent.b'), 'not json', 'utf8')
    expect(r.hermes.readCursor('agent.b').lastProcessed).toBeNull()
  })
})

describe('Hermes — crash safety (S-BLACKOUT primitives)', () => {
  it('loses nothing when the harness dies before the rename', async () => {
    const r = await rig({
      faults: (point) => {
        if (point === 'before-deliver') throw new Error('blackout before delivery')
      }
    })
    const sent = message()
    const outboxFile = r.send('agent.a', sent)

    await expect(r.hermes.sweep()).rejects.toThrow(/blackout/)

    // Still in the outbox: nothing delivered, nothing lost.
    expect(fs.existsSync(outboxFile)).toBe(true)
    expect(r.inbox('agent.b')).toEqual([])
  })

  it('does not double-deliver when the harness dies after the rename', async () => {
    let armed = true
    const r = await rig({
      faults: (point) => {
        if (point === 'before-drain-outbox' && armed) {
          armed = false
          throw new Error('blackout after delivery, before the outbox drain')
        }
      }
    })
    const sent = message()
    r.send('agent.a', sent)

    await expect(r.hermes.sweep()).rejects.toThrow(/blackout/)
    // Delivered, but the outbox copy survived the crash.
    expect(r.inbox('agent.b')).toEqual([`${sent.id}.json`])

    // The restarted harness sweeps again: same id, same filename, no duplicate.
    await r.hermes.sweep()
    expect(r.inbox('agent.b')).toEqual([`${sent.id}.json`])
    expect(await r.hermes.consumeInbox('agent.b')).toHaveLength(1)
  })
})

describe('Hermes — a sweep nobody awaits', () => {
  it('reports a watcher-triggered failure instead of killing the harness', async () => {
    // The watcher fires this sweep, so there is no caller to reject to. Before
    // the guard, a failing delivery here was an unhandledRejection — fatal to
    // the Electron main process, over a fault the design says to absorb.
    const seen: unknown[] = []
    const r = await rig({
      faults: (point) => {
        if (point === 'before-deliver') throw new Error('watcher-time blackout')
      },
      onSweepError: (err) => seen.push(err)
    })
    r.hermes.watch('agent.a')
    r.hermes.start()

    const unhandled: unknown[] = []
    const capture = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', capture)
    try {
      r.send('agent.a', message())
      for (let i = 0; i < 100 && seen.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', capture)
    }

    expect(seen).toHaveLength(1)
    expect((seen[0] as Error).message).toMatch(/watcher-time blackout/)
    expect(unhandled).toEqual([])
  })
})

describe('Hermes — the sweep backs up fs-watch (R6)', () => {
  it('finds mail no watcher ever reported', async () => {
    const r = await rig()
    // No watch() call at all: the sweep is the only thing that can find this.
    r.send('agent.a', message())

    expect((await r.hermes.sweep()).delivered).toHaveLength(1)
  })

  it('delivers within the latency budget once watching (NFR-2: p95 ≤ 500 ms)', async () => {
    const r = await rig()
    r.hermes.watch('agent.a')
    r.hermes.start()

    const started = Date.now()
    r.send('agent.a', message())

    let elapsed = 0
    for (let i = 0; i < 100; i += 1) {
      if (r.inbox('agent.b').length > 0) {
        elapsed = Date.now() - started
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect(r.inbox('agent.b')).toHaveLength(1)
    expect(elapsed).toBeLessThan(500)
  })

  it('is safe to sweep concurrently — one pass, not a race', async () => {
    const r = await rig()
    r.send('agent.a', message())
    r.send('agent.a', message())

    const reports = await Promise.all([r.hermes.sweep(), r.hermes.sweep(), r.hermes.sweep()])

    expect(reports.flatMap((report) => report.delivered)).toHaveLength(2)
    expect(r.inbox('agent.b')).toHaveLength(2)
  })
})

describe('Hermes — routing rules end to end (M2.4)', () => {
  it('bounces mail to a missing agent, and the sender actually receives it', async () => {
    const r = await rig()
    const sent = message({ to: 'agent.ghost' })
    r.send('agent.a', sent)

    await r.hermes.sweep()

    // Nothing dropped: a refuse landed back in the sender's own inbox.
    const inbox = r.inbox('agent.a')
    expect(inbox).toHaveLength(1)
    const refusal = JSON.parse(
      fs.readFileSync(path.join(r.agora.agentDir('agent.a'), 'inbox', inbox[0] ?? ''), 'utf8')
    ) as Message
    expect(refusal.act).toBe('refuse')
    expect(refusal.in_reply_to).toBe(sent.id)
    expect(refusal.body).toContain('agent.ghost')
    expect(r.agora.readLog().some((e) => e['kind'] === 'bounce')).toBe(true)
  })

  it('fans a broadcast out to every other agent', async () => {
    const r = await rig()
    r.hermes.ensureMailbox('agent.c')
    r.send('agent.a', message({ to: 'broadcast', act: 'inform' }))

    const report = await r.hermes.sweep()

    expect(report.delivered).toHaveLength(2)
    expect(r.inbox('agent.b')).toHaveLength(1)
    expect(r.inbox('agent.c')).toHaveLength(1)
    // Never back to the sender.
    expect(r.inbox('agent.a')).toEqual([])
  })

  it('diverts a message at the hop cap instead of delivering it', async () => {
    const r = await rig()
    const sent = message({ hops: DEFAULT_HOP_CAP })
    r.send('agent.a', sent)

    await r.hermes.sweep()

    // The addressee never sees it; the human queue does (no Artemis yet).
    expect(r.inbox('agent.b')).toEqual([])
    const humanInbox = path.join(r.agora.pathOf('human'), 'inbox')
    expect(fs.readdirSync(humanInbox)).toEqual([`${sent.id}.json`])

    const diverted = r.agora.readLog().find((e) => e['kind'] === 'bounce')
    expect(diverted).toMatchObject({ divertedTo: 'human', hops: DEFAULT_HOP_CAP })
  })

  it('delivers one hop below the cap', async () => {
    const r = await rig()
    r.send('agent.a', message({ hops: DEFAULT_HOP_CAP - 1 }))
    await r.hermes.sweep()
    expect(r.inbox('agent.b')).toHaveLength(1)
  })

  it('routes to:human into the Architect queue, outside agents/', async () => {
    const r = await rig()
    r.send('agent.a', message({ to: 'human', act: 'inform' }))

    await r.hermes.sweep()

    expect(fs.readdirSync(path.join(r.agora.pathOf('human'), 'inbox'))).toHaveLength(1)
    // A human is not an agent and must not appear in the roster.
    expect(r.hermes.knownAgents()).not.toContain('human')
  })
})

describe('Hermes — the autonomy loop (ADR-0013, M2.5)', () => {
  it('lets a turn end when nothing is pending', async () => {
    const r = await rig()
    expect(r.hermes.decideOnStop('agent.b', {})).toBeNull()
  })

  it('blocks a turn that has unread mail, handing back a reason (S-STOPLOOP)', async () => {
    const r = await rig()
    r.send('agent.a', message())
    await r.hermes.sweep()

    const reply = r.hermes.decideOnStop('agent.b', {})

    expect(reply?.decision).toBe('block')
    expect(reply?.reason).toContain('1')
    expect(r.hermes.blockCount('agent.b')).toBe(1)
  })

  it('never re-blocks a turn the hook itself continued (guard 1)', async () => {
    const r = await rig()
    r.send('agent.a', message())
    await r.hermes.sweep()

    expect(r.hermes.decideOnStop('agent.b', { stop_hook_active: true })).toBeNull()
    expect(r.hermes.blockCount('agent.b')).toBe(0)
  })

  it('stops blocking at the cap however much mail keeps arriving (guard 2, S-STOPLOOP)', async () => {
    const r = await rig({ blockCap: 3 })
    r.send('agent.a', message())
    await r.hermes.sweep()

    // The pathological case: mail never runs out, the agent never consumes it.
    const decisions = [1, 2, 3, 4, 5].map(() => r.hermes.decideOnStop('agent.b', {}))

    expect(decisions.slice(0, 3).every((d) => d?.decision === 'block')).toBe(true)
    expect(decisions.slice(3).every((d) => d === null)).toBe(true)
    expect(r.hermes.blockCount('agent.b')).toBe(3)
  })

  it('reports the pathology before the cap fires', async () => {
    const signals: { agentId: string; blocks: number }[] = []
    const r = await rig({
      blockCap: 50,
      onPathology: (agentId, blocks) => signals.push({ agentId, blocks })
    })
    r.send('agent.a', message())
    await r.hermes.sweep()

    for (let i = 0; i < PATHOLOGY_SIGNAL_AT; i += 1) r.hermes.decideOnStop('agent.b', {})

    expect(signals.at(-1)).toEqual({ agentId: 'agent.b', blocks: PATHOLOGY_SIGNAL_AT })
  })

  it('gives a respawned agent a fresh block budget', async () => {
    const r = await rig({ blockCap: 2 })
    r.send('agent.a', message())
    await r.hermes.sweep()
    r.hermes.decideOnStop('agent.b', {})
    r.hermes.decideOnStop('agent.b', {})
    expect(r.hermes.decideOnStop('agent.b', {})).toBeNull()

    r.hermes.resetSession('agent.b')

    expect(r.hermes.decideOnStop('agent.b', {})?.decision).toBe('block')
  })

  it('logs every stop decision, so a silent loop is impossible', async () => {
    const r = await rig()
    r.send('agent.a', message())
    await r.hermes.sweep()
    r.hermes.decideOnStop('agent.b', {})
    r.hermes.decideOnStop('agent.c', {})

    const stops = r.agora.readLog().filter((e) => e['kind'] === 'hook' && e['event'] === 'stop')
    expect(stops).toHaveLength(2)
    expect(stops[0]).toMatchObject({ agentId: 'agent.b', decision: 'block', pendingMail: 1 })
    expect(stops[1]).toMatchObject({ agentId: 'agent.c', decision: 'continue' })
  })
})

describe('Hermes — the inbox wake watchdog (ADR-0013, FR-3.5, S-WAKE)', () => {
  it('nudges an idle agent exactly once when mail lands', async () => {
    const nudges: { agentId: string; text: string }[] = []
    const r = await rig({
      isIdle: () => true,
      nudge: (agentId, text) => nudges.push({ agentId, text })
    })
    r.send('agent.a', message())
    await r.hermes.sweep()

    expect(r.hermes.wakeCheck()).toEqual(['agent.b'])
    // Called again while the same mail sits unread: no second nudge.
    expect(r.hermes.wakeCheck()).toEqual([])
    expect(r.hermes.wakeCheck()).toEqual([])
    expect(nudges).toHaveLength(1)
    expect(nudges[0]?.agentId).toBe('agent.b')
  })

  it('suppresses the nudge for an agent that is not idle', async () => {
    const r = await rig({ isIdle: () => false, nudge: () => {} })
    r.send('agent.a', message())
    await r.hermes.sweep()

    expect(r.hermes.wakeCheck()).toEqual([])
  })

  it('nudges again for the NEXT batch of mail, once the first is consumed', async () => {
    const r = await rig({ isIdle: () => true, nudge: () => {} })
    r.send('agent.a', message())
    await r.hermes.sweep()
    expect(r.hermes.wakeCheck()).toEqual(['agent.b'])

    await r.hermes.consumeInbox('agent.b')
    expect(r.hermes.wakeCheck()).toEqual([])

    r.send('agent.a', message())
    await r.hermes.sweep()
    expect(r.hermes.wakeCheck()).toEqual(['agent.b'])
  })

  it('does not nudge an agent with an empty inbox', async () => {
    const r = await rig({ isIdle: () => true, nudge: () => {} })
    expect(r.hermes.wakeCheck()).toEqual([])
  })

  it('records each wake in the log', async () => {
    const r = await rig({ isIdle: () => true, nudge: () => {} })
    r.send('agent.a', message())
    await r.hermes.sweep()
    r.hermes.wakeCheck()

    expect(r.agora.readLog().some((e) => e['kind'] === 'hook' && e['event'] === 'wake')).toBe(true)
  })
})

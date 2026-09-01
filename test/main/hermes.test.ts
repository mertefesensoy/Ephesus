import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { composeMessage, makeMessageId, type Message } from '../../src/shared/message'
import { Agora } from '../../src/main/agora'
import {
  DONE_DIR,
  Hermes,
  REJECTED_DIR,
  type HermesFaultPoint,
  type StopReply
} from '../../src/main/hermes'
import { PromptStore } from '../../src/main/prompts'
import { HERMES_SENDER } from '../../src/shared/reserved'
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
  outbox(agentId: string): readonly string[]
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
    onDiverted?: (record: { from: string; conversation: string; reason: string }) => void
    /**
     * Opt-in, not the default: several cases below assert on the *fallback*
     * rendering (`render()` serialises its vars when no store is wired), so
     * handing every rig the real templates would rewrite tests that are not
     * about prose. The cases that check what an agent is actually told wire it.
     */
    withPrompts?: boolean
  } = {}
): Promise<Rig> {
  const { withPrompts, ...hermesOptions } = options
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-hermes-'))
  temps.push(home)
  const prompts = new PromptStore(path.join(home, 'prompts'), BUNDLED_PROMPTS)
  const agora = new Agora({
    root: path.join(home, 'agora'),
    prompts,
    backoffMs: 1
  })
  await agora.ensureRepo()
  agoras.push(agora)

  const hermes = new Hermes({ agora, ...(withPrompts ? { prompts } : {}), ...hermesOptions })
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
    outbox(agentId) {
      const dir = path.join(agora.agentDir(agentId), 'outbox')
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
    const forged = message({ from: 'agent.b', to: 'agent.a' })
    r.send('agent.a', forged)

    const report = await r.hermes.sweep()

    expect(report.rejected[0]?.reason).toContain('does not own this outbox')
    // The forged message itself is not carried. agent.a's inbox is no longer
    // asserted EMPTY, because the refusal now lands there — which is the point
    // of the case below.
    expect(r.inbox('agent.a')).not.toContain(`${forged.id}.json`)
  })

  /**
   * The general form of the 2026-09-01 loss. Deriving `requires_reply` fixed
   * the ONE reason that destroyed Artemis's standup brief; these cover the
   * class — whatever the reason, the author is told, so it can learn, correct
   * and retry instead of writing into a void.
   */
  it('returns the refusal to the author, with enough to fix the message', async () => {
    const r = await rig({ withPrompts: true })
    const file = path.join(r.agora.agentDir('agent.a'), 'outbox', 'broken.json')
    fs.writeFileSync(file, '{ not json', 'utf8')

    const report = await r.hermes.sweep()

    const notice = report.rejected[0]?.notice
    expect(notice).not.toBeNull()
    // Addressed from the reserved router identity, never forged as someone else.
    expect(notice?.from).toBe(HERMES_SENDER)
    expect(notice?.act).toBe('refuse')
    // The author is read from the PATH: a file whose bytes are not even JSON
    // still has a knowable author, which is what makes the class closable.
    expect(notice?.to).toBe('agent.a')
    expect(r.inbox('agent.a')).toEqual([`${notice?.id}.json`])

    // Enough to fix it: which message, why, and where the text still is.
    expect(notice?.subject).toContain('broken.json')
    expect(notice?.body).toContain('not valid JSON')
    expect(notice?.body).toContain(`outbox/${REJECTED_DIR}/broken.json`)
  })

  it('tells the outbox owner, not the identity a forged file claimed', async () => {
    const r = await rig({ withPrompts: true })
    r.send('agent.a', message({ from: 'agent.b', to: 'agent.a' }))

    const report = await r.hermes.sweep()

    // agent.b did not write this and must never be told that it did. The
    // author comes from the directory, not from the content — which is exactly
    // why a forgery cannot misdirect the refusal.
    expect(report.rejected[0]?.notice?.to).toBe('agent.a')
    expect(r.inbox('agent.b')).toEqual([])
  })

  it('cannot ping-pong: the refusal obligates nothing and never enters an outbox', async () => {
    const r = await rig({ withPrompts: true })
    fs.writeFileSync(
      path.join(r.agora.agentDir('agent.a'), 'outbox', 'broken.json'),
      '{ not json',
      'utf8'
    )

    const first = await r.hermes.sweep()
    const notice = first.rejected[0]?.notice
    expect(notice).not.toBeNull()

    // `refuse` is not a reply-obliging act, so the notice asks for nothing back
    // and starts no chain; hops 0 means it can never trip a hop cap either.
    expect(notice?.requires_reply).toBe(false)
    expect(notice?.hops).toBe(0)

    // It is well-formed, so consuming it can never reject it in turn...
    const consumed = await r.hermes.consumeInbox('agent.a')
    expect(consumed.map((m) => m.id)).toEqual([notice?.id])

    // ...and it went straight to the inbox, so the next sweep finds nothing to
    // refuse. A refusal cannot be refused.
    const second = await r.hermes.sweep()
    expect(second.rejected).toEqual([])
    expect(second.delivered).toEqual([])
    expect(r.outbox('agent.a')).toEqual([])
  })

  it('parks a message whose author cannot be named, and invents no recipient', async () => {
    const r = await rig({ withPrompts: true })
    const inbox = path.join(r.agora.agentDir('agent.b'), 'inbox')
    // An inbox names the RECIPIENT; `from` is the field that just failed to
    // validate. Guessing an author here would send a refusal to someone who may
    // never have written anything, so the log entry is all anyone can have.
    //
    // BOTH inbox failure branches, deliberately: unreadable bytes and readable
    // JSON that is not a message. A first draft covered only the first, and a
    // mutation that invented an author on the second passed it.
    fs.writeFileSync(path.join(inbox, 'wrecked.json'), '{ "from": "', 'utf8')
    fs.writeFileSync(path.join(inbox, 'shaped.json'), '{ "from": "agent.a" }', 'utf8')

    expect(await r.hermes.consumeInbox('agent.b')).toEqual([])

    expect(fs.existsSync(path.join(inbox, REJECTED_DIR, 'wrecked.json'))).toBe(true)
    expect(fs.existsSync(path.join(inbox, REJECTED_DIR, 'shaped.json'))).toBe(true)
    // Nobody is told — least of all `agent.a`, which the readable-but-invalid
    // file names as its sender and which the router must not believe.
    expect(r.inbox('agent.a')).toEqual([])
    expect(r.inbox('agent.b')).toEqual([])
    // Matched on the two files by name rather than counted globally: the log is
    // the whole rig's, and an exact count would couple this case to anything
    // else that ever logs an error.
    const errors = r.agora
      .readLog()
      .filter((e) => e['kind'] === 'error' && e['subsystem'] === 'hermes')
    for (const name of ['wrecked.json', 'shaped.json']) {
      const entry = errors.find((e) => String(e['file'] ?? '').endsWith(name))
      expect(entry, `no rejection logged for ${name}`).toBeDefined()
      expect(entry).toMatchObject({ author: null, noticeId: null })
    }
  })

  it('still parks, and says it could not tell anyone, when the author is unaddressable', async () => {
    const r = await rig({ withPrompts: true })
    // A directory under agents/ whose name is not a valid agent id. `to` is
    // schema-validated, so composing the notice throws — and it must be caught,
    // not delivered half-formed and not allowed to take the sweep down.
    const stray = path.join(r.agora.pathOf('agents'), 'NOT-an-agent-id', 'outbox')
    fs.mkdirSync(stray, { recursive: true })
    fs.writeFileSync(path.join(stray, 'broken.json'), '{ not json', 'utf8')

    const report = await r.hermes.sweep()

    const record = report.rejected.find((x) => x.file.includes('NOT-an-agent-id'))
    expect(record).toBeDefined()
    expect(record?.notice).toBeNull()
    // Parked regardless: losing the notification must not also lose the file.
    expect(fs.existsSync(path.join(stray, REJECTED_DIR, 'broken.json'))).toBe(true)
    // And the failure to notify is itself visible — a silent failure to break
    // the silence would be the same bug one level up.
    const failed = r.agora
      .readLog()
      .find((e) => typeof e['reason'] === 'string' && e['reason'].includes('could not tell'))
    expect(failed).toBeDefined()
  })

  /**
   * Replaces a case that asserted the message was REJECTED. On the 2026-09-01
   * live run that rule destroyed a finished standup brief, and the author was
   * never told — a rejection is parked and logged, never returned. The
   * obligation is now derived, which the sender cannot dodge, and the mail is
   * carried.
   */
  it('carries a message whose obligation flag was wrong, having fixed it', async () => {
    const r = await rig()
    const forged = { ...message({ act: 'request' }), requires_reply: false }
    fs.writeFileSync(
      path.join(r.agora.agentDir('agent.a'), 'outbox', `${forged.id}.json`),
      JSON.stringify(forged),
      'utf8'
    )

    const report = await r.hermes.sweep()

    expect(report.rejected).toEqual([])
    const delivered = r.inbox('agent.b')
    expect(delivered).toHaveLength(1)
    const carried = JSON.parse(
      fs.readFileSync(
        path.join(r.agora.agentDir('agent.b'), 'inbox', delivered[0] as string),
        'utf8'
      )
    ) as { requires_reply: boolean }
    expect(carried.requires_reply).toBe(true)
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

  it('reports a timer-triggered failure instead of killing the harness', async () => {
    // The M2 close-out fixed the watcher path but missed this one: the periodic
    // sweep timer fired `void this.sweep()`, so a delivery failure on a tick
    // with no watcher armed was an unhandledRejection — fatal to the Electron
    // main process. Found by the M2 close-out audit.
    const seen: unknown[] = []
    const r = await rig({
      faults: (point) => {
        if (point === 'before-deliver') throw new Error('timer-time blackout')
      },
      onSweepError: (err) => seen.push(err)
    })
    // Deliberately NO watcher: only the timer can find this mail.
    r.hermes.start()

    const unhandled: unknown[] = []
    const capture = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', capture)
    try {
      r.send('agent.a', message())
      for (let i = 0; i < 200 && seen.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', capture)
      r.hermes.stop()
    }

    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect((seen[0] as Error).message).toMatch(/timer-time blackout/)
    expect(unhandled).toEqual([])
  })

  it('wakes an idle agent from the production tick, no test driver involved', async () => {
    // The M2 close-out audit found wakeCheck() had zero production callers —
    // the watchdog only ran when a test called it. The tick now chains it onto
    // every sweep, so this asserts the app's own wiring wakes the agent.
    const nudges: string[] = []
    const r = await rig({
      isIdle: () => true,
      nudge: (agentId) => {
        nudges.push(agentId)
      }
    })
    r.hermes.watch('agent.a')
    r.hermes.start()
    try {
      r.send('agent.a', message())
      for (let i = 0; i < 200 && nudges.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    } finally {
      r.hermes.stop()
    }

    expect(nudges).toEqual(['agent.b'])
    expect(r.hermes.pendingMailCount('agent.b')).toBe(0)
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

  it('signals the breaker on a hop-cap diversion — divert, not bounce (trip #3)', async () => {
    // The M3 close-out audit found trip signal #3 wired to onBounced, which a
    // divert never fires: the breaker was blind to its hop-cap signal. The
    // divert path now notifies, exactly once per message however often the
    // sweep re-visits it.
    const diverted: { from: string; conversation: string; reason: string }[] = []
    const r = await rig({ onDiverted: (record) => diverted.push(record) })
    const sent = message({ hops: DEFAULT_HOP_CAP })
    r.send('agent.a', sent)

    await r.hermes.sweep()
    await r.hermes.sweep()

    expect(diverted).toHaveLength(1)
    expect(diverted[0]).toMatchObject({ from: 'agent.a', conversation: sent.conversation })
    expect(diverted[0]?.reason).toContain('hop cap')
  })

  it('holds only the paused recipient of a broadcast, and never re-delivers the rest', async () => {
    // The M3 close-out audit found a paused recipient held the ENTIRE
    // broadcast, and every sweep re-delivered the others — duplicate delivery
    // log entries drumming until the pause lifted (the metronome pattern).
    const r = await rig()
    r.hermes.ensureMailbox('agent.c')
    r.hermes.setPaused('agent.c', true)
    const sent = message({ to: 'broadcast', act: 'inform' })
    r.send('agent.a', sent)

    await r.hermes.sweep()
    await r.hermes.sweep()
    await r.hermes.sweep()

    // agent.b got its copy exactly once; agent.c is held, message not lost.
    expect(r.inbox('agent.b')).toHaveLength(1)
    expect(r.inbox('agent.c')).toEqual([])
    const deliveries = r.agora
      .readLog()
      .filter((e) => e['kind'] === 'delivery' && e['msgId'] === sent.id)
    expect(deliveries).toHaveLength(1)
    // The hold itself is in the log once, not once per sweep.
    const holds = r.agora
      .readLog()
      .filter((e) => e['kind'] === 'breaker' && e['action'] === 'delivery-held')
    expect(holds).toHaveLength(1)

    // Pause lifts: the held copy arrives, the outbox finally drains.
    r.hermes.setPaused('agent.c', false)
    await r.hermes.sweep()
    expect(r.inbox('agent.c')).toHaveLength(1)
    expect(r.outbox('agent.a')).toEqual([])
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
    expect(await r.hermes.decideOnStop('agent.b', {})).toBeNull()
  })

  it('blocks a turn that has unread mail, handing back a reason (S-STOPLOOP)', async () => {
    const r = await rig()
    r.send('agent.a', message())
    await r.hermes.sweep()

    const reply = await r.hermes.decideOnStop('agent.b', {})

    expect(reply?.decision).toBe('block')
    expect(reply?.reason).toContain('1')
    expect(r.hermes.blockCount('agent.b')).toBe(1)
    // Hand-over consumption (ADR-0003, close-out audit): the reason names WHERE
    // the mail was archived and its file is moved in the same act — a second
    // Stop with nothing new can never re-block on the same message.
    //
    // A pointer, not the payload: this text is typed into the agent's terminal,
    // and a real TUI treats a multi-line block as a paste and stops to confirm
    // it. The archived path is what the agent needs; the content is a file it
    // can already read.
    expect(reply?.reason).toContain('inbox/.done/')
    expect(reply?.reason).not.toContain('\n')
    expect(r.hermes.pendingMailCount('agent.b')).toBe(0)
    expect(await r.hermes.decideOnStop('agent.b', {})).toBeNull()
  })

  it('never re-blocks a turn the hook itself continued (guard 1)', async () => {
    const r = await rig()
    r.send('agent.a', message())
    await r.hermes.sweep()

    expect(await r.hermes.decideOnStop('agent.b', { stop_hook_active: true })).toBeNull()
    expect(r.hermes.blockCount('agent.b')).toBe(0)
  })

  it('stops blocking at the cap however much mail keeps arriving (guard 2, S-STOPLOOP)', async () => {
    const r = await rig({ blockCap: 3 })

    // The pathological case: mail keeps arriving, round after round.
    const decisions: (StopReply | null)[] = []
    for (let i = 0; i < 5; i += 1) {
      r.send('agent.a', message())
      await r.hermes.sweep()
      decisions.push(await r.hermes.decideOnStop('agent.b', {}))
    }

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
    for (let i = 0; i < PATHOLOGY_SIGNAL_AT; i += 1) {
      r.send('agent.a', message())
      await r.hermes.sweep()
      await r.hermes.decideOnStop('agent.b', {})
    }

    expect(signals.at(-1)).toEqual({ agentId: 'agent.b', blocks: PATHOLOGY_SIGNAL_AT })
  })

  it('gives a respawned agent a fresh block budget', async () => {
    const r = await rig({ blockCap: 2 })
    const decide = async (): Promise<StopReply | null> => {
      r.send('agent.a', message())
      await r.hermes.sweep()
      return r.hermes.decideOnStop('agent.b', {})
    }
    expect((await decide())?.decision).toBe('block')
    expect((await decide())?.decision).toBe('block')
    expect(await decide()).toBeNull()

    r.hermes.resetSession('agent.b')

    expect((await decide())?.decision).toBe('block')
  })

  it('logs every stop decision, so a silent loop is impossible', async () => {
    const r = await rig()
    r.send('agent.a', message())
    await r.hermes.sweep()
    await r.hermes.decideOnStop('agent.b', {})
    await r.hermes.decideOnStop('agent.c', {})

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

    expect(await r.hermes.wakeCheck()).toEqual(['agent.b'])
    // Called again after the hand-over: no second nudge, nothing left pending.
    expect(await r.hermes.wakeCheck()).toEqual([])
    expect(await r.hermes.wakeCheck()).toEqual([])
    expect(nudges).toHaveLength(1)
    expect(nudges[0]?.agentId).toBe('agent.b')
    // The nudge names where the mail was archived, and the file is moved in the
    // same act. It POINTS rather than pasting: this text is typed into a real
    // TUI, which treats a multi-line block as a paste and halts for
    // confirmation — two freshly spawned agents died there before the hand-over
    // became a pointer.
    expect(nudges[0]?.text).toContain('inbox/.done/')
    expect(nudges[0]?.text).toContain('.json')
    expect(nudges[0]?.text).not.toContain('\n')
    expect(r.hermes.pendingMailCount('agent.b')).toBe(0)
  })

  it('suppresses the nudge for an agent that is not idle', async () => {
    const r = await rig({ isIdle: () => false, nudge: () => {} })
    r.send('agent.a', message())
    await r.hermes.sweep()

    expect(await r.hermes.wakeCheck()).toEqual([])
  })

  it('nudges again for the NEXT batch of mail, once the first is consumed', async () => {
    const r = await rig({ isIdle: () => true, nudge: () => {} })
    r.send('agent.a', message())
    await r.hermes.sweep()
    expect(await r.hermes.wakeCheck()).toEqual(['agent.b'])

    expect(await r.hermes.wakeCheck()).toEqual([])

    r.send('agent.a', message())
    await r.hermes.sweep()
    expect(await r.hermes.wakeCheck()).toEqual(['agent.b'])
  })

  it('does not nudge an agent with an empty inbox', async () => {
    const r = await rig({ isIdle: () => true, nudge: () => {} })
    expect(await r.hermes.wakeCheck()).toEqual([])
  })

  it('records each wake in the log', async () => {
    const r = await rig({ isIdle: () => true, nudge: () => {} })
    r.send('agent.a', message())
    await r.hermes.sweep()
    await r.hermes.wakeCheck()

    expect(r.agora.readLog().some((e) => e['kind'] === 'hook' && e['event'] === 'wake')).toBe(true)
  })
})

describe('Hermes — mail arriving just after a nudge still gets one (M7.7)', () => {
  /**
   * The old watchdog keyed "already nudged" on the AGENT. The nudge consumes
   * the inbox, so the next tick normally sees zero pending and clears the flag
   * — but mail landing in the window between the consume and that observation
   * leaves `pending > 0` with the flag still set, and `pending` never returns
   * to zero again. The agent goes permanently deaf.
   *
   * Keying on the message FILES makes "exactly once" mean once per message,
   * which is what FR-3.5 asks for and what S-WAKE's "no stale nudges" allows.
   */
  it('nudges again for mail that landed after the previous nudge', async () => {
    const nudges: string[] = []
    const r = await rig({ isIdle: () => true, nudge: (agentId) => nudges.push(agentId) })

    r.send('agent.a', message())
    await r.hermes.sweep()
    expect(await r.hermes.wakeCheck()).toEqual(['agent.b'])
    expect(r.hermes.pendingMailCount('agent.b')).toBe(0)

    // New mail, and NO intervening tick observed the empty inbox — which is
    // precisely the window the old flag could not survive.
    r.send('agent.a', message({ subject: 'the second one' }))
    await r.hermes.sweep()

    expect(await r.hermes.wakeCheck()).toEqual(['agent.b'])
    expect(nudges).toEqual(['agent.b', 'agent.b'])
  })

  it('still refuses to nudge twice for the SAME unread mail', async () => {
    // S-WAKE's "no stale nudges" — unchanged. An agent that is told about a
    // message and leaves it unread is not told again.
    const nudges: string[] = []
    const r = await rig({ isIdle: () => false, nudge: (agentId) => nudges.push(agentId) })
    r.send('agent.a', message())
    await r.hermes.sweep()
    // Not idle: skipped, and NOT recorded as told.
    expect(await r.hermes.wakeCheck()).toEqual([])
    expect(nudges).toEqual([])
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GATE_SCHEMA_VERSION,
  gateApproveSchema,
  type GatePolicy,
  type OpenGate
} from '../../src/shared/gates'
import { composeMessage, makeMessageId, type Message } from '../../src/shared/message'
import { HUMAN_QUEUE } from '../../src/shared/routing'
import { Agora } from '../../src/main/agora'
import { Hermes } from '../../src/main/hermes'
import { PromptStore } from '../../src/main/prompts'
import { GateManager } from '../../src/main/watch/gates'

/**
 * The `watch:` read/write surface (SDD §5) the approvals post is a projection
 * of.
 *
 * The property under test is that **main is the authority**: the panel holds no
 * gate state, so every verdict it sends must be validated in main against
 * main's own queue, and the panel's only source of truth is what
 * `watch:approvals` returns. That is asserted here at the module boundary, per
 * TEST-STRATEGY §2 ("never test through the UI what can be tested at the module
 * boundary"); the panel's *rendering* is E2E territory and is carried as owed.
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

async function rig(): Promise<{ agora: Agora; hermes: Hermes }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-watch-ipc-'))
  homes.push(home)
  const prompts = new PromptStore(path.join(home, 'prompts'), BUNDLED_PROMPTS)
  const agora = new Agora({ root: path.join(home, 'agora'), prompts, backoffMs: 1 })
  await agora.ensureRepo()
  agoras.push(agora)
  return { agora, hermes: new Hermes({ agora, prompts }) }
}

const PACKAGING = {
  what: 'rm -rf build/',
  why: 'stale artifacts break the release',
  blastRadius: 'the build directory only',
  rollback: 'npm run build regenerates it'
}

const DENY_ALL: GatePolicy = { schemaVersion: GATE_SCHEMA_VERSION, autonomy: 'manual', rules: [] }

function gates(): GateManager {
  return new GateManager({ policy: () => DENY_ALL })
}

function open(manager: GateManager, over: Partial<{ agentId: string }> = {}): OpenGate {
  const outcome = manager.submit({
    kind: 'destructive',
    agentId: over.agentId ?? 'agent.mason',
    packaging: PACKAGING
  })
  if (!outcome.held) throw new Error('expected the gate to be held')
  return outcome.gate
}

describe('watch:approve validates in main (invariant §2)', () => {
  it('accepts a well-formed verdict', () => {
    const parsed = gateApproveSchema.safeParse({
      gateId: 'g-2026-08-27t01-00-00-000z-ab12',
      verdict: 'approved'
    })
    expect(parsed.success).toBe(true)
  })

  it.each([
    ['a malformed gate id', { gateId: '../../etc/passwd', verdict: 'approved' }],
    ['an unknown verdict', { gateId: 'g-1', verdict: 'maybe' }],
    ['a missing verdict', { gateId: 'g-1' }],
    ['an unknown field', { gateId: 'g-1', verdict: 'approved', force: true }],
    [
      'a claimed channel — main stamps it, the renderer may not name it',
      { gateId: 'g-1', verdict: 'approved', context: { channel: 'voice' } }
    ]
  ])('refuses %s', (_name, payload) => {
    expect(gateApproveSchema.safeParse(payload).success).toBe(false)
  })

  it('refuses a verdict on a gate main does not have open', () => {
    const manager = gates()
    // The renderer holds no gate state, so an id it sends is always a claim
    // main has to check — including a stale one from a queue it rendered
    // moments before the gate settled.
    expect(manager.decide('g-2026-08-27t01-00-00-000z-ffff', 'approved').ok).toBe(false)
  })

  it('refuses a second verdict on a gate already settled, keeping the first', () => {
    const manager = gates()
    const gate = open(manager)
    expect(manager.decide(gate.id, 'denied').ok).toBe(true)
    // Two clicks from a stale render must not overturn the recorded verdict.
    expect(manager.decide(gate.id, 'approved').ok).toBe(false)
    expect(manager.verdictOf(gate.id)).toBe('denied')
  })

  it('is the single source of the queue the panel renders', () => {
    const manager = gates()
    const first = open(manager)
    const second = open(manager, { agentId: 'agent.scribe' })
    expect(manager.list().map((gate) => gate.id)).toEqual([first.id, second.id])
    manager.decide(first.id, 'approved')
    // The panel re-reads rather than editing its own copy, so this list is the
    // only thing that can be shown after a verdict.
    expect(manager.list().map((gate) => gate.id)).toEqual([second.id])
  })

  it('reports a refusal reason the panel can show', () => {
    const manager = gates()
    const result = manager.decide('g-2026-08-27t01-00-00-000z-ffff', 'approved')
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.reason).toMatch(/no open gate/)
  })
})

describe('the Architect’s queue drains visibly (FR-3.7, the M2 carried item)', () => {
  function humanMessage(over: Partial<Message> = {}): Message {
    return composeMessage({
      id: makeMessageId(new Date(), 'aa11'),
      conversation: 'conv-1',
      from: 'agent.mason',
      to: HUMAN_QUEUE,
      act: 'query',
      subject: 'which staging database should I use?',
      body: 'both look current',
      created_at: new Date().toISOString(),
      ...over
    })
  }

  function deliverToHuman(hermes: Hermes, message: Message): void {
    const inbox = path.join(hermes.mailboxDir(HUMAN_QUEUE), 'inbox')
    fs.mkdirSync(inbox, { recursive: true })
    fs.writeFileSync(path.join(inbox, `${message.id}.json`), JSON.stringify(message, null, 2))
  }

  it('is empty before anything is diverted', async () => {
    const { hermes } = await rig()
    expect(hermes.humanQueue()).toEqual([])
  })

  it('shows mail addressed to the human', async () => {
    const { hermes } = await rig()
    // From M2 this accumulated with no reader — mail addressed to the human
    // that the human could not see.
    deliverToHuman(hermes, humanMessage())
    const queue = hermes.humanQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0]?.subject).toContain('staging database')
    expect(queue[0]?.from).toBe('agent.mason')
  })

  it('shows several, oldest first', async () => {
    const { hermes } = await rig()
    const first = humanMessage({ id: makeMessageId(new Date(2026, 7, 27, 9), 'aa01') })
    const second = humanMessage({ id: makeMessageId(new Date(2026, 7, 27, 10), 'aa02') })
    deliverToHuman(hermes, second)
    deliverToHuman(hermes, first)
    // Message ids are time-sortable by construction (SDD §4.4).
    expect(hermes.humanQueue().map((m) => m.id)).toEqual([first.id, second.id])
  })

  it('drains through the harness, not by the test deleting the file', async () => {
    const { hermes } = await rig()
    const message = humanMessage()
    deliverToHuman(hermes, message)
    expect(hermes.humanQueue()).toHaveLength(1)

    // The product's own act — the first draft of this test performed the drain
    // itself, which proved a property the app did not have.
    expect(hermes.dismissFromHumanQueue(message.id)).toBe(true)
    expect(hermes.humanQueue()).toEqual([])
  })

  it('archives rather than deletes, so the mail survives as evidence', async () => {
    const { hermes } = await rig()
    const message = humanMessage()
    deliverToHuman(hermes, message)
    hermes.dismissFromHumanQueue(message.id)
    // Same act `consumeInbox` performs for an agent: atomic rename into
    // `.done/` (ADR-0003), never an unlink.
    const done = path.join(hermes.mailboxDir(HUMAN_QUEUE), 'inbox', '.done', `${message.id}.json`)
    expect(fs.existsSync(done)).toBe(true)
    expect(JSON.parse(fs.readFileSync(done, 'utf8'))).toMatchObject({ id: message.id })
  })

  it('is a no-op on a second click from a stale render', async () => {
    const { hermes } = await rig()
    const message = humanMessage()
    deliverToHuman(hermes, message)
    expect(hermes.dismissFromHumanQueue(message.id)).toBe(true)
    expect(hermes.dismissFromHumanQueue(message.id)).toBe(false)
  })

  it('drains one message without touching the rest', async () => {
    const { hermes } = await rig()
    const first = humanMessage({ id: makeMessageId(new Date(2026, 7, 27, 9), 'bb01') })
    const second = humanMessage({ id: makeMessageId(new Date(2026, 7, 27, 10), 'bb02') })
    deliverToHuman(hermes, first)
    deliverToHuman(hermes, second)
    hermes.dismissFromHumanQueue(first.id)
    expect(hermes.humanQueue().map((m) => m.id)).toEqual([second.id])
  })

  it('skips one unreadable file rather than hiding the whole queue', async () => {
    const { hermes } = await rig()
    deliverToHuman(hermes, humanMessage())
    const inbox = path.join(hermes.mailboxDir(HUMAN_QUEUE), 'inbox')
    fs.writeFileSync(path.join(inbox, 'zz-torn.json'), '{ half a message')
    // One bad file must not make the rest of the Architect's mail invisible.
    expect(hermes.humanQueue()).toHaveLength(1)
  })

  it('skips a well-formed file that is not a message', async () => {
    const { hermes } = await rig()
    const inbox = path.join(hermes.mailboxDir(HUMAN_QUEUE), 'inbox')
    fs.mkdirSync(inbox, { recursive: true })
    fs.writeFileSync(path.join(inbox, 'aa.json'), JSON.stringify({ hello: 'world' }))
    expect(hermes.humanQueue()).toEqual([])
  })
})

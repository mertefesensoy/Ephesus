import { afterEach, describe, expect, it } from 'vitest'
import { REJECTED_DIR } from '../../src/main/hermes'
import { cleanupHomes, startCompany, scenarioMessage, sendStep, type Company } from './company'

/**
 * **S-BOUNCE** (TEST-STRATEGY §3): "mail to archived/missing agent; assert
 * `refuse` bounce + log, sender notified, nothing dropped."
 *
 * FR-3.4 says a missing inbox bounces and is logged, *never silently dropped* —
 * so every assertion here is about the message still being accounted for after
 * it fails to arrive.
 */

let company: Company | null = null

afterEach(async () => {
  await company?.close()
  company = null
  cleanupHomes()
})

describe('S-BOUNCE', () => {
  it('bounces mail to an agent that never existed, and tells the sender', async () => {
    company = await startCompany()
    company.hire('agent.a')

    const sent = scenarioMessage({
      from: 'agent.a',
      to: 'agent.ghost',
      act: 'request',
      subject: 'can you take the flaky test'
    })
    await company.runTurn('agent.a', [sendStep(sent)])
    await company.hermes.sweep()

    // The sender is notified — with a real message, in its real inbox.
    const inbox = company.inbox('agent.a')
    expect(inbox).toHaveLength(1)
    const refusal = company.readInbox('agent.a', inbox[0] ?? '')
    expect(refusal.act).toBe('refuse')
    expect(refusal.to).toBe('agent.a')
    expect(refusal.in_reply_to).toBe(sent.id)
    expect(refusal.conversation).toBe(sent.conversation)
    expect(refusal.body).toContain('agent.ghost')

    // And the log records it with the refs to find both messages again.
    const bounce = company.agora.readLogAll().find((e) => e['kind'] === 'bounce')
    expect(bounce).toMatchObject({
      kind: 'bounce',
      msgId: sent.id,
      from: 'agent.a',
      to: 'agent.ghost',
      refusalId: refusal.id
    })
  })

  it('bounces mail to an ARCHIVED agent — a mailbox that is gone is gone', async () => {
    company = await startCompany()
    company.hire('agent.a')
    company.hire('agent.b')

    // agent.b is archived: its mailbox no longer exists.
    const fs = await import('node:fs')
    fs.rmSync(company.agora.agentDir('agent.b'), { recursive: true, force: true })

    await company.runTurn('agent.a', [
      sendStep(scenarioMessage({ from: 'agent.a', to: 'agent.b', act: 'query' }))
    ])
    await company.hermes.sweep()

    expect(company.inbox('agent.a')).toHaveLength(1)
    expect(company.readInbox('agent.a', company.inbox('agent.a')[0] ?? '').act).toBe('refuse')
  })

  it('drops nothing: the outbox is drained and the message is accounted for', async () => {
    company = await startCompany()
    company.hire('agent.a')

    await company.runTurn('agent.a', [
      sendStep(scenarioMessage({ from: 'agent.a', to: 'agent.nowhere' }))
    ])
    await company.hermes.sweep()

    const fs = await import('node:fs')
    const path = await import('node:path')
    const outbox = path.join(company.agora.agentDir('agent.a'), 'outbox')
    // Drained from the outbox…
    expect(fs.readdirSync(outbox).filter((n) => n.endsWith('.json'))).toEqual([])
    // …and present as a bounce in the log plus a refusal in the sender's inbox.
    expect(company.agora.readLogAll().filter((e) => e['kind'] === 'bounce')).toHaveLength(1)
    expect(company.inbox('agent.a')).toHaveLength(1)
  })

  /**
   * S-BOUNCE's charter is "sender notified, nothing dropped", and until now it
   * only held for mail that was *undeliverable*. A message the router REFUSED
   * to carry was parked and logged and its author was never told — which is how
   * a complete, fully-cited standup brief was destroyed on 2026-09-01 with one
   * line in the error log as the only symptom anywhere.
   */
  it('returns a REJECTION to its author too, not only an undeliverable bounce', async () => {
    company = await startCompany()
    company.hire('agent.a')

    const fs = await import('node:fs')
    const path = await import('node:path')
    const outbox = path.join(company.agora.agentDir('agent.a'), 'outbox')
    // Truncated JSON: refused before a single field can be read, so there is no
    // message id and no conversation to reply into — the hardest case to answer.
    fs.writeFileSync(path.join(outbox, 'malformed.json'), '{ "act": "propose"', 'utf8')

    await company.hermes.sweep()

    const inbox = company.inbox('agent.a')
    expect(inbox).toHaveLength(1)
    const refusal = company.readInbox('agent.a', inbox[0] ?? '')
    expect(refusal.act).toBe('refuse')
    // The author is known from the outbox it was found in, not from the bytes.
    expect(refusal.to).toBe('agent.a')
    // Enough to act on: which file, and where its text still is.
    expect(refusal.body).toContain('malformed.json')
    expect(refusal.body).toContain(`outbox/${REJECTED_DIR}/malformed.json`)

    // Still parked for the Architect — the refusal points at it.
    expect(fs.existsSync(path.join(outbox, REJECTED_DIR, 'malformed.json'))).toBe(true)

    // And it does not refuse its own refusal: a second sweep finds nothing,
    // and the notice consumes cleanly instead of looping.
    await company.hermes.sweep()
    expect(company.inbox('agent.a')).toHaveLength(1)
    expect(await company.hermes.consumeInbox('agent.a')).toHaveLength(1)
  })

  it('does not bounce a bounce — the refusal itself is consumable', async () => {
    company = await startCompany()
    company.hire('agent.a')

    await company.runTurn('agent.a', [
      sendStep(scenarioMessage({ from: 'agent.a', to: 'agent.nowhere' }))
    ])
    await company.hermes.sweep()
    await company.hermes.sweep()

    // Exactly one refusal, and it consumes cleanly rather than looping.
    expect(company.inbox('agent.a')).toHaveLength(1)
    const consumed = await company.hermes.consumeInbox('agent.a')
    expect(consumed).toHaveLength(1)
    expect(company.agora.readLogAll().filter((e) => e['kind'] === 'bounce')).toHaveLength(1)
  })
})

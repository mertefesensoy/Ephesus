import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_HOP_CAP } from '../../src/shared/routing'
import { cleanupHomes, startCompany, scenarioMessage, sendStep, type Company } from './company'

/**
 * **S-LIVELOCK** (TEST-STRATEGY §3): "two fake agents scripted to ping-pong;
 * assert hop-cap diversion to Artemis at exactly the cap, log records, no
 * delivery loop."
 *
 * Two REAL fake-engine processes take turns, each replying to what it just
 * received with `hops + 1`, exactly as a pair of agents stuck in a polite loop
 * would. Nothing stops them except the transport rule.
 */

let company: Company | null = null

afterEach(async () => {
  await company?.close()
  company = null
  cleanupHomes()
})

describe('S-LIVELOCK', () => {
  it('diverts at exactly the cap, and the addressee never sees that message', async () => {
    company = await startCompany()
    company.hire('agent.a')
    company.hire('agent.b')

    let hops = 0
    let sender = 'agent.a'
    let recipient = 'agent.b'
    let lastId: string | null = null

    // Ping-pong until the router refuses to carry it any further.
    for (let turn = 0; turn <= DEFAULT_HOP_CAP; turn += 1) {
      const message = scenarioMessage({
        from: sender,
        to: recipient,
        act: 'query',
        subject: `turn ${turn}`,
        hops,
        in_reply_to: lastId
      })
      await company.runTurn(sender, [sendStep(message)])
      await company.hermes.sweep()

      lastId = message.id
      hops += 1
      const swap = sender
      sender = recipient
      recipient = swap
    }

    // Every exchange below the cap was delivered to an agent...
    const deliveries = company.agora.readLog().filter((e) => e['kind'] === 'delivery')
    expect(deliveries.filter((e) => e['to'] !== 'human')).toHaveLength(DEFAULT_HOP_CAP)

    // ...and the one AT the cap was diverted instead.
    const diversion = company.agora
      .readLog()
      .find((e) => e['kind'] === 'bounce' && e['divertedTo'] === 'human')
    expect(diversion).toMatchObject({ hops: DEFAULT_HOP_CAP, divertedTo: 'human' })
    expect(String(diversion?.['reason'])).toContain(`hop cap ${DEFAULT_HOP_CAP}`)
  })

  it('breaks the loop: the ping-pong cannot continue past the cap', async () => {
    company = await startCompany()
    company.hire('agent.a')
    company.hire('agent.b')

    // Ten more attempts, all already past the cap.
    for (let i = 0; i < 10; i += 1) {
      await company.runTurn('agent.a', [
        sendStep(
          scenarioMessage({
            from: 'agent.a',
            to: 'agent.b',
            act: 'query',
            hops: DEFAULT_HOP_CAP + i
          })
        )
      ])
    }
    await company.hermes.sweep()

    // Not one of them reached agent.b. The loop is broken, not merely slowed.
    expect(company.inbox('agent.b')).toEqual([])
    expect(company.inbox('human')).toHaveLength(10)
  })

  it('records every diversion, so the escalation is auditable', async () => {
    company = await startCompany()
    company.hire('agent.a')
    company.hire('agent.b')

    await company.runTurn('agent.a', [
      sendStep(
        scenarioMessage({ from: 'agent.a', to: 'agent.b', act: 'query', hops: DEFAULT_HOP_CAP })
      )
    ])
    await company.hermes.sweep()

    const log = company.agora.readLog()
    const diversion = log.find((e) => e['kind'] === 'bounce')
    // The refs needed to reconstruct it: who, to whom, where it went instead.
    expect(diversion).toMatchObject({ from: 'agent.a', to: 'agent.b', divertedTo: 'human' })
    expect(log.some((e) => e['kind'] === 'delivery' && e['to'] === 'human')).toBe(true)
  })
})

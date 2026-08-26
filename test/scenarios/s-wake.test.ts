import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupHomes, startCompany, scenarioMessage, sendStep, type Company } from './company'

/**
 * **S-WAKE** (TEST-STRATEGY §3): "mail lands while agent idle; assert watchdog
 * nudge exactly once, no stale nudges, cursor idempotency on replay."
 *
 * The failure this covers is the one ADR-0013 added the watchdog for: mail that
 * arrives while an agent is *already* idle produces no Stop event, so without a
 * watchdog it would sit unread forever.
 */

let company: Company | null = null

afterEach(async () => {
  await company?.close()
  company = null
  cleanupHomes()
})

describe('S-WAKE', () => {
  it('nudges an idle agent exactly once when mail lands', async () => {
    const nudges: string[] = []
    company = await startCompany({ isIdle: () => true, nudge: (id) => nudges.push(id) })
    company.hire('agent.a')
    company.hire('agent.b')

    await company.runTurn('agent.a', [
      sendStep(scenarioMessage({ from: 'agent.a', to: 'agent.b', act: 'request' }))
    ])
    await company.hermes.sweep()

    expect(company.hermes.wakeCheck()).toEqual(['agent.b'])
    // Five more passes while the same mail sits unread: still one nudge.
    for (let i = 0; i < 5; i += 1) company.hermes.wakeCheck()
    expect(nudges).toEqual(['agent.b'])

    expect(company.agora.readLog().filter((e) => e['event'] === 'wake')).toHaveLength(1)
  })

  it('suppresses a stale nudge — an agent mid-turn is left alone', async () => {
    const nudges: string[] = []
    company = await startCompany({ isIdle: () => false, nudge: (id) => nudges.push(id) })
    company.hire('agent.a')
    company.hire('agent.b')

    await company.runTurn('agent.a', [
      sendStep(scenarioMessage({ from: 'agent.a', to: 'agent.b' }))
    ])
    await company.hermes.sweep()

    expect(company.hermes.wakeCheck()).toEqual([])
    expect(nudges).toEqual([])
  })

  it('wakes again for the next batch, once the first is consumed', async () => {
    company = await startCompany({ isIdle: () => true, nudge: () => {} })
    company.hire('agent.a')
    company.hire('agent.b')

    await company.runTurn('agent.a', [
      sendStep(scenarioMessage({ from: 'agent.a', to: 'agent.b' }))
    ])
    await company.hermes.sweep()
    expect(company.hermes.wakeCheck()).toEqual(['agent.b'])

    await company.hermes.consumeInbox('agent.b')
    expect(company.hermes.wakeCheck()).toEqual([])

    await company.runTurn('agent.a', [
      sendStep(scenarioMessage({ from: 'agent.a', to: 'agent.b' }))
    ])
    await company.hermes.sweep()
    expect(company.hermes.wakeCheck()).toEqual(['agent.b'])
  })

  it('is idempotent on replay: a redelivered id is never consumed twice', async () => {
    company = await startCompany({ isIdle: () => true, nudge: () => {} })
    company.hire('agent.a')
    company.hire('agent.b')

    const sent = scenarioMessage({ from: 'agent.a', to: 'agent.b', act: 'request' })
    await company.runTurn('agent.a', [sendStep(sent)])
    await company.hermes.sweep()

    const first = await company.hermes.consumeInbox('agent.b')
    expect(first.map((m) => m.id)).toEqual([sent.id])
    expect(company.done('agent.b')).toEqual([`${sent.id}.json`])
    expect(company.hermes.readCursor('agent.b').lastProcessed).toBe(sent.id)

    // A crash-and-replay puts the same file back in the inbox.
    fs.writeFileSync(
      path.join(company.agora.agentDir('agent.b'), 'inbox', `${sent.id}.json`),
      JSON.stringify(sent),
      'utf8'
    )

    expect(await company.hermes.consumeInbox('agent.b')).toEqual([])
    expect(company.inbox('agent.b')).toEqual([])
    expect(company.done('agent.b')).toHaveLength(1)
  })
})

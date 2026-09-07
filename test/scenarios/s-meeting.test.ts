import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ODEON_ENDPOINT } from '../../src/shared/reserved'
import { cleanupHomes, scenarioMessage, sendStep, startCompany, type Company } from './company'

/**
 * S-MEETING (TEST-STRATEGY §3): "convene 3 fake agents; assert turn order
 * enforcement, interjection floor-grab, minutes + action items in board/ledger."
 *
 * Three REAL spawned `fake-engine` processes answer from their own outboxes,
 * over the real router. The claim under test is the one that makes a meeting a
 * meeting: an out-of-turn answer is held, not lost — and the held answer is
 * released when the floor reaches it.
 */

const companies: Company[] = []
afterAll(async () => {
  for (const company of companies.splice(0)) await company.close()
  cleanupHomes()
})

const ATTENDEES = ['agent.a', 'agent.b', 'agent.c']

async function company(): Promise<Company> {
  const started = await startCompany()
  companies.push(started)
  started.hire('agent.artemis')
  for (const id of ATTENDEES) started.hire(id)
  return started
}

/** One attendee answers from its own outbox, as a real spawned process. */
async function answer(eph: Company, from: string, text: string): Promise<void> {
  await eph.runTurn(from, [
    sendStep(
      scenarioMessage({ from, to: ODEON_ENDPOINT, act: 'inform', subject: 'meeting', body: text })
    )
  ])
  await eph.hermes.sweep()
}

function convene(eph: Company): string {
  const opened = eph.meetings.convene({
    attendees: ATTENDEES,
    agenda: 'What is blocking the checkout fix?'
  })
  if (!opened.ok) throw new Error(opened.reason)
  return opened.id
}

function spoke(eph: Company): string[] {
  return (eph.meetings.current()?.transcript ?? []).map((turn) => turn.from)
}

function asked(eph: Company, who: string): number {
  return eph
    .inbox(who)
    .map((name) => eph.readInbox(who, name))
    .filter((message) => message.from === ODEON_ENDPOINT && message.act === 'query').length
}

describe('S-MEETING — turn order is enforced, not requested', () => {
  it('hands the floor to the first attendee and asks nobody else', async () => {
    const eph = await company()
    convene(eph)

    expect(eph.meetings.current()?.floor).toBe('agent.a')
    expect(asked(eph, 'agent.a')).toBe(1)
    expect(asked(eph, 'agent.b')).toBe(0)
    expect(asked(eph, 'agent.c')).toBe(0)
  })

  it('HOLDS an out-of-turn answer rather than losing it', async () => {
    const eph = await company()
    convene(eph)
    await answer(eph, 'agent.c', 'c answers early')

    expect(spoke(eph)).not.toContain('agent.c')
    expect(eph.meetings.current()?.held.map((turn) => turn.from)).toEqual(['agent.c'])
    // …and it did not steal the floor.
    expect(eph.meetings.current()?.floor).toBe('agent.a')
  })

  it('RELEASES held answers in attendee order when the round closes', async () => {
    const eph = await company()
    convene(eph)
    await answer(eph, 'agent.c', 'c answers early')
    await answer(eph, 'agent.b', 'b answers early')
    await answer(eph, 'agent.a', 'a answers in turn')

    expect(spoke(eph).slice(1)).toEqual(['agent.a', 'agent.b', 'agent.c'])
    expect(eph.meetings.current()?.held).toEqual([])
  })

  it('refuses somebody who is not in the meeting', async () => {
    const eph = await company()
    eph.hire('agent.stranger')
    convene(eph)
    await answer(eph, 'agent.stranger', 'may I?')

    expect(spoke(eph)).not.toContain('agent.stranger')
    expect(eph.meetings.current()?.held).toEqual([])
  })
})

describe('S-MEETING — the Architect can take the floor', () => {
  it('records the interjection and hands the floor where it names', async () => {
    const eph = await company()
    convene(eph)
    const outcome = eph.meetings.interject('Skip that — what about the deploy?', 'agent.c')

    expect(outcome.kind).toBe('accepted')
    expect(eph.meetings.current()?.floor).toBe('agent.c')
    expect(spoke(eph).at(-1)).toBe('human')
    expect(asked(eph, 'agent.c')).toBe(1)
  })

  it('leaves the floor put when it names nobody', async () => {
    const eph = await company()
    convene(eph)
    eph.meetings.interject('Carry on.')
    expect(eph.meetings.current()?.floor).toBe('agent.a')
  })
})

describe('S-MEETING — minutes and action items on close', () => {
  it('archives minutes carrying the transcript', async () => {
    const eph = await company()
    const id = convene(eph)
    await answer(eph, 'agent.a', 'the CI cache is stale')

    const closed = eph.meetings.close()
    expect(closed.ok).toBe(true)
    if (!closed.ok) return
    const md = fs.readFileSync(path.join(eph.agora.root, closed.ref), 'utf8')
    expect(md).toContain('the CI cache is stale')
    expect(md).toContain(id)
  })

  it('prints what NEVER reached the floor rather than dropping it', async () => {
    const eph = await company()
    convene(eph)
    await answer(eph, 'agent.c', 'never heard')

    const closed = eph.meetings.close()
    if (!closed.ok) throw new Error(closed.reason)
    const md = fs.readFileSync(path.join(eph.agora.root, closed.ref), 'utf8')
    expect(md).toContain('Never reached the floor')
    expect(md).toContain('never heard')
  })

  it('sends action items to the SCRIBE, and writes no task itself (FR-4.2)', async () => {
    const eph = await company()
    convene(eph)
    const before = eph.tasks.tasks().tasks.length

    eph.meetings.close([
      { title: 'Rebuild the CI cache', assignee: 'agent.a', spec: 'clear and rebuild it' }
    ])

    expect(eph.tasks.tasks().tasks).toHaveLength(before)
    const toArtemis = eph
      .inbox('agent.artemis')
      .map((name) => eph.readInbox('agent.artemis', name))
      .find((message) => message.body.includes('Rebuild the CI cache'))
    expect(toArtemis).toBeDefined()
    expect(toArtemis?.body).toContain('ledger endpoint')
  })

  it('records the close in the book of record, with what went unheard', async () => {
    const eph = await company()
    convene(eph)
    await answer(eph, 'agent.b', 'unheard')
    eph.meetings.close()

    const closed = eph.agora
      .readLogAll()
      .find((row) => row['kind'] === 'meeting' && row['event'] === 'closed')
    expect(closed).toMatchObject({ unheard: 1 })
  })
})

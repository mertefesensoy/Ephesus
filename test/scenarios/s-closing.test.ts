import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CLOSING_ACK_SUBJECT } from '../../src/main/closing'
import { CLOSING_ENDPOINT } from '../../src/shared/reserved'
import { cleanupHomes, scenarioMessage, startCompany, type Company } from './company'

/**
 * S-CLOSING (GYM-003): the orderly-quit protocol on real rails — real spawned
 * `fake-engine` processes reading a real inbox, appending a real `memory.md`,
 * and acknowledging through a real outbox the router routes to the closing
 * endpoint. The quit dialog itself is Electron chrome outside this rig; what
 * this suite proves is the protocol the dialog's "Closing time" button runs.
 */

const companies: Company[] = []
afterAll(async () => {
  for (const company of companies.splice(0)) await company.close()
  cleanupHomes()
})

async function company(closingDeadlineMs?: number): Promise<Company> {
  const started = await startCompany(closingDeadlineMs === undefined ? {} : { closingDeadlineMs })
  companies.push(started)
  return started
}

/** The pack-up script a well-behaved worker runs on the closing request. */
function packUp(agentId: string): readonly unknown[] {
  return [
    { kind: 'read-inbox', consume: true },
    {
      kind: 'append-memory',
      body: 'Parked: mid-way through the checkout fix; next step: re-run the failing test.',
      at: '2026-08-28'
    },
    {
      kind: 'write-outbox',
      message: scenarioMessage({
        from: agentId,
        to: CLOSING_ENDPOINT,
        act: 'inform',
        subject: CLOSING_ACK_SUBJECT,
        body: 'parked the checkout fix'
      })
    },
    { kind: 'exit', code: 0 }
  ]
}

describe('S-CLOSING — everyone packs up and the floor closes clean', () => {
  it('requests land, memory grows, acks resolve the protocol, all on the record', async () => {
    const eph = await company()
    eph.hire('agent.mason')
    eph.hire('agent.scribe')

    const done = eph.closing.begin()
    // One request per live agent, straight into the inbox (deliverFromHarness).
    expect(eph.inbox('agent.mason')).toHaveLength(1)
    expect(eph.inbox('agent.scribe')).toHaveLength(1)
    // Reentry is refused while the floor is packing up.
    expect(() => eph.closing.begin()).toThrow('already in progress')

    // Two REAL processes read the request, write memory, and acknowledge.
    await eph.runTurn('agent.mason', packUp('agent.mason'))
    await eph.runTurn('agent.scribe', packUp('agent.scribe'))
    await eph.hermes.sweep()

    const report = await done
    expect([...report.acked].sort()).toEqual(['agent.mason', 'agent.scribe'])
    expect(report.missing).toEqual([])
    expect(report.timedOut).toBe(false)

    // The whole point: memory.md gained the parked state BEFORE teardown.
    for (const agentId of ['agent.mason', 'agent.scribe']) {
      const memory = fs.readFileSync(path.join(eph.agora.agentDir(agentId), 'memory.md'), 'utf8')
      expect(memory).toContain('Parked: mid-way through the checkout fix')
    }

    // And the book of record can reconstruct the shutdown (NFR-13).
    const events = eph.agora
      .readLog()
      .filter((row) => row.kind === 'shutdown')
      .map((row) => row['event'])
    expect(events[0]).toBe('closing-begin')
    expect(events.filter((e) => e === 'closing-ack')).toHaveLength(2)
    expect(events.at(-1)).toBe('closing-complete')
  })
})

describe('S-CLOSING — the deadline is a hard promise, and silence is named', () => {
  it('proceeds at the deadline with the silent agent in the report and the log', async () => {
    const eph = await company(500)
    eph.hire('agent.mason')
    eph.hire('agent.tess')

    const done = eph.closing.begin()
    // Only mason packs up; tess never answers.
    await eph.runTurn('agent.mason', packUp('agent.mason'))
    await eph.hermes.sweep()

    const report = await done
    expect(report.timedOut).toBe(true)
    expect(report.acked).toEqual(['agent.mason'])
    expect(report.missing).toEqual(['agent.tess'])

    const complete = eph.agora
      .readLog()
      .filter((row) => row.kind === 'shutdown')
      .find((row) => row['event'] === 'closing-complete')
    expect(complete).toMatchObject({ missing: ['agent.tess'], timedOut: true })
  })
})

describe('S-CLOSING — an out-of-season ack bounces, never drops (FR-3.4)', () => {
  it('tells the sender nobody was packing up', async () => {
    const eph = await company()
    eph.hire('agent.mason')

    await eph.runTurn('agent.mason', [
      {
        kind: 'write-outbox',
        message: scenarioMessage({
          from: 'agent.mason',
          to: CLOSING_ENDPOINT,
          act: 'inform',
          subject: CLOSING_ACK_SUBJECT,
          body: 'parked (but nobody asked)'
        })
      },
      { kind: 'exit', code: 0 }
    ])
    await eph.hermes.sweep()

    const inbox = eph.inbox('agent.mason')
    expect(inbox).toHaveLength(1)
    const refusal = JSON.parse(
      fs.readFileSync(
        path.join(eph.hermes.mailboxDir('agent.mason'), 'inbox', inbox[0] ?? ''),
        'utf8'
      )
    ) as { act: string; body: string }
    expect(refusal.act).toBe('refuse')
    expect(refusal.body).toContain('no closing time is in progress')
  })
})

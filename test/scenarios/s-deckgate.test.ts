import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { LEDGER_ENDPOINT, LEDGER_SCHEMA_VERSION } from '../../src/shared/ledger'
import { DECK_SECTIONS, ODEON_SCHEMA_VERSION } from '../../src/shared/odeon'
import { ODEON_ENDPOINT } from '../../src/shared/reserved'
import { cleanupHomes, scenarioMessage, sendStep, startCompany, type Company } from './company'

/**
 * S-DECKGATE (TEST-STRATEGY §3, SRS §6.3): "`review:deck` task refuses `done`
 * until deck exists; deck renders in-app; comment → follow-up task."
 *
 * Run against the SHIPPED endpoint dispatch and the SHIPPED ledger endpoint, on
 * real git in a temp home. The gate is the whole claim: FR-7.2's "mechanically
 * unclosable" has to be a mechanism, not an instruction, so the suite closes the
 * task the only way anything can — by proposing it — and asserts the refusal.
 */

const companies: Company[] = []
afterAll(async () => {
  for (const company of companies.splice(0)) await company.close()
  cleanupHomes()
})

async function company(): Promise<Company> {
  const started = await startCompany()
  companies.push(started)
  started.hire('agent.artemis')
  started.hire('agent.mason')
  return started
}

function propose(eph: Company, ops: unknown[]): Promise<void> {
  eph.tasks.submit(
    scenarioMessage({
      from: 'agent.artemis',
      to: LEDGER_ENDPOINT,
      act: 'propose',
      subject: 'ledger',
      body: JSON.stringify({ schemaVersion: LEDGER_SCHEMA_VERSION, ops })
    })
  )
  return Promise.resolve()
}

function deckBody(taskId: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: ODEON_SCHEMA_VERSION,
    kind: 'deck',
    taskId,
    title: 'Checkout flakiness',
    sections: Object.fromEntries(DECK_SECTIONS.map((s) => [s, `${s} content`])),
    ...over
  })
}

/**
 * A REAL spawned `fake-engine` process writes the filing into its own outbox,
 * and the real router carries it. SDD §2 gives `odeon/` to the harness, so
 * this is the only way in that exists.
 */
async function fileDeck(eph: Company, taskId: string, from = 'agent.mason'): Promise<void> {
  await eph.runTurn(from, [
    sendStep(
      scenarioMessage({
        from,
        to: ODEON_ENDPOINT,
        act: 'propose',
        subject: 'deck',
        body: deckBody(taskId)
      })
    )
  ])
  await eph.hermes.sweep()
}

async function tryClose(eph: Company, taskId: string): Promise<void> {
  await propose(eph, [{ op: 'update', id: taskId, patch: { status: 'done' } }])
}

async function withReviewTask(eph: Company, id: string): Promise<void> {
  await propose(eph, [
    {
      op: 'create',
      task: {
        id,
        title: 'Fix the flaky checkout test',
        spec: 'Reproduce it, then fix it.',
        assignee: 'agent.mason',
        review: ['deck']
      }
    }
  ])
}

function decks(eph: Company): string[] {
  const dir = path.join(eph.agora.root, 'odeon', 'decks')
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
}

describe('S-DECKGATE — a review:deck task is mechanically unclosable', () => {
  it('REFUSES done while the deck is missing', async () => {
    const eph = await company()
    await withReviewTask(eph, 't-deckgate-01')
    await tryClose(eph, 't-deckgate-01')

    const task = eph.tasks.tasks().tasks.find((row) => row.id === 't-deckgate-01')
    expect(task?.status).not.toBe('done')
    expect(task?.artifacts.deck).toBeNull()
  })

  it('closes once the assignee files the deck from its own outbox', async () => {
    const eph = await company()
    await withReviewTask(eph, 't-deckgate-02')
    await fileDeck(eph, 't-deckgate-02')
    await tryClose(eph, 't-deckgate-02')

    const task = eph.tasks.tasks().tasks.find((row) => row.id === 't-deckgate-02')
    expect(task?.status).toBe('done')
    expect(task?.artifacts.deck).toContain('odeon/decks/')
  })

  it('archives the deck immutably — a revision is a NEW file', async () => {
    const eph = await company()
    await withReviewTask(eph, 't-deckgate-03')
    await fileDeck(eph, 't-deckgate-03')
    const first = decks(eph).find((name) => name.includes('t-deckgate-03')) ?? ''
    const bytes = fs.readFileSync(path.join(eph.agora.root, 'odeon', 'decks', first))

    await new Promise((resolve) => setTimeout(resolve, 5))
    await fileDeck(eph, 't-deckgate-03')

    const now = decks(eph).filter((name) => name.includes('t-deckgate-03'))
    expect(now).toHaveLength(2)
    expect(fs.readFileSync(path.join(eph.agora.root, 'odeon', 'decks', first))).toEqual(bytes)
  })

  it('refuses a deck from somebody the task was not assigned to', async () => {
    const eph = await company()
    eph.hire('agent.scribe')
    await withReviewTask(eph, 't-deckgate-04')
    await fileDeck(eph, 't-deckgate-04', 'agent.scribe')

    expect(decks(eph).filter((name) => name.includes('t-deckgate-04'))).toEqual([])
  })

  it('renders the deck for the viewer, from the archive and nowhere else', async () => {
    const eph = await company()
    await withReviewTask(eph, 't-deckgate-05')
    await fileDeck(eph, 't-deckgate-05')

    const record = eph.odeon.decks().find((deck) => deck.taskId === 't-deckgate-05')
    expect(record).toBeDefined()
    expect(eph.odeon.read(record?.ref ?? '')).toContain('Checkout flakiness')
    // A ref the renderer could invent resolves to nothing.
    expect(eph.odeon.read('../../config.json')).toBeNull()
  })

  it('sends an Architect comment to the orchestrator, and mints NO task itself', async () => {
    // UC-05 step 4. FR-4.2 gives the ledger one scribe.
    const eph = await company()
    await withReviewTask(eph, 't-deckgate-06')
    await fileDeck(eph, 't-deckgate-06')
    const ref = eph.odeon.decks().find((deck) => deck.taskId === 't-deckgate-06')?.ref ?? ''
    const before = eph.tasks.tasks().tasks.length

    const outcome = eph.odeon.comment(ref, 'The trade-offs need a cost paragraph.', 'agent.artemis')

    expect(outcome.queued).toBe(true)
    if (outcome.queued) expect(outcome.to).toBe('agent.artemis')
    expect(outcome.message?.body).toContain('cost paragraph')
    expect(eph.tasks.tasks().tasks).toHaveLength(before)
  })

  it('records the whole gate in the book of record (NFR-13)', async () => {
    const eph = await company()
    await withReviewTask(eph, 't-deckgate-07')
    await fileDeck(eph, 't-deckgate-07')

    const archived = eph.agora
      .readLog()
      .find((row) => row['kind'] === 'deck' && row['event'] === 'archived')
    expect(archived).toMatchObject({ taskId: 't-deckgate-07', by: 'agent.mason' })
  })
})

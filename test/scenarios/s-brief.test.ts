import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { BRIEF_MAX_SECONDS, BRIEF_SCHEMA_VERSION, spokenSeconds } from '../../src/shared/brief'
import { LEDGER_ENDPOINT, LEDGER_SCHEMA_VERSION } from '../../src/shared/ledger'
import { ODEON_ENDPOINT } from '../../src/shared/reserved'
import { cleanupHomes, scenarioMessage, sendStep, startCompany, type Company } from './company'

/**
 * S-BRIEF (TEST-STRATEGY §3, SRS §6.2): "seeded ledger/log/budget fixtures →
 * compiled brief; assert every narrative sentence carries source refs and refs
 * resolve; ≤ 90 s at configured wpm."
 *
 * The suite narrates through the SHIPPED endpoint, from a REAL spawned agent's
 * outbox, so what is asserted is the path the running app takes.
 */

const companies: Company[] = []
afterAll(async () => {
  for (const company of companies.splice(0)) await company.close()
  cleanupHomes()
})

/** A company with a seeded window: one completed task and one open gate. */
async function seeded(): Promise<Company> {
  const eph = await startCompany()
  companies.push(eph)
  eph.hire('agent.artemis')
  eph.hire('agent.mason')

  eph.tasks.submit(
    scenarioMessage({
      from: 'agent.artemis',
      to: LEDGER_ENDPOINT,
      act: 'propose',
      subject: 'ledger',
      body: JSON.stringify({
        schemaVersion: LEDGER_SCHEMA_VERSION,
        ops: [
          {
            op: 'create',
            task: {
              id: 't-brief-01',
              title: 'Fix the flaky checkout test',
              spec: 'Reproduce it, then fix it.',
              assignee: 'agent.mason'
            }
          }
        ]
      })
    })
  )
  // A real tool call the policy holds, so the window has something blocked.
  await eph.runTurn('agent.mason', [
    { kind: 'hook', event: 'pre-tool', payload: { tool: 'Edit', path: 'package.json' } },
    { kind: 'exit', code: 0 }
  ])
  return eph
}

async function narrate(
  eph: Company,
  briefId: string,
  sentences: readonly { section: string; text: string; refs: readonly string[] }[]
): Promise<void> {
  await eph.runTurn('agent.artemis', [
    sendStep(
      scenarioMessage({
        from: 'agent.artemis',
        to: ODEON_ENDPOINT,
        act: 'propose',
        subject: 'brief',
        body: JSON.stringify({
          schemaVersion: BRIEF_SCHEMA_VERSION,
          kind: 'brief',
          briefId,
          sentences
        })
      })
    )
  ])
  await eph.hermes.sweep()
}

function briefs(eph: Company): string[] {
  const dir = path.join(eph.agora.root, 'odeon', 'briefs')
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
}

describe('S-BRIEF — the compiler assembles facts, and only facts', () => {
  it('compiles a window whose every fact carries refs', async () => {
    const eph = await seeded()
    const facts = eph.briefing.request()

    expect(facts).not.toBeNull()
    expect(facts?.length).toBeGreaterThan(0)
    for (const fact of facts ?? []) {
      expect(fact.refs.length, fact.what).toBeGreaterThan(0)
    }
  })

  it('asks the orchestrator to narrate, and hands her the facts', async () => {
    const eph = await seeded()
    eph.briefing.request()
    const asked = eph.inbox('agent.artemis').map((name) => eph.readInbox('agent.artemis', name))
    const ask = asked.find((message) => message.from === ODEON_ENDPOINT)
    expect(ask?.act).toBe('request')
    expect(ask?.body).toContain('task:t-brief-01')
  })
})

describe('S-BRIEF — a sentence the Architect cannot check is refused', () => {
  it('REFUSES a narration citing a fact nobody issued, and archives nothing', async () => {
    const eph = await seeded()
    eph.briefing.request()
    const briefId = eph.briefing.pending() ?? ''

    await narrate(eph, briefId, [
      { section: 'headline', text: 'Everything shipped.', refs: ['task:t-invented'] }
    ])

    expect(briefs(eph)).toEqual([])
  })

  it('archives a narration whose every sentence resolves', async () => {
    const eph = await seeded()
    const facts = eph.briefing.request() ?? []
    const briefId = eph.briefing.pending() ?? ''

    await narrate(
      eph,
      briefId,
      facts.slice(0, 3).map((fact, index) => ({
        section: index === 0 ? 'headline' : fact.section,
        text: `Fact ${String(index + 1)} as narrated.`,
        refs: fact.refs.slice(0, 1)
      }))
    )

    expect(briefs(eph)).toHaveLength(1)
    const md = fs.readFileSync(
      path.join(eph.agora.root, 'odeon', 'briefs', briefs(eph)[0] ?? ''),
      'utf8'
    )
    // Every narrated line carries its refs inline, and the appendix backs them.
    expect(md).toMatch(/\[[^\]]+\]$/m)
    expect(md).toContain('## Source refs')
  })

  it('lets the SAME window be re-narrated after a refusal', async () => {
    // A refusal that closed the question would make the reasons useless.
    const eph = await seeded()
    const facts = eph.briefing.request() ?? []
    const briefId = eph.briefing.pending() ?? ''

    await narrate(eph, briefId, [
      { section: 'headline', text: 'Invented.', refs: ['task:t-invented'] }
    ])
    expect(briefs(eph)).toEqual([])

    await narrate(eph, briefId, [
      {
        section: 'headline',
        text: 'Supported.',
        refs: (facts[0]?.refs[0] ?? '') ? [facts[0]?.refs[0] ?? ''] : []
      }
    ])
    expect(briefs(eph)).toHaveLength(1)
  })
})

describe('S-BRIEF — the spoken budget (SRS §6.2)', () => {
  it('refuses a narration over 90 seconds at the configured wpm', async () => {
    const eph = await seeded()
    const facts = eph.briefing.request() ?? []
    const briefId = eph.briefing.pending() ?? ''
    const long = Array.from({ length: 400 }, () => 'word').join(' ')

    expect(spokenSeconds(long)).toBeGreaterThan(BRIEF_MAX_SECONDS)
    await narrate(eph, briefId, [
      { section: 'headline', text: long, refs: [facts[0]?.refs[0] ?? ''] }
    ])
    expect(briefs(eph)).toEqual([])
  })

  it('archives one inside the budget', async () => {
    const eph = await seeded()
    const facts = eph.briefing.request() ?? []
    const briefId = eph.briefing.pending() ?? ''

    await narrate(eph, briefId, [
      { section: 'headline', text: 'One action waits on you.', refs: [facts[0]?.refs[0] ?? ''] }
    ])
    expect(briefs(eph)).toHaveLength(1)
  })
})

/**
 * The seam the M5 exit demo found: `computeMetrics` counted a completed task by
 * matching `{kind:'task', event:'update', status:'done'}`, and the production
 * ledger endpoint wrote no `status` at all. Every unit test passed, because
 * every unit test synthesised the row it wanted.
 *
 * This asserts the metric against a log the REAL endpoint produced — which is
 * the only version of the claim worth making.
 */
describe('org metrics count from the log the endpoint really writes (regression)', () => {
  it('counts a completed task from production log rows, not from a fixture', async () => {
    const eph = await seeded()
    eph.tasks.submit(
      scenarioMessage({
        from: 'agent.artemis',
        to: LEDGER_ENDPOINT,
        act: 'propose',
        subject: 'ledger',
        body: JSON.stringify({
          schemaVersion: LEDGER_SCHEMA_VERSION,
          ops: [{ op: 'update', id: 't-brief-01', patch: { status: 'done' } }]
        })
      })
    )

    // The row the endpoint wrote must carry the status the metric reads.
    const row = eph.agora
      .readLogAll()
      .filter((entry) => entry['kind'] === 'task' && entry['event'] === 'update')
      .at(-1)
    expect(row).toMatchObject({ status: 'done', assignee: 'agent.mason' })

    const metrics = eph.org.report().metrics.find((m) => m.agentId === 'agent.mason')
    expect(metrics?.tasksDone).toBe(1)
  })
})

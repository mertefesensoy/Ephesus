import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { cleanupHomes, scenarioMessage, sendStep, startCompany, type Company } from './company'
import { HARBOR_ENDPOINT } from '../../src/shared/reserved'
import { TRIAGE_SUBJECT } from '../../src/main/incidents'
import { compileFacts } from '../../src/shared/brief'
import { composeMessage, makeMessageId } from '../../src/shared/message'
import { renderScorecard, scoreEPlaybook, type DrillRecord } from '../evals/e-playbook'
import type { InboundItem } from '../../src/shared/harbor'

/**
 * The COMMITTED generator for M7's demo evidence (M7.7).
 *
 * M6's close-out recorded a standing gap: the generator for `docs/demo/*.svg`
 * was a scratch file, so the artifacts were honest but unreproducible from the
 * repository and a refactor would have orphaned them silently. This is the
 * answer for M7's evidence — the generator IS a test, so `npm test` reproduces
 * every artifact, and a change that breaks the chain breaks the suite rather
 * than quietly rotting a file nobody re-runs.
 *
 * It writes two files:
 *
 *  - `docs/demo/m7-onehour-chain.txt` — the SRS §6.1 chain as it actually ran,
 *    step by step, over shipped components with a fake engine and a scripted
 *    `gh`. **Not the acceptance criterion**; the header says so, in the file.
 *  - `docs/demo/m7-eplaybook-scorecard.md` — E-PLAYBOOK's drill, scored.
 */

const DEMO = path.join(__dirname, '..', '..', 'docs', 'demo')
const ONCALL = 'agent.mason'
const companies: Company[] = []

/**
 * The two ids in the transcript a re-run cannot reproduce, and their shapes.
 *
 * A mail id is stamped from the wall clock (`IncidentEndpoint.send`), and a task
 * id carries three random bytes ON PURPOSE — `LedgerEndpoint.mintId` explains
 * why a counter would be wrong, since two proposals in flight would mint the
 * same id. Neither is a defect to fix upstream.
 *
 * Printing them raw is what made this COMMITTED artifact rewrite itself on every
 * `npm test`, so the file looked freshly changed on every branch and a real
 * regeneration was indistinguishable from clock noise. The generator now checks
 * each id against the shape below and prints a stable rendering — which is
 * strictly more than printing the digits did, because nothing verified them.
 * Neither id is referenced anywhere else in the transcript, so the digits were
 * load-bearing for no reader of it.
 */
const MAIL_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-inc33p$/
const TASK_ID = /^t-\d{4}-\d{2}-\d{2}-[0-9a-f]{6}[0-9a-z]$/

afterEach(async () => {
  for (const company of companies.splice(0)) await company.close()
})

afterAll(() => {
  cleanupHomes()
})

function failedRun(): InboundItem {
  return {
    repo: 'owner/app',
    kind: 'ci-run',
    ref: 4021,
    title: 'build and test',
    state: 'completed',
    conclusion: 'failure',
    url: 'https://github.com/owner/app/actions/runs/4021',
    at: '2026-08-31T09:00:00.000Z',
    author: null,
    labels: [],
    draft: false
  }
}

describe('M7 evidence (committed generator)', () => {
  it('writes the SRS §6.1 chain transcript', async () => {
    const eph = await startCompany()
    companies.push(eph)
    eph.hire('agent.artemis')
    eph.hire(ONCALL)
    eph.agora.writeRegistry({ ...eph.agora.registry(), orchestratorId: 'agent.artemis' })
    eph.incidentBindings.push({
      instanceId: 'skeleton-crew:repo:myapp',
      agentId: ONCALL,
      playbook: 'incident.md',
      repos: ['owner/app']
    })

    const lines: string[] = []
    const step = (n: string, what: string): void => {
      lines.push(`[${n}] ${what}`)
    }

    step('1', `CI reports run #4021 on owner/app: failure`)
    const raised = eph.incidents.raise([failedRun()])
    expect(raised[0]?.msgId ?? '').toMatch(MAIL_ID)
    step('2', `incident raised: ${raised[0]?.incident.key ?? '?'} → mail <stamped>-inc33p`)
    step('2a', `tasks.json is UNCHANGED (${String(eph.tasks.tasks().tasks.length)} tasks) — FR-5.2`)

    const request = eph.readInbox('agent.artemis', eph.inbox('agent.artemis')[0] as string)
    step('3', `Artemis received a "${request.act}" from ${request.from}`)

    eph.tasks.submit(
      composeMessage({
        id: makeMessageId(new Date('2026-08-31T09:01:00.000Z'), 'prop1'),
        conversation: 'c-evidence',
        in_reply_to: null,
        from: 'agent.artemis',
        to: 'agent.ledger',
        act: 'propose',
        subject: 'triage',
        body: JSON.stringify({
          schemaVersion: 1,
          ops: [
            {
              op: 'create',
              task: {
                title: 'Triage failed CI run #4021 on owner/app',
                spec: 'Follow playbooks/incident.md.',
                assignee: ONCALL
              }
            }
          ]
        }),
        hops: 0,
        created_at: '2026-08-31T09:01:00.000Z'
      })
    )
    const task = eph.tasks.tasks().tasks[0]
    expect(task?.id ?? '').toMatch(TASK_ID)
    step('4', `Artemis proposed; task t-<day>-<minted> assigned to ${task?.assignee ?? '?'}`)

    await eph.runTurn(ONCALL, [
      sendStep(
        scenarioMessage({
          from: ONCALL,
          to: HARBOR_ENDPOINT,
          act: 'inform',
          subject: TRIAGE_SUBJECT,
          body: JSON.stringify({
            schemaVersion: 1,
            kind: 'triage',
            incident: 'owner/app#ci-run:4021',
            severity: 1,
            resolved: false,
            summary: 'the login service returns 500 for every request since the deploy'
          }),
          conversation: request.conversation,
          in_reply_to: request.id,
          hops: 1
        })
      )
    ])
    await eph.hermes.sweep()
    step('5', `on-call agent filed a triage report from its own outbox (severity 1, unresolved)`)
    step('6', `escalated now: ${eph.escalatedNow.join(', ') || 'none'}`)
    step('6a', `gates open: ${String(eph.gates.list().length)}`)
    step('7', `obligation unmet: ${eph.unmetObligations[0] ?? 'none'}`)

    const facts = compileFacts({
      events: eph.agora.readLog(0, 500),
      ledger: eph.tasks.tasks(),
      openGates: eph.gates.list().map((gate) => ({ id: gate.id, agentId: gate.agentId })),
      openMemos: [],
      spend: []
    })
    step('8', 'the next briefing narrates, from the log:')
    for (const entry of facts.filter((f) => f.what.includes('incident owner/app'))) {
      lines.push(`      · ${entry.what}   [${entry.refs.join(', ')}]`)
    }

    const body = [
      'SRS §6.1 — the one-hour company test: THE CHAIN',
      '',
      'Generated by test/scenarios/m7-evidence.test.ts. Re-run with `npm test`.',
      '',
      'WHAT THIS IS: every arrow between "CI went red" and "the standup says so",',
      'walked over the SHIPPED components — real git in a temp home, the real',
      'IncidentEndpoint, Hermes router, LedgerEndpoint, GateManager and briefing',
      'compiler. The `gh` process and the ENGINE are replaced at their seams',
      '(TEST-STRATEGY §1); a scripted fake-engine stands where a real `claude`',
      'would deliberate.',
      '',
      'WHAT THIS IS NOT: the acceptance criterion. SRS §6.1 asks whether a REAL',
      'agent, given a REAL broken test in a REAL repository, actually triages it',
      'correctly and opens a sound fix PR. That is judgment, and no fake engine',
      'stands in for it. The judgment half is OWED and recorded in docs/PROGRESS.md.',
      '',
      'TWO IDS BELOW ARE NORMALISED. A mail id is wall-clock stamped and a task id',
      'carries three random bytes by design, so printing them raw rewrote this',
      'committed file on every run. Each is checked against its documented shape',
      'and then printed <in angle brackets>; neither is referenced anywhere else.',
      '',
      ...lines,
      ''
    ].join('\n')

    // The artifact is evidence only if it says what actually happened.
    expect(body).toContain('tasks.json is UNCHANGED')
    expect(body).toContain('triaged severity-1')
    expect(body).toContain('WHAT THIS IS NOT')

    // And it is COMMITTED, so a run that changed nothing must produce the same
    // bytes. A future step that prints a fresh id fails HERE, where the reason
    // is written down, instead of surfacing as a phantom diff in someone's
    // `git status` on an unrelated branch — which is how this was found.
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/)
    expect(body).not.toMatch(/t-\d{4}-\d{2}-\d{2}-[0-9a-f]{6}/)

    // Written last: a run that fails its own checks above leaves the previous
    // artifact standing rather than replacing it with something unverified.
    fs.mkdirSync(DEMO, { recursive: true })
    fs.writeFileSync(path.join(DEMO, 'm7-onehour-chain.txt'), body)
  })

  it('writes the E-PLAYBOOK drill scorecard', () => {
    // The drill as `playbooks/incident.md` says to run it: triage, reproduce,
    // gated fix, report. Scored by the shipped scorer, not by hand.
    const drill: DrillRecord = {
      raisedAtMs: 0,
      triagedAtMs: 247_000,
      report: {
        schemaVersion: 1,
        kind: 'triage',
        incident: 'owner/app#ci-run:4021',
        severity: 1,
        resolved: false,
        summary: 'the login service returns 500 for every request since the deploy'
      },
      actions: [
        { kind: 'read', detail: 'the failing run log', gated: false },
        { kind: 'reproduce', detail: 'locally against the deployed commit', gated: false },
        { kind: 'revert', detail: 'the offending deploy', gated: true },
        { kind: 'open-pr', detail: 'the revert, for review', gated: true }
      ]
    }
    const score = scoreEPlaybook(drill)
    const card = [
      renderScorecard(score),
      '## Provenance',
      '',
      'Generated by `test/scenarios/m7-evidence.test.ts`; re-run with `npm test`.',
      'The drill record above is a FIXTURE, not a live agent run — E-PLAYBOOK is a',
      'weekly/pre-release eval against real engines (TEST-STRATEGY §6), and this',
      'records the scorer working end to end on a well-run drill. The live run is',
      'owed with the rest of SRS §6.1.',
      ''
    ].join('\n')

    fs.mkdirSync(DEMO, { recursive: true })
    fs.writeFileSync(path.join(DEMO, 'm7-eplaybook-scorecard.md'), card)

    expect(score.passed).toBe(true)
    expect(score.timeToTriageMs).toBe(247_000)
    expect(card).toContain('FIXTURE, not a live agent run')
  })
})

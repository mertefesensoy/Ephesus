import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { cleanupHomes, scenarioMessage, sendStep, startCompany, type Company } from './company'
import { ProfileStore } from '../../src/main/profiles'
import { activationPlan } from '../../src/shared/profile-activation'
import { AUTONOMY_LEVELS, type AutonomyLevel } from '../../src/shared/gates'
import { HARBOR_ENDPOINT } from '../../src/shared/reserved'
import { composeMessage, makeMessageId, type Message } from '../../src/shared/message'
import { TRIAGE_SUBJECT } from '../../src/main/incidents'
import type { InboundItem } from '../../src/shared/harbor'

/**
 * **S-PROFILE** (TEST-STRATEGY §3): "activate Skeleton Crew on a fixture repo;
 * fake CI webhook → triage task auto-created → playbook path; assert
 * stricter-wins autonomy composition."
 *
 * Run over the real rails of `startCompany`: real git in a temp home, the
 * SHIPPED `IncidentEndpoint`, the SHIPPED `Hermes` router, the SHIPPED
 * `LedgerEndpoint`. The `gh` process is the only thing replaced, by handing the
 * endpoint the items a recorded response would have parsed into — TEST-STRATEGY
 * §1's "determinize the boundary, not the world".
 *
 * The claim this suite exists to defend is the one a unit test cannot reach:
 * **a CI failure becomes a task in `tasks.json` without the harness ever
 * writing `tasks.json`.** The chain is
 *
 *   ingested item → IncidentEndpoint.raise → mail to Artemis
 *     → Artemis proposes → Hermes routes → LedgerEndpoint.submit → tasks.json
 *
 * and every arrow is a shipped component. If any one of them were stubbed, the
 * suite would prove nothing about the system that ships.
 */

const REPO_ROOT = path.join(__dirname, '..', '..')

const companies: Company[] = []

afterEach(async () => {
  for (const company of companies.splice(0)) await company.close()
})

afterAll(() => {
  cleanupHomes()
})

async function company(): Promise<Company> {
  const started = await startCompany()
  companies.push(started)
  return started
}

function failedRun(overrides: Partial<InboundItem> = {}): InboundItem {
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
    draft: false,
    ...overrides
  }
}

/** The Skeleton Crew as shipped, loaded through the real store. */
function skeletonCrew() {
  const store = new ProfileStore(
    path.join(REPO_ROOT, 'test', '.no-such-home'),
    path.join(REPO_ROOT, 'profiles')
  )
  const loaded = store.load('skeleton-crew')
  if (!loaded.ok) throw new Error(`skeleton-crew did not load: ${loaded.reasons.join('; ')}`)
  return loaded.bundle
}

describe('S-PROFILE — Skeleton Crew on a fixture repo', () => {
  it('activates on a repo target and plans the crew FR-9.2 names', () => {
    const bundle = skeletonCrew()
    const planned = activationPlan(
      bundle,
      { kind: 'repo', id: 'myapp', path: REPO_ROOT },
      'autonomous'
    )
    if (!planned.ok) throw new Error(planned.reasons.join('; '))

    expect(planned.plan.hires.map((hire) => hire.hire).sort()).toEqual([
      'ci-babysitter',
      'dependency-updater',
      'health-watcher',
      // Not a component FR-9.2 names. The fourth hire is the profile format
      // being exercised rather than extended: a hire file with its own budget,
      // no schema field, no private API — which is ADR-0012's dogfood claim
      // being true rather than asserted.
      'verifier'
    ])
    // The disclosure the Architect reads before activating: what it may hold.
    expect(planned.plan.envGrants).toEqual(['GH_TOKEN'])
    expect(planned.plan.playbooks).toContain('incident.md')
  })

  it('asserts stricter-wins composition against a laxer global ceiling', () => {
    const bundle = skeletonCrew()
    // The global policy is the MOST permissive setting there is, so any row
    // that comes back below `autonomous` came from the bundle asking for it and
    // winning: composition takes the stricter side, and the bundle asked for
    // the stricter side.
    const planned = activationPlan(
      bundle,
      { kind: 'repo', id: 'myapp', path: REPO_ROOT },
      'autonomous'
    )
    if (!planned.ok) throw new Error(planned.reasons.join('; '))
    const byKind = Object.fromEntries(planned.plan.autonomy.map((row) => [row.kind, row.effective]))
    // The value moved on 2026-09-01 (skeleton-crew's irreversible classes went
    // manual -> supervised); what this case proves did not. A laxer global does
    // not widen the profile: `autonomous` above `supervised` still yields
    // `supervised`, which is the direction stricter-wins exists to hold.
    expect(byKind.destructive).toBe('supervised')
    expect(byKind['prod-facing']).toBe('supervised')

    // And the other direction, which is the one a bug would take: a STRICTER
    // global clamps every kind down to `manual`, the profile's own `autonomous`
    // default included — the widest thing the bundle now asks for, and so the
    // row that would fail loudest if composition ever widened.
    const clamped = activationPlan(bundle, { kind: 'repo', id: 'myapp', path: REPO_ROOT }, 'manual')
    if (!clamped.ok) throw new Error(clamped.reasons.join('; '))
    for (const row of clamped.plan.autonomy) {
      expect(row.effective).toBe('manual')
    }
  })

  it('never lets the profile widen past the global ceiling, at any rung', () => {
    const bundle = skeletonCrew()
    const rank = { manual: 0, supervised: 1, autonomous: 2 } as const
    for (const global of AUTONOMY_LEVELS) {
      const planned = activationPlan(
        bundle,
        { kind: 'repo', id: 'myapp', path: REPO_ROOT },
        global as AutonomyLevel
      )
      if (!planned.ok) throw new Error(planned.reasons.join('; '))
      for (const row of planned.plan.autonomy) {
        expect(rank[row.effective]).toBeLessThanOrEqual(rank[global as AutonomyLevel])
      }
    }
  })
})

describe('S-PROFILE — a CI failure becomes a triage task, through Artemis', () => {
  const ONCALL = 'agent.mason'

  async function onCallCompany(): Promise<Company> {
    const co = await company()
    co.hire('agent.artemis')
    co.hire(ONCALL)
    // Artemis must be the roster's orchestrator for the router to accept her
    // ledger proposals (FR-5.2 — the writer check is a transport rule).
    const registry = co.agora.registry()
    co.agora.writeRegistry({ ...registry, orchestratorId: 'agent.artemis' })
    co.incidentBindings.push({
      instanceId: 'skeleton-crew:repo:myapp',
      agentId: ONCALL,
      playbook: 'incident.md',
      repos: ['owner/app']
    })
    return co
  }

  it('raises the incident as mail to Artemis, not as a ledger write', async () => {
    const co = await onCallCompany()
    const before = co.tasks.tasks().tasks.length

    const raised = co.incidents.raise([failedRun()])
    expect(raised).toHaveLength(1)

    // Nothing was written to the ledger by the harness — FR-5.2's single
    // scribe. The task does not exist yet, and that is correct.
    expect(co.tasks.tasks().tasks).toHaveLength(before)

    // Artemis has the request in her inbox.
    const names = co.inbox('agent.artemis')
    expect(names).toHaveLength(1)
    const request = co.readInbox('agent.artemis', names[0] as string)
    expect(request.from).toBe(HARBOR_ENDPOINT)
    expect(request.act).toBe('request')
    expect(request.body).toContain('owner/app')
    expect(request.body).toContain('4021')
    // The runbook is named, never inlined — the harness does not read playbooks.
    expect(request.body).toContain('incident.md')
  })

  it('completes the chain: Artemis proposes, and the task lands assigned', async () => {
    const co = await onCallCompany()
    co.incidents.raise([failedRun()])

    // Artemis does what UC-09 step 2 says she does, through the ordinary
    // ledger endpoint — a `propose` from her outbox, routed by the shipped
    // Hermes. Nothing in this test writes `tasks.json`.
    const proposal = composeMessage({
      id: makeMessageId(new Date('2026-08-31T09:01:00.000Z'), 'prop1'),
      conversation: 'c-incident-4021',
      in_reply_to: null,
      from: 'agent.artemis',
      to: 'agent.ledger',
      act: 'propose',
      subject: 'triage the failed CI run',
      body: JSON.stringify({
        schemaVersion: 1,
        ops: [
          {
            op: 'create',
            task: {
              title: 'Triage failed CI run #4021 on owner/app',
              spec: 'Follow playbooks/incident.md: triage, reproduce, attempt the playbook fix, report severity to agent.harbor.',
              assignee: ONCALL
            }
          }
        ]
      }),
      hops: 0,
      created_at: '2026-08-31T09:01:00.000Z'
    })

    const outcome = co.tasks.submit(proposal)
    expect(outcome.ok).toBe(true)

    const tasks = co.tasks.tasks().tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.assignee).toBe(ONCALL)
    expect(tasks[0]?.status).toBe('todo')
    expect(tasks[0]?.title).toContain('4021')
  })

  it('raises once however often the same red run is ingested', async () => {
    const co = await onCallCompany()
    // The Harbor rebuilds its queues every ingestion; without the cursor the
    // crew would be woken for one failure forever.
    co.incidents.raise([failedRun()])
    co.incidents.raise([failedRun()])
    co.incidents.raise([failedRun()])
    expect(co.inbox('agent.artemis')).toHaveLength(1)
  })

  it('drops an item for a repository no live instance watches, and says so', async () => {
    const co = await onCallCompany()
    co.incidents.raise([failedRun({ repo: 'stranger/repo' })])
    expect(co.inbox('agent.artemis')).toHaveLength(0)

    const log = fs.readFileSync(path.join(co.agora.root, 'log.jsonl'), 'utf8')
    expect(log).toContain('incident-unclaimed')
  })
})

describe('S-PROFILE — the playbook path back', () => {
  const ONCALL = 'agent.mason'

  async function raised(): Promise<{ co: Company; request: Message }> {
    const co = await company()
    co.hire('agent.artemis')
    co.hire(ONCALL)
    const registry = co.agora.registry()
    co.agora.writeRegistry({ ...registry, orchestratorId: 'agent.artemis' })
    co.incidentBindings.push({
      instanceId: 'skeleton-crew:repo:myapp',
      agentId: ONCALL,
      playbook: 'incident.md',
      repos: ['owner/app']
    })
    co.incidents.raise([failedRun()])
    const names = co.inbox('agent.artemis')
    return { co, request: co.readInbox('agent.artemis', names[0] as string) }
  }

  /**
   * Files a triage report the way an on-call agent actually files one: a REAL
   * spawned `fake-engine` writes it into its own outbox, and the SHIPPED Hermes
   * sweeps it.
   *
   * This matters more than it looks. Handing the message to `onTriage` — or
   * even to `deliverFromHarness` — would skip both of the edits that make the
   * reply reachable at all: the `HARBOR_ENDPOINT` branch in `routeMessage`, and
   * the `submitToHarbor` arm in Hermes's endpoint dispatch. Without that branch
   * the message falls through to the terminal `else` and is submitted to the
   * LEDGER, which answers a correctly-filed report with a ledger refusal and
   * never warns anybody. Only a test that sweeps a real outbox can see that.
   */
  async function report(
    co: Company,
    request: Message,
    body: Record<string, unknown>
  ): Promise<void> {
    await co.runTurn(ONCALL, [
      sendStep(
        scenarioMessage({
          from: ONCALL,
          to: HARBOR_ENDPOINT,
          act: 'inform',
          subject: TRIAGE_SUBJECT,
          body: JSON.stringify(body),
          conversation: request.conversation,
          in_reply_to: request.id,
          hops: 1
        })
      )
    ])
    await co.hermes.sweep()
  }

  const BASE = {
    schemaVersion: 1,
    kind: 'triage',
    incident: 'owner/app#ci-run:4021',
    resolved: false,
    summary: 'the login service returns 500 for every request since the deploy'
  }

  it('a severity-1 escalates now and records the announcement it cannot make', async () => {
    const { co, request } = await raised()
    await report(co, request, { ...BASE, severity: 1 })

    // Asserted on the OBSERVABLE effects, because the sweep — not this test —
    // called the endpoint. That is the point: the router really did carry it.
    expect(co.escalatedNow).toEqual(['owner/app#ci-run:4021'])

    // UC-09 step 4's spoken half. The Herald is built and unwired (M6.9,
    // deferred indefinitely), so the obligation is RECORDED as owed and
    // reported, and is not quietly satisfied by the gate that just opened.
    expect(co.unmetObligations).toHaveLength(1)
    expect(co.unmetObligations[0]).toMatch(/Herald is not wired/)
    const log = fs.readFileSync(path.join(co.agora.root, 'log.jsonl'), 'utf8')
    expect(log).toContain('incident-announce-owed')

    // The Architect's queue actually has something in it.
    expect(co.gates.list().length).toBeGreaterThan(0)
  })

  it('a severity-2 rides the standup and owes no announcement', async () => {
    const { co, request } = await raised()
    await report(co, request, { ...BASE, severity: 2, resolved: true })

    const log = fs.readFileSync(path.join(co.agora.root, 'log.jsonl'), 'utf8')
    expect(log).toContain('incident-triaged')
    expect(co.escalatedNow).toEqual([])
    expect(co.unmetObligations).toEqual([])
    expect(log).not.toContain('incident-announce-owed')
  })

  it('records the agent’s own summary in the log, verbatim', async () => {
    const { co, request } = await raised()
    await report(co, request, { ...BASE, severity: 2 })

    const log = fs.readFileSync(path.join(co.agora.root, 'log.jsonl'), 'utf8')
    // The brief will cite this entry (UC-09 step 3). A rewritten sentence would
    // be a claim nobody made — E-BRIEF-FAITH's rule, at the incident's end.
    expect(log).toContain('the login service returns 500 for every request since the deploy')
  })
})

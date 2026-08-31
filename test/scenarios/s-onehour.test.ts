import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { cleanupHomes, scenarioMessage, sendStep, startCompany, type Company } from './company'
import { HARBOR_ENDPOINT } from '../../src/shared/reserved'
import { TRIAGE_SUBJECT } from '../../src/main/incidents'
import { compileFacts } from '../../src/shared/brief'
import { composeMessage, makeMessageId, type Message } from '../../src/shared/message'
import type { InboundItem } from '../../src/shared/harbor'

/**
 * **The one-hour company test's CHAIN** (SRS §6.1) — M7.7.
 *
 * SRS §6.1 is an acceptance criterion, not a suite: *"The Architect activates
 * Skeleton Crew on a real repo, breaks a test on a branch, and walks away.
 * Within the hour: the crew has detected the failure, fixed it or opened a fix
 * PR, filed the required memo if the fix crossed policy, and the next briefing
 * narrates the incident accurately from the log — with zero un-gated
 * destructive actions."*
 *
 * ## What this suite is, and what it is NOT
 *
 * It walks that chain end to end over the SHIPPED components: real git in a
 * temp home, the real `IncidentEndpoint`, the real Hermes router, the real
 * `LedgerEndpoint`, the real `GateManager`, the real briefing compiler. Two
 * things are replaced at their seams, per TEST-STRATEGY §1 ("determinize the
 * boundary, not the world"): the `gh` process, and the ENGINE — a scripted
 * `fake-engine` stands where a real `claude` would deliberate.
 *
 * **It is therefore not the acceptance criterion.** §6.1 asks whether a real
 * agent, given a real broken test, actually triages it correctly — that is
 * judgment, and no fake engine can stand in for it. What this proves is the
 * harness: that every arrow between "CI went red" and "the standup says so"
 * exists, is wired, and carries the truth. The judgment half is recorded as
 * owed in `docs/PROGRESS.md`, and this suite is what makes the owed part small
 * and specific rather than "does M7 work".
 *
 * It found one real defect on its first run: the briefing compiler had no
 * incident branch at all, so §6.1's last clause was unreachable — see the
 * `narrates` block below.
 */

const companies: Company[] = []
const ONCALL = 'agent.mason'
const INSTANCE = 'skeleton-crew:repo:myapp'

afterEach(async () => {
  for (const company of companies.splice(0)) await company.close()
})

afterAll(() => {
  cleanupHomes()
})

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

/** A company with the Skeleton Crew on call for `owner/app`. */
async function onCall(): Promise<Company> {
  const eph = await startCompany()
  companies.push(eph)
  eph.hire('agent.artemis')
  eph.hire(ONCALL)
  eph.agora.writeRegistry({ ...eph.agora.registry(), orchestratorId: 'agent.artemis' })
  eph.incidentBindings.push({
    instanceId: INSTANCE,
    agentId: ONCALL,
    playbook: 'incident.md',
    repos: ['owner/app']
  })
  return eph
}

/** Artemis proposes the triage task, through the ordinary ledger endpoint. */
function proposeTriage(eph: Company): void {
  const proposal = composeMessage({
    id: makeMessageId(new Date('2026-08-31T09:01:00.000Z'), 'prop1'),
    conversation: 'c-onehour',
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
            spec: 'Follow playbooks/incident.md; report severity to agent.harbor.',
            assignee: ONCALL
          }
        }
      ]
    }),
    hops: 0,
    created_at: '2026-08-31T09:01:00.000Z'
  })
  const outcome = eph.tasks.submit(proposal)
  expect(outcome.ok).toBe(true)
}

/** The on-call agent files its triage from its own outbox, through the router. */
async function fileTriage(
  eph: Company,
  request: Message,
  body: Record<string, unknown>
): Promise<void> {
  await eph.runTurn(ONCALL, [
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
  await eph.hermes.sweep()
}

const REPORT = {
  schemaVersion: 1,
  kind: 'triage',
  incident: 'owner/app#ci-run:4021',
  severity: 1,
  resolved: false,
  summary: 'the login service returns 500 for every request since the deploy'
}

describe('SRS §6.1 — the chain, end to end over shipped components', () => {
  it('walks CI failure → incident → task → triage → gate → standup', async () => {
    const eph = await onCall()

    // 1. A test breaks. The Harbor's ingestion reports the run; the crew
    //    detects it without anybody asking.
    const raised = eph.incidents.raise([failedRun()])
    expect(raised).toHaveLength(1)

    // 2. The harness does not write the ledger (FR-5.2). It mails Artemis.
    expect(eph.tasks.tasks().tasks).toHaveLength(0)
    const request = eph.readInbox('agent.artemis', eph.inbox('agent.artemis')[0] as string)
    expect(request.from).toBe(HARBOR_ENDPOINT)

    // 3. Artemis proposes; the task lands assigned.
    proposeTriage(eph)
    const task = eph.tasks.tasks().tasks[0]
    expect(task?.assignee).toBe(ONCALL)

    // 4. The on-call agent triages and reports, through the real mail plane.
    await fileTriage(eph, request, REPORT)

    // 5. A severity-1 reaches the Architect NOW, and the announcement it owes
    //    is recorded as unmet rather than pretended (M6.9 deferred).
    expect(eph.escalatedNow).toEqual(['owner/app#ci-run:4021'])
    expect(eph.gates.list().length).toBeGreaterThan(0)
    expect(eph.unmetObligations.join(' ')).toMatch(/Herald is not wired/)

    // 6. …and the next briefing narrates it FROM THE LOG.
    const facts = compileFacts({
      events: eph.agora.readLog(0, 500),
      ledger: eph.tasks.tasks(),
      openGates: eph.gates.list().map((gate) => ({ id: gate.id, agentId: gate.agentId })),
      openMemos: [],
      spend: []
    })
    const narrated = facts.map((entry) => entry.what).join(' | ')
    expect(narrated).toMatch(/incident owner\/app#ci-run:4021/)
    expect(narrated).toMatch(/triaged severity-1/)
    // The agent's own words, verbatim — this is the E-BRIEF-FAITH surface.
    expect(narrated).toContain('the login service returns 500 for every request since the deploy')

    // 7. And the standup says the spoken alarm did NOT happen.
    //
    //    UC-09 step 4 promises a severity-1 reaches the Herald immediately;
    //    M6.9 is deferred, so it cannot. The endpoint records that as owed —
    //    but an obligation recorded only in `log.jsonl` is one the Architect
    //    has to go looking for. The standup is where they find out without
    //    looking, which is the whole point of recording it rather than
    //    dropping it.
    expect(narrated).toMatch(/owed an immediate spoken announcement that could not be made/)
  })

  it('narrates the incident accurately, and every claim carries a resolvable ref', async () => {
    const eph = await onCall()
    eph.incidents.raise([failedRun()])
    const request = eph.readInbox('agent.artemis', eph.inbox('agent.artemis')[0] as string)
    proposeTriage(eph)
    await fileTriage(eph, request, { ...REPORT, severity: 2, resolved: true })

    const facts = compileFacts({
      events: eph.agora.readLog(0, 500),
      ledger: eph.tasks.tasks(),
      openGates: [],
      openMemos: [],
      spend: []
    })
    const incidentFacts = facts.filter((entry) => entry.what.includes('incident owner/app'))

    // Accurately: the repo, the conclusion, the severity and the resolution as
    // recorded — nothing the harness decided for itself.
    expect(incidentFacts.length).toBeGreaterThanOrEqual(2)
    expect(incidentFacts.map((entry) => entry.what).join(' ')).toMatch(/failure on owner\/app/)
    expect(incidentFacts.map((entry) => entry.what).join(' ')).toMatch(
      /triaged severity-2 and resolved/
    )
    // S-BRIEF's rule: a claim the Architect cannot check is refused, so every
    // fact this section adds must carry a ref into the book of record.
    for (const entry of incidentFacts) {
      expect(entry.refs.length, entry.what).toBeGreaterThan(0)
      expect(
        entry.refs.every((ref) => ref.startsWith('log#')),
        entry.what
      ).toBe(true)
    }
  })

  it('says a severity-2 was resolved WITHOUT claiming the Architect must act', async () => {
    const eph = await onCall()
    eph.incidents.raise([failedRun()])
    const request = eph.readInbox('agent.artemis', eph.inbox('agent.artemis')[0] as string)
    await fileTriage(eph, request, { ...REPORT, severity: 2, resolved: true })

    expect(eph.escalatedNow).toEqual([])
    expect(eph.unmetObligations).toEqual([])
    const facts = compileFacts({
      events: eph.agora.readLog(0, 500),
      ledger: eph.tasks.tasks(),
      openGates: [],
      openMemos: [],
      spend: []
    })
    // The incident is still narrated — a resolved incident the Architect never
    // hears about is, from their side, one that did not happen (UC-09 step 3).
    expect(facts.map((entry) => entry.what).join(' ')).toMatch(/triaged severity-2 and resolved/)
  })

  it('takes zero un-gated destructive actions along the way', async () => {
    const eph = await onCall()
    eph.incidents.raise([failedRun()])
    const request = eph.readInbox('agent.artemis', eph.inbox('agent.artemis')[0] as string)
    proposeTriage(eph)
    await fileTriage(eph, request, REPORT)

    // §6.1's last clause. The company runs deny-by-default (the rig's policy is
    // `denyAllPolicy`), so the assertion worth making is that the whole chain
    // produced no ALLOWED destructive or outbound act — only a held gate.
    const log = fs.readFileSync(path.join(eph.agora.root, 'log.jsonl'), 'utf8')
    const allowed = log
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(
        (entry) =>
          entry.kind === 'gate' &&
          entry.event === 'allowed' &&
          (entry.gateKind === 'destructive' || entry.gateKind === 'outbound')
      )
    expect(allowed).toEqual([])
  })
})

/**
 * The seam that cost the incident path its whole production life.
 *
 * `index.ts` derives its `IncidentBinding`s from `ActivationPlan.triggers`, and
 * filtered on `trigger.when === 'ci'` — while the plan renders `when` as
 * `"on ci"` for the activation screen. So `bindings()` always returned empty,
 * every CI failure was dropped as `incident-unclaimed`, and no incident was
 * ever raised. Both halves were green: `incidents.test.ts` passed
 * `IncidentBinding` objects in directly and never derived one from a plan.
 *
 * Found on the first real repository this was pointed at. This case derives the
 * binding the way production does, so the two halves finally meet.
 */
describe('the incident binding is derived from a real plan', () => {
  it('finds the ci trigger by its EVENT, not by its display label', async () => {
    const { ProfileStore } = await import('../../src/main/profiles')
    const { activationPlan } = await import('../../src/shared/profile-activation')
    const store = new ProfileStore(
      path.join(__dirname, '..', '.no-such-home'),
      path.join(__dirname, '..', '..', 'profiles')
    )
    const loaded = store.load('skeleton-crew')
    if (!loaded.ok) throw new Error(loaded.reasons.join('; '))
    const planned = activationPlan(
      loaded.bundle,
      { kind: 'repo', id: 'musahit', path: path.join(__dirname, '..', '..') },
      'manual'
    )
    if (!planned.ok) throw new Error(planned.reasons.join('; '))

    // Exactly the expression `src/main/index.ts` uses to build its bindings.
    const bindings = planned.plan.triggers.filter((trigger) => trigger.event === 'ci')
    expect(bindings).toHaveLength(1)
    expect(bindings[0]?.playbook).toBe('incident.md')

    // And the label it must NOT be keyed on, pinned so the two cannot be
    // confused again.
    expect(bindings[0]?.when).toBe('on ci')
    expect(planned.plan.triggers.filter((trigger) => trigger.when === 'ci')).toEqual([])
  })
})

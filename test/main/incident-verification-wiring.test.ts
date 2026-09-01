import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { IncidentEndpoint, VERDICT_SUBJECT, type IncidentBinding } from '../../src/main/incidents'
import { PromptStore } from '../../src/main/prompts'
import { ProfileStore } from '../../src/main/profiles'
import {
  activationPlan,
  verifierAgentFor,
  type ActivationPlan
} from '../../src/shared/profile-activation'
import { VERIFIER_HIRE } from '../../src/shared/profile'
import { HARBOR_ENDPOINT } from '../../src/shared/reserved'
import { composeMessage, makeMessageId, type Message } from '../../src/shared/message'
import { routeMessage } from '../../src/shared/routing'
import type { InboundItem } from '../../src/shared/harbor'

/**
 * The verification path as the APPLICATION assembles it, not as a unit test
 * mocks it.
 *
 * `test/main/incidents.test.ts` proves the protocol against a rig whose
 * `render` is a fake and whose `verifierFor` returns a constant. Every one of
 * those assertions would stay green if the prompt files did not exist, if a
 * template asked for a `{{placeholder}}` the endpoint never supplies, if the
 * profile named no verifier hire, or if the router refused the verdict message
 * on its way in. Each of those is a real way to ship a feature nothing can
 * reach — and this repository has shipped exactly that before: M7.4's incident
 * binding filtered `trigger.when === 'ci'` against a plan rendering `"on ci"`,
 * so every CI failure was dropped while both halves' unit tests passed.
 *
 * So this file joins the seams `src/main/index.ts` joins, with the SHIPPED
 * pieces: the real `PromptStore` over the repository's own `prompts/`, the real
 * `ProfileStore` over the repository's own `profiles/`, the real
 * `activationPlan`, and the real routing rules. Only the target directory and
 * the clock are stand-ins.
 */

const REPO = path.join(__dirname, '..', '..')

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eph-verify-'))
}

const BINDING: IncidentBinding = {
  instanceId: 'skeleton-crew@repo:myapp',
  agentId: 'agent.skeleton-crew-myapp-ci-babysitter',
  playbook: 'incident.md',
  repos: ['owner/app']
}

const CI_RUN: InboundItem = {
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

const DIAGNOSED = {
  schemaVersion: 1,
  kind: 'triage',
  incident: 'owner/app#ci-run:4021',
  severity: 2,
  resolved: false,
  summary: 'the window cutoff falls before the fixture timestamps',
  rootCause: {
    claim: 'ArcLinker.run() has no injectable clock and always calls live utcnow()',
    cites: [
      { file: 'musahit/arcs/linker.py', line: 122, quote: 'async def run(self, run_id: str)' }
    ]
  }
}

/** The endpoint wired the way `src/main/index.ts` wires it, prompts and all. */
function endpointOn(
  home: string,
  verifier: string | null
): { readonly endpoint: IncidentEndpoint; readonly delivered: Message[] } {
  const prompts = new PromptStore(path.join(home, 'prompts'), path.join(REPO, 'prompts'))
  const delivered: Message[] = []
  let tick = 0
  const endpoint = new IncidentEndpoint({
    bindings: () => [BINDING],
    orchestratorId: () => 'agent.artemis',
    verifierFor: () => verifier,
    deliver: (message) => delivered.push(message),
    // Byte-for-byte the expression in `src/main/index.ts`. A prompt file that
    // does not exist, or a `{{placeholder}}` nothing fills, throws here.
    render: (kind, vars) => prompts.render(path.join('harbor', `incident-${kind}.md`), vars).trim(),
    onLogEvent: () => {},
    now: () => new Date(Date.UTC(2026, 7, 31, 10, 0, tick++))
  })
  return { endpoint, delivered }
}

function triage(original: Message): Message {
  return composeMessage({
    id: makeMessageId(new Date('2026-08-31T10:05:00.000Z'), 'tri1'),
    conversation: original.conversation,
    in_reply_to: original.id,
    from: BINDING.agentId,
    to: HARBOR_ENDPOINT,
    act: 'inform',
    subject: 'INCIDENT-TRIAGE',
    body: JSON.stringify(DIAGNOSED),
    hops: 1,
    created_at: '2026-08-31T10:05:00.000Z'
  })
}

/** The shipped Skeleton Crew, planned onto a repo target — no fixture bundle. */
function crewPlan(): ActivationPlan {
  const loaded = new ProfileStore(
    path.join(tempHome(), 'profiles'),
    path.join(REPO, 'profiles')
  ).load('skeleton-crew')
  if (!loaded.ok) throw new Error(loaded.reasons.join('; '))
  const planned = activationPlan(
    loaded.bundle,
    { kind: 'repo', id: 'myapp', path: REPO },
    'autonomous'
  )
  if (!planned.ok) throw new Error(planned.reasons.join('; '))
  return planned.plan
}

describe('the shipped profile names somebody to do the checking', () => {
  it('gives the Skeleton Crew a verifier hire, with its own budget', () => {
    const loaded = new ProfileStore(
      path.join(tempHome(), 'profiles'),
      path.join(REPO, 'profiles')
    ).load('skeleton-crew')
    if (!loaded.ok) throw new Error(loaded.reasons.join('; '))

    const hire = loaded.bundle.hires.find((candidate) => candidate.name === VERIFIER_HIRE)
    expect(hire).toBeDefined()
    // How the second opinion is PAID for, in a line the Architect reads on the
    // activation screen before agreeing to it — rather than an unbudgeted agent
    // turn charged to whoever happened to be nearby.
    expect(hire?.budget?.dailyTokens).toBeGreaterThan(0)
    // It reads and reports. A verifier holding a credential would be a second
    // agent able to change the repository it is meant to be checking.
    expect(hire?.envGrants).toEqual([])
  })

  it('resolves to a real agent id through the same plan `index.ts` reads', () => {
    const planned = crewPlan()

    // `verifierAgentFor` is the function `index.ts` calls, not a copy of it,
    // and it is fed a PLAN rather than an id passed in by hand. Both halves
    // matter: M7.4's binding bug was invisible to every unit test because none
    // of them ever derived a binding from a plan, and a resolver inlined in
    // `index.ts` could only ever be asserted by a copy that stays green while
    // the original rots.
    const instances = [{ instanceId: planned.instanceId, plan: planned }]
    const oncall = planned.triggers.find((trigger) => trigger.event === 'ci')?.agentId
    expect(oncall).toBe('agent.skeleton-crew-myapp-ci-babysitter')
    expect(verifierAgentFor(instances, planned.instanceId, oncall ?? '')).toBe(
      'agent.skeleton-crew-myapp-verifier'
    )
  })

  it('resolves nobody for an instance it has never heard of', () => {
    const planned = crewPlan()
    // A crew IS on the floor — just not this one. A verifier from another
    // activation is pointed at another checkout, so it cannot open the file the
    // claim cites, and asking it anyway would produce a verdict about a
    // different repository.
    expect(
      verifierAgentFor(
        [{ instanceId: 'front-office@repo:other', plan: planned }],
        'skeleton-crew@repo:myapp',
        BINDING.agentId
      )
    ).toBeNull()
    expect(verifierAgentFor([], 'skeleton-crew@repo:myapp', BINDING.agentId)).toBeNull()
  })

  it('refuses to hand the job back to the agent who wrote the claim', () => {
    const planned = crewPlan()

    // The verifier reporting on its own incident — legal in a profile that put
    // one hire on two duties. Independence is the whole product, so the answer
    // is nobody rather than itself.
    expect(
      verifierAgentFor(
        [{ instanceId: planned.instanceId, plan: planned }],
        planned.instanceId,
        'agent.skeleton-crew-myapp-verifier'
      )
    ).toBeNull()
  })
})

describe('the real prompt files render with the facts the endpoint supplies', () => {
  it('asks the verifier to refute, in the words of `prompts/harbor/`', () => {
    const { endpoint, delivered } = endpointOn(tempHome(), 'agent.skeleton-crew-myapp-verifier')
    endpoint.raise([CI_RUN])
    endpoint.onTriage(triage(delivered[0] as Message))

    const query = delivered.at(-1)
    expect(query?.to).toBe('agent.skeleton-crew-myapp-verifier')
    expect(query?.act).toBe('query')
    // Not a fake's JSON: the shipped template, with the agent's own claim and
    // citation interpolated into it.
    expect(query?.body).toContain('Try to refute it')
    expect(query?.body).toContain('ArcLinker.run() has no injectable clock')
    expect(query?.body).toContain('- musahit/arcs/linker.py:122 — async def run(self, run_id: str)')
    expect(query?.body).toContain(VERDICT_SUBJECT)
    expect(query?.subject).toContain('owner/app#ci-run:4021')
  })

  it('renders the dispute note to the claimant from the same store', () => {
    const { endpoint, delivered } = endpointOn(tempHome(), 'agent.skeleton-crew-myapp-verifier')
    endpoint.raise([CI_RUN])
    endpoint.onTriage(triage(delivered[0] as Message))
    const query = delivered.at(-1) as Message

    endpoint.onVerdict(
      composeMessage({
        id: makeMessageId(new Date('2026-08-31T10:20:00.000Z'), 'ver1'),
        conversation: query.conversation,
        in_reply_to: query.id,
        from: 'agent.skeleton-crew-myapp-verifier',
        to: HARBOR_ENDPOINT,
        act: 'inform',
        subject: VERDICT_SUBJECT,
        body: JSON.stringify({
          schemaVersion: 1,
          kind: 'root-cause-verdict',
          incident: 'owner/app#ci-run:4021',
          verdict: 'refute',
          because: 'line 122 already takes `now`, documented, and threads it on',
          read: [
            {
              file: 'musahit/arcs/linker.py',
              line: 122,
              quote: 'async def run(self, run_id: str, now: datetime | None = None)'
            }
          ]
        }),
        hops: 1,
        created_at: '2026-08-31T10:20:00.000Z'
      })
    )

    const note = delivered.at(-1)
    expect(note?.to).toBe(BINDING.agentId)
    expect(note?.body).toContain('does not agree with it')
    expect(note?.body).toContain('line 122 already takes `now`')
    expect(note?.body).toContain('musahit/arcs/linker.py:122')
  })
})

describe('a verdict can actually reach the endpoint', () => {
  it('routes to the harbor endpoint rather than bouncing', () => {
    // The router's rule for `agent.harbor` is reply-shaped acts only. A verdict
    // is an `inform`, so it lands — but nothing else in the suite checks that,
    // and a verdict the router bounced would leave the verifier's work in a
    // `.rejected/` directory with the endpoint waiting forever.
    const verdict = composeMessage({
      id: makeMessageId(new Date('2026-08-31T10:20:00.000Z'), 'ver1'),
      conversation: 'c-1',
      in_reply_to: null,
      from: 'agent.skeleton-crew-myapp-verifier',
      to: HARBOR_ENDPOINT,
      act: 'inform',
      subject: VERDICT_SUBJECT,
      body: '{}',
      hops: 1,
      created_at: '2026-08-31T10:20:00.000Z'
    })
    const route = routeMessage(verdict, { knownAgents: [], orchestratorId: null })
    expect(route.kind).toBe('endpoint')
    expect(route.kind === 'endpoint' && route.endpoint).toBe(HARBOR_ENDPOINT)
  })

  it('is told apart from a triage report by its subject, as `index.ts` does', () => {
    // `index.ts`'s harbor branch dispatches on the subject alone, so the two
    // subjects must not be equal — a coincidence that would send every verdict
    // to `onTriage` and refuse it as a malformed report.
    expect(VERDICT_SUBJECT).not.toBe('INCIDENT-TRIAGE')
  })
})

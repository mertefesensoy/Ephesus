import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Agora } from '../../src/main/agora'
import { PromptStore } from '../../src/main/prompts'
import {
  IncidentEndpoint,
  TRIAGE_SUBJECT,
  VERDICT_SUBJECT,
  type IncidentBinding
} from '../../src/main/incidents'
import { foldIncidents } from '../../src/shared/incident-view'
import { HARBOR_ENDPOINT } from '../../src/shared/reserved'
import { composeMessage, makeMessageId, type Message } from '../../src/shared/message'
import type { InboundItem } from '../../src/shared/harbor'

/**
 * The seam between what the incident endpoint WRITES and what the panel READS
 * (B14, ENGINEERING-STANDARDS §6.7).
 *
 * `test/shared/incident-view.test.ts` proves the fold against rows this test
 * file typed, and `test/renderer/incidents-panel.test.tsx` proves the panel
 * against a board the fold produced. Both would stay green if the endpoint
 * named a field `oncall` and the fold read `onCall`, because nothing in either
 * file has ever seen the endpoint's own output. That is the M6-Herald shape
 * this repository keeps rediscovering, and the fold is unusually exposed to it:
 * it reads a LOOSE log row by string field names, so every one of them is a
 * silent-null waiting to happen.
 *
 * So this file runs the real endpoint against a real `Agora` in a temp
 * directory, appends through the real `appendLog`, reads back through the real
 * `readLogAll`, and folds. Only the clock and the target repository are
 * stand-ins. The production expression it mirrors is
 * `src/main/index.ts` — `incidentBoard: () => foldIncidents(agora?.readLogAll() ?? [])`.
 */

const REPO = path.join(__dirname, '..', '..')

const homes: string[] = []

afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop()
    if (home !== undefined) fs.rmSync(home, { recursive: true, force: true })
  }
})

const ONCALL = 'agent.skeleton-crew-myapp-ci-babysitter'
const VERIFIER = 'agent.skeleton-crew-myapp-verifier'
const ARTEMIS = 'agent.artemis'

const BINDING: IncidentBinding = {
  instanceId: 'skeleton-crew@repo:myapp',
  agentId: ONCALL,
  playbook: 'incident.md',
  playbookPath: `/home/instances/i/playbooks/incident.md`,
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

const INCIDENT_KEY = 'owner/app#ci-run:4021'

const DIAGNOSED = {
  schemaVersion: 1,
  kind: 'triage',
  incident: INCIDENT_KEY,
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

interface Rig {
  readonly endpoint: IncidentEndpoint
  readonly agora: Agora
  readonly delivered: Message[]
}

async function rig(): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-surface-'))
  homes.push(home)
  const prompts = new PromptStore(path.join(home, 'prompts'), path.join(REPO, 'prompts'))
  const agora = new Agora({ root: path.join(home, 'agora'), prompts, backoffMs: 1 })
  // The same call the application makes before anything appends (SDD §4).
  await agora.ensureRepo()
  const delivered: Message[] = []
  let tick = 0
  const endpoint = new IncidentEndpoint({
    bindings: () => [BINDING],
    orchestratorId: () => ARTEMIS,
    verifierFor: () => VERIFIER,
    deliver: (message) => delivered.push(message),
    render: (kind, vars) => prompts.render(path.join('harbor', `incident-${kind}.md`), vars).trim(),
    // The application's own expression, minus the commit: `agora.appendLog` is
    // the single writer and is what the fold reads back.
    onLogEvent: (draft) => {
      agora.appendLog(draft)
    },
    now: () => new Date(Date.UTC(2026, 7, 31, 10, 0, tick++))
  })
  return { endpoint, agora, delivered }
}

let replies = 0

function reply(options: {
  readonly to: Message
  readonly from: string
  readonly subject: string
  readonly body: string
}): Message {
  return composeMessage({
    id: makeMessageId(
      new Date('2026-08-31T10:05:00.000Z'),
      `wir${String(replies++).padStart(2, '0')}`
    ),
    conversation: options.to.conversation,
    in_reply_to: options.to.id,
    from: options.from,
    to: HARBOR_ENDPOINT,
    act: 'inform',
    subject: options.subject,
    body: options.body,
    hops: 1,
    created_at: '2026-08-31T10:05:00.000Z'
  })
}

function sent(rigged: Rig, index: number): Message {
  const message = rigged.delivered[index]
  if (message === undefined) throw new Error(`no message at ${String(index)}`)
  return message
}

describe('what the endpoint writes is what the panel reads', () => {
  it('folds a raised incident with every field the card shows', async () => {
    const rigged = await rig()
    rigged.endpoint.raise([CI_RUN])

    const board = foldIncidents(rigged.agora.readLogAll())
    const [incident] = board.incidents
    // Every one of these is a field name agreed between two files. A typo in
    // either produces a null the fold cannot distinguish from an absent field.
    expect(incident?.key).toBe(INCIDENT_KEY)
    expect(incident?.repo).toBe('owner/app')
    expect(incident?.ref).toBe(4021)
    expect(incident?.conclusion).toBe('failure')
    expect(incident?.oncall).toBe(ONCALL)
    expect(incident?.playbook).toBe('incident.md')
    expect(incident?.instanceId).toBe('skeleton-crew@repo:myapp')
    expect(incident?.stage).toBe('awaiting-triage')
  })

  it("folds the on-call agent's triage, verbatim", async () => {
    const rigged = await rig()
    rigged.endpoint.raise([CI_RUN])
    rigged.endpoint.onTriage(
      reply({
        to: sent(rigged, 0),
        from: ONCALL,
        subject: TRIAGE_SUBJECT,
        body: JSON.stringify(DIAGNOSED)
      })
    )

    const [incident] = foldIncidents(rigged.agora.readLogAll()).incidents
    expect(incident?.severity).toBe(2)
    expect(incident?.resolved).toBe(false)
    expect(incident?.triagedBy).toBe(ONCALL)
    expect(incident?.summary).toBe('the window cutoff falls before the fixture timestamps')
    // The root cause went out for verification, so the incident is with a
    // verifier rather than settled.
    expect(incident?.stage).toBe('verifying')
    expect(incident?.verification?.verifier).toBe(VERIFIER)
    expect(incident?.verification?.claim).toContain('no injectable clock')
  })

  it('folds the refusal the orchestrator earns, onto the incident', async () => {
    // End to end for M8.9's first defect: she writes prose, the endpoint
    // refuses with the rule, the refusal reaches the book of record naming its
    // incident, and the panel can show it against that incident. Before this
    // package the last two of those four were impossible.
    const rigged = await rig()
    rigged.endpoint.raise([CI_RUN])
    rigged.endpoint.onTriage(
      reply({
        to: sent(rigged, 0),
        from: ARTEMIS,
        subject: TRIAGE_SUBJECT,
        body: 'Task opened as t-inc-app-4021 and assigned to the ci-babysitter.'
      })
    )

    const [incident] = foldIncidents(rigged.agora.readLogAll()).incidents
    expect(incident?.refusals).toHaveLength(1)
    expect(incident?.refusals[0]?.from).toBe(ARTEMIS)
    expect(incident?.refusals[0]?.of).toBe('triage')
    expect(incident?.refusals[0]?.reasons.join(' ')).toContain('on-call agent')
    expect(incident?.stage).toBe('awaiting-triage')
  })

  it('folds a verdict refused for length onto its incident', async () => {
    const rigged = await rig()
    rigged.endpoint.raise([CI_RUN])
    rigged.endpoint.onTriage(
      reply({
        to: sent(rigged, 0),
        from: ONCALL,
        subject: TRIAGE_SUBJECT,
        body: JSON.stringify(DIAGNOSED)
      })
    )
    const query = rigged.delivered.find((message) => message.to === VERIFIER)
    if (query === undefined) throw new Error('no verification query was sent')
    rigged.endpoint.onVerdict(
      reply({
        to: query,
        from: VERIFIER,
        subject: VERDICT_SUBJECT,
        body: JSON.stringify({
          schemaVersion: 1,
          kind: 'root-cause-verdict',
          incident: INCIDENT_KEY,
          verdict: 'refute',
          because: 'x'.repeat(4_231),
          read: [{ file: 'musahit/arcs/linker.py', line: 122, quote: 'now: datetime' }]
        })
      })
    )

    const [incident] = foldIncidents(rigged.agora.readLogAll()).incidents
    const refusal = incident?.refusals.find((row) => row.of === 'verdict')
    expect(refusal?.from).toBe(VERIFIER)
    expect(refusal?.reasons.join(' ')).toContain('4231 characters')
    expect(refusal?.reasons.join(' ')).toContain('the limit is 2000')
  })

  it('folds a settled verdict beside the claim it answered', async () => {
    const rigged = await rig()
    rigged.endpoint.raise([CI_RUN])
    rigged.endpoint.onTriage(
      reply({
        to: sent(rigged, 0),
        from: ONCALL,
        subject: TRIAGE_SUBJECT,
        body: JSON.stringify(DIAGNOSED)
      })
    )
    const query = rigged.delivered.find((message) => message.to === VERIFIER)
    if (query === undefined) throw new Error('no verification query was sent')
    rigged.endpoint.onVerdict(
      reply({
        to: query,
        from: VERIFIER,
        subject: VERDICT_SUBJECT,
        body: JSON.stringify({
          schemaVersion: 1,
          kind: 'root-cause-verdict',
          incident: INCIDENT_KEY,
          verdict: 'refute',
          because: 'line 122 already takes now: datetime | None = None',
          read: [
            {
              file: 'musahit/arcs/linker.py',
              line: 122,
              quote: 'async def run(self, run_id: str, now: datetime | None = None)'
            }
          ]
        })
      })
    )

    const [incident] = foldIncidents(rigged.agora.readLogAll()).incidents
    expect(incident?.stage).toBe('triaged')
    expect(incident?.verification?.verdict).toBe('refute')
    expect(incident?.verification?.because).toBe(
      'line 122 already takes now: datetime | None = None'
    )
    expect(incident?.verification?.read).toEqual(['musahit/arcs/linker.py:122'])
  })

  it('folds a CI failure no live binding claimed', async () => {
    const rigged = await rig()
    rigged.endpoint.raise([{ ...CI_RUN, repo: 'owner/unwatched', ref: 77 }])

    const board = foldIncidents(rigged.agora.readLogAll())
    expect(board.incidents).toHaveLength(0)
    expect(board.unclaimed).toHaveLength(1)
    expect(board.unclaimed[0]?.repo).toBe('owner/unwatched')
    expect(board.unclaimed[0]?.because).toContain('no live profile instance')
  })
})

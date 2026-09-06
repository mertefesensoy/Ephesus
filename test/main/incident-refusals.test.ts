import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  IncidentEndpoint,
  TRIAGE_SUBJECT,
  VERDICT_SUBJECT,
  type IncidentBinding
} from '../../src/main/incidents'
import { PromptStore } from '../../src/main/prompts'
import { HARBOR_ENDPOINT } from '../../src/shared/reserved'
import { composeMessage, makeMessageId, type Message } from '../../src/shared/message'
import type { InboundItem } from '../../src/shared/harbor'

/**
 * The two refusals that have to TEACH (M8.9), read off the Architect's own
 * `log.jsonl` rather than imagined:
 *
 *  - **12 of 21 triage attempts refused, nine of them `agent.artemis` replying
 *    in prose** — "Task opene…", "Assigned t…", "Reassigned…". She is doing
 *    exactly what `prompts/harbor/incident-body.md` asks (open the task, assign
 *    it) and then writing back to say so, which the SAME prompt forbids by name
 *    and warns will bounce. It bounced nine times, and each time she was told
 *    `triage report: not JSON — Unexpected token 'T'`.
 *  - **Every root-cause verdict the company has ever received was thrown away
 *    for length** — three verification requests, three refusals reading
 *    `because: Too big: expected string to have <=2000 characters`, and zero
 *    `incident-root-cause-verdict` rows in the whole file.
 *
 * A guard that is right and a sentence that cannot be learned from is a guard
 * whose refusal is re-earned on the next incident. These tests are about the
 * SENTENCE, so they run the real `PromptStore` over the repository's own
 * `prompts/`: a refusal asserted against a fake renderer would stay green with
 * the prompt file absent, which is the exact shape of check this repository
 * keeps catching in itself.
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
const ARTEMIS = 'agent.artemis'
const VERIFIER = 'agent.skeleton-crew-myapp-verifier'

const BINDING: IncidentBinding = {
  instanceId: 'skeleton-crew@repo:myapp',
  agentId: ONCALL,
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
  readonly delivered: Message[]
  readonly logged: Record<string, unknown>[]
}

/** The endpoint wired the way `src/main/index.ts` wires it, prompts and all. */
function rig(bindings: readonly IncidentBinding[] = [BINDING]): Rig {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-refuse-'))
  homes.push(home)
  const prompts = new PromptStore(path.join(home, 'prompts'), path.join(REPO, 'prompts'))
  const delivered: Message[] = []
  const logged: Record<string, unknown>[] = []
  let tick = 0
  const endpoint = new IncidentEndpoint({
    bindings: () => bindings,
    orchestratorId: () => ARTEMIS,
    verifierFor: () => VERIFIER,
    deliver: (message) => delivered.push(message),
    // Byte-for-byte the expression in `src/main/index.ts`. A prompt file that
    // does not exist, or a `{{placeholder}}` nothing fills, throws here.
    render: (kind, vars) => prompts.render(path.join('harbor', `incident-${kind}.md`), vars).trim(),
    onLogEvent: (draft) => logged.push(draft),
    now: () => new Date(Date.UTC(2026, 7, 31, 10, 0, tick++))
  })
  return { endpoint, delivered, logged }
}

/** The request the endpoint sent, by position; fails loudly rather than casting. */
function sent(rigged: Rig, index: number): Message {
  const message = rigged.delivered[index]
  if (message === undefined) throw new Error(`no message at ${String(index)}`)
  return message
}

function lastBody(rigged: Rig): string {
  return sent(rigged, rigged.delivered.length - 1).body
}

let replies = 0

function reply(options: {
  readonly to: Message
  readonly from: string
  readonly subject: string
  readonly body: string
  readonly threaded?: boolean
  readonly act?: 'inform' | 'refuse' | 'agree'
}): Message {
  return composeMessage({
    id: makeMessageId(
      new Date('2026-08-31T10:05:00.000Z'),
      `rep${String(replies++).padStart(2, '0')}`
    ),
    conversation: options.to.conversation,
    in_reply_to: options.threaded === false ? null : options.to.id,
    from: options.from,
    to: HARBOR_ENDPOINT,
    act: options.act ?? 'inform',
    subject: options.subject,
    body: options.body,
    hops: 1,
    created_at: '2026-08-31T10:05:00.000Z'
  })
}

describe('the orchestrator answering a triage she was asked to delegate', () => {
  it('is told the rule, not that her prose is not JSON', () => {
    const rigged = rig()
    rigged.endpoint.raise([CI_RUN])
    // Her actual first words on the Architect's machine.
    const acted = rigged.endpoint.onTriage(
      reply({
        to: sent(rigged, 0),
        from: ARTEMIS,
        subject: TRIAGE_SUBJECT,
        body: 'Task opened as t-inc-app-4021 and assigned to the ci-babysitter.'
      })
    )

    expect(acted).toBeNull()
    const body = lastBody(rigged)
    expect(body).not.toContain('not JSON')
    expect(body).not.toContain('Unexpected token')
    // The rule, in the words of `prompts/harbor/incident-not-your-triage.md`.
    expect(body).toContain('belongs to the on-call agent')
    // And what to do instead, which is the half a parse error can never carry.
    expect(body).toContain('`refuse`')
  })

  it('names the incident on the refusal row, so a surface can attach it', () => {
    const rigged = rig()
    rigged.endpoint.raise([CI_RUN])
    rigged.endpoint.onTriage(
      reply({
        to: sent(rigged, 0),
        from: ARTEMIS,
        subject: TRIAGE_SUBJECT,
        body: 'Reassigned to the updater.'
      })
    )

    const refusal = rigged.logged.find((row) => row['event'] === 'incident-triage-refused')
    expect(refusal?.['incident']).toBe(INCIDENT_KEY)
  })

  it('refuses her even when she did not thread the reply', () => {
    // An agent that composes a fresh message leaves nothing to look up, and a
    // guard that only fires on a threaded reply is a guard that might never
    // fire at all — the log records the refusals, not the `in_reply_to` that
    // produced them, so this branch cannot be assumed away.
    const rigged = rig()
    rigged.endpoint.raise([CI_RUN])
    const acted = rigged.endpoint.onTriage(
      reply({
        to: sent(rigged, 0),
        from: ARTEMIS,
        subject: TRIAGE_SUBJECT,
        body: 'This is the triage.',
        threaded: false
      })
    )
    expect(acted).toBeNull()
    expect(lastBody(rigged)).toContain('belongs to the on-call agent')
  })

  it('does NOT refuse her when she is the one on call', () => {
    // A one-agent company whose orchestrator is also its on-call agent must not
    // be refused for doing its job. This is the direction that makes the guard
    // a rule about the roster rather than a blocklist on one agent id.
    const rigged = rig([{ ...BINDING, agentId: ARTEMIS }])
    rigged.endpoint.raise([CI_RUN])
    const acted = rigged.endpoint.onTriage(
      reply({
        to: sent(rigged, 0),
        from: ARTEMIS,
        subject: TRIAGE_SUBJECT,
        body: JSON.stringify(DIAGNOSED)
      })
    )
    expect(acted).not.toBeNull()
  })

  it('does NOT refuse the reassignee, who is neither on call nor the orchestrator', () => {
    // The live log has the orchestrator reassigning a triage — "reassigned to
    // you; on-call agent is out of budget". The obvious generalisation ("only
    // `incident.agentId` may report") would refuse honest work to fix a
    // courtesy reply, so the guard is deliberately about her alone.
    const rigged = rig()
    rigged.endpoint.raise([CI_RUN])
    const acted = rigged.endpoint.onTriage(
      reply({
        to: sent(rigged, 0),
        from: 'agent.skeleton-crew-myapp-dependency-updater',
        subject: TRIAGE_SUBJECT,
        body: JSON.stringify(DIAGNOSED)
      })
    )
    expect(acted).not.toBeNull()
  })

  it('leaves the on-call agent on the parse path when the report is malformed', () => {
    // The guard is about WHO wrote, and it must not swallow the refusal the
    // author of a broken report actually needs.
    const rigged = rig()
    rigged.endpoint.raise([CI_RUN])
    rigged.endpoint.onTriage(
      reply({
        to: sent(rigged, 0),
        from: ONCALL,
        subject: TRIAGE_SUBJECT,
        body: 'not json at all'
      })
    )
    expect(lastBody(rigged)).toContain('not JSON')
  })

  it('still records a plain declination rather than refusing it', () => {
    // `refuse`/`agree` were taught to this endpoint before M8.9 and stay
    // untouched: the orchestrator saying "I cannot delegate this" is an answer,
    // not a report, and the incident stays awaiting either way.
    const rigged = rig()
    rigged.endpoint.raise([CI_RUN])
    rigged.endpoint.onTriage(
      reply({
        to: sent(rigged, 0),
        from: ARTEMIS,
        subject: TRIAGE_SUBJECT,
        body: 'the on-call agent is out of budget',
        act: 'refuse'
      })
    )
    expect(rigged.logged.some((row) => row['event'] === 'incident-triage-declined')).toBe(true)
    expect(rigged.delivered).toHaveLength(1)
  })
})

describe('a verdict refused for length', () => {
  /** Raises, triages, and returns the verification query sent to the verifier. */
  function verdictQuery(rigged: Rig): Message {
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
    return query
  }

  const verdictBody = (because: string): string =>
    JSON.stringify({
      schemaVersion: 1,
      kind: 'root-cause-verdict',
      incident: INCIDENT_KEY,
      verdict: 'refute',
      because,
      read: [{ file: 'musahit/arcs/linker.py', line: 122, quote: 'now: datetime | None = None' }]
    })

  it('says how far over it went, not only what the schema wanted', () => {
    const rigged = rig()
    const query = verdictQuery(rigged)
    rigged.endpoint.onVerdict(
      reply({
        to: query,
        from: VERIFIER,
        subject: VERDICT_SUBJECT,
        body: verdictBody('x'.repeat(4_231))
      })
    )

    const body = lastBody(rigged)
    expect(body).toContain('4231 characters')
    expect(body).toContain('the limit is 2000')
    expect(body).not.toContain('Too big: expected string')
  })

  it('tells the verifier the question is still open and the reading still counts', () => {
    const rigged = rig()
    const query = verdictQuery(rigged)
    rigged.endpoint.onVerdict(
      reply({
        to: query,
        from: VERIFIER,
        subject: VERDICT_SUBJECT,
        body: verdictBody('x'.repeat(2_001))
      })
    )
    // In the words of `prompts/harbor/incident-verdict-refused.md`.
    expect(lastBody(rigged)).toContain('still open')
  })

  it('accepts the shortened second answer on the same thread', () => {
    // THE property that makes "refuse" cheaper than "truncate": `refuseVerdict`
    // never clears `awaitingVerdict`, so the corrected verdict lands. Without
    // it, naming the limit would be advice the verifier could not act on, and
    // truncating a verifier's reasoning would have been the better trade.
    const rigged = rig()
    const query = verdictQuery(rigged)
    rigged.endpoint.onVerdict(
      reply({
        to: query,
        from: VERIFIER,
        subject: VERDICT_SUBJECT,
        body: verdictBody('x'.repeat(4_231))
      })
    )
    const second = rigged.endpoint.onVerdict(
      reply({
        to: query,
        from: VERIFIER,
        subject: VERDICT_SUBJECT,
        body: verdictBody('the clock IS injectable — line 122 takes now: datetime | None = None')
      })
    )

    expect(second?.verdict).toBe('refute')
    expect(rigged.logged.some((row) => row['event'] === 'incident-root-cause-verdict')).toBe(true)
  })

  it('does NOT invite a second answer when nothing is awaiting one', () => {
    // The one refusal path where the thread really is closed. Telling an agent
    // to answer again a question nobody asked buys a second wasted turn, which
    // is the cost this whole change exists to stop.
    const rigged = rig()
    rigged.endpoint.raise([CI_RUN])
    const unsolicited = reply({
      to: sent(rigged, 0),
      from: VERIFIER,
      subject: VERDICT_SUBJECT,
      body: verdictBody('nobody asked me'),
      threaded: false
    })
    expect(rigged.endpoint.onVerdict(unsolicited)).toBeNull()
    expect(lastBody(rigged)).not.toContain('still open')
  })

  it('names the incident on the refusal row', () => {
    const rigged = rig()
    const query = verdictQuery(rigged)
    rigged.endpoint.onVerdict(
      reply({
        to: query,
        from: VERIFIER,
        subject: VERDICT_SUBJECT,
        body: verdictBody('x'.repeat(4_231))
      })
    )
    const refusal = rigged.logged.find((row) => row['event'] === 'incident-verdict-refused')
    expect(refusal?.['incident']).toBe(INCIDENT_KEY)
  })
})

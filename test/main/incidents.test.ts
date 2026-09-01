import { describe, expect, it } from 'vitest'
import {
  IncidentEndpoint,
  TRIAGE_SUBJECT,
  VERDICT_SUBJECT,
  type IncidentBinding
} from '../../src/main/incidents'
import { HARBOR_ENDPOINT } from '../../src/shared/reserved'
import { composeMessage, makeMessageId, parseMessage, type Message } from '../../src/shared/message'
import type { InboundItem } from '../../src/shared/harbor'

/**
 * The incident endpoint (FR-9.2, UC-09, SDD §7.5 — M7.4).
 *
 * The claims under test are the ones that would be invisible if only the two
 * halves were tested separately:
 *
 *  - a CI failure becomes MAIL TO ARTEMIS, never a direct ledger write
 *    (FR-5.2's single scribe, asserted by the absence of any other path);
 *  - the same red run raises ONCE however many times it is ingested;
 *  - the harness assigns no severity — the agent's report does;
 *  - a severity-1's announcement is recorded as OWED and reported, because the
 *    Herald is unwired (M6.9, deferred) and must not be called.
 */

const BINDING: IncidentBinding = {
  instanceId: 'skeleton-crew:repo:myapp',
  agentId: 'agent.skeleton-crew-myapp-ci-babysitter',
  playbook: 'incident.md',
  repos: ['owner/app']
}

function ciRun(overrides: Partial<InboundItem> = {}): InboundItem {
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

interface Rig {
  readonly endpoint: IncidentEndpoint
  readonly delivered: Message[]
  readonly logged: Record<string, unknown>[]
  readonly unmet: string[]
  readonly escalated: string[]
}

function rig(
  bindings: readonly IncidentBinding[] = [BINDING],
  // `undefined` takes the default verifier; an explicit `null` is a floor with
  // nobody to ask, which is a different case and has its own test.
  options: { readonly verifier?: string | null } = {}
): Rig {
  const delivered: Message[] = []
  const logged: Record<string, unknown>[] = []
  const unmet: string[] = []
  const escalated: string[] = []
  let tick = 0
  const endpoint = new IncidentEndpoint({
    bindings: () => bindings,
    orchestratorId: () => 'agent.artemis',
    deliver: (message) => delivered.push(message),
    verifierFor: () => (options.verifier === undefined ? VERIFIER : options.verifier),
    // Stand-in for the PromptStore, which reads `prompts/harbor/incident-*.md`.
    // The words are not this module's to own (invariant §8) — the FACTS are,
    // so the fake renders them where a real template would interpolate them.
    render: (kind, vars) =>
      kind.endsWith('subject') ? `${kind}: ${vars.repo ?? vars.incident}` : JSON.stringify(vars),
    onLogEvent: (draft) => logged.push(draft),
    onUnmetObligation: (what) => unmet.push(what),
    onEscalateNow: (incident) => escalated.push(incident.key),
    now: () => new Date(Date.UTC(2026, 7, 31, 10, 0, tick++))
  })
  return { endpoint, delivered, logged, unmet, escalated }
}

describe('a CI failure becomes mail to the orchestrator', () => {
  it('writes to Artemis, from the Harbor endpoint, asking for a task', () => {
    const { endpoint, delivered } = rig()
    const raised = endpoint.raise([ciRun()])

    expect(raised).toHaveLength(1)
    expect(delivered).toHaveLength(1)
    const message = delivered[0]
    expect(message?.from).toBe(HARBOR_ENDPOINT)
    expect(message?.to).toBe('agent.artemis')
    // `request` obligates a reply (ADR-0003's obligation table). The task is
    // hers to propose — the harness asks, it does not write `tasks.json`.
    expect(message?.act).toBe('request')
  })

  it('carries the ingested facts and adds nothing', () => {
    const { endpoint, delivered } = rig()
    endpoint.raise([ciRun()])
    const vars = JSON.parse(delivered[0]?.body ?? '{}') as Record<string, string>

    expect(vars.repo).toBe('owner/app')
    expect(vars.ref).toBe('4021')
    expect(vars.title).toBe('build and test')
    expect(vars.conclusion).toBe('failure')
    expect(vars.at).toBe('2026-08-31T09:00:00.000Z')
    expect(vars.oncall).toBe('agent.skeleton-crew-myapp-ci-babysitter')
    expect(vars.playbook).toBe('incident.md')
    // No severity, no diagnosis, no summary: the harness has none of those and
    // must not supply them. This is E-BRIEF-FAITH's rule applied at the port.
    expect(Object.keys(vars)).not.toContain('severity')
    expect(Object.keys(vars)).not.toContain('diagnosis')
    expect(Object.keys(vars)).not.toContain('summary')
  })

  it('logs the raise against the instance that owns it', () => {
    const { endpoint, logged } = rig()
    endpoint.raise([ciRun()])
    const entry = logged.find((row) => row.event === 'incident-raised')
    expect(entry).toMatchObject({
      kind: 'profile',
      instanceId: 'skeleton-crew:repo:myapp',
      incident: 'owner/app#ci-run:4021',
      oncall: 'agent.skeleton-crew-myapp-ci-babysitter'
    })
  })
})

describe('raising is idempotent', () => {
  it('raises a still-failing run exactly once across repeated ingestions', () => {
    const { endpoint, delivered } = rig()
    // The Harbor rebuilds its queues from scratch every ten minutes, so the
    // same red run arrives again and again. Without the cursor the crew is
    // woken forever for one failure.
    endpoint.raise([ciRun()])
    endpoint.raise([ciRun()])
    endpoint.raise([ciRun({ title: 'build and test (renamed)' })])

    expect(delivered).toHaveLength(1)
    expect(endpoint.raisedKeys()).toEqual(['owner/app#ci-run:4021'])
  })

  it('still raises a genuinely different run', () => {
    const { endpoint, delivered } = rig()
    endpoint.raise([ciRun()])
    endpoint.raise([ciRun({ ref: 4022 })])
    expect(delivered).toHaveLength(2)
  })
})

describe('what is not an incident raises nothing', () => {
  it('ignores a run that passed', () => {
    const { endpoint, delivered } = rig()
    endpoint.raise([ciRun({ conclusion: 'success' })])
    expect(delivered).toHaveLength(0)
  })

  it('ignores a run still in flight, and a cancelled one', () => {
    const { endpoint, delivered } = rig()
    endpoint.raise([ciRun({ conclusion: null, state: 'in_progress' })])
    endpoint.raise([ciRun({ ref: 4023, conclusion: 'cancelled' })])
    expect(delivered).toHaveLength(0)
  })

  it('ignores issues and pull requests', () => {
    const { endpoint, delivered } = rig()
    endpoint.raise([ciRun({ kind: 'issue' }), ciRun({ kind: 'pull-request', ref: 12 })])
    expect(delivered).toHaveLength(0)
  })
})

describe('routing never guesses a recipient', () => {
  it('drops an item no live binding watches, and says so', () => {
    const { endpoint, delivered, logged } = rig()
    endpoint.raise([ciRun({ repo: 'someone/else' })])

    expect(delivered).toHaveLength(0)
    expect(logged.find((row) => row.event === 'incident-unclaimed')).toMatchObject({
      repo: 'someone/else'
    })
  })

  it('raises nothing at all when no profile is on call', () => {
    const { endpoint, delivered, logged } = rig([])
    endpoint.raise([ciRun()])
    expect(delivered).toHaveLength(0)
    expect(logged.some((row) => row.event === 'incident-unclaimed')).toBe(true)
  })

  it('routes to the binding that declared the repository', () => {
    const other: IncidentBinding = {
      instanceId: 'skeleton-crew:repo:other',
      agentId: 'agent.skeleton-crew-other-ci-babysitter',
      playbook: 'incident.md',
      repos: ['someone/else']
    }
    const { endpoint, delivered } = rig([other, BINDING])
    endpoint.raise([ciRun()])
    const vars = JSON.parse(delivered[0]?.body ?? '{}') as Record<string, string>
    expect(vars.oncall).toBe('agent.skeleton-crew-myapp-ci-babysitter')
  })
})

/** The agent's report, as it would arrive from an outbox. */
function triage(
  original: Message,
  body: Record<string, unknown>,
  from = 'agent.skeleton-crew-myapp-ci-babysitter'
): Message {
  return composeMessage({
    id: makeMessageId(new Date('2026-08-31T10:05:00.000Z'), 'tri1'),
    conversation: original.conversation,
    in_reply_to: original.id,
    from,
    to: HARBOR_ENDPOINT,
    act: 'inform',
    subject: TRIAGE_SUBJECT,
    body: JSON.stringify(body),
    hops: 1,
    created_at: '2026-08-31T10:05:00.000Z'
  })
}

const REPORT = {
  schemaVersion: 1,
  kind: 'triage',
  incident: 'owner/app#ci-run:4021',
  severity: 2,
  resolved: true,
  summary: 'flaky timeout in the upload test; re-ran and it passed'
}

describe('the severity comes from the agent, and drives the escalation', () => {
  it('acts on a severity-2 without escalating now', () => {
    const { endpoint, delivered, escalated, unmet, logged } = rig()
    endpoint.raise([ciRun()])
    const escalation = endpoint.onTriage(triage(delivered[0] as Message, REPORT))

    expect(escalation?.severity).toBe(2)
    expect(escalation?.escalateNow).toBe(false)
    expect(escalated).toEqual([])
    expect(unmet).toEqual([])
    expect(logged.find((row) => row.event === 'incident-triaged')).toMatchObject({
      severity: 2,
      resolved: true,
      summary: 'flaky timeout in the upload test; re-ran and it passed'
    })
  })

  it('escalates a severity-1 immediately', () => {
    const { endpoint, delivered, escalated } = rig()
    endpoint.raise([ciRun()])
    const escalation = endpoint.onTriage(
      triage(delivered[0] as Message, { ...REPORT, severity: 1, resolved: false })
    )

    expect(escalation?.escalateNow).toBe(true)
    expect(escalated).toEqual(['owner/app#ci-run:4021'])
  })

  it('carries the agent’s summary verbatim into the log', () => {
    const { endpoint, delivered, logged } = rig()
    endpoint.raise([ciRun()])
    const words = 'the migration dropped a column that the API still reads'
    endpoint.onTriage(triage(delivered[0] as Message, { ...REPORT, summary: words }))
    // Verbatim, because the brief cites this entry and a rewritten sentence is
    // a claim nobody made.
    expect(logged.find((row) => row.event === 'incident-triaged')?.summary).toBe(words)
  })
})

describe('a severity-1 announcement is owed, not faked', () => {
  it('records the obligation and reports it unmet, without calling the Herald', () => {
    const { endpoint, delivered, unmet, logged } = rig()
    endpoint.raise([ciRun()])
    endpoint.onTriage(triage(delivered[0] as Message, { ...REPORT, severity: 1 }))

    // UC-09 step 4 says the Herald announces a severity-1 immediately. M6.9 —
    // wiring the Herald — is deferred indefinitely by Architect decision, so
    // the obligation is RECORDED and REPORTED rather than silently dropped
    // (invariant §7) and rather than satisfied by something that is not a
    // spoken announcement.
    expect(unmet).toHaveLength(1)
    expect(unmet[0]).toMatch(/severity-1/)
    expect(unmet[0]).toMatch(/Herald is not wired/)
    expect(logged.find((row) => row.event === 'incident-announce-owed')).toMatchObject({
      incident: 'owner/app#ci-run:4021',
      because: 'herald-unwired'
    })
  })

  it('owes nothing for a severity-2', () => {
    const { endpoint, delivered, unmet, logged } = rig()
    endpoint.raise([ciRun()])
    endpoint.onTriage(triage(delivered[0] as Message, REPORT))
    expect(unmet).toEqual([])
    expect(logged.some((row) => row.event === 'incident-announce-owed')).toBe(false)
  })
})

describe('an unreadable report is refused, never defaulted', () => {
  it('refuses a report with no severity and says why', () => {
    const { endpoint, delivered, logged } = rig()
    endpoint.raise([ciRun()])
    const withoutSeverity: Record<string, unknown> = { ...REPORT }
    delete withoutSeverity.severity
    const escalation = endpoint.onTriage(triage(delivered[0] as Message, withoutSeverity))

    // Not "assume severity-2". A report the harness could not read must not
    // become a quiet claim that the incident was mild.
    expect(escalation).toBeNull()
    expect(logged.find((row) => row.event === 'incident-triage-refused')).toBeDefined()
    const refusal = delivered.at(-1)
    expect(refusal?.act).toBe('refuse')
    expect(refusal?.to).toBe('agent.skeleton-crew-myapp-ci-babysitter')
    expect(refusal?.from).toBe(HARBOR_ENDPOINT)
  })

  it('refuses a report for an incident nobody raised', () => {
    const { endpoint, delivered } = rig()
    endpoint.raise([ciRun()])
    const stray = composeMessage({
      id: makeMessageId(new Date('2026-08-31T10:05:00.000Z'), 'stray'),
      conversation: 'c-stray',
      in_reply_to: null,
      from: 'agent.skeleton-crew-myapp-ci-babysitter',
      to: HARBOR_ENDPOINT,
      act: 'inform',
      subject: TRIAGE_SUBJECT,
      body: JSON.stringify({ ...REPORT, incident: 'owner/app#ci-run:9999' }),
      hops: 1,
      created_at: '2026-08-31T10:05:00.000Z'
    })
    expect(endpoint.onTriage(stray)).toBeNull()
    expect(delivered.at(-1)?.act).toBe('refuse')
  })

  /**
   * The second instance of the half-wired-endpoint bug, fixed here.
   *
   * `agent.harbor` sends the triage `request`, which obligates a reply, and
   * PROTOCOL.md tells an agent to refuse and say why when it cannot do what it
   * was asked. Every reply that reached this endpoint went through the triage
   * report parser, so an on-call agent that explained itself perfectly clearly
   * was told "the body is not valid JSON" — the address accepted the message
   * and then read it as the only thing it knew how to read.
   */
  it('takes a declination as a declination, not as a malformed report', () => {
    const { endpoint, delivered, logged } = rig()
    endpoint.raise([ciRun()])
    const request = delivered[0] as Message
    const declined = composeMessage({
      id: makeMessageId(new Date('2026-08-31T10:05:00.000Z'), 'dec1'),
      conversation: request.conversation,
      in_reply_to: request.id,
      from: 'agent.skeleton-crew-myapp-ci-babysitter',
      to: HARBOR_ENDPOINT,
      act: 'refuse',
      subject: `re: ${request.subject}`,
      body: 'The run logs have already been garbage-collected; I cannot tell what failed.',
      hops: 1,
      created_at: '2026-08-31T10:05:00.000Z'
    })

    expect(endpoint.onTriage(declined)).toBeNull()
    // Recorded as what it is, with the agent's own words and the incident it
    // was about — not as a parse failure.
    const record = logged.find((row) => row.event === 'incident-triage-declined')
    expect(record).toBeDefined()
    expect(record?.incident).toBe('owner/app#ci-run:4021')
    expect(String(record?.because)).toContain('garbage-collected')
    expect(logged.find((row) => row.event === 'incident-triage-refused')).toBeUndefined()
    // And nothing is mailed back complaining about JSON: a `refuse` obliges no
    // reply, and the endpoint has nothing to add.
    expect(delivered).toHaveLength(1)
  })

  it('leaves the incident awaiting triage when the on-call agent declines', () => {
    // The one outcome worse than the old bounce would be treating "I cannot
    // triage this" as triage. Nobody has looked at the incident yet.
    const { endpoint, delivered, escalated } = rig()
    endpoint.raise([ciRun()])
    const request = delivered[0] as Message
    endpoint.onTriage(
      composeMessage({
        id: makeMessageId(new Date('2026-08-31T10:05:00.000Z'), 'dec2'),
        conversation: request.conversation,
        in_reply_to: request.id,
        from: 'agent.skeleton-crew-myapp-ci-babysitter',
        to: HARBOR_ENDPOINT,
        act: 'refuse',
        subject: `re: ${request.subject}`,
        body: 'not mine to triage',
        hops: 1,
        created_at: '2026-08-31T10:05:00.000Z'
      })
    )
    expect(escalated).toEqual([])
    // Nothing was mailed back at the declination — in particular not a refusal
    // about JSON the agent never claimed to send.
    expect(delivered).toHaveLength(1)
    // Still awaiting: a real report on the same incident is still accepted.
    expect(endpoint.onTriage(triage(request, { ...REPORT, severity: 1 }))?.severity).toBe(1)
  })

  it('does not act twice on one incident', () => {
    const { endpoint, delivered, escalated } = rig()
    endpoint.raise([ciRun()])
    const report = triage(delivered[0] as Message, { ...REPORT, severity: 1 })
    expect(endpoint.onTriage(report)?.severity).toBe(1)
    // The second arrival has nothing awaiting it and is refused, rather than
    // escalating the same incident to the Architect a second time.
    expect(endpoint.onTriage(report)).toBeNull()
    expect(escalated).toEqual(['owner/app#ci-run:4021'])
  })
})

/**
 * An independent verdict on a root cause (the 2026-09-01 live run's second
 * reconciliation gap).
 *
 * The run's finding, in one line: the triage was a specific technical diagnosis
 * of a real repository, MOST of it verified, and its root cause was false in a
 * way that took ten seconds to check. Nothing in the company could check it.
 * These tests are about the machinery that now can — and about the four ways it
 * declines to spend an agent turn, because a verification that fires on every
 * report is a burn-rate problem wearing a safety hat.
 */

const ROOT_CAUSE = {
  claim: 'ArcLinker.run() has no injectable clock and always calls live utcnow()',
  cites: [
    {
      file: 'musahit/arcs/linker.py',
      line: 122,
      quote: 'async def run(self, run_id: str)'
    }
  ]
}

/** A triage report that asserts a diagnosis, in the shape the endpoint verifies. */
const DIAGNOSED = { ...REPORT, rootCause: ROOT_CAUSE }

const VERIFIER = 'agent.skeleton-crew-myapp-verifier'

/** The verifier's answer, as it would arrive from an outbox. */
function verdictMessage(query: Message, body: Record<string, unknown>, from = VERIFIER): Message {
  return composeMessage({
    id: makeMessageId(new Date('2026-08-31T10:20:00.000Z'), 'ver1'),
    conversation: query.conversation,
    in_reply_to: query.id,
    from,
    to: HARBOR_ENDPOINT,
    act: 'inform',
    subject: VERDICT_SUBJECT,
    body: JSON.stringify(body),
    hops: 1,
    created_at: '2026-08-31T10:20:00.000Z'
  })
}

const VERDICT = {
  schemaVersion: 1,
  kind: 'root-cause-verdict',
  incident: 'owner/app#ci-run:4021',
  verdict: 'refute',
  because: 'line 122 already reads `now: datetime | None = None`, documented, and threads it on',
  read: [
    {
      file: 'musahit/arcs/linker.py',
      line: 122,
      quote: 'async def run(self, run_id: str, now: datetime | None = None)'
    }
  ]
}

describe('a root cause is checked by somebody who did not write it', () => {
  it('asks the verifier to refute it, carrying the claim and its citations', () => {
    const { endpoint, delivered, logged } = rig()
    endpoint.raise([ciRun()])
    endpoint.onTriage(triage(delivered[0] as Message, DIAGNOSED))

    const query = delivered.at(-1)
    expect(query?.to).toBe(VERIFIER)
    expect(query?.from).toBe(HARBOR_ENDPOINT)
    // `query` obligates a reply and routes an `inform` back here. A `request`
    // would read as "do this work"; what is wanted is an answer, and one of the
    // legal answers is "cannot tell".
    expect(query?.act).toBe('query')
    const vars = JSON.parse(query?.body ?? '{}') as Record<string, string>
    // The claim and the citations verbatim — the harness carries what the agent
    // wrote and adds no reading of its own.
    expect(vars.claim).toBe(ROOT_CAUSE.claim)
    expect(vars.cites).toContain('musahit/arcs/linker.py:122')
    expect(vars.claimedBy).toBe('agent.skeleton-crew-myapp-ci-babysitter')
    expect(
      logged.find((row) => row.event === 'incident-root-cause-verification-requested')
    ).toMatchObject({ incident: 'owner/app#ci-run:4021', verifier: VERIFIER })
  })

  it('asks nobody when the report asserted no root cause', () => {
    const { endpoint, delivered, logged } = rig()
    endpoint.raise([ciRun()])
    endpoint.onTriage(triage(delivered[0] as Message, REPORT))
    // Most triage has no diagnosis to offer, and "could not retrieve the run
    // log" is a complete result. Spending an agent turn on every report would
    // make the check the most expensive thing in the subsystem.
    expect(delivered.some((message) => message.to === VERIFIER)).toBe(false)
    expect(logged.some((row) => row.event === 'incident-root-cause-verification-requested')).toBe(
      false
    )
  })

  it('records the reason when no verifier is available, rather than falling silent', () => {
    const { endpoint, delivered, logged } = rig([BINDING], { verifier: null })
    endpoint.raise([ciRun()])
    endpoint.onTriage(triage(delivered[0] as Message, DIAGNOSED))

    expect(delivered.some((message) => message.to === VERIFIER)).toBe(false)
    // "Nobody checked this diagnosis" is a fact about the record. A company
    // with no verifier hire gets triaged, unverified incidents and can see that
    // it does.
    expect(logged.find((row) => row.event === 'incident-root-cause-unverified')).toMatchObject({
      incident: 'owner/app#ci-run:4021',
      because: 'no independent verifier is available on this instance'
    })
  })

  it('refuses to let the author verify their own claim', () => {
    const oncall = 'agent.skeleton-crew-myapp-ci-babysitter'
    const { endpoint, delivered, logged } = rig([BINDING], {
      verifier: oncall
    })
    endpoint.raise([ciRun()])
    endpoint.onTriage(triage(delivered[0] as Message, DIAGNOSED))

    // Self-verification is worse than none: it produces a record that looks
    // checked. The resolver in `index.ts` excludes the author too; this is the
    // rule kept where it is a rule rather than a lookup.
    expect(delivered.some((message) => message.act === 'query')).toBe(false)
    expect(logged.find((row) => row.event === 'incident-root-cause-unverified')).toMatchObject({
      because: 'the only available verifier is the agent who wrote the report'
    })
  })

  it('buys exactly one verification per incident, however often it is reported', () => {
    const { endpoint, delivered, logged } = rig()
    endpoint.raise([ciRun()])
    const report = triage(delivered[0] as Message, DIAGNOSED)
    endpoint.onTriage(report)
    // A second report on the same incident — a corrected re-send, a duplicate
    // from an agent that lost track. A verification is a whole agent turn on
    // somebody else's budget and must not be bought twice.
    //
    // This is asserted against the mechanism that actually provides it: the
    // incident stops awaiting triage on the first accepted report, so the
    // second is refused before `verify` is reached. An explicit
    // "already verified" guard stood here first and its regression passed with
    // the guard deleted — a second cost control over an idempotency that was
    // already total, and an assertion that could not fail.
    expect(endpoint.onTriage(report)).toBeNull()
    expect(delivered.at(-1)?.act).toBe('refuse')
    expect(delivered.filter((message) => message.act === 'query')).toHaveLength(1)
    expect(
      logged.filter((row) => row.event === 'incident-root-cause-verification-requested')
    ).toHaveLength(1)
  })

  it('never delays an escalation to wait for a verdict', () => {
    const { endpoint, delivered, escalated, unmet, logged } = rig()
    endpoint.raise([ciRun()])
    const escalation = endpoint.onTriage(
      triage(delivered[0] as Message, { ...DIAGNOSED, severity: 1 })
    )
    // UC-09 step 4's alarm does not wait for a second pair of eyes to open a
    // file. The verification goes out beside the escalation, not in front of it.
    expect(escalation?.escalateNow).toBe(true)
    expect(escalated).toEqual(['owner/app#ci-run:4021'])
    expect(unmet).toHaveLength(1)
    expect(delivered.some((message) => message.to === VERIFIER)).toBe(true)
    // …and in that order, which is the part a refactor could quietly reverse.
    // Everything the escalation owes is on the record before the second opinion
    // is even asked for.
    const events = logged.map((row) => row.event)
    expect(events.indexOf('incident-triaged')).toBeLessThan(
      events.indexOf('incident-root-cause-verification-requested')
    )
    expect(events.indexOf('incident-announce-owed')).toBeLessThan(
      events.indexOf('incident-root-cause-verification-requested')
    )
  })
})

describe('the verdict is recorded BESIDE the claim, never in place of it', () => {
  it('logs both sides verbatim, and leaves the triage entry untouched', () => {
    const { endpoint, delivered, logged } = rig()
    endpoint.raise([ciRun()])
    endpoint.onTriage(triage(delivered[0] as Message, DIAGNOSED))
    const query = delivered.at(-1) as Message
    const recorded = endpoint.onVerdict(verdictMessage(query, VERDICT))

    expect(recorded?.verdict).toBe('refute')
    expect(logged.find((row) => row.event === 'incident-root-cause-verdict')).toMatchObject({
      incident: 'owner/app#ci-run:4021',
      verdict: 'refute',
      verifier: VERIFIER,
      claim: ROOT_CAUSE.claim,
      because: VERDICT.because
    })
    // The Architect's standing position, asserted: the triage report still
    // stands exactly as written. The verifier is another agent reading the same
    // repository under the same pressures, and a system that let one reading
    // overwrite another would have swapped a confident wrong claim for a
    // confident wrong correction.
    expect(logged.find((row) => row.event === 'incident-triaged')).toMatchObject({
      summary: REPORT.summary,
      severity: 2
    })
  })

  it('tells the claimant when their root cause is refuted, with the evidence', () => {
    const { endpoint, delivered } = rig()
    endpoint.raise([ciRun()])
    endpoint.onTriage(triage(delivered[0] as Message, DIAGNOSED))
    endpoint.onVerdict(verdictMessage(delivered.at(-1) as Message, VERDICT))

    const note = delivered.at(-1)
    expect(note?.to).toBe('agent.skeleton-crew-myapp-ci-babysitter')
    // An `inform`: the agent is not being asked to defend itself or re-report.
    // It is being told the one thing the previous run never told anybody.
    expect(note?.act).toBe('inform')
    const vars = JSON.parse(note?.body ?? '{}') as Record<string, string>
    expect(vars.verifier).toBe(VERIFIER)
    expect(vars.because).toBe(VERDICT.because)
    expect(vars.read).toContain('musahit/arcs/linker.py:122')
  })

  it('says nothing to the claimant when the verdict agrees', () => {
    const { endpoint, delivered, logged } = rig()
    endpoint.raise([ciRun()])
    endpoint.onTriage(triage(delivered[0] as Message, DIAGNOSED))
    const before = delivered.length
    endpoint.onVerdict(
      verdictMessage(delivered.at(-1) as Message, {
        ...VERDICT,
        verdict: 'agree'
      })
    )
    // A confirmation is in the log for anyone who looks. Mailing it would train
    // agents to skim the one message that matters.
    expect(delivered).toHaveLength(before)
    expect(logged.find((row) => row.event === 'incident-root-cause-verdict')).toMatchObject({
      verdict: 'agree'
    })
  })

  it('changes nothing about the escalation the on-call agent decided', () => {
    const { endpoint, delivered, escalated } = rig()
    endpoint.raise([ciRun()])
    endpoint.onTriage(triage(delivered[0] as Message, DIAGNOSED))
    endpoint.onVerdict(verdictMessage(delivered.at(-1) as Message, VERDICT))
    // The severity was the agent's call (UC-09 step 2) and a disputed diagnosis
    // does not make an incident milder — often the reverse. A refutation reaches
    // the Architect through the log and the standup, not by moving a rung.
    expect(escalated).toEqual([])
  })
})

describe('a verdict that cannot be trusted is refused, not recorded', () => {
  it('refuses an unreadable verdict back to the verifier', () => {
    const { endpoint, delivered, logged } = rig()
    endpoint.raise([ciRun()])
    endpoint.onTriage(triage(delivered[0] as Message, DIAGNOSED))
    const query = delivered.at(-1) as Message
    const broken: Record<string, unknown> = { ...VERDICT }
    delete broken.verdict

    expect(endpoint.onVerdict(verdictMessage(query, broken))).toBeNull()
    expect(delivered.at(-1)?.act).toBe('refuse')
    expect(delivered.at(-1)?.to).toBe(VERIFIER)
    expect(logged.find((row) => row.event === 'incident-verdict-refused')).toBeDefined()
  })

  it('refuses a refutation that quotes nothing it read', () => {
    const { endpoint, delivered, logged } = rig()
    endpoint.raise([ciRun()])
    endpoint.onTriage(triage(delivered[0] as Message, DIAGNOSED))
    const query = delivered.at(-1) as Message

    expect(endpoint.onVerdict(verdictMessage(query, { ...VERDICT, read: [] }))).toBeNull()
    expect(delivered.at(-1)?.body).toContain('must quote what it read')
    // …and nothing was written down. An unevidenced refutation must not reach
    // the record at all, or the standup would narrate a dispute nobody can check.
    expect(logged.some((row) => row.event === 'incident-root-cause-verdict')).toBe(false)
  })

  it('refuses a verdict from an agent nobody asked', () => {
    const { endpoint, delivered } = rig()
    endpoint.raise([ciRun()])
    endpoint.onTriage(triage(delivered[0] as Message, DIAGNOSED))
    const query = delivered.at(-1) as Message

    // Accepting a volunteer would mean the claim's own author could file a
    // verdict on their own claim, and the independence is worth more than the
    // volunteer.
    expect(
      endpoint.onVerdict(verdictMessage(query, VERDICT, 'agent.skeleton-crew-myapp-ci-babysitter'))
    ).toBeNull()
    expect(delivered.at(-1)?.act).toBe('refuse')
  })

  it('refuses a verdict whose body names a different incident than the thread', () => {
    const { endpoint, delivered, logged } = rig()
    endpoint.raise([ciRun()])
    endpoint.onTriage(triage(delivered[0] as Message, DIAGNOSED))
    const query = delivered.at(-1) as Message

    // Right thread, wrong key — a verifier holding two queries answering one
    // with the other's incident. The disagreement means the reading may have
    // been done against a different repository, so the thread is not trusted
    // over the body: both must agree or neither is believed.
    expect(
      endpoint.onVerdict(verdictMessage(query, { ...VERDICT, incident: 'owner/app#ci-run:9999' }))
    ).toBeNull()
    expect(delivered.at(-1)?.act).toBe('refuse')
    expect(delivered.at(-1)?.body).toContain('owner/app#ci-run:4021')
    expect(logged.some((row) => row.event === 'incident-root-cause-verdict')).toBe(false)
  })

  it('refuses a verdict on a root cause nobody sent for verification', () => {
    const { endpoint, delivered } = rig()
    endpoint.raise([ciRun()])
    endpoint.onTriage(triage(delivered[0] as Message, REPORT))
    const stray = composeMessage({
      id: makeMessageId(new Date('2026-08-31T10:20:00.000Z'), 'stray'),
      conversation: 'c-stray',
      in_reply_to: null,
      from: VERIFIER,
      to: HARBOR_ENDPOINT,
      act: 'inform',
      subject: VERDICT_SUBJECT,
      body: JSON.stringify(VERDICT),
      hops: 1,
      created_at: '2026-08-31T10:20:00.000Z'
    })

    expect(endpoint.onVerdict(stray)).toBeNull()
    expect(delivered.at(-1)?.act).toBe('refuse')
  })

  it('does not record the same verdict twice', () => {
    const { endpoint, delivered, logged } = rig()
    endpoint.raise([ciRun()])
    endpoint.onTriage(triage(delivered[0] as Message, DIAGNOSED))
    const query = delivered.at(-1) as Message
    const answer = verdictMessage(query, VERDICT)

    expect(endpoint.onVerdict(answer)?.verdict).toBe('refute')
    expect(endpoint.onVerdict(answer)).toBeNull()
    expect(logged.filter((row) => row.event === 'incident-root-cause-verdict')).toHaveLength(1)
  })
})

/**
 * Every message this path emits must be one an agent can actually read.
 *
 * `deliverFromHarness` writes straight into an inbox without parsing, so a
 * harness-composed message that violates the envelope schema is not refused
 * here — it lands, and fails when the RECIPIENT's reply is validated, or when
 * anything reads the file back. `Message.conversation` is capped at 64
 * characters and an incident key is `<owner>/<repo>#ci-run:<run id>`, which a
 * long enough repository name pushes over. That is a defect nothing else in the
 * suite would notice, because every fixture repo in it is called `owner/app`.
 */
describe('the mail this path writes is legal mail', () => {
  const LONG_REPO = 'an-organisation-with-a-long-name/a-repository-with-an-even-longer-name'

  it('emits a parseable query and dispute note even for a long repository name', () => {
    const binding: IncidentBinding = { ...BINDING, repos: [LONG_REPO] }
    const { endpoint, delivered } = rig([binding])
    endpoint.raise([ciRun({ repo: LONG_REPO })])
    const incident = `${LONG_REPO}#ci-run:4021`
    expect(incident.length).toBeGreaterThan(64)

    endpoint.onTriage(triage(delivered[0] as Message, { ...DIAGNOSED, incident }))
    const query = delivered.at(-1) as Message
    endpoint.onVerdict(verdictMessage(query, { ...VERDICT, incident }))

    // Round-tripped through the validator an agent's own mail goes through.
    for (const message of delivered) {
      const parsed = parseMessage(message)
      expect(parsed.ok ? '' : `${message.subject}: ${parsed.reason}`).toBe('')
    }
    expect(delivered.at(-1)?.to).toBe(BINDING.agentId)
  })
})

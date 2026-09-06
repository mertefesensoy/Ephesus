import { describe, expect, it } from 'vitest'
import { foldIncidents } from '../../src/shared/incident-view'
import { logEntrySchema, type LogEntry } from '../../src/shared/log'

/**
 * The incident surface's fold (B14).
 *
 * The question this package had to answer before drawing anything was
 * ADR-0027's — held, or derived? Derived: §5 of that ADR already records
 * incident correlation as state the harness deliberately does not persist, and
 * its closing line forbids persisting what a live subsystem re-derives from a
 * durable source. So the panel reads the book of record, and this is the read.
 *
 * Every fixture below is built through `logEntrySchema`, so a row this test
 * asserts on is a row the appender could actually have written. A hand-rolled
 * object literal would let the fold be proved against a shape that never
 * reaches it.
 */

let seq = 0

function row(fields: Record<string, unknown>): LogEntry {
  seq += 1
  return logEntrySchema.parse({
    kind: 'profile',
    ts: 1_800_000_000_000 + seq * 1_000,
    seq,
    ...fields
  })
}

const KEY = 'owner/app#ci-run:4021'

const raised = (over: Record<string, unknown> = {}): LogEntry =>
  row({
    event: 'incident-raised',
    instanceId: 'skeleton-crew@repo:myapp',
    incident: KEY,
    repo: 'owner/app',
    ref: 4021,
    conclusion: 'failure',
    oncall: 'agent.ci-babysitter',
    playbook: 'incident.md',
    msgId: '2026-08-31T10-00-00-000Z-incf1',
    ...over
  })

const triaged = (over: Record<string, unknown> = {}): LogEntry =>
  row({
    event: 'incident-triaged',
    instanceId: 'skeleton-crew@repo:myapp',
    incident: KEY,
    by: 'agent.ci-babysitter',
    severity: 2,
    resolved: false,
    summary: 'the window cutoff falls before the fixture timestamps',
    escalateNow: false,
    announceNow: false,
    ...over
  })

describe('foldIncidents', () => {
  it('opens a row from the raised event and carries its facts', () => {
    const board = foldIncidents([raised()])
    const [incident] = board.incidents
    expect(incident?.key).toBe(KEY)
    expect(incident?.repo).toBe('owner/app')
    expect(incident?.ref).toBe(4021)
    expect(incident?.oncall).toBe('agent.ci-babysitter')
    expect(incident?.stage).toBe('awaiting-triage')
    expect(incident?.severity).toBeNull()
  })

  it('carries the summary and severity the agent reported, unrewritten', () => {
    const board = foldIncidents([raised(), triaged()])
    const [incident] = board.incidents
    expect(incident?.stage).toBe('triaged')
    expect(incident?.severity).toBe(2)
    expect(incident?.summary).toBe('the window cutoff falls before the fixture timestamps')
    expect(incident?.triagedBy).toBe('agent.ci-babysitter')
  })

  it('shows a refusal AS a refusal, on the incident it was about', () => {
    // The whole point. 12 of 21 triage attempts on the Architect's machine were
    // refused and nothing anywhere showed one.
    const board = foldIncidents([
      raised(),
      row({
        event: 'incident-triage-refused',
        incident: KEY,
        from: 'agent.artemis',
        reasons: ['the triage of an incident belongs to its on-call agent, not to you']
      })
    ])
    const [incident] = board.incidents
    expect(incident?.refusals).toHaveLength(1)
    expect(incident?.refusals[0]?.from).toBe('agent.artemis')
    expect(incident?.refusals[0]?.of).toBe('triage')
    expect(board.unattributedRefusals).toHaveLength(0)
  })

  it('keeps a refusal that names no incident instead of dropping it', () => {
    // The parse-failure path is exactly where the key is unknowable, and it is
    // the loudest instance of the defect. A fold that dropped these would make
    // the panel report FEWER refusals than happened.
    const board = foldIncidents([
      raised(),
      row({
        event: 'incident-triage-refused',
        incident: null,
        from: 'agent.artemis',
        reasons: ['triage report: not JSON']
      })
    ])
    expect(board.incidents[0]?.refusals).toHaveLength(0)
    expect(board.unattributedRefusals).toHaveLength(1)
    expect(board.unattributedRefusals[0]?.reasons).toEqual(['triage report: not JSON'])
  })

  it('does not attach a refusal to an incident it has never seen raised', () => {
    // A guessed attribution is worse than none: a refusal filed against the
    // wrong incident is a fact nobody can correct.
    const board = foldIncidents([
      row({
        event: 'incident-verdict-refused',
        incident: 'owner/other#ci-run:9',
        from: 'agent.verifier',
        reasons: ['because: 4231 characters, and the limit is 2000']
      })
    ])
    expect(board.incidents).toHaveLength(0)
    expect(board.unattributedRefusals).toHaveLength(1)
    expect(board.unattributedRefusals[0]?.of).toBe('verdict')
  })

  it('reads the same however the entries are ordered', () => {
    // A single pass happens to be right on an append-only file read oldest
    // first, and "right given the order it is called with" is the coupling that
    // becomes a bug the first time somebody pages backwards.
    const entries = [
      raised(),
      row({
        event: 'incident-triage-refused',
        incident: KEY,
        from: 'agent.artemis',
        reasons: ['x']
      })
    ]
    const forward = foldIncidents(entries)
    const backward = foldIncidents([...entries].reverse())
    expect(backward.incidents[0]?.refusals).toHaveLength(1)
    expect(backward.unattributedRefusals).toEqual(forward.unattributedRefusals)
  })

  it('follows a root cause from asked to answered', () => {
    const asked = foldIncidents([
      raised(),
      triaged(),
      row({
        event: 'incident-root-cause-verification-requested',
        incident: KEY,
        verifier: 'agent.verifier',
        claimedBy: 'agent.ci-babysitter',
        claim: 'run() has no injectable clock',
        cites: ['linker.py:122']
      })
    ])
    expect(asked.incidents[0]?.stage).toBe('verifying')
    expect(asked.incidents[0]?.verification?.verdict).toBeNull()

    const answered = foldIncidents([
      raised(),
      triaged(),
      row({
        event: 'incident-root-cause-verification-requested',
        incident: KEY,
        verifier: 'agent.verifier',
        claim: 'run() has no injectable clock'
      }),
      row({
        event: 'incident-root-cause-verdict',
        incident: KEY,
        verifier: 'agent.verifier',
        verdict: 'refute',
        claim: 'run() has no injectable clock',
        because: 'line 122 takes now: datetime | None = None',
        read: ['linker.py:122']
      })
    ])
    expect(answered.incidents[0]?.stage).toBe('triaged')
    expect(answered.incidents[0]?.verification?.verdict).toBe('refute')
    expect(answered.incidents[0]?.verification?.because).toBe(
      'line 122 takes now: datetime | None = None'
    )
    expect(answered.incidents[0]?.verification?.read).toEqual(['linker.py:122'])
  })

  it('says when nobody checked the diagnosis', () => {
    // An unverified claim reads exactly like a verified one three weeks later.
    const board = foldIncidents([
      raised(),
      triaged(),
      row({
        event: 'incident-root-cause-unverified',
        incident: KEY,
        by: 'agent.ci-babysitter',
        because: 'no independent verifier is available on this instance'
      })
    ])
    expect(board.incidents[0]?.unverifiedBecause).toBe(
      'no independent verifier is available on this instance'
    )
    expect(board.incidents[0]?.verification).toBeNull()
  })

  it('carries an escalation the harness owes and could not deliver', () => {
    const board = foldIncidents([
      raised(),
      triaged({ severity: 1, announceNow: true }),
      row({ event: 'incident-announce-owed', incident: KEY, because: 'herald-unwired' })
    ])
    expect(board.incidents[0]?.owed).toEqual(['herald-unwired'])
  })

  it('keeps a declination as an aside, not as a triage', () => {
    const board = foldIncidents([
      raised(),
      row({
        event: 'incident-triage-declined',
        incident: KEY,
        from: 'agent.ci-babysitter',
        because: 'I am out of budget'
      })
    ])
    expect(board.incidents[0]?.stage).toBe('awaiting-triage')
    expect(board.incidents[0]?.asides[0]?.act).toBe('declined')
    expect(board.incidents[0]?.asides[0]?.because).toBe('I am out of budget')
  })

  it('lists a CI failure nobody was on call for', () => {
    const board = foldIncidents([
      row({
        event: 'incident-unclaimed',
        repo: 'owner/unwatched',
        ref: 77,
        because: 'no live profile instance watches this repository'
      })
    ])
    expect(board.unclaimed).toEqual([
      {
        repo: 'owner/unwatched',
        ref: 77,
        because: 'no live profile instance watches this repository',
        at: expect.any(Number) as number
      }
    ])
  })

  it('treats a re-raise after a restart as the same incident, raised when it first was', () => {
    // ADR-0027 §5: a restart SHOULD re-raise a still-failing incident. Two rows
    // are one incident — and `raisedAt` is the FIRST sighting, which is the
    // half a count cannot check: a Map key overwrites, so dropping the guard
    // leaves one row and quietly restamps a build that has been failing since
    // Monday as having been raised this morning, moving it in a list ordered
    // newest first.
    const first = raised()
    const refusal = row({
      event: 'incident-triage-refused',
      incident: KEY,
      from: 'agent.artemis',
      reasons: ['x']
    })
    const again = raised()
    expect(again.ts).toBeGreaterThan(first.ts)

    const board = foldIncidents([first, refusal, again])
    expect(board.incidents).toHaveLength(1)
    expect(board.incidents[0]?.refusals).toHaveLength(1)
    expect(board.incidents[0]?.raisedAt).toBe(first.ts)
  })

  it('opens at the end of the book — newest incident first', () => {
    // Raised first, so the second row really is the later one; the fixture's
    // own ordering is what the assertion is about.
    const earlier = raised()
    const later = row({
      event: 'incident-raised',
      incident: 'owner/app#ci-run:5000',
      repo: 'owner/app',
      ref: 5000,
      conclusion: 'failure',
      oncall: 'agent.ci-babysitter',
      playbook: 'incident.md'
    })
    const board = foldIncidents([earlier, later])
    expect(board.incidents.map((incident) => incident.ref)).toEqual([5000, 4021])
  })

  it('ignores rows that are not the incident path', () => {
    const board = foldIncidents([
      logEntrySchema.parse({ kind: 'spawn', ts: 1, seq: 900, agentId: 'agent.artemis' }),
      logEntrySchema.parse({ kind: 'profile', ts: 2, seq: 901, event: 'trigger-fired' }),
      raised()
    ])
    expect(board.incidents).toHaveLength(1)
  })

  it('skips a raised row missing the fields it needs rather than inventing them', () => {
    // A reader's job is to read what is there. An incident with no repository
    // would render as a card about nothing.
    const board = foldIncidents([row({ event: 'incident-raised', incident: KEY, ref: 4021 })])
    expect(board.incidents).toHaveLength(0)
  })
})

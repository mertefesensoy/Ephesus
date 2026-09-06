// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  IncidentsPanel,
  refusalLine,
  verificationLine
} from '../../src/renderer/src/IncidentsPanel'
import { foldIncidents, type IncidentBoard, type IncidentRow } from '../../src/shared/incident-view'
import { logEntrySchema, type LogEntry } from '../../src/shared/log'
import type { EphApi } from '../../src/shared/ipc'

/**
 * The incident surface (B14).
 *
 * The rule it exists to keep is one sentence long — **a refusal renders as a
 * refusal, never as an absence** — and it is the whole reason a panel is worth
 * building here. The log already held 21 triage attempts of which 12 were
 * refused, and 3 verifications of which none ever completed; a panel listing
 * only what went well would have been an improvement on nothing and would still
 * have hidden all of that.
 *
 * The board this renders is produced by the REAL fold over rows built through
 * the REAL log schema, so the panel is proved against data the appender could
 * actually have written rather than against a shape invented for the test.
 */

let root: Root | null = null
let host: HTMLDivElement

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  delete (window as { eph?: unknown }).eph
})

let seq = 0

function logRow(fields: Record<string, unknown>): LogEntry {
  seq += 1
  return logEntrySchema.parse({
    kind: 'profile',
    ts: 1_800_000_000_000 + seq * 1_000,
    seq,
    ...fields
  })
}

const KEY = 'owner/app#ci-run:4021'

const RAISED = (): LogEntry =>
  logRow({
    event: 'incident-raised',
    instanceId: 'skeleton-crew@repo:myapp',
    incident: KEY,
    repo: 'owner/app',
    ref: 4021,
    conclusion: 'failure',
    oncall: 'agent.ci-babysitter',
    playbook: 'incident.md'
  })

/** Only the one method this panel calls, typed against the real contract. */
interface HarborBridge {
  readonly harbor: Pick<EphApi['harbor'], 'incidents'>
}

async function mount(answer: () => Promise<IncidentBoard>): Promise<void> {
  const stub: HarborBridge = { harbor: { incidents: answer } }
  Object.assign(window, { eph: stub })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<IncidentsPanel />)
  })
}

const shown = (): string => host.textContent ?? ''

describe('the incident panel', () => {
  it('shows a refusal as a refusal, with who was refused and why', async () => {
    const board = foldIncidents([
      RAISED(),
      logRow({
        event: 'incident-triage-refused',
        incident: KEY,
        from: 'agent.artemis',
        reasons: ['the triage of an incident belongs to its on-call agent, not to you']
      })
    ])
    await mount(() => Promise.resolve(board))

    expect(shown()).toContain('refused once — agent.artemis')
    expect(shown()).toContain('belongs to its on-call agent')
    expect(shown()).toContain('owner/app #4021')
  })

  it('shows a refusal the log cannot attribute, rather than swallowing it', async () => {
    // The parse-failure path, which is where the loudest instance of the
    // defect actually lands: nine of the twelve refusals on the Architect's
    // machine could name no incident.
    const board = foldIncidents([
      RAISED(),
      logRow({
        event: 'incident-triage-refused',
        incident: null,
        from: 'agent.artemis',
        reasons: ['triage report: not JSON']
      })
    ])
    await mount(() => Promise.resolve(board))

    expect(shown()).toContain('REFUSED, INCIDENT UNKNOWN')
    expect(shown()).toContain('triage report: not JSON')
  })

  it('says an unread log could not be read, never "no incidents"', async () => {
    // "Nothing has happened" and "we could not find out" are different facts,
    // and rendering the second as the first is a degradation failing as GOOD
    // news — the one direction invariant §7 does not allow.
    await mount(() => Promise.reject(new Error('the bridge is gone')))
    expect(shown()).toContain('could not read the book of record')
    expect(shown()).not.toContain('no incident has been raised')
  })

  it('carries the summary verbatim once it is triaged', async () => {
    const board = foldIncidents([
      RAISED(),
      logRow({
        event: 'incident-triaged',
        incident: KEY,
        by: 'agent.ci-babysitter',
        severity: 2,
        resolved: false,
        summary: 'the window cutoff falls before the fixture timestamps'
      })
    ])
    await mount(() => Promise.resolve(board))
    expect(shown()).toContain('the window cutoff falls before the fixture timestamps')
    expect(shown()).toContain('severity 2')
    expect(shown()).toContain('triaged')
  })

  it('shows an owed escalation nothing delivered', async () => {
    const board = foldIncidents([
      RAISED(),
      logRow({ event: 'incident-announce-owed', incident: KEY, because: 'herald-unwired' })
    ])
    await mount(() => Promise.resolve(board))
    expect(shown()).toContain('owed: herald-unwired')
  })

  it('says so plainly when nothing has been raised', async () => {
    await mount(() => Promise.resolve({ incidents: [], unclaimed: [], unattributedRefusals: [] }))
    expect(shown()).toContain('no incident has been raised')
  })
})

const row = (over: Partial<IncidentRow>): IncidentRow => ({
  key: KEY,
  instanceId: null,
  repo: 'owner/app',
  ref: 4021,
  conclusion: 'failure',
  oncall: 'agent.ci-babysitter',
  playbook: 'incident.md',
  raisedAt: 0,
  stage: 'triaged',
  severity: 2,
  summary: null,
  resolved: null,
  triagedBy: 'agent.ci-babysitter',
  verification: null,
  unverifiedBecause: null,
  owed: [],
  refusals: [],
  asides: [],
  ...over
})

describe('the panel copy', () => {
  it('says nothing rather than "0 refusals"', () => {
    // A count of zero in a list of counts is noise; a count of nine is the
    // finding. The absence of a line is the right rendering of the absence of
    // a refusal — and the ONLY place in this panel where that is true.
    expect(refusalLine([])).toBeNull()
  })

  it('names every distinct sender once, however many times they were refused', () => {
    const line = refusalLine([
      { of: 'triage', from: 'agent.artemis', reasons: ['a'], at: 1, seq: 1 },
      { of: 'triage', from: 'agent.artemis', reasons: ['b'], at: 2, seq: 2 },
      { of: 'verdict', from: 'agent.verifier', reasons: ['c'], at: 3, seq: 3 }
    ])
    expect(line).toBe('refused 3 times — agent.artemis, agent.verifier')
  })

  it('says nobody checked the diagnosis, and why', () => {
    expect(
      verificationLine(row({ unverifiedBecause: 'no independent verifier is available' }))
    ).toBe('unverified — no independent verifier is available')
  })

  it('distinguishes a verifier who has not answered from one who could not tell', () => {
    expect(
      verificationLine(
        row({
          verification: {
            verifier: 'agent.verifier',
            claim: 'c',
            verdict: null,
            because: null,
            read: []
          }
        })
      )
    ).toBe('awaiting agent.verifier')
    expect(
      verificationLine(
        row({
          verification: {
            verifier: 'agent.verifier',
            claim: 'c',
            verdict: 'cannot-tell',
            because: 'the branch is gone',
            read: []
          }
        })
      )
    ).toBe('cannot-tell — agent.verifier')
  })

  it('says nothing about a root cause nobody claimed', () => {
    expect(verificationLine(row({}))).toBeNull()
  })
})

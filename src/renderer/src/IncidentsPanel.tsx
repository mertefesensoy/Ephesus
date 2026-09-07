import { useEffect, useState, type ReactElement } from 'react'
import type {
  IncidentBoard,
  IncidentRefusal,
  IncidentRow,
  IncidentStage
} from '../../shared/incident-view'
import type { EphApi } from '../../shared/ipc'

/**
 * The incident surface (B14, FR-9.2, UC-09, SDD §7.5).
 *
 * ## What was invisible, and it was not the incidents
 *
 * On the first real repository this company was pointed at, the log held 21
 * triage attempts of which **12 were refused**, and 3 root-cause verifications
 * of which **3 were refused and none ever completed**. Every one of those facts
 * was written down, append-only, the whole time. None of it was anywhere a
 * person would look, and the Architect's only evidence that the incident path
 * was working was that it had not obviously stopped.
 *
 * So the rule this panel is built around is narrow and load-bearing: **a
 * refusal renders as a refusal, never as an absence.** A panel that listed the
 * nine incidents that went well would have been an improvement on nothing and
 * would still have hidden the twelve that did not. Three consequences:
 *
 *  - refusals are on the incident, counted, with the sender and the reasons;
 *  - refusals the log cannot attribute get their own section rather than being
 *    dropped, because the parse-failure path — the loudest instance of the
 *    defect — is exactly where the incident key is unknowable;
 *  - "nobody checked this diagnosis" and "this severity-1 owes an announcement
 *    nothing delivered" are shown as the standing facts they are (invariant §7).
 *
 * It renders inside PROFILES rather than as a fourteenth tab: UI-DESIGN §4
 * enumerates the tabs and there is no Incidents among them, and the incident
 * path belongs to a profile instance — the binding comes from an activation
 * plan's `ci` trigger, and every row it reads is `kind: 'profile'`.
 */

const heading = {
  fontFamily: 'var(--eph-face-display)',
  fontSize: '8px',
  fontWeight: 'normal',
  margin: '12px 0 6px'
} as const

const data = { fontFamily: 'var(--eph-face-data)', fontSize: '12px' } as const

const card = {
  ...data,
  border: '1px solid var(--eph-ink-700)',
  padding: '6px 8px',
  marginBottom: '6px'
} as const

/** Contract: pure. §9 copy voice for how far along an incident is. */
export function stageLabel(stage: IncidentStage): string {
  if (stage === 'awaiting-triage') return 'awaiting triage'
  if (stage === 'verifying') return 'root cause with a verifier'
  return 'triaged'
}

/** The §2.4 status token a stage is painted in. */
function stageTone(row: IncidentRow): string {
  if (row.refusals.length > 0) return 'var(--eph-status-blocked)'
  if (row.stage === 'awaiting-triage') return 'var(--eph-status-working)'
  return 'var(--eph-status-success)'
}

/**
 * Contract: pure. What the panel says about an incident's REFUSALS.
 *
 * Returns null when there were none — and the caller renders nothing rather
 * than "0 refusals", because a count of zero in a list of counts is noise while
 * a count of nine is the finding.
 */
export function refusalLine(refusals: readonly IncidentRefusal[]): string | null {
  if (refusals.length === 0) return null
  const senders = [...new Set(refusals.map((refusal) => refusal.from))].sort()
  const times = refusals.length === 1 ? 'once' : `${String(refusals.length)} times`
  return `refused ${times} — ${senders.join(', ')}`
}

/**
 * Contract: pure. The verification sentence, or why there is not one.
 *
 * "Nobody checked this diagnosis" is a fact about the record, so it is a
 * SENTENCE here rather than an empty space: an unverified claim that reads like
 * a verified one three weeks later is the failure the whole verification path
 * exists to prevent, and a panel that showed nothing would reproduce it.
 */
export function verificationLine(row: IncidentRow): string | null {
  if (row.verification === null) {
    return row.unverifiedBecause === null ? null : `unverified — ${row.unverifiedBecause}`
  }
  if (row.verification.verdict === null) {
    return `awaiting ${row.verification.verifier}`
  }
  return `${row.verification.verdict} — ${row.verification.verifier}`
}

function Refusals({ refusals }: { readonly refusals: readonly IncidentRefusal[] }): ReactElement {
  return (
    <ul style={{ ...data, margin: '4px 0 0', paddingLeft: '16px' }}>
      {refusals.map((refusal) => (
        <li key={`${String(refusal.seq)}-${refusal.of}`} style={{ marginBottom: '2px' }}>
          <span style={{ color: 'var(--eph-status-blocked)' }}>
            {refusal.of} refused · {refusal.from}
          </span>
          {refusal.reasons.length > 0 && <> — {refusal.reasons.join('; ')}</>}
        </li>
      ))}
    </ul>
  )
}

export function IncidentCard({ row }: { readonly row: IncidentRow }): ReactElement {
  const refused = refusalLine(row.refusals)
  const verified = verificationLine(row)
  return (
    <li style={card}>
      <div>
        <span style={{ color: stageTone(row) }}>● {stageLabel(row.stage)}</span>
        {' · '}
        {row.repo} #{row.ref} · {row.conclusion}
      </div>
      <div style={{ color: 'var(--eph-ink-500)' }}>
        on call: {row.oncall} · runbook {row.playbook}
      </div>
      {row.summary !== null && (
        <div style={{ marginTop: '4px' }}>
          {row.severity !== null && <>severity {row.severity} · </>}
          {row.resolved === true ? 'resolved · ' : ''}
          {/* The agent's own sentence, carried verbatim. The harness does not
              rewrite it here any more than it does in the log. */}
          {row.summary}
        </div>
      )}
      {verified !== null && (
        <div style={{ color: 'var(--eph-ink-500)' }}>root cause: {verified}</div>
      )}
      {row.owed.map((what) => (
        <div key={what} style={{ color: 'var(--eph-status-looping)' }}>
          ⚠ owed: {what}
        </div>
      ))}
      {refused !== null && (
        <div style={{ color: 'var(--eph-status-blocked)', marginTop: '4px' }}>⚠ {refused}</div>
      )}
      {row.refusals.length > 0 && <Refusals refusals={row.refusals} />}
    </li>
  )
}

export function IncidentsPanel(): ReactElement {
  const [board, setBoard] = useState<IncidentBoard | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    const eph = window.eph
    if (!eph) return
    /**
     * The bridge group, read defensively, because `window.eph` is a surface the
     * renderer does not own.
     *
     * The type says `harbor` is always there and in the shipped preload it is.
     * This panel is a CHILD of another one, though, so anything that mounts
     * `ProfilesPanel` mounts this too — and a throw here does not degrade this
     * panel, it takes the whole Profiles tab down with it. That is not
     * hypothetical: it happened the moment M8.9 met a `ProfilesPanel` test
     * written on main that stubbed `profiles` and nothing else.
     *
     * So a missing group renders the failure state this panel already has,
     * which is the same rule as the `.catch` below: "we could not read" is a
     * fact worth showing, and it must never be shown as "nothing has happened".
     */
    const harbor: EphApi['harbor'] | undefined = eph.harbor
    if (harbor === undefined) {
      setFailure('the harbor bridge is not available')
      return
    }
    let cancelled = false
    harbor
      .incidents()
      .then((next) => {
        if (!cancelled) setBoard(next)
      })
      .catch((err: unknown) => {
        // Never an empty board on failure: "no incidents" and "we could not
        // read the log" are different facts, and rendering the second as the
        // first is a degradation failing as GOOD news (invariant §7).
        if (!cancelled) setFailure(String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section aria-label="Incidents">
      <h3 style={heading}>INCIDENTS</h3>
      {failure !== null && (
        <p style={{ ...data, color: 'var(--eph-status-blocked)' }}>
          ⚠ could not read the book of record: {failure}
        </p>
      )}
      {failure === null && board === null && <p style={data}>reading the log…</p>}
      {board !== null && board.incidents.length === 0 && (
        <p style={data}>no incident has been raised on this machine.</p>
      )}
      {board !== null && board.incidents.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {board.incidents.map((row) => (
            <IncidentCard key={row.key} row={row} />
          ))}
        </ul>
      )}
      {board !== null && board.unattributedRefusals.length > 0 && (
        <>
          <h3 style={heading}>REFUSED, INCIDENT UNKNOWN</h3>
          {/* Not a leftovers bin. A body that did not parse is exactly where
              the incident key is unknowable, and dropping these would make the
              panel report FEWER refusals than happened — the absence it was
              built to end. */}
          <Refusals refusals={board.unattributedRefusals} />
        </>
      )}
      {board !== null && board.unclaimed.length > 0 && (
        <>
          <h3 style={heading}>UNCLAIMED</h3>
          <ul style={{ ...data, margin: 0, paddingLeft: '16px' }}>
            {board.unclaimed.map((row) => (
              <li key={`${row.repo}#${String(row.ref)}`}>
                {row.repo} #{row.ref} — {row.because}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

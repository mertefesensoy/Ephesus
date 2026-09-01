import { composeMessage, makeMessageId, type Message } from '../shared/message'
import { replyHops } from '../shared/routing'
import { HARBOR_ENDPOINT } from '../shared/reserved'
import {
  checkTriage,
  escalationFor,
  incidentFrom,
  parseTriageReport,
  type Incident,
  type IncidentEscalation,
  type TriageReport
} from '../shared/incident'
import type { InboundItem } from '../shared/harbor'
import { isCiFailure } from '../shared/harbor'

/**
 * The incident endpoint (FR-9.2, UC-09, SDD §7.5 — the Skeleton Crew's spine).
 *
 * SDD §7.5's sequence, and where each arrow actually lands:
 *
 * ```
 * webhook/health trigger ─► profile trigger binding ─► on-call agent task (auto)
 * agent follows playbooks/incident.md: triage → reproduce → playbook fix
 *   fix ok ─► inform Artemis ─► log ─► next brief
 *   needs gated action ─► §7.3 path with incident context; severity-1 → Herald announces now
 * ```
 *
 * The first arrow is this module. A CI run came back failed; the binding in the
 * active profile names an on-call agent and a runbook; and the *task* is
 * created the only way a task can be — by Artemis. `LedgerEndpoint.submit`
 * applies a `propose` the router has already established came from the
 * orchestrator (FR-5.2, FR-4.2), so a harness that wrote `tasks.json` itself
 * would be reaching past the single scribe. It mails her instead, from
 * `agent.harbor`, and she decides what the task says and who gets it.
 *
 * That is not a workaround, it is the ADR-0005 split at the port: **the harness
 * reports what came in; the orchestrator decides what to do about it.** The
 * mail carries the ingested facts verbatim and adds nothing — no diagnosis, no
 * severity, no summary sentence. Inventing any of those here would be the
 * E-BRIEF-FAITH failure wearing a Harbor hat, which is precisely what the M7.3
 * package line warned about.
 *
 * ## What this module does NOT do
 *
 * It does not grade severity. UC-09 step 2 gives triage to the agent, and the
 * escalation table (`src/shared/incident.ts`) is driven by the severity the
 * agent REPORTS, never by anything the harness guessed from a run title.
 *
 * It does not announce. UC-09 step 4 says a severity-1 reaches the Herald
 * immediately, and **M6.9 — wiring the Herald into the application — is
 * deferred indefinitely by Architect decision**. `src/main/herald/` has no
 * production caller and does not gain one here. A severity-1's announcement is
 * therefore recorded as an OWED, UNMET obligation and reported through the
 * ordinary degradation channel (invariant §7), so the gap is a line the
 * Architect can see rather than a promise nothing kept.
 *
 * Electron-free and clock-injectable, like `closing.ts`, so the whole protocol
 * is testable without an app.
 */

/** The subject an on-call agent's triage report must carry. */
export const TRIAGE_SUBJECT = 'INCIDENT-TRIAGE'

export interface RaisedIncident {
  readonly incident: Incident
  /** The message id Artemis was written under, for the audit trail (NFR-13). */
  readonly msgId: string
}

/**
 * One trigger binding, as the active profile declares it — which on-call agent
 * handles incidents for which instance, and which runbook they follow.
 */
export interface IncidentBinding {
  readonly instanceId: string
  readonly agentId: string
  readonly playbook: string
  /** Repositories this instance watches, so an item is routed to its owner. */
  readonly repos: readonly string[]
}

export interface IncidentEndpointOptions {
  /**
   * The `ci` event bindings of every live profile instance. Empty means no
   * profile is on call — which is a fact worth logging, not a reason to
   * invent a recipient.
   */
  bindings(): readonly IncidentBinding[]
  /** Where Artemis's mail goes (`registry.orchestratorId`). */
  orchestratorId(): string
  /** Delivery straight into an inbox (`Hermes.deliverFromHarness`). */
  deliver(message: Message): void
  /**
   * Renders the request's words from `prompts/harbor/incident-*.md`
   * (invariant §8) — this class supplies only the facts in `vars`.
   */
  render(kind: 'subject' | 'body', vars: Record<string, string>): string
  /**
   * Task ids the ledger actually holds, for reconciling what a triage report
   * CLAIMS against what the company can see. Absent means no ledger is wired,
   * and an unverifiable claim is then let through rather than refused on the
   * strength of a check that could not run.
   */
  taskIds?(): readonly string[]
  /** `log.jsonl` kind `profile` (SDD §4.3): raised, triaged, owed. */
  onLogEvent(draft: { kind: 'profile' } & Record<string, unknown>): void
  /**
   * Raised when an escalation this table owes cannot be delivered — today,
   * only a severity-1's announcement, because the Herald is unwired (M6.9,
   * deferred). Surfaces as a visible degradation, never swallowed.
   */
  onUnmetObligation?(what: string): void
  /** Raised when a severity-1 needs the Architect now (UC-08's path). */
  onEscalateNow?(incident: Incident, report: TriageReport): void
  now?(): Date
}

export class IncidentEndpoint {
  /**
   * Incident keys already raised, so a failing run that stays failing does not
   * wake the crew every ten minutes.
   *
   * The Harbor rebuilds its queues from scratch on every ingestion (it holds
   * "what is open now", not "what is new"), so without this the same red run
   * would be news forever. In memory rather than on disk deliberately: a
   * restart SHOULD re-raise a still-failing incident, because after a restart
   * nobody can be sure the earlier request survived in anyone's inbox — and a
   * duplicate incident is a cheap failure, while a dropped one is the whole
   * subsystem not working.
   */
  private readonly raised = new Set<string>()

  /** Raised incidents awaiting a triage report, by the message id sent. */
  private readonly awaiting = new Map<string, Incident>()

  private readonly now: () => Date

  constructor(private readonly options: IncidentEndpointOptions) {
    this.now = options.now ?? (() => new Date())
  }

  /** Incident keys already raised — the idempotency set, for tests and panels. */
  raisedKeys(): readonly string[] {
    return [...this.raised].sort()
  }

  /**
   * Contract: raises every NEW CI failure among `items` and returns what it
   * raised. Idempotent — an item already raised is skipped silently, because
   * the second sighting of the same red run is not a second incident.
   *
   * Routing is by repository: an item is handed to the binding whose profile
   * declared that repo in `harbor.json`. An item no live binding claims is
   * LOGGED and dropped rather than sent to whoever happens to be on call for
   * something else — a crew woken for a repository it was never given is a
   * crew that will edit one.
   */
  raise(items: readonly InboundItem[]): readonly RaisedIncident[] {
    const bindings = this.options.bindings()
    const out: RaisedIncident[] = []

    for (const item of items) {
      if (!isCiFailure(item)) continue

      const binding = bindings.find((candidate) => candidate.repos.includes(item.repo))
      if (binding === undefined) {
        this.options.onLogEvent({
          kind: 'profile',
          event: 'incident-unclaimed',
          repo: item.repo,
          ref: item.ref,
          because: 'no live profile instance watches this repository'
        })
        continue
      }

      const incident = incidentFrom(item, binding)
      if (incident === null) continue
      if (this.raised.has(incident.key)) continue

      const raisedOne = this.send(incident)
      this.raised.add(incident.key)
      out.push(raisedOne)
    }

    return out
  }

  private send(incident: Incident): RaisedIncident {
    const at = this.now()
    const msgId = makeMessageId(at, `inc${incident.ref.toString(36)}`)
    // Facts only, and every one of them copied from what `gh` returned. The
    // words around them come from the prompt file (invariant §8).
    const vars = {
      repo: incident.repo,
      ref: String(incident.ref),
      title: incident.title,
      conclusion: incident.conclusion,
      url: incident.url,
      at: incident.at,
      oncall: incident.agentId,
      playbook: incident.playbook,
      triageSubject: TRIAGE_SUBJECT
    }
    const message = composeMessage({
      id: msgId,
      conversation: msgId,
      from: HARBOR_ENDPOINT,
      to: this.options.orchestratorId(),
      act: 'request',
      subject: this.options.render('subject', vars).slice(0, 200),
      body: this.options.render('body', vars),
      hops: 0,
      created_at: at.toISOString()
    })
    this.options.deliver(message)
    this.awaiting.set(msgId, incident)
    this.options.onLogEvent({
      kind: 'profile',
      event: 'incident-raised',
      instanceId: incident.instanceId,
      incident: incident.key,
      repo: incident.repo,
      ref: incident.ref,
      conclusion: incident.conclusion,
      oncall: incident.agentId,
      playbook: incident.playbook,
      msgId
    })
    return { incident, msgId }
  }

  /**
   * Contract: handles a triage report addressed to this endpoint (UC-09 steps
   * 3 and 4). Returns the escalation it acted on, or null when the message was
   * not a usable report — and says why in the log either way.
   *
   * A malformed report is REFUSED back to its sender rather than defaulted.
   * Choosing a severity on the agent's behalf would turn "we could not read how
   * bad this is" into "this is not very bad", and that is the wrong direction
   * for an incident path to fail in.
   */
  onTriage(message: Message): IncidentEscalation | null {
    const parsed = parseTriageReport(message.body)
    if (!parsed.ok) {
      this.options.onLogEvent({
        kind: 'profile',
        event: 'incident-triage-refused',
        from: message.from,
        msgId: message.id,
        reasons: parsed.reasons
      })
      this.refuse(message, parsed.reasons)
      return null
    }

    const report = parsed.report

    // Reconciliation (2026-09-01): a report may not claim a ledger action it
    // cannot point at. The brief has refused unsupported sentences since M4;
    // this is the same rule on the other thing an agent asserts about its own
    // work. Skipped entirely when no ledger is wired — refusing on a check that
    // could not run would be worse than not checking.
    const observed = this.options.taskIds?.() ?? null
    if (observed !== null) {
      const faith = checkTriage(report, { taskIds: observed })
      if (!faith.ok) {
        this.options.onLogEvent({
          kind: 'profile',
          event: 'incident-triage-refused',
          from: message.from,
          msgId: message.id,
          reasons: faith.reasons
        })
        this.refuse(message, faith.reasons)
        return null
      }
    }

    const incident =
      (message.in_reply_to === null ? undefined : this.awaiting.get(message.in_reply_to)) ??
      [...this.awaiting.values()].find((candidate) => candidate.key === report.incident)

    if (incident === undefined) {
      const because = `no incident "${report.incident}" is awaiting triage`
      this.options.onLogEvent({
        kind: 'profile',
        event: 'incident-triage-refused',
        from: message.from,
        msgId: message.id,
        reasons: [because]
      })
      this.refuse(message, [because])
      return null
    }

    const escalation = escalationFor(report.severity)
    this.awaiting.delete(incident.key)
    for (const [key, value] of this.awaiting) {
      if (value.key === incident.key) this.awaiting.delete(key)
    }

    this.options.onLogEvent({
      kind: 'profile',
      event: 'incident-triaged',
      instanceId: incident.instanceId,
      incident: incident.key,
      by: message.from,
      msgId: message.id,
      severity: report.severity,
      resolved: report.resolved,
      // The agent's own sentence, carried verbatim. The harness does not
      // rewrite it, and the brief that reads it later can cite this entry.
      summary: report.summary,
      escalateNow: escalation.escalateNow,
      announceNow: escalation.announceNow
    })

    if (escalation.escalateNow) this.options.onEscalateNow?.(incident, report)

    if (escalation.announceNow) {
      // UC-09 step 4's obligation, recorded as OWED. The Herald is built,
      // tested and unreachable from the application by Architect decision
      // (M6.9, deferred indefinitely) — so this does not call it, and it does
      // not pretend the announcement happened either.
      const what = `severity-1 incident ${incident.key} owes an immediate spoken announcement; the Herald is not wired (M6.9 deferred)`
      this.options.onLogEvent({
        kind: 'profile',
        event: 'incident-announce-owed',
        instanceId: incident.instanceId,
        incident: incident.key,
        because: 'herald-unwired'
      })
      this.options.onUnmetObligation?.(what)
    }

    return escalation
  }

  /** A refusal back to the agent that wrote, on the same conversation. */
  private refuse(original: Message, reasons: readonly string[]): void {
    const at = this.now()
    this.options.deliver(
      composeMessage({
        id: makeMessageId(at, `ref${Math.random().toString(36).slice(2, 8)}`),
        conversation: original.conversation,
        in_reply_to: original.id,
        from: HARBOR_ENDPOINT,
        to: original.from,
        act: 'refuse',
        subject: `re: ${original.subject}`.slice(0, 200),
        body: reasons.join('\n'),
        hops: replyHops(original),
        created_at: at.toISOString()
      })
    )
  }
}

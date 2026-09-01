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
import {
  checkVerdict,
  formatCitations,
  parseRootCauseVerdict,
  type RootCause,
  type RootCauseVerdict
} from '../shared/root-cause'
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
 * It does not judge a diagnosis. When a triage report asserts a root cause with
 * citations, this module asks a SECOND AGENT to open those files and try to
 * refute it, and records what comes back BESIDE the claim — never instead of
 * it. The harness supplies the claim, the citations and the address; the reading
 * and the verdict are the verifier's, exactly as the triage is the on-call
 * agent's. See `verify()` for why it never delays an escalation, and the note
 * on the class for why one incident already buys exactly one verification.
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

/**
 * The subject an independent verifier's verdict must carry.
 *
 * A separate subject rather than a flag inside the body, because the router
 * hands everything addressed to `agent.harbor` to one endpoint and the endpoint
 * has to tell a report from a verdict before it parses either. The last time
 * this port assumed every arriving message was one shape, an orchestrator's
 * ordinary courtesy reply was refused by name (2026-09-01 live run, defect 1).
 */
export const VERDICT_SUBJECT = 'INCIDENT-VERDICT'

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

/**
 * Prompt surfaces this endpoint renders, by the file that holds each one
 * (`prompts/harbor/incident-<kind>.md`). A union rather than a free string so a
 * prompt file that does not exist is a compile error rather than a throw at the
 * moment an incident lands.
 */
export type RenderedText =
  'subject' | 'body' | 'verify-subject' | 'verify-body' | 'disputed-subject' | 'disputed-body'

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
  render(kind: RenderedText, vars: Record<string, string>): string
  /**
   * The agent who should try to REFUTE a root cause, or null when nobody can.
   *
   * Injected rather than derived here, because "who is independent of this
   * report" is a fact about the live floor and this module knows only about
   * incidents. What it does enforce is the half that is a rule rather than a
   * lookup: a verifier who is the report's own author is refused (see
   * `verify`), so a resolver that returned one cannot produce self-verification.
   *
   * Null is an ordinary answer, not a fault. A company that has not hired a
   * verifier gets its incidents triaged and unverified, and the reason is
   * written to the log rather than left as a silence.
   */
  verifierFor?(input: { readonly incident: Incident; readonly reportedBy: string }): string | null
  /**
   * Task ids the ledger actually holds, for reconciling what a triage report
   * CLAIMS against what the company can see. Absent means no ledger is wired,
   * and an unverifiable LEDGER claim is then let through rather than refused on
   * the strength of a check that could not run.
   *
   * It does not disable `checkTriage`. The root-cause rule needs nothing looked
   * up, so it still runs — a check that could not run is a reason to skip that
   * check, not to stop checking.
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

  /**
   * Root causes sent out for verification and not yet answered, by the message
   * id the query went out under. Holds the CLAIM, because `checkVerdict` needs
   * what was asserted to judge whether the verdict actually read it.
   */
  private readonly awaitingVerdict = new Map<
    string,
    { readonly incident: Incident; readonly claim: RootCause; readonly verifier: string }
  >()

  /**
   * On the cost control that is NOT here.
   *
   * A verification is a whole agent turn on somebody else's budget, so "one
   * incident, one verification" matters. It is already true, and a second guard
   * in `verify()` would have been dead code: an incident raises at most once
   * (`raised`), a raised incident is triaged at most once (`awaiting` is cleared
   * on the first accepted report, and a later one is refused with "no incident
   * … is awaiting triage"), and `verify` is reached only from an accepted
   * triage. A `verificationSent` set was written here first and its regression
   * passed with the set removed — the second report never reaches `verify` to
   * begin with. The test that survives asserts the property against the
   * mechanism that actually provides it, which is the only kind worth keeping.
   */

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
    // Not every honest answer to a triage request is a triage report.
    // PROTOCOL.md tells an agent to refuse and say why when it cannot do what
    // it was asked, and the triage request is an ask like any other — but every
    // reply that reached here went through the report parser, so an on-call
    // agent that explained itself perfectly clearly got "the body is not valid
    // JSON" back. That is the second instance of the endpoint-hears-nothing
    // bug: the address accepted the message and then read it as the only thing
    // it knew how to read.
    //
    // The incident stays awaiting in both cases. Nobody has triaged it yet, and
    // closing it because the on-call agent said "no" or "working on it" is the
    // one outcome worse than the refusal this replaces.
    if (message.act === 'refuse' || message.act === 'agree') {
      const incident =
        message.in_reply_to === null ? undefined : this.awaiting.get(message.in_reply_to)
      this.options.onLogEvent({
        kind: 'profile',
        event: message.act === 'refuse' ? 'incident-triage-declined' : 'incident-triage-accepted',
        from: message.from,
        msgId: message.id,
        incident: incident?.key ?? null,
        because: message.body.slice(0, 2000)
      })
      return null
    }

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
    // cannot point at, and may not call something a root cause without citing
    // the source it read. The brief has refused unsupported sentences since M4;
    // these are the same rule on the two things an agent asserts about its own
    // work. `taskIds` null means no ledger is wired, which skips the LEDGER half
    // alone — the root-cause half needs nothing looked up, and a check that
    // could not run is a reason to skip that check, not to stop checking.
    const faith = checkTriage(report, { taskIds: this.options.taskIds?.() ?? null })
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
    // Cleared by value, not by key: `awaiting` is keyed by the msgId the request
    // went out under, so the entry to drop is found by matching incident keys.
    // `awaiting.delete(incident.key)` would look up a key that is never a key.
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

    // LAST, and after every escalation has already been acted on. Verification
    // is a second opinion on the diagnosis, never a precondition for treating
    // the incident: a severity-1 that waited for a verifier to read a file
    // would have converted a second pair of eyes into a delay on the alarm,
    // which is the one thing UC-09 step 4 refuses to trade.
    this.verify(incident, report, message.from)

    return escalation
  }

  /**
   * Asks an independent agent to try to REFUTE the report's root cause.
   *
   * Nothing here judges the claim. The harness carries the claim, its citations
   * and the address, exactly as `send` carries an ingested CI failure — the
   * reading is the verifier's and so is the verdict. Three ways this declines to
   * ask:
   *
   *  - **The report asserts no root cause.** There is nothing citeable to check
   *    and nothing is logged. Most triage is an observation ("the runner ran out
   *    of disk"), and an entry saying so on every incident would bury the two
   *    below in noise.
   *  - **No verifier is available** — an ordinary state for a company that has
   *    not hired one.
   *  - **The only verifier IS the report's author.** Self-verification is worse
   *    than none: it produces a record that looks checked. The resolver already
   *    excludes the author; this refuses it a second time, because the property
   *    is a rule and not a lookup.
   *
   * The last two are LOGGED with their reason. "Nobody checked this diagnosis"
   * is a fact about the record, and invariant §7 makes a degradation visible
   * rather than silent — an unverified claim that reads like a verified one three
   * weeks later is the whole failure this path exists to prevent.
   */
  private verify(incident: Incident, report: TriageReport, reportedBy: string): void {
    const claim = report.rootCause
    if (claim === undefined) return

    const unverified = (because: string): void => {
      this.options.onLogEvent({
        kind: 'profile',
        event: 'incident-root-cause-unverified',
        instanceId: incident.instanceId,
        incident: incident.key,
        by: reportedBy,
        because
      })
    }

    const verifier = this.options.verifierFor?.({ incident, reportedBy }) ?? null
    if (verifier === null) {
      unverified('no independent verifier is available on this instance')
      return
    }
    if (verifier === reportedBy) {
      unverified('the only available verifier is the agent who wrote the report')
      return
    }

    const at = this.now()
    const msgId = makeMessageId(at, `ver${incident.ref.toString(36)}`)
    // Facts only: the claim and its citations as the agent wrote them, plus the
    // address to answer at. Every word around them is a prompt (invariant §8),
    // including the instruction to try to refute — which is the whole method and
    // therefore exactly the kind of text the Architect must be able to edit.
    const vars = {
      repo: incident.repo,
      ref: String(incident.ref),
      incident: incident.key,
      url: incident.url,
      claimedBy: reportedBy,
      claim: claim.claim,
      cites: formatCitations(claim.cites),
      verdictSubject: VERDICT_SUBJECT
    }
    const message = composeMessage({
      id: msgId,
      conversation: msgId,
      from: HARBOR_ENDPOINT,
      to: verifier,
      // `query` obligates a reply (ADR-0003's table) and routes an `inform`
      // back here. A `request` would read as "do this work"; what is wanted is
      // an answer to a question, and one of the legal answers is "cannot tell".
      act: 'query',
      subject: this.options.render('verify-subject', vars).slice(0, 200),
      body: this.options.render('verify-body', vars),
      hops: 0,
      created_at: at.toISOString()
    })
    this.options.deliver(message)
    this.awaitingVerdict.set(msgId, { incident, claim, verifier })
    this.options.onLogEvent({
      kind: 'profile',
      event: 'incident-root-cause-verification-requested',
      instanceId: incident.instanceId,
      incident: incident.key,
      claimedBy: reportedBy,
      verifier,
      claim: claim.claim,
      cites: claim.cites.map((cite) => `${cite.file}:${String(cite.line)}`),
      msgId
    })
  }

  /**
   * Contract: handles a verifier's verdict on a root cause. Returns the verdict
   * it recorded, or null when the message was not a usable one — and says why in
   * the log either way.
   *
   * **The verdict is recorded BESIDE the claim, never in place of it.** The
   * triage report already stands in `log.jsonl`, verbatim and append-only; this
   * writes a second entry naming both. That is the Architect's standing position
   * and it is the right one for a reason worth stating: the verifier is another
   * agent reading the same repository under the same pressures, and a system
   * that let one agent's reading overwrite another's would have replaced a
   * confident wrong claim with a confident wrong correction. Two records with
   * their evidence attached is something a human can referee; one record that
   * changed is not.
   *
   * Nothing about the escalation moves. The severity was the on-call agent's
   * call (UC-09 step 2) and a disputed diagnosis does not make an incident less
   * severe — often the reverse. A refutation reaches the Architect the way every
   * other incident fact does: through the log and the next standup.
   */
  onVerdict(message: Message): RootCauseVerdict | null {
    const parsed = parseRootCauseVerdict(message.body)
    if (!parsed.ok) {
      this.refuseVerdict(message, parsed.reasons)
      return null
    }
    const verdict = parsed.verdict

    const pending =
      (message.in_reply_to === null ? undefined : this.awaitingVerdict.get(message.in_reply_to)) ??
      [...this.awaitingVerdict.values()].find(
        (candidate) =>
          candidate.incident.key === verdict.incident && candidate.verifier === message.from
      )
    if (pending === undefined) {
      this.refuseVerdict(message, [
        `no root cause for "${verdict.incident}" is awaiting a verdict from you`
      ])
      return null
    }

    // Only the agent that was ASKED may answer. An unsolicited verdict is not
    // obviously bad — a colleague spotting a false diagnosis is a good thing —
    // but accepting one would mean the report's own author could file a verdict
    // on their own claim, and the independence this whole path buys is worth
    // more than the volunteer. A rejected volunteer is told why and can say it
    // to the Architect in the ordinary way.
    if (message.from !== pending.verifier) {
      this.refuseVerdict(message, [
        `the verdict on "${verdict.incident}" was asked of ${pending.verifier}, not of you`
      ])
      return null
    }

    // The body must name the incident the query was about. Matched by
    // `in_reply_to` this can disagree — a verifier holding two queries answers
    // one thread with the other's key — and the disagreement means the reading
    // may have been done against the wrong repository. Silently trusting the
    // thread would file a verdict on a claim nobody checked.
    if (verdict.incident !== pending.incident.key) {
      this.refuseVerdict(message, [
        `this thread asked about "${pending.incident.key}"; your verdict names "${verdict.incident}"`
      ])
      return null
    }

    const evidenced = checkVerdict(verdict, pending.claim)
    if (!evidenced.ok) {
      this.refuseVerdict(message, evidenced.reasons)
      return null
    }

    for (const [key, value] of this.awaitingVerdict) {
      if (value.incident.key === pending.incident.key) this.awaitingVerdict.delete(key)
    }

    this.options.onLogEvent({
      kind: 'profile',
      event: 'incident-root-cause-verdict',
      instanceId: pending.incident.instanceId,
      incident: pending.incident.key,
      verdict: verdict.verdict,
      verifier: message.from,
      msgId: message.id,
      // Both sides verbatim, in one entry, so a reader never has to join two
      // log lines by hand to see what was claimed and what was answered.
      claim: pending.claim.claim,
      because: verdict.because,
      read: verdict.read.map((cite) => `${cite.file}:${String(cite.line)}`)
    })

    if (verdict.verdict === 'refute') {
      this.tellTheClaimant(pending.incident, verdict, pending.verifier, message.conversation)
    }

    return verdict
  }

  /**
   * Tells the on-call agent that its root cause was refuted, with the evidence.
   *
   * An `inform`, so it obliges nothing: the agent is not being asked to defend
   * itself or to re-report, and a dispute is not a refusal. It is being told
   * something it would otherwise never learn — the previous run's false
   * diagnosis was never contradicted by anyone, which is why the fix it proposed
   * would have been attempted. An agent that hears "the file you cited says
   * this" can correct course; one that hears nothing repeats itself.
   */
  private tellTheClaimant(
    incident: Incident,
    verdict: RootCauseVerdict,
    verifier: string,
    /**
     * The VERIFICATION exchange's conversation, not the incident key.
     *
     * `Message.conversation` is capped at 64 characters and an incident key is
     * `<owner>/<repo>#ci-run:<run id>` — comfortably under the cap for every
     * repository this has met, and over it for a long enough name, which would
     * put a message in an agent's inbox that `parseMessage` refuses to read.
     * The verification thread's id is a message id, so it is legal by
     * construction, and it threads the dispute where the reading that produced
     * it already lives.
     */
    conversation: string
  ): void {
    const at = this.now()
    const vars = {
      incident: incident.key,
      repo: incident.repo,
      verifier,
      because: verdict.because,
      read: formatCitations(verdict.read)
    }
    this.options.deliver(
      composeMessage({
        id: makeMessageId(at, `dis${incident.ref.toString(36)}`),
        conversation,
        from: HARBOR_ENDPOINT,
        to: incident.agentId,
        act: 'inform',
        subject: this.options.render('disputed-subject', vars).slice(0, 200),
        body: this.options.render('disputed-body', vars),
        hops: 0,
        created_at: at.toISOString()
      })
    )
  }

  /** A refusal back to a verifier, logged the way a refused report is. */
  private refuseVerdict(message: Message, reasons: readonly string[]): void {
    this.options.onLogEvent({
      kind: 'profile',
      event: 'incident-verdict-refused',
      from: message.from,
      msgId: message.id,
      reasons
    })
    this.refuse(message, reasons)
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

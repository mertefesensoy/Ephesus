import { composeMessage, makeMessageId, type Message } from '../shared/message'
import { replyHops } from '../shared/routing'
import { HARBOR_ENDPOINT } from '../shared/reserved'
import {
  dispositionFor,
  outboundKey,
  parseOutboundDraft,
  permitFromApproval,
  permitToPost,
  type OutboundDisposition,
  type OutboundDraft,
  type PostPermit
} from '../shared/outbound'
import type { AutonomyLevel } from '../shared/gates'

/**
 * The Front Office's outbound desk (FR-9.3, UC-10 step 3 — M7.5).
 *
 * UC-10's third step is the whole package: *"Outbound comments above a
 * configured autonomy level require Architect approval (batched into the
 * standup by default)."* This module is where that sentence becomes a
 * mechanism, and the M7.5 risk line is explicit that it must be one:
 * **"auto-post" is the first outward-facing irreversible act the company can
 * take on its own — that gate belongs in the harness, not in a playbook's
 * prose.**
 *
 * The three rungs, and what each one actually does:
 *
 * - **`manual` (draft-only)** — the draft is FILED and the author is told.
 *   Nothing leaves the machine. There is no branch here that could post,
 *   because `dispositionFor('manual')` yields `file`, and `permitToPost`
 *   returns null for anything that is not `post`. The poster's parameter type
 *   cannot be satisfied.
 * - **`supervised`** — an `outbound` gate opens. The draft waits; the standup
 *   carries it, because `BriefInput.openGates` is what the briefing already
 *   reads. Batching is therefore not a second queue that could drift from the
 *   gate — it IS the gate, seen from the brief.
 * - **`autonomous` (auto-post)** — sent, and logged with `granted: 'autonomy'`
 *   so an auto-posted comment is distinguishable from an approved one forever.
 *
 * ## What this module refuses to do
 *
 * It does not write the comment. The body is the agent's words, carried
 * verbatim — the harness decides whether they are sent, never what they say
 * (ADR-0005, and the same rule the incident summary follows).
 *
 * It does not decide the autonomy level either. That is the composition the
 * Watch already performs (`ProfileActivations.autonomyFor`), so a profile's
 * request has already been clamped against the global ceiling before it gets
 * here. A second opinion about autonomy in this file would be a second place
 * the answer lives, and the more permissive one would eventually win.
 */

/** The subject an outbound draft must carry. */
export const OUTBOUND_SUBJECT = 'OUTBOUND-DRAFT'

export interface FiledDraft {
  readonly key: string
  readonly draft: OutboundDraft
  readonly author: string
  readonly disposition: OutboundDisposition
  /** The gate holding it, when one was opened. */
  readonly gateId: string | null
  readonly at: string
}

export interface FrontOfficeOptions {
  /**
   * The composed `outbound` autonomy for this agent, or null when the agent
   * belongs to no active profile. Null is treated as `manual`: an agent nobody
   * put on a profile has no standing to speak for the company.
   */
  outboundAutonomy(agentId: string): AutonomyLevel | null
  /**
   * Opens an `outbound` gate and returns its id (UC-10 step 3), or null when
   * one could not be opened.
   *
   * Takes the WHOLE draft, not a summary of it. UC-08's packaging is what the
   * Architect reads before deciding, and approving a comment without seeing its
   * text would be approving a signature on a blank page.
   */
  openGate(request: { agentId: string; key: string; draft: OutboundDraft }): string | null
  /** Sends it. Only ever called with a permit. */
  post(permit: PostPermit): Promise<{ ok: boolean; because: string | null }>
  /** Delivery straight into an inbox (`Hermes.deliverFromHarness`). */
  deliver(message: Message): void
  /** `log.jsonl` kind `remote` (SDD §4.3, FR-10.3). */
  onLogEvent(draft: { kind: 'remote' } & Record<string, unknown>): void
  now?(): Date
}

export class FrontOffice {
  /** Drafts filed draft-only or waiting at a gate, newest last. */
  private readonly filed: FiledDraft[] = []
  /** Gate id → the draft it holds, so an approval can find its draft. */
  private readonly held = new Map<string, FiledDraft>()
  private readonly now: () => Date

  constructor(private readonly options: FrontOfficeOptions) {
    this.now = options.now ?? (() => new Date())
  }

  /** Everything filed or held — what the Front Office panel would show. */
  drafts(): readonly FiledDraft[] {
    return [...this.filed]
  }

  /** Drafts waiting at a gate. The standup reads these through `openGates`. */
  pending(): readonly FiledDraft[] {
    return [...this.held.values()]
  }

  /**
   * Contract: handles one draft an agent filed. Returns what was done with it.
   *
   * Refuses an unreadable draft rather than posting what it could parse — there
   * is no "send the readable part of a comment" behaviour, for obvious reasons.
   */
  async onDraft(message: Message): Promise<OutboundDisposition | null> {
    const parsed = parseOutboundDraft(message.body)
    if (!parsed.ok) {
      this.options.onLogEvent({
        kind: 'remote',
        event: 'outbound-refused',
        from: message.from,
        msgId: message.id,
        reasons: parsed.reasons
      })
      this.refuse(message, parsed.reasons)
      return null
    }

    const draft = parsed.draft
    const key = outboundKey(draft)
    // Null → `manual`. An agent on no profile does not get the benefit of the
    // doubt about speaking publicly under the company's name.
    const level = this.options.outboundAutonomy(message.from) ?? 'manual'
    const disposition = dispositionFor(level)
    const at = this.now().toISOString()

    if (disposition.kind === 'file') {
      const filed: FiledDraft = { key, draft, author: message.from, disposition, gateId: null, at }
      this.filed.push(filed)
      this.options.onLogEvent({
        kind: 'remote',
        event: 'outbound-filed',
        repo: draft.repo,
        target: draft.target,
        ref: draft.ref,
        by: message.from,
        because: 'draft-only'
      })
      this.reply(
        message,
        'agree',
        `filed as a draft — this profile is draft-only, so nothing was sent`
      )
      return disposition
    }

    if (disposition.kind === 'hold') {
      const gateId = this.options.openGate({ agentId: message.from, key, draft })
      const filed: FiledDraft = { key, draft, author: message.from, disposition, gateId, at }
      this.filed.push(filed)
      if (gateId !== null) this.held.set(gateId, filed)
      this.options.onLogEvent({
        kind: 'remote',
        event: 'outbound-held',
        repo: draft.repo,
        target: draft.target,
        ref: draft.ref,
        by: message.from,
        gate: gateId
      })
      this.reply(
        message,
        'agree',
        gateId === null
          ? 'held: this profile needs approval to comment, and no gate could be opened'
          : `held for the Architect at gate ${gateId}; it rides the next standup`
      )
      return disposition
    }

    // `post` — and the permit is minted from the disposition, so this line is
    // unreachable for any level that is not `autonomous`.
    const permit = permitToPost(draft, disposition)
    if (permit === null) {
      // Defensive and, by construction, dead: `dispositionFor` returned `post`.
      // Kept because the alternative is a non-null assertion on the one act in
      // this system that cannot be recalled.
      this.refuse(message, ['outbound: no permit could be minted for this draft'])
      return null
    }
    await this.send(permit, message)
    return disposition
  }

  /**
   * Contract: an Architect's verdict on a held draft. Posts it when approved,
   * drops it when not — and in both cases the draft stops being pending.
   *
   * Returns false when the gate holds no draft, so a caller cannot mistake
   * "nothing was waiting" for "it went out".
   */
  async onVerdict(gateId: string, approved: boolean): Promise<boolean> {
    const filed = this.held.get(gateId)
    if (filed === undefined) return false
    this.held.delete(gateId)

    const permit = permitFromApproval(filed.draft, gateId, approved)
    if (permit === null) {
      this.options.onLogEvent({
        kind: 'remote',
        event: 'outbound-rejected',
        repo: filed.draft.repo,
        target: filed.draft.target,
        ref: filed.draft.ref,
        gate: gateId
      })
      return true
    }
    await this.send(permit, null)
    return true
  }

  private async send(permit: PostPermit, original: Message | null): Promise<void> {
    const outcome = await this.options.post(permit)
    if (!outcome.ok && original !== null) {
      this.reply(original, 'refuse', `could not send: ${outcome.because ?? 'unknown error'}`)
      return
    }
    if (outcome.ok && original !== null) {
      this.reply(original, 'agree', `posted to ${outboundKey(permit.draft)}`)
    }
  }

  private reply(original: Message, act: 'agree' | 'refuse', body: string): void {
    const at = this.now()
    this.options.deliver(
      composeMessage({
        id: makeMessageId(at, `out${Math.random().toString(36).slice(2, 8)}`),
        conversation: original.conversation,
        in_reply_to: original.id,
        from: HARBOR_ENDPOINT,
        to: original.from,
        act,
        subject: `re: ${original.subject}`.slice(0, 200),
        body,
        hops: replyHops(original),
        created_at: at.toISOString()
      })
    )
  }

  private refuse(original: Message, reasons: readonly string[]): void {
    this.reply(original, 'refuse', reasons.join('\n'))
  }
}

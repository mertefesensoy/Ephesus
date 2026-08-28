import path from 'node:path'
import { parseVerdictFiling } from '../shared/memo'
import type { Message } from '../shared/message'
import type { Gymnasium } from './gymnasium'
import type { BriefingJob } from './briefing'
import type { Odeon } from './odeon'
import type { PromptStore } from './prompts'

/**
 * The Odeon endpoint's dispatch (ADR-0008, FR-7.1–7.3, FR-12).
 *
 * One address takes five filings — deck, memo, verdict, brief, gym proposal —
 * because the archive is one subsystem and ADR-0015 rejects a second governance
 * machine outright. Which parser runs is chosen here; what each filing MEANS is
 * decided by the module that owns it.
 *
 * This lives in its own module for the reason the M2 close-out review found the
 * hard way: the gate choke points were wired inline in `index.ts` and copied
 * character-for-character into the scenario rig, so a scenario stayed green with
 * the production wiring deleted. Both callers go through here instead, and the
 * S-suites exercise the shipped path.
 */

export interface OdeonEndpointDeps {
  readonly odeon: Odeon
  readonly gymnasium: Gymnasium | null
  readonly briefing: BriefingJob | null
  /** Invariant §8: every word an agent reads is rendered from `prompts/`. */
  readonly prompts: PromptStore | null
  /** Artemis's delegated-authority check — `mayDecide` (FR-5.5). */
  mayDecide?(request: {
    class: 'memo'
    domain: string
  }):
    | { readonly allowed: true; readonly countersignature: { by: string; under: string } }
    | { readonly allowed: false; readonly because: string }
  /** Routes a filed memo to its bench (FR-7.3). */
  triageMemo(memoId: string, trigger: string, filedBy: string): void
  /** Settles the gate a memo verdict answers, and tells the agent. */
  applyMemoVerdict(input: {
    readonly gateId: string
    readonly gateVerdict: 'approved' | 'denied'
    readonly verdict: string
    readonly memoId: string
    readonly notes: string
    readonly decidedBy: string
  }): void
  /** Pushed when the memo queue changed, so the panel re-reads. */
  onQueueChanged?(): void
}

export interface EndpointAnswer {
  readonly ok: boolean
  readonly reasons?: readonly string[]
  readonly subject: string
  readonly body: string
}

/**
 * Contract: the function Hermes hands every message addressed to the Odeon.
 *
 * A meeting reply (`act: 'inform'`) never reaches here — the caller routes that
 * to the meeting driver, because the floor is a `query` and its answer is not a
 * filing.
 */
export function wireOdeonEndpoint(deps: OdeonEndpointDeps): (message: Message) => EndpointAnswer {
  /**
   * Which artifact a filing claims to be, without validating it.
   *
   * The full parse belongs to the archive; this only chooses which parser runs,
   * so a body that is not JSON at all falls through to the deck parser and gets
   * the precise refusal it deserves there rather than a vaguer one here.
   */
  function filingKind(body: string): 'deck' | 'memo' | 'verdict' | 'brief' | 'gym-proposal' {
    try {
      const raw: unknown = JSON.parse(body)
      const kind = (raw as { kind?: unknown } | null)?.kind
      if (kind === 'memo' || kind === 'verdict' || kind === 'brief' || kind === 'gym-proposal') {
        return kind
      }
    } catch {
      // Not JSON. The deck parser says so precisely; do not guess here.
    }
    return 'deck'
  }

  /** Archives a deck and renders the endpoint answer (invariant §8). */
  function archiveDeck(archive: Odeon, message: Message): EndpointAnswer {
    const words = deps.prompts
    const outcome = archive.fileDeck(message)
    if (words === null) return { ok: outcome.ok, subject: 'odeon', body: JSON.stringify(outcome) }
    if (outcome.ok) {
      return {
        ok: true,
        subject: words
          .render(path.join('odeon', 'deck-accept-subject.md'), { taskId: outcome.taskId })
          .trim()
          .slice(0, 200),
        body: words
          .render(path.join('odeon', 'deck-accept.md'), {
            ref: outcome.ref,
            taskId: outcome.taskId
          })
          .trim()
      }
    }
    return {
      ok: false,
      reasons: outcome.reasons,
      subject: words.read(path.join('odeon', 'deck-refuse-subject.md')).trim().slice(0, 200),
      body: words
        .render(path.join('odeon', 'deck-refuse.md'), { reasons: bullets(outcome.reasons) })
        .trim()
    }
  }

  /**
   * Archives a memo, then triages it (FR-7.3). Archive FIRST: a memo exists on
   * disk even when nobody can decide it yet, because ADR-0008 makes the memo
   * itself the record, not the verdict on it.
   */
  function archiveMemo(archive: Odeon, message: Message): EndpointAnswer {
    const words = deps.prompts
    const outcome = archive.fileMemo(message)
    if (outcome.ok) deps.triageMemo(outcome.memoId, outcome.filing.trigger, message.from)
    if (words === null) return { ok: outcome.ok, subject: 'odeon', body: JSON.stringify(outcome) }
    if (outcome.ok) {
      return {
        ok: true,
        subject: words
          .render(path.join('odeon', 'memo-accept-subject.md'), { memoId: outcome.memoId })
          .trim()
          .slice(0, 200),
        body: words.render(path.join('odeon', 'memo-accept.md'), { memoId: outcome.memoId }).trim()
      }
    }
    return {
      ok: false,
      reasons: outcome.reasons,
      subject: words.read(path.join('odeon', 'memo-refuse-subject.md')).trim().slice(0, 200),
      body: words
        .render(path.join('odeon', 'memo-refuse.md'), { reasons: bullets(outcome.reasons) })
        .trim()
    }
  }

  /**
   * The orchestrator settling a memo she was delegated (FR-5.5, FR-7.3).
   *
   * `mayDecide` is asked AGAIN here rather than trusted from the triage: the
   * verdict arrives as mail, and mail can arrive late, out of order, or from an
   * orchestrator whose authority table changed in between. The countersignature
   * must describe the authority that exists NOW, not the one that existed when
   * the memo was routed.
   */
  function settleFromOrchestrator(archive: Odeon, message: Message): EndpointAnswer {
    const parsed = parseVerdictFiling(message.body)
    if (!parsed.ok) return refuseVerdict([parsed.reason])
    const header = archive.headerOf(parsed.filing.memoId)
    if (header === null) return refuseVerdict([`no memo "${parsed.filing.memoId}" is on file`])
    const may = deps.mayDecide?.({ class: 'memo', domain: header.trigger }) ?? {
      allowed: false as const,
      because: 'no orchestrator is hired'
    }
    if (!may.allowed) return refuseVerdict([may.because])
    if (may.countersignature.by !== message.from) {
      return refuseVerdict([
        `only ${may.countersignature.by} may settle a delegated memo; "${message.from}" may not`
      ])
    }
    const settled = archive.decideMemo({
      memoId: parsed.filing.memoId,
      verdict: parsed.filing.verdict,
      notes: parsed.filing.notes,
      decider: {
        kind: 'orchestrator',
        agentId: may.countersignature.by,
        under: may.countersignature.under
      }
    })
    if (!settled.ok) return refuseVerdict([settled.reason])
    deps.applyMemoVerdict({
      gateId: settled.gateId,
      gateVerdict: settled.gateVerdict,
      verdict: parsed.filing.verdict,
      memoId: parsed.filing.memoId,
      notes: parsed.filing.notes,
      decidedBy: may.countersignature.by
    })
    deps.onQueueChanged?.()
    // Invariant §8: the reply is read by an LLM, so the words come from
    // prompts/odeon/ like every sibling path (M5 close-out audit, finding 3).
    const words = deps.prompts
    if (words === null) {
      return {
        ok: true,
        subject: 'odeon',
        body: JSON.stringify({ memoId: parsed.filing.memoId, verdict: parsed.filing.verdict })
      }
    }
    const vars = {
      memoId: parsed.filing.memoId,
      verdict: parsed.filing.verdict,
      authority: may.countersignature.under
    }
    return {
      ok: true,
      subject: words
        .render(path.join('odeon', 'verdict-recorded-subject.md'), vars)
        .trim()
        .slice(0, 200),
      body: words.render(path.join('odeon', 'verdict-recorded.md'), vars).trim()
    }
  }

  function refuseVerdict(reasons: readonly string[]): EndpointAnswer {
    const words = deps.prompts
    if (words === null) {
      return { ok: false, reasons, subject: 'odeon', body: JSON.stringify({ reasons }) }
    }
    return {
      ok: false,
      reasons,
      subject: words.read(path.join('odeon', 'verdict-refuse-subject.md')).trim().slice(0, 200),
      body: words
        .render(path.join('odeon', 'verdict-refuse.md'), { reasons: bullets(reasons) })
        .trim()
    }
  }

  /**
   * Archives a narrated brief, checked against the facts the compiler issued
   * (FR-7.1, S-BRIEF).
   *
   * A narration whose `briefId` nobody asked for is refused before a single
   * sentence is read: the fact set is the question, and an answer to a question
   * nobody posed cannot be checked against anything.
   */
  function archiveBrief(archive: Odeon, message: Message): EndpointAnswer {
    const words = deps.prompts
    const job = deps.briefing
    if (job === null) return refuseBrief(['no briefing job is running'], words)
    const briefId = briefIdOf(message.body)
    const facts = briefId === null ? null : job.factsFor(briefId)
    if (facts === null) {
      return refuseBrief([`no standup is waiting on a brief called "${briefId ?? '?'}"`], words)
    }
    const outcome = archive.fileBrief(message, facts)
    // Settle ONLY on success. A refused narration leaves the question open so
    // the orchestrator can correct it and narrate the same window again —
    // closing it on refusal would make the refusal terminal and the retry
    // impossible, which a live run found the hard way.
    job.narrated(briefId ?? '', outcome.ok)
    if (words === null) {
      return { ok: outcome.ok, subject: 'odeon', body: JSON.stringify(outcome) }
    }
    if (outcome.ok) {
      return {
        ok: true,
        subject: words
          .render(path.join('odeon', 'brief-accept-subject.md'), { briefId: outcome.briefId })
          .trim()
          .slice(0, 200),
        body: words
          .render(path.join('odeon', 'brief-accept.md'), {
            ref: outcome.ref,
            spokenSeconds: String(Math.round(outcome.spokenSeconds))
          })
          .trim()
      }
    }
    return refuseBrief(outcome.reasons, words)
  }

  function refuseBrief(reasons: readonly string[], words: PromptStore | null): EndpointAnswer {
    if (words === null) {
      return { ok: false, reasons, subject: 'odeon', body: JSON.stringify({ reasons }) }
    }
    return {
      ok: false,
      reasons,
      subject: words.read(path.join('odeon', 'brief-refuse-subject.md')).trim().slice(0, 200),
      body: words
        .render(path.join('odeon', 'brief-refuse.md'), { reasons: bullets(reasons) })
        .trim()
    }
  }

  /** The brief a narration claims to answer, without validating the rest. */
  function briefIdOf(body: string): string | null {
    try {
      const raw: unknown = JSON.parse(body)
      const id = (raw as { briefId?: unknown } | null)?.briefId
      return typeof id === 'string' ? id : null
    } catch {
      return null
    }
  }

  /**
   * Files a Gymnasium proposal (FR-12.2). SDD §7.6 routes it through the same
   * endpoint as the other Odeon artifacts — one filing address, because the
   * Gymnasium deliberately reuses the accountability machinery rather than
   * growing a second one (ADR-0015 rejects the separate meta-agent outright).
   */
  function fileGymProposal(message: Message): EndpointAnswer {
    const words = deps.prompts
    const gym = deps.gymnasium
    if (gym === null) {
      return { ok: false, subject: 'gymnasium', body: 'the gymnasium is not available' }
    }
    const outcome = gym.propose(message)
    if (words === null) {
      return { ok: outcome.ok, subject: 'gymnasium', body: JSON.stringify(outcome) }
    }
    if (outcome.ok) {
      return {
        ok: true,
        subject: words
          .render(path.join('gymnasium', 'accept-subject.md'), { gymId: outcome.id })
          .trim()
          .slice(0, 200),
        body: words.render(path.join('gymnasium', 'accept.md'), { gymId: outcome.id }).trim()
      }
    }
    return {
      ok: false,
      reasons: outcome.reasons,
      subject: words.read(path.join('gymnasium', 'refuse-subject.md')).trim().slice(0, 200),
      body: words
        .render(path.join('gymnasium', 'refuse.md'), { reasons: bullets(outcome.reasons) })
        .trim()
    }
  }

  /** Reasons as a markdown list. Serialization, not prose (invariant §8). */
  function bullets(reasons: readonly string[]): string {
    return reasons.map((r) => `- ${r}`).join('\n')
  }

  return (message: Message): EndpointAnswer => {
    const kind = filingKind(message.body)
    if (kind === 'verdict') return settleFromOrchestrator(deps.odeon, message)
    if (kind === 'memo') return archiveMemo(deps.odeon, message)
    if (kind === 'brief') return archiveBrief(deps.odeon, message)
    if (kind === 'gym-proposal') return fileGymProposal(message)
    return archiveDeck(deps.odeon, message)
  }
}

import {
  CLOSING_ENDPOINT,
  HARBOR_ENDPOINT,
  HERMES_SENDER,
  LEDGER_ENDPOINT,
  LIBRARY_ENDPOINT,
  ODEON_ENDPOINT,
  PROFILE_ENDPOINT
} from './reserved'
import { REPLY_OBLIGING_ACTS, SPEECH_ACTS, requiresReply, type SpeechAct } from './message'

/**
 * What each harness-owned address may say and may hear (ADR-0003, SDD §7.1).
 *
 * `reserved.ts` names the endpoints; this module states their **mail contract**,
 * and `routing.ts` reads it rather than repeating it. That split is the point.
 * Twice now an endpoint has shipped able to SEND but unable to HEAR:
 *
 *  - `agent.profiles` sends every scheduled trigger wake and had no branch in
 *    `routeMessage` at all, so the crew ran their sweeps on the 2026-09-01 live
 *    run and every report bounced with `no mailbox for "agent.profiles"`.
 *  - `agent.harbor` sends the triage request but its handler reads *only* a
 *    triage report, so any other honest answer came back as a parse error.
 *
 * Two instances of one shape is a pattern, and the pattern has a name: nobody
 * derived what an endpoint must ACCEPT from what it SENDS. Here the derivation
 * is the invariant, and `test/shared/endpoints.test.ts` fails when it breaks.
 *
 * Deliberately NOT merged into `reserved.ts`: that module imports nothing on
 * purpose (`agents.ts` validates spawn ids against it, and `message.ts` imports
 * `agents.ts`), so a `SpeechAct` import there would be an import cycle in a
 * module zod initializes at import time — a crash, not a style problem.
 */

/**
 * The acts that CLOSE an exchange rather than opening one — `inform`, `agree`,
 * `refuse`, `done`.
 *
 * Derived from the obligation table, never enumerated, so the two can never
 * disagree: an act is terminal exactly when answering it obliges nothing
 * further. This is what PROTOCOL.md describes when it tells an agent to
 * "`refuse` and say why" when it cannot do what was asked, or to say so "when
 * you finish" — those replies tell the harness something and ask it for
 * nothing.
 */
export const TERMINAL_ACTS: readonly SpeechAct[] = SPEECH_ACTS.filter((act) => !requiresReply(act))

/** The mail contract of one harness-owned address. */
export interface EndpointContract {
  /** The reserved agent id (`src/shared/reserved.ts`). */
  readonly id: string
  /** How the router names it in a refusal: `the <name> endpoint takes ...`. */
  readonly name: string
  /**
   * Acts the harness sends FROM this address. The audited truth, not an
   * aspiration — every entry has a `composeMessage({ from: <id> })` call site
   * behind it, cited in the comment on each contract.
   */
  readonly sends: readonly SpeechAct[]
  /**
   * Acts `routeMessage` admits TO this address. Empty means the address takes
   * no mail at all, which is only legal when `sends` obliges no reply.
   *
   * "Can receive" is NOT "accepts anything": an endpoint with nothing to decide
   * should keep refusing the acts that ASK it for a decision. What it may not
   * do is refuse the acts an agent it questioned is obliged to answer with.
   */
  readonly accepts: readonly SpeechAct[]
  /**
   * The subset of `accepts` the endpoint's handler actually acts on — files,
   * applies, adjudicates.
   *
   * Everything in `accepts` but not in `handles` is an **aside**: an answer the
   * endpoint asked for and has nothing to do with, like an agent telling the
   * Odeon "done" instead of filing a deck. Hermes records those in `log.jsonl`
   * and sends no reply, which is both honest and correct — FR-3.4 forbids
   * dropping, not answering, and a terminal act obliges nothing back.
   *
   * The split matters because the alternative is what shipped: an aside handed
   * to a handler that knows exactly one body shape comes back as a parse error,
   * so the agent is told its JSON is malformed when it never claimed to send
   * any.
   */
  readonly handles: readonly SpeechAct[]
  /** Why the address is deaf. Required when `accepts` is empty, else omitted. */
  readonly deaf?: string
}

/**
 * Every reserved id's contract. `RESERVED_AGENT_IDS` is the roll call; this is
 * the register, and the guard test asserts the two match in both directions —
 * a new endpoint with no entry here fails CI before it can ship half-wired.
 */
export const ENDPOINT_CONTRACTS: readonly EndpointContract[] = [
  {
    // `Hermes.bounce` (src/main/hermes.ts) and nothing else.
    id: HERMES_SENDER,
    name: 'hermes',
    sends: ['refuse'],
    accepts: [],
    handles: [],
    // The router is not a correspondent. It writes refusals and reads no mail,
    // and saying so plainly is the fix: until this contract existed a reply to
    // a bounce fell through to the mailbox lookup and came back `no mailbox for
    // "agent.hermes"` — which is false. The address is not missing; it is the
    // router's own, and there is nobody behind it to answer.
    // Reason-shaped, like every other literal in this file and in `routing.ts`:
    // it is DATA serialised into the slot in `prompts/hermes/bounce-body.md`,
    // not prose of its own. Advice about where to take the matter instead would
    // be prompt text, and prompt text lives in `prompts/` (invariant §8).
    deaf: "the hermes endpoint is the router's own address; it writes refusals and reads no mail"
  },
  {
    // `Hermes.replyFromHarness` defaults to this `from` (agree/refuse verdicts).
    id: LEDGER_ENDPOINT,
    name: 'ledger',
    sends: ['agree', 'refuse'],
    // Unchanged, and deliberately so: the ledger never asks an agent anything,
    // so no agent is ever obliged to reply here. `propose` is the only way in
    // (FR-5.2), and the orchestrator-only rule lives in `routeMessage` because
    // it reads the routing context, which a static contract cannot.
    accepts: ['propose'],
    handles: ['propose']
  },
  {
    // `Reflection.request` (src/main/reflection.ts) sends a `request`; the
    // endpoint's own verdicts go out as agree/refuse.
    id: LIBRARY_ENDPOINT,
    name: 'library',
    sends: ['request', 'agree', 'refuse'],
    // `propose` is the condensation the request asks for by name
    // (prompts/library/reflect-request.md). The terminal acts are here because
    // that request OBLIGES a reply and PROTOCOL.md tells an agent to refuse and
    // say why when it cannot do what was asked — a refusal the router used to
    // bounce, leaving `Reflection.outstanding` holding that agent forever and
    // the Architect with no record of why its memory was never condensed.
    accepts: ['propose', 'inform', 'agree', 'refuse', 'done'],
    // Only the condensation is applied. The rest are asides: Hermes records
    // them and answers nothing, rather than running prose through the
    // condensation parser and telling the agent its JSON is malformed.
    handles: ['propose']
  },
  {
    // `ClosingTime.begin` (src/main/closing.ts) mails every live agent a
    // `request` at an orderly quit.
    id: CLOSING_ENDPOINT,
    name: 'closing',
    sends: ['request'],
    // `agree` and `refuse` join the two acts GYM-003 already took: an agent
    // that cannot park its WIP has to be able to say so, and closing time is
    // exactly when that answer matters most.
    accepts: ['inform', 'agree', 'refuse', 'done'],
    // `ClosingTime.noteReply` reads the subject and the reply-to, never the
    // act, and already records an answer it cannot match. All four land.
    handles: ['inform', 'agree', 'refuse', 'done']
  },
  {
    // Five `request` sites (briefing.ts, meeting.ts action items, odeon.ts deck
    // comment, index.ts memo-required and memo-triage), the meeting floor as a
    // `query` (meeting.ts), and the memo verdict as an `inform` (index.ts).
    id: ODEON_ENDPOINT,
    name: 'odeon',
    sends: ['request', 'query', 'inform'],
    // `propose` files an artifact; `inform` answers the floor. The rest are new
    // and overdue: six reply-obliging asks went out from this address against
    // an accept-set of two, so `done` — the act PROTOCOL.md names for finishing
    // ("When you finish, say so with a reference to the result") — bounced off
    // the very endpoint that had asked.
    accepts: ['propose', 'inform', 'agree', 'refuse', 'done'],
    // A filing and a meeting answer are acted on. "Done" and "I cannot" are
    // asides — recorded, not run through the deck parser.
    handles: ['propose', 'inform']
  },
  {
    // `Incidents.raise` sends the triage `request`; `Incidents.refuse` and
    // `FrontOffice.reply` answer with refuse/agree.
    id: HARBOR_ENDPOINT,
    name: 'harbor',
    sends: ['request', 'agree', 'refuse'],
    // A triage report informs. A crew member who cannot triage the incident it
    // was handed must be able to refuse it — and until the handler learned to
    // tell the two apart, that refusal came back as a triage parse error.
    accepts: ['inform', 'agree', 'refuse', 'done'],
    // `Incidents.onTriage` now reads all four: a report, or a declination and
    // an acceptance that leave the incident awaiting triage and say so.
    handles: ['inform', 'agree', 'refuse', 'done']
  },
  {
    // `wakeMessage` (src/main/profiles.ts) — every scheduled trigger.
    id: PROFILE_ENDPOINT,
    name: 'profiles',
    sends: ['request'],
    // A sweep report tells the harness what an agent found and asks nothing, so
    // the three asking acts stay refused. `agree` and `refuse` are reports too:
    // "skipped, the workspace was locked" is the single most useful thing a
    // sweep can say, and it was the one answer this endpoint threw away.
    accepts: ['inform', 'agree', 'refuse', 'done'],
    // All four are recorded; the log distinguishes a refusal from a report.
    handles: ['inform', 'agree', 'refuse', 'done']
  }
]

const BY_ID = new Map(ENDPOINT_CONTRACTS.map((contract) => [contract.id, contract]))

/** Contract: pure. The contract for a reserved id, or undefined for an agent. */
export function endpointContract(id: string): EndpointContract | undefined {
  return BY_ID.get(id)
}

/** Contract: pure. Whether this endpoint ever asks an agent a question. */
export function obligesReply(contract: EndpointContract): boolean {
  return contract.sends.some((act) => REPLY_OBLIGING_ACTS.includes(act))
}

/** `"a"`, `"a" or "b"`, `"a", "b" or "c"` — the router's refusal reads as prose. */
export function listActs(acts: readonly SpeechAct[]): string {
  const quoted = acts.map((act) => `"${act}"`)
  if (quoted.length <= 1) return quoted.join('')
  return `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`
}

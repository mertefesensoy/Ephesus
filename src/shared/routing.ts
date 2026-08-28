import { CLOSING_ENDPOINT, LEDGER_ENDPOINT, LIBRARY_ENDPOINT, ODEON_ENDPOINT } from './reserved'
import { BROADCAST, HUMAN, type Message } from './message'

/**
 * The routing rules (ADR-0003, FR-3.3/3.4/3.7).
 *
 * These are **pure functions on purpose**. ADR-0003 calls the anti-livelock
 * rules "transport rules, not etiquette", and S-LIVELOCK and S-BOUNCE assert
 * them at this module boundary rather than through the UI or a spawned agent —
 * a rule you can only test end-to-end is a rule nobody will test.
 */

/**
 * Hop cap (ADR-0003: "at the hop cap the router diverts the message to Artemis
 * instead of delivering"). The ADR does not name a number. Eight leaves room
 * for a genuine multi-turn exchange — ask, clarify, answer, confirm, twice over
 * — while catching a two-agent ping-pong within a few seconds rather than a few
 * minutes of budget.
 */
export const DEFAULT_HOP_CAP = 8

export interface RoutingContext {
  /** Agent ids that currently have a mailbox. */
  readonly knownAgents: readonly string[]
  /** Artemis, or null before the orchestrator is hired (M3). */
  readonly orchestratorId: string | null
  readonly hopCap?: number
}

export type Route =
  /** Deliver as addressed, to one or more mailboxes. */
  | { readonly kind: 'deliver'; readonly to: readonly string[] }
  /**
   * Addressed to the harness's ledger endpoint (SDD §7.1): not delivered to a
   * mailbox at all — handed to the endpoint, which validates it and writes
   * `tasks.json` through the single committer.
   */
  | { readonly kind: 'endpoint'; readonly endpoint: string }
  /** Hop cap reached: goes to the adjudicator instead of the addressee. */
  | { readonly kind: 'divert'; readonly to: string; readonly reason: string }
  /** Undeliverable: the sender gets a `refuse` back and the log gets a bounce. */
  | { readonly kind: 'bounce'; readonly reason: string }

/**
 * Where mail for the Architect goes until Artemis exists (FR-3.7: `to:"human"`
 * routes to Artemis as the Architect's proxy). With no orchestrator hired there
 * is no proxy, so it queues for the Architect directly rather than bouncing —
 * losing a message addressed to the human would be the worst outcome available.
 */
export const HUMAN_QUEUE = HUMAN

/**
 * Contract: pure, total, and never silently drops. Every message gets exactly
 * one of: delivered somewhere, diverted to an adjudicator, or bounced back to
 * its sender with a reason.
 *
 * Order matters. The hop cap is checked **first**, because a livelocked
 * ping-pong must be caught whether or not its recipient still exists — the
 * point of the cap is to stop the loop, not to adjudicate the address.
 */
export function routeMessage(message: Message, ctx: RoutingContext): Route {
  const cap = ctx.hopCap ?? DEFAULT_HOP_CAP
  const adjudicator = ctx.orchestratorId ?? HUMAN_QUEUE

  // FR-3.3: past the hop cap, escalate instead of delivering. "At exactly the
  // cap" — a message that has made `cap` hops is diverted; `cap - 1` is not.
  if (message.hops >= cap) {
    return {
      kind: 'divert',
      to: adjudicator,
      reason: `hop cap ${cap} reached (hops=${message.hops}); diverted from "${message.to}"`
    }
  }

  if (message.to === BROADCAST) {
    // Fan-out to everyone but the sender — a broadcast is not a message to
    // oneself, and delivering it back would be an instant self-reply loop.
    const recipients = ctx.knownAgents.filter((id) => id !== message.from)
    return recipients.length > 0
      ? { kind: 'deliver', to: recipients }
      : { kind: 'bounce', reason: 'broadcast has no recipients other than the sender' }
  }

  if (message.to === HUMAN) {
    // FR-3.7/ADR-0005: Artemis is the Architect's proxy. Only what she judges
    // critical continues to the Architect's own queue — and that judgement is
    // hers, made by flipping `needs_human`, not a rule in this function.
    // The proxy cannot proxy for herself: Artemis mailing the human goes to
    // the Architect's queue, never back into her own inbox (M3 audit, N4).
    const proxy = ctx.orchestratorId
    return {
      kind: 'deliver',
      to: [proxy !== null && message.from !== proxy ? proxy : HUMAN_QUEUE]
    }
  }

  if (message.to === LEDGER_ENDPOINT) {
    // "Agents never touch tasks.json." The endpoint is the only way in, and
    // this is where the two rules that make it safe live — because ADR-0003
    // calls these transport rules, not etiquette.
    if (ctx.orchestratorId === null) {
      return { kind: 'bounce', reason: 'the ledger endpoint has no orchestrator to write for it' }
    }
    if (message.from !== ctx.orchestratorId) {
      return {
        kind: 'bounce',
        reason: `only the orchestrator may write the ledger; "${message.from}" may not`
      }
    }
    if (message.act !== 'propose') {
      return {
        kind: 'bounce',
        reason: `the ledger endpoint takes "propose" acts; got "${message.act}"`
      }
    }
    return { kind: 'endpoint', endpoint: LEDGER_ENDPOINT }
  }

  if (message.to === LIBRARY_ENDPOINT) {
    // ADR-0006 layer 3. Unlike the ledger, ANY agent may write here — but only
    // about its own memory, which is why there is no writer check: the endpoint
    // condenses `message.from`'s memory and nobody else's, so an agent writing
    // here can only ever act on itself.
    if (message.act !== 'propose') {
      return {
        kind: 'bounce',
        reason: `the library endpoint takes "propose" acts; got "${message.act}"`
      }
    }
    return { kind: 'endpoint', endpoint: LIBRARY_ENDPOINT }
  }

  if (message.to === CLOSING_ENDPOINT) {
    // GYM-003. Any agent may answer closing time — the request went to all of
    // them — but only with a reply-shaped act: an ACK informs, it never asks.
    // Whether a closing is actually in progress is state, not transport; the
    // handler bounces an out-of-season ACK with a reason (FR-3.4).
    if (message.act !== 'inform' && message.act !== 'done') {
      return {
        kind: 'bounce',
        reason: `the closing endpoint takes "inform" or "done" acts; got "${message.act}"`
      }
    }
    return { kind: 'endpoint', endpoint: CLOSING_ENDPOINT }
  }

  if (message.to === ODEON_ENDPOINT) {
    // ADR-0008, FR-7.2. Like the Library and unlike the ledger, ANY agent may
    // file here — accountability that only the orchestrator could file would be
    // accountability nobody owes. What an agent may file FOR is checked by the
    // endpoint, which refuses a deck for a task the sender was not assigned;
    // that is a ledger fact, and the router does not read the ledger.
    // `propose` files an artifact; `inform` answers a meeting question. The
    // floor is handed out as a `query`, and ADR-0003's act table makes the
    // reply to a query an `inform` — so refusing one here would make the
    // meeting driver unable to hear its own attendees.
    if (message.act !== 'propose' && message.act !== 'inform') {
      return {
        kind: 'bounce',
        reason: `the odeon endpoint takes "propose" or "inform" acts; got "${message.act}"`
      }
    }
    return { kind: 'endpoint', endpoint: ODEON_ENDPOINT }
  }

  // FR-3.4: a missing or archived inbox bounces, never drops.
  if (!ctx.knownAgents.includes(message.to)) {
    return { kind: 'bounce', reason: `no mailbox for "${message.to}"` }
  }

  return { kind: 'deliver', to: [message.to] }
}

/**
 * Contract: the hops a reply to `message` carries. Every reply increments
 * (ADR-0003), which is what makes the cap reachable — a ping-pong that reset
 * the counter would never trip it.
 */
export function replyHops(message: Message): number {
  return message.hops + 1
}

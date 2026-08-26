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
    return { kind: 'deliver', to: [ctx.orchestratorId ?? HUMAN_QUEUE] }
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
